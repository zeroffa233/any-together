import { isIP } from 'node:net';
import type { ResourceIdentity } from './protocol.js';

/**
 * Adapter id for locally shared video files served by `LocalMediaServer`
 * (src/server/local-media-server.ts). The share URL is an `http(s)` URL on a
 * LAN IPv4 literal (or 127.0.0.1/localhost) carrying the opaque share token in
 * its PATH — the canonical identity drops query/hash, so the token must live
 * in the path to survive canonicalization.
 */
export const LOCAL_VIDEO_ADAPTER_ID = 'local-video';

/**
 * Path shape of a local share URL: `/local/<token>/video/<filename>`. The
 * token is a base64url string; the filename is the encodeURIComponent'd
 * basename of the shared file (display/identity only — the server never
 * derives a filesystem path from the URL).
 */
const LOCAL_VIDEO_PATH_PATTERN = /^\/local\/([A-Za-z0-9_-]+)\/video\/([^/]+)$/;

/**
 * Stable, machine-readable error for local-video identity construction.
 * `code` is one of:
 * - 'invalid-url': the input cannot be parsed as a URL at all.
 * - 'not-local-video': the URL parses but is not an `http(s)` URL on an IPv4
 *   literal (or localhost) whose path is `/local/<token>/video/<filename>`.
 */
export class LocalVideoIdentityError extends Error {
  constructor(readonly code: 'invalid-url' | 'not-local-video', message: string) {
    super(message);
    this.name = 'LocalVideoIdentityError';
  }
}

/** True when the value is a structurally valid local-video share URL. */
function isLocalVideoUrlString(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // The v1 media server only serves plain IP:port URLs: no domain names and
  // no IPv6 literals (the loopback form is 127.0.0.1/localhost).
  if (isIP(url.hostname) !== 4 && url.hostname !== 'localhost') return false;
  const match = LOCAL_VIDEO_PATH_PATTERN.exec(url.pathname);
  if (match === null) return false;
  const filename = match[2];
  if (filename === undefined || filename.length === 0) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(filename);
  } catch {
    return false;
  }
  return decoded.length > 0 && decoded !== '.' && decoded !== '..';
}

/**
 * True when the value is a string that parses as a local-video share URL
 * (same structural rules as `createLocalVideoResourceIdentity`, without
 * throwing).
 */
export function isLocalVideoUrl(value: unknown): value is string {
  return typeof value === 'string' && isLocalVideoUrlString(value);
}

/**
 * Build the share URL served by `LocalMediaServer` for one file. `host` is the
 * advertised (LAN-reachable) host, `port` the actual bound port, `token` the
 * opaque share token and `filename` the file's basename; the basename is
 * percent-encoded so any filename survives as a single path segment.
 */
export function buildLocalVideoShareUrl(host: string, port: number, token: string, filename: string): string {
  return `http://${host}:${port}/local/${token}/video/${encodeURIComponent(filename)}`;
}

/**
 * Normalize a local-video share URL into the canonical session resource
 * identity.
 *
 * - Only `http(s)` URLs whose host is an IPv4 literal (or `localhost`) and
 *   whose path is `/local/<token>/video/<filename>` are accepted; foreign
 *   URLs, domain hosts and other paths throw a stable
 *   `LocalVideoIdentityError` ('invalid-url' and 'not-local-video'
 *   respectively).
 * - The canonical URL is the complete token URL (`origin + pathname`, trailing
 *   slash trimmed, query/hash dropped), so the opaque token stays part of the
 *   identity — exactly the string the media server requires.
 * - The decoded file basename is preserved as `resourceId` for diagnostics;
 *   identity equality is still driven by `canonicalUrl`.
 */
export function createLocalVideoResourceIdentity(mediaUrl: string): ResourceIdentity {
  let url: URL | undefined;
  try {
    url = new URL(mediaUrl);
  } catch {
    // Unparseable input: stable 'invalid-url' error.
  }
  if (url === undefined) {
    throw new LocalVideoIdentityError('invalid-url', `Cannot parse media URL: ${JSON.stringify(mediaUrl)}`);
  }
  if (!isLocalVideoUrlString(mediaUrl)) {
    throw new LocalVideoIdentityError(
      'not-local-video',
      `Media URL ${mediaUrl} is not a local-video share URL (expected http(s)://<ip-or-localhost>:<port>/local/<token>/video/<filename>)`,
    );
  }
  const canonicalUrl = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  const match = LOCAL_VIDEO_PATH_PATTERN.exec(url.pathname);
  const resourceId = match === null ? undefined : decodeURIComponent(match[2] ?? '');
  return {
    adapterId: LOCAL_VIDEO_ADAPTER_ID,
    canonicalUrl,
    ...(resourceId === undefined ? {} : { resourceId }),
  };
}
