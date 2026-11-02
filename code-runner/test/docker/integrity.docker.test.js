'use strict';

// Node A3a against real forge (the base pinned in @verdikta/common, v1.8.5):
// the §9.5 integrity checks, claimedObservable and the fix check, with every
// catalogue fixture of the node in its forge form — ffi and fs-cheatcode
// attempts, stdout mimicking forge's JUnit, lib/ edits — and ordinary PoCs
// that must raise nothing. Under runc locally; CI runs this file under runc
// and under gVisor (runsc). Every container and image is removed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { executeRun } = require('../../src/pipeline');
const { checkSpec } = require('../../src/classLimits');
const { claimSteps } = require('../../src/steps');
const { RUNTIME, silent, instanceId, dockerTestConfig, dockerFor, leftovers, removeAll } = require('./helpers');
const { VAULT_REPO, FOUNDRY_TOML, vaultBaseline, buildFixture, addFilesPatch, modifyPatch, pocFile } = require('./forgeFixture');

const TIMEOUT = 900000;
const fixtures = new Map();
const builder = dockerFor(dockerTestConfig());

const FORGE_STD = '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract StdMarker {}\n';
const PLAIN_TOML = 'fs_permissions = [{ access = "read-write", path = "./state" }]';
const VARIANTS = Object.freeze({
  // The vault with a maker-allowed state directory, a tracked forge-std file and an untracked dependency in lib/.
  plain: {
    toml: PLAIN_TOML,
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'mkdir -p lib/solady/src && printf "contract Solady {}\\n" > lib/solady/src/Solady.sol'
  },
  // The same, with ffi enabled by the maker (ffi cannot be enabled inline at forge 1.8.5).
  ffi: {
    toml: 'ffi = true',
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'mkdir -p lib/solady/src && printf "contract Solady {}\\n" > lib/solady/src/Solady.sol'
  }
});

function fixture(variant = 'plain') {
  if (!fixtures.has(variant)) fixtures.set(variant, buildFixture(builder, { ...VARIANTS[variant], instance: `${instanceId()}${variant}` }));
  return fixtures.get(variant);
}

test.after(async () => {
  for (const f of fixtures.values()) {
    try { await (await f).remove(); } catch (_) { /* the build failed: nothing to remove */ }
  }
});

function claimSpec(fx, over = {}) {
  return {
    version: 1,
    kind: 'bug',
    repo: 'https://github.com/acme/vault',
    baseCommit: fx.baseCommit,
    env: { image: fx.image, from: 'foundry', platform: 'linux/amd64', unpackedBytes: 2000000000 },
    attestation: 'attestation.json',
    commands: {
      framework: 'forge', build: 'forge build', test: 'forge test',
      testFiles: 'forge test --match-path $FILES', testIds: 'forge test --match-test $TEST_IDS', ...(over.commands || {})
    },
    paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.gitignore'] },
    limits: { cpus: 1, memoryMb: 1024, buildSeconds: 90, testSeconds: 120, runSeconds: 360, maxPatchBytes: 2000000 }
  };
}

const NAME = 'test_deposit_credits_exactly';
function finding(poc = {}) {
  return {
    version: 1, claimedClass: 'HIGH', rootCause: 'Vault.deposit credits one wei more than it receives, so balances overstate deposits.',
    affectedPaths: ['src/Vault.sol'],
    poc: { command: `forge test --match-test ${NAME}`, observable: `${NAME} fails at the committed hash with "2 != 1"`, ...poc }
  };
}

function claim(fx, pocPatch, over = {}) {
  return {
    listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    bcid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    spec: claimSpec(fx, over),
    attestation: {},
    pocPatch,
    fixPatch: over.fixPatch || null,
    baseline: vaultBaseline(fx.baseCommit),
    finding: over.finding || finding(),
    report: '',
    knownIssues: [],
    priorFindings: [],
    eaGates: { disclosure: 'pass', inScope: 'pass' },
    deadlineMs: 800000
  };
}

