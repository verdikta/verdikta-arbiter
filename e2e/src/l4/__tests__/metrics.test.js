'use strict';

// Node A6c: p95 and σ from what L4 can really observe. The rule: a number that needs more
// samples than it has does not print as if it meant something.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { P95_MIN_SAMPLES, SIGMA_MIN_REVEALS, SIGMA_MIN_ROUNDS, SIGMA_OVER_LIMIT_MAX_PERCENT, FLIP_RATE_MIN, LATENCY_BUDGET_MS, SIGMA_LIMIT_POINTS, p95Of, sigmaOf, sigmaAllowance, validMassPoints, summarize, metricChecks, gate } = require('../metrics');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'l4-metrics.js');
const jury = (latencyMs, validMass = [70, 70, 70], over = {}) => ({ id: 'r', kind: 'valid', verdict: 'jury', fault: false, latencyMs, validMass, ...over });
const times = (n, ms = 300000) => Array.from({ length: n }, (_, i) => ms + i);
/** σ 10 for [50, 60, 70], 0 for [70, 70, 70]: n jury rounds with a σ, the first `over` of them above 5 points. */
const WIDE = [50, 60, 70];
const sigmaRounds = (n, over) => times(n).map((t, i) => jury(t, i < over ? WIDE : [70, 70, 70]));

describe('the numbers', () => {
  it('the budget and the limits are the design\'s', () => {
    expect(LATENCY_BUDGET_MS).toBe(900000);
    expect(SIGMA_LIMIT_POINTS).toBe(5);
    expect(P95_MIN_SAMPLES).toBe(20);
    expect(SIGMA_MIN_REVEALS).toBe(3);
    expect(SIGMA_MIN_ROUNDS).toBe(20);
    expect(SIGMA_OVER_LIMIT_MAX_PERCENT).toBe(10);
    expect(FLIP_RATE_MIN).toBe(10);
  });

  it('valid mass in points: everything above INVALID and DUPLICATE, 10,000 to the point', () => {
    expect(validMassPoints([0, 0, 0, 100000, 700000, 200000])).toBe(100);
    expect(validMassPoints([1000000, 0, 0, 0, 0, 0])).toBe(0);
    expect(validMassPoints([200000, 300000, 100000, 100000, 100000, 200000])).toBe(50);
  });
});

describe('p95Of', () => {
  it('three runs give no p95, only the slowest', () => {
    expect(p95Of([100, 300, 200])).toEqual({ n: 3, p95Ms: null, maxMs: 300 });
  });

  it('nothing gives nothing', () => {
    expect(p95Of([])).toEqual({ n: 0, p95Ms: null, maxMs: null });
  });

  it('19 is not enough: nearest-rank p95 of 19 is the maximum', () => {
    expect(p95Of(times(19)).p95Ms).toBeNull();
  });

  it('20 is: the 19th of 20, whatever order they came in', () => {
    const sorted = Array.from({ length: 20 }, (_, i) => (i + 1) * 1000);
    const shuffled = [...sorted].reverse();
    expect(p95Of(shuffled)).toEqual({ n: 20, p95Ms: 19000, maxMs: 20000 });
  });

  it('100: the 95th', () => {
    expect(p95Of(Array.from({ length: 100 }, (_, i) => i + 1)).p95Ms).toBe(95);
  });
});

describe('sigmaOf', () => {
  it('two arbiters give no σ', () => {
    expect(sigmaOf([70, 80])).toEqual({ n: 2, sigma: null });
  });

  it('three do: the sample standard deviation', () => {
    expect(sigmaOf([70, 70, 70]).sigma).toBe(0);
    expect(sigmaOf([60, 70, 80]).sigma).toBeCloseTo(10, 6);
  });
});

describe('sigmaAllowance: 10% of the rounds with a σ, rounded down', () => {
  it.each([[0, 0], [9, 0], [10, 1], [19, 1], [20, 2], [29, 2], [30, 3], [39, 3], [40, 4], [100, 10]])('%i rounds allow %i above the limit', (usable, allowed) => {
    expect(sigmaAllowance(usable)).toBe(allowed);
  });
});

