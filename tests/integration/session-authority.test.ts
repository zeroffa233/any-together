/**
 * Integration tests for SessionAuthority over real ephemeral TCP/WebSocket transport.
 *
 * Every case spins up a real SessionAuthority (ephemeral port) and connects real
 * SessionClient / ws clients to it; nothing uses an in-memory fake transport.
 * Each case has an explicit node:test timeout plus bounded `withTimeout` wrappers,
 * and cleanup is registered with `t.after` (node:test's finally: it runs even when
 * the body fails) so servers and sockets never leak.
 * Waits are condition-driven polls that exit the moment the signal arrives; no
 * fixed-duration sleeps are used (captured message arrays are plain arrays without
 * events, so a 10ms poll is the deterministic equivalent of awaiting a signal).
 *
 * Covered scenarios (18):
 *   1. same-resource join: identical initial snapshot, first joiner is host
 *   2. ordered interleaved intents converge to identical revision/state on both clients
 *   3. duplicate commandId: idempotent acknowledgement, no revision bump, newer state never overwritten
 *   4. mismatched bilibili resource identity rejected (resource-mismatch)
 *   5. third participant rejected (session-full), session keeps working
 *   6. duplicate participant id rejected, closed with policy code 1008
 *   7. snapshot-request returns the full current authoritative state (verified
 *      at the wire); the SessionClient stale guard drops the same-revision echo
 *   8. version gap healed: rejoining participant receives the full latest snapshot
 *   9. participant-left diagnostic broadcast; stop()/close() never hang
 *  10. invalid intents and malformed messages return error codes, state untouched;
 *      guards run shape-first (invalid-intent) before membership (not-joined)
 *  11. host approval: pending joiner occupies a seat but is not counted or synced;
 *      join-request carries the joiner identity; pending id/snapshot misuse is
 *      rejected; the approval snapshot is decision-time (includes a pre-approval intent)
 *  12. identity-less joiner: join without resourceIdentity pushes the canonical
 *      resource via join-accepted; the joiner reports against it and the session turns ready
 *  13. host rejection: accepted=false -> host-declined + close 1008; the seat stays
 *      occupied while pending (a third socket gets session-full); session keeps working
 *  14. malformed joins, join-decisions and actual-state reports return error codes
 *      and never crash the authority
 *  15. session-status readiness ladder (awaiting-second-participant ->
 *      awaiting-actual-state -> ready -> invalidated by intents -> ready) and
 *      identical-status dedup
 *  16. actual-state diagnostics: position drift, stale revision, phase/rate and
 *      resource mismatch carry expected/actual details; a rate-only mismatch is
 *      readiness-blocking (NFR-001) and closes the ready gate
 *  17. pending-join lifecycle: a leaving host releases the pending joiner with
 *      host-unavailable; a giving-up joiner silently frees its seat
 *  18. stale snapshot is ignored: a withheld snapshot never regresses a client
 *      that already advanced past it
 *
 * Scenarios 1-10 join through the deterministic auto-accept path
 * (`autoAcceptJoins: true`); scenarios 11-14 and 17 drive the real host-approval
 * flow (join-request / join-decision) that the default user path uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { SessionAuthority } from '../../src/server/session-authority.js';
import { SessionClient } from '../../src/client/session-client.js';
import { createBilibiliResourceIdentity } from '../../src/shared/resource.js';
import { isPlaybackState } from '../../src/shared/protocol.js';
import type {
  ActualStateReport,
  IntentKind,
  JoinRequestMessage,
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
const ALICE = 'alice';
const BOB = 'bob';
const CAROL = 'carol';

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
 * because the captured message/state arrays are plain arrays (no event emitter);
 * the probe is re-evaluated every 10ms and the poll exits the moment the
 * condition is true, so no fixed latency is paid and no condition is guessed.
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
 * Start an authority. Most scenarios exercise state/session behavior and use the
 * deterministic auto-accept join (`autoAcceptJoins: true`); approval scenarios
 * pass `false` so the second participant goes through the real join-request /
 * join-decision flow.
 */
async function startAuthority(
  resourceIdentity: ResourceIdentity = RESOURCE_BV1,
  autoAcceptJoins = true,
): Promise<{ authority: SessionAuthority; url: string; sessionId: string }> {
  const authority = new SessionAuthority({ resourceIdentity, autoAcceptJoins });
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
  readonly joinRequests: JoinRequestMessage[] = [];

  constructor(url: string, sessionId: string, participantId: string, resourceIdentity?: ResourceIdentity) {
    this.participantId = participantId;
    this.client = new SessionClient({
      url,
      sessionId,
      participantId,
      ...(resourceIdentity === undefined ? {} : { resourceIdentity }),
    });
    this.client.onState((state) => this.states.push(state));
    this.client.onDiagnostic((message) => this.diagnostics.push(message));
    this.client.onSessionStatus((status) => this.statuses.push(status));
    this.client.onJoinRequest((request) => this.joinRequests.push(request));
  }

  async connect(timeoutMs = 5000): Promise<JoinAccepted> {
    return withTimeout(this.client.connect(), timeoutMs, `join of ${this.participantId}`);
  }

  async close(timeoutMs = 3000): Promise<void> {
    await withTimeout(this.client.close(), timeoutMs, `close of ${this.participantId}`).catch(() => {});
  }

  submit(kind: IntentKind, payload?: PlaybackIntent['payload'], commandId?: string): string {
    return this.client.submitIntent(kind, payload, commandId);
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

  async waitForStatus(predicate: (status: SessionStatusMessage) => boolean, timeoutMs = 5000): Promise<SessionStatusMessage> {
    return waitFor(
      () => this.statuses.find(predicate),
      timeoutMs,
      `session-status on ${this.participantId}`,
    );
  }

  async waitForJoinRequest(predicate: (request: JoinRequestMessage) => boolean, timeoutMs = 5000): Promise<JoinRequestMessage> {
    return waitFor(
      () => this.joinRequests.find(predicate),
      timeoutMs,
      `join-request on ${this.participantId}`,
    );
  }

  /** The host accepts or rejects the single pending join request. */
  decideJoin(accepted: boolean): void {
    this.client.sendJoinDecision(accepted);
  }

  /**
   * Report the actual state that exactly matches the latest authoritative state
   * this client observed (same revision, phase, projected position, rate), so
   * the report evaluates as consistent unless a field is overridden. Overrides
   * force a divergent report (drifted position, wrong phase, wrong resource,
   * stale revision, ...) for diagnostic scenarios.
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

  get latest(): PlaybackState {
    const latest = this.states[this.states.length - 1];
    if (latest === undefined) throw new Error(`No state observed on ${this.participantId}`);
    return latest;
  }
}

// ---------------------------------------------------------------------------
// Raw ws client (still real TCP/WebSocket, for wire-level scenarios)
// ---------------------------------------------------------------------------

type RawClient = {
  socket: WebSocket;
  messages: unknown[];
  closeCode: number | null;
  closeReason: string;
};

async function connectRaw(url: string, timeoutMs = 5000): Promise<RawClient> {
  const socket = new WebSocket(url);
  const messages: unknown[] = [];
  let closeCode: number | null = null;
  let closeReason = '';
  socket.on('message', (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()));
    } catch {
      messages.push(raw.toString());
    }
  });
  socket.on('close', (code, reason) => {
    closeCode = code;
    closeReason = reason.toString();
  });
  const { promise: opened, resolve, reject } = Promise.withResolvers<void>();
  let settled = false;
  socket.once('open', () => {
    settled = true;
    resolve();
  });
  socket.on('error', (error) => {
    if (settled) return; // keep a listener attached so late errors never crash the runner
    settled = true;
    reject(new Error(`Raw WebSocket error: ${error.message}`));
  });
  await withTimeout(opened, timeoutMs, 'raw socket open');
  return {
    socket,
    messages,
    // Live closure-backed accessors: the 'close' handler above mutates the
    // locals, and these getters read through to them, so a close observed
    // after connectRaw resolves is visible here (no stale primitive snapshot).
    get closeCode(): number | null {
      return closeCode;
    },
    get closeReason(): string {
      return closeReason;
    },
  };
}

function rawSend(client: RawClient, message: unknown): void {
  client.socket.send(JSON.stringify(message));
}

function closeRaw(client: RawClient | undefined): void {
  if (!client) return;
  const { socket } = client;
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
  }
}

function joinMessage(participantId: string, resourceIdentity: ResourceIdentity): unknown {
  return { type: 'join', participantId, resourceIdentity };
}

/**
 * Validated-boundary readers for raw wire messages: each narrows with `in`,
 * validates the payload with the protocol's own guards, and only then exposes
 * typed fields. Raw wire data is never read through unchecked casts.
 */

function rawPlaybackState(message: unknown, type: 'state' | 'snapshot' | 'join-accepted'): PlaybackState | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  if (!('type' in message) || message.type !== type) return undefined;
  if (!('state' in message) || !isPlaybackState(message.state)) return undefined;
  return message.state;
}

function rawJoinAccepted(message: unknown): { role: 'host' | 'client'; state: PlaybackState } | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  if (!('type' in message) || message.type !== 'join-accepted') return undefined;
  if (!('role' in message) || !('state' in message) || !isPlaybackState(message.state)) return undefined;
  const role = message.role;
  if (role === 'host' || role === 'client') return { role, state: message.state };
  return undefined;
}

