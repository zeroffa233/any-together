import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { test } from 'node:test';

type BrowserIdentity = {
  adapterId: string;
  canonicalUrl: string;
  resourceId?: string;
};

type IdentityRegistry = {
  resolve(url: string): { adapterId: string } | undefined;
  deriveIdentity(url: string): BrowserIdentity | null;
  isSupportedUrl(url: string): boolean;
  list(): Array<{ adapterId: string }>;
};

function loadIdentityRegistry(): IdentityRegistry {
  const context = createContext({ URL });
  runInContext(readFileSync('extension/identity.js', 'utf8'), context, { filename: 'extension/identity.js' });
  const registry = (context as typeof context & { AnyTogetherIdentity?: IdentityRegistry }).AnyTogetherIdentity;
  assert.ok(registry, 'identity.js must expose AnyTogetherIdentity');
  return registry;
}

test('browser identity registry resolves dynamic LAN local-video URLs and canonicalizes the token path', () => {
  const identity = loadIdentityRegistry();
  const url = 'http://192.168.1.5:18767/local/share_token/video/my%20clip.mp4?range=1#fragment';
  assert.equal(identity.resolve(url)?.adapterId, 'local-video');
  const derived = identity.deriveIdentity(url);
  assert.deepEqual({
    adapterId: derived?.adapterId,
    canonicalUrl: derived?.canonicalUrl,
    resourceId: derived?.resourceId,
  }, {
    adapterId: 'local-video',
    canonicalUrl: 'http://192.168.1.5:18767/local/share_token/video/my%20clip.mp4',
    resourceId: 'my clip.mp4',
  });
  assert.equal(identity.isSupportedUrl('http://localhost:18767/local/token/video/movie.webm'), true);
  assert.equal(identity.list().some((entry) => entry.adapterId === 'local-video'), true);
});

test('browser identity registry rejects non-local or malformed local-video destinations', () => {
  const identity = loadIdentityRegistry();
  const unsupported = [
    'https://192.168.1.5:18767/local/token/video/movie.mp4',
    'http://example.com/local/token/video/movie.mp4',
    'http://999.1.1.1:18767/local/token/video/movie.mp4',
    'http://192.168.1.5:18767/local/token/not-video/movie.mp4',
    'http://192.168.1.5:18767/local/token/video/',
  ];
  for (const url of unsupported) {
    assert.equal(identity.resolve(url), undefined, `must reject ${url}`);
    assert.equal(identity.deriveIdentity(url), null, `must not derive ${url}`);
  }
});

test('manifest keeps local-video access optional and delegates injection to scripting', () => {
  const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8')) as {
    permissions?: string[];
    optional_host_permissions?: string[];
    content_scripts?: Array<{ matches?: string[] }>;
  };
  assert.ok(manifest.permissions?.includes('scripting'));
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*']);
  assert.equal(
    manifest.content_scripts?.some((script) => script.matches?.some((match) => match.includes('/local/'))),
    false,
    'dynamic local pages must not receive a static broad content script',
  );
});
