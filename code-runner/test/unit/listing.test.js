'use strict';

// Node A2b acceptance: POST /v1/listing-checks (design §8.2 steps 2-3, §8.3),
// driven through the run engine and the HTTP server against a fake env image
// (test/helpers/fakeClaim.js). The same paths run against real forge in
// test/docker/listing.docker.test.js.
//
//   1. {spec, image}: build once, suite three times with no network and the
//      fixed fuzz seed; stable / unstable sets, timings, unpacked size,
//      default limits (3x measured + repeat reserve)
//   2. a listing whose limits exceed the 360 s runSeconds cap is too heavy
//   3. the harness proof: a trivially failing and a trivially broken test
//      under paths.tests told apart by the JUnit, else refused
//   4. the same isolation, limits and deadline rules as /v1/runs
//   Review focus: the endpoint cannot run claims outside the claim gates.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { executeRun } = require('../../src/pipeline');
const { createServer } = require('../../src/server');
const { FORGE_FUZZ_SEED, validateBaseline } = require('../../src/common');
const { CLASS_HARD_LIMITS } = require('../../src/classLimits');
const {
  validateListingRequest, listingSteps, imageUnpackedBytes, deriveLimits, buildBudgetMs, suiteBudgetMs, harnessPath, probeCandidates,
  probePatch, PROBES, LISTING_FIELDS, LISTING_CHECK_SECONDS
} = require('../../src/listing');
const { testConfig, request } = require('../helpers/http');
const { IMAGE, runRequest, spec } = require('../helpers/requests');
const { BASE, claimSandbox, decode } = require('../helpers/fakeClaim');
const { never } = require('../helpers/fakeDocker');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const noAdmission = async () => {};
const meminfo = async () => ({ availableMb: 1e6, error: null });
const statfs = async () => ({ bavail: 1e7, bsize: 4096 });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const COMMANDS = {
  framework: 'forge',
  build: 'forge build',
  test: 'forge test',
  testFiles: 'forge test --match-path $FILES',
  testIds: 'forge test --match-test $TEST_IDS'
};

/** code_review.json as a maker drafts it before the image is attested: no env.image, no size, no limits. */
function draftSpec(over = {}) {
  return {
    version: 1,
    kind: 'bug',
    repo: 'https://github.com/acme/vault',
    baseCommit: BASE,
    env: { from: 'foundry' },
    commands: { ...COMMANDS, ...(over.commands || {}) },
    paths: over.paths || { tests: ['test/**'], protected: ['foundry.toml', 'lib/**'] },
    stake: { scope: { include: ['src/**'], exclude: [] } },
    ...(over.limits ? { limits: over.limits } : {}),
    ...(over.env ? { env: over.env } : {}),
    ...(over.stake ? { stake: over.stake } : {})
  };
}

function listingBody(over = {}) {
  return { spec: draftSpec(over.spec || {}), image: IMAGE, deadline: 900000, ...(over.body || {}) };
}

/**
 * forge's JUnit; a case is { name, failure (a message, or null for a failure without one), skipped, error }. forge's own
 * shape (test/helpers/fakeClaim.js): each suite's summary and counts follow its records, as the integrity checks
 * (A3a), which a probe's runs get too, require.
 */
function junitOf(suites) {
  return require('../helpers/fakeClaim').junit(suites);
}

/** The maker's suite on run k (1-3): test_deposit passes, test_flaky fails on run 2, test_broken always fails, test_skipped skips. */
function vaultSuite(k) {
  return junitOf([
    { suite: 'test/Vault.t.sol:VaultTest', cases: [
      { name: 'test_deposit()' },
      { name: 'test_flaky()', ...(k === 2 ? { failure: 'flaked' } : {}) },
      { name: 'test_broken()', failure: 'always' },
      { name: 'test_skipped()', skipped: true },
      { name: 'testFuzz_amount(uint256)' }
    ] }
  ]);
}

/** Which probe the last applied patch put in place (or null: the listed commit). */
function probeKindOf(patch) {
  if (!patch) return null;
  if (patch.includes('forge-std/Test.sol')) return 'failsForgeStd';
  if (patch.includes('VerdiktaHarnessCompileError')) return 'compileError';
  if (patch.includes('VerdiktaHarnessSetUpError')) return 'setUpError';
  if (patch.includes('VerdiktaHarnessFails')) return 'failsPlain';
  return 'other';
}

/**
 * A fake env image for a listing check: the maker's suite, and forge's
 * answers to the probes the way a forge repository with (`modern`), with
 * legacy (`legacy`) or without (`none`) forge-std would give them.
 */
function listingSandbox({
  suite = [vaultSuite(1), vaultSuite(2), vaultSuite(3)], forgeStd = 'modern', probeRun = {}, build = null,
  history = () => ({ stdout: '400000000\n0\n600000000\n' }), git = {}, scripts = {}, handlers = {}, ...rest
} = {}) {
  let applied = null;
  let suiteRun = 0;
  const pathOf = () => /\+\+\+ b\/(\S+)/.exec(applied)[1];
  const lines = () => applied.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const hexLen = 40;
  const probeDefaults = {
    failsForgeStd: () => (forgeStd === 'legacy'
      ? { exitCode: 1, stdout: junitOf([{ suite: `${pathOf()}:VerdiktaHarnessFails`, cases: [{ name: 'test_verdiktaHarnessFails()', failure: null }] }]) }
      : { exitCode: 1, stdout: junitOf([{ suite: `${pathOf()}:VerdiktaHarnessFails`, cases: [{ name: 'test_verdiktaHarnessFails()', failure: 'verdikta harness: a trivially failing test: 1 != 2' }] }]) }),
    failsPlain: () => ({ exitCode: 1, stdout: junitOf([{ suite: `${pathOf()}:VerdiktaHarnessFails`, cases: [{ name: 'test_verdiktaHarnessFails()', failure: 'verdikta harness: a trivially failing test' }] }]) }),
    compileError: () => ({ exitCode: 1, stdout: '', stderr: 'Error: Compiler run failed:\nError (7576): Undeclared identifier.\n' }),
    setUpError: () => ({ exitCode: 1, stdout: junitOf([{ suite: `${pathOf()}:VerdiktaHarnessSetUpError`, cases: [{ name: 'setUp()', failure: 'verdikta harness: a trivially broken setUp' }] }]) })
  };
  const sb = claimSandbox({
    ...rest,
    handlers: { history: (args) => history(args), ...handlers },
    git: {
      'apply --index': (d) => { applied = d.stdin.toString('utf8'); return { exitCode: 0 }; },
      'diff --raw': () => ({ stdout: Buffer.from(`:000000 100644 ${'0'.repeat(hexLen)} ${'b'.repeat(hexLen)} A\0${pathOf()}\0`, 'latin1') }),
      'diff --name-status': () => ({ stdout: `A\0${pathOf()}\0` }),
      'diff --numstat': () => ({ stdout: `${lines()}\t0\t${pathOf()}\0` }),
      'diff -U0': () => ({ stdout: applied }),
      reset: (d) => { if (d.sub.includes(sb.repo.commit)) applied = null; return { exitCode: 0 }; },
      ...git
    },
    scripts: {
      'vcr-build': (d) => {
        const kind = probeKindOf(applied);
        if (build) return build(d, kind);
        if (kind === 'failsForgeStd' && forgeStd === 'none') return { exitCode: 1, stderr: 'Error: Source "forge-std/Test.sol" not found\n' };
        if (kind === 'compileError') return { exitCode: 1, stderr: 'Error: Compiler run failed\n' };
        return { exitCode: 0, stdout: 'Compiling 3 files with Solc 0.8.31\n' };
      },
      'vcr-suite': (d, repo) => {
        suiteRun += 1;
        d.container = containerOf(sb.docker.calls[sb.docker.calls.length - 1]);
        const h = suite[suiteRun - 1];
        if (typeof h === 'function') return h(d, suiteRun, repo);
        return { exitCode: 1, stdout: h === undefined ? '' : h };
      },
      'vcr-poc': (d, repo) => {
        d.container = containerOf(sb.docker.calls[sb.docker.calls.length - 1]);
        const kind = probeKindOf(applied);
        const h = probeRun[kind] || probeDefaults[kind];
        if (!h) throw new Error(`no probe answer for ${kind}`);
        return h(d, repo, pathOf());
      },
      ...scripts
    }
  });
  sb.applied = () => applied;
  return sb;
}

