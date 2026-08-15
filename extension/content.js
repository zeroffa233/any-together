'use strict';

/**
 * AnyTogether content script — runs on pages served by a registered syncer
 * (see manifest and identity.js; currently Bilibili only).
 *
 * The page logic never adjudicates authoritative state: it locates the target
 * video, executes apply-state commands sent by the background worker, reports
 * actual media observations, and relays user-initiated media events as
 * semantic intents. All decisions about what is authoritative happen in the
 * Node companion process; the background worker only bridges messages.
 *
 * Site URL rules, identity derivation and matching live in identity.js
 * (AnyTogetherIdentity, loaded before this script); the content core never
 * re-implements them, so a future syncer only needs a registry entry.
 *
 * The script guards the incoming apply-state stream itself: a state for a
 * different resource or an older revision than the last applied one is never
 * executed, so a delayed/stale apply can never overwrite a newer page state.
 */

const HAVE_FUTURE_DATA = 3;
const SEEK_SETTLE_POLL_MS = 25;
const MAX_SEEK_SETTLE_POLLS = 20;
const TARGET_RETRY_MS = 4000;
const APPLY_SETTLE_MS = 500;
const TIMEUPDATE_REPORT_INTERVAL_MS = 1000;
const TIMEUPDATE_REPORT_DRIFT = 0.5;
const REFRESH_INTERVAL_MS = 1500;

const MEDIA_EVENTS = [
  'play', 'pause', 'seeking', 'seeked', 'waiting', 'playing', 'ended', 'error', 'ratechange', 'timeupdate',
];

const PAGE = {
  identity: null,
  target: null,
  buffering: false,
  registered: false,
  initialApplied: false, // first authoritative apply happened; before that, page
  // autoplay/buffering noise must not be treated as user commands
  applying: false,
  settleUntil: 0,
  lastHref: '',
  lastAppliedRevision: -1, // newest authoritative revision executed on this page
  lastActualSentAt: 0,
  lastSentPosition: null,
};

// --- identity -------------------------------------------------------------------
// URL support, identity derivation and matching come from identity.js
// (AnyTogetherIdentity, loaded before this script via the manifest). Content
// core never re-implements site URL rules; a new syncer is a registry entry.

// --- target video (same selection rules as src/adapters/bilibili-adapter.ts) --

function visibleArea(element) {
  if (typeof element.getBoundingClientRect !== 'function') return 0;
  try {
    const rect = element.getBoundingClientRect();
    return Math.max(0, rect.width * rect.height);
  } catch {
    return 0;
  }
}

function selectTarget() {
  const candidates = Array.from(document.querySelectorAll('video'))
    .map((video, index) => ({ video, index, area: visibleArea(video) }))
    .filter((entry) => entry.video.readyState > 0 || Number.isFinite(entry.video.duration));
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => right.area - left.area || left.index - right.index);
  return candidates[0].video;
}

async function findTargetWithRetry(timeoutMs = TARGET_RETRY_MS) {
  const deadline = Date.now() + timeoutMs;
  let target = selectTarget();
  while (!target && Date.now() < deadline) {
    await sleep(500);
    target = selectTarget();
  }
  return target;
}

// --- local state reading -------------------------------------------------------

function phaseFor(target) {
  if (target.error) return 'error';
  if (target.ended) return 'ended';
  if (target.seeking) return 'seeking';
  if (target.paused) return 'paused';
  if (PAGE.buffering) return 'buffering';
  if (target.readyState < HAVE_FUTURE_DATA) return 'loading';
  return 'playing';
}

function readSnapshot(target) {
  const video = target ?? PAGE.target;
  return {
    identity: PAGE.identity ?? AnyTogetherIdentity.deriveIdentity(location.href),
    mediaPhase: video ? phaseFor(video) : 'paused',
    positionSeconds: video ? video.currentTime : 0,
    positionObservedAtMs: Date.now(),
    playbackRate: video ? video.playbackRate : 1,
    durationSeconds: video && Number.isFinite(video.duration) ? video.duration : null,
  };
}

// --- applying authoritative state ------------------------------------------------

function applyPhase(target, phase) {
  switch (phase) {
    case 'playing':
      return target.play(); // may reject under autoplay policy; caller reports it
    case 'paused':
    case 'ended':
    case 'ready':
      // ready is the authority's fresh-resource phase; keep the media paused
      // so page autoplay cannot start playback and turn the real phase into
      // a false mismatch against the authoritative state.
      target.pause();
      return undefined;
    default:
      // seeking / buffering / loading / error are observed-only phases;
      // position and rate still apply below.
      return undefined;
  }
}

