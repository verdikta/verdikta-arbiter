'use strict';

// Node A3a: the §9.5 integrity checks as pure functions (src/integrity.js):
// the snapshot readers, what each check watches, the JUnit consistency
// rules against real forge 1.8.5 output, and the static tamper flags,
// including that ordinary forge tests raise none. The pipeline paths are in
// integrity.pipeline.test.js; real forge in test/docker/integrity.docker.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const integrity = require('../../src/integrity');
const { readForgeJUnit } = require('../../src/junit');
const { junit, manifestOf, forgeConfig, initialTree } = require('../helpers/fakeClaim');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------ snapshot readers

test('parseManifest reads find\'s NUL records and sha256sum -z lines, byte for byte (spaces, line breaks, links)', () => {
  const odd = '/work/lib/a b\nc.sol';
  const buf = Buffer.concat([
    Buffer.from(`f\x00644\x003\x00${odd}\x00\x00`, 'latin1'),
    Buffer.from('l\x00777\x0012\x00/work/lib/link\x00../src/x.sol\x00', 'latin1'),
    Buffer.from('f\x00600\x000\x00/work/lib/locked\x00\x00', 'latin1'),
    Buffer.from('vcr-hashes\x00'),
    Buffer.from(`${sha('abc')}  ${odd}\x00`, 'latin1')
  ]);
  const m = integrity.parseManifest(buf);
  assert.equal(m.ok, true, m.reason);
  assert.deepEqual(m.entries.get(odd), { type: 'f', mode: '644', size: '3', target: '', hash: sha('abc') });
  assert.deepEqual(m.entries.get('/work/lib/link'), { type: 'l', mode: '777', size: '12', target: '../src/x.sol', hash: null });
  // A file sha256sum could not read keeps no hash: it can never match a hashed one.
  assert.equal(m.entries.get('/work/lib/locked').hash, null);
  for (const bad of [Buffer.from('f\x00644\x003\x00/work/x'), Buffer.from('f\x00644\x003\x00/work/x\x00\x00'), Buffer.from('vcr-hashes\x00nothex  /work/x\x00')]) {
    assert.equal(integrity.parseManifest(bad).ok, false, JSON.stringify(bad.toString('latin1')));
  }
});

test('parseFramework reads forge\'s path, PATH and `forge config --json` (out, cache_path, libs, solc), and the config\'s hash', () => {
  const config = forgeConfig(initialTree());
  const p = integrity.parseFramework(Buffer.from(`vcr-forge /usr/local/bin/forge\nvcr-path /usr/local/bin:/work/bin:bin\n${config}`));
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.forgePath, '/usr/local/bin/forge');
  assert.deepEqual(p.pathDirs, ['/usr/local/bin', '/work/bin', '/work/bin']);
  assert.equal(p.configSha256, sha(config));
  assert.deepEqual(p.config, { out: 'out', cachePath: 'cache', libs: ['lib'], solc: '/opt/solc/solc' });
  assert.equal(integrity.parseFramework(Buffer.from('{}')).ok, false, 'no header lines');
  assert.equal(integrity.parseFramework(Buffer.from('vcr-forge /f\nvcr-path /b\nnot json')).ok, false);
});

// ------------------------------------------------------------- what is watched

