'use strict';

// Node A3b, the Verification Report (design §9.3, §9.4): validated by common,
// every input digest recorded, hashed with common's canonicalisation, and the
// determinism rules of the PR's design section (R1-R9, N1) held by force or by
// measurement. The fixtures here drive the run engine with a fake forge; the
// same fixtures against real forge are in test/docker/report.docker.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { codeReview } = require('@verdikta/common');
const { buildReport, attestationSha256, ReportUnavailable, SCHEDULE_DISAGREED } = require('../../src/report');
const { RUNNER_VERSION } = require('../../src/version');
const { BASE, POC_PATCH, FIX_PATCH, junit, drainFails, claimSandbox, suitePasses } = require('../helpers/fakeClaim');
const { DRAIN, IMAGE, claimRequest, finding, runClaim } = require('../helpers/claimRun');
const { settlementFacts } = require('../helpers/settlementFacts');

const CLASS = 'linux/amd64';
const PINNED = codeReview.GVISOR_RELEASE;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const built = (r, request, over = {}) => buildReport(r, request, { gvisor: PINNED, platform: CLASS, ...over });
const show = (r) => JSON.stringify({ outcome: r.outcome, abstain: r.abstain, issues: r.issues, gates: r.gates }, null, 1);

const SUITE = 'test/Exploit.t.sol:ExploitTest';
const one = (message, name = 'test_drain()') => junit([{ suite: SUITE, cases: [{ name, failure: message }] }]);
const passes = (name = 'test_drain()') => junit([{ suite: SUITE, cases: [{ name }] }]);

// ------------------------------------------- acceptance 1: valid, every digest, common's hash

test('the report validates against verdikta.claim-report/1 and records every input digest', async () => {
  const request = claimRequest();
  const r = await runClaim(claimSandbox(), request);
  assert.equal(r.outcome, 'definitive', show(r));
  const { report, sha256: hash, warnings } = built(r, request);
  const checked = codeReview.validateClaimReport(report);
  assert.equal(checked.ok, true, JSON.stringify(checked.issues));
  assert.deepEqual(warnings, [], 'nothing about this report is off the pins');
  assert.deepEqual(report.inputs, {
    listingCid: request.listingCid,
    bcid: request.bcid,
    envImage: IMAGE.slice(IMAGE.indexOf('@') + 1),
    platform: CLASS,
    attestationSha256: sha256(codeReview.canonicalJson(request.attestation)),
    baseCommit: BASE,
    pocPatchSha256: sha256(Buffer.from(POC_PATCH)),
    fixPatchSha256: null,
    runner: RUNNER_VERSION,
    gvisor: PINNED,
    semgrepRules: codeReview.SEMGREP_RULES_VERSION,
    eaGates: { disclosure: 'pass', inScope: 'pass' }
  });
  assert.equal(hash, codeReview.reportSha256(report), 'common\'s canonicalisation, nothing of the runner\'s');
  assert.equal(attestationSha256(request.attestation), report.inputs.attestationSha256);
});

test('the fix patch\'s digest and diff are recorded with it, and the report holds only the schema\'s fix fields', async () => {
  const fixPatch = Buffer.from(FIX_PATCH);
  const request = claimRequest({ fixPatch });
  const r = await runClaim(claimSandbox(), request);
  const { report } = built(r, request);
  assert.equal(report.inputs.fixPatchSha256, sha256(fixPatch));
  assert.equal(report.fix.present, true);
  assert.deepEqual(Object.keys(report.fix).sort(), ['applies', 'builds', 'integrity', 'pocPasses', 'present', 'regressionCount', 'regressions', 'tier']);
  assert.ok(report.diff.fix && Number.isInteger(report.diff.fix.files), 'diff.fix is set exactly when fix.present');
});

test('the report is the canonical form: JSON.parse(canonicalReportJson) of itself, ready to hash again unchanged', async () => {
  const request = claimRequest();
  const r = await runClaim(claimSandbox(), request);
  const { report, sha256: hash } = built(r, request);
  assert.equal(JSON.stringify(report), codeReview.canonicalReportJson(report));
  assert.equal(codeReview.reportSha256(JSON.parse(JSON.stringify(report))), hash);
});

