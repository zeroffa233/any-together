import {
  isSyncItemDefinitions,
  isSyncItemValues,
  type PlaybackState,
  type SyncItemDefinition,
  type SyncItemIntent,
  type SyncItemValues,
} from '../shared/protocol.js';

export class SyncItemTransitionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SyncItemTransitionError';
  }
}

function assertClock(nowMs: number): void {
  if (!Number.isFinite(nowMs)) throw new SyncItemTransitionError('invalid-clock', 'Clock must be finite');
}

function cloneValues(values: SyncItemValues): SyncItemValues {
  return { ...values };
}

export function syncItemDefinitionsEqual(
  left: readonly SyncItemDefinition[] | undefined,
  right: readonly SyncItemDefinition[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  return left.every((definition, index) => {
    const other = right[index];
    return other !== undefined
      && definition.key === other.key
      && definition.semantic === other.semantic
      && definition.convergence === other.convergence
      && definition.min === other.min
      && definition.max === other.max
      && definition.tolerance === other.tolerance;
  });
}

export function syncItemValuesEqual(left: SyncItemValues | undefined, right: SyncItemValues | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

export function applySyncItemBinding(
  state: PlaybackState,
  definitions: readonly SyncItemDefinition[],
  values: SyncItemValues,
  nowMs = Date.now(),
): PlaybackState {
  assertClock(nowMs);
  if (!isSyncItemDefinitions([...definitions]) || definitions.length === 0) {
    throw new SyncItemTransitionError('invalid-sync-items', 'At least one valid sync item definition is required');
  }
  if (!isSyncItemValues(values)) {
    throw new SyncItemTransitionError('invalid-sync-items', 'Sync item values must be finite numbers');
  }
  const keys = new Set(definitions.map((definition) => definition.key));
  if (definitions.some((definition) => !Object.prototype.hasOwnProperty.call(values, definition.key))) {
    throw new SyncItemTransitionError('invalid-sync-items', 'Every sync item definition requires an initial value');
  }
  if (Object.keys(values).some((key) => !keys.has(key))) {
    throw new SyncItemTransitionError('invalid-sync-items', 'Sync item values must match their definitions');
  }
  return {
    ...state,
    stateRevision: state.stateRevision + 1,
    lastSequence: state.lastSequence + 1,
    lastCommandId: null,
    updatedAtMs: nowMs,
    syncItemDefinitions: definitions.map((definition) => ({ ...definition })),
    syncItems: cloneValues(values),
  };
}

export function applySyncItemIntent(
  state: PlaybackState,
  intent: SyncItemIntent,
  nowMs = Date.now(),
): PlaybackState {
  assertClock(nowMs);
  const definitions = state.syncItemDefinitions ?? [];
  const definition = definitions.find((candidate) => candidate.key === intent.key);
  if (definition === undefined || state.syncItems === undefined) {
    throw new SyncItemTransitionError('unknown-sync-item', `Unknown sync item '${intent.key}'`);
  }
  if (intent.value < definition.min || intent.value > definition.max) {
    throw new SyncItemTransitionError(
      'invalid-sync-value',
      `Value for '${intent.key}' must be between ${definition.min} and ${definition.max}`,
    );
  }
  if (state.syncItems[intent.key] === intent.value) return state;
  return {
    ...state,
    stateRevision: state.stateRevision + 1,
    lastSequence: state.lastSequence + 1,
    lastCommandId: intent.commandId,
    updatedAtMs: nowMs,
    syncItems: {
      ...state.syncItems,
      [intent.key]: intent.value,
    },
  };
}
