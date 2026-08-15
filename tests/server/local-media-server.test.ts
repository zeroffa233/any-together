/**
 * HTTP coverage for the tokenized single-file media server
 * (src/server/local-media-server.ts), exercised over REAL TCP with node:test,
 * temp files and Node's global fetch: no in-memory fakes anywhere.
 *
 * Every case starts the server on an ephemeral port with a temp file whose
 * bytes are a deterministic offset-dependent pattern (so range windows are
 * verifiable byte-for-byte), registers `t.after` cleanup (temp dir removal +
 * server stop, node:test's finally runs even when the body fails), and bounds
 * every network wait with `AbortSignal.timeout`.
 *
 * Covered scenarios:
 *   1. start() validation: non-absolute / missing / non-regular paths are
 *      rejected, explicit tokens are validated, a successful start publishes
 *      an opaque-token share snapshot (token in the URL path, no query)
 *   2. GET without Range streams the WHOLE file: 200, Accept-Ranges,
 *      exact Content-Type/Content-Length, byte-identical body
 *   3. HEAD mirrors GET headers with an empty body (no stream opened)
 *   4. single valid byte ranges → 206 with exact Content-Range /
 *      Content-Length / byte windows (prefix, middle, open-ended, suffix,
 *      explicit full, end-past-EOF clamped)
 *   5. invalid / multiple / unsatisfiable ranges → 416 with
 *      `Content-Range: bytes * /<size>` and an empty body
 *   6. wrong token / wrong filename / foreign path shapes are UNIFORM 404s
 *      with empty bodies — nothing about the share leaks; query/hash on the
 *      exact URL still serve (the token lives in the PATH)
 *   7. methods other than GET/HEAD are refused with 405 + Allow
 *   8. stop() revokes the share, frees the port, is idempotent; a restart
 *      mints a fresh token and the old URL never serves again
 *   9. an empty file serves 200/0 and rejects every byte range as 416
 *  10. HEAD honors a valid Range with 206 headers and no body
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { LocalMediaServer } from '../../src/server/local-media-server.js';
import type { LocalMediaServerOptions, LocalShare } from '../../src/server/local-media-server.js';

// tsconfig targets ES2022, which does not include Promise.withResolvers (ES2024).
// Node >= 22 provides it at runtime; this keeps the type available without a lib bump.
declare global {
  interface PromiseWithResolvers<T> {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  }
  interface PromiseConstructor {
    withResolvers<T>(): PromiseWithResolvers<T>;
  }
}

const REQUEST_TIMEOUT_MS = 5000;

type HttpResult = { status: number; headers: Headers; body: Buffer };

/** One bounded HTTP round-trip; every wait is capped, nothing can hang. */
async function httpRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (options.headers !== undefined) init.headers = options.headers;
  const response = await fetch(url, init);
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, body };
}

/** Deterministic, offset-dependent bytes so every range window is verifiable. */
function patternedBytes(size: number): Buffer {
  const buffer = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index += 1) {
    buffer[index] = (index * 31 + 7) % 251;
  }
  return buffer;
}

/** Temp video file with guaranteed cleanup; the extension drives Content-Type. */
async function makeVideoFile(
  t: TestContext,
  name = 'sample.mp4',
  size = 64 * 1024,
): Promise<{ dir: string; filePath: string; bytes: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), 'any-together-media-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const filePath = join(dir, name);
  const bytes = patternedBytes(size);
  await writeFile(filePath, bytes);
  return { dir, filePath, bytes };
}

