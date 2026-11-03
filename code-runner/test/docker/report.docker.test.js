'use strict';

// Node A3b against real forge (the base pinned in @verdikta/common, v1.8.5):
// the same claim in two containers with different clocks, hostnames and run
// directories, on a fast and a slow CPU schedule, gives the identical verdict,
// report hash and pack hash. Under runc locally (linux/arm64 on Apple silicon,
// where the report is built through the same function with the class platform
// named, since the schema's platform is a constant); CI runs this file under
// runc and under the pinned gVisor on amd64. Cross-host: G2.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { codeReview } = require('@verdikta/common');
const { executeRun } = require('../../src/pipeline');
const { checkSpec } = require('../../src/classLimits');
const { claimSteps } = require('../../src/steps');
const { buildReport } = require('../../src/report');
const { RUNTIME, silent, instanceId, dockerTestConfig, dockerFor, leftovers, removeAll } = require('./helpers');
const { VAULT_REPO, VM_SOL, vaultBaseline, buildFixture, addFilesPatch, pocFile } = require('./forgeFixture');

const TIMEOUT = 900000;
const builder = dockerFor(dockerTestConfig());
const fixtures = new Map();

const VM = VM_SOL.replace('    function assume(bool c) external pure;', [
  '    function assume(bool c) external pure;',
  '    function unixTime() external view returns (uint256);',
  '    function randomUint() external returns (uint256);',
  '    function toString(uint256 v) external pure returns (string memory);'
].join('\n'));

const VARIANTS = Object.freeze({
  plain: { toml: 'fs_permissions = [{ access = "read-write", path = "./state" }]' },
  ffi: { toml: 'ffi = true' }
});

function fixture(variant) {
  if (!fixtures.has(variant)) {
    fixtures.set(variant, buildFixture(builder, { files: { ...VAULT_REPO, 'test/Vm.sol': VM }, instance: instanceId(), ...VARIANTS[variant] }));
  }
  return fixtures.get(variant);
}

test.after(async () => {
  for (const f of fixtures.values()) await (await f).remove().catch(() => {});
});

function claim(fx, files, over = {}) {
  const spec = {
    version: 1, kind: 'bug', repo: 'https://github.com/acme/vault', baseCommit: fx.baseCommit,
    env: { image: fx.image, from: 'foundry', platform: 'linux/amd64', unpackedBytes: 2000000000 },
    attestation: 'attestation.json',
    commands: { framework: 'forge', build: 'forge build', test: 'forge test', testFiles: 'forge test --match-path $FILES', testIds: 'forge test --match-test $TEST_IDS' },
    paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.gitignore'] },
    limits: { cpus: 1, memoryMb: 1024, buildSeconds: 90, testSeconds: 120, runSeconds: 360, maxPatchBytes: 2000000 }
  };
  return {
    listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    bcid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    spec, attestation: { version: 1, env: spec.env }, pocPatch: addFilesPatch(files), fixPatch: null,
    baseline: vaultBaseline(fx.baseCommit),
    finding: {
      version: 1, claimedClass: 'HIGH', rootCause: 'Vault.deposit credits one wei more than it receives.', affectedPaths: ['src/Vault.sol'],
      poc: { command: 'forge test', observable: 'the test fails at the committed hash' }
    },
    report: '# A report\n', knownIssues: [], priorFindings: [], eaGates: { disclosure: 'pass', inScope: 'pass' }, deadlineMs: 800000,
    ...over
  };
}

