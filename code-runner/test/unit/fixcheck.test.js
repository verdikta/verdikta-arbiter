'use strict';

// Node A3a: the fix check (design §9.2 step 8, §20 decision 14) through the
// run engine against the fake env image: a second sandbox, admitted with
// the PoC's, applies poc.patch and fix.patch (source allowed; tests and
// protected paths not; binary changes refused host-side), builds, runs the
// maker's full suite once, and records `fix` — never a gate. Real forge in
// test/docker/integrity.docker.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeRun } = require('../../src/pipeline');
const { checkSpec } = require('../../src/classLimits');
const { claimSteps } = require('../../src/steps');
const { Capacity } = require('../../src/admission');
const { createServer } = require('../../src/server');
const { FORGE_FUZZ_SEED } = require('../../src/common');
const { testConfig, request: httpRequest } = require('../helpers/http');
const { spec: baseSpec, IMAGE, runRequest } = require('../helpers/requests');
const { fakeDocker, healthyDaemon } = require('../helpers/fakeDocker');
const { BASE, POC_PATCH, FIX_PATCH, junit, drainFails, suitePasses, claimSandbox } = require('../helpers/fakeClaim');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const STABLE = 'test/Vault.t.sol > VaultTest > test_deposit()';

function forgeSpec(over = {}) {
  return baseSpec({
    baseCommit: BASE,
    commands: { framework: 'forge', build: 'forge build', test: 'forge test', testFiles: 'forge test --match-path $FILES', testIds: 'forge test --match-test $TEST_IDS', ...(over.commands || {}) },
    paths: over.paths || { tests: ['test/**'], protected: ['foundry.toml', 'lib/**'] },
    limits: { cpus: 1, memoryMb: 512, buildSeconds: 30, testSeconds: 60, runSeconds: 300, maxPatchBytes: 2000000 }
  });
}

function claimRequest(over = {}) {
  return {
    listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    bcid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    spec: over.spec || forgeSpec(),
    attestation: {},
    pocPatch: Buffer.from(POC_PATCH),
    fixPatch: over.fixPatch === undefined ? Buffer.from(FIX_PATCH) : over.fixPatch,
    baseline: { version: 1, baseCommit: BASE, framework: 'forge', runs: 3, tests: [{ id: STABLE, results: ['pass', 'pass', 'pass'] }], stable: [STABLE], unstable: [] },
    finding: { version: 1, claimedClass: 'HIGH', rootCause: 'x'.repeat(30), affectedPaths: ['src/Vault.sol'], poc: { command: 'forge test --match-test test_drain', observable: 'test_drain fails with "vault drained"' } },
    report: '',
    knownIssues: [],
    priorFindings: [],
    eaGates: { disclosure: 'pass', inScope: 'pass' },
    deadlineMs: 700000
  };
}

async function runClaim(sb, request = claimRequest(), { sandboxes = request.fixPatch ? 2 : 1 } = {}) {
  const lim = checkSpec(request.spec);
  assert.ok(lim.ok, JSON.stringify(lim.issues));
  const receivedAt = Date.now();
  return executeRun({
    docker: sb.docker, config: testConfig(), limits: lim.limits, image: IMAGE, runId: '0123456789abcdef',
    steps: claimSteps(request, lim.limits), receivedAt, deadlineAt: receivedAt + 700000, active: new Set(), log: silent,
    admit: async () => {}, sandboxes
  });
}

const show = (r) => JSON.stringify({ outcome: r.outcome, abstain: r.abstain, issues: r.issues, gates: r.gates, fix: r.facts && r.facts.fix && { ...r.facts.fix, checkout: undefined } }, null, 1);
const label = (d) => (d.kind === 'git' ? `git ${d.sub[0]}` : d.kind);
const CLEAN = Object.freeze({
  identityComplete: true, summaryConsistent: true, exitConsistent: true,
  protectedPathsUnchanged: true, frameworkUnchanged: true, dependenciesUnchanged: true, tamperFlags: []
});
const CLAIM_GATES = ['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable'];

