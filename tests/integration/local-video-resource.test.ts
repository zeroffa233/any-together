/**
 * Integration coverage for the local-video RESOURCE IDENTITY layer: a shared
 * local file's token URL becomes a canonical `local-video` ResourceIdentity
 * that flows through the real authority exactly like any other adapter's.
 *
 * Every case spins up a REAL LocalMediaServer (temp file, ephemeral port) and
 * a REAL SessionAuthority with REAL SessionClient instances over real
 * TCP/WebSocket transport; nothing is faked. Each case has an explicit
 * node:test timeout, bounded `withTimeout`/polling waits, and `t.after`
 * cleanup (temp dirs, media servers, authorities, sockets — node:test's
 * finally runs even when the body fails).
 *
 * Covered scenarios:
 *   1. createLocalVideoResourceIdentity canonicalizes a share URL into a
 *      local-video identity: adapterId 'local-video', canonicalUrl = the
 *      FULL token URL (query/hash dropped, token kept in the path), the
 *      decoded basename preserved as resourceId, and the identity passes the
 *      shared core's isValidResourceIdentity guard; foreign/malformed URLs
 *      are rejected with stable LocalVideoIdentityError codes. The identity
 *      URL is also verified to be the LIVE serving URL (HTTP 200).
 *   2. a host join carrying a local-video identity binds an UNBOUND session
 *      (join-accepted state carries the identity, revision stays 0); an
 *      identity-less client join adopts the canonical identity and both
 *      endpoints reporting against it opens the readiness gate — proving the
 *      pushed identity is actually usable.
 *   3. resource-bind switches the session between two distinct local shares:
 *      revision/sequence bump, phase/playhead reset, BOTH participants
 *      observe the identical switched state, the authority adopts it; a
 *      same-identity re-bind is a no-op (no extra broadcast), and a
 *      subsequent seek still applies cleanly.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { SessionAuthority } from '../../src/server/session-authority.js';
import { SessionClient } from '../../src/client/session-client.js';
import { LocalMediaServer } from '../../src/server/local-media-server.js';
import type { LocalShare } from '../../src/server/local-media-server.js';
import {
  createLocalVideoResourceIdentity,
  isLocalVideoUrl,
  LOCAL_VIDEO_ADAPTER_ID,
  LocalVideoIdentityError,
} from '../../src/shared/local-resource.js';
import { isValidResourceIdentity } from '../../src/shared/protocol.js';
import type {
  ActualStateReport,
  IntentKind,
  PlaybackIntent,
  PlaybackState,
  ResourceIdentity,
  ServerMessage,
  SessionStatusMessage,
} from '../../src/shared/protocol.js';

// tsconfig targets ES2022, which does not include Promise.withResolvers (ES2024).
// Node >= 22 provides it at runtime; this keeps the type available without a lib bump.
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

type JoinAccepted = Extract<ServerMessage, { type: 'join-accepted' }>;
/** Actual-state report fields a client fills in itself (identity comes from the session). */
type ActualStateBody = Omit<ActualStateReport, 'type' | 'sessionId' | 'participantId' | 'resourceIdentity' | 'adapterId'>;

const HOST = 'host-p';
const CLIENT = 'client-p';

