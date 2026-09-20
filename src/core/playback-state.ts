import {
  isPlaybackIntent,
  isPlaybackState,
  isValidResourceIdentity,
  MAX_PLAYBACK_RATE,
} from '../shared/protocol.js';
import type { MediaPhase, PlaybackIntent, PlaybackState } from '../shared/protocol.js';

/**
 * Domain error for invalid state transitions. `code` carries a stable, machine-readable
 * identifier ('invalid-seek', 'invalid-rate', 'session-mismatch', ...) so callers can
 * react without parsing messages.
 */
export class StateTransitionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'StateTransitionError';
  }
}

/** Float-drift tolerance (seconds) when checking seek targets against the duration. */
export const SEEK_TOLERANCE_SECONDS = 0.001;

/** Phases in which the playhead advances with wall-clock time. */
export function isPhaseAdvancing(phase: MediaPhase): boolean {
  return phase === 'playing';
}

/** Round seconds to millisecond precision so stored/frozen positions never accumulate float noise. */
function normalizePosition(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

function assertFiniteClock(nowMs: number): void {
  if (!Number.isFinite(nowMs)) {
    throw new StateTransitionError('invalid-clock', 'Clock input must be a finite millisecond timestamp');
  }
}

/**
 * Create the initial authoritative state for a session. `resourceIdentity` may
 * be NULL for an unbound session (host has not joined with an identity nor sent
 * `resource-bind` yet); the state then carries no resource, keeps a 'ready'
 * phase, and rejects playback intents via `resource-unbound` until the host
 * binds one. A non-null identity is validated structurally.
 */
export function createInitialPlaybackState(
  sessionId: string,
  resourceIdentity: PlaybackState['resourceIdentity'],
  nowMs = Date.now(),
  durationSeconds: number | null = null,
): PlaybackState {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new StateTransitionError('invalid-session', 'Session id must be a non-empty string');
  }
  if (resourceIdentity !== null && !isValidResourceIdentity(resourceIdentity)) {
    throw new StateTransitionError(
      'invalid-resource-identity',
      'Resource identity must be null or have a non-empty adapterId and canonicalUrl',
    );
  }
  assertFiniteClock(nowMs);
  if (durationSeconds !== null && (!Number.isFinite(durationSeconds) || durationSeconds < 0)) {
    throw new StateTransitionError('invalid-duration', 'Duration must be null or a non-negative finite number of seconds');
  }
  return {
    sessionId,
    resourceIdentity: resourceIdentity === null ? null : { ...resourceIdentity },
    stateRevision: 0,
    lastSequence: 0,
    mediaPhase: 'ready',
    positionSeconds: 0,
    positionAtMs: nowMs,
    playbackRate: 1,
    durationSeconds,
    lastCommandId: null,
    updatedAtMs: nowMs,
  };
}

/**
 * Project the authoritative playhead position at `nowMs`.
 * While the phase advances ('playing'), the position is extrapolated from the last
 * frozen anchor (positionSeconds at positionAtMs) using the current playbackRate;
 * every other phase returns the frozen position. The projection never moves
 * backwards and never exceeds the duration.
 */
export function projectPlaybackPosition(state: PlaybackState, nowMs = Date.now()): number {
  assertFiniteClock(nowMs);
  if (!isPhaseAdvancing(state.mediaPhase)) return state.positionSeconds;
  const elapsedSeconds = Math.max(0, nowMs - state.positionAtMs) / 1000;
  const projected = state.positionSeconds + elapsedSeconds * state.playbackRate;
  const bounded = state.durationSeconds === null ? projected : Math.min(state.durationSeconds, projected);
  return normalizePosition(bounded);
}

/**
 * Apply one intent to the authoritative state, returning a brand-new state.
 *
 * - Pure and deterministic: the same (state, intent, nowMs) triple always yields the
 *   same output; the clock is injected, never sampled.
 * - The playhead is always re-projected from `state` at apply time and then frozen at
 *   `nowMs` (positionAtMs), so an intent can never overwrite a newer position with an
 *   older projection, and float noise is normalized to millisecond precision.
 * - `stateRevision` and `lastSequence` each increase by exactly 1 per applied intent,
 *   so they stay strictly monotonic. Applied commands are recorded in `lastCommandId`
 *   so callers can recognize duplicates (idempotency by commandId).
 * - Invalid intents throw `StateTransitionError` with a stable `code` and never touch
 *   the input state: 'invalid-intent' (malformed), 'invalid-seek' / 'invalid-rate'
 *   (bad payload values), 'session-mismatch', 'resource-unbound' (no resource bound
 *   yet — playback intents are rejected until the host binds one),
 *   'invalid-state', 'invalid-clock'.
 */
