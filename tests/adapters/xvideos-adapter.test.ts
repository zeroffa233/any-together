/**
 * Node unit tests for the XVideos page adapter.
 *
 * Every test injects a fake page (document / location / media element), so nothing
 * reads browser globals; two tests prove that isolation explicitly. The adapter is
 * exercised only through the public HTMLMediaElement surface — the fakes carry no
 * XVideos-private API, so tests double as proof that no private player API is used.
 *
 * URL policy is tested on both layers (identity guard and registry rule):
 * current-shape video pages `/video.<encoded-id>/<slug>` are supported; the dead
 * legacy numeric format (`/video123456789`), id-only pages, non-video paths, and
 * query/fragment-bearing URLs are rejected explicitly — no claim is made for them.
 * Failure paths are asserted as explicit results ('rejected' / 'unsupported' with
 * messages), never as fabricated 'applied' outcomes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  XvideosAdapter,
  type XvideosMediaCollection,
  type XvideosMediaElement,
  type XvideosPage,
  xvideosRegistration,
} from '../../src/adapters/xvideos-adapter.js';
import {
  AdapterSiteError,
  type AdapterEvent,
  type AdapterSiteErrorCode,
  type AdapterTargetState,
} from '../../src/adapters/resource-adapter.js';
import { AdapterRegistry, AdapterRegistryError, createDefaultAdapterRegistry } from '../../src/adapters/adapter-registry.js';
import { isValidResourceIdentity } from '../../src/shared/protocol.js';

const XVIDEOS_URL = 'https://www.xvideos.com/video.k3mrbkHfabc/homemade_amateur_compilation_2';
const ENCODED_ID = 'k3mrbkHfabc';
/** The canonical identity every video URL collapses onto (encoded id only, no slug). */
const CANONICAL_URL = `https://www.xvideos.com/video.${ENCODED_ID}`;

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
class FakeMedia implements XvideosMediaElement {
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

function makePage(media: XvideosMediaElement[], href: string): XvideosPage {
  return {
    document: {
      querySelectorAll: (_selectors: string): XvideosMediaCollection => media,
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

test('identifyResource returns a normalized XVideos identity from a current-shape URL', () => {
  const adapter = new XvideosAdapter(makePage([], XVIDEOS_URL));
  assert.equal(adapter.adapterId, 'xvideos');
  const identity = adapter.identifyResource();
  assert.equal(identity.adapterId, 'xvideos');
  // The identity is rebuilt from the encoded id alone; the slug is dropped.
  assert.equal(identity.canonicalUrl, CANONICAL_URL);
  assert.equal(identity.resourceId, ENCODED_ID);
  assert.equal(isValidResourceIdentity(identity), true, 'produced identities must pass the shared resource gate');
});

test('identifyResource derives the identity from the encoded id, ignoring slug variants', () => {
  const slugOne = new XvideosAdapter(makePage([], 'https://www.xvideos.com/video.k3mrbkHfabc/title_one')).identifyResource();
  const slugTwo = new XvideosAdapter(makePage([], 'https://www.xvideos.com/video.k3mrbkHfabc/title_two')).identifyResource();
  // XVideos redirects wrong slugs onto the canonical slug, and the slug is pure
  // SEO text — it must never change the resource identity.
  assert.equal(slugOne.canonicalUrl, CANONICAL_URL);
  assert.equal(slugOne.resourceId, ENCODED_ID);
  assert.equal(slugTwo.canonicalUrl, CANONICAL_URL);
  assert.equal(slugTwo.resourceId, ENCODED_ID);
});

test('identifyResource collapses every XVideos host onto one canonical URL', () => {
  const hosts = [
    'https://xvideos.com/video.k3mrbkHfabc/slug',
    'https://www.xvideos.com/video.k3mrbkHfabc/slug',
    'https://flash.xvideos.com/video.k3mrbkHfabc/slug',
  ];
  for (const href of hosts) {
    const identity = new XvideosAdapter(makePage([], href)).identifyResource();
    assert.equal(identity.canonicalUrl, CANONICAL_URL, `${href} must collapse onto the canonical URL`);
    assert.equal(identity.resourceId, ENCODED_ID, `${href} must keep the encoded id`);
  }
});

test('identifyResource rejects legacy numeric and non-video XVideos pages explicitly', () => {
  const nonVideoPages = [
    'https://www.xvideos.com/',
    'https://www.xvideos.com/video123456789',
    'https://www.xvideos.com/video123456789/homemade_compilation',
    'https://www.xvideos.com/video.k3mrbkHfabc',
    'https://www.xvideos.com/video.k3mrbkHfabc/',
    'https://www.xvideos.com/video.',
    'https://www.xvideos.com/video',
    'https://www.xvideos.com/tags/amateur',
    'https://www.xvideos.com/porn-videos',
    'https://www.xvideos.com/video.k3mrbkHfabc/slug?ref=1',
    'https://www.xvideos.com/video.k3mrbkHfabc/slug#fragment',
  ];
  for (const href of nonVideoPages) {
    const error = assertAdapterSiteError(
      'not-bilibili',
      () => new XvideosAdapter(makePage([], href)).identifyResource(),
    );
    assert.match(error.message, /not an XVideos video page/, `${href} must be rejected as a non-video page`);
  }
});

test('identifyResource rejects hosts that are not XVideos with not-bilibili', () => {
  const foreignHosts = [
    'https://example.com/video.k3mrbkHfabc/slug',
    'https://evilxvideos.com/video.k3mrbkHfabc/slug',
    'https://xvideos.com.evil.example/video.k3mrbkHfabc/slug',
    'https://xvideos.co/video.k3mrbkHfabc/slug',
    'https://notxvideos.com/video.k3mrbkHfabc/slug',
  ];
  for (const href of foreignHosts) {
    const error = assertAdapterSiteError(
      'not-bilibili',
      () => new XvideosAdapter(makePage([], href)).identifyResource(),
    );
    assert.match(error.message, /not an XVideos site/);
  }
});

test('identifyResource rejects unparseable or missing URLs explicitly', () => {
  const invalid = assertAdapterSiteError(
    'invalid-url',
    () => new XvideosAdapter(makePage([], 'not a url')).identifyResource(),
  );
  assert.match(invalid.message, /Cannot parse/);

  const emptyHref = assertAdapterSiteError(
    'browser-required',
    () => new XvideosAdapter(makePage([], '')).identifyResource(),
  );
  assert.match(emptyHref.message, /page location/);

  const noLocation = assertAdapterSiteError(
    'browser-required',
    () => new XvideosAdapter({ document: makePage([], XVIDEOS_URL).document } as unknown as XvideosPage).identifyResource(),
  );
  assert.match(noLocation.message, /page location/);
});

test('adapter constructed without a page fails explicitly in Node', { timeout: 5000 }, async () => {
  const adapter = new XvideosAdapter();
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
    const adapter = new XvideosAdapter(makePage([media], XVIDEOS_URL));
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
  const adapter = new XvideosAdapter(makePage([small, large], XVIDEOS_URL));
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 22);
});

test('selectTarget breaks area ties by document order', () => {
  const first = new FakeMedia({ currentTime: 33, rect: { width: 800, height: 600 } });
  const second = new FakeMedia({ currentTime: 44, rect: { width: 800, height: 600 } });
  const adapter = new XvideosAdapter(makePage([first, second], XVIDEOS_URL));
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 33);
});

test('selectTarget ignores candidates that have no playable data', () => {
  const stale = new FakeMedia({ currentTime: 1, readyState: 0, duration: Number.NaN });
  const playable = new FakeMedia({ currentTime: 2 });
  const adapter = new XvideosAdapter(makePage([stale, playable], XVIDEOS_URL));
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 2);
});

test('selectTarget uses only the public media surface; unmeasured candidates score zero', () => {
  // A minimal structural fake with no getBoundingClientRect and no event API
  // beyond the HTMLMediaElement contract: the adapter must still work with it.
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
  } as unknown as XvideosMediaElement;
  const adapter = new XvideosAdapter(makePage([unmeasured], XVIDEOS_URL));
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 5);
});

