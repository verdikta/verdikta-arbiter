'use strict';

// Node A2a against real forge (the base pinned in @verdikta/common, v1.8.5):
// the patch gates, the build, the PoC on the fixed schedule and the
// reproduces gate, on fixture Foundry repositories built locally as env
// images (forgeFixture.js). Under runc locally; CI runs this file under runc
// and under gVisor (runsc). Every container and image is removed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { executeRun } = require('../../src/pipeline');
const { checkSpec } = require('../../src/classLimits');
const { claimSteps } = require('../../src/steps');
const { encodeBase85Line } = require('../../src/patch');
const { FORGE_FUZZ_SEED } = require('../../src/common');
const { runText } = require('../../src/docker');
const { RUNTIME, silent, instanceId, dockerTestConfig, dockerFor, leftovers, removeAll } = require('./helpers');
const { VAULT_REPO, vaultBaseline, buildFixture, addFilesPatch, modifyPatch, pocFile } = require('./forgeFixture');

const TIMEOUT = 900000;
const fixtures = new Map();
const builder = dockerFor(dockerTestConfig());

/** The fixture image for a foundry.toml variant, built once per file. */
function fixture(variant = 'plain') {
  if (!fixtures.has(variant)) {
    const toml = {
      plain: 'fs_permissions = [{ access = "read-write", path = "./state" }]',
      ffi: 'ffi = true'
    }[variant];
    fixtures.set(variant, buildFixture(builder, { toml, instance: `${instanceId()}${variant}` }));
  }
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
      framework: 'forge',
      build: 'forge build',
      test: 'forge test',
      testFiles: 'forge test --match-path $FILES',
      testIds: 'forge test --match-test $TEST_IDS',
      ...(over.commands || {})
    },
    paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.gitignore'] },
    limits: { cpus: 1, memoryMb: 1024, buildSeconds: 90, testSeconds: 120, runSeconds: 360, maxPatchBytes: 2000000, ...(over.limits || {}) }
  };
}

function claim(fx, pocPatch, over = {}) {
  return {
    listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    bcid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    spec: claimSpec(fx, over),
    attestation: {},
    pocPatch,
    fixPatch: null,
    baseline: vaultBaseline(fx.baseCommit),
    finding: {},
    report: '',
    knownIssues: [],
    priorFindings: [],
    eaGates: { disclosure: 'pass', inScope: 'pass' },
    deadlineMs: 800000
  };
}

async function run(t, request, extraSteps = []) {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance).catch(() => {}));
  const lim = checkSpec(request.spec);
  assert.ok(lim.ok, JSON.stringify(lim.issues));
  const receivedAt = Date.now();
  const result = await executeRun({
    docker, config, limits: lim.limits, image: request.spec.env.image, runId: crypto.randomBytes(8).toString('hex'),
    steps: [...claimSteps(request, lim.limits), ...extraSteps], receivedAt, deadlineAt: receivedAt + request.deadlineMs,
    active: new Set(), log: silent
  });
  assert.deepEqual(await leftovers(docker, config.instance), [], 'the run removed its sandbox');
  return { result, docker };
}

const stepNames = (r) => r.steps.map((s) => s.name);
const show = (r) => JSON.stringify({ outcome: r.outcome, abstain: r.abstain, issues: r.issues, gates: r.gates }, null, 1);

/** The vault's bug: a deposit credits one wei too many. A PoC that asserts the right credit fails as an assertion. */
const DRAIN = pocFile('ExploitTest', [
  '    function test_deposit_credits_exactly() public { Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }'
]);

