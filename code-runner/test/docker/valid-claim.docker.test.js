'use strict';

// Node A3d against real forge (the base pinned in @verdikta/common, v1.8.5). Two ways a valid claim settled wrong, both
// found on public repositories (A7b):
//
// 1. forge writes the mocks of its compile cache as an unordered list, and frameworkUnchanged held that file to the
//    bytes of run 1: a valid PoC whose imports bring in two or more such files settled DUPLICATE, at random.
// 2. A baseline test named test() (a fixture's coverage marker) made the word in `forge test` a test the finding names:
//    a valid PoC settled INVALID, the bond forfeited.
//
// Each with what must still fail: a real change to the compile cache, a finding that names another test. Under runc
// locally; CI runs this file under runc and under gVisor. Every container and image is removed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runText } = require('../../src/docker');
const { PLATFORM, dockerTestConfig, dockerFor, instanceId } = require('./helpers');
const { settlementFacts } = require('../helpers/settlementFacts');
const { VAULT_REPO, buildFixture, addFilesPatch, pocFile } = require('./forgeFixture');
const { body, check, claim, show } = require('./listingHarness');

const TIMEOUT = 900000;
const REPEATS = 3;
const builder = dockerFor(dockerTestConfig());
const fixtures = new Map();

const NAME = 'test_deposit_credits_exactly';
const MOCK_FILES = ['A', 'B', 'C', 'D'];

/** A test file holding a contract that inherits a source contract, which forge 1.8.5 takes for a mock, and a test of its own. */
const mockFile = (x) => [
  '// SPDX-License-Identifier: MIT',
  'pragma solidity ^0.8.0;',
  'import {Vault} from "../src/Vault.sol";',
  'import {Base} from "./Vm.sol";',
  `contract Mock${x} is Vault {}`,
  `contract Mock${x}Test is Base { function test_mock_${x}() public { require(address(new Mock${x}()) != address(0), "deployed"); } }`,
  ''
].join('\n');
const MOCK_REPO = Object.freeze({ ...VAULT_REPO, ...Object.fromEntries(MOCK_FILES.map((x) => [`test/Mock${x}.t.sol`, mockFile(x)])) });

const mockBaseline = (fx) => {
  const ids = [
    'test/Vault.t.sol > VaultTest > test_deposit()',
    ...MOCK_FILES.map((x) => `test/Mock${x}.t.sol > Mock${x}Test > test_mock_${x}()`)
  ].sort();
  return { version: 1, baseCommit: fx.baseCommit, framework: 'forge', runs: 3, tests: ids.map((id) => ({ id, results: ['pass', 'pass', 'pass'] })), stable: ids, unstable: [] };
};

/** The PoC of the measured case: valid on its own, with imports of the mock files that add no test of theirs to it. */
const importsMocks = (lines = []) => [
  '// SPDX-License-Identifier: MIT',
  'pragma solidity ^0.8.0;',
  'import {Vault} from "../src/Vault.sol";',
  'import {Base} from "./Vm.sol";',
  ...MOCK_FILES.map((x) => `import "./Mock${x}.t.sol" as Mocks${x};`),
  'contract ExploitTest is Base {',
  `    function ${NAME}() public {`,
  ...lines,
  '        Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1);',
  '    }',
  '}',
  ''
].join('\n');
const mockFinding = (poc = {}) => ({
  version: 1, claimedClass: 'HIGH', rootCause: 'A deposit credits one wei more than it receives, so balances overstate deposits.',
  affectedPaths: ['src/Vault.sol'], poc: { command: `forge test --match-test ${NAME}`, observable: `${NAME} fails at the committed hash with "2 != 1"`, ...poc }
});

