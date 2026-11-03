'use strict';

// Node A3b at the route: POST /v1/runs answers a definitive run with the
// report, its hash and the pack; an abstaining one with none of them; and the
// request's own documents are refused before any work, so a report can never
// fail on what the requester sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const { codeReview } = require('@verdikta/common');
const { createServer } = require('../../src/server');
const { testConfig, request: httpRequest } = require('../helpers/http');
const { attestationFor, IMAGE } = require('../helpers/requests');
const { claimSandbox, POC_PATCH, BASE } = require('../helpers/fakeClaim');
const { forgeSpec, finding, DEPOSIT } = require('../helpers/claimRun');
const { imageInspect } = require('../helpers/fakeDocker');

function body(over = {}) {
  const spec = forgeSpec();
  return {
    listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    bcid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    spec,
    attestation: attestationFor(spec),
    pocPatch: Buffer.from(POC_PATCH).toString('base64'),
    fixPatch: null,
    baseline: { version: 1, baseCommit: BASE, framework: 'forge', runs: 3, tests: [{ id: DEPOSIT, results: ['pass', 'pass', 'pass'] }], stable: [DEPOSIT], unstable: [] },
    finding: finding(),
    report: '# Reentrancy\n',
    knownIssues: [],
    priorFindings: [],
    eaGates: { disclosure: 'pass', inScope: 'pass' },
    deadline: 700000,
    ...over
  };
}

async function serve(t, sb, { env = {}, options = {} } = {}) {
  const config = testConfig(env);
  const logged = [];
  const log = { info: (m, o) => logged.push([m, o]), warn() {}, error() {}, debug() {} };
  const srv = createServer({ config, docker: sb.docker, log, meminfo: async () => ({ availableMb: 100000, error: null }), statfs: async () => ({ bavail: 1e12, bsize: 1 }), ...options });
  const target = await srv.listen();
  t.after(() => srv.close());
  return { target, logged };
}

const post = (target, b) => httpRequest(target, { method: 'POST', path: '/v1/runs', body: b });

test('a definitive answer carries the report, its hash and the pack, ready for the EA\'s request to the AI Node', async (t) => {
  const { target, logged } = await serve(t, claimSandbox());
  const res = await post(target, body());
  assert.equal(res.status, 200, res.raw.slice(0, 500));
  const { report, reportSha256, contextPack, runner } = res.body;
  assert.equal(codeReview.validateClaimReport(report).ok, true);
  assert.equal(reportSha256, codeReview.reportSha256(report));
  assert.equal(report.inputs.gvisor, 'runc', 'local mode, as measured');
  assert.equal(runner.gvisor, 'runc');
  assert.equal(contextPack.budgetTokens, 60000);
  assert.ok(contextPack.files.length >= 3);

  // A4b's seam: what the AI Node validates on receipt.
  const checked = codeReview.validateCodeReviewRequest({
    version: 1, codeClass: 'code-standard', deadlineMs: 400000, report, reportSha256,
    claim: { bcid: report.inputs.bcid, finding: finding() }, knownIssues: [], priorFindings: [], dispute: null
  });
  assert.equal(checked.ok, true, JSON.stringify(checked.issues));

  const line = logged.find(([m]) => m === 'run finished')[1];
  assert.equal(line.reportSha256, reportSha256, 'the hash is logged (§9.3)');
  assert.equal(line.packSha256, contextPack.sha256);
  assert.ok(!JSON.stringify(logged).includes('contract Vault'), 'logs carry hashes, never contents');
});

test('an abstaining run has no report and no pack', async (t) => {
  const sb = claimSandbox({ scripts: { 'vcr-build': () => ({ exitCode: 137 }) } });
  const { target } = await serve(t, sb);
  const res = await post(target, body());
  assert.equal(res.status, 503);
  assert.equal(res.body.outcome, 'abstain');
  assert.equal(res.body.report, null);
  assert.equal(res.body.reportSha256, null);
  assert.equal(res.body.contextPack, null);
});

test('R5: a development run on linux/arm64 has gates and a pack, and says why it has no report', async (t) => {
  const handlers = { image: (args) => (args[1] === 'inspect' ? imageInspect(args, { platform: 'linux/arm64' }) : { stdout: '' }) };
  const { target } = await serve(t, claimSandbox({ handlers }), { env: { CODE_RUNNER_PLATFORM: 'linux/arm64' } });
  const res = await post(target, body());
  assert.equal(res.status, 200, res.raw.slice(0, 500));
  assert.equal(res.body.report, null);
  assert.equal(res.body.reportSha256, null);
  assert.match(res.body.reportUnavailable, /linux\/amd64/);
  assert.equal(res.body.gates.reproduces.status, 'pass');
  assert.ok(res.body.contextPack);
});

