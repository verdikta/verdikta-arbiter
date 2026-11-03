'use strict';

/**
 * The claim suite (`suite: "claim"` in scenarios.json). Each scenario and mode is one
 * reported case. A case fails on any failed check, on an error from the service under
 * test, and on the harness not starting: there is no skip.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const axios = require('axios');
const chalk = require('chalk');
const { codeReview } = require('@verdikta/common');
const A = require('../../assertions');
const C = require('./checks');
const F = require('./fixtures');
const { fetchJustificationJson } = require('../../ipfs');
const { claimVerdictChecks } = require('../../l4/claim-checks');

const AI_ROUTE = '/api/rank-and-justify';
const RUN_ROUTE = '/v1/runs';
/** The EA's deadline (design §11): the job's 840 s less the commit reserve. */
const DEADLINE_LIMIT_MS = 780000;
/** A deadline of 57 s leaves the jury 12 s after the justifier's 45 s. */
const SHORT_DEADLINE_MS = 57000;
const SHORT_JURY_MS = 12000;
const CODE_STANDARD_JUROR_TOKENS = 8000;
const TESTING_TOOL = path.join(__dirname, '..', '..', '..', '..', 'testing-tool', 'src', 'index.js');

const last = (list) => list[list.length - 1];

async function justificationOf(h, cid) {
  const { json, errors } = await fetchJustificationJson([h.ipfs.url], cid, 10000, { attempts: 1 });
  if (!json) throw new Error(`the justification ${cid} is not on the local IPFS: ${errors.join('; ')}`);
  return json;
}

const evidenceChecks = (json, settlement, reportSha256) => {
  const text = String(json.justification || '');
  const checks = [
    A.assert('evidence.first', text.startsWith('Execution evidence v1'), text.slice(0, 80)),
    A.assert('evidence.settlement', text.includes(`Settlement: ${settlement}`), (/Settlement: .*/.exec(text) || ['no Settlement line'])[0])
  ];
  if (reportSha256) checks.push(A.assert('evidence.reportHash', text.includes(`Report-SHA256: ${reportSha256}`), reportSha256));
  return checks;
};

/** The jury path's checks over one job: from `before` to now. */
function juryChecks(h, before, marks) {
  const aiCalls = h.ai.post(AI_ROUTE);
  const call = aiCalls.length > before.aiCalls ? last(aiCalls) : null;
  const run = last(h.runner.post(RUN_ROUTE));
  const answer = run && run.response;
  const provider = h.providerCalls().slice(before.providerCalls);
  return [
    ...C.runChecks(answer, { classPlatform: h.classPlatform }),
    C.gatesPassed(answer && answer.report),
    ...C.aiRequestChecks(call, {
      pack: answer && answer.contextPack,
      reportSha256: answer && answer.reportSha256,
      deadlineLimitMs: DEADLINE_LIMIT_MS,
      validate: codeReview.validateCodeReviewRequest
    }),
    ...C.providerChecks(provider, {
      panel: h.panel,
      justifier: h.justifier,
      reportSha256: answer && answer.reportSha256,
      markers: marks,
      maxTokens: CODE_STANDARD_JUROR_TOKENS
    }),
    ...C.ipfsChecks(h.ipfs)
  ];
}

const MARKERS = () => [F.REPORT_MARKER, F.POC_MARKER];

/** What L4 will assert of this same verdict (src/l4/claim-checks.js), so its checks read what the EA really writes. */
const l4Checks = (kind, scores, cid, json, claimCid, h) => claimVerdictChecks({
  kind, scores, reports: [{ cid, json }], cids: [h.claims.listingCid, claimCid]
}).map((check) => ({ ...check, name: `l4.${check.name}` }));

