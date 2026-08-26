import { isResourceIdentityEqual } from '../shared/protocol.js';
import type { ActualStateReport, MediaPhase, PlaybackState } from '../shared/protocol.js';
import { projectPlaybackPosition } from './playback-state.js';

/**
 * Pure consistency evaluation for actual-state reports. Everything here is a
 * function of (authoritative state, report) — no clocks, no state, no I/O —
 * so the server and tests share one definition of "in sync".
 */

/** Position divergence (milliseconds) beyond which a report is a desync. */
export const POSITION_DRIFT_THRESHOLD_MS = 250;

/**
 * Phases that can never satisfy a session, even when both endpoints agree: the
 * media hit an error. An error must be diagnosed explicitly instead of being
 * silently treated as applied success. Buffering is NOT unacceptable: it is a
 * transient lifecycle state (a momentary stall on the way to 'playing') and is
 * judged as such elsewhere — compatible with a settled authority phase, never
 * blocking the gate on its own. A shared 'ended' is a legal terminal state —
 * both endpoints ending is consistent — so disagreement is caught by
 * phase-mismatch, not flagged here.
 */
export const UNACCEPTABLE_PHASES: readonly MediaPhase[] = ['error'] as const;

export type ConsistencyIssueKind =
  | 'stale-report'
  | 'revision-mismatch'
  | 'resource-mismatch'
  | 'adapter-mismatch'
  | 'phase-mismatch'
  | 'unacceptable-phase'
  | 'position-drift'
  | 'rate-mismatch'
  | 'duration-mismatch'
  | 'sync-item-mismatch'
  | 'apply-failure';

export type ConsistencyIssue = {
  kind: ConsistencyIssueKind;
  detail: string;
  /** Signed drift in milliseconds (position-drift only). */
  driftMs?: number;
  /**
   * Whether this issue keeps the readiness gate closed. Defaults to membership
   * in READINESS_BLOCKING_KINDS.
   */
  blocking?: boolean;
};

export type ConsistencyResult = {
  /**
   * True when no readiness-blocking issue is present: the report is for the
   * current revision, matches resource/adapter, applied cleanly, the phase is
   * acceptable, and the position is within the drift threshold.
   */
  consistent: boolean;
  issues: ConsistencyIssue[];
};

/**
 * Issues that must keep the session gate closed. A rate mismatch is a real
 * divergence from the authoritative state and blocks. A duration mismatch is
 * only diagnosed when both sides know a concrete duration and disagree, so
 * every diagnosed duration mismatch blocks; an authority that does not yet
 * know the duration is never flagged against a report that does.
 */
export const READINESS_BLOCKING_KINDS: ReadonlySet<ConsistencyIssueKind> = new Set<ConsistencyIssueKind>([
  'stale-report',
  'revision-mismatch',
  'resource-mismatch',
  'adapter-mismatch',
  'phase-mismatch',
  'unacceptable-phase',
  'position-drift',
  'rate-mismatch',
  'duration-mismatch',
  'sync-item-mismatch',
  'apply-failure',
]);

export function isUnacceptablePhase(phase: MediaPhase): boolean {
  return (UNACCEPTABLE_PHASES as readonly string[]).includes(phase);
}

/**
 * Transient media lifecycle states: a buffering element is loading toward
 * 'playing', a seeking element is moving toward the session's target phase.
 * Neither is evidence of divergence — the endpoint is mid-transition on its
 * way to the settled phase — so each is compatible with any non-terminal
 * phase for consistency evaluation.
 */
export const TRANSIENT_PHASES: readonly MediaPhase[] = ['buffering', 'seeking'] as const;

export function isTransientPhase(phase: MediaPhase): boolean {
  return (TRANSIENT_PHASES as readonly string[]).includes(phase);
}

/** Settled terminal phases: a transient report is never compatible with these. */
function isTerminalPhase(phase: MediaPhase): boolean {
  return phase === 'ended' || phase === 'error';
}