async function runListing(sb, body = listingBody(), { caps, deadlineMs = 900000, limitsOver = null, admit = noAdmission, extraSteps = [] } = {}) {
  const v = validateListingRequest(body);
  assert.ok(v.ok, JSON.stringify(v.issues));
  const limits = limitsOver ? Object.freeze({ ...v.limits, ...limitsOver }) : v.limits;
  const steps = listingSteps(v.request, limits, { imageSize: () => imageUnpackedBytes(sb.docker, v.request.image), ...(caps ? { caps } : {}) });
  const receivedAt = Date.now();
  return executeRun({
    docker: sb.docker, config: testConfig(), limits, image: v.request.image, runId: '0123456789abcdef', steps: [...steps, ...extraSteps],
    receivedAt, deadlineAt: receivedAt + deadlineMs, active: new Set(), log: silent, admit
  });
}

const kinds = (sb) => sb.execs().map((d) => (d.kind === 'git' ? `git ${d.sub[0]}` : d.kind));
const show = (r) => JSON.stringify({ outcome: r.outcome, abstain: r.abstain, issues: r.issues, listing: r.facts.listing && { ...r.facts.listing, baseline: undefined } }, null, 1);
const codes = (r) => r.facts.listing.refusals.map((x) => x.code);

// ------------------------------------------------- 1. build, suite x3, baseline

test('a listing check builds once and runs the suite three times with --junit and the fixed fuzz seed, at the listed commit', async () => {
  const sb = listingSandbox();
  const r = await runListing(sb);
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.facts.listing.status, 'accepted', show(r));
  // The listing's build comes once, before any suite run; the probes' own builds come after the suite.
  const seq = kinds(sb);
  const firstSuite = seq.indexOf('vcr-suite');
  assert.equal(seq.slice(0, firstSuite).filter((k) => k === 'vcr-build').length, 1, 'one build before the suite');
  const suites = sb.execs().filter((d) => d.kind === 'vcr-suite');
  assert.equal(suites.length, 3);
  for (const s of suites) {
    // Attempt 3 (owner decision Q31): the declared test command as forge's argv, with the runner's reporter flags.
    assert.deepEqual(s.argv, ['/usr/local/bin/forge', 'test', '--junit', '--fuzz-seed', FORGE_FUZZ_SEED]);
    assert.equal(s.fixedEnv.FOUNDRY_FUZZ_SEED, FORGE_FUZZ_SEED);
  }
  // Runs 2 and 3 start from the listed commit's tracked files (the checkout's commit of it), as a claim's re-runs do.
  const between = seq.slice(firstSuite, seq.lastIndexOf('vcr-suite') + 1);
  assert.deepEqual(between, ['vcr-suite', 'vcr-cleanup', 'git reset', 'vcr-suite', 'vcr-cleanup', 'git reset', 'vcr-suite']);
  const resets = sb.execs().filter((d) => d.kind === 'git' && d.sub[0] === 'reset').slice(0, 2);
  for (const x of resets) assert.deepEqual(x.sub, ['reset', '--quiet', '--hard', sb.repo.commit]);
  // The forced checkout ran first, as for a claim: nothing of the image's checkout is used.
  assert.deepEqual(seq.slice(0, 4), ['vcr-procs', 'git init', 'git init', 'vcr-stage']);
});

test('the baseline: every test with its result on each run, stable = passed all three, unstable = everything else; valid baseline.json', async () => {
  const sb = listingSandbox();
  const r = await runListing(sb);
  const { baseline } = r.facts.listing;
  const id = (n) => `test/Vault.t.sol > VaultTest > ${n}`;
  assert.deepEqual(baseline.tests, [
    { id: id('testFuzz_amount(uint256)'), results: ['pass', 'pass', 'pass'] },
    { id: id('test_broken()'), results: ['fail', 'fail', 'fail'] },
    { id: id('test_deposit()'), results: ['pass', 'pass', 'pass'] },
    { id: id('test_flaky()'), results: ['pass', 'fail', 'pass'] },
    { id: id('test_skipped()'), results: ['skip', 'skip', 'skip'] }
  ]);
  assert.deepEqual(baseline.stable, [id('testFuzz_amount(uint256)'), id('test_deposit()')]);
  assert.deepEqual(baseline.unstable, [id('test_broken()'), id('test_flaky()'), id('test_skipped()')]);
  assert.equal(baseline.version, 1);
  assert.equal(baseline.baseCommit, BASE, 'the listed commit, not the runner\'s commit of it');
  assert.equal(baseline.framework, 'forge');
  assert.equal(baseline.runs, 3);
  assert.equal(baseline.timings.testSeconds.length, 3);
  const v = validateBaseline(baseline, draftSpec());
  assert.ok(v.ok, JSON.stringify(v.issues));
  assert.deepEqual(r.facts.listing.suite, { tests: 5, stable: 2, unstable: 3, exitCodes: [1, 1, 1], harnessErrors: [[], [], []] });
});

