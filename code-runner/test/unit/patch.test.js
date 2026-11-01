'use strict';

// Acceptance (applies, testPathsOnly): maxPatchBytes and the 50 MB expansion
// are decided from the patch's own bytes before git sees them, so a
// compression bomb can never make git materialise it; binary changes count
// as stats only. These are the host-side checks and the readers of git's own
// output (which runs inside the sandbox, never here).

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const {
  scanPatch, encodeBase85Line, parseNameStatusZ, parseNumstatZ, parseAddedLines, unquoteCStyle, reportablePath, parseLsTreeZ
} = require('../../src/patch');

const LIMITS = { maxPatchBytes: 2000000, patchExpansionBytes: 50000000 };

function textPatch(file = 'test/Exploit.t.sol', lines = ['// exploit']) {
  return Buffer.from([
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    ''
  ].join('\n'));
}

/** A git binary patch section, encoded the way git writes it (zlib, base85 lines of 52 bytes). */
function binarySection(file, kind, size, payload) {
  const z = zlib.deflateSync(payload, { level: 9 });
  const lines = [];
  for (let i = 0; i < z.length; i += 52) lines.push(encodeBase85Line(z.subarray(i, i + 52)));
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    'index 0000000000000000000000000000000000000000..1111111111111111111111111111111111111111',
    'GIT binary patch',
    `${kind} ${size}`,
    ...lines,
    '',
    'literal 0',
    'HcmV?d00001',
    '',
    ''
  ].join('\n');
}

/** A git delta: varint source size, varint target size, then one insert op. */
function delta(sourceSize, targetSize) {
  const varint = (n) => {
    const out = [];
    do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
    return out;
  };
  return Buffer.from([...varint(sourceSize), ...varint(targetSize), 1, 0x41]);
}

test('a small text patch passes; its size and expansion are reported', () => {
  const p = textPatch();
  const r = scanPatch(p, LIMITS);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.bytes, p.length);
  assert.equal(r.expansionBytes, '// exploit\n'.length + `++ b/test/Exploit.t.sol\n`.length);
  assert.equal(r.binaryHunks, 0);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
});

test('maxPatchBytes: one byte over the spec\'s limit fails, at the limit passes', () => {
  const p = textPatch();
  assert.equal(scanPatch(p, { ...LIMITS, maxPatchBytes: p.length }).ok, true);
  const r = scanPatch(p, { ...LIMITS, maxPatchBytes: p.length - 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PATCH_TOO_LARGE');
  assert.match(r.reason, new RegExp(`${p.length} bytes.*${p.length - 1}`));
});

test('50 MB expansion: a 60 MB binary literal of zeros (a 60 KB patch) fails before git sees it', () => {
  const size = 60 * 1000 * 1000;
  // The declared size is what git would allocate; the payload is a token.
  const p = Buffer.from(binarySection('test/bomb.bin', 'literal', size, Buffer.alloc(1024)));
  assert.ok(p.length < 100000);
  const r = scanPatch(p, LIMITS);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PATCH_EXPANSION');
  assert.ok(r.expansionBytes >= size);
});

test('a small binary literal passes and counts at its declared size', () => {
  const p = Buffer.from(binarySection('test/fixture.bin', 'literal', 3000, Buffer.alloc(3000, 7)));
  const r = scanPatch(p, LIMITS);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.binaryHunks, 1);
  assert.equal(r.expansionBytes, 3000);
});

test('a binary delta counts the target size its header declares; an unreadable delta fails closed', () => {
  const ok = scanPatch(Buffer.from(binarySection('test/f.bin', 'delta', 6, delta(3000, 3100))), LIMITS);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.expansionBytes, 6 + 3100, "the inflated delta and the file it rebuilds");
  const bomb = scanPatch(Buffer.from(binarySection('test/f.bin', 'delta', 9, delta(10, 80 * 1000 * 1000))), LIMITS);
  assert.equal(bomb.ok, false);
  assert.equal(bomb.code, 'PATCH_EXPANSION');
  const garbled = Buffer.from([
    'diff --git a/test/f.bin b/test/f.bin', 'GIT binary patch', 'delta 9', 'Hzzzzzzzzzzzzzz', '', ''
  ].join('\n'));
  const bad = scanPatch(garbled, LIMITS);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'PATCH_BINARY_UNREADABLE');
});