/**
 * Project the authoritative playhead to NOW instead of using the frozen anchor
 * as the current position. Mirrors src/core/playback-state.ts
 * projectPlaybackPosition: while the phase advances ('playing') the position
 * is extrapolated from positionSeconds at positionAtMs using playbackRate;
 * every other phase keeps the frozen position. Never moves backwards, never
 * exceeds the duration.
 */
function projectedPosition(state) {
  if (state.mediaPhase !== 'playing') return state.positionSeconds;
  const elapsedSeconds = Math.max(0, Date.now() - state.positionAtMs) / 1000;
  const projected = state.positionSeconds + elapsedSeconds * state.playbackRate;
  if (Number.isFinite(state.durationSeconds) && state.durationSeconds !== null) {
    return Math.min(state.durationSeconds, projected);
  }
  return projected;
}

function waitForSeekSettled(target) {
  return new Promise((resolve) => {
    if (!target.seeking) return resolve();
    let attempts = 0;
    const poll = () => {
      if (!target.seeking || attempts >= MAX_SEEK_SETTLE_POLLS) return resolve();
      attempts += 1;
      setTimeout(poll, SEEK_SETTLE_POLL_MS);
    };
    setTimeout(poll, SEEK_SETTLE_POLL_MS);
  });
}

async function applyAuthoritativeState(state) {
  const target = await findTargetWithRetry();
  if (!target) {
    return { result: 'unsupported', error: '页面没有可控制的视频', snapshot: readSnapshot() };
  }
  PAGE.target = target;
  ensureListeners(target);

  try {
    await applyPhase(target, state.mediaPhase);
  } catch (error) {
    return {
      result: 'rejected',
      error: `无法执行 ${state.mediaPhase}: ${error instanceof Error ? error.message : String(error)}`,
      snapshot: readSnapshot(target),
    };
  }

  if (Number.isFinite(state.positionSeconds)
    && Number.isFinite(state.positionAtMs)
    && Number.isFinite(state.playbackRate)) {
    const targetPosition = projectedPosition(state);
    if (Math.abs(target.currentTime - targetPosition) > 0.25) {
      target.currentTime = targetPosition;
      await waitForSeekSettled(target);
    }
  }
  if (Number.isFinite(state.playbackRate) && state.playbackRate > 0) {
    try {
      target.playbackRate = state.playbackRate;
    } catch {
      // Browser clamp; the returned snapshot reflects the real value.
    }
  }
  return { result: 'applied', snapshot: readSnapshot(target) };
}

// --- media events: report observations, relay user intent -----------------------

function onMediaEvent(event) {
  const target = event.currentTarget;
  // Events from a replaced/detached video element (SPA swap) must never
  // report state or intent for the current page; only the active target talks.
  if (target !== PAGE.target) return;
  if (event.type === 'waiting') PAGE.buffering = true;
  else if (['play', 'playing', 'pause', 'seeked', 'ended', 'error'].includes(event.type)) PAGE.buffering = false;

  // Events caused by our own apply are swallowed by the settle window; anything
  // else is a page-side change (user interaction or site autoplay) worth
  // relaying as a semantic intent. The server remains the only adjudicator.
  const userInitiated = PAGE.initialApplied && Date.now() >= PAGE.settleUntil && !PAGE.applying;
  if (userInitiated && target) {
    switch (event.type) {
      case 'play':
        sendToBackground({ type: 'user-intent', kind: 'play' });
        break;
      case 'pause':
        sendToBackground({ type: 'user-intent', kind: 'pause' });
        break;
      case 'seeked':
        sendToBackground({ type: 'user-intent', kind: 'seek', payload: { targetSeconds: target.currentTime } });
        break;
      case 'ratechange':
        sendToBackground({ type: 'user-intent', kind: 'set-rate', payload: { playbackRate: target.playbackRate } });
        break;
      default:
        break;
    }
  }

  // No actual-state/user-intent before the first authoritative apply: this
  // page is not yet bound to the session, and reporting local (e.g. 0/ready)
  // state would fabricate stale/drift diagnostics. Only apply-result replies
  // report real state before that point.
  if (!PAGE.initialApplied) return;

  if (event.type === 'timeupdate') {
    const now = Date.now();
    const drift = target ? Math.abs(target.currentTime - (PAGE.lastSentPosition ?? -Infinity)) : Infinity;
    if (now - PAGE.lastActualSentAt < TIMEUPDATE_REPORT_INTERVAL_MS && drift < TIMEUPDATE_REPORT_DRIFT) return;
    PAGE.lastActualSentAt = now;
    if (target) PAGE.lastSentPosition = target.currentTime;
  }
  sendToBackground({ type: 'actual-state', snapshot: readSnapshot(target) });
}

