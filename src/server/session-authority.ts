import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { applyIntent, createInitialPlaybackState, projectPlaybackPosition, StateTransitionError } from '../core/playback-state.js';
import { applySyncItemBinding, applySyncItemIntent, syncItemDefinitionsEqual, syncItemValuesEqual, SyncItemTransitionError } from '../core/sync-items.js';
import { evaluateActualState, type ConsistencyResult } from '../core/consistency-monitor.js';
import {
  isActualStateReport,
  isClientJoin,
  isJoinDecision,
  isPlaybackIntent,
  isResourceBindMessage,
  isResourceIdentityEqual,
  isSnapshotRequest,
  isSyncItemBindMessage,
  isSyncItemIntent,
  type ActualStateReport,
  type ClientJoin,
  type ClientMessage,
  type DiagnosticMessage,
  type JoinDecision,
  type PlaybackIntent,
  type PlaybackState,
  type ResourceBindMessage,
  type ResourceIdentity,
  type ServerMessage,
  type SessionParticipantStatus,
  type SessionStatusMessage,
  type SyncItemBindMessage,
  type SyncItemIntent,
} from '../shared/protocol.js';

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

export type AuthorityOptions = {
  host?: string;
  port?: number;
  sessionId?: string;
  /**
   * Optional: the session's media resource. When absent the session starts
   * UNBOUND — state.resourceIdentity is null and playback intents are rejected
   * with 'resource-unbound' — until the first host join carries an identity or
   * a joined participant sends `resource-bind`. When present, joins advertising a
   * different identity are rejected with 'resource-mismatch'.
   */
  resourceIdentity?: ResourceIdentity;
  durationSeconds?: number | null;
  /**
   * When true, the second participant joins immediately without waiting for a
   * host `join-decision`. Intended for CLI smoke tooling only; the default is
   * false so the creator authority always approves joins.
   */
  autoAcceptJoins?: boolean;
  /**
   * Optional human-readable session alias (no whitespace). Joins may address
   * the session by name OR by id — the two are interchangeable on the wire.
   * One CLI process serves exactly one session, so the name is unique there
   * by construction; emptiness/whitespace is rejected at construction.
   */
  sessionName?: string;
};

type Participant = {
  id: string;
  role: 'host' | 'client';
  socket: WebSocket;
};

type ParticipantReport = {
  report: ActualStateReport;
  evaluation: ConsistencyResult;
  /**
   * Consecutive correctable-divergent reports against the CURRENT revision.
   * A resync only fires after RESYNC_CONFIRM_STREAK in a row: single samples
   * during seeks, buffers or page loads are transient and must never force a
   * correction — only a divergence that persists across consecutive samples
   * proves the endpoint is genuinely settled in the wrong state.
   */
  divergentStreak: number;
};

/**
 * Consistency issues a forced resync can actually fix: the authority
 * re-broadcasts its state so the diverging endpoint re-applies it. Stale or
 * mismatched revisions are handled by snapshot recovery, and an apply failure
 * cannot be fixed by re-broadcasting the same state, so neither triggers one.
 */
const CORRECTABLE_ISSUES: Record<string, true> = {
  'position-drift': true,
  'phase-mismatch': true,
  'rate-mismatch': true,
  'duration-mismatch': true,
  'sync-item-mismatch': true,
};

/** Minimum gap between forced resyncs, so a seeking endpoint can settle. */
const RESYNC_COOLDOWN_MS = 2000;

/**
 * Consecutive correctable-divergent reports (against the CURRENT revision)
 * required before a resync fires. With the ~250ms playing-phase report
 * cadence this confirms real drift in under a second, while single samples
 * distorted by a seek, a buffer or page load never accumulate a streak.
 * Transient phases (buffering/seeking) produce no correctable issues at all,
 * so "the state is changing" is exempt by construction.
 */
const RESYNC_CONFIRM_STREAK = 3;

/**
 * How long a resource switch may stay unconfirmed. Every actual-state report
 * carries the reporter's identity, so a healthy switch confirms within one
 * reporting period; the timeout only covers pages that never load.
 */
const TRANSITION_TIMEOUT_MS = 5000;

/**
 * After a CONFIRMED switch, old-resource echoes may still be in flight (slow
 * pages, SPA residue, a late tab activation). For this window further
 * different-identity binds are still ignored; a genuine switch made inside
 * the grace is re-asserted by the extension's persistent-intent retry.
 */
const TRANSITION_GRACE_MS = 1500;

type PendingJoin = {
  socket: WebSocket;
  participantId: string;
  resourceIdentity?: ResourceIdentity;
};