test('copies are refused: a copy rebuilds a whole existing file from one header line', () => {
  const p = Buffer.from([
    'diff --git a/src/Big.sol b/test/Copy.sol', 'similarity index 100%', 'copy from src/Big.sol', 'copy to test/Copy.sol', ''
  ].join('\n'));
  const r = scanPatch(p, LIMITS);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PATCH_COPY');
});

test('R15-F1: renames are refused in every header form git reads, so no source can be rebuilt many times', () => {
  // One source renamed to many names: git apply --numstat names only the destinations, and git reloads the source each time.
  const many = Buffer.from(Array.from({ length: 60 }, (_, i) => [
    `diff --git a/test/fixture.bin b/test/r${i}.bin`, 'similarity index 100%', 'rename from test/fixture.bin', `rename to test/r${i}.bin`
  ].join('\n')).join('\n') + '\n');
  const r = scanPatch(many, LIMITS);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PATCH_RENAME');
  assert.match(r.reason, /git diff --no-renames/);
  for (const header of ['rename from test/a.sol', 'rename to test/b.sol', 'rename old test/a.sol', 'rename new test/b.sol', 'rename from "test/q\\"a.sol"']) {
    const one = scanPatch(Buffer.from(['diff --git a/test/a.sol b/test/b.sol', 'similarity index 90%', header, ''].join('\n')), LIMITS);
    assert.equal(one.code, 'PATCH_RENAME', header);
  }
  // A move written as a deletion and an addition is fine; so is text that only mentions a rename.
  const moved = Buffer.concat([
    Buffer.from(['diff --git a/test/a.sol b/test/a.sol', 'deleted file mode 100644', '--- a/test/a.sol', '+++ /dev/null', '@@ -1 +0,0 @@', '-x', ''].join('\n')),
    textPatch('test/b.sol', ['x', 'rename from a comment'])
  ]);
  assert.equal(scanPatch(moved, LIMITS).ok, true);
});

test('R17-F1: a binary section whose postimage is an object already in the repository counts at that object\'s size, every time', () => {
  const big = 'ab'.repeat(20);
  const objects = new Map([[big, 1024 * 1024]]);
  const section = (i, form, id = big) => [
    `diff --git a/test/c${i}.bin b/test/c${i}.bin`, 'new file mode 100644', `index ${'0'.repeat(40)}..${id}`,
    ...(form === 'summary' ? [`Binary files /dev/null and b/test/c${i}.bin differ`] : ['GIT binary patch', 'literal 0', 'HcmV?d00001', '', 'literal 0', 'HcmV?d00001', ''])
  ].join('\n');
  for (const form of ['summary', 'literal']) {
    const sixty = Buffer.from(Array.from({ length: 60 }, (_, i) => section(i, form)).join('\n') + '\n');
    const r = scanPatch(sixty, LIMITS, { objects });
    assert.equal(r.ok, false, form);
    assert.equal(r.code, 'PATCH_EXPANSION', form);
    // Without the object in the repository, git has nothing to load: the literal or summary is all there is.
    assert.equal(scanPatch(sixty, LIMITS).ok, true, form);
    const two = scanPatch(Buffer.from([section(1, form), section(2, form), ''].join('\n')), LIMITS, { objects });
    assert.ok(two.ok);
    assert.equal(two.expansionBytes, 2 * 1024 * 1024, form);
  }
  // git reads the id in any case and with a mode after it.
  const upper = scanPatch(Buffer.from(section(1, 'summary', big.toUpperCase()).replace(`..${big.toUpperCase()}`, `..${big.toUpperCase()} 100644`) + '\n'), LIMITS, { objects });
  assert.equal(upper.expansionBytes, 1024 * 1024);
  // Round 18: git matches a summary by its first and last bytes only, so an embedded carriage return (or any other byte)
  // still makes it binary. The count never asks: every section naming an existing object counts, marker or not.
  for (const summary of ['Binary files /dev/null and b/test/c\r.bin differ', 'Files /dev/null\rand b/test/c.bin differ', 'no binary marker at all']) {
    const sixty = Buffer.from(Array.from({ length: 60 }, (_, i) => [
      `diff --git a/test/c${i}.bin b/test/c${i}.bin`, 'new file mode 100644', `index ${'0'.repeat(40)}..${big}`, summary
    ].join('\n')).join('\n') + '\n');
    assert.equal(scanPatch(sixty, LIMITS, { objects }).code, 'PATCH_EXPANSION', JSON.stringify(summary));
  }
  // A text section whose postimage is an existing object (the patch recreates a tracked file) counts too: an over-count.
  const text = scanPatch(Buffer.from(['diff --git a/test/t.sol b/test/t.sol', `index ${'0'.repeat(40)}..${big}`, '--- /dev/null', '+++ b/test/t.sol', '@@ -0,0 +1 @@', '+x', ''].join('\n')), LIMITS, { objects });
  assert.ok(text.expansionBytes >= 1024 * 1024);
  // An index line before any `diff --git` header is not one git reads.
  assert.ok(scanPatch(Buffer.from(`index ${'0'.repeat(40)}..${big}\n`), LIMITS, { objects }).expansionBytes === 0);
});

