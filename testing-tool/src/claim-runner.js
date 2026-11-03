const axios = require('axios');
const { codeReview } = require('@verdikta/common');
const { CLAIM_DEADLINE_MS, buildClaimRequest } = require('./claim-scenarios');

/**
 * Sending a claim scenario to the AI Node.
 *
 * Not TestRunner.callAINode: that retries anything three times inside a 60 s timeout, and
 * every repeat of a claim is another provider bill. As the External Adapter does (claimRun.js,
 * design §11): at most two calls, the second only on 503 with `retryable: true`, and the
 * wait set by the request's own deadline, since the AI Node answers at it.
 */

const AI_ROUTE = '/api/rank-and-justify';
const AI_ATTEMPTS = 2;
/** What the HTTP wait adds to the deadline: the AI Node answers at its deadline, and the answer has to arrive. */
const HTTP_MARGIN_MS = 15000;

const claimHttpTimeoutMs = (deadlineMs) => deadlineMs + HTTP_MARGIN_MS;

/**
 * @param {string} aiNodeUrl
 * @param {object} body - buildClaimRequest's
 * @param {{ deadlineMs: number }} options
 * @returns {Promise<object>} the AI Node's 200 answer
 * @throws {Error} any other answer: the status and the AI Node's error code, never the request
 */
async function callClaim(aiNodeUrl, body, { deadlineMs }) {
  const url = `${aiNodeUrl.replace(/\/+$/, '')}${AI_ROUTE}`;
  for (let attempt = 1; ; attempt += 1) {
    const response = await axios.post(url, body, {
      timeout: claimHttpTimeoutMs(deadlineMs),
      validateStatus: () => true,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      proxy: false
    });
    if (response.status === 200) return response.data;
    const answer = response.data && typeof response.data === 'object' ? response.data : {};
    const retryable = response.status === 503 && answer.retryable === true;
    if (!retryable || attempt === AI_ATTEMPTS) {
      const detail = typeof answer.error === 'string' ? `: ${answer.error}` : '';
      throw new Error(`the AI Node answered ${response.status} ${answer.errorCode || 'with no error code'} after ${attempt} call(s)${detail}`);
    }
  }
}

/** The answer's scores in the listing's order, or a throw: a verdict over anything else is not one. */
function vectorOf(scores) {
  if (!Array.isArray(scores) || scores.length !== codeReview.BUG_OUTCOMES.length
    || !codeReview.BUG_OUTCOMES.every((outcome, i) => scores[i] && scores[i].outcome === outcome)) {
    throw new Error(`the AI Node's answer does not score the outcomes ${codeReview.BUG_OUTCOMES.join(', ')}`);
  }
  return scores.map((entry) => entry.score);
}

/**
 * One scenario, one result, in the shape results-manager.js saves, plus how the verdict
 * settles by the listing's stake. A disagreement with `expected_outcome` is a measurement,
 * not an error: only a request that did not give a verdict is an error.
 *
 * @param {object} scenario - loadClaimScenario's
 * @param {{ aiNodeUrl: string, deadlineMs?: number }} options
 * @returns {Promise<object>}
 */
async function runClaimScenario(scenario, { aiNodeUrl, deadlineMs = CLAIM_DEADLINE_MS }) {
  const started = Date.now();
  const base = {
    scenario_id: scenario.scenario_id,
    jury_id: 'listing',
    expected_outcome: scenario.expected_outcome === undefined ? null : scenario.expected_outcome,
    report_sha256: scenario.input.reportSha256,
    timestamp: new Date().toISOString()
  };
  try {
    const body = buildClaimRequest(scenario, { deadlineMs, requestTag: `[testing-tool ${scenario.scenario_id}]` });
    const answer = await callClaim(aiNodeUrl, body, { deadlineMs });
    const settled = codeReview.settleBugOutcome(vectorOf(answer.scores), scenario.stake);
    return {
      ...base,
      scores: answer.scores,
      justification: typeof answer.justification === 'string' ? answer.justification : '',
      execution_time_ms: Date.now() - started,
      settled: { outcome: settled.outcome, valid: settled.valid, class: settled.class, validMass: settled.validMass, classMass: settled.classMass },
      agrees: scenario.expected_outcome === undefined ? null : settled.outcome === scenario.expected_outcome,
      prompt_sha256: answer.codeReview && answer.codeReview.promptSha256 ? answer.codeReview.promptSha256 : null,
      model_results: Array.isArray(answer.model_results) ? answer.model_results : []
    };
  } catch (error) {
    return {
      ...base,
      scores: [],
      justification: '',
      execution_time_ms: Date.now() - started,
      settled: null,
      agrees: null,
      prompt_sha256: null,
      error: error.message
    };
  }
}

module.exports = { callClaim, runClaimScenario, claimHttpTimeoutMs };
