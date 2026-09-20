import { AdapterSiteError, type AdapterApplyResult, type AdapterEvent, type AdapterTargetState, type LocalPlaybackState, type ResourceAdapter } from './resource-adapter.js';
import type { MediaPhase, ResourceIdentity } from '../shared/protocol.js';
import type { AdapterPage, SyncerRegistration } from './adapter-registry.js';

/**
 * Structural view of the media element the adapter drives. XVideos' player is
 * a plain HTML5VideoElement, so the shape matches the Bilibili/YouTube
 * adapters' minimal structural interface: tests pass a fake object without
 * casts while real elements still fit. Only the public media surface is used
 * — no private player API or page-internal state.
 */
export interface XvideosMediaElement {
  readonly error: unknown;
  readonly ended: boolean;
  readonly seeking: boolean;
  readonly paused: boolean;
  readonly readyState: number;
  readonly duration: number;
  currentTime: number;
  playbackRate: number;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  getBoundingClientRect(): { readonly width: number; readonly height: number };
}

/** Collection of media candidates: real NodeLists and plain arrays both fit. */
export type XvideosMediaCollection = ArrayLike<XvideosMediaElement> & Iterable<XvideosMediaElement>;

export interface XvideosDocument {
  querySelectorAll(selectors: string): XvideosMediaCollection;
}

export interface XvideosPage {
  /**
   * Optional so registry-bound pages without a document still typecheck; the
   * adapter reports 'browser-required' when a media operation needs it.
   */
  document?: XvideosDocument;
  location: { readonly href: string };
}

const MEDIA_EVENTS: AdapterEvent[] = [
  'play', 'pause', 'seeking', 'seeked', 'waiting', 'playing', 'ended', 'error', 'ratechange', 'timeupdate',
];

/** `readyState` at which the media has enough data to advance playback. */
const HAVE_FUTURE_DATA = 3;
const SEEK_SETTLE_POLL_MS = 25;
const MAX_SEEK_SETTLE_POLLS = 20;

/** Host pattern for XVideos sites: `xvideos.com` itself or any `*.xvideos.com` subdomain. */
const XVIDEOS_HOST_PATTERN = /(^|\.)xvideos\.com$/;

/** Canonical base every XVideos video identity collapses onto, host-independent. */
const XVIDEOS_CANONICAL_BASE = 'https://www.xvideos.com/video.';

/**
 * Full-URL pattern for XVideos VIDEO pages in the current (encoded-id) shape:
 * `/video.<encoded-id>/<slug>` with a non-empty base36-style encoded id and a
 * non-empty slug, e.g. `https://www.xvideos.com/video.k3mrbkHfabc/title_slug`.
 *
 * Deliberately rejected:
 * - legacy numeric ids (`/video123456789/...`): the numeric URL format is dead
 *   on XVideos (404s), so this adapter makes no claim for it;
 * - id-only URLs (`/video.<id>` without a slug), empty ids (`/video.`), and
 *   every non-video path (homepage, tags, porn-videos, ...);
 * - query strings and fragments after the slug: video page URLs carry none.
 *
 * The encoded id is captured so the canonical identity can be rebuilt from it
 * alone — the slug is cosmetic (XVideos redirects wrong slugs onto the
 * canonical slug), so slug variants must never change the resource identity.
 * The serialized registry `AdapterUrlRule` uses `source`, and the adapter's
 * identity guard tests the same full-URL pattern, so the registry rule and
 * the identity policy cannot drift.
 */
