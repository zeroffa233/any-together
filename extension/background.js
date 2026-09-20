'use strict';

/**
 * AnyTogether MV3 background (service worker).
 *
 * Holds the only WebSocket: it talks to the Node companion authority
 * (src/server/session-authority.ts) using the wire protocol from
 * src/shared/protocol.ts. The popup and the Bilibili content script reach this
 * worker through chrome.runtime messaging; the content script never touches
 * the socket.
 *
 * Responsibilities:
 *  - connect to the CLI (the only host) through a share string or the
 *    advanced host/port/session fields — 127.0.0.1 works the same as a LAN
 *    address, so there is no host/client mode in the extension;
 *  - either side may switch videos: a page navigation to another supported
 *    video re-binds the resource via resource-bind and the other side follows
 *    in its own tab;
 *  - surface pending join requests to the host popup and relay its decision;
 *  - wrap content-script observations (host tab AND client tab) into
 *    ActualStateReport messages — native player content events are the only
 *    intent source;
 *  - adopt authoritative states only when strictly newer (stale protection)
 *    and, when the authority switched the session resource, adopt the new
 *    identity with the new revision and re-route; apply states strictly in
 *    revision order on one serialized queue so an older apply can never
 *    overwrite a newer state;
 *  - route authoritative PlaybackState to the participant's OWN tab (the host
 *    tab in host mode, the client tab in client mode), overwriting its URL in
 *    place — a tab is created only when no reusable page exists — and wait
 *    for the route before applying to avoid concurrent tab/apply races.
 */

// Shared browser-side syncer identity registry (URL matching, canonical
// identity derivation, capability listing) — one source of truth for all
// site-specific logic in the extension.
importScripts('identity.js');
const IDENTITY = globalThis.AnyTogetherIdentity;

const SESSION = {
  status: 'disconnected', // disconnected | connecting | connected | error
  ws: null,
  keepalive: null,
  host: '',
  port: 0,
  sessionId: '',
  participantId: '',
  role: null,
  hostTabId: null, // host mode's apply target: the tab the host page plays in;
  // its content-ready identity changes trigger resource-bind
  bindInFlight: null, // resource identity of a resource-bind sent but not yet adopted
  pendingLocalPermission: null, // { origin, pattern, canonicalUrl } awaiting popup user gesture
  injectedLocalTabs: new Set(), // local-video tabs injected after navigation
  commandedNavigations: new Map(), // tabId -> { url, atMs } navigations we issued via routeCanonical
  lastRoutedFingerprint: null, // resource fingerprint whose URL we already auto-navigated to once
  identity: null, // session ResourceIdentity; adopted from join-accepted or a
  // newer authoritative state after a participant resource-bind
  // Client-only one-time auto recovery: once the authority reports the session
  // ready, the client tab is refreshed in place exactly once per resource so
  // the page re-injects the authoritative state and reports its actual state.
  // The fingerprint dedups by resource (adapterId|canonicalUrl|resourceId) —
  // revisions/playback updates never re-trigger it, a resource switch does.
  clientAutoRecoveredFingerprint: null, // resource whose recovery already ran
  clientRecoverInFlight: null, // fingerprint of a recovery reload in the queue
  latestState: null, // most recent accepted authoritative PlaybackState
  latestStatus: null, // most recent session-status broadcast
  lastDiagnostic: null, // most recent structured diagnostic
  pendingJoin: null, // join-request awaiting the host decision
  nextCommandSeq: 0,
  clientTabId: null, // client mode's apply target; content-ready registrations
  // and tab takeover keep it pointing at the session page
  lastAppliedRevision: -1,
  applyQueue: Promise.resolve(), // serializes route+apply work
  lastCreateAt: 0, // throttle for repeated tab creation (redirect loops)
  lastError: null,
  notice: null, // soft page notice (no media yet, page navigated away, ...)
};

const VALID_INTENT_KINDS = ['play', 'pause', 'seek', 'set-rate', 'replay'];
const CREATE_TAB_THROTTLE_MS = 10000;
const DEFAULT_PORT = 8765;

// --- identity helpers (delegated to the shared AnyTogetherIdentity registry) --

// --- local-video runtime permission and injection ---------------------------

function localPermissionDescriptor(url) {
  const identity = IDENTITY.deriveIdentity(url);
  if (!identity || identity.adapterId !== 'local-video') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  return {
    origin: parsed.origin,
    pattern: `${parsed.origin}/*`,
    canonicalUrl: `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`,
  };
}

function setLocalPermissionPrompt(descriptor) {
  const previous = SESSION.pendingLocalPermission;
  SESSION.pendingLocalPermission = descriptor;
  if (!previous || previous.origin !== descriptor.origin) {
    notifyPopup({ type: 'local-permission-request', permission: descriptor });
  }
  setNotice(`本地视频需要访问 ${descriptor.origin}，请在扩展窗口中授权`);
}

async function ensureLocalOriginPermission(url) {
  const descriptor = localPermissionDescriptor(url);
  if (descriptor === null) return true;
  if (typeof chrome.permissions?.contains !== 'function') {
    setNotice('当前浏览器不支持本地视频权限检查');
    setLocalPermissionPrompt(descriptor);
    return false;
  }
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: [descriptor.pattern] });
  } catch (error) {
    setNotice(`无法检查本地视频权限: ${error instanceof Error ? error.message : String(error)}`);
    setLocalPermissionPrompt(descriptor);
    return false;
  }
  if (granted) {
    if (SESSION.pendingLocalPermission?.origin === descriptor.origin) {
      SESSION.pendingLocalPermission = null;
      notifyPopup({ type: 'local-permission-granted', origin: descriptor.origin });
    }
    return true;
  }
  setLocalPermissionPrompt(descriptor);
  return false;
}

