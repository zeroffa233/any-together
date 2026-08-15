/**
 * Integration tests for the dynamic-resource lifecycle introduced with nullable
 * resource identity: sessions that start WITHOUT a pre-configured URL, bind
 * dynamically on the first host join or via host `resource-bind`, switch
 * resources mid-session, and isolate actual-state reports bound to the old
 * resource. Also covers the default adapter registry's routing rules.
 *
 * Every case spins up a real SessionAuthority (ephemeral port) and connects
 * real SessionClient instances over real TCP/WebSocket transport; nothing uses
 * an in-memory fake. Each case has an explicit node:test timeout, bounded
 * `withTimeout` wrappers, and `t.after` cleanup (node:test's finally — it runs
 * even when the body fails) so authorities and sockets never leak. Waits are
 * condition-driven polls that exit the moment the signal arrives; no
 * fixed-duration sleeps are used. Deterministic time control cannot replace
 * these waits: the signals arrive over real TCP/WebSocket I/O that only the
 * platform clock can make observable, so each wait polls until its condition
 * holds instead of guessing a latency.
 *
 * Covered scenarios (6):
 *   1. authority started without a resource stays unbound (resourceIdentity
 *      null on the wire); playback intents are rejected with 'resource-unbound'
 *      and the state is untouched; the host then binds via `resource-bind`
 *      (revision/sequence bump to 1, phase ready, position 0, identity adopted)
 *   2. a host join carrying a Bilibili identity + roleHint host binds the
 *      unbound session (no revision bump); an identity-less client join with
 *      roleHint client adopts the canonical identity via join-accepted and can
 *      report against it, turning the session ready
 *   3. a host resource-bind switches to a second Bilibili identity: revision/
 *      sequence bump past prior intents, playhead reset to 0, phase ready,
 *      duration dropped, lastCommandId cleared; BOTH participants receive the
 *      identical switched state (the identity-less client follows the bind)
 *   4. reports bound to the old resource are isolated after a bind: a stale
 *      pre-bind report (old revision + old identity) and an old-identity
 *      report at the new revision can neither promote a phase nor close the
 *      readiness gate (actual-state-mismatch diagnostics instead); the session
 *      turns ready only after both participants report against the new
 *      resource
 *   5. createDefaultAdapterRegistry: resolves the bilibili.com apex, any
 *      subdomain, and instantiates via resolveAdapter; unknown, non-http(s)
 *      and unparseable URLs resolve to undefined; a second registration for
 *      the same domain throws AdapterRegistryError 'duplicate-domain' (after
 *      normalization) without leaving partial state
 *   6. a CLIENT-initiated resource-bind: any joined participant may switch
 *      the session media, not just the host. The identity-less client binds
 *      BV2 over an actively playing session: both endpoints observe the
 *      identical reset state (revision/sequence bump, phase ready, playhead
 *      0) and can report against the NEW identity to open the readiness
 *      gate; an old-identity report at the new revision can neither promote
 *      a phase nor move the playhead and is diagnosed as a mismatch
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionAuthority } from '../../src/server/session-authority.js';
import { SessionClient } from '../../src/client/session-client.js';
import { createBilibiliResourceIdentity } from '../../src/shared/resource.js';
import { AdapterRegistryError, createDefaultAdapterRegistry } from '../../src/adapters/adapter-registry.js';
import { BilibiliAdapter } from '../../src/adapters/bilibili-adapter.js';
import type {
  ActualStateReport,
  ErrorMessage,
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
type Diagnostic = Extract<ServerMessage, { type: 'diagnostic' }>;
/** Actual-state report fields a client fills in itself (identity comes from the session). */
type ActualStateBody = Omit<ActualStateReport, 'type' | 'sessionId' | 'participantId' | 'resourceIdentity' | 'adapterId'>;

const RESOURCE_BV1 = createBilibiliResourceIdentity('https://www.bilibili.com/video/BV1xx411c7mD');
const RESOURCE_BV2 = createBilibiliResourceIdentity('https://www.bilibili.com/video/BV1zz441c8nF');
const HOST = 'host-p';
const CLIENT = 'client-p';

