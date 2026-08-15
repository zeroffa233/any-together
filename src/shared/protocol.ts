/**
 * Cross-cutting wire and domain contract for any-together sessions.
 * All exported types are JSON-serializable; all guards are pure functions.
 */

export type MediaPhase =
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'seeking'
  | 'buffering'
  | 'ended'
  | 'error';

/** Every valid media phase, kept in sync with the `MediaPhase` union. */
export const MEDIA_PHASES: readonly MediaPhase[] = [
  'loading',
  'ready',
  'playing',
  'paused',
  'seeking',
  'buffering',
  'ended',
  'error',
] as const;

export function isMediaPhase(value: unknown): value is MediaPhase {
  return typeof value === 'string' && (MEDIA_PHASES as readonly string[]).includes(value);
}

/** Host pattern for Bilibili sites: `bilibili.com` itself or any `*.bilibili.com` subdomain. */
export const BILIBILI_HOST_PATTERN = /(^|\.)bilibili\.com$/;

/**
 * Path pattern for Bilibili VIDEO pages: the path must be exactly `/video` or
 * start with `/video/`; any other path (`/`, `/watch/...`, `/bangumi/...`) is
 * not a video page. Written as a full-URL pattern tolerant of a query/hash
 * directly after the `/video` segment, so one definition serves the
 * serialized registry `AdapterUrlRule` (tested against the raw page href),
 * the canonical identity URLs (origin + query/hash-free pathname), and the
 * Bilibili identity guard alike.
 */
export const BILIBILI_VIDEO_PATH_PATTERN = /^https?:\/\/[^/]+\/video(?:\/|[?#]|$)/;

/**
 * True when the value is an `http(s)` URL whose host is `bilibili.com` or a
 * subdomain of it. This is the Bilibili-specific acceptance level for resource
 * identities (the canonical form is an `http(s)://*.bilibili.com/.../video/...`
 * page URL); the generic `isValidResourceIdentity` deliberately does NOT apply
 * it so non-Bilibili adapters are not rejected by the shared core.
 */
export function isBilibiliUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && BILIBILI_HOST_PATTERN.test(url.hostname);
}

/**
 * True when the value is a non-empty string that parses as an `http(s)` URL.
 * This is the host-agnostic URL requirement of the generic resource identity
 * guard; site policy lives in the site-specific guards such as
 * `isBilibiliResourceIdentity`.
 */
function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

export type ResourceIdentity = {
  adapterId: string;
  canonicalUrl: string;
  resourceId?: string;
};

/**
 * True when the identity is structurally well-formed (non-empty adapterId,
 * optional non-empty resourceId) AND the canonicalUrl is an `http(s)` URL.
 * This is deliberately host-agnostic: any site's resource adapter can produce
 * identities the shared core accepts. Site-specific policy (e.g. the first
 * release only serving Bilibili) is enforced by the site-specific guard
 * `isBilibiliResourceIdentity` at the entrypoints, not by the core.
 */
export function isValidResourceIdentity(value: unknown): value is ResourceIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.adapterId !== 'string' || candidate.adapterId.length === 0) return false;
  if (!isHttpUrl(candidate.canonicalUrl)) return false;
  if (
    candidate.resourceId !== undefined
    && (typeof candidate.resourceId !== 'string' || candidate.resourceId.length === 0)
  ) {
    return false;
  }
  return true;
}

/**
 * Bilibili-specific identity guard for the first release's entrypoints: a
 * structurally valid identity whose canonicalUrl is an `http(s)` URL on a
 * bilibili.com subdomain with a `/video` or `/video/...` path. Use this
 * anywhere the Bilibili CLI/authority must reject foreign resources AND
 * non-video Bilibili pages; the generic `isValidResourceIdentity` accepts any
 * site so the core stays adapter-agnostic.
 */
export function isBilibiliResourceIdentity(value: unknown): value is ResourceIdentity {
  if (!isValidResourceIdentity(value)) return false;
  return isBilibiliUrl(value.canonicalUrl) && BILIBILI_VIDEO_PATH_PATTERN.test(value.canonicalUrl);
}

/**
 * Deterministic, collision-safe (NUL-separated) string key for identity comparison and
 * set/map membership in caller layers.
 */
export function resourceIdentityFingerprint(identity: ResourceIdentity): string {
  return `${identity.adapterId}\u0000${identity.canonicalUrl}\u0000${identity.resourceId ?? ''}`;
}

/**
 * Authoritative session state. `resourceIdentity` is NULL while the session has
 * no bound resource (the host has not joined with an identity / sent
 * `resource-bind` yet). Playback intents are rejected against an unbound state;
 * the media phase may still be 'loading'/'ready' while the UI shows the session
 * as unbound. Once bound, the identity is never null again.
 */
