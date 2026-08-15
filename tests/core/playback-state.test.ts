/**
 * Behavior tests for the playback state machine (src/core/playback-state.ts), the
 * report-consistency evaluation it feeds (src/core/consistency-monitor.ts), and
 * Bilibili resource identity normalization (src/shared/resource.ts).
 *
 * All clocks are injected as fixed millisecond timestamps; the suite is pure and
 * deterministic — no wall clock, network, DOM, or cross-test ordering dependencies.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyIntent,
  createInitialPlaybackState,
  isPhaseAdvancing,
  projectPlaybackPosition,
  restorePlaybackState,
  StateTransitionError,
} from '../../src/core/playback-state.js';
import {
  arePhasesReadinessEquivalent,
  evaluateActualState,
  POSITION_DRIFT_THRESHOLD_MS,
} from '../../src/core/consistency-monitor.js';
import { createBilibiliResourceIdentity, ResourceIdentityError } from '../../src/shared/resource.js';
import {
  isBilibiliResourceIdentity,
  isPlaybackIntent,
  isPlaybackState,
  isResourceIdentityEqual,
  isValidResourceIdentity,
  MAX_PLAYBACK_RATE,
  resourceIdentityFingerprint,
} from '../../src/shared/protocol.js';
import type { ActualStateReport, PlaybackIntent, PlaybackState } from '../../src/shared/protocol.js';

const SESSION_ID = 'session-1';
const T0 = 1_000_000;
const T1 = T0 + 4_000;
const T2 = T0 + 10_000;

const identity = createBilibiliResourceIdentity('https://www.bilibili.com/video/BV1xx411c7mD');

const savedPlaying: PlaybackState = {
  sessionId: SESSION_ID,
  resourceIdentity: identity,
  stateRevision: 7,
  lastSequence: 9,
  mediaPhase: 'playing',
  positionSeconds: 30,
  positionAtMs: 1_000,
  playbackRate: 1,
  durationSeconds: 100,
  lastCommandId: 'cmd-restore-me',
  updatedAtMs: 1_000,
};

function makeIntent(
  kind: PlaybackIntent['kind'],
  overrides: Partial<PlaybackIntent> = {},
): PlaybackIntent {
  return {
    type: 'intent',
    commandId: `cmd-${kind}`,
    sessionId: SESSION_ID,
    participantId: 'participant-1',
    clientObservedRevision: 0,
    kind,
    createdAtMs: T0,
    ...overrides,
  };
}

function expectTransitionError(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof StateTransitionError, `expected StateTransitionError, got: ${String(err)}`);
    assert.equal((err as StateTransitionError).code, code);
    return true;
  });
}

describe('createInitialPlaybackState', () => {
  it('starts ready with zeroed counters anchored at nowMs', () => {
    const state = createInitialPlaybackState(SESSION_ID, identity, T0);
    assert.equal(state.mediaPhase, 'ready');
    assert.equal(state.positionSeconds, 0);
    assert.equal(state.positionAtMs, T0);
    assert.equal(state.updatedAtMs, T0);
    assert.equal(state.stateRevision, 0);
    assert.equal(state.lastSequence, 0);
    assert.equal(state.playbackRate, 1);
    assert.equal(state.durationSeconds, null);
    assert.equal(state.lastCommandId, null);
    assert.equal(isPlaybackState(state), true);
  });

  it('honors an explicit duration and keeps the resource identity', () => {
    const state = createInitialPlaybackState(SESSION_ID, identity, T0, 120);
    assert.equal(state.durationSeconds, 120);
    assert.deepEqual(state.resourceIdentity, identity);
  });

  it('rejects an empty session id', () => {
    expectTransitionError(() => createInitialPlaybackState('', identity, T0), 'invalid-session');
  });

  it('rejects an invalid resource identity', () => {
    expectTransitionError(
      () => createInitialPlaybackState(SESSION_ID, { adapterId: '', canonicalUrl: '' }, T0),
      'invalid-resource-identity',
    );
    assert.equal(isValidResourceIdentity({ adapterId: 'bilibili', canonicalUrl: '' }), false);
  });

  it('keeps the core host-agnostic: the Bilibili site constraint lives in the site guard', () => {
    const foreign = {
      adapterId: 'bilibili',
      canonicalUrl: 'https://example.com/video/BV1xx411c7mD',
      resourceId: 'BV1xx411c7mD',
    };
    // The shared core deliberately accepts any http(s) identity, so the state
    // machine cannot reject a future adapter's resource; site policy is not
    // its concern.
    assert.equal(isValidResourceIdentity(foreign), true, 'the shared core must accept a foreign-site identity');
    const state = createInitialPlaybackState(SESSION_ID, foreign, T0);
    assert.deepEqual(state.resourceIdentity, foreign, 'the core must keep the foreign identity as-is');
    // The first-release site constraint is enforced by the Bilibili-specific
    // guard at the entrypoints instead of by the core.
    assert.equal(isBilibiliResourceIdentity(foreign), false, 'the Bilibili guard must reject a foreign host');
    assert.equal(
      isBilibiliResourceIdentity(createBilibiliResourceIdentity('https://www.bilibili.com/video/BV1xx411c7mD')),
      true,
      'the Bilibili guard must accept a canonical Bilibili identity',
    );
  });

  it('rejects a negative duration', () => {
    expectTransitionError(() => createInitialPlaybackState(SESSION_ID, identity, T0, -1), 'invalid-duration');
  });

  it('rejects a non-finite clock', () => {
    expectTransitionError(() => createInitialPlaybackState(SESSION_ID, identity, Number.NaN), 'invalid-clock');
  });
});

describe('projectPlaybackPosition', () => {
  it('returns the frozen position for non-advancing phases', () => {
    const initial = createInitialPlaybackState(SESSION_ID, identity, T0);
    assert.equal(projectPlaybackPosition(initial, T0 + 100_000), 0);
    const paused = applyIntent(initial, makeIntent('pause'), T0);
    assert.equal(projectPlaybackPosition(paused, T0 + 100_000), 0);
  });

  it('advances from the anchor while playing', () => {
    const playing = applyIntent(createInitialPlaybackState(SESSION_ID, identity, T0), makeIntent('play'), T0);
    assert.equal(projectPlaybackPosition(playing, T0 + 5_000), 5);
  });

  it('scales the projection by playback rate', () => {
    let state = createInitialPlaybackState(SESSION_ID, identity, T0);
    state = applyIntent(state, makeIntent('play'), T0);
    state = applyIntent(state, makeIntent('set-rate', { payload: { playbackRate: 2 } }), T0);
    assert.equal(state.mediaPhase, 'playing');
    assert.equal(projectPlaybackPosition(state, T0 + 3_000), 6);
  });

  it('caps the projection at the duration', () => {
    const playing = applyIntent(createInitialPlaybackState(SESSION_ID, identity, T0, 10), makeIntent('play'), T0);
    assert.equal(projectPlaybackPosition(playing, T0 + 60_000), 10);
  });

  it('caps the rate-scaled projection at the duration', () => {
    let state = createInitialPlaybackState(SESSION_ID, identity, T0, 10);
    state = applyIntent(state, makeIntent('seek', { payload: { targetSeconds: 8 } }), T0);
    state = applyIntent(state, makeIntent('play'), T0);
    state = applyIntent(state, makeIntent('set-rate', { payload: { playbackRate: 2 } }), T0);
    assert.equal(projectPlaybackPosition(state, T0 + 2_000), 10);
  });

  it('never moves backwards when the clock goes back', () => {
    const playing = applyIntent(createInitialPlaybackState(SESSION_ID, identity, T0), makeIntent('play'), T0);
    assert.equal(projectPlaybackPosition(playing, T0 - 5_000), 0);
  });

  it('is monotonic in time while playing', () => {
    const playing = applyIntent(createInitialPlaybackState(SESSION_ID, identity, T0), makeIntent('play'), T0);
    const earlier = projectPlaybackPosition(playing, T0 + 1_000);
    const later = projectPlaybackPosition(playing, T0 + 2_000);
    assert.ok(later >= earlier);
  });

  it('rounds the projection to millisecond precision', () => {
    const playing = applyIntent(createInitialPlaybackState(SESSION_ID, identity, T0), makeIntent('play'), T0);
    assert.equal(projectPlaybackPosition(playing, T0 + 1_234), 1.234);
  });

  it('rejects a non-finite clock', () => {
    const playing = applyIntent(createInitialPlaybackState(SESSION_ID, identity, T0), makeIntent('play'), T0);
    expectTransitionError(() => projectPlaybackPosition(playing, Number.NaN), 'invalid-clock');
  });

  it('only the playing phase advances', () => {
    assert.equal(isPhaseAdvancing('playing'), true);
    assert.equal(isPhaseAdvancing('ready'), false);
    assert.equal(isPhaseAdvancing('paused'), false);
    assert.equal(isPhaseAdvancing('ended'), false);
  });
});

describe('applyIntent', () => {
  it('play transitions to playing and freezes the projection at nowMs', () => {
    const state = applyIntent(createInitialPlaybackState(SESSION_ID, identity, T0), makeIntent('play'), T1);
    assert.equal(state.mediaPhase, 'playing');
    assert.equal(state.positionSeconds, 0);
    assert.equal(state.positionAtMs, T1);
    assert.equal(state.stateRevision, 1);
    assert.equal(state.lastSequence, 1);
    assert.equal(state.lastCommandId, 'cmd-play');
  });

  it('play applied mid-playback projects the current position', () => {
    let state = createInitialPlaybackState(SESSION_ID, identity, T0);
    state = applyIntent(state, makeIntent('play'), T0);
    state = applyIntent(state, makeIntent('play', { commandId: 'cmd-play-again' }), T1);
    assert.equal(state.mediaPhase, 'playing');
    assert.equal(state.positionSeconds, 4);
    assert.equal(state.positionAtMs, T1);
    assert.equal(state.stateRevision, 2);
  });

  it('pause freezes the projected position', () => {
    let state = createInitialPlaybackState(SESSION_ID, identity, T0);
    state = applyIntent(state, makeIntent('play'), T0);
    state = applyIntent(state, makeIntent('pause'), T1);
    assert.equal(state.mediaPhase, 'paused');
    assert.equal(state.positionSeconds, 4);
    assert.equal(state.positionAtMs, T1);
    assert.equal(projectPlaybackPosition(state, T2), 4);
  });

  it('seek to a legal target keeps a playing phase playing', () => {
    let state = createInitialPlaybackState(SESSION_ID, identity, T0);
    state = applyIntent(state, makeIntent('play'), T0);
    state = applyIntent(state, makeIntent('seek', { payload: { targetSeconds: 10 } }), T1);
    assert.equal(state.mediaPhase, 'playing');
    assert.equal(state.positionSeconds, 10);
    assert.equal(state.positionAtMs, T1);
  });

  it('seek from a non-playing phase freezes as paused', () => {
    const state = applyIntent(
      createInitialPlaybackState(SESSION_ID, identity, T0),
      makeIntent('seek', { payload: { targetSeconds: 5 } }),
      T1,
    );
    assert.equal(state.mediaPhase, 'paused');
    assert.equal(state.positionSeconds, 5);
  });

  it('seek without a duration keeps the exact target', () => {
    const state = applyIntent(
      createInitialPlaybackState(SESSION_ID, identity, T0),
      makeIntent('seek', { payload: { targetSeconds: 12.345 } }),
      T1,
    );
    assert.equal(state.positionSeconds, 12.345);
  });

  it('seek at exactly the duration is accepted', () => {
    const state = applyIntent(
      createInitialPlaybackState(SESSION_ID, identity, T0, 10),
      makeIntent('seek', { payload: { targetSeconds: 10 } }),
      T1,
    );
    assert.equal(state.positionSeconds, 10);
  });

  it('seek beyond the duration throws invalid-seek and leaves the state untouched', () => {
    const state = createInitialPlaybackState(SESSION_ID, identity, T0, 10);
    const before = structuredClone(state);
    expectTransitionError(
      () => applyIntent(state, makeIntent('seek', { payload: { targetSeconds: 10.0015 } }), T1),
      'invalid-seek',
    );
    assert.deepEqual(state, before);
  });

  it('seek within float tolerance of the duration clamps to the duration', () => {
    const state = applyIntent(
      createInitialPlaybackState(SESSION_ID, identity, T0, 10),
      makeIntent('seek', { payload: { targetSeconds: 10.0005 } }),
      T1,
    );
    assert.equal(state.positionSeconds, 10);
  });

  it('rejects negative and NaN seek targets', () => {
    const state = createInitialPlaybackState(SESSION_ID, identity, T0, 10);
    // Negative/NaN targets fail structural validation, so the stable code is 'invalid-intent'.
    expectTransitionError(
      () => applyIntent(state, makeIntent('seek', { payload: { targetSeconds: -1 } }), T1),
      'invalid-intent',
    );
    expectTransitionError(
      () => applyIntent(state, makeIntent('seek', { payload: { targetSeconds: Number.NaN } }), T1),
      'invalid-intent',
    );
  });

  it('set-rate accepts rates in (0, MAX_PLAYBACK_RATE]', () => {
    const base = createInitialPlaybackState(SESSION_ID, identity, T0);
    assert.equal(applyIntent(base, makeIntent('set-rate', { payload: { playbackRate: 0.5 } }), T0).playbackRate, 0.5);
    assert.equal(applyIntent(base, makeIntent('set-rate', { payload: { playbackRate: 2 } }), T0).playbackRate, 2);
    assert.equal(
      applyIntent(base, makeIntent('set-rate', { payload: { playbackRate: MAX_PLAYBACK_RATE } }), T0).playbackRate,
      MAX_PLAYBACK_RATE,
    );
  });

  it('rejects zero, negative, above-max and NaN rates and leaves the state untouched', () => {
    const state = createInitialPlaybackState(SESSION_ID, identity, T0);
    const before = structuredClone(state);
    // Out-of-domain rates fail structural validation, so the stable code is 'invalid-intent'.
    for (const playbackRate of [0, -2, 17, Number.NaN]) {
      expectTransitionError(
        () => applyIntent(state, makeIntent('set-rate', { payload: { playbackRate } }), T1),
        'invalid-intent',
      );
    }
    assert.deepEqual(state, before);
  });

  it('set-rate keeps the phase and freezes the position at apply time', () => {
    let state = createInitialPlaybackState(SESSION_ID, identity, T0);
    state = applyIntent(state, makeIntent('play'), T0);
    state = applyIntent(state, makeIntent('set-rate', { payload: { playbackRate: 2 } }), T1);
    assert.equal(state.mediaPhase, 'playing');
    assert.equal(state.positionSeconds, 4);
    assert.equal(state.positionAtMs, T1);
  });

  it('replay resets the position to zero and resumes playing', () => {
    let state = createInitialPlaybackState(SESSION_ID, identity, T0);
    state = applyIntent(state, makeIntent('play'), T0);
    state = applyIntent(state, makeIntent('pause'), T1);
    assert.equal(state.positionSeconds, 4);
    state = applyIntent(state, makeIntent('replay'), T2);
    assert.equal(state.mediaPhase, 'playing');
    assert.equal(state.positionSeconds, 0);
    assert.equal(state.positionAtMs, T2);
    assert.equal(projectPlaybackPosition(state, T2 + 2_000), 2);
  });

  it('rejects intents for another session', () => {
    const state = createInitialPlaybackState(SESSION_ID, identity, T0);
    expectTransitionError(
      () => applyIntent(state, makeIntent('play', { sessionId: 'session-2' }), T1),
      'session-mismatch',
    );
  });

  it('rejects malformed intents', () => {
    const state = createInitialPlaybackState(SESSION_ID, identity, T0);
    const seekWithoutPayload = { ...makeIntent('play'), kind: 'seek' } as unknown as PlaybackIntent;
    const unknownKind = { ...makeIntent('play'), kind: 'rewind' } as unknown as PlaybackIntent;
    expectTransitionError(() => applyIntent(state, seekWithoutPayload, T1), 'invalid-intent');
    expectTransitionError(() => applyIntent(state, unknownKind, T1), 'invalid-intent');
  });

  it('rejects malformed states', () => {
    const state = createInitialPlaybackState(SESSION_ID, identity, T0);
    const badRevision = { ...state, stateRevision: -1 };
    const badIdentity = { ...state, resourceIdentity: { adapterId: '', canonicalUrl: '' } };
    expectTransitionError(() => applyIntent(badRevision, makeIntent('play'), T1), 'invalid-state');
    expectTransitionError(() => applyIntent(badIdentity, makeIntent('play'), T1), 'invalid-state');
  });

  it('rejects a non-finite clock', () => {
    const state = createInitialPlaybackState(SESSION_ID, identity, T0);
    expectTransitionError(() => applyIntent(state, makeIntent('play'), Number.NaN), 'invalid-clock');
  });

  it('never mutates the input state, including on rejection', () => {
    const state = createInitialPlaybackState(SESSION_ID, identity, T0);
    const before = structuredClone(state);
    applyIntent(state, makeIntent('play'), T1);
    assert.deepEqual(state, before);
    expectTransitionError(
      () => applyIntent(state, makeIntent('seek', { payload: { targetSeconds: -1 } }), T1),
      'invalid-intent',
    );
    assert.deepEqual(state, before);
  });

  it('bumps stateRevision and lastSequence by exactly one per intent', () => {
    const intents: PlaybackIntent[] = [
      makeIntent('play'),
      makeIntent('pause'),
      makeIntent('seek', { payload: { targetSeconds: 5 } }),
      makeIntent('set-rate', { payload: { playbackRate: 2 } }),
      makeIntent('replay'),
    ];
    let state = createInitialPlaybackState(SESSION_ID, identity, T0);
    const revisions: number[] = [];
    for (const [i, intent] of intents.entries()) {
      state = applyIntent(state, intent, T0 + i * 1_000);
      revisions.push(state.stateRevision);
      assert.equal(state.lastSequence, state.stateRevision);
    }
    assert.deepEqual(revisions, [1, 2, 3, 4, 5]);
    assert.equal(state.stateRevision, 5);
    assert.equal(state.lastSequence, 5);
  });
});

describe('consistency evaluation: ready/paused phase equivalence', () => {
  const ready = createInitialPlaybackState(SESSION_ID, identity, T0);

  function pausedReport(overrides: Partial<ActualStateReport> = {}): ActualStateReport {
    return {
      type: 'actual-state',
      sessionId: SESSION_ID,
      participantId: 'participant-1',
      resourceIdentity: identity,
      adapterId: identity.adapterId,
      observedRevision: ready.stateRevision,
      mediaPhase: 'paused',
      positionSeconds: 0,
      positionObservedAtMs: T1,
      playbackRate: 1,
      durationSeconds: null,
      applyResult: 'applied',
      ...overrides,
    };
  }

  it('judges a paused actual report against a ready authority consistent (no false desync)', () => {
    assert.equal(arePhasesReadinessEquivalent('ready', 'paused'), true);
    assert.equal(arePhasesReadinessEquivalent('paused', 'ready'), true);
    const evaluation = evaluateActualState(ready, pausedReport());
    assert.equal(evaluation.consistent, true, `expected consistent, got issues: ${JSON.stringify(evaluation.issues)}`);
    assert.deepEqual(evaluation.issues, []);
  });

  it('is symmetric: a ready report against a paused authority is consistent', () => {
    const paused = applyIntent(ready, makeIntent('pause'), T1);
    const evaluation = evaluateActualState(paused, {
      ...pausedReport(),
      observedRevision: paused.stateRevision,
      mediaPhase: 'ready',
    });
    assert.equal(evaluation.consistent, true, `expected consistent, got issues: ${JSON.stringify(evaluation.issues)}`);
    assert.deepEqual(evaluation.issues, []);
  });

  it('still flags real divergences: playing, ended and buffering reports against a ready authority are phase mismatches', () => {
    for (const mediaPhase of ['playing', 'ended', 'buffering'] as const) {
      const evaluation = evaluateActualState(ready, pausedReport({ mediaPhase }));
      assert.equal(evaluation.consistent, false, `${mediaPhase} against a ready authority must not be consistent`);
      assert.ok(
        evaluation.issues.some((issue) => issue.kind === 'phase-mismatch'),
        `${mediaPhase} against a ready authority must carry a phase-mismatch issue`,
      );
    }
    // error/buffering are additionally unacceptable on their own.
    const buffering = evaluateActualState(ready, pausedReport({ mediaPhase: 'buffering' }));
    assert.ok(
      buffering.issues.some((issue) => issue.kind === 'unacceptable-phase'),
      'buffering must also be flagged as an unacceptable phase',
    );
  });

  it('keeps judging real drift: a paused report far from the ready playhead is still a desync', () => {
    const evaluation = evaluateActualState(ready, pausedReport({ positionSeconds: 5 }));
    assert.equal(evaluation.consistent, false, 'a 5s drift against a ready authority must stay a desync');
    const drift = evaluation.issues.find((issue) => issue.kind === 'position-drift');
    assert.ok(drift, 'the drifted paused report must carry a position-drift issue');
    assert.ok((drift.driftMs ?? 0) > POSITION_DRIFT_THRESHOLD_MS, 'the drift must exceed the threshold');
  });

  it('keeps judging real mismatches on other fields: a paused report with a different rate is a desync', () => {
    const evaluation = evaluateActualState(ready, pausedReport({ playbackRate: 2 }));
    assert.equal(evaluation.consistent, false, 'a rate mismatch must stay a desync');
    assert.ok(
      evaluation.issues.some((issue) => issue.kind === 'rate-mismatch'),
      'the mismatched rate must be reported',
    );
  });
});

describe('restorePlaybackState', () => {
  it('re-anchors the saved position at restore time without jumping', () => {
    const restored = restorePlaybackState(savedPlaying, T0);
    assert.equal(restored.positionSeconds, 30);
    assert.equal(restored.positionAtMs, T0);
    // One second after restore the position advanced 1s from the *saved* position,
    // not from the wall-clock gap between the old anchor (t=1000) and restore time.
    assert.equal(projectPlaybackPosition(restored, T0 + 1_000), 31);
  });

  it('preserves revision, sequence, phase, identity and command id', () => {
    const restored = restorePlaybackState(savedPlaying, T0);
    assert.equal(restored.sessionId, SESSION_ID);
    assert.equal(restored.stateRevision, 7);
    assert.equal(restored.lastSequence, 9);
    assert.equal(restored.mediaPhase, 'playing');
    assert.equal(restored.playbackRate, 1);
    assert.equal(restored.durationSeconds, 100);
    assert.equal(restored.lastCommandId, 'cmd-restore-me');
    assert.deepEqual(restored.resourceIdentity, identity);
  });

  it('keeps a restored paused state frozen', () => {
    const restored = restorePlaybackState({ ...savedPlaying, mediaPhase: 'paused' }, T0);
    assert.equal(projectPlaybackPosition(restored, T0 + 60_000), 30);
  });

  it('rejects malformed saved states', () => {
    expectTransitionError(() => restorePlaybackState({} as unknown as PlaybackState, T0), 'invalid-state');
    expectTransitionError(
      () => restorePlaybackState({ ...savedPlaying, positionSeconds: -1 }, T0),
      'invalid-state',
    );
  });
});

describe('createBilibiliResourceIdentity', () => {
  it('extracts the BV id and keeps the canonical URL', () => {
    const id = createBilibiliResourceIdentity('https://www.bilibili.com/video/BV1xx411c7mD');
    assert.equal(id.adapterId, 'bilibili');
    assert.equal(id.canonicalUrl, 'https://www.bilibili.com/video/BV1xx411c7mD');
    assert.equal(id.resourceId, 'BV1xx411c7mD');
    assert.equal(isBilibiliResourceIdentity(id), true, 'produced identities must satisfy the first-release Bilibili site gate');
  });

  it('strips a trailing slash from the canonical URL', () => {
    const id = createBilibiliResourceIdentity('https://www.bilibili.com/video/BV1xx411c7mD/');
    assert.equal(id.canonicalUrl, 'https://www.bilibili.com/video/BV1xx411c7mD');
    assert.equal(id.resourceId, 'BV1xx411c7mD');
  });

  it('drops query parameters from the canonical URL', () => {
    const id = createBilibiliResourceIdentity('https://www.bilibili.com/video/BV1xx411c7mD?p=2&t=10s');
    assert.equal(id.canonicalUrl, 'https://www.bilibili.com/video/BV1xx411c7mD');
    assert.equal(id.resourceId, 'BV1xx411c7mD');
  });

  it('normalizes a combined trailing slash and query', () => {
    const id = createBilibiliResourceIdentity('https://www.bilibili.com/video/BV1xx411c7mD/?p=2');
    assert.equal(id.canonicalUrl, 'https://www.bilibili.com/video/BV1xx411c7mD');
    assert.equal(id.resourceId, 'BV1xx411c7mD');
  });

  it('omits resourceId for a /video page without a BV segment', () => {
    const id = createBilibiliResourceIdentity('https://www.bilibili.com/video');
    assert.equal(id.adapterId, 'bilibili');
    assert.equal(id.canonicalUrl, 'https://www.bilibili.com/video');
    assert.equal(id.resourceId, undefined);
    assert.equal(isBilibiliResourceIdentity(id), true, 'a /video page without a BV segment must still satisfy the site gate');
  });

  it('rejects non-Bilibili hosts and non-http schemes with not-bilibili', () => {
    const foreign = [
      'https://example.com/video/BV1xx411c7mD',
      'https://bilibili.com.evil.example/video/BV1xx411c7mD',
      'https://evilbilibili.com/video/BV1xx411c7mD',
      'ftp://www.bilibili.com/video/BV1xx411c7mD',
      'file:///tmp/video.html',
    ];
    for (const href of foreign) {
      assert.throws(
        () => createBilibiliResourceIdentity(href),
        (error: unknown) => error instanceof ResourceIdentityError && error.code === 'not-bilibili',
        `${href} must be rejected as not-bilibili`,
      );
    }
  });

  it('rejects unparseable URLs with invalid-url', () => {
    assert.throws(
      () => createBilibiliResourceIdentity('not a url'),
      (error: unknown) => error instanceof ResourceIdentityError && error.code === 'invalid-url',
    );
  });

  it('accepts the bare domain and bilibili subdomains on /video paths as valid identities', () => {
    assert.equal(isBilibiliResourceIdentity(createBilibiliResourceIdentity('https://bilibili.com/video/BV1xx411c7mD')), true);
    assert.equal(isBilibiliResourceIdentity(createBilibiliResourceIdentity('https://live.bilibili.com/video/12345')), true);
    assert.equal(isBilibiliResourceIdentity(createBilibiliResourceIdentity('https://m.bilibili.com/video/BV1xx411c7mD')), true);
  });

  it('rejects non-video Bilibili pages (root, subdomain, /videos, /video.html) with not-bilibili', () => {
    const nonVideo = [
      'https://www.bilibili.com/',
      'https://live.bilibili.com/12345',
      'https://www.bilibili.com/videos',
      'https://www.bilibili.com/video.html',
    ];
    for (const href of nonVideo) {
      assert.throws(
        () => createBilibiliResourceIdentity(href),
        (error: unknown) => error instanceof ResourceIdentityError && error.code === 'not-bilibili',
        `${href} must be rejected as not-bilibili`,
      );
    }
    // The site guard mirrors the constructor's video-path policy at identity level.
    assert.equal(isBilibiliResourceIdentity({ adapterId: 'bilibili', canonicalUrl: 'https://www.bilibili.com/videos' }), false);
    assert.equal(isBilibiliResourceIdentity({ adapterId: 'bilibili', canonicalUrl: 'https://www.bilibili.com/video.html' }), false);
    assert.equal(isBilibiliResourceIdentity({ adapterId: 'bilibili', canonicalUrl: 'https://live.bilibili.com/12345' }), false);
  });

  it('treats raw and normalized locations as the same identity', () => {
    const raw = createBilibiliResourceIdentity('https://www.bilibili.com/video/BV1xx411c7mD/?p=2&t=5');
    const clean = createBilibiliResourceIdentity('https://www.bilibili.com/video/BV1xx411c7mD');
    assert.equal(resourceIdentityFingerprint(raw), resourceIdentityFingerprint(clean));
    assert.equal(isResourceIdentityEqual(raw, clean), true);
    assert.equal(
      isResourceIdentityEqual(clean, {
        adapterId: 'bilibili',
        canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
        resourceId: 'BV1xx411c7mD',
      }),
      true,
    );
  });
});

describe('structural guards', () => {
  it('accept machine-produced states and intents', () => {
    const state = createInitialPlaybackState(SESSION_ID, identity, T0);
    assert.equal(isPlaybackState(state), true);
    assert.equal(isPlaybackState(applyIntent(state, makeIntent('play'), T0)), true);
    assert.equal(isPlaybackIntent(makeIntent('seek', { payload: { targetSeconds: 1 } })), true);
  });

  it('reject garbage input', () => {
    assert.equal(isPlaybackState(null), false);
    assert.equal(isPlaybackState({}), false);
    assert.equal(isPlaybackIntent({ type: 'intent', kind: 'seek' }), false);
    assert.equal(isValidResourceIdentity({ adapterId: 'bilibili', canonicalUrl: '' }), false);
  });

  it('accepts a generic identity from a future adapter', () => {
    const futureIdentity = {
      adapterId: 'youtube',
      canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      resourceId: 'dQw4w9WgXcQ',
    };
    // The shared gate is host-agnostic by design: a future adapter's identity
    // must pass even though the first release only serves Bilibili (that
    // constraint lives in isBilibiliResourceIdentity at the entrypoints).
    assert.equal(isValidResourceIdentity(futureIdentity), true);
  });
});
