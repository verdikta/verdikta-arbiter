'use strict';

/**
 * What an L4 claim scenario asserts about a fulfilled request, as pure functions of what the
 * revealing arbiters uploaded. The rule from the L2 suite holds: a claim scenario passes only
 * on what happened. An abstention, a verdict some other way than the scenario's, an arbiter
 * judging another claim: each fails.
 *
 * These run on real justifications in the L2 claim suite on every PR (src/l2/claim/run-claim.js),
 * so what they read is what the External Adapter writes. What a real chain does to the vector,
 * and what real jurors decide, only a live run can say.
 */

const { codeReview } = require('@verdikta/common');
const { assert } = require('../assertions');
const { invalidScoreChecks } = require('../l2/claim/checks');

const EVIDENCE_HEADER = 'Execution evidence v1';
const EVIDENCE_END = 'End execution evidence';
const REPORT_HASH = /^[0-9a-f]{64}$/;
/** settleBugOutcome wants a stake for what it pays; only `valid` is read here. */
const ANY_STAKE = Object.freeze({ awards: Object.freeze({ LOW: '0', MEDIUM: '0', HIGH: '0', CRITICAL: '0' }), lowestClassCounted: 'LOW' });

/** What each kind of scenario expects of every revealing arbiter. A gate the EA decides has no run, so no evidence block. */
const EXPECTED = Object.freeze({
  valid: Object.freeze({ source: 'code-review-jury', settlement: 'jury', gate: null }),
  'front-gate': Object.freeze({ source: 'code-review-gate', settlement: null, gate: 'inScope' }),
  'runner-gate': Object.freeze({ source: 'code-review-runner', settlement: 'INVALID (testPathsOnly)', gate: 'testPathsOnly' })
});

/**
 * The first Execution evidence block's fields, or null unless the justification opens with
 * one. A reader takes the first block only: jury text follows it and can say anything
 * (external-adapter/src/codeReview/evidence.js).
 * @param {unknown} text
 * @returns {Record<string, string>|null}
 */
function firstEvidenceBlock(text) {
  const lines = String(text === undefined || text === null ? '' : text).split('\n');
  if (lines[0] !== EVIDENCE_HEADER) return null;
  const end = lines.indexOf(EVIDENCE_END);
  if (end < 0) return null;
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(': ');
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 2);
  }
  return fields;
}

const short = (cid) => `${String(cid).slice(0, 8)}…`;
const every = (reports, fails, name, passDetail) => {
  const bad = reports.map(fails).filter(Boolean);
  return assert(name, reports.length > 0 && bad.length === 0, bad.length ? bad.join('; ') : (reports.length ? passDetail : 'no justification to read'));
};

function evidenceChecks(fetched, expected, [listingCid, claimCid]) {
  const blocks = fetched.map((r) => ({ cid: r.cid, block: firstEvidenceBlock(r.json.justification) }));
  const hashes = blocks.map(({ block }) => block && block['Report-SHA256']);
  return [
    every(blocks, ({ cid, block }) => (block ? null : `${short(cid)}: no Execution evidence block first`), 'claim.evidenceFirst', 'every justification opens with the block'),
    every(blocks, ({ cid, block }) => (block && block.Settlement === expected.settlement ? null : `${short(cid)}: Settlement=${block && block.Settlement}`), 'claim.settlement', `Settlement: ${expected.settlement}`),
    every(blocks, ({ cid, block }) => (block && block.Listing === listingCid && block.Claim === claimCid ? null : `${short(cid)}: Listing=${block && block.Listing}, Claim=${block && block.Claim}`), 'claim.evidenceNamesThisClaim', 'every block names this listing and claim'),
    assert('claim.reportHashAgrees', hashes.length > 0 && hashes.every((h) => REPORT_HASH.test(String(h))) && new Set(hashes).size === 1, `${new Set(hashes).size} report hash(es): ${[...new Set(hashes)].join(', ')}`)
  ];
}

/**
 * @param {object} o
 * @param {'valid'|'front-gate'|'runner-gate'} o.kind - the scenario's `claim`
 * @param {Array} o.scores - the aggregated vector
 * @param {Array<{cid: string, json: object|null}>} o.reports - one per revealing arbiter
 * @param {string[]} o.cids - the request's [listing, claim]
 * @param {boolean} [o.assertWinner] - also hold a valid claim to settling valid; real jurors decide that, so only when asked
 * @returns {Array<{ name: string, ok: boolean, detail: string }>}
 */
function claimVerdictChecks({ kind, scores, reports, cids, assertWinner = false }) {
  const expected = EXPECTED[kind];
  if (!expected) throw new Error(`Unknown L4 claim kind: ${kind}`);

  const vector = Array.isArray(scores) ? scores.map(Number) : [];
  const fetched = reports.filter((r) => r.json);
  const metadata = (r) => (r.json.metadata && typeof r.json.metadata === 'object' ? r.json.metadata : {});
  const checks = [
    assert('claim.sixOutcomes', vector.length === codeReview.BUG_OUTCOMES.length, `[${vector.join(', ')}]`),
    assert('claim.fetched', reports.length > 0 && fetched.length === reports.length, `${fetched.length} of ${reports.length} justification(s) fetched`),
    every(fetched, (r) => (metadata(r).verdict_source === expected.source ? null : `${short(r.cid)}: ${metadata(r).verdict_source}`), 'claim.verdictSource', expected.source)
  ];

  if (expected.gate) {
    checks.push(...invalidScoreChecks(vector));
    checks.push(every(fetched, (r) => (metadata(r).gate === expected.gate ? null : `${short(r.cid)}: gate=${metadata(r).gate}`), 'claim.gate', `gate=${expected.gate}`));
  }
  if (expected.settlement) {
    checks.push(...evidenceChecks(fetched, expected, cids));
  } else {
    checks.push(every(fetched, (r) => (metadata(r).claim === cids[1] ? null : `${short(r.cid)}: claim=${metadata(r).claim}`), 'claim.gateNamesThisClaim', 'every verdict names this claim'));
  }
  if (kind === 'valid' && assertWinner) {
    let valid = false;
    let detail = '';
    try {
      const settled = codeReview.settleBugOutcome(vector, ANY_STAKE);
      valid = settled.valid;
      detail = `settles ${settled.outcome}, valid mass ${settled.validMass}`;
    } catch (error) {
      detail = error.message;
    }
    checks.push(assert('claim.settlesValid', valid, detail));
  }
  return checks;
}

module.exports = { claimVerdictChecks, firstEvidenceBlock };
