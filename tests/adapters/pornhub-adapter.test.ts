/**
 * Node unit tests for the Pornhub page adapter.
 *
 * Every test injects a fake page (document / location / media element), so nothing
 * reads browser globals; two tests prove that isolation explicitly. Failure paths
 * are asserted as explicit results ('rejected' / 'unsupported' with messages),
 * never as fabricated 'applied' outcomes. Age-gate / login-wall pages are covered
 * as pages without playable media: they must report no-media / unsupported, never
 * success. The adapter only drives the standard HTMLVideoElement surface (fake
 * media objects below), never a site-private player API. The same fake page drives
 * the registry tests at the bottom: Pornhub view URLs resolve to the pornhub
 * syncer in a fresh registry, and the default registry serves all five built-in
 * syncers, pornhub included.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PornhubAdapter,
  type PornhubMediaCollection,
  type PornhubMediaElement,
  type PornhubPage,
  pornhubRegistration,
} from '../../src/adapters/pornhub-adapter.js';
import {
  AdapterSiteError,
  type AdapterEvent,
  type AdapterSiteErrorCode,
  type AdapterTargetState,
} from '../../src/adapters/resource-adapter.js';
import { AdapterRegistry, AdapterRegistryError, createDefaultAdapterRegistry } from '../../src/adapters/adapter-registry.js';
import { isValidResourceIdentity } from '../../src/shared/protocol.js';

const PORNHUB_URL = 'https://www.pornhub.com/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d';
const VIEWKEY = 'ph5f2e8a1b3c4d5e6f7a8b9c0d';
/** The canonical identity every view URL collapses onto. */
const CANONICAL_URL = `https://www.pornhub.com/view_video.php?viewkey=${VIEWKEY}`;

/** All native media events the adapter surfaces to subscribers. */
const ALL_MEDIA_EVENTS: readonly AdapterEvent[] = [
  'play', 'pause', 'seeking', 'seeked', 'waiting', 'playing', 'ended', 'error', 'ratechange', 'timeupdate',
];

type FakeMediaOptions = {
  paused?: boolean;
  readyState?: number;
  duration?: number;
  currentTime?: number;
  playbackRate?: number;
  rect?: { width: number; height: number };
};

/** Scripted media element: records native calls, exposes event bindings, emits on demand. */
class FakeMedia implements PornhubMediaElement {
  error: unknown = null;
  ended = false;
  seeking = false;
  paused: boolean;
  readyState: number;
  duration: number;
  playbackRate: number;
  rect: { width: number; height: number };
  playCalls = 0;
  pauseCalls = 0;
  private _currentTime: number;
  private readonly playRejections: Error[] = [];
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(options: FakeMediaOptions = {}) {
    this.paused = options.paused ?? true;
    this.readyState = options.readyState ?? 4;
    this.duration = options.duration ?? 600;
    this._currentTime = options.currentTime ?? 0;
    this.playbackRate = options.playbackRate ?? 1;
    this.rect = options.rect ?? { width: 640, height: 360 };
  }

  get currentTime(): number {
    return this._currentTime;
  }

  set currentTime(value: number) {
    this._currentTime = value;
    // Real-time settle is deliberate: the adapter under test observes the
    // element's `seeking` flag by polling its own wall-clock setTimeout
    // (SEEK_SETTLE_POLL_MS in the source), so the fake must settle on the real
    // clock too — fake timers cannot drive the source module's timers.
    this.seeking = true;
    setTimeout(() => {
      this.seeking = false;
    }, 10);
  }

  play(): Promise<void> {
    this.playCalls += 1;
    const rejection = this.playRejections.shift();
    if (rejection !== undefined) {
      return Promise.reject(rejection);
    }
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }

  addEventListener(type: string, listener: EventListener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set<EventListener>();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  getBoundingClientRect(): { readonly width: number; readonly height: number } {
    return this.rect;
  }

  /** Script the next `play()` call to reject with this error. */
  rejectNextPlay(error: Error): void {
    this.playRejections.push(error);
  }

  /** Count of bound listeners for one event, or across all events when omitted. */
  listenerCount(event?: string): number {
    if (event === undefined) {
      let total = 0;
      for (const set of this.listeners.values()) total += set.size;
      return total;
    }
    return this.listeners.get(event)?.size ?? 0;
  }

  /** Fire a native event at every listener bound for `type`. */
  emit(type: string): void {
    const set = this.listeners.get(type);
    if (set === undefined) return;
    for (const listener of [...set]) {
      listener(new Event(type));
    }
  }
}

function makePage(media: PornhubMediaElement[], href: string): PornhubPage {
  return {
    document: {
      querySelectorAll: (_selectors: string): PornhubMediaCollection => media,
    },
    location: { href },
  };
}

function targetState(overrides: Partial<AdapterTargetState> = {}): AdapterTargetState {
  return { mediaPhase: 'paused', positionSeconds: 0, playbackRate: 1, ...overrides };
}

function assertAdapterSiteError(code: AdapterSiteErrorCode, fn: () => unknown): AdapterSiteError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof AdapterSiteError, `expected AdapterSiteError, got: ${String(thrown)}`);
  const siteError = thrown as AdapterSiteError;
  assert.equal(siteError.code, code);
  return siteError;
}

test('identifyResource returns a normalized Pornhub identity', () => {
  const adapter = new PornhubAdapter(makePage([], 'https://www.pornhub.com/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d&t=30&utm_source=test'));
  assert.equal(adapter.adapterId, 'pornhub');
  const identity = adapter.identifyResource();
  assert.equal(identity.adapterId, 'pornhub');
  // Extra query parameters are dropped; the identity is rebuilt from viewkey alone.
  assert.equal(identity.canonicalUrl, CANONICAL_URL);
  assert.equal(identity.resourceId, VIEWKEY);
  assert.equal(isValidResourceIdentity(identity), true, 'produced identities must pass the shared resource gate');

  const bare = new PornhubAdapter(makePage([], 'https://www.pornhub.com/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d')).identifyResource();
  assert.equal(bare.canonicalUrl, CANONICAL_URL);
  assert.equal(bare.resourceId, VIEWKEY);
  assert.equal(isValidResourceIdentity(bare), true, 'a normalized identity must pass the shared resource gate');
});

test('identifyResource normalizes query order, extra parameters and fragments', () => {
  const reshuffled = new PornhubAdapter(makePage([], 'https://pornhub.com/view_video.php?utm_source=test&t=30&viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d#frag')).identifyResource();
  assert.equal(reshuffled.canonicalUrl, CANONICAL_URL);
  assert.equal(reshuffled.resourceId, VIEWKEY);

  const fragmentOnly = new PornhubAdapter(makePage([], 'https://www.pornhub.com/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d#t=1m30s')).identifyResource();
  assert.equal(fragmentOnly.canonicalUrl, CANONICAL_URL);

  // A viewkey after unrelated parameters in any order still normalizes.
  const reordered = new PornhubAdapter(makePage([], 'https://www.pornhub.com/view_video.php?a=1&viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d&b=2')).identifyResource();
  assert.equal(reordered.canonicalUrl, CANONICAL_URL);
  assert.equal(reordered.resourceId, VIEWKEY);
});

test('identifyResource collapses every Pornhub host onto one canonical URL', () => {
  const hosts = [
    'https://pornhub.com/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d',
    'https://www.pornhub.com/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d',
    'https://de.pornhub.com/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d',
    'https://pornhub.com.evil.example/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d',
  ];
  for (const href of hosts) {
    // The last entry is a lookalike host: it must be rejected, not normalized.
    if (href.includes('evil.example')) {
      const error = assertAdapterSiteError(
        'not-bilibili',
        () => new PornhubAdapter(makePage([], href)).identifyResource(),
      );
      assert.match(error.message, /not a Pornhub site/);
      continue;
    }
    const identity = new PornhubAdapter(makePage([], href)).identifyResource();
    assert.equal(identity.canonicalUrl, CANONICAL_URL, `${href} must collapse onto the canonical URL`);
    assert.equal(identity.resourceId, VIEWKEY, `${href} must keep the viewkey`);
  }
});