export type PlaybackState = {
  sessionId: string;
  resourceIdentity: ResourceIdentity | null;
  stateRevision: number;
  lastSequence: number;
  mediaPhase: MediaPhase;
  positionSeconds: number;
  positionAtMs: number;
  playbackRate: number;
  durationSeconds: number | null;
  lastCommandId: string | null;
  updatedAtMs: number;
  errorCode?: string;
};

export function isPlaybackState(value: unknown): value is PlaybackState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0) return false;
  // The field is REQUIRED but nullable: null means the session has no bound resource yet.
  if (candidate.resourceIdentity !== null && !isValidResourceIdentity(candidate.resourceIdentity)) return false;
  if (!isNonNegativeInteger(candidate.stateRevision)) return false;
  if (!isNonNegativeInteger(candidate.lastSequence)) return false;
  if (!isMediaPhase(candidate.mediaPhase)) return false;
  if (!isNonNegativeFinite(candidate.positionSeconds)) return false;
  if (!Number.isFinite(candidate.positionAtMs)) return false;
  if (!isPositiveFinite(candidate.playbackRate)) return false;
  if (candidate.durationSeconds !== null && !isNonNegativeFinite(candidate.durationSeconds)) return false;
  if (candidate.lastCommandId !== null && (typeof candidate.lastCommandId !== 'string' || candidate.lastCommandId.length === 0)) {
    return false;
  }
  if (!Number.isFinite(candidate.updatedAtMs)) return false;
  if (candidate.errorCode !== undefined && (typeof candidate.errorCode !== 'string' || candidate.errorCode.length === 0)) {
    return false;
  }
  return true;
}

export type IntentKind = 'play' | 'pause' | 'seek' | 'set-rate' | 'replay';

/** Every valid intent kind, kept in sync with the `IntentKind` union. */
export const INTENT_KINDS: readonly IntentKind[] = ['play', 'pause', 'seek', 'set-rate', 'replay'] as const;

export function isIntentKind(value: unknown): value is IntentKind {
  return typeof value === 'string' && (INTENT_KINDS as readonly string[]).includes(value);
}

export type PlaybackIntent = {
  type: 'intent';
  commandId: string;
  sessionId: string;
  participantId: string;
  clientObservedRevision: number;
  kind: IntentKind;
  payload?: {
    targetSeconds?: number;
    playbackRate?: number;
  };
  createdAtMs: number;
};

/** Upper bound for `set-rate` payloads, enforced by the state machine. */
export const MAX_PLAYBACK_RATE = 16;

/**
 * Structural validation of an intent: message shape, identifiers, revision/clock
 * sanity, and kind-specific payload requirements. Domain bounds that need state
 * context (seek target vs. duration) are enforced by the state machine instead.
 */
export function isPlaybackIntent(value: unknown): value is PlaybackIntent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'intent') return false;
  if (typeof candidate.commandId !== 'string' || candidate.commandId.length === 0) return false;
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0) return false;
  if (typeof candidate.participantId !== 'string' || candidate.participantId.length === 0) return false;
  if (!isNonNegativeInteger(candidate.clientObservedRevision)) return false;
  if (!Number.isFinite(candidate.createdAtMs)) return false;
  if (!isIntentKind(candidate.kind)) return false;

  const payload = candidate.payload;
  if (candidate.kind === 'seek') {
    if (typeof payload !== 'object' || payload === null) return false;
    const targetSeconds = (payload as Record<string, unknown>).targetSeconds;
    return isNonNegativeFinite(targetSeconds);
  }
  if (candidate.kind === 'set-rate') {
    if (typeof payload !== 'object' || payload === null) return false;
    const playbackRate = (payload as Record<string, unknown>).playbackRate;
    return typeof playbackRate === 'number'
      && Number.isFinite(playbackRate)
      && playbackRate > 0
      && playbackRate <= MAX_PLAYBACK_RATE;
  }
  // play / pause / replay take no payload; only reject the fields this protocol owns.
  if (payload === undefined || payload === null) return true;
  if (typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  return record.targetSeconds === undefined && record.playbackRate === undefined;
}

export type ActualStateReport = {
  type: 'actual-state';
  sessionId: string;
  participantId: string;
  observedRevision: number;
  resourceIdentity: ResourceIdentity;
  mediaPhase: MediaPhase;
  positionSeconds: number;
  positionObservedAtMs: number;
  playbackRate: number;
  durationSeconds: number | null;
  adapterId: string;
  applyResult: 'applied' | 'rejected' | 'unsupported';
  error?: string;
};

/**
 * Structural validation of an actual-state report: message shape, identifiers,
 * a structurally valid resource identity, and number/phase sanity.
 */