export class SessionAuthority {
  private readonly host: string;
  private readonly port: number;
  private readonly sessionId: string;
  private readonly sessionName: string | undefined;
  private readonly durationSeconds: number | null;
  private readonly autoAcceptJoins: boolean;
  /** Human-readable alias when configured; undefined when the session is id-only. */
  readonly sessionAlias: string | undefined;
  private readonly participants = new Map<WebSocket, Participant>();
  /** Latest actual-state report per joined participant, keyed by socket. */
  private readonly reports = new Map<WebSocket, ParticipantReport>();
  private readonly processedCommands = new Set<string>();
  private pendingJoin: PendingJoin | undefined;
  private lastResyncAtMs = 0;
  private lastStatusKey: string | undefined;
  /** In-flight resource switch: null when stable, target+since while navigating. */
  private transition: { target: ResourceIdentity; sinceMs: number } | null = null;
  private transitionGraceUntilMs = 0;
  private server: WebSocketServer | undefined;
  private state: PlaybackState;

  constructor(options: AuthorityOptions) {
    this.host = options.host ?? '0.0.0.0';
    this.port = options.port ?? 0;
    this.sessionId = options.sessionId ?? randomUUID();
    if (options.sessionName !== undefined) {
      const name = options.sessionName.trim();
      if (name.length === 0 || /\s/.test(name)) {
        throw new Error(`Invalid session name ${JSON.stringify(options.sessionName)} (must be non-empty without whitespace)`);
      }
      this.sessionName = name;
    }
    this.autoAcceptJoins = options.autoAcceptJoins ?? false;
    this.sessionAlias = this.sessionName;
    this.durationSeconds = options.durationSeconds ?? null;
    this.state = createInitialPlaybackState(
      this.sessionId,
      // No identity: the session starts unbound and is bound by the first
      // host join's identity or by a participant `resource-bind`.
      options.resourceIdentity ?? null,
      Date.now(),
      this.durationSeconds,
    );
  }