test('a PoC that fails as an assertion on all three runs reproduces, on the pinned foundry base; the commit is fixed', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const inspected = {};
  const inspect = async (ctx) => {
    const sh = async (name, script) => (await ctx.exec(['sh', '-c', script], { name, timeoutMs: 60000 })).stdout.text;
    inspected.commit = await sh('inspect:commit', 'git log -1 --date=raw --format="%an|%ae|%ad|%cn|%ce|%cd|%P|%s" && git diff --name-only HEAD^ HEAD');
    inspected.env = await sh('inspect:env', 'printf "%s|%s|%s|%s|%s" "$TZ" "$LANG" "$CI" "$(hostname)" "$HOME"');
    const host = await runText(builder, ['inspect', '--type', 'container', '--format', '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.Config.Hostname}}', ctx.sandboxName], { timeoutMs: 30000 });
    inspected.host = host.stdout.trim();
  };
  const request = claim(fx, addFilesPatch({ 'test/Exploit.t.sol': DRAIN }));
  const { result: r } = await run(t, request, [inspect]);
  assert.equal(r.outcome, 'definitive', show(r));
  for (const g of ['applies', 'testPathsOnly', 'build', 'reproduces']) assert.equal(r.gates[g].status, 'pass', `${g}: ${show(r)}`);
  assert.deepEqual(r.facts.poc.tests, [{
    id: 'test/Exploit.t.sol > ExploitTest > test_deposit_credits_exactly()',
    runs: ['fail', 'fail', 'fail'],
    kind: 'assertion',
    message: 'assertion failed: 2 != 1'
  }]);
  assert.deepEqual(r.facts.poc.runs.map((x) => [x.command, x.junit]), [['testFiles', 'ok'], ['testIds', 'ok'], ['testIds', 'ok']]);
  const names = stepNames(r);
  for (const n of ['poc:1', 'poc:2', 'poc:3']) assert.ok(names.includes(n), n);
  const poc1 = r.steps.find((s) => s.name === 'poc:1');
  assert.match(poc1.stdout.text, /<testsuites /, 'forge printed its JUnit');
  // Committed with a fixed author and date, on the listed commit.
  const [meta, changed] = inspected.commit.trim().split('\n');
  assert.equal(meta, `Verdikta code runner|code-runner@verdikta.invalid|1767225600 +0000|Verdikta code runner|code-runner@verdikta.invalid|1767225600 +0000|${fx.baseCommit}|poc.patch`);
  assert.equal(changed, 'test/Exploit.t.sol');
  assert.equal(r.facts.commit.base, fx.baseCommit);
  // The fixed environment: TZ, LANG, CI, the hostname, CPU and memory from the spec.
  assert.equal(inspected.env, 'UTC|C.UTF-8|true|sandbox|/home/sandbox');
  assert.equal(inspected.host, `${1e9} ${1024 * 1024 * 1024} sandbox`);
  assert.deepEqual(r.facts.leftoverProcesses.map((x) => x.killed), [0, 0, 0, 0]);

  // The same claim again: the same commit, gates and facts (the commit hash is
  // fixed by the author, the date and the tree).
  const again = await run(t, request);
  assert.equal(again.result.facts.commit.poc, r.facts.commit.poc);
  assert.deepEqual(again.result.gates, r.gates);
  assert.deepEqual(again.result.facts.poc, r.facts.poc);
});

test('poc-patch-edits-source: a patch that edits src/ fails testPathsOnly, decided by git inside the sandbox before the build', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const vault = VAULT_REPO['src/Vault.sol'];
  const vaultTest = VAULT_REPO['test/Vault.t.sol'];
  const patch = Buffer.concat([
    modifyPatch('src/Vault.sol', vault, vault.replace('amount + 1', 'amount')),
    modifyPatch('test/Vault.t.sol', vaultTest, vaultTest.replace('    function test_deposit()', '    function test_more() public { revert("x"); }\n    function test_deposit()')),
    addFilesPatch({ 'test/Exploit.t.sol': pocFile('ExploitTest', ['    /// forge-config: default.fuzz.runs = 1', '    function test_x() public { vm.skip(true); }']) })
  ]);
  const { result: r } = await run(t, claim(fx, patch));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.applies.status, 'pass', show(r));
  assert.equal(r.gates.testPathsOnly.status, 'fail');
  assert.match(r.gates.testPathsOnly.detail, /src\/Vault\.sol.*outside paths\.tests/);
  assert.deepEqual(r.facts.testPaths.outside, ['src/Vault.sol']);
  assert.ok(!stepNames(r).includes('build'), 'nothing ran after the gate');
  assert.equal(r.gates.build, undefined);
  // The flags, from git's own diff of the applied patch.
  assert.deepEqual(r.facts.flags.existingTestsModified, ['test/Vault.t.sol']);
  assert.deepEqual(r.facts.flags.skipMarkersAdded, ['test/Exploit.t.sol']);
  assert.deepEqual(r.facts.flags.frameworkReferences, [{ file: 'test/Exploit.t.sol', line: 6, rule: 'forge-inline-config' }]);

  // A patch to a protected path fails too.
  const toml = await run(t, claim(fx, Buffer.concat([
    addFilesPatch({ 'test/Exploit.t.sol': DRAIN }),
    modifyPatch('.gitignore', VAULT_REPO['.gitignore'], `${VAULT_REPO['.gitignore']}src/\n`)
  ])));
  assert.equal(toml.result.gates.testPathsOnly.status, 'fail', show(toml.result));
  assert.match(toml.result.gates.testPathsOnly.detail, /\.gitignore.*paths\.protected/);
});