test('a test missing or duplicated on a run is an error there; a failing setUp in the maker\'s suite is a warning, not a test', async () => {
  const run = (k) => junitOf([
    { suite: 'test/Vault.t.sol:VaultTest', cases: [{ name: 'test_deposit()' }, ...(k === 2 ? [] : [{ name: 'test_gone()' }]), ...(k === 3 ? [{ name: 'test_deposit()' }] : [])] },
    { suite: 'test/Oracle.t.sol:OracleTest', cases: [{ name: 'setUp()', failure: 'no rpc' }] }
  ]);
  const sb = listingSandbox({ suite: [run(1), run(2), run(3)] });
  const r = await runListing(sb);
  const { baseline, warnings } = r.facts.listing;
  assert.deepEqual(baseline.tests, [
    { id: 'test/Vault.t.sol > VaultTest > test_deposit()', results: ['pass', 'pass', 'error'] },
    { id: 'test/Vault.t.sol > VaultTest > test_gone()', results: ['pass', 'error', 'pass'] }
  ]);
  assert.deepEqual(baseline.stable, []);
  assert.deepEqual(warnings.map((w) => w.code).sort(), ['BASELINE_NO_STABLE_TESTS', 'SUITE_HARNESS_ERRORS']);
  assert.match(warnings.find((w) => w.code === 'SUITE_HARNESS_ERRORS').detail, /test\/Oracle\.t\.sol:OracleTest setUp\(\)/);
});

test('timings, the unpacked size and the default limits: 3x the measured times plus the repeat reserve', async () => {
  const sb = listingSandbox({
    scripts: { 'vcr-build': async (d) => { await delay(120); return { exitCode: 0 }; } },
    suite: [1, 2, 3].map((k) => async () => { await delay(k === 2 ? 90 : 40); return { exitCode: 1, stdout: vaultSuite(k) }; })
  });
  const r = await runListing(sb, listingBody({ spec: { limits: { cpus: 1, memoryMb: 2048 } } }));
  assert.equal(r.facts.listing.status, 'accepted', show(r));
  const { timings, limits, image } = r.facts.listing;
  assert.deepEqual(Object.keys(timings), ['prepareSeconds', 'buildSeconds', 'testSeconds']);
  assert.ok(timings.buildSeconds >= 0.12, JSON.stringify(timings));
  assert.ok(timings.testSeconds[1] >= 0.09 && timings.testSeconds[1] >= Math.max(timings.testSeconds[0], timings.testSeconds[2]), JSON.stringify(timings));
  // The formula, from the measured times (ms).
  const ms = (s) => Math.round(s * 1000);
  const P = ms(timings.prepareSeconds);
  const B = ms(timings.buildSeconds);
  const T = Math.max(...timings.testSeconds.map(ms));
  assert.equal(limits.buildSeconds, Math.max(1, Math.ceil((3 * B) / 1000)));
  assert.equal(limits.testSeconds, Math.max(1, Math.ceil((3 * T) / 1000)));
  assert.equal(limits.runSeconds, Math.ceil((3 * (P + B + T)) / 1000) + 2 * limits.testSeconds);
  // The spec's own cpus and memory (what the suite was measured with); the class's patch size.
  assert.equal(limits.cpus, 1);
  assert.equal(limits.memoryMb, 2048);
  assert.equal(limits.maxPatchBytes, CLASS_HARD_LIMITS.maxPatchBytes);
  assert.deepEqual(r.facts.listing.baseline.timings, { buildSeconds: timings.buildSeconds, testSeconds: timings.testSeconds });
  // The unpacked size: the sum of the image's layers as the daemon lists them.
  assert.deepEqual(image, { ref: IMAGE, unpackedBytes: 1000000000 });
  const history = sb.docker.callsOf('history');
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].args, ['history', '--human=false', '--no-trunc', '--format', '{{.Size}}', IMAGE]);
});

test('deriveLimits: buildSeconds = ceil(3B), testSeconds = ceil(3T), runSeconds = ceil(3(P + B + T)) + 2 testSeconds', () => {
  const spec = { cpus: 2, memoryMb: 4096, maxPatchBytes: 2000000 };
  const d = deriveLimits({ prepareMs: 4000, buildMs: 14200, testMs: [21500, 20900, 22100] }, spec);
  assert.deepEqual(d.limits, { cpus: 2, memoryMb: 4096, buildSeconds: 43, testSeconds: 67, runSeconds: 121 + 134, maxPatchBytes: 2000000 });
  assert.deepEqual(d.over, []);
  // At least 1 s each, whatever was measured.
  assert.deepEqual(deriveLimits({ prepareMs: 0, buildMs: 0, testMs: [0, 0, 0] }, spec).limits, { ...spec, buildSeconds: 1, testSeconds: 1, runSeconds: 2 });
});

test('the image\'s unpacked size above the class\'s 6 GB is refused; a daemon that cannot list the layers abstains', async () => {
  const big = await runListing(listingSandbox({ history: () => ({ stdout: '3000000000\n3000000001\n' }) }));
  assert.equal(big.outcome, 'definitive', show(big));
  assert.deepEqual(codes(big), ['IMAGE_ABOVE_CLASS_MAX']);
  assert.equal(big.facts.listing.status, 'refused');
  const broken = await runListing(listingSandbox({ history: () => ({ exitCode: 1, stderr: 'Error response from daemon: No such image\n' }) }));
  assert.equal(broken.outcome, 'abstain');
  assert.equal(broken.abstain.cause, 'docker_error');
  assert.equal(broken.abstain.step, 'image:size');
});

test('a build that fails at the listed commit, and a suite run without readable JUnit, refuse the listing', async () => {
  const built = await runListing(listingSandbox({ build: (d, kind) => (kind === null ? { exitCode: 2, stderr: 'Error: Compiler run failed\n' } : { exitCode: 0 }) }));
  assert.equal(built.outcome, 'definitive');
  assert.deepEqual(codes(built), ['BUILD_FAILED']);
  assert.match(built.facts.listing.refusals[0].detail, /exited 2/);
  assert.equal(built.facts.listing.baseline, null);

  const sb = listingSandbox({ suite: [vaultSuite(1), '', vaultSuite(3)] });
  const unread = await runListing(sb);
  assert.deepEqual(codes(unread), ['SUITE_JUNIT_UNREADABLE']);
  assert.match(unread.facts.listing.refusals[0].detail, /run 2/);
  assert.equal(sb.execs().filter((d) => d.kind === 'vcr-suite').length, 2, 'the check stops at its first refusal');
  assert.equal(sb.execs().filter((d) => d.kind === 'vcr-poc').length, 0, 'no harness probe after a refusal');
});

test('the scope must name a file of the listed commit, and the image must leave a claim room to apply its patch', async () => {
  const empty = await runListing(listingSandbox(), listingBody({ spec: { stake: { scope: { include: ['contracts/**'] } } } }));
  assert.deepEqual(codes(empty), ['SCOPE_EMPTY']);
  const full = await runListing(listingSandbox({ freeBytes: 10 * 1024 * 1024 }));
  assert.equal(full.outcome, 'requester_error');
  assert.deepEqual(full.issues.map((i) => i.code), ['IMAGE_WORKDIR_FULL']);
});

test('limits code_review.json declares below the measured defaults are refused (claims would run out of time)', async () => {
  const r = await runListing(listingSandbox(), listingBody({ spec: { limits: { runSeconds: 1, testSeconds: 1 } } }));
  assert.equal(r.outcome, 'definitive');
  assert.deepEqual(codes(r), ['LIMITS_BELOW_DEFAULTS']);
  assert.match(r.facts.listing.refusals[0].detail, /runSeconds 1/);
  assert.ok(r.facts.listing.limits.runSeconds > 1);
});

