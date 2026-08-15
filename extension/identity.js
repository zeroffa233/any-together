'use strict';

/**
 * AnyTogetherIdentity — shared browser-side syncer identity registry.
 *
 * Single source of truth for "which site syncer serves a page URL" inside the
 * extension: URL matching (registrable domain + subdomains, optionally refined
 * by a URL rule), canonical resource-identity derivation, and the static
 * capability set each syncer advertises. Both the content script and the MV3
 * background service worker load this file (manifest order / importScripts),
 * so no site-specific URL or identity logic lives in either script.
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
   * Canonical form of a registrable domain: trimmed, lowercased, trailing dots
   * removed, free of scheme/port/wildcard/whitespace characters. Null when the
   * input is not usable as a domain.
   */
  function normalizeDomain(domain) {
    if (typeof domain !== 'string') return null;
    const normalized = domain.trim().toLowerCase().replace(/\.+$/, '');
    if (normalized.length === 0) return null;
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
      capabilities: Array.isArray(registration.capabilities) ? registration.capabilities.slice() : [],
      deriveIdentity: typeof registration.deriveIdentity === 'function' ? registration.deriveIdentity : undefined,
    };
    const compiled = compileRule(entry.urlRule);
    byId.set(adapterId, entry);
    byDomain.set(domain, entry);
    if (compiled !== undefined) compiledRules.set(entry, compiled);
    registrations.push(entry);
  }

  /** Domain/subdomain + optional URL-rule match of one entry against a parsed URL. */
  function matchesUrl(entry, url) {
    const hostname = url.hostname.toLowerCase();
    if (hostname !== entry.domain && !hostname.endsWith(`.${entry.domain}`)) return false;
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
    urlRule: '^https?://[^/]*/video(/|$|[?#])',
    capabilities: ['play', 'pause', 'seek', 'set-rate', 'replay', 'native-events'],
    deriveIdentity(url) {
      const match = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
      return match ? { resourceId: match[1] } : undefined;
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
