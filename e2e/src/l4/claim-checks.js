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

const JURY = Object.freeze({ source: 'code-review-jury', settlement: 'jury', gate: null });

/** What each kind of scenario expects of every revealing arbiter. A gate the EA decides has no run, so no evidence block. */
const EXPECTED = Object.freeze({
  valid: JURY,
  'front-gate': Object.freeze({ source: 'code-review-gate', settlement: null, gate: 'inScope' }),
  'runner-gate': Object.freeze({ source: 'code-review-runner', settlement: 'INVALID (testPathsOnly)', gate: 'testPathsOnly' }),
  // A3b's named fixtures: what moves between hosts must not reach the report.
  'time-dependent': JURY,
  'randomness-dependent': JURY,
  flaky: Object.freeze({ source: 'code-review-runner', settlement: 'INVALID (reproduces)', gate: 'reproduces' }),
  // The fault switch's verdicts: the same as any, plus what the switch says it did.
  'near-limit-juror': Object.freeze({ ...JURY, fault: 'near-limit-juror' }),
  'provider-timeout': Object.freeze({ ...JURY, fault: 'provider-timeout' }),
  'slow-justifier': Object.freeze({ ...JURY, fault: 'slow-justifier' }),
  'cold-cache': Object.freeze({ ...JURY, cold: true }),
  dispute: Object.freeze({ ...JURY, dispute: true })
});

/** §11: the image pull's budget. */
const PULL_BUDGET_MS = 90000;
/** The fault switch holds to 5 s under a limit; this leaves the rest for scheduling. */
const FAULT_NEAR_MS = 15000;
const JUSTIFIER_RESERVE_MS = 45000;

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

/**
 * The hashes must be one, and the assertion stays strict about it: a test's message steady on
 * one host and different on another (limit P1, #137) gives two hashes and fails here. No
 * settlement reads `message`, so the verdict is not at stake, but §18's 100% is. What L4 can
 * add from outside the host: whether the blocks differ in anything else.
 */
function hashDetail(blocks, hashes) {
  const distinct = [...new Set(hashes)];
  const detail = `${distinct.length} report hash(es): ${distinct.join(', ')}`;
  if (distinct.length < 2 || blocks.some(({ block }) => !block)) return detail;
  const rest = new Set(blocks.map(({ block }) => {
    const { 'Report-SHA256': _hash, ...others } = block;
    return JSON.stringify(others);
  }));
  return rest.size === 1
    ? `${detail}. The evidence blocks agree on everything else, so the difference is outside the block: a test's message, limit P1 (#137). Read the hosts' reports before calling it a defect`
    : detail;
}

function evidenceChecks(fetched, expected, [listingCid, claimCid]) {
  const blocks = fetched.map((r) => ({ cid: r.cid, block: firstEvidenceBlock(r.json.justification) }));
  const hashes = blocks.map(({ block }) => block && block['Report-SHA256']);
  return [
    every(blocks, ({ cid, block }) => (block ? null : `${short(cid)}: no Execution evidence block first`), 'claim.evidenceFirst', 'every justification opens with the block'),
    every(blocks, ({ cid, block }) => (block && block.Settlement === expected.settlement ? null : `${short(cid)}: Settlement=${block && block.Settlement}`), 'claim.settlement', `Settlement: ${expected.settlement}`),
    every(blocks, ({ cid, block }) => (block && block.Listing === listingCid && block.Claim === claimCid ? null : `${short(cid)}: Listing=${block && block.Listing}, Claim=${block && block.Claim}`), 'claim.evidenceNamesThisClaim', 'every block names this listing and claim'),
    assert('claim.reportHashAgrees', hashes.length > 0 && hashes.every((h) => REPORT_HASH.test(String(h))) && new Set(hashes).size === 1, hashDetail(blocks, hashes))
  ];
}

const metadataOf = (r) => (r.json.metadata && typeof r.json.metadata === 'object' ? r.json.metadata : {});

/** What the run named, on every arbiter: its adapter's block, and on a jury verdict its AI Node. */
function faultSwitchChecks(fetched, expected, faultSwitch) {
  const stateOf = (r) => {
    const block = r.json.arbiter && r.json.arbiter.canaryFault;
    return block && typeof block === 'object' ? block.state : undefined;
  };
  const checks = [every(fetched, (r) => (stateOf(r) === faultSwitch.ea ? null : `${short(r.cid)}: ${stateOf(r)}`), 'claim.faultSwitch', `every adapter says ${faultSwitch.ea}`)];
  if (expected.source === JURY.source) {
    checks.push(every(fetched, (r) => (metadataOf(r).canary_fault_ai_node === faultSwitch.aiNode ? null : `${short(r.cid)}: ${metadataOf(r).canary_fault_ai_node}`), 'claim.aiNodeFaultSwitch', `every AI Node says ${faultSwitch.aiNode}`));
  }
  return checks;
}