async function run(t, request) {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance).catch(() => {}));
  const lim = checkSpec(request.spec);
  assert.ok(lim.ok, JSON.stringify(lim.issues));
  const receivedAt = Date.now();
  const result = await executeRun({
    docker, config, limits: lim.limits, image: request.spec.env.image, runId: crypto.randomBytes(8).toString('hex'),
    steps: claimSteps(request, lim.limits), receivedAt, deadlineAt: receivedAt + request.deadlineMs,
    active: new Set(), log: silent, sandboxes: request.fixPatch ? 2 : 1
  });
  assert.deepEqual(await leftovers(docker, config.instance), [], 'the run removed its sandboxes');
  return result;
}

const show = (r) => JSON.stringify({
  outcome: r.outcome, abstain: r.abstain, issues: r.issues, gates: r.gates,
  integrity: r.facts && r.facts.poc ? r.facts.poc.integrity : undefined, failures: r.facts && r.facts.integrity ? r.facts.integrity.poc : undefined,
  runs: r.facts && r.facts.poc ? r.facts.poc.runs : undefined,
  step: r.abstain ? (r.steps || []).find((s) => s.name === r.abstain.step) : undefined
}, null, 1);

const CLEAN = Object.freeze({
  identityComplete: true, summaryConsistent: true, exitConsistent: true,
  protectedPathsUnchanged: true, frameworkUnchanged: true, dependenciesUnchanged: true, tamperFlags: []
});

/** The vault's bug: a deposit credits one wei too many. */
const DRAIN = pocFile('ExploitTest', [
  `    function ${NAME}() public { Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
]);

/** A Solidity string literal of `text` (quotes and backslashes escaped, line breaks as \n). */
const sol = (text) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

/** An ffi call running `script` in sh, as one line of a test body. */
const ffiSh = (script) => `string[] memory c = new string[](3); c[0] = "sh"; c[1] = "-c"; c[2] = ${sol(script)}; vm.ffi(c);`;

// ------------------------------------------------------------ no false positives

test('ordinary PoCs raise no integrity failure under real forge: the vault PoC, a build that skips tests, a PoC writing an allowed state file', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const r = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': DRAIN })));
  assert.equal(r.outcome, 'definitive', show(r));
  for (const g of ['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable']) assert.equal(r.gates[g].status, 'pass', `${g}: ${show(r)}`);
  assert.deepEqual(r.facts.poc.integrity, CLEAN);
  for (const [name, v] of Object.entries(r.facts)) assert.ok(v && (v.tier === 'A' || v.tier === 'B'), `${name} carries its tier`);

  // `forge build --skip test`: run 1 compiles the tests and rewrites out/ (a new build-info): not a change.
  const skip = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': DRAIN }), { commands: { build: 'forge build --skip test' } }));
  assert.equal(skip.gates.integrity.status, 'pass', show(skip));

  // A PoC that writes the state directory the maker allowed, every run, and fails each time.
  const state = pocFile('ExploitTest', [
    `    function ${NAME}() public { vm.writeFile("state/seen", "1"); Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
  ]);
  const s = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': state })));
  assert.equal(s.gates.integrity.status, 'pass', show(s));
  assert.equal(s.gates.reproduces.status, 'pass');
});

// ------------------------------------------------------- the catalogue fixtures