test('a report the runner could not build is its own bug: the run abstains, never a definitive answer without one', async (t) => {
  const { target } = await serve(t, claimSandbox(), { options: { finishClaim: () => { throw new Error('boom'); } } });
  const res = await post(target, body());
  assert.equal(res.status, 503);
  assert.equal(res.body.abstain.cause, 'runner_error');
  assert.equal(res.body.report, null);
  assert.equal(res.body.contextPack, null);
});

test('R3: eaGates must be exactly disclosure and inScope, both passed: the schema\'s constants', async (t) => {
  const { target } = await serve(t, claimSandbox());
  for (const eaGates of [{ disclosure: 'pass' }, { disclosure: 'pass', inScope: 'fail' }, { disclosure: 'fail', inScope: 'pass' }, { disclosure: 'pass', inScope: 'pass', extra: 'pass' }, {}]) {
    const res = await post(target, body({ eaGates }));
    assert.equal(res.status, 400, JSON.stringify(eaGates));
    assert.ok(res.body.issues.some((i) => i.path.startsWith('/eaGates')), JSON.stringify(res.body.issues));
  }
});

test('the request names its class or defaults to code-standard; the budget is common\'s', async (t) => {
  const { target } = await serve(t, claimSandbox());
  const premium = await post(target, body({ codeClass: 'code-premium' }));
  assert.equal(premium.status, 200, premium.raw.slice(0, 300));
  assert.equal(premium.body.contextPack.budgetTokens, 120000);
  assert.equal(premium.body.contextPack.codeClass, 'code-premium');
  const unknown = await post(target, body({ codeClass: 'code-gold' }));
  assert.equal(unknown.status, 400);
  assert.ok(unknown.body.issues.some((i) => i.path === '/codeClass'));
});

test('the documents the report and the pack read are refused before any work when they are not what common says', async (t) => {
  const sb = claimSandbox();
  const { target } = await serve(t, sb);
  const entry = { title: 'A known issue', class: 'LOW', paths: ['src/Vault.sol'], description: 'A description of twenty characters or more.' };
  const known = { id: codeReview.knownIssueId(entry), ...entry };
  const cases = [
    ['/finding', { finding: { class: 'HIGH' } }],
    ['/knownIssues', { knownIssues: [{ ...known, id: `sha256:${'0'.repeat(64)}` }] }],
    ['/priorFindings/0', { priorFindings: [{ finding: finding() }] }],
    ['/priorFindings/0', { priorFindings: [{ bcid: 'nope', finding: finding() }] }],
    ['/priorFindings/0/finding', { priorFindings: [{ bcid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', finding: { class: 'HIGH' } }] }],
    ['/attestation', { attestation: { ...attestationFor(forgeSpec()), weight: 0.5 } }]
  ];
  for (const [p, over] of cases) {
    const res = await post(target, body(over));
    assert.equal(res.status, 400, `${p}: ${res.raw.slice(0, 300)}`);
    assert.ok(res.body.issues.some((i) => i.path.startsWith(p)), `${p}: ${JSON.stringify(res.body.issues)}`);
  }
  assert.equal(sb.docker.callsOf('create').length, 0, 'no sandbox');
  const ok = await post(target, body({ knownIssues: [known], priorFindings: [{ bcid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', finding: finding(), report: '# prior\n' }] }));
  assert.equal(ok.status, 200, ok.raw.slice(0, 300));
});

test('a stable test id the report could not carry is the requester\'s baseline, refused before any work', async (t) => {
  const { target } = await serve(t, claimSandbox());
  const res = await post(target, body({ baseline: { version: 1, baseCommit: BASE, framework: 'forge', runs: 3, tests: [{ id: DEPOSIT, results: ['pass', 'pass', 'pass'] }], stable: [`bad\nid`], unstable: [] } }));
  assert.equal(res.status, 400);
  assert.ok(res.body.issues.some((i) => i.code === 'BASELINE_INVALID'), JSON.stringify(res.body.issues));
  void IMAGE;
});
