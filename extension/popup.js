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

const ADAPTER_LABELS = { bilibili: 'Bilibili', youtube: 'YouTube', 'local-video': '本地视频' };

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
  'awaiting-actual-state': '等待双方回报当前页面状态',
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
  'session-full': '会话已满（最多两名参与者），请让主机创建新会话后重试',
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
let mode = 'host'; // selected roleHint; NOT the granted role
let actualRole = null; // join-accepted.role, only meaningful while connected
let selfParticipantId = null;
let submitLock = false; // connect is single-submission until a status frame
let decisionLock = false; // join accept/reject is single-submission
let fetchInFlight = false; // local Session API read in progress
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
  // Project the authoritative playhead to now instead of freezing the anchor.
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
  const primary = $('connect');
  const disconnectBtn = $('disconnect');
  const viewDiag = $('view-diagnostic');
  const switchRole = $('switch-role');

  icon.textContent = UI_ICONS[state];
  icon.className = `status-icon state-${state}`;
  icon.classList.toggle('pulse', state === 'connecting' || state === 'waiting');
  label.textContent = UI_LABELS[state];

  let description;
  switch (state) {
    case 'disconnected':
      description = '选择角色并填写必要信息';
      break;
    case 'connecting':
      description = mode === 'client'
        ? '已发送加入请求，等待主机审批'
        : '请保持此窗口打开，正在完成加入';
      break;
    case 'connected':
      description = '正在读取会话状态';
      break;
    case 'waiting':
      description = REASON_LABELS[currentSessionStatus?.reason] ?? '等待会话就绪';
      break;
    case 'ready':
      description = '双方状态一致；播放请使用视频页原生播放器';
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
  primary.hidden = inFamily;
  primary.disabled = submitLock || state === 'connecting';
  primary.textContent = state === 'error' ? '重试连接'
    : state === 'connecting'
      ? (mode === 'client' ? '正在连接主机…' : '连接中…')
      : (mode === 'client' ? '加入会话' : '连接并创建会话');

  disconnectBtn.hidden = !inFamily;
  disconnectBtn.disabled = !inFamily;
  viewDiag.hidden = state !== 'degraded';

  switchRole.hidden = true;
  if (state === 'error') {
    const code = rejectCodeFromError(lastErrorText);
    if (code === 'host-required') {
      switchRole.hidden = false;
      switchRole.textContent = '切换为主机';
    } else if (code === 'host-already-exists') {
      switchRole.hidden = false;
      switchRole.textContent = '切换为从机';
    }
  }

  applyLock();
}

function applyLock() {
  const locked = submitLock || lastStatus === 'connecting' || lastStatus === 'connected';
  $('modehost').disabled = locked;
  $('modeclient').disabled = locked;
  for (const id of ['server', 'port', 'session', 'participant']) $(id).disabled = locked;
  $('localsession').disabled = locked || fetchInFlight;
  updateShareAvailability();
}

// --- mode / config card ------------------------------------------------------

function setMode(next, skipFetch = false) {
  const host = next === 'host';
  mode = host ? 'host' : 'client';
  $('modehost').checked = host;
  $('modeclient').checked = !host;

  const serverInput = $('server');
  serverInput.readOnly = host;
  $('label-server').textContent = host ? '本机伴随进程地址' : '主机地址';
  $('hint-server').textContent = host
    ? '仅连接本机；Session 由本机伴随进程提供'
    : '主机分享的地址（IP 或主机名）';
  $('copysession').hidden = !host;
  $('localsession').hidden = !host;
  const sessionInput = $('session');
  sessionInput.placeholder = host ? '本机 Session ID' : '主机分享的 Session ID';
  if (host) {
    serverInput.value = '127.0.0.1';
  } else if (serverInput.value.trim() === '127.0.0.1') {
    // Do not carry the host-only localhost default into client mode.
    serverInput.value = '';
  }
  if (!host) $('share-text').textContent = '—';

  clearFieldErrors();
  $('hint-session').textContent = '';
  if (host && !skipFetch && lastStatus !== 'connected' && !sessionInput.value.trim()) {
    void fetchLocalSession();
  }
  renderBanner();
}

