import { BILIBILI_HOST_PATTERN, BILIBILI_VIDEO_PATH_PATTERN, isBilibiliResourceIdentity, isBilibiliUrl } from './protocol.js';
import type { ResourceIdentity } from './protocol.js';

/**
 * Stable, machine-readable error for resource identity construction failures.
 * `code` is one of:
 * - 'invalid-url': the input cannot be parsed as a URL at all.
 * - 'not-bilibili': the URL parses but is not an http(s) URL on a bilibili.com
 *   subdomain, or is a Bilibili page whose path is not `/video`/`/video/...`.
 */
export class ResourceIdentityError extends Error {
  constructor(readonly code: 'invalid-url' | 'not-bilibili', message: string) {
    super(message);
    this.name = 'ResourceIdentityError';
  }
}

/**
 * Normalize a Bilibili VIDEO page URL into the canonical session resource identity.
 *
 * - Only `http(s)` URLs on `bilibili.com` or a `*.bilibili.com` subdomain whose
 *   path is `/video` or `/video/...` are accepted; foreign URLs and non-video
 *   Bilibili pages throw a stable `ResourceIdentityError` ('invalid-url' and
 *   'not-bilibili' respectively).
 * - The canonical URL is `origin + pathname` with the trailing slash trimmed and
 *   query/hash dropped, so the same video always maps to one identity.
 * - The BV id is preserved as `resourceId` when the path carries a `/video/BV…`
 *   segment; it stays undefined for `/video` pages without a BV segment.
 */
export function createBilibiliResourceIdentity(location: string): ResourceIdentity {
  if (!isBilibiliUrl(location)) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(location);
    } catch {
      // Unparseable input: stable 'invalid-url' error.
    }
    if (parsed === undefined) {
      throw new ResourceIdentityError('invalid-url', `Cannot parse resource URL: ${JSON.stringify(location)}`);
    }
    throw new ResourceIdentityError(
      'not-bilibili',
      `Resource URL ${location} is not an http(s) URL on a bilibili.com subdomain`,
    );
  }
  const url = new URL(location);
  const canonicalUrl = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  if (!BILIBILI_VIDEO_PATH_PATTERN.test(canonicalUrl)) {
    throw new ResourceIdentityError(
      'not-bilibili',
      `Resource URL ${location} is not a Bilibili video page`,
    );
  }
  const resourceId = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1];
  return {
    adapterId: 'bilibili',
    canonicalUrl,
    ...(resourceId === undefined ? {} : { resourceId }),
  };
}

/** Re-exported so adapter/CLI callers share one host-matching definition. */
export { BILIBILI_HOST_PATTERN, isBilibiliResourceIdentity };
