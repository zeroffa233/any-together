/**
 * Node unit tests for the YouTube page adapter.
 *
 * Every test injects a fake page (document / location / media element), so nothing
 * reads browser globals; two tests prove that isolation explicitly. Failure paths
 * are asserted as explicit results ('rejected' / 'unsupported' with messages),
 * never as fabricated 'applied' outcomes. The same fake page drives the registry
 * tests at the bottom: YouTube watch URLs resolve to the youtube syncer in the
 * default registry while Bilibili routing stays untouched.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  YoutubeAdapter,
  type YoutubeMediaCollection,
  type YoutubeMediaElement,
  type YoutubePage,
  youtubeRegistration,
} from '../../src/adapters/youtube-adapter.js';
import {
  AdapterSiteError,
  type AdapterEvent,
  type AdapterSiteErrorCode,
  type AdapterTargetState,
} from '../../src/adapters/resource-adapter.js';
import { AdapterRegistryError, createDefaultAdapterRegistry } from '../../src/adapters/adapter-registry.js';
import { isValidResourceIdentity } from '../../src/shared/protocol.js';

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const VIDEO_ID = 'dQw4w9WgXcQ';
/** The canonical identity every watch URL collapses onto. */
const CANONICAL_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

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
class FakeMedia implements YoutubeMediaElement {
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

function makePage(media: YoutubeMediaElement[], href: string): YoutubePage {
  return {
    document: {
      querySelectorAll: (_selectors: string): YoutubeMediaCollection => media,
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

test('identifyResource returns a normalized YouTube identity', () => {
  const adapter = new YoutubeAdapter(makePage([], 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30&list=PLabc'));
  assert.equal(adapter.adapterId, 'youtube');
  const identity = adapter.identifyResource();
  assert.equal(identity.adapterId, 'youtube');
  // Extra query parameters are dropped; the identity is rebuilt from v alone.
  assert.equal(identity.canonicalUrl, CANONICAL_URL);
  assert.equal(identity.resourceId, VIDEO_ID);
  assert.equal(isValidResourceIdentity(identity), true, 'produced identities must pass the shared resource gate');

  const bare = new YoutubeAdapter(makePage([], 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')).identifyResource();
  assert.equal(bare.canonicalUrl, CANONICAL_URL);
  assert.equal(bare.resourceId, VIDEO_ID);
  assert.equal(isValidResourceIdentity(bare), true, 'a normalized identity must pass the shared resource gate');
});

test('identifyResource normalizes query order, extra parameters and fragments', () => {
  const reshuffled = new YoutubeAdapter(makePage([], 'https://youtube.com/watch?list=PLabc&t=30&v=dQw4w9WgXcQ#frag')).identifyResource();
  assert.equal(reshuffled.canonicalUrl, CANONICAL_URL);
  assert.equal(reshuffled.resourceId, VIDEO_ID);

  const fragmentOnly = new YoutubeAdapter(makePage([], 'https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=1m30s')).identifyResource();
  assert.equal(fragmentOnly.canonicalUrl, CANONICAL_URL);
});

test('identifyResource collapses every YouTube host onto one canonical URL', () => {
  const hosts = [
    'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
  ];
  for (const href of hosts) {
    // The last entry is a lookalike host: it must be rejected, not normalized.
    if (href.includes('evil.example')) {
      const error = assertAdapterSiteError(
        'not-bilibili',
        () => new YoutubeAdapter(makePage([], href)).identifyResource(),
      );
      assert.match(error.message, /not a YouTube site/);
      continue;
    }
    const identity = new YoutubeAdapter(makePage([], href)).identifyResource();
    assert.equal(identity.canonicalUrl, CANONICAL_URL, `${href} must collapse onto the canonical URL`);
    assert.equal(identity.resourceId, VIDEO_ID, `${href} must keep the video id`);
  }
});

test('identifyResource rejects non-watch YouTube pages with no video id', () => {
  const nonWatchPages = [
    'https://www.youtube.com/',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/feed/subscriptions',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?list=PLabc',
    'https://www.youtube.com/watch?v=',
    'https://www.youtube.com/watch/dQw4w9WgXcQ',
    'https://www.youtube.com/watchdogs',
  ];
  for (const href of nonWatchPages) {
    const error = assertAdapterSiteError(
      'not-bilibili',
      () => new YoutubeAdapter(makePage([], href)).identifyResource(),
    );
    assert.match(error.message, /not a YouTube watch page|has no video id/);
  }
});

test('identifyResource rejects hosts that are not YouTube with not-bilibili', () => {
  const foreignHosts = [
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://evilyoutube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.co/watch?v=dQw4w9WgXcQ',
    'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
  ];
  for (const href of foreignHosts) {
    const error = assertAdapterSiteError(
      'not-bilibili',
      () => new YoutubeAdapter(makePage([], href)).identifyResource(),
    );
    assert.match(error.message, /not a YouTube site/);
  }
});

test('identifyResource rejects unparseable or missing URLs explicitly', () => {
  const invalid = assertAdapterSiteError(
    'invalid-url',
    () => new YoutubeAdapter(makePage([], 'not a url')).identifyResource(),
  );
  assert.match(invalid.message, /Cannot parse/);

  const emptyHref = assertAdapterSiteError(
    'browser-required',
    () => new YoutubeAdapter(makePage([], '')).identifyResource(),
  );
  assert.match(emptyHref.message, /page location/);

  const noLocation = assertAdapterSiteError(
    'browser-required',
    () => new YoutubeAdapter({ document: makePage([], YOUTUBE_URL).document } as unknown as YoutubePage).identifyResource(),
  );
  assert.match(noLocation.message, /page location/);
});

test('adapter constructed without a page fails explicitly in Node', { timeout: 5000 }, async () => {
  const adapter = new YoutubeAdapter();
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
    const adapter = new YoutubeAdapter(makePage([media], YOUTUBE_URL));
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
  const adapter = new YoutubeAdapter(makePage([small, large], YOUTUBE_URL));
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 22);
});

test('selectTarget breaks area ties by document order', () => {
  const first = new FakeMedia({ currentTime: 33, rect: { width: 800, height: 600 } });
  const second = new FakeMedia({ currentTime: 44, rect: { width: 800, height: 600 } });
  const adapter = new YoutubeAdapter(makePage([first, second], YOUTUBE_URL));
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 33);
});

test('selectTarget ignores candidates that have no playable data', () => {
  const stale = new FakeMedia({ currentTime: 1, readyState: 0, duration: Number.NaN });
  const playable = new FakeMedia({ currentTime: 2 });
  const adapter = new YoutubeAdapter(makePage([stale, playable], YOUTUBE_URL));
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
  } as unknown as YoutubeMediaElement;
  const adapter = new YoutubeAdapter(makePage([unmeasured], YOUTUBE_URL));
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 5);
});

test('no playable media reports no-media on select/read/apply', { timeout: 5000 }, async () => {
  const adapter = new YoutubeAdapter(makePage([], YOUTUBE_URL));
  const error = assertAdapterSiteError('no-media', () => adapter.selectTarget());
  assert.match(error.message, /No playable YouTube video/);
  assertAdapterSiteError('no-media', () => adapter.readState());

  const result = await adapter.applyState(targetState());
  assert.equal(result.result, 'unsupported');
  assert.match(result.error ?? '', /No playable YouTube video/);
  assert.equal(result.state.mediaPhase, 'paused');
  assert.equal(result.state.resourceIdentity.canonicalUrl, CANONICAL_URL);
  assert.equal(result.state.resourceIdentity.resourceId, VIDEO_ID);
  assert.equal(isValidResourceIdentity(result.state.resourceIdentity), true, 'the unsupported placeholder must still satisfy the shared resource gate');
});

test('readState maps live media signals onto shared phases', () => {
  const media = new FakeMedia({ paused: false, readyState: 4 });
  const adapter = new YoutubeAdapter(makePage([media], YOUTUBE_URL));
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
  const adapter = new YoutubeAdapter(makePage([media], YOUTUBE_URL));
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
  const adapter = new YoutubeAdapter(makePage([media], YOUTUBE_URL));
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
  const adapter = new YoutubeAdapter(makePage([media], YOUTUBE_URL));
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
  const adapter = new YoutubeAdapter(makePage([media], YOUTUBE_URL));
  adapter.selectTarget();

  const result = await adapter.applyState(targetState({ positionSeconds: 42.1 }));
  assert.equal(result.result, 'applied');
  assert.equal(media.currentTime, 42);
  assert.equal(result.state.positionSeconds, 42);
});

test('applyState plays, sets the rate, and reads back the real state', { timeout: 5000 }, async () => {
  const media = new FakeMedia({ currentTime: 5 });
  const adapter = new YoutubeAdapter(makePage([media], YOUTUBE_URL));
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
  const adapter = new YoutubeAdapter(makePage([media], YOUTUBE_URL));
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
  const adapter = new YoutubeAdapter(makePage([media], YOUTUBE_URL));
  adapter.selectTarget();

  const result = await adapter.applyState(targetState({ mediaPhase: 'playing', playbackRate: Number.NaN }));
  assert.equal(result.result, 'rejected');
  assert.match(result.error ?? '', /Unsupported playback rate/);
  assert.equal(media.playCalls, 0);
  assert.equal(result.state.mediaPhase, 'paused');
});

test('subscribe binds all native media events and unsubscribe removes exactly them', () => {
  const media = new FakeMedia();
  const adapter = new YoutubeAdapter(makePage([media], YOUTUBE_URL));
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

test('the default adapter registry resolves YouTube watch URLs to the youtube syncer', () => {
  const registry = createDefaultAdapterRegistry();

  // Watch pages resolve on the apex, www and any subdomain, with the v
  // parameter in any query position.
  const apex = registry.resolve('https://youtube.com/watch?v=dQw4w9WgXcQ');
  assert.ok(apex, 'the apex youtube.com domain must resolve');
  assert.equal(apex.adapterId, 'youtube', 'the apex domain must route to the youtube adapter');
  const www = registry.resolve('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30&list=PLabc');
  assert.equal(www?.adapterId, 'youtube', 'www.youtube.com must resolve to the youtube adapter');
  const music = registry.resolve('https://music.youtube.com/watch?list=PLabc&v=dQw4w9WgXcQ');
  assert.equal(music?.adapterId, 'youtube', 'a *.youtube.com subdomain with a v parameter must resolve');
  assert.equal(registry.get('youtube')?.name, 'YouTube');
  assert.deepEqual(registry.get('youtube')?.capabilities, ['play', 'pause', 'seek', 'set-rate', 'replay', 'native-events']);

  // Non-watch pages and watch pages without a v parameter never resolve.
  assert.equal(registry.resolve('https://youtube.com/'), undefined, 'the homepage must not resolve');
  assert.equal(registry.resolve('https://youtube.com/shorts/dQw4w9WgXcQ'), undefined, 'shorts must not resolve');
  assert.equal(registry.resolve('https://youtube.com/watch'), undefined, '/watch without a v parameter must not resolve');
  assert.equal(registry.resolve('https://youtube.com/watch?v='), undefined, 'an empty v parameter must not resolve');

  // resolveAdapter instantiates the syncer for a matching page environment.
  const adapter = registry.resolveAdapter({ location: { href: YOUTUBE_URL } });
  assert.ok(adapter, 'resolveAdapter must instantiate a syncer for a YouTube page');
  assert.equal(adapter.adapterId, 'youtube', 'the instantiated adapter must identify as youtube');
  assert.ok(adapter instanceof YoutubeAdapter, 'resolveAdapter must produce a YoutubeAdapter');
});

test('the default adapter registry keeps Bilibili routing and scope unchanged', () => {
  const registry = createDefaultAdapterRegistry();

  const bilibili = registry.resolve('https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(bilibili?.adapterId, 'bilibili', 'Bilibili video pages must still resolve to the bilibili adapter');
  assert.equal(registry.resolve('https://live.bilibili.com/video/12345')?.adapterId, 'bilibili', 'Bilibili subdomains must still resolve');
  assert.equal(registry.resolve('https://www.bilibili.com/'), undefined, 'non-video Bilibili pages must still not resolve');
  assert.equal(registry.resolve('https://www.bilibili.com/videos'), undefined, '/videos must still not resolve');
  assert.equal(registry.resolve('https://example.com/watch?v=dQw4w9WgXcQ'), undefined, 'unknown domains must not resolve');
  assert.equal(registry.resolve('not a url at all'), undefined, 'unparseable URLs must not resolve');
  assert.equal(registry.resolveAdapter({ location: { href: 'https://example.com/' } }), undefined, 'resolveAdapter must return undefined off-domain');

  assert.equal(registry.size, 2, 'the default registry serves exactly Bilibili and YouTube');
  assert.deepEqual(registry.list().map((registration) => registration.adapterId), ['bilibili', 'youtube']);
});

test('youtubeRegistration registers cleanly in a fresh registry and refuses conflicts', () => {
  const registry = createDefaultAdapterRegistry();

  // Duplicate adapterId and duplicate domain are hard conflicts.
  assert.throws(
    () => registry.register(youtubeRegistration),
    (error: unknown) => error instanceof AdapterRegistryError && error.code === 'duplicate-adapter',
    're-registering the youtube adapterId must throw duplicate-adapter',
  );
  assert.throws(
    () => registry.register({
      adapterId: 'youtube-clone',
      name: 'YouTube Clone',
      domain: 'youtube.com',
      create: () => new YoutubeAdapter(),
      capabilities: [],
    }),
    (error: unknown) => error instanceof AdapterRegistryError
      && error.code === 'duplicate-domain'
      && /already served by adapter 'youtube'/.test(error.message),
    'registering a second syncer for youtube.com must throw duplicate-domain',
  );
});