async function ensureLocalContentScript(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return false;
  }
  if (!tab?.url || localPermissionDescriptor(tab.url) === null) return true;
  if (!(await ensureLocalOriginPermission(tab.url))) return false;
  // A service-worker restart loses the in-memory Set. Ping first so a second
  // injection cannot create duplicate listeners/timers in the page.
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: 'content-ping' });
    if (reply?.ok === true) {
      SESSION.injectedLocalTabs.add(tabId);
      return true;
    }
  } catch {
    // No content script yet; execute it below.
  }
  if (typeof chrome.scripting?.executeScript !== 'function') {
    setNotice('当前浏览器不支持动态注入本地视频同步脚本');
    return false;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['identity.js', 'content.js'],
    });
    SESSION.injectedLocalTabs.add(tabId);
    return true;
  } catch (error) {
    setNotice(`本地视频同步脚本注入失败: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function handleLocalPermissionResult(origin, granted) {
  const pending = SESSION.pendingLocalPermission;
  if (!pending || pending.origin !== origin) {
    return { ok: false, error: '没有待处理的本地视频权限请求' };
  }
  if (granted === true) {
    SESSION.pendingLocalPermission = null;
    SESSION.notice = null;
    notifyPopup({ type: 'local-permission-granted', origin });
    enqueueApply();
    return { ok: true };
  }
  setNotice(`未授权访问 ${origin}，本地视频不会开始同步`);
  return { ok: true, granted: false };
}

// deriveIdentity / identityEqual / isSupportedUrl live in extension/identity.js
// so no domain logic is duplicated in this worker.

// --- session share ------------------------------------------------------------

/**
 * Share string a host hands to its clients: host, ws port and session id in
 * one copyable payload. The client can paste/type the pieces into its popup.
 */
function buildShare(host, port, sessionId) {
  return `anytogether://session?host=${encodeURIComponent(host)}&port=${Number(port)}&session=${encodeURIComponent(sessionId)}`;
}

// --- popup notification ------------------------------------------------------

function notifyPopup(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // No receiver (popup closed).
  }
}

function setStatus(status) {
  SESSION.status = status;
  notifyPopup({
    type: 'status',
    status,
    role: SESSION.role,
    sessionId: SESSION.sessionId,
    session: SESSION.sessionId,
    participantId: SESSION.participantId,
    host: SESSION.host,
    port: SESSION.port,
    api: SESSION.port > 0
      ? `http://127.0.0.1:${SESSION.port + 1}/api/session`
      : null,
    share: SESSION.host && SESSION.sessionId
      ? buildShare(SESSION.host, SESSION.port, SESSION.sessionId)
      : null,
    canonicalUrl: SESSION.identity ? SESSION.identity.canonicalUrl : null,
    localPermission: SESSION.pendingLocalPermission,
    lastError: SESSION.lastError,
  });
}

function setNotice(text) {
  SESSION.notice = text;
  notifyPopup({ type: 'notice', text });
}

// --- connection lifecycle ----------------------------------------------------