test('age-gated or media-less pages report no-media on select/read/apply — never applied', { timeout: 5000 }, async () => {
  // No playable <video> at all: an age wall, geo block, or broken embed all
  // look like this to the adapter, and all must be reported, not fabricated.
  const empty = new XvideosAdapter(makePage([], XVIDEOS_URL));
  const error = assertAdapterSiteError('no-media', () => empty.selectTarget());
  assert.match(error.message, /No playable XVideos video/);
  assertAdapterSiteError('no-media', () => empty.readState());

  const result = await empty.applyState(targetState());
  assert.equal(result.result, 'unsupported');
  assert.match(result.error ?? '', /No playable XVideos video/);
  assert.equal(result.state.mediaPhase, 'paused');
  assert.equal(result.state.resourceIdentity.canonicalUrl, CANONICAL_URL);
  assert.equal(result.state.resourceIdentity.resourceId, ENCODED_ID);
  assert.equal(isValidResourceIdentity(result.state.resourceIdentity), true, 'the unsupported placeholder must still satisfy the shared resource gate');

  // Only stale (unplayable) candidates: same outcome.
  const staleOnly = new XvideosAdapter(makePage([new FakeMedia({ readyState: 0, duration: Number.NaN })], XVIDEOS_URL));
  assertAdapterSiteError('no-media', () => staleOnly.selectTarget());
  const staleResult = await staleOnly.applyState(targetState());
  assert.equal(staleResult.result, 'unsupported');
});

