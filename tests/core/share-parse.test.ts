import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

type ParsedShare = {
  host: string;
  port: number;
  session: string;
};

type ParseShareString = (raw: unknown) => ParsedShare | null;

const popupSource = readFileSync('extension/popup.js', 'utf8');
const functionStart = popupSource.indexOf('function parseShareString');
const functionEnd = popupSource.indexOf('\n}\n\nconst ADAPTER_LABELS', functionStart) + 2;
assert.ok(functionStart >= 0, 'popup.js must define parseShareString');
assert.ok(functionEnd > functionStart, 'could not locate parseShareString closing brace');
const functionSource = popupSource.slice(functionStart, functionEnd);
const parseShareString = new Function(`return (${functionSource});`)() as ParseShareString;

test('parses a standard share string', () => {
  assert.deepEqual(
    parseShareString('anytogether://session?host=127.0.0.1&port=8765&session=abc123'),
    { host: '127.0.0.1', port: 8765, session: 'abc123' },
  );
});

test('decodes encoded host and session values', () => {
  assert.deepEqual(
    parseShareString(
      'anytogether://session?host=media%20host%2Foffice&port=443&session=room%3Falpha%26beta%3D1',
    ),
    { host: 'media host/office', port: 443, session: 'room?alpha&beta=1' },
  );
});

test('accepts a share string without the scheme prefix', () => {
  assert.deepEqual(
    parseShareString('session?host=example.test&port=1&session=client-1'),
    { host: 'example.test', port: 1, session: 'client-1' },
  );
});

test('rejects ports outside the valid range or with non-numeric values', () => {
  for (const port of ['0', '65536', 'not-a-number']) {
    assert.equal(
      parseShareString(`anytogether://session?host=example.test&port=${port}&session=client-1`),
      null,
    );
  }
});

test('rejects share strings missing a required field', () => {
  assert.equal(parseShareString('anytogether://session?port=8765&session=client-1'), null);
  assert.equal(parseShareString('anytogether://session?host=example.test&session=client-1'), null);
  assert.equal(parseShareString('anytogether://session?host=example.test&port=8765'), null);
});

test('trims surrounding whitespace', () => {
  assert.deepEqual(
    parseShareString('  \n anytogether://session?host=example.test&port=65535&session=client-1 \t'),
    { host: 'example.test', port: 65535, session: 'client-1' },
  );
});

test('returns null instead of throwing for malformed encoding', () => {
  assert.equal(parseShareString('anytogether://session?host=%ZZ&port=8765&session=client-1'), null);
});