export function isActualStateReport(value: unknown): value is ActualStateReport {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'actual-state') return false;
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0) return false;
  if (typeof candidate.participantId !== 'string' || candidate.participantId.length === 0) return false;
  if (!isNonNegativeInteger(candidate.observedRevision)) return false;
  if (!isValidResourceIdentity(candidate.resourceIdentity)) return false;
  if (!isMediaPhase(candidate.mediaPhase)) return false;
  if (!isNonNegativeFinite(candidate.positionSeconds)) return false;
  if (typeof candidate.positionObservedAtMs !== 'number' || !Number.isFinite(candidate.positionObservedAtMs)) return false;
  if (!isPositiveFinite(candidate.playbackRate)) return false;
  if (candidate.durationSeconds !== null && !isNonNegativeFinite(candidate.durationSeconds)) return false;
  if (typeof candidate.adapterId !== 'string' || candidate.adapterId.length === 0) return false;
  const applyResult = candidate.applyResult;
  if (applyResult !== 'applied' && applyResult !== 'rejected' && applyResult !== 'unsupported') return false;
  if (candidate.error !== undefined && (typeof candidate.error !== 'string' || candidate.error.length === 0)) return false;
  return true;
}

/**
 * Join request from a client. `resourceIdentity` is OPTIONAL: a joiner may not
 * know the session resource yet, and the authority pushes it via the
 * join-accepted state. When present it MUST match the session resource.
 * `roleHint` is OPTIONAL: the joiner's declared intent ('host' or 'client');
 * the authority makes the final role decision and echoes it in
 * join-accepted.role. Both fields are absent in legacy joiners, so the guard
 * stays wire-compatible with old clients.
 */
export type ClientJoin = {
  type: 'join';
  participantId: string;
  roleHint?: 'host' | 'client';
  resourceIdentity?: ResourceIdentity;
};

export function isClientJoin(value: unknown): value is ClientJoin {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'join') return false;
  if (typeof candidate.participantId !== 'string' || candidate.participantId.length === 0) return false;
  if (candidate.roleHint !== undefined && candidate.roleHint !== 'host' && candidate.roleHint !== 'client') return false;
  if (candidate.resourceIdentity === undefined) return true;
  return isValidResourceIdentity(candidate.resourceIdentity);
}

/**
 * Host-only binding of the session's media resource. Only an already-accepted
 * host may send it; the authority rejects it from clients, from unjoined
 * participants, and before the sender's host role is established. The identity
 * passes the generic (site-agnostic) guard, so future adapters can bind their
 * own site's resources without touching the shared core.
 */
export type ResourceBindMessage = {
  type: 'resource-bind';
  participantId: string;
  resourceIdentity: ResourceIdentity;
};

export function isResourceBindMessage(value: unknown): value is ResourceBindMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'resource-bind'
    && typeof candidate.participantId === 'string'
    && candidate.participantId.length > 0
    && isValidResourceIdentity(candidate.resourceIdentity);
}

export type SnapshotRequest = {
  type: 'snapshot-request';
  participantId: string;
  observedRevision: number;
};

export function isSnapshotRequest(value: unknown): value is SnapshotRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'snapshot-request'
    && typeof candidate.participantId === 'string'
    && candidate.participantId.length > 0
    && isNonNegativeInteger(candidate.observedRevision);
}

/**
 * Host decision on the single pending join request. `participantId` identifies
 * the DECISION MAKER (the host), matching the sender semantics of every other
 * client message; the target is the one pending joiner.
 */
export type JoinDecision = {
  type: 'join-decision';
  participantId: string;
  accepted: boolean;
};

export function isJoinDecision(value: unknown): value is JoinDecision {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'join-decision'
    && typeof candidate.participantId === 'string'
    && candidate.participantId.length > 0
    && typeof candidate.accepted === 'boolean';
}

export type ClientMessage =
  | ClientJoin
  | ResourceBindMessage
  | PlaybackIntent
  | SnapshotRequest
  | ActualStateReport
  | JoinDecision;

/** Sent to the host when a second participant requests to join. */
export type JoinRequestMessage = {
  type: 'join-request';
  participantId: string;
  resourceIdentity?: ResourceIdentity;
};

export function isJoinRequestMessage(value: unknown): value is JoinRequestMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'join-request') return false;
  if (typeof candidate.participantId !== 'string' || candidate.participantId.length === 0) return false;
  if (candidate.resourceIdentity === undefined) return true;
  return isValidResourceIdentity(candidate.resourceIdentity);
}

export type JoinAcceptedMessage = {
  type: 'join-accepted';
  role: 'host' | 'client';
  participantId: string;
  state: PlaybackState;
};

export function isJoinAcceptedMessage(value: unknown): value is JoinAcceptedMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'join-accepted') return false;
  if (candidate.role !== 'host' && candidate.role !== 'client') return false;
  if (typeof candidate.participantId !== 'string' || candidate.participantId.length === 0) return false;
  return isPlaybackState(candidate.state);
}