test('readState maps live media signals onto shared phases', () => {
  const media = new FakeMedia({ paused: false, readyState: 4 });
  const adapter = new XvideosAdapter(makePage([media], XVIDEOS_URL));
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
  const adapter = new XvideosAdapter(makePage([media], XVIDEOS_URL));
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
  const adapter = new XvideosAdapter(makePage([media], XVIDEOS_URL));
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
  const adapter = new XvideosAdapter(makePage([media], XVIDEOS_URL));
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
  const adapter = new XvideosAdapter(makePage([media], XVIDEOS_URL));
  adapter.selectTarget();

  const result = await adapter.applyState(targetState({ positionSeconds: 42.1 }));
  assert.equal(result.result, 'applied');
  assert.equal(media.currentTime, 42);
  assert.equal(result.state.positionSeconds, 42);
});

test('applyState plays, sets the rate, and reads back the real state', { timeout: 5000 }, async () => {
  const media = new FakeMedia({ currentTime: 5 });
  const adapter = new XvideosAdapter(makePage([media], XVIDEOS_URL));
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
  const adapter = new XvideosAdapter(makePage([media], XVIDEOS_URL));
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
  const adapter = new XvideosAdapter(makePage([media], XVIDEOS_URL));
  adapter.selectTarget();

  const result = await adapter.applyState(targetState({ mediaPhase: 'playing', playbackRate: Number.NaN }));
  assert.equal(result.result, 'rejected');
  assert.match(result.error ?? '', /Unsupported playback rate/);
  assert.equal(media.playCalls, 0);
  assert.equal(result.state.mediaPhase, 'paused');
});

