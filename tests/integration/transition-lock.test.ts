import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionAuthority } from '../../src/server/session-authority.js';
import { SessionClient } from '../../src/client/session-client.js';
import { createBilibiliResourceIdentity } from '../../src/shared/resource.js';
import type { PlaybackState } from '../../src/shared/protocol.js';

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

const BV1 = createBilibiliResourceIdentity('https://www.bilibili.com/video/BV1xx411c7mD');
const BV2 = createBilibiliResourceIdentity('https://www.bilibili.com/video/BV1zz441c8nF');
const BV3 = createBilibiliResourceIdentity('https://www.bilibili.com/video/BV3yy553d9pQ');

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

/** Wait until the authority's state revision is strictly greater than `after`. */
async function waitForStateBeyond(
  client: SessionClient,
  after: number,
  label: string,
): Promise<PlaybackState> {
  return waitFor(
    () => (client.state && client.state.stateRevision > after ? client.state : undefined),
    5000,
    label,
  );
}

async function startPair(): Promise<{
  authority: SessionAuthority;
  host: SessionClient;
  client: SessionClient;
}> {
  const authority = new SessionAuthority({ autoAcceptJoins: true });
  const endpoint = await authority.start();
  const url = `ws://127.0.0.1:${endpoint.port}`;
  const host = new SessionClient({ url, sessionId: endpoint.sessionId, participantId: 'host', roleHint: 'host' });
  const client = new SessionClient({ url, sessionId: endpoint.sessionId, participantId: 'client', roleHint: 'client' });
  await withTimeout(host.connect(), 5000, 'host join');
  await withTimeout(client.connect(), 5000, 'client join');
  return { authority, host, client };
}

test('a bind during an unconfirmed transition is ignored until both endpoints report the target', { timeout: 20000 }, async () => {
  const { authority, host, client } = await startPair();
  try {
    // First switch: accepted, transitions the session and locks it.
    host.sendResourceBind(BV2);
    const afterFirst = await waitForStateBeyond(client, 0, 'first bind');
    assert.deepEqual(afterFirst.resourceIdentity, BV2);
    assert.equal(afterFirst.mediaPhase, 'ready');

    // A second DIFFERENT bind while no endpoint has confirmed BV2: ignored.
    client.sendResourceBind(BV3);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    assert.equal(authority.getState().stateRevision, afterFirst.stateRevision, 'the locked bind must not bump');
    assert.deepEqual(authority.getState().resourceIdentity, BV2, 'the locked bind must not switch');

    // Both endpoints report the TARGET identity: the lock releases.
    const body = {
      observedRevision: authority.getState().stateRevision,
      mediaPhase: 'paused',
      positionSeconds: 0,
      positionObservedAtMs: Date.now(),
      playbackRate: 1,
      durationSeconds: null,
      applyResult: 'applied',
    } as const;
    host.reportActualState(body);
    client.reportActualState(body);

    // Confirmation starts the 1.5s post-switch grace window (wall-clock based
    // in the authority); wait it out before the next switch is accepted.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 1600);
    await promise;

    // Now a new switch is accepted again.
    client.sendResourceBind(BV3);
    const afterUnlock = await waitForStateBeyond(client, afterFirst.stateRevision, 'post-unlock bind');
    assert.deepEqual(afterUnlock.resourceIdentity, BV3);
  } finally {
    await client.close();
    await host.close();
    await authority.stop();
  }
});

// The transition timeout is wall-clock based inside SessionAuthority (5s), so
// this case needs a real delay: deterministic clocks cannot advance Date.now().
test('the transition lock expires after 5s so a page that never loads cannot deadlock switches', { timeout: 20000 }, async () => {
  const { authority, host, client } = await startPair();
  try {
    host.sendResourceBind(BV2);
    await waitForStateBeyond(client, 0, 'first bind');

    // No endpoint confirms BV2. After the 5s timeout the lock must expire and
    // a fresh switch must be accepted again.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5200);
    await promise;

    client.sendResourceBind(BV3);
    const after = await waitForStateBeyond(client, 1, 'post-timeout bind');
    assert.deepEqual(after.resourceIdentity, BV3);
  } finally {
    await client.close();
    await host.close();
    await authority.stop();
  }
});

test('an identical bind during the transition stays an idempotent no-op', { timeout: 15000 }, async () => {
  const { authority, host, client } = await startPair();
  try {
    host.sendResourceBind(BV2);
    const afterFirst = await waitForStateBeyond(client, 0, 'first bind');
    const revision = afterFirst.stateRevision;

    // The follower's own content-ready re-binds the same identity: no-op.
    client.sendResourceBind(BV2);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.equal(authority.getState().stateRevision, revision);
    assert.deepEqual(authority.getState().resourceIdentity, BV2);
  } finally {
    await client.close();
    await host.close();
    await authority.stop();
  }
});

// The grace window (1.5s) starts when BOTH endpoints confirm the target, so
// this case needs real wall-clock time around the confirmation.
test('after a confirmed switch, a late old-resource echo inside the grace is absorbed', { timeout: 20000 }, async () => {
  const { authority, host, client } = await startPair();
  try {
    host.sendResourceBind(BV2);
    const afterFirst = await waitForStateBeyond(client, 0, 'first bind');

    // Both confirm BV2: the lock releases into the 1.5s grace window.
    const body = {
      observedRevision: authority.getState().stateRevision,
      mediaPhase: 'paused',
      positionSeconds: 0,
      positionObservedAtMs: Date.now(),
      playbackRate: 1,
      durationSeconds: null,
      applyResult: 'applied',
    } as const;
    host.reportActualState(body);
    client.reportActualState(body);
    await waitFor(
      () => (authority.getState().stateRevision === afterFirst.stateRevision ? true : undefined),
      3000,
      'confirmation',
    ).catch(() => {});

    // Late echo of the OLD resource (BV1) right after confirmation: absorbed.
    host.sendResourceBind(BV1);
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    assert.equal(authority.getState().stateRevision, afterFirst.stateRevision, 'grace must absorb the late echo');
    assert.deepEqual(authority.getState().resourceIdentity, BV2);

    // After the grace expires, a genuine switch is accepted again.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 1600);
    await promise;
    client.sendResourceBind(BV3);
    const after = await waitForStateBeyond(client, afterFirst.stateRevision, 'post-grace bind');
    assert.deepEqual(after.resourceIdentity, BV3);
  } finally {
    await client.close();
    await host.close();
    await authority.stop();
  }
});