test('R1: nothing the schema lacks reaches the report: no duration, run id, container, step, poc.runs or detail', async () => {
  const request = claimRequest();
  const r = await runClaim(claimSandbox(), request);
  const text = JSON.stringify(built(r, request).report);
  for (const word of ['durationMs', 'runId', 'vcr-', 'stdout', '"runs":[{', 'harnessErrors', 'exitCode', 'basis', 'detail', 'frameworkReferences', 'binaryFiles', 'expansionBytes', r.runId]) {
    assert.ok(!text.includes(word), `the report holds ${word}`);
  }
  assert.ok(r.facts.poc.runs, 'the operational facts keep them');
});

test('a claim that stops at each gate still makes one valid report', async () => {
  const cases = [
    ['applies', claimSandbox({ git: { 'apply --index': () => ({ exitCode: 1, stderr: 'error: patch failed\n' }) } })],
    ['testPathsOnly', claimSandbox({ git: { 'diff --name-status': () => ({ stdout: Buffer.from('M\0src/Vault.sol\0') }) } })],
    ['build', claimSandbox({ scripts: { 'vcr-build': () => ({ exitCode: 1 }) } })]
  ];
  for (const [gate, sb] of cases) {
    const request = claimRequest();
    const r = await runClaim(sb, request);
    assert.equal(r.gates[gate].status, 'fail', show(r));
    const { report } = built(r, request);
    assert.equal(report.gates[gate], 'fail');
    assert.equal(report.poc, null);
    assert.deepEqual(report.diff.poc, gate === 'applies' ? { files: 0, added: 0, removed: 0 } : report.diff.poc);
    assert.equal(codeReview.validateClaimReport(report).ok, true);
  }
});

test('R5: a run on another platform has no report; the schema\'s platform would be false', async () => {
  const request = claimRequest();
  const r = await runClaim(claimSandbox(), request);
  assert.throws(() => buildReport(r, request, { gvisor: 'runc', platform: 'linux/arm64' }), ReportUnavailable);
});

test('the runtime is what was measured: runc in local mode, with common\'s warning, never the pin', async () => {
  const request = claimRequest();
  const r = await runClaim(claimSandbox(), request);
  const { report, warnings } = built(r, request, { gvisor: 'runc' });
  assert.equal(report.inputs.gvisor, 'runc');
  assert.deepEqual(warnings.map((w) => w.code), ['REPORT_RUNTIME_NOT_PINNED']);
});

// ------------------------------------------- R6: messages

test('R6: a message identical on all three runs is kept', async () => {
  const request = claimRequest();
  const r = await runClaim(claimSandbox(), request);
  const { report } = built(r, request);
  assert.deepEqual(report.poc.tests, [{ id: DRAIN, runs: ['fail', 'fail', 'fail'], kind: 'assertion', message: 'vault drained' }]);
});

test('R6: a message that moves between runs is null in the report, and only that test\'s; facts keep what forge said', async () => {
  const suite = (t) => junit([{ suite: SUITE, cases: [{ name: 'test_clock()', failure: String(t) }, { name: 'test_drain()', failure: 'vault drained' }] }]);
  const request = claimRequest();
  const r = await runClaim(claimSandbox({ poc: [suite(1793666340302), suite(1793666341310), suite(1793666342318)] }), request);
  const { report } = built(r, request);
  const by = Object.fromEntries(report.poc.tests.map((t) => [t.id.split(' > ').pop(), t]));
  assert.equal(by['test_clock()'].message, null);
  assert.deepEqual(by['test_clock()'].runs, ['fail', 'fail', 'fail'], 'the results stand');
  assert.equal(by['test_clock()'].kind, 'assertion');
  assert.equal(by['test_drain()'].message, 'vault drained');
  assert.equal(report.gates.reproduces, 'pass', 'a message decides nothing here');
  assert.equal(r.facts.poc.tests.find((t) => t.id.endsWith('test_clock()')).message, '1793666340302');
});

// ------------------------------------------- N1: a flaky pattern