/** claim-valid, mode 0: the whole path to the jury, the verdict and its upload. */
async function validMode0(h) {
  const before = h.counts();
  const resp = await h.evaluate(h.claims.valid.requestCid);
  const score = resp && resp.data && resp.data.aggregatedScore;
  const firstRun = last(h.runner.post(RUN_ROUTE));
  const checks = [
    A.assert('response.success', resp && resp.status === 'success', `status=${resp && resp.status}`),
    ...C.scoreChecks(score, h.juryAverage),
    ...juryChecks(h, before, MARKERS()),
    ...C.pullChecks(firstRun && firstRun.response, await h.registry.manifestRequests(), h.image)
  ];
  const cid = resp && resp.data && resp.data.justificationCid;
  checks.push(A.cidAssertion('justificationCid.valid', cid));
  if (A.isLikelyCid(cid)) {
    const run = last(h.runner.post(RUN_ROUTE));
    const json = await justificationOf(h, cid);
    checks.push(...evidenceChecks(json, 'jury', run && run.response && run.response.reportSha256));
    checks.push(A.assert('justification.pinned', h.ipfs.pins.includes(cid), cid));
    checks.push(A.assert('justification.source', json.metadata && json.metadata.verdict_source === 'code-review-jury', `verdict_source=${json.metadata && json.metadata.verdict_source}`));
    checks.push(...l4Checks('valid', score, cid, json, h.claims.valid.cid, h));
  }
  h.ranValid = checks.every((c) => c.ok);
  return checks;
}

/** Mode 1 then mode 2 on one claim, the commitment recomputed from the reveal. */
async function commitReveal(h, requestCid, { expectScores, settlement, l4 }) {
  const checks = [];
  const aggId = `agg${Date.now().toString(16)}`;
  const commit = await h.evaluate(`1:${requestCid}`, { aggId });
  const committed = commit && commit.data && commit.data.aggregatedScore;
  checks.push(...A.commitAssertions(committed, commit && commit.data && commit.data.justificationCid));
  const commitment = committed && committed[0];
  if (!/^[0-9]+$/.test(String(commitment))) return checks;
  const pinsAtCommit = h.ipfs.pins.length;
  const reveal = await h.evaluate(`2:${commitment}`, { aggId });
  const scores = reveal && reveal.data && reveal.data.aggregatedScore;
  checks.push(...expectScores(scores));
  const value = reveal && reveal.data && reveal.data.justificationCid;
  checks.push(...A.cidWithSaltAssertion(value));
  checks.push(...C.commitmentChecks(commitment, scores, value, h.operator));
  checks.push(A.assert('reveal.uploads', h.ipfs.pins.length === pinsAtCommit + 1, `${h.ipfs.pins.length - pinsAtCommit} pin(s) at the reveal`));
  if (typeof value === 'string' && value.includes(':')) {
    const json = await justificationOf(h, value.split(':')[0]);
    if (settlement) checks.push(...evidenceChecks(json, settlement));
    if (l4) checks.push(...l4Checks(l4.kind, scores, value.split(':')[0], json, l4.claimCid, h));
  }
  return checks;
}

/** claim-valid, commit-reveal. Jury per job, one sandbox for the operator's jobs (§9.2). */
async function validCommitReveal(h) {
  const before = h.counts();
  const checks = await commitReveal(h, h.claims.valid.requestCid, {
    expectScores: (s) => C.scoreChecks(s, h.juryAverage),
    settlement: 'jury',
    l4: { kind: 'valid', claimCid: h.claims.valid.cid }
  });
  const after = h.counts();
  checks.push(A.assert('jury.perJob', after.aiCalls === before.aiCalls + 1, `${after.aiCalls - before.aiCalls} AI call(s) for the commit`));
  if (h.ranValid) checks.push(A.assert('run.shared', after.runnerCalls === before.runnerCalls, `${after.runnerCalls - before.runnerCalls} new sandbox run(s): the first job's is served from the shared run`));
  checks.push(...C.ipfsChecks(h.ipfs));
  return checks;
}

/**
 * The deadline at the provider layer: the EA's own request, replayed to the real AI Node
 * with a short deadline and a juror that hangs. The call must be aborted by the signal, at
 * the deadline less the justifier's reserve, and the answer must say a retry may help.
 */
