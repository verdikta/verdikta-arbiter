'use strict';

// A7a, acceptance 2: the harness, over a fake runner session. Exit codes, the order of the work, what is exported.
// The real runs are in npm run calibration; here is what they must lead to.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main, EXIT } = require('../../calibration/run');
const { writeCorpus, juryCase, controlCase, GATES_PASS, TEST_ID } = require('../helpers/calibrationCorpus');
const { cidV0 } = require('../../calibration/lib/archives');

const RUNNER = Object.freeze({ version: '0.1.0', runtime: 'runsc', platform: 'linux/amd64', gvisor: 'release-20260921.0' });

function reportFor(runner, body) {
  return {
    schema: 'verdikta.claim-report/1',
    inputs: { listingCid: body.listingCid, bcid: body.bcid, pocPatchSha256: 'x' },
    gates: runner.gates,
    poc: {
      tests: runner.tests,
      testCount: runner.tests.length,
      runCounts: {},
      integrity: { tamperFlags: [] },
      honestyFlags: runner.honestyFlags.map((f) => ({ ...f, message: 'm' }))
    },
    fix: { present: false },
    findings: [],
    flags: { existingTestsModified: [], skipMarkersAdded: [], protectedPathsTouched: [] }
  };
}

/** A session that answers each claim as `answers` says, by the PoC's text. */
function fakeSession({ platform = 'linux/amd64', answer = null, listingStatus = 'accepted', baseline = null, log = [] } = {}) {
  const expectedFor = (body) => {
    const poc = Buffer.from(body.pocPatch, 'base64').toString('utf8');
    return poc.includes('vm.store') ? juryCase().expected.runner : controlCase().expected.runner;
  };
  return () => ({
    runtime: RUNNER.runtime,
    platform,
    runner: { ...RUNNER, platform },
    async publish(listing) {
      log.push(`publish ${listing.id}`);
      return {
        image: `127.0.0.1:5000/verdikta/calibration/${listing.id}@sha256:${'e'.repeat(64)}`,
        digest: `sha256:${'e'.repeat(64)}`
      };
    },
    async listingCheck(published, listing) {
      log.push(`check ${listing.id}`);
      return { status: 200, body: { outcome: 'definitive', listing: { status: listingStatus, refusals: [], baseline: baseline || { ...listing.baseline, timings: { buildSeconds: 1 } } } } };
    },
    async run(body) {
      log.push(`run ${body.bcid}`);
      if (answer) return answer(body);
      const runner = expectedFor(body);
      const out = {
        outcome: 'definitive', runner: { ...RUNNER, platform },
        gates: Object.fromEntries(Object.entries(runner.gates).map(([g, s]) => [g, { status: s, basis: 'junit', detail: (runner.gateDetails || {})[g] || 'd' }])),
        facts: { poc: { tests: runner.tests.map((t) => ({ id: t.id, runs: t.runs })) } },
        report: reportFor(runner, body), reportSha256: 'a'.repeat(64),
        contextPack: { codeClass: 'code-standard', files: [{ tier: 'poc', name: 'p', text: 'PoC' }], usedTokens: 1, budgetTokens: 2 }
      };
      return { status: 200, body: out };
    },
    async close() { log.push('close'); }
  });
}

function settleFake(report) {
  const failed = Object.entries(report.gates).filter(([, s]) => s === 'fail');
  if (failed.length === 0) return { kind: 'jury' };
  return { kind: 'invalid', gate: 'reproduces', check: 'POC_DID_NOT_REPRODUCE', reason: 'r' };
}