test('identifyResource rejects non-view Pornhub pages with no viewkey', () => {
  const nonViewPages = [
    'https://www.pornhub.com/',
    'https://www.pornhub.com/video/abc123',
    'https://www.pornhub.com/video/search?q=test',
    'https://www.pornhub.com/view_video.php',
    'https://www.pornhub.com/view_video.php?viewkey=',
    'https://www.pornhub.com/view_video.php?viewkey=%20',
    'https://www.pornhub.com/view_video.php?t=30&list=PLabc',
    'https://www.pornhub.com/view_video.php/abc',
    'https://www.pornhub.com/view_video',
  ];
  for (const href of nonViewPages) {
    const error = assertAdapterSiteError(
      'not-bilibili',
      () => new PornhubAdapter(makePage([], href)).identifyResource(),
    );
    assert.match(error.message, /not a Pornhub view_video page|has no viewkey/);
  }
});

test('identifyResource rejects hosts that are not Pornhub with not-bilibili', () => {
  const foreignHosts = [
    'https://example.com/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d',
    'https://evilypornhub.com/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d',
    'https://pornhub.co/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d',
    'https://pornhub.org/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d',
    'https://notpornhub.com/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d',
  ];
  for (const href of foreignHosts) {
    const error = assertAdapterSiteError(
      'not-bilibili',
      () => new PornhubAdapter(makePage([], href)).identifyResource(),
    );
    assert.match(error.message, /not a Pornhub site/);
  }
});

test('identifyResource rejects unparseable or missing URLs explicitly', () => {
  const invalid = assertAdapterSiteError(
    'invalid-url',
    () => new PornhubAdapter(makePage([], 'not a url')).identifyResource(),
  );
  assert.match(invalid.message, /Cannot parse/);

  const emptyHref = assertAdapterSiteError(
    'browser-required',
    () => new PornhubAdapter(makePage([], '')).identifyResource(),
  );
  assert.match(emptyHref.message, /page location/);

  const noLocation = assertAdapterSiteError(
    'browser-required',
    () => new PornhubAdapter({ document: makePage([], PORNHUB_URL).document } as unknown as PornhubPage).identifyResource(),
  );
  assert.match(noLocation.message, /page location/);
});

test('adapter constructed without a page fails explicitly in Node', { timeout: 5000 }, async () => {
  const adapter = new PornhubAdapter();
  assertAdapterSiteError('browser-required', () => adapter.identifyResource());
  assertAdapterSiteError('browser-required', () => adapter.selectTarget());

  const result = await adapter.applyState(targetState());
  assert.equal(result.result, 'unsupported');
  assert.match(result.error ?? '', /page document/);
  // Neutral placeholder state, not a fabricated success.
  assert.equal(result.state.mediaPhase, 'paused');
  assert.equal(result.state.positionSeconds, 0);
  assert.equal(result.state.resourceIdentity.canonicalUrl, '');
});

