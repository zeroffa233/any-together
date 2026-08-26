import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applySyncItemBinding, applySyncItemIntent, SyncItemTransitionError } from '../../src/core/sync-items.js';
import { createInitialPlaybackState } from '../../src/core/playback-state.js';
import { createBilibiliResourceIdentity } from '../../src/shared/resource.js';
import type { SyncItemDefinition, SyncItemIntent } from '../../src/shared/protocol.js';

const T0 = 1_000_000;
const identity = createBilibiliResourceIdentity('https://www.bilibili.com/video/BV1xx411c7mD');
const definitions: SyncItemDefinition[] = [
  { key: 'pdf.scroll', semantic: 'scalar', convergence: 'shared', min: 0, max: 1, tolerance: 0.002 },
  { key: 'pdf.zoom', semantic: 'scalar', convergence: 'shared', min: 0.25, max: 4, tolerance: 0.01 },
];

function state() {
  return createInitialPlaybackState('session-1', identity, T0);
}

function intent(key: string, value: number, commandId = `cmd-${key}`): SyncItemIntent {
  return {
    type: 'sync-item-intent',
    commandId,
    sessionId: 'session-1',
    participantId: 'participant-1',
    clientObservedRevision: 0,
    key,
    value,
    createdAtMs: T0,
  };
}

test('binds PDF scalar definitions and initial values as one authoritative revision', () => {
  const bound = applySyncItemBinding(state(), definitions, { 'pdf.scroll': 0.25, 'pdf.zoom': 1 }, T0 + 10);
  assert.equal(bound.stateRevision, 1);
  assert.equal(bound.lastSequence, 1);
  assert.deepEqual(bound.syncItemDefinitions, definitions);
  assert.deepEqual(bound.syncItems, { 'pdf.scroll': 0.25, 'pdf.zoom': 1 });
});

test('applies a scalar intent without changing media playback fields', () => {
  const bound = applySyncItemBinding(state(), definitions, { 'pdf.scroll': 0, 'pdf.zoom': 1 }, T0);
  const next = applySyncItemIntent(bound, intent('pdf.scroll', 0.75), T0 + 100);
  assert.equal(next.stateRevision, 2);
  assert.equal(next.lastCommandId, 'cmd-pdf.scroll');
  assert.equal(next.mediaPhase, bound.mediaPhase);
  assert.equal(next.positionSeconds, bound.positionSeconds);
  assert.equal(next.syncItems?.['pdf.scroll'], 0.75);
});

test('reapplying the same scalar value is an idempotent no-op', () => {
  const bound = applySyncItemBinding(state(), definitions, { 'pdf.scroll': 0.5, 'pdf.zoom': 1 }, T0);
  const next = applySyncItemIntent(bound, intent('pdf.scroll', 0.5), T0 + 100);
  assert.equal(next, bound);
});

test('rejects unknown and out-of-range scalar values explicitly', () => {
  const bound = applySyncItemBinding(state(), definitions, { 'pdf.scroll': 0, 'pdf.zoom': 1 }, T0);
  assert.throws(
    () => applySyncItemIntent(bound, intent('pdf.page', 2), T0),
    (error: unknown) => error instanceof SyncItemTransitionError && error.code === 'unknown-sync-item',
  );
  assert.throws(
    () => applySyncItemIntent(bound, intent('pdf.scroll', 2), T0),
    (error: unknown) => error instanceof SyncItemTransitionError && error.code === 'invalid-sync-value',
  );
});