/** Did this arbiter do what the fault asks? null when it did, or why not. */
function faultProblem(r, fault) {
  const applied = metadataOf(r).canary_fault;
  if (!applied || typeof applied !== 'object') return 'no fault reported';
  if (applied.refused) return `refused: ${applied.refused}`;
  if (applied.fault !== fault) return `fault ${applied.fault}`;
  if (fault === 'near-limit-juror') {
    if (applied.action !== 'hold-juror-answer') return `action ${applied.action}`;
    const results = Array.isArray(r.json.model_results) ? r.json.model_results : [];
    const slowest = results.reduce((most, m) => Math.max(most, Number(m.duration_ms) || 0), 0);
    return slowest >= Number(applied.jurorTimeoutMs) - FAULT_NEAR_MS ? null : `slowest juror ${slowest} ms of ${applied.jurorTimeoutMs}`;
  }
  if (fault === 'provider-timeout') {
    if (applied.attempts !== 2 || applied.action !== null) return `attempts ${applied.attempts}, action ${applied.action}`;
    // Any timeout gives two attempts: this one has to be the switch's, as the AI Node verified it.
    const first = Array.isArray(applied.earlierAttempts) ? applied.earlierAttempts[0] : null;
    return first && first.action === 'late-juror' && first.errorCode === 'CODE_REVIEW_JUROR_TIMEOUT' ? null : `the first attempt: ${JSON.stringify(first)}`;
  }
  if (fault === 'slow-justifier') {
    if (applied.action !== 'hold-justifier-answer') return `action ${applied.action}`;
    return Number(applied.justifierMs) >= JUSTIFIER_RESERVE_MS - FAULT_NEAR_MS ? null : `justifier ${applied.justifierMs} ms`;
  }
  return `no rule for ${fault}`;
}

/** The runner's own fact, from each arbiter: pulled, or a pull another run on that host started. Never already there, and never a kept run of an earlier round (`reused`). */
function coldChecks(fetched) {
  const imageOf = (r) => metadataOf(r).runner_image;
  const isCold = (r) => Boolean(imageOf(r)) && (imageOf(r).cache === 'pulled' || imageOf(r).cache === 'shared');
  return [
    assert('claim.imageCold',
      fetched.length > 0 && fetched.every(isCold) && fetched.some((r) => imageOf(r).cache === 'pulled'),
      fetched.map((r) => `${short(r.cid)}: ${imageOf(r) ? imageOf(r).cache : 'no fact'}`).join('; ')),
    every(fetched, (r) => (imageOf(r) && imageOf(r).durationMs <= PULL_BUDGET_MS ? null : `${short(r.cid)}: ${imageOf(r) ? imageOf(r).durationMs : '?'} ms`), 'claim.pullWithinBudget',
      `${fetched.map((r) => (imageOf(r) ? `${imageOf(r).durationMs} ms` : '?')).join(', ')}, each at most ${PULL_BUDGET_MS} ms (§11)`)
  ];
}

/**
 * @param {object} o
 * @param {string} o.kind - the scenario's `claim`, one of EXPECTED
 * @param {Array} o.scores - the aggregated vector
 * @param {Array<{cid: string, json: object|null}>} o.reports - one per revealing arbiter
 * @param {string[]} o.cids - the request's [listing, claim]
 * @param {boolean} [o.assertWinner] - also hold a valid claim to settling valid; real jurors decide that, so only when asked
 * @param {{ ea: string, aiNode: string }} [o.faultSwitch] - the state every arbiter must report (default off)
 * @param {string} [o.statementCid] - a dispute round's statement
 * @returns {Array<{ name: string, ok: boolean, detail: string }>}
 */