test('injected page is used exclusively; browser globals are never read', { timeout: 5000 }, async () => {
  const globals = globalThis as Record<string, unknown>;
  const originalDocument = globals.document;
  const originalLocation = globals.location;
  const documentSpy = {
    querySelectorAll: (): never => {
      throw new Error('adapter read globalThis.document');
    },
  };
  const locationSpy = {
    get href(): never {
      throw new Error('adapter read globalThis.location');
    },
  };
  Object.defineProperty(globalThis, 'document', { value: documentSpy, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', { value: locationSpy, configurable: true, writable: true });
  try {
    const media = new FakeMedia({ currentTime: 7 });
    const adapter = new PornhubAdapter(makePage([media], PORNHUB_URL));
    assert.equal(adapter.identifyResource().canonicalUrl, CANONICAL_URL);
    adapter.selectTarget();
    assert.equal(adapter.readState().positionSeconds, 7);

    const result = await adapter.applyState(targetState({ mediaPhase: 'playing', positionSeconds: 7 }));
    assert.equal(result.result, 'applied');
    assert.equal(result.state.mediaPhase, 'playing');
  } finally {
    if (originalDocument === undefined) {
      delete globals.document;
    } else {
      globals.document = originalDocument;
    }
    if (originalLocation === undefined) {
      delete globals.location;
    } else {
      globals.location = originalLocation;
    }
  }
});

test('selectTarget picks the largest visible video', () => {
  const small = new FakeMedia({ currentTime: 11, rect: { width: 640, height: 360 } });
  const large = new FakeMedia({ currentTime: 22, rect: { width: 1920, height: 1080 } });
  const adapter = new PornhubAdapter(makePage([small, large], PORNHUB_URL));
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 22);
});

test('selectTarget breaks area ties by document order', () => {
  const first = new FakeMedia({ currentTime: 33, rect: { width: 800, height: 600 } });
  const second = new FakeMedia({ currentTime: 44, rect: { width: 800, height: 600 } });
  const adapter = new PornhubAdapter(makePage([first, second], PORNHUB_URL));
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 33);
});

test('selectTarget ignores candidates that have no playable data', () => {
  const stale = new FakeMedia({ currentTime: 1, readyState: 0, duration: Number.NaN });
  const playable = new FakeMedia({ currentTime: 2 });
  const adapter = new PornhubAdapter(makePage([stale, playable], PORNHUB_URL));
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 2);
});

test('selectTarget tolerates candidates without a measurable rect as zero area', () => {
  const unmeasured = {
    error: null,
    ended: false,
    seeking: false,
    paused: true,
    readyState: 4,
    duration: 600,
    currentTime: 5,
    playbackRate: 1,
    play(): Promise<void> {
      return Promise.resolve();
    },
    pause(): void {},
    addEventListener(): void {},
    removeEventListener(): void {},
  } as unknown as PornhubMediaElement;
  const adapter = new PornhubAdapter(makePage([unmeasured], PORNHUB_URL));
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 5);
});

test('age gate and login wall pages without playable media report no-media, never success', { timeout: 5000 }, async () => {
  // An age-gate or login screen carries no <video> at all.
  const walled = new PornhubAdapter(makePage([], PORNHUB_URL));
  const error = assertAdapterSiteError('no-media', () => walled.selectTarget());
  assert.match(error.message, /No playable Pornhub video/);
  assertAdapterSiteError('no-media', () => walled.readState());

  const result = await walled.applyState(targetState({ mediaPhase: 'playing' }));
  assert.equal(result.result, 'unsupported');
  assert.match(result.error ?? '', /No playable Pornhub video/);
  // The unsupported placeholder carries the real page identity, not a fake success.
  assert.equal(result.state.mediaPhase, 'paused');
  assert.equal(result.state.positionSeconds, 0);
  assert.equal(result.state.resourceIdentity.canonicalUrl, CANONICAL_URL);
  assert.equal(result.state.resourceIdentity.resourceId, VIEWKEY);
  assert.equal(isValidResourceIdentity(result.state.resourceIdentity), true, 'the unsupported placeholder must still satisfy the shared resource gate');

  // A walled embed shell whose only <video> has no playable data behaves the same.
  const shell = new PornhubAdapter(makePage([new FakeMedia({ readyState: 0, duration: Number.NaN })], PORNHUB_URL));
  assertAdapterSiteError('no-media', () => shell.selectTarget());
  const shellResult = await shell.applyState(targetState());
  assert.equal(shellResult.result, 'unsupported');
  assert.match(shellResult.error ?? '', /No playable Pornhub video/);
});

