/**
 * @fileoverview Code-review (stake attestation) mode of the External Adapter.
 *
 * A request is in code mode when the manifest of its primary archive (cids[0],
 * the listing) has the `codeReview` key. The handler calls
 * `evaluateCodeReview` in place of the text-mode AI path; the result has
 * aiClient.evaluate's shape, so the commit / reveal / upload tail is shared.
 *
 *   front gates (frontGates.js) ── requester error ──► errored, no commit
 *        │                      ── claim INVALID  ──► verdict, committed
 *        ▼
 *   run (claimRun.js, node A4b) ──► runner + jury result, or errored
 *
 * Whatever the run returns is checked before the handler may commit it: a
 * mode-1 commit carries a real commitment to a vector over the listing's six
 * outcomes, or the request errors (no commit).
 *
 * Design: docs/development/stake-attestation-design.md (§9.1, §10.1, §12, §14).
 */

const { codeReview } = require('@verdikta/common');
const { runFrontGates, refuseSingleCid } = require('./frontGates');
const claimRun = require('./claimRun');

/** Does this (unvalidated) manifest opt into code review? */
function isCodeReviewManifest(manifest) {
  return Boolean(manifest) && typeof manifest === 'object' && !Array.isArray(manifest)
    && Object.prototype.hasOwnProperty.call(manifest, 'codeReview');
}

/**
 * The run's result must score exactly the listing's outcomes, in order, with
 * non-negative integers summing to 1,000,000. Anything else is a bug in the
 * run, not a verdict: throw, so the arbiter abstains instead of committing it.
 */
function assertRunResult(result, outcomes) {
  const fail = (why) => {
    const error = new Error(`CODE_REVIEW_RUN_RESULT: the code-review run returned ${why}; the arbiter abstains`);
    error.code = 'CODE_REVIEW_RUN_RESULT';
    return error;
  };
  if (!result || typeof result !== 'object' || !Array.isArray(result.scores)) throw fail('no scores');
  if (result.scores.length !== outcomes.length) throw fail(`${result.scores.length} scores for ${outcomes.length} outcomes`);
  let total = 0;
  result.scores.forEach((entry, index) => {
    if (!entry || entry.outcome !== outcomes[index]) throw fail(`a score for an outcome other than ${outcomes[index]} at position ${index}`);
    if (!Number.isSafeInteger(entry.score) || entry.score < 0) throw fail(`a score that is not a non-negative integer at position ${index}`);
    total += entry.score;
  });
  if (total !== codeReview.OUTCOME_MASS_TOTAL) throw fail(`scores summing to ${total}, not ${codeReview.OUTCOME_MASS_TOTAL}`);
  return result;
}

/**
 * @param {object} input - see frontGates.runFrontGates
 * @returns {Promise<{ scores: object[], justification: string, metadata?: object }>}
 */
async function evaluateCodeReview(input) {
  const gates = await runFrontGates(input);
  if (gates.verdict) return gates.verdict;
  const result = await claimRun.runClaim(gates.context, { logger: input.deps.logger, runTag: input.runTag });
  return assertRunResult(result, gates.context.listing.outcomes);
}

module.exports = { isCodeReviewManifest, evaluateCodeReview, refuseSingleCid, assertRunResult };