/**
 * True when two phases satisfy the readiness judgment identically: the
 * authority's fresh-resource phase 'ready' and a real paused media element
 * are the same observable state, so 'ready' and 'paused' are equivalent for
 * consistency evaluation. No other phase is equivalent to either: 'playing',
 * 'ended', 'error', 'buffering' and 'seeking' are distinct observable states.
 * Transient phases ('buffering'/'seeking') are never diagnosed as mismatches
 * by `arePhasesConsistencyCompatible`, so they need no equivalence here.
 */
export function arePhasesReadinessEquivalent(left: MediaPhase, right: MediaPhase): boolean {
  return left === right
    || (left === 'ready' && right === 'paused')
    || (left === 'paused' && right === 'ready');
}

/**
 * True when two phases are compatible for a consistency judgment, i.e. they
 * must not be diagnosed as a phase mismatch. Compatible phases are: equal
 * phases; the ready/paused pair (the same observable pre-roll state); and any
 * pair in which one side is a transient lifecycle phase ('buffering',
 * 'seeking') while the other is not a terminal phase. A transient phase
 * against 'ended'/'error' is still a real disagreement — the media cannot be
 * transiently loading while the session has settled on a terminal outcome.
 */
export function arePhasesConsistencyCompatible(left: MediaPhase, right: MediaPhase): boolean {
  return arePhasesReadinessEquivalent(left, right)
    || (isTransientPhase(left) && !isTerminalPhase(right))
    || (isTransientPhase(right) && !isTerminalPhase(left));
}

/**
 * Evaluate one actual-state report against the authoritative state.
 *
 * - Discrete field consistency: revision, phase, rate, duration. The
 *   authority's fresh-resource 'ready' phase and a paused media element are
 *   the same observable state, so 'ready' and 'paused' are judged equivalent
 *   for the phase comparison. Buffering/seeking reports are transient media
 *   lifecycle states — an endpoint mid-transition on its way to the settled
 *   phase — so they are compatible with any non-terminal authority phase and
 *   never generate a phase mismatch against one (no other phase is
 *   compatible).
 * - Resource/adapter mismatch: while the session has a bound resource, the
 *   report's identity must equal the session's. Against an unbound session
 *   (`authoritative.resourceIdentity === null`) there is nothing to compare,
 *   so resource/adapter checks are skipped — a concrete report identity is not
 *   treated as a false mismatch. Actual-state reports always carry a concrete
 *   identity; they are simply not comparable until a resource is bound.
 * - Position drift: only judged between equivalent, non-transient phases (a
 *   phase mismatch is already reported for incompatible phases, and a
 *   buffering/seeking report is mid-transition, so its position is converging
 *   on the target, not diverging). While the authoritative phase is 'playing',
 *   the expected position is projected from positionAtMs + playbackRate to the
 *   report's observation time; other phases compare the frozen anchor. Drift
 *   beyond `POSITION_DRIFT_THRESHOLD_MS` yields a desync result.
 * - Apply failure: any applyResult other than 'applied' is a desync, and an
 *   error phase is flagged explicitly even when applied.
 */