async function waitForJoinAccepted(
  client: RawClient,
  timeoutMs: number,
  label: string,
): Promise<{ role: 'host' | 'client'; state: PlaybackState }> {
  return waitFor(() => {
    for (const message of client.messages) {
      const accepted = rawJoinAccepted(message);
      if (accepted !== undefined) return accepted;
    }
    return undefined;
  }, timeoutMs, label);
}

function rawJoinRejectedReason(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  if (!('type' in message) || message.type !== 'join-rejected') return undefined;
  if (!('reason' in message) || typeof message.reason !== 'string') return undefined;
  return message.reason;
}

function rawErrorCode(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  if (!('type' in message) || message.type !== 'error') return undefined;
  if (!('code' in message) || typeof message.code !== 'string') return undefined;
  return message.code;
}

// ---------------------------------------------------------------------------
// Transparent WebSocket relay that can withhold server 'snapshot' frames
// ---------------------------------------------------------------------------

type HeldSnapshot = {
  released: boolean;
  release: () => void;
};

/**
 * A real WebSocket server that forwards every frame verbatim between the client
 * and the authority, except 'snapshot' frames, which are withheld until their
 * `release()` is called. Both legs are real TCP/WebSocket connections, so the
 * client and the authority never know a relay sits between them — this is the
 * only way to deliver a genuinely stale snapshot to a SessionClient, because
 * the real authority always answers snapshot requests with its current state.
 */
async function startSnapshotHoldingProxy(targetUrl: string): Promise<{
  url: string;
  held: HeldSnapshot[];
  close: () => Promise<void>;
}> {
  const proxy = new WebSocketServer({ port: 0 });
  const held: HeldSnapshot[] = [];
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.once('listening', resolve);
    }),
    5000,
    'snapshot-holding proxy bind',
  );
  proxy.on('error', () => {}); // post-bind errors surface through the close events below
  proxy.on('connection', (clientSocket) => {
    const upstream = new WebSocket(targetUrl);
    const queued: RawData[] = [];
    upstream.on('error', () => {}); // teardown happens via the close events below
    upstream.on('open', () => {
      // Flush everything the client sent while the upstream was connecting, so
      // an early join message can never be dropped by the relay.
      for (const raw of queued) upstream.send(raw);
      queued.length = 0;
    });
    clientSocket.on('message', (raw) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(raw);
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        queued.push(raw);
      }
    });
    upstream.on('message', (raw) => {
      if (clientSocket.readyState !== WebSocket.OPEN) return;
      let isSnapshot = false;
      try {
        const parsed: unknown = JSON.parse(raw.toString());
        isSnapshot = typeof parsed === 'object' && parsed !== null && 'type' in parsed && parsed.type === 'snapshot';
      } catch {
        // Non-JSON frames are forwarded verbatim.
      }
      if (isSnapshot) {
        let forward: () => void = () => {};
        const entry: HeldSnapshot = {
          released: false,
          release() {
            if (entry.released) return;
            entry.released = true;
            forward();
          },
        };
        forward = () => {
          if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(raw);
        };
        held.push(entry);
        return;
      }
      clientSocket.send(raw);
    });
    clientSocket.on('close', () => upstream.terminate());
    upstream.on('close', () => clientSocket.terminate());
  });
  const address = proxy.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    throw new Error('Snapshot-holding proxy did not bind a TCP port');
  }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    held,
    close: () => new Promise<void>((resolve) => {
      // Terminate any remaining client sockets so server.close() cannot hang.
      for (const client of proxy.clients) client.terminate();
      proxy.close(() => resolve());
    }),
  };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

test('join: same-resource clients receive identical initial snapshots; first joiner is host', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority();
  const alice = new Harness(url, sessionId, ALICE, RESOURCE_BV1);
  const bob = new Harness(url, sessionId, BOB, RESOURCE_BV1);
  t.after(async () => {
    await bob.close();
    await alice.close();
    await stopAuthority(authority);
  });

  const joinAlice = await alice.connect();
  const joinBob = await bob.connect();

  assert.equal(joinAlice.role, 'host', 'first joiner must be the host (creator authority)');
  assert.equal(joinBob.role, 'client', 'second joiner must be a client');
  assert.equal(authority.participantCount, 2, 'both joiners must be registered');

  for (const [label, join] of [['alice', joinAlice], ['bob', joinBob]] as const) {
    const state = join.state;
    assert.equal(state.sessionId, sessionId, `${label}: session id mismatch`);
    assert.deepEqual(state.resourceIdentity, RESOURCE_BV1, `${label}: bilibili resource identity mismatch`);
    assert.equal(state.stateRevision, 0, `${label}: initial revision must be 0`);
    assert.equal(state.lastSequence, 0, `${label}: initial sequence must be 0`);
    assert.equal(state.mediaPhase, 'ready', `${label}: initial phase must be ready`);
    assert.equal(state.positionSeconds, 0, `${label}: initial position must be 0`);
    assert.equal(state.playbackRate, 1, `${label}: initial rate must be 1`);
    assert.equal(state.durationSeconds, null, `${label}: initial duration must be null`);
    assert.equal(state.lastCommandId, null, `${label}: initial lastCommandId must be null`);
  }
  assert.deepEqual(joinAlice.state, joinBob.state, 'both joiners must observe the identical initial snapshot');
  assert.equal(alice.states.length, 1, 'alice must have recorded exactly the initial snapshot');
  assert.equal(bob.states.length, 1, 'bob must have recorded exactly the initial snapshot');
});

test('ordered intents from both clients converge to identical revision and state', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority();
  const alice = new Harness(url, sessionId, ALICE, RESOURCE_BV1);
  const bob = new Harness(url, sessionId, BOB, RESOURCE_BV1);
  t.after(async () => {
    await bob.close();
    await alice.close();
    await stopAuthority(authority);
  });
  await alice.connect();
  await bob.connect();

  const playId = alice.submit('play');
  const afterPlay = await alice.waitForRevision(1);
  await bob.waitForRevision(1);
  assert.equal(afterPlay.stateRevision, 1, summarize(afterPlay));
  assert.equal(afterPlay.lastSequence, 1, summarize(afterPlay));
  assert.equal(afterPlay.mediaPhase, 'playing', summarize(afterPlay));
  assert.equal(afterPlay.lastCommandId, playId, summarize(afterPlay));

  const seekId = bob.submit('seek', { targetSeconds: 42.5 });
  const afterSeek = await bob.waitForRevision(2);
  await alice.waitForRevision(2);
  assert.equal(afterSeek.stateRevision, 2, summarize(afterSeek));
  assert.equal(afterSeek.lastSequence, 2, summarize(afterSeek));
  assert.equal(afterSeek.mediaPhase, 'playing', summarize(afterSeek));
  assert.equal(afterSeek.positionSeconds, 42.5, summarize(afterSeek));
  assert.equal(afterSeek.lastCommandId, seekId, summarize(afterSeek));

  alice.submit('pause');
  const afterPause = await alice.waitForRevision(3);
  await bob.waitForRevision(3);
  assert.equal(afterPause.stateRevision, 3, summarize(afterPause));
  assert.equal(afterPause.lastSequence, 3, summarize(afterPause));
  assert.equal(afterPause.mediaPhase, 'paused', summarize(afterPause));
  assert.ok(afterPause.positionSeconds >= 42.5, `playhead must have advanced while playing: ${summarize(afterPause)}`);
  assert.ok(afterPause.positionSeconds < 60, `position must not jump wildly: ${summarize(afterPause)}`);

  const finalSeekId = bob.submit('seek', { targetSeconds: 10 });
  const final = await bob.waitForRevision(4);
  await alice.waitForRevision(4);
  assert.equal(final.stateRevision, 4, summarize(final));
  assert.equal(final.lastSequence, 4, summarize(final));
  assert.equal(final.mediaPhase, 'paused', summarize(final));
  assert.equal(final.positionSeconds, 10, summarize(final));
  assert.equal(final.lastCommandId, finalSeekId, summarize(final));

  assert.deepEqual(
    alice.latest,
    bob.latest,
    `clients diverged: alice ${summarize(alice.latest)} vs bob ${summarize(bob.latest)}`,
  );
  assert.equal(alice.states.length, 5, 'alice must have observed the initial snapshot plus 4 broadcasts');
  assert.equal(bob.states.length, 5, 'bob must have observed the initial snapshot plus 4 broadcasts');
  assert.deepEqual(alice.states, bob.states, 'both clients must observe the same state history');
});