test('junit-forged-early-exit (forge form): an ffi child prints a JUnit to forge\'s stdout and kills forge; with the exit masked, exit-code and summary consistency refuse it, unmasked it abstains', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('ffi');
  const forged = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="Test run" tests="1" skipped="0" failures="1" errors="0">',
    '<testsuite name="test/Exploit.t.sol:ExploitTest" tests="1" skipped="0" errors="0" failures="1">',
    '<testcase name="test_forged()"><failure message="vault drained"/><system-out>[FAIL: vault drained] test_forged() (gas: 3266)</system-out></testcase>',
    '</testsuite></testsuites>'
  ].join('');
  const poc = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      `    function test_forged() public { ${ffiSh(`printf '%s\\n' '${forged}' > /proc/$PPID/fd/1; kill -9 $PPID`)} }`
    ])
  });
  // A maker command that inverts forge's exit (`!`): a forge killed by the child then ends 0, a clean exit.
  const masked = await run(t, claim(fx, poc, {
    commands: { testFiles: '! forge test --match-path $FILES', testIds: '! forge test --match-test $TEST_IDS' },
    finding: finding({ command: 'forge test --match-test test_forged', observable: 'test_forged fails with "vault drained"' })
  }));
  assert.equal(masked.outcome, 'definitive', show(masked));
  assert.equal(masked.gates.integrity.status, 'fail', show(masked));
  assert.equal(masked.gates.reproduces.status, 'fail');
  assert.equal(masked.facts.poc.integrity.exitConsistent, false, 'the command exited 0 with no report of its own or a failing one');
  if (masked.facts.poc.runs[0].junit === 'ok') {
    // Where forge's stdout can be reopened (runc), the forged document was read: it has no forge summary.
    assert.equal(masked.facts.poc.integrity.summaryConsistent, false, show(masked));
    assert.equal(masked.gates.reproduces.basis, 'integrity', 'only the integrity checks stood between the forged record and reproduces');
  } else {
    assert.notEqual(RUNTIME, 'runc', 'runc reopens /proc/<pid>/fd/1');
  }
  const kinds = new Set(masked.facts.poc.integrity.tamperFlags.map((f) => f.kind));
  for (const k of ['report-path-referenced', 'exit-during-import']) assert.ok(kinds.has(k), `${k}: ${JSON.stringify(masked.facts.poc.integrity.tamperFlags)}`);

  // Unmasked, the kill is a signal death (exit 137): the arbiter abstains, no verdict.
  const plain = await run(t, claim(fx, poc));
  assert.equal(plain.outcome, 'abstain', show(plain));
  assert.equal(plain.abstain.step, 'poc:1');
});

test('protected-file-modified-at-runtime (forge form): an ffi child rewrites foundry.toml during run 1; forge itself refuses the file cheatcode form', { timeout: TIMEOUT }, async (t) => {
  // forge 1.8.5 refuses vm.writeFile on foundry.toml whatever fs_permissions say: the attempt errors, and is flagged.
  const plain = await fixture();
  const toml = `${FOUNDRY_TOML(PLAIN_TOML)}ffi = true\n`;
  const cheat = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      '    /// forge-config: default.fs_permissions = [{ access = "read-write", path = "./" }]',
      `    function ${NAME}() public { vm.writeFile("foundry.toml", ${sol(toml)}); Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
    ])
  });
  const c = await run(t, claim(plain, cheat));
  assert.equal(c.outcome, 'definitive', show(c));
  assert.equal(c.gates.reproduces.status, 'fail', show(c));
  assert.equal(c.facts.poc.tests[0].kind, 'error', 'the refused cheatcode is an error, not an assertion');
  assert.equal(c.gates.integrity.status, 'fail');
  assert.equal(c.facts.poc.integrity.protectedPathsUnchanged, true, 'forge left foundry.toml alone');
  assert.ok(c.facts.poc.integrity.tamperFlags.some((f) => f.kind === 'framework-patched'), JSON.stringify(c.facts.poc.integrity.tamperFlags));

  // ffi (enabled by the maker) has no such guard: the child appends to foundry.toml, which later runs would load.
  const fx = await fixture('ffi');
  const poc = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      `    function ${NAME}() public { ${ffiSh("printf 'optimizer = true\\n' >> foundry.toml")} Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
    ])
  });
  const r = await run(t, claim(fx, poc));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.integrity.status, 'fail', show(r));
  assert.equal(r.facts.poc.integrity.protectedPathsUnchanged, false);
  assert.equal(r.facts.poc.integrity.frameworkUnchanged, false, 'forge\'s resolved configuration changed with it');
  assert.match(r.gates.integrity.detail, /protectedPathsUnchanged \(run 1: foundry\.toml changed/);
  assert.match(r.gates.integrity.detail, /forge's resolved configuration changed/);
  assert.deepEqual(r.facts.poc.tests[0].runs, ['fail', 'fail', 'fail'], 'the JUnit alone would have reproduced');
  assert.equal(r.gates.reproduces.status, 'fail');
  assert.equal(r.gates.reproduces.basis, 'integrity');
});

