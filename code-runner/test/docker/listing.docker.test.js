'use strict';

// Node A2b against real forge (the base pinned in @verdikta/common, v1.8.5):
// the listing check's build, suite x3, baseline, default limits and harness
// proof, on fixture Foundry repositories built locally as env images
// (forgeFixture.js). Under runc locally; CI runs this file under runc and
// under gVisor (runsc). Every container and image is removed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { executeRun } = require('../../src/pipeline');
const { validateListingRequest, listingSteps, imageUnpackedBytes } = require('../../src/listing');
const { validateBaseline } = require('../../src/common');
const { runText } = require('../../src/docker');
const { silent, instanceId, dockerTestConfig, dockerFor, leftovers, removeAll } = require('./helpers');
const { VAULT_REPO, buildFixture } = require('./forgeFixture');

const TIMEOUT = 900000;
const builder = dockerFor(dockerTestConfig());
const fixtures = new Map();

/** A test that passes on its first run and fails on every later one (it leaves an untracked flag in state/). */
const FLAKY = [
  '// SPDX-License-Identifier: MIT',
  'pragma solidity ^0.8.0;',
  'import {Base} from "./Vm.sol";',
  'contract FlakyTest is Base {',
  '    function test_flaky() public { if (vm.isFile("state/flag")) revert("not the first run"); vm.writeFile("state/flag", "x"); }',
  '}',
  ''
].join('\n');

/** forge-std's Test, cut down to the one assertion the probe uses: modern (vm.assertEq reverts) or legacy (a fail flag, no revert). */
const FORGE_STD = {
  modern: [
    '// SPDX-License-Identifier: MIT',
    'pragma solidity >=0.6.2;',
    'interface VmAssertions { function assertEq(uint256 a, uint256 b, string calldata err) external pure; }',
    'abstract contract Test {',
    '    VmAssertions private constant VM = VmAssertions(address(uint160(uint256(keccak256("hevm cheat code")))));',
    '    function assertEq(uint256 a, uint256 b, string memory err) internal pure { VM.assertEq(a, b, err); }',
    '}',
    ''
  ].join('\n'),
  legacy: [
    '// SPDX-License-Identifier: MIT',
    'pragma solidity >=0.6.2;',
    'interface VmStore { function store(address target, bytes32 slot, bytes32 value) external; }',
    'abstract contract Test {',
    '    address private constant HEVM = address(uint160(uint256(keccak256("hevm cheat code"))));',
    '    event log(string);',
    '    function assertEq(uint256 a, uint256 b, string memory err) internal {',
    '        if (a != b) { emit log(err); VmStore(HEVM).store(HEVM, bytes32("failed"), bytes32(uint256(1))); }',
    '    }',
    '}',
    ''
  ].join('\n')
};

const REMAP = 'remappings = ["forge-std/=lib/forge-std/src/"]';

/** The vault with foundry.toml's test directory named tests/ (R5-F1). */
const TESTS_DIR = (() => {
  const files = {};
  for (const [k, v] of Object.entries(VAULT_REPO)) files[k.startsWith('test/') ? `tests/${k.slice(5)}` : k] = v;
  files['foundry.toml'] = '[profile.default]\nsrc = "src"\ntest = "tests"\nout = "out"\ncache_path = "cache"\nsolc = "/opt/solc/solc"\noffline = true\n';
  return files;
})();
const VARIANTS = Object.freeze({
  vault: { files: { ...VAULT_REPO, 'test/Flaky.t.sol': FLAKY }, toml: 'fs_permissions = [{ access = "read-write", path = "./state" }]' },
  modern: { files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD.modern }, toml: REMAP },
  legacy: { files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD.legacy }, toml: REMAP },
  testsdir: { files: TESTS_DIR }
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

function body(fx, over = {}) {
  return {
    spec: {
      version: 1,
      kind: 'bug',
      repo: 'https://github.com/acme/vault',
      baseCommit: fx.baseCommit,
      env: { from: 'foundry' },
      commands: {
        framework: 'forge',
        build: 'forge build',
        test: 'forge test',
        testFiles: 'forge test --match-path $FILES',
        testIds: 'forge test --match-test $TEST_IDS',
        ...(over.commands || {})
      },
      paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.gitignore'] },
      stake: { scope: { include: ['src/**'] } },
      limits: { cpus: 1, memoryMb: 1024 }
    },
    image: fx.image,
    deadline: 900000
  };
}

