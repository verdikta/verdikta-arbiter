'use strict';

/**
 * The listing and claim archives, and their names. The testing tool (A6b) and every arbiter
 * name an archive by the CIDv0 of its bytes, and the canary's report hashes those CIDs, so the
 * bytes must not depend on a clock or a zlib: a ZIP of stored members, in name order, with a
 * fixed date.
 *
 * `cidV0` is what `ipfs add` gives for a file of one chunk (test/unit/calibration.archives.test.js
 * holds it to the package testing-tool recomputes with). An archive past one chunk is refused:
 * the proofs here are small, and a wrong name is worse than a loud stop.
 */

const crypto = require('node:crypto');

/** ipfs add's default chunk: past this a file is a DAG of chunks. */
const MAX_CID_BYTES = 262144;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** 1980-01-01, the DOS epoch: time 0, date ((0 << 9) | (1 << 5) | 1). */
const DOS_DATE = 0x21;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const asBytes = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`, 'utf8'));

/**
 * @param {Record<string, Buffer|string|object>} members - name → bytes, text or a JSON value
 * @returns {Buffer} a ZIP of stored members, in name order
 */
function storedZip(members) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const names = Object.keys(members).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const name of names) {
    const data = asBytes(members[name]);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function varint(n) {
  const out = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Buffer.from(out);
}

function base58(bytes) {
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** The CIDv0 of a file of one chunk: sha2-256 of a dag-pb node holding a UnixFS file. */
function cidV0(bytes) {
  if (bytes.length > MAX_CID_BYTES) {
    throw new Error(`an archive of ${bytes.length} bytes needs chunking, which this harness does not do; its CID would be wrong (at most ${MAX_CID_BYTES})`);
  }
  const unixfs = Buffer.concat([Buffer.from([0x08, 0x02, 0x12]), varint(bytes.length), bytes, Buffer.from([0x18]), varint(bytes.length)]);
  const node = Buffer.concat([Buffer.from([0x0a]), varint(unixfs.length), unixfs]);
  const digest = crypto.createHash('sha256').update(node).digest();
  return base58(Buffer.concat([Buffer.from([0x12, 0x20]), digest]));
}

/**
 * A listing archive, as the attestation site makes it (manifest with `codeReview`, its primary
 * file, the spec, the baseline, the known issues, the attestation). Unsigned here: the runner
 * only compares the attestation's image with the spec's, and the signature is the EA's check,
 * which this harness does not reach.
 */
function listingArchive({ spec, baseline, knownIssues, attestation, query, juryParameters, outcomes }) {
  return storedZip({
    'manifest.json': { version: '1.0', primary: { filename: 'primary_query.json' }, juryParameters, codeReview: 'code_review.json' },
    'primary_query.json': { query, outcomes, references: [] },
    'code_review.json': spec,
    'baseline.json': baseline,
    'known_issues.json': knownIssues,
    'attestation.json': attestation
  });
}

/** A claim archive: the submitted-work contract plus finding.json, report.md, poc.patch and fix.patch when there is one. */
function claimArchive({ name, finding, report, poc, fix = null }) {
  return storedZip({
    'manifest.json': { version: '1.0', name, primary: { filename: 'primary_query.json' } },
    'primary_query.json': { query: `Claim: ${finding.title || name} (see report.md).` },
    'finding.json': finding,
    'report.md': report,
    'poc.patch': poc,
    ...(fix ? { 'fix.patch': fix } : {})
  });
}

module.exports = { storedZip, cidV0, listingArchive, claimArchive, crc32, MAX_CID_BYTES };