test('subscribe binds all native media events and unsubscribe removes exactly them', () => {
  const media = new FakeMedia();
  const adapter = new XvideosAdapter(makePage([media], XVIDEOS_URL));
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

test('a registry holding xvideosRegistration resolves current-shape video URLs and rejects everything else', () => {
  const registry = new AdapterRegistry();
  registry.register(xvideosRegistration);

  // Current-shape video pages resolve on the apex, www and any subdomain.
  const apex = registry.resolve('https://xvideos.com/video.k3mrbkHfabc/slug');
  assert.ok(apex, 'the apex xvideos.com domain must resolve');
  assert.equal(apex.adapterId, 'xvideos', 'the apex domain must route to the xvideos adapter');
  assert.equal(registry.resolve('https://www.xvideos.com/video.k3mrbkHfabc/homemade_compilation')?.adapterId, 'xvideos');
  assert.equal(registry.resolve('https://flash.xvideos.com/video.k3mrbkHfabc/slug')?.adapterId, 'xvideos');
  assert.equal(registry.get('xvideos')?.name, 'XVideos');
  assert.deepEqual(registry.get('xvideos')?.capabilities, ['play', 'pause', 'seek', 'set-rate', 'replay', 'native-events']);

  // Legacy numeric, id-only, non-video and query/fragment-bearing URLs never resolve.
  assert.equal(registry.resolve('https://www.xvideos.com/'), undefined, 'the homepage must not resolve');
  assert.equal(registry.resolve('https://www.xvideos.com/video123456789'), undefined, 'legacy numeric ids must not resolve');
  assert.equal(registry.resolve('https://www.xvideos.com/video123456789/slug'), undefined, 'legacy numeric ids with slugs must not resolve');
  assert.equal(registry.resolve('https://www.xvideos.com/video.k3mrbkHfabc'), undefined, 'encoded id without a slug must not resolve');
  assert.equal(registry.resolve('https://www.xvideos.com/video.k3mrbkHfabc/slug?ref=1'), undefined, 'query-bearing video URLs must not resolve');
  assert.equal(registry.resolve('https://www.xvideos.com/tags/amateur'), undefined, 'tag pages must not resolve');

  // resolveAdapter instantiates the syncer for a matching page environment.
  const adapter = registry.resolveAdapter({ location: { href: XVIDEOS_URL } });
  assert.ok(adapter, 'resolveAdapter must instantiate a syncer for an XVideos page');
  assert.equal(adapter.adapterId, 'xvideos', 'the instantiated adapter must identify as xvideos');
  assert.ok(adapter instanceof XvideosAdapter, 'resolveAdapter must produce an XvideosAdapter');
});

test('xvideosRegistration registers cleanly in a fresh registry and refuses conflicts; the default registry serves xvideos', () => {
  const registry = new AdapterRegistry();
  registry.register(xvideosRegistration);

  // Duplicate adapterId and duplicate domain are hard conflicts.
  assert.throws(
    () => registry.register(xvideosRegistration),
    (error: unknown) => error instanceof AdapterRegistryError && error.code === 'duplicate-adapter',
    're-registering the xvideos adapterId must throw duplicate-adapter',
  );
  assert.throws(
    () => registry.register({
      adapterId: 'xvideos-clone',
      name: 'XVideos Clone',
      domain: 'xvideos.com',
      create: () => new XvideosAdapter(),
      capabilities: [],
    }),
    (error: unknown) => error instanceof AdapterRegistryError
      && error.code === 'duplicate-domain'
      && /already served by adapter 'xvideos'/.test(error.message),
    'registering a second syncer for xvideos.com must throw duplicate-domain',
  );

  // The default registry now serves XVideos as one of the five built-in
  // syncers; existing routing (Bilibili + YouTube) must be untouched.
  const defaults = createDefaultAdapterRegistry();
  assert.equal(defaults.resolve('https://www.xvideos.com/video.k3mrbkHfabc/slug')?.adapterId, 'xvideos', 'the default registry resolves XVideos URLs');
  assert.equal(defaults.size, 5, 'the default registry serves exactly the five built-in syncers');
  assert.equal(defaults.resolve('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.adapterId, 'youtube');
  assert.equal(defaults.resolve('https://www.bilibili.com/video/BV1xx411c7mD')?.adapterId, 'bilibili');
});
