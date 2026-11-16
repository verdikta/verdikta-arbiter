'use strict';

// A6b's contract with A7a: run.json names the archives by the CIDv0 of their bytes, so the archives must be byte-stable
// and the CID must be the one `ipfs add` gives (testing-tool recomputes it with ipfs-only-hash).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { storedZip, cidV0, listingArchive, claimArchive, MAX_CID_BYTES } = require('../../calibration/lib/archives');

/** The entries of a stored ZIP by its central directory, each checked against its CRC. */
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'an end-of-central-directory record');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const size = buffer.readUInt32LE(at + 24);
    const nameLen = buffer.readUInt16LE(at + 28);
    const extra = buffer.readUInt16LE(at + 30);
    const comment = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    assert.equal(method, 0, 'stored');
    if (typeof zlib.crc32 === 'function') assert.equal(zlib.crc32(data), crc, `${name} CRC`);
    out[name] = data;
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

test('a stored ZIP holds its members and is byte-stable', () => {
  const a = storedZip({ 'b.txt': 'two\n', 'a.json': Buffer.from('{}') });
  const b = storedZip({ 'a.json': Buffer.from('{}'), 'b.txt': 'two\n' });
  assert.ok(a.equals(b), 'whatever the order they were given in');
  const members = readZip(a);
  assert.equal(members['a.json'].toString(), '{}');
  assert.equal(members['b.txt'].toString(), 'two\n');
  assert.equal(crypto.createHash('sha256').update(a).digest('hex'), crypto.createHash('sha256').update(b).digest('hex'));
  assert.deepEqual(a.subarray(10, 14), Buffer.from([0x00, 0x00, 0x21, 0x00]), 'the DOS time of 1980-01-01, never the clock');
});

// Vectors from ipfs-only-hash 4.0.0, the package testing-tool recomputes CIDs with.
const VECTORS = [
  ['hello\n', 'QmZULkCELmmk5XNfCgTnCyFgAVxBRBXyDHGGMVoLFLiXEN'],
  ['verdikta calibration\n', 'QmWudNPwc5LLR8tsNHj5gzwrhtVa9BWwfLKi6iU1s65Zhr'],
  ['x'.repeat(1000), 'QmZPhawDdx4KWQG5eNG8A6hVnZwSxJLPCqkDt9kSGTWK27'],
  ['y'.repeat(262144), 'QmQdda5cTKHvZogjjpHMUbg3TNSjyhyoWNb5vBjE9rtssW']
];

test('cidV0 is the CID `ipfs add` gives', () => {
  for (const [text, cid] of VECTORS) assert.equal(cidV0(Buffer.from(text)), cid, `${text.slice(0, 20)}… (${text.length} bytes)`);
});

test('cidV0 refuses what would need chunking, instead of naming it wrongly', () => {
  assert.equal(MAX_CID_BYTES, 262144);
  assert.throws(() => cidV0(Buffer.alloc(262145)), /262145 bytes.*chunk/);
});

test('the listing archive is what the testing tool and the EA read', () => {
  const spec = { version: 1, codeReviewMarker: true };
  const zip = listingArchive({ spec, baseline: { b: 1 }, knownIssues: [], attestation: { version: 1 }, query: 'Q', juryParameters: { J: 1 }, outcomes: ['INVALID'] });
  const m = readZip(zip);
  const manifest = JSON.parse(m['manifest.json']);
  assert.equal(manifest.codeReview, 'code_review.json');
  assert.equal(manifest.primary.filename, 'primary_query.json');
  assert.deepEqual(manifest.juryParameters, { J: 1 });
  assert.deepEqual(JSON.parse(m['code_review.json']), spec);
  assert.deepEqual(JSON.parse(m['known_issues.json']), []);
  assert.deepEqual(JSON.parse(m['baseline.json']), { b: 1 });
  assert.deepEqual(JSON.parse(m['attestation.json']), { version: 1 });
  const primary = JSON.parse(m['primary_query.json']);
  assert.equal(primary.query, 'Q');
  assert.deepEqual(primary.outcomes, ['INVALID']);
});

test('the claim archive holds finding.json, report.md, poc.patch and fix.patch only when there is one', () => {
  const noFix = readZip(claimArchive({ name: 'c', finding: { version: 1 }, report: '# r\n', poc: Buffer.from('p\n'), fix: null }));
  assert.equal(noFix['report.md'].toString(), '# r\n');
  assert.equal(noFix['poc.patch'].toString(), 'p\n');
  assert.deepEqual(JSON.parse(noFix['finding.json']), { version: 1 });
  assert.equal(noFix['fix.patch'], undefined);
  const withFix = readZip(claimArchive({ name: 'c', finding: { version: 1 }, report: '# r\n', poc: Buffer.from('p\n'), fix: Buffer.from('f\n') }));
  assert.equal(withFix['fix.patch'].toString(), 'f\n');
});

test('another name or another byte is another CID; the same inputs are the same CID', () => {
  const a = { name: 'c', finding: { version: 1 }, report: '# r\n', poc: Buffer.from('p\n'), fix: null };
  assert.equal(cidV0(claimArchive(a)), cidV0(claimArchive({ ...a })));
  assert.notEqual(cidV0(claimArchive(a)), cidV0(claimArchive({ ...a, report: '# r!\n' })));
});
