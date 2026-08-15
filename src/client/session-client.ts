import WebSocket from 'ws';
import {
  isDiagnosticMessage,
  isErrorMessage,
  isJoinAcceptedMessage,
  isJoinRequestMessage,
  isPlaybackState,
  isSessionStatus,
} from '../shared/protocol.js';
import type {
  ActualStateReport,
  ClientMessage,
  IntentKind,
  PlaybackIntent,
  PlaybackState,
  ResourceBindMessage,
  ResourceIdentity,
  ServerMessage,
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

export type SessionClientOptions = {
  url: string;
  sessionId: string;
  participantId: string;
  /**
   * Optional: the joiner's declared role ('host' or 'client'). Advisory: the
   * authority assigns the first participant the host role and the second the
   * client role, and echoes the decision in join-accepted.role.
   */
  roleHint?: 'host' | 'client';
  /**
   * Optional: a joiner may not know the session resource yet. When absent, the
   * identity is adopted from the join-accepted state pushed by the authority,
   * and follows later `resource-bind` state broadcasts.
   */
  resourceIdentity?: ResourceIdentity;
};

type StateListener = (state: PlaybackState) => void;
type DiagnosticListener = (message: ServerMessage) => void;
type SessionStatusMessage = Extract<ServerMessage, { type: 'session-status' }>;
type SessionStatusListener = (status: SessionStatusMessage) => void;
type JoinRequestMessage = Extract<ServerMessage, { type: 'join-request' }>;
type JoinRequestListener = (request: JoinRequestMessage) => void;
type JoinAccepted = Extract<ServerMessage, { type: 'join-accepted' }>;

export class SessionClient {
  private readonly options: SessionClientOptions;
  private socket: WebSocket | undefined;
  private latestState: PlaybackState | undefined;
  private joinedRole: 'host' | 'client' | undefined;
  private latestStatus: SessionStatusMessage | undefined;
  private stateListeners: StateListener[] = [];
  private diagnosticListeners: DiagnosticListener[] = [];
  private sessionStatusListeners: SessionStatusListener[] = [];
  private joinRequestListeners: JoinRequestListener[] = [];
  private joinResolve: ((message: JoinAccepted) => void) | undefined;
  private joinReject: ((error: Error) => void) | undefined;
  private nextCommandNumber = 0;

  constructor(options: SessionClientOptions) {
    this.options = options;
  }

  async connect(): Promise<JoinAccepted> {
    if (this.socket) throw new Error('Session client is already connected');
    const socket = new WebSocket(this.options.url);
    this.socket = socket;

    const { promise, resolve, reject } = Promise.withResolvers<JoinAccepted>();
    this.joinResolve = resolve;
    this.joinReject = reject;

    socket.on('message', (raw) => this.handleMessage(raw.toString()));
    socket.on('error', (error) => {
      if (!this.joinReject) return;
      this.rejectJoin(new Error(`Connection failed: ${error.message}`));
    });
    socket.on('close', (code, reason) => {
      this.socket = undefined;
      if (!this.joinReject) return;
      const detail = reason.toString() || `code ${code}`;
      this.rejectJoin(new Error(`Connection closed before join was accepted (${detail})`));
    });
    socket.once('open', () => {
      const join: ClientMessage = {
        type: 'join',
        participantId: this.options.participantId,
        ...(this.options.resourceIdentity === undefined ? {} : { resourceIdentity: this.options.resourceIdentity }),
        ...(this.options.roleHint === undefined ? {} : { roleHint: this.options.roleHint }),
      };
      socket.send(JSON.stringify(join));
    });
    return promise;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    if (socket.readyState === WebSocket.CLOSED) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    socket.once('close', () => resolve());
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1000, 'client-close');
    } else {
      // CONNECTING / CLOSING: a close frame cannot be sent or would never be
      // acknowledged; force the socket down so 'close' fires promptly.
      socket.terminate();
    }
    const forceClose = setTimeout(() => socket.terminate(), 1000);
    forceClose.unref();
    try {
      await promise;
    } finally {
      clearTimeout(forceClose);
    }
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.push(listener);
    return () => {
      this.stateListeners = this.stateListeners.filter((candidate) => candidate !== listener);
    };
  }

  onDiagnostic(listener: DiagnosticListener): () => void {
    this.diagnosticListeners.push(listener);
    return () => {
      this.diagnosticListeners = this.diagnosticListeners.filter((candidate) => candidate !== listener);
    };
  }

  onSessionStatus(listener: SessionStatusListener): () => void {
    this.sessionStatusListeners.push(listener);
    return () => {
      this.sessionStatusListeners = this.sessionStatusListeners.filter((candidate) => candidate !== listener);
    };
  }

  /** Hosts use this to learn about a pending second participant. */
  onJoinRequest(listener: JoinRequestListener): () => void {
    this.joinRequestListeners.push(listener);
    return () => {
      this.joinRequestListeners = this.joinRequestListeners.filter((candidate) => candidate !== listener);
    };
  }

  /** Latest session readiness broadcast, or undefined before the first one. */
  get sessionStatus(): SessionStatusMessage | undefined {
    return this.latestStatus;
  }

  /** Role granted at join time ('host' for the first participant). */
  get role(): 'host' | 'client' | undefined {
    return this.joinedRole;
  }

  /** Hosts decide the pending join request; non-hosts are rejected by the authority. */
  sendJoinDecision(accepted: boolean): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Session client is not connected');
    const decision: ClientMessage = {
      type: 'join-decision',
      participantId: this.options.participantId,
      accepted,
    };
    socket.send(JSON.stringify(decision));
  }

  /**
   * Hosts bind (or switch) the session's media resource; clients and unjoined
   * sockets are rejected by the authority. On success the authority broadcasts
   * a bumped-revision state carrying the newly bound identity, which this
   * client adopts like any other state broadcast.
   */
  sendResourceBind(resourceIdentity: ResourceIdentity): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Session client is not connected');
    const message: ResourceBindMessage = {
      type: 'resource-bind',
      participantId: this.options.participantId,
      resourceIdentity,
    };
    socket.send(JSON.stringify(message));
  }

  get state(): PlaybackState | undefined {
    return this.latestState;
  }

  submitIntent(
    kind: IntentKind,
    payload?: PlaybackIntent['payload'],
    commandId = `${this.options.participantId}-${++this.nextCommandNumber}`,
  ): string {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Session client is not connected');
    const message: PlaybackIntent = {
      type: 'intent',
      commandId,
      sessionId: this.options.sessionId,
      participantId: this.options.participantId,
      clientObservedRevision: this.latestState?.stateRevision ?? 0,
      kind,
      ...(payload === undefined ? {} : { payload }),
      createdAtMs: Date.now(),
    };
    socket.send(JSON.stringify(message));
    return commandId;
  }

  requestSnapshot(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Session client is not connected');
    const request: ClientMessage = {
      type: 'snapshot-request',
      participantId: this.options.participantId,
      observedRevision: this.latestState?.stateRevision ?? 0,
    };
    socket.send(JSON.stringify(request));
  }

  reportActualState(
    report: Omit<ActualStateReport, 'type' | 'sessionId' | 'participantId' | 'resourceIdentity' | 'adapterId'>
      & { resourceIdentity?: ResourceIdentity; adapterId?: string },
  ): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Session client is not connected');
    // Resolve the report identity against the LATEST authoritative state,
    // which follows resource-binds and may be null while the session is
    // unbound; an unbound state falls through to the client option, and the
    // report is refused only when no concrete identity is known at all.
    const adoptedIdentity = this.latestState?.resourceIdentity ?? undefined;
    const identity = report.resourceIdentity ?? adoptedIdentity ?? this.options.resourceIdentity;
    if (!identity) {
      throw new Error('Session client has no resource identity; wait for join-accepted or a host resource-bind to bind the session resource');
    }
    const message: ActualStateReport = {
      ...report,
      type: 'actual-state',
      sessionId: this.options.sessionId,
      participantId: this.options.participantId,
      resourceIdentity: identity,
      adapterId: report.adapterId ?? identity.adapterId,
    };
    socket.send(JSON.stringify(message));
  }

  async waitForRevision(revision: number, timeoutMs = 2000): Promise<PlaybackState> {
    if (this.latestState && this.latestState.stateRevision >= revision) return this.latestState;
    const { promise, resolve, reject } = Promise.withResolvers<PlaybackState>();
    let unsubscribe: () => void = () => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for state revision ${revision}`));
    }, timeoutMs);
    unsubscribe = this.onState((state) => {
      if (state.stateRevision < revision) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(state);
    });
    return promise;
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.rejectJoin(new Error(`Invalid server message: ${String(error)}`));
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.rejectJoin(new Error('Invalid server message: expected a JSON object'));
      return;
    }
    // Validated boundary: shape-check the discriminant before trusting the payload.
    if (!('type' in parsed) || typeof parsed.type !== 'string') {
      this.rejectJoin(new Error('Invalid server message: expected an object with a string type'));
      return;
    }
    const message = parsed as ServerMessage;

    switch (message.type) {
      case 'join-accepted': {
        if (!isJoinAcceptedMessage(message)) {
          this.rejectJoin(new Error('Invalid join-accepted message'));
          return;
        }
        if (message.participantId !== this.options.participantId || message.state.sessionId !== this.options.sessionId) {
          this.rejectJoin(new Error('Join accepted for a different participant or session'));
          return;
        }
        this.joinedRole = message.role;
        // The authority is authoritative about the resource: the pushed state
        // (possibly null-identity while unbound) becomes the reference for
        // actual-state reports; later resource-bind broadcasts update it.
        this.acceptState(message.state);
        this.joinResolve?.(message);
        this.clearJoinHandlers();
        return;
      }
      case 'join-rejected': {
        if (typeof message.reason !== 'string') {
          this.rejectJoin(new Error('Invalid join-rejected message'));
          return;
        }
        this.rejectJoin(new Error(`Join rejected: ${message.reason}`));
        return;
      }
      case 'join-request': {
        if (!isJoinRequestMessage(message)) return;
        for (const listener of this.joinRequestListeners) listener(message);
        return;
      }
      case 'state': {
        if (!isPlaybackState(message.state) || message.state.sessionId !== this.options.sessionId) return;
        this.acceptState(message.state);
        return;
      }
      case 'snapshot': {
        if (!isPlaybackState(message.state) || message.state.sessionId !== this.options.sessionId) return;
        this.acceptState(message.state, true);
        return;
      }
      case 'session-status': {
        if (!isSessionStatus(message)) return;
        this.latestStatus = message;
        for (const listener of this.sessionStatusListeners) listener(message);
        return;
      }
      default:
        // Diagnostics and errors; anything else on the wire is ignored.
        if (isDiagnosticMessage(message) || isErrorMessage(message)) {
          for (const listener of this.diagnosticListeners) listener(message);
        }
        return;
    }
  }

  private acceptState(state: PlaybackState, isSnapshot = false): void {
    const currentRevision = this.latestState?.stateRevision ?? -1;
    // Stale states must never overwrite newer authoritative state — live
    // broadcasts and snapshots alike are rejected when not strictly newer.
    if (state.stateRevision <= currentRevision) return;
    // A version gap means missed messages: request the full snapshot instead of
    // guessing the missing operations, and never adopt the gap state first.
    if (!isSnapshot && state.stateRevision > currentRevision + 1) {
      this.requestSnapshot();
      return;
    }
    this.latestState = state;
    this.emitState(state);
  }

  private emitState(state: PlaybackState): void {
    for (const listener of this.stateListeners) listener(state);
  }

  private rejectJoin(error: Error): void {
    this.joinReject?.(error);
    this.clearJoinHandlers();
  }

  private clearJoinHandlers(): void {
    this.joinResolve = undefined;
    this.joinReject = undefined;
  }
}