// ---------------------------------------------------------------------------
// Helpers: bounded waits and cleanup guarantees
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
 * Poll a probe until it returns a value; every wait is bounded. Polling is used
 * because the captured message arrays are plain arrays (no event emitter); the
 * probe is re-evaluated every 10ms and the poll exits the moment the condition
 * is true, so no fixed latency is paid and no condition is guessed.
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

/** Compact, failure-evidence summary of an observable playback state. */
function summarize(state: PlaybackState): string {
  return `revision=${state.stateRevision} sequence=${state.lastSequence} phase=${state.mediaPhase} position=${state.positionSeconds}s`;
}

/**
 * Start an authority. By default it has NO initial resource (dynamic binding is
 * exercised by every scenario) and joins are auto-accepted so the flows stay
 * deterministic.
 */
async function startAuthority(
  options: { resourceIdentity?: ResourceIdentity; autoAcceptJoins?: boolean; durationSeconds?: number | null } = {},
): Promise<{ authority: SessionAuthority; url: string; sessionId: string }> {
  const authority = new SessionAuthority({
    ...(options.resourceIdentity === undefined ? {} : { resourceIdentity: options.resourceIdentity }),
    autoAcceptJoins: options.autoAcceptJoins ?? true,
    ...(options.durationSeconds === undefined ? {} : { durationSeconds: options.durationSeconds }),
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
  /** Diagnostic AND error messages: SessionClient routes both to onDiagnostic. */
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
   * Report the actual state that exactly matches the latest authoritative state
   * this client observed (same revision, phase, projected position, rate), so
   * the report evaluates as consistent unless a field is overridden. Overrides
   * force a divergent report (stale revision, wrong resource, terminal phase,
   * ...) for the report-isolation scenarios.
   */
  reportConsistent(overrides: Partial<ActualStateBody> & { resourceIdentity?: ResourceIdentity } = {}): void {
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
      ...(overrides.resourceIdentity === undefined ? {} : { resourceIdentity: overrides.resourceIdentity }),
    });
  }

  async waitForRevision(revision: number, timeoutMs = 5000): Promise<PlaybackState> {
    return withTimeout(
      this.client.waitForRevision(revision, timeoutMs),
      timeoutMs + 1000,
      `revision ${revision} on ${this.participantId}`,
    );
  }

  async waitForDiagnostic(predicate: (message: Diagnostic) => boolean, timeoutMs = 5000): Promise<Diagnostic> {
    return waitFor(
      () => this.diagnostics.find(
        (message): message is Diagnostic => message.type === 'diagnostic' && predicate(message),
      ),
      timeoutMs,
      `diagnostic on ${this.participantId}`,
    );
  }

  async waitForError(predicate: (message: ErrorMessage) => boolean, timeoutMs = 5000): Promise<ErrorMessage> {
    return waitFor(
      () => this.diagnostics.find(
        (message): message is ErrorMessage => message.type === 'error' && predicate(message),
      ),
      timeoutMs,
      `error on ${this.participantId}`,
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

test('an authority started without a resource stays unbound; intents are rejected with resource-unbound until the host binds one', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority();
  const host = new Harness(url, sessionId, HOST, undefined, 'host');
  t.after(async () => {
    await host.close();
    await stopAuthority(authority);
  });

  // The authority was created with NO initial resource: the join-accepted
  // state must carry a null identity, so the session is provably unbound.
  const join = await host.connect();
  assert.equal(join.role, 'host', 'the first joiner with roleHint host must be granted the host role');
  assert.equal(join.state.resourceIdentity, null, 'an authority without an initial resource must start unbound');
  assert.equal(join.state.stateRevision, 0, 'an unbound session must still start at revision 0');
  assert.equal(join.state.mediaPhase, 'ready', 'an unbound session keeps a ready phase');
  assert.equal(authority.getState().resourceIdentity, null, 'the authority-side state must also be unbound');

  // Playback intents against the unbound session are rejected explicitly.
  host.submit('play');
  const error = await host.waitForError((message) => message.code === 'resource-unbound', 3000);
  assert.match(error.message, /no bound resource/i, `resource-unbound must explain the missing resource: ${error.message}`);
  assert.equal(host.latest.stateRevision, 0, `the rejected intent must not touch the state: ${summarize(host.latest)}`);
  assert.equal(host.states.length, 1, 'no state broadcast may follow the rejected intent');

  // The host then binds a resource dynamically: no URL was ever configured.
  host.bind(RESOURCE_BV1);
  const bound = await host.waitForRevision(1);
  assert.deepEqual(bound.resourceIdentity, RESOURCE_BV1, 'resource-bind must adopt the sent identity');
  assert.equal(bound.stateRevision, 1, `resource-bind must bump the revision: ${summarize(bound)}`);
  assert.equal(bound.lastSequence, 1, 'resource-bind must bump the sequence');
  assert.equal(bound.mediaPhase, 'ready', 'a fresh bind must reset the phase to ready');
  assert.equal(bound.positionSeconds, 0, 'a fresh bind must reset the playhead to 0');
  assert.equal(bound.durationSeconds, null, 'a fresh bind must drop the duration');
  assert.equal(bound.lastCommandId, null, 'a fresh bind must clear the last command');
  assert.deepEqual(authority.getState().resourceIdentity, RESOURCE_BV1, 'the authority must adopt the bound identity');
});

test('a host join with a Bilibili identity + roleHint host binds the unbound session; an identity-less client join with roleHint client adopts the canonical identity', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority();
  const host = new Harness(url, sessionId, HOST, RESOURCE_BV1, 'host');
  const client = new Harness(url, sessionId, CLIENT, undefined, 'client');
  t.after(async () => {
    await client.close();
    await host.close();
    await stopAuthority(authority);
  });

  // The first host join carries its Bilibili identity: the session binds on
  // join and the host receives the adopted state in join-accepted.
  const hostJoin = await host.connect();
  assert.equal(hostJoin.role, 'host', 'the host joiner must be granted the host role');
  assert.deepEqual(hostJoin.state.resourceIdentity, RESOURCE_BV1, 'a host join carrying an identity must bind the unbound session');
  assert.equal(hostJoin.state.stateRevision, 0, 'binding on the first join must not bump the revision');
  assert.equal(hostJoin.state.mediaPhase, 'ready', 'the adopted state must be a fresh ready state');
  assert.deepEqual(authority.getState().resourceIdentity, RESOURCE_BV1, 'the authority must adopt the joined identity');

  // The client knows nothing about the resource: join-accepted must push the
  // canonical identity, not the client's own (it has none).
  const clientJoin = await client.connect();
  assert.equal(clientJoin.role, 'client', 'the second joiner with roleHint client must be granted the client role');
  assert.deepEqual(clientJoin.state.resourceIdentity, RESOURCE_BV1, 'an identity-less joiner must receive the canonical session identity');
  assert.equal(clientJoin.state.sessionId, sessionId, 'the pushed state must belong to the session');
  assert.deepEqual(client.latest.resourceIdentity, RESOURCE_BV1, 'the client must adopt the canonical identity as its reference');

  // The client can report against the identity it adopted, and the session
  // turns ready — proving the pushed identity is actually usable.
  host.reportConsistent();
  client.reportConsistent();
  const ready = await host.waitForStatus((status) => status.ready, 3000);
  const clientEntry = ready.participants.find((participant) => participant.participantId === CLIENT);
  assert.ok(clientEntry, 'the identity-less client must appear in the ready status');
  assert.equal(clientEntry.reported, true, 'the identity-less client must have reported');
  assert.equal(clientEntry.consistent, true, 'the identity-less client must be consistent against the canonical identity');
});

test('a host resource-bind switches the session resource: revision/sequence bump, playhead reset, and both participants receive the new state', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority({ resourceIdentity: RESOURCE_BV1, durationSeconds: 600 });
  const host = new Harness(url, sessionId, HOST, RESOURCE_BV1, 'host');
  const client = new Harness(url, sessionId, CLIENT, undefined, 'client');
  t.after(async () => {
    await client.close();
    await host.close();
    await stopAuthority(authority);
  });

  const hostJoin = await host.connect();
  assert.equal(hostJoin.state.durationSeconds, 600, 'the pre-bind session must know the configured duration');
  await client.connect();
  assert.deepEqual(client.latest.resourceIdentity, RESOURCE_BV1, 'the identity-less client adopts the initial resource');

  // Put the session into a non-trivial position first so the reset is
  // observable: a seek to 30s freezes positionSeconds at 30 (revision 1).
  host.submit('seek', { targetSeconds: 30 });
  const sought = await host.waitForRevision(1);
  assert.equal(sought.positionSeconds, 30, `the seek must move the playhead: ${summarize(sought)}`);
  await client.waitForRevision(1);

  // The host switches to a SECOND Bilibili identity.
  host.bind(RESOURCE_BV2);
  const boundHost = await host.waitForRevision(2);
  const boundClient = await client.waitForRevision(2);

  assert.deepEqual(boundHost.resourceIdentity, RESOURCE_BV2, 'the host must receive the switched identity');
  assert.deepEqual(boundClient.resourceIdentity, RESOURCE_BV2, 'the identity-less client must follow the switched identity');
  assert.equal(boundHost.stateRevision, 2, `the bind must bump the revision past prior intents: ${summarize(boundHost)}`);
  assert.equal(boundHost.lastSequence, 2, 'the bind must bump the sequence past prior intents');
  assert.equal(boundHost.mediaPhase, 'ready', 'the bind must reset the phase to ready');
  assert.equal(boundHost.positionSeconds, 0, `the bind must reset the playhead to 0: ${summarize(boundHost)}`);
  assert.equal(boundHost.playbackRate, 1, 'the bind must reset the playback rate');
  assert.equal(boundHost.durationSeconds, null, `the bind must drop the known duration: ${summarize(boundHost)}`);
  assert.equal(boundHost.lastCommandId, null, 'the bind must clear the last command');
  assert.deepEqual(boundHost, boundClient, 'both participants must observe the identical switched state');
  assert.deepEqual(authority.getState().resourceIdentity, RESOURCE_BV2, 'the authority must adopt the switched identity');

  // Exactly one state broadcast per participant per step: join, seek, bind.
  assert.equal(host.states.length, 3, `host must have exactly join+seek+bind states: ${host.states.map(summarize).join(' -> ')}`);
  assert.equal(client.states.length, 3, `client must have exactly join+seek+bind states: ${client.states.map(summarize).join(' -> ')}`);
});

