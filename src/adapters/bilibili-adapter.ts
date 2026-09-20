import { AdapterSiteError, type AdapterApplyResult, type AdapterEvent, type AdapterTargetState, type LocalPlaybackState, type ResourceAdapter } from './resource-adapter.js';
import { BILIBILI_VIDEO_PATH_PATTERN, type MediaPhase, type ResourceIdentity } from '../shared/protocol.js';
import { createBilibiliResourceIdentity } from '../shared/resource.js';
import type { AdapterPage, SyncerRegistration } from './adapter-registry.js';

/**
 * Structural view of the media element the adapter drives. Kept minimal so tests can
 * pass a fake object without casts while real `HTMLVideoElement` instances still fit.
 */
export interface BilibiliMediaElement {
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
export type BilibiliMediaCollection = ArrayLike<BilibiliMediaElement> & Iterable<BilibiliMediaElement>;

export interface BilibiliDocument {
  querySelectorAll(selectors: string): BilibiliMediaCollection;
}

export interface BilibiliPage {
  /**
   * Optional so registry-bound pages without a document still typecheck; the
   * adapter reports 'browser-required' when a media operation needs it.
   */
  document?: BilibiliDocument;
  location: { readonly href: string };
}

const MEDIA_EVENTS: AdapterEvent[] = [
  'play', 'pause', 'seeking', 'seeked', 'waiting', 'playing', 'ended', 'error', 'ratechange', 'timeupdate',
];

/** `readyState` at which the media has enough data to advance playback. */
const HAVE_FUTURE_DATA = 3;
const SEEK_SETTLE_POLL_MS = 25;
const MAX_SEEK_SETTLE_POLLS = 20;

const BILIBILI_HOST_PATTERN = /(^|\.)bilibili\.com$/;

export class BilibiliAdapter implements ResourceAdapter {
  readonly adapterId = 'bilibili';
  private readonly page: BilibiliPage;
  private target: BilibiliMediaElement | undefined;
  private buffering = false;

  constructor(page?: BilibiliPage) {
    // Resolve the browser globals lazily so `new BilibiliAdapter()` never crashes in
    // Node; unit tests inject a fake page explicitly.
    this.page = page ?? { document: globalThis.document, location: globalThis.location };
  }

  identifyResource(): ResourceIdentity {
    const href = this.page.location?.href;
    if (typeof href !== 'string' || href.length === 0) {
      throw new AdapterSiteError('browser-required', 'BilibiliAdapter needs a page location to identify the resource');
    }
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      throw new AdapterSiteError('invalid-url', `Cannot parse Bilibili page URL: ${href}`);
    }
    if (!BILIBILI_HOST_PATTERN.test(url.hostname)) {
      throw new AdapterSiteError('not-bilibili', `Page host ${url.hostname} is not a Bilibili site`);
    }
    if (!BILIBILI_VIDEO_PATH_PATTERN.test(`${url.origin}${url.pathname}`)) {
      throw new AdapterSiteError('not-bilibili', `Page URL ${href} is not a Bilibili video page`);
    }
    // Same normalization as the CLI's createBilibiliResourceIdentity: origin +
    // slash-trimmed pathname, plus the BV id when the path carries one.
    return createBilibiliResourceIdentity(href);
  }

  selectTarget(): void {
    const document = this.page.document;
    if (document === undefined || typeof document.querySelectorAll !== 'function') {
      throw new AdapterSiteError('browser-required', 'BilibiliAdapter needs a page document to find a video');
    }
    const candidates = Array.from(document.querySelectorAll('video'))
      .filter((candidate) => candidate.readyState > 0 || Number.isFinite(candidate.duration));
    if (candidates.length === 0) {
      throw new AdapterSiteError('no-media', 'No playable Bilibili video found on this page');
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
      throw new AdapterSiteError('no-media', 'No playable Bilibili video found on this page');
    }
  }

  readState(): LocalPlaybackState {
    return this.readStateOf(this.requireTarget());
  }

  async applyState(targetState: AdapterTargetState): Promise<AdapterApplyResult> {
    let target: BilibiliMediaElement;
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

  private requireTarget(): BilibiliMediaElement {
    if (this.target === undefined) this.selectTarget();
    if (this.target === undefined) {
      throw new AdapterSiteError('no-media', 'No Bilibili video target is available');
    }
    return this.target;
  }

  /**
   * Deterministic mapping of the live media object onto shared phases, most
   * significant first: error > ended > seeking > paused > buffering > loading >
   * playing. A paused element stays 'paused' even while it buffers; a playing
   * element that stalls reports 'buffering' via the 'waiting' event.
   */
  private phaseFor(target: BilibiliMediaElement): MediaPhase {
    if (target.error) return 'error';
    if (target.ended) return 'ended';
    if (target.seeking) return 'seeking';
    if (target.paused) return 'paused';
    if (this.buffering) return 'buffering';
    if (target.readyState < HAVE_FUTURE_DATA) return 'loading';
    return 'playing';
  }

  private readStateOf(target: BilibiliMediaElement): LocalPlaybackState {
    return {
      resourceIdentity: this.identifyResource(),
      mediaPhase: this.phaseFor(target),
      positionSeconds: target.currentTime,
      playbackRate: target.playbackRate,
      durationSeconds: Number.isFinite(target.duration) ? target.duration : null,
    };
  }

  private applyPhase(target: BilibiliMediaElement, phase: MediaPhase): Promise<void> | void {
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
  private async waitForSeekSettled(target: BilibiliMediaElement): Promise<void> {
    if (!target.seeking) return;
    for (let attempt = 0; attempt < MAX_SEEK_SETTLE_POLLS && target.seeking; attempt += 1) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, SEEK_SETTLE_POLL_MS);
      await promise;
    }
  }

  private visibleArea(candidate: BilibiliMediaElement): number {
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

  private bestEffortState(target: BilibiliMediaElement): LocalPlaybackState {
    try {
      return this.readStateOf(target);
    } catch {
      return this.unplayableState();
    }
  }
}

/**
 * Registry contract for the Bilibili syncer: an http(s) page on bilibili.com
 * or a *.bilibili.com subdomain whose path is `/video` or `/video/...`.
 * Other Bilibili pages do not resolve to this syncer; the adapter's
 * `identifyResource` enforces the same video-path rule at identity time,
 * mirroring the shared identity guards.
 */
export const bilibiliRegistration: SyncerRegistration = {
  adapterId: 'bilibili',
  name: 'Bilibili',
  domain: 'bilibili.com',
  // Serialized full-URL rule (source + flags survive JSON / structured clone):
  // only `/video` and `/video/...` pages match, so `resolve` never hands
  // non-video Bilibili pages to this syncer. The source is shared with the
  // identity guards, so the registry rule and identity policy cannot drift.
  urlRule: { source: BILIBILI_VIDEO_PATH_PATTERN.source },
  create: (page: AdapterPage) => {
    const document = page.document as BilibiliDocument | undefined;
    return new BilibiliAdapter(
      document === undefined
        ? { location: page.location }
        : { document, location: page.location },
    );
  },
  capabilities: ['play', 'pause', 'seek', 'set-rate', 'replay', 'native-events'],
};
