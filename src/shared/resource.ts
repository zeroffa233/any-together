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
 *   query/hash dropped, so the same video always maps to one identity — EXCEPT
 *   the `p` query parameter: it selects the part (分P) of a multi-part upload
 *   and therefore WHICH video the player loads. Parts > 1 are kept as `?p=<n>`
 *   on the canonical URL, so different parts are different session resources
 *   (switching parts re-binds the session like any other resource switch).
 *   Part 1 and invalid/absent values keep the bare canonical form, so plain
 *   video URLs stay compatible. Tracking parameters (vd_source, spm_id_from,
 *   t, ...) are always dropped.
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
  const base = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  if (!BILIBILI_VIDEO_PATH_PATTERN.test(base)) {
    throw new ResourceIdentityError(
      'not-bilibili',
      `Resource URL ${location} is not a Bilibili video page`,
    );
  }
  const part = normalizeBilibiliPart(url.searchParams.get('p'));
  const canonicalUrl = part === null ? base : `${base}?p=${part}`;
  const resourceId = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1];
  return {
    adapterId: 'bilibili',
    canonicalUrl,
    ...(resourceId === undefined ? {} : { resourceId }),
  };
}

/**
 * The part number from a `p` query parameter, or null when the URL does not
 * select a part above 1: absent, non-numeric, zero or unsafe values all mean
 * "part 1" and keep the bare canonical form.
 */
function normalizeBilibiliPart(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const part = Number(raw);
  if (!Number.isSafeInteger(part) || part <= 1) return null;
  return part;
}

/** Re-exported so adapter/CLI callers share one host-matching definition. */
export { BILIBILI_HOST_PATTERN, isBilibiliResourceIdentity };