async function validJurorDeadline(h) {
  const sent = h.ai.post(AI_ROUTE).find((c) => c.status === 200 && c.request && c.request.codeReview);
  if (!sent) throw new Error('no code-mode request was recorded to replay: the valid claim did not reach the jury');
  const body = JSON.parse(JSON.stringify(sent.request));
  body.codeReview.deadlineMs = SHORT_DEADLINE_MS;
  body.models[1] = { ...body.models[1], provider: h.hangingJuror.provider, model: h.hangingJuror.model };
  const before = h.providerCalls().length;
  const started = Date.now();
  const res = await axios.post(`${h.aiDirect}${AI_ROUTE}`, body, { timeout: 120000, validateStatus: () => true });
  const took = Date.now() - started;
  const calls = h.providerCalls().slice(before);
  const hung = calls.find((c) => c.model === h.hangingJuror.model);
  return [
    A.assert('deadline.answer', res.status === 503 && res.data.errorCode === 'CODE_REVIEW_JUROR_TIMEOUT' && res.data.retryable === true, `HTTP ${res.status}, ${res.data.errorCode}, retryable=${res.data.retryable}`),
    A.assert('deadline.reachedProvider', Boolean(hung) && hung.outcome === 'aborted' && hung.signalAborted === true, hung ? `outcome=${hung.outcome}, signalAborted=${hung.signalAborted}` : 'the hanging juror was not called'),
    A.assert('deadline.onTime', took >= SHORT_JURY_MS - 1000 && took <= SHORT_JURY_MS + 8000, `${took} ms; the jury's share of a ${SHORT_DEADLINE_MS} ms deadline is ${SHORT_JURY_MS} ms`),
    A.assert('deadline.noJustifier', !calls.some((c) => c.model === h.justifier.model), 'no justification for a jury that did not finish')
  ];
}

/**
 * The testing tool's claim type on the real AI Node (node A6b): what the run recorded, as a
 * scenario folder, through the tool's own CLI. Its body must be the EA's, but for the time
 * left and the tag, and the AI Node must take it.
 */
async function validTestingTool(h) {
  const sent = h.ai.post(AI_ROUTE).find((c) => c.status === 200 && c.request && c.request.codeReview && c.request.codeReview.claim.bcid === h.claims.valid.cid);
  if (!sent) throw new Error('no code-mode request was recorded to compare: the valid claim did not reach the jury');
  const answer = h.runner.post(RUN_ROUTE).map((c) => c.response).find((r) => r && r.report && r.report.inputs.bcid === h.claims.valid.cid);
  if (!answer) throw new Error('no run of the valid claim was recorded');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-claim-tool-'));
  try {
    const folder = path.join(dir, 'claims', 'e2e-valid');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'scenario.json'), JSON.stringify({ id: 'e2e-valid', expected_outcome: 'HIGH' }));
    fs.writeFileSync(path.join(folder, 'listing.zip'), h.claims.listing);
    fs.writeFileSync(path.join(folder, 'claim.zip'), h.claims.valid.buffer);
    fs.writeFileSync(path.join(folder, 'run.json'), JSON.stringify({ report: answer.report, reportSha256: answer.reportSha256, contextPack: answer.contextPack }));
    const before = h.ai.post(AI_ROUTE).length;
    const results = path.join(dir, 'results');
    const run = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [TESTING_TOOL, 'test', '--type', 'claim', '--jury', 'real', '--claims-dir', path.join(dir, 'claims'), '--results-dir', results, '--ai-node-url', h.ai.url], { cwd: dir, env: { PATH: process.env.PATH } });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { out += c; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out }));
    });
    const checks = [A.assert('tool.exit', run.code === 0, `exit ${run.code}: ${run.out.slice(-800)}`)];
    const calls = h.ai.post(AI_ROUTE).slice(before);
    checks.push(A.assert('tool.oneCall', calls.length === 1, `${calls.length} call(s) to the AI Node`));
    if (calls.length === 1) {
      const comparable = ({ requestTag, codeReview: field, ...rest }) => {
        const { deadlineMs, ...kept } = field;
        return { ...rest, codeReview: kept };
      };
      checks.push(A.assert('tool.sameRequestAsTheEa', isDeepStrictEqual(comparable(calls[0].request), comparable(sent.request)), 'the same request but for deadlineMs and requestTag'));
      checks.push(A.assert('tool.aiNodeAnswered', calls[0].status === 200, `HTTP ${calls[0].status}`));
    }
    const runs = fs.existsSync(results) ? fs.readdirSync(results) : [];
    const saved = runs.length === 1 ? JSON.parse(fs.readFileSync(path.join(results, runs[0], 'summary.json'), 'utf8')).results[0] : null;
    checks.push(A.assert('tool.saved', Boolean(saved), `${runs.length} run(s) saved`));
    if (saved) {
      checks.push(...C.scoreChecks(saved.scores.map((s) => s.score), h.juryAverage));
      checks.push(A.assert('tool.settled', saved.agrees === true, `settled ${saved.settled && saved.settled.outcome}, expected HIGH`));
      checks.push(A.assert('tool.promptHash', /^[0-9a-f]{64}$/.test(String(saved.prompt_sha256)), `prompt_sha256=${saved.prompt_sha256}`));
    }
    return checks;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A gate-failing claim: all weight on INVALID, the gate named, no AI call. */
