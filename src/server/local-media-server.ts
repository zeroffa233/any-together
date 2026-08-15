import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, extname, isAbsolute } from 'node:path';
import { open, stat } from 'node:fs/promises';
import { buildLocalVideoShareUrl } from '../shared/local-resource.js';

/**
 * Token segment of the share URL path. Generated tokens are 43-char base64url;
 * explicit overrides must stay within this safe, path-uncharacter alphabet.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Only route shape that exists: `/local/<token>/video/<filename>`. The token
 * is the lookup key; the filename segment is display/identity only and must
 * decode to the shared file's basename. No other path can ever resolve, so
 * there is no path-to-filesystem derivation to attack.
 */
const ROUTE_PATTERN = /^\/local\/([A-Za-z0-9_-]+)\/video\/([^/]+)$/;

/** Single byte range, RFC 9110 §14.1.2, `bytes=` unit only. */
const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

/**
 * Zero-dependency extension → MIME map. Anything else is served as
 * application/octet-stream rather than guessed.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
};

export type LocalMediaServerOptions = {
  /** Absolute path of the single regular file to share. */
  filePath: string;
  /** Listen host; defaults to '0.0.0.0' (every interface). */
  host?: string;
  /** Listen port; defaults to 0 (OS-assigned ephemeral port). */
  port?: number;
  /**
   * Hostname advertised in the share URL. Defaults to '127.0.0.1' when `host`
   * is a wildcard (0.0.0.0/::), otherwise to `host`. The LAN address must be
   * chosen by the caller (e.g. the host CLI enumerates non-internal IPv4s).
   */
  urlHost?: string;
  /** Explicit token override (path-safe); defaults to a random 32-byte base64url token. */
  token?: string;
};

/** Immutable description of one active share, snapshot at `start()`. */
export type LocalShare = {
  /** Opaque bearer token embedded in the URL path. */
  token: string;
  /** Canonical share URL: http://<urlHost>:<port>/local/<token>/video/<basename>. */
  url: string;
  /** Absolute path of the served regular file. */
  filePath: string;
  /** File size in bytes at share time. */
  size: number;
  /** Content-Type derived from the file extension. */
  contentType: string;
  /** Actually bound listen port (may differ from `options.port` when it was 0). */
  port: number;
};

type ParsedRange = { start: number; end: number };

/**
 * Tokenized single-file HTTP media server for one session.
 *
 * - Serves exactly ONE explicitly shared regular file, identified by an
 *   opaque per-share token in the URL path; there is no directory browsing,
 *   no arbitrary path resolution, no upload, no transcode, no P2P.
 * - GET/HEAD with full-stream 200 and single-range 206 semantics; invalid,
 *   multiple or unsatisfiable ranges get 416. Bodies stream via
 *   `fs.createReadStream` — the file is never buffered whole.
 * - `stop()` revokes the token and force-closes connections, freeing the
 *   port; a later `start()` issues a NEW token, so a stopped share's URL is
 *   permanently dead.
 */
export class LocalMediaServer {
  private readonly filePath: string;
  private readonly host: string;
  private readonly port: number;
  private readonly urlHost: string;
  private readonly token: string | undefined;
  private server: Server | undefined;
  private shareInfo: LocalShare | undefined;

  constructor(options: LocalMediaServerOptions) {
    if (options.token !== undefined && !TOKEN_PATTERN.test(options.token)) {
      throw new Error(`Invalid media share token ${JSON.stringify(options.token)} (must match ${String(TOKEN_PATTERN)})`);
    }
    this.filePath = options.filePath;
    this.host = options.host ?? '0.0.0.0';
    this.port = options.port ?? 0;
    this.urlHost = options.urlHost
      ?? (this.host === '0.0.0.0' || this.host === '::' ? '127.0.0.1' : this.host);
    this.token = options.token;
  }

  /** Current share, or null when the server is not running. */
  get share(): LocalShare | null {
    return this.shareInfo ?? null;
  }