test('readState maps live media signals onto shared phases', () => {
  const media = new FakeMedia({ paused: false, readyState: 4 });
  const adapter = new PornhubAdapter(makePage([media], PORNHUB_URL));
  adapter.selectTarget();

  const snapshot = adapter.readState();
  assert.equal(snapshot.mediaPhase, 'playing');
  assert.equal(snapshot.durationSeconds, 600);
  assert.equal(snapshot.resourceIdentity.canonicalUrl, CANONICAL_URL);
  assert.equal(isValidResourceIdentity(snapshot.resourceIdentity), true, 'read-state snapshots must pass the shared resource gate');

  media.error = new Error('media failure');
  assert.equal(adapter.readState().mediaPhase, 'error');

  media.error = null;
  media.ended = true;
  assert.equal(adapter.readState().mediaPhase, 'ended');

  media.ended = false;
  media.seeking = true;
  assert.equal(adapter.readState().mediaPhase, 'seeking');

  media.seeking = false;
  media.paused = true;
  assert.equal(adapter.readState().mediaPhase, 'paused');

  media.paused = false;
  media.readyState = 2;
  assert.equal(adapter.readState().mediaPhase, 'loading');

  media.readyState = 4;
  assert.equal(adapter.readState().mediaPhase, 'playing');
});

test('waiting marks buffering and playing clears it; paused wins while buffering', () => {
  const media = new FakeMedia({ paused: false });
  const adapter = new PornhubAdapter(makePage([media], PORNHUB_URL));
  adapter.selectTarget();
  const received: AdapterEvent[] = [];
  const unsubscribe = adapter.subscribe((event) => {
    received.push(event);
  });

  media.emit('waiting');
  assert.equal(adapter.readState().mediaPhase, 'buffering');
  assert.deepEqual(received, ['waiting']);

  media.emit('playing');
  assert.equal(adapter.readState().mediaPhase, 'playing');
  assert.deepEqual(received, ['waiting', 'playing']);

  // A paused element stays 'paused' even while it buffers.
  media.paused = true;
  media.emit('waiting');
  assert.equal(adapter.readState().mediaPhase, 'paused');

  unsubscribe();
});

test('applyState pauses and reads back the real state', { timeout: 5000 }, async () => {
  const media = new FakeMedia({ paused: false, currentTime: 12.5 });
  const adapter = new PornhubAdapter(makePage([media], PORNHUB_URL));
  adapter.selectTarget();

  const result = await adapter.applyState(targetState({ mediaPhase: 'paused', positionSeconds: 12.5 }));
  assert.equal(result.result, 'applied');
  assert.equal(media.pauseCalls, 1);
  assert.equal(media.paused, true);
  assert.equal(result.state.mediaPhase, 'paused');
  assert.equal(result.state.positionSeconds, 12.5);
  assert.equal(result.state.playbackRate, 1);
  assert.equal(result.state.durationSeconds, 600);
});

test('applyState seeks beyond the threshold and reads back the settled position', { timeout: 5000 }, async () => {
  const media = new FakeMedia({ currentTime: 0 });
  const adapter = new PornhubAdapter(makePage([media], PORNHUB_URL));
  adapter.selectTarget();

  const result = await adapter.applyState(targetState({ positionSeconds: 300 }));
  assert.equal(result.result, 'applied');
  assert.equal(media.currentTime, 300);
  assert.equal(media.seeking, false);
  assert.equal(result.state.positionSeconds, 300);
  // The returned snapshot reflects the settled seek, not a 'seeking' phase.
  assert.equal(result.state.mediaPhase, 'paused');
});