// ---------------------------------------------------------------------------
// Helpers: bounded waits and guaranteed cleanup
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const { promise: bounded, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(
    () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`)),
    timeoutMs,
  );
  promise.then(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error) => {
      clearTimeout(timer);
      reject(error);
    },
  );
  return bounded;
}

/**
 * Poll a probe until it returns a value; every wait is bounded. The probe is
 * re-evaluated every 10ms and the poll exits the moment the condition holds.
 */
async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
}

/** Temp video file with guaranteed cleanup; the extension drives Content-Type. */
async function makeVideoFile(
  t: TestContext,
  name: string,
  size = 4096,
): Promise<{ dir: string; filePath: string; bytes: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), 'any-together-local-video-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const filePath = join(dir, name);
  const bytes = Buffer.alloc(size, 0x5a);
  await writeFile(filePath, bytes);
  return { dir, filePath, bytes };
}

/** Loopback-bound media share with guaranteed stop. */
async function startLocalShare(t: TestContext, filePath: string): Promise<LocalShare> {
  const server = new LocalMediaServer({ filePath, host: '127.0.0.1' });
  const share = await server.start();
  t.after(async () => {
    await server.stop().catch(() => {});
  });
  return share;
}

async function startAuthority(
  options: { resourceIdentity?: ResourceIdentity } = {},
): Promise<{ authority: SessionAuthority; url: string; sessionId: string }> {
  const authority = new SessionAuthority({
    autoAcceptJoins: true,
    ...(options.resourceIdentity === undefined ? {} : { resourceIdentity: options.resourceIdentity }),
  });
  const endpoint = await withTimeout(authority.start(), 5000, 'authority start');
  return { authority, url: `ws://127.0.0.1:${endpoint.port}`, sessionId: endpoint.sessionId };
}

async function stopAuthority(authority: SessionAuthority): Promise<void> {
  await withTimeout(authority.stop(), 3000, 'authority stop').catch(() => {});
}

// ---------------------------------------------------------------------------
// Harness: real SessionClient plus observable message capture
// ---------------------------------------------------------------------------

class Harness {
  readonly client: SessionClient;
  readonly participantId: string;
  readonly states: PlaybackState[] = [];
  readonly diagnostics: ServerMessage[] = [];
  readonly statuses: SessionStatusMessage[] = [];

  constructor(
    url: string,
    sessionId: string,
    participantId: string,
    resourceIdentity?: ResourceIdentity,
    roleHint?: 'host' | 'client',
  ) {
    this.participantId = participantId;
    this.client = new SessionClient({
      url,
      sessionId,
      participantId,
      ...(resourceIdentity === undefined ? {} : { resourceIdentity }),
      ...(roleHint === undefined ? {} : { roleHint }),
    });
    this.client.onState((state) => this.states.push(state));
    this.client.onDiagnostic((message) => this.diagnostics.push(message));
    this.client.onSessionStatus((status) => this.statuses.push(status));
  }

  async connect(timeoutMs = 5000): Promise<JoinAccepted> {
    return withTimeout(this.client.connect(), timeoutMs, `join of ${this.participantId}`);
  }

  async close(timeoutMs = 3000): Promise<void> {
    await withTimeout(this.client.close(), timeoutMs, `close of ${this.participantId}`).catch(() => {});
  }

  submit(kind: IntentKind, payload?: PlaybackIntent['payload']): string {
    return this.client.submitIntent(kind, payload);
  }

  bind(resourceIdentity: ResourceIdentity): void {
    this.client.sendResourceBind(resourceIdentity);
  }

  /**
   * Report the actual state that exactly matches the latest authoritative
   * state this client observed, so the report evaluates as consistent.
   */
  reportConsistent(overrides: Partial<ActualStateBody> = {}): void {
    const latest = this.latest;
    const now = Date.now();
    const projected = latest.mediaPhase === 'playing'
      ? latest.positionSeconds + ((now - latest.positionAtMs) / 1000) * latest.playbackRate
      : latest.positionSeconds;
    this.client.reportActualState({
      observedRevision: overrides.observedRevision ?? latest.stateRevision,
      mediaPhase: overrides.mediaPhase ?? latest.mediaPhase,
      positionSeconds: overrides.positionSeconds ?? projected,
      positionObservedAtMs: overrides.positionObservedAtMs ?? now,
      playbackRate: overrides.playbackRate ?? latest.playbackRate,
      durationSeconds: overrides.durationSeconds ?? latest.durationSeconds,
      applyResult: overrides.applyResult ?? 'applied',
    });
  }

  async waitForRevision(revision: number, timeoutMs = 5000): Promise<PlaybackState> {
    return withTimeout(
      this.client.waitForRevision(revision, timeoutMs),
      timeoutMs + 1000,
      `revision ${revision} on ${this.participantId}`,
    );
  }

  async waitForStatus(predicate: (status: SessionStatusMessage) => boolean, timeoutMs = 5000): Promise<SessionStatusMessage> {
    return waitFor(
      () => this.statuses.find(predicate),
      timeoutMs,
      `session-status on ${this.participantId}`,
    );
  }

  get latest(): PlaybackState {
    const latest = this.states[this.states.length - 1];
    if (latest === undefined) throw new Error(`No state observed on ${this.participantId}`);
    return latest;
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

test('createLocalVideoResourceIdentity canonicalizes a share URL into a local-video identity that is the live serving URL', { timeout: 15000 }, async (t) => {
  const { filePath, bytes } = await makeVideoFile(t, '我的 movie.mp4');
  const share = await startLocalShare(t, filePath);

  assert.ok(isLocalVideoUrl(share.url), 'the share URL must be recognized as a local-video URL');
  const identity = createLocalVideoResourceIdentity(share.url);
  assert.equal(identity.adapterId, LOCAL_VIDEO_ADAPTER_ID, 'the identity must carry the local-video adapter id');
  assert.equal(identity.canonicalUrl, share.url, 'the canonical URL must be the FULL token URL (token in the path)');
  assert.equal(identity.resourceId, basename(filePath), 'the decoded basename must be preserved as resourceId');
  assert.ok(isValidResourceIdentity(identity), 'the identity must pass the shared core validity guard');

  // Query/hash are dropped by canonicalization while the path token survives,
  // so a decorated URL maps to the SAME identity.
  const decorated = createLocalVideoResourceIdentity(`${share.url}?t=123#frag`);
  assert.deepEqual(decorated, identity, 'query/hash must be dropped while the path token is preserved');

  // The identity URL is the LIVE serving URL, not a display-only string.
  const response = await fetch(share.url, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, 'the identity URL must serve the shared file');
  assert.equal((await response.arrayBuffer()).byteLength, bytes.length, 'the identity URL must stream the shared file bytes');

  // Foreign and malformed URLs are rejected with stable error codes.
  assert.throws(
    () => createLocalVideoResourceIdentity('https://www.bilibili.com/video/BV1xx411c7mD'),
    (error) => error instanceof LocalVideoIdentityError && error.code === 'not-local-video',
    'a foreign site URL must be rejected as not-local-video',
  );
  assert.throws(
    () => createLocalVideoResourceIdentity('https://example.com/local/tok/video/x.mp4'),
    (error) => error instanceof LocalVideoIdentityError && error.code === 'not-local-video',
    'a domain-host URL must be rejected as not-local-video',
  );
  assert.throws(
    () => createLocalVideoResourceIdentity('not a url'),
    (error) => error instanceof LocalVideoIdentityError && error.code === 'invalid-url',
    'an unparseable URL must be rejected as invalid-url',
  );
  assert.equal(isLocalVideoUrl('https://example.com/local/tok/video/x.mp4'), false, 'a domain-host URL must not pass the guard');
});

test('a host join carrying a local-video identity binds the unbound session; an identity-less client adopts and reports against it', { timeout: 15000 }, async (t) => {
  const { filePath } = await makeVideoFile(t, 'movie.mp4');
  const share = await startLocalShare(t, filePath);
  const identity = createLocalVideoResourceIdentity(share.url);

  const { authority, url, sessionId } = await startAuthority();
  const host = new Harness(url, sessionId, HOST, identity, 'host');
  const client = new Harness(url, sessionId, CLIENT, undefined, 'client');
  t.after(async () => {
    await client.close();
    await host.close();
    await stopAuthority(authority);
  });

  // The first host join carries its local-video identity: the session binds
  // on join and the host receives the adopted state in join-accepted.
  const hostJoin = await host.connect();
  assert.equal(hostJoin.role, 'host', 'the host joiner must be granted the host role');
  assert.deepEqual(hostJoin.state.resourceIdentity, identity, 'a host join carrying a local-video identity must bind the unbound session');
  assert.equal(hostJoin.state.stateRevision, 0, 'binding on the first join must not bump the revision');
  assert.equal(hostJoin.state.mediaPhase, 'ready', 'the adopted state must be a fresh ready state');
  assert.deepEqual(authority.getState().resourceIdentity, identity, 'the authority must adopt the joined identity');

  // The client knows nothing about the resource: join-accepted must push the
  // canonical identity, not the client's own (it has none).
  const clientJoin = await client.connect();
  assert.equal(clientJoin.role, 'client', 'the second joiner with roleHint client must be granted the client role');
  assert.deepEqual(clientJoin.state.resourceIdentity, identity, 'an identity-less joiner must receive the canonical session identity');
  assert.deepEqual(client.latest.resourceIdentity, identity, 'the client must adopt the canonical identity as its reference');

  // The pushed identity is actually usable: consistent reports from both
  // endpoints open the readiness gate.
  host.reportConsistent();
  client.reportConsistent();
  const ready = await host.waitForStatus((status) => status.ready, 3000);
  const clientEntry = ready.participants.find((participant) => participant.participantId === CLIENT);
  assert.ok(clientEntry, 'the identity-less client must appear in the ready status');
  assert.equal(clientEntry.reported, true, 'the identity-less client must have reported');
  assert.equal(clientEntry.consistent, true, 'the identity-less client must be consistent against the local-video identity');
});

test('resource-bind switches the session to a second local share; both participants follow and a same-identity re-bind is a no-op', { timeout: 15000 }, async (t) => {
  const { filePath: firstPath } = await makeVideoFile(t, 'first.mp4', 2048);
  const { filePath: secondPath } = await makeVideoFile(t, 'second.mp4', 4096);
  const first = await startLocalShare(t, firstPath);
  const second = await startLocalShare(t, secondPath);
  const firstIdentity = createLocalVideoResourceIdentity(first.url);
  const secondIdentity = createLocalVideoResourceIdentity(second.url);
  assert.notDeepEqual(firstIdentity, secondIdentity, 'two shares must produce distinct identities');

  const { authority, url, sessionId } = await startAuthority({ resourceIdentity: firstIdentity });
  const host = new Harness(url, sessionId, HOST, firstIdentity, 'host');
  const client = new Harness(url, sessionId, CLIENT, undefined, 'client');
  t.after(async () => {
    await client.close();
    await host.close();
    await stopAuthority(authority);
  });

  await host.connect();
  assert.deepEqual(host.latest.resourceIdentity, firstIdentity, 'the pre-configured local-video identity must bind the session');
  await client.connect();
  assert.deepEqual(client.latest.resourceIdentity, firstIdentity, 'the identity-less client adopts the initial local share');

  // The host switches to a SECOND local share.
  host.bind(secondIdentity);
  const boundHost = await host.waitForRevision(1);
  const boundClient = await client.waitForRevision(1);
  assert.deepEqual(boundHost.resourceIdentity, secondIdentity, 'the host must receive the switched identity');
  assert.deepEqual(boundClient.resourceIdentity, secondIdentity, 'the identity-less client must follow the switched identity');
  assert.equal(boundHost.stateRevision, 1, 'the bind must bump the revision');
  assert.equal(boundHost.mediaPhase, 'ready', 'the bind must reset the phase to ready');
  assert.equal(boundHost.positionSeconds, 0, 'the bind must reset the playhead to 0');
  assert.deepEqual(boundHost, boundClient, 'both participants must observe the identical switched state');
  assert.deepEqual(authority.getState().resourceIdentity, secondIdentity, 'the authority must adopt the switched identity');
  assert.equal(authority.getState().stateRevision, 1, 'the authority must hold the bumped revision');

  // The client re-binds the identity the session ALREADY holds: idempotent
  // no-op. The seek that follows travels on the SAME socket immediately after
  // the duplicate bind, so the authority processes it in order: when revision
  // 2 is observed, any (buggy) broadcast from the duplicate bind would have
  // arrived before it and must already be in the captured state arrays.
  client.bind(secondIdentity);
  client.submit('seek', { targetSeconds: 10 });
  await host.waitForRevision(2);
  await client.waitForRevision(2);
  assert.equal(host.states.length, 3, `the duplicate bind must broadcast nothing: ${host.states.map((state) => `rev${state.stateRevision}`).join(' -> ')}`);
  assert.equal(client.states.length, 3, 'the duplicate bind must not reach the other participant either');
  assert.deepEqual(host.latest.resourceIdentity, secondIdentity, 'the duplicate bind must not change the bound identity');
  assert.equal(host.latest.stateRevision, 2, 'the seek must apply on top of the switched identity');
  assert.equal(host.latest.positionSeconds, 10, 'the seek must move the playhead of the switched identity');
  assert.deepEqual(authority.getState().resourceIdentity, secondIdentity, 'the authority must stay bound to the second share');
  assert.equal(authority.getState().stateRevision, 2, 'the authority must not bump on a duplicate bind');
});