export const XVIDEOS_VIDEO_URL_PATTERN = /^https?:\/\/(?:[^/]+\.)?xvideos\.com\/video\.([A-Za-z0-9]+)\/[^\/?#]+$/;

export class XvideosAdapter implements ResourceAdapter {
  readonly adapterId = 'xvideos';
  private readonly page: XvideosPage;
  private target: XvideosMediaElement | undefined;
  private buffering = false;

  constructor(page?: XvideosPage) {
    // Resolve the browser globals lazily so `new XvideosAdapter()` never crashes in
    // Node; unit tests inject a fake page explicitly.
    this.page = page ?? { document: globalThis.document, location: globalThis.location };
  }

  identifyResource(): ResourceIdentity {
    const href = this.page.location?.href;
    if (typeof href !== 'string' || href.length === 0) {
      throw new AdapterSiteError('browser-required', 'XvideosAdapter needs a page location to identify the resource');
    }
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      throw new AdapterSiteError('invalid-url', `Cannot parse XVideos page URL: ${href}`);
    }
    if (!XVIDEOS_HOST_PATTERN.test(url.hostname)) {
      // 'not-bilibili' is the shared AdapterSiteErrorCode for "URL parses but is
      // not served by this adapter"; the union in resource-adapter.ts is not
      // site-extensible, so the message always names the actual site.
      throw new AdapterSiteError('not-bilibili', `Page host ${url.hostname} is not an XVideos site`);
    }
    if (!XVIDEOS_VIDEO_URL_PATTERN.test(href)) {
      throw new AdapterSiteError('not-bilibili', `Page URL ${href} is not an XVideos video page`);
    }
    const encodedId = XVIDEOS_VIDEO_URL_PATTERN.exec(href)?.[1];
    if (encodedId === undefined || encodedId.length === 0) {
      // Unreachable while the pattern above passes; kept as a hard guard so the
      // canonical identity can never be built from an empty id.
      throw new AdapterSiteError('not-bilibili', `Page URL ${href} has no XVideos video id`);
    }
    // Canonical identity: rebuilt from the encoded id alone, so the slug (SEO
    // text that XVideos itself redirects onto its canonical form), host and any
    // page state never change the resource. The encoded id is also the
    // site-native resourceId, mirroring Bilibili's BV id and YouTube's v id.
    return {
      adapterId: this.adapterId,
      canonicalUrl: `${XVIDEOS_CANONICAL_BASE}${encodedId}`,
      resourceId: encodedId,
    };
  }

  selectTarget(): void {
    const document = this.page.document;
    if (document === undefined || typeof document.querySelectorAll !== 'function') {
      throw new AdapterSiteError('browser-required', 'XvideosAdapter needs a page document to find a video');
    }
    const candidates = Array.from(document.querySelectorAll('video'))
      .filter((candidate) => candidate.readyState > 0 || Number.isFinite(candidate.duration));
    if (candidates.length === 0) {
      // Also covers age-gated / geo-blocked pages: when XVideos cannot serve the
      // video there is no playable <video> and the adapter must say so instead
      // of fabricating a target.
      throw new AdapterSiteError('no-media', 'No playable XVideos video found on this page');
    }
    // Deterministic: the largest visible candidate wins, ties break by document order.
    const scored = candidates.map((candidate, index) => ({
      candidate,
      index,
      area: this.visibleArea(candidate),
    }));
    scored.sort((left, right) => right.area - left.area || left.index - right.index);
    this.target = scored[0]?.candidate;
    if (this.target === undefined) {
      throw new AdapterSiteError('no-media', 'No playable XVideos video found on this page');
    }
  }

  readState(): LocalPlaybackState {
    return this.readStateOf(this.requireTarget());
  }

  async applyState(targetState: AdapterTargetState): Promise<AdapterApplyResult> {
    let target: XvideosMediaElement;
    try {
      target = this.requireTarget();
    } catch (error) {
      if (error instanceof AdapterSiteError) {
        return { result: 'unsupported', error: error.message, state: this.unplayableState() };
      }
      throw error;
    }
    try {
      if (!Number.isFinite(targetState.playbackRate) || targetState.playbackRate <= 0) {
        throw new Error(`Unsupported playback rate: ${targetState.playbackRate}`);
      }
      await this.applyPhase(target, targetState.mediaPhase);
      if (Number.isFinite(targetState.positionSeconds)) {
        if (Math.abs(target.currentTime - targetState.positionSeconds) > 0.25) {
          target.currentTime = targetState.positionSeconds;
          await this.waitForSeekSettled(target);
        }
      }
      target.playbackRate = targetState.playbackRate;
      return { result: 'applied', state: this.readStateOf(target) };
    } catch (error) {
      if (error instanceof AdapterSiteError) {
        return { result: 'unsupported', error: error.message, state: this.unplayableState() };
      }
      return {
        result: 'rejected',
        error: error instanceof Error ? error.message : String(error),
        state: this.bestEffortState(target),
      };
    }
  }

  subscribe(listener: (event: AdapterEvent) => void): () => void {
    const target = this.requireTarget();
    const handlers = new Map<AdapterEvent, EventListener>();
    for (const event of MEDIA_EVENTS) {
      const handler: EventListener = () => {
        this.noteMediaEvent(event);
        listener(event);
      };
      handlers.set(event, handler);
      target.addEventListener(event, handler);
    }
    return () => {
      for (const [event, handler] of handlers) {
        target.removeEventListener(event, handler);
      }
    };
  }

  private requireTarget(): XvideosMediaElement {
    if (this.target === undefined) this.selectTarget();
    if (this.target === undefined) {
      throw new AdapterSiteError('no-media', 'No XVideos video target is available');
    }
    return this.target;
  }

  /**
   * Deterministic mapping of the live media object onto shared phases, most
   * significant first: error > ended > seeking > paused > buffering > loading >
   * playing. A paused element stays 'paused' even while it buffers; a playing
   * element that stalls reports 'buffering' via the 'waiting' event.
   */
  private phaseFor(target: XvideosMediaElement): MediaPhase {
    if (target.error) return 'error';
    if (target.ended) return 'ended';
    if (target.seeking) return 'seeking';
    if (target.paused) return 'paused';
    if (this.buffering) return 'buffering';
    if (target.readyState < HAVE_FUTURE_DATA) return 'loading';
    return 'playing';
  }

  private readStateOf(target: XvideosMediaElement): LocalPlaybackState {
    return {
      resourceIdentity: this.identifyResource(),
      mediaPhase: this.phaseFor(target),
      positionSeconds: target.currentTime,
      playbackRate: target.playbackRate,
      durationSeconds: Number.isFinite(target.duration) ? target.duration : null,
    };
  }

  private applyPhase(target: XvideosMediaElement, phase: MediaPhase): Promise<void> | void {
    switch (phase) {
      case 'playing':
        return target.play();
      case 'paused':
      case 'ended':
      case 'ready':
        // 'ready' is the authority's fresh-resource phase; keep the media
        // paused so page autoplay cannot start playback and turn the real
        // phase into a false mismatch against the authoritative state.
        target.pause();
        return;
      case 'seeking':
      case 'buffering':
      case 'loading':
      case 'error':
        // Observed-only phases are not directly enforceable; position/rate still apply.
        return;
    }
  }

  /** Poll briefly so a returned 'applied' state reflects the settled seek, not 'seeking'. */
  private async waitForSeekSettled(target: XvideosMediaElement): Promise<void> {
    if (!target.seeking) return;
    for (let attempt = 0; attempt < MAX_SEEK_SETTLE_POLLS && target.seeking; attempt += 1) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, SEEK_SETTLE_POLL_MS);
      await promise;
    }
  }

  private visibleArea(candidate: XvideosMediaElement): number {
    if (typeof candidate.getBoundingClientRect !== 'function') return 0;
    try {
      const rect = candidate.getBoundingClientRect();
      return Math.max(0, rect.width * rect.height);
    } catch {
      return 0;
    }
  }

  private noteMediaEvent(event: AdapterEvent): void {
    switch (event) {
      case 'waiting':
        this.buffering = true;
        return;
      case 'play':
      case 'playing':
      case 'pause':
      case 'seeked':
      case 'ended':
      case 'error':
        this.buffering = false;
        return;
      default:
        return;
    }
  }

  /** Neutral state for 'unsupported' results: identity plus an inert media snapshot. */
  private unplayableState(): LocalPlaybackState {
    let resourceIdentity: ResourceIdentity;
    try {
      resourceIdentity = this.identifyResource();
    } catch {
      const href = this.page.location?.href;
      resourceIdentity = { adapterId: this.adapterId, canonicalUrl: typeof href === 'string' ? href : '' };
    }
    return {
      resourceIdentity,
      mediaPhase: 'paused',
      positionSeconds: 0,
      playbackRate: 1,
      durationSeconds: null,
    };
  }

  private bestEffortState(target: XvideosMediaElement): LocalPlaybackState {
    try {
      return this.readStateOf(target);
    } catch {
      return this.unplayableState();
    }
  }
}

/**
 * Registry contract for the XVideos syncer: an http(s) page on xvideos.com or
 * a *.xvideos.com subdomain whose path is a current-shape video page
 * `/video.<encoded-id>/<slug>`. Homepage, tag/browse pages and the dead
 * legacy numeric format (`/video123456...`) do not resolve to this syncer;
 * the adapter's `identifyResource` enforces the same full-URL rule at
 * identity time, so the registry rule and the identity policy cannot drift.
 */
export const xvideosRegistration: SyncerRegistration = {
  adapterId: 'xvideos',
  name: 'XVideos',
  domain: 'xvideos.com',
  // Serialized full-URL rule (source + flags survive JSON / structured clone):
  // only current-shape video pages match, so `resolve` never hands non-video
  // or legacy-numeric XVideos pages to this syncer.
  urlRule: { source: XVIDEOS_VIDEO_URL_PATTERN.source },
  create: (page: AdapterPage) => {
    const document = page.document as XvideosDocument | undefined;
    return new XvideosAdapter(
      document === undefined
        ? { location: page.location }
        : { document, location: page.location },
    );
  },
  capabilities: ['play', 'pause', 'seek', 'set-rate', 'replay', 'native-events'],
};
