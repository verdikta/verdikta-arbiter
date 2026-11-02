'use strict';

// The host-side checks of poc.patch and the readers of git's own output
// (git runs inside the sandbox, never here). Attempt 3 (owner decision Q26):
// the patch's expansion is no longer counted from its text; scanPatch keeps
// only the checks that do not parse the patch's meaning (maxPatchBytes, no
// NUL, no copy or rename), and the measurement is done after git applies the
// patch, from the raw diff of the runner's own index (parseRawZ,
// sumObjectSizes). The measurement end to end is in claim.test.js and
// claim.docker.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  scanPatch, parseRawZ, sumObjectSizes, encodeBase85Line, parseNameStatusZ, parseNumstatZ, parseAddedLines, unquoteCStyle, reportablePath, parseLsTreeZ
} = require('../../src/patch');

const LIMITS = { maxPatchBytes: 2000000 };

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

const POC_TEXT = textPatch().toString('latin1');

test('a small patch passes; its size, hash and binary-hunk count are reported, no expansion yet', () => {
  const p = textPatch();
  const r = scanPatch(p, LIMITS);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.bytes, p.length);
  assert.equal(r.binaryHunks, 0);
  assert.equal(r.expansionBytes, undefined, 'the expansion is measured after the apply, not here');
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  // A binary section is counted for the fact, but its size is not parsed.
  const bin = scanPatch(Buffer.from(['diff --git a/test/f.bin b/test/f.bin', 'GIT binary patch', 'literal 999999999', 'HcmV?d00001', '', ''].join('\n')), LIMITS);
  assert.equal(bin.ok, true, 'a huge declared size is not refused here; the apply measures what is written');
  assert.equal(bin.binaryHunks, 1);
});

test('maxPatchBytes: one byte over the spec\'s limit fails, at the limit passes', () => {
  const p = textPatch();
  assert.equal(scanPatch(p, { maxPatchBytes: p.length }).ok, true);
  const r = scanPatch(p, { maxPatchBytes: p.length - 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PATCH_TOO_LARGE');
  assert.match(r.reason, new RegExp(`${p.length} bytes.*${p.length - 1}`));
});

test('a NUL byte anywhere is refused (git reads a header field as a C string)', () => {
  for (const at of [0, 10, POC_TEXT.length - 1]) {
    const b = Buffer.from(POC_TEXT);
    b[at] = 0;
    assert.equal(scanPatch(b, LIMITS).code, 'PATCH_NUL', `a NUL at ${at}`);
  }
  assert.equal(scanPatch(textPatch(), LIMITS).ok, true);
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

test('parseRawZ: the postimage ids of every created or modified blob, a deletion and a gitlink left out', () => {
  const zero = '0'.repeat(40);
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const c = 'c'.repeat(40);
  const raw = [
    `:000000 100644 ${zero} ${a} A`, 'test/new.sol',
    `:100644 100644 ${b} ${c} M`, 'test/mod.sol',
    `:100644 000000 ${b} ${zero} D`, 'test/gone.sol',
    `:100644 100755 ${a} ${a} T`, 'run.sh',
    `:000000 160000 ${zero} ${b} A`, 'lib/dep',
    `:000000 120000 ${zero} ${c} A`, 'test/link'
  ].join('\0') + '\0';
  const r = parseRawZ(Buffer.from(raw, 'latin1'), 40);
  assert.ok(r.ok, r.reason);
  assert.equal(r.paths, 6, 'every touched path is counted');
  assert.deepEqual(r.ids, [a, c, a, c], 'new, modified, type-changed and symlink blobs; not the deletion, not the gitlink');
  // SHA-256 ids.
  const s = parseRawZ(Buffer.from(`:000000 100644 ${'0'.repeat(64)} ${'f'.repeat(64)} A\0test/x\0`, 'latin1'), 64);
  assert.deepEqual(s.ids, ['f'.repeat(64)]);
  // Malformed records fail closed.
  assert.equal(parseRawZ(Buffer.from('nope\0path\0', 'latin1'), 40).ok, false);
  assert.equal(parseRawZ(Buffer.from(`:000000 100644 ${zero} ${a} A\0`, 'latin1'), 40).ok, false, 'a record without a path');
  assert.deepEqual(parseRawZ(Buffer.from(''), 40), { ok: true, ids: [], paths: 0 });
});

test('sumObjectSizes: one line per id, summed, repeats counted; unreadable or missing fails closed', () => {
  assert.equal(sumObjectSizes('10\n20\n30\n', 3), 60);
  assert.equal(sumObjectSizes('5\n5\n5\n5\n', 4), 20, 'a repeated id counts every time');
  assert.equal(sumObjectSizes('0\n', 1), 0);
  assert.equal(sumObjectSizes('10\n20\n', 3), null, 'a line missing');
  assert.equal(sumObjectSizes('10\n20\n30\n', 2), null, 'a line too many');
  assert.equal(sumObjectSizes('10\nbbbb bbbb missing\n', 2), null, 'an object the measurement could not size');
  assert.equal(sumObjectSizes('', 0), 0);
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

test('base85 encodes the way git writes it (fixtures build binary patches from it)', () => {
  // 4 bytes -> a length prefix ('D' = 64 + 4) and one 5-char group; the value 1 is "00001".
  assert.equal(encodeBase85Line(Buffer.from([0, 0, 0, 1])), 'D00001');
  for (const n of [1, 4, 5, 52]) assert.equal(encodeBase85Line(Buffer.alloc(n, 7)).length, 1 + Math.ceil(n / 4) * 5);
  assert.throws(() => encodeBase85Line(Buffer.alloc(53)), RangeError);
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