test('classify: protected globs (on the UTF-8 name), dependencies, the framework, artifacts and the runner\'s repository; caches and the rest are not watched', () => {
  const tree = initialTree();
  const add = (p, content = 'x') => tree.set(p, { type: 'f', mode: '644', content });
  add('/work/remappings.txt');
  add('/work/.env');
  add('/work/foundry.lock');
  add('/work/node_modules/@openzeppelin/contracts/ERC20.sol');
  add('/work/dependencies/solmate-6/src/ERC20.sol');
  add('/work/out/Vault.sol/Vault.json');
  add('/work/cache/solidity-files-cache.json');
  add('/home/sandbox/.foundry/foundry.toml');
  add('/home/sandbox/.gitconfig');
  add('/home/sandbox/.foundry/cache/signatures');
  add('/home/sandbox/.cache/pip/http/x');
  add('/work/cache/test-failures');
  add('/work/bin/forge');
  add(`/work/${Buffer.from('lib/café.sol').toString('latin1')}`);
  add('/work/state/ran');
  const m = integrity.parseManifest(manifestOf(tree, ['/work', '/home/sandbox']));
  assert.equal(m.ok, true);
  const sets = integrity.classify(m.entries, {
    protectedGlobs: ['foundry.toml', 'lib/caf?.sol'],
    config: { out: 'out', cachePath: 'cache', libs: ['lib'], solc: '/opt/solc/solc' },
    forgePath: '/usr/local/bin/forge',
    pathDirs: ['/usr/local/bin', '/work/bin']
  });
  // Keys are the paths' bytes (read latin1); displayPath gives their UTF-8 reading.
  const keys = (s) => [...s.keys()].map(integrity.displayPath).sort();
  assert.deepEqual(keys(sets.protected), ['foundry.toml', 'lib/café.sol']);
  assert.deepEqual(keys(sets.dependencies), [
    'dependencies/solmate-6/src/ERC20.sol', 'lib/café.sol', 'lib/forge-std/src/Test.sol', 'node_modules/@openzeppelin/contracts/ERC20.sol'
  ]);
  assert.deepEqual(keys(sets.framework), [
    '.env', 'bin/forge', 'foundry.lock', 'foundry.toml', 'lib/forge-std/src/Test.sol', 'remappings.txt', '~/.foundry/foundry.toml', '~/.gitconfig'
  ]);
  // forge's compile cache names the artifacts a later run loads: held like them; the rest of cache/ is not watched.
  assert.deepEqual(keys(sets.artifacts), ['cache/solidity-files-cache.json', 'out/Vault.sol/Vault.json']);
  assert.deepEqual(keys(sets.repository), ['.git/HEAD', '.git/config', '.git/index', '.git/info/attributes']);
  const all = new Set(Object.values(sets).flatMap(keys));
  for (const p of ['src/Vault.sol', 'test/Vault.t.sol', 'state/ran', 'cache/test-failures', '~/.foundry/cache/signatures', '~/.cache/pip/http/x']) {
    assert.ok(!all.has(p), `${p} is not watched`);
  }
});

test('changedPaths: a changed byte, mode, link target, a new and a removed file each count; an untouched file does not', () => {
  const before = new Map([['a', 'f 644 1 x'], ['b', 'f 644 1 y'], ['c', 'l 777 1 t'], ['d', 'f 644 1 z']]);
  const after = new Map([['a', 'f 644 1 x'], ['b', 'f 755 1 y'], ['c', 'l 777 1 u'], ['e', 'f 644 1 n']]);
  assert.deepEqual(integrity.changedPaths(before, after), ['b', 'c', 'd', 'e']);
  assert.deepEqual(integrity.changedPaths(before, new Map(before)), []);
});

// ---------------------------------------------------- framework-summary consistency

const REAL_FORGE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<testsuites name="Test run" tests="4" skipped="1" failures="2" errors="0" timestamp="2026-11-02T04:27:25.311+00:00" time="0.000">',
  '    <testsuite name="test/A.t.sol:ATest" tests="3" skipped="1" errors="0" failures="1" time="0.000">',
  '        <testcase name="test_fail()" time="0.000">',
  '            <failure message="assertion failed: 1 != 2"/>',
  '            <system-out>[FAIL: assertion failed: 1 != 2] test_fail() (gas: 3266)</system-out>',
  '        </testcase>',
  '        <testcase name="test_pass()" time="0.000">',
  '            <system-out>[PASS] test_pass() (gas: 143)</system-out>',
  '        </testcase>',
  '        <testcase name="test_skip()" time="0.000">',
  '            <skipped/>',
  '            <system-out>[SKIP] test_skip() (gas: 0)</system-out>',
  '        </testcase>',
  '        <system-out>Suite result: FAILED. 1 passed; 1 failed; 1 skipped; finished in 264.34µs (129.98µs CPU time)</system-out>',
  '    </testsuite>',
  '    <testsuite name="test/D.t.sol:SetupFail" tests="1" skipped="0" errors="0" failures="1" time="0.000">',
  '        <testcase name="setUp()" time="0.000">',
  '            <failure message="no setup"/>',
  '            <system-out>[FAIL: no setup] setUp() (gas: 0)</system-out>',
  '        </testcase>',
  '        <system-out>Suite result: FAILED. 0 passed; 1 failed; 0 skipped; finished in 394.57µs (0.00ns CPU time)</system-out>',
  '    </testsuite>',
  '</testsuites>',
  ''
].join('\n');

const doc = (text) => readForgeJUnit(Buffer.from(text));