test('duplicate commandId is idempotent: no revision bump and newer state is never overwritten', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority();
  const alice = new Harness(url, sessionId, ALICE, RESOURCE_BV1);
  const bob = new Harness(url, sessionId, BOB, RESOURCE_BV1);
  t.after(async () => {
    await bob.close();
    await alice.close();
    await stopAuthority(authority);
  });
  await alice.connect();
  await bob.connect();

  const playId = alice.submit('play', undefined, 'dup-play');
  await alice.waitForRevision(1);
  await bob.waitForRevision(1);
  const pauseId = alice.submit('pause', undefined, 'dup-pause');
  await alice.waitForRevision(2);
  await bob.waitForRevision(2);

  assert.equal(alice.states.length, 3, 'alice: initial snapshot plus two broadcasts');
  assert.equal(bob.states.length, 3, 'bob: initial snapshot plus two broadcasts');

  // Replay the very first command id. The authority must acknowledge without
  // re-applying, and the acknowledgement (revision 2, equal to the sender's
  // current revision) must be dropped by the stale-state guard instead of
  // overwriting the newer paused state.
  alice.submit('play', undefined, playId);
  // Barrier: bob's fresh command must land on revision 3. If the duplicate had
  // been re-applied it would have consumed a revision, so the fresh command
  // would land on revision 4 instead — and alice's history would contain the
  // duplicate's broadcast.
  const freshId = bob.submit('pause', undefined, 'fresh-after-duplicate');
  const afterFresh = await bob.waitForRevision(3);
  await alice.waitForRevision(3);

  assert.equal(afterFresh.stateRevision, 3, summarize(afterFresh));
  assert.equal(afterFresh.lastSequence, 3, summarize(afterFresh));
  assert.equal(afterFresh.lastCommandId, freshId, summarize(afterFresh));
  assert.equal(alice.latest.stateRevision, 3, `duplicate must not increment: ${summarize(alice.latest)}`);
  assert.equal(alice.latest.lastSequence, 3, `duplicate must not consume a sequence number: ${summarize(alice.latest)}`);
  assert.equal(alice.latest.mediaPhase, 'paused', `newer state must survive the duplicate: ${summarize(alice.latest)}`);
  assert.equal(alice.latest.lastCommandId, freshId, `newer state must survive the duplicate: ${summarize(alice.latest)}`);
  assert.equal(alice.states.length, 4, 'duplicate acknowledgement must not emit a state on alice');
  assert.equal(bob.states.length, 4, 'duplicate must not broadcast to other participants');
});

test('join with a mismatched bilibili resource identity is rejected', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority();
  const alice = new Harness(url, sessionId, ALICE, RESOURCE_BV1);
  const carol = new Harness(url, sessionId, CAROL, RESOURCE_BV2);
  t.after(async () => {
    await carol.close();
    await alice.close();
    await stopAuthority(authority);
  });
  await alice.connect();
  assert.equal(authority.participantCount, 1);

  await assert.rejects(
    carol.connect(),
    /resource-mismatch/,
    'a client bound to a different bilibili video must be rejected with resource-mismatch',
  );
  assert.equal(authority.participantCount, 1, 'the rejected joiner must not be counted');
  assert.equal(alice.latest.stateRevision, 0, 'the rejected join must not touch the session state');
});

test('a third participant is rejected with session-full while the session keeps working', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority();
  const alice = new Harness(url, sessionId, ALICE, RESOURCE_BV1);
  const bob = new Harness(url, sessionId, BOB, RESOURCE_BV1);
  const carol = new Harness(url, sessionId, CAROL, RESOURCE_BV1);
  t.after(async () => {
    await carol.close();
    await bob.close();
    await alice.close();
    await stopAuthority(authority);
  });
  await alice.connect();
  await bob.connect();

  await assert.rejects(carol.connect(), /session-full/, 'the third joiner must be rejected with session-full');
  assert.equal(authority.participantCount, 2, 'the rejected third joiner must not be counted');

  // The two accepted participants keep working.
  const playId = alice.submit('play');
  const after = await alice.waitForRevision(1);
  await bob.waitForRevision(1);
  assert.equal(after.stateRevision, 1, summarize(after));
  assert.equal(after.lastCommandId, playId, summarize(after));
});

test('a duplicate participant id is rejected and the socket closes with policy code 1008', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority();
  const alice = new Harness(url, sessionId, ALICE, RESOURCE_BV1);
  t.after(async () => {
    await alice.close();
    await stopAuthority(authority);
  });
  await alice.connect();

  const raw = await connectRaw(url);
  t.after(() => closeRaw(raw));
  rawSend(raw, joinMessage(ALICE, RESOURCE_BV1)); // same participant id as alice
  await waitFor(
    () => {
      for (const message of raw.messages) {
        if (rawJoinRejectedReason(message) === 'duplicate-or-empty-participant-id') return true;
      }
      return undefined;
    },
    3000,
    'join-rejected for duplicate participant id',
  );
  await waitFor(() => (raw.closeCode === 1008 ? true : undefined), 3000, 'close frame with code 1008');
  assert.equal(raw.closeReason, 'invalid-participant-id', 'close reason must identify the policy violation');
  assert.equal(authority.participantCount, 1, 'the duplicate joiner must not be counted');
  assert.equal(alice.latest.stateRevision, 0, 'the rejected join must not touch the session state');
});

test('snapshot-request returns the full current authoritative state', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority();
  const alice = new Harness(url, sessionId, ALICE, RESOURCE_BV1);
  // bob joins as a raw socket so the snapshot frame can be captured at the
  // wire: the SessionClient stale guard drops same-revision snapshots before
  // they reach the state listeners, so only a raw observer sees the payload.
  const bob = await connectRaw(url);
  t.after(async () => {
    closeRaw(bob);
    await alice.close();
    await stopAuthority(authority);
  });
  await alice.connect();
  rawSend(bob, joinMessage(BOB, RESOURCE_BV1));
  await waitForJoinAccepted(bob, 3000, 'bob join-accepted');

  const playId = alice.submit('play');
  await alice.waitForRevision(1);
  await waitFor(
    () => (bob.messages.some((message) => rawPlaybackState(message, 'state')?.stateRevision === 1) ? true : undefined),
    3000,
    'bob to observe revision 1',
  );
  const seekId = 'bob-seek-1';
  rawSend(bob, {
    type: 'intent',
    commandId: seekId,
    sessionId,
    participantId: BOB,
    clientObservedRevision: 1,
    kind: 'seek',
    payload: { targetSeconds: 42.5 },
    createdAtMs: Date.now(),
  });
  await alice.waitForRevision(2);
  await waitFor(
    () => (bob.messages.some((message) => rawPlaybackState(message, 'state')?.stateRevision === 2) ? true : undefined),
    3000,
    'bob to observe revision 2',
  );

  const stateCount = alice.states.length; // initial snapshot + two broadcasts

  // The server answers a snapshot-request with the full current authoritative
  // state; the raw socket captures the frame and its payload must equal the
  // state the SessionClient already holds.
  rawSend(bob, { type: 'snapshot-request', participantId: BOB, observedRevision: 2 });
  const snapshot = await waitFor(
    () => {
      for (const message of bob.messages) {
        const state = rawPlaybackState(message, 'snapshot');
        if (state !== undefined && state.stateRevision === 2) return state;
      }
      return undefined;
    },
    3000,
    'bob to receive the snapshot frame',
  );
  assert.equal(snapshot.stateRevision, 2, summarize(snapshot));
  assert.equal(snapshot.lastSequence, 2, summarize(snapshot));
  assert.equal(snapshot.mediaPhase, 'playing', summarize(snapshot));
  assert.equal(snapshot.positionSeconds, 42.5, summarize(snapshot));
  assert.equal(snapshot.lastCommandId, seekId, summarize(snapshot));
  assert.deepEqual(
    snapshot,
    alice.latest,
    `snapshot must carry the full current state, not a stale one: ${summarize(snapshot)}`,
  );

  // The SessionClient stale guard rejects a snapshot that is not strictly
  // newer, so a client request must not extend its observed history. The next
  // broadcast on the same connection proves the request was answered first
  // (per-connection FIFO: the snapshot frame precedes the revision-3 state)
  // and the echo was then discarded instead of being adopted.
  alice.client.requestSnapshot();
  const pauseId = alice.submit('pause');
  await alice.waitForRevision(3);
  assert.equal(alice.latest.lastCommandId, pauseId, summarize(alice.latest));
  assert.equal(
    alice.states.length,
    stateCount + 1,
    'a same-revision snapshot must not extend the client state history',
  );
});