async function gateFail(h, requestCid, gate, { runnerCalls, l4 }) {
  const before = h.counts();
  const resp = await h.evaluate(requestCid);
  const after = h.counts();
  const checks = [
    A.assert('response.success', resp && resp.status === 'success', `status=${resp && resp.status}`),
    ...C.invalidScoreChecks(resp && resp.data && resp.data.aggregatedScore),
    ...C.noAiChecks(before, after),
    A.assert('runner.calls', after.runnerCalls - before.runnerCalls === runnerCalls, `${after.runnerCalls - before.runnerCalls} runner call(s), expected ${runnerCalls}`),
    ...C.ipfsChecks(h.ipfs)
  ];
  const cid = resp && resp.data && resp.data.justificationCid;
  checks.push(A.cidAssertion('justificationCid.valid', cid));
  if (A.isLikelyCid(cid)) {
    const json = await justificationOf(h, cid);
    checks.push(A.assert('justification.source', json.metadata && /^code-review-(gate|runner)$/.test(String(json.metadata.verdict_source)), `verdict_source=${json.metadata && json.metadata.verdict_source}`));
    checks.push(A.assert('justification.gate', String(json.justification).includes(gate), `the justification names ${gate}`));
    checks.push(...l4Checks(l4.kind, resp.data.aggregatedScore, cid, json, l4.claimCid, h));
  }
  return checks;
}

async function gateFailCommitReveal(h) {
  const before = h.counts();
  const checks = await commitReveal(h, h.claims.editsSource.requestCid, {
    expectScores: C.invalidScoreChecks,
    l4: { kind: 'runner-gate', claimCid: h.claims.editsSource.cid }
  });
  checks.push(...C.noAiChecks(before, h.counts()));
  return checks;
}

/** Text mode on the arbiter that also serves code review: none of the code path touches it. */
function textChecks(h, before) {
  const calls = h.ai.post(AI_ROUTE).slice(before.aiCalls);
  const provider = h.providerCalls().slice(before.providerCalls);
  const after = h.counts();
  return [
    A.assert('text.aiCalled', calls.length === 1, `${calls.length} AI call(s)`),
    A.assert('text.noCodeReviewField', calls.every((c) => c.request && !('codeReview' in c.request)), 'the request is the text-mode one'),
    A.assert('text.noRunner', after.runnerCalls === before.runnerCalls, `${after.runnerCalls - before.runnerCalls} runner call(s)`),
    A.assert('text.jurorsCalled', provider.filter((c) => c.model !== h.justifier.model).length >= 2, provider.map((c) => c.model).join(', ')),
    A.assert('text.notClaimOptions', provider.every((c) => c.options.effort !== 'high'), 'no juror runs with code mode\'s effort'),
    ...C.ipfsChecks(h.ipfs)
  ];
}

