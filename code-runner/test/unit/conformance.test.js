'use strict';

// A7a, acceptance 4: `npm run conformance`. A report exists only on the class platform, and its hash names the gVisor
// release measured, so only one setup has the canonical hash: linux/amd64 under the pinned gVisor (A3b). Anywhere else the
// canary still runs, and no line of output can be taken for that hash.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codeReview } = require('@verdikta/common');
const { main, canonicalProblems, inputsSha256, EXIT, CANARY_REGISTRY_PORT } = require('../../conformance/run');
const { loadCorpus } = require('../../calibration/lib/format');
const { listingView, caseRequest } = require('../../calibration/lib/harness');

const ROOT = path.join(__dirname, '..', '..', 'conformance');
const LOCK = JSON.parse(fs.readFileSync(path.join(ROOT, 'canary.lock.json'), 'utf8'));
const HEX64 = /\b[0-9a-f]{64}\b/;
const GVISOR = codeReview.GVISOR_RELEASE;

function canaryCase() {
  const { cases } = loadCorpus({ root: ROOT });
  assert.equal(cases.length, 1, 'one canary');
  return cases[0];
}

const FAKE_HASH = 'f'.repeat(64);

function fakeReport(hash = FAKE_HASH) {
  const { runner } = canaryCase().expected;
  return {
    fakeHash: hash,
    schema: 'verdikta.claim-report/1',
    inputs: { gvisor: GVISOR, platform: 'linux/amd64', runner: '0.1.0', semgrepRules: codeReview.SEMGREP_RULES_VERSION, envImage: LOCK.imageDigest, listingCid: LOCK.listingCid, bcid: LOCK.bcid },
    gates: runner.gates,
    poc: { tests: runner.tests, honestyFlags: runner.honestyFlags.map((f) => ({ ...f, message: 'm' })), testCount: 1, runCounts: {}, integrity: { tamperFlags: [] } },
    fix: { present: true, ...runner.fix },
    findings: [],
    flags: { existingTestsModified: [], skipMarkersAdded: [], protectedPathsTouched: [] }
  };
}

function answerFor({ runner = { version: '0.1.0', runtime: 'runsc', platform: 'linux/amd64', gvisor: GVISOR }, report = fakeReport(), over = {} } = {}) {
  const expected = canaryCase().expected.runner;
  return {
    status: 200,
    body: {
      outcome: 'definitive', runner,
      gates: Object.fromEntries(Object.entries(expected.gates).map(([g, s]) => [g, { status: s, basis: 'junit', detail: 'd' }])),
      facts: { poc: { tests: expected.tests.map((t) => ({ id: t.id, runs: t.runs })) }, fix: { present: true, ...expected.fix } },
      report,
      reportSha256: report ? report.fakeHash : null,
      reportUnavailable: report ? null : 'the report\'s platform is linux/amd64; this run used linux/arm64 (a development setting)',
      contextPack: { files: [{ tier: 'poc', name: 'p', text: 'PoC' }] },
      ...over
    }
  };
}

function session({ platform = 'linux/amd64', runtime = 'runsc', digest = LOCK.imageDigest, answers = null, log = [], listingStatus = 'accepted' } = {}) {
  const canned = answers || (() => answerFor());
  return (opts) => {
    log.push({ registryPort: opts.registryPort });
    return {
      runtime,
      platform,
      runner: { version: '0.1.0', runtime, platform, gvisor: runtime === 'runsc' ? GVISOR : 'runc' },
      async publish(listing) {
        return { image: `127.0.0.1:${CANARY_REGISTRY_PORT}/verdikta/conformance-canary@${digest}`, digest, repoName: listing.id };
      },
      async listingCheck(published, listing) {
        return { status: 200, body: { outcome: 'definitive', listing: { status: listingStatus, refusals: [], baseline: listing.baseline } } };
      },
      async run(body) {
        log.push(body);
        return canned(body);
      },
      async close() {}
    };
  };
}