test('version gap healed: a participant that missed broadcasts receives the full latest snapshot on rejoin', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority();
  const alice = new Harness(url, sessionId, ALICE, RESOURCE_BV1);
  t.after(async () => {
    await alice.close();
    await stopAuthority(authority);
  });
  await alice.connect();

  const viewer = await connectRaw(url);
  t.after(() => closeRaw(viewer));
  rawSend(viewer, joinMessage('viewer-c', RESOURCE_BV1));
  const viewerJoin = await waitForJoinAccepted(viewer, 3000, 'viewer join-accepted');
  assert.equal(viewerJoin.role, 'client');
  assert.equal(viewerJoin.state.stateRevision, 0, summarize(viewerJoin.state));

  alice.submit('play');
  await alice.waitForRevision(1);
  await waitFor(
    () => {
      for (const message of viewer.messages) {
        const state = rawPlaybackState(message, 'state');
        if (state !== undefined && state.stateRevision === 1) return true;
      }
      return undefined;
    },
    3000,
    'viewer to observe revision 1',
  );

  viewer.socket.terminate(); // viewer drops out mid-session and will miss the next intent
  const left = await alice.waitForDiagnostic(
    (message) => message.code === 'participant-left' && message.participantId === 'viewer-c',
  );
  assert.equal(left.participantId, 'viewer-c', 'surviving participant must learn who left');
  await waitFor(() => (authority.participantCount === 1 ? true : undefined), 3000, 'participant count 1');

  const seekId = alice.submit('seek', { targetSeconds: 30 });
  const afterSeek = await alice.waitForRevision(2);
  assert.equal(afterSeek.stateRevision, 2, summarize(afterSeek));
  assert.equal(afterSeek.positionSeconds, 30, summarize(afterSeek));

  const viewerRejoin = await connectRaw(url);
  t.after(() => closeRaw(viewerRejoin));
  rawSend(viewerRejoin, joinMessage('viewer-c', RESOURCE_BV1));
  const rejoin = await waitForJoinAccepted(viewerRejoin, 3000, 'rejoin snapshot');
  assert.equal(rejoin.role, 'client');
  assert.equal(rejoin.state.stateRevision, 2, `rejoin snapshot must cover the missed revision: ${summarize(rejoin.state)}`);
  assert.equal(rejoin.state.positionSeconds, 30, summarize(rejoin.state));
  assert.equal(rejoin.state.lastCommandId, seekId, summarize(rejoin.state));
  assert.deepEqual(
    rejoin.state,
    alice.latest,
    `rejoin snapshot must match the authoritative state: ${summarize(rejoin.state)}`,
  );
  assert.equal(authority.participantCount, 2, 'rejoined participant must be counted again');
});

test('participant-left is broadcast to survivors and stop()/close() never hang', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority();
  const alice = new Harness(url, sessionId, ALICE, RESOURCE_BV1);
  const bob = new Harness(url, sessionId, BOB, RESOURCE_BV1);
  t.after(async () => {
    await bob.close();
    await alice.close();
    await stopAuthority(authority);
  });
  await alice.connect();
  await bob.connect();

  await bob.close(); // graceful leave
  const left = await alice.waitForDiagnostic(
    (message) => message.code === 'participant-left' && message.participantId === BOB,
  );
  assert.equal(left.participantId, BOB, 'surviving participant must receive the participant-left diagnostic');
  await waitFor(() => (authority.participantCount === 1 ? true : undefined), 3000, 'participant count 1');
  assert.equal(alice.latest.stateRevision, 0, 'a leave must not mutate playback state');
  const afterLeave = await alice.waitForStatus(
    (status) => status.reason === 'awaiting-second-participant',
    3000,
  );
  assert.equal(afterLeave.ready, false, 'the session must drop back to non-ready when only the host remains');

  // stop() must resolve promptly even though alice is still connected.
  const started = Date.now();
  await withTimeout(authority.stop(), 3000, 'authority stop with a live client');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `authority stop took ${elapsed}ms`);

  // A client close after the server is gone must not hang either.
  await withTimeout(alice.client.close(), 3000, 'client close after server stop');
});

test('invalid intents and malformed messages return error codes and leave state untouched', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority();
  const alice = new Harness(url, sessionId, ALICE, RESOURCE_BV1);
  const bob = new Harness(url, sessionId, BOB, RESOURCE_BV1);
  t.after(async () => {
    await bob.close();
    await alice.close();
    await stopAuthority(authority);
  });
  await alice.connect();
  await bob.connect();

  alice.submit('seek', { targetSeconds: -1 }); // structurally invalid target
  alice.submit('set-rate', { playbackRate: 0 }); // zero rate
  alice.submit('set-rate', { playbackRate: 32 }); // above MAX_PLAYBACK_RATE
  await waitFor(
    () => (
      alice.diagnostics.filter((message) => message.type === 'error' && message.code === 'invalid-intent').length === 3
        ? true
        : undefined
    ),
    3000,
    'three invalid-intent errors on alice',
  );
  const errorCodes = alice.diagnostics.filter((message) => message.type === 'error').map((m) => `${m.code}: ${m.message}`);
  assert.equal(errorCodes.length, 3, errorCodes.join(' | '));

  const raw = await connectRaw(url);
  t.after(() => closeRaw(raw));
  raw.socket.send('this is not json');
  await waitFor(
    () => {
      for (const message of raw.messages) {
        if (rawErrorCode(message) === 'invalid-json') return true;
      }
      return undefined;
    },
    3000,
    'invalid-json error on raw socket',
  );
  rawSend(raw, { type: 'bogus' });
  await waitFor(
    () => {
      for (const message of raw.messages) {
        if (rawErrorCode(message) === 'unknown-message') return true;
      }
      return undefined;
    },
    3000,
    'unknown-message error on raw socket',
  );
  rawSend(raw, { type: 'intent' }); // missing every required field: malformed, rejected before membership
  await waitFor(
    () => {
      for (const message of raw.messages) {
        if (rawErrorCode(message) === 'invalid-intent') return true;
      }
      return undefined;
    },
    3000,
    'invalid-intent error on raw socket',
  );
  // The shape guard never closes the socket: the raw client survives, and a
  // WELL-FORMED intent from a socket that never joined still hits the
  // membership guard (not-joined) — shape-first, then membership.
  assert.equal(raw.socket.readyState, WebSocket.OPEN, 'the raw socket must stay open after a malformed intent');
  rawSend(raw, {
    type: 'intent',
    commandId: 'raw-bystander-1',
    sessionId,
    participantId: 'raw-bystander',
    clientObservedRevision: 0,
    kind: 'play',
    createdAtMs: Date.now(),
  });
  await waitFor(
    () => {
      for (const message of raw.messages) {
        if (rawErrorCode(message) === 'not-joined') return true;
      }
      return undefined;
    },
    3000,
    'not-joined error for a well-formed intent from an unjoined socket',
  );

  assert.equal(alice.latest.stateRevision, 0, `state must be untouched by invalid intents: ${summarize(alice.latest)}`);
  assert.equal(bob.latest.stateRevision, 0, `state must be untouched by invalid intents: ${summarize(bob.latest)}`);
  assert.equal(alice.states.length, 1, 'no state broadcast may follow an invalid intent');
  assert.equal(bob.states.length, 1, 'no state broadcast may follow an invalid intent');

  // The session must still accept valid intents afterwards.
  const playId = alice.submit('play');
  const after = await alice.waitForRevision(1);
  await bob.waitForRevision(1);
  assert.equal(after.stateRevision, 1, summarize(after));
  assert.equal(after.lastSequence, 1, summarize(after));
  assert.equal(after.lastCommandId, playId, summarize(after));
});