function binaryPatch(file, bytes) {
  const blob = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
  const z = zlib.deflateSync(bytes);
  const lines = [];
  for (let i = 0; i < z.length; i += 52) lines.push(encodeBase85Line(z.subarray(i, i + 52)));
  return Buffer.from([
    `diff --git a/${file} b/${file}`, 'new file mode 100644', `index 0000000000000000000000000000000000000000..${blob}`,
    'GIT binary patch', `literal ${bytes.length}`, ...lines, '', 'literal 0', 'HcmV?d00001', '', ''
  ].join('\n'));
}

test('applies with real git: a patch that does not apply, one above maxPatchBytes, an expansion bomb; binary changes as stats only', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const stale = modifyPatch('test/Vault.t.sol', VAULT_REPO['test/Vault.t.sol'].replace('no credit', 'other text'), VAULT_REPO['test/Vault.t.sol']);
  const { result: r1 } = await run(t, claim(fx, stale));
  assert.equal(r1.gates.applies.status, 'fail', show(r1));
  assert.equal(r1.gates.applies.basis, 'exit_code');
  assert.match(r1.gates.applies.detail, /does not apply to the listed commit/);

  const small = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': DRAIN }), { limits: { maxPatchBytes: 200 } }));
  assert.equal(small.result.gates.applies.status, 'fail', show(small.result));
  assert.equal(small.result.gates.applies.basis, 'input');
  assert.ok(!stepNames(small.result).some((n) => n.startsWith('patch:')), 'git never saw it');

  const bomb = Buffer.from([
    'diff --git a/test/b.bin b/test/b.bin', 'new file mode 100644', `index 0000000000000000000000000000000000000000..${'1'.repeat(40)}`,
    'GIT binary patch', 'literal 60000000', 'zcmeIuF#!Mo0K%a4Pi+Q3h&OqVfB^#r3>YwAz<>b*1`HT5V8DO@0|pEjFkrxd', '', 'literal 0', 'HcmV?d00001', '', ''
  ].join('\n'));
  const big = await run(t, claim(fx, bomb));
  assert.equal(big.result.gates.applies.status, 'fail', show(big.result));
  assert.match(big.result.gates.applies.detail, /50000000/);

  const withBinary = Buffer.concat([addFilesPatch({ 'test/Exploit.t.sol': DRAIN }), binaryPatch('test/fixture.bin', crypto.randomBytes(300))]);
  const { result: r4 } = await run(t, claim(fx, withBinary));
  assert.equal(r4.gates.applies.status, 'pass', show(r4));
  assert.equal(r4.gates.reproduces.status, 'pass', show(r4));
  assert.equal(r4.facts.diff.binaryFiles, 1);
  assert.equal(r4.facts.diff.files, 2);
  assert.equal(r4.facts.patch.binaryHunks, 1);
});

test('build gate: a PoC that does not compile fails the build (tier A); an OOM-killed build abstains', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const broken = addFilesPatch({ 'test/Exploit.t.sol': DRAIN.replace('import {Vault} from "../src/Vault.sol";', 'import {Vault} from "../src/Missing.sol";') });
  const { result: r } = await run(t, claim(fx, broken));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(r.gates.build, { status: 'fail', basis: 'exit_code', detail: 'the build command exited 1' });
  assert.ok(!stepNames(r).includes('poc:1'));

  const oom = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': DRAIN }), {
    commands: { build: 'forge build && dd if=/dev/zero of=/dev/null bs=768M count=1' },
    limits: { memoryMb: 512 }
  }));
  assert.equal(oom.result.outcome, 'abstain', show(oom.result));
  assert.equal(oom.result.abstain.cause, 'oom');
  assert.equal(oom.result.abstain.step, 'build');
  assert.equal(oom.result.gates.build, undefined, 'no gate from an abstaining step');
});

