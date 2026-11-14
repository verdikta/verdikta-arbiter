'use strict';

/**
 * L4's measurements (design §11, §18), as pure functions, for a run's report and for
 * scripts/l4-metrics.js over many. A run reports them and never fails on them; the script is
 * the gate. A number that needs more samples than it has does not print as if it meant
 * something: it says what is missing.
 *
 * The settled outcome (Q70 item 4, owner 2026-11-10) is reported beside σ and gated nowhere.
 * σ is taken over every recorded reveal, before the aggregator's filter; the outcome is what
 * getEvaluation's vector settles, after it (§10.8: of the first three reveals, the closest pair).
 */

const { codeReview } = require('@verdikta/common');
const { assert } = require('../assertions');

/** §11's worst case, the on-chain `responseTimeoutSeconds` it asks for. */
const LATENCY_BUDGET_MS = 900000;
/** §18: σ ≤ 5 points of valid mass, read as a rate (§18's erratum, owner 2026-11-09). */
const SIGMA_LIMIT_POINTS = 5;
/** Nearest-rank p95 of fewer than 20 samples is the maximum. */
const P95_MIN_SAMPLES = 20;
/** Sample standard deviation needs two values; two arbiters agreeing says little, so three. */
const SIGMA_MIN_REVEALS = 3;
/** Rounds with a σ the gate wants before it reads them: fewer is too few samples, as for p95. */
const SIGMA_MIN_ROUNDS = 20;
/** At most this percentage of those rounds, rounded down, may be above the limit: 2 of 20, 4 of 40. */
const SIGMA_OVER_LIMIT_MAX_PERCENT = 10;
/** Below this a flip count stays a count. */
const FLIP_RATE_MIN = 10;
const MASS_PER_POINT = 10000;
/** INVALID and DUPLICATE come first in the six outcomes; the rest is the valid mass. */
const FIRST_VALID_OUTCOME = 2;

/** A round that never finished is slower than any budget. */
const seconds = (ms) => (Number.isFinite(ms) ? `${Math.round(ms / 1000)} s` : 'a round that never finished');

function validMassPoints(vector) {
  return vector.slice(FIRST_VALID_OUTCOME).reduce((sum, value) => sum + Number(value), 0) / MASS_PER_POINT;
}

function p95Of(samples) {
  const n = samples.length;
  if (n === 0) return { n, p95Ms: null, maxMs: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const maxMs = sorted[n - 1];
  if (n < P95_MIN_SAMPLES) return { n, p95Ms: null, maxMs };
  return { n, p95Ms: sorted[Math.ceil(0.95 * n) - 1], maxMs };
}

/** 10% of the rounds with a σ, rounded down, in integers: the rounding never depends on how 0.1 is stored. */
function sigmaAllowance(usable) {
  return Math.floor((usable * SIGMA_OVER_LIMIT_MAX_PERCENT) / 100);
}

function sigmaOf(values) {
  const n = values.length;
  if (n < SIGMA_MIN_REVEALS) return { n, sigma: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  return { n, sigma: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)) };
}

/** A recorded outcome this module can read: one of common's six, with settlement's `valid` beside it. */
const isSettled = (settled) => Boolean(settled) && codeReview.BUG_OUTCOMES.includes(settled.outcome) && typeof settled.valid === 'boolean';

/**
 * What the finished jury rounds settled. A round from a report written before the outcome was
 * recorded has no `settled` (`unrecorded`); one whose vector settlement refused has no outcome
 * (`unsettled`). Either is left out and counted, and neither is ever counted as not valid. The
 * exact-class rate is over the settled rounds whose scenario names an `expectedClass`.
 */