export function applyIntent(
  state: PlaybackState,
  intent: PlaybackIntent,
  nowMs = Date.now(),
): PlaybackState {
  if (!isPlaybackState(state)) {
    throw new StateTransitionError('invalid-state', 'State must be a well-formed playback state');
  }
  if (!isPlaybackIntent(intent)) {
    throw new StateTransitionError('invalid-intent', 'Intent must be a well-formed playback intent for its kind');
  }
  if (intent.sessionId !== state.sessionId) {
    throw new StateTransitionError('session-mismatch', 'Intent belongs to another session');
  }
  if (state.resourceIdentity === null) {
    throw new StateTransitionError(
      'resource-unbound',
      'Cannot apply playback intent: the session has no bound resource yet',
    );
  }
  assertFiniteClock(nowMs);

  const frozenPosition = normalizePosition(projectPlaybackPosition(state, nowMs));
  const next: PlaybackState = {
    ...state,
    resourceIdentity: { ...state.resourceIdentity },
    positionSeconds: frozenPosition,
    positionAtMs: nowMs,
    stateRevision: state.stateRevision + 1,
    lastSequence: state.lastSequence + 1,
    lastCommandId: intent.commandId,
    updatedAtMs: nowMs,
  };

  switch (intent.kind) {
    case 'play':
      return { ...next, mediaPhase: 'playing' };
    case 'pause':
      return { ...next, mediaPhase: 'paused' };
    case 'replay':
      return { ...next, mediaPhase: 'playing', positionSeconds: 0 };
    case 'seek': {
      const targetSeconds = intent.payload?.targetSeconds;
      if (targetSeconds === undefined || !Number.isFinite(targetSeconds) || targetSeconds < 0) {
        throw new StateTransitionError('invalid-seek', 'Seek target must be a non-negative finite number of seconds');
      }
      return {
        ...next,
        positionSeconds: clampSeekTarget(targetSeconds, state.durationSeconds),
        mediaPhase: state.mediaPhase === 'playing' ? 'playing' : 'paused',
      };
    }
    case 'set-rate': {
      const playbackRate = intent.payload?.playbackRate;
      if (playbackRate === undefined || !Number.isFinite(playbackRate) || playbackRate <= 0 || playbackRate > MAX_PLAYBACK_RATE) {
        throw new StateTransitionError(
          'invalid-rate',
          `Playback rate must be greater than 0 and no more than ${MAX_PLAYBACK_RATE}`,
        );
      }
      return { ...next, playbackRate };
    }
  }
}

/**
 * Restore a persisted snapshot as the new authoritative state. The saved position is
 * kept exactly and re-anchored at `nowMs` (positionAtMs), so wall-clock gaps (server
 * restart, reconnect) never cause jumps: a restored 'playing' state resumes advancing
 * from the saved position at restore time. `stateRevision`/`lastSequence` are
 * preserved, so callers keep them monotonic by always restoring the newest snapshot.
 */
export function restorePlaybackState(saved: PlaybackState, nowMs = Date.now()): PlaybackState {
  if (!isPlaybackState(saved)) {
    throw new StateTransitionError('invalid-state', 'Saved state must be a well-formed playback state');
  }
  assertFiniteClock(nowMs);
  return {
    ...saved,
    resourceIdentity: saved.resourceIdentity === null ? null : { ...saved.resourceIdentity },
    positionAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

/** Validate the seek target against the duration: out-of-range throws, float drift within tolerance clamps. */
function clampSeekTarget(targetSeconds: number, durationSeconds: number | null): number {
  if (durationSeconds === null) return normalizePosition(targetSeconds);
  if (targetSeconds > durationSeconds + SEEK_TOLERANCE_SECONDS) {
    throw new StateTransitionError('invalid-seek', 'Seek target exceeds media duration');
  }
  return normalizePosition(Math.min(durationSeconds, targetSeconds));
}