/** The report's fix fields, as facts.fix carries them. */
const fixFields = (f) => ({ present: f.present, applies: f.applies, builds: f.builds, pocPasses: f.pocPasses, regressions: f.regressions, regressionCount: f.regressionCount, tier: f.tier, integrity: f.integrity });

test('fix check: in a second sandbox, fix.patch applies (source allowed), builds, the PoC passes and no stable test regresses; recorded, never a gate', async () => {
  const sb = claimSandbox();
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(fixFields(r.facts.fix), {
    present: true, applies: 'pass', builds: 'pass', pocPasses: true, regressions: [], regressionCount: 0, tier: 'B', integrity: CLEAN
  });
  // Never a gate: the claim's gates are the six of §10.1, decided as without a fix.
  assert.deepEqual(Object.keys(r.gates).sort(), [...CLAIM_GATES].sort());
  for (const g of CLAIM_GATES) assert.equal(r.gates[g].status, 'pass', g);
  // A second container: its own forced checkout, poc.patch and fix.patch applied and committed, the build, the suite once.
  const fixOrder = sb.fixExecs().map(label);
  assert.equal(fixOrder[0], 'vcr-procs');
  const applies = sb.fixExecs().filter((d) => d.kind === 'git' && d.sub[0] === 'apply');
  assert.deepEqual(applies.map((d) => d.stdin.toString()), [POC_PATCH, FIX_PATCH], 'the PoC, then the fix on top of it');
  assert.deepEqual(sb.fixExecs().filter((d) => d.kind === 'git' && d.sub[0] === 'commit').map((d) => d.sub[d.sub.length - 1]), ['poc.patch', 'fix.patch']);
  const tail = fixOrder.slice(fixOrder.lastIndexOf('git rev-parse') + 1);
  assert.deepEqual(tail, ['vcr-framework', 'forge-config', 'vcr-external-roots', 'vcr-manifest', 'vcr-build', 'vcr-cleanup', 'vcr-suite', 'vcr-cleanup', 'vcr-manifest', 'vcr-external-roots', 'vcr-framework', 'forge-config']);
  const [suite] = sb.fixExecs().filter((d) => d.kind === 'vcr-suite');
  // commands.test with the reporter flags, run as forge's argv (attempt 3).
  assert.deepEqual(suite.argv, ['/usr/local/bin/forge', 'test', '--junit', '--fuzz-seed', FORGE_FUZZ_SEED], 'commands.test with the reporter flags');
  assert.equal(suite.fixedEnv.FOUNDRY_FUZZ_SEED, FORGE_FUZZ_SEED);
  // Exec names say which sandbox they ran in.
  assert.ok(r.steps.some((s) => s.name === 'fix:suite'), r.steps.map((s) => s.name).join(' '));
  assert.ok(r.steps.some((s) => s.name === 'fix:build'));
  // The fix's own patch facts, tier A.
  assert.equal(r.facts.fix.patch.sha256, require('node:crypto').createHash('sha256').update(FIX_PATCH).digest('hex'));
  assert.deepEqual({ ...r.facts.fix.diff }, { tier: 'A', files: 1, added: 1, removed: 1, binaryFiles: 0, applied: true });
});