describe('summarize', () => {
  it('counts a jury round with no fault injected; a gate is not the path being timed, and an injected delay is not a measurement', () => {
    const summary = summarize([
      jury(100000),
      jury(800000, [70, 70, 70], { fault: true, kind: 'near-limit-juror' }),
      { id: 'g', kind: 'front-gate', verdict: 'gate', fault: false, latencyMs: 90000, validMass: [0, 0, 0] },
      { id: 'r', kind: 'runner-gate', verdict: 'runner', fault: false, latencyMs: 120000, validMass: [0, 0, 0] }
    ]);
    expect(summary.latency.n).toBe(1);
    expect(summary.latency.maxMs).toBe(100000);
    expect(summary.sigma.perRound).toHaveLength(2);
  });

  it('a jury round that never finished counts as slower than any budget, and has no σ', () => {
    const lost = { id: 'x', kind: 'valid', verdict: 'jury', fault: false, latencyMs: 900000, validMass: [], unfinished: true };
    const one = summarize([...times(19).map((t) => jury(t)), lost]);
    expect(one.latency).toMatchObject({ n: 20, unfinished: 1, maxMs: Infinity });
    expect(Number.isFinite(one.latency.p95Ms)).toBe(true);
    expect(one.sigma.perRound).toHaveLength(19);
    const two = summarize([...times(18).map((t) => jury(t)), lost, lost]);
    expect(two.latency.p95Ms).toBe(Infinity);
    expect(gate(two).ok).toBe(false);
    expect(gate(two).lines.join('\n')).toMatch(/2 never finished/);
    const few = summarize([jury(1000), lost]);
    expect(metricChecks(few)[0].detail).toMatch(/no p95: 2 of the 20 rounds it needs, 1 never finished; slowest a round that never finished/);
  });

  it('a round served a kept run is no latency sample: no pull and no sandbox in its time. It still tells σ', () => {
    const summary = summarize([jury(100000), jury(5000, [50, 60, 70], { runReused: true })]);
    expect(summary.latency).toMatchObject({ n: 1, maxMs: 100000, reused: 1 });
    expect(summary.sigma.perRound).toHaveLength(2);
    expect(metricChecks(summary)[0].detail).toMatch(/1 served a kept run left out/);
    expect(metricChecks(summarize([jury(5000, [70, 70, 70], { runReused: true })]))[0].detail).toMatch(/no p95: no jury round with no fault injected; 1 served a kept run left out/);
  });

  it('a fault round still tells σ: the switch cannot move a score', () => {
    const summary = summarize([jury(1, [50, 60, 70], { fault: true })]);
    expect(summary.sigma.perRound[0].sigma).toBeCloseTo(10, 6);
  });

  it('a round with fewer reveals than σ needs is listed and has none', () => {
    const summary = summarize([jury(1, [70, 80])]);
    expect(summary.sigma.perRound[0]).toMatchObject({ n: 2, sigma: null });
    expect(summary.sigma).toMatchObject({ usable: 0, over: 0, allowance: 0, rate: null, largest: null });
  });

  it('counts the rounds above the limit: a σ of exactly 5 is not above it, two reveals are no round', () => {
    const summary = summarize([jury(1, [65, 70, 75]), jury(1, WIDE), jury(1, [70, 70, 70]), jury(1, [0, 100])]);
    expect(sigmaOf([65, 70, 75]).sigma).toBe(5);
    expect(summary.sigma).toMatchObject({ usable: 3, over: 1, allowance: 0, limit: 5 });
    expect(summary.sigma.rate).toBeCloseTo(1 / 3, 9);
    expect(summary.sigma.largest).toBeCloseTo(10, 6);
  });

  it('counts flips only for a first verdict the contract would let a maker dispute', () => {
    const summary = summarize([], [
      { countable: true, flipped: true }, { countable: true, flipped: false }, { countable: false, flipped: false }
    ]);
    expect(summary.flips).toEqual({ k: 1, n: 2, rate: null });
  });

  it('a rate from 10', () => {
    const disputes = Array.from({ length: 10 }, (_, i) => ({ countable: true, flipped: i < 3 }));
    expect(summarize([], disputes).flips).toEqual({ k: 3, n: 10, rate: 0.3 });
  });
});

