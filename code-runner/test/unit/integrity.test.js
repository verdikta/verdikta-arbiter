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
const { junit, manifestOf, forgeConfig, initialTree, kernelResolver } = require('../helpers/fakeClaim');

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

test('parseFramework reads forge\'s path, PATH and `forge config --json` (out, cache_path, libs, solc, broadcast, snapshots), and the config\'s hash', () => {
  const config = forgeConfig(initialTree());
  const p = integrity.parseFramework(Buffer.from(`vcr-forge /usr/local/bin/forge\nvcr-path /usr/local/bin:/work/bin:bin\n${config}`));
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.forgePath, '/usr/local/bin/forge');
  assert.deepEqual(p.pathDirs, ['/usr/local/bin', '/work/bin', '/work/bin']);
  assert.equal(p.configSha256, sha(config));
  assert.deepEqual(p.config, { out: 'out', cachePath: 'cache', libs: ['lib'], solc: '/opt/solc/solc', broadcast: 'broadcast', snapshots: 'snapshots' });
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

// ------------------------------------------------- links: the kernel resolves (attempt 2)

const CONFIG = Object.freeze({ out: 'out', cachePath: 'cache', libs: ['lib'], solc: '/opt/solc/solc', broadcast: 'broadcast', snapshots: 'snapshots' });
const link = (tree, p, target) => tree.set(p, { type: 'l', target });
const file = (tree, p, content = 'x') => tree.set(p, { type: 'f', mode: '644', content });
const keysOf = (x) => [...x.keys()].map(integrity.displayPath).sort();

/**
 * The sets of a fake tree with its watched links followed, the kernel's
 * answers coming from the fake's resolver (test/helpers/fakeClaim.js); every
 * batch the runner asked to resolve is in `calls`.
 */
async function watched(tree, o = {}) {
  const m = integrity.parseManifest(manifestOf(tree, ['/work', '/home/sandbox']));
  assert.equal(m.ok, true, m.reason);
  const sets = integrity.classify(m.entries, {
    protectedGlobs: o.protectedGlobs || ['foundry.toml'], config: o.config || CONFIG, forgePath: '/usr/local/bin/forge', pathDirs: ['/usr/local/bin']
  });
  const kernel = kernelResolver(tree);
  const calls = [];
  const resolve = async (paths) => {
    calls.push(paths);
    return new Map(paths.map((p) => [p, kernel(p)]));
  };
  const roots = integrity.watchRoots({ protectedGlobs: o.protectedGlobs || ['foundry.toml'], config: o.config || CONFIG, forgePath: '/usr/local/bin/forge', pathDirs: ['/usr/local/bin'] });
  const r = await integrity.watchLinks(m.entries, sets, {
    config: o.config || CONFIG, testGlobs: o.testGlobs || ['test/**'], patchPaths: o.patchPaths || new Set(), roots,
    ...(o.categories ? { categories: o.categories } : {}), ...(o.limits ? { limits: o.limits } : {})
  }, resolve);
  return { sets, r, calls, entries: m.entries };
}

test('A3a R6-F1 (round 7): the kernel resolves a watched link in filesystem order, `..` after a link in the middle taken from where that link leads', async () => {
  const tree = initialTree();
  // lib/pkg -> ../bridge/../payload with bridge -> vendor/nested: the kernel reaches vendor/payload; collapsing `..` first gives payload/.
  link(tree, '/work/lib/pkg', '../bridge/../payload');
  link(tree, '/work/bridge', 'vendor/nested');
  file(tree, '/work/vendor/nested/.keep');
  file(tree, '/work/vendor/payload/fixture.json', '{}');
  file(tree, '/work/payload/fixture.json', '{}');
  const { sets, r, calls } = await watched(tree);
  assert.ok(keysOf(sets.dependencies).includes('vendor/payload/fixture.json'), JSON.stringify(keysOf(sets.dependencies)));
  assert.ok(!keysOf(sets.dependencies).includes('payload/fixture.json'), 'the lexical answer is nobody\'s dependency');
  // The link's own entry carries the kernel's answer; the unwatched link on the way (bridge) is never asked about.
  assert.match(sets.dependencies.get('lib/pkg'), /^l 777 20 -> \.\.\/bridge\/\.\.\/payload => d \/work\/vendor\/payload$/);
  assert.deepEqual(calls, [['/work/lib/pkg']]);
  assert.deepEqual(r.uncovered, []);
});

test('A3a R6-F1 (round 7): a watched link into forge\'s cache directory is uncovered, the link and its target named; its tree is never watched as a dependency', async () => {
  const tree = initialTree();
  link(tree, '/work/lib/cpkg', '../cache/pkg');
  file(tree, '/work/cache/pkg/Dep.sol', 'contract Dep {}');
  const { sets, r } = await watched(tree);
  assert.deepEqual(r.uncovered, [{ link: 'lib/cpkg', target: '/work/cache/pkg', where: 'forge\'s cache directory (cache)', category: 'dependencies' }]);
  assert.ok(!keysOf(sets.dependencies).includes('cache/pkg/Dep.sol'));
});

test('item 3: a watched link whose real target is in (or holds) a place builds and runs write to, or is a directory outside the work tree, is uncovered; a file on the read-only root, or a link that resolves to nothing, is not', async () => {
  const tree = initialTree();
  const want = {
    'lib/tmp': ['/tmp/dep', '/tmp/dep', /^\/tmp$/],
    'lib/home': ['/home/sandbox/dep', '/home/sandbox/dep', /^\$HOME$/],
    'lib/out': ['../out/Vault.sol', '/work/out/Vault.sol', /^forge's out directory \(out\)$/],
    'lib/bc': ['../broadcast/Deploy.s.sol', '/work/broadcast/Deploy.s.sol', /^forge's broadcast directory \(broadcast\)$/],
    'lib/snap': ['../snapshots', '/work/snapshots', /^forge's snapshots directory \(snapshots\)$/],
    'lib/git': ['../.git', '/work/.git', /^the runner's repository \(\.git\)$/],
    'lib/root': ['..', '/work', /^the work tree's root$/],
    'lib/slash': ['/', '/', /holds \/tmp, \$HOME or the work tree/],
    'lib/homes': ['/home', '/home', /holds \/tmp, \$HOME or the work tree/],
    'lib/tests': ['../test/helpers', '/work/test/helpers', /^paths\.tests$/],
    'lib/testfile': ['../test/Vault.t.sol', '/work/test/Vault.t.sol', /^paths\.tests$/],
    'lib/nest': ['../nest', '/work/nest', /^a directory holding forge's out directory \(nest\/out\)$/],
    // A directory on the read-only root is not listed: a link inside it (here one back into the work tree) is unseen.
    'lib/ro': ['/opt/pkg', '/opt/pkg', /^a directory outside the work tree, whose links the runner does not list$/]
  };
  for (const [rel, [target]] of Object.entries(want)) link(tree, `/work/${rel}`, target);
  file(tree, '/tmp/dep/A.sol');
  file(tree, '/home/sandbox/dep/A.sol');
  file(tree, '/work/out/Vault.sol/Vault.json');
  file(tree, '/work/broadcast/Deploy.s.sol/1/run-latest.json');
  file(tree, '/work/snapshots/A.json');
  file(tree, '/work/test/helpers/H.sol');
  file(tree, '/work/nest/src/N.sol');
  // Not uncovered: a file on the read-only root (immutable, its real path holds no link), and links that resolve to nothing.
  file(tree, '/opt/pkg/P.sol');
  link(tree, '/opt/pkg/inner', '/work/vendor/evil');
  file(tree, '/work/vendor/evil/E.sol');
  link(tree, '/work/lib/rofile', '/opt/pkg/P.sol');
  link(tree, '/work/lib/dangling', '../nothing/here');
  link(tree, '/work/lib/loop1', 'loop2');
  link(tree, '/work/lib/loop2', 'loop1');
  const m = integrity.parseManifest(manifestOf(tree, ['/work', '/home/sandbox']));
  const config = { ...CONFIG, out: 'nest/out' };
  const sets = integrity.classify(m.entries, { protectedGlobs: [], config, forgePath: '/usr/local/bin/forge', pathDirs: [] });
  const kernel = kernelResolver(tree);
  const r = await integrity.watchLinks(m.entries, sets, { config, testGlobs: ['test/**'], patchPaths: new Set() }, async (ps) => new Map(ps.map((p) => [p, kernel(p)])));
  // nest/out is forge's out here; lib/out's target is then no artifact directory, so the default out/ rule comes from `config`.
  const got = new Map(r.uncovered.map((u) => [u.link, u]));
  for (const [rel, [, target, where]] of Object.entries(want)) {
    if (rel === 'lib/out') continue;
    assert.ok(got.has(rel), `${rel} is uncovered: ${JSON.stringify(r.uncovered)}`);
    assert.equal(got.get(rel).target, target, rel);
    assert.match(got.get(rel).where, where, rel);
  }
  for (const rel of ['lib/rofile', 'lib/dangling', 'lib/loop1', 'lib/loop2']) assert.ok(!got.has(rel), `${rel} is not uncovered`);
  assert.match(sets.dependencies.get('lib/rofile'), / => f \/opt\/pkg\/P\.sol$/);
  assert.ok(!keysOf(sets.dependencies).includes('vendor/evil/E.sol'));
  assert.match(sets.dependencies.get('lib/dangling'), / => \?$/);
  assert.match(sets.dependencies.get('lib/loop1'), / => \?$/);
  assert.ok(!keysOf(sets.dependencies).some((k) => k.startsWith('/opt')), 'the read-only root is not listed');
  // With forge's out at out/, a link into it is uncovered too.
  const plain = await watched(tree, { testGlobs: ['test/**'] });
  assert.match(plain.r.uncovered.find((u) => u.link === 'lib/out').where, /^forge's out directory \(out\)$/);
});

test('item 2: only links inside a watched set are resolved; links in the test paths, the sources and anywhere else are never followed', async () => {
  const tree = initialTree();
  for (let i = 0; i < 5; i += 1) link(tree, `/work/test/links/l${i}`, '.');
  link(tree, '/work/src/Gen.sol', '../gen/Gen.sol');
  file(tree, '/work/gen/Gen.sol', 'contract Gen {}');
  link(tree, '/work/state/tmp', '/tmp/scratch');
  const before = await watched(new Map(tree));
  assert.deepEqual(before.calls, [], 'nothing was resolved');
  assert.equal(before.r.links, 0);
  assert.ok(!keysOf(before.sets.dependencies).includes('gen/Gen.sol'));
  assert.deepEqual(before.r.uncovered, []);
  // A maker who wants a linked source watched lists it under paths.protected: then the kernel resolves it and its target is watched as it is.
  const prot = await watched(new Map(tree), { protectedGlobs: ['foundry.toml', 'src/**'] });
  assert.deepEqual(prot.calls, [['/work/src/Gen.sol']]);
  assert.ok(keysOf(prot.sets.protected).includes('gen/Gen.sol'));
});

test('item 2: the closure is transitive and deduplicated by real path: links in a tree a link leads to are resolved in the next round, once', async () => {
  const tree = initialTree();
  link(tree, '/work/lib/a', '../v1');
  link(tree, '/work/lib/a2', '../v1/.');
  link(tree, '/work/v1/b', '../v2');
  file(tree, '/work/v1/x.sol');
  file(tree, '/work/v2/c.sol');
  // A forge-std behind a link: the link is the framework and a dependency, and so is what it leads to.
  link(tree, '/work/lib/forge-std2', '../vendor/forge-std');
  file(tree, '/work/vendor/forge-std/src/Test.sol');
  const { sets, r, calls } = await watched(tree);
  assert.deepEqual(calls, [['/work/lib/a', '/work/lib/a2', '/work/lib/forge-std2'], ['/work/v1/b']]);
  assert.equal(r.rounds, 2);
  for (const k of ['v1/x.sol', 'v1/b', 'v2/c.sol', 'vendor/forge-std/src/Test.sol']) assert.ok(keysOf(sets.dependencies).includes(k), k);
  assert.ok(keysOf(sets.framework).includes('vendor/forge-std/src/Test.sol'));
  assert.ok(!keysOf(sets.framework).includes('v1/x.sol'));
  assert.match(sets.dependencies.get('v1/b'), / => d \/work\/v2$/);
});

test('links whose targets change between runs: a link on the way retargeted, with identical bytes behind it, changes the watched link\'s own entry', async () => {
  const mk = (bridge) => {
    const tree = initialTree();
    link(tree, '/work/lib/pkg', '../bridge/pkg');
    link(tree, '/work/bridge', bridge);
    file(tree, '/work/vendor/pkg/X.sol', 'contract X {}');
    file(tree, '/work/vendor2/pkg/X.sol', 'contract X {}');
    return tree;
  };
  const a = await watched(mk('vendor'));
  const b = await watched(mk('vendor2'));
  assert.deepEqual(integrity.changedPaths(a.sets.dependencies, b.sets.dependencies).map(integrity.displayPath), ['lib/pkg', 'vendor/pkg/X.sol', 'vendor2/pkg/X.sol']);
});

test('A3a R7-F1: host work is linear and bounded: 20,000 watched links to `.` are one batch of 20,000, deduplicated to one tree, in bounded time and memory', async () => {
  const N = 20000;
  const many = (dir, target = '.') => {
    const tree = initialTree();
    for (let i = 0; i < N; i += 1) link(tree, `/work/${dir}/l${i}`, target);
    return tree;
  };
  const heap = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  const { r, calls, entries } = await watched(many('lib'));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, N);
  assert.equal(r.links, N);
  assert.deepEqual(r.uncovered, []);
  // Each link and each listed entry is visited a bounded number of times (attempt 1 scanned the listing per link: N^2).
  assert.ok(r.visited <= 3 * entries.size, `${r.visited} visits for ${entries.size} entries`);
  assert.ok(ms < 5000, `${ms} ms`);
  assert.ok(process.memoryUsage().heapUsed - heap < 256 * 1024 * 1024, 'memory');
  // Twice the links, about twice the work.
  const half = await watched((() => { const t = initialTree(); for (let i = 0; i < N / 2; i += 1) link(t, `/work/lib/l${i}`, '.'); return t; })());
  assert.ok(r.visited <= 2.2 * half.r.visited, `${r.visited} vs ${half.r.visited}`);
  // In the test paths (where poc.patch may add them) they are never followed.
  const t1 = process.hrtime.bigint();
  const tests = await watched(many('test/links'));
  assert.deepEqual(tests.calls, []);
  assert.equal(tests.r.visited, 0);
  assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 < 5000);
  // To `..` (the work tree's root): every one uncovered, still one batch.
  const up = await watched(many('lib', '..'));
  assert.equal(up.calls.length, 1);
  assert.equal(up.r.uncovered.length, N);
  assert.ok(up.r.visited <= 3 * up.entries.size);
});

test('A3a R7-F1: each listed entry is visited at most once per set, also when a later round joins a tree that holds an earlier one', async () => {
  // t/1/…/8, 500 files at each level; lib/a leads to the deepest, and each level holds `up -> ..`: every round joins
  // the parent of the last tree. Joined naively (each tree scanned whole), that is 8 passes over the deepest files.
  const tree = initialTree();
  let dir = '/work/t';
  const levels = [];
  for (let d = 1; d <= 8; d += 1) {
    dir = `${dir}/${d}`;
    levels.push(dir);
    for (let i = 0; i < 500; i += 1) file(tree, `${dir}/f${i}.sol`);
  }
  for (const d of levels.slice(1)) link(tree, `${d}/up`, '..');
  link(tree, '/work/lib/a', `..${levels[7].slice('/work'.length)}`);
  const { sets, r, entries } = await watched(tree);
  assert.equal(r.rounds, 8);
  assert.equal(keysOf(sets.dependencies).filter((k) => k.startsWith('t/')).length, 8 * 500 + 7);
  assert.ok(r.visited <= entries.size + 2 * r.links, `${r.visited} visits for ${entries.size} entries and ${r.links} links`);
});

test('item 4: more watched links than the cap, or links nested deeper than the round cap, are too large to watch, before any resolution past the cap', async () => {
  assert.equal(integrity.MAX_WATCHED_LINKS, 50000);
  assert.equal(integrity.MAX_LINK_ROUNDS, 16);
  const tree = initialTree();
  for (let i = 0; i < 11; i += 1) link(tree, `/work/lib/l${i}`, '.');
  await assert.rejects(watched(tree, { limits: { links: 10 } }), (err) => err instanceof integrity.WatchTooLarge && /more than 10 watched links/.test(err.message));
  // The cap holds as links are queued: a tree a link leads to that holds 1,000 links stops at the 11th, the kernel asked once.
  const wide = initialTree();
  link(wide, '/work/lib/a', '../v');
  for (let i = 0; i < 1000; i += 1) link(wide, `/work/v/l${i}`, '.');
  const m = integrity.parseManifest(manifestOf(wide, ['/work', '/home/sandbox']));
  const sets = integrity.classify(m.entries, { protectedGlobs: [], config: CONFIG, forgePath: '/usr/local/bin/forge', pathDirs: [] });
  const kernel = kernelResolver(wide);
  const asked = [];
  await assert.rejects(integrity.watchLinks(m.entries, sets, { config: CONFIG, limits: { links: 10 } }, async (ps) => { asked.push(ps.length); return new Map(ps.map((p) => [p, kernel(p)])); }),
    (err) => err instanceof integrity.WatchTooLarge);
  assert.deepEqual(asked, [1]);
  // A chain d0 -> d1 -> … each one a round: 17 rounds exceed 16.
  const chain = initialTree();
  link(chain, '/work/lib/c0', '../d1');
  for (let i = 1; i <= 17; i += 1) link(chain, `/work/d${i}/c${i}`, `../d${i + 1}`);
  file(chain, '/work/d18/end.sol');
  await assert.rejects(watched(chain), (err) => err instanceof integrity.WatchTooLarge && /more than 16 levels/.test(err.message));
  const ok = await watched(chain, { limits: { rounds: 20 } });
  assert.equal(ok.r.rounds, 18);
  assert.ok(keysOf(ok.sets.dependencies).includes('d18/end.sol'));
  // The listing's entries are capped too (parseManifest stops past the cap).
  const big = new Map();
  for (let i = 0; i < 5; i += 1) file(big, `/work/f${i}`);
  const p = integrity.parseManifest(manifestOf(big, ['/work']), { maxEntries: 4 });
  assert.equal(p.ok, false);
  assert.equal(p.tooLarge, true);
  assert.match(p.reason, /more than 4 entries/);
  assert.equal(integrity.parseManifest(manifestOf(big, ['/work']), { maxEntries: 5 }).ok, true);
  assert.equal(integrity.MAX_ENTRIES, 1000000);
});

test('a link at or above a set\'s root: the kernel resolves the root itself, and exactly what it leads to joins the set (a lib behind a linked directory, forge\'s cache directory, out, a protected path)', async () => {
  const tree = initialTree();
  // libs = ["deps/lib"] with deps -> third_party: forge reads deps/lib/… from third_party/lib/; nothing is listed under deps/.
  link(tree, '/work/deps', 'third_party');
  file(tree, '/work/third_party/lib/X.sol', 'contract X {}');
  file(tree, '/work/third_party/other.sol');
  // forge's out under a linked directory, and its cache directory itself a link (the compile cache is held, the rest is not).
  link(tree, '/work/build', 'b');
  file(tree, '/work/b/out/V.sol/V.json', '{}');
  link(tree, '/work/cache', 'shared-cache');
  file(tree, '/work/shared-cache/solidity-files-cache.json', '{}');
  file(tree, '/work/shared-cache/test-failures', 'run 1');
  // A protected glob whose literal directory is a link (over the whole tree it leads to), and an exact protected path.
  link(tree, '/work/config', 'shared');
  file(tree, '/work/shared/a.toml');
  file(tree, '/work/shared/notes.txt');
  link(tree, '/work/conf2', 'shared2');
  file(tree, '/work/shared2/x.toml');
  file(tree, '/work/shared2/y.toml');
  const config = { ...CONFIG, libs: ['lib', 'deps/lib'], out: 'build/out' };
  const { sets, r } = await watched(tree, { config, protectedGlobs: ['foundry.toml', 'config/*.toml', 'conf2/x.toml'] });
  assert.deepEqual(r.uncovered, []);
  assert.ok(keysOf(sets.dependencies).includes('third_party/lib/X.sol'));
  assert.ok(!keysOf(sets.dependencies).includes('third_party/other.sol'), 'the root, not the whole tree the link leads to');
  assert.match(sets.dependencies.get('deps/lib'), /^root => d \/work\/third_party\/lib$/);
  assert.ok(keysOf(sets.artifacts).includes('b/out/V.sol/V.json'));
  assert.ok(keysOf(sets.artifacts).includes('shared-cache/solidity-files-cache.json'));
  assert.ok(!keysOf(sets.artifacts).includes('shared-cache/test-failures'), 'forge rewrites the rest of its cache on every run');
  for (const k of ['shared/a.toml', 'shared/notes.txt', 'shared2/x.toml']) assert.ok(keysOf(sets.protected).includes(k), k);
  assert.ok(!keysOf(sets.protected).includes('shared2/y.toml'));
  // The cache directory a link into /tmp: the compile cache there is uncovered (the artifacts are run 1's on).
  const tmp = initialTree();
  link(tmp, '/work/cache', '/tmp/cache');
  file(tmp, '/tmp/cache/solidity-files-cache.json', '{}');
  const t = await watched(tmp);
  assert.deepEqual(t.r.uncovered, [{ link: 'cache/solidity-files-cache.json', target: '/tmp/cache/solidity-files-cache.json', where: '/tmp', category: 'artifacts' }]);
  // The patch's own link on the way to a root (paths.tests overlapping) is the claim's, never resolved.
  const own = initialTree();
  link(own, '/work/deps', 'third_party');
  file(own, '/work/third_party/lib/X.sol');
  const p = await watched(own, { config, patchPaths: new Set(['deps']) });
  assert.deepEqual(p.calls, []);
  assert.deepEqual(p.r.patchLinks, [{ link: 'deps', category: 'dependencies' }]);
});

test('a link a patch adds inside a watched set (paths.tests overlapping lib/) is reported, never resolved or followed', async () => {
  const tree = initialTree();
  link(tree, '/work/lib/x/E.t.sol', '/tmp/evil');
  link(tree, '/work/lib/y', '../vendor/y');
  file(tree, '/work/vendor/y/Y.sol');
  const { r, calls } = await watched(tree, { patchPaths: new Set(['lib/x/E.t.sol']), testGlobs: ['test/**', 'lib/**/*.t.sol'] });
  assert.deepEqual(calls, [['/work/lib/y']]);
  assert.deepEqual(r.patchLinks, [{ link: 'lib/x/E.t.sol', category: 'dependencies' }]);
  assert.deepEqual(r.uncovered, []);
});

test('parseLinks reads the link script\'s records in the order asked, byte for byte; anything else is unreadable', () => {
  const batch = ['/work/lib/a', `/work/lib/${Buffer.from('é\nb').toString('latin1')}`, '/work/lib/c', '/work/lib/d'];
  const ok = Buffer.from(`d\0${batch[0]}\0/work/v\0f\0${batch[1]}\0/work/x\ny\0?\0${batch[2]}\0\0!\0${batch[3]}\0\0`, 'latin1');
  const p = integrity.parseLinks(ok, batch);
  assert.equal(p.ok, true, p.reason);
  assert.deepEqual([...p.answers], [
    [batch[0], { kind: 'd', real: '/work/v' }], [batch[1], { kind: 'f', real: '/work/x\ny' }], [batch[2], { kind: '?', real: '' }], [batch[3], { kind: '!', real: '' }]
  ]);
  for (const bad of [
    `d\0${batch[1]}\0/work/v\0`, // out of order
    `d\0${batch[0]}\0/work/v\0`, // too few
    `x\0${batch[0]}\0/work/v\0`, // not a kind
    `d\0${batch[0]}\0relative\0`, // not absolute
    `?\0${batch[0]}\0/work/v\0`, // an answer for nothing
    `d\0${batch[0]}\0/work/v` // no end
  ]) assert.equal(integrity.parseLinks(Buffer.from(bad, 'latin1'), batch).ok, false, JSON.stringify(bad));
});

test('the link script is hermetic, reads its paths from stdin, and leaves resolution to the kernel (cd -P, realpath -e)', () => {
  const argv = integrity.linksArgv();
  assert.deepEqual(argv.slice(0, 2), ['/usr/bin/env', '-i']);
  const sh = argv.indexOf('/bin/sh');
  assert.deepEqual(argv.slice(sh), ['/bin/sh', '-c', integrity.LINKS_SCRIPT, 'vcr-links']);
  assert.match(integrity.LINKS_SCRIPT, /cd -P -- "\$l"/);
  assert.match(integrity.LINKS_SCRIPT, /realpath -e -- "\$l"/);
  assert.doesNotMatch(integrity.LINKS_SCRIPT, /readlink/, 'the script never reads a link\'s text');
});

test('the link script against the real kernel (Linux: dash, GNU coreutils): the R6-F1 forms, a file link, dangling and looping links, a line break in a name', { skip: process.platform !== 'linux' }, () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-links-')));
  try {
    const at = (p) => path.join(root, p);
    for (const d of ['vendor/nested', 'vendor/payload', 'lib', 'cache/pkg', 'a\nb']) fs.mkdirSync(at(d), { recursive: true });
    fs.writeFileSync(at('vendor/payload/f.json'), '{}');
    fs.symlinkSync('vendor/nested', at('bridge'));
    fs.symlinkSync('../bridge/../payload', at('lib/pkg'));
    fs.symlinkSync('../cache/pkg', at('lib/cpkg'));
    fs.symlinkSync('../vendor/payload/f.json', at('lib/file'));
    fs.symlinkSync('nope', at('lib/dang'));
    fs.symlinkSync('loop2', at('lib/loop1'));
    fs.symlinkSync('loop1', at('lib/loop2'));
    fs.symlinkSync('../a\nb', at('lib/nl'));
    const batch = ['lib/pkg', 'lib/cpkg', 'lib/file', 'lib/dang', 'lib/loop1', 'lib/nl'].map(at);
    const argv = integrity.linksArgv();
    const r = spawnSync(argv[0], argv.slice(1), { input: Buffer.from(`${batch.join('\0')}\0`, 'latin1') });
    assert.equal(r.status, 0, r.stderr.toString());
    const p = integrity.parseLinks(r.stdout, batch);
    assert.equal(p.ok, true, p.reason);
    assert.deepEqual([...p.answers.values()], [
      { kind: 'd', real: at('vendor/payload') }, { kind: 'd', real: at('cache/pkg') }, { kind: 'f', real: at('vendor/payload/f.json') },
      { kind: '?', real: '' }, { kind: '?', real: '' }, { kind: 'd', real: at('a\nb') }
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