test('host approval: the second participant stays pending until accepted; the approval snapshot is decision-time', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority(RESOURCE_BV1, false);
  const alice = new Harness(url, sessionId, ALICE, RESOURCE_BV1);
  t.after(async () => {
    await alice.close();
    await stopAuthority(authority);
  });
  await alice.connect();

  const joiner = await connectRaw(url);
  t.after(() => closeRaw(joiner));
  rawSend(joiner, joinMessage('peer-c', RESOURCE_BV1));

  const request = await alice.waitForJoinRequest((candidate) => candidate.participantId === 'peer-c', 3000);
  assert.deepEqual(request.resourceIdentity, RESOURCE_BV1, 'the host must learn the pending joiner identity');
  // While pending the joiner occupies a seat but is neither counted nor synced.
  assert.equal(authority.participantCount, 1, 'a pending joiner must not be counted');
  assert.equal(alice.states.length, 1, 'a pending joiner must not trigger any state broadcast');
  assert.equal(alice.latest.stateRevision, 0, summarize(alice.latest));

  // A pending joiner cannot act: snapshot requests are not-joined...
  rawSend(joiner, { type: 'snapshot-request', participantId: 'peer-c', observedRevision: 0 });
  await waitFor(
    () => {
      for (const message of joiner.messages) {
        if (rawErrorCode(message) === 'not-joined') return true;
      }
      return undefined;
    },
    3000,
    'not-joined error for a pending joiner snapshot-request',
  );
  // ...and its participant id cannot be claimed by another socket: while the
  // pending seat is occupied, any third socket — even one reusing the pending
  // id — hits session-full.
  const impostor = await connectRaw(url);
  t.after(() => closeRaw(impostor));
  rawSend(impostor, joinMessage('peer-c', RESOURCE_BV1));
  await waitFor(
    () => {
      for (const message of impostor.messages) {
        if (rawJoinRejectedReason(message) === 'session-full') return true;
      }
      return undefined;
    },
    3000,
    'session-full for a third socket claiming the pending id',
  );
  await waitFor(() => (impostor.closeCode === 1008 ? true : undefined), 3000, 'impostor close frame 1008');

  // Intents still adjudicate while a join is pending, and the approval snapshot
  // is decision-time: it must include the pre-approval intent.
  const playId = alice.submit('play');
  await alice.waitForRevision(1);
  assert.equal(alice.latest.stateRevision, 1, 'intents must adjudicate while a join is pending');

  alice.decideJoin(true);
  const accepted = await waitForJoinAccepted(joiner, 3000, 'peer-c join-accepted');
  assert.equal(accepted.role, 'client', 'the accepted second participant must join as a client');
  assert.equal(accepted.state.sessionId, sessionId, 'the accepted joiner must receive the session id');
  assert.equal(accepted.state.stateRevision, 1, 'the approval snapshot must reflect the decision-time state');
  assert.equal(accepted.state.lastCommandId, playId, 'the approval snapshot must include the pre-approval intent');
  assert.deepEqual(accepted.state, alice.latest, 'the accepted joiner must receive the current authoritative snapshot');
  assert.equal(authority.participantCount, 2, 'the accepted joiner must be counted');

  // The session keeps working and both sides converge on new intents.
  const pauseId = alice.submit('pause');
  const after = await alice.waitForRevision(2);
  assert.equal(after.stateRevision, 2, summarize(after));
  assert.equal(after.lastCommandId, pauseId, summarize(after));
  await waitFor(
    () => {
      for (const message of joiner.messages) {
        const state = rawPlaybackState(message, 'state');
        if (state !== undefined && state.stateRevision === 2) return true;
      }
      return undefined;
    },
    3000,
    'peer-c to observe revision 2',
  );
});

test('an identity-less joiner receives the canonical session resource and can report against it', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority(RESOURCE_BV1, false);
  const alice = new Harness(url, sessionId, ALICE, RESOURCE_BV1);
  // No resourceIdentity: this joiner does not know the session resource yet.
  const anon = new Harness(url, sessionId, 'anon-c');
  t.after(async () => {
    await anon.close();
    await alice.close();
    await stopAuthority(authority);
  });
  await alice.connect();

  const soloStatus = await alice.waitForStatus((status) => status.reason === 'awaiting-second-participant', 3000);
  assert.equal(soloStatus.ready, false, 'a solo host session can never be ready');
  assert.equal(soloStatus.stateRevision, 0);
  assert.deepEqual(soloStatus.participants, [
    { participantId: ALICE, role: 'host', reported: false, consistent: false },
  ]);

  // The join-accepted promise only settles once the host decides, so capture it
  // first and drive the approval flow while the joiner is still pending.
  const anonJoin = anon.connect(); // sends a join with no resourceIdentity at all
  const request = await alice.waitForJoinRequest((candidate) => candidate.participantId === 'anon-c', 3000);
  assert.equal('resourceIdentity' in request, false, 'an identity-less joiner must arrive without a resource');
  assert.equal(authority.participantCount, 1, 'the pending joiner must not be counted');
  assert.equal(anon.client.role, undefined, 'the pending joiner must not be joined yet');

  alice.decideJoin(true);
  const anonJoinResult = await anonJoin;
  assert.equal(anonJoinResult.role, 'client', 'the identity-less joiner must join as a client');
  assert.equal(anon.client.role, 'client', 'the identity-less joiner must join as a client');
  const accepted = anon.latest;
  assert.deepEqual(accepted.resourceIdentity, RESOURCE_BV1, 'join-accepted must push the canonical session resource');
  assert.equal(accepted.sessionId, sessionId, 'the pushed state must belong to the session');
  assert.equal(authority.participantCount, 2, 'the accepted joiner must be counted');

  const awaiting = await alice.waitForStatus((status) => status.reason === 'awaiting-actual-state', 3000);
  assert.equal(awaiting.ready, false, 'before both participants report, the session must stay non-ready');

  // Both participants report; the identity-less joiner reports against the
  // resource it adopted from join-accepted.
  alice.reportConsistent();
  anon.reportConsistent();
  const ready = await alice.waitForStatus((status) => status.ready === true, 3000);
  assert.equal(ready.stateRevision, 0);
  assert.equal(ready.reason, undefined);
  const anonEntry = ready.participants.find((participant) => participant.participantId === 'anon-c');
  assert.ok(anonEntry, 'the identity-less joiner must appear in the status');
  assert.equal(anonEntry.reported, true, 'the identity-less joiner must have reported');
  assert.equal(anonEntry.consistent, true, 'the identity-less joiner must be consistent against the pushed resource');
  assert.equal(
    alice.diagnostics.filter((message) => message.type === 'diagnostic' && message.code === 'actual-state-mismatch').length,
    0,
    'the pushed canonical resource must not be diagnosed as a mismatch',
  );
});