// --------------------------------------------------------- 2. too heavy

test('too heavy: a listing whose default limits would pass the 360 s runSeconds cap (or the 90 s build cap) is refused', () => {
  const spec = { cpus: 2, memoryMb: 4096, maxPatchBytes: 2000000 };
  // P 10 s, B 20 s, T 40 s: runSeconds = ceil(3 x 70) + 2 x 120 = 450.
  const heavy = deriveLimits({ prepareMs: 10000, buildMs: 20000, testMs: [40000, 39000, 38000] }, spec);
  assert.equal(heavy.limits.runSeconds, 450);
  assert.deepEqual(heavy.over, ['runSeconds would be 450, above the class\'s 360']);
  // Exactly at the cap is accepted, one second over is not.
  const at = deriveLimits({ prepareMs: 10000, buildMs: 20000, testMs: [30000, 30000, 30000] }, spec);
  assert.equal(at.limits.runSeconds, 360);
  assert.deepEqual(at.over, []);
  const over = deriveLimits({ prepareMs: 10001, buildMs: 20000, testMs: [30000, 30000, 30000] }, spec);
  assert.equal(over.limits.runSeconds, 361);
  assert.equal(over.over.length, 1);
  assert.deepEqual(deriveLimits({ prepareMs: 0, buildMs: 30001, testMs: [1, 1, 1] }, spec).over, ['buildSeconds would be 91, above the class\'s 90']);
});

test('the check stops a measured step where the limits can no longer fit: the build at 30 s, a suite run at its share of 360 s', () => {
  assert.equal(buildBudgetMs(0), 30000);
  assert.equal(buildBudgetMs(100000), 19000);
  assert.equal(suiteBudgetMs(0, 0), Math.floor(357000 / 9));
  assert.equal(suiteBudgetMs(10000, 20000), Math.floor((357000 - 90000) / 9));
  // A build and a suite run at their budgets still fit the caps exactly.
  for (const [p, b] of [[0, 30000], [2500, 17000], [7000, 29999]]) {
    const budgetB = Math.min(b, buildBudgetMs(p));
    const t = suiteBudgetMs(p, budgetB);
    assert.deepEqual(deriveLimits({ prepareMs: p, buildMs: budgetB, testMs: [t, t, t] }, { cpus: 2, memoryMb: 4096, maxPatchBytes: 1 }).over, [], `${p} ${b}`);
  }
});

test('too heavy, measured: a suite run that passes its share of the run cap is stopped and the listing refused (definitive, not an abstain)', async () => {
  // Caps small enough to drive with a fake: a 9 s run leaves each suite run about (6 s - 3(P + B)) / 9.
  const caps = { ...CLASS_HARD_LIMITS, buildSeconds: 3, runSeconds: 9 };
  const sb = listingSandbox({ suite: [async () => { await delay(1500); return { exitCode: 0, stdout: vaultSuite(1) }; }] });
  const r = await runListing(sb, listingBody(), { caps });
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(codes(r), ['LISTING_TOO_HEAVY']);
  assert.match(r.facts.listing.refusals[0].detail, /suite run 1 ran past/);
  assert.equal(r.facts.listing.limits, null);
  assert.equal(sb.execs().filter((d) => d.kind === 'vcr-poc').length, 0);
  // The suite step was stopped by its own limit, and the sandbox removed.
  const step = r.steps.find((s) => s.name === 'suite:1');
  assert.equal(step.cause, 'step_timeout');
  assert.ok(sb.docker.callsOf('rm').length >= 1);
});

test('too heavy, measured: a build that passes its share of the caps is stopped and the listing refused', async () => {
  const caps = { ...CLASS_HARD_LIMITS, buildSeconds: 1, runSeconds: 360 };
  const sb = listingSandbox({ scripts: { 'vcr-build': async () => { await delay(1200); return { exitCode: 0 }; } } });
  const r = await runListing(sb, listingBody(), { caps });
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(codes(r), ['LISTING_TOO_HEAVY']);
  assert.match(r.facts.listing.refusals[0].detail, /the build ran past 0\.333 s/);
  assert.equal(sb.execs().filter((d) => d.kind === 'vcr-suite').length, 0);
});

// ----------------------------------------------------- 3. the harness proof

test('harness proof: the trivially failing test fails as an assertion on all three runs; the broken ones are errors (compile, setUp)', async () => {
  const sb = listingSandbox();
  const r = await runListing(sb);
  assert.equal(r.facts.listing.status, 'accepted', show(r));
  const { harness } = r.facts.listing;
  assert.equal(harness.path, 'test/VerdiktaHarness.t.sol');
  assert.deepEqual(harness.probes.map((p) => [p.name, p.variant, p.verdict]), [
    ['fails', 'forge-std', 'assertion'],
    ['compileError', null, 'no_junit'],
    ['setUpError', null, 'harness_error']
  ]);
  const fails = harness.probes[0];
  assert.equal(fails.test, 'test/VerdiktaHarness.t.sol > VerdiktaHarnessFails > test_verdiktaHarnessFails()');
  // Put in place and judged by the claim pipeline's own gates: applies, testPathsOnly, build, reproduces on three runs.
  for (const g of ['applies', 'testPathsOnly', 'build', 'reproduces']) assert.equal(fails.gates[g].status, 'pass', `${g}: ${JSON.stringify(fails.gates[g])}`);
  assert.match(fails.gates.reproduces.detail, /failed as an assertion on all 3 runs/);
  assert.equal(harness.probes[1].gates.reproduces.status, 'fail');
  assert.equal(harness.probes[1].run1.junit, 'absent');
  assert.deepEqual(harness.probes[2].run1.harnessErrors.map((h) => [h.suite, h.name]), [['test/VerdiktaHarness.t.sol:VerdiktaHarnessSetUpError', 'setUp()']]);
  // testFiles ran each probe's file ($FILES) with the reporter flags; three runs for the failing test, one for each broken one.
  const pocs = sb.execs().filter((d) => d.kind === 'vcr-poc');
  assert.equal(pocs.length, 5);
  for (const p of pocs) {
    assert.ok(p.argv.includes('--match-path=test/VerdiktaHarness.t.sol') || p.argv.some((a) => a.startsWith('--match-test=')), JSON.stringify(p.argv));
    assert.deepEqual(p.argv.slice(-3), ['--junit', '--fuzz-seed', FORGE_FUZZ_SEED]);
  }
  // The compile probe goes straight to testFiles: no build between its apply and its run.
  const seq = kinds(sb);
  const applies = seq.reduce((a, k, i) => (k === 'git apply' ? [...a, i] : a), []);
  assert.equal(applies.length, 3);
  assert.equal(seq.slice(applies[1], applies[2]).filter((k) => k === 'vcr-build').length, 0);
});

/** The container a docker exec ran in. */
const containerOf = (call) => call.args.find((a) => /^vcr-[0-9a-f]{16}-[0-9]+$/.test(a));