function ensureListeners(target) {
  if (target.__anyTogetherListening) return;
  target.__anyTogetherListening = true;
  for (const type of MEDIA_EVENTS) target.addEventListener(type, onMediaEvent);
}

// --- messaging ---------------------------------------------------------------------

function sendToBackground(message) {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // Extension context invalidated (extension reloaded); next refresh re-registers.
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || message.type !== 'apply-state') return undefined;

  void (async () => {
    const state = message.state;
    if (!state || typeof state !== 'object' || !Number.isInteger(state.stateRevision)) {
      sendResponse({ type: 'apply-result', result: 'rejected', error: '无效的权威状态', snapshot: readSnapshot() });
      return;
    }
    // Unsupported guard: no registered syncer serves the current page (or SPA
    // navigation left the syncer's site) — there is nothing to control.
    if (!PAGE.identity) {
      sendResponse({
        type: 'apply-result',
        result: 'unsupported',
        error: '当前页面不是受支持的同步页面',
        snapshot: readSnapshot(),
      });
      return;
    }
    // Identity guard: never execute a state for a different resource on this
    // page (covers SPA navigation away from the session video).
    if (!AnyTogetherIdentity.identityEqual(state.resourceIdentity, PAGE.identity)) {
      sendResponse({
        type: 'apply-result',
        result: 'rejected',
        error: '权威状态与当前页面资源不匹配',
        snapshot: readSnapshot(),
      });
      return;
    }
    // Revision guard: a stale apply must never overwrite a newer page state.
    if (state.stateRevision <= PAGE.lastAppliedRevision) {
      sendResponse({ type: 'apply-result', result: 'applied', snapshot: readSnapshot() });
      return;
    }

    PAGE.applying = true;
    let payload;
    try {
      payload = await applyAuthoritativeState(state);
    } catch (error) {
      payload = {
        result: 'rejected',
        error: error instanceof Error ? error.message : String(error),
        snapshot: readSnapshot(),
      };
    } finally {
      PAGE.applying = false;
      PAGE.settleUntil = Date.now() + APPLY_SETTLE_MS;
      PAGE.initialApplied = true;
    }
    if (payload.result === 'applied') PAGE.lastAppliedRevision = state.stateRevision;
    sendResponse({ type: 'apply-result', ...payload });
  })();
  return true;
});

// --- registration: SPA-safe refresh loop -------------------------------------------

/**
 * Re-derives the page identity, tracks the target video and re-registers with
 * the background whenever any of them changes:
 * - URL change / SPA navigation → new identity → content-ready with the fresh
 *   identity (or no registration at all on unsupported pages);
 * - video element appears → delayed content-ready (hasVideo: true) so the
 *   background re-pushes the authoritative state;
 * - video element is replaced or detached (SPA swap) → apply pipeline reset
 *   and re-registration, so a stale target never keeps the old state.
 */
function refresh() {
  const href = location.href;
  const identity = AnyTogetherIdentity.deriveIdentity(href);
  const identityChanged = href !== PAGE.lastHref
    || !PAGE.identity
    || !AnyTogetherIdentity.identityEqual(PAGE.identity, identity);
  if (identityChanged) {
    PAGE.lastHref = href;
    PAGE.identity = identity;
    PAGE.registered = false;
    PAGE.initialApplied = false;
    PAGE.target = null;
    PAGE.buffering = false;
    PAGE.settleUntil = 0;
    PAGE.lastAppliedRevision = -1;
  }

  if (identity) {
    const target = selectTarget();
    if (PAGE.target === null && target) {
      // First video on this page/identity: attach and register the target.
      PAGE.target = target;
      ensureListeners(target);
      // Delayed target registration: the video may only appear after the page
      // is interactive; tell the background the target is now available so it
      // can re-push the authoritative state.
      if (PAGE.registered) {
        sendToBackground({ type: 'content-ready', identity, hasVideo: true });
      }
    } else if (PAGE.target !== null && (target !== PAGE.target || !document.contains(PAGE.target))) {
      // SPA video-element swap: the current target was replaced or detached.
      // Reset the apply pipeline and re-register so the background re-pushes
      // the authoritative state onto the new element; the stale target keeps
      // its listeners but onMediaEvent ignores it.
      PAGE.target = target ?? null;
      if (PAGE.target) ensureListeners(PAGE.target);
      PAGE.registered = false;
      PAGE.initialApplied = false;
      PAGE.buffering = false;
      PAGE.settleUntil = 0;
      PAGE.lastAppliedRevision = -1;
    }
  }

  if (identity && !PAGE.registered) {
    PAGE.registered = true;
    sendToBackground({ type: 'content-ready', identity, hasVideo: PAGE.target !== null });
  }
}

setInterval(refresh, REFRESH_INTERVAL_MS);
refresh();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