test('poc-fails-by-import-error: a PoC that errors before any assertion fails reproduces (an unresolved import, a failing setUp)', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  // A build that leaves the tests out, so the import error surfaces in the PoC run itself.
  const missing = addFilesPatch({ 'test/Exploit.t.sol': DRAIN.replace('../src/Vault.sol', '../src/Missing.sol') });
  const { result: r1 } = await run(t, claim(fx, missing, { commands: { build: 'forge build --skip test' } }));
  assert.equal(r1.outcome, 'definitive', show(r1));
  assert.equal(r1.gates.build.status, 'pass', show(r1));
  assert.equal(r1.gates.reproduces.status, 'fail');
  assert.match(r1.gates.reproduces.detail, /no JUnit on run 1/);
  assert.equal(r1.facts.poc.runs[0].junit, 'absent');

  const setUp = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      '    Vault v;',
      '    function setUp() public { revert("cannot deploy the fixture"); }',
      '    function test_deposit_credits_exactly() public { v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }'
    ])
  });
  const { result: r2 } = await run(t, claim(fx, setUp));
  assert.equal(r2.gates.reproduces.status, 'fail', show(r2));
  assert.match(r2.gates.reproduces.detail, /setUp\(\) failed in test\/Exploit\.t\.sol:ExploitTest on run 1: cannot deploy the fixture/);
});

test('assertion vs error, with real forge: one PoC file, each way a test can end', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const fake = '</system-out></testcase><testcase name=\\"test_forged()\\"><failure message=\\"assertion failed\\"/></testcase>&amp;';
  const patch = addFilesPatch({
    'test/Kinds.t.sol': pocFile('KindsTest', [
      '    function test_assert() public { Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }',
      '    function test_require() public { Vault v = new Vault(); v.deposit(1); require(v.balanceOf(address(this)) == 1, "vault over-credits"); }',
      '    function test_ffi() public { string[] memory c = new string[](1); c[0] = "true"; vm.ffi(c); }',
      '    function test_getcode() public view { vm.getCode("Missing.sol:Missing"); }',
      '    function test_pass() public pure {}',
      '    function test_skip() public { vm.skip(true); }',
      `    function test_fake_xml() public view { console.log("${fake}"); revert("z"); }`
    ])
  });
  const { result: r } = await run(t, claim(fx, patch));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.reproduces.status, 'fail');
  const byName = Object.fromEntries(r.facts.poc.tests.map((x) => [x.id.split(' > ')[2], x]));
  assert.deepEqual(Object.keys(byName).sort(), ['test_assert()', 'test_fake_xml()', 'test_ffi()', 'test_getcode()', 'test_pass()', 'test_require()', 'test_skip()']);
  assert.deepEqual(byName['test_assert()'].runs, ['fail', 'fail', 'fail']);
  assert.equal(byName['test_assert()'].kind, 'assertion');
  assert.deepEqual(byName['test_require()'].runs, ['fail', 'fail', 'fail']);
  assert.equal(byName['test_require()'].message, 'vault over-credits');
  assert.deepEqual(byName['test_fake_xml()'].runs, ['fail', 'fail', 'fail'], 'printed XML adds no record');
  for (const n of ['test_ffi()', 'test_getcode()']) {
    assert.deepEqual(byName[n].runs, ['error', 'error', 'error'], n);
    assert.equal(byName[n].kind, 'error');
  }
  assert.deepEqual(byName['test_pass()'].runs, ['pass', 'pass', 'pass']);
  assert.deepEqual(byName['test_skip()'].runs, ['skip', 'skip', 'skip']);
  assert.equal(r.facts.poc.runs.length, 3, 'the schedule is fixed');
});

