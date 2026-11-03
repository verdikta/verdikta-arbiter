/**
 * @fileoverview The External Adapter's request to the AI Node in code mode, as a
 * pure function of its input (design §7.2, §10.3; reused by the testing tool, so
 * it requires nothing).
 *
 * The context pack travels as named attachments, in the runner's order, with
 * nothing beside it: report.md, finding.json, the known issues and the prior
 * findings' summaries reach the jury through the pack's budgeted tiers. The
 * `codeReview` field names known issues and prior findings by id only, and carries
 * the Verification Report, its hash and the finding the prompt quotes. The
 * listing's query goes unchanged; no line of the addendum goes at all, since the
 * contract's addendum holds nothing but key material.
 */

const CODE_REVIEW_REQUEST_VERSION = 1;

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * A document with its strings in well-formed Unicode. finding.json is the hunter's,
 * and a JSON escape can write a lone surrogate, which has no canonical form: the
 * AI Node would fail on it, and every arbiter would abstain on a word of the
 * hunter's. The runner's pack treats it the same way.
 */
function wellFormed(value) {
  if (typeof value === 'string') return value.replace(LONE_SURROGATE, '\ufffd');
  if (Array.isArray(value)) return value.map(wellFormed);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [wellFormed(key), wellFormed(entry)]));
  }
  return value;
}

/**
 * @param {object} input
 * @param {string} input.query - the listing's query, from its primary file
 * @param {string[]} input.outcomes
 * @param {object} input.juryParameters - the manifest's panel (AI_NODES, ITERATIONS)
 * @param {string} input.codeClass
 * @param {object} input.report - the Verification Report
 * @param {string} input.reportSha256
 * @param {{ bcid: string, finding: object }} input.claim
 * @param {{ id: string }[]} input.knownIssues - the listing's known issues
 * @param {{ bcid: string }[]} input.priorFindings - in request order
 * @param {{ statementCid: string, statement: string }|null} input.dispute
 * @param {{ files: { name: string, text: string }[] }} input.contextPack
 * @param {number} input.deadlineMs - the time remaining when this is sent
 * @param {string} [input.requestTag]
 * @returns {object} the body of POST /api/rank-and-justify
 */
function buildCodeReviewAiRequest(input) {
  const { juryParameters, contextPack, claim } = input;
  return {
    prompt: input.query,
    outcomes: [...input.outcomes],
    models: juryParameters.AI_NODES.map((node) => ({
      provider: node.AI_PROVIDER,
      model: node.AI_MODEL,
      weight: node.WEIGHT,
      count: node.NO_COUNTS
    })),
    ...(juryParameters.ITERATIONS !== undefined ? { iterations: juryParameters.ITERATIONS } : {}),
    attachments: contextPack.files.map((file) => file.text),
    attachmentNames: contextPack.files.map((file) => file.name),
    ...(input.requestTag ? { requestTag: input.requestTag } : {}),
    codeReview: {
      version: CODE_REVIEW_REQUEST_VERSION,
      codeClass: input.codeClass,
      deadlineMs: input.deadlineMs,
      report: input.report,
      reportSha256: input.reportSha256,
      claim: { bcid: claim.bcid, finding: wellFormed(claim.finding) },
      knownIssues: input.knownIssues.map((issue) => issue.id),
      priorFindings: input.priorFindings.map((prior) => prior.bcid),
      dispute: input.dispute ? { statementCid: input.dispute.statementCid, statement: input.dispute.statement } : null
    }
  };
}

module.exports = { buildCodeReviewAiRequest };