test('harness proof: every probe runs as a claim does, in a fresh sandbox of its own, the previous one removed first (R1-F2)', async () => {
  const sb = listingSandbox({ forgeStd: 'none' });
  const r = await runListing(sb);
  assert.equal(r.facts.listing.status, 'accepted', show(r));
  // The measurement's sandbox, then one per probe (forge-std, plain, compile, setUp).
  const creates = sb.docker.callsOf('create').map((c) => c.args[c.args.indexOf('--name') + 1]);
  assert.deepEqual(creates, [1, 2, 3, 4, 5].map((n) => `vcr-0123456789abcdef-${n}`));
  // Never two at once: each sandbox is removed before the next is created.
  const order = sb.docker.calls.filter((c) => c.args[0] === 'create' || c.args[0] === 'rm').map((c) => (c.args[0] === 'create' ? `create ${c.args[c.args.indexOf('--name') + 1]}` : `rm ${c.args[c.args.length - 1]}`));
  for (let n = 1; n < 5; n += 1) {
    assert.ok(order.indexOf(`rm vcr-0123456789abcdef-${n}`) < order.indexOf(`create vcr-0123456789abcdef-${n + 1}`), order.join(', '));
  }
  // Every one with the same flags (the claim's).
  const flags = sb.docker.callsOf('create').map((c) => isolationOf(c.args));
  for (const f of flags) assert.deepEqual(f, flags[0]);
  // In each probe's sandbox the forced checkout comes first, then the probe's patch: the claim pipeline from its start.
  for (let n = 2; n <= 5; n += 1) {
    const name = `vcr-0123456789abcdef-${n}`;
    const execs = sb.docker.callsOf('exec').filter((c) => containerOf(c) === name).map(decode)
      .filter((d) => d.kind && d.argv[3] !== 'vcr-probe' && d.argv[3] !== 'vcr-launcher-check');
    const ks = execs.map((d) => (d.kind === 'git' ? `git ${d.sub[0]}` : d.kind));
    assert.deepEqual(ks.slice(0, 4), ['vcr-procs', 'git init', 'git init', 'vcr-stage'], name);
    assert.equal(ks.filter((k) => k === 'git apply').length, 1, name);
    assert.equal(ks.includes('vcr-suite'), false, `${name}: no suite run in a probe's sandbox`);
  }
});

test('harness proof: what the suite leaves behind cannot make a probe pass (a prerequisite only commands.test creates)', async () => {
  // commands.test leaves a file in its sandbox that testFiles needs; a claim's sandbox never ran commands.test.
  const ready = new Set();
  const suite = [1, 2, 3].map((k) => (d) => { ready.add(d.container); return { exitCode: 1, stdout: vaultSuite(k) }; });
  const needsReady = (inner) => (d, repo, p) => (ready.has(d.container) ? inner(d, repo, p) : { exitCode: 1, stdout: '', stderr: 'missing /tmp/suite-ready\n' });
  const ok = (d, repo, p) => ({ exitCode: 1, stdout: junitOf([{ suite: `${p}:VerdiktaHarnessFails`, cases: [{ name: 'test_verdiktaHarnessFails()', failure: 'x: 1 != 2' }] }]) });
  const sb = listingSandbox({ suite, probeRun: { failsForgeStd: needsReady(ok), failsPlain: needsReady(ok) } });
  const r = await runListing(sb);
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(codes(r), ['HARNESS_ASSERTION_NOT_REPORTED'], show(r));
});

test('harness proof without forge-std: the trivially failing test falls back to a plain revert', async () => {
  const r = await runListing(listingSandbox({ forgeStd: 'none' }));
  assert.equal(r.facts.listing.status, 'accepted', show(r));
  assert.deepEqual(r.facts.listing.harness.probes.map((p) => [p.name, p.variant, p.verdict]), [
    ['fails', 'forge-std', 'not_run'],
    ['fails', 'plain', 'assertion'],
    ['compileError', null, 'no_junit'],
    ['setUpError', null, 'harness_error']
  ]);
});

test('harness proof: legacy, non-reverting assertions (a failure without a reason is an error) refuse the listing', async () => {
  const sb = listingSandbox({ forgeStd: 'legacy' });
  const r = await runListing(sb);
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(codes(r), ['LEGACY_ASSERTIONS']);
  assert.match(r.facts.listing.refusals[0].detail, /do not revert/);
  assert.deepEqual(r.facts.listing.harness.probes.map((p) => p.verdict), ['not_assertion']);
  // The claim's fixed schedule (three runs once run 1 found the test), and no probe after the refusal.
  assert.equal(sb.execs().filter((d) => d.kind === 'vcr-poc').length, 3);
  assert.equal(sb.applied() && sb.applied().includes('VerdiktaHarnessCompileError'), false);
});

test('harness proof: a testFiles that does not run the PoC\'s files cannot host claims', async () => {
  // forge's JUnit, but only of the maker's suite: the probe's test never ran.
  const r = await runListing(listingSandbox({ probeRun: { failsForgeStd: () => ({ exitCode: 0, stdout: vaultSuite(1) }), failsPlain: () => ({ exitCode: 0, stdout: vaultSuite(1) }) } }));
  assert.deepEqual(codes(r), ['HARNESS_ASSERTION_NOT_REPORTED']);
  assert.match(r.facts.listing.refusals[0].detail, /no test the patch added ran on run 1/);
});

test('harness proof: a trivially failing test that is not an assertion failure on every run (flaky) is refused', async () => {
  let n = 0;
  const flaky = (d, repo, p) => {
    n += 1;
    return { exitCode: n === 2 ? 0 : 1, stdout: junitOf([{ suite: `${p}:VerdiktaHarnessFails`, cases: [{ name: 'test_verdiktaHarnessFails()', ...(n === 2 ? {} : { failure: 'x: 1 != 2' }) }] }]) };
  };
  const r = await runListing(listingSandbox({ probeRun: { failsForgeStd: flaky } }));
  assert.deepEqual(codes(r), ['HARNESS_ASSERTION_NOT_REPORTED']);
  assert.match(r.facts.listing.refusals[0].detail, /passed on run 2/);
});

test('harness proof: a compile error that still yields readable JUnit, or a setUp failure the JUnit does not report, refuses the listing', async () => {
  const compile = await runListing(listingSandbox({ probeRun: { compileError: () => ({ exitCode: 1, stdout: junitOf([]) }) } }));
  assert.deepEqual(codes(compile), ['HARNESS_ERROR_NOT_REPORTED']);
  assert.match(compile.facts.listing.refusals[0].detail, /does not compile/);
  const setUp = await runListing(listingSandbox({
    probeRun: { setUpError: (d, repo, p) => ({ exitCode: 0, stdout: junitOf([{ suite: `${p}:VerdiktaHarnessSetUpError`, cases: [{ name: 'test_verdiktaHarnessSetUpError()' }] }]) }) }
  }));
  assert.deepEqual(codes(setUp), ['HARNESS_ERROR_NOT_REPORTED']);
  assert.match(setUp.facts.listing.refusals[0].detail, /setUp\(\) reverts/);
});

