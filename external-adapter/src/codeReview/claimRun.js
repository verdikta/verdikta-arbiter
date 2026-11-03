/**
 * @fileoverview The code-review run: everything after the front gates (design
 * §7, §9.2 step 1, §10.1, §10.5, §11, §12; owner decision Q35).
 *
 *   /health ── unreachable, unhealthy ──► abstain
 *      │
 *   the shared run (one per key across this operator's jobs)
 *      │ ── abstain, or anything that is not a fact ──► abstain
 *      │
 *   this claim's report? right versions? a pinned runtime? ── no ──► abstain
 *      │
 *   settleReport ── a gate, a tamper flag ──► INVALID, no model
 *      │         ── another failed check  ──► DUPLICATE, no model
 *      │
 *   the AI Node, once, or twice on its retryable status, while the jury can finish
 *
 * The result has aiClient.evaluate's shape, or this throws: a throw is the errored
 * path, no commit, in every mode. Never `PROVIDER_ERROR:`, whose mode-0 path answers
 * 200 + [0]. The EA's text-mode AI client is not used: it retries on its own, with
 * no deadline.
 *
 * Logs carry CIDs, hashes and codes, never archive contents or keys (§16).
 */

const axios = require('axios');
const crypto = require('crypto');
const { codeReview } = require('@verdikta/common');
const { CodeReviewAbstain, issueCodes } = require('./errors');
const { juryWorthCalling } = require('./time');
const { runKey, sharedRuns } = require('./sharedRuns');
const { runnerHealth, buildRunRequest, postRun } = require('./runnerClient');
const { settleReport } = require('./settlement');
const { buildExecutionEvidence } = require('./evidence');
const { buildRunnerVerdict } = require('./verdict');
const { buildCodeReviewAiRequest } = require('./aiRequest');
const { faultForRequest } = require('../canaryFault');

const AI_ROUTE = '/api/rank-and-justify';
/** One retry (§11): the first call and one more. */
const AI_ATTEMPTS = 2;
/** The most an AI Node's answer may hold: scores and a justification. */
const MAX_AI_ANSWER_BYTES = 64 * 1024 * 1024;
const CODE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
/** What an AI Node may say about its fault switch (ai-node/src/lib/code-review/canary-fault.ts). */
const AI_SWITCH_STATES = Object.freeze(['off', 'armed', 'refused']);
const AI_SWITCH_ACTIONS = Object.freeze(['hold-juror-answer', 'late-juror', 'hold-justifier-answer']);

const abstain = (code, detail) => new CodeReviewAbstain(code, detail);
const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * Does the shared run's report belong to this job's claim, on what the key named?
 * Checked per job, so a bug in the key, or another gateway's bytes under one CID,
 * abstains rather than settling a claim on another listing's run.
 */
function assertReportIsThisClaims(report, context, { runnerVersion, rulesVersion }) {
  const { listing, claim } = context;
  const { inputs } = report;
  const image = String(listing.spec.env.image);
  const fixPatch = claim.fixPatch && claim.fixPatch.length > 0 ? claim.fixPatch : null;
  const expected = {
    listingCid: listing.cid,
    bcid: claim.bcid,
    envImage: image.slice(image.indexOf('@') + 1),
    attestationSha256: sha256Hex(Buffer.from(codeReview.canonicalJson(listing.attestation), 'utf8')),
    baseCommit: listing.spec.baseCommit,
    pocPatchSha256: sha256Hex(claim.pocPatch),
    fixPatchSha256: fixPatch ? sha256Hex(fixPatch) : null,
    runner: runnerVersion,
    semgrepRules: rulesVersion
  };
  const wrong = Object.keys(expected).filter((field) => inputs[field] !== expected[field]);
  if (wrong.length > 0) {
    throw abstain('CODE_REVIEW_RUN_MISMATCH', `the report is not this claim's run: ${wrong.join(', ')} differ`);
  }
}

/**
 * Production trust is judged under the pinned gVisor only. The runner refuses
 * any other release of runsc itself; `runc` is its local mode, for a test chain
 * under dev trust. A verdict from another sandbox could differ from the network's.
 */
function assertRuntime(report, context) {
  if (context.trust === 'production' && report.inputs.gvisor !== codeReview.GVISOR_RELEASE) {
    throw abstain('CODE_REVIEW_RUNTIME_NOT_PINNED', `a production-trust listing was run under another runtime than ${codeReview.GVISOR_RELEASE}`);
  }
}

/** The pack must be there, in this class, within its budget, and text the AI Node reads as text. */
function assertPack(pack, context) {
  const bad = (why) => abstain('CODE_REVIEW_PACK', `the context pack cannot go to the jury: ${why}`);
  if (!pack || !Array.isArray(pack.files) || pack.files.length === 0) throw bad('the run returned none');
  if (pack.codeClass !== context.codeClass) throw bad('it was built for another class');
  if (!Number.isInteger(pack.usedTokens) || !Number.isInteger(pack.budgetTokens) || pack.usedTokens > pack.budgetTokens) {
    throw bad('it is over its budget');
  }
  for (const file of pack.files) {
    if (!file || typeof file.name !== 'string' || file.name === '' || typeof file.text !== 'string') throw bad('a file has no name or text');
    if (file.text.startsWith('data:')) throw bad('a file would read as a data URI');
  }
}