describe('what a run prints', () => {
  const details = (summary) => Object.fromEntries(metricChecks(summary).map((c) => [c.name, c.detail]));

  it('says there is no p95 and why, never a number from three runs', () => {
    const shown = details(summarize([jury(100000), jury(200000), jury(300000)]));
    expect(shown['metric.latencyP95']).toMatch(/no p95: 3 of the 20/);
    expect(shown['metric.latencyP95']).toMatch(/slowest 300 s/);
    expect(shown['metric.latencyP95']).toMatch(/900 s/);
    expect(shown['metric.latencyP95']).not.toMatch(/p95 [0-9]/);
  });

  it('prints it from 20', () => {
    const shown = details(summarize(times(20).map((t) => jury(t))));
    expect(shown['metric.latencyP95']).toMatch(/p95 300 s of the 900 s budget \(§11\), 20 rounds/);
  });

  it('says there is no σ below three reveals', () => {
    const shown = details(summarize([jury(1, [70, 80])]));
    expect(shown['metric.validMassSigma']).toMatch(/no σ/);
  });

  it('below 20 rounds: how many it has, how many are above 5, the rate, the allowance, the largest, and how rough three values are', () => {
    const shown = details(summarize([jury(1, [50, 60, 70], { id: 'a' }), jury(1, [70, 70, 70], { id: 'b' })]));
    expect(shown['metric.validMassSigma']).toMatch(/^2 of the 20 rounds the gate wants; 1 above 5 points \(50\.0%\), allowance 0 \(10% of 2, rounded down\); largest 10\.0 points; three values make a rough number$/);
  });

  it('from 20 rounds: the rounds above 5 of the usable rounds, the rate, the allowance and the largest', () => {
    expect(details(summarize(sigmaRounds(20, 2)))['metric.validMassSigma']).toBe('2 of 20 rounds above 5 points (10.0%), within the allowance of 2 (10% of 20, rounded down; §18); largest 10.0 points; three values make a rough number');
    expect(details(summarize(sigmaRounds(29, 3)))['metric.validMassSigma']).toMatch(/^3 of 29 rounds above 5 points \(10\.3%\), over the allowance of 2 \(10% of 29, rounded down; §18\); largest 10\.0 points/);
  });

  it('flips as k of n, a percentage only from 10', () => {
    expect(details(summarize([], [{ countable: true, flipped: true }]))['metric.disputeFlips']).toMatch(/1 of 1/);
    expect(details(summarize([], [{ countable: true, flipped: true }]))['metric.disputeFlips']).not.toMatch(/%/);
    expect(details(summarize([], Array.from({ length: 10 }, (_, i) => ({ countable: true, flipped: i < 3 }))))['metric.disputeFlips']).toMatch(/30%/);
  });

  it('a metric never fails a run: L4 reports, the gate decides', () => {
    for (const check of metricChecks(summarize([jury(900001), jury(1, [0, 50, 100])]))) expect(check.ok).toBe(true);
  });
});

describe('the gate over many runs', () => {
  const enough = () => times(20).map((t) => jury(t));

  it('passes with enough samples inside every limit', () => {
    expect(gate(summarize(enough())).ok).toBe(true);
  });

  it.each([
    ['too few latency samples', () => times(19).map((t) => jury(t)), /p95/],
    ['a p95 over the budget', () => times(20, 900001).map((t) => jury(t)), /p95/],
    ['too few rounds with a σ', () => times(20).map((t, i) => jury(t, i < 4 ? [70, 70, 70] : [70, 70])), /FAIL σ.*4 of the 20 rounds the gate wants/],
    ['more rounds above 5 points than the allowance', () => sigmaRounds(20, 3), /FAIL σ.*3 of 20 rounds above 5 points \(15\.0%\), over the allowance of 2/]
  ])('fails on %s, and says which', (_name, rounds, why) => {
    const result = gate(summarize(rounds()));
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(why);
  });
});