  /**
   * Validate the file, bind the port and expose the share. Throws on
   * non-absolute paths, unreadable files and non-regular files; the token is
   * generated unless one was supplied.
   */
  async start(): Promise<LocalShare> {
    if (this.server !== undefined) throw new Error('Local media server is already running');
    if (!isAbsolute(this.filePath)) {
      throw new Error(`Shared file path must be absolute: ${JSON.stringify(this.filePath)}`);
    }
    let info: Stats;
    try {
      info = await stat(this.filePath);
    } catch (error) {
      throw new Error(`Cannot access shared file ${JSON.stringify(this.filePath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!info.isFile()) {
      throw new Error(`Shared path is not a regular file: ${JSON.stringify(this.filePath)}`);
    }
    try {
      const handle = await open(this.filePath, 'r');
      await handle.close();
    } catch (error) {
      throw new Error(`Shared file is not readable: ${JSON.stringify(this.filePath)} (${error instanceof Error ? error.message : String(error)})`);
    }

    const token = this.token ?? randomBytes(32).toString('base64url');
    const filename = basename(this.filePath);
    const contentType = CONTENT_TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream';

    const server = createServer((request, response) => this.handleRequest(request, response));
    const { promise, resolve, reject } = Promise.withResolvers<{ host: string; port: number }>();
    const onError = (error: Error) => {
      server.off('listening', onListening);
      server.close();
      reject(new Error(`local media server failed to listen on ${this.host}:${this.port} (${error.message})`));
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('local media server bound without a TCP address'));
        return;
      }
      resolve({ host: address.address, port: address.port });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(this.port, this.host);
    const address = await promise;

    this.server = server;
    const share: LocalShare = {
      token,
      url: buildLocalVideoShareUrl(this.urlHost, address.port, token, filename),
      filePath: this.filePath,
      size: info.size,
      contentType,
      port: address.port,
    };
    this.shareInfo = share;
    return share;
  }

  /**
   * Stop serving: revoke the token, terminate in-flight connections so the
   * port is released immediately, then close. Idempotent; a subsequent
   * `start()` produces a brand-new token.
   */
  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    this.shareInfo = undefined;
    server.closeAllConnections();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    await promise;
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    const share = this.shareInfo;
    if (share === undefined) {
      this.sendEmpty(response, 503);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': '0' });
      response.end();
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      this.sendEmpty(response, 400);
      return;
    }
    const route = ROUTE_PATTERN.exec(pathname);
    if (route === null || route[1] !== share.token) {
      // Uniform 404: wrong shape and wrong token are indistinguishable, so
      // nothing about the share leaks.
      this.sendEmpty(response, 404);
      return;
    }
    let requestedName: string;
    try {
      requestedName = decodeURIComponent(route[2] ?? '');
    } catch {
      this.sendEmpty(response, 404);
      return;
    }
    if (requestedName !== basename(share.filePath)) {
      this.sendEmpty(response, 404);
      return;
    }

    const parsedRange = request.headers.range === undefined ? null : parseRange(request.headers.range, share.size);
    if (parsedRange === 'invalid' || parsedRange === 'unsatisfiable') {
      response.writeHead(416, { 'Content-Range': `bytes */${share.size}`, 'Content-Length': '0' });
      response.end();
      return;
    }
    const status = parsedRange === null ? 200 : 206;
    const length = parsedRange === null ? share.size : parsedRange.end - parsedRange.start + 1;
    const headers: Record<string, string> = {
      'Accept-Ranges': 'bytes',
      'Content-Type': share.contentType,
      'Content-Length': String(length),
    };
    if (parsedRange !== null) {
      headers['Content-Range'] = `bytes ${parsedRange.start}-${parsedRange.end}/${share.size}`;
    }
    response.writeHead(status, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    const stream = createReadStream(share.filePath, parsedRange === null ? undefined : parsedRange);
    stream.on('error', () => response.destroy());
    response.on('close', () => {
      if (!response.writableEnded) stream.destroy();
    });
    stream.pipe(response);
  }

  private sendEmpty(response: ServerResponse, status: number): void {
    response.writeHead(status, { 'Content-Length': '0' });
    response.end();
  }
}

/**
 * Parse a single `bytes=` range against the file size. Returns the inclusive
 * byte window, or 'invalid' (malformed syntax, non-bytes unit, multiple
 * ranges, start > end) / 'unsatisfiable' (start at/after EOF, `-0` suffix, any
 * range on an empty file) — both map to 416 by the caller.
 */
function parseRange(headerValue: string, size: number): ParsedRange | 'invalid' | 'unsatisfiable' {
  const match = RANGE_PATTERN.exec(headerValue.trim());
  if (match === null) return 'invalid';
  const startSpec = match[1] ?? '';
  const endSpec = match[2] ?? '';
  if (startSpec === '' && endSpec === '') return 'invalid';
  if (size === 0) return 'unsatisfiable';
  if (startSpec === '') {
    // Suffix: last N bytes.
    const suffixLength = Number(endSpec);
    if (suffixLength === 0) return 'unsatisfiable';
    return { start: Math.max(size - suffixLength, 0), end: size - 1 };
  }
  const start = Number(startSpec);
  if (start >= size) return 'unsatisfiable';
  if (endSpec === '') return { start, end: size - 1 };
  const end = Number(endSpec);
  if (start > end) return 'invalid';
  // createReadStream's end is inclusive, so the last byte is size - 1.
  return { start, end: Math.min(end, size - 1) };
}