async function connect(options) {
  // Idempotent lifecycle guard: a repeated connect click must never tear down
  // a healthy (or in-flight) connection. Only a disconnected or errored
  // session may start a fresh socket.
  if (SESSION.status === 'connecting') {
    return { ok: false, error: '正在连接中，请稍候' };
  }
  if (SESSION.status === 'connected') {
    return { ok: false, error: '已连接，请先断开再重新连接' };
  }
  // Reaching this point the session is disconnected or errored: reset any
  // leftover socket state (disconnect() is idempotent) and build fresh.
  disconnect();
  // Every extension is the same kind of client — the CLI is the only host.
  // A CLI on THIS machine is still reached through the loopback address, so
  // there is no host/client mode: just an address, a port and a session.
  let host = String(options.host ?? '').trim().replace(/^wss?:\/\//, '');
  let port = Number(options.port);
  // An inline `host:port` in the address field wins over the separate port
  // field. Without this, `192.168.1.5:8765` plus the default port 8765 would
  // produce a duplicated `ws://192.168.1.5:8765:8765`.
  const inline = host.match(/^([^:/]+):(\d+)$/);
  if (inline) {
    host = inline[1];
    port = Number(inline[2]);
  }
  host = host.replace(/\/+$/, '');
  if (!host) host = '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) port = DEFAULT_PORT;

  const sessionId = String(options.sessionId ?? '').trim();
  if (!sessionId) return { ok: false, error: '缺少会话 ID 或分享串' };

  // Claim connecting BEFORE the first await: a second connect message is then
  // rejected synchronously above and can never slip in to duplicate this
  // attempt.
  SESSION.status = 'connecting';
  SESSION.host = host;
  SESSION.port = port;
  SESSION.lastError = null;
  SESSION.notice = null;
  SESSION.pendingJoin = null;
  SESSION.sessionId = sessionId;

  const participantId = String(options.participantId ?? '').trim()
    || `browser-${Math.random().toString(36).slice(2, 10)}`;

  SESSION.participantId = participantId;
  // The first joiner becomes the session's protocol host regardless of which
  // machine it sits on — the CLI (authority) is the real host. The joining
  // extension therefore never declares a roleHint: the legacy first-come rule
  // assigns roles with no mode switch anywhere in the UI.
  SESSION.hostTabId = null;
  // The authority is authoritative about the resource: SESSION.identity is
  // adopted from join-accepted (or a later resource-bind state), not here.
  SESSION.identity = null;
  setStatus('connecting');

  let ws;
  try {
    ws = new WebSocket(`ws://${host}:${port}`);
  } catch (error) {
    SESSION.lastError = `无效的服务器地址: ${error instanceof Error ? error.message : String(error)}`;
    setStatus('error');
    return { ok: false, error: SESSION.lastError };
  }
  SESSION.ws = ws;

  ws.addEventListener('open', () => {
    if (SESSION.ws !== ws) return;
    const join = {
      type: 'join',
      participantId: SESSION.participantId,
    };
    ws.send(JSON.stringify(join));
  });

  ws.addEventListener('message', (event) => {
    if (SESSION.ws === ws) handleServerMessage(event.data);
  });

  ws.addEventListener('error', () => {
    if (SESSION.ws !== ws) return;
    SESSION.lastError = SESSION.lastError
      ?? '无法连接到服务器，请核对地址与端口（公网部署需在服务器防火墙放行该端口）';
    setStatus('error');
  });

  ws.addEventListener('close', () => {
    if (SESSION.ws !== ws) return;
    SESSION.ws = null;
    SESSION.clientTabId = null;
    SESSION.hostTabId = null;
    SESSION.pendingLocalPermission = null;
    SESSION.injectedLocalTabs.clear();
    SESSION.commandedNavigations.clear();
    SESSION.bindInFlight = null;
    SESSION.clientAutoRecoveredFingerprint = null;
    SESSION.clientRecoverInFlight = null;
    SESSION.lastAppliedRevision = -1;
    SESSION.role = null;
    SESSION.latestState = null;
    SESSION.latestStatus = null;
    SESSION.lastDiagnostic = null;
    SESSION.pendingJoin = null;
    SESSION.notice = null;
    SESSION.applyQueue = Promise.resolve();
    stopKeepalive();
    if (SESSION.status !== 'error') {
      SESSION.lastError = null;
      setStatus('disconnected');
    }
  });

  return { ok: true };
}

function disconnect() {
  const ws = SESSION.ws;
  SESSION.ws = null;
  SESSION.clientTabId = null;
  SESSION.hostTabId = null;
  SESSION.bindInFlight = null;
  SESSION.clientAutoRecoveredFingerprint = null;
  SESSION.commandedNavigations.clear();
  SESSION.pendingLocalPermission = null;
  SESSION.injectedLocalTabs.clear();
  SESSION.clientRecoverInFlight = null;
  SESSION.lastAppliedRevision = -1;
  SESSION.role = null;
  SESSION.latestState = null;
  SESSION.latestStatus = null;
  SESSION.lastDiagnostic = null;
  SESSION.pendingJoin = null;
  SESSION.notice = null;
  SESSION.applyQueue = Promise.resolve();
  SESSION.lastError = null;
  stopKeepalive();
  if (ws) {
    try {
      ws.close();
    } catch {
      // Already closed.
    }
  }
  // Idempotent: repeated calls while already disconnected change nothing and
  // must not re-notify the popup.
  if (SESSION.status !== 'disconnected') setStatus('disconnected');
}

// --- wire protocol (src/shared/protocol.ts) ---------------------------------

function handleServerMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'join-accepted': {
      const state = message.state;
      if (message.participantId !== SESSION.participantId
        || !state || state.sessionId !== SESSION.sessionId) {
        return; // accepted for a different participant/session — ignore
      }
      SESSION.role = message.role;
      SESSION.participantId = message.participantId;
      // The authority is authoritative about the resource: adopt the pushed
      // identity so a joiner that never supplied one can still route and
      // report against the session resource.
      SESSION.identity = state.resourceIdentity;
      SESSION.lastError = null;
      startKeepalive();
      setStatus('connected');
      acceptAuthoritativeState(state);
      break;
    }
    case 'join-rejected':
      SESSION.lastError = `加入被拒绝: ${message.reason}`;
      setStatus('error');
      if (SESSION.ws) SESSION.ws.close();
      break;
    case 'join-request': {
      // Only the host receives join requests; surface the pending joiner in
      // the popup and wait for a join-decision.
      if (SESSION.role !== 'host' || !message.participantId) break;
      SESSION.pendingJoin = {
        participantId: message.participantId,
        ...(message.resourceIdentity ? { resourceIdentity: message.resourceIdentity } : {}),
      };
      notifyPopup({ type: 'join-request', join: SESSION.pendingJoin });
      break;
    }
    case 'state':
      if (message.state?.sessionId !== SESSION.sessionId) break;
      acceptAuthoritativeState(message.state, false);
      break;
    case 'snapshot':
      if (message.state?.sessionId !== SESSION.sessionId) break;
      acceptAuthoritativeState(message.state, true);
      break;
    case 'session-status':
      SESSION.latestStatus = message;
      notifyPopup({ type: 'session-status', status: message });
      // Client-only: once the session is ready, one in-place refresh per
      // resource re-syncs a page whose display drifted from the authority.
      maybeAutoRecoverClient();
      break;
    case 'diagnostic':
      SESSION.lastDiagnostic = message;
      notifyPopup({ type: 'diagnostic', diagnostic: message });
      break;
    case 'error':
      SESSION.lastError = `服务器错误 (${message.code}): ${message.message}`;
      setStatus(SESSION.status);
      break;
    default:
      break;
  }
}

/**
 * Adopt an authoritative state only when it is strictly newer than the
 * current one. A version gap means missed broadcasts: request the full
 * snapshot instead of guessing.
 *
 * The authority is authoritative about the session resource: when a strictly
 * newer state carries a DIFFERENT identity (a participant resource-bind
 * switched the video), the new identity is adopted together with the new
 * revision and the apply pipeline re-routes every participant page to the
 * fresh resource.
 */
function acceptAuthoritativeState(state, isSnapshot = false) {
  if (!state || typeof state !== 'object' || !Number.isInteger(state.stateRevision)) return;
  const currentRevision = SESSION.latestState?.stateRevision ?? -1;
  if (state.stateRevision <= currentRevision) return; // stale — never regress
  if (!isSnapshot && state.stateRevision > currentRevision + 1) {
    requestSnapshot();
    return;
  }
  if (state.resourceIdentity === null && SESSION.identity !== null) return; // defensive: no unbind exists
  if (state.resourceIdentity && !IDENTITY.identityEqual(state.resourceIdentity, SESSION.identity)) {
    // A participant switched the session resource: adopt the new identity so
    // routing and reporting follow the authoritative resource.
    SESSION.identity = state.resourceIdentity;
    if (SESSION.bindInFlight && IDENTITY.identityEqual(SESSION.bindInFlight, SESSION.identity)) {
      SESSION.bindInFlight = null; // the pending bind landed
    }
  }
  SESSION.latestState = state;
  if (!SESSION.identity) SESSION.identity = state.resourceIdentity;
  notifyPopup({ type: 'state', state });
  enqueueApply();
}

