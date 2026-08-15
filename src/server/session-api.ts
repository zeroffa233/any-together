import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { SessionAuthority } from './session-authority.js';
import type { ResourceIdentity } from '../shared/protocol.js';

export type SessionApiOptions = {
  /**
   * Read-only handle to the session authority. The API only reads `getState()`
   * to answer GET /api/session; it never sends messages, never binds the
   * resource, and never touches media or authoritative state.
   */
  authority: SessionAuthority;
  /** Port the session WebSocket listens on; reported in every payload. */
  wsPort: number;
  /** API listen port; defaults to `wsPort + 1`. */
  port?: number;
  /** Listen host; defaults to 127.0.0.1 — this API is local-machine only. */
  host?: string;
};

export type SessionInfo = {
  sessionId: string;
  wsHost: '127.0.0.1';
  wsPort: number;
  apiPort: number;
  resourceIdentity: ResourceIdentity | null;
  bound: boolean;
};

/**
 * Local HTTP API for a session, sharing the authority's lifetime. It is
 * strictly read-only: every handler derives its payload from
 * `authority.getState()` and no handler mutates state or touches media.
 * Endpoints:
 * - GET /api/session  → SessionInfo JSON
 * - GET /health       → { status: 'ok' } (also /api/health)
 * - OPTIONS *         → CORS preflight
 * Errors are returned as JSON `{ error: { code, message } }`.
 */
export class SessionApi {
  private readonly authority: SessionAuthority;
  private readonly wsPort: number;
  private readonly port: number;
  private readonly host: string;
  private server: Server | undefined;

  constructor(options: SessionApiOptions) {
    this.authority = options.authority;
    this.wsPort = options.wsPort;
    this.port = options.port ?? options.wsPort + 1;
    this.host = options.host ?? '127.0.0.1';
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error('Session API is already running');
    const server = createServer((request, response) => this.handleRequest(request, response));

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const onError = (error: Error) => {
      server.off('listening', onListening);
      server.close();
      reject(new Error(`session API failed to listen on ${this.host}:${this.port} (${error.message})`));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(this.port, this.host);
    await promise;

    this.server = server;
    return { host: this.host, port: this.port };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    await promise;
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    // CORS: the host page binds from a browser context that may not share this
    // origin, so every response (including errors) stays cross-origin readable.
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Max-Age', '86400');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      this.sendError(response, 400, 'invalid-request', 'Request URL could not be parsed');
      return;
    }

    if (request.method !== 'GET') {
      this.sendError(response, 405, 'method-not-allowed', `Method ${request.method} is not allowed; use GET`);
      return;
    }

    if (pathname === '/api/session') {
      this.sendJson(response, 200, this.sessionInfo());
      return;
    }
    if (pathname === '/health' || pathname === '/api/health') {
      this.sendJson(response, 200, { status: 'ok' });
      return;
    }
    this.sendError(response, 404, 'not-found', `Unknown endpoint ${JSON.stringify(pathname)}; try GET /api/session`);
  }

  private sessionInfo(): SessionInfo {
    // getState() returns a defensive copy of the identity; this payload is a
    // read-only snapshot and never feeds back into the authority.
    const state = this.authority.getState();
    return {
      sessionId: state.sessionId,
      wsHost: '127.0.0.1',
      wsPort: this.wsPort,
      apiPort: this.port,
      resourceIdentity: state.resourceIdentity,
      bound: state.resourceIdentity !== null,
    };
  }

  private sendJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  }

  private sendError(response: ServerResponse, status: number, code: string, message: string): void {
    this.sendJson(response, status, { error: { code, message } });
  }
}