async function postToAiNode(aiNode, body, { deadline }) {
  const stop = deadline.abortAtDeadline();
  try {
    return await axios.post(`${aiNode.url.replace(/\/+$/, '')}${AI_ROUTE}`, body, {
      signal: stop.signal,
      validateStatus: () => true,
      maxRedirects: 0,
      proxy: false,
      maxBodyLength: Infinity,
      maxContentLength: MAX_AI_ANSWER_BYTES
    });
  } catch (error) {
    if (stop.signal.aborted) throw deadline.expired('AI Node answered');
    throw abstain('CODE_REVIEW_AI_UNREACHABLE', `the AI Node's answer did not arrive (${typeof error.code === 'string' && CODE.test(error.code) ? error.code : 'unknown'})`);
  } finally {
    stop.clear();
  }
}

/** The jury's verdict, from the run held by this job: a retry never goes back to a sandbox. */
async function askJury(context, run, { config, deadline, logger, runTag, fault }) {
  const { listing, claim } = context;
  const payload = (deadlineMs, attempt) => buildCodeReviewAiRequest({
    query: listing.query,
    outcomes: listing.outcomes,
    juryParameters: listing.juryParameters,
    codeClass: context.codeClass,
    report: run.report,
    reportSha256: run.reportSha256,
    claim: { bcid: claim.bcid, finding: claim.finding },
    knownIssues: listing.knownIssues,
    priorFindings: context.priorFindings,
    dispute: context.dispute,
    contextPack: run.contextPack,
    deadlineMs,
    requestTag: `${runTag} attempt=${attempt}`
  });

  const earlier = [];
  for (let attempt = 1; attempt <= AI_ATTEMPTS; attempt += 1) {
    const remaining = deadline.remaining();
    if (!juryWorthCalling(remaining)) {
      throw abstain('CODE_REVIEW_DEADLINE', `${remaining} ms left is too little for a juror and the justifier; no model is called`);
    }
    const body = payload(remaining, attempt);
    const checked = codeReview.validateCodeReviewRequest(body.codeReview);
    if (!checked.ok) {
      throw abstain('CODE_REVIEW_AI_REQUEST', `the request does not validate, so no model is called: ${issueCodes(checked.issues)}`);
    }
    logger.info(`${runTag} code-review jury attempt ${attempt}: report=${run.reportSha256} deadlineMs=${remaining} files=${body.attachments.length}`);
    // Beside the request, never in it: the prompt, the report and the pack are as they were.
    const directive = fault ? fault.directiveFor(attempt, { bcid: claim.bcid, reportSha256: run.reportSha256 }) : null;
    const response = await postToAiNode(config.aiNode, directive ? { ...body, canaryFault: directive } : body, { deadline });
    const answer = response.data && typeof response.data === 'object' ? response.data : {};
    if (response.status === 200) return { answer, attempts: attempt, earlier };

    const errorCode = typeof answer.errorCode === 'string' && CODE.test(answer.errorCode) ? answer.errorCode : 'unknown';
    logger.warn(`${runTag} code-review AI Node answered ${response.status} ${errorCode} (attempt ${attempt})`);
    earlier.push({ action: aiSwitchStamp(answer).action, errorCode });
    const retryable = response.status === 503 && answer.retryable === true;
    if (!retryable || attempt === AI_ATTEMPTS) {
      throw abstain('CODE_REVIEW_AI_ABSTAIN', `the AI Node answered ${response.status} ${errorCode}`);
    }
  }
  throw abstain('CODE_REVIEW_AI_ABSTAIN', 'the AI Node gave no verdict'); // the loop returns or throws
}

const wholeMs = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/** What the AI Node said of its fault switch, as far as it is one of the words that can be said. */
function aiSwitchStamp(answer) {
  const stamp = (answer.codeReview && answer.codeReview.canaryFault) || answer.canaryFault;
  const said = stamp && typeof stamp === 'object' ? stamp : {};
  return {
    state: AI_SWITCH_STATES.includes(said.state) ? said.state : 'unknown',
    action: AI_SWITCH_ACTIONS.includes(said.action) ? said.action : null,
    justifierMs: wholeMs(said.justifierMs)
  };
}

/**
 * What an L4 scenario reads off a jury verdict, in the upload's metadata, which no settlement
 * reads: the AI Node's switch, how the image was had, the dispute's statement, and what a
 * fault did. Enums, counts and CIDs only.
 */