function requestSnapshot() {
  if (SESSION.status !== 'connected' || !SESSION.ws) return;
  SESSION.ws.send(JSON.stringify({
    type: 'snapshot-request',
    participantId: SESSION.participantId,
    observedRevision: SESSION.latestState?.stateRevision ?? 0,
  }));
}

// --- tab routing: keep the participant's own tab on the session resource ---

/**
 * The participant's own apply target: the host tab in host mode (the page the
 * host watches from), the client tab in client mode. All routing and applies
 * go through this single tab, so a session resource switch overwrites the
 * current page in place instead of piling up extra windows/tabs.
 */
function applyTargetTabId() {
  return SESSION.role === 'host' ? SESSION.hostTabId : SESSION.clientTabId;
}

function adoptApplyTarget(tabId) {
  if (SESSION.role === 'host') SESSION.hostTabId = tabId;
  else SESSION.clientTabId = tabId;
  SESSION.lastAppliedRevision = -1;
}

function clearApplyTarget() {
  if (SESSION.role === 'host') SESSION.hostTabId = null;
  else SESSION.clientTabId = null;
  SESSION.lastAppliedRevision = -1;
}

/**
 * Navigation commands issued by routeCanonical. A content-ready arriving from
 * such a tab within COMMANDED_NAV_WINDOW_MS is a transition echo (the old page
 * or a site redirect), never a user switch — the session is already going to
 * the commanded URL.
 */
const COMMANDED_NAV_WINDOW_MS = 3000;

function markCommandedNavigation(tabId, url) {
  SESSION.commandedNavigations.set(tabId, { url, atMs: Date.now() });
}

/**
 * Persistent-intent proof for a resource switch: a bind silently swallowed by
 * the authority's transition lock (or lost in flight) is re-sent every ~1.1s
 * as long as the requesting tab still sits on that identity. If the user moves
 * the tab elsewhere, or the session lands on the identity, the retry stops —
 * so echoes cannot resurrect and genuine intent is never lost.
 */
function scheduleBindRetry(tabId, identity, attemptsLeft, baseline) {
  if (attemptsLeft <= 0 || SESSION.status !== 'connected') return;
  setTimeout(() => {
    if (SESSION.status !== 'connected') return;
    // Landed: the session followed this identity.
    if (SESSION.identity && IDENTITY.identityEqual(identity, SESSION.identity)) return;
    // The session has moved to a DIFFERENT identity than both the request and
    // the baseline it had when the retry started: the transition confirmed on
    // another resource, so this request is a stale echo — never resurrect it.
    if (SESSION.identity && baseline !== null
      && !IDENTITY.identityEqual(identity, SESSION.identity)
      && !IDENTITY.identityEqual(SESSION.identity, baseline)) return;
    // A different bind is in flight: it owns the outcome now.
    if (SESSION.bindInFlight !== null && !IDENTITY.identityEqual(identity, SESSION.bindInFlight)) return;
    void (async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        const current = tab?.url ? IDENTITY.deriveIdentity(tab.url) : null;
        if (!current || !IDENTITY.identityEqual(current, identity)) return; // user moved on
        if (tabId === applyTargetTabId() || tab.active === true) {
          adoptApplyTarget(tabId);
          sendResourceBind(identity);
          scheduleBindRetry(tabId, identity, attemptsLeft - 1, baseline);
        }
      } catch {
        // Tab gone: nothing to prove anymore.
      }
    })();
  }, 1100);
}

 async function routeCanonical(canonicalUrl) {
  if (!(await ensureLocalOriginPermission(canonicalUrl))) return;
  if (!IDENTITY.isSupportedUrl(canonicalUrl)) return; // never open unsupported destinations

  // Prefer the participant's own tab and overwrite its URL in place: a
  // session resource switch (local or remote) must navigate the current page
  // to the new video, never spawn a new window/tab while a page exists.
  const ownTabId = applyTargetTabId();
  if (ownTabId !== null) {
    try {
      const tab = await chrome.tabs.get(ownTabId);
      if (!tab?.url) throw new Error('no url');
      if (IDENTITY.deriveIdentity(tab.url)?.canonicalUrl === canonicalUrl) {
        // Already on the session resource: make it the active page and apply.
        try {
          await chrome.tabs.update(ownTabId, { active: true });
        } catch {
          // Best-effort; applying state still works on a background tab.
        }
        adoptApplyTarget(ownTabId);
        return;
      }
      // Overwrite the participant's own tab with the session resource. The
      // old page is destroyed by the navigation, so no stale video keeps
      // playing (no overlapping audio) and no extra tab appears.
      await chrome.tabs.update(ownTabId, { url: canonicalUrl, active: true });
      markCommandedNavigation(ownTabId, canonicalUrl);
      adoptApplyTarget(ownTabId);
      return;
    } catch {
      // Tab gone or not updateable: fall through to a reusable page.
      clearApplyTarget();
    }
  }

  // No (or dead) own tab: reuse an existing supporting page before creating
  // anything. Prefer the current window, and a page already on the session
  // resource, then any supporting page (it will be navigated to the resource).
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  const reusable = (tab) => tab.id !== undefined && typeof tab.url === 'string' && IDENTITY.isSupportedUrl(tab.url);
  const onResource = (tab) => IDENTITY.deriveIdentity(tab.url)?.canonicalUrl === canonicalUrl;
  let currentWindowId = null;
  try {
    const current = await chrome.windows.getCurrent();
    currentWindowId = current?.id ?? null;
  } catch {
    // No window context; scan every window.
  }
  const inCurrentWindow = (tab) => currentWindowId === null || tab.windowId === currentWindowId;
  const match =
    tabs.find((tab) => reusable(tab) && inCurrentWindow(tab) && onResource(tab))
    ?? tabs.find((tab) => reusable(tab) && inCurrentWindow(tab))
    ?? tabs.find((tab) => reusable(tab) && onResource(tab))
    ?? tabs.find(reusable);
  if (match) {
    adoptApplyTarget(match.id);
    try {
      const update = { active: true };
      if (!onResource(match)) update.url = canonicalUrl;
      await chrome.tabs.update(match.id, update);
      if (update.url) markCommandedNavigation(match.id, update.url);
      if (match.windowId !== undefined) await chrome.windows.update(match.windowId, { focused: true });
    } catch {
      // Guidance is best-effort; applying state still works on a background tab.
    }
    return;
  }

  // No reusable page anywhere: only now may the initial tab be created.
  // Throttle repeated creation: a page that redirects away from the canonical
  // URL (login wall, anti-bot) must not cause an unbounded tab-creation loop.
  const now = Date.now();
  if (now - SESSION.lastCreateAt < CREATE_TAB_THROTTLE_MS) {
    setNotice('目标页面暂时无法打开（可能被重定向），请手动打开视频页面后重试');
    return;
  }
  try {
    const created = await chrome.tabs.create({ url: canonicalUrl });
    markCommandedNavigation(created.id, canonicalUrl);
    adoptApplyTarget(created.id);
    SESSION.lastCreateAt = Date.now();
  } catch (error) {
    SESSION.lastError = `无法打开目标页面: ${error instanceof Error ? error.message : String(error)}`;
    setStatus(SESSION.status);
  }
}