test('actual-state reports bound to the old resource can neither promote a phase nor ready the session after a resource-bind', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority({ resourceIdentity: RESOURCE_BV1 });
  const host = new Harness(url, sessionId, HOST, RESOURCE_BV1, 'host');
  const client = new Harness(url, sessionId, CLIENT, undefined, 'client');
  t.after(async () => {
    await client.close();
    await host.close();
    await stopAuthority(authority);
  });

  await host.connect();
  await client.connect();
  // Reach ready on the initial resource: both endpoints report consistently.
  host.reportConsistent();
  client.reportConsistent();
  await host.waitForStatus((status) => status.ready, 3000);

  // The host switches to BV2; the bind clears stored reports and resets the
  // state, so the old resource's reports must be judged against BV2.
  host.bind(RESOURCE_BV2);
  const bound = await host.waitForRevision(1);
  assert.deepEqual(bound.resourceIdentity, RESOURCE_BV2, `the bind must be observed: ${summarize(bound)}`);
  await client.waitForRevision(1);
  const statesAfterBind = host.states.length;
  assert.equal(statesAfterBind, 2, `host must have join+bind states: ${host.states.map(summarize).join(' -> ')}`);

  // (a) A STALE pre-bind report (old revision 0 + old identity, terminal
  // 'ended'): it must not promote 'ended' into the new resource's state, and
  // it must not close the readiness gate. It is diagnosed as a mismatch.
  client.reportConsistent({
    observedRevision: 0,
    resourceIdentity: RESOURCE_BV1,
    mediaPhase: 'ended',
    positionSeconds: 42,
    applyResult: 'applied',
  });
  await host.waitForDiagnostic(
    (message) => message.code === 'actual-state-mismatch' && message.participantId === CLIENT,
    3000,
  );
  assert.equal(host.latest.stateRevision, 1, 'a stale report must not promote a phase');
  assert.equal(host.latest.mediaPhase, 'ready', `the new resource must stay ready: ${summarize(host.latest)}`);
  assert.deepEqual(host.latest.resourceIdentity, RESOURCE_BV2, 'the stale report must not change the bound identity');
  assert.equal(host.latest.positionSeconds, 0, 'the stale report must not move the playhead');
  assert.equal(host.states.length, statesAfterBind, 'no state broadcast may follow the stale report');
  assert.equal(client.states.length, 2, 'the stale report must not broadcast any state to the client either');

  // (b) An OLD-IDENTITY report at the NEW revision: the stale page echoes the
  // new revision against its old resource — it must not overwrite the newly
  // bound resource's state either, and it must keep the gate closed with an
  // explicit desync status.
  client.reportConsistent({
    observedRevision: 1,
    resourceIdentity: RESOURCE_BV1,
    mediaPhase: 'ended',
    positionSeconds: 42,
    applyResult: 'applied',
  });
  await waitFor(
    () => (
      host.diagnostics.filter(
        (message) => message.type === 'diagnostic' && message.code === 'actual-state-mismatch' && message.participantId === CLIENT,
      ).length === 2
        ? true
        : undefined
    ),
    3000,
    'second actual-state-mismatch diagnostic on the host',
  );
  assert.equal(host.latest.stateRevision, 1, 'an old-identity report at the new revision must not promote a phase');
  assert.equal(host.latest.mediaPhase, 'ready', `the new resource must stay ready: ${summarize(host.latest)}`);
  assert.equal(host.states.length, statesAfterBind, 'the old-identity report must not broadcast a state');
  const desync = await host.waitForStatus(
    (status) => status.ready === false && status.reason === 'actual-state-desync',
    3000,
  );
  assert.equal(desync.stateRevision, 1, 'the desync status must be against the new revision');
  const desyncClient = desync.participants.find((participant) => participant.participantId === CLIENT);
  assert.ok(desyncClient, 'the old-identity reporter must appear in the status');
  assert.equal(desyncClient.reported, true, 'the old-identity report must be counted as reported');
  assert.equal(desyncClient.consistent, false, 'the old-identity report must be judged inconsistent');

  // The gate opens only for reports against the NEW resource: both endpoints
  // re-report for revision 1 with BV2 and the session turns ready.
  host.reportConsistent();
  client.reportConsistent();
  const ready = await host.waitForStatus((status) => status.ready && status.stateRevision === 1, 3000);
  const readyClient = ready.participants.find((participant) => participant.participantId === CLIENT);
  assert.ok(readyClient, 'the re-reporting client must appear in the ready status');
  assert.equal(readyClient.reported, true, 'the re-reporting client must be reported');
  assert.equal(readyClient.consistent, true, 'the re-reporting client must be consistent against the new resource');
  assert.deepEqual(authority.getState().resourceIdentity, RESOURCE_BV2, 'the authority state must stay bound to the new resource');
});

