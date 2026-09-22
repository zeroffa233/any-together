'use strict';

/**
 * AnyTogether popup — presentation state machine over the authoritative
 * background snapshot. The popup never infers socket/playback state: it
 * renders `status` (disconnected|connecting|connected|error), `session-status`
 * (ready/reason/participants), authoritative `state` (resource/phase/position)
 * and the latest `diagnostic` pushed by the background worker, and turns them
 * into a seven-state UI (disconnected/connecting/connected/waiting/ready/
 * degraded/error). The selected radio is only a join.roleHint; the actual role
 * always comes from join-accepted (status.role). There are no playback
 * controls and no manual URL input: the native video player is the only
 * intent source.
 */

const $ = (id) => document.getElementById(id);
function parseShareString(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const payload = text.startsWith('anytogether://')
    ? text.slice('anytogether://'.length)
    : text;
  if (!payload.startsWith('session?')) return null;

  const params = Object.create(null);
  const query = payload.slice('session?'.length);
  if (!query) return null;
  for (const part of query.split('&')) {
    const separator = part.indexOf('=');
    if (separator <= 0) return null;
    const key = part.slice(0, separator);
    if (!['host', 'port', 'session'].includes(key) || Object.hasOwn(params, key)) return null;
    try {
      params[key] = decodeURIComponent(part.slice(separator + 1));
    } catch {
      return null;
    }
  }

  if (!params.host || !params.port || !params.session || !/^\d+$/.test(params.port)) return null;
  const port = Number(params.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: params.host, port, session: params.session };
}

const ADAPTER_LABELS = { bilibili: 'Bilibili', youtube: 'YouTube', 'local-video': '本地视频', 'arxiv-pdf': 'arXiv PDF' };

const PHASE_LABELS = {
  loading: '加载中',
  ready: '就绪',
  playing: '播放中',
  paused: '已暂停',
  seeking: '跳转中',
  buffering: '缓冲中',
  ended: '已结束',
  error: '错误',
};

const REASON_LABELS = {
  'awaiting-second-participant': '等待第二位参与者加入',
  'awaiting-actual-state': '等待各参与者回报当前页面状态',
  'actual-state-desync': '实际状态不同步',
};

const DIAGNOSTIC_LABELS = {
  desync: '状态不同步',
  'actual-state-mismatch': '资源/适配器或实际状态不匹配',
  'participant-left': '参与者离开',
};

// Stable join-rejected reason codes (protocol §2.2) mapped to actionable
// Chinese copy. The background prefixes these codes as "加入被拒绝: <code>";
// the popup maps the code, never the server's English message.
const JOIN_REJECT_LABELS = {
  'host-required': '此会话需要先由主机创建，请在创建者设备选择主机',
  'host-already-exists': '此会话已有主机，请切换为从机',
  'duplicate-or-empty-participant-id': '参与者 ID 重复或为空，请更换后重试',
  'resource-mismatch': '提供的资源与会话不一致，请改用与主机相同的视频页',
  'host-declined': '主机拒绝了加入请求',
  'host-unavailable': '主机暂不可用，请稍后重试',
  'no-host-available': '此会话需要先由主机创建，请在创建者设备选择主机',
};

const UI_ICONS = {
  disconnected: '—',
  connecting: '⋯',
  connected: '✓',
  waiting: '⋯',
  ready: '✓',
  degraded: '!',
  error: '×',
};

const UI_LABELS = {
  disconnected: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  waiting: '等待就绪',
  ready: '已就绪',
  degraded: '需要检查同步',
  error: '连接失败',
};

const CONNECTED_FAMILY = ['connected', 'waiting', 'ready', 'degraded'];

let currentState = null; // authoritative PlaybackState
let lastStatus = 'disconnected'; // background lifecycle status
let lastErrorText = null;
let lastStatusInfo = null;
let currentSessionStatus = null; // latest session-status broadcast
let lastDiagnostic = null; // latest diagnostic (drawer shows only this one)
let pendingJoin = null;
let selfParticipantId = null;
let submitLock = false; // connect is single-submission until a status frame
let decisionLock = false; // join accept/reject is single-submission
let prevStatus = 'disconnected';
let sessionStatusSeq = 0; // event ordering: a session-status newer than the
let diagnosticSeq = 0; // last diagnostic wins (fresh ready=true clears degraded)
let localPermission = null; // pending { origin, pattern, canonicalUrl } from background
let permissionInFlight = false;
let panelOpen = false;