/** One "host": a container with its own hostname and CPU schedule. The runner forces --hostname; a host's own is only ever the host's. */
async function host(t, request, { hostname = null, cpus = null } = {}) {
  const config = dockerTestConfig();
  const real = dockerFor(config);
  t.after(() => removeAll(real, config.instance).catch(() => {}));
  const docker = {
    ...real,
    run: (args, o) => {
      if (args[0] !== 'create') return real.run(args, o);
      const a = [...args];
      if (hostname) a[a.indexOf('--hostname') + 1] = hostname;
      if (cpus) a[a.indexOf('--cpus') + 1] = cpus;
      return real.run(a, o);
    }
  };
  const lim = checkSpec(request.spec);
  assert.ok(lim.ok, JSON.stringify(lim.issues));
  const receivedAt = Date.now();
  const result = await executeRun({
    docker, config, limits: lim.limits, image: request.spec.env.image, runId: crypto.randomBytes(8).toString('hex'),
    steps: claimSteps(request, lim.limits), receivedAt, deadlineAt: receivedAt + request.deadlineMs, active: new Set(), log: silent
  });
  assert.deepEqual(await leftovers(real, config.instance), [], 'the run removed its sandbox');
  assert.equal(result.outcome, 'definitive', JSON.stringify({ abstain: result.abstain, issues: result.issues, gates: result.gates }));
  // R4 on the real runtime: what was measured.
  assert.equal(result.gvisor, RUNTIME === 'runsc' ? codeReview.GVISOR_RELEASE : 'runc');
  const built = buildReport(result, request, { gvisor: result.gvisor, platform: 'linux/amd64' });
  assert.equal(codeReview.validateClaimReport(built.report).ok, true);
  const ms = Date.now() - receivedAt;
  // What the pack's reads cost, which the listing check's limits do not measure.
  const packMs = result.steps.filter((s) => s.name.startsWith('pack:')).reduce((n, s) => n + s.durationMs, 0);
  t.diagnostic(`${hostname || 'sandbox'} cpus=${cpus || request.spec.limits.cpus}: ${ms} ms in all, the pack's reads ${packMs} ms`);
  return { result, ...built, ms };
}

const gatesOf = (r) => Object.fromEntries(Object.entries(r.gates).map(([k, v]) => [k, v.status]));

/** Two hosts: other clocks (they run one after the other, at least a second apart), another hostname, another CPU schedule. */
async function twoHosts(t, request) {
  const a = await host(t, request);
  await new Promise((r) => setTimeout(r, 1100));
  const b = await host(t, request, { hostname: 'another-host', cpus: '0.25' });
  assert.deepEqual(gatesOf(a.result), gatesOf(b.result), 'the same verdict');
  assert.equal(a.sha256, b.sha256, 'the same report hash');
  assert.equal(a.result.contextPack.sha256, b.result.contextPack.sha256, 'the same pack hash');
  return [a, b];
}

const TIME_POC = pocFile('ClockTest', [
  '    function test_reads_the_clock() public { require(false, vm.toString(vm.unixTime())); }',
  '    function test_deposit_credits_exactly() public { Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }'
]);

test('time-dependent-poc-two-hosts: a test that reads the clock, in two containers with different clocks, hostnames and CPU schedules, gives the identical verdict and report hash', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('plain');
  const [a, b] = await twoHosts(t, claim(fx, { 'test/Clock.t.sol': TIME_POC }));
  const raw = (h) => h.result.facts.poc.tests.find((x) => x.id.includes('reads_the_clock')).message;
  assert.notEqual(raw(a), raw(b), 'forge printed different clocks');
  const reported = (h, name) => h.report.poc.tests.find((x) => x.id.includes(name));
  assert.equal(reported(a, 'reads_the_clock').message, null, 'moved between runs: not in the report');
  assert.deepEqual(reported(a, 'reads_the_clock').runs, ['fail', 'fail', 'fail']);
  assert.equal(reported(a, 'credits_exactly').message, 'assertion failed: 2 != 1', 'a stable message stays');
  assert.equal(a.result.gates.reproduces.status, 'pass');
});

const RANDOM_POC = pocFile('RandomTest', [
  '    function sh(string memory c) internal returns (string memory) { string[] memory a = new string[](3); a[0] = "/bin/sh"; a[1] = "-c"; a[2] = c; return string(vm.ffi(a)); }',
  '    function test_unseeded_random() public { require(false, sh("od -An -N8 -tx8 /dev/urandom")); }',
  '    function test_run_directory() public { require(false, sh("mktemp -d")); }',
  '    function test_seeded_random() public { require(false, vm.toString(vm.randomUint())); }'
]);