test('a client resource-bind switches the session resource: any joined participant may bind, both endpoints reset to the new identity, and an old-identity report cannot promote state', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority({ resourceIdentity: RESOURCE_BV1, durationSeconds: 600 });
  const host = new Harness(url, sessionId, HOST, RESOURCE_BV1, 'host');
  const client = new Harness(url, sessionId, CLIENT, undefined, 'client');
  t.after(async () => {
    await client.close();
    await host.close();
    await stopAuthority(authority);
  });

  const hostJoin = await host.connect();
  assert.equal(hostJoin.role, 'host', 'the first joiner with roleHint host must be granted the host role');
  assert.equal(hostJoin.state.durationSeconds, 600, 'the pre-bind session must know the configured duration');
  await client.connect();
  assert.deepEqual(client.latest.resourceIdentity, RESOURCE_BV1, 'the identity-less client adopts the initial resource');

  // Put the session into a non-trivial position first so the reset is
  // observable: a seek to 30s freezes positionSeconds at 30 (revision 1).
  host.submit('seek', { targetSeconds: 30 });
  const sought = await host.waitForRevision(1);
  assert.equal(sought.positionSeconds, 30, `the seek must move the playhead: ${summarize(sought)}`);
  await client.waitForRevision(1);

  // The CLIENT — not the host — switches to a SECOND Bilibili identity:
  // resource-bind is open to any joined participant.
  client.bind(RESOURCE_BV2);
  const boundClient = await client.waitForRevision(2);
  const boundHost = await host.waitForRevision(2);

  assert.deepEqual(boundClient.resourceIdentity, RESOURCE_BV2, 'the binding client must receive the switched identity');
  assert.deepEqual(boundHost.resourceIdentity, RESOURCE_BV2, 'the host must follow the client-initiated switch');
  assert.equal(boundClient.stateRevision, 2, `the bind must bump the revision past prior intents: ${summarize(boundClient)}`);
  assert.equal(boundClient.lastSequence, 2, 'the bind must bump the sequence past prior intents');
  assert.equal(boundClient.mediaPhase, 'ready', 'the bind must reset the phase to ready');
  assert.equal(boundClient.positionSeconds, 0, `the bind must reset the playhead to 0: ${summarize(boundClient)}`);
  assert.equal(boundClient.playbackRate, 1, 'the bind must reset the playback rate');
  assert.equal(boundClient.durationSeconds, null, `the bind must drop the known duration: ${summarize(boundClient)}`);
  assert.equal(boundClient.lastCommandId, null, 'the bind must clear the last command');
  assert.deepEqual(boundClient, boundHost, 'both participants must observe the identical switched state');
  assert.deepEqual(authority.getState().resourceIdentity, RESOURCE_BV2, 'the authority must adopt the client-bound identity');

  // Both endpoints — the host and the identity-less client — can report
  // against the NEW identity: the readiness gate opens at the new revision.
  host.reportConsistent();
  client.reportConsistent();
  const ready = await host.waitForStatus((status) => status.ready && status.stateRevision === 2, 3000);
  const readyClient = ready.participants.find((participant) => participant.participantId === CLIENT);
  assert.ok(readyClient, 'the reporting client must appear in the ready status');
  assert.equal(readyClient.reported, true, 'the client must be reported against the new identity');
  assert.equal(readyClient.consistent, true, 'the client must be consistent against the new identity');

  // An OLD-identity report at the NEW revision must not promote into the
  // newly bound resource's state: the stale page cannot flip the phase to
  // 'ended' nor move the playhead, and no state broadcast may follow.
  client.reportConsistent({
    observedRevision: 2,
    resourceIdentity: RESOURCE_BV1,
    mediaPhase: 'ended',
    positionSeconds: 42,
    applyResult: 'applied',
  });
  await host.waitForDiagnostic(
    (message) => message.code === 'actual-state-mismatch' && message.participantId === CLIENT,
    3000,
  );
  assert.equal(host.latest.stateRevision, 2, 'an old-identity report must not promote a phase');
  assert.equal(host.latest.mediaPhase, 'ready', `the new resource must stay ready: ${summarize(host.latest)}`);
  assert.deepEqual(host.latest.resourceIdentity, RESOURCE_BV2, 'the old-identity report must not change the bound identity');
  assert.equal(host.latest.positionSeconds, 0, 'the old-identity report must not move the playhead');
  assert.equal(host.states.length, 3, `host must have exactly join+seek+bind states: ${host.states.map(summarize).join(' -> ')}`);
  assert.equal(client.states.length, 3, `client must have exactly join+seek+bind states: ${client.states.map(summarize).join(' -> ')}`);
  const desync = await host.waitForStatus(
    (status) => status.ready === false && status.reason === 'actual-state-desync',
    3000,
  );
  assert.equal(desync.stateRevision, 2, 'the desync status must be against the new revision');
  const desyncClient = desync.participants.find((participant) => participant.participantId === CLIENT);
  assert.ok(desyncClient, 'the old-identity reporter must appear in the status');
  assert.equal(desyncClient.reported, true, 'the old-identity report must be counted as reported');
  assert.equal(desyncClient.consistent, false, 'the old-identity report must be judged inconsistent');
  assert.deepEqual(authority.getState().resourceIdentity, RESOURCE_BV2, 'the authority state must stay bound to the new resource');
});