async function check(t, b, { before = [] } = {}) {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance).catch(() => {}));
  const v = validateListingRequest(b);
  assert.ok(v.ok, JSON.stringify(v.issues));
  const steps = listingSteps(v.request, v.limits, { imageSize: () => imageUnpackedBytes(docker, v.request.image) });
  const receivedAt = Date.now();
  const result = await executeRun({
    docker, config, limits: v.limits, image: v.request.image, runId: crypto.randomBytes(8).toString('hex'),
    steps: [...before, ...steps], receivedAt, deadlineAt: receivedAt + v.request.deadlineMs, active: new Set(), log: silent
  });
  assert.deepEqual(await leftovers(docker, config.instance), [], 'the check removed its sandbox');
  return result;
}

const show = (r) => JSON.stringify({
  outcome: r.outcome, abstain: r.abstain, issues: r.issues,
  listing: r.facts && r.facts.listing ? { ...r.facts.listing, baseline: undefined } : undefined,
  step: r.abstain ? (r.steps || []).find((s) => s.name === r.abstain.step) : undefined
}, null, 1);
const verdicts = (r) => r.facts.listing.harness.probes.map((p) => [p.name, p.variant, p.verdict]);

test('a listing check on real forge: build once, suite x3 without network, the baseline, timings, size, default limits; the harness proof (plain revert)', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('vault');
  const host = {};
  const inspect = async (ctx) => {
    const r = await runText(builder, ['inspect', '--type', 'container', '--format',
      '{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.Config.User}}',
      ctx.sandboxName], { timeoutMs: 30000 });
    host.config = r.stdout.trim();
  };
  // The first sandbox, before the check removes it for the probes' fresh ones (each created the same way).
  const r = await check(t, body(fx), { before: [inspect] });
  assert.equal(r.outcome, 'definitive', show(r));
  const l = r.facts.listing;
  assert.equal(l.status, 'accepted', show(r));
  // The suite ran three times on the listed commit's files; test_flaky passed once, then found its flag.
  assert.deepEqual(l.baseline.tests, [
    { id: 'test/Flaky.t.sol > FlakyTest > test_flaky()', results: ['pass', 'fail', 'fail'] },
    { id: 'test/Vault.t.sol > VaultTest > test_deposit()', results: ['pass', 'pass', 'pass'] }
  ]);
  assert.deepEqual(l.baseline.stable, ['test/Vault.t.sol > VaultTest > test_deposit()']);
  assert.deepEqual(l.baseline.unstable, ['test/Flaky.t.sol > FlakyTest > test_flaky()']);
  assert.equal(l.baseline.baseCommit, fx.baseCommit);
  assert.ok(validateBaseline(l.baseline, body(fx).spec).ok);
  // One listing build before the suite; three suite runs.
  const names = r.steps.map((s) => s.name);
  assert.equal(names.filter((n) => n === 'build').length, 1);
  assert.deepEqual(names.filter((n) => /^suite:[0-9]$/.test(n)), ['suite:1', 'suite:2', 'suite:3']);
  assert.ok(names.indexOf('build') < names.indexOf('suite:1'));
  assert.match(r.steps.find((s) => s.name === 'suite:1').stdout.text, /<testsuites /, 'forge printed its JUnit');
  // Timings, size and the defaults from them.
  const ms = (s) => Math.round(s * 1000);
  const T = Math.max(...l.timings.testSeconds.map(ms));
  assert.equal(l.limits.buildSeconds, Math.max(1, Math.ceil((3 * ms(l.timings.buildSeconds)) / 1000)));
  assert.equal(l.limits.testSeconds, Math.max(1, Math.ceil((3 * T) / 1000)));
  assert.equal(l.limits.runSeconds, Math.ceil((3 * (ms(l.timings.prepareSeconds) + ms(l.timings.buildSeconds) + T)) / 1000) + 2 * l.limits.testSeconds);
  assert.ok(l.limits.runSeconds <= 360);
  assert.equal(l.limits.cpus, 1);
  assert.equal(l.limits.memoryMb, 1024);
  assert.ok(Number.isSafeInteger(l.image.unpackedBytes) && l.image.unpackedBytes > 100000000, `unpacked ${l.image.unpackedBytes}`);
  // The harness proof: no forge-std here, so the plain revert; the broken tests are errors.
  assert.equal(l.harness.path, 'test/VerdiktaHarness.t.sol');
  assert.deepEqual(verdicts(r), [
    ['fails', 'forge-std', 'not_run'],
    ['fails', 'plain', 'assertion'],
    ['compileError', null, 'no_junit'],
    ['setUpError', null, 'harness_error']
  ]);
  // The same container as a claim's: no network, read-only, no capabilities, the spec's cpus and memory, uid 10001.
  const [net, ro, capDrop, secOpt, cpus, mem, user] = host.config.split('|');
  assert.equal(net, 'none');
  assert.equal(ro, 'true');
  assert.deepEqual(JSON.parse(capDrop), ['ALL']);
  assert.ok(JSON.parse(secOpt).includes('no-new-privileges'));
  assert.equal(cpus, '1000000000');
  assert.equal(mem, String(1024 * 1024 * 1024));
  assert.equal(user, '10001:10001');
});