test('host rejection: accepted=false rejects the pending joiner with host-declined and the session keeps working', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority(RESOURCE_BV1, false);
  const alice = new Harness(url, sessionId, ALICE, RESOURCE_BV1);
  t.after(async () => {
    await alice.close();
    await stopAuthority(authority);
  });
  await alice.connect();

  const joiner = await connectRaw(url);
  t.after(() => closeRaw(joiner));
  rawSend(joiner, joinMessage('refused-c', RESOURCE_BV1));
  await alice.waitForJoinRequest((candidate) => candidate.participantId === 'refused-c', 3000);

  // While the request is pending the seat is occupied: a third socket is full.
  const third = await connectRaw(url);
  t.after(() => closeRaw(third));
  rawSend(third, joinMessage('third-c', RESOURCE_BV1));
  await waitFor(
    () => {
      for (const message of third.messages) {
        if (rawJoinRejectedReason(message) === 'session-full') return true;
      }
      return undefined;
    },
    3000,
    'session-full for a third socket while a join is pending',
  );
  await waitFor(() => (third.closeCode === 1008 ? true : undefined), 3000, 'third socket close frame 1008');

  alice.decideJoin(false);
  await waitFor(
    () => {
      for (const message of joiner.messages) {
        if (rawJoinRejectedReason(message) === 'host-declined') return true;
      }
      return undefined;
    },
    3000,
    'join-rejected host-declined',
  );
  await waitFor(() => (joiner.closeCode === 1008 ? true : undefined), 3000, 'joiner close frame 1008');
  assert.equal(joiner.closeReason, 'host-declined', 'the close reason must identify the decline');
  assert.equal(authority.participantCount, 1, 'the declined joiner must not be counted');
  assert.equal(alice.latest.stateRevision, 0, 'the declined join must not touch the session state');

  // The host keeps full control and the freed pending seat can be reused.
  const playId = alice.submit('play');
  const after = await alice.waitForRevision(1);
  assert.equal(after.stateRevision, 1, summarize(after));
  assert.equal(after.lastCommandId, playId, summarize(after));

  const second = await connectRaw(url);
  t.after(() => closeRaw(second));
  rawSend(second, joinMessage('later-c', RESOURCE_BV1));
  await alice.waitForJoinRequest((candidate) => candidate.participantId === 'later-c', 3000);
  alice.decideJoin(true);
  const accepted = await waitForJoinAccepted(second, 3000, 'later-c join-accepted');
  assert.equal(accepted.role, 'client', 'the later joiner must be accepted as a client');
  assert.equal(accepted.state.stateRevision, 1, 'the accepted joiner must receive the current snapshot');
  assert.equal(authority.participantCount, 2, 'the accepted later joiner must be counted');
});

test('malformed joins, decisions, and actual-state reports return error codes and never crash the authority', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority(RESOURCE_BV1, false);
  const alice = new Harness(url, sessionId, ALICE, RESOURCE_BV1);
  t.after(async () => {
    await alice.close();
    await stopAuthority(authority);
  });
  await alice.connect();

  let raw = await connectRaw(url);
  t.after(() => closeRaw(raw));

  // Malformed joins: explicit errors, no pending seat, no crash. All three
  // invalid-message cases are sent before the structurally valid foreign
  // identity: the authority closes the socket (policy code 1008) when it
  // rejects that join, so nothing sent after it is ever processed.
  rawSend(raw, { type: 'join' }); // missing participantId
  rawSend(raw, { type: 'join', participantId: 'mal-a', resourceIdentity: null }); // null identity
  rawSend(raw, {
    type: 'join',
    participantId: 'mal-c',
    resourceIdentity: { adapterId: '', canonicalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD' },
  }); // empty adapterId
  rawSend(raw, {
    type: 'join',
    participantId: 'mal-b',
    resourceIdentity: {
      adapterId: 'bilibili',
      canonicalUrl: 'https://example.com/video/BV1xx411c7mD',
      resourceId: 'BV1xx411c7mD',
    },
  }); // structurally valid but foreign identity: rejected as resource-mismatch
  await waitFor(
    () => (raw.messages.filter((message) => rawErrorCode(message) === 'invalid-message').length >= 3 ? true : undefined),
    3000,
    'three invalid-message errors for malformed joins',
  );
  await waitFor(
    () => {
      for (const message of raw.messages) {
        if (rawJoinRejectedReason(message) === 'resource-mismatch') return true;
      }
      return undefined;
    },
    3000,
    'join-rejected resource-mismatch for a structurally valid foreign identity',
  );
  assert.equal(authority.participantCount, 1, 'malformed joins must not occupy a participant or pending seat');
  assert.equal(alice.states.length, 1, 'malformed joins must not touch the session state');

  // The resource-mismatch rejection closed the raw socket, so the rest of the
  // scenario runs on a fresh connection.
  closeRaw(raw);
  raw = await connectRaw(url);
  t.after(() => closeRaw(raw));

  // A well-formed join still flows through the approval path afterwards.
  rawSend(raw, joinMessage('mal-d', RESOURCE_BV1));
  await alice.waitForJoinRequest((candidate) => candidate.participantId === 'mal-d', 3000);
  alice.decideJoin(true);
  const joined = await waitForJoinAccepted(raw, 3000, 'mal-d join-accepted');
  assert.equal(joined.role, 'client');

  // Malformed actual-state reports: explicit errors, never a crash.
  rawSend(raw, { type: 'actual-state' }); // missing every field
  rawSend(raw, { type: 'actual-state', participantId: 'mal-d', observedRevision: 0 }); // missing the rest
  rawSend(raw, {
    type: 'actual-state',
    sessionId,
    participantId: 'mal-d',
    observedRevision: 0,
    resourceIdentity: {
      adapterId: 'bilibili',
      canonicalUrl: 'https://example.com/video/BV1xx411c7mD',
      resourceId: 'BV1xx411c7mD',
    },
    mediaPhase: 'ready',
    positionSeconds: 0,
    positionObservedAtMs: Date.now(),
    playbackRate: 1,
    durationSeconds: null,
    adapterId: 'bilibili',
    applyResult: 'applied',
  }); // foreign but structurally valid identity: diagnosed as actual-state-mismatch
  await waitFor(
    () => (raw.messages.filter((message) => rawErrorCode(message) === 'invalid-message').length >= 2 ? true : undefined),
    3000,
    'two invalid-message errors for malformed actual-state reports',
  );

  // A well-formed report for the wrong session is rejected explicitly.
  rawSend(raw, {
    type: 'actual-state',
    sessionId: 'some-other-session',
    participantId: 'mal-d',
    observedRevision: 0,
    resourceIdentity: RESOURCE_BV1,
    mediaPhase: 'ready',
    positionSeconds: 0,
    positionObservedAtMs: Date.now(),
    playbackRate: 1,
    durationSeconds: null,
    adapterId: 'bilibili',
    applyResult: 'applied',
  });
  await waitFor(
    () => {
      for (const message of raw.messages) {
        if (rawErrorCode(message) === 'session-mismatch') return true;
      }
      return undefined;
    },
    3000,
    'session-mismatch error',
  );

  // join-decision misuse: never joined, not the host, nothing pending.
  const stranger = await connectRaw(url);
  t.after(() => closeRaw(stranger));
  rawSend(stranger, { type: 'join-decision', participantId: 'nobody', accepted: true });
  rawSend(stranger, { type: 'join-decision', participantId: 'nobody' }); // missing accepted field
  rawSend(stranger, {
    type: 'actual-state',
    sessionId,
    participantId: 'nobody',
    observedRevision: 0,
    resourceIdentity: RESOURCE_BV1,
    mediaPhase: 'ready',
    positionSeconds: 0,
    positionObservedAtMs: Date.now(),
    playbackRate: 1,
    durationSeconds: null,
    adapterId: 'bilibili',
    applyResult: 'applied',
  });
  await waitFor(
    () => (stranger.messages.filter((message) => rawErrorCode(message) === 'invalid-message').length >= 1 ? true : undefined),
    3000,
    'invalid-message for a decision without accepted',
  );
  await waitFor(
    () => (stranger.messages.filter((message) => rawErrorCode(message) === 'not-joined').length >= 2 ? true : undefined),
    3000,
    'two not-joined errors on the stranger socket',
  );
  rawSend(raw, { type: 'join-decision', participantId: 'mal-d', accepted: true }); // client, not host
  await waitFor(
    () => {
      for (const message of raw.messages) {
        if (rawErrorCode(message) === 'not-host') return true;
      }
      return undefined;
    },
    3000,
    'not-host error for a client decision',
  );
  alice.decideJoin(true); // host, but nothing is pending
  await waitFor(
    () => (alice.diagnostics.some((message) => message.type === 'error' && message.code === 'no-pending-join') ? true : undefined),
    3000,
    'no-pending-join error on alice',
  );

  // The authority is fully alive: valid intents still adjudicate and the raw
  // client is still connected.
  assert.equal(authority.participantCount, 2, 'only alice and mal-d are joined');
  assert.equal(raw.socket.readyState, WebSocket.OPEN, 'the raw client must still be connected after malformed traffic');
  const playId = alice.submit('play');
  const after = await alice.waitForRevision(1);
  assert.equal(after.stateRevision, 1, summarize(after));
  assert.equal(after.lastSequence, 1, summarize(after));
  assert.equal(after.lastCommandId, playId, summarize(after));
});

