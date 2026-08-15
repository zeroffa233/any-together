'use strict';

/**
 * AnyTogether popup — host/client mode switch, session form (host: localhost +
 * auto-fetched Session ID + copy share; client: host/port/session/participant),
 * connection status, authoritative state display, session readiness, pending
 * join requests. There are no playback controls: native player content events
 * in the synced pages are the only intent source. Talks to the background
 * worker via chrome.runtime messaging; it never opens a WebSocket itself.
 */

const $ = (id) => document.getElementById(id);

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
const STATUS_LABELS = {
  disconnected: '未连接',
  connecting: '连接中',
  connected: '已连接',
  error: '错误',
};
const READINESS_REASONS = {
  'awaiting-second-participant': '等待第二参与者加入',
  'awaiting-actual-state': '等待从机回报实际状态',
  'actual-state-desync': '实际状态不同步',
};
// Phases that can never satisfy a session: show them explicitly as not ready.
const UNACCEPTABLE_PHASES = ['ended', 'buffering', 'error'];

let currentState = null;
let lastStatus = 'disconnected';
let currentSessionStatus = null;
let pendingJoin = null;
let mode = 'host';

function send(message) {
  return chrome.runtime.sendMessage(message).catch(() => ({ ok: false, error: '后台服务不可用' }));
}

function showError(text) {
  const el = $('error');
  el.textContent = text ?? '';
  el.classList.toggle('visible', !!text);
}

function showNotice(text) {
  const el = $('notice');
  el.textContent = text ?? '';
  el.classList.toggle('visible', !!text);
}

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

function setMode(next, skipFetch = false) {
  const host = next === 'host';
  mode = host ? 'host' : 'client';
  $('modehost').checked = host;
  $('modeclient').checked = !host;
  // Host mode talks to the LOCAL companion: the server address is fixed and
  // the session comes from the local Session API.
  $('server').readOnly = host;
  $('copysession').classList.toggle('hidden', !host);
  $('localsession').classList.toggle('hidden', host);
  $('session').placeholder = host ? '自动从本机伴随进程获取' : '主机分享的 Session ID';
  if (host) {
    $('server').value = '127.0.0.1'; // host mode talks to the local machine only
  } else if ($('server').value.trim() === '127.0.0.1') {
    // Do not carry the host-only localhost default into client mode.
    $('server').value = '';
  }
  if (host && !skipFetch && lastStatus !== 'connected' && !$('session').value.trim()) {
    void fetchLocalSession();
  }
}

async function fetchLocalSession() {
  const port = $('port').value.trim() || '8765';
  const reply = await send({ type: 'get-local-session', port });
  if (!reply || reply.ok === false) {
    showNotice(reply?.error ?? '无法获取本机 Session');
    return;
  }
  $('session').value = reply.sessionId;
  $('copysession').disabled = false;
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
  if (!reply || reply.ok === false) return showError(reply?.error ?? '无法生成共享信息');
  const copied = await copyText(reply.share);
  if (copied) showNotice('已复制共享信息，发送给从机即可加入');
  else showError('复制失败，请手动发送 Session ID');
}

function renderStatus(info) {
  lastStatus = info.status;
  const el = $('status');
  el.textContent = STATUS_LABELS[info.status] ?? info.status;
  el.className = `badge status-${info.status}`;

  const connected = info.status === 'connected';
  let sessionLine = connected
    ? `角色: ${info.role === 'host' ? '主机' : '从机'} · Session: ${info.sessionId} · 参与者: ${info.participantId}`
    : '';
  if (connected && info.api) sessionLine += ` · API: ${info.api}`;
  $('sessioninfo').textContent = sessionLine;
  $('videolink').textContent = connected && info.canonicalUrl ? `视频: ${info.canonicalUrl}` : '';
  if (!connected) {
    currentState = null;
    currentSessionStatus = null;
    $('state').textContent = '—';
    $('diagnostics').textContent = '';
    renderPendingJoin(null);
  }
  // Restore the connection form from live status so a reopened popup is never
  // empty while the worker still holds the session.
  if (info.host && (info.status === 'connected' || info.status === 'connecting')) $('server').value = info.host;
  if (info.port && (info.status === 'connected' || info.status === 'connecting')) $('port').value = String(info.port);
  if (info.sessionId && !$('session').value.trim()) $('session').value = info.sessionId;
  if (info.participantId && !$('participant').value.trim()) $('participant').value = info.participantId;
  $('copysession').disabled = !$('session').value.trim();
  $('resync').disabled = !connected;
  showError(info.lastError ?? '');
  renderReadiness(currentSessionStatus);
}

