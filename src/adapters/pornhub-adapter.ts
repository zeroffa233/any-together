import { AdapterSiteError, type AdapterApplyResult, type AdapterEvent, type AdapterTargetState, type LocalPlaybackState, type ResourceAdapter } from './resource-adapter.js';
import type { MediaPhase, ResourceIdentity } from '../shared/protocol.js';
import type { AdapterPage, SyncerRegistration } from './adapter-registry.js';

/**
 * Structural view of the media element the adapter drives. Pornhub's view page
 * player is a plain HTMLVideoElement, so the shape matches the Bilibili and
 * YouTube adapters' minimal structural interface: tests pass a fake object
 * without casts while real elements still fit. The adapter deliberately never
 * touches site-private player globals — only the standard media surface
 * (play/pause/currentTime/playbackRate/readyState/duration/events) is used.
 */
export interface PornhubMediaElement {
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
export type PornhubMediaCollection = ArrayLike<PornhubMediaElement> & Iterable<PornhubMediaElement>;

export interface PornhubDocument {
  querySelectorAll(selectors: string): PornhubMediaCollection;
}

export interface PornhubPage {
  /**
   * Optional so registry-bound pages without a document still typecheck; the
   * adapter reports 'browser-required' when a media operation needs it.
   */
  document?: PornhubDocument;
  location: { readonly href: string };
}

const MEDIA_EVENTS: AdapterEvent[] = [
  'play', 'pause', 'seeking', 'seeked', 'waiting', 'playing', 'ended', 'error', 'ratechange', 'timeupdate',
];

/** `readyState` at which the media has enough data to advance playback. */
const HAVE_FUTURE_DATA = 3;
const SEEK_SETTLE_POLL_MS = 25;
const MAX_SEEK_SETTLE_POLLS = 20;

/** Host pattern for Pornhub sites: `pornhub.com` itself or any `*.pornhub.com` subdomain. */
const PORNHUB_HOST_PATTERN = /(^|\.)pornhub\.com$/;

/** Canonical base every Pornhub view identity collapses onto, host-independent. */
const PORNHUB_CANONICAL_BASE = 'https://www.pornhub.com/view_video.php?viewkey=';

/**
 * Full-URL pattern for Pornhub VIEW pages: `/view_video.php` with a non-empty
 * `viewkey=` query parameter in any position (`?viewkey=…` or
 * `?t=30&viewkey=…`). The serialized registry `AdapterUrlRule` uses `source`,
 * and the adapter's identity guard is written against the same shape, so the
 * registry rule and the identity policy cannot drift. Non-view Pornhub pages
 * (homepage, /video/… channels, search) and view pages without a viewkey are
 * deliberately excluded.
 */
export const PORNHUB_VIEW_URL_PATTERN = /^https?:\/\/(?:[^/]+\.)?pornhub\.com\/view_video\.php\?(?:[^#]*&)?viewkey=[^&#]+/;

export class PornhubAdapter implements ResourceAdapter {
  readonly adapterId = 'pornhub';
  private readonly page: PornhubPage;
  private target: PornhubMediaElement | undefined;
  private buffering = false;

  constructor(page?: PornhubPage) {
    // Resolve the browser globals lazily so `new PornhubAdapter()` never crashes in
    // Node; unit tests inject a fake page explicitly.
    this.page = page ?? { document: globalThis.document, location: globalThis.location };
  }

  identifyResource(): ResourceIdentity {
    const href = this.page.location?.href;
    if (typeof href !== 'string' || href.length === 0) {
      throw new AdapterSiteError('browser-required', 'PornhubAdapter needs a page location to identify the resource');
    }
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      throw new AdapterSiteError('invalid-url', `Cannot parse Pornhub page URL: ${href}`);
    }
    if (!PORNHUB_HOST_PATTERN.test(url.hostname)) {
      // 'not-bilibili' is the shared AdapterSiteErrorCode for "URL parses but is
      // not served by this adapter"; the union in resource-adapter.ts is not
      // site-extensible, so the message always names the actual site.
      throw new AdapterSiteError('not-bilibili', `Page host ${url.hostname} is not a Pornhub site`);
    }
    if (url.pathname !== '/view_video.php') {
      throw new AdapterSiteError('not-bilibili', `Page URL ${href} is not a Pornhub view_video page`);
    }
    const viewkey = url.searchParams.get('viewkey')?.trim() ?? '';
    if (viewkey.length === 0) {
      throw new AdapterSiteError('not-bilibili', `Page URL ${href} has no viewkey`);
    }
    // Canonical identity: rebuilt from the viewkey alone, so query order,
    // extra parameters (t, utm_source, ...) and the fragment never change the
    // resource, and every host (pornhub.com, www, country subdomains)
    // collapses onto one canonical view URL. The viewkey is also the
    // site-native resourceId, mirroring Bilibili's BV id and YouTube's v id.
    return {
      adapterId: this.adapterId,
      canonicalUrl: `${PORNHUB_CANONICAL_BASE}${encodeURIComponent(viewkey)}`,
      resourceId: viewkey,
    };
  }

  selectTarget(): void {
    const document = this.page.document;
    if (document === undefined || typeof document.querySelectorAll !== 'function') {
      throw new AdapterSiteError('browser-required', 'PornhubAdapter needs a page document to find a video');
    }
    const candidates = Array.from(document.querySelectorAll('video'))
      .filter((candidate) => candidate.readyState > 0 || Number.isFinite(candidate.duration));
    if (candidates.length === 0) {
      // Age gates, login walls and empty embed shells carry no playable
      // <video>; reporting no-media (never a fabricated success) is the
      // honest outcome for those pages.
      throw new AdapterSiteError('no-media', 'No playable Pornhub video found on this page');
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
      throw new AdapterSiteError('no-media', 'No playable Pornhub video found on this page');
    }
  }

  readState(): LocalPlaybackState {
    return this.readStateOf(this.requireTarget());
  }

  async applyState(targetState: AdapterTargetState): Promise<AdapterApplyResult> {
    let target: PornhubMediaElement;
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

  private requireTarget(): PornhubMediaElement {
    if (this.target === undefined) this.selectTarget();
    if (this.target === undefined) {
      throw new AdapterSiteError('no-media', 'No Pornhub video target is available');
    }
    return this.target;
  }

  /**
   * Deterministic mapping of the live media object onto shared phases, most
   * significant first: error > ended > seeking > paused > buffering > loading >
   * playing. A paused element stays 'paused' even while it buffers; a playing
   * element that stalls reports 'buffering' via the 'waiting' event.
   */
  private phaseFor(target: PornhubMediaElement): MediaPhase {
    if (target.error) return 'error';
    if (target.ended) return 'ended';
    if (target.seeking) return 'seeking';
    if (target.paused) return 'paused';
    if (this.buffering) return 'buffering';
    if (target.readyState < HAVE_FUTURE_DATA) return 'loading';
    return 'playing';
  }

  private readStateOf(target: PornhubMediaElement): LocalPlaybackState {
    return {
      resourceIdentity: this.identifyResource(),
      mediaPhase: this.phaseFor(target),
      positionSeconds: target.currentTime,
      playbackRate: target.playbackRate,
      durationSeconds: Number.isFinite(target.duration) ? target.duration : null,
    };
  }

  private applyPhase(target: PornhubMediaElement, phase: MediaPhase): Promise<void> | void {
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
  private async waitForSeekSettled(target: PornhubMediaElement): Promise<void> {
    if (!target.seeking) return;
    for (let attempt = 0; attempt < MAX_SEEK_SETTLE_POLLS && target.seeking; attempt += 1) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, SEEK_SETTLE_POLL_MS);
      await promise;
    }
  }

  private visibleArea(candidate: PornhubMediaElement): number {
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

  private bestEffortState(target: PornhubMediaElement): LocalPlaybackState {
    try {
      return this.readStateOf(target);
    } catch {
      return this.unplayableState();
    }
  }
}

/**
 * Registry contract for the Pornhub syncer: an http(s) page on pornhub.com
 * or a *.pornhub.com subdomain whose path is `/view_video.php` with a
 * non-empty `viewkey=` query parameter in any position. Other Pornhub pages
 * (homepage, /video/… categories, search, view without viewkey) do not
 * resolve to this syncer; the adapter's `identifyResource` enforces the same
 * view-page rule at identity time, so the registry rule and the identity
 * policy cannot drift.
 */
export const pornhubRegistration: SyncerRegistration = {
  adapterId: 'pornhub',
  name: 'Pornhub',
  domain: 'pornhub.com',
  // Serialized full-URL rule (source + flags survive JSON / structured clone):
  // only `/view_video.php` pages with a non-empty `viewkey=` query parameter
  // match, so `resolve` never hands non-view Pornhub pages to this syncer.
  urlRule: { source: PORNHUB_VIEW_URL_PATTERN.source },
  create: (page: AdapterPage) => {
    const document = page.document as PornhubDocument | undefined;
    return new PornhubAdapter(
      document === undefined
        ? { location: page.location }
        : { document, location: page.location },
    );
  },
  capabilities: ['play', 'pause', 'seek', 'set-rate', 'replay', 'native-events'],
};