test('session-status is ready only when both participants report consistency-clean actual state, and identical statuses are deduped', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority(RESOURCE_BV1);
  const alice = new Harness(url, sessionId, ALICE, RESOURCE_BV1);
  const bob = new Harness(url, sessionId, BOB, RESOURCE_BV1);
  t.after(async () => {
    await bob.close();
    await alice.close();
    await stopAuthority(authority);
  });
  await alice.connect();

  const solo = await alice.waitForStatus((status) => status.reason === 'awaiting-second-participant', 3000);
  assert.equal(solo.ready, false, 'a solo host can never be ready');
  assert.equal(solo.stateRevision, 0);
  assert.deepEqual(solo.participants, [{ participantId: ALICE, role: 'host', reported: false, consistent: false }]);

  await bob.connect();
  const awaiting = await alice.waitForStatus((status) => status.reason === 'awaiting-actual-state', 3000);
  assert.equal(awaiting.ready, false);
  assert.equal(awaiting.participants.length, 2);

  alice.reportConsistent();
  const aliceReported = await alice.waitForStatus(
    (status) => status.ready === false
      && status.reason === 'awaiting-actual-state'
      && status.participants.some((participant) => participant.participantId === ALICE && participant.reported),
    3000,
  );
  assert.equal(
    aliceReported.participants.find((participant) => participant.participantId === BOB)?.reported,
    false,
    'bob must still be unreported',
  );

  bob.reportConsistent();
  const readyRev0 = await alice.waitForStatus((status) => status.ready === true, 3000);
  assert.equal(readyRev0.stateRevision, 0);
  assert.equal(readyRev0.reason, undefined);
  for (const id of [ALICE, BOB] as const) {
    const entry = readyRev0.participants.find((participant) => participant.participantId === id);
    assert.ok(entry, `${id} must appear in the ready status`);
    assert.equal(entry.reported, true, `${id} must have reported`);
    assert.equal(entry.consistent, true, `${id} must be consistent`);
  }

  // A new revision invalidates every stored report: the gate closes again.
  alice.submit('play');
  await alice.waitForRevision(1);
  await bob.waitForRevision(1);
  const invalidated = await alice.waitForStatus((status) => status.stateRevision === 1 && status.ready === false, 3000);
  assert.equal(invalidated.reason, 'awaiting-actual-state', 'new revisions must re-arm the report gate');

  alice.reportConsistent();
  bob.reportConsistent();
  const readyRev1 = await alice.waitForStatus((status) => status.stateRevision === 1 && status.ready === true, 3000);
  assert.equal(readyRev1.reason, undefined);

  // A drifting report closes the gate and marks the reporter inconsistent.
  bob.reportConsistent({
    positionSeconds: bob.latest.positionSeconds + 5,
    positionObservedAtMs: Date.now(),
  });
  const desynced = await alice.waitForStatus(
    (status) => status.ready === false && status.reason === 'actual-state-desync',
    3000,
  );
  assert.equal(desynced.stateRevision, 1);
  const bobEntry = desynced.participants.find((participant) => participant.participantId === BOB);
  assert.ok(bobEntry, 'bob must appear in the desync status');
  assert.equal(bobEntry.reported, true);
  assert.equal(bobEntry.consistent, false);

  // Recovery: a clean report re-opens the gate.
  bob.reportConsistent();
  await waitFor(
    () => (
      alice.statuses[alice.statuses.length - 1]?.ready === true
      && alice.statuses[alice.statuses.length - 1]?.stateRevision === 1
        ? true
        : undefined
    ),
    3000,
    'ready status after recovery',
  );

  // Identical statuses are not rebroadcast: reporting the same ready state a
  // second time must not emit a duplicate frame, and the next real change lands
  // exactly one frame later.
  const statusCountBefore = alice.statuses.length;
  bob.reportConsistent(); // produces the identical status again
  alice.submit('pause');
  await alice.waitForRevision(2);
  await bob.waitForRevision(2);
  const invalidatedRev2 = await alice.waitForStatus((status) => status.stateRevision === 2 && status.ready === false, 3000);
  assert.equal(invalidatedRev2.reason, 'awaiting-actual-state');
  assert.equal(
    alice.statuses.length,
    statusCountBefore + 1,
    'a duplicate ready report must be deduped: exactly one new status frame for revision 2',
  );
  assert.equal(alice.statuses[alice.statuses.length - 1]?.stateRevision, 2, 'the final frame must be the revision-2 status');
});

test('actual-state diagnostics report drift, stale revision, phase/rate and resource mismatch with expected and actual details', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority(RESOURCE_BV1);
  const alice = new Harness(url, sessionId, ALICE, RESOURCE_BV1);
  const bob = new Harness(url, sessionId, BOB, RESOURCE_BV1);
  t.after(async () => {
    await bob.close();
    await alice.close();
    await stopAuthority(authority);
  });
  await alice.connect();
  await bob.connect();

  alice.submit('play');
  await alice.waitForRevision(1);
  await bob.waitForRevision(1);

  // 1. Position drift beyond the 250ms threshold.
  const driftedPosition = bob.latest.positionSeconds + 5;
  bob.reportConsistent({ positionSeconds: driftedPosition, positionObservedAtMs: Date.now() });
  const drift = await alice.waitForDiagnostic(
    (message) => message.code === 'desync' && message.participantId === BOB && message.actual?.positionSeconds === driftedPosition,
    3000,
  );
  assert.equal(drift.stateRevision, 1);
  assert.equal(drift.sessionId, sessionId);
  assert.ok(typeof drift.expected?.positionSeconds === 'number', 'the diagnostic must carry the expected projected position');
  assert.match(drift.detail, /drift/i);
  const desynced = await alice.waitForStatus((status) => status.reason === 'actual-state-desync', 3000);
  assert.equal(desynced.ready, false, 'a drifting report must close the ready gate');

  // 2. A stale report (older revision) is a desync with an explicit detail.
  bob.reportConsistent({ observedRevision: 0 });
  const stale = await alice.waitForDiagnostic(
    (message) => message.code === 'desync' && message.participantId === BOB && /older/i.test(message.detail),
    3000,
  );
  assert.equal(stale.stateRevision, 1);
  // Status precedence after the fix: a stale report counts as a MISSING report
  // (nothing was judged against the current revision), so even a consistency-
  // clean partner cannot make the session ready and the gate reads
  // awaiting-actual-state — not actual-state-desync — until the reporter
  // re-reports the current revision.
  alice.reportConsistent();
  await waitFor(
    () => {
      const latest = alice.statuses[alice.statuses.length - 1];
      return latest !== undefined && latest.reason === 'awaiting-actual-state' && latest.stateRevision === 1
        ? true
        : undefined;
    },
    3000,
    'stale report to demote the gate to awaiting-actual-state',
  );

  // 3. Phase mismatch (authoritative playing vs reported paused) combined with a
  //    rate mismatch: both sides of the comparison are carried in the diagnostic.
  bob.reportConsistent({
    mediaPhase: 'paused',
    playbackRate: 2,
    positionSeconds: bob.latest.positionSeconds,
    positionObservedAtMs: Date.now(),
  });
  const phaseRate = await alice.waitForDiagnostic(
    (message) => message.code === 'desync' && message.participantId === BOB && message.actual?.mediaPhase === 'paused',
    3000,
  );
  assert.equal(phaseRate.expected?.mediaPhase, 'playing', 'the diagnostic must carry the authoritative phase');
  assert.equal(phaseRate.actual?.mediaPhase, 'paused');
  assert.equal(phaseRate.expected?.playbackRate, 1, 'the diagnostic must carry the authoritative rate');
  assert.equal(phaseRate.actual?.playbackRate, 2);
  // The phase/rate report IS judged against the current revision, so the gate
  // re-arms to actual-state-desync: an inconsistent report at the current
  // revision takes priority over the other side's missing-report state.
  await waitFor(
    () => {
      const latest = alice.statuses[alice.statuses.length - 1];
      return latest !== undefined && latest.reason === 'actual-state-desync' && latest.stateRevision === 1
        ? true
        : undefined;
    },
    3000,
    'phase/rate report to re-arm the desync gate',
  );

  // 4. A valid but different Bilibili identity is diagnosed as actual-state-mismatch.
  bob.reportConsistent({ resourceIdentity: RESOURCE_BV2 });
  const resourceMismatch = await alice.waitForDiagnostic(
    (message) => message.code === 'actual-state-mismatch' && message.participantId === BOB,
    3000,
  );
  assert.deepEqual(resourceMismatch.resource?.expected, RESOURCE_BV1);
  assert.deepEqual(resourceMismatch.resource?.actual, RESOURCE_BV2);

  // 5. The reporter's clean report re-opens the gate (alice already reported
  //    clean in step 2) and emits no further diagnostic.
  bob.reportConsistent();
  const readyAgain = await alice.waitForStatus((status) => status.ready === true, 3000);
  assert.equal(readyAgain.stateRevision, 1);
  assert.equal(
    alice.diagnostics.filter((message) => message.type === 'diagnostic' && message.code === 'desync').length,
    3,
    'exactly three desync diagnostics: drift, stale revision, phase/rate',
  );
  assert.equal(
    alice.diagnostics.filter((message) => message.type === 'diagnostic' && message.code === 'actual-state-mismatch').length,
    1,
    'exactly one actual-state-mismatch diagnostic',
  );

  // 6. A rate-only mismatch is readiness-blocking per NFR-001: it emits a
  //    fourth desync diagnostic and keeps the ready gate closed at
  //    actual-state-desync until the reporter corrects the rate.
  bob.reportConsistent({ playbackRate: 2 });
  await waitFor(
    () => {
      const latest = alice.statuses[alice.statuses.length - 1];
      return latest !== undefined && latest.ready === false && latest.reason === 'actual-state-desync' && latest.stateRevision === 1
        ? true
        : undefined;
    },
    3000,
    'rate-only mismatch to close the ready gate with actual-state-desync',
  );
  alice.submit('seek', { targetSeconds: 10 });
  await alice.waitForRevision(2);
  await bob.waitForRevision(2);
  await alice.waitForStatus((status) => status.stateRevision === 2, 3000);
  assert.equal(
    alice.diagnostics.filter((message) => message.type === 'diagnostic' && message.code === 'desync').length,
    4,
    'exactly four desync diagnostics: drift, stale revision, phase/rate, rate-only',
  );
  assert.equal(
    alice.diagnostics.filter((message) => message.type === 'diagnostic' && message.code === 'actual-state-mismatch').length,
    1,
    'the rate-only report must not add a mismatch diagnostic',
  );
  // Status ladder across the scenario: (1) alice solo awaiting-second-participant,
  // (2) bob joined awaiting-actual-state, (3) play invalidates reports at rev 1,
  // (4) drift desync, (5) stale report demotes to awaiting-actual-state,
  // (6) alice's clean report, (7) phase/rate desync, (8) resource-mismatch
  // report produces a status identical to (7) and is deduped, (9) recovery
  // ready, (10) rate-only desync, (11) seek re-arms awaiting-actual-state at
  // rev 2 — ten frames broadcast in total.
  assert.equal(alice.statuses.length, 10, 'rate-only and identical-status frames must be deduped: exactly ten statuses');
  assert.equal(alice.statuses[alice.statuses.length - 1]?.stateRevision, 2);
});