test('added text counts toward expansion; many hunks of added text past 50 MB would fail', () => {
  const r = scanPatch(textPatch('test/a.txt', ['x'.repeat(1000)]), { ...LIMITS, patchExpansionBytes: 900 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PATCH_EXPANSION');
});

test('base85 lines decode the way git encodes them', () => {
  const { decodeBase85Line } = require('../../src/patch');
  for (const n of [1, 4, 5, 51, 52]) {
    const bytes = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff));
    assert.deepEqual(decodeBase85Line(encodeBase85Line(bytes)), bytes);
  }
  assert.equal(decodeBase85Line('A!!!!'), null, 'a character outside git\'s alphabet');
  assert.equal(decodeBase85Line('Z'), null, 'a length prefix with no data');
});

test('git -z outputs: name-status and numstat, paths byte for byte', () => {
  const ns = parseNameStatusZ(Buffer.from('A\0test/a b.t.sol\0M\0test/V.t.sol\0D\0src/x.sol\0T\0test/l\0'));
  assert.deepEqual(ns, [
    { status: 'A', path: 'test/a b.t.sol' },
    { status: 'M', path: 'test/V.t.sol' },
    { status: 'D', path: 'src/x.sol' },
    { status: 'T', path: 'test/l' }
  ]);
  assert.equal(parseNameStatusZ(Buffer.from('A\0dangling')), null);
  assert.equal(parseNameStatusZ(Buffer.from('R100\0a\0b\0')), null, 'renames are split by --no-renames; any other status is refused');
  const num = parseNumstatZ(Buffer.from('3\t0\ttest/B.t.sol\0-\t-\ttest/x.bin\0'));
  assert.deepEqual(num, [
    { added: 3, removed: 0, binary: false, path: 'test/B.t.sol' },
    { added: 0, removed: 0, binary: true, path: 'test/x.bin' }
  ]);
  assert.equal(parseNumstatZ(Buffer.from('x\t0\tp\0')), null);
});

test('ls-tree -z: paths of the listed commit', () => {
  assert.deepEqual(parseLsTreeZ(Buffer.from('foundry.toml\0lib/forge-std\0src/V.sol\0')), ['foundry.toml', 'lib/forge-std', 'src/V.sol']);
});