function outcomesOf(jury) {
  const finished = jury.filter((r) => !r.unfinished);
  const recorded = finished.filter((r) => r.settled !== undefined);
  const settled = recorded.filter((r) => isSettled(r.settled));
  const notValid = settled.filter((r) => !r.settled.valid).length;
  const labelled = settled.filter((r) => typeof r.expectedClass === 'string');
  const exact = labelled.filter((r) => r.settled.outcome === r.expectedClass).length;
  const byKind = new Map();
  for (const r of settled) {
    const counts = byKind.get(r.kind) || new Map();
    byKind.set(r.kind, counts.set(r.settled.outcome, (counts.get(r.settled.outcome) || 0) + 1));
  }
  return {
    settled: settled.length,
    unsettled: recorded.length - settled.length,
    unrecorded: finished.length - recorded.length,
    notValid,
    notValidRate: settled.length ? notValid / settled.length : null,
    labelled: labelled.length,
    exact,
    exactRate: labelled.length ? exact / labelled.length : null,
    byKind: Object.fromEntries([...byKind].map(([kind, counts]) => [kind, Object.fromEntries(counts)]))
  };
}

/**
 * @param {Array<{ id: string, kind: string, verdict: string, fault: boolean, latencyMs: number, validMass: number[], settled?: object, expectedClass?: string }>} rounds
 * @param {Array<{ countable: boolean, flipped: boolean }>} [disputes]
 */
function summarize(rounds, disputes = []) {
  const jury = rounds.filter((r) => r.verdict === 'jury');
  // The typical path: no gate stopped it early, no delay was injected into it, and it ran its own
  // sandbox (an arbiter keeps a run for 15 minutes, and a later round of that claim is served it).
  // A round that never finished counts as slower than any budget, or a network that loses rounds
  // would look fast.
  const timed = jury.filter((r) => !r.fault && !r.runReused);
  const latency = {
    ...p95Of(timed.map((r) => (r.unfinished ? Infinity : r.latencyMs))),
    budgetMs: LATENCY_BUDGET_MS,
    unfinished: timed.filter((r) => r.unfinished).length,
    reused: jury.filter((r) => r.runReused && !r.fault).length
  };
  const perRound = jury.filter((r) => !r.unfinished).map((r) => ({ id: r.id, ...sigmaOf(r.validMass || []) }));
  const sigmas = perRound.filter((r) => r.sigma !== null).map((r) => r.sigma);
  const usable = sigmas.length;
  const over = sigmas.filter((sigma) => sigma > SIGMA_LIMIT_POINTS).length;
  const counted = disputes.filter((d) => d.countable);
  const k = counted.filter((d) => d.flipped).length;
  return {
    latency,
    sigma: {
      perRound,
      usable,
      over,
      rate: usable ? over / usable : null,
      allowance: sigmaAllowance(usable),
      largest: usable ? Math.max(...sigmas) : null,
      limit: SIGMA_LIMIT_POINTS
    },
    outcomes: outcomesOf(jury),
    flips: { k, n: counted.length, rate: counted.length >= FLIP_RATE_MIN ? k / counted.length : null }
  };
}

function latencyLine({ n, p95Ms, maxMs, budgetMs, unfinished, reused }) {
  const leftOut = reused > 0 ? `; ${reused} served a kept run left out` : '';
  if (n === 0) return `no p95: no jury round with no fault injected${leftOut}`;
  const lost = `${unfinished > 0 ? `, ${unfinished} never finished` : ''}${leftOut}`;
  if (p95Ms === null) return `no p95: ${n} of the ${P95_MIN_SAMPLES} rounds it needs${lost}; slowest ${seconds(maxMs)} of the ${seconds(budgetMs)} budget (§11)`;
  return `p95 ${seconds(p95Ms)} of the ${seconds(budgetMs)} budget (§11), ${n} rounds${lost}, slowest ${seconds(maxMs)}`;
}