test('N1: a test whose results disagree is reported as error on all three runs, whichever run passed', async () => {
  const request = claimRequest();
  const fast = await runClaim(claimSandbox({ poc: [one('even'), passes(), one('even')] }), request);
  const slow = await runClaim(claimSandbox({ poc: [passes(), one('even'), passes()] }), request);
  for (const r of [fast, slow]) assert.equal(r.gates.reproduces.status, 'fail', show(r));
  const a = built(fast, request);
  const b = built(slow, request);
  assert.deepEqual(a.report.poc.tests, [{ id: DRAIN, runs: ['error', 'error', 'error'], kind: 'error', message: SCHEDULE_DISAGREED }]);
  assert.deepEqual(a.report.poc.runCounts, { fail: 0, pass: 0, error: 3, skip: 0, missing: 0, duplicate: 0, notRun: 0 });
  assert.equal(a.sha256, b.sha256);
  assert.deepEqual(fast.facts.poc.tests[0].runs, ['fail', 'pass', 'fail'], 'facts keep what each run did');
  assert.deepEqual(slow.facts.poc.tests[0].runs, ['pass', 'fail', 'pass']);
});

test('N1 changes nothing A4b reads: a flaky PoC still fails reproduces on its own, with clean integrity', async () => {
  const r = await runClaim(claimSandbox({ poc: [one('even'), passes(), one('even')] }));
  const read = settlementFacts(r);
  assert.deepEqual(read, { valid: true, issues: [], integrity: 'pass', tampered: false, failedChecks: [], reproduces: 'fail', reproducesFailed: 'on-its-own' });
});

test('N1 stays out of the identity results: a skipped record keeps its run, and integrity fails as before', async () => {
  const skipped = junit([{ suite: SUITE, cases: [{ name: 'test_drain()', skipped: true }] }]);
  const request = claimRequest();
  const r = await runClaim(claimSandbox({ poc: [one('x'), skipped, one('x')] }), request);
  const { report } = built(r, request);
  assert.deepEqual(report.poc.tests[0].runs, ['fail', 'skip', 'fail']);
  assert.equal(report.gates.integrity, 'fail');
  assert.equal(report.poc.integrity.identityComplete, false);
});

test('N1 covers runCounts past the 200 tests the report lists: the counts of a flaky test #201 cannot tell the hosts apart', async () => {
  const names = Array.from({ length: 201 }, (_, i) => `test_${String(i).padStart(3, '0')}()`);
  const suite = (flakyFails) => junit([{ suite: SUITE, cases: names.map((name, i) => (i === 200 && !flakyFails ? { name } : { name, failure: 'x' })) }]);
  const request = claimRequest();
  const a = await runClaim(claimSandbox({ poc: [suite(true), suite(false), suite(true)] }), request);
  const b = await runClaim(claimSandbox({ poc: [suite(false), suite(true), suite(false)] }), request);
  assert.equal(built(a, request).sha256, built(b, request).sha256);
  assert.equal(built(a, request).report.poc.tests.length, 200);
  assert.equal(built(a, request).report.poc.runCounts.error, 3);
  assert.equal(built(a, request).report.poc.runCounts.fail, 600);
});

// ------------------------------------------- R7: a hunter cannot make a report invalid

test('R7: a test id over the schema\'s bound still makes a valid report, the same on every host, and two such ids stay apart', async () => {
  // forge's name fits the JUnit reader's 1,024; with the file and the contract the id does not fit the report's.
  const long = (c) => `test_${c.repeat(1000)}()`;
  const suite = junit([{ suite: SUITE, cases: [{ name: long('a'), failure: 'x' }, { name: long('b'), failure: 'x' }] }]);
  const request = claimRequest();
  const r = await runClaim(claimSandbox({ poc: [suite, suite, suite] }), request);
  const { report, sha256: hash } = built(r, request);
  assert.equal(codeReview.validateClaimReport(report).ok, true);
  assert.equal(report.poc.tests.length, 2);
  assert.notEqual(report.poc.tests[0].id, report.poc.tests[1].id);
  for (const t of report.poc.tests) assert.ok(t.id.length <= 1024);
  assert.equal(built(r, request).sha256, hash);
  assert.equal(r.gates.reproduces.status, 'pass', 'the long ids are still the tests that reproduced');
});

test('R7: what the JUnit reader refuses (a control character, a surrogate) reads as no test, and still makes a valid report', async () => {
  for (const suite of [junit([{ suite: SUITE, cases: [{ name: 'test_x(&#1;)', failure: 'x' }] }]), one('lone &#xD83D; surrogate')]) {
    const request = claimRequest();
    const r = await runClaim(claimSandbox({ poc: [suite, suite, suite] }), request);
    assert.equal(r.outcome, 'definitive', show(r));
    assert.equal(r.gates.reproduces.status, 'fail');
    const { report } = built(r, request);
    assert.equal(report.poc.testCount, 0);
    assert.equal(codeReview.validateClaimReport(report).ok, true);
  }
});