// --- messaging & one-at-a-time feedback -------------------------------------

function send(message) {
  return chrome.runtime.sendMessage(message).catch(() => ({ ok: false, error: '后台服务不可用' }));
}

function showError(text) {
  const el = $('error');
  el.textContent = text ?? '';
  el.hidden = !text;
  if (text) {
    const notice = $('notice');
    notice.textContent = '';
    notice.hidden = true;
  }
}

function showNotice(text) {
  const el = $('notice');
  el.textContent = text ?? '';
  el.hidden = !text;
  if (text) {
    const error = $('error');
    error.textContent = '';
    error.hidden = true;
  }
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// --- time & position ---------------------------------------------------------

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function projectedPosition(state) {
  // background.js localizes the authority anchor into this browser's clock.
  let position = Number.isFinite(state.positionSeconds) ? state.positionSeconds : 0;
  if (state.mediaPhase === 'playing' && Number.isFinite(state.positionAtMs)) {
    const rate = Number.isFinite(state.playbackRate) ? state.playbackRate : 1;
    position += (Math.max(0, Date.now() - state.positionAtMs) / 1000) * rate;
    if (Number.isFinite(state.durationSeconds)) position = Math.min(state.durationSeconds, position);
  }
  return position;
}

// --- presentation state machine (spec §5) ------------------------------------

function computeUiState() {
  if (lastStatus === 'error') return 'error';
  if (lastStatus === 'connecting') return 'connecting';
  if (lastStatus !== 'connected') return 'disconnected';
  const phaseError = currentState?.mediaPhase === 'error';
  const liveDesync = currentSessionStatus?.reason === 'actual-state-desync';
  const diagDesync = lastDiagnostic
    && (lastDiagnostic.code === 'desync' || lastDiagnostic.code === 'actual-state-mismatch')
    && diagnosticSeq > sessionStatusSeq;
  if (liveDesync || diagDesync || phaseError) return 'degraded';
  if (currentSessionStatus?.ready === true) return 'ready';
  if (currentSessionStatus) return 'waiting';
  return 'connected';
}

function rejectCodeFromError(text) {
  const m = String(text ?? '').match(/^加入被拒绝: (\S+)$/);
  return m ? m[1] : null;
}

function errorDescription() {
  const code = rejectCodeFromError(lastErrorText);
  if (code && JOIN_REJECT_LABELS[code]) return JOIN_REJECT_LABELS[code];
  return lastErrorText || '连接失败，请检查后重试';
}

function renderBanner() {
  const state = computeUiState();
  const icon = $('status-icon');
  const label = $('status-label');
  const desc = $('status-description');
  const disconnectBtn = $('disconnect');
  const viewDiag = $('view-diagnostic');

  // Disconnected (incl. errors surfaced on the connect card): no session UI
  // at all — the connect card and its inline errors are the whole screen.
  const showSessionUi = state !== 'disconnected';
  $('connection-banner').hidden = !showSessionUi;
  $('participants-section').hidden = !showSessionUi;
  $('resource-section').hidden = !showSessionUi;
  icon.textContent = UI_ICONS[state];
  icon.className = `status-icon state-${state}`;
  icon.classList.toggle('pulse', state === 'connecting' || state === 'waiting');
  label.textContent = UI_LABELS[state];

  let description;
  switch (state) {
    case 'connecting':
      description = '已发送连接请求，等待完成加入';
      break;
    case 'connected':
      description = '正在读取会话状态';
      break;
    case 'waiting':
      description = REASON_LABELS[currentSessionStatus?.reason] ?? '等待会话就绪';
      break;
    case 'ready':
      description = '所有参与者状态一致；播放请使用视频页原生播放器';
      break;
    case 'degraded':
      description = lastDiagnostic?.detail
        ? truncate(lastDiagnostic.detail, 120)
        : (REASON_LABELS[currentSessionStatus?.reason] ?? '请打开诊断查看详情');
      break;
    case 'error':
      description = errorDescription();
      break;
    default:
      description = '';
  }
  desc.textContent = description;

  const inFamily = CONNECTED_FAMILY.includes(state);
  disconnectBtn.hidden = !inFamily;
  disconnectBtn.disabled = !inFamily;
  viewDiag.hidden = state !== 'degraded';

  // Progressive disclosure: while connected (any healthy sub-state) the
  // connect card has no interactive value — session cards lead instead. It
  // returns on disconnect or error.
  $('connect-form').hidden = inFamily;

  applyLock();
}

function applyLock() {
  const locked = submitLock || lastStatus === 'connecting' || lastStatus === 'connected';
  for (const id of ['server', 'port', 'session', 'participant']) $(id).disabled = locked;
}

function validateForm(server, port, sessionId) {
  if (!server) return { id: 'server', text: '请输入主机地址（IP 或主机名）' };
  const portNum = Number(port);
  if (!port || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return { id: 'port', text: '端口需为 1–65535 之间的整数' };
  }
  if (!sessionId) return { id: 'session', text: '请输入会话 ID 或名称（或直接粘贴分享串）' };
  return null;
}

function showFieldError(err) {
  const el = $(`err-${err.id}`);
  el.textContent = err.text;
  el.hidden = false;
  $(err.id).focus();
}

function clearFieldErrors() {
  for (const id of ['server', 'port', 'session']) {
    const el = $(`err-${id}`);
    el.textContent = '';
    el.hidden = true;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older Chrome / restricted popup context: legacy copy fallback.
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

async function doConnect() {
  const state = computeUiState();
  if (submitLock || state === 'connecting' || CONNECTED_FAMILY.includes(state)) return;

  // Share string wins when present; otherwise fall back to the advanced
  // fields with the built-in defaults (127.0.0.1 / 8765) from placeholders.
  const shareText = $('share').value.trim();
  const parsed = shareText ? parseShareString(shareText) : null;
  if (shareText && !parsed) {
    showFieldError({ id: 'share', text: '无法识别分享串，请粘贴完整的 anytogether:// 分享串' });
    return;
  }
  const server = parsed?.host ?? $('server').value.trim() ?? '';
  const port = String(parsed?.port ?? $('port').value.trim() ?? '');
  const sessionId = parsed?.session ?? $('session').value.trim();
  const participantId = $('participant').value.trim();

  const effectiveServer = server || '127.0.0.1';
  const effectivePort = port || '8765';
  const firstError = validateForm(effectiveServer, effectivePort, sessionId);
  if (firstError) {
    showFieldError(firstError);
    return;
  }
  clearFieldErrors();
  submitLock = true; // lock before the round-trip; the status frame releases it
  renderBanner();
  const reply = await send({
    type: 'connect',
    host: effectiveServer,
    port: effectivePort,
    sessionId,
    participantId,
  });
  if (reply && reply.ok === false) {
    submitLock = false;
    showError(reply.error ?? '连接失败');
    renderBanner();
  }
  // On success the background's status frame ('connecting') owns the lock.
}

// --- status ------------------------------------------------------------------

function renderStatus(info) {
  prevStatus = lastStatus;
  lastStatus = info.status;
  lastErrorText = info.lastError ?? null;
  lastStatusInfo = info;
  localPermission = info.localPermission ?? null;

  if (lastStatus === 'connected') {
    selfParticipantId = info.participantId ?? null;
  } else {
    selfParticipantId = null;
  }

  // Reopened popup restores the worker's real target fields for a retry.
  const restorable = lastStatus === 'connected' || lastStatus === 'connecting' || lastStatus === 'error';
  if (info.host && restorable) $('server').value = info.host;
  if (info.port && restorable) $('port').value = String(info.port);
  if (info.sessionId && !$('session').value.trim()) $('session').value = info.sessionId;
  if (info.participantId && !$('participant').value.trim()) $('participant').value = info.participantId;

  if (lastStatus !== 'connected') {
    // Explicit disconnect / terminal error clears read-only projections but
    // keeps the retryable config fields.
    currentState = null;
    currentSessionStatus = null;
    lastDiagnostic = null;
    sessionStatusSeq = 0;
    diagnosticSeq = 0;
    renderPendingJoin(null);
  }

  submitLock = false; // a fresh status frame ends any in-flight submission
  renderBanner();
  renderParticipants();
  renderResourceCard();
  renderConnectionDetails();
  renderShareText(info.share);
  renderDiagnosticDrawer();
  renderLocalPermission();
  showError(info.lastError ?? '');
}

// --- participants (spec §6.1) ------------------------------------------------

function renderParticipants() {
  const list = $('participant-list');
  const placeholder = $('participants-placeholder');
  const count = $('participants-count');
  const participants = currentSessionStatus?.participants ?? [];
  count.textContent = String(participants.length);
  list.textContent = '';

  if (lastStatus !== 'connected') {
    placeholder.textContent = '连接后显示参与者';
    placeholder.hidden = false;
    return;
  }
  if (!currentSessionStatus || participants.length < 2) {
    placeholder.textContent = '等待另一位参与者加入';
    placeholder.hidden = false;
    return;
  }
  placeholder.hidden = true;
  for (const p of participants) {
    const ok = p.reported && p.consistent;
    const li = document.createElement('li');
    li.className = 'participant-row';

    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.className = `participant-icon ${ok ? 'ok' : p.reported ? 'bad' : ''}`;
    icon.textContent = ok ? '✓' : p.reported ? '!' : '⋯';

    const body = document.createElement('div');
    body.className = 'participant-body';

    const name = document.createElement('div');
    name.className = 'participant-name';
    const idSpan = document.createElement('span');
    idSpan.className = 'participant-id';
    idSpan.textContent = p.participantId;
    idSpan.title = p.participantId;
    name.appendChild(idSpan);
    if (selfParticipantId && p.participantId === selfParticipantId) {
      const selfPill = document.createElement('span');
      selfPill.className = 'pill pill-self';
      selfPill.textContent = '本机';
      name.appendChild(selfPill);
    }

    const report = document.createElement('div');
    report.className = 'participant-report';
    report.textContent = ok ? '已回报，一致' : p.reported ? '需要检查' : '等待页面回报';

    body.appendChild(name);
    body.appendChild(report);
    li.appendChild(icon);
    li.appendChild(body);
    list.appendChild(li);
  }
}

// --- resource / playback read-only card (spec §6.3) --------------------------

function renderResourceCard() {
  const empty = $('resource-empty');
  const body = $('resource-body');
  if (!currentState || lastStatus !== 'connected') {
    body.hidden = true;
    empty.hidden = false;
    empty.textContent = lastStatus === 'connecting'
      ? '正在连接，资源将在加入后显示。'
      : '未连接，无资源信息。';
    return;
  }
  const identity = currentState.resourceIdentity;
  if (!identity) {
    body.hidden = true;
    empty.hidden = false;
    empty.textContent = '尚未绑定资源。主机请在支持的视频页打开或使用本地视频广播；从机将等待主机共享资源。';
    return;
  }
  empty.hidden = true;
  body.hidden = false;
  $('resource-adapter').textContent = ADAPTER_LABELS[identity.adapterId] ?? identity.adapterId;
  // The resource's own name is the recognizable bit: a BV id, a file name —
  // fall back to the canonical URL tail when the syncer has no resourceId.
  $('resource-name').textContent = identity.resourceId
    ?? (identity.canonicalUrl.split('/').pop() || identity.canonicalUrl);
  updatePlaybackFields();
}

function renderLocalPermission() {
  const card = $('local-permission');
  const show = !!localPermission && lastStatus === 'connected';
  card.hidden = !show;
  if (!show) return;
  $('local-permission-origin').textContent = localPermission.origin;
  $('grant-local-permission').disabled = permissionInFlight;
  $('deny-local-permission').disabled = permissionInFlight;
}

async function grantLocalPermission() {
  if (!localPermission || permissionInFlight) return;
  const request = localPermission;
  permissionInFlight = true;
  $('local-permission-status').textContent = '正在请求浏览器权限…';
  renderLocalPermission();
  let granted = false;
  try {
    if (typeof chrome.permissions?.request !== 'function') {
      throw new Error('当前浏览器不支持运行时权限请求');
    }
    granted = await chrome.permissions.request({ origins: [request.pattern] });
  } catch (error) {
    $('local-permission-status').textContent = error instanceof Error ? error.message : String(error);
    permissionInFlight = false;
    renderLocalPermission();
    return;
  }
  const reply = await send({ type: 'local-permission-result', origin: request.origin, granted });
  permissionInFlight = false;
  if (!reply || reply.ok === false) {
    $('local-permission-status').textContent = reply?.error ?? '权限结果未能发送到后台';
    renderLocalPermission();
    return;
  }
  if (!granted) {
    $('local-permission-status').textContent = '未授权。点击“允许并继续同步”可再次请求。';
    renderLocalPermission();
    return;
  }
  localPermission = null;
  renderLocalPermission();
  showNotice('已授权本地视频地址，正在打开并注入同步脚本');
}

async function denyLocalPermission() {
  if (!localPermission || permissionInFlight) return;
  const origin = localPermission.origin;
  permissionInFlight = true;
  const reply = await send({ type: 'local-permission-result', origin, granted: false });
  permissionInFlight = false;
  if (!reply || reply.ok === false) {
    $('local-permission-status').textContent = reply?.error ?? '无法取消本地视频授权请求';
    renderLocalPermission();
    return;
  }
  localPermission = null;
  renderLocalPermission();
  showNotice('已暂不授权本地视频地址');
}

// --- playback read-only fields ------------------------------------------------

function updatePlaybackFields() {
  if (!currentState) return;
  const phase = currentState.mediaPhase;
  const rate = Number.isFinite(currentState.playbackRate) ? currentState.playbackRate : 1;
  const phaseText = PHASE_LABELS[phase] ?? phase ?? '未知';

  // Status pill: color mirrors the phase family, text carries the rate only
  // when it differs from normal playback speed.
  const pill = $('resource-phase');
  pill.textContent = Math.abs(rate - 1) > 1e-9
    ? `${phaseText} · ${rate.toFixed(2)}×`
    : phaseText;
  pill.className = phase === 'error'
    ? 'phase-pill phase-error'
    : phase === 'playing'
      ? 'phase-pill phase-playing'
      : phase === 'buffering' || phase === 'seeking' || phase === 'loading'
        ? 'phase-pill phase-transient'
        : 'phase-pill phase-other';

  // Progress bar + time row. Unknown duration shows the time pair only.
  const position = projectedPosition(currentState);
  const percent = currentState.durationSeconds != null && currentState.durationSeconds > 0
    ? Math.min(100, Math.max(0, (position / currentState.durationSeconds) * 100))
    : 0;
  $('resource-progress').style.width = `${percent}%`;
  $('resource-position').textContent = formatTime(position);
  $('resource-duration').textContent = currentState.durationSeconds == null
    ? '时长未知'
    : formatTime(currentState.durationSeconds);
  $('resource-error').hidden = phase !== 'error';
}

// --- join approval (spec §6.2) ------------------------------------------------

function renderPendingJoin(join, pendingCount = 1) {
  pendingJoin = join;
  const card = $('join-approval');
  const show = !!join && lastStatus === 'connected';
  card.hidden = !show;
  if (!show) return;
  $('join-requester-id').textContent = pendingCount > 1
    ? `${join.participantId}（另有 ${pendingCount - 1} 人待审批）`
    : join.participantId;
  const identity = join.resourceIdentity;
  $('join-requester-resource').textContent = identity
    ? `${ADAPTER_LABELS[identity.adapterId] ?? identity.adapterId} · ${identity.canonicalUrl}`
    : '未提供视频';
  $('join-processing').hidden = true;
  $('joinaccept').disabled = false;
  $('joinreject').disabled = false;
  decisionLock = false;
}

async function sendJoinDecision(accepted) {
  if (decisionLock) return;
  decisionLock = true;
  $('joinaccept').disabled = true;
  $('joinreject').disabled = true;
  $('join-processing').hidden = false;
  const reply = await send({ type: 'join-decision', accepted });
  decisionLock = false;
  if (!reply || reply.ok === false) {
    $('join-processing').hidden = true;
    $('joinaccept').disabled = false;
    $('joinreject').disabled = false;
    showError(reply?.error ?? '发送加入决定失败，请重试');
    return;
  }
  renderPendingJoin(null);
}

// --- secondary panel: diagnostics / connection / share (spec §7) --------------

function addKv(dl, dtText, ddText) {
  const dt = document.createElement('dt');
  dt.textContent = dtText;
  const dd = document.createElement('dd');
  dd.textContent = ddText;
  dd.className = 'selectable';
  dl.appendChild(dt);
  dl.appendChild(dd);
}

function addCompareLi(ul, text) {
  const li = document.createElement('li');
  li.textContent = text;
  ul.appendChild(li);
}

function buildCompareCol(title, snapshot, resourceIdentity) {
  const col = document.createElement('div');
  col.className = 'compare-col';
  const h = document.createElement('h4');
  h.textContent = title;
  col.appendChild(h);
  const ul = document.createElement('ul');
  if (snapshot) {
    addCompareLi(ul, `状态：${PHASE_LABELS[snapshot.mediaPhase] ?? snapshot.mediaPhase ?? '未知'}`);
    addCompareLi(ul, `位置：${formatTime(snapshot.positionSeconds)}`);
    addCompareLi(ul, `倍速：${Number.isFinite(snapshot.playbackRate) ? snapshot.playbackRate.toFixed(2) : '—'}×`);
  }
  if (resourceIdentity) {
    addCompareLi(ul, `站点：${ADAPTER_LABELS[resourceIdentity.adapterId] ?? resourceIdentity.adapterId}`);
    addCompareLi(ul, `链接：${resourceIdentity.canonicalUrl ?? '—'}`);
  } else if (title === '期望' && snapshot) {
    addCompareLi(ul, '资源：未绑定');
  }
  col.appendChild(ul);
  return col;
}

function renderDiagnosticDrawer() {
  const body = $('diagnostic-body');
  body.textContent = '';
  const d = lastDiagnostic;
  if (!d) {
    body.textContent = '暂无诊断记录';
    return;
  }

  const head = document.createElement('div');
  head.className = 'diagnostic-head';
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.className = d.code === 'participant-left' ? 'status-icon state-connected'
    : d.code === 'actual-state-mismatch' ? 'status-icon state-error'
      : 'status-icon state-degraded';
  icon.textContent = d.code === 'participant-left' ? 'i' : '!';
  head.appendChild(icon);
  const title = document.createElement('strong');
  title.textContent = DIAGNOSTIC_LABELS[d.code] ?? d.code;
  head.appendChild(title);
  const rev = document.createElement('span');
  rev.className = 'muted';
  rev.textContent = `修订 #${Number.isInteger(d.stateRevision) ? d.stateRevision : '?'}`;
  head.appendChild(rev);
  body.appendChild(head);

  const detail = document.createElement('p');
  detail.className = 'diagnostic-detail';
  detail.textContent = d.detail ?? '';
  body.appendChild(detail);

  const kv = document.createElement('dl');
  kv.className = 'kv';
  addKv(kv, '参与者', d.participantId ?? '—');
  const reason = currentSessionStatus?.reason;
  if (reason) addKv(kv, '就绪原因', REASON_LABELS[reason] ?? reason);
  body.appendChild(kv);

  if (d.expected || d.actual) {
    const compare = document.createElement('div');
    compare.className = 'compare';
    compare.appendChild(buildCompareCol('期望', d.expected, d.resource?.expected));
    compare.appendChild(buildCompareCol('实际', d.actual, d.resource?.actual));
    body.appendChild(compare);
  }

  const recovery = document.createElement('p');
  recovery.className = 'recovery';
  recovery.textContent = d.code === 'participant-left'
    ? '恢复建议：等待其他参与者加入；若无法加入，可断开后重新建立会话。'
    : '恢复建议：重新确认各参与者打开同一视频页并等待页面回报；必要时在视频页操作一次以触发重新上报。';
  body.appendChild(recovery);
}

function renderConnectionDetails() {
  const dl = $('connection-details');
  dl.textContent = '';
  const port = $('port').value.trim() || '8765';
  const api = lastStatusInfo?.api ?? null;
  addKv(dl, 'Session ID', $('session').value.trim() || '—');
  addKv(dl, '主机地址', $('server').value.trim() || '—');
  addKv(dl, '端口', port);
  addKv(dl, 'API 地址', api ?? '—');
  addKv(dl, '参与者 ID', selfParticipantId ?? '—');
  // Debug-grade details moved out of the resource card: the resource URL and
  // the authoritative revision belong here, not in the at-a-glance card.
  if (currentState?.resourceIdentity) {
    addKv(dl, '资源链接', currentState.resourceIdentity.canonicalUrl);
  }
  if (currentState && Number.isInteger(currentState.stateRevision)) {
    addKv(dl, '修订', `#${currentState.stateRevision}`);
  }
}

function renderShareText(share) {
  if (share) {
    $('share-text').textContent = share;
  }
}

// --- secondary panel open/close ----------------------------------------------

function panelFocusables() {
  const panel = $('secondary-panel');
  return [...panel.querySelectorAll('summary, button, input')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
}

function openPanel(detailsId) {
  panelOpen = true;
  const panel = $('secondary-panel');
  panel.hidden = false;
  $('more-button').setAttribute('aria-expanded', 'true');
  if (detailsId) {
    const details = $(detailsId);
    if (details) details.open = true;
  }
  const first = panelFocusables()[0] ?? $('panel-close');
  first.focus();
}

function closePanel(returnFocus = true) {
  if (!panelOpen) return;
  panelOpen = false;
  $('secondary-panel').hidden = true;
  $('more-button').setAttribute('aria-expanded', 'false');
  if (returnFocus) $('more-button').focus();
}

function trapPanelTab(event) {
  const focusables = panelFocusables();
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

// --- init ---------------------------------------------------------------------

async function init() {
  let reply = null;
  try {
    reply = await send({ type: 'get-status' });
  } catch {
    reply = null;
  }
  if (reply) {
    if (reply.state) currentState = reply.state;
    if (reply.sessionStatus) {
      currentSessionStatus = reply.sessionStatus;
      sessionStatusSeq = 1;
    }
    if (reply.lastDiagnostic) {
      lastDiagnostic = reply.lastDiagnostic;
      diagnosticSeq = 1;
    }
    renderStatus(reply);
    if (reply.notice) showNotice(reply.notice);
    if (reply.pendingJoin) renderPendingJoin(reply.pendingJoin, reply.pendingJoinCount ?? 1);
    renderDiagnosticDrawer();
  } else {
    renderBanner();
    renderParticipants();
    showError('无法读取后台状态，请重新打开扩展窗口');
  }
  $('loading-state').hidden = true;
}

document.addEventListener('DOMContentLoaded', init);

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'status':
      renderStatus(message);
      break;
    case 'state':
      if (message.state) {
        currentState = message.state;
        renderResourceCard();
        renderBanner();
      }
      break;
    case 'session-status':
      currentSessionStatus = message.status;
      sessionStatusSeq += 1;
      renderParticipants();
      renderBanner();
      renderDiagnosticDrawer();
      break;
    case 'diagnostic':
      if (message.diagnostic) {
        lastDiagnostic = message.diagnostic;
        diagnosticSeq += 1;
      }
      renderDiagnosticDrawer();
      renderBanner();
      break;
    case 'local-permission-request':
      localPermission = message.permission ?? null;
      renderLocalPermission();
      break;
    case 'local-permission-granted':
      if (localPermission?.origin === message.origin) localPermission = null;
      renderLocalPermission();
      showNotice('已授权本地视频地址，正在继续同步');
      break;
    case 'notice':
      renderLocalPermission();
      showNotice(message.text);
      break;
    case 'join-request':
      renderPendingJoin(message.join, message.pendingCount ?? 1);
      break;
    case 'join-request-clear':
      renderPendingJoin(null);
      break;
    default:
      break;
  }
});

// Keep the projected playhead live (authoritative anchor, not a frozen value).
setInterval(() => {
  if (lastStatus === 'connected' && currentState && !$('resource-body').hidden) {
    updatePlaybackFields();
  }
}, 1000);

// --- wiring -------------------------------------------------------------------

$('connect-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void doConnect();
});

$('connect').addEventListener('click', () => {
  void doConnect();
});

$('disconnect').addEventListener('click', () => {
  void send({ type: 'disconnect' });
});

$('session').addEventListener('input', () => {
  clearFieldErrors();
});

$('server').addEventListener('input', () => {
  const el = $('err-server');
  el.textContent = '';
  el.hidden = true;
});

$('port').addEventListener('input', () => {
  const el = $('err-port');
  el.textContent = '';
  el.hidden = true;
});

$('advanced-toggle').addEventListener('click', () => {
  const fields = $('advanced-fields');
  fields.hidden = !fields.hidden;
  $('advanced-toggle').setAttribute('aria-expanded', String(!fields.hidden));
});

$('joinaccept').addEventListener('click', () => {
  void sendJoinDecision(true);
});

$('joinreject').addEventListener('click', () => {
  void sendJoinDecision(false);
});

$('grant-local-permission').addEventListener('click', () => {
  void grantLocalPermission();
});

$('deny-local-permission').addEventListener('click', () => {
  void denyLocalPermission();
});

$('view-diagnostic').addEventListener('click', () => {
  openPanel('details-diagnostic');
});

$('open-diagnostic').addEventListener('click', () => {
  openPanel('details-diagnostic');
});

$('more-button').addEventListener('click', () => {
  if (panelOpen) closePanel(true);
  else openPanel();
});

$('panel-close').addEventListener('click', () => {
  closePanel(true);
});

document.addEventListener('keydown', (event) => {
  if (!panelOpen) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closePanel(true);
  } else if (event.key === 'Tab') {
    trapPanelTab(event);
  }
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseShareString };
}