const VARIANTS = Object.freeze({
  mocks: { files: MOCK_REPO },
  // ffi on by the maker, so a claim's test can edit what forge left; what is at stake is what the runner then sees.
  mocksffi: { toml: 'ffi = true', files: MOCK_REPO },
  // A listing's test that edits the compile cache on its second run.
  suiteforges: {
    toml: 'ffi = true',
    files: {
      ...MOCK_REPO,
      'test/Editor.t.sol': pocFile('Editor', [
        '    function test_edit() public {',
        '        string[] memory c = new string[](3); c[0] = "sh"; c[1] = "-c";',
        '        c[2] = "if [ -e /tmp/once ]; then sed -i \'s#Vault.sol/Vault.json#Vault.sol/Forged.json#\' cache/solidity-files-cache.json; fi; : > /tmp/once";',
        '        vm.ffi(c);',
        '    }'
      ])
    }
  },
  // Problem 2: a fixture's coverage marker, as a real repository has it.
  marker: {
    files: {
      ...VAULT_REPO,
      'test/Vault.t.sol': VAULT_REPO['test/Vault.t.sol'].replace('contract VaultTest is Base {', 'contract VaultTest is Base {\n    function test() public {}')
    }
  }
});

function fixture(variant) {
  if (!fixtures.has(variant)) fixtures.set(variant, buildFixture(builder, { ...VARIANTS[variant], instance: `${instanceId()}${variant}` }));
  return fixtures.get(variant);
}

test.after(async () => {
  for (const f of fixtures.values()) {
    try { await (await f).remove(); } catch (_) { /* the build failed: nothing to remove */ }
  }
});

const GATES = ['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable'];

function assertReachesTheJury(r) {
  assert.equal(r.outcome, 'definitive', show(r));
  for (const g of GATES) assert.equal(r.gates[g].status, 'pass', `${g}: ${show(r)}`);
  const read = settlementFacts(r);
  assert.deepEqual(read.issues, [], 'common\'s validator');
  assert.equal(read.tampered, false);
  assert.deepEqual(read.failedChecks, []);
  assert.equal(read.reproduces, 'pass');
}

/** The claim settled DUPLICATE on this check alone (owner decision Q35): bond back, no award. */
function assertFrameworkFails(r, re) {
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.integrity.status, 'fail', show(r));
  assert.match(r.gates.integrity.detail, /\bframeworkUnchanged\b/);
  assert.match(r.gates.integrity.detail, re);
  const read = settlementFacts(r);
  assert.deepEqual(read.issues, [], 'common\'s validator');
  assert.equal(read.tampered, false, JSON.stringify(r.facts.poc.integrity.tamperFlags));
  assert.deepEqual(read.failedChecks, ['frameworkUnchanged']);
  assert.equal(read.reproducesFailed, 'only-through-integrity');
}

// -------------------------------------------------- 1. forge's compile cache

test('what the rest of this file rests on, measured: forge 1.8.5 writes the mocks of its compile cache in another order, and nothing else there moves', { timeout: TIMEOUT }, async () => {
  const fx = await fixture('mocks');
  const WRITES = 6;
  const script = [
    'set -e',
    'cp -a /repo /tmp/w && cd /tmp/w',
    `printf '%s' '${Buffer.from(importsMocks()).toString('base64')}' | base64 -d > test/Exploit.t.sol`,
    'FOUNDRY_SOLC=/opt/solc/solc forge build --skip test > /dev/null 2>&1',
    `i=0; while [ $i -lt ${WRITES} ]; do`,
    '  FOUNDRY_SOLC=/opt/solc/solc forge test --match-path test/Exploit.t.sol --junit > /dev/null 2>&1 || true',
    '  base64 -w0 cache/solidity-files-cache.json; echo',
    '  i=$((i+1))',
    'done'
  ].join('\n');
  const out = await runText(builder, ['run', '--rm', '--pull', 'never', '--network', 'none', '--platform', PLATFORM, '--user', '0', '--entrypoint', '/bin/sh', fx.image, '-c', script], { timeoutMs: 600000 });
  assert.equal(out.exitCode, 0, out.stderr);
  const files = out.stdout.trim().split('\n').map((l) => JSON.parse(Buffer.from(l, 'base64').toString('utf8')));
  assert.equal(files.length, WRITES);
  const orders = new Set(files.map((f) => JSON.stringify(f.mocks)));
  assert.ok(orders.size > 1, `the same order on ${WRITES} writes: ${[...orders]}`);
  for (const f of files) assert.deepEqual([...f.mocks].sort(), MOCK_FILES.map((x) => `/tmp/w/test/Mock${x}.t.sol`));
  // Every other field, as forge wrote it, the same on every write.
  const rest = new Set(files.map(({ mocks, ...others }) => JSON.stringify(others)));
  assert.equal(rest.size, 1, 'a field besides mocks differs between runs');
});