test('R7: a message cut at the bound keeps whole characters, and still hashes', async () => {
  const request = claimRequest();
  const s = one(`${'a'.repeat(1999)}😀tail`);
  const r = await runClaim(claimSandbox({ poc: [s, s, s] }), request);
  assert.equal(r.outcome, 'definitive', show(r));
  const { report, sha256: hash } = built(r, request);
  assert.equal(codeReview.validateClaimReport(report).ok, true);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(report.poc.tests[0].message, 'a'.repeat(1999));
});

test('R7: more tamper flags, paths and tests than the schema holds stay within its bounds, in canonical order', async () => {
  const lines = Array.from({ length: 150 }, () => '+vm.writeFile("foundry.toml", "x");').join('\n');
  const patch = [
    'diff --git a/test/Exploit.t.sol b/test/Exploit.t.sol', 'new file mode 100644', '--- /dev/null', '+++ b/test/Exploit.t.sol',
    '@@ -0,0 +1,150 @@', lines, ''
  ].join('\n');
  const addedDiff = patch.replace('--- /dev/null', 'index 0000000..95fbe20\n--- /dev/null');
  const request = claimRequest({ pocPatch: Buffer.from(patch) });
  const r = await runClaim(claimSandbox({ diff: addedDiff }), request);
  const { report } = built(r, request);
  assert.equal(codeReview.validateClaimReport(report).ok, true);
  assert.ok(report.poc.integrity.tamperFlags.length <= 100);
});

// ------------------------------------------- attack: report-hash determinism

test('attack: forge listing the tests in another order, with other durations and timestamps, changes nothing', async () => {
  const request = claimRequest();
  const cases = [{ name: 'test_a()', failure: 'a' }, { name: 'test_b()', failure: 'b' }, { name: 'test_c()', failure: 'c' }];
  const fwd = junit([{ suite: SUITE, cases }]);
  const rev = junit([{ suite: SUITE, cases: [...cases].reverse() }]).replace(/time="[^"]*"/g, 'time="9.999"').replace(/timestamp="[^"]*"/, 'timestamp="2031-01-01T00:00:00.000+00:00"');
  const a = await runClaim(claimSandbox({ poc: [fwd, fwd, fwd] }), request);
  const b = await runClaim(claimSandbox({ poc: [rev, rev, rev] }), request);
  assert.equal(built(a, request).sha256, built(b, request).sha256);
});

test('attack: the report does not change with what the run records for operators: run id, steps, durations, image cache', async () => {
  const request = claimRequest();
  const r = await runClaim(claimSandbox(), request);
  const hash = built(r, request).sha256;
  const other = {
    ...r, runId: 'ffffffffffffffff', steps: [], image: { ref: 'x', cache: 'pulled', durationMs: 99 },
    gates: Object.fromEntries(Object.entries(r.gates).map(([k, v]) => [k, { ...v, detail: `${v.detail} on another host at another time` }])),
    facts: { ...r.facts, checkout: { other: true }, leftoverProcesses: { tier: 'A', steps: [{ after: 'build', killed: 3 }] }, integrity: { tier: 'A', poc: null, fix: null } }
  };
  assert.equal(built(other, request).sha256, hash);
});

test('attack: the runtime and the patch move the hash, so the hash means what it says', async () => {
  const request = claimRequest();
  const r = await runClaim(claimSandbox(), request);
  assert.notEqual(built(r, request, { gvisor: 'runc' }).sha256, built(r, request).sha256);
  assert.notEqual(built(r, { ...request, pocPatch: Buffer.from('other') }).sha256, built(r, request).sha256);
  assert.notEqual(built(r, { ...request, attestation: { version: 2 } }).sha256, built(r, request).sha256);
});

test('attack: a message a run\'s harness failure replaced is held to the same rule, and a flaky harness folds', async () => {
  const withHarness = (msg) => junit([{ suite: SUITE, cases: [{ name: 'setUp()', failure: msg }, { name: 'test_drain()', failure: 'x' }] }]);
  const request = claimRequest();
  const a = await runClaim(claimSandbox({ poc: [one('x'), withHarness('setUp 1'), one('x')] }), request);
  const b = await runClaim(claimSandbox({ poc: [withHarness('setUp 2'), one('x'), one('x')] }), request);
  for (const r of [a, b]) assert.equal(codeReview.validateClaimReport(built(r, request).report).ok, true, show(r));
  assert.deepEqual(built(a, request).report.poc.tests[0].runs, ['error', 'error', 'error']);
});

