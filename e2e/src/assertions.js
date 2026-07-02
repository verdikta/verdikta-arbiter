'use strict';

/**
 * Shared assertions for the Verdikta E2E harness.
 * Each assertion returns { name, ok, detail } so the reporter can render a
 * uniform pass/fail table across L2 (off-chain) and (later) L4 (on-chain) runs.
 */

/** Coerce a score entry that may be a number, numeric string, or BigInt-like. */
function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return NaN;
}

/** Normalize an aggregatedScore array (numbers or numeric strings) to numbers. */
function normalizeScores(scoreArray) {
  if (!Array.isArray(scoreArray)) return null;
  const nums = scoreArray.map(toNumber);
  if (nums.some(Number.isNaN)) return null;
  return nums;
}

function assert(name, ok, detail) {
  return { name, ok: Boolean(ok), detail: detail || '' };
}

/**
 * Structural invariants for a completed evaluation score vector.
 * @param {Array} scoreArray - aggregatedScore (numbers/strings)
 * @param {object} opts - { minOutcomes, scoreSumTarget, scoreSumSlack }
 */
function structuralScoreAssertions(scoreArray, opts = {}) {
  const { minOutcomes = 2, scoreSumTarget = 1000000, scoreSumSlack = 5 } = opts;
  const results = [];

  const scores = normalizeScores(scoreArray);
  results.push(
    assert('scores.isNumericArray', scores !== null,
      scores === null ? `not a numeric array: ${JSON.stringify(scoreArray)}` : `len=${scores.length}`)
  );
  if (scores === null) return results;

  results.push(
    assert('scores.length>=minOutcomes', scores.length >= minOutcomes,
      `length=${scores.length}, min=${minOutcomes}`)
  );

  const sum = scores.reduce((a, b) => a + b, 0);
  const withinSlack = Math.abs(sum - scoreSumTarget) <= scoreSumSlack;
  results.push(
    assert('scores.sum≈1,000,000', withinSlack,
      `sum=${sum}, target=${scoreSumTarget}, slack=±${scoreSumSlack}`)
  );

  results.push(
    assert('scores.allNonNegative', scores.every((s) => s >= 0),
      `min=${Math.min(...scores)}`)
  );

  return results;
}

/** Index of the maximum score (argmax); -1 for empty/invalid. */
function winnerIndex(scoreArray) {
  const scores = normalizeScores(scoreArray);
  if (!scores || scores.length === 0) return -1;
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  return best;
}

/** Assert the winning (argmax) outcome index equals the expected index. */
function winnerAssertion(scoreArray, expectedIndex) {
  const idx = winnerIndex(scoreArray);
  return assert('winner.index===expected', idx === expectedIndex,
    `winnerIndex=${idx}, expected=${expectedIndex}`);
}

/** A CID looks valid if it's a non-empty CIDv0 (Qm...) or CIDv1 (bafy.../b...) string. */
function isLikelyCid(cid) {
  if (typeof cid !== 'string' || cid.length < 10) return false;
  return /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,}|baf[a-z0-9]{20,})$/.test(cid.trim());
}

function cidAssertion(name, cid) {
  return assert(name, isLikelyCid(cid), `cid=${JSON.stringify(cid)}`);
}

/** Mode-2 reveal returns "<cid>:<salt>" where salt is 20 lowercase hex chars. */
function cidWithSaltAssertion(value) {
  const results = [];
  const ok = typeof value === 'string' && value.includes(':');
  results.push(assert('reveal.hasCidAndSalt', ok, `value=${JSON.stringify(value)}`));
  if (!ok) return results;
  const [cid, salt] = value.split(':');
  results.push(cidAssertion('reveal.cidValid', cid));
  results.push(assert('reveal.saltIs20Hex', /^[0-9a-f]{20}$/.test(salt || ''), `salt=${salt}`));
  return results;
}

/** Mode-1 commit returns a single decimal commitment in aggregatedScore[0]. */
function commitAssertions(scoreArray, justificationCid) {
  const results = [];
  results.push(assert('commit.singleElement', Array.isArray(scoreArray) && scoreArray.length === 1,
    `len=${Array.isArray(scoreArray) ? scoreArray.length : 'n/a'}`));
  const c = scoreArray && scoreArray[0];
  results.push(assert('commit.isPositiveInteger', /^[0-9]+$/.test(String(c)) && String(c) !== '0',
    `commitment=${c}`));
  results.push(assert('commit.emptyJustificationCid', !justificationCid,
    `justificationCid=${JSON.stringify(justificationCid)}`));
  return results;
}

module.exports = {
  toNumber,
  normalizeScores,
  assert,
  structuralScoreAssertions,
  winnerIndex,
  winnerAssertion,
  isLikelyCid,
  cidAssertion,
  cidWithSaltAssertion,
  commitAssertions,
};