function validateForm(server, port, sessionId) {
  if (mode === 'client' && !server) return { id: 'server', text: '请输入主机地址（IP 或主机名）' };
  const portNum = Number(port);
  if (!port || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return { id: 'port', text: '端口需为 1–65535 之间的整数' };
  }
  if (mode === 'client' && !sessionId) return { id: 'session', text: '请输入主机分享的 Session ID' };
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

async function fetchLocalSession() {
  if (fetchInFlight) return;
  const port = $('port').value.trim() || '8765';
  fetchInFlight = true;
  $('localsession').disabled = true;
  $('hint-session').textContent = '正在读取本机 Session…';
  const reply = await send({ type: 'get-local-session', port });
  fetchInFlight = false;
  $('localsession').disabled = false;
  if (!reply || reply.ok === false) {
    $('hint-session').textContent = reply?.error
      ?? '无法读取本机 Session。请确认伴随进程已启动（本机 API 端口为 WS 端口 + 1）。';
    return;
  }
  $('session').value = reply.sessionId;
  $('hint-session').textContent = '';
  updateShareAvailability();
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

async function copySession() {
  const host = $('server').value.trim();
  const port = $('port').value.trim() || '8765';
  const sessionId = $('session').value.trim();
  if (!sessionId) return showError('请先获取或填写 Session ID');
  const reply = await send({ type: 'copy-session', host, port, sessionId });
  if (!reply || reply.ok === false) return showError(reply?.error ?? '无法生成分享串');
  $('share-text').textContent = reply.share;
  $('copyshare').disabled = false;
  const copied = await copyText(reply.share);
  if (copied) showNotice('已复制，可发送给从机');
  else showError('复制失败，请手动复制分享串');
}

async function doConnect() {
  const state = computeUiState();
  if (submitLock || state === 'connecting' || CONNECTED_FAMILY.includes(state)) return;
  const server = $('server').value.trim();
  const port = $('port').value.trim();
  const sessionId = $('session').value.trim();
  const participantId = $('participant').value.trim();
  const firstError = validateForm(server, port, sessionId);
  if (firstError) {
    showFieldError(firstError);
    return;
  }
  clearFieldErrors();
  submitLock = true; // lock before the round-trip; the status frame releases it
  renderBanner();
  const reply = await send({
    type: 'connect',
    mode,
    roleHint: mode,
    host: server,
    port,
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

// --- status / role -----------------------------------------------------------

function renderRoleBadge() {
  const badge = $('role-badge');
  if (actualRole) {
    badge.textContent = `实际角色 · ${actualRole === 'host' ? '主机' : '从机'}`;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function renderStatus(info) {
  prevStatus = lastStatus;
  lastStatus = info.status;
  lastErrorText = info.lastError ?? null;
  lastStatusInfo = info;
  localPermission = info.localPermission ?? null;

  if (lastStatus === 'connected') {
    actualRole = info.role ?? null;
    selfParticipantId = info.participantId ?? null;
  } else {
    actualRole = null;
    selfParticipantId = null;
  }
  renderRoleBadge();

  // join-accepted.role differs from the selected hint: confirm the authority's
  // assignment once, and never treat the radio choice as the granted role.
  if (lastStatus === 'connected' && prevStatus !== 'connected'
    && info.role && info.role !== info.mode) {
    showNotice(`已按会话权威分配为${info.role === 'host' ? '主机' : '从机'}`);
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
    const rolePill = document.createElement('span');
    rolePill.className = 'pill';
    rolePill.textContent = p.role === 'host' ? '主机' : '从机';
    name.appendChild(rolePill);
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
  $('resource-url').textContent = identity.canonicalUrl;
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

// --- join approval (spec §6.2) ------------------------------------------------

function updatePlaybackFields() {
  if (!currentState) return;
  const phase = currentState.mediaPhase;
  $('resource-phase').textContent = PHASE_LABELS[phase] ?? phase ?? '未知';
  $('resource-position').textContent = formatTime(projectedPosition(currentState));
  $('resource-duration').textContent = currentState.durationSeconds == null
    ? '时长未知'
    : formatTime(currentState.durationSeconds);
  const rate = Number.isFinite(currentState.playbackRate) ? currentState.playbackRate : 1;
  $('resource-rate').textContent = `${rate.toFixed(2)}×`;
  $('resource-revision').textContent = `#${Number.isInteger(currentState.stateRevision) ? currentState.stateRevision : '?'}`;
  $('resource-error').hidden = phase !== 'error';
}

// --- join approval (spec §6.2) ------------------------------------------------

function renderPendingJoin(join) {
  pendingJoin = join;
  const card = $('join-approval');
  const show = !!join && lastStatus === 'connected' && actualRole === 'host';
  card.hidden = !show;
  if (!show) return;
  $('join-requester-id').textContent = join.participantId;
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
    ? '恢复建议：等待第二位参与者加入；若无法加入，可断开后重新建立会话。'
    : '恢复建议：重新确认双方打开同一视频页并等待页面回报；必要时在视频页操作一次以触发重新上报。';
  body.appendChild(recovery);
}

function renderConnectionDetails() {
  const dl = $('connection-details');
  dl.textContent = '';
  const port = $('port').value.trim() || '8765';
  const api = lastStatusInfo?.api
    ?? (mode === 'host' ? `http://127.0.0.1:${Number(port) + 1}/api/session` : null);
  addKv(dl, '实际角色', actualRole ? (actualRole === 'host' ? '主机' : '从机') : '—');
  addKv(dl, 'Session ID', $('session').value.trim() || '—');
  addKv(dl, '主机地址', $('server').value.trim() || '—');
  addKv(dl, 'WebSocket 端口', port);
  addKv(dl, 'API 地址', api ?? '—');
  addKv(dl, '参与者 ID', selfParticipantId ?? '—');
}

function renderShareText(share) {
  if (share) {
    $('share-text').textContent = share;
    $('copyshare').disabled = false;
  }
}

function updateShareAvailability() {
  const hasSession = !!$('session').value.trim();
  $('copysession').disabled = !hasSession;
  $('copyshare').disabled = mode !== 'host' || !hasSession;
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
    if (reply.mode) setMode(reply.mode === 'host' ? 'host' : 'client', true);
    renderStatus(reply);
    if (reply.notice) showNotice(reply.notice);
    if (reply.pendingJoin) renderPendingJoin(reply.pendingJoin);
    renderDiagnosticDrawer();
  } else {
    renderBanner();
    renderParticipants();
    showError('无法读取后台状态，请重新打开扩展窗口');
  }
  $('loading-state').hidden = true;
  // Host mode with no live session and no session id yet: pull it from the
  // local companion API so the user sees it before connecting.
  if (mode === 'host' && lastStatus !== 'connected' && !$('session').value.trim()) {
    void fetchLocalSession();
  }
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
      renderPendingJoin(message.join);
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

$('modehost').addEventListener('change', () => setMode('host'));
$('modeclient').addEventListener('change', () => setMode('client'));

$('session').addEventListener('input', () => {
  clearFieldErrors();
  updateShareAvailability();
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

$('localsession').addEventListener('click', () => {
  void fetchLocalSession();
});

$('copysession').addEventListener('click', () => {
  void copySession();
});

$('copyshare').addEventListener('click', () => {
  void copySession();
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

$('switch-role').addEventListener('click', () => {
  setMode(mode === 'host' ? 'client' : 'host');
  showNotice(mode === 'host' ? '已切换为主机模式，请重试连接' : '已切换为从机模式，请重试连接');
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