function verdictFacts(answer, run, context, { fault, attempts, earlier }) {
  const stamp = aiSwitchStamp(answer);
  return {
    canary_fault_ai_node: stamp.state,
    runner_image: run.image || null,
    ...(context.dispute ? { dispute_statement: context.dispute.statementCid } : {}),
    ...(fault ? {
      canary_fault: fault.refused
        ? { fault: fault.fault, refused: fault.refused }
        : { fault: fault.fault, attempts, earlierAttempts: earlier, action: stamp.action, jurorTimeoutMs: wholeMs(answer.codeReview && answer.codeReview.jurorTimeoutMs), justifierMs: stamp.justifierMs }
    } : {})
  };
}

/** The jury's answer as the upload reads it, with the block first. */
function juryResult(answer, run, facts) {
  const stamp = answer.codeReview && answer.codeReview.reportSha256;
  if (stamp !== run.reportSha256) {
    throw abstain('CODE_REVIEW_AI_ANSWER', 'the AI Node\'s verdict does not name this report');
  }
  if (typeof answer.justification !== 'string' || answer.justification.trim() === '' || !Array.isArray(answer.scores)) {
    throw abstain('CODE_REVIEW_AI_ANSWER', 'the AI Node\'s verdict has no scores or no justification');
  }
  return {
    scores: answer.scores.map((entry) => ({ outcome: entry && entry.outcome, score: entry && entry.score })),
    justification: `${buildExecutionEvidence(run.report, run.reportSha256)}\n\n${answer.justification}`,
    metadata: { ...(answer.metadata && typeof answer.metadata === 'object' ? answer.metadata : {}), verdict_source: 'code-review-jury', reportSha256: run.reportSha256, ...facts },
    model_results: Array.isArray(answer.model_results) ? answer.model_results : [],
    warnings: Array.isArray(answer.warnings) ? answer.warnings : []
  };
}

/**
 * @param {object} context - see frontGates.runFrontGates
 * @param {object} options
 * @param {object} options.config - config.runner (url, readToken) and config.aiNode (url)
 * @param {object} options.deadline - time.createDeadline's
 * @param {object} [options.logger]
 * @param {string} [options.runTag]
 * @param {object} [options.runs] - the shared runs (default: the process's)
 * @param {{ aggId?: string, jobId?: string }} [options.canaryRequest] - the bridge's ids, for the fault switch to measure this request
 * @param {object} [options.canaryConfig] - the switch's configuration (default: the process's)
 * @returns {Promise<{ scores: { outcome: string, score: number }[], justification: string, metadata: object }>}
 * @throws {Error} the errored path, no commit
 */
async function runClaim(context, options) {
  const { config, deadline, runs = sharedRuns, runTag = '' } = options;
  const logger = options.logger || { info() {}, warn() {}, error() {}, debug() {} };
  const { listing, claim } = context;
  deadline.assertOpen('runner was called');

  const { version: runnerVersion } = await runnerHealth(config.runner, { deadline });
  const rulesVersion = codeReview.SEMGREP_RULES_VERSION;
  const key = runKey({
    listingCid: listing.cid,
    bcid: claim.bcid,
    runnerVersion,
    rulesVersion,
    codeClass: context.codeClass,
    priorFindings: context.priorFindings
  });

  // A job waiting on another job's run keeps its own deadline, and leaves that run alone.
  const run = await deadline.race(runs.run(key, () => {
    const remaining = deadline.remaining();
    if (remaining < 1) throw deadline.expired('runner was called');
    logger.info(`${runTag} code-review run start key=${key} runner=${runnerVersion} deadline=${remaining}${context.warnings && context.warnings.length ? ` warnings=${context.warnings.join(',')}` : ''}`);
    return postRun(config.runner, buildRunRequest(context, remaining), { deadline });
  }), 'runner answered');

  assertReportIsThisClaims(run.report, context, { runnerVersion, rulesVersion });
  assertRuntime(run.report, context);
  if (run.warnings && run.warnings.length > 0) {
    logger.warn(`${runTag} code-review report ${run.reportSha256}: ${[...new Set(run.warnings)].join(', ')}`);
  }

  const settlement = settleReport(run.report);
  logger.info(`${runTag} code-review report=${run.reportSha256} settles ${settlement.kind}${settlement.gate ? ` (${settlement.gate}, ${settlement.check})` : ''}`);
  if (settlement.kind !== 'jury') return buildRunnerVerdict(listing.outcomes, settlement, run);

  assertPack(run.contextPack, context);
  // Only here, with the run settled for the jury: the switch never meets the runner or a gate.
  const fault = await faultForRequest({ bcid: claim.bcid, ...options.canaryRequest }, { config: options.canaryConfig, logger, runTag });
  const { answer, attempts, earlier } = await askJury(context, run, { config, deadline, logger, runTag, fault });
  return juryResult(answer, run, verdictFacts(answer, run, context, { fault, attempts, earlier }));
}

module.exports = { runClaim, assertReportIsThisClaims };