export function evaluateActualState(authoritative: PlaybackState, report: ActualStateReport): ConsistencyResult {
  const issues: ConsistencyIssue[] = [];

  if (report.observedRevision < authoritative.stateRevision) {
    issues.push({
      kind: 'stale-report',
      detail: `Reported revision ${report.observedRevision} is older than the authoritative revision ${authoritative.stateRevision}`,
    });
  } else if (report.observedRevision !== authoritative.stateRevision) {
    issues.push({
      kind: 'revision-mismatch',
      detail: `Reported revision ${report.observedRevision} does not match the authoritative revision ${authoritative.stateRevision}`,
    });
  }

  if (authoritative.resourceIdentity !== null) {
    if (!isResourceIdentityEqual(report.resourceIdentity, authoritative.resourceIdentity)) {
      issues.push({
        kind: 'resource-mismatch',
        detail: `Reported resource ${JSON.stringify(report.resourceIdentity)} does not match the session resource ${JSON.stringify(authoritative.resourceIdentity)}`,
      });
    }
    if (report.adapterId !== authoritative.resourceIdentity.adapterId) {
      issues.push({
        kind: 'adapter-mismatch',
        detail: `Reported adapter ${report.adapterId} does not match the session adapter ${authoritative.resourceIdentity.adapterId}`,
      });
    }
  }

  if (!arePhasesConsistencyCompatible(report.mediaPhase, authoritative.mediaPhase)) {
    issues.push({
      kind: 'phase-mismatch',
      detail: `Reported phase ${report.mediaPhase} does not match the authoritative phase ${authoritative.mediaPhase} (only ready/paused are equivalent; buffering/seeking are transient)`,
    });
  }
  if (isUnacceptablePhase(report.mediaPhase)) {
    issues.push({
      kind: 'unacceptable-phase',
      detail: `Reported phase ${report.mediaPhase} cannot satisfy the session (error)`,
    });
  }

  // Position drift: only judge settled, equivalent phases. A transient report
  // is mid-transition — its position is converging on the session's target,
  // not diverging — and an incompatible phase is already reported above, so
  // drift is measured only between equivalent non-transient phases.
  if (arePhasesReadinessEquivalent(report.mediaPhase, authoritative.mediaPhase)
    && !isTransientPhase(report.mediaPhase)
    && !isTransientPhase(authoritative.mediaPhase)) {
    const expectedPosition = projectPlaybackPosition(authoritative, report.positionObservedAtMs);
    const driftMs = Math.round(Math.abs(expectedPosition - report.positionSeconds) * 1000);
    if (driftMs > POSITION_DRIFT_THRESHOLD_MS) {
      issues.push({
        kind: 'position-drift',
        driftMs,
        detail: `Position drift of ${driftMs}ms exceeds the ${POSITION_DRIFT_THRESHOLD_MS}ms threshold (expected ${expectedPosition}s at observation time, reported ${report.positionSeconds}s)`,
      });
    }
  }

  if (Math.abs(report.playbackRate - authoritative.playbackRate) > 1e-9) {
    issues.push({
      kind: 'rate-mismatch',
      detail: `Reported playback rate ${report.playbackRate} does not match the authoritative rate ${authoritative.playbackRate}`,
    });
  }
  // The authority may legitimately not know the media duration yet
  // (durationSeconds null); a report that carries a concrete duration is
  // information completing the state, not a divergence. A mismatch is only
  // diagnosed when both sides actually know a concrete duration and disagree.
  if (authoritative.durationSeconds !== null
    && report.durationSeconds !== null
    && report.durationSeconds !== authoritative.durationSeconds) {
    issues.push({
      kind: 'duration-mismatch',
      detail: `Reported duration ${report.durationSeconds} does not match the authoritative duration ${authoritative.durationSeconds}`,
    });
  }

  const definitions = authoritative.syncItemDefinitions ?? [];
  if (definitions.length > 0) {
    for (const definition of definitions) {
      const reportedValue = report.syncItems?.[definition.key];
      const expectedValue = authoritative.syncItems?.[definition.key];
      if (reportedValue === undefined || expectedValue === undefined
        || Math.abs(reportedValue - expectedValue) > definition.tolerance) {
        issues.push({
          kind: 'sync-item-mismatch',
          detail: `Reported sync item ${definition.key}=${String(reportedValue)} does not match the authoritative value ${String(expectedValue)} within tolerance ${definition.tolerance}`,
        });
      }
    }
  }

  if (report.applyResult !== 'applied') {
    issues.push({
      kind: 'apply-failure',
      detail: report.error ?? `Adapter reported applyResult=${report.applyResult}`,
    });
  }

  return {
    consistent: issues.every((issue) => !(issue.blocking ?? READINESS_BLOCKING_KINDS.has(issue.kind))),
    issues,
  };
}