export type JoinRejectedMessage = {
  type: 'join-rejected';
  reason: string;
};

export type StateMessage = {
  type: 'state';
  state: PlaybackState;
};

export type SnapshotMessage = {
  type: 'snapshot';
  state: PlaybackState;
};

/**
 * Per-participant contribution to session readiness. `reported` is true when the
 * participant sent an actual-state report for the CURRENT stateRevision;
 * `consistent` is true when that report carried no readiness-blocking issue.
 */
export type SessionParticipantStatus = {
  participantId: string;
  role: 'host' | 'client';
  reported: boolean;
  consistent: boolean;
};

/**
 * Observable session readiness. `ready` is true ONLY when both participants have
 * reported a consistency-clean actual state for the current revision; otherwise
 * it is explicitly false with a machine-readable `reason`.
 */
export type SessionStatusMessage = {
  type: 'session-status';
  sessionId: string;
  ready: boolean;
  reason?: string;
  stateRevision: number;
  participants: SessionParticipantStatus[];
};

export function isSessionStatus(value: unknown): value is SessionStatusMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'session-status') return false;
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0) return false;
  if (typeof candidate.ready !== 'boolean') return false;
  if (candidate.reason !== undefined && (typeof candidate.reason !== 'string' || candidate.reason.length === 0)) return false;
  if (!isNonNegativeInteger(candidate.stateRevision)) return false;
  if (!Array.isArray(candidate.participants)) return false;
  return candidate.participants.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const record = entry as Record<string, unknown>;
    if (typeof record.participantId !== 'string' || record.participantId.length === 0) return false;
    if (record.role !== 'host' && record.role !== 'client') return false;
    return typeof record.reported === 'boolean' && typeof record.consistent === 'boolean';
  });
}

/** Resource comparison embedded in desync diagnostics. */
export type DiagnosticResourceComparison = {
  expected: ResourceIdentity;
  actual: ResourceIdentity;
};

/** Authoritative-vs-actual state comparison embedded in desync diagnostics. */
export type DiagnosticStateComparison = {
  mediaPhase?: MediaPhase;
  positionSeconds?: number;
  playbackRate?: number;
};

export type DiagnosticMessage = {
  type: 'diagnostic';
  code: 'desync' | 'participant-left' | 'actual-state-mismatch';
  participantId: string;
  detail: string;
  sessionId?: string;
  stateRevision?: number;
  resource?: DiagnosticResourceComparison;
  expected?: DiagnosticStateComparison;
  actual?: DiagnosticStateComparison;
};

export function isDiagnosticMessage(value: unknown): value is DiagnosticMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'diagnostic') return false;
  const code = candidate.code;
  if (code !== 'desync' && code !== 'participant-left' && code !== 'actual-state-mismatch') return false;
  if (typeof candidate.participantId !== 'string' || candidate.participantId.length === 0) return false;
  if (typeof candidate.detail !== 'string') return false;
  if (candidate.sessionId !== undefined && (typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0)) return false;
  if (candidate.stateRevision !== undefined && !isNonNegativeInteger(candidate.stateRevision)) return false;
  if (candidate.resource !== undefined) {
    if (typeof candidate.resource !== 'object' || candidate.resource === null) return false;
    const resource = candidate.resource as Record<string, unknown>;
    if (!isValidResourceIdentity(resource.expected) || !isValidResourceIdentity(resource.actual)) return false;
  }
  for (const key of ['expected', 'actual'] as const) {
    const comparison = candidate[key];
    if (comparison === undefined) continue;
    if (typeof comparison !== 'object' || comparison === null) return false;
    const record = comparison as Record<string, unknown>;
    if (record.mediaPhase !== undefined && !isMediaPhase(record.mediaPhase)) return false;
    if (record.positionSeconds !== undefined && !isNonNegativeFinite(record.positionSeconds)) return false;
    if (record.playbackRate !== undefined && !isPositiveFinite(record.playbackRate)) return false;
  }
  return true;
}

export type ErrorMessage = {
  type: 'error';
  code: string;
  message: string;
};

export function isErrorMessage(value: unknown): value is ErrorMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'error'
    && typeof candidate.code === 'string'
    && candidate.code.length > 0
    && typeof candidate.message === 'string';
}

export type ServerMessage =
  | JoinAcceptedMessage
  | JoinRejectedMessage
  | JoinRequestMessage
  | StateMessage
  | SnapshotMessage
  | SessionStatusMessage
  | DiagnosticMessage
  | ErrorMessage;

/** Identity equality covers adapterId, canonicalUrl and resourceId. */
export function isResourceIdentityEqual(a: ResourceIdentity, b: ResourceIdentity): boolean {
  return a.adapterId === b.adapterId
    && a.canonicalUrl === b.canonicalUrl
    && a.resourceId === b.resourceId;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
