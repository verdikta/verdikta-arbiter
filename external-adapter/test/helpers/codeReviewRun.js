/**
 * Doubles for the code-review run (node A4b): real HTTP servers standing in
 * for the code runner and the AI Node, and the reports they answer with.
 *
 * A report is built field by field in verdikta.claim-report/1 and held to
 * common's validator here, so a test can only settle what the schema accepts.
 * The gates follow from the facts by the same rule the validator checks.
 * Kept outside __tests__ so jest does not run it as a suite.
 */

const crypto = require('crypto');
const http = require('http');
const { codeReview } = require('@verdikta/common');

const RUNNER_VERSION = '0.1.0';
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const CLEAN = Object.freeze({
  identityComplete: true, summaryConsistent: true, exitConsistent: true,
  protectedPathsUnchanged: true, frameworkUnchanged: true, dependenciesUnchanged: true
});
const FAIL3 = Object.freeze(['fail', 'fail', 'fail']);
const RUN_KEY = Object.freeze({ fail: 'fail', pass: 'pass', error: 'error', skip: 'skip', missing: 'missing', duplicate: 'duplicate', 'not-run': 'notRun' });

function kindOf(runs) {
  if (runs.includes('error')) return 'error';
  return runs.includes('fail') ? 'assertion' : null;
}

/**
 * The PoC part. Options: tests [{ id, runs, message }] or `runs` (one list per
 * test), integrity (checks to override), tamperFlags, honestyFlags, testCount
 * and runCounts (for a report over the bound on `tests`).
 */