test('applyState leaves currentTime alone when the position is within the threshold', { timeout: 5000 }, async () => {
  const media = new FakeMedia({ currentTime: 42 });
  const adapter = new PornhubAdapter(makePage([media], PORNHUB_URL));
  adapter.selectTarget();

  const result = await adapter.applyState(targetState({ positionSeconds: 42.1 }));
  assert.equal(result.result, 'applied');
  assert.equal(media.currentTime, 42);
  assert.equal(result.state.positionSeconds, 42);
});

test('applyState plays, sets the rate, and reads back the real state', { timeout: 5000 }, async () => {
  const media = new FakeMedia({ currentTime: 5 });
  const adapter = new PornhubAdapter(makePage([media], PORNHUB_URL));
  adapter.selectTarget();

  const result = await adapter.applyState(targetState({ mediaPhase: 'playing', positionSeconds: 5, playbackRate: 2 }));
  assert.equal(result.result, 'applied');
  assert.equal(media.playCalls, 1);
  assert.equal(media.paused, false);
  assert.equal(media.playbackRate, 2);
  assert.equal(result.state.mediaPhase, 'playing');
  assert.equal(result.state.positionSeconds, 5);
  assert.equal(result.state.playbackRate, 2);
  assert.equal(result.state.resourceIdentity.canonicalUrl, CANONICAL_URL);
});

test('applyState reports rejected when play() rejects — never fabricates applied', { timeout: 5000 }, async () => {
  const media = new FakeMedia();
  media.rejectNextPlay(new Error('play() interrupted by the browser'));
  const adapter = new PornhubAdapter(makePage([media], PORNHUB_URL));
  adapter.selectTarget();

  const result = await adapter.applyState(targetState({ mediaPhase: 'playing' }));
  assert.equal(result.result, 'rejected');
  assert.match(result.error ?? '', /play\(\) interrupted/);
  assert.equal(media.playCalls, 1);
  // The state is the best-effort real snapshot: still paused, still at 0.
  assert.equal(result.state.mediaPhase, 'paused');
  assert.equal(result.state.positionSeconds, 0);
});

test('applyState rejects invalid playback rates explicitly', { timeout: 5000 }, async () => {
  const media = new FakeMedia();
  const adapter = new PornhubAdapter(makePage([media], PORNHUB_URL));
  adapter.selectTarget();

  const result = await adapter.applyState(targetState({ mediaPhase: 'playing', playbackRate: Number.NaN }));
  assert.equal(result.result, 'rejected');
  assert.match(result.error ?? '', /Unsupported playback rate/);
  assert.equal(media.playCalls, 0);
  assert.equal(result.state.mediaPhase, 'paused');
});

test('subscribe binds all native media events and unsubscribe removes exactly them', () => {
  const media = new FakeMedia();
  const adapter = new PornhubAdapter(makePage([media], PORNHUB_URL));
  adapter.selectTarget();
  const received: AdapterEvent[] = [];
  const unsubscribe = adapter.subscribe((event) => {
    received.push(event);
  });

  for (const event of ALL_MEDIA_EVENTS) {
    assert.equal(media.listenerCount(event), 1, `listener bound for ${event}`);
  }

  for (const event of ALL_MEDIA_EVENTS) media.emit(event);
  assert.deepEqual(received, [...ALL_MEDIA_EVENTS]);

  unsubscribe();
  assert.equal(media.listenerCount(), 0);
  media.emit('play');
  media.emit('waiting');
  assert.deepEqual(received, [...ALL_MEDIA_EVENTS]);
});

// --- registry -------------------------------------------------------------------

