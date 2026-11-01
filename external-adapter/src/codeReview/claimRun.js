/**
 * @fileoverview The code-review run: the seam node A4b fills.
 *
 * The front gates (frontGates.js) hand this the context of a claim that
 * passed every gate the EA decides before any pull or model call. A4b
 * implements the rest: the single deadline (§11), the shared code-runner
 * call keyed by listing CID + bCID + runner and rule versions + the prior
 * findings (assumption A7), runner gates and integrity failures as INVALID,
 * and the AI Node handoff with the report and the context pack. It must
 * return a result of aiClient.evaluate's shape (scores over the listing's
 * outcomes, a justification) or throw; a throw is the errored path, no
 * commit.
 *
 * The context carries no key material and no machine line: `addendumText`
 * is what of the addendum a model may see ('' for every addendum the
 * contract writes), and `dispute.statement` is the maker's argument, to be
 * fenced as such (§13.3, erratum E2).
 *
 * Until A4b lands there is no runner in this build, so a gate-passing claim
 * makes the arbiter abstain rather than reach a model without the runner's
 * evidence.
 */

/**
 * @param {object} context - see frontGates.runFrontGates
 * @param {{ logger?: object, runTag?: string }} [options]
 * @returns {Promise<{ scores: { outcome: string, score: number }[], justification: string }>}
 */
async function runClaim(context, options = {}) {
  const error = new Error('CODE_REVIEW_RUN_UNAVAILABLE: the code-review run (code-runner and jury) is not in this build; the arbiter abstains');
  error.code = 'CODE_REVIEW_RUN_UNAVAILABLE';
  throw error;
}

module.exports = { runClaim };