/** Started LocalMediaServer with guaranteed stop; returns the live share. */
async function startShare(
  t: TestContext,
  filePath: string,
  options: Omit<LocalMediaServerOptions, 'filePath'> = {},
): Promise<{ server: LocalMediaServer; share: LocalShare }> {
  const server = new LocalMediaServer({ filePath, ...options });
  const share = await server.start();
  t.after(async () => {
    await server.stop().catch(() => {});
  });
  return { server, share };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

test('start() rejects non-absolute, missing and non-regular paths, validates explicit tokens, and publishes an opaque-token share snapshot', { timeout: 15000 }, async (t) => {
  const { dir, filePath } = await makeVideoFile(t);

  // Rejections: nothing is ever served for an invalid share path.
  await assert.rejects(
    new LocalMediaServer({ filePath: 'sample.mp4' }).start(),
    /absolute/,
    'a relative shared path must be rejected',
  );
  await assert.rejects(
    new LocalMediaServer({ filePath: join(dir, 'missing.mp4') }).start(),
    /Cannot access shared file/,
    'a missing shared file must be rejected',
  );
  await assert.rejects(
    new LocalMediaServer({ filePath: dir }).start(),
    /not a regular file/,
    'a directory must be rejected: no directory browsing',
  );
  assert.throws(
    () => new LocalMediaServer({ filePath, token: 'bad token!' }),
    /must match/,
    'explicit tokens must be path-safe',
  );

  // A valid share publishes a snapshot with the opaque token in the PATH.
  const server = new LocalMediaServer({ filePath });
  const share = await server.start();
  t.after(async () => {
    await server.stop();
  });
  assert.match(share.token, /^[A-Za-z0-9_-]{40,}$/, 'the generated token must be a long opaque path-safe string');
  assert.equal(
    share.url,
    `http://127.0.0.1:${share.port}/local/${share.token}/video/${encodeURIComponent(basename(filePath))}`,
    'the share URL must embed the token in the path',
  );
  const parsedUrl = new URL(share.url);
  assert.equal(parsedUrl.search, '', 'the share URL must be query-free so the canonical identity survives');
  assert.equal(share.size, 64 * 1024, 'the share must snapshot the file size');
  assert.equal(share.contentType, 'video/mp4', 'the extension must drive Content-Type');
  assert.ok(Number.isInteger(share.port) && share.port > 0, 'the share must carry the actually bound port');
  assert.deepEqual(server.share, share, 'the share getter must expose the active share');
  await assert.rejects(server.start(), /already running/, 'a running server must refuse a second start');

  // An explicit path-safe token is honored verbatim.
  const custom = new LocalMediaServer({ filePath, token: 'custom-token_123' });
  const customShare = await custom.start();
  t.after(async () => {
    await custom.stop();
  });
  assert.equal(customShare.token, 'custom-token_123', 'an explicit token must be used verbatim');
  assert.ok(customShare.url.includes('/local/custom-token_123/video/'), 'the explicit token must appear in the URL path');
});

test('GET without Range streams the entire file with 200, Accept-Ranges and exact headers', { timeout: 15000 }, async (t) => {
  const { filePath, bytes } = await makeVideoFile(t);
  const { share } = await startShare(t, filePath);

  const result = await httpRequest(share.url);
  assert.equal(result.status, 200, 'a plain GET must be a full 200 stream');
  assert.equal(result.headers.get('content-type'), 'video/mp4', 'the stream must carry the derived Content-Type');
  assert.equal(result.headers.get('accept-ranges'), 'bytes', 'the server must advertise byte ranges');
  assert.equal(result.headers.get('content-length'), String(bytes.length), 'the full stream must report the exact length');
  assert.deepEqual(result.body, bytes, 'the streamed body must equal the file bytes exactly');
});

test('HEAD returns the same headers as GET with an empty body', { timeout: 15000 }, async (t) => {
  const { filePath, bytes } = await makeVideoFile(t);
  const { share } = await startShare(t, filePath);

  const head = await httpRequest(share.url, { method: 'HEAD' });
  const get = await httpRequest(share.url);
  assert.equal(head.status, 200, 'HEAD must succeed with 200');
  assert.equal(head.headers.get('content-type'), get.headers.get('content-type'), 'HEAD must mirror the GET Content-Type');
  assert.equal(head.headers.get('content-length'), String(bytes.length), 'HEAD must report the exact Content-Length');
  assert.equal(head.headers.get('accept-ranges'), 'bytes', 'HEAD must advertise byte ranges');
  assert.equal(head.body.length, 0, 'HEAD must not stream a body');
});

test('single valid byte ranges are served as 206 with exact windows', { timeout: 15000 }, async (t) => {
  const { filePath, bytes } = await makeVideoFile(t);
  const { share } = await startShare(t, filePath);
  const size = bytes.length;

  const cases: Array<{ range: string; start: number; end: number; label: string }> = [
    { range: 'bytes=0-9', start: 0, end: 9, label: 'prefix' },
    { range: 'bytes=100-199', start: 100, end: 199, label: 'middle' },
    { range: `bytes=${size - 32}-`, start: size - 32, end: size - 1, label: 'open-ended' },
    { range: 'bytes=-32', start: size - 32, end: size - 1, label: 'suffix' },
    { range: `bytes=0-${size - 1}`, start: 0, end: size - 1, label: 'explicit full' },
    { range: 'bytes=0-99999999', start: 0, end: size - 1, label: 'end past EOF clamped' },
  ];
  for (const { range, start, end, label } of cases) {
    const result = await httpRequest(share.url, { headers: { Range: range } });
    assert.equal(result.status, 206, `${label} (${range}) must be a 206 partial content`);
    assert.equal(result.headers.get('content-range'), `bytes ${start}-${end}/${size}`, `${label} (${range}) must carry the exact Content-Range`);
    assert.equal(result.headers.get('content-length'), String(end - start + 1), `${label} (${range}) must carry the exact Content-Length`);
    assert.equal(result.headers.get('accept-ranges'), 'bytes', `${label} (${range}) must advertise byte ranges`);
    assert.deepEqual(result.body, bytes.subarray(start, end + 1), `${label} (${range}) must serve the exact byte window`);
  }
});

test('invalid, multiple and unsatisfiable ranges are rejected with 416 and an empty body', { timeout: 15000 }, async (t) => {
  const { filePath, bytes } = await makeVideoFile(t);
  const { share } = await startShare(t, filePath);
  const size = bytes.length;

  const invalidRanges = [
    'items=0-5', // non-bytes unit
    'bytes=abc', // malformed
    'bytes=0-5,10-15', // multiple ranges
    'bytes=50-10', // start after end
    'bytes=-', // empty suffix spec
    `bytes=${size}-`, // start at EOF
    `bytes=${size + 100}-`, // start past EOF
    'bytes=-0', // zero-length suffix
  ];
  for (const range of invalidRanges) {
    const result = await httpRequest(share.url, { headers: { Range: range } });
    assert.equal(result.status, 416, `${range} must be a 416 Range Not Satisfiable`);
    assert.equal(result.headers.get('content-range'), `bytes */${size}`, `${range} must report the satisfiable size`);
    assert.equal(result.body.length, 0, `${range} must have an empty body`);
  }
});

test('wrong token, wrong filename and foreign path shapes are uniform 404s that leak nothing', { timeout: 15000 }, async (t) => {
  const { filePath, bytes } = await makeVideoFile(t, 'secret clip.mp4');
  const { share } = await startShare(t, filePath);
  const wrongToken = (share.token[0] === 'A' ? 'B' : 'A') + share.token.slice(1);

  const probes: Array<{ path: string; label: string }> = [
    { path: `/local/${wrongToken}/video/${encodeURIComponent('secret clip.mp4')}`, label: 'wrong token, exact shape' },
    { path: `/local/${share.token}/video/other.mp4`, label: 'right token, wrong filename' },
    { path: `/local/${share.token}/other/secret%20clip.mp4`, label: 'foreign path shape' },
    { path: `/local/${share.token}/video/`, label: 'empty filename segment' },
    { path: `/local/${share.token}/video/secret%20clip.mp4/extra`, label: 'extra path segment' },
    { path: `/local/${share.token}/video/..%2Fsecret%20clip.mp4`, label: 'encoded traversal filename' },
    { path: `/local/${share.token}`, label: 'missing /video segment' },
  ];
  for (const { path, label } of probes) {
    const result = await httpRequest(`http://127.0.0.1:${share.port}${path}`);
    assert.equal(result.status, 404, `${label} must be a 404`);
    assert.equal(result.body.length, 0, `${label} must not leak a body`);
    assert.equal(result.headers.get('content-type'), null, `${label} must not leak the share Content-Type`);
    assert.equal(result.headers.get('content-range'), null, `${label} must not leak the file size`);
  }

  // Positive control: the token lives in the PATH, so query/hash on the exact
  // URL must not change what is served (canonical identity drops query/hash).
  const decorated = await httpRequest(`${share.url}?t=12345#frag`);
  assert.equal(decorated.status, 200, 'query/hash on the exact URL must still serve the file');
  assert.deepEqual(decorated.body, bytes, 'query/hash must not alter the streamed bytes');
});

test('methods other than GET and HEAD are refused with 405 and Allow', { timeout: 15000 }, async (t) => {
  const { filePath } = await makeVideoFile(t);
  const { share } = await startShare(t, filePath);

  const result = await httpRequest(share.url, { method: 'POST' });
  assert.equal(result.status, 405, 'POST must be refused with 405 Method Not Allowed');
  assert.equal(result.headers.get('allow'), 'GET, HEAD', 'the refusal must advertise the allowed methods');
  assert.equal(result.body.length, 0, 'the refusal must not stream a body');
});

test('stop() revokes the share, frees the port and is idempotent; a restart mints a fresh token', { timeout: 15000 }, async (t) => {
  const { filePath } = await makeVideoFile(t);
  const server = new LocalMediaServer({ filePath });
  const first = await server.start();
  t.after(async () => {
    await server.stop();
  });
  assert.deepEqual(server.share, first, 'the share must be live before stop');

  await server.stop();
  assert.equal(server.share, null, 'stop() must revoke the share snapshot');
  // The port is released: a fresh connection must fail outright.
  await assert.rejects(
    fetch(first.url, { signal: AbortSignal.timeout(3000) }),
    'the media port must refuse connections after stop()',
  );
  await server.stop(); // idempotent

  // A restart mints a NEW token; the old URL must never serve again.
  const second = await server.start();
  assert.notEqual(second.token, first.token, 'each start() must mint a fresh opaque token');
  const fresh = await httpRequest(second.url);
  assert.equal(fresh.status, 200, 'the restarted share must serve its file');

  let oldResult: HttpResult | 'refused' = 'refused';
  try {
    oldResult = await httpRequest(first.url);
  } catch {
    // Connection refused: exactly what a stopped server must produce.
  }
  if (oldResult !== 'refused') {
    assert.equal(oldResult.status, 404, 'a stopped share URL must never serve the file again (404 if the OS re-bound the port)');
  }
});

test('an empty file serves 200/0 and rejects every byte range as 416', { timeout: 15000 }, async (t) => {
  const { filePath } = await makeVideoFile(t, 'empty.mp4', 0);
  const { share } = await startShare(t, filePath);

  const full = await httpRequest(share.url);
  assert.equal(full.status, 200, 'a plain GET on an empty file must be a 200');
  assert.equal(full.headers.get('content-length'), '0', 'an empty file must report length 0');
  assert.equal(full.body.length, 0, 'an empty file must stream zero bytes');

  for (const range of ['bytes=0-0', 'bytes=-1', 'bytes=0-']) {
    const result = await httpRequest(share.url, { headers: { Range: range } });
    assert.equal(result.status, 416, `${range} on an empty file must be unsatisfiable`);
    assert.equal(result.headers.get('content-range'), 'bytes */0', `${range} must report the satisfiable size 0`);
  }
});

test('HEAD honors a valid Range with 206 headers and no body', { timeout: 15000 }, async (t) => {
  const { filePath } = await makeVideoFile(t);
  const { share } = await startShare(t, filePath);

  const result = await httpRequest(share.url, { method: 'HEAD', headers: { Range: 'bytes=0-9' } });
  assert.equal(result.status, 206, 'HEAD with a valid range must be a 206');
  assert.equal(result.headers.get('content-range'), 'bytes 0-9/65536', 'HEAD must carry the exact Content-Range');
  assert.equal(result.headers.get('content-length'), '10', 'HEAD must carry the window length');
  assert.equal(result.body.length, 0, 'HEAD must not stream a body');
});