/**
 * Serialized route+apply pipeline. Every authoritative state (and every
 * content-ready re-registration) is enqueued here, so routeCanonical and the
 * tab apply can never race each other, and an older state can never be applied
 * after a newer one: each run applies whatever is the CURRENT latest state.
 */
function enqueueApply() {
  if (SESSION.status !== 'connected') return;
  SESSION.applyQueue = SESSION.applyQueue
    .then(() => routeAndApply())
    .catch((error) => {
      SESSION.lastError = error instanceof Error ? error.message : String(error);
      setStatus(SESSION.status);
    });
}

async function routeAndApply() {
  const state = SESSION.latestState;
  if (!state) return;
  if (SESSION.lastAppliedRevision >= state.stateRevision) return; // already applied
  // A client auto-recovery reload is queued for the current resource: applying
  // to the page that is about to be refreshed would re-report a stale page.
  // The reloaded page re-applies through its own content-ready registration.
  if (SESSION.clientRecoverInFlight !== null) return;
  const canonicalUrl = state.resourceIdentity?.canonicalUrl;
  if (!canonicalUrl || !IDENTITY.isSupportedUrl(canonicalUrl)) return;
  // Route first, apply only after the apply target is known — never race the two.
  await routeCanonical(canonicalUrl);
  if (applyTargetTabId() === null) return;
  await sendApplyToTab(state);
}

async function sendApplyToTab(state) {
  const canonicalUrl = state.resourceIdentity?.canonicalUrl;
  let tabId = applyTargetTabId();
  if (tabId === null) return;

  // The target tab may be gone or may have navigated away from the session
  // resource (SPA navigation): re-route before applying to the wrong page.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url) throw new Error('no url');
    const tabIdentity = IDENTITY.deriveIdentity(tab.url);
    if (tabIdentity?.canonicalUrl !== canonicalUrl) {
      if (tabIdentity) {
        // The page shows a DIFFERENT supported video: the participant just
        // switched videos and its content-ready is about to re-bind the
        // session (or already did). Do not fight the switch — the broadcast
        // state will re-route both sides. Apply nothing to the foreign page.
        return;
      }
      // Unsupported/blank page. Once THIS resource identity has been
      // auto-navigated to (fresh join or switch), a non-video page such as a
      // Bilibili search is USER intent — dragging the tab back would fight
      // the user. Leave gracefully; returning to a supported page (or opening
      // a new video there) re-registers via content-ready and restores sync.
      // Routing is still allowed when this identity was never routed (initial
      // open, service-worker restart, or a dead tab).
      const fingerprint = identityFingerprint(state.resourceIdentity);
      if (SESSION.lastRoutedFingerprint === fingerprint) {
        if (!SESSION.notice) setNotice('已暂时离开会话视频；回到支持的视频页将自动恢复同步');
        return;
      }
      SESSION.lastRoutedFingerprint = fingerprint;
      await routeCanonical(canonicalUrl);
      if (applyTargetTabId() === null) return;
    }
  } catch {
    clearApplyTarget();
    await routeCanonical(canonicalUrl);
    if (applyTargetTabId() === null) return;
  }
  tabId = applyTargetTabId();
  if (tabId === null || !(await ensureLocalContentScript(tabId))) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'apply-state', state });
    SESSION.lastAppliedRevision = state.stateRevision;
    if (SESSION.notice) setNotice(null);
  } catch {
    // Content script not ready yet (tab still loading): its content-ready
    // registration will re-trigger the apply once the page is up.
    if (!SESSION.notice) setNotice('目标页面加载中，就绪后自动同步');
  }
}

// --- sending -----------------------------------------------------------------

function sendIntent(kind, payload) {
  if (SESSION.status !== 'connected' || !SESSION.ws) throw new Error('未连接会话');
  if (!VALID_INTENT_KINDS.includes(kind)) throw new Error(`未知意图: ${kind}`);
  if (kind === 'seek') {
    if (!payload || !Number.isFinite(payload.targetSeconds) || payload.targetSeconds < 0) {
      throw new Error('seek 需要非负 targetSeconds');
    }
  } else if (kind === 'set-rate') {
    if (!payload || !Number.isFinite(payload.playbackRate) || payload.playbackRate <= 0 || payload.playbackRate > 16) {
      throw new Error('set-rate 需要 0 < playbackRate <= 16');
    }
  }

  const intent = {
    type: 'intent',
    commandId: `${SESSION.participantId}-ext-${++SESSION.nextCommandSeq}`,
    sessionId: SESSION.sessionId,
    participantId: SESSION.participantId,
    clientObservedRevision: SESSION.latestState?.stateRevision ?? 0,
    kind,
    createdAtMs: Date.now(),
  };
  if (payload !== undefined && payload !== null) intent.payload = payload;
  SESSION.ws.send(JSON.stringify(intent));
  return intent.commandId;
}

