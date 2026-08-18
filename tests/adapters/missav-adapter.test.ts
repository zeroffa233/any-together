/**
 * Node unit tests for the MissAV page adapter.
 *
 * Every test injects a fake page (document / location / media element), so nothing
 * reads browser globals; two tests prove that isolation explicitly. Failure paths
 * are asserted as explicit results ('rejected' / 'unsupported' with messages),
 * never as fabricated 'applied' outcomes. URL policy is conservative: only
 * `/locale/hyphenated-id` and `/dmN/locale/hyphenated-id` pages on missav.live
 * (or a subdomain) resolve to a video; homepage, locale-only, non-hyphenated and
 * age-wall/consent pages report explicit errors.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MissavAdapter,
  MISSAV_VIDEO_URL_PATTERN,
  missavRegistration,
  type MissavMediaCollection,
  type MissavMediaElement,
  type MissavPage,
} from '../../src/adapters/missav-adapter.js';
import {
  AdapterSiteError,
  type AdapterEvent,
  type AdapterSiteErrorCode,
  type AdapterTargetState,
} from '../../src/adapters/resource-adapter.js';
import { createDefaultAdapterRegistry } from '../../src/adapters/adapter-registry.js';
import { isValidResourceIdentity } from '../../src/shared/protocol.js';

const MISSAV_URL = 'https://missav.live/en/mxgs-1440';
const MISSAV_CANONICAL = 'https://missav.live/en/mxgs-1440';

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
class FakeMedia implements MissavMediaElement {
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

function makePage(media: MissavMediaElement[], href: string): MissavPage {
  return {
    document: {
      querySelectorAll: (_selectors: string): MissavMediaCollection => media,
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

test('identifyResource returns a normalized MissAV identity', () => {
  const adapter = new MissavAdapter(makePage([], 'https://missav.live/en/mxgs-1440?ref=home&p=2#top'));
  assert.equal(adapter.adapterId, 'missav');
  const identity = adapter.identifyResource();
  assert.equal(identity.adapterId, 'missav');
  // Query strings, fragments and the mirror segment are dropped from the canonical URL.
  assert.equal(identity.canonicalUrl, MISSAV_CANONICAL);
  assert.equal(identity.resourceId, 'mxgs-1440');
  assert.equal(isValidResourceIdentity(identity), true, 'produced identities must pass the shared resource gate');

  const localeVariant = new MissavAdapter(makePage([], 'https://missav.live/zh-cn/ssis-001')).identifyResource();
  assert.equal(localeVariant.canonicalUrl, 'https://missav.live/zh-cn/ssis-001');
  assert.equal(localeVariant.resourceId, 'ssis-001');
  assert.equal(isValidResourceIdentity(localeVariant), true);
});

test('identifyResource collapses mirror/subdomain/query variants onto one stable identity', () => {
  const variants = [
    'https://missav.live/en/mxgs-1440',
    'https://missav.live/en/mxgs-1440/',
    'https://missav.live/dm1/en/mxgs-1440',
    'https://missav.live/dm42/en/mxgs-1440?from=home',
    'https://sub.missav.live/en/mxgs-1440',
    'https://cdn.missav.live/dm3/en/mxgs-1440',
  ];
  for (const href of variants) {
    const identity = new MissavAdapter(makePage([], href)).identifyResource();
    assert.equal(identity.adapterId, 'missav');
    assert.equal(identity.canonicalUrl, MISSAV_CANONICAL, `variant ${href} must collapse onto the canonical URL`);
    assert.equal(identity.resourceId, 'mxgs-1440', `variant ${href} must keep the dvd id`);
    assert.equal(isValidResourceIdentity(identity), true);
  }

  // A different video (and a different locale) is a different identity.
  const other = new MissavAdapter(makePage([], 'https://missav.live/ja/ssis-001')).identifyResource();
  assert.equal(other.canonicalUrl, 'https://missav.live/ja/ssis-001');
  assert.notEqual(other.canonicalUrl, MISSAV_CANONICAL);
});

test('identifyResource rejects non-video MissAV pages with not-bilibili', () => {
  const nonVideoPages = [
    'https://missav.live/',
    'https://missav.live/en',
    'https://missav.live/en/',
    'https://missav.live/en/mxgs1440',
    'https://missav.live/dm/en/mxgs-1440',
    'https://missav.live/dm1/mxgs-1440',
    'https://missav.live/x/en/mxgs-1440',
    'https://missav.live/en/mxgs-1440/extra',
    // A missav.live host over a non-http(s) scheme is still not a video page.
    'ftp://missav.live/en/mxgs-1440',
  ];
  for (const href of nonVideoPages) {
    const error = assertAdapterSiteError(
      'not-bilibili',
      () => new MissavAdapter(makePage([], href)).identifyResource(),
    );
    assert.match(error.message, /not a MissAV video page/);
  }
});

test('identifyResource rejects hosts that are not MissAV with not-bilibili', () => {
  const foreignHosts = [
    'https://example.com/en/mxgs-1440',
    'https://missav.live.evil.example/en/mxgs-1440',
    'https://evilmissav.live/en/mxgs-1440',
  ];
  for (const href of foreignHosts) {
    const error = assertAdapterSiteError(
      'not-bilibili',
      () => new MissavAdapter(makePage([], href)).identifyResource(),
    );
    assert.match(error.message, /not a MissAV site/);
  }
});

test('identifyResource rejects unparseable or missing URLs explicitly', () => {
  const invalid = assertAdapterSiteError(
    'invalid-url',
    () => new MissavAdapter(makePage([], 'not a url')).identifyResource(),
  );
  assert.match(invalid.message, /Cannot parse/);

  const emptyHref = assertAdapterSiteError(
    'browser-required',
    () => new MissavAdapter(makePage([], '')).identifyResource(),
  );
  assert.match(emptyHref.message, /page location/);

  const noLocation = assertAdapterSiteError(
    'browser-required',
    () => new MissavAdapter({ document: makePage([], MISSAV_URL).document } as unknown as MissavPage).identifyResource(),
  );
  assert.match(noLocation.message, /page location/);
});

test('adapter constructed without a page fails explicitly in Node', { timeout: 5000 }, async () => {
  const adapter = new MissavAdapter();
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
    const adapter = new MissavAdapter(makePage([media], MISSAV_URL));
    assert.equal(adapter.identifyResource().canonicalUrl, MISSAV_CANONICAL);
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
  const adapter = new MissavAdapter(makePage([small, large], MISSAV_URL));
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 22);
});

test('selectTarget breaks area ties by document order', () => {
  const first = new FakeMedia({ currentTime: 33, rect: { width: 800, height: 600 } });
  const second = new FakeMedia({ currentTime: 44, rect: { width: 800, height: 600 } });
  const adapter = new MissavAdapter(makePage([first, second], MISSAV_URL));
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 33);
});

test('selectTarget ignores candidates that have no playable data', () => {
  const stale = new FakeMedia({ currentTime: 1, readyState: 0, duration: Number.NaN });
  const playable = new FakeMedia({ currentTime: 2 });
  const adapter = new MissavAdapter(makePage([stale, playable], MISSAV_URL));
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
  } as unknown as MissavMediaElement;
  const adapter = new MissavAdapter(makePage([unmeasured], MISSAV_URL));
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 5);
});

test('age-wall or consent pages without playable media report no-media, never success', { timeout: 5000 }, async () => {
  // Age-gate / consent overlay pages expose no playable video element.
  const adapter = new MissavAdapter(makePage([], MISSAV_URL));
  const error = assertAdapterSiteError('no-media', () => adapter.selectTarget());
  assert.match(error.message, /No playable MissAV video/);
  assertAdapterSiteError('no-media', () => adapter.readState());

  const result = await adapter.applyState(targetState());
  assert.equal(result.result, 'unsupported');
  assert.match(result.error ?? '', /No playable MissAV video/);
  assert.equal(result.state.mediaPhase, 'paused');
  // The neutral placeholder still carries the real identity — nothing fabricated.
  assert.equal(result.state.resourceIdentity.canonicalUrl, MISSAV_CANONICAL);
  assert.equal(result.state.resourceIdentity.resourceId, 'mxgs-1440');
});

test('readState maps live media signals onto shared phases', () => {
  const media = new FakeMedia({ paused: false, readyState: 4 });
  const adapter = new MissavAdapter(makePage([media], MISSAV_URL));
  adapter.selectTarget();

  const snapshot = adapter.readState();
  assert.equal(snapshot.mediaPhase, 'playing');
  assert.equal(snapshot.durationSeconds, 600);
  assert.equal(snapshot.resourceIdentity.canonicalUrl, MISSAV_CANONICAL);
  assert.equal(isValidResourceIdentity(snapshot.resourceIdentity), true, 'read-state snapshots must satisfy the shared resource gate');

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
  const adapter = new MissavAdapter(makePage([media], MISSAV_URL));
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
  const adapter = new MissavAdapter(makePage([media], MISSAV_URL));
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
  const adapter = new MissavAdapter(makePage([media], MISSAV_URL));
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
  const adapter = new MissavAdapter(makePage([media], MISSAV_URL));
  adapter.selectTarget();

  const result = await adapter.applyState(targetState({ positionSeconds: 42.1 }));
  assert.equal(result.result, 'applied');
  assert.equal(media.currentTime, 42);
  assert.equal(result.state.positionSeconds, 42);
});

test('applyState plays, sets the rate, and reads back the real state', { timeout: 5000 }, async () => {
  const media = new FakeMedia({ currentTime: 5 });
  const adapter = new MissavAdapter(makePage([media], MISSAV_URL));
  adapter.selectTarget();

  const result = await adapter.applyState(targetState({ mediaPhase: 'playing', positionSeconds: 5, playbackRate: 2 }));
  assert.equal(result.result, 'applied');
  assert.equal(media.playCalls, 1);
  assert.equal(media.paused, false);
  assert.equal(media.playbackRate, 2);
  assert.equal(result.state.mediaPhase, 'playing');
  assert.equal(result.state.positionSeconds, 5);
  assert.equal(result.state.playbackRate, 2);
  assert.equal(result.state.resourceIdentity.canonicalUrl, MISSAV_CANONICAL);
});

test('applyState reports rejected when play() rejects — never fabricates applied', { timeout: 5000 }, async () => {
  const media = new FakeMedia();
  media.rejectNextPlay(new Error('play() interrupted by the browser'));
  const adapter = new MissavAdapter(makePage([media], MISSAV_URL));
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
  const adapter = new MissavAdapter(makePage([media], MISSAV_URL));
  adapter.selectTarget();

  const result = await adapter.applyState(targetState({ mediaPhase: 'playing', playbackRate: Number.NaN }));
  assert.equal(result.result, 'rejected');
  assert.match(result.error ?? '', /Unsupported playback rate/);
  assert.equal(media.playCalls, 0);
  assert.equal(result.state.mediaPhase, 'paused');
});

test('subscribe binds all native media events and unsubscribe removes exactly them', () => {
  const media = new FakeMedia();
  const adapter = new MissavAdapter(makePage([media], MISSAV_URL));
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

test('missavRegistration exposes a registry-ready contract', () => {
  assert.equal(missavRegistration.adapterId, 'missav');
  assert.equal(missavRegistration.domain, 'missav.live');
  assert.equal(missavRegistration.name, 'MissAV');
  assert.deepEqual(missavRegistration.capabilities, ['play', 'pause', 'seek', 'set-rate', 'replay', 'native-events']);

  // The serialized urlRule is the same pattern the identity guard uses.
  assert.equal(missavRegistration.urlRule?.source, MISSAV_VIDEO_URL_PATTERN.source);
  const rule = new RegExp(missavRegistration.urlRule?.source ?? '(?!)');
  assert.equal(rule.test('https://missav.live/en/mxgs-1440'), true);
  assert.equal(rule.test('https://missav.live/dm2/ja/ssis-001'), true);
  assert.equal(rule.test('https://missav.live/'), false);
  assert.equal(rule.test('https://missav.live/en/mxgs1440'), false);
  assert.equal(rule.test('https://example.com/en/mxgs-1440'), false);

  // create() binds the page environment to a working adapter.
  const media = new FakeMedia({ currentTime: 9 });
  const page = makePage([media], MISSAV_URL);
  const adapter = missavRegistration.create({ location: page.location, document: page.document });
  assert.ok(adapter instanceof MissavAdapter);
  assert.equal(adapter.adapterId, 'missav');
  assert.equal(adapter.identifyResource().canonicalUrl, MISSAV_CANONICAL);
  adapter.selectTarget();
  assert.equal(adapter.readState().positionSeconds, 9);
});

test('the default adapter registry serves all five built-in syncers, missav included', () => {
  const registry = createDefaultAdapterRegistry();
  // MissAV registration is a built-in of the default registry; it serves
  // exactly the five syncers: Bilibili, YouTube, MissAV, Pornhub and XVideos.
  assert.equal(registry.size, 5, 'the default registry serves exactly the five built-in syncers');
  for (const adapterId of ['bilibili', 'youtube', 'missav', 'pornhub', 'xvideos']) {
    assert.ok(registry.get(adapterId), `the ${adapterId} registration exists in the default registry`);
  }
  assert.equal(
    registry.resolve(MISSAV_URL)?.adapterId,
    'missav',
    'missav video URLs resolve to the missav syncer in the default registry',
  );
  assert.equal(registry.get('missav')?.name, 'MissAV', 'the missav registration is the MissAV syncer');
});
