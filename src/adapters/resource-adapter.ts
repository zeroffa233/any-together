import type { MediaPhase, PlaybackState, ResourceIdentity } from '../shared/protocol.js';

/**
 * Snapshot of what the page's media actually reports right now. Values are read from
 * the live media object (or a fake page in tests) — never synthesized to match the
 * last applied command.
 */
export type LocalPlaybackState = {
  resourceIdentity: ResourceIdentity;
  mediaPhase: MediaPhase;
  positionSeconds: number;
  playbackRate: number;
  durationSeconds: number | null;
};

/** State fields the authority can ask an adapter to enforce on the page. */
export type AdapterTargetState = Pick<PlaybackState, 'mediaPhase' | 'positionSeconds' | 'playbackRate'>;

/**
 * Outcome of applying a target state:
 * - 'applied' — the operations ran and `state` is the real post-execution snapshot.
 * - 'rejected' — an operation was attempted but failed (browser rejection, invalid
 *   values); `state` is the best-effort real snapshot.
 * - 'unsupported' — the adapter cannot operate on this page (no media, wrong site);
 *   `state` is a neutral placeholder and `error` explains why.
 */
export type AdapterApplyResult = {
  result: 'applied' | 'rejected' | 'unsupported';
  error?: string;
  state: LocalPlaybackState;
};

/** Native media events an adapter can surface to the page agent. */
export type AdapterEvent =
  | 'play'
  | 'pause'
  | 'seeking'
  | 'seeked'
  | 'waiting'
  | 'playing'
  | 'ended'
  | 'error'
  | 'ratechange'
  | 'timeupdate';

/**
 * Operations a syncer advertises for its site. The static, registry-visible
 * form is `SyncerRegistration.capabilities`; the adapter implements them
 * through `applyState` / `subscribe` at runtime.
 *
 * - 'play' / 'pause' — start and stop playback.
 * - 'seek' — jump to an arbitrary position.
 * - 'set-rate' — change the playback rate.
 * - 'replay' — restart an ended resource.
 * - 'native-events' — surfaces native media events via `subscribe`.
 */
export type AdapterCapability = 'play' | 'pause' | 'seek' | 'set-rate' | 'replay' | 'native-events';

export type AdapterSiteErrorCode = 'invalid-url' | 'not-bilibili' | 'browser-required' | 'no-media';

/**
 * Explicit page-level failure: the adapter cannot (or is not allowed to) do its job on
 * the current page. Thrown by `identifyResource` / `selectTarget` / `readState` so
 * callers never mistake a site problem for a media operation failure.
 */
export class AdapterSiteError extends Error {
  readonly code: AdapterSiteErrorCode;

  constructor(code: AdapterSiteErrorCode, message: string) {
    super(message);
    this.name = 'AdapterSiteError';
    this.code = code;
  }
}

/**
 * Page adapter contract (semantics, not session state).
 *
 * Implementations are stateless with respect to sessions and commands: they never
 * store a sessionId, commandId, command sequence, or state revision. They only map a
 * page's media to the shared playback semantics and report what actually happened.
 *
 * - `identifyResource()` normalizes the current page URL into a comparable
 *   ResourceIdentity; throws `AdapterSiteError` for unparseable or foreign URLs.
 * - `selectTarget()` picks the deterministic target media object on the page; throws
 *   `AdapterSiteError('no-media')` when nothing playable exists. Selection must be
 *   deterministic — callers must never pick the "first" candidate themselves.
 * - `readState()` returns the real observed state of the selected target; throws
 *   `AdapterSiteError` when no target is available.
 * - `applyState(target)` performs play/pause/seek/rate and always resolves to an
 *   `AdapterApplyResult` whose `state` is read after execution.
 * - `subscribe(listener)` binds native events for the current target and returns an
 *   unsubscribe function that removes exactly those bindings.
 */
export interface ResourceAdapter {
  readonly adapterId: string;
  identifyResource(): ResourceIdentity;
  selectTarget(): void;
  readState(): LocalPlaybackState;
  applyState(target: AdapterTargetState): Promise<AdapterApplyResult>;
  subscribe(listener: (event: AdapterEvent) => void): () => void;
}