function sendSyncItemBind(definitions, values) {
  if (SESSION.status !== 'connected' || !SESSION.ws || SESSION.role !== 'host') return;
  if (!Array.isArray(definitions) || !values || typeof values !== 'object') return;
  SESSION.ws.send(JSON.stringify({
    type: 'sync-item-bind',
    participantId: SESSION.participantId,
    definitions,
    values,
  }));
}

function sendSyncItemIntent(key, value) {
  if (SESSION.status !== 'connected' || !SESSION.ws) return;
  if (typeof key !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) return;
  SESSION.ws.send(JSON.stringify({
    type: 'sync-item-intent',
    commandId: `${SESSION.participantId}-sync-${++SESSION.nextCommandSeq}`,
    sessionId: SESSION.sessionId,
    participantId: SESSION.participantId,
    clientObservedRevision: SESSION.latestState?.stateRevision ?? 0,
    key,
    value,
    createdAtMs: Date.now(),
  }));
}


function sendActualStateReport(snapshot, applyResult, error, fromHost = false) {
  if (SESSION.status !== 'connected' || !SESSION.ws || !SESSION.identity) return;
  if (!snapshot || typeof snapshot !== 'object') return;
  // The page's own snapshot identity is authoritative for its report: a page
  // that drifted to another resource must not contaminate the session's
  // actual state. Either side's identity legitimately changes while its own
  // resource-bind is in flight (the authority re-judges once the bind lands),
  // so those transient reports are dropped silently; any other mismatch is
  // rejected loudly.
  const identity = snapshot.identity;
  if (identity && !IDENTITY.identityEqual(identity, SESSION.identity)) {
    if (SESSION.bindInFlight && IDENTITY.identityEqual(SESSION.bindInFlight, identity)) return;
    if (fromHost) return;
    SESSION.lastError = '页面报告与实际会话资源不一致，已忽略该报告';
    setStatus(SESSION.status);
    return;
  }
  const report = {
    type: 'actual-state',
    sessionId: SESSION.sessionId,
    participantId: SESSION.participantId,
    observedRevision: SESSION.latestState?.stateRevision ?? 0,
    resourceIdentity: identity ?? SESSION.identity,
    mediaPhase: snapshot.mediaPhase,
    positionSeconds: snapshot.positionSeconds,
    positionObservedAtMs: snapshot.positionObservedAtMs,
    playbackRate: snapshot.playbackRate,
    durationSeconds: snapshot.durationSeconds ?? null,
    adapterId: (identity ? identity.adapterId : SESSION.identity.adapterId) ?? 'unknown',
    applyResult,
    ...(snapshot.syncItems === undefined ? {} : { syncItems: snapshot.syncItems }),
  };
  if (error !== undefined && error !== null) report.error = String(error);
  SESSION.ws.send(JSON.stringify(report));
}

/**
 * Resource (re)binding: the participant's current page switched to another
 * video and the session must follow. Any joined participant — host or client —
 * may send this; the authority bumps the revision, resets the playhead for
 * the fresh resource and broadcasts the new state to every participant, and
 * each side then navigates its own existing tab to the new resource.
 */
function sendResourceBind(identity) {
  if (!identity || SESSION.status !== 'connected' || !SESSION.ws) return false;
  // Dedupe: an identical bind request already in flight (content-ready and tab
  // activation can both observe the same navigation). The identity is adopted
  // only after the authority's broadcast round-trip, so compare against the
  // pending bind, not SESSION.identity.
  if (SESSION.bindInFlight && IDENTITY.identityEqual(SESSION.bindInFlight, identity)) return false;
  SESSION.bindInFlight = identity;
  SESSION.ws.send(JSON.stringify({
    type: 'resource-bind',
    participantId: SESSION.participantId,
    resourceIdentity: identity,
  }));
  return true;
}

// --- keepalive: an open socket and a quiet session must not let the worker
// --- idle out; a protocol snapshot-request is a harmless keepalive ping.

function startKeepalive() {
  stopKeepalive();
  SESSION.keepalive = setInterval(() => {
    requestSnapshot();
  }, 20000);
}

function stopKeepalive() {
  if (SESSION.keepalive !== null) {
    clearInterval(SESSION.keepalive);
    SESSION.keepalive = null;
  }
}

/**
 * Adopt a tab as the session's apply target and re-trigger the apply pipeline.
 * Shared by the content-ready handler and the tab-takeover path. In host mode
 * the apply target is the host tab; in client mode it is the client tab.
 */
function registerApplyTarget(tabId, hasVideo) {
  adoptApplyTarget(tabId);
  if (hasVideo === false) {
    setNotice('目标页面暂无可播放视频，等待视频就绪');
  } else if (hasVideo === true && SESSION.notice) {
    setNotice(null);
  }
  enqueueApply();
  // Client-only one-time auto recovery: if the session is already ready but
  // this resource has not been recovered yet, queue a single in-place refresh
  // (it is serialized after the pending apply by the shared pipeline).
  if (hasVideo !== false) maybeAutoRecoverClient();
}

// --- client auto recovery ------------------------------------------------------
// The authority's readiness signal is the trigger: when it reports the session
// ready, the client tab may still be showing a stale phase (authority
// buffering while the page actually plays, authority paused while the page
// seeks). Refresh the client's own tab in place exactly once per resource so
// the fresh page re-injects the current authoritative state and reports its
// actual state back. Host pages are never touched, no new tab/window is ever
// created, and revisions/playback updates never re-trigger a refresh.

/**
 * Stable per-resource key for the recovery dedup — two identities are the same
 * resource exactly when IDENTITY.identityEqual says so.
 */