async function runMain(argv, makeSession, over = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, {
    makeSession,
    settle: () => ({ kind: 'jury' }),
    validate: () => ({ request: {} }),
    developmentReport: () => fakeReport(),
    reportHash: (report) => report.fakeHash,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    ...over
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('on the canonical setup it prints the report hash and the versions it came from', async () => {
  const r = await runMain([], session());
  assert.equal(r.code, EXIT.OK, r.out + r.err);
  assert.match(r.out, new RegExp(`conformance report sha256: ${FAKE_HASH}`));
  assert.match(r.out, new RegExp(GVISOR));
  assert.match(r.out, /runner 0\.1\.0/);
});

test('a local run (runc, arm64, no report) exits 0 on the expected gates, says so plainly, and prints nothing that looks like a hash', async () => {
  const r = await runMain([], session({
    platform: 'linux/arm64', runtime: 'runc',
    answers: () => answerFor({ runner: { version: '0.1.0', runtime: 'runc', platform: 'linux/arm64', gvisor: 'runc' }, report: null })
  }));
  assert.equal(r.code, EXIT.OK, r.out + r.err);
  assert.match(r.out, /LOCAL RUN/);
  assert.match(r.out, /no report hash/i);
  assert.match(r.out, /linux\/arm64/);
  assert.match(r.out, /CI records/);
  assert.doesNotMatch(r.out + r.err, HEX64, 'nothing with the shape of the canonical hash');
});

test('runc on amd64 has a report, and still no hash to print: the report names runc', async () => {
  const report = { ...fakeReport(), inputs: { ...fakeReport().inputs, gvisor: 'runc' } };
  const r = await runMain([], session({
    runtime: 'runc',
    answers: () => answerFor({ runner: { version: '0.1.0', runtime: 'runc', platform: 'linux/amd64', gvisor: 'runc' }, report })
  }));
  assert.equal(r.code, EXIT.OK, r.out + r.err);
  assert.match(r.out, /LOCAL RUN/);
  assert.doesNotMatch(r.out + r.err, HEX64);
});

test('a canary whose gates differ fails anywhere, with no hash', async () => {
  const bad = answerFor();
  bad.body.gates.reproduces.status = 'fail';
  bad.body.report = { ...fakeReport(), gates: { ...fakeReport().gates, reproduces: 'fail' } };
  const r = await runMain([], session({ answers: () => bad }), { settle: () => ({ kind: 'invalid', gate: 'reproduces', check: 'POC_DID_NOT_REPRODUCE' }) });
  assert.equal(r.code, EXIT.DISAGREE, r.out + r.err);
  assert.doesNotMatch(r.out, /conformance report sha256/);
  assert.doesNotMatch(r.out + r.err, new RegExp(FAKE_HASH));
});

test('canonicalProblems reads the runner\'s answer, not the environment', () => {
  const good = answerFor().body;
  const inputs = { lock: LOCK, published: { digest: LOCK.imageDigest }, listingCid: LOCK.listingCid, bcid: LOCK.bcid, reportHash: () => good.reportSha256 };
  assert.deepEqual(canonicalProblems(good, inputs), []);
  const check = (body, re) => assert.ok(canonicalProblems(body, inputs).some((p) => re.test(p)), `${re}: ${JSON.stringify(canonicalProblems(body, inputs))}`);
  check({ ...good, runner: { ...good.runner, runtime: 'runc' } }, /runtime/);
  check({ ...good, runner: { ...good.runner, gvisor: 'release-20200101.0' } }, /gvisor|gVisor/);
  check({ ...good, runner: { ...good.runner, platform: 'linux/arm64' } }, /platform/);
  check({ ...good, report: null }, /no report/);
  check({ ...good, report: { ...good.report, inputs: { ...good.report.inputs, gvisor: 'runc' } } }, /report.*gvisor|gVisor/);
  check({ ...good, report: { ...good.report, inputs: { ...good.report.inputs, envImage: `sha256:${'0'.repeat(64)}` } } }, /envImage|image/);
  check({ ...good, report: { ...good.report, inputs: { ...good.report.inputs, listingCid: 'Qmother' } } }, /listingCid/);
  check({ ...good, report: { ...good.report, inputs: { ...good.report.inputs, bcid: 'Qmother' } } }, /bcid/);
  assert.ok(canonicalProblems(good, { ...inputs, reportHash: () => '0'.repeat(64) }).some((p) => /hash/.test(p)), 'the runner\'s hash is recomputed');
  assert.ok(canonicalProblems(good, { ...inputs, published: { digest: `sha256:${'0'.repeat(64)}` } }).some((p) => /digest|lock/.test(p)), 'the image built must be the locked one');
});

test('an image that is not the locked one on the class platform stops the run before any claim', async () => {
  const log = [];
  const r = await runMain([], session({ digest: `sha256:${'0'.repeat(64)}`, log }));
  assert.equal(r.code, EXIT.HARNESS, r.out + r.err);
  assert.match(r.err, /canary\.lock\.json|lock/);
  assert.equal(log.filter((l) => l && l.bcid).length, 0, 'no claim ran');
});

test('the canary uses the fixed registry port, since the reference is in what the report hashes', async () => {
  const log = [];
  await runMain([], session({ log }));
  assert.equal(log[0].registryPort, CANARY_REGISTRY_PORT);
  assert.ok(Number.isInteger(CANARY_REGISTRY_PORT) && CANARY_REGISTRY_PORT > 1024);
  assert.match(LOCK.image, new RegExp(`^127\\.0\\.0\\.1:${CANARY_REGISTRY_PORT}/verdikta/conformance-canary@sha256:[0-9a-f]{64}$`));
  assert.equal(LOCK.image.split('@')[1], LOCK.imageDigest);
});

test('--repeat runs it again and requires the same hash', async () => {
  const log = [];
  const r = await runMain(['--repeat', '2'], session({ log }));
  assert.equal(r.code, EXIT.OK, r.out + r.err);
  assert.equal(log.filter((l) => l && l.bcid).length, 2);
  let n = 0;
  const drift = await runMain(['--repeat', '2'], session({
    answers: () => { n += 1; return answerFor({ report: fakeReport((n === 1 ? 'a' : 'b').repeat(64)) }); }
  }));
  assert.equal(drift.code, EXIT.DISAGREE, drift.out + drift.err);
  assert.match(drift.err, /different report hashes/);
  assert.doesNotMatch(drift.out, /conformance report sha256/);
});

test('--repeat holds every run to the canonical conditions, not only the last', async () => {
  let n = 0;
  const r = await runMain(['--repeat', '2'], session({
    answers: () => {
      n += 1;
      return n === 1 ? answerFor({ runner: { version: '0.1.0', runtime: 'runsc', platform: 'linux/amd64', gvisor: 'release-20200101.0' } }) : answerFor();
    }
  }));
  assert.equal(r.code, EXIT.HARNESS, r.out + r.err);
  assert.match(r.err, /gVisor/);
  assert.doesNotMatch(r.out, /conformance report sha256/);
});

test('--json records what CI keeps; a local run\'s record has no hash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-conf-'));
  try {
    const file = path.join(dir, 'c.json');
    assert.equal((await runMain(['--json', file], session())).code, EXIT.OK);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.canonical, true);
    assert.equal(saved.reportSha256, FAKE_HASH);
    assert.equal(saved.gvisor, GVISOR);
    assert.equal(saved.imageDigest, LOCK.imageDigest);
    assert.ok(saved.report);

    assert.equal((await runMain(['--json', file], session({
      platform: 'linux/arm64', runtime: 'runc',
      answers: () => answerFor({ runner: { version: '0.1.0', runtime: 'runc', platform: 'linux/arm64', gvisor: 'runc' }, report: null })
    }))).code, EXIT.OK);
    const local = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(local.canonical, false);
    assert.equal(local.reportSha256, undefined);
    assert.equal(local.report, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the canary is fixed: its inputs are pinned, and a change says what must follow', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, 'canary'));
  walk(path.join(ROOT, 'cases'));
  const hash = crypto.createHash('sha256');
  for (const f of files) hash.update(`${f}\0`).update(fs.readFileSync(path.join(ROOT, f)));
  const message = 'the canary changed. A new canary is a new report hash: run npm run conformance -- --write-lock, and update C5\'s value in @verdikta/common with a runner release';
  assert.equal(hash.digest('hex'), LOCK.inputsSha256, message);
  assert.equal(inputsSha256(), LOCK.inputsSha256, message);
});

