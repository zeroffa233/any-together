import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionAuthority } from '../../src/server/session-authority.js';
import { SessionClient } from '../../src/client/session-client.js';
import type { PlaybackState, SyncItemDefinition, ServerMessage } from '../../src/shared/protocol.js';

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

const DEFINITIONS: SyncItemDefinition[] = [
  { key: 'pdf.scroll', semantic: 'scalar', convergence: 'shared', min: 0, max: 1, tolerance: 0.002 },
  { key: 'pdf.zoom', semantic: 'scalar', convergence: 'shared', min: 0.25, max: 4, tolerance: 0.01 },
];

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const { promise: bounded, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
  promise.then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); },
  );
  return bounded;
}

async function waitForState(client: SessionClient, predicate: (state: PlaybackState) => boolean): Promise<PlaybackState> {
  if (client.state && predicate(client.state)) return client.state;
  const { promise, resolve } = Promise.withResolvers<PlaybackState>();
  const unsubscribe = client.onState((state) => {
    if (!predicate(state)) return;
    unsubscribe();
    resolve(state);
  });
  return withTimeout(promise, 5000, 'scalar state');
}

async function startPair(): Promise<{ authority: SessionAuthority; host: SessionClient; client: SessionClient }> {
  const authority = new SessionAuthority({ autoAcceptJoins: true });
  const endpoint = await authority.start();
  const url = `ws://127.0.0.1:${endpoint.port}`;
  const host = new SessionClient({ url, sessionId: endpoint.sessionId, participantId: 'host', roleHint: 'host' });
  const client = new SessionClient({ url, sessionId: endpoint.sessionId, participantId: 'client', roleHint: 'client' });
  await withTimeout(host.connect(), 5000, 'host join');
  await withTimeout(client.connect(), 5000, 'client join');
  return { authority, host, client };
}

test('host binds PDF scalar items and both real websocket clients converge on scalar intents', { timeout: 15000 }, async () => {
  const { authority, host, client } = await startPair();
  try {
    host.sendSyncItemBind(DEFINITIONS, { 'pdf.scroll': 0, 'pdf.zoom': 1 });
    await waitForState(client, (state) => state.syncItems?.['pdf.scroll'] === 0);
    assert.deepEqual(client.state?.syncItemDefinitions, DEFINITIONS);

    const commandId = client.submitSyncItemIntent('pdf.scroll', 0.75, 'scroll-command');
    assert.equal(commandId, 'scroll-command');
    const nextHost = await waitForState(host, (state) => state.syncItems?.['pdf.scroll'] === 0.75);
    const nextClient = await waitForState(client, (state) => state.syncItems?.['pdf.scroll'] === 0.75);
    assert.equal(nextHost.stateRevision, nextClient.stateRevision);
    assert.equal(nextHost.lastCommandId, 'scroll-command');

    client.submitSyncItemIntent('pdf.scroll', 0.75, 'scroll-command');
    await waitForState(host, (state) => state.stateRevision === nextHost.stateRevision);
    assert.equal(authority.getState().stateRevision, nextHost.stateRevision);
  } finally {
    await client.close();
    await host.close();
    await authority.stop();
  }
});

test('client cannot replace the host-bound scalar schema', { timeout: 15000 }, async () => {
  const { authority, host, client } = await startPair();
  const errors: ServerMessage[] = [];
  client.onDiagnostic((message) => errors.push(message));
  try {
    host.sendSyncItemBind(DEFINITIONS, { 'pdf.scroll': 0, 'pdf.zoom': 1 });
    await waitForState(client, (state) => state.syncItems?.['pdf.zoom'] === 1);
    client.sendSyncItemBind(DEFINITIONS, { 'pdf.scroll': 0.8, 'pdf.zoom': 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(authority.getState().syncItems?.['pdf.scroll'], 0);
    assert.equal(errors.some((message) => message.type === 'error' && message.code === 'not-host'), true);
  } finally {
    await client.close();
    await host.close();
    await authority.stop();
  }
});