test('fix check: fix.pocPasses = false when the PoC still fails with the fix; the claim\'s outcome is unaffected', async () => {
  const sb = claimSandbox({ fix: { suite: suitePasses({ poc: { failure: 'vault drained' } }) } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.facts.fix.pocPasses, false);
  assert.deepEqual(r.facts.fix.regressions, []);
  assert.equal(r.facts.fix.builds, 'pass');
  assert.deepEqual(r.facts.fix.integrity, CLEAN);
  for (const g of CLAIM_GATES) assert.equal(r.gates[g].status, 'pass', g);
});

test('fix check: a stable baseline test that fails with the fix is a regression (counted, listed in code-unit order)', async () => {
  const sb = claimSandbox({ fix: { suite: suitePasses({ deposit: { failure: 'deposit broke' } }) } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.facts.fix.pocPasses, true);
  assert.deepEqual(r.facts.fix.regressions, [STABLE]);
  assert.equal(r.facts.fix.regressionCount, 1);
  for (const g of CLAIM_GATES) assert.equal(r.gates[g].status, 'pass', g);
  // A stable test the suite no longer reports (its setUp now fails) regresses too, and is an identity gap.
  const gone = junit([
    { suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()' }] },
    { suite: 'test/Vault.t.sol:VaultTest', cases: [{ name: 'setUp()', failure: 'cannot deploy' }] }
  ]);
  const r2 = await runClaim(claimSandbox({ fix: { suite: gone } }));
  assert.deepEqual(r2.facts.fix.regressions, [STABLE]);
  assert.equal(r2.facts.fix.integrity.identityComplete, false);
  assert.match(r2.facts.integrity.fix.failures[0].detail, /test\/Vault\.t\.sol > VaultTest > test_deposit\(\) has no record/);
});

test('fix check: a fix that touches paths.tests or a protected path does not apply, and nothing is built', async () => {
  for (const [nameStatus, re] of [['M\0test/Vault.t.sol\0', /test\/Vault\.t\.sol under paths\.tests/], ['M\0foundry.toml\0', /foundry\.toml under paths\.protected/], ['A\0src/a b.sol\0', /cannot be named in a report/]]) {
    const sb = claimSandbox({ fix: { nameStatus } });
    const r = await runClaim(sb);
    assert.equal(r.outcome, 'definitive', show(r));
    assert.deepEqual(fixFields(r.facts.fix), { present: true, applies: 'fail', builds: 'not-run', pocPasses: null, regressions: [], regressionCount: 0, tier: 'B', integrity: null });
    assert.match(r.facts.fix.detail.applies, re);
    assert.ok(!sb.fixExecs().some((d) => d.kind === 'vcr-build'), 'no fixed build');
    for (const g of CLAIM_GATES) assert.equal(r.gates[g].status, 'pass', g);
  }
  // git refusing the fix: applies fails with git's reason.
  const r = await runClaim(claimSandbox({ fix: { applyExit: 1 } }));
  assert.equal(r.facts.fix.applies, 'fail');
  assert.match(r.facts.fix.detail.applies, /fix\.patch does not apply .*patch failed: src\/Vault\.sol:1/);
});

test('fix check: binary changes, renames and copies in fix.patch are refused host-side (the proposed rule), before git sees it', async () => {
  const cases = [
    [['diff --git a/src/logo.png b/src/logo.png', 'new file mode 100644', 'index 0000000..1111111', 'GIT binary patch', 'literal 3', 'IcmZPo000310RR91', '', ''], /fix\.patch makes a binary change/],
    [['diff --git a/src/A.sol b/src/B.sol', 'similarity index 100%', 'rename from src/A.sol', 'rename to src/B.sol', ''], /fix\.patch renames a file/],
    [['diff --git a/src/A.sol b/src/C.sol', 'copy from src/A.sol', 'copy to src/C.sol', ''], /fix\.patch copies a file/]
  ];
  for (const [lines, re] of cases) {
    const fixPatch = Buffer.from(lines.join('\n'));
    const sb = claimSandbox({ fix: { patch: fixPatch } });
    const r = await runClaim(sb, claimRequest({ fixPatch }));
    assert.equal(r.outcome, 'definitive', show(r));
    assert.equal(r.facts.fix.applies, 'fail');
    assert.equal(r.facts.fix.builds, 'not-run');
    assert.match(r.facts.fix.detail.applies, re);
    const applied = sb.fixExecs().filter((d) => d.kind === 'git' && d.sub[0] === 'apply').map((d) => d.stdin.toString());
    assert.deepEqual(applied, [POC_PATCH], 'git never saw fix.patch');
    // The report still gets the patch's hash and a diff object (zeros: never applied).
    assert.equal(r.facts.fix.patch.sha256, require('node:crypto').createHash('sha256').update(fixPatch).digest('hex'));
    assert.deepEqual(r.facts.fix.diff, { tier: 'A', files: 0, added: 0, removed: 0, binaryFiles: 0, applied: false });
  }
});

test('R6-F1: a fix whose patch applied is always built: builds is pass or fail, never not-run; a failed build sets nothing else', async () => {
  const sb = claimSandbox({ fix: { build: () => ({ exitCode: 1, stderr: 'Error: Compiler run failed\n' }) } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(fixFields(r.facts.fix), { present: true, applies: 'pass', builds: 'fail', pocPasses: null, regressions: [], regressionCount: 0, tier: 'B', integrity: null });
  assert.ok(!sb.fixExecs().some((d) => d.kind === 'vcr-suite'));
  // Every outcome the fix check can record keeps the report's one form.
  for (const f of [r.facts.fix]) if (f.applies === 'pass') assert.notEqual(f.builds, 'not-run');
});

test('fix check: no fix.patch, no second sandbox; the fix facts take their not-run values', async () => {
  const sb = claimSandbox();
  const r = await runClaim(sb, claimRequest({ fixPatch: null }));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(sb.fixExecs(), []);
  assert.deepEqual(fixFields(r.facts.fix), { present: false, applies: 'not-run', builds: 'not-run', pocPasses: null, regressions: [], regressionCount: 0, tier: 'B', integrity: null });
});

test('fix check: its evidence has the integrity checks too: a PoC that tampers during the suite run leaves fix.integrity failed (the claim is unaffected)', async () => {
  const suite = (d, k, box) => { box.tree.set('/work/lib/forge-std/src/Test.sol', { type: 'f', mode: '644', content: '// patched' }); return { exitCode: 0, stdout: suitePasses() }; };
  const r = await runClaim(claimSandbox({ fix: { suite } }));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.facts.fix.pocPasses, true, 'recorded as observed');
  assert.equal(r.facts.fix.integrity.dependenciesUnchanged, false);
  assert.equal(r.facts.fix.integrity.frameworkUnchanged, false);
  for (const g of CLAIM_GATES) assert.equal(r.gates[g].status, 'pass', g);
  // A suite that exits 0 while it reports a failure, or prints no summary, is not consistent either.
  const odd = () => ({ exitCode: 0, stdout: suitePasses({ deposit: { failure: 'x' } }) });
  const r2 = await runClaim(claimSandbox({ fix: { suite: odd } }));
  assert.equal(r2.facts.fix.integrity.exitConsistent, false);
});

test('fix check: a limit hit in the fix sandbox abstains the run (an informational fact is still a definitive one)', async () => {
  const sb = claimSandbox({ fix: { suite: () => ({ exitCode: 137 }) } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'abstain', show(r));
  assert.equal(r.abstain.cause, 'oom');
  assert.equal(r.abstain.step, 'fix:suite');
});

test('fix check: it runs beside the PoC (both sandboxes live at once), and the run waits for it', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // The fix's build waits until the PoC's third run has started: only parallel sandboxes get there.
  const sb = claimSandbox({
    fix: { build: async () => { await gate; return { exitCode: 0 }; } },
    poc: [drainFails(), drainFails(), () => { release(); return { exitCode: 1, stdout: drainFails() }; }]
  });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.facts.fix.builds, 'pass');
  assert.equal(r.facts.fix.pocPasses, true);
});

test('fix check: a fix.patch needs commands.test (the full suite); without it the request is the requester\'s', async () => {
  const s = forgeSpec();
  delete s.commands.test;
  const r = await runClaim(claimSandbox(), claimRequest({ spec: s }));
  assert.equal(r.outcome, 'requester_error');
  assert.deepEqual(r.issues.map((i) => [i.code, i.path]), [['COMMAND_MISSING', '/spec/commands/test']]);
});

// ------------------------------------------------------- admission (A1b's note)

test('admission: a run with fix.patch is admitted for two sandboxes\' memory; a run may not open more sandboxes than it was admitted for', async () => {
  const config = { ...testConfig(), slots: 2, memoryReserveMb: { chainlink: 100, postgres: 0, aiNode: 0, localModel: 0 } };
  const capacity = new Capacity({ config, meminfo: async () => ({ availableMb: 1200, error: null }) });
  const limits = { memoryMb: 512, runSeconds: 10 };
  const docker = fakeDocker(healthyDaemon());
  const stopAt = Date.now() + 600000;
  const one = await capacity.admit({ docker, limits, stopAt, sandboxes: 1, exists: () => false });
  assert.equal(capacity.committedMb(), 512);
  one.release();
  const two = await capacity.admit({ docker, limits, stopAt, sandboxes: 2, exists: () => false });
  assert.equal(capacity.committedMb(), 1024, 'both sandboxes\' limits are held');
  two.release();
  // 1200 - 2 x 512 leaves 176 MiB: above the 100 MiB reserve; 3 x 512 would not fit.
  await assert.rejects(capacity.admit({ docker, limits, stopAt, sandboxes: 3, exists: () => false }), /may use 1536 MiB/);

  // The engine refuses a second sandbox a run was not admitted for.
  const steps = [async (ctx) => { await ctx.openSandbox(); }];
  const lim = checkSpec(forgeSpec()).limits;
  const receivedAt = Date.now();
  const r = await executeRun({ docker, config: testConfig(), limits: lim, image: IMAGE, runId: '0123456789abcdef', steps, receivedAt, deadlineAt: receivedAt + 600000, active: new Set(), log: silent, admit: async () => {} });
  assert.equal(r.outcome, 'abstain');
  assert.equal(r.abstain.cause, 'runner_error');
  assert.match(r.abstain.detail, /admitted for 1 sandbox/);
});

test('admission through the server: POST /v1/runs with fix.patch asks for two sandboxes\' memory', async (t) => {
  const seen = [];
  const config = testConfig();
  const runner = createServer({ config, docker: fakeDocker(healthyDaemon()), log: silent, statfs: async () => ({ bavail: 1e12, bsize: 1 }), meminfo: async () => ({ availableMb: 1e6, error: null }), stepsFor: () => [async (ctx) => { seen.push(ctx.limits.memoryMb); }] });
  const admitted = [];
  const admit = runner.capacity.admit.bind(runner.capacity);
  runner.capacity.admit = (o) => { admitted.push(o.sandboxes); return admit(o); };
  const address = await runner.listen();
  t.after(() => runner.close());
  for (const fixPatch of [null, Buffer.from(FIX_PATCH).toString('base64')]) {
    const res = await httpRequest({ host: address.host, port: address.port }, { method: 'POST', path: '/v1/runs', body: runRequest({ fixPatch }) });
    assert.equal(res.status, 200, res.raw);
  }
  assert.deepEqual(admitted, [1, 2]);
  assert.deepEqual(seen, [4096, 4096], 'each sandbox keeps the spec\'s own memory limit');
});

// ------------------------------------------------------------------- round 1

test('A3a R1-F1: the fix run is held to the tests the PoC\'s run 1 added: a PoC suite whose setUp now fails is a gap, not a pass', async () => {
  const two = junit([
    { suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()', failure: 'vault drained' }] },
    { suite: 'test/Exploit.t.sol:ExploitTwo', cases: [{ name: 'test_two()', failure: 'vault drained twice' }] }
  ]);
  const suite = junit([
    { suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()' }] },
    { suite: 'test/Exploit.t.sol:ExploitTwo', cases: [{ name: 'setUp()', failure: 'cannot deploy with the fix' }] },
    { suite: 'test/Vault.t.sol:VaultTest', cases: [{ name: 'test_deposit()' }] }
  ]);
  const r = await runClaim(claimSandbox({ poc: [two, two, two], fix: { suite } }));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.reproduces.status, 'pass');
  assert.equal(r.facts.fix.pocPasses, false, 'test_two() never ran with the fix');
  assert.equal(r.facts.fix.integrity.identityComplete, false);
  const detail = r.facts.integrity.fix.failures.find((f) => f.check === 'identityComplete').detail;
  assert.match(detail, /test\/Exploit\.t\.sol > ExploitTwo > test_two\(\) has no record/);
  assert.match(detail, /setUp\(\) failed in test\/Exploit\.t\.sol:ExploitTwo: its tests did not run/);
  assert.deepEqual(r.facts.fix.suite.pocTests.map((t) => [t.id.split(' > ')[1], t.result]), [['ExploitTest', 'pass'], ['ExploitTwo', 'missing']]);
});

test('A3a R1-F2: fix.patch paths are matched by their own (UTF-8) names: a protected src/café.sol is refused', async () => {
  const spec = forgeSpec({ paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', 'src/café.sol'] } });
  const r = await runClaim(claimSandbox({ fix: { nameStatus: 'M\0src/café.sol\0', numstat: '1\t1\tsrc/café.sol\0' } }), claimRequest({ spec }));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.facts.fix.applies, 'fail');
  assert.match(r.facts.fix.detail.applies, /src\/café\.sol under paths\.protected/);
  // A test directory with a non-ASCII name is matched the same way.
  const spec2 = forgeSpec({ paths: { tests: ['test/**', 'tést/**'], protected: ['foundry.toml'] } });
  const r2 = await runClaim(claimSandbox({ fix: { nameStatus: 'M\0tést/A.t.sol\0', numstat: '1\t1\ttést/A.t.sol\0' } }), claimRequest({ spec: spec2 }));
  assert.match(r2.facts.fix.detail.applies, /tést\/A\.t\.sol under paths\.tests/);
});

test('A3a R4-F2: a fix that leaves forge\'s configuration unreadable is a failed fixed build, not the requester\'s error; through the HTTP API the claim\'s gates stand', async (t) => {
  const { forgeConfig } = require('../helpers/fakeClaim');
  // foundry.toml is not protected in this listing, so the fix may change it; with the fix, `forge config` fails.
  const spec = forgeSpec({ paths: { tests: ['test/**'], protected: ['lib/**'] } });
  const framework = (d, box) => (box.n === 2 && box.fixCommitted
    ? { exitCode: 1, stdout: 'vcr-forge /usr/local/bin/forge\nvcr-path /usr/bin\n', stderr: 'Error: failed to parse foundry.toml: invalid TOML\n' }
    : { stdout: `vcr-forge /usr/local/bin/forge\nvcr-path /usr/bin\n${forgeConfig(box.tree)}` });
  const fix = { nameStatus: 'M\0foundry.toml\0', numstat: '1\t1\tfoundry.toml\0' };
  const r = await runClaim(claimSandbox({ fix, scripts: { 'vcr-framework': framework } }), claimRequest({ spec }));
  assert.equal(r.outcome, 'definitive', show(r));
  for (const g of CLAIM_GATES) assert.equal(r.gates[g].status, 'pass', g);
  assert.deepEqual(fixFields(r.facts.fix), { present: true, applies: 'pass', builds: 'fail', pocPasses: null, regressions: [], regressionCount: 0, tier: 'B', integrity: null });
  assert.match(r.facts.fix.detail.builds, /^with the fix, FORGE_CONFIG_INVALID: .*failed to parse foundry\.toml/);

  // The same claim over HTTP: 200, the PoC's results, the fix recorded.
  const { attestationFor } = require('../helpers/requests');
  const sb = claimSandbox({ fix, scripts: { 'vcr-framework': framework } });
  const runner = createServer({ config: testConfig(), docker: sb.docker, log: silent, statfs: async () => ({ bavail: 1e12, bsize: 1 }), meminfo: async () => ({ availableMb: 1e6, error: null }) });
  const address = await runner.listen();
  t.after(() => runner.close());
  const req = claimRequest({ spec });
  const body = {
    listingCid: req.listingCid, bcid: req.bcid, spec, attestation: attestationFor(spec), pocPatch: req.pocPatch.toString('base64'),
    fixPatch: req.fixPatch.toString('base64'), baseline: req.baseline, finding: req.finding, report: '# x\n', knownIssues: [], priorFindings: [],
    eaGates: req.eaGates, deadline: 700000
  };
  const res = await httpRequest({ host: address.host, port: address.port }, { method: 'POST', path: '/v1/runs', body });
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.gates.reproduces.status, 'pass');
  assert.equal(res.body.facts.fix.builds, 'fail');
});