async function runMain(argv, corpus, session, over = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, {
    root: corpus.root,
    makeSession: session,
    settle: settleFake,
    validate: () => ({ request: {} }),
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    ...over
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('every case agreeing exits 0, with one image and one listing check per listing', async () => {
  const corpus = writeCorpus();
  const log = [];
  try {
    const r = await runMain(['--subset', 'adversarial'], corpus, fakeSession({ log }));
    assert.equal(r.code, EXIT.OK, r.out + r.err);
    assert.equal(log.filter((l) => l.startsWith('publish')).length, 1);
    assert.equal(log.filter((l) => l.startsWith('check')).length, 1);
    assert.equal(log.filter((l) => l.startsWith('run')).length, 2);
    assert.equal(log[log.length - 1], 'close');
    assert.match(r.out, /adversarial\.store/);
    assert.match(r.out, /all 2 cases agree/);
  } finally {
    corpus.cleanup();
  }
});

test('any disagreement exits non-zero and names it', async () => {
  const corpus = writeCorpus({ adversarial: { expected: { ...juryCase().expected, runner: { ...juryCase().expected.runner, tests: [{ id: TEST_ID, runs: ['fail', 'fail', 'fail'], kind: 'assertion', message: 'not what forge said' }] } } } });
  try {
    // The session answers with the original expected result, so the altered case file disagrees with it.
    const r = await runMain(['--subset', 'adversarial'], corpus, fakeSession());
    assert.equal(r.code, EXIT.DISAGREE, r.out + r.err);
    assert.match(r.out, /tests\.0\.message: expected "not what forge said", actual "assertion failed: 0 != 5"/);
  } finally {
    corpus.cleanup();
  }
});

test('a malformed case exits with the format\'s code and runs nothing', async () => {
  const corpus = writeCorpus({ adversarial: { format: 'nope' } });
  const log = [];
  try {
    const r = await runMain(['--subset', 'adversarial'], corpus, fakeSession({ log }));
    assert.equal(r.code, EXIT.MALFORMED, r.out + r.err);
    assert.match(r.err, /format/);
    assert.deepEqual(log, [], 'no image, no run');
  } finally {
    corpus.cleanup();
  }
});

test('a subset with no cases exits with an error, never 0', async () => {
  const corpus = writeCorpus();
  try {
    const r = await runMain(['--subset', 'clear-valid'], corpus, fakeSession());
    assert.equal(r.code, EXIT.MALFORMED, r.out + r.err);
    assert.match(r.err, /clear-valid/);
  } finally {
    corpus.cleanup();
  }
});

test('an unknown option is refused', async () => {
  const corpus = writeCorpus();
  try {
    const r = await runMain(['--subsett', 'adversarial'], corpus, fakeSession());
    assert.equal(r.code, EXIT.MALFORMED);
    assert.match(r.err, /--subsett/);
  } finally {
    corpus.cleanup();
  }
});

test('a listing the real listing check refuses stops the run, and says why', async () => {
  const corpus = writeCorpus();
  try {
    const r = await runMain([], corpus, fakeSession({ listingStatus: 'refused' }));
    assert.equal(r.code, EXIT.HARNESS, r.out + r.err);
    assert.match(r.err, /listing check.*vault|vault.*listing check/);
  } finally {
    corpus.cleanup();
  }
});

test('a baseline the listing check does not reproduce stops the run', async () => {
  const corpus = writeCorpus();
  try {
    const r = await runMain([], corpus, fakeSession({ baseline: { version: 1, tests: [], stable: [], unstable: [] } }));
    assert.equal(r.code, EXIT.HARNESS, r.out + r.err);
    assert.match(r.err, /baseline/);
  } finally {
    corpus.cleanup();
  }
});

test('a runner that fails unexpectedly closes the session and exits with the harness\'s code', async () => {
  const corpus = writeCorpus();
  const log = [];
  try {
    const r = await runMain([], corpus, fakeSession({ log, answer: () => { throw new Error('connection refused'); } }));
    assert.equal(r.code, EXIT.HARNESS, r.out + r.err);
    assert.match(r.err, /connection refused/);
    assert.equal(log[log.length - 1], 'close');
  } finally {
    corpus.cleanup();
  }
});

test('a control whose result did not differ on the run fails, though each case file is self-consistent', async () => {
  const corpus = writeCorpus();
  try {
    // A runner that answers both as the jury case: the control disagrees by its own expected result, and by the relation.
    const session = fakeSession({
      answer: (body) => {
        const runner = juryCase().expected.runner;
        return { status: 200, body: {
          outcome: 'definitive', runner: RUNNER,
          gates: Object.fromEntries(Object.entries(runner.gates).map(([g, s]) => [g, { status: s, basis: 'junit', detail: 'd' }])),
          facts: { poc: { tests: runner.tests.map((t) => ({ id: t.id, runs: t.runs })) } },
          report: reportFor(runner, body), reportSha256: 'a'.repeat(64),
          contextPack: { files: [] }
        } };
      }
    });
    const r = await runMain([], corpus, session);
    assert.equal(r.code, EXIT.DISAGREE, r.out + r.err);
    assert.match(r.out, /relation|did not differ|differsIn/);
  } finally {
    corpus.cleanup();
  }
});

test('--self-check passes when every alteration is noticed, on the real observation', async () => {
  const corpus = writeCorpus();
  try {
    const r = await runMain(['--self-check'], corpus, fakeSession());
    assert.equal(r.code, EXIT.OK, r.out + r.err);
    assert.match(r.out, /self-check: \d+ alterations.*noticed/);
  } finally {
    corpus.cleanup();
  }
});

test('--results writes what happened, in a versioned form', async () => {
  const corpus = writeCorpus();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-results-'));
  try {
    const file = path.join(dir, 'r.json');
    const r = await runMain(['--results', file], corpus, fakeSession());
    assert.equal(r.code, EXIT.OK);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.format, 'verdikta.calibration-results/1');
    assert.deepEqual(saved.cases.map((c) => c.id).sort(), ['adversarial.store', 'adversarial.store.control']);
    const one = saved.cases.find((c) => c.id === 'adversarial.store');
    assert.equal(one.actual, 'jury');
    assert.deepEqual(one.disagreements, []);
    assert.equal(one.observed.settlement.kind, 'jury');
    assert.equal(saved.agreement.total, 2);
    assert.deepEqual(saved.runner, RUNNER);
  } finally {
    corpus.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--export writes only what reaches the jury, in the testing tool\'s layout, named by the bytes\' CIDv0', async () => {
  const corpus = writeCorpus();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-export-'));
  try {
    const r = await runMain(['--export', dir], corpus, fakeSession());
    assert.equal(r.code, EXIT.OK, r.out + r.err);
    assert.deepEqual(fs.readdirSync(dir), ['adversarial.store'], 'the control failed a gate, and production calls no model on it');
    const folder = path.join(dir, 'adversarial.store');
    const scenario = JSON.parse(fs.readFileSync(path.join(folder, 'scenario.json'), 'utf8'));
    assert.equal(scenario.id, 'adversarial.store');
    assert.equal(scenario.expected_outcome, 'INVALID');
    assert.deepEqual(scenario.tags, ['adversarial']);
    const run = JSON.parse(fs.readFileSync(path.join(folder, 'run.json'), 'utf8'));
    assert.deepEqual(Object.keys(run).sort(), ['contextPack', 'report', 'reportSha256']);
    assert.equal(run.report.inputs.listingCid, cidV0(fs.readFileSync(path.join(folder, 'listing.zip'))));
    assert.equal(run.report.inputs.bcid, cidV0(fs.readFileSync(path.join(folder, 'claim.zip'))));
  } finally {
    corpus.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--export refuses a host with no report from the runner, before any work', async () => {
  const corpus = writeCorpus();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-export-'));
  const log = [];
  try {
    const r = await runMain(['--export', dir], corpus, fakeSession({ platform: 'linux/arm64', log }));
    assert.equal(r.code, EXIT.MALFORMED, r.out + r.err);
    assert.match(r.err, /linux\/arm64/);
    assert.ok(!log.some((l) => l.startsWith('run')), 'nothing ran');
  } finally {
    corpus.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a request to the runner carries the archives\' CIDs and the listing\'s own files', async () => {
  const corpus = writeCorpus();
  const seen = [];
  const session = fakeSession();
  try {
    const wrap = () => {
      const s = session();
      const run = s.run;
      s.run = (body) => { seen.push(body); return run(body); };
      return s;
    };
    const r = await runMain([], corpus, wrap);
    assert.equal(r.code, EXIT.OK, r.out + r.err);
    const body = seen[0];
    assert.match(body.listingCid, /^Qm/);
    assert.match(body.bcid, /^Qm/);
    assert.notEqual(seen[0].bcid, seen[1].bcid);
    assert.equal(seen[0].listingCid, seen[1].listingCid, 'one listing archive');
    assert.equal(body.spec.env.image, `127.0.0.1:5000/verdikta/calibration/vault@sha256:${'e'.repeat(64)}`);
    assert.equal(body.attestation.env.image, body.spec.env.image);
    assert.deepEqual(body.eaGates, { disclosure: 'pass', inScope: 'pass' });
    assert.deepEqual(body.knownIssues, []);
    assert.equal(body.baseline.baseCommit, corpus.commit);
    assert.equal(body.fixPatch, null);
    assert.equal(body.codeClass, 'code-standard');
  } finally {
    corpus.cleanup();
  }
});

test('a fix.patch reaches the request and the claim archive; the case\'s fix result is compared', async () => {
  const { loadCorpus } = require('../../calibration/lib/format');
  const { listingView, caseRequest } = require('../../calibration/lib/harness');
  const corpus = writeCorpus();
  try {
    const { byId } = loadCorpus({ root: corpus.root });
    const entry = byId.get('adversarial.store');
    const view = listingView(entry.listing, { image: `127.0.0.1:5000/verdikta/calibration/vault@sha256:${'e'.repeat(64)}`, digest: `sha256:${'e'.repeat(64)}` });
    const without = caseRequest(entry, view);
    assert.equal(without.body.fixPatch, null);
    const fix = Buffer.from('diff --git a/src/Vault.sol b/src/Vault.sol\n');
    const withFix = caseRequest({ ...entry, claim: { ...entry.claim, fix } }, view);
    assert.equal(withFix.body.fixPatch, fix.toString('base64'));
    assert.notEqual(withFix.body.bcid, without.body.bcid, 'the archive holds the fix');
    assert.ok(withFix.archive.includes(fix));
  } finally {
    corpus.cleanup();
  }
});

test('prior findings reach the request and the export with the CID of their own archive', async () => {
  const corpus = writeCorpus({ adversarial: { priorFindings: ['priors/01'] } });
  const seen = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-export-'));
  const session = fakeSession();
  try {
    const priorDir = path.join(corpus.casePath('store'), 'priors/01');
    fs.mkdirSync(priorDir, { recursive: true });
    const { finding } = require('../helpers/calibrationCorpus');
    fs.writeFileSync(path.join(priorDir, 'finding.json'), `${finding({ title: 'An earlier finding' })}\n`);
    fs.writeFileSync(path.join(priorDir, 'report.md'), '# Earlier\n');
    const wrap = () => {
      const s = session();
      const run = s.run;
      s.run = (body) => { seen.push(body); return run(body); };
      return s;
    };
    const r = await runMain(['--export', dir], corpus, wrap);
    assert.equal(r.code, EXIT.OK, r.out + r.err);
    const body = seen.find((b) => b.priorFindings.length === 1);
    assert.equal(body.priorFindings[0].finding.title, 'An earlier finding');
    assert.equal(body.priorFindings[0].report, '# Earlier\n');
    const zip = fs.readFileSync(path.join(dir, 'adversarial.store/priors/01-01.zip'));
    assert.equal(body.priorFindings[0].bcid, cidV0(zip));
  } finally {
    corpus.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function addPrior(corpus, rel, title) {
  const { finding } = require('../helpers/calibrationCorpus');
  const priorDir = path.join(corpus.casePath('store'), rel);
  fs.mkdirSync(priorDir, { recursive: true });
  fs.writeFileSync(path.join(priorDir, 'finding.json'), `${finding({ title })}\n`);
  fs.writeFileSync(path.join(priorDir, 'report.md'), `# ${title}\n`);
}

test('R1-F2: prior findings stay in the case\'s order in the export: the testing tool reads them in file-name order', async () => {
  const corpus = writeCorpus({ adversarial: { priorFindings: ['priors/02', 'priors/01', 'priors/03'] } });
  const seen = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-export-'));
  const session = fakeSession();
  try {
    addPrior(corpus, 'priors/01', 'First by name');
    addPrior(corpus, 'priors/02', 'Named second, listed first');
    addPrior(corpus, 'priors/03', 'Third');
    const wrap = () => {
      const s = session();
      const run = s.run;
      s.run = (body) => { seen.push(body); return run(body); };
      return s;
    };
    const r = await runMain(['--export', dir], corpus, wrap);
    assert.equal(r.code, EXIT.OK, r.out + r.err);
    const body = seen.find((b) => b.priorFindings.length === 3);
    const inRequest = body.priorFindings.map((p) => p.bcid);
    const folder = path.join(dir, 'adversarial.store/priors');
    // As testing-tool/src/claim-scenarios.js reads them: .zip files, sorted by name.
    const inExport = fs.readdirSync(folder).filter((n) => n.endsWith('.zip')).sort().map((n) => cidV0(fs.readFileSync(path.join(folder, n))));
    assert.deepEqual(inExport, inRequest);
    assert.equal(body.priorFindings[0].finding.title, 'Named second, listed first');
  } finally {
    corpus.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R1-F2: two prior folders with one base name both reach the export', async () => {
  const corpus = writeCorpus({ adversarial: { priorFindings: ['priors/a/x', 'priors/b/x'] } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-export-'));
  try {
    addPrior(corpus, 'priors/a/x', 'One');
    addPrior(corpus, 'priors/b/x', 'Other');
    const r = await runMain(['--export', dir], corpus, fakeSession());
    assert.equal(r.code, EXIT.OK, r.out + r.err);
    assert.equal(fs.readdirSync(path.join(dir, 'adversarial.store/priors')).length, 2);
  } finally {
    corpus.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R1-F3: an export replaces the earlier one: a scenario that no longer reaches the jury does not stay behind', async () => {
  const corpus = writeCorpus();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-export-'));
  try {
    const stale = path.join(dir, 'adversarial.revised');
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, 'scenario.json'), '{"id":"adversarial.revised"}');
    fs.writeFileSync(path.join(stale, 'run.json'), '{}');
    const r = await runMain(['--export', dir], corpus, fakeSession());
    assert.equal(r.code, EXIT.OK, r.out + r.err);
    assert.deepEqual(fs.readdirSync(dir), ['adversarial.store']);
  } finally {
    corpus.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R1-F3: a run that disagrees leaves no export at all: the last one no longer describes this corpus', async () => {
  const corpus = writeCorpus({ adversarial: { expected: { ...juryCase().expected, runner: { ...juryCase().expected.runner, tests: [{ id: TEST_ID, runs: ['fail', 'fail', 'fail'], kind: 'assertion', message: 'not what forge said' }] } } } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-export-'));
  try {
    const stale = path.join(dir, 'adversarial.store');
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, 'scenario.json'), '{"id":"adversarial.store"}');
    const r = await runMain(['--export', dir], corpus, fakeSession());
    assert.equal(r.code, EXIT.DISAGREE, r.out + r.err);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    corpus.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R1-F3: an export directory holding anything but scenario folders is refused before any run, and nothing in it is touched', async () => {
  const corpus = writeCorpus();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-export-'));
  const log = [];
  try {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
    const other = path.join(dir, 'adversarial.old');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'scenario.json'), '{}');
    const r = await runMain(['--export', dir], corpus, fakeSession({ log }));
    assert.equal(r.code, EXIT.MALFORMED, r.out + r.err);
    assert.match(r.err, /notes\.txt/);
    assert.ok(!log.some((l) => l.startsWith('run')), 'nothing ran');
    assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'mine');
    assert.ok(fs.existsSync(path.join(other, 'scenario.json')));
  } finally {
    corpus.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a listing whose repo is a public git URL is accepted by the format and refused by this node\'s image step, loudly', async () => {
  const corpus = writeCorpus({ listing: { repo: { kind: 'git', url: 'https://github.com/example/project' } } });
  try {
    const { imageInputs } = require('../../calibration/lib/session');
    const { loadCorpus } = require('../../calibration/lib/format');
    const { cases } = loadCorpus({ root: corpus.root });
    assert.throws(() => imageInputs(cases[0].listing), /git.*A7b/);
  } finally {
    corpus.cleanup();
  }
});

test('the settlement used by default is the External Adapter\'s own', () => {
  const { settleReport } = require('../../calibration/lib/settle');
  const fromEa = require('../../../external-adapter/src/codeReview/settlement').settleReport;
  assert.equal(settleReport, fromEa);
});

test('GATES_PASS covers common\'s report gates, less the two the EA owns', () => {
  const { codeReview } = require('@verdikta/common');
  const runner = codeReview.REPORT_GATES.filter((g) => !['disclosure', 'inScope'].includes(g));
  assert.deepEqual(Object.keys(GATES_PASS).sort(), [...runner].sort());
});