test('the default adapter registry resolves Bilibili pages, refuses unknown URLs, and rejects same-domain conflicts', { timeout: 15000 }, async (t) => {
  const registry = createDefaultAdapterRegistry();

  // Bilibili routing: apex domain, www subdomain, and any other subdomain.
  const apex = registry.resolve('https://bilibili.com/video/BV1xx411c7mD');
  assert.ok(apex, 'the apex bilibili.com domain must resolve');
  assert.equal(apex.adapterId, 'bilibili', 'the apex domain must route to the bilibili adapter');
  const www = registry.resolve('https://www.bilibili.com/video/BV1xx411c7mD?p=2');
  assert.equal(www?.adapterId, 'bilibili', 'www.bilibili.com must resolve to the bilibili adapter');
  const subdomain = registry.resolve('https://sub.bilibili.com/bangumi/play/ep123');
  assert.equal(subdomain?.adapterId, 'bilibili', 'any *.bilibili.com subdomain must resolve to the bilibili adapter');

  // resolveAdapter instantiates the syncer for a matching page environment.
  const adapter = registry.resolveAdapter({ location: { href: 'https://www.bilibili.com/video/BV1xx411c7mD' } });
  assert.ok(adapter, 'resolveAdapter must instantiate a syncer for a Bilibili page');
  assert.equal(adapter.adapterId, 'bilibili', 'the instantiated adapter must identify as bilibili');

  // Unknown and unusable URLs never resolve (and never throw).
  assert.equal(registry.resolve('https://example.com/video/BV1xx411c7mD'), undefined, 'unknown domains must resolve to undefined');
  assert.equal(registry.resolve('https://youtube.com/watch?v=abc123'), undefined, 'other video sites must resolve to undefined');
  assert.equal(registry.resolve('ftp://bilibili.com/video/BV1xx411c7mD'), undefined, 'non-http(s) URLs must resolve to undefined');
  assert.equal(registry.resolve('not a url at all'), undefined, 'unparseable URLs must resolve to undefined');
  assert.equal(registry.resolveAdapter({ location: { href: 'https://example.com/' } }), undefined, 'resolveAdapter must return undefined off-domain');

  // A second syncer claiming the same registrable domain is a hard conflict.
  assert.throws(
    () => registry.register({
      adapterId: 'bilibili-clone',
      name: 'Bilibili Clone',
      domain: 'bilibili.com',
      create: () => new BilibiliAdapter(),
      capabilities: [],
    }),
    (error: unknown) => (
      error instanceof AdapterRegistryError
      && error.code === 'duplicate-domain'
      && /already served by adapter 'bilibili'/.test(error.message)
    ),
    'registering a second syncer for bilibili.com must throw AdapterRegistryError duplicate-domain',
  );

  // Domain canonicalization: case, whitespace and trailing dots collapse onto
  // the same normalized key before the conflict check.
  assert.throws(
    () => registry.register({
      adapterId: 'bilibili-clone-2',
      name: 'Bilibili Clone 2',
      domain: '  BILIBILI.COM.  ',
      create: () => new BilibiliAdapter(),
      capabilities: [],
    }),
    (error: unknown) => error instanceof AdapterRegistryError && error.code === 'duplicate-domain',
    'a normalized-equivalent domain must also throw duplicate-domain',
  );
  assert.equal(registry.size, 1, 'failed registrations must not leave partial registry state');
});