  async start(): Promise<{ host: string; port: number; sessionId: string; sessionName?: string }> {
    if (this.server) throw new Error('Session authority is already running');
    const server = new WebSocketServer({ host: this.host, port: this.port });
    server.on('connection', (socket) => this.handleConnection(socket));

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const onError = (error: Error) => {
      server.off('listening', onListening);
      server.close();
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    await promise;

    // After startup, a server-level error must not crash the process: if the
    // listener is gone, tear down every participant and free the instance.
    server.on('error', () => {
      if (server.address() === null) {
        for (const socket of this.participants.keys()) socket.terminate();
        this.participants.clear();
        this.server = undefined;
      }
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Session server did not expose a TCP address');
    }
    this.server = server;
    // port may be 0 (ephemeral): report the actually bound port.
    return {
      host: this.host,
      port: address.port,
      sessionId: this.sessionId,
      ...(this.sessionAlias === undefined ? {} : { sessionName: this.sessionAlias }),
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    // Terminate instead of a graceful close handshake so stop() cannot hang on
    // a peer that never acknowledges the close frame.
    for (const socket of this.participants.keys()) socket.terminate();
    this.participants.clear();
    // An unapproved joiner holds a live connection outside `participants`; it
    // must be terminated too, or server.close() waits on it and stop() hangs.
    if (this.pendingJoin) {
      this.pendingJoin.socket.terminate();
      this.pendingJoin = undefined;
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    await promise;
  }

  getState(): PlaybackState {
    return {
      ...this.state,
      resourceIdentity: this.state.resourceIdentity === null ? null : { ...this.state.resourceIdentity },
      ...(this.state.syncItemDefinitions === undefined ? {} : {
        syncItemDefinitions: this.state.syncItemDefinitions.map((definition) => ({ ...definition })),
      }),
      ...(this.state.syncItems === undefined ? {} : { syncItems: { ...this.state.syncItems } }),
    };
  }

  get participantCount(): number {
    return this.participants.size;
  }

  private handleConnection(socket: WebSocket): void {
    socket.on('message', (raw) => {
      void this.handleMessage(socket, raw);
    });
    socket.on('close', () => {
      // A pending joiner that gives up frees its slot silently; the host never
      // receives a decision for a gone joiner.
      if (this.pendingJoin?.socket === socket) this.pendingJoin = undefined;
      const participant = this.participants.get(socket);
      if (!participant) return;
      this.participants.delete(socket);
      this.reports.delete(socket);
      // If the host leaves while a join request is pending, no one can decide:
      // reject the pending joiner explicitly instead of leaving it hanging.
      if (participant.role === 'host' && this.pendingJoin) {
        const abandoned = this.pendingJoin;
        this.pendingJoin = undefined;
        this.send(abandoned.socket, { type: 'join-rejected', reason: 'host-unavailable' });
        abandoned.socket.close(1008, 'host-unavailable');
      }
      this.broadcast({
        type: 'diagnostic',
        code: 'participant-left',
        participantId: participant.id,
        detail: 'Participant disconnected',
      });
      this.broadcastSessionStatus();
    });
  }

  private async handleMessage(socket: WebSocket, raw: RawData): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      this.send(socket, { type: 'error', code: 'invalid-json', message: 'Message must be valid JSON' });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.send(socket, { type: 'error', code: 'invalid-message', message: 'Message must be a JSON object' });
      return;
    }
    // Validated boundary: shape-check the discriminant before trusting the payload.
    if (!('type' in parsed) || typeof parsed.type !== 'string') {
      this.send(socket, { type: 'error', code: 'invalid-message', message: 'Message must be an object with a string type' });
      return;
    }
    const message = parsed as ClientMessage;

    // Messages are adjudicated synchronously in arrival order; that order is
    // the deterministic command order for this session. Every variant is
    // shape-guarded at this boundary so malformed input returns an explicit
    // error and can never reach the state machine or crash the authority.
    try {
      switch (message.type) {
        case 'join':
          if (!isClientJoin(message)) {
            this.send(socket, { type: 'error', code: 'invalid-message', message: 'Malformed join message' });
            return;
          }
          this.handleJoin(socket, message);
          return;
        case 'resource-bind':
          if (!isResourceBindMessage(message)) {
            this.send(socket, { type: 'error', code: 'invalid-message', message: 'Malformed resource-bind message' });
            return;
          }
          this.handleResourceBind(socket, message);
          return;
        case 'join-decision':
          if (!isJoinDecision(message)) {
            this.send(socket, { type: 'error', code: 'invalid-message', message: 'Malformed join-decision message' });
            return;
          }
          this.handleJoinDecision(socket, message);
          return;
        case 'intent':
          if (!isPlaybackIntent(message)) {
            this.send(socket, { type: 'error', code: 'invalid-intent', message: 'Malformed playback intent' });
            return;
          }
          this.handleIntent(socket, message);
          return;
        case 'snapshot-request':
          if (!isSnapshotRequest(message)) {
            this.send(socket, { type: 'error', code: 'invalid-message', message: 'Malformed snapshot-request message' });
            return;
          }
          this.handleSnapshotRequest(socket, message.participantId);
          return;
        case 'actual-state':
          if (!isActualStateReport(message)) {
            this.send(socket, { type: 'error', code: 'invalid-message', message: 'Malformed actual-state report' });
            return;
          }
          this.handleActualState(socket, message);
          return;
        case 'sync-item-bind':
          if (!isSyncItemBindMessage(message)) {
            this.send(socket, { type: 'error', code: 'invalid-message', message: 'Malformed sync-item-bind message' });
            return;
          }
          this.handleSyncItemBind(socket, message);
          return;
        case 'sync-item-intent':
          if (!isSyncItemIntent(message)) {
            this.send(socket, { type: 'error', code: 'invalid-message', message: 'Malformed sync-item-intent message' });
            return;
          }
          this.handleSyncItemIntent(socket, message);
          return;
        default:
          this.send(socket, { type: 'error', code: 'unknown-message', message: 'Unsupported client message' });
      }
    } catch (error) {
      // Defense in depth: no input may crash the authority or leave the
      // connection hanging without an explicit error.
      this.send(socket, {
        type: 'error',
        code: 'internal-error',
        message: error instanceof Error ? error.message : 'Unexpected error while handling message',
      });
    }
  }

  private handleJoin(socket: WebSocket, message: ClientJoin): void {
    const { participantId, resourceIdentity, roleHint } = message;
    // roleHint mutual exclusion: a joiner declaring the client role requires a
    // host to already exist, and a joiner declaring the host role must be the
    // very first participant — a session can never have two hosts. An
    // unapproved (pending) joiner holds the client seat and proves a host is
    // present, so it counts as 'host already exists' too. These checks run
    // BEFORE the seat-occupancy check so the reason stays precise when both
    // conditions would apply. roleHint remains advisory for role ASSIGNMENT:
    // the authority still grants the first participant the host role and the
    // second the client role and echoes the decision in join-accepted.role.
    const hasHost = this.pendingJoin !== undefined
      || [...this.participants.values()].some((participant) => participant.role === 'host');
    if (roleHint === 'client' && this.participants.size === 0) {
      this.send(socket, { type: 'join-rejected', reason: 'host-required' });
      socket.close(1008, 'host-required');
      return;
    }
    if (roleHint === 'host' && hasHost) {
      this.send(socket, { type: 'join-rejected', reason: 'host-already-exists' });
      socket.close(1008, 'host-already-exists');
      return;
    }
    // A pending join occupies a seat: the session holds at most two participants.
    const occupied = this.participants.size + (this.pendingJoin === undefined ? 0 : 1);
    if (occupied >= 2) {
      this.send(socket, { type: 'join-rejected', reason: 'session-full' });
      socket.close(1008, 'session-full');
      return;
    }
    const duplicateId = [...this.participants.values()].some((participant) => participant.id === participantId)
      || this.pendingJoin?.participantId === participantId;
    if (!participantId || duplicateId) {
      this.send(socket, { type: 'join-rejected', reason: 'duplicate-or-empty-participant-id' });
      socket.close(1008, 'invalid-participant-id');
      return;
    }
    // Resource mismatch can only be rejected when the joiner PROACTIVELY
    // supplies an identity AND the session already has a bound resource; an
    // identity-less joiner is evaluated later, when it reports its actual
    // state against the pushed session resource, and an unbound session has
    // nothing to mismatch. roleHint is advisory for the granted role (the
    // authority assigns roles and echoes them in join-accepted.role), but it
    // does gate the mutual-exclusion checks above.
    const sessionIdentity = this.state.resourceIdentity;
    if (resourceIdentity !== undefined && sessionIdentity !== null && !isResourceIdentityEqual(resourceIdentity, sessionIdentity)) {
      this.send(socket, { type: 'join-rejected', reason: 'resource-mismatch' });
      socket.close(1008, 'resource-mismatch');
      return;
    }

    if (this.participants.size === 0) {
      // The first participant creates the session and is its authority. A
      // session started without an identity is bound here by the first host
      // join ('the host page binds its current resource'); the pushed
      // join-accepted state therefore already carries the adopted identity.
      if (sessionIdentity === null && resourceIdentity !== undefined) {
        this.state = { ...this.state, resourceIdentity: { ...resourceIdentity } };
      }
      this.participants.set(socket, { id: participantId, role: 'host', socket });
      this.send(socket, {
        type: 'join-accepted',
        role: 'host',
        participantId,
        state: this.getState(),
      });
      this.broadcastSessionStatus();
      return;
    }

    if (this.autoAcceptJoins) {
      // CLI smoke mode: skip the human approval step.
      this.participants.set(socket, { id: participantId, role: 'client', socket });
      this.send(socket, {
        type: 'join-accepted',
        role: 'client',
        participantId,
        state: this.getState(),
      });
      this.broadcastSessionStatus();
      return;
    }

    // The second participant must be approved by the host before joining.
    this.pendingJoin = {
      socket,
      participantId,
      ...(resourceIdentity === undefined ? {} : { resourceIdentity }),
    };
    const host = this.findHost();
    if (!host) {
      // Defensive: no host exists to decide (it left mid-session). The pending
      // slot is released and the joiner is rejected explicitly.
      this.pendingJoin = undefined;
      this.send(socket, { type: 'join-rejected', reason: 'no-host-available' });
      socket.close(1008, 'no-host-available');
      return;
    }
    this.send(host.socket, {
      type: 'join-request',
      participantId,
      ...(resourceIdentity === undefined ? {} : { resourceIdentity }),
    });
  }

  private handleJoinDecision(socket: WebSocket, decision: JoinDecision): void {
    const participant = this.participants.get(socket);
    if (!participant || participant.id !== decision.participantId) {
      this.send(socket, { type: 'error', code: 'not-joined', message: 'Participant is not joined to this session' });
      return;
    }
    if (participant.role !== 'host') {
      this.send(socket, { type: 'error', code: 'not-host', message: 'Only the host may decide join requests' });
      return;
    }
    const pending = this.pendingJoin;
    if (!pending) {
      this.send(socket, { type: 'error', code: 'no-pending-join', message: 'There is no join request awaiting a decision' });
      return;
    }
    this.pendingJoin = undefined;
    if (!decision.accepted) {
      this.send(pending.socket, { type: 'join-rejected', reason: 'host-declined' });
      pending.socket.close(1008, 'host-declined');
      return;
    }
    this.participants.set(pending.socket, { id: pending.participantId, role: 'client', socket: pending.socket });
    // The joiner may not have known the resource: the accepted state pushes the
    // canonical identity and gives it the full current snapshot.
    this.send(pending.socket, {
      type: 'join-accepted',
      role: 'client',
      participantId: pending.participantId,
      state: this.getState(),
    });
    this.broadcastSessionStatus();
  }

  private findHost(): Participant | undefined {
    for (const participant of this.participants.values()) {
      if (participant.role === 'host') return participant;
    }
    return undefined;
  }

  /**
   * Participant resource (re)binding. Any joined participant — host or client —
   * switches the session media with `resource-bind`: the bind bumps revision
   * and sequence, resets the playhead and phase for the fresh resource, clears
   * stored actual-state reports (old-page reports can neither be judged
   * against nor promote into the new resource), and broadcasts the new state
   * plus session status. Either side may switch videos; the other side follows
   * in its own tab. join-decision remains host-only.
   *
   * Re-binding the EXACT identity the session already holds is idempotent and
   * changes nothing: both ends can legitimately bind the same resource
   * concurrently (each side's content-ready fires after the same navigation),
   * and a second identical bind must not bump the revision or reset the
   * playhead, or it would invalidate the state the first bind just pushed.
   * Different identities still switch in order below.
   */
  private handleResourceBind(socket: WebSocket, message: ResourceBindMessage): void {
    const participant = this.participants.get(socket);
    if (!participant || participant.id !== message.participantId) {
      this.send(socket, { type: 'error', code: 'not-joined', message: 'Participant is not joined to this session' });
      return;
    }
    this.expireTransition();
    // Idempotent no-op: an identical bind cannot change anything, so it must
    // not bump the revision nor reset the playhead. An unbound session has no
    // identity to compare and still adopts the bind below.
    const sessionIdentity = this.state.resourceIdentity;
    if (sessionIdentity !== null && isResourceIdentityEqual(message.resourceIdentity, sessionIdentity)) {
      return;
    }
    // Transition lock: while a resource switch is in flight (until every
    // participant reports the NEW identity, or the timeout expires) further
    // DIFFERENT identities are ignored. Reports from a page still sitting on
    // the old resource are navigation echoes, not user intent — accepting them
    // is what produced the X/Y oscillation. The echo never re-binds: the
    // extension filters its own commanded navigations, and a genuine switch
    // made during the transition re-binds with a persistent-intent retry that
    // survives past the timeout below. A short grace period AFTER a confirmed
    // switch absorbs late echoes of the OLD resource the same way.
    if (this.transition !== null || Date.now() < this.transitionGraceUntilMs) {
      this.send(socket, { type: 'state', state: this.getState() });
      return;
    }
    const nowMs = Date.now();
    const { errorCode: _previousErrorCode, syncItemDefinitions: _previousDefinitions, syncItems: _previousItems, ...stateWithoutResourceState } = this.state;
    this.state = {
      ...stateWithoutResourceState,
      resourceIdentity: { ...message.resourceIdentity },
      stateRevision: this.state.stateRevision + 1,
      lastSequence: this.state.lastSequence + 1,
      mediaPhase: 'ready',
      positionSeconds: 0,
      positionAtMs: nowMs,
      playbackRate: 1,
      // The new resource's duration is unknown until a participant reports it.
      durationSeconds: null,
      lastCommandId: null,
      updatedAtMs: nowMs,
    };
    this.transition = { target: { ...message.resourceIdentity }, sinceMs: nowMs };
    this.reports.clear();
    this.broadcast({ type: 'state', state: this.getState() });
    this.broadcastSessionStatus();
  }

  /**
   * A resource switch is CONFIRMED only when every joined participant has
   * reported an actual state carrying the target identity — the periodic
   * actual-state stream is the completion signal, so no extra message exists.
   * A timeout force-unlocks so a page that never loads cannot deadlock the
   * session; the target stays bound either way.
   */
  private checkTransitionUnlock(): void {
    const transition = this.transition;
    if (transition === null) return;
    if (Date.now() - transition.sinceMs > TRANSITION_TIMEOUT_MS) {
      this.transition = null;
      return;
    }
    for (const socket of this.participants.keys()) {
      const entry = this.reports.get(socket);
      if (entry === undefined) return;
      if (!isResourceIdentityEqual(entry.report.resourceIdentity, transition.target)) return;
    }
    // Confirmed: keep rejecting OLD-resource echoes for a short grace window.
    // (The timeout-unlock path above deliberately grants no grace — it already
    // waited the full timeout for a switch that never confirmed.)
    this.transition = null;
    this.transitionGraceUntilMs = Date.now() + TRANSITION_GRACE_MS;
  }

  private expireTransition(): void {
    if (this.transition !== null && Date.now() - this.transition.sinceMs > TRANSITION_TIMEOUT_MS) {
      this.transition = null;
    }
  }

  /**
   * True when a wire message addresses THIS session by id or (when configured)
   * by its human-readable name — the two are interchangeable.
   */
  private acceptsSessionId(sessionId: string): boolean {
    return sessionId === this.sessionId
      || (this.sessionName !== undefined && sessionId === this.sessionName);
  }

  private handleSyncItemBind(socket: WebSocket, message: SyncItemBindMessage): void {
    const participant = this.participants.get(socket);
    if (!participant || participant.id !== message.participantId) {
      this.send(socket, { type: 'error', code: 'not-joined', message: 'Participant is not joined to this session' });
      return;
    }
    if (participant.role !== 'host') {
      this.send(socket, { type: 'error', code: 'not-host', message: 'Only the host may bind sync items' });
      return;
    }
    const currentDefinitions = this.state.syncItemDefinitions;
    if (currentDefinitions !== undefined) {
      if (!syncItemDefinitionsEqual(currentDefinitions, message.definitions)) {
        this.send(socket, { type: 'error', code: 'sync-item-mismatch', message: 'Sync item definitions are already bound' });
        return;
      }
      if (!syncItemValuesEqual(this.state.syncItems, message.values)) {
        this.send(socket, { type: 'state', state: this.getState() });
      }
      return;
    }
    try {
      this.state = applySyncItemBinding(this.state, message.definitions, message.values);
      this.broadcast({ type: 'state', state: this.getState() });
      this.broadcastSessionStatus();
    } catch (error) {
      if (error instanceof SyncItemTransitionError) {
        this.send(socket, { type: 'error', code: error.code, message: error.message });
        return;
      }
      this.send(socket, { type: 'error', code: 'sync-item-failed', message: 'Unable to bind sync items' });
    }
  }

  private handleSyncItemIntent(socket: WebSocket, intent: SyncItemIntent): void {
    const participant = this.participants.get(socket);
    if (!participant || participant.id !== intent.participantId || !this.acceptsSessionId(intent.sessionId)) {
      this.send(socket, { type: 'error', code: 'not-joined', message: 'Participant is not joined to this session' });
      return;
    }
    if (this.processedCommands.has(intent.commandId)) {
      this.send(socket, { type: 'state', state: this.getState() });
      return;
    }
    try {
      const nextState = applySyncItemIntent(this.state, intent);
      this.processedCommands.add(intent.commandId);
      if (nextState === this.state) {
        this.send(socket, { type: 'state', state: this.getState() });
        return;
      }
      this.state = nextState;
      this.broadcast({ type: 'state', state: this.getState() });
      this.broadcastSessionStatus();
    } catch (error) {
      if (error instanceof SyncItemTransitionError) {
        this.send(socket, { type: 'error', code: error.code, message: error.message });
        return;
      }
      this.send(socket, { type: 'error', code: 'sync-item-failed', message: 'Unable to apply sync item intent' });
    }
  }

  private handleIntent(socket: WebSocket, intent: PlaybackIntent): void {
    const participant = this.participants.get(socket);
    if (!participant || participant.id !== intent.participantId || !this.acceptsSessionId(intent.sessionId)) {
      this.send(socket, { type: 'error', code: 'not-joined', message: 'Participant is not joined to this session' });
      return;
    }
    if (this.processedCommands.has(intent.commandId)) {
      // Duplicate command: acknowledge with the current state, never re-apply.
      this.send(socket, { type: 'state', state: this.getState() });
      return;
    }
    // Idempotent no-op for phase-identical intents: a slow endpoint's echo
    // (or a duplicate user click) must not bump the revision and invalidate
    // every stored actual-state report for a state that does not change.
    const isPhaseNoOp = (intent.kind === 'play' && this.state.mediaPhase === 'playing')
      || (intent.kind === 'pause' && (this.state.mediaPhase === 'paused' || this.state.mediaPhase === 'ready'));
    if (isPhaseNoOp) {
      this.processedCommands.add(intent.commandId);
      this.send(socket, { type: 'state', state: this.getState() });
      return;
    }

    try {
      // The state machine compares intent.sessionId against state.sessionId
      // (the real id); a joiner addressing the session by NAME passes the
      // acceptsSessionId gate above, so normalize before applying.
      const wireIntent = intent.sessionId === this.sessionId
        ? intent
        : { ...intent, sessionId: this.sessionId };
      const nextState = applyIntent(this.state, wireIntent, Date.now());
      this.processedCommands.add(intent.commandId);
      this.state = nextState;
      this.broadcast({ type: 'state', state: this.getState() });
      // The new revision invalidates every stored actual-state report, so the
      // session can no longer be ready until both participants re-report.
      this.broadcastSessionStatus();
    } catch (error) {
      if (error instanceof StateTransitionError) {
        this.send(socket, { type: 'error', code: error.code, message: error.message });
        return;
      }
      this.send(socket, { type: 'error', code: 'intent-failed', message: 'Unable to apply playback intent' });
    }
  }

  private handleSnapshotRequest(socket: WebSocket, participantId: string): void {
    const participant = this.participants.get(socket);
    if (!participant || participant.id !== participantId) {
      this.send(socket, { type: 'error', code: 'not-joined', message: 'Participant is not joined to this session' });
      return;
    }
    this.send(socket, { type: 'snapshot', state: this.getState() });
  }

  private handleActualState(socket: WebSocket, report: ActualStateReport): void {
    const participant = this.participants.get(socket);
    if (!participant || participant.id !== report.participantId) {
      this.send(socket, { type: 'error', code: 'not-joined', message: 'Participant is not joined to this session' });
      return;
    }
    if (!this.acceptsSessionId(report.sessionId)) {
      this.send(socket, { type: 'error', code: 'session-mismatch', message: 'Actual state report belongs to another session' });
      return;
    }

    // A terminal media phase is an observed shared transition, not merely a
    // local diagnostic. Promote it to one authoritative revision so every
    // endpoint receives the same phase — but only when the report is for the
    // CURRENT revision AND the CURRENT resource: a stale page echoing the new
    // revision against its old resource must never overwrite the newly bound
    // resource's state, and an unbound session has nothing to promote.
    // Buffering is deliberately NOT promoted: it is a transient, single-ended
    // lifecycle state, and promoting one endpoint's momentary buffer would
    // rewrite the global authority phase, pulling the other endpoint into
    // 'buffering' (jitter) while the media is actually in sync. The transient
    // phase is instead judged compatible by the consistency evaluation.
    // Stored reports are invalidated after a bind because the new revision
    // must be observed by both endpoints again.
    const observedPhase = report.mediaPhase;
    const sessionIdentity = this.state.resourceIdentity;
    const promotesPhase = sessionIdentity !== null
      && isResourceIdentityEqual(report.resourceIdentity, sessionIdentity)
      && report.observedRevision === this.state.stateRevision
      && report.applyResult === 'applied'
      && ['ended', 'error'].includes(observedPhase)
      && observedPhase !== this.state.mediaPhase;
    if (promotesPhase) {
      const { errorCode: _previousErrorCode, ...stateWithoutError } = this.state;
      const nextRevision = this.state.stateRevision + 1;
      this.state = {
        ...stateWithoutError,
        stateRevision: nextRevision,
        lastSequence: this.state.lastSequence + 1,
        mediaPhase: observedPhase,
        positionSeconds: report.positionSeconds,
        positionAtMs: report.positionObservedAtMs,
        updatedAtMs: Date.now(),
        lastCommandId: `observation:${participant.id}:${nextRevision}`,
        ...(observedPhase === 'error' && report.error !== undefined ? { errorCode: report.error } : {}),
      };
      this.reports.clear();
      this.broadcast({ type: 'state', state: this.getState() });
      this.broadcastSessionStatus();
      return;
    }
    // The observation instant is approximated by ARRIVAL time on the
    // authority's own clock: report.positionObservedAtMs comes from the
    // endpoint's machine, and cross-device clock skew would leak straight
    // into the projected position and produce permanent fake drift. LAN
    // transit delay (<10ms) is the only error this reintroduces.
    const evaluation = evaluateActualState(this.state, report, Date.now());
    // Store the report even when inconsistent: staleness is judged against the
    // CURRENT revision at session-status time, and the diagnostic stays useful.
    // The divergent streak only accumulates for reports against the CURRENT
    // revision carrying a correctable issue; anything else (stale echo,
    // transient phase, clean state) resets it.
    const previous = this.reports.get(socket);
    const streakCarry = previous !== undefined && previous.report.observedRevision === this.state.stateRevision
      ? previous.divergentStreak
      : 0;
    const divergentStreak = report.observedRevision === this.state.stateRevision
      && report.applyResult === 'applied'
      && evaluation.issues.some((issue) => CORRECTABLE_ISSUES[issue.kind] === true)
      ? streakCarry + 1
      : 0;
    this.reports.set(socket, { report, evaluation, divergentStreak });
    this.checkTransitionUnlock();
    if (!evaluation.consistent) {
      this.broadcast(this.buildDesyncDiagnostic(participant, report, evaluation));
    }
    if (this.shouldTriggerResync(socket, report, evaluation)) {
      this.triggerResync();
      return;
    }
    this.broadcastSessionStatus();
  }

  /**
   * Periodic-sync enforcement: a divergence against the CURRENT revision that
   * PERSISTS across RESYNC_CONFIRM_STREAK consecutive reports (drift beyond
   * the 250ms tolerance, or a discrete phase/rate/duration/item mismatch)
   * triggers ONE forced resync — the authority re-broadcasts its state under
   * a new revision so the diverging endpoint re-applies it. Single samples
   * distorted by a seek, buffer or page load never fire (streak resets on any
   * clean/transient/stale report); drift within the tolerance never counts;
   * stale reports are handled by snapshot recovery; apply failures cannot be
   * fixed by re-broadcasting; and the cooldown lets a seeking endpoint settle
   * before another resync can fire.
   */
  private shouldTriggerResync(socket: WebSocket, report: ActualStateReport, evaluation: ConsistencyResult): boolean {
    if (Date.now() - this.lastResyncAtMs < RESYNC_COOLDOWN_MS) return false;
    if (report.observedRevision !== this.state.stateRevision) return false;
    if (report.applyResult !== 'applied') return false;
    // A report from a DIFFERENT resource (an endpoint that navigated away or
    // is still loading the fresh resource) cannot be corrected by
    // re-broadcasting: the routing layer must navigate it back. Re-syncing
    // here would also let a transitioning page ping-pong the revision.
    const sessionIdentity = this.state.resourceIdentity;
    if (sessionIdentity !== null && !isResourceIdentityEqual(report.resourceIdentity, sessionIdentity)) return false;
    // Persistence gate: a single divergent sample is noise (seek, buffer,
    // decode hiccup) and only surfaces as a diagnostic. The resync fires when
    // the divergence PERSISTS across consecutive samples for this revision.
    const streak = this.reports.get(socket)?.divergentStreak ?? 0;
    return streak >= RESYNC_CONFIRM_STREAK;
  }

  private triggerResync(): void {
    const nowMs = Date.now();
    const nextRevision = this.state.stateRevision + 1;
    const { errorCode: _previousErrorCode, ...stateWithoutError } = this.state;
    this.state = {
      ...stateWithoutError,
      stateRevision: nextRevision,
      lastSequence: this.state.lastSequence + 1,
      lastCommandId: `resync:${nextRevision}`,
      updatedAtMs: nowMs,
    };
    this.lastResyncAtMs = nowMs;
    this.reports.clear();
    this.broadcast({ type: 'state', state: this.getState() });
    this.broadcastSessionStatus();
  }

  private buildDesyncDiagnostic(
    participant: Participant,
    report: ActualStateReport,
    evaluation: ConsistencyResult,
  ): DiagnosticMessage {
    const sessionIdentity = this.state.resourceIdentity;
    const resourceMismatch = sessionIdentity !== null && evaluation.issues.some(
      (issue) => issue.kind === 'resource-mismatch' || issue.kind === 'adapter-mismatch',
    );
    return {
      type: 'diagnostic',
      code: resourceMismatch ? 'actual-state-mismatch' : 'desync',
      participantId: participant.id,
      detail: evaluation.issues.map((issue) => issue.detail).join('; ')
        || 'Actual state diverges from the authoritative state',
      sessionId: this.sessionId,
      stateRevision: this.state.stateRevision,
      // The resource comparison embeds concrete identities, which the wire
      // guard requires; an unbound session has no expected identity to compare.
      ...(sessionIdentity === null
        ? {}
        : { resource: { expected: sessionIdentity, actual: report.resourceIdentity } }),
      expected: {
        mediaPhase: this.state.mediaPhase,
        positionSeconds: projectPlaybackPosition(this.state, Date.now()),
        playbackRate: this.state.playbackRate,
        ...(this.state.syncItems === undefined ? {} : { syncItems: this.state.syncItems }),
      },
      actual: {
        mediaPhase: report.mediaPhase,
        positionSeconds: report.positionSeconds,
        playbackRate: report.playbackRate,
        ...(report.syncItems === undefined ? {} : { syncItems: report.syncItems }),
      },
    };
  }

  /**
   * Broadcast session readiness, but only when it actually changed, so steady
   * actual-state reports do not flood the session with identical status frames.
   */
  private broadcastSessionStatus(): void {
    const message = this.buildSessionStatus();
    const key = JSON.stringify(message);
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.broadcast(message);
  }

  private buildSessionStatus(): SessionStatusMessage {
    const participants: SessionParticipantStatus[] = [];
    for (const [socket, participant] of this.participants) {
      const entry = this.reports.get(socket);
      const reported = entry !== undefined && entry.report.observedRevision === this.state.stateRevision;
      const consistent = reported && entry !== undefined && entry.evaluation.consistent;
      participants.push({
        participantId: participant.id,
        role: participant.role,
        reported,
        consistent,
      });
    }

    let ready = true;
    let reason: string | undefined;
    if (participants.length < 2) {
      ready = false;
      reason = 'awaiting-second-participant';
    } else {
      // A report that is inconsistent against the CURRENT revision takes
      // priority over a missing report: a diagnosed desync must not be masked
      // as awaiting-actual-state just because the other side has not
      // re-reported yet. Stale reports (evaluation from an older revision)
      // stay in the missing bucket: nothing has been judged against the
      // current revision.
      const inconsistent = participants.find((status) => status.reported && !status.consistent);
      if (inconsistent) {
        ready = false;
        reason = 'actual-state-desync';
      } else {
        const missing = participants.find((status) => !status.reported);
        if (missing) {
          ready = false;
          reason = 'awaiting-actual-state';
        }
      }
    }

    return {
      type: 'session-status',
      sessionId: this.sessionId,
      ready,
      ...(reason === undefined ? {} : { reason }),
      stateRevision: this.state.stateRevision,
      participants,
    };
  }

  private broadcast(message: ServerMessage): void {
    for (const socket of this.participants.keys()) this.send(socket, message);
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}