async function textMode0(h) {
  const before = h.counts();
  const resp = await h.evaluate(h.claims.textCid);
  const checks = [
    A.assert('response.success', resp && resp.status === 'success', `status=${resp && resp.status}`),
    ...A.structuralScoreAssertions(resp && resp.data && resp.data.aggregatedScore, { minOutcomes: 2 })
  ];
  const cid = resp && resp.data && resp.data.justificationCid;
  checks.push(A.cidAssertion('justificationCid.valid', cid));
  if (A.isLikelyCid(cid)) {
    const json = await justificationOf(h, cid);
    checks.push(A.assert('text.noEvidenceBlock', !String(json.justification).startsWith('Execution evidence'), 'a text-mode justification'));
  }
  checks.push(...textChecks(h, before));
  return checks;
}

async function textCommitReveal(h) {
  const before = h.counts();
  const checks = await commitReveal(h, h.claims.textCid, { expectScores: (s) => A.structuralScoreAssertions(s, { minOutcomes: 2 }) });
  checks.push(...textChecks(h, before));
  return checks;
}

const HANDLERS = Object.freeze({
  valid: { 0: validMode0, 'commit-reveal': validCommitReveal, 'juror-deadline': validJurorDeadline, 'testing-tool': validTestingTool },
  'gate-fail': {
    'front-gate': (h) => gateFail(h, h.claims.outOfScope.requestCid, 'inScope', { runnerCalls: 0, l4: { kind: 'front-gate', claimCid: h.claims.outOfScope.cid } }),
    'runner-gate': (h) => gateFail(h, h.claims.editsSource.requestCid, 'testPathsOnly', { runnerCalls: 1, l4: { kind: 'runner-gate', claimCid: h.claims.editsSource.cid } }),
    'commit-reveal': gateFailCommitReveal
  },
  text: { 0: textMode0, 'commit-reveal': textCommitReveal }
});

function refuseAll(scenarios, reporter, error) {
  for (const s of scenarios) {
    for (const mode of s.modes && s.modes.length ? s.modes : ['0']) {
      reporter.addCase({ id: s.id, mode, durationMs: 0, error, checks: [] });
    }
  }
}

/**
 * @param {object} cfg - merged config
 * @param {object[]} scenarios - the claim scenarios to run
 * @param {object} opts - { mock, bootAdapter, reporter, startHarness }
 */
async function runClaimSuite(cfg, scenarios, opts) {
  const { reporter } = opts;
  if (!opts.mock) {
    refuseAll(scenarios, reporter, 'a claim scenario runs the AI Node with the mock provider; --real does not apply');
    return;
  }
  if (!opts.bootAdapter) {
    refuseAll(scenarios, reporter, 'a claim scenario needs --boot-adapter: the harness starts every service, with dev trust set explicitly');
    return;
  }
  const start = opts.startHarness || require('./harness').startClaimHarness;
  let h;
  try {
    h = await start(cfg);
  } catch (err) {
    console.log(chalk.red(`[claim] the harness did not start: ${err.message}`));
    refuseAll(scenarios, reporter, `the claim harness did not start: ${err.message}`);
    return;
  }
  try {
    for (const scenario of scenarios) {
      for (const mode of scenario.modes) {
        const started = Date.now();
        try {
          const handler = (HANDLERS[scenario.claim] || {})[mode];
          if (!handler) throw new Error(`no handler for ${scenario.claim}/${mode}`);
          const checks = await handler(h);
          reporter.addCase({ id: scenario.id, mode, durationMs: Date.now() - started, checks });
        } catch (err) {
          const detail = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
          reporter.addCase({ id: scenario.id, mode, durationMs: Date.now() - started, error: detail, checks: [] });
        }
        const lastCase = reporter.cases[reporter.cases.length - 1];
        if ((lastCase.error || lastCase.checks.some((c) => !c.ok)) && h.serviceTails) {
          const tails = h.serviceTails();
          for (const [name, text] of Object.entries(tails)) console.log(chalk.gray(`--- ${name} (last lines)\n${text.slice(-3000)}`));
        }
      }
    }
  } finally {
    await h.close();
  }
}

module.exports = { runClaimSuite };