function pocOf(shape = {}) {
  const tests = (shape.tests || (shape.runs || [FAIL3]).map((runs, i) => ({ id: `test/Exploit.t.sol > ExploitTest > test_${i}()`, runs })))
    .map((test) => {
      const kind = kindOf(test.runs);
      return { id: test.id, runs: [...test.runs], kind, message: kind === null ? null : (test.message === undefined ? 'assertion failed' : test.message) };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const runCounts = { fail: 0, pass: 0, error: 0, skip: 0, missing: 0, duplicate: 0, notRun: 0 };
  for (const test of tests) for (const run of test.runs) runCounts[RUN_KEY[run]] += 1;
  return {
    tier: 'B',
    testCount: shape.testCount === undefined ? tests.length : shape.testCount,
    runCounts: shape.runCounts || runCounts,
    tests,
    integrity: { ...CLEAN, ...(shape.integrity || {}), tamperFlags: shape.tamperFlags || [] },
    honestyFlags: shape.honestyFlags || []
  };
}

const NO_FIX = Object.freeze({
  present: false, applies: 'not-run', builds: 'not-run', pocPasses: null, regressions: [], regressionCount: 0, tier: 'B', integrity: null
});
const GOOD_FIX = Object.freeze({
  present: true, applies: 'pass', builds: 'pass', pocPasses: true, regressions: [], regressionCount: 0, tier: 'B',
  integrity: { ...CLEAN, tamperFlags: [] }
});

/**
 * A valid report for a request the runner received.
 * @param {object} body - POST /v1/runs's body
 * @param {object} [shape] - stop: 'applies' | 'testPathsOnly' | 'build' (the gate that failed, no PoC); else
 *   pocOf's options; claimedObservable ('pass' default); fix; findings; flags; diff; inputs (overrides); gates (overrides,
 *   for a report the validator should refuse); runner
 */
function reportFor(body, shape = {}) {
  const image = String(body.spec.env.image);
  const fixBytes = body.fixPatch ? Buffer.from(body.fixPatch, 'base64') : null;
  const poc = shape.stop ? null : pocOf(shape);
  const clean = poc !== null && Object.keys(CLEAN).every((c) => poc.integrity[c] === true) && poc.integrity.tamperFlags.length === 0;
  const reproduces = poc === null ? 'not-run'
    : (clean && poc.testCount > 0 && poc.runCounts.fail === poc.testCount * 3 ? 'pass' : 'fail');
  const order = ['applies', 'testPathsOnly', 'build'];
  const stopAt = shape.stop ? order.indexOf(shape.stop) : order.length;
  const gate = (i) => (i < stopAt ? 'pass' : (i === stopAt ? 'fail' : 'not-run'));
  const gates = {
    applies: gate(0),
    testPathsOnly: gate(1),
    build: gate(2),
    reproduces,
    integrity: poc === null ? 'not-run' : (clean ? 'pass' : 'fail'),
    claimedObservable: reproduces === 'pass' ? (shape.claimedObservable || 'pass') : 'not-run',
    ...(shape.gates || {})
  };
  const fix = shape.fix || (fixBytes ? GOOD_FIX : NO_FIX);
  return {
    schema: 'verdikta.claim-report/1',
    inputs: {
      listingCid: body.listingCid,
      bcid: body.bcid,
      envImage: image.slice(image.indexOf('@') + 1),
      platform: 'linux/amd64',
      attestationSha256: sha256(Buffer.from(codeReview.canonicalJson(body.attestation), 'utf8')),
      baseCommit: body.spec.baseCommit,
      pocPatchSha256: sha256(Buffer.from(body.pocPatch, 'base64')),
      fixPatchSha256: fixBytes ? sha256(fixBytes) : null,
      runner: shape.runner || RUNNER_VERSION,
      gvisor: codeReview.GVISOR_RELEASE,
      semgrepRules: codeReview.SEMGREP_RULES_VERSION,
      eaGates: { disclosure: 'pass', inScope: 'pass' },
      ...(shape.inputs || {})
    },
    gates,
    poc,
    fix,
    build: { status: gates.build, tier: 'A' },
    findings: shape.findings || [],
    flags: { existingTestsModified: [], skipMarkersAdded: [], protectedPathsTouched: [], ...(shape.flags || {}) },
    diff: shape.diff || { poc: { files: 1, added: 10, removed: 0 }, fix: fix.present ? { files: 1, added: 1, removed: 1 } : null }
  };
}

/** A small pack in the runner's form: the claim tier holds report.md, the prior tier the summaries. */
function packFor(body) {
  const priors = (body.priorFindings || []).map((p) => `${p.bcid}: ${p.finding.title || ''}`).join('\n');
  const files = [
    { name: '00-manifest.json', tier: 'manifest', text: '{"schema":"verdikta.context-pack/1"}' },
    { name: '01-poc-diff.patch', tier: 'poc', text: '# poc.patch\n+contract ExploitTest {}\n' },
    { name: '02-finding.txt', tier: 'claim', text: `# finding.json\n${JSON.stringify(body.finding)}` },
    { name: '02-report.txt', tier: 'claim', text: `# report.md\n${body.report}` },
    ...(priors ? [{ name: '06-prior-findings.txt', tier: 'priorFindings', text: `# summaries\n${priors}` }] : [])
  ];
  return { version: 1, codeClass: 'code-standard', budgetTokens: 60000, usedTokens: 500, sha256: 'a'.repeat(64), tiers: [], files };
}

/** POST /v1/runs's definitive answer for a shape; `unchecked` lets a report through that the validator refuses. */
function definitive(body, shape = {}, { unchecked = false } = {}) {
  const raw = reportFor(body, shape);
  const checked = codeReview.validateClaimReport(raw);
  if (!unchecked && !checked.ok) throw new Error(`test report does not validate: ${JSON.stringify(checked.issues)}`);
  return {
    status: 200,
    json: {
      outcome: 'definitive',
      runId: '0123456789abcdef',
      runner: { version: raw.inputs.runner, runtime: 'runsc', platform: 'linux/amd64', gvisor: raw.inputs.gvisor },
      limits: {},
      abstain: null,
      image: { ref: body.spec.env.image, cache: 'hit', durationMs: 1 },
      steps: [],
      gates: { applies: { status: raw.gates.applies, basis: 'exit_code', detail: 'RUN-SPECIFIC-DETAIL /tmp/run-77' } },
      facts: { poc: { detail: 'RUN-SPECIFIC-DETAIL /tmp/run-77' } },
      report: checked.ok ? JSON.parse(codeReview.canonicalReportJson(raw)) : raw,
      reportSha256: checked.ok ? codeReview.reportSha256(raw) : 'b'.repeat(64),
      reportUnavailable: null,
      contextPack: packFor(body)
    }
  };
}

const abstained = (cause, step = 'image') => ({
  status: 503,
  json: {
    outcome: 'abstain', runId: 'f'.repeat(16), runner: { version: RUNNER_VERSION, runtime: 'runsc', platform: 'linux/amd64', gvisor: codeReview.GVISOR_RELEASE },
    limits: {}, abstain: { cause, step, detail: 'operator-only detail with HUNTER-TEXT-IN-DETAIL' }, image: null, steps: [], gates: {}, facts: {},
    report: null, reportSha256: null, reportUnavailable: null, contextPack: null
  }
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : null);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function serve(handler) {
  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => {
          if (server.closeAllConnections) server.closeAllConnections();
          server.close(() => done());
        })
      });
    });
  });
}

