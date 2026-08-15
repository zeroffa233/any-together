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
 * media hit an error or is stalled buffering. These must be diagnosed
 * explicitly instead of being silently treated as applied success. A shared
 * 'ended' is a legal terminal state — both endpoints ending is consistent — so
 * disagreement is caught by phase-mismatch, not flagged here.
 */
export const UNACCEPTABLE_PHASES: readonly MediaPhase[] = ['error', 'buffering'] as const;

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
  | 'apply-failure';

export type ConsistencyIssue = {
  kind: ConsistencyIssueKind;
  detail: string;
  /** Signed drift in milliseconds (position-drift only). */
  driftMs?: number;
  /**
   * Whether this issue keeps the readiness gate closed. Defaults to membership
   * in READINESS_BLOCKING_KINDS; duration-mismatch sets it explicitly because
   * blocking depends on whether the authoritative duration is known.
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
 * divergence from the authoritative state and blocks. Duration mismatches are
 * handled per-issue: they block only when both sides know the duration,
 * because the authority may legitimately not know the media duration.
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
  'apply-failure',
]);

export function isUnacceptablePhase(phase: MediaPhase): boolean {
  return (UNACCEPTABLE_PHASES as readonly string[]).includes(phase);
}

/**
 * Evaluate one actual-state report against the authoritative state.
 *
 * - Discrete field consistency: revision, phase, rate, duration.
 * - Resource/adapter mismatch: while the session has a bound resource, the
 *   report's identity must equal the session's. Against an unbound session
 *   (`authoritative.resourceIdentity === null`) there is nothing to compare,
 *   so resource/adapter checks are skipped — a concrete report identity is not
 *   treated as a false mismatch. Actual-state reports always carry a concrete
 *   identity; they are simply not comparable until a resource is bound.
 * - Position drift: while the authoritative phase is 'playing', the expected
 *   position is projected from positionAtMs + playbackRate to the report's
 *   observation time; other phases compare the frozen anchor. Drift beyond
 *   `POSITION_DRIFT_THRESHOLD_MS` yields a desync result.
 * - Apply failure: any applyResult other than 'applied' is a desync, and
 *   error/buffering phases are flagged explicitly even when applied.
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

  if (report.mediaPhase !== authoritative.mediaPhase) {
    issues.push({
      kind: 'phase-mismatch',
      detail: `Reported phase ${report.mediaPhase} does not match the authoritative phase ${authoritative.mediaPhase}`,
    });
  }
  if (isUnacceptablePhase(report.mediaPhase)) {
    issues.push({
      kind: 'unacceptable-phase',
      detail: `Reported phase ${report.mediaPhase} cannot satisfy the session (error/buffering)`,
    });
  }

  // Position drift: compare like phases only; a phase mismatch is already reported.
  if (report.mediaPhase === authoritative.mediaPhase) {
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
  if (report.durationSeconds !== authoritative.durationSeconds) {
    issues.push({
      kind: 'duration-mismatch',
      // The authority may legitimately not know the media duration yet
      // (durationSeconds null); a mismatch is only a readiness violation when
      // both sides actually know the duration and disagree.
      blocking: authoritative.durationSeconds !== null && report.durationSeconds !== null,
      detail: `Reported duration ${String(report.durationSeconds)} does not match the authoritative duration ${String(authoritative.durationSeconds)}`,
    });
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