test('reporter-monkeypatched (forge form): a PoC rewrites forge-std\'s source with a file cheatcode during run 1', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const poc = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      '    /// forge-config: default.fs_permissions = [{ access = "read-write", path = "./lib" }]',
      `    function ${NAME}() public { vm.writeFile("lib/forge-std/src/Test.sol", ${sol(`${FORGE_STD}// patched\n`)}); Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
    ])
  });
  const r = await run(t, claim(fx, poc));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.integrity.status, 'fail', show(r));
  assert.ok(r.facts.poc.integrity.tamperFlags.some((f) => f.kind === 'reporter-patched'), JSON.stringify(r.facts.poc.integrity.tamperFlags));
  assert.equal(r.facts.poc.integrity.frameworkUnchanged, false, 'the post-run checksum of the reporter module');
  assert.equal(r.facts.poc.integrity.dependenciesUnchanged, false);
  assert.match(r.gates.integrity.detail, /run 1: lib\/forge-std\/src\/Test\.sol changed/);
});

test('dependencies-edited-during-run (forge form): an ffi child edits an untracked lib/ dependency during run 2', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('ffi');
  const count = 'n=$(cat state/n 2>/dev/null || echo 0); n=$((n+1)); echo $n > state/n; if [ $n -eq 2 ]; then echo "// drained" >> lib/solady/src/Solady.sol; fi';
  const poc = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      `    function ${NAME}() public { ${ffiSh(count)} Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
    ])
  });
  const r = await run(t, claim(fx, poc));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.integrity.status, 'fail', show(r));
  assert.equal(r.facts.poc.integrity.dependenciesUnchanged, false);
  assert.match(r.gates.integrity.detail, /dependenciesUnchanged \(run 2: lib\/solady\/src\/Solady\.sol changed/);
  assert.deepEqual(r.facts.poc.tests[0].runs, ['fail', 'fail', 'fail'], 'the JUnit alone would have reproduced');
  assert.deepEqual(r.facts.poc.integrity.tamperFlags, [], 'measured, not predicted: no static flag caught this one');
});

test('test-report-missing-identity (forge form): the PoC skips itself on runs 2 and 3 (vm.skip after a state file)', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const poc = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      `    function ${NAME}() public { if (vm.isFile("state/ran")) vm.skip(true); vm.writeFile("state/ran", "1"); Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
    ])
  });
  const r = await run(t, claim(fx, poc));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.facts.poc.integrity.identityComplete, false, show(r));
  assert.match(r.gates.integrity.detail, /identityComplete \(run 2: test\/Exploit\.t\.sol > ExploitTest > test_deposit_credits_exactly\(\) is skipped/);
  assert.deepEqual(r.facts.poc.tests[0].runs, ['fail', 'skip', 'skip']);
  assert.equal(r.gates.reproduces.status, 'fail');
  // forge's own summary and exit code agree with the skip: only identity completeness fails.
  assert.equal(r.facts.poc.integrity.summaryConsistent, true);
  assert.equal(r.facts.poc.integrity.exitConsistent, true);
});

test('test-report-duplicate-identity (forge form): an ffi child forges a summary-consistent JUnit carrying the PoC twice, and the maker\'s command masks forge\'s death', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('ffi');
  const forged = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="Test run" tests="2" skipped="0" failures="1" errors="0">',
    '<testsuite name="test/Exploit.t.sol:ExploitTest" tests="2" skipped="0" errors="0" failures="1">',
    '<testcase name="test_dup()"><failure message="vault drained"/><system-out>[FAIL: vault drained] test_dup() (gas: 3266)</system-out></testcase>',
    '<testcase name="test_dup()"><system-out>[PASS] test_dup() (gas: 143)</system-out></testcase>',
    '<system-out>Suite result: FAILED. 1 passed; 1 failed; 0 skipped; finished in 1.00ms (1.00ms CPU time)</system-out>',
    '</testsuite></testsuites>'
  ].join('');
  const poc = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [`    function test_dup() public { ${ffiSh(`printf '%s\\n' '${forged}' > /proc/$PPID/fd/1; kill -9 $PPID`)} }`])
  });
  // A wrapper that keeps forge's 0 and 1 and turns a signal death into 1.
  const r = await run(t, claim(fx, poc, {
    commands: {
      testFiles: 'sh -c \'forge test --match-path "$0" "$@" || exit 1\' $FILES',
      testIds: 'sh -c \'forge test --match-test "$0" "$@" || exit 1\' $TEST_IDS'
    }
  }));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.integrity.status, 'fail', show(r));
  assert.equal(r.gates.reproduces.status, 'fail');
  if (r.facts.poc.runs[0].junit === 'ok') {
    assert.equal(r.facts.poc.integrity.identityComplete, false);
    assert.match(r.gates.integrity.detail, /run 1: test\/Exploit\.t\.sol > ExploitTest > test_dup\(\) has 2 records/);
    assert.equal(r.facts.poc.integrity.summaryConsistent, true, 'a careful forgery passes the summary check: identity is what refuses it');
    assert.equal(r.facts.poc.integrity.exitConsistent, true);
    assert.equal(r.facts.poc.tests[0].runs[0], 'duplicate');
  } else {
    assert.notEqual(RUNTIME, 'runc', `${JSON.stringify(r.facts.poc.runs[0])} ${(r.steps.find((s) => s.name === 'poc:1') || {}).stdout ? r.steps.find((s) => s.name === 'poc:1').stdout.text.slice(0, 2000) : ''}`);
  }
});