function respond(res, { status = 200, json, raw }) {
  if (res.destroyed) return;
  const payload = raw !== undefined ? Buffer.from(raw) : Buffer.from(JSON.stringify(json));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.length });
  res.end(payload);
}

const HANG = Symbol('hang');

/**
 * A code runner. `answer(body, state)` returns { status, json | raw } (default:
 * a clean definitive answer) or HANG to keep the request open; it may be async.
 * `health()` likewise (default: 200, ok). state.runs holds each body,
 * state.auth the Authorization headers, state.cancelled the requests the
 * caller hung up on.
 */
async function startRunner(options = {}) {
  const state = { runs: [], auth: [], healthCalls: 0, cancelled: 0, answer: options.answer, health: options.health };
  const server = await serve(async (req, res) => {
    state.auth.push(req.headers.authorization);
    if (req.url === '/health') {
      state.healthCalls += 1;
      const out = state.health ? await state.health(state) : { status: 200, json: { ok: true, reasons: [], service: 'verdikta-code-runner', version: RUNNER_VERSION } };
      if (out !== HANG) respond(res, out);
      return;
    }
    const body = await readJson(req);
    state.runs.push(body);
    res.on('close', () => { if (!res.writableFinished) state.cancelled += 1; });
    const out = state.answer ? await state.answer(body, state) : definitive(body);
    if (out !== HANG) respond(res, out);
  });
  return { ...server, state };
}

const juryScores = (index = 4) => codeReview.BUG_OUTCOMES.map((outcome, i) => ({ outcome, score: i === index ? 1000000 : 0 }));

const juryAnswer = (body, over = {}) => ({
  status: 200,
  json: {
    scores: juryScores(),
    justification: 'The panel finds a HIGH: JURY-TEXT.',
    metadata: { models_requested: 2, models_successful: 2, models_failed: 0, success_threshold_met: true, total_duration_ms: 1 },
    model_results: [{ provider: 'anthropic', model: 'claude', status: 'success', duration_ms: 1 }],
    codeReview: {
      codeClass: body.codeReview.codeClass,
      reportSha256: body.codeReview.reportSha256,
      promptSha256: 'c'.repeat(64),
      deadlineMs: body.codeReview.deadlineMs,
      jurorTimeoutMs: 240000,
      justifierReserveMs: 45000,
      maxTokens: 8000,
      effort: 'high'
    },
    ...over
  }
});

const aiError = (status, errorCode, retryable = false) => ({
  status,
  json: { error: `AI-NODE-ERROR-TEXT ${errorCode}`, errorCode, retryable, scores: [], justification: '' }
});

/** An AI Node. `answer(body, state)` as for the runner; default: the jury's verdict. state.calls holds each body. */
async function startAiNode(options = {}) {
  const state = { calls: [], cancelled: 0, answer: options.answer };
  const server = await serve(async (req, res) => {
    const body = await readJson(req);
    state.calls.push(body);
    res.on('close', () => { if (!res.writableFinished) state.cancelled += 1; });
    const out = state.answer ? await state.answer(body, state) : juryAnswer(body);
    if (out !== HANG) respond(res, out);
  });
  return { ...server, state };
}

module.exports = {
  RUNNER_VERSION,
  CLEAN,
  FAIL3,
  HANG,
  NO_FIX,
  GOOD_FIX,
  sha256,
  pocOf,
  reportFor,
  packFor,
  definitive,
  abstained,
  startRunner,
  startAiNode,
  juryScores,
  juryAnswer,
  aiError
};