describe('the σ gate is a rate: above 5 points in at most 10% of the rounds, over at least 20 (owner, 2026-11-09)', () => {
  const sigmaLineOf = (result) => result.lines.find((line) => line.includes('σ'));

  it.each([[20, 2], [29, 2], [30, 3], [39, 3], [40, 4]])('%i rounds pass with %i above 5: the allowance', (n, over) => {
    const result = gate(summarize(sigmaRounds(n, over)));
    expect(sigmaLineOf(result)).toMatch(new RegExp(`^PASS σ of the valid mass: ${over} of ${n} rounds above 5 points .*within the allowance of ${over} `));
    expect(result.ok).toBe(true);
  });

  it.each([[20, 3, 2], [29, 3, 2], [30, 4, 3], [39, 4, 3], [40, 5, 4]])('%i rounds fail with %i above 5, one more than the allowance of %i', (n, over, allowed) => {
    const result = gate(summarize(sigmaRounds(n, over)));
    expect(result.ok).toBe(false);
    expect(sigmaLineOf(result)).toMatch(new RegExp(`^FAIL σ of the valid mass: ${over} of ${n} rounds above 5 points .*over the allowance of ${allowed} `));
    expect(result.lines[0]).toMatch(/^PASS latency/);
  });

  it('a σ of exactly 5 points is within the limit, in every round', () => {
    const result = gate(summarize(times(20).map((t) => jury(t, [65, 70, 75]))));
    expect(sigmaLineOf(result)).toMatch(/^PASS σ of the valid mass: 0 of 20 rounds above 5 points \(0\.0%\).*largest 5\.0 points/);
    expect(result.ok).toBe(true);
  });

  it('19 rounds are too few, as for p95, even with none above 5', () => {
    const result = gate(summarize([...sigmaRounds(19, 0), jury(300100, [70, 70])]));
    expect(result.lines[0]).toMatch(/^PASS latency/);
    expect(sigmaLineOf(result)).toMatch(/^FAIL σ of the valid mass: 19 of the 20 rounds the gate wants; 0 above 5 points/);
    expect(result.ok).toBe(false);
  });

  it('a round with fewer than 3 reveals is no round: it neither fills the 20 nor raises the allowance', () => {
    const twoReveals = (n) => times(n, 400000).map((t) => jury(t, [0, 100]));
    const short = summarize([...sigmaRounds(19, 0), ...twoReveals(5)]);
    expect(short.sigma).toMatchObject({ usable: 19, over: 0, allowance: 1 });
    expect(gate(short).ok).toBe(false);
    const over = summarize([...sigmaRounds(20, 3), ...twoReveals(10)]);
    expect(over.sigma).toMatchObject({ usable: 20, over: 3, allowance: 2 });
    expect(sigmaLineOf(gate(over))).toMatch(/^FAIL σ of the valid mass: 3 of 20 rounds above 5 points/);
    expect(gate(over).ok).toBe(false);
  });

  it('the latency gate is its own: a p95 over the budget fails with every σ inside', () => {
    const result = gate(summarize(times(20, 900001).map((t) => jury(t))));
    expect(result.lines[0]).toMatch(/^FAIL latency/);
    expect(sigmaLineOf(result)).toMatch(/^PASS σ/);
    expect(result.ok).toBe(false);
  });
});

describe('scripts/l4-metrics.js', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-l4-metrics-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const reportFile = (name, rounds, dispute) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ cases: [{ id: 'x', mode: 'l4', checks: [], metrics: { rounds, ...(dispute ? { dispute } : {}) } }, { id: 'claim-l4-metrics', mode: 'l4', checks: [] }] }));
    return file;
  };
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

  it('adds up reports: ten and ten make twenty', () => {
    const a = reportFile('a.json', times(10).map((t) => jury(t)));
    const b = reportFile('b.json', times(10, 400000).map((t) => jury(t)));
    const r = run(a, b);
    expect(r.stdout).toMatch(/20 rounds/);
    expect(r.status).toBe(0);
  });

  it('a report named twice is one measurement: a round is its request', () => {
    const rounds = times(10).map((t, i) => jury(t, [70, 70, 70], { aggId: `0x${i}` }));
    const a = reportFile('a.json', rounds, { aggId: '0xd', countable: true, flipped: true });
    const copy = path.join(dir, 'copy.json');
    fs.copyFileSync(a, copy);
    const r = run(a, a, copy);
    expect(r.stdout).toMatch(/10 round\(s\)/);
    expect(r.stdout).toMatch(/no p95: 10 of the 20/);
    expect(r.stdout).toMatch(/1 of 1 flipped/);
    expect(r.status).toBe(1);
  });

  it('σ over many reports: 2 of 20 rounds above 5 points pass, 3 fail and the line says so', () => {
    const a = reportFile('a.json', times(10).map((t, i) => jury(t, i < 1 ? WIDE : [70, 70, 70])));
    const b = reportFile('b.json', times(10, 400000).map((t, i) => jury(t, i < 1 ? WIDE : [70, 70, 70])));
    const pass = run(a, b);
    expect(pass.stdout).toMatch(/PASS σ of the valid mass: 2 of 20 rounds above 5 points \(10\.0%\), within the allowance of 2/);
    expect(pass.status).toBe(0);
    const c = reportFile('c.json', times(10, 500000).map((t, i) => jury(t, i < 2 ? WIDE : [70, 70, 70])));
    const fail = run(a, c);
    expect(fail.stdout).toMatch(/FAIL σ of the valid mass: 3 of 20 rounds above 5 points \(15\.0%\), over the allowance of 2/);
    expect(fail.status).toBe(1);
  });

  it('exits 1 on too few, and says so', () => {
    const r = run(reportFile('a.json', [jury(100000)]));
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/no p95: 1 of the 20/);
  });

  it('exits 1 on no file and on a file that is not a report', () => {
    expect(run().status).toBe(1);
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, 'nope');
    expect(run(bad).status).toBe(1);
  });
});
