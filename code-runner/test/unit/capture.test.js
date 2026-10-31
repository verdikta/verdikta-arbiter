'use strict';

// Acceptance: capped stream reads, 32 KiB head/tail per step.

const test = require('node:test');
const assert = require('node:assert/strict');
const { HeadTail, Capped, STEP_LOG_HEAD_BYTES, STEP_LOG_TAIL_BYTES } = require('../../src/capture');

const KiB = 1024;

function bytes(n, seed = 0) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i + seed) % 251;
  return b;
}

function feed(sink, buf, chunk) {
  for (let i = 0; i < buf.length; i += chunk) sink.write(buf.subarray(i, i + chunk));
}

test('32 KiB head and 32 KiB tail per step', () => {
  assert.equal(STEP_LOG_HEAD_BYTES, 32 * KiB);
  assert.equal(STEP_LOG_TAIL_BYTES, 32 * KiB);
});

test('output within the cap is kept whole', () => {
  const data = bytes(50 * KiB);
  const s = new HeadTail();
  feed(s, data, 7000);
  const snap = s.snapshot();
  assert.deepEqual(Buffer.concat([snap.head, snap.tail]), data);
  assert.equal(snap.omittedBytes, 0);
  assert.equal(snap.totalBytes, data.length);
  assert.equal(s.toJSON().text, data.toString('utf8'));
});

test('longer output keeps exactly its first and last 32 KiB, whatever the chunking', () => {
  const small = bytes(100 * KiB, 3);
  const s1 = new HeadTail();
  feed(s1, small, 1);
  assert.deepEqual(s1.snapshot().head, small.subarray(0, 32 * KiB));
  assert.deepEqual(s1.snapshot().tail, small.subarray(small.length - 32 * KiB));

  const data = bytes(1024 * KiB);
  for (const chunk of [7, 1000, 32 * KiB, 33 * KiB, 300 * KiB, data.length]) {
    const s = new HeadTail();
    feed(s, data, chunk);
    const snap = s.snapshot();
    assert.deepEqual(snap.head, data.subarray(0, 32 * KiB), `head chunk=${chunk}`);
    assert.deepEqual(snap.tail, data.subarray(data.length - 32 * KiB), `tail chunk=${chunk}`);
    assert.equal(snap.omittedBytes, data.length - 64 * KiB);
    assert.equal(snap.totalBytes, data.length);
  }
});

test('the text form marks what was cut', () => {
  const s = new HeadTail({ headBytes: 4, tailBytes: 4 });
  s.write(Buffer.from('abcdefghijklmnop'));
  const j = s.toJSON();
  assert.equal(j.text, 'abcd\n[... 8 bytes omitted ...]\nmnop');
  assert.equal(j.omittedBytes, 8);
  assert.equal(j.totalBytes, 16);
});

test('memory stays bounded however much is written', () => {
  const s = new HeadTail();
  const chunk = Buffer.alloc(64 * KiB, 1);
  for (let i = 0; i < 2000; i++) s.write(chunk);
  assert.ok(s.retainedBytes() <= 32 * KiB + 2 * 32 * KiB + chunk.length, `retained ${s.retainedBytes()}`);
});

test('Capped keeps at most maxBytes and says when more came', () => {
  const c = new Capped(10);
  assert.equal(c.write(Buffer.from('12345')), true);
  assert.equal(c.overLimit, false);
  assert.equal(c.write(Buffer.from('6789012')), false);
  assert.equal(c.overLimit, true);
  assert.equal(c.bytes().toString(), '1234567890');
  c.write(Buffer.from('more'));
  assert.equal(c.bytes().length, 10);
  assert.equal(c.totalBytes, 16);
});