test('what the lock names follows from the sources: the archives and the commit, with no network and no Docker', () => {
  const entry = canaryCase();
  assert.equal(entry.listing.commit, LOCK.baseCommit);
  const view = listingView(entry.listing, { image: LOCK.image, digest: LOCK.imageDigest });
  assert.equal(view.cid, LOCK.listingCid);
  assert.equal(caseRequest(entry, view).body.bcid, LOCK.bcid);
  assert.equal(LOCK.platform, 'linux/amd64');
});

test('the canary exercises what a hash should cover: a flag, the fix check, all gates', () => {
  const c = canaryCase();
  const { runner } = c.expected;
  assert.equal(c.subsets.includes('conformance'), true);
  assert.ok(c.claim.fix, 'a fix.patch, so the fix check is in the hash');
  assert.ok(runner.honestyFlags.length >= 1, 'a flag, so a scan that read nothing would change the hash');
  assert.deepEqual(new Set(Object.values(runner.gates)), new Set(['pass']));
  assert.equal(runner.settlement.kind, 'jury');
  assert.equal(c.listing.repo.path, 'canary/repo', 'its own repository: a new calibration case cannot move it');
  assert.equal(runner.fix.pocPasses, true);
});

test('A8: the installer\'s self-test runs the registry on the host network, because the runner\'s daemon cannot publish a port', async () => {
  const { registryArgs } = require('../../calibration/lib/session');
  assert.deepEqual(registryArgs('r', 5987, false).slice(0, 6), ['run', '--detach', '--name', 'r', '--publish', '127.0.0.1:5987:5000']);
  const host = registryArgs('r', 5987, true);
  assert.deepEqual(host.slice(4, 8), ['--network', 'host', '--env', 'REGISTRY_HTTP_ADDR=127.0.0.1:5987']);
  assert.ok(!host.includes('--publish'));
  assert.equal(registryArgs('r', 5987, false).at(-1), host.at(-1), 'the same image either way');
});