test('a valid PoC whose imports bring the mocks into forge\'s compile cache settles the same on every repeat, the first listing-shaped build compiling no test', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('mocks');
  for (let k = 1; k <= REPEATS; k += 1) {
    const r = await claim(t, fx, {
      pocPatch: addFilesPatch({ 'test/Exploit.t.sol': importsMocks() }), baseline: mockBaseline(fx), finding: mockFinding(), commands: { build: 'forge build --skip test' }
    });
    assertReachesTheJury(r);
    assert.equal(r.facts.poc.integrity.frameworkUnchanged, true, `repeat ${k}`);
  }
});

test('the same on a build that compiled the mocks already: forge rewrites the file on each run with nothing to compile', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('mocks');
  for (let k = 1; k <= REPEATS; k += 1) {
    const r = await claim(t, fx, { pocPatch: addFilesPatch({ 'test/Exploit.t.sol': importsMocks() }), baseline: mockBaseline(fx), finding: mockFinding() });
    assertReachesTheJury(r);
  }
});

test('a listing whose suite takes in the mock files passes the real listing check, and a suite that really edits the compile cache is refused', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('mocks');
  for (let k = 1; k <= REPEATS; k += 1) {
    const r = await check(t, body(fx));
    assert.equal(r.facts.listing.status, 'accepted', show(r));
  }
  const forges = await fixture('suiteforges');
  const refused = await check(t, body(forges));
  assert.equal(refused.facts.listing.status, 'refused', show(refused));
  assert.deepEqual(refused.facts.listing.refusals.map((x) => x.code), ['IMAGE_WATCH_CHANGED_BY_SUITE'], show(refused));
  assert.match(refused.facts.listing.refusals[0].detail, /run 2: cache\/solidity-files-cache\.json changed/);
});

// What a PoC may do to the file on run 2, by ffi, once forge has written it there. The list reordered is what forge does
// itself; everything else is a real change, whatever it does to the list as well.
const SWAP = 's#"mocks":\\["\\([^"]*\\)","\\([^"]*\\)"#"mocks":["\\2","\\1"#';
const POINT = 's#Vault.sol/Vault.json#Vault.sol/Forged.json#';
const ONCE = (edit) => `if [ -e /tmp/once ]; then sed -i '${edit}' cache/solidity-files-cache.json; fi; : > /tmp/once`;
const ffiPoc = (script) => importsMocks([
  '        string[] memory c = new string[](3); c[0] = "sh"; c[1] = "-c";',
  `        c[2] = "${script.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}";`,
  '        vm.ffi(c);'
]);

test('review focus: reordering the mocks list by hand is what forge does itself, and fails nothing', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('mocksffi');
  const r = await claim(t, fx, { pocPatch: addFilesPatch({ 'test/Exploit.t.sol': ffiPoc(ONCE(SWAP)) }), baseline: mockBaseline(fx), finding: mockFinding(), commands: { build: 'forge build --skip test' } });
  assertReachesTheJury(r);
});

for (const [what, edit] of [
  ['an artifact pointed at another file', POINT],
  ['the same, with the list reordered to hide it', `${SWAP};${POINT}`],
  ['a file added to the list', 's#"mocks":\\[#"mocks":["/work/src/Vault.sol",#'],
  ['a file dropped from the list', 's#"mocks":\\["[^"]*",#"mocks":[#'],
  ['a file doubled in place of another', 's#"mocks":\\["\\([^"]*\\)","[^"]*"#"mocks":["\\1","\\1"#'],
  ['the list named twice', 's#"mocks":#"mocks":[],"mocks":#'],
  ['a key written twice before the real one', 's#^{#{"files":{},#'],
  ['a space added', 's#"mocks":#"mocks": #']
]) {
  test(`review focus: a real change to the compile cache still fails frameworkUnchanged, on real forge: ${what}`, { timeout: TIMEOUT }, async (t) => {
    const fx = await fixture('mocksffi');
    const r = await claim(t, fx, { pocPatch: addFilesPatch({ 'test/Exploit.t.sol': ffiPoc(ONCE(edit)) }), baseline: mockBaseline(fx), finding: mockFinding(), commands: { build: 'forge build --skip test' } });
    assertFrameworkFails(r, /run 2: cache\/solidity-files-cache\.json changed/);
  });
}

