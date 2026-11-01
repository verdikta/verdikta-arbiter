/**
 * @fileoverview The deterministic INVALID verdict of a failed claim gate.
 *
 * Design §10.1: when a gate fails, the EA builds a verdict with the full
 * 1,000,000 on the first outcome (INVALID) and a justification naming the
 * gate and its evidence; the verdict takes the normal commit/reveal path and
 * no model is called. This is the malformed-archive settlement
 * (utils/bcidValidation.js) with the claim's gate named instead of a
 * bounty-submission explanation: same result shape as aiClient.evaluate, so
 * the handler's commit / reveal / upload tail needs no special case, and the
 * same vector on every arbiter.
 *
 * The justification is uploaded at reveal and is public, like the revealed
 * claim itself. It is built only from the gate, the check code and common's
 * issue text (paths, hashes), never from key material, and is a pure
 * function of its inputs so every arbiter writes the same one.
 */

const { codeReview } = require('@verdikta/common');

const REASON_MAX_CHARS = 1500;

const GATE_HELP = Object.freeze({
  'claim-archive': 'A claim archive is a ZIP following the submitted-work contract (manifest.json with a primary JSON file) '
    + 'that also carries finding.json (a JSON object), report.md (UTF-8 text), poc.patch (a patch adding a '
    + 'proof-of-concept test) and optionally fix.patch (design §8.5).',
  disclosure: 'The revealed archive must hash to the archiveSha256 committed on-chain, the ciphertext pinned at '
    + 'disclose must hash to the committed ciphertextSha256, and encrypting the archive with the revealed keys '
    + 'to the listing\'s disclosure key must reproduce that ciphertext byte for byte; the request\'s addendum '
    + 'carries these in one strictly formatted line (design §14, erratum E1).',
  inScope: 'finding.json must validate against the finding schema, and every affected path must be inside the '
    + 'stake\'s scope (design §10.1).'
});

function truncate(text, max = REASON_MAX_CHARS) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}… (${value.length - max} more characters)` : value;
}

/**
 * @param {string[]} outcomes - the listing's outcomes (validated: BUG_OUTCOMES, INVALID first)
 * @param {{ gate: string, check: string, reason: string, member?: string, bcid: string }} failure
 * @returns {{ scores: { outcome: string, score: number }[], justification: string, metadata: object }}
 */
function buildCodeReviewInvalidVerdict(outcomes, failure) {
  const { gate, check, reason, member = null, bcid } = failure;
  const scores = outcomes.map((outcome, index) => ({
    outcome,
    score: index === 0 ? codeReview.OUTCOME_MASS_TOTAL : 0
  }));
  const lines = [
    `Verdict: ${outcomes[0]} (deterministic, not an AI judgement).`,
    '',
    `The claim ${bcid} failed a gate that every arbiter checks before any sandbox run or model call, `
      + `so the round settles on the first outcome ("${outcomes[0]}").`,
    '',
    `Gate: ${gate}`
  ];
  if (member) lines.push(`Member: ${member}`);
  lines.push(`Check: ${check}`, `Reason: ${truncate(reason)}`);
  if (GATE_HELP[gate]) lines.push('', GATE_HELP[gate]);

  return {
    scores,
    justification: lines.join('\n'),
    metadata: {
      verdict_source: 'code-review-gate',
      gate,
      check,
      member,
      claim: bcid
    }
  };
}

module.exports = { buildCodeReviewInvalidVerdict, GATE_HELP };