test('harness proof: the probes go under paths.tests, never under paths.protected or onto a tracked file', () => {
  const spec = (tests, prot = []) => ({ paths: { tests, protected: prot } });
  assert.equal(harnessPath(spec(['test/**']), []), 'test/VerdiktaHarness.t.sol');
  assert.equal(harnessPath(spec(['test/**/*.t.sol']), []), 'test/VerdiktaHarness.t.sol');
  // forge's test directory first, where a glob allows it: not the root, where forge compiles no test.
  assert.equal(harnessPath(spec(['**/*.t.sol']), []), 'test/VerdiktaHarness.t.sol');
  assert.equal(harnessPath(spec(['**']), []), 'test/VerdiktaHarness.t.sol');
  assert.equal(harnessPath(spec(['tests/**']), []), 'tests/VerdiktaHarness.t.sol');
  assert.equal(harnessPath(spec(['test/*/Exploit*.sol']), []), 'test/VerdiktaHarness/ExploitVerdiktaHarness.sol');
  // A name the repository already uses: the same with a number (R1-F3), up to 9.
  assert.equal(harnessPath(spec(['test/poc/**']), ['test/poc/VerdiktaHarness.t.sol']), 'test/poc/VerdiktaHarness2.t.sol');
  assert.equal(harnessPath(spec(['test/**'], ['test/VerdiktaHarness.t.sol']), []), 'test/VerdiktaHarness2.t.sol', 'that one name protected');
  const taken = ['', ...[2, 3, 4, 5, 6, 7, 8, 9]].map((n) => `test/VerdiktaHarness${n}.t.sol`);
  assert.equal(harnessPath(spec(['test/**']), taken), null, 'all nine taken');
  assert.equal(harnessPath(spec(['test/**']), taken.slice(0, 5)), 'test/VerdiktaHarness6.t.sol');
  assert.equal(harnessPath(spec(['test/**'], ['test/**']), []), null, 'protected');
  assert.equal(harnessPath(spec(['test/Exploit.t.sol']), []), 'test/Exploit.t.sol', 'a literal path is the one place a PoC may go');
  assert.equal(harnessPath(spec(['test/Exploit.t.sol']), ['test/Exploit.t.sol']), null);
  assert.equal(harnessPath(spec(['docs/**', 'test/**']), ['docs/VerdiktaHarness.t.sol']), 'test/VerdiktaHarness.t.sol', 'the next glob');
  // Only plain characters: the path goes into the probe's patch header.
  assert.equal(harnessPath(spec(['te st/**']), []), null);
  assert.equal(harnessPath(spec(['test\n+++ b/src/Vault.sol/**']), []), null);
  assert.deepEqual(probeCandidates('test/**'), ['test/VerdiktaHarness.t.sol']);
  // Where the suite's own tests ran comes first (R5-F1): foundry.toml's test directory, whatever it is called.
  assert.equal(harnessPath(spec(['**/*.t.sol']), [], { suiteFiles: ['tests/Vault.t.sol', 'tests/Oracle.t.sol', 'tests/unit/A.t.sol'] }), 'tests/VerdiktaHarness.t.sol');
  assert.equal(harnessPath(spec(['**/*.t.sol']), [], { suiteFiles: ['b/X.t.sol', 'a/Y.t.sol'] }), 'a/VerdiktaHarness.t.sol', 'a tie: code-unit order');
  assert.equal(harnessPath(spec(['test/**']), [], { suiteFiles: ['tests/Vault.t.sol'] }), 'test/VerdiktaHarness.t.sol', 'still under paths.tests');
  assert.equal(harnessPath(spec(['**/*.t.sol']), [], { suiteFiles: ['Root.t.sol'] }), 'test/VerdiktaHarness.t.sol', 'a file at the root names no directory');
  // Taken there: the numbered names in that directory before any fallback directory.
  assert.equal(harnessPath(spec(['**/*.t.sol']), ['tests/VerdiktaHarness.t.sol'], { suiteFiles: ['tests/Vault.t.sol'] }), 'tests/VerdiktaHarness2.t.sol');
  assert.equal(harnessPath(spec(['**/*.t.sol'], ['tests/VerdiktaHarness.t.sol']), [], { suiteFiles: ['tests/Vault.t.sol'] }), 'tests/VerdiktaHarness2.t.sol', 'protected there');
});

test('harness proof: no free path under paths.tests refuses the listing', async () => {
  const r = await runListing(listingSandbox(), listingBody({ spec: { paths: { tests: ['test/Vault.t.sol'], protected: [] } } }));
  assert.deepEqual(codes(r), ['HARNESS_NO_PATH']);
});

test('harness proof: a probe that does not finish within the default limits refuses the listing', async () => {
  const r = await runListing(listingSandbox({ probeRun: { failsForgeStd: () => never() } }));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(codes(r), ['HARNESS_TOO_SLOW']);
  assert.match(r.facts.listing.refusals[0].detail, /harness:fails:forge-std:poc:1 ran past/);
});