test('a leaving host releases the pending joiner with host-unavailable; a giving-up joiner frees its seat', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority(RESOURCE_BV1, false);
  const alice = new Harness(url, sessionId, ALICE, RESOURCE_BV1);
  t.after(async () => {
    await alice.close();
    await stopAuthority(authority);
  });
  await alice.connect();

  // The host disconnects while a join is pending: the joiner must not hang.
  const joiner = await connectRaw(url);
  t.after(() => closeRaw(joiner));
  rawSend(joiner, joinMessage('waiting-c', RESOURCE_BV1));
  await alice.waitForJoinRequest((candidate) => candidate.participantId === 'waiting-c', 3000);

  await alice.close(); // host leaves without deciding
  await waitFor(
    () => {
      for (const message of joiner.messages) {
        if (rawJoinRejectedReason(message) === 'host-unavailable') return true;
      }
      return undefined;
    },
    3000,
    'join-rejected host-unavailable',
  );
  await waitFor(() => (joiner.closeCode === 1008 ? true : undefined), 3000, 'joiner close frame 1008');
  assert.equal(joiner.closeReason, 'host-unavailable', 'the close reason must identify the abandoned join');
  assert.equal(authority.participantCount, 0, 'the departed host must not linger');

  // A pending joiner that gives up frees the seat silently; the next host can
  // approve a fresh joiner without any hang.
  const dave = new Harness(url, sessionId, 'dave', RESOURCE_BV1);
  t.after(async () => {
    await dave.close();
    await stopAuthority(authority);
  });
  await dave.connect();

  const flaky = await connectRaw(url);
  t.after(() => closeRaw(flaky));
  rawSend(flaky, joinMessage('flaky-c', RESOURCE_BV1));
  await dave.waitForJoinRequest((candidate) => candidate.participantId === 'flaky-c', 3000);
  assert.equal(authority.participantCount, 1, 'the pending joiner must not be counted');
  // The joiner gives up before any decision. Await the close handshake: the
  // server processes the close before it answers the close frame, so once the
  // client sees 'close' the pending seat is provably free again.
  await new Promise<void>((resolve) => {
    flaky.socket.once('close', () => resolve());
    flaky.socket.close();
  });

  const steady = await connectRaw(url);
  t.after(() => closeRaw(steady));
  rawSend(steady, joinMessage('steady-c', RESOURCE_BV1));
  await dave.waitForJoinRequest((candidate) => candidate.participantId === 'steady-c', 3000);
  dave.decideJoin(true);
  const accepted = await waitForJoinAccepted(steady, 3000, 'steady-c join-accepted');
  assert.equal(accepted.role, 'client', 'the steady joiner must be accepted');
  assert.equal(accepted.state.sessionId, sessionId, 'the accepted joiner must receive the session id');
  assert.equal(authority.participantCount, 2, 'the accepted joiner must be counted');
});

test('a stale snapshot is ignored: a withheld snapshot never regresses a client that already advanced', { timeout: 15000 }, async (t) => {
  const { authority, url, sessionId } = await startAuthority(RESOURCE_BV1);
  const proxy = await startSnapshotHoldingProxy(url);
  const alice = new Harness(proxy.url, sessionId, ALICE, RESOURCE_BV1);
  const bob = new Harness(url, sessionId, BOB, RESOURCE_BV1);
  t.after(async () => {
    await bob.close();
    await alice.close();
    await withTimeout(proxy.close(), 3000, 'proxy close').catch(() => {});
    await stopAuthority(authority);
  });
  await alice.connect(); // through the proxy
  await bob.connect(); // directly

  bob.submit('play');
  await alice.waitForRevision(1);
  await bob.waitForRevision(1);
  bob.submit('seek', { targetSeconds: 42.5 });
  await alice.waitForRevision(2);
  await bob.waitForRevision(2);

  // Alice requests a snapshot (revision 2); the proxy withholds the response.
  alice.client.requestSnapshot();
  await waitFor(() => (proxy.held.length === 1 ? true : undefined), 3000, 'proxy to withhold the snapshot');

  // Revision 3 arrives while the snapshot is still withheld.
  bob.submit('pause');
  await alice.waitForRevision(3);
  await bob.waitForRevision(3);
  assert.equal(alice.states.length, 4, 'join-accepted plus three broadcasts');

  // Release the stale snapshot (revision 2) after the client already advanced
  // to revision 3, then advance once more. If the client adopted the stale
  // snapshot its observed history would dip; the follow-up revision proves the
  // guard dropped it and the client kept the newer state.
  proxy.held[0]?.release();
  bob.submit('set-rate', { playbackRate: 2 });
  await alice.waitForRevision(4);
  await bob.waitForRevision(4);

  assert.equal(alice.latest.stateRevision, 4, summarize(alice.latest));
  assert.equal(alice.latest.mediaPhase, 'paused', summarize(alice.latest));
  assert.equal(alice.latest.playbackRate, 2, summarize(alice.latest));
  assert.deepEqual(
    alice.states.map((state) => state.stateRevision),
    [0, 1, 2, 3, 4],
    'the observed history must stay strictly monotonic: a stale snapshot must never be adopted',
  );
  assert.deepEqual(alice.latest, bob.latest, 'both clients must converge on the same authoritative state');
});