test('added lines from a -U0 diff, per file, with new line numbers; hunk bodies are never read as headers', () => {
  const diff = [
    'diff --git a/test/A.t.sol b/test/A.t.sol',
    'new file mode 100644',
    'index 0000000..95fbe20',
    '--- /dev/null',
    '+++ b/test/A.t.sol',
    '@@ -0,0 +1,3 @@',
    '+line one',
    '+++ b/not/a/header',
    '+vm.skip(true);',
    'diff --git a/test/V.t.sol b/test/V.t.sol',
    'index 2057cae..1567b22 100644',
    '--- a/test/V.t.sol',
    '+++ b/test/V.t.sol',
    '@@ -2 +2 @@ contract',
    '-old',
    '+new',
    '\\ No newline at end of file',
    '@@ -9,0 +10,2 @@',
    '+ten',
    '+eleven',
    'diff --git a/test/x.bin b/test/x.bin',
    'new file mode 100644',
    'index 0000000..ccbf7e3',
    'Binary files /dev/null and b/test/x.bin differ',
    'diff --git "a/test/q\\"uote.sol" "b/test/q\\"uote.sol"',
    'new file mode 100644',
    '--- /dev/null',
    '+++ "b/test/q\\"uote.sol"',
    '@@ -0,0 +1 @@',
    '+q',
    ''
  ].join('\n');
  const r = parseAddedLines(Buffer.from(diff));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.files.get('test/A.t.sol'), [
    { line: 1, text: 'line one' }, { line: 2, text: '++ b/not/a/header' }, { line: 3, text: 'vm.skip(true);' }
  ]);
  assert.deepEqual(r.files.get('test/V.t.sol'), [{ line: 2, text: 'new' }, { line: 10, text: 'ten' }, { line: 11, text: 'eleven' }]);
  assert.equal(r.files.has('test/x.bin'), false, 'binary content is never read');
  assert.deepEqual(r.files.get('test/q"uote.sol'), [{ line: 1, text: 'q' }]);
  assert.equal(parseAddedLines(Buffer.from('@@ -0,0 +1 @@\n+orphan\n')).ok, false);
});

test('C-style quoted paths', () => {
  assert.equal(unquoteCStyle('"a\\tb\\"c\\\\d\\303\\251"'), 'a\tb"c\\dé');
  assert.equal(unquoteCStyle('plain'), 'plain');
  assert.equal(unquoteCStyle('"unterminated'), null);
  assert.equal(unquoteCStyle('"bad\\q"'), null);
});

test('reportable paths: what a report can carry (no whitespace, control characters or backslash)', () => {
  for (const p of ['test/A.t.sol', 'test/we,ird/A[1]{x}.t.sol', 'test/q"uote.sol']) assert.equal(reportablePath(p), true, p);
  for (const p of ['test/a b.sol', 'test/a\tb', 'test/a\\b', 'test/\u0001', '', 'x'.repeat(513), 'test/../x', '/abs']) {
    assert.equal(reportablePath(p), false, JSON.stringify(p));
  }
});

test('R1-F2: the reverse hunk counts too (git inflates both while it parses), and sizes read as git\'s strtoul reads them', () => {
  // A small forward literal, then a reverse literal declaring 60 MB.
  const reverse = Buffer.from([
    'diff --git a/test/f.bin b/test/f.bin', 'index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644',
    'GIT binary patch', 'literal 3', 'IcmV?d00001', '', 'literal 60000000', 'zcmeIuF#!Mo0K%a4Pi+Q3h&OqVfB^#r3>YwAz<>b*1`HT5V8DO@0|pEjFkrxd', '', ''
  ].join('\n'));
  const r = scanPatch(reverse, LIMITS);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PATCH_EXPANSION');
  for (const [size, expected] of [['+60000000', 60000000], ['  +60000000', 60000000], ['060000000', 60000000], ['-1', Number.MAX_SAFE_INTEGER], ['-0', 0], ['x', 0], ['99999999999999999999', Number.MAX_SAFE_INTEGER]]) {
    const p = Buffer.from(['diff --git a/test/f.bin b/test/f.bin', 'GIT binary patch', `literal ${size}`, 'HcmV?d00001', '', ''].join('\n'));
    assert.equal(scanPatch(p, { ...LIMITS, patchExpansionBytes: Number.MAX_SAFE_INTEGER }).expansionBytes, expected, size);
  }
  assert.equal(scanPatch(Buffer.from(['GIT binary patch', 'literal +60000000', ''].join('\n')), LIMITS).code, 'PATCH_EXPANSION');
  // A CRLF patch reads the same.
  assert.equal(scanPatch(Buffer.from(['GIT binary patch\r', 'literal 60000000\r', ''].join('\n')), LIMITS).code, 'PATCH_EXPANSION');
});