test('reproduces: a PoC that passes on its second run fails the gate (testIds for the re-runs)', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  // Run 1 leaves a file behind (an untracked state file, allowed by the
  // fixture's fs_permissions); runs 2 and 3 see it and pass.
  const flaky = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      '    function test_flaky() public {',
      '        if (!vm.isFile("state/ran")) { vm.writeFile("state/ran", "1"); vm.assertEq(uint256(1), uint256(2)); }',
      '    }'
    ])
  });
  const { result: r } = await run(t, claim(fx, flaky));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.reproduces.status, 'fail');
  assert.equal(r.gates.reproduces.detail, 'test/Exploit.t.sol > ExploitTest > test_flaky() passed on run 2');
  assert.deepEqual(r.facts.poc.tests[0].runs, ['fail', 'pass', 'pass']);
  assert.deepEqual(r.facts.poc.runs.map((x) => x.command), ['testFiles', 'testIds', 'testIds']);
});

test('a claim process that outlives its run is killed before the next one; bytes a test writes to forge\'s stdout make the JUnit unreadable', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('ffi');
  const procs = {};
  const listProcs = async (ctx) => {
    procs.after = (await ctx.exec(['sh', '-c', 'for d in /proc/[0-9]*; do read -r s < "$d/stat" 2>/dev/null && echo "$s"; done'], { name: 'inspect:procs', timeoutMs: 60000 })).stdout.text;
  };
  const spawn = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      '    function test_spawn() public {',
      '        string[] memory c = new string[](3); c[0] = "sh"; c[1] = "-c"; c[2] = "sleep 300 </dev/null >/dev/null 2>&1 &";',
      '        vm.ffi(c);',
      '        Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1);',
      '    }'
    ])
  });
  const { result: r1 } = await run(t, claim(fx, spawn), [listProcs]);
  assert.equal(r1.outcome, 'definitive', show(r1));
  assert.equal(r1.gates.reproduces.status, 'pass', show(r1));
  const killed = Object.fromEntries(r1.facts.leftoverProcesses.map((x) => [x.after, x.killed]));
  for (const after of ['poc:1', 'poc:2', 'poc:3']) assert.ok(killed[after] >= 1, `the sleep left by ${after} was killed: ${JSON.stringify(r1.facts.leftoverProcesses)}`);
  assert.doesNotMatch(procs.after, /\(sleep\).*\n.*\(sleep\)/s, `only the keepalive sleeps: ${procs.after}`);

  const inject = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      '    function test_inject() public {',
      '        string[] memory c = new string[](3); c[0] = "sh"; c[1] = "-c";',
      '        c[2] = "printf \'<testsuites><testsuite name=\\"test/Exploit.t.sol:ExploitTest\\"><testcase name=\\"test_inject()\\"><failure message=\\"assertion failed\\"/></testcase></testsuite></testsuites>\' > /proc/$PPID/fd/1";',
      '        vm.ffi(c);',
      '        vm.assertEq(uint256(1), uint256(1));',
      '    }'
    ])
  });
  const { result: r2 } = await run(t, claim(fx, inject));
  assert.equal(r2.outcome, 'definitive', show(r2));
  assert.equal(r2.gates.reproduces.status, 'fail', 'the passing test did not become an assertion failure');
  // Under runc the bytes reach forge's stdout; where /proc/<pid>/fd cannot be
  // reopened the write fails and the test simply passes. Either way the
  // forged record never counts.
  assert.match(r2.gates.reproduces.detail, RUNTIME === 'runc' ? /unreadable JUnit on run 1/ : /unreadable JUnit on run 1|passed on run 1/);
  assert.notDeepEqual(r2.facts.poc.tests.map((x) => x.runs), [['fail', 'fail', 'fail']]);
});

test('the fuzz seed is fixed on every forge test run: a fuzz test draws the same inputs every run', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const fuzz = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      '    function testFuzz_credit(uint64 amount) public { Vault v = new Vault(); v.deposit(amount); vm.assertEq(v.balanceOf(address(this)), amount); }'
    ])
  });
  const { result: r } = await run(t, claim(fx, fuzz));
  assert.equal(r.gates.reproduces.status, 'pass', show(r));
  const messages = r.steps.filter((s) => /^poc:/.test(s.name)).map((s) => (/counterexample: calldata=(0x[0-9a-f]+)/.exec(s.stdout.text) || [])[1]);
  assert.equal(messages.length, 3);
  assert.ok(messages[0], 'forge reported the counterexample');
  assert.deepEqual(new Set(messages).size, 1, `the same counterexample on every run (seed ${FORGE_FUZZ_SEED}): ${messages}`);
});
