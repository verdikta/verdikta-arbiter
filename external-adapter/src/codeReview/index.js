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
 *   run (claimRun.js, node A4b) ──► a runner verdict or the jury's, or errored
 *
 * One deadline runs from receipt through all of it (§11, time.js). Whatever comes
 * out is checked before the handler may commit it: a mode-1 commit carries a real
 * commitment to a vector over the listing's six outcomes, made by the deadline,
 * or the request errors (no commit).
 *
 * Design: docs/development/stake-attestation-design.md (§9.1, §10.1, §11, §12, §14).
 */

const { codeReview } = require('@verdikta/common');
const { runFrontGates, refuseSingleCid, assertOperatorReady, assertRequestLayout } = require('./frontGates');
const claimRun = require('./claimRun');
const { createDeadline } = require('./time');
const { buildCodeReviewAiRequest } = require('./aiRequest');

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
 * The checks that need only the configuration and the CID list (operator
 * switch, then request layout), for the handler to run before any claim
 * archive is extracted. runFrontGates repeats them.
 */
function assertCodeReviewRequest(config, cidArray) {
  assertOperatorReady(config);
  assertRequestLayout(cidArray);
}

/**
 * The archive fetches, held to the deadline on an arbiter that serves code review
 * (§11). The request's mode is only known once they are done, since its manifest
 * is in the archive being fetched, so a text-mode request on that arbiter gets the
 * same bound. It only ever cuts a request off at 780 s or so, and the IPFS client
 * gives up on each fetch long before. A fetch may be shared with another job:
 * this leaves it running, and only this job stops waiting.
 *
 * @param {object} config - getCodeReviewConfig()
 * @param {number} receivedAt - epoch ms
 * @param {Promise<object>} triage - fetchAndTriageArchives's
 * @param {() => void} onStop - called when this job stops waiting
 * @returns {Promise<object>} what the triage resolves to
 */
function boundFetches(config, receivedAt, triage, onStop) {
  if (!config.ready) return triage;
  const deadline = createDeadline({ receivedAt, deadlineMs: config.deadlineMs });
  return deadline.race(triage, 'archives were fetched').catch((error) => {
    onStop();
    throw error;
  });
}

/**
 * @param {object} input - see frontGates.runFrontGates
 * @param {number} [input.receivedAt] - when the adapter received the request, epoch ms (the deadline's start)
 * @param {{ aggId?: string, jobId?: string }} [input.canaryRequest] - the bridge's ids
 * @returns {Promise<{ scores: object[], justification: string, metadata?: object }>}
 */
async function evaluateCodeReview(input) {
  const deadline = createDeadline({
    receivedAt: input.receivedAt === undefined ? Date.now() : input.receivedAt,
    deadlineMs: input.config.deadlineMs
  });
  const gates = await deadline.race(runFrontGates({ ...input, deadline }), 'front gates finished');
  let result;
  if (gates.verdict) {
    result = gates.verdict;
  } else {
    result = assertRunResult(await claimRun.runClaim(gates.context, {
      config: input.config,
      deadline,
      logger: input.deps.logger,
      runTag: input.runTag,
      canaryRequest: input.canaryRequest
    }), gates.context.listing.outcomes);
  }
  // Nothing is committed late (§11): whichever way the verdict was reached.
  deadline.assertOpen('verdict was ready to commit');
  return result;
}

module.exports = { isCodeReviewManifest, assertCodeReviewRequest, boundFetches, evaluateCodeReview, refuseSingleCid, assertRunResult, buildCodeReviewAiRequest };