function identityFingerprint(identity) {
  if (!identity || typeof identity !== 'object') return null;
  return `${identity.adapterId}|${identity.canonicalUrl}|${identity.resourceId ?? ''}`;
}

/**
 * Queue the one-time client refresh when the session is ready and the current
 * resource has not been recovered yet. Called from the session-status handler
 * (ready flips true) and from registerApplyTarget (a page registered after the
 * session was already ready). Every condition is re-checked at execution time.
 */
function maybeAutoRecoverClient() {
  if (SESSION.role !== 'client') return; // the host never auto-refreshes
  if (SESSION.status !== 'connected') return;
  if (SESSION.latestStatus?.ready !== true) return; // sync not established yet
  if (!SESSION.latestState) return; // nothing authoritative to re-inject yet
  const fingerprint = identityFingerprint(SESSION.identity);
  if (!fingerprint) return;
  // One recovery per resource: a resource switch resets the fingerprint, but
  // later revisions/playback updates never re-trigger it.
  if (SESSION.clientAutoRecoveredFingerprint === fingerprint) return;
  // Never stack recoveries — the in-flight one already covers this resource.
  if (SESSION.clientRecoverInFlight !== null) return;
  // A resource switch is landing: recover the FRESH identity once it is
  // adopted, never reload the page for the outgoing one.
  if (SESSION.bindInFlight !== null) return;
  // No client page yet (still routing/opening): wait — the page's
  // content-ready registration re-checks and triggers once it is in place.
  if (SESSION.clientTabId === null) return;
  SESSION.clientRecoverInFlight = fingerprint;
  enqueueClientRecovery();
}

/**
 * Serialize the recovery reload with the route+apply pipeline so it can never
 * race a connect/route/apply cycle.
 */
function enqueueClientRecovery() {
  SESSION.applyQueue = SESSION.applyQueue
    .then(() => performClientRecovery())
    .catch((error) => {
      SESSION.clientRecoverInFlight = null;
      SESSION.lastError = error instanceof Error ? error.message : String(error);
      setStatus(SESSION.status);
    });
}

/**
 * Reload the client's own tab in place (same tab, no new window) and consume
 * the recovery for this resource. The reloaded page's content-ready
 * re-registers the apply target and re-applies the current authoritative
 * state, then reports its actual state back through the normal pipeline.
 */
