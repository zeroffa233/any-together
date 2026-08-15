/**
 * Node unit tests for the Bilibili page adapter.
 *
 * Every test injects a fake page (document / location / media element), so nothing
 * reads browser globals; two tests prove that isolation explicitly. Failure paths
 * are asserted as explicit results ('rejected' / 'unsupported' with messages),
 * never as fabricated 'applied' outcomes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BilibiliAdapter,
  type BilibiliMediaCollection,
  type BilibiliMediaElement,
  type BilibiliPage,
} from '../../src/adapters/bilibili-adapter.js';
import {
  AdapterSiteError,
  type AdapterEvent,
  type AdapterSiteErrorCode,
  type AdapterTargetState,
} from '../../src/adapters/resource-adapter.js';
import { isBilibiliResourceIdentity, isValidResourceIdentity } from '../../src/shared/protocol.js';

const BILIBILI_URL = 'https://www.bilibili.com/video/BV1xx411c7mD';

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
class FakeMedia implements BilibiliMediaElement {
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

function makePage(media: BilibiliMediaElement[], href: string): BilibiliPage {
  return {
    document: {
      querySelectorAll: (_selectors: string): BilibiliMediaCollection => media,
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

test('identifyResource returns a normalized Bilibili identity', () => {
  const adapter = new BilibiliAdapter(makePage([], 'https://www.bilibili.com/video/BV1xx411c7mD?p=2&t=30'));
  assert.equal(adapter.adapterId, 'bilibili');
  const identity = adapter.identifyResource();
  assert.equal(identity.adapterId, 'bilibili');
  // Query strings are dropped and the path is compared without a trailing slash.
  assert.equal(identity.canonicalUrl, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(identity.resourceId, 'BV1xx411c7mD');
  assert.equal(isValidResourceIdentity(identity), true, 'produced identities must pass the shared resource gate');
  assert.equal(isBilibiliResourceIdentity(identity), true, 'produced identities must satisfy the first-release Bilibili site gate');

  const trailingSlash = new BilibiliAdapter(makePage([], 'https://www.bilibili.com/video/BV1xx411c7mD/')).identifyResource();
  assert.equal(trailingSlash.canonicalUrl, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(trailingSlash.resourceId, 'BV1xx411c7mD');
  assert.equal(isBilibiliResourceIdentity(trailingSlash), true, 'a normalized identity must satisfy the Bilibili site gate');

  const subdomain = new BilibiliAdapter(makePage([], 'https://m.bilibili.com/video/BV1xx411c7mD')).identifyResource();
  assert.equal(subdomain.canonicalUrl, 'https://m.bilibili.com/video/BV1xx411c7mD');
  assert.equal(subdomain.resourceId, 'BV1xx411c7mD');
  assert.equal(isBilibiliResourceIdentity(subdomain), true, 'a subdomain identity must satisfy the Bilibili site gate');
});

test('identifyResource omits resourceId for pages without a BV video path', () => {
  const root = new BilibiliAdapter(makePage([], 'https://www.bilibili.com/')).identifyResource();
  assert.equal(root.canonicalUrl, 'https://www.bilibili.com');
  assert.ok(!('resourceId' in root));
  assert.equal(isBilibiliResourceIdentity(root), true, 'a bare Bilibili page must still satisfy the Bilibili site gate');

  const live = new BilibiliAdapter(makePage([], 'https://live.bilibili.com/12345')).identifyResource();
  assert.equal(live.canonicalUrl, 'https://live.bilibili.com/12345');
  assert.ok(!('resourceId' in live));
  assert.equal(isBilibiliResourceIdentity(live), true, 'a Bilibili subdomain page must still satisfy the Bilibili site gate');
});

test('identifyResource rejects hosts that are not Bilibili with not-bilibili', () => {
  const foreignHosts = [
    'https://example.com/video/BV1xx411c7mD',
    'https://bilibili.com.evil.example/video/BV1xx411c7mD',
    'https://evilbilibili.com/video/BV1xx411c7mD',
  ];
  for (const href of foreignHosts) {
    const error = assertAdapterSiteError(
      'not-bilibili',
      () => new BilibiliAdapter(makePage([], href)).identifyResource(),
    );
    assert.match(error.message, /not a Bilibili site/);
  }
});

test('identifyResource rejects unparseable or missing URLs explicitly', () => {
  const invalid = assertAdapterSiteError(
    'invalid-url',
    () => new BilibiliAdapter(makePage([], 'not a url')).identifyResource(),
  );
  assert.match(invalid.message, /Cannot parse/);

  const emptyHref = assertAdapterSiteError(
    'browser-required',
    () => new BilibiliAdapter(makePage([], '')).identifyResource(),
  );
  assert.match(emptyHref.message, /page location/);

  const noLocation = assertAdapterSiteError(
    'browser-required',
    () => new BilibiliAdapter({ document: makePage([], BILIBILI_URL).document } as unknown as BilibiliPage).identifyResource(),
  );
  assert.match(noLocation.message, /page location/);
});

test('adapter constructed without a page fails explicitly in Node', { timeout: 5000 }, async () => {
  const adapter = new BilibiliAdapter();
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
    const adapter = new BilibiliAdapter(makePage([media], BILIBILI_URL));
    assert.equal(adapter.identifyResource().canonicalUrl, BILIBILI_URL);
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
  const adapter = new BilibiliAdapter(makePage([small, large], BILIBILI_URL));
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 22);
});

test('selectTarget breaks area ties by document order', () => {
  const first = new FakeMedia({ currentTime: 33, rect: { width: 800, height: 600 } });
  const second = new FakeMedia({ currentTime: 44, rect: { width: 800, height: 600 } });
  const adapter = new BilibiliAdapter(makePage([first, second], BILIBILI_URL));
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 33);
});

test('selectTarget ignores candidates that have no playable data', () => {
  const stale = new FakeMedia({ currentTime: 1, readyState: 0, duration: Number.NaN });
  const playable = new FakeMedia({ currentTime: 2 });
  const adapter = new BilibiliAdapter(makePage([stale, playable], BILIBILI_URL));
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
  } as unknown as BilibiliMediaElement;
  const adapter = new BilibiliAdapter(makePage([unmeasured], BILIBILI_URL));
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 5);
});

test('no playable media reports no-media on select/read/apply', { timeout: 5000 }, async () => {
  const adapter = new BilibiliAdapter(makePage([], BILIBILI_URL));
  const error = assertAdapterSiteError('no-media', () => adapter.selectTarget());
  assert.match(error.message, /No playable Bilibili video/);
  assertAdapterSiteError('no-media', () => adapter.readState());

  const result = await adapter.applyState(targetState());
  assert.equal(result.result, 'unsupported');
  assert.match(result.error ?? '', /No playable Bilibili video/);
  assert.equal(result.state.mediaPhase, 'paused');
  assert.equal(result.state.resourceIdentity.canonicalUrl, BILIBILI_URL);
  assert.equal(result.state.resourceIdentity.resourceId, 'BV1xx411c7mD');
  assert.equal(isBilibiliResourceIdentity(result.state.resourceIdentity), true, 'the unsupported placeholder must still satisfy the Bilibili site gate');
});

test('readState maps live media signals onto shared phases', () => {
  const media = new FakeMedia({ paused: false, readyState: 4 });
  const adapter = new BilibiliAdapter(makePage([media], BILIBILI_URL));
  adapter.selectTarget();

  const snapshot = adapter.readState();
  assert.equal(snapshot.mediaPhase, 'playing');
  assert.equal(snapshot.durationSeconds, 600);
  assert.equal(snapshot.resourceIdentity.canonicalUrl, BILIBILI_URL);
  assert.equal(isBilibiliResourceIdentity(snapshot.resourceIdentity), true, 'read-state snapshots must satisfy the Bilibili site gate');

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
  const adapter = new BilibiliAdapter(makePage([media], BILIBILI_URL));
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
  const adapter = new BilibiliAdapter(makePage([media], BILIBILI_URL));
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
  const adapter = new BilibiliAdapter(makePage([media], BILIBILI_URL));
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
  const adapter = new BilibiliAdapter(makePage([media], BILIBILI_URL));
  adapter.selectTarget();

  const result = await adapter.applyState(targetState({ positionSeconds: 42.1 }));
  assert.equal(result.result, 'applied');
  assert.equal(media.currentTime, 42);
  assert.equal(result.state.positionSeconds, 42);
});

test('applyState plays, sets the rate, and reads back the real state', { timeout: 5000 }, async () => {
  const media = new FakeMedia({ currentTime: 5 });
  const adapter = new BilibiliAdapter(makePage([media], BILIBILI_URL));
  adapter.selectTarget();

  const result = await adapter.applyState(targetState({ mediaPhase: 'playing', positionSeconds: 5, playbackRate: 2 }));
  assert.equal(result.result, 'applied');
  assert.equal(media.playCalls, 1);
  assert.equal(media.paused, false);
  assert.equal(media.playbackRate, 2);
  assert.equal(result.state.mediaPhase, 'playing');
  assert.equal(result.state.positionSeconds, 5);
  assert.equal(result.state.playbackRate, 2);
  assert.equal(result.state.resourceIdentity.canonicalUrl, BILIBILI_URL);
});

test('applyState reports rejected when play() rejects — never fabricates applied', { timeout: 5000 }, async () => {
  const media = new FakeMedia();
  media.rejectNextPlay(new Error('play() interrupted by the browser'));
  const adapter = new BilibiliAdapter(makePage([media], BILIBILI_URL));
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
  const adapter = new BilibiliAdapter(makePage([media], BILIBILI_URL));
  adapter.selectTarget();

  const result = await adapter.applyState(targetState({ mediaPhase: 'playing', playbackRate: Number.NaN }));
  assert.equal(result.result, 'rejected');
  assert.match(result.error ?? '', /Unsupported playback rate/);
  assert.equal(media.playCalls, 0);
  assert.equal(result.state.mediaPhase, 'paused');
});

test('subscribe binds all native media events and unsubscribe removes exactly them', () => {
  const media = new FakeMedia();
  const adapter = new BilibiliAdapter(makePage([media], BILIBILI_URL));
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
