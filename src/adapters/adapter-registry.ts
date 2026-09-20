import type { AdapterCapability, ResourceAdapter } from './resource-adapter.js';
import { bilibiliRegistration } from './bilibili-adapter.js';
import { missavRegistration } from './missav-adapter.js';
import { pornhubRegistration } from './pornhub-adapter.js';
import { xvideosRegistration } from './xvideos-adapter.js';
import { youtubeRegistration } from './youtube-adapter.js';

/**
 * Minimal page environment the registry guarantees to syncer factories.
 * `document` is opaque so each registration narrows it for its own site;
 * factories must never assume browser globals exist (Node unit tests inject
 * fakes explicitly).
 */
export type AdapterPage = {
  location: { readonly href: string };
  document?: unknown;
};

/**
 * Serializable URL-matching rule: a RegExp expressed as `source` + `flags` so
 * rules survive JSON / structured-clone round trips. Empty sources and
 * global/sticky flags are rejected at registration time.
 */
export type AdapterUrlRule = {
  source: string;
  flags?: string;
};

/**
 * Static, registry-visible contract of one site syncer. A syncer ships exactly
 * this plus a `ResourceAdapter` implementation; the registry routes page URLs
 * to it and instantiates it through `create`.
 *
 * `adapterId` must be stable and should match the adapter's own `adapterId`.
 * `domain` is the canonical registrable domain (e.g. 'bilibili.com'); the
 * optional `urlRule` refines the match to a full-URL pattern within that
 * domain and its subdomains.
 */
export type SyncerRegistration = {
  adapterId: string;
  /** Human-readable site name. */
  name?: string;
  /** Canonical registrable domain this syncer serves. */
  domain: string;
  /**
   * Optional full-URL RegExp rule; when present it must also match the page
   * URL. Absent means every page on `domain` (and its subdomains) is served.
   */
  urlRule?: AdapterUrlRule;
  /** Factory binding one page environment to a fresh adapter instance. */
  create(page: AdapterPage): ResourceAdapter;
  /** Operations the syncer can enforce or surface. */
  capabilities: readonly AdapterCapability[];
};

export type AdapterRegistryErrorCode =
  | 'duplicate-adapter'
  | 'duplicate-domain'
  | 'invalid-registration'
  | 'invalid-rule';

/**
 * Explicit registry failure: duplicate adapterId/domain conflicts and invalid
 * registrations (empty adapterId, malformed domain, empty or uncompilable URL
 * rules). Thrown by `register`, never by `resolve`.
 */
export class AdapterRegistryError extends Error {
  readonly code: AdapterRegistryErrorCode;

  constructor(code: AdapterRegistryErrorCode, message: string) {
    super(message);
    this.name = 'AdapterRegistryError';
    this.code = code;
  }
}

/**
 * Routes page URLs to site syncers.
 *
 * Matching is two-layered: the registration's `domain` must match the URL
 * hostname (the domain itself or any subdomain), and when the registration
 * carries a `urlRule` the rule must match the full URL. The most specific
 * (longest-domain) match wins. Same-domain conflicts and duplicate adapterIds
 * fail at registration time; unknown or unparseable URLs resolve to undefined.
 */
export class AdapterRegistry {
  private readonly byId = new Map<string, SyncerRegistration>();
  private readonly byDomain = new Map<string, SyncerRegistration>();
  private readonly compiledRules = new WeakMap<SyncerRegistration, RegExp>();

  get size(): number {
    return this.byId.size;
  }