test('the harness proof with the listing\'s forge-std: assertEq fails as an assertion on all three runs', { timeout: TIMEOUT }, async (t) => {
  const r = await check(t, body(await fixture('modern')));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.facts.listing.status, 'accepted', show(r));
  assert.deepEqual(verdicts(r), [
    ['fails', 'forge-std', 'assertion'],
    ['compileError', null, 'no_junit'],
    ['setUpError', null, 'harness_error']
  ]);
  const fails = r.facts.listing.harness.probes[0];
  assert.match(fails.gates.reproduces.detail, /failed as an assertion on all 3 runs/);
});

test('legacy, non-reverting assertions: the trivially failing test is an error, and the listing is refused', { timeout: TIMEOUT }, async (t) => {
  const r = await check(t, body(await fixture('legacy')));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(r.facts.listing.refusals.map((x) => x.code), ['LEGACY_ASSERTIONS'], show(r));
  assert.deepEqual(verdicts(r), [['fails', 'forge-std', 'not_assertion']]);
});

test('too heavy: a build that runs past 30 s is stopped, and the listing refused (3x it passes the class\'s 90 s build)', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('vault');
  const t0 = Date.now();
  const r = await check(t, body(fx, { commands: { build: 'sleep 40; forge build' } }));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(r.facts.listing.refusals.map((x) => x.code), ['LISTING_TOO_HEAVY'], show(r));
  assert.match(r.facts.listing.refusals[0].detail, /the build ran past 30 s/);
  assert.equal(r.steps.find((s) => s.name === 'build').cause, 'step_timeout');
  assert.ok(Date.now() - t0 < 40000, 'stopped at the budget, not at the build\'s end');
  assert.equal(r.facts.listing.limits, null);
});

test('a build that fails at the listed commit refuses the listing; a testFiles that ignores $FILES cannot host claims', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('vault');
  const built = await check(t, body(fx, { commands: { build: 'forge build && exit 3' } }));
  assert.equal(built.outcome, 'definitive', show(built));
  assert.deepEqual(built.facts.listing.refusals.map((x) => x.code), ['BUILD_FAILED']);
  // The maker's testFiles runs one fixed file whatever $FILES names: a PoC would never run.
  const ignored = await check(t, body(fx, { commands: { testFiles: 'FILES=test/Vault.t.sol; forge test --match-path $FILES' } }));
  assert.equal(ignored.outcome, 'definitive', show(ignored));
  assert.deepEqual(ignored.facts.listing.refusals.map((x) => x.code), ['HARNESS_ASSERTION_NOT_REPORTED'], show(ignored));
});

test('what the suite leaves in its sandbox cannot make the harness proof pass: each probe gets a fresh one, as a claim does (R1-F2)', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('vault');
  // commands.test leaves /tmp/suite-ready behind, and testFiles needs it: a claim, which never runs commands.test, would fail.
  const r = await check(t, body(fx, { commands: { test: 'touch /tmp/suite-ready && forge test', testFiles: '[ -e /tmp/suite-ready ] && forge test --match-path $FILES' } }));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(r.facts.listing.refusals.map((x) => x.code), ['HARNESS_ASSERTION_NOT_REPORTED'], show(r));
  assert.equal(r.facts.listing.baseline.stable.length, 1, 'the suite itself ran');
});

test('a custom test directory (foundry.toml test = "tests") and a broad paths.tests: the probes go where the suite ran (R5-F1)', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('testsdir');
  const b = body(fx);
  b.spec.paths = { tests: ['**/*.t.sol'], protected: ['foundry.toml', 'lib/**', '.gitignore'] };
  const r = await check(t, b);
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.facts.listing.status, 'accepted', show(r));
  assert.equal(r.facts.listing.harness.path, 'tests/VerdiktaHarness.t.sol');
  assert.deepEqual(r.facts.listing.baseline.stable, ['tests/Vault.t.sol > VaultTest > test_deposit()']);
});