test('randomness-dependent-poc-two-hosts: a test that uses an unseeded RNG and a per-run directory, in two containers, gives the identical verdict and report hash', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('ffi');
  const [a, b] = await twoHosts(t, claim(fx, { 'test/Random.t.sol': RANDOM_POC }));
  const raw = (h, name) => h.result.facts.poc.tests.find((x) => x.id.includes(name)).message;
  assert.notEqual(raw(a, 'unseeded_random'), raw(b, 'unseeded_random'), 'the RNG did differ');
  assert.notEqual(raw(a, 'run_directory'), raw(b, 'run_directory'), 'the run directory did differ');
  const reported = (name) => a.report.poc.tests.find((x) => x.id.includes(name));
  assert.equal(reported('unseeded_random').message, null);
  assert.equal(reported('run_directory').message, null);
  assert.equal(raw(a, 'seeded_random'), raw(b, 'seeded_random'), '--fuzz-seed seeds vm.randomUint');
  assert.equal(reported('seeded_random').message, raw(a, 'seeded_random'), 'seeded, so it stays');
});

/** Fails on runs 1 and 3 or on run 2, by the clock's parity at run 1 (state/ keeps the run count): always mixed, and the phase follows the host. */
const FLAKY_POC = pocFile('FlakyTest', [
  '    function test_alternates() public {',
  '        uint256 run = 0; uint256 phase = 0;',
  '        if (vm.isFile("./state/run1")) { run = 1; phase = vm.isFile("./state/phase1") ? 1 : 0; }',
  '        if (vm.isFile("./state/run2")) run = 2;',
  '        if (run == 0) { phase = vm.unixTime() % 2000 < 1000 ? 0 : 1; if (phase == 1) vm.writeFile("./state/phase1", "1"); vm.writeFile("./state/run1", "1"); }',
  '        if (run == 1) vm.writeFile("./state/run2", "1");',
  '        require((run + phase) % 2 == 1, "this run fails");',
  '    }'
]);

test('flaky-poc-two-schedules: a PoC that alternates, on a fast and a slow CPU schedule, is INVALID on both with the identical report hash', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('plain');
  const [a, b] = await twoHosts(t, claim(fx, { 'test/Flaky.t.sol': FLAKY_POC }));
  for (const h of [a, b]) {
    assert.equal(h.result.gates.reproduces.status, 'fail');
    assert.equal(h.result.gates.integrity.status, 'pass', JSON.stringify(h.result.gates.integrity));
    const runs = h.result.facts.poc.tests[0].runs;
    assert.ok(runs.includes('pass') && runs.includes('fail'), `mixed: ${runs}`);
    assert.deepEqual(h.report.poc.tests[0].runs, ['error', 'error', 'error']);
  }
});

test('R8: under the runner\'s own flags a PoC reads the same hostname in every container, so the report stays the same', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('ffi');
  const poc = pocFile('HostTest', [
    '    function test_hostname() public { string[] memory a = new string[](1); a[0] = "hostname"; require(false, string(vm.ffi(a))); }'
  ]);
  const request = claim(fx, { 'test/Host.t.sol': poc });
  const a = await host(t, request);
  const b = await host(t, request);
  assert.equal(a.result.facts.poc.tests[0].message, 'sandbox');
  assert.equal(a.sha256, b.sha256);
});

test('the pack on real git: the PoC with its function context and full text, the named source, call sites, a tree, and the same bytes in both containers', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('plain');
  const [a] = await twoHosts(t, claim(fx, { 'test/Clock.t.sol': TIME_POC }));
  const pack = a.result.contextPack;
  const text = (name) => pack.files.filter((f) => f.tier === name).map((f) => f.text).join('\n');
  assert.match(text('poc'), /diff --git a\/test\/Clock\.t\.sol b\/test\/Clock\.t\.sol/);
  assert.match(text('poc'), /index 0{40}\.\.[0-9a-f]{40}/, 'whole blob ids');
  assert.match(text('poc'), /poc file: test\/Clock\.t\.sol\n[^]*contract ClockTest/);
  assert.match(text('source'), /source file: src\/Vault\.sol\n[^]*contract Vault/);
  assert.match(text('callSites'), /symbol: deposit/);
  assert.match(text('callSites'), /src\/Vault\.sol:5:/);
  assert.match(text('tree'), /src\//);
  assert.ok(pack.usedTokens <= pack.budgetTokens);
  for (const t2 of pack.tiers) assert.notEqual(t2.status, 'dropped', t2.name);
});