  /**
   * Registers a syncer contract. Throws `AdapterRegistryError` on invalid
   * registrations and on conflicts with an already-registered syncer (same
   * adapterId, or the same domain).
   */
  register(registration: SyncerRegistration): void {
    const adapterId = registration.adapterId.trim();
    if (adapterId.length === 0) {
      throw new AdapterRegistryError('invalid-registration', 'Syncer adapterId must be a non-empty string');
    }
    const domain = normalizeDomain(registration.domain);
    if (domain === null) {
      throw new AdapterRegistryError(
        'invalid-registration',
        `Invalid syncer domain: ${JSON.stringify(registration.domain)}`,
      );
    }
    if (typeof registration.create !== 'function') {
      throw new AdapterRegistryError('invalid-registration', `Syncer '${adapterId}' must provide a create(page) factory`);
    }
    if (this.byId.has(adapterId)) {
      throw new AdapterRegistryError('duplicate-adapter', `Adapter '${adapterId}' is already registered`);
    }
    const existing = this.byDomain.get(domain);
    if (existing !== undefined) {
      throw new AdapterRegistryError(
        'duplicate-domain',
        `Domain '${domain}' is already served by adapter '${existing.adapterId}'`,
      );
    }
    const compiled = compileRule(registration.urlRule);
    this.byId.set(adapterId, registration);
    this.byDomain.set(domain, registration);
    if (compiled !== undefined) {
      this.compiledRules.set(registration, compiled);
    }
  }

  /**
   * Finds the registration serving `url`: the longest-domain match whose
   * optional URL rule also matches. Returns undefined for unparseable URLs,
   * non-http(s) URLs, and URLs no registration serves.
   */
  resolve(url: string): SyncerRegistration | undefined {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    const hostname = parsed.hostname.toLowerCase();
    let best: SyncerRegistration | undefined;
    let bestDomainLength = -1;
    for (const [domain, registration] of this.byDomain) {
      if (hostname !== domain && !hostname.endsWith(`.${domain}`)) {
        continue;
      }
      const rule = this.compiledRules.get(registration);
      if (rule !== undefined && !rule.test(url)) {
        continue;
      }
      if (domain.length > bestDomainLength) {
        best = registration;
        bestDomainLength = domain.length;
      }
    }
    return best;
  }

  /** One-shot lookup + instantiation; undefined when no syncer serves the page. */
  resolveAdapter(page: AdapterPage): ResourceAdapter | undefined {
    const registration = this.resolve(page.location.href);
    return registration === undefined ? undefined : registration.create(page);
  }

  get(adapterId: string): SyncerRegistration | undefined {
    return this.byId.get(adapterId);
  }

  /** All registrations in registration order. */
  list(): readonly SyncerRegistration[] {
    return Array.from(this.byId.values());
  }
}

/**
 * Canonical form of a registrable domain: trimmed, lowercased, trailing dots
 * removed, and free of scheme/port/wildcard/whitespace characters. Returns
 * null when the input is not usable as a domain.
 */
function normalizeDomain(domain: string): string | null {
  if (typeof domain !== 'string') return null;
  const normalized = domain.trim().toLowerCase().replace(/\.+$/, '');
  if (normalized.length === 0) return null;
  if (/[\s/:*?]/.test(normalized)) return null;
  return normalized;
}

/**
 * Validates and compiles a serialized URL rule. Empty sources and
 * global/sticky flags (stateful `lastIndex` matching) are rejected; the
 * compiled RegExp is cached so resolve never re-compiles.
 */
function compileRule(rule: AdapterUrlRule | undefined): RegExp | undefined {
  if (rule === undefined) return undefined;
  const source = rule.source;
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new AdapterRegistryError('invalid-rule', 'URL rule source must be a non-empty string');
  }
  const flags = rule.flags ?? '';
  if (/[gy]/.test(flags)) {
    throw new AdapterRegistryError('invalid-rule', `URL rule must not use global/sticky flags, got: ${JSON.stringify(flags)}`);
  }
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new AdapterRegistryError(
      'invalid-rule',
      `URL rule does not compile: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Registry pre-populated with the built-in syncers. */
export function createDefaultAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(bilibiliRegistration);
  registry.register(youtubeRegistration);
  registry.register(missavRegistration);
  registry.register(pornhubRegistration);
  registry.register(xvideosRegistration);
  return registry;
}

/** Default registry: serves Bilibili, YouTube, MissAV, Pornhub and XVideos. */
export const defaultAdapterRegistry = createDefaultAdapterRegistry();