test('junit-forged-early-exit (rule): forge\'s own JUnit (forge 1.8.5, a failure, a skip, a failing setUp) is summary-consistent', () => {
  const real = doc(REAL_FORGE);
  assert.equal(real.ok, true, real.reason);
  assert.deepEqual(integrity.summaryConsistency(real), { ok: true, detail: null });
  assert.deepEqual(integrity.summaryConsistency(doc(junit([{ suite: 'test/E.t.sol:E', cases: [{ name: 'test_a()', failure: 'x' }, { name: 'test_b()' }] }]))), { ok: true, detail: null });
  // forge with no matching test: an empty <testsuites> with zero counts.
  assert.deepEqual(integrity.summaryConsistency(doc('<testsuites name="Test run" tests="0" skipped="0" failures="0" errors="0" timestamp="x" time="0.000">\n</testsuites>\n')), { ok: true, detail: null });
});

test('junit-forged-early-exit (rule): a JUnit without forge\'s suite summary, or whose counts disagree with its records, is inconsistent', () => {
  const cases = [
    [junit([{ suite: 'test/E.t.sol:E', cases: [{ name: 'test_a()', failure: 'x' }] }], { summary: false }), /test\/E\.t\.sol:E has no forge suite summary/],
    [REAL_FORGE.replace('1 passed; 1 failed; 1 skipped', '1 passed; 0 failed; 1 skipped'), /test\/A\.t\.sol:ATest: forge's summary says 1 passed, 0 failed, 1 skipped; its records are 1 passed, 1 failed, 1 skipped/],
    [REAL_FORGE.replace('Suite result: FAILED. 1 passed', 'Suite result: ok. 1 passed'), /test\/A\.t\.sol:ATest: forge's summary says ok/],
    [REAL_FORGE.replace('tests="3" skipped="1" errors="0" failures="1"', 'tests="3" skipped="1" errors="0" failures="0"'), /test\/A\.t\.sol:ATest: failures="0", but the suite has 1/],
    [REAL_FORGE.replace('<testsuites name="Test run" tests="4"', '<testsuites name="Test run" tests="5"'), /<testsuites> tests="5", but the suites hold 4/],
    [REAL_FORGE.replace(' skipped="1" failures="2"', ' failures="2"'), /<testsuites> has no skipped count/],
    [REAL_FORGE.replace('</testsuite>\n    <testsuite name="test/D.t.sol:SetupFail"', '<system-out>Suite result: ok. 9 passed; 0 failed; 0 skipped; finished in 1ms</system-out></testsuite>\n    <testsuite name="test/D.t.sol:SetupFail"'), /test\/A\.t\.sol:ATest has more than one forge suite summary/]
  ];
  for (const [text, re] of cases) {
    const d = doc(text);
    assert.equal(d.ok, true, d.reason);
    const s = integrity.summaryConsistency(d);
    assert.equal(s.ok, false, text);
    assert.match(s.detail, re);
  }
  // Nothing to compare without a readable JUnit: that run is already an error for reproduces.
  assert.deepEqual(integrity.summaryConsistency({ ok: false, reason: 'x' }), { ok: true, detail: null });
});

test('junit-forged-early-exit (rule): exit-code consistency, non-zero exactly when the JUnit records a failure; an exit 0 with no JUnit is an exit before forge\'s report', () => {
  const failing = doc(REAL_FORGE);
  const passing = doc(junit([{ suite: 'test/E.t.sol:E', cases: [{ name: 'test_a()' }] }]));
  assert.equal(integrity.exitConsistency({ exitCode: 1, junit: 'ok', doc: failing }).ok, true);
  assert.equal(integrity.exitConsistency({ exitCode: 0, junit: 'ok', doc: passing }).ok, true);
  assert.match(integrity.exitConsistency({ exitCode: 0, junit: 'ok', doc: failing }).detail, /exited 0, but the JUnit records 2 failures/);
  assert.match(integrity.exitConsistency({ exitCode: 1, junit: 'ok', doc: passing }).detail, /exited 1, but the JUnit records no failure/);
  // forge exits non-zero without a JUnit (a compile error): consistent, and an error for reproduces.
  assert.equal(integrity.exitConsistency({ exitCode: 1, junit: 'absent', doc: null }).ok, true);
  assert.match(integrity.exitConsistency({ exitCode: 0, junit: 'absent', doc: null }).detail, /exited 0 without forge's JUnit/);
  assert.match(integrity.exitConsistency({ exitCode: 0, junit: 'invalid', doc: null }).detail, /exited 0 with an unreadable JUnit/);
});

// ----------------------------------------------------------------- tamper flags

const added = (file, lines) => new Map([[file, lines.map((text, i) => ({ line: i + 1, text }))]]);
const kinds = (flags) => flags.map((f) => `${f.kind} ${f.file}:${f.line}`);

test('tamper flags: forge forms of each kind (fs cheatcodes, inline fs_permissions, ffi into /proc, stdout markup, kill, trap, a maker command\'s script)', () => {
  const lines = [
    '    /// forge-config: default.fs_permissions = [{ access = "read-write", path = "./" }]',
    '    function test_a() public { vm.writeFile("foundry.toml", "ffi = true"); }',
    '    function test_b() public { vm.writeFile("lib/forge-std/src/StdAssertions.sol", ""); }',
    '    function test_c() public { vm.writeFile("/tmp/x", "1"); vm.removeFile("../outside.txt"); }',
    '    function test_d() public { c[2] = "printf x > /proc/$PPID/fd/1"; }',
    '    string constant FAKE = "<testsuites><testsuite name=\\"x\\"><testcase name=\\"test_d()\\"/>";',
    '    function test_e() public { c[2] = "kill -9 $PPID"; }',
    '    function test_f() public { vm.copyFile("test/x.sol", "node_modules/a/b.sol"); }',
    '    /// forge-config: default.fs_permissions = [{ access = "write", path = "/" }]',
    '    function test_g() public { vm.writeFile(".git/config", ""); vm.writeLine("/dev/stdout", "x"); }'
  ];
  const shell = ['#!/bin/sh', 'trap "printf done" EXIT'];
  const files = new Map([...added('test/Exploit.t.sol', lines), ...added('test/helper.sh', shell), ...added('test/run.sh', ['exec forge test "$@"'])]);
  const flags = integrity.tamperFlags({
    added: files,
    touched: [{ status: 'A', path: 'test/Exploit.t.sol' }, { status: 'A', path: 'test/helper.sh' }, { status: 'M', path: 'test/run.sh' }],
    commands: { build: 'forge build', testFiles: 'sh ./test/run.sh --match-path $FILES', testIds: 'sh test/run.sh --match-test $TEST_IDS' }
  });
  assert.deepEqual(kinds(flags), [
    'exit-during-import test/Exploit.t.sol:7',
    'exit-handler-registered test/helper.sh:2',
    'framework-patched test/Exploit.t.sol:1',
    'framework-patched test/Exploit.t.sol:2',
    'framework-patched test/Exploit.t.sol:8',
    'framework-patched test/Exploit.t.sol:9',
    'framework-patched test/Exploit.t.sol:10',
    'framework-patched test/run.sh:null',
    'report-path-referenced test/Exploit.t.sol:5',
    'report-path-referenced test/Exploit.t.sol:6',
    'report-path-referenced test/Exploit.t.sol:10',
    'reporter-patched test/Exploit.t.sol:3',
    'write-outside-repository test/Exploit.t.sol:4',
    'write-outside-repository test/Exploit.t.sol:9',
    'write-outside-repository test/Exploit.t.sol:10'
  ]);
  for (const k of new Set(flags.map((f) => f.kind))) assert.ok(integrity.TAMPER_FLAG_KINDS.includes(k), k);
});

test('tamper flags: ordinary forge tests raise none (forge-std imports, inline fuzz config, relative state files, console.log, ffi to a helper, revert messages)', () => {
  const lines = [
    'import {Test, console} from "forge-std/Test.sol";',
    'import {Vault} from "../src/Vault.sol";',
    '} from "forge-std/StdAssertions.sol";',
    'contract ExploitTest is Test {',
    '    /// forge-config: default.fuzz.runs = 1024',
    '    /// forge-config: default.fs_permissions = [{ access = "read", path = "./test/fixtures" }]',
    '    /// forge-config: default.fs_permissions = [{ access = "read-write", path = "./poc-output" }]',
    '    function test_drain() public {',
    '        string memory data = vm.readFile("test/fixtures/state.json");',
    '        vm.writeFile("state/ran", "1");',
    '        vm.copyFile("lib/pkg/fixture.json", "state/input.json");',
    '        console.log("vault balance", address(v).balance);',
    '        require(ok, "the kill switch did not trip");',
    '        assertEq(v.balanceOf(address(this)), 1, "proc: drained");',
    '        string[] memory c = new string[](2); c[0] = "node"; c[1] = "test/differential.js";',
    '        // see the /process notes in the report',
    '    }',
    '}'
  ];
  const flags = integrity.tamperFlags({
    added: added('test/Exploit.t.sol', lines),
    touched: [{ status: 'A', path: 'test/Exploit.t.sol' }],
    commands: { build: 'forge build', testFiles: 'forge test --match-path $FILES', testIds: 'forge test --match-test $TEST_IDS', test: 'forge test' }
  });
  assert.deepEqual(flags, []);
});

test('tamper flags are bounded (100) and in the report\'s order: kind, file, line', () => {
  const many = added('test/X.t.sol', Array.from({ length: 150 }, () => 'vm.writeFile("/tmp/x", "1");'));
  const flags = integrity.tamperFlags({ added: many, touched: [], commands: {} });
  assert.equal(flags.length, 100);
  assert.deepEqual(flags[0], { kind: 'write-outside-repository', file: 'test/X.t.sol', line: 1 });
  assert.deepEqual(flags[99], { kind: 'write-outside-repository', file: 'test/X.t.sol', line: 100 });
});

// ----------------------------------------------------------- the Integrity object

test('integrityOf: the report\'s Integrity shape; any failed check (or a tamper flag) names itself, in the fixed order', () => {
  const clean = integrity.integrityOf({ identity: [], summary: [], exit: [], protected: [], framework: [], dependencies: [], tamperFlags: [] });
  assert.deepEqual(clean.integrity, {
    identityComplete: true, summaryConsistent: true, exitConsistent: true,
    protectedPathsUnchanged: true, frameworkUnchanged: true, dependenciesUnchanged: true, tamperFlags: []
  });
  assert.equal(clean.clean, true);
  assert.deepEqual(clean.failures, []);
  const dirty = integrity.integrityOf({
    identity: [], summary: ['run 1: x has no forge suite summary'], exit: ['run 1: exited 0'], protected: [], framework: [],
    dependencies: ['run 2: lib/a.sol changed'], tamperFlags: [{ kind: 'reporter-patched', file: 'test/E.t.sol', line: 3 }]
  });
  assert.equal(dirty.clean, false);
  assert.deepEqual(dirty.failures.map((f) => f.check), ['summaryConsistent', 'exitConsistent', 'dependenciesUnchanged', 'tamperFlags']);
  assert.equal(dirty.integrity.dependenciesUnchanged, false);
  assert.match(integrity.integrityDetail(dirty.failures), /^summaryConsistent \(run 1: x has no forge suite summary\); exitConsistent \(run 1: exited 0\); dependenciesUnchanged \(run 2: lib\/a\.sol changed\); tamperFlags \(reporter-patched at test\/E\.t\.sol:3\)$/);
});

test('A3a R4-F1: configured directories with non-ASCII names (libs, out, cache_path, PATH, forge) are watched in the manifest\'s byte form', () => {
  const b = (p) => Buffer.from(p, 'utf8').toString('latin1');
  const tree = new Map();
  for (const p of ['/work/dépendances/x/src/X.sol', '/work/résultats/X.sol/X.json', '/work/cäche/solidity-files-cache.json', '/work/cäche/test-failures', '/work/bïn/tool', '/work/outils/forgé']) {
    tree.set(b(p), { type: 'f', mode: '644', content: 'x' });
  }
  const m = integrity.parseManifest(manifestOf(tree, ['/work']));
  assert.equal(m.ok, true, m.reason);
  const sets = integrity.classify(m.entries, {
    protectedGlobs: [],
    config: { out: 'résultats', cachePath: 'cäche', libs: ['dépendances'], solc: null },
    forgePath: '/work/outils/forgé', realPath: '/work/outils/forgé', pathDirs: ['/work/bïn']
  });
  const keys = (x) => [...x.keys()].map(integrity.displayPath).sort();
  assert.deepEqual(keys(sets.dependencies), ['dépendances/x/src/X.sol']);
  assert.deepEqual(keys(sets.artifacts), ['cäche/solidity-files-cache.json', 'résultats/X.sol/X.json']);
  assert.deepEqual(keys(sets.framework), ['bïn/tool', 'outils/forgé']);
});