function renderReadiness(sessionStatus) {
  const el = $('readiness');
  if (!sessionStatus || lastStatus !== 'connected') {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.classList.remove('hidden');
  if (sessionStatus.ready) {
    el.textContent = '会话就绪';
    el.className = 'badge readiness-ready';
  } else {
    const reason = READINESS_REASONS[sessionStatus.reason] ?? sessionStatus.reason ?? '';
    el.textContent = `未就绪${reason ? `：${reason}` : ''}`;
    el.className = 'badge readiness-pending';
  }
}

function renderState(state) {
  if (!state) return;
  currentState = state;
  const phase = PHASE_LABELS[state.mediaPhase] ?? state.mediaPhase ?? '未知';
  const position = formatTime(projectedPosition(state));
  const duration = formatTime(state.durationSeconds);
  const rate = Number.isFinite(state.playbackRate) ? state.playbackRate : 1;
  const revision = Number.isInteger(state.stateRevision) ? state.stateRevision : '?';
  const el = $('state');
  el.textContent =
    `${phase} · ${position} / ${duration} @ ${rate.toFixed(2)}x · 修订 #${revision}`;
  // ended/buffering/error can never satisfy a session: mark the state line so
  // it is never mistaken for a ready session.
  el.classList.toggle('state-bad', UNACCEPTABLE_PHASES.includes(state.mediaPhase));
}

function renderDiagnostic(diagnostic) {
  $('diagnostics').textContent = diagnostic
    ? `诊断 (${diagnostic.code}): ${diagnostic.detail}`
    : '';
}

function renderPendingJoin(join) {
  pendingJoin = join;
  const section = $('joinrequest');
  if (!join) {
    section.classList.add('hidden');
    return;
  }
  $('joinrequest-info').textContent = join.resourceIdentity
    ? `第二参与者请求加入：${join.participantId}（视频 ${join.resourceIdentity.canonicalUrl}）`
    : `第二参与者请求加入：${join.participantId}（未提供视频）`;
  section.classList.remove('hidden');
}

async function sendJoinDecision(accepted) {
  const reply = await send({ type: 'join-decision', accepted });
  if (reply && reply.ok === false) showError(reply.error ?? '发送加入决定失败');
  else renderPendingJoin(null);
}

function init() {
  send({ type: 'get-status' })
    .then((reply) => {
      if (!reply) return;
      // Restore the mode the worker is running so a reopened popup matches the
      // live session before the fields are filled from status.
      if (reply.mode) setMode(reply.mode, true);
      if (reply.status) renderStatus(reply);
      if (reply.state) renderState(reply.state);
      if (reply.sessionStatus) {
        currentSessionStatus = reply.sessionStatus;
        renderReadiness(currentSessionStatus);
      }
      if (reply.lastDiagnostic) renderDiagnostic(reply.lastDiagnostic);
      if (reply.notice) showNotice(reply.notice);
      if (reply.pendingJoin) renderPendingJoin(reply.pendingJoin);
      // Host mode with no live session and no session id yet: pull it from the
      // local companion API so the user sees it before connecting.
      if (mode === 'host' && lastStatus !== 'connected' && !$('session').value.trim()) {
        void fetchLocalSession();
      }
    })
    .catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'status':
      renderStatus(message);
      break;
    case 'state':
      renderState(message.state);
      break;
    case 'session-status':
      currentSessionStatus = message.status;
      renderReadiness(currentSessionStatus);
      break;
    case 'diagnostic':
      renderDiagnostic(message.diagnostic);
      break;
    case 'notice':
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

setInterval(() => {
  if (lastStatus === 'connected' && currentState) renderState(currentState);
}, 1000);

$('modehost').addEventListener('change', () => setMode('host'));
$('modeclient').addEventListener('change', () => setMode('client'));

$('session').addEventListener('input', () => {
  $('copysession').disabled = !$('session').value.trim();
});

$('copysession').addEventListener('click', () => {
  void copySession();
});

$('localsession').addEventListener('click', () => {
  void fetchLocalSession();
});

$('connect').addEventListener('click', async () => {
  const host = $('server').value.trim();
  const port = $('port').value.trim();
  const sessionId = $('session').value.trim();
  const participantId = $('participant').value.trim();
  if (!host) return showError('请输入主机地址');
  if (!port) return showError('请输入端口');
  // Host mode may leave the session empty: the background auto-fetches it
  // from the local companion API. A client needs the host's session id.
  if (mode === 'client' && !sessionId) return showError('请输入主机分享的 Session ID');
  const reply = await send({
    type: 'connect',
    mode,
    roleHint: mode,
    host,
    port,
    sessionId,
    participantId,
  });
  if (reply && reply.ok === false) showError(reply.error ?? '连接失败');
});

$('disconnect').addEventListener('click', () => {
  void send({ type: 'disconnect' });
});

$('joinaccept').addEventListener('click', () => {
  void sendJoinDecision(true);
});

$('joinreject').addEventListener('click', () => {
  void sendJoinDecision(false);
});
  $('resync').addEventListener('click', async () => {
    const reply = await send({ type: 'resync' });
    if (reply && reply.ok === false) showError(reply.error ?? '重新同步失败');
  });
