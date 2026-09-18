import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionAuthority } from '../../src/server/session-authority.js';
import { SessionClient } from '../../src/client/session-client.js';
import { createBilibiliResourceIdentity } from '../../src/shared/resource.js';
import type { ActualStateReport, PlaybackState } from '../../src/shared/protocol.js';

declare global {
  interface PromiseWithResolvers<T> {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  }
  interface PromiseConstructor {
    withResolvers<T>(): PromiseWithResolvers<T>;
  }
}

const IDENTITY = createBilibiliResourceIdentity('https://www.bilibili.com/video/BV1xx411c7mD');

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const { promise: bounded, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
  promise.then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); },
  );
  return bounded;
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
}

async function startPair(): Promise<{
  authority: SessionAuthority;
  host: SessionClient;
  client: SessionClient;
}> {
  const authority = new SessionAuthority({ resourceIdentity: IDENTITY, autoAcceptJoins: true });
  const endpoint = await withTimeout(authority.start(), 5000, 'authority start');
  const url = `ws://127.0.0.1:${endpoint.port}`;
  const host = new SessionClient({ url, sessionId: endpoint.sessionId, participantId: 'host', roleHint: 'host' });
  const client = new SessionClient({ url, sessionId: endpoint.sessionId, participantId: 'client', roleHint: 'client' });
  await withTimeout(host.connect(), 5000, 'host join');
  await withTimeout(client.connect(), 5000, 'client join');
  return { authority, host, client };
}

function reportBody(
  authority: SessionAuthority,
  overrides: Partial<ActualStateReport> = {},
): Omit<ActualStateReport, 'type' | 'sessionId' | 'participantId' | 'resourceIdentity' | 'adapterId'> {
  return {
    observedRevision: authority.getState().stateRevision,
    mediaPhase: 'paused',
    positionSeconds: 0,
    positionObservedAtMs: Date.now(),
    playbackRate: 1,
    durationSeconds: null,
    applyResult: 'applied',
    ...overrides,
  };
}

test('a drifting report beyond 250ms triggers one resync revision both clients converge on', { timeout: 15000 }, async () => {
  const { authority, host, client } = await startPair();
  try {
    host.submitIntent('play');
    await waitFor(() => (authority.getState().mediaPhase === 'playing' ? authority.getState() : undefined), 5000, 'play');

    // Report a position ~5s behind the authority's projection: a correctable
    // drift that must trigger exactly one resync bump.
    client.reportActualState(reportBody(authority, { mediaPhase: 'playing', positionSeconds: 5 }));
    const resynced = await waitFor(
      () => (authority.getState().lastCommandId?.startsWith('resync:') ? authority.getState() : undefined),
      5000,
      'resync revision',
    );
    assert.equal(resynced.stateRevision, 2);
    assert.equal(resynced.mediaPhase, 'playing');

    const hostState = await waitFor(
      () => (host.state && host.state.stateRevision >= 2 ? host.state : undefined),
      5000,
      'host resync state',
    );
    const clientState = await waitFor(
      () => (client.state && client.state.stateRevision >= 2 ? client.state : undefined),
      5000,
      'client resync state',
    );
    assert.equal(hostState.lastCommandId, clientState.lastCommandId);
    assert.ok(hostState.lastCommandId?.startsWith('resync:'));
  } finally {
    await client.close();
    await host.close();
    await authority.stop();
  }
});

test('drift within the 250ms tolerance never triggers a resync', { timeout: 15000 }, async () => {
  const { authority, host, client } = await startPair();
  try {
    host.submitIntent('play');
    await waitFor(() => (authority.getState().mediaPhase === 'playing' ? authority.getState() : undefined), 5000, 'play');
    const revisionBefore = authority.getState().stateRevision;

    client.reportActualState(reportBody(authority, { mediaPhase: 'playing', positionSeconds: 0.1 }));
    // Poll past the cooldown window: no report may bump the revision.
    const deadline = Date.now() + 2300;
    while (Date.now() < deadline) {
      assert.equal(authority.getState().stateRevision, revisionBefore, 'in-tolerance drift must not resync');
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 50);
      await promise;
    }
  } finally {
    await client.close();
    await host.close();
    await authority.stop();
  }
});

// The cooldown is wall-clock based on the authority (2s), so this case needs a
// real delay: deterministic clocks cannot advance SessionAuthority's Date.now().
test('resync respects the cooldown: a second drift inside 2s does not double-bump', { timeout: 20000 }, async () => {
  const { authority, host, client } = await startPair();
  try {
    host.submitIntent('play');
    await waitFor(() => (authority.getState().mediaPhase === 'playing' ? authority.getState() : undefined), 5000, 'play');

    client.reportActualState(reportBody(authority, { mediaPhase: 'playing', positionSeconds: 5 }));
    const first = await waitFor(
      () => (authority.getState().lastCommandId?.startsWith('resync:') ? authority.getState() : undefined),
      5000,
      'first resync',
    );

    // Immediate second drift report against the NEW revision: inside the
    // cooldown, so no second bump within 700ms.
    client.reportActualState(reportBody(authority, { mediaPhase: 'playing', positionSeconds: 5 }));
    {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 700);
      await promise;
      assert.equal(authority.getState().stateRevision, first.stateRevision, 'cooldown must suppress the second resync');
    }

    // After the cooldown, a fresh drifting report triggers again. The 2s wait
    // is deliberate: the cooldown is wall-clock based inside SessionAuthority.
    {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 2100);
      await promise;
    }
    client.reportActualState(reportBody(authority, { mediaPhase: 'playing', positionSeconds: 5 }));
    const second = await waitFor(
      () => (authority.getState().stateRevision > first.stateRevision ? authority.getState() : undefined),
      5000,
      'second resync after cooldown',
    );
    assert.ok(second.lastCommandId?.startsWith('resync:'));
  } finally {
    await client.close();
    await host.close();
    await authority.stop();
  }
});

test('a phase-identical intent does not bump the revision', { timeout: 15000 }, async () => {
  const { authority, host, client } = await startPair();
  try {
    host.submitIntent('play');
    await waitFor(() => (authority.getState().mediaPhase === 'playing' ? authority.getState() : undefined), 5000, 'play');
    const revisionBefore = authority.getState().stateRevision;

    // An echo/duplicate play on an already-playing session: acknowledged, no resync.
    client.submitIntent('play');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    assert.equal(authority.getState().stateRevision, revisionBefore);
    assert.equal(authority.getState().mediaPhase, 'playing');
  } finally {
    await client.close();
    await host.close();
    await authority.stop();
  }
});