function sigmaLine({ perRound, usable, over, rate, allowance, largest, limit }) {
  if (usable === 0) return `no σ: no jury round with ${SIGMA_MIN_REVEALS} recorded reveals (${perRound.length} jury round(s))`;
  const above = `above ${limit} points (${(rate * 100).toFixed(1)}%)`;
  const share = `${SIGMA_OVER_LIMIT_MAX_PERCENT}% of ${usable}, rounded down`;
  const largestOf = `largest ${largest.toFixed(1)} points; three values make a rough number`;
  if (usable < SIGMA_MIN_ROUNDS) return `${usable} of the ${SIGMA_MIN_ROUNDS} rounds the gate wants; ${over} ${above}, allowance ${allowance} (${share}); ${largestOf}`;
  return `${over} of ${usable} rounds ${above}, ${over > allowance ? 'over' : 'within'} the allowance of ${allowance} (${share}; §18); ${largestOf}`;
}

const percent = (rate) => `${(rate * 100).toFixed(1)}%`;

function outcomeLine({ settled, unsettled, unrecorded, notValid, notValidRate, labelled, exact, exactRate, byKind }) {
  const out = [
    unsettled > 0 ? `${unsettled} whose vector could not be settled` : null,
    unrecorded > 0 ? `${unrecorded} from a report that predates the settled outcome` : null
  ].filter(Boolean);
  const leftOut = out.length ? ` (left out: ${out.join(', ')})` : '';
  if (settled === 0) return `no settled outcome: no finished jury round has one${leftOut}`;
  const exactly = labelled === 0 ? 'no round names an expected class' : `${exact} of ${labelled} labelled round(s) settled the expected class (${percent(exactRate)})`;
  const kinds = Object.entries(byKind).map(([kind, counts]) => `${kind} (${codeReview.BUG_OUTCOMES.filter((o) => counts[o]).map((o) => `${o} ${counts[o]}`).join(', ')})`);
  return `${settled} jury round(s) with a settled outcome${leftOut}; ${notValid} settled not valid, INVALID or DUPLICATE (${percent(notValidRate)}); ${exactly}; by kind: ${kinds.join(', ')}`;
}

function flipLine({ k, n, rate }) {
  if (n === 0) return 'no dispute round whose first verdict was valid';
  return rate === null ? `${k} of ${n} flipped; no rate below ${FLIP_RATE_MIN}` : `${k} of ${n} flipped: ${Math.round(rate * 100)}%`;
}

/** A run's report. They hold, whatever they say: a run reports, the gate decides. */
function metricChecks(summary) {
  return [
    assert('metric.latencyP95', true, latencyLine(summary.latency)),
    assert('metric.validMassSigma', true, sigmaLine(summary.sigma)),
    assert('metric.settledOutcome', true, outcomeLine(summary.outcomes)),
    assert('metric.disputeFlips', true, flipLine(summary.flips))
  ];
}

/**
 * G2's read over many runs: enough samples, inside every limit. σ's limit is a rate: at least 20
 * rounds with a σ, and above 5 points in at most 10% of them, rounded down. Flips and the settled
 * outcome are measured, with no limit of their own: `ok` never reads them.
 */
function gate(summary) {
  const { latency, sigma } = summary;
  const latencyOk = latency.p95Ms !== null && latency.p95Ms <= latency.budgetMs;
  const sigmaOk = sigma.usable >= SIGMA_MIN_ROUNDS && sigma.over <= sigma.allowance;
  return {
    ok: latencyOk && sigmaOk,
    lines: [
      `${latencyOk ? 'PASS' : 'FAIL'} latency: ${latencyLine(latency)}`,
      `${sigmaOk ? 'PASS' : 'FAIL'} σ of the valid mass: ${sigmaLine(sigma)}`,
      `INFO settled outcome: ${outcomeLine(summary.outcomes)}`,
      `INFO disputes: ${flipLine(summary.flips)}`
    ]
  };
}

module.exports = {
  LATENCY_BUDGET_MS, SIGMA_LIMIT_POINTS, P95_MIN_SAMPLES, SIGMA_MIN_REVEALS, SIGMA_MIN_ROUNDS, SIGMA_OVER_LIMIT_MAX_PERCENT,
  FLIP_RATE_MIN, validMassPoints, p95Of, sigmaOf, sigmaAllowance, outcomesOf, summarize, metricChecks, gate
};