async function performClientRecovery() {
  if (SESSION.role !== 'client' || SESSION.status !== 'connected') return;
  const fingerprint = SESSION.clientRecoverInFlight;
  if (fingerprint === null) return;
  // The resource may have switched while the reload was queued (or a bind is
  // still landing): never reload for a stale resource — the fresh identity
  // gets its own recovery once adopted.
  if (identityFingerprint(SESSION.identity) !== fingerprint || SESSION.bindInFlight !== null) {
    SESSION.clientRecoverInFlight = null;
    return;
  }
  const tabId = SESSION.clientTabId;
  if (tabId === null) {
    SESSION.clientRecoverInFlight = null;
    return;
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url || !IDENTITY.identityEqual(IDENTITY.deriveIdentity(tab.url), SESSION.identity)) {
      // The page left the session resource (manual navigation, login wall):
      // recovery is not consumed; the content-ready/route pipeline re-opens it.
      SESSION.clientRecoverInFlight = null;
      clearApplyTarget();
      enqueueApply();
      return;
    }
  } catch {
    // Tab gone: let routing re-open the session page.
    SESSION.clientRecoverInFlight = null;
    clearApplyTarget();
    enqueueApply();
    return;
  }
  try {
    await chrome.tabs.reload(tabId);
    SESSION.clientAutoRecoveredFingerprint = fingerprint;
    SESSION.clientRecoverInFlight = null;
  } catch (error) {
    // Failed reload: explicit notice, and the fingerprint stays unrecovered so
    // the next readiness signal may retry once.
    SESSION.clientRecoverInFlight = null;
    setNotice(`从机页面自动刷新失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- tab lifecycle --------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    SESSION.injectedLocalTabs.delete(tabId);
    return;
  }
  if (changeInfo.status === 'complete' && tabId === applyTargetTabId()) enqueueApply();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  SESSION.injectedLocalTabs.delete(tabId);
  SESSION.commandedNavigations.delete(tabId);
  // The apply-target tab is gone: drop it so a fresh page's content-ready
  // re-registers and re-applies; while the page is gone, re-route the latest
  // state so the session page comes back. The socket, session, latest state,
  // identity and status all survive.
  if (tabId !== applyTargetTabId()) return;
  clearApplyTarget();
  SESSION.notice = null;
  enqueueApply();
});

chrome.tabs.onActivated.addListener((info) => {
  // The participant's ACTIVE tab is its media-source candidate: switching to
  // another video tab switches the session resource. The identity comparison
  // makes this a no-op for already-bound pages (and for the apply target,
  // which carries the same canonical identity). Either side may switch.
  if (SESSION.status !== 'connected' || SESSION.role === null) return;
  if (info.tabId === applyTargetTabId()) return;
  chrome.tabs.get(info.tabId)
    .then((tab) => {
      if (!tab?.url) return; // switched again / no url
      const identity = IDENTITY.deriveIdentity(tab.url);
      if (!identity) return; // an unsupported page never binds the resource
      adoptApplyTarget(info.tabId);
      if (SESSION.identity === null || !IDENTITY.identityEqual(identity, SESSION.identity)) {
        sendResourceBind(identity);
        // Tab activation is a deliberate user action: prove the intent
        // persistently in case the authority is mid-transition.
        scheduleBindRetry(info.tabId, identity, 6, SESSION.identity);
      } else {
        // Same resource in a fresh tab/window: take it over and re-apply.
        enqueueApply();
      }
    })
    .catch(() => {});
});

// --- message router -----------------------------------------------------------


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return undefined;

  switch (message.type) {
    // popup -> background
    case 'connect': {
      // connect() is async (host mode may fetch the local Session API and the
      // active tab); keep the message channel open until it settles.
      void connect(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    case 'disconnect':
      disconnect();
      sendResponse({ ok: true });
      return undefined;
    case 'local-permission-result': {
      const origin = typeof message.origin === 'string' ? message.origin : '';
      sendResponse(handleLocalPermissionResult(origin, message.granted === true));
      return undefined;
    }
    case 'join-decision': {
      if (SESSION.status !== 'connected' || !SESSION.ws) {
        sendResponse({ ok: false, error: '未连接会话' });
        return undefined;
      }
      if (SESSION.role !== 'host' || !SESSION.pendingJoin) {
        sendResponse({ ok: false, error: '没有待处理的加入请求' });
        return undefined;
      }
      SESSION.ws.send(JSON.stringify({
        type: 'join-decision',
        participantId: SESSION.participantId,
        accepted: message.accepted === true,
      }));
      SESSION.pendingJoin = null;
      notifyPopup({ type: 'join-request-clear' });
      sendResponse({ ok: true });
      return undefined;
    }
    case 'get-status':
      sendResponse({
        status: SESSION.status,
        role: SESSION.role,
        sessionId: SESSION.sessionId,
        session: SESSION.sessionId,
        participantId: SESSION.participantId,
        host: SESSION.host,
        port: SESSION.port,
        api: SESSION.port > 0
          ? `http://127.0.0.1:${SESSION.port + 1}/api/session`
          : null,
        share: SESSION.host && SESSION.sessionId
          ? buildShare(SESSION.host, SESSION.port, SESSION.sessionId)
          : null,
        canonicalUrl: SESSION.identity ? SESSION.identity.canonicalUrl : null,
        lastError: SESSION.lastError,
        notice: SESSION.notice,
        state: SESSION.latestState,
        sessionStatus: SESSION.latestStatus,
        lastDiagnostic: SESSION.lastDiagnostic,
        pendingJoin: SESSION.pendingJoin,
        localPermission: SESSION.pendingLocalPermission,
      });
      return undefined;

    // content -> background
    case 'content-ready': {
      const tabId = sender.tab?.id;
      if (tabId === undefined || SESSION.status !== 'connected') return undefined;
      const identity = message.identity ?? null;
      const isOwnTab = tabId === applyTargetTabId();
      const isActivePage = sender.tab?.active === true;

      // Either side may switch videos: a page carrying a supported identity
      // different from the session resource re-binds it, so the other side
      // follows in its own tab. Only the participant's own apply-target tab
      // or a freshly activated page (new window/tab) may do this; a
      // superseded or background page never steals the role.
      if (identity && (SESSION.identity === null || !IDENTITY.identityEqual(identity, SESSION.identity))) {
        if (isOwnTab || isActivePage) {
          // Transition-echo filter: if we recently COMMANDED this tab to
          // navigate (routeCanonical), a different identity reported by it is
          // the old page or a redirect — not a user switch. Re-align instead
          // of re-binding, and let the persistent-intent retry prove whether
          // a genuine user switch hides behind the echo.
          const commanded = SESSION.commandedNavigations.get(tabId);
          if (commanded && Date.now() - commanded.atMs < COMMANDED_NAV_WINDOW_MS) {
            enqueueApply();
            scheduleBindRetry(tabId, identity, 4, SESSION.identity);
            return undefined;
          }
          adoptApplyTarget(tabId);
          sendResourceBind(identity);
          scheduleBindRetry(tabId, identity, 6, SESSION.identity);
        }
        return undefined;
      }

      // Unsupported/blank page: only matters when it is the current apply
      // target — drop it, but do NOT auto-reopen: navigating away from the
      // video page is user intent (e.g. searching). Returning to a supported
      // page re-registers and restores sync.
      if (!identity) {
        if (isOwnTab) {
          clearApplyTarget();
          if (!SESSION.notice) setNotice('已暂时离开会话视频；回到支持的视频页将自动恢复同步');
        }
        return undefined;
      }

      // The page carries the session resource identity: it becomes the apply
      // target (a new window/tab with the same resource takes over — we never
      // create an extra one) and the apply pipeline re-runs for that tab. The
      // superseded page's later events are ignored because its sender tab id
      // no longer matches the apply target.
      if (SESSION.role === 'host' && message.syncItemDefinitions && message.syncItems) {
        sendSyncItemBind(message.syncItemDefinitions, message.syncItems);
      }
      registerApplyTarget(tabId, message.hasVideo);
      return undefined;
    }
    case 'actual-state': {
      // Native player content events are the only intent source: only the
      // participant's own apply-target tab (host tab in host mode, client tab
      // in client mode) may report — old/superseded pages never affect the
      // session.
      if (sender.tab?.id !== applyTargetTabId()) return undefined;
      sendActualStateReport(message.snapshot, 'applied', undefined, SESSION.role === 'host');
      return undefined;
    }
    case 'user-intent': {
      if (sender.tab?.id !== applyTargetTabId()) return undefined;
      try {
        sendIntent(message.kind, message.payload);
      } catch {
        // Not connected; the observation will resurface via actual-state.
      }
      return undefined;
    }
    case 'user-sync-items': {
      if (sender.tab?.id !== applyTargetTabId() || !message.values || typeof message.values !== 'object') return undefined;
      for (const [key, value] of Object.entries(message.values)) sendSyncItemIntent(key, value);
      return undefined;
    }
    case 'apply-result': {
      if (sender.tab?.id !== applyTargetTabId()) return undefined;
      if (message.result !== 'applied') {
        SESSION.lastError = `页面执行失败 (${message.result}): ${message.error ?? '未知错误'}`;
        setStatus(SESSION.status);
      } else if (SESSION.lastError) {
        SESSION.lastError = null;
        setStatus(SESSION.status);
      }
      sendActualStateReport(message.snapshot, message.result, message.error, SESSION.role === 'host');
      return undefined;
    }
    default:
      return undefined;
  }
});