test('harness proof: a probe whose steps each fit their limits but whose whole run, from its launch, passes runSeconds is refused (R3-F1)', async () => {
  // The measurement is fast (defaults: buildSeconds 1, testSeconds 1, runSeconds 3 or 4); each probe sandbox takes
  // 0.9 s to prepare, 0.9 s to build and 0.9 s a run: every step inside its own limit, the probe's run about 4.5 s.
  let first = null;
  let sb = null;
  const slowInProbe = (answer) => async (d) => {
    const c = containerOf(sb.docker.calls[sb.docker.calls.length - 1]);
    first = first || c;
    if (c !== first) await delay(900);
    return answer(d);
  };
  const fail = (d, repo, p) => ({ exitCode: 1, stdout: junitOf([{ suite: `${p}:VerdiktaHarnessFails`, cases: [{ name: 'test_verdiktaHarnessFails()', failure: 'x: 1 != 2' }] }]) });
  sb = listingSandbox({
    scripts: { 'vcr-stage': slowInProbe(() => ({ stdout: 'vcr-git-entries 2\n' })) },
    build: (d, kind) => (kind === null ? { exitCode: 0 } : delay(900).then(() => ({ exitCode: 0 }))),
    probeRun: { failsForgeStd: (d, repo, p) => delay(900).then(() => fail(d, repo, p)) }
  });
  const r = await runListing(sb);
  assert.equal(r.outcome, 'definitive', show(r));
  assert.ok(r.facts.listing.limits.runSeconds <= 4 && r.facts.listing.limits.testSeconds === 1, JSON.stringify(r.facts.listing.limits));
  assert.deepEqual(codes(r), ['HARNESS_TOO_SLOW'], show(r));
  assert.match(r.facts.listing.refusals[0].detail, /stopped at runSeconds [34]: the probe's run, from its launch, did not fit/);
  // No step passed its own limit: the probe's runSeconds stopped it.
  for (const st of r.steps.filter((x) => x.name.startsWith('harness:') && x.outcome === 'definitive')) assert.ok(st.durationMs < 1000, st.name);
});

test('the probes without forge-std compile with any solc from 0.4.22 (revert reasons); the forge-std one needs forge-std\'s own 0.6.2 (R3-F2)', () => {
  assert.ok(PROBES.failsForgeStd.lines.includes('pragma solidity >=0.6.2;'));
  for (const p of [PROBES.failsPlain, PROBES.compileError, PROBES.setUpError]) assert.ok(p.lines.includes('pragma solidity >=0.4.22;'), p.name);
});

// ----------------------------- 4. the same isolation, limits and deadline rules

test('the check runs under the class\'s limits, the spec\'s lower cpus and memory, and its own budget as runSeconds', () => {
  const v = validateListingRequest(listingBody({ spec: { limits: { cpus: 1, memoryMb: 1024, maxPatchBytes: 1000 } } }));
  assert.ok(v.ok, JSON.stringify(v.issues));
  assert.deepEqual(v.limits, {
    cpus: 1, memoryMb: 1024, pids: CLASS_HARD_LIMITS.pids, buildSeconds: 90, testSeconds: 360, runSeconds: LISTING_CHECK_SECONDS,
    maxPatchBytes: 1000, patchExpansionBytes: CLASS_HARD_LIMITS.patchExpansionBytes, platform: 'linux/amd64'
  });
  assert.equal(LISTING_CHECK_SECONDS, 720);
  assert.equal(v.request.unpackedBytes, CLASS_HARD_LIMITS.imageUnpackedBytes, 'the pull is admitted for the class maximum');
  // A draft's size is not attested: whatever it declares, the pull reserves the class maximum (R1-F1).
  for (const unpackedBytes of [1, 1400000000]) {
    const declared = validateListingRequest(listingBody({ spec: { env: { from: 'foundry', image: IMAGE, platform: 'linux/amd64', unpackedBytes } } }));
    assert.ok(declared.ok);
    assert.equal(declared.request.unpackedBytes, CLASS_HARD_LIMITS.imageUnpackedBytes);
  }
});

test('a listing check is a requester error before any work for the same spec problems /v1/runs refuses', () => {
  const v = (over) => validateListingRequest(listingBody(over));
  const c = (r) => r.issues.map((i) => `${i.code} ${i.path}`);
  assert.deepEqual(c(v({ spec: { limits: { runSeconds: 361 } } })), ['LIMIT_ABOVE_CLASS_MAX /spec/limits/runSeconds']);
  assert.deepEqual(c(v({ spec: { limits: { cpus: 4 } } })), ['LIMIT_ABOVE_CLASS_MAX /spec/limits/cpus']);
  assert.deepEqual(c(v({ spec: { env: { from: 'foundry', platform: 'linux/arm64' } } })), ['PLATFORM_NOT_ALLOWED /spec/env/platform']);
  assert.deepEqual(c(v({ spec: { env: { from: 'foundry', unpackedBytes: 7000000000 } } })), ['IMAGE_ABOVE_CLASS_MAX /spec/env/unpackedBytes']);
  assert.deepEqual(c(v({ spec: { env: { from: 'node22' } } })), ['ENV_UNSUPPORTED /spec/env/from']);
  assert.deepEqual(c(v({ spec: { env: { from: 'foundry', image: IMAGE.replace('aaaa', 'bbbb') } } })), ['IMAGE_MISMATCH /spec/env/image']);
  assert.deepEqual(c(v({ spec: { commands: { test: undefined } } })), ['COMMAND_MISSING /spec/commands/test']);
  assert.deepEqual(c(v({ spec: { commands: { testFiles: 'forge test' } } })), ['COMMAND_PLACEHOLDER /spec/commands/testFiles']);
  assert.deepEqual(c(v({ spec: { commands: { framework: 'pytest' } } })), ['FRAMEWORK_UNSUPPORTED /spec/commands/framework']);
  assert.deepEqual(c(v({ body: { image: 'ghcr.io/verdikta/stake-env:latest' } })), ['SCHEMA /image']);
  assert.deepEqual(c(v({ body: { image: undefined } })), ['REQUIRED /image']);
  assert.deepEqual(c(v({ body: { deadline: 900001 } })), ['SCHEMA /deadline']);
  assert.deepEqual(c(v({ body: { deadline: 0 } })), ['SCHEMA /deadline']);
  assert.deepEqual(c(validateListingRequest([])), ['SCHEMA /']);
});

test('the run\'s own budget and the deadline abstain, as for /v1/runs (only a measured step\'s own limit refuses)', async () => {
  // The check's budget (runSeconds) ends while the build is still running: the run's limit, not the build's.
  const budget = await runListing(listingSandbox({ scripts: { 'vcr-build': () => never() } }), listingBody(), { limitsOver: { runSeconds: 1 } });
  assert.equal(budget.outcome, 'abstain');
  assert.equal(budget.abstain.cause, 'step_timeout');
  assert.match(budget.abstain.detail, /the run reached its wall-clock limit/);
  assert.equal(budget.facts.listing, undefined, 'no listing summary from a run that abstained');
  // The deadline (less the reserve) ends the run the same way it ends a claim's.
  const reserve = testConfig().deadlineReserveMs;
  const late = await runListing(listingSandbox({ scripts: { 'vcr-build': () => never() } }), listingBody(), { deadlineMs: reserve + 600 });
  assert.equal(late.outcome, 'abstain');
  assert.equal(late.abstain.cause, 'deadline');
  // Any other limit event in a step abstains too: an OOM-killed suite run is not a refusal.
  const oom = await runListing(listingSandbox({ suite: [() => ({ exitCode: 137, stdout: '' })] }));
  assert.equal(oom.outcome, 'abstain');
  assert.equal(oom.abstain.cause, 'oom');
});

// -------------------------------------------------------------- over HTTP

async function start(sb, config = testConfig()) {
  const runner = createServer({ config, docker: sb.docker, log: silent, statfs, meminfo });
  const address = await runner.listen();
  return { runner, target: { host: address.host, port: address.port }, config };
}

/** A container's create argv without what names one run (its name, run labels, keepalive). */
function isolationOf(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--name' || args[i] === '--label') { i += 1; continue; }
    out.push(args[i]);
  }
  return out.slice(0, -1);
}