function claimVerdictChecks({ kind, scores, reports, cids, assertWinner = false, faultSwitch = Object.freeze({ ea: 'off', aiNode: 'off' }), statementCid = null }) {
  const expected = EXPECTED[kind];
  if (!expected) throw new Error(`Unknown L4 claim kind: ${kind}`);

  const vector = Array.isArray(scores) ? scores.map(Number) : [];
  const fetched = reports.filter((r) => r.json);
  const metadata = metadataOf;
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
  checks.push(...faultSwitchChecks(fetched, expected, faultSwitch));
  if (expected.fault) {
    checks.push(every(fetched, (r) => {
      const problem = faultProblem(r, expected.fault);
      return problem ? `${short(r.cid)}: ${problem}` : null;
    }, 'claim.faultApplied', `every arbiter's ${expected.fault} did what it says`));
  } else {
    checks.push(every(fetched, (r) => (metadata(r).canary_fault === undefined ? null : `${short(r.cid)}: ${JSON.stringify(metadata(r).canary_fault)}`), 'claim.noFault', 'no fault touched this claim'));
  }
  if (expected.cold) checks.push(...coldChecks(fetched));
  if (expected.dispute) {
    checks.push(every(fetched, (r) => (metadata(r).dispute_statement === statementCid ? null : `${short(r.cid)}: ${metadata(r).dispute_statement}`), 'claim.disputeStatement', `every arbiter names ${short(statementCid)}`));
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

/**
 * Is this every recorded reveal, once each? The one test, for the assertion and for whether a
 * round's reveals may count as a measurement of the spread.
 * @param {{ reveals: Array<{ slot: number }>, responseCount: number|null, error: string|null }} o
 */
function revealsAreComplete({ reveals, responseCount, error }) {
  return error === null && Number.isInteger(responseCount) && responseCount > 0
    && reveals.length === responseCount && new Set(reveals.map((r) => r.slot)).size === responseCount;
}

/**
 * What the reveal transactions say against what the aggregator and the uploads say.
 * @param {object} o
 * @param {Array<{ slot: number, cid: string, scores: number[] }>} o.reveals - from the chain
 * @param {number|null} o.responseCount - how many the aggregator recorded, null when that could not be read
 * @param {string|null} o.error - why they could not be read
 * @param {Array<{ cid: string, json: object|null }>} o.reports - the uploads
 * @param {string[]} o.combinedCids - getEvaluation's list, the cluster
 */
function revealChecks({ reveals, responseCount, error, reports, combinedCids }) {
  const slots = new Set(reveals.map((r) => r.slot));
  const cids = new Set(reveals.map((r) => r.cid));
  const missing = combinedCids.filter((cid) => !cids.has(cid));
  const uploaded = new Map(reports.map((r) => [r.cid, r.json]));
  const vectorOf = (json) => (json && Array.isArray(json.scores) ? json.scores.map((s) => Number(s && s.score)) : null);
  const different = reveals.filter((r) => {
    const vector = vectorOf(uploaded.get(r.cid));
    return !vector || vector.length !== r.scores.length || vector.some((value, i) => value !== r.scores[i]);
  });
  return [
    assert('claim.revealsRead', error === null && reveals.length > 0, error === null ? `${reveals.length} recorded reveal(s), ${combinedCids.length} in the cluster` : error),
    assert('claim.revealsComplete', revealsAreComplete({ reveals, responseCount, error }),
      `${responseCount === null ? 'no complete round was read from the aggregator' : `the aggregator recorded ${responseCount} response(s)`}; read ${reveals.length} reveal(s) in ${slots.size} slot(s)`),
    assert('claim.clusterInReveals', reveals.length > 0 && missing.length === 0, missing.length ? `no reveal carries ${missing.map(short).join(', ')}` : 'every clustered justification is a recorded reveal'),
    assert('claim.revealMatchesUpload', reveals.length > 0 && different.length === 0, different.length ? `not what was uploaded: ${different.map((r) => short(r.cid)).join(', ')}` : 'each upload holds the vector revealed on-chain')
  ];
}

/** An abstention scenario: nobody committed, and no verdict came. commitReceived null means it could not be read. */
function abstainChecks({ status, commitReceived }) {
  return [
    assert('claim.noCommit', commitReceived === 0, `${commitReceived === null ? 'the status could not be read' : `${commitReceived} commit(s)`}`),
    assert('claim.noVerdict', status !== 'fulfilled', `status=${status}`)
  ];
}

const VERDICT_BY_SOURCE = Object.freeze({ 'code-review-jury': 'jury', 'code-review-gate': 'gate', 'code-review-runner': 'runner' });

/**
 * What a round's uploads say happened, for its measurements. A scenario's expectation is not
 * evidence: a valid claim answered by a gate fails its checks, and must not then count as a fast
 * jury round. Mixed or missing evidence is `unreadable`, and counts for nothing.
 *
 * @param {Array<{ json: object|null }>} reports - one per recorded reveal
 * @returns {{ verdict: string, faultSeen: boolean, runReused: boolean }}
 */
function observedRound(reports) {
  const sources = reports.map((r) => (r.json ? metadataOf(r).verdict_source : undefined));
  const known = sources.length > 0 && new Set(sources).size === 1 ? VERDICT_BY_SOURCE[sources[0]] : undefined;
  const faultSeen = reports.some((r) => {
    const applied = r.json ? metadataOf(r).canary_fault : undefined;
    return Boolean(applied) && !applied.refused;
  });
  // Served a kept run of an earlier round: no pull and no sandbox in this round's time.
  const runReused = reports.some((r) => {
    const image = r.json ? metadataOf(r).runner_image : undefined;
    return Boolean(image) && image.cache === 'reused';
  });
  return { verdict: known || 'unreadable', faultSeen, runReused };
}

module.exports = { claimVerdictChecks, revealChecks, revealsAreComplete, abstainChecks, observedRound, firstEvidenceBlock, EXPECTED, VERDICT_BY_SOURCE };