// ------------------------------------------- the three fixtures, on a fake forge (real forge: the Docker suite)

/** Two hosts' JUnit for one run: what forge varies by host (times, timestamps) and what the PoC prints. */
function hostJUnit(message, { time, stamp }) {
  return one(message).replace(/time="[^"]*"/g, `time="${time}"`).replace(/timestamp="[^"]*"/, `timestamp="${stamp}"`).replace(/finished in [^<]*/g, `finished in ${time}s (${time}s CPU time)`);
}

test('time-dependent-poc-two-hosts: a test that reads the clock, on a fast and a slow host, gives the identical verdict and report hash', async () => {
  const request = claimRequest();
  const fast = await runClaim(claimSandbox({
    poc: [1, 2, 3].map((n) => hostJUnit(`clock ${1793666340000 + n}`, { time: '0.001', stamp: `2026-11-03T00:47:0${n}.000+00:00` }))
  }), request);
  const slow = await runClaim(claimSandbox({
    poc: [1, 2, 3].map((n) => hostJUnit(`clock ${1793666999000 + n * 3}`, { time: '0.300', stamp: `2026-11-04T09:00:0${n}.000+00:00` }))
  }), request);
  for (const g of ['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity']) assert.equal(fast.gates[g].status, slow.gates[g].status, g);
  assert.notEqual(fast.facts.poc.tests[0].message, slow.facts.poc.tests[0].message, 'the clocks did differ');
  assert.equal(built(fast, request).sha256, built(slow, request).sha256);
  assert.equal(built(fast, request).report.poc.tests[0].message, null);
});

test('randomness-dependent-poc-two-hosts: a test that prints an unseeded random value, on two hosts, gives the identical verdict and report hash', async () => {
  const request = claimRequest();
  const rnd = () => crypto.randomBytes(8).toString('hex');
  const a = await runClaim(claimSandbox({ poc: [one(rnd()), one(rnd()), one(rnd())] }), request);
  const b = await runClaim(claimSandbox({ poc: [one(rnd()), one(rnd()), one(rnd())] }), request);
  assert.equal(a.gates.reproduces.status, b.gates.reproduces.status);
  assert.equal(built(a, request).sha256, built(b, request).sha256);
});

test('flaky-poc-two-schedules: a PoC that alternates on a fast and a slow schedule settles the same on both, with the identical report hash', async () => {
  const request = claimRequest();
  const fast = await runClaim(claimSandbox({ poc: [one('flip'), passes(), one('flip')] }), request);
  const slow = await runClaim(claimSandbox({ poc: [passes(), one('flip'), passes()] }), request);
  for (const r of [fast, slow]) {
    assert.equal(r.gates.reproduces.status, 'fail', show(r));
    assert.equal(settlementFacts(r).reproducesFailed, 'on-its-own');
  }
  assert.equal(built(fast, request).sha256, built(slow, request).sha256);
});

test('the fix check\'s facts are carried as they are: pocPasses and regressions in the report, suite and checkout not', async () => {
  const fixPatch = Buffer.from(FIX_PATCH);
  const request = claimRequest({ fixPatch });
  const r = await runClaim(claimSandbox({ fix: { suite: suitePasses({ deposit: { failure: 'y' } }) } }), request);
  const { report } = built(r, request);
  assert.equal(report.fix.pocPasses, true);
  assert.deepEqual(report.fix.regressions, ['test/Vault.t.sol > VaultTest > test_deposit()']);
  assert.equal(report.fix.regressionCount, 1);
  assert.ok(!JSON.stringify(report.fix).includes('checkout'));
});

test('drainFails keeps its meaning for the helper A4b mirrors: a clean claim reads as passing', async () => {
  const read = settlementFacts(await runClaim(claimSandbox({ poc: [drainFails(), drainFails(), drainFails()] }), claimRequest({ finding: finding() })));
  assert.equal(read.valid, true);
  assert.equal(read.reproduces, 'pass');
  assert.equal(read.reproducesFailed, null);
});