test('pornhubRegistration registers cleanly in a fresh registry and resolves view URLs', () => {
  const registry = new AdapterRegistry();
  registry.register(pornhubRegistration);
  assert.equal(registry.size, 1, 'the fresh registry serves exactly the pornhub syncer');
  assert.equal(registry.get('pornhub')?.name, 'Pornhub');
  assert.deepEqual(registry.get('pornhub')?.capabilities, ['play', 'pause', 'seek', 'set-rate', 'replay', 'native-events']);

  // View pages resolve on the apex, www and any subdomain, with the viewkey
  // parameter in any query position.
  assert.equal(registry.resolve('https://pornhub.com/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d')?.adapterId, 'pornhub');
  assert.equal(registry.resolve('https://www.pornhub.com/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d&t=30&utm_source=x')?.adapterId, 'pornhub');
  assert.equal(registry.resolve('https://de.pornhub.com/view_video.php?utm_source=x&viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d')?.adapterId, 'pornhub');

  // Non-view pages and view pages without a viewkey never resolve.
  assert.equal(registry.resolve('https://pornhub.com/'), undefined, 'the homepage must not resolve');
  assert.equal(registry.resolve('https://pornhub.com/video/abc123'), undefined, 'category pages must not resolve');
  assert.equal(registry.resolve('https://pornhub.com/view_video.php'), undefined, 'view_video.php without a viewkey must not resolve');
  assert.equal(registry.resolve('https://pornhub.com/view_video.php?viewkey='), undefined, 'an empty viewkey must not resolve');
  assert.equal(registry.resolve('https://pornhub.com/view_video.php?t=30'), undefined, 'missing viewkey must not resolve');
  assert.equal(registry.resolve('https://pornhub.com.evil.example/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d'), undefined, 'lookalike hosts must not resolve');
  assert.equal(registry.resolve('https://example.com/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d'), undefined, 'foreign hosts must not resolve');
  assert.equal(registry.resolve('not a url at all'), undefined, 'unparseable URLs must not resolve');

  // resolveAdapter instantiates the syncer for a matching page environment.
  const adapter = registry.resolveAdapter({ location: { href: PORNHUB_URL } });
  assert.ok(adapter, 'resolveAdapter must instantiate a syncer for a Pornhub page');
  assert.equal(adapter.adapterId, 'pornhub', 'the instantiated adapter must identify as pornhub');
  assert.ok(adapter instanceof PornhubAdapter, 'resolveAdapter must produce a PornhubAdapter');
});

test('pornhubRegistration refuses duplicate adapterId and duplicate domain conflicts', () => {
  const registry = new AdapterRegistry();
  registry.register(pornhubRegistration);

  assert.throws(
    () => registry.register(pornhubRegistration),
    (error: unknown) => error instanceof AdapterRegistryError && error.code === 'duplicate-adapter',
    're-registering the pornhub adapterId must throw duplicate-adapter',
  );
  assert.throws(
    () => registry.register({
      adapterId: 'pornhub-clone',
      name: 'Pornhub Clone',
      domain: 'pornhub.com',
      create: () => new PornhubAdapter(),
      capabilities: [],
    }),
    (error: unknown) => error instanceof AdapterRegistryError
      && error.code === 'duplicate-domain'
      && /already served by adapter 'pornhub'/.test(error.message),
    'registering a second syncer for pornhub.com must throw duplicate-domain',
  );
});

test('the default adapter registry serves all five built-in syncers, pornhub included', () => {
  const registry = createDefaultAdapterRegistry();
  // Pornhub registration is a built-in of the default registry; it serves
  // exactly the five syncers: Bilibili, YouTube, MissAV, Pornhub and XVideos.
  assert.equal(registry.size, 5, 'the default registry serves exactly the five built-in syncers');
  for (const adapterId of ['bilibili', 'youtube', 'missav', 'pornhub', 'xvideos']) {
    assert.ok(registry.get(adapterId), `the ${adapterId} registration exists in the default registry`);
  }
  assert.equal(
    registry.resolve('https://www.pornhub.com/view_video.php?viewkey=ph5f2e8a1b3c4d5e6f7a8b9c0d')?.adapterId,
    'pornhub',
    'pornhub view URLs resolve to the pornhub syncer in the default registry',
  );
  assert.equal(registry.get('pornhub')?.name, 'Pornhub', 'the pornhub registration is the Pornhub syncer');
});
