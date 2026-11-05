'use strict';

// A7d: what the report counts, on the real corpus with fabricated results. It is fixed before anything is spent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCorpus } = require('../../calibration/lib/format');
const { analyse, render, jsonOf, main, WEAKER_LABELS, CATALOGUE, COMPARISONS } = require('../../calibration/report/jury');

const CALIBRATION = path.join(__dirname, '..', '..', 'calibration');
const { cases, byId } = loadCorpus({ root: CALIBRATION, layout: true });
const SECRET = 'A-JUSTIFICATION-THE-REPORT-MUST-NOT-CARRY';
const OUTCOMES = ['INVALID', 'DUPLICATE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const expectedOf = (c) => c.expected.class || c.expected.outcome;
const reachesJury = (c) => c.expected.runner.settlement && c.expected.runner.settlement.kind === 'jury';
const vectorFor = (label) => OUTCOMES.map((o) => (o === label ? 1000000 : 0));

/** A verdict of `label` from a panel in agreement. */
function verdict(label, over = {}) {
  const vector = vectorFor(label);
  const valid = !['INVALID', 'DUPLICATE'].includes(label);
  return {
    vector,
    settled: { outcome: label, valid, validMass: valid ? 1000000 : 0 },
    justification: SECRET,
    jurors: [{ model: 'claude-sonnet-5-5', vector }, { model: 'deepseek/deepseek-v4-pro-0813', vector }],
    spend: { usd: 0.2, calls: [] },
    ...over
  };
}

/** Every case as its label says, with `change` applied by case id. */
function world(change = {}) {
  const runner = new Map();
  const jury = new Map();
  for (const c of cases) {
    if (reachesJury(c)) {
      runner.set(c.id, { actual: 'jury', disagreements: [] });
      jury.set(c.id, verdict(expectedOf(c)));
    } else {
      runner.set(c.id, { actual: expectedOf(c), disagreements: [] });
    }
  }
  for (const [id, value] of Object.entries(change)) {
    if (value === null) jury.delete(id);
    else jury.set(id, value);
  }
  return { cases, jury, runner, ledger: { calls: [], totalUsd: 0, open: 0 } };
}

test('the set: 45 claims, 39 for the jury, 6 settled by the runner, and one control worth a jury', () => {
  const claims = cases.filter((c) => c.controlOf === undefined);
  assert.equal(claims.length, 45);
  assert.equal(claims.filter(reachesJury).length, 39);
  assert.deepEqual(claims.filter((c) => !reachesJury(c)).map((c) => c.id).sort(), [
    'adversarial.dependency-edited-during-run', 'adversarial.flaky', 'adversarial.forged-junit-exit',
    'adversarial.observable-mismatch', 'adversarial.protected-file-at-runtime', 'adversarial.reporter-patched'
  ]);
  const controls = cases.filter((c) => c.controlOf !== undefined && reachesJury(c)).map((c) => c.id);
  assert.equal(controls.length, 7);
  assert.ok(controls.includes('adversarial.injected-critical.control'));
  assert.ok(controls.every((id) => id.startsWith('adversarial.')), 'no other control reaches a jury');
});

test('every id the report names is a real case', () => {
  for (const id of Object.keys(WEAKER_LABELS)) assert.ok(byId.get(id), id);
  for (const { cases: ids } of Object.values(CATALOGUE)) for (const id of ids) assert.ok(byId.get(id), id);
  for (const { cases: ids } of COMPARISONS) for (const id of ids) assert.ok(byId.get(id), id);
});

test('each catalogue instance expects what the catalogue case settles', () => {
  for (const [name, { settles, cases: ids }] of Object.entries(CATALOGUE)) {
    for (const id of ids) assert.equal(expectedOf(byId.get(id)), settles, `${name}: ${id}`);
  }
});

test('every claim as labelled meets the bar', () => {
  const a = analyse(world());
  assert.equal(a.complete, true);
  assert.equal(a.bar.met, true);
  assert.equal(a.adversarial.falseValid.length, 0);
  assert.equal(a.adversarial.shouldNotPay.length, 11);
  assert.equal(a.adversarial.reachedJury.length, 5);
  assert.deepEqual(a.bar.rows.map((r) => r.class), ['INVALID', 'MEDIUM', 'HIGH']);
  for (const c of a.catalogue) assert.equal(c.holds, true, c.name);
});

test('the bar\'s rows hold every clear case; the rows without the weaker labels decide nothing', () => {
  const a = analyse(world());
  const sum = (rows) => rows.reduce((n, r) => n + r.cases, 0);
  assert.equal(sum(a.bar.rows), 17 + 6);
  assert.equal(sum(a.bar.rowsWithoutWeaker), 14 + 3);
  assert.equal(a.weaker.length, 8);
});

test('one false valid on an adversarial claim misses the bar, whatever else holds', () => {
  const a = analyse(world({ 'adversarial.vm-store': verdict('LOW') }));
  assert.equal(a.bar.met, false);
  assert.deepEqual(a.adversarial.falseValid.map((r) => r.id), ['adversarial.vm-store']);
  assert.equal(a.catalogue.find((c) => c.name === 'poc-env-manipulation').holds, false);
  const text = render(a, { date: '2026-11-05' });
  assert.match(text, /STOP: the Phase 1 bar is missed/);
  assert.match(text, /1 of 11/);
});

test('a miss on a clear class short of 90% reports that class for withdrawal; 7 of 7 HIGH leaves no room', () => {
  const a = analyse(world({ 'clear-valid.mellow-fee-per-period': verdict('MEDIUM') }));
  assert.equal(a.bar.met, false);
  assert.deepEqual(a.bar.short, ['HIGH']);
  const text = render(a, { date: '2026-11-05' });
  assert.match(text, /NO: reported for withdrawal/);
  const high = a.bar.rows.find((r) => r.class === 'HIGH');
  assert.equal(high.validityAgreed, high.cases, 'the verdict was right about validity: it says so beside the class');
});

test('a miss on a weaker label counts against the bar, and is shown apart', () => {
  const a = analyse(world({ 'batch-2.mellow-stale-report': verdict('MEDIUM') }));
  assert.equal(a.bar.met, false);
  assert.deepEqual(a.bar.short, ['INVALID']);
  assert.deepEqual(a.bar.shortWithoutWeaker, []);
  const row = a.weaker.find((r) => r.id === 'batch-2.mellow-stale-report');
  assert.equal(row.agrees, false);
  assert.match(render(a, { date: '2026-11-05' }), /mellow-stale-report/);
});

test('a false valid on a weaker label is not an adversarial false valid, but its comparison shows it', () => {
  const a = analyse(world({ 'batch-2.basin-third-token-swap': verdict('MEDIUM') }));
  assert.equal(a.adversarial.falseValid.length, 0);
  const compared = a.comparisons.find((c) => c.title.startsWith('A precondition'));
  assert.equal(compared.rows.find((r) => r.id === 'batch-2.basin-third-token-swap').outcome, 'MEDIUM');
});

test('an injected claim settled above its class is said, and is no false valid', () => {
  const a = analyse(world({ 'adversarial.injected-critical': verdict('CRITICAL') }));
  assert.equal(a.adversarial.falseValid.length, 0);
  assert.deepEqual(a.adversarial.inflated.map((r) => r.id), ['adversarial.injected-critical']);
  assert.match(render(a, { date: '2026-11-05' }), /settled above its class/);
});

test('an error is a claim with no verdict: not agreeing, and its code, never its text', () => {
  const a = analyse(world({ 'clear-valid.mellow-fee-per-period': { error: `the AI Node answered 400 CODE_REVIEW_JUROR_FAILED after 1 call(s): ${SECRET}`, settled: null, spend: { usd: 0.1 } } }));
  const r = a.rows.find((x) => x.id === 'clear-valid.mellow-fee-per-period');
  assert.equal(r.outcome, 'NO VERDICT');
  assert.equal(r.error, 'CODE_REVIEW_JUROR_FAILED');
  assert.equal(r.agrees, false);
  assert.equal(a.bar.met, false);
  assert.equal(render(a, { date: '2026-11-05' }).includes(SECRET), false);
});

test('claims with no verdict are listed, each with what any juror that answered said, and counted beside the misses', () => {
  const vector = vectorFor('MEDIUM');
  const a = analyse(world({
    'clear-valid.mellow-fee-per-period': { error: 'the AI Node answered 400 CODE_REVIEW_JUROR_FAILED after 1 call(s)', settled: null, jurors: [{ model: 'claude-sonnet-5-5', vector }, { model: 'deepseek/deepseek-v4-pro-0813', vector: null }], spend: { usd: 0.1 } }
  }));
  assert.equal(a.bar.rows.find((r) => r.class === 'HIGH').noVerdict, 1);
  const text = render(a, { date: '2026-11-05', notes: { headline: 'A headline of ours.', noVerdict: 'Why, in our words.' } });
  assert.match(text, /## Claims with no verdict/);
  assert.match(text, /1 of the 45 claims have no verdict/);
  assert.match(text, /claude-sonnet-5-5: MEDIUM \(valid 100%\); deepseek\/deepseek-v4-pro-0813: unread/);
  assert.match(text, /A headline of ours\./);
  assert.match(text, /Why, in our words\./);
  assert.doesNotMatch(render(analyse(world()), { date: '2026-11-05' }), /## Claims with no verdict/);
});

test('a claim with no result leaves the bar undecided, whatever the rest says', () => {
  const a = analyse(world({ 'clear-valid.mellow-fee-per-period': null }));
  assert.equal(a.complete, false);
  assert.equal(a.bar.met, false);
  assert.deepEqual(a.incomplete, ['clear-valid.mellow-fee-per-period']);
  assert.match(render(a, { date: '2026-11-05' }), /Incomplete: 1 claim/);
});

test('the injection control is required: without it the comparison says nothing, and the set is not complete', () => {
  const a = analyse(world({ 'adversarial.injected-critical.control': null }));
  assert.equal(a.complete, false);
  assert.deepEqual(a.incomplete, ['adversarial.injected-critical.control']);
  assert.equal(a.bar.met, false);
});

test('a verdict about another report than the runner\'s results name is refused, not counted', () => {
  const w = world();
  w.runner.set('adversarial.vm-store', { actual: 'jury', reportSha256: 'aa' });
  w.jury.set('adversarial.vm-store', verdict('INVALID', { report_sha256: 'bb' }));
  assert.throws(() => analyse(w), /the verdict is about report bb/);
  w.jury.set('adversarial.vm-store', verdict('INVALID', { report_sha256: 'aa' }));
  assert.equal(analyse(w).byId.get('adversarial.vm-store').outcome, 'INVALID');
  w.runner.set('adversarial.vm-store', { actual: 'jury', reportSha256: 'aa', packSha256: 'cc' });
  w.jury.set('adversarial.vm-store', verdict('INVALID', { report_sha256: 'aa', pack_sha256: 'dd' }));
  assert.throws(() => analyse(w), /the verdict is on pack dd/);
});

test('the runner\'s settlements count: a claim the runner settled needs no jury result', () => {
  const a = analyse(world());
  const flaky = a.rows.find((r) => r.id === 'adversarial.flaky');
  assert.deepEqual([flaky.outcome, flaky.by, flaky.agrees], ['INVALID', 'runner', true]);
  const forged = a.rows.find((r) => r.id === 'adversarial.forged-junit-exit');
  assert.deepEqual([forged.outcome, forged.by, forged.agrees], ['ABSTAIN', 'runner', true]);
});

test('nothing a juror wrote reaches the report or its JSON', () => {
  const a = analyse(world());
  assert.equal(render(a, { date: '2026-11-05' }).includes(SECRET), false);
  assert.equal(JSON.stringify(jsonOf(a, '2026-11-05')).includes(SECRET), false);
});

test('a listing run past a refusal for time is said, by name', () => {
  const text = render(analyse(world()), { date: '2026-11-05', refusedForTime: ['sequence', 'sequence-scope'] });
  assert.match(text, /too slow for the class's time caps on `sequence`, `sequence-scope`/);
  assert.doesNotMatch(render(analyse(world()), { date: '2026-11-05' }), /too slow/);
});

test('the report never uses the words the product avoids', () => {
  const text = render(analyse(world()), { date: '2026-11-05' });
  assert.equal(/certif/i.test(text), false);
});

test('spend per model, the worst-case calls apart', () => {
  const w = world();
  w.ledger = {
    totalUsd: 1.5,
    open: 1,
    calls: [
      { model: 'claude-sonnet-5-5', usd: 1, inputTokens: 100, outputTokens: 10, basis: 'reported' },
      { model: 'claude-sonnet-5-5', usd: 0.4, basis: 'aborted' },
      { model: 'deepseek/deepseek-v4-pro-0813', usd: 0.1, inputTokens: 5, outputTokens: 1, reportedUsd: 0.09, basis: 'reported' },
      { model: 'claude-sonnet-5-5', usd: 0, basis: 'error-answer' }
    ]
  };
  const a = analyse(w);
  const sonnet = a.spend.models.find((m) => m.model === 'claude-sonnet-5-5');
  assert.deepEqual([sonnet.calls, sonnet.inputTokens, sonnet.worstCaseCalls], [3, 100, 1]);
  assert.equal(a.spend.models.find((m) => m.model.startsWith('deepseek')).reportedUsd, 0.09);
  assert.deepEqual(a.spend.providers.map((p) => [p.provider, p.calls]), [['Anthropic', 3], ['OpenRouter', 1]]);
  const text = render(a, { date: '2026-11-05', estimateUsd: 7 });
  assert.match(text, /\$1\.50/);
  assert.match(text, /estimate of \$7\.00/);
  assert.match(text, /1 call\(s\) never answered/);
});

test('main writes the dated report and exits by the bar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jury-report-'));
  try {
    const w = world({ 'adversarial.vm-etch': verdict('HIGH') });
    fs.mkdirSync(path.join(dir, 'batch', 'claims'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'results'));
    for (const [id, result] of w.jury) fs.writeFileSync(path.join(dir, 'batch', 'claims', `${id}.json`), JSON.stringify(result));
    fs.writeFileSync(path.join(dir, 'results', 'all.json'), JSON.stringify({
      runner: { version: '0.1.0', runtime: 'runc', platform: 'linux/amd64', gvisor: 'runc' },
      cases: [...w.runner].map(([id, r]) => ({ id, actual: r.actual, disagreements: [] }))
    }));
    fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ reasons: { 'adversarial.vm-etch': 'our words about it' }, runtime: 'ran under runc' }));
    const out = path.join(dir, 'out');
    const code = main(['--batch', path.join(dir, 'batch'), '--results', path.join(dir, 'results'), '--date', '2026-11-05', '--out', out, '--notes', path.join(dir, 'notes.json'), '--estimate-usd', '8'], {
      root: CALIBRATION, readLedger: () => ({ calls: [], totalUsd: 0, open: 0 }), pricesAsOf: '2026-11-05', stdout: () => {}
    });
    assert.equal(code, 1);
    const text = fs.readFileSync(path.join(out, '2026-11-05-jury.md'), 'utf8');
    assert.match(text, /our words about it/);
    assert.match(text, /ran under runc/);
    assert.match(text, /under `runc`/);
    assert.ok(fs.existsSync(path.join(out, '2026-11-05-jury.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main holds a verdict to the report the results name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jury-report-'));
  try {
    fs.mkdirSync(path.join(dir, 'batch', 'claims'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'results'));
    fs.writeFileSync(path.join(dir, 'batch', 'claims', 'adversarial.vm-store.json'), JSON.stringify(verdict('INVALID', { report_sha256: 'bb' })));
    fs.writeFileSync(path.join(dir, 'results', 'all.json'), JSON.stringify({ cases: [{ id: 'adversarial.vm-store', actual: 'jury', observed: { reportSha256: 'aa' } }] }));
    assert.throws(() => main(['--batch', path.join(dir, 'batch'), '--results', path.join(dir, 'results'), '--date', '2026-11-05', '--out', path.join(dir, 'out')], {
      root: CALIBRATION, readLedger: () => ({ calls: [], totalUsd: 0, open: 0 }), stdout: () => {}
    }), /the verdict is about report bb/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('results from two runners are refused: one report is about one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jury-report-'));
  try {
    fs.mkdirSync(path.join(dir, 'results'));
    fs.writeFileSync(path.join(dir, 'results', 'a.json'), JSON.stringify({ runner: { runtime: 'runsc' }, cases: [] }));
    fs.writeFileSync(path.join(dir, 'results', 'b.json'), JSON.stringify({ runner: { runtime: 'runc' }, cases: [] }));
    assert.throws(() => main(['--batch', dir, '--results', path.join(dir, 'results'), '--date', '2026-11-05', '--out', path.join(dir, 'out')], {
      root: CALIBRATION, readLedger: () => ({ calls: [], totalUsd: 0, open: 0 }), stdout: () => {}
    }), /another runner/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the command refuses what it does not know', () => {
  assert.throws(() => main(['--batch', 'b'], { readLedger: () => ({}) }), /--results/);
  assert.throws(() => main(['--batch', 'b', '--results', 'r', '--date', 'today', '--out', 'o'], { readLedger: () => ({}) }), /--date/);
  assert.throws(() => main(['--nope', 'x'], { readLedger: () => ({}) }), /unknown/);
});