test('claimed-observable-mismatch (forge form): finding.json names another test, or quotes an observable forge did not record', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const poc = addFilesPatch({ 'test/Exploit.t.sol': DRAIN });
  for (const [poc2, status, re] of [
    [{ command: 'forge test --match-test test_deposit', observable: 'test_deposit fails with "2 != 1"' }, 'fail', /names test_deposit, which is not a test the patch added that failed/],
    [{ observable: `${NAME} fails with "vault emptied"` }, 'fail', /"vault emptied" is not in the recorded failure/],
    [{}, 'pass', new RegExp(NAME)]
  ]) {
    const r = await run(t, claim(fx, poc, { finding: finding(poc2) }));
    assert.equal(r.gates.reproduces.status, 'pass', show(r));
    assert.equal(r.gates.claimedObservable.status, status, show(r));
    assert.match(r.gates.claimedObservable.detail, re);
  }
});

// ------------------------------------------------------------------ the fix check

test('fix check under real forge: a fix that verifies, one whose PoC still fails, and one that breaks a stable test (regression); the claim\'s gates never move', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const vault = VAULT_REPO['src/Vault.sol'];
  const poc = addFilesPatch({ 'test/Exploit.t.sol': DRAIN });
  const cases = [
    [modifyPatch('src/Vault.sol', vault, vault.replace('amount + 1', 'amount')), { pocPasses: true, regressions: [] }],
    [modifyPatch('src/Vault.sol', vault, vault.replace('contract Vault {', '// a comment, not a fix\ncontract Vault {')), { pocPasses: false, regressions: [] }],
    [modifyPatch('src/Vault.sol', vault, vault.replace('amount + 1', '0')), { pocPasses: false, regressions: ['test/Vault.t.sol > VaultTest > test_deposit()'] }]
  ];
  for (const [fixPatch, want] of cases) {
    const r = await run(t, claim(fx, poc, { fixPatch }));
    assert.equal(r.outcome, 'definitive', show(r));
    for (const g of ['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable']) assert.equal(r.gates[g].status, 'pass', `${g}: ${show(r)}`);
    const f = r.facts.fix;
    assert.equal(f.present, true);
    assert.equal(f.applies, 'pass', JSON.stringify(f.detail));
    assert.equal(f.builds, 'pass', JSON.stringify(f.detail));
    assert.equal(f.pocPasses, want.pocPasses, JSON.stringify(f.suite));
    assert.deepEqual(f.regressions, want.regressions);
    assert.equal(f.regressionCount, want.regressions.length);
    assert.deepEqual(f.integrity, CLEAN, JSON.stringify(r.facts.integrity.fix));
    assert.ok(r.steps.some((s) => s.name === 'fix:suite'));
  }
  // A fix that edits a test does not apply; the fixed tree is never built.
  const touchesTest = modifyPatch('test/Vault.t.sol', VAULT_REPO['test/Vault.t.sol'], VAULT_REPO['test/Vault.t.sol'].replace('"no credit"', '"none"'));
  const r = await run(t, claim(fx, poc, { fixPatch: touchesTest }));
  assert.equal(r.facts.fix.applies, 'fail', show(r));
  assert.equal(r.facts.fix.builds, 'not-run');
  assert.match(r.facts.fix.detail.applies, /test\/Vault\.t\.sol under paths\.tests/);
});