// ------------------------------------------- 2. the word `test` in a command

const markerBaseline = (fx) => {
  const ids = ['test/Vault.t.sol > VaultTest > test()', 'test/Vault.t.sol > VaultTest > test_deposit()'];
  return { version: 1, baseCommit: fx.baseCommit, framework: 'forge', runs: 3, tests: ids.map((id) => ({ id, results: ['pass', 'pass', 'pass'] })), stable: ids, unstable: [] };
};
const PLAIN_POC = pocFile('ExploitTest', [`    function ${NAME}() public { Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`]);

test('a listing with a baseline test named test() has it on its baseline, as forge reports it', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('marker');
  const r = await check(t, body(fx));
  assert.equal(r.facts.listing.status, 'accepted', show(r));
  assert.ok(r.facts.listing.baseline.stable.includes('test/Vault.t.sol > VaultTest > test()'), show(r));
});

for (const [what, command] of [
  ['the plain command', `forge test --match-test ${NAME}`],
  ['every word of the grammar', `forge test --match-path test/Exploit.t.sol --match-contract ExploitTest --match-test ${NAME} --fuzz-runs 256 --isolate -vvv`],
  ['a command outside the grammar', `FOUNDRY_PROFILE=default forge test --mt ${NAME} --json`],
  ['a path with a space in it', `forge test --match-path 'test/my test/Exploit.t.sol' --match-test ${NAME}`]
]) {
  test(`a valid PoC on a listing with a baseline test named test() reaches the jury: ${what}`, { timeout: TIMEOUT }, async (t) => {
    const fx = await fixture('marker');
    const r = await claim(t, fx, { pocPatch: addFilesPatch({ 'test/Exploit.t.sol': PLAIN_POC }), baseline: markerBaseline(fx), finding: mockFinding({ command }) });
    assertReachesTheJury(r);
    assert.match(r.gates.claimedObservable.detail, new RegExp(`names ${NAME};`));
  });
}

for (const [what, poc, re] of [
  ['the filter names it', { command: 'forge test --match-test test_deposit' }, /names test_deposit, which is not a test the patch added that failed/],
  ['the filter is the marker', { command: 'forge test --match-test test' }, /names test, which is not a test the patch added that failed/],
  ['the filter is the marker, with =', { command: 'forge test --mt=test' }, /names test, which is not a test the patch added that failed/],
  ['an argument names it', { command: 'forge test test_deposit' }, /names test_deposit, which is not a test the patch added that failed/],
  ['a flag inside a quoted filter cannot swallow it', { command: `forge test --match-test '${NAME}|(?: --match-path )?test_deposit'` }, /names test_deposit, which is not a test the patch added that failed/],
  ['the observable names it', { observable: `test_deposit and ${NAME} fail at the committed hash with "2 != 1"` }, /names test_deposit, which is not a test the patch added that failed/],
  ['the observable names the marker', { observable: `test() and ${NAME} fail with "2 != 1"` }, /names test, which is not a test the patch added that failed/],
  ['nothing names the added test', { command: 'forge test', observable: 'the deposit over-credits: "2 != 1"' }, /names none of the tests the patch added/]
]) {
  test(`review focus: a finding that names the wrong test still fails claimedObservable, on real forge: ${what}`, { timeout: TIMEOUT }, async (t) => {
    const fx = await fixture('marker');
    const r = await claim(t, fx, { pocPatch: addFilesPatch({ 'test/Exploit.t.sol': PLAIN_POC }), baseline: markerBaseline(fx), finding: mockFinding(poc) });
    assert.equal(r.outcome, 'definitive', show(r));
    assert.equal(r.gates.reproduces.status, 'pass', show(r));
    assert.equal(r.gates.integrity.status, 'pass', show(r));
    assert.equal(r.gates.claimedObservable.status, 'fail', show(r));
    assert.match(r.gates.claimedObservable.detail, re);
  });
}
