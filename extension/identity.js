'use strict';

/**
 * AnyTogetherIdentity — shared browser-side syncer identity registry.
 *
 * Single source of truth for "which site syncer serves a page URL" inside the
 * extension: URL matching (registrable domain + subdomains, optionally refined
 * by a URL rule or a custom URL predicate), canonical resource-identity derivation,
 * and the static capability set each syncer advertises. Both the content script
 * and the MV3 background service worker load this file (manifest order /
 * importScripts), so no site-specific URL or identity logic lives in either
 * script.
 *
 * Adding a new syncer means registering it here — domain (+ optional URL rule),
 * identity derivation hook and capabilities. content.js and background.js stay
 * untouched.
 *
 * Exposed as a single global `AnyTogetherIdentity`, compatible with the
 * content-script isolated world and the service-worker global (no module
 * loader dependency).
 */
(function (global) {
  const registrations = [];
  const byId = new Map();
  const byDomain = new Map();
  const compiledRules = new WeakMap();

  /**
   * Canonical form of a registrable domain. `*` is reserved for a registration
   * that supplies both a restrictive URL rule and a custom URL predicate.
   */
  function normalizeDomain(domain) {
    if (typeof domain !== 'string') return null;
    const normalized = domain.trim().toLowerCase().replace(/\.+$/, '');
    if (normalized.length === 0 || normalized === '*') return normalized || null;
    if (/[\s/:*?]/.test(normalized)) return null;
    return normalized;
  }

  /**
   * Compiles a serialized URL rule ({source, flags}); undefined rules pass
   * through. Empty sources and global/sticky flags (stateful lastIndex
   * matching) are rejected. The compiled RegExp is cached on the entry so
   * resolution never re-compiles.
   */
  function compileRule(rule) {
    if (rule === undefined) return undefined;
    if (!rule || typeof rule !== 'object' || typeof rule.source !== 'string' || rule.source.trim().length === 0) {
      throw new Error('AnyTogetherIdentity: URL rule source must be a non-empty string');
    }
    const flags = typeof rule.flags === 'string' ? rule.flags : '';
    if (/[gy]/.test(flags)) {
      throw new Error(`AnyTogetherIdentity: URL rule must not use global/sticky flags, got: ${JSON.stringify(flags)}`);
    }
    try {
      return new RegExp(rule.source, flags);
    } catch (error) {
      throw new Error(
        `AnyTogetherIdentity: URL rule does not compile: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Registers a syncer contract. Throws on invalid registrations (empty
   * adapterId/domain, uncompilable URL rule) and on conflicts (same adapterId,
   * or the same domain served twice).
   */
  function register(registration) {
    if (!registration || typeof registration !== 'object') {
      throw new Error('AnyTogetherIdentity: registration must be an object');
    }
    const adapterId = typeof registration.adapterId === 'string' ? registration.adapterId.trim() : '';
    if (adapterId.length === 0) {
      throw new Error('AnyTogetherIdentity: syncer adapterId must be a non-empty string');
    }
    const domain = normalizeDomain(registration.domain);
    if (domain === null) {
      throw new Error(`AnyTogetherIdentity: invalid syncer domain: ${JSON.stringify(registration.domain)}`);
    }
    if (byId.has(adapterId)) {
      throw new Error(`AnyTogetherIdentity: adapter '${adapterId}' is already registered`);
    }
    const existing = byDomain.get(domain);
    if (existing !== undefined) {
      throw new Error(`AnyTogetherIdentity: domain '${domain}' is already served by adapter '${existing.adapterId}'`);
    }
    const entry = {
      adapterId,
      name: typeof registration.name === 'string' ? registration.name : adapterId,
      domain,
      urlRule: registration.urlRule,
      matchUrl: typeof registration.matchUrl === 'function' ? registration.matchUrl : undefined,
      capabilities: Array.isArray(registration.capabilities) ? registration.capabilities.slice() : [],
      deriveIdentity: typeof registration.deriveIdentity === 'function' ? registration.deriveIdentity : undefined,
    };
    const compiled = compileRule(entry.urlRule);
    byId.set(adapterId, entry);
    byDomain.set(domain, entry);
    if (compiled !== undefined) compiledRules.set(entry, compiled);
    registrations.push(entry);
  }

  /** Domain/subdomain + optional URL-rule/custom predicate match. */
  function matchesUrl(entry, url) {
    const hostname = url.hostname.toLowerCase();
    if (entry.domain !== '*' && hostname !== entry.domain && !hostname.endsWith(`.${entry.domain}`)) return false;
    if (typeof entry.matchUrl === 'function' && !entry.matchUrl(url)) return false;
    const rule = compiledRules.get(entry);
    return rule === undefined || rule.test(url.href);
  }

  /**
   * Registration serving `url`, or undefined. Matching is two-layered: the
   * entry's domain must match the hostname (domain itself or any subdomain)
   * and, when present, the URL rule must match the full URL. The most specific
   * (longest-domain) match wins. Unparseable and non-http(s) URLs never match.
   */
  function resolve(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    let best;
    let bestDomainLength = -1;
    for (const entry of byDomain.values()) {
      if (!matchesUrl(entry, parsed)) continue;
      if (entry.domain.length > bestDomainLength) {
        best = entry;
        bestDomainLength = entry.domain.length;
      }
    }
    return best;
  }

  /**
   * Adapter descriptor for the page the content script runs on: undefined when
   * no syncer serves the URL. The content core treats the result as read-only
   * metadata (adapterId, capabilities) and never re-implements URL matching.
   */
  function resolveAdapter(url) {
    return resolve(url);
  }

  /**
   * Canonical resource identity for a page URL, or null when the URL is not
   * served by any registered syncer. The base identity is adapterId +
   * canonicalUrl (origin + pathname, trailing slash trimmed, query/hash
   * dropped); the syncer's own deriveIdentity hook may extend it (e.g.
   * Bilibili's BV resourceId). Mirrors src/shared/resource.ts semantics.
   */
  function deriveIdentity(locationOrUrl) {
    if (typeof locationOrUrl !== 'string' || locationOrUrl.length === 0) return null;
    let url;
    try {
      url = new URL(locationOrUrl);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const entry = resolve(locationOrUrl);
    if (entry === undefined) return null;
    const identity = {
      adapterId: entry.adapterId,
      canonicalUrl: url.origin + url.pathname.replace(/\/$/, ''),
    };
    if (typeof entry.deriveIdentity === 'function') {
      const extra = entry.deriveIdentity(url);
      if (extra && typeof extra === 'object') {
        for (const key of Object.keys(extra)) identity[key] = extra[key];
      }
    }
    return identity;
  }

  /** Structural equality of two identities (adapterId, canonicalUrl, resourceId). */
  function identityEqual(left, right) {
    return !!left && !!right
      && left.adapterId === right.adapterId
      && left.canonicalUrl === right.canonicalUrl
      && (left.resourceId ?? null) === (right.resourceId ?? null);
  }

  /** True when a registered syncer serves the URL (http(s), domain, URL rule). */
  function isSupportedUrl(url) {
    return resolve(url) !== undefined;
  }

  /** Registrations in registration order. */
  function list() {
    return registrations.slice();
  }

  // Local video shares are served over HTTP by the companion process on an
  // IPv4 LAN address (or localhost). The wildcard domain is constrained by
  // matchUrl and the URL rule; it does not make arbitrary pages supported.
  register({
    adapterId: 'local-video',
    name: '本地视频',
    domain: '*',
    urlRule: {
      source: '^http://(?:localhost|(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3})(?::\\d+)?/local/[A-Za-z0-9_-]+/video/[^/?#]+(?:[?#].*)?$',
      flags: '',
    },
    matchUrl(url) {
      return url.protocol === 'http:';
    },
    capabilities: ['play', 'pause', 'seek', 'set-rate', 'replay', 'native-events'],
    deriveIdentity(url) {
      const match = url.pathname.match(/^\/local\/[A-Za-z0-9_-]+\/video\/([^/]+)$/);
      if (!match) return undefined;
      try {
        const resourceId = decodeURIComponent(match[1]);
        if (!resourceId || resourceId === '.' || resourceId === '..') return undefined;
        return { resourceId };
      } catch {
        return undefined;
      }
    },
  });

  // --- Built-in syncers --------------------------------------------------------

  // Bilibili: http(s) pages on bilibili.com or a *.bilibili.com subdomain whose
  // path starts with /video or /video/… (mirrors the manifest content-script
  // scope, so non-video pages like the homepage, search or user spaces are
  // never served). The BV id is preserved as resourceId when the path carries
  // a /video/BV… segment; it stays undefined for /video pages without a BV.
  register({
    adapterId: 'bilibili',
    name: 'Bilibili',
    domain: 'bilibili.com',
    // Path must start with /video (next char /, query, hash or end of URL);
    // anchored at the scheme so embedded "/video" segments never match.
    urlRule: { source: '^https?://[^/]*/video(/|$|[?#])', flags: '' },
    capabilities: ['play', 'pause', 'seek', 'set-rate', 'replay', 'native-events'],
    deriveIdentity(url) {
      const match = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
      return match ? { resourceId: match[1] } : undefined;
    },
  });

  // YouTube: http(s) pages on youtube.com or a *.youtube.com subdomain whose
  // path is /watch with a non-empty v= query parameter (the parameter may sit
  // anywhere in the query string; mirrors the manifest content-script scope,
  // so non-watch pages like the homepage, shorts or feeds are never served).
  // The video id is the session resource: the canonical identity is rebuilt
  // from the v parameter alone, so query order, extra parameters (list/t/...)
  // and the fragment never change it, and every host (youtube.com, www, m,
  // music) collapses onto https://www.youtube.com/watch?v=<id> — the same
  // normalization as the Node YoutubeAdapter.
  register({
    adapterId: 'youtube',
    name: 'YouTube',
    domain: 'youtube.com',
    // /watch followed by a query string carrying a non-empty v= parameter.
    urlRule: { source: '^https?://(?:[^/]+\\.)?youtube\\.com/watch\\?(?:[^#]*&)?v=[^&#]+', flags: '' },
    capabilities: ['play', 'pause', 'seek', 'set-rate', 'replay', 'native-events'],
    deriveIdentity(url) {
      const videoId = url.searchParams.get('v');
      if (!videoId) return undefined;
      return { canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`, resourceId: videoId };
    },
  });

  // MissAV: http(s) pages on missav.live or a *.missav.live subdomain whose
  // path is `/<locale>/<dvd-id>` with an optional `/dm<N>/` mirror segment
  // (mirrors the manifest content-script scope, so homepage and locale-only
  // pages are never served). The dvd id is the session resource: the
  // canonical identity is rebuilt from locale + dvd id alone, so the mirror
  // segment, subdomain, query parameters and fragment never change it, and
  // every mirror collapses onto https://missav.live/<locale>/<dvd-id> — the
  // same normalization as the Node MissavAdapter.
  register({
    adapterId: 'missav',
    name: 'MissAV',
    domain: 'missav.live',
    // `/<locale>/<dvd-id>` with an optional `/dm<N>/` mirror segment; the id
    // must be hyphenated so locale-only and non-video paths never match.
    urlRule: {
      source: '^https?://(?:[^/]+\\.)?missav\\.live/(?:dm\\d+/)?([a-z]{2}(?:-[a-z]{2})?)/([a-z0-9]+-[a-z0-9]+)/?(?=[?#]|$)',
      flags: '',
    },
    capabilities: ['play', 'pause', 'seek', 'set-rate', 'replay', 'native-events'],
    deriveIdentity(url) {
      const match = url.href.match(/^https?:\/\/(?:[^/]+\.)?missav\.live\/(?:dm\d+\/)?([a-z]{2}(?:-[a-z]{2})?)\/([a-z0-9]+-[a-z0-9]+)\/?(?=[?#]|$)/);
      if (!match) return undefined;
      return { canonicalUrl: `https://missav.live/${match[1]}/${match[2]}`, resourceId: match[2] };
    },
  });

  // Pornhub: http(s) pages on pornhub.com or a *.pornhub.com subdomain whose
  // path is /view_video.php with a non-empty viewkey= query parameter in any
  // position (mirrors the manifest content-script scope, so homepage, channel
  // and search pages are never served). The viewkey is the session resource:
  // the canonical identity is rebuilt from the viewkey alone, so query order,
  // extra parameters and the fragment never change it, and every host
  // (pornhub.com, www, country subdomains) collapses onto
  // https://www.pornhub.com/view_video.php?viewkey=<id> — the same
  // normalization as the Node PornhubAdapter.
  register({
    adapterId: 'pornhub',
    name: 'Pornhub',
    domain: 'pornhub.com',
    // /view_video.php with a non-empty viewkey= parameter in any query position.
    urlRule: { source: '^https?://(?:[^/]+\\.)?pornhub\\.com/view_video\\.php\\?(?:[^#]*&)?viewkey=[^&#]+', flags: '' },
    capabilities: ['play', 'pause', 'seek', 'set-rate', 'replay', 'native-events'],
    deriveIdentity(url) {
      const viewkey = url.searchParams.get('viewkey');
      if (viewkey === null) return undefined;
      const trimmed = viewkey.trim();
      if (trimmed.length === 0) return undefined;
      return {
        canonicalUrl: `https://www.pornhub.com/view_video.php?viewkey=${encodeURIComponent(trimmed)}`,
        resourceId: trimmed,
      };
    },
  });

  // XVideos: http(s) pages on xvideos.com or a *.xvideos.com subdomain whose
  // path is a current-shape video page `/video.<encoded-id>/<slug>` (mirrors
  // the manifest content-script scope; homepage, tag/browse pages and the
  // dead legacy numeric format are never served). The encoded id is the
  // session resource: the canonical identity is rebuilt from the id alone, so
  // the cosmetic slug (XVideos redirects wrong slugs onto the canonical one),
  // host and page state never change it, and every host collapses onto
  // https://www.xvideos.com/video.<id> — the same normalization as the Node
  // XvideosAdapter.
  register({
    adapterId: 'xvideos',
    name: 'XVideos',
    domain: 'xvideos.com',
    // Current-shape video pages only: /video.<encoded-id>/<slug>.
    urlRule: { source: '^https?://(?:[^/]+\\.)?xvideos\\.com/video\\.([A-Za-z0-9]+)/[^/?#]+$', flags: '' },
    capabilities: ['play', 'pause', 'seek', 'set-rate', 'replay', 'native-events'],
    deriveIdentity(url) {
      const match = url.href.match(/^https?:\/\/(?:[^/]+\.)?xvideos\.com\/video\.([A-Za-z0-9]+)\/[^\/?#]+$/);
      if (!match) return undefined;
      return { canonicalUrl: `https://www.xvideos.com/video.${match[1]}`, resourceId: match[1] };
    },
  });

  // --- Public API ----------------------------------------------------------------

  global.AnyTogetherIdentity = {
    register,
    resolve,
    resolveAdapter,
    deriveIdentity,
    identityEqual,
    isSupportedUrl,
    list,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