test('POST /v1/listing-checks: 200 with the listing; the sandbox is created exactly as a claim run\'s (no network, read-only, no capabilities)', async (t) => {
  const sb = listingSandbox();
  const { runner, target } = await start(sb);
  t.after(() => runner.close());
  const res = await request(target, { method: 'POST', path: '/v1/listing-checks', body: listingBody() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.outcome, 'definitive');
  assert.equal(res.body.kind, 'listing-check');
  assert.match(res.body.checkId, /^[0-9a-f]{16}$/);
  assert.equal(res.body.listing.status, 'accepted', JSON.stringify(res.body.listing.refusals));
  assert.equal(res.body.listing.baseline.stable.length, 2);
  assert.equal(res.body.limits.runSeconds, LISTING_CHECK_SECONDS);
  assert.equal(res.body.image.cache, 'hit', 'through the image cache (A1b), as a run');
  // Never a claim's shape.
  for (const key of ['gates', 'facts', 'report', 'reportSha256', 'contextPack']) assert.equal(key in res.body, false, key);

  const listingCreate = sb.docker.callsOf('create')[0].args;
  for (const flag of [['--network', 'none'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges'], ['--pull', 'never'], ['--ipc', 'none']]) {
    const i = listingCreate.indexOf(flag[0]);
    assert.ok(i >= 0 && listingCreate[i + 1] === flag[1], flag.join(' '));
  }
  assert.ok(listingCreate.includes('--read-only'));
  // A claim run against the same image and limits gets the same container.
  const claim = claimSandbox();
  const s2 = await start(claim);
  t.after(() => s2.runner.close());
  const claimSpec = { ...spec({ baseCommit: BASE, commands: COMMANDS }) };
  const baseline = { version: 1, baseCommit: BASE, framework: 'forge', runs: 3, tests: [{ id: 'test/Vault.t.sol > VaultTest > test_deposit()', results: ['pass', 'pass', 'pass'] }], stable: ['test/Vault.t.sol > VaultTest > test_deposit()'], unstable: [] };
  const run = await request(s2.target, { method: 'POST', path: '/v1/runs', body: runRequest({ spec: claimSpec, baseline }) });
  assert.equal(run.status, 200, JSON.stringify(run.body.abstain || run.body.issues));
  assert.deepEqual(isolationOf(listingCreate), isolationOf(claim.docker.callsOf('create')[0].args));
});

test('review focus: no claim field reaches a listing check (400 before any Docker call), and /v1/runs does not take a listing check', async (t) => {
  const sb = listingSandbox();
  const { runner, target } = await start(sb);
  t.after(() => runner.close());
  const claimFields = ['listingCid', 'bcid', 'attestation', 'pocPatch', 'fixPatch', 'baseline', 'finding', 'report', 'knownIssues', 'priorFindings', 'eaGates'];
  const claimBody = runRequest();
  for (const f of claimFields) {
    const res = await request(target, { method: 'POST', path: '/v1/listing-checks', body: { ...listingBody(), [f]: claimBody[f] } });
    assert.equal(res.status, 400, f);
    assert.deepEqual(res.body.issues.map((i) => `${i.code} ${i.path}`), [`UNKNOWN_FIELD /${f}`]);
  }
  assert.deepEqual(LISTING_FIELDS, ['spec', 'image', 'deadline']);
  const asRun = await request(target, { method: 'POST', path: '/v1/runs', body: listingBody() });
  assert.equal(asRun.status, 400);
  assert.ok(asRun.body.issues.some((i) => i.code === 'UNKNOWN_FIELD' && i.path === '/image'));
  assert.equal(sb.docker.calls.length, 0, 'nothing reached Docker');
});

test('review focus: the only patches a listing check applies are the runner\'s own probes, and it records no claim gate', async () => {
  const sb = listingSandbox({ forgeStd: 'none' });
  const r = await runListing(sb);
  assert.equal(r.facts.listing.status, 'accepted', show(r));
  const probeAt = r.facts.listing.harness.path;
  const allowed = [PROBES.failsForgeStd, PROBES.failsPlain, PROBES.compileError, PROBES.setUpError].map((p) => probePatch(probeAt, p.lines).toString('utf8'));
  const applied = sb.execs().filter((d) => d.kind === 'git' && d.sub[0] === 'apply').map((d) => d.stdin.toString('utf8'));
  assert.equal(applied.length, 4);
  for (const a of applied) assert.ok(allowed.includes(a), a);
  assert.deepEqual(r.gates, {}, 'the claim functions gate into the probes\' own scope, never the run');
  assert.deepEqual(Object.keys(r.facts), ['listing']);
});

test('over HTTP: a deadline that cannot cover the check\'s budget, and the maintenance lock, abstain at admission (503)', async (t) => {
  const sb = listingSandbox();
  const config = testConfig();
  const { runner, target } = await start(sb, config);
  t.after(() => runner.close());
  const short = await request(target, { method: 'POST', path: '/v1/listing-checks', body: listingBody({ body: { deadline: 700000 } }) });
  assert.equal(short.status, 503);
  assert.equal(short.body.abstain.cause, 'admission_refused');
  assert.match(short.body.abstain.detail, /the run may need 720000 ms/);
  fs.mkdirSync(path.dirname(config.maintenanceFile), { recursive: true });
  fs.writeFileSync(config.maintenanceFile, '');
  const locked = await request(target, { method: 'POST', path: '/v1/listing-checks', body: listingBody() });
  assert.equal(locked.status, 503);
  assert.equal(locked.body.abstain.cause, 'admission_refused');
  assert.match(locked.body.abstain.detail, /maintenance lock/);
  assert.equal(sb.docker.callsOf('create').length, 0);
});

test('over HTTP: a draft that understates its image size cannot admit a cold pull the disk has no room for (R1-F1)', async (t) => {
  const sb = listingSandbox({
    handlers: { image: (args) => (args[1] === 'inspect' ? { exitCode: 1, stderr: 'Error response from daemon: No such image\n' } : { stdout: '' }) }
  });
  // 7.5 GB free: room for the 1-byte image the draft declares, not for the class maximum the pull reserves.
  const config = testConfig();
  const runner = createServer({ config, docker: sb.docker, log: silent, statfs: async () => ({ bavail: 7500000000 / 4096, bsize: 4096 }), meminfo });
  const address = await runner.listen();
  t.after(() => runner.close());
  const target = { host: address.host, port: address.port };
  const body = listingBody({ spec: { env: { from: 'foundry', unpackedBytes: 1 } } });
  const res = await request(target, { method: 'POST', path: '/v1/listing-checks', body });
  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.equal(res.body.abstain.cause, 'admission_refused');
  assert.equal(res.body.abstain.step, 'pull');
  assert.match(res.body.abstain.detail, /6000000000 unpacked/);
  assert.equal(sb.docker.callsOf('pull').length, 0, 'no pull began');
  assert.equal(sb.docker.callsOf('create').length, 0);
});

test('over HTTP: wrong method 405, wrong type 415, bad JSON 400, a requester error the steps find is a 400 with the check id', async (t) => {
  const sb = listingSandbox({ freeBytes: 1024 });
  const { runner, target } = await start(sb);
  t.after(() => runner.close());
  assert.equal((await request(target, { path: '/v1/listing-checks' })).status, 405);
  assert.equal((await request(target, { method: 'POST', path: '/v1/listing-checks', body: 'x', headers: { 'content-type': 'text/plain' } })).status, 415);
  const bad = await request(target, { method: 'POST', path: '/v1/listing-checks', body: '{nope' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.issues[0].code, 'INVALID_JSON');
  const full = await request(target, { method: 'POST', path: '/v1/listing-checks', body: listingBody() });
  assert.equal(full.status, 400);
  assert.equal(full.body.kind, 'listing-check');
  assert.match(full.body.checkId, /^[0-9a-f]{16}$/);
  assert.deepEqual(full.body.issues.map((i) => i.code), ['IMAGE_WORKDIR_FULL']);
});
