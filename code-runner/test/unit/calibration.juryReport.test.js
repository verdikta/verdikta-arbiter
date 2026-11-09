'use strict';

// A7d: what the report counts, on the real corpus with fabricated results. It is fixed before anything is spent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCorpus } = require('../../calibration/lib/format');
const { analyse, compareRuns, render, jsonOf, main, programLabelOf, sideBySide, classDistance, WEAKER_LABELS, CATALOGUE, COMPARISONS } = require('../../calibration/report/jury');

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
  assert.deepEqual(a.bar.rows.map((r) => r.class), ['INVALID', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], 'the bar reads the classes under immunefi-v2.3');
  for (const c of a.catalogue) assert.equal(c.holds, true, c.name);
});

// A7e: the bar reads the labels under immunefi-v2.3; the programs' labels are reported beside them and decide nothing.

/** A synthetic row, as analyse makes one: the rubric's label in `expected`, the program's in `programLabel`. */
function labelRow(id, expected, programLabel, outcome) {
  const fam = (l) => (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(l) ? 'VALID' : l);
  return {
    id, subsets: ['clear-valid'], expected, programLabel, outcome,
    agrees: outcome === expected, agreesValidity: fam(outcome) === fam(expected),
    agreesProgram: outcome === programLabel, agreesValidityProgram: fam(outcome) === fam(programLabel)
  };
}

const SYNTHETIC = Object.freeze([
  labelRow('a', 'HIGH', 'MEDIUM', 'MEDIUM'),
  labelRow('b', 'LOW', 'MEDIUM', 'HIGH'),
  labelRow('c', 'CRITICAL', 'HIGH', 'LOW'),
  labelRow('d', 'INVALID', 'INVALID', 'LOW'),
  labelRow('e', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE'),
  labelRow('f', 'MEDIUM', 'MEDIUM', 'NO VERDICT'),
  labelRow('g', 'LOW', 'HIGH', 'INVALID')
]);

test('A7e: the program\'s label is its class where it judged the claim valid at one, and the outcome the case expects otherwise', () => {
  assert.equal(programLabelOf(byId.get('clear-valid.mellow-fee-per-period')), 'HIGH');
  assert.equal(programLabelOf(byId.get('batch-2.kleidi-pause-gas')), 'MEDIUM');
  assert.equal(programLabelOf(byId.get('batch-2.basin-upgrade-and-call')), 'DUPLICATE', 'a duplicate of a valid finding is the program\'s duplicate');
  assert.equal(programLabelOf(byId.get('batch-2.mellow-fee-on-falling-price')), 'INVALID');
  assert.equal(programLabelOf(byId.get('adversarial.injected-critical')), byId.get('adversarial.injected-critical').expected.class, 'a fixture of ours has no program: its own label stands');
  for (const c of cases) {
    const program = c.source && c.source.program;
    if (c.expected.outcome === 'VALID' && program && program.class) assert.equal(programLabelOf(c), program.class, c.id);
  }
});

test('A7e: agreement per class, against the rubric\'s labels and the program\'s side by side, with validity per class', () => {
  const rows = sideBySide(SYNTHETIC);
  assert.deepEqual(rows.map((r) => r.class), ['INVALID', 'DUPLICATE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
  const at = (label) => rows.find((r) => r.class === label);
  assert.deepEqual(at('LOW').rubric, { cases: 2, agreed: 0, validityAgreed: 1, noVerdict: 0 });
  assert.deepEqual(at('LOW').program, { cases: 0, agreed: 0, validityAgreed: 0, noVerdict: 0 });
  assert.deepEqual(at('MEDIUM').rubric, { cases: 1, agreed: 0, validityAgreed: 0, noVerdict: 1 });
  assert.deepEqual(at('MEDIUM').program, { cases: 3, agreed: 1, validityAgreed: 2, noVerdict: 1 });
  assert.deepEqual(at('HIGH').rubric, { cases: 1, agreed: 0, validityAgreed: 1, noVerdict: 0 });
  assert.deepEqual(at('HIGH').program, { cases: 2, agreed: 0, validityAgreed: 1, noVerdict: 0 });
  assert.deepEqual(at('CRITICAL').program, { cases: 0, agreed: 0, validityAgreed: 0, noVerdict: 0 });
  assert.deepEqual(at('INVALID').rubric, { cases: 1, agreed: 0, validityAgreed: 0, noVerdict: 0 });
  assert.deepEqual(at('DUPLICATE').program, { cases: 1, agreed: 1, validityAgreed: 1, noVerdict: 0 });
});

test('A7e: class distance, exact, one off, two or more and the mean signed, negative when the jury is below the label', () => {
  const rubric = classDistance(SYNTHETIC, 'expected');
  assert.deepEqual({ ...rubric, meanSigned: Math.round(rubric.meanSigned * 1000) / 1000 }, { cases: 5, compared: 3, exact: 0, oneOff: 1, twoOrMore: 2, meanSigned: -0.667, notValid: 1, noVerdict: 1 });
  const program = classDistance(SYNTHETIC, 'programLabel');
  assert.deepEqual({ ...program, meanSigned: Math.round(program.meanSigned * 1000) / 1000 }, { cases: 5, compared: 3, exact: 1, oneOff: 1, twoOrMore: 1, meanSigned: -0.333, notValid: 1, noVerdict: 1 });
  assert.equal(classDistance([labelRow('h', 'HIGH', 'HIGH', 'NO VERDICT')], 'expected').meanSigned, null, 'no verdict in a valid class: no mean');
  assert.equal(classDistance([labelRow('i', 'LOW', 'LOW', 'CRITICAL')], 'expected').meanSigned, 3, 'above the label is positive');
});

test('A7e: on the real corpus, the program\'s labels are beside the bar and decide nothing', () => {
  const a = analyse(world());
  assert.equal(a.bar.met, true, 'the jury agreeing with every label under the rubric meets the bar');
  const program = (label) => a.labels.rows.find((r) => r.class === label).program;
  assert.equal(program('HIGH').cases, 7, 'the clear-valid claims the programs called High');
  assert.equal(program('MEDIUM').cases, 10);
  assert.equal(program('INVALID').cases, 6);
  assert.equal(a.labels.rows.reduce((n, r) => n + r.rubric.cases, 0), 23);
  assert.equal(a.labels.rows.reduce((n, r) => n + r.program.cases, 0), 23);
  assert.equal(a.labels.distance.rubric.clear.exact, 17);
  const p = a.labels.distance.program.clear;
  assert.equal(p.compared, 17);
  assert.equal(p.exact + p.oneOff + p.twoOrMore, 17);
  for (const r of a.rows) assert.equal(r.agreesProgram, r.outcome === r.programLabel, r.id);
  // A jury that answered every claim with the program's label: its rows against the program say so, and the bar still reads the rubric's.
  const asProgram = {};
  for (const c of cases) if (c.controlOf === undefined && reachesJury(c)) asProgram[c.id] = verdict(programLabelOf(c));
  const b = analyse(world(asProgram));
  assert.equal(b.labels.distance.program.clear.exact, 17);
  assert.equal(b.bar.met, false, 'the bar, and its exit, read the rubric\'s labels, which differ from the programs\' on some clear claims');
  const text = render(b, { date: '2026-11-08' });
  assert.match(text, /## The rubric's labels and the program's/);
  assert.match(text, /\| Labels \| Claims \| In a valid class \| Exact \| One off \| Two or more \| Mean signed \| Not valid \| No verdict \|/);
  assert.match(text, /\| Program's, clear \| 17 \| 17 \| 17 \| 0 \| 0 \| 0\.00 \| 0 \| 0 \|/);
  assert.equal(jsonOf(b, '2026-11-08').labels.distance.program.clear.exact, 17);
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

test('a miss on a clear class short of 90% reports that class for withdrawal; 5 of 5 CRITICAL leaves no room', () => {
  const a = analyse(world({ 'clear-valid.mellow-fee-per-period': verdict('HIGH') }));
  assert.equal(a.bar.met, false);
  assert.deepEqual(a.bar.short, ['CRITICAL']);
  const text = render(a, { date: '2026-11-05' });
  assert.match(text, /NO: reported for withdrawal/);
  const critical = a.bar.rows.find((r) => r.class === 'CRITICAL');
  assert.equal(critical.validityAgreed, critical.cases, 'the verdict was right about validity: it says so beside the class');
  assert.equal(a.labels.rows.find((r) => r.class === 'HIGH').program.agreed, 2, 'and the same verdict agrees with the program\'s High');
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
  assert.equal(a.bar.rows.find((r) => r.class === 'CRITICAL').noVerdict, 1);
  const text = render(a, { date: '2026-11-05', notes: { headline: 'A headline of ours.', noVerdict: 'Why, in our words.' } });
  assert.match(text, /## Claims with no verdict/);
  assert.match(text, /1 of the 39 claims that reached the jury have no verdict/);
  assert.match(text, /claude-sonnet-5-5: MEDIUM \(valid 100%\); deepseek\/deepseek-v4-pro-0813: unread/);
  assert.match(text, /A headline of ours\./);
  assert.match(text, /Why, in our words\./);
  assert.doesNotMatch(render(analyse(world()), { date: '2026-11-05' }), /## Claims with no verdict/);
});

test('no verdict by cause: a timeout, the output limit and anything else, with each call\'s tokens and time', () => {
  const call = (model, over) => ({ model, status: 200, basis: 'reported', inputTokens: 100, outputTokens: 500, maxTokens: 32000, finishReason: 'stop', durationMs: 90000, ...over });
  const failed = (code, calls, over = {}) => ({ error: `the AI Node answered 400 ${code} after 1 call(s): ${SECRET}`, settled: null, jurors: [], execution_time_ms: 240000, spend: { usd: 0.1, calls }, ...over });
  const a = analyse(world({
    'clear-valid.mellow-fee-per-period': failed('CODE_REVIEW_JUROR_TIMEOUT', [call('deepseek/deepseek-v4-pro-0813', { status: null, basis: 'aborted', inputTokens: undefined, outputTokens: undefined, finishReason: undefined, durationMs: 240000 })], { attempts: 2, juror_states: [{ juror: 'openrouter:deepseek', status: 'timeout', duration_ms: 240000, message: SECRET }] }),
    'clear-valid.mellow-performance-fee': failed('CODE_REVIEW_JUROR_FAILED', [call('deepseek/deepseek-v4-pro-0813', { outputTokens: 32000, reasoningTokens: 32000, finishReason: 'length' })]),
    'clear-valid.mellow-consensus-threshold': failed('CODE_REVIEW_JUROR_FAILED', [call('claude-sonnet-5-5', {})], { juror_states: [{ juror: 'anthropic:x', status: 'failed', http_status: 400 }] }),
    'clear-valid.basin-upgrade-access': failed('CODE_REVIEW_JUSTIFIER_FAILED', [call('claude-haiku-5-5', {})]),
    'clear-valid.layeredge-tier-demotion': failed('CODE_REVIEW_JUROR_FAILED', [{ model: 'deepseek/deepseek-v4-pro-0813', status: 200, basis: 'reported', inputTokens: 1, outputTokens: 8000 }])
  }));
  const causes = Object.fromEntries(a.noVerdict.map((r) => [r.id.split('.')[1], r.cause]));
  assert.deepEqual(causes, {
    'mellow-fee-per-period': 'juror timeout',
    'mellow-performance-fee': 'output limit',
    'mellow-consensus-threshold': 'juror failed (HTTP 400)',
    'basin-upgrade-access': 'code_review_justifier_failed',
    'layeredge-tier-demotion': 'output limit'
  });
  const text = render(a, { date: '2026-11-05' });
  assert.match(text, /\| juror timeout \| 1 \|/);
  assert.match(text, /32000 of 32000 out \(32000 reasoning\), length, 90 s/);
  assert.match(text, /no usage, aborted, 240 s/);
  assert.equal(text.includes(SECRET), false);
  assert.equal(JSON.stringify(jsonOf(a, '2026-11-05')).includes(SECRET), false);
});

test('two runs compared: what gained a verdict, what lost one, what moved', () => {
  const noVerdict = { error: 'x CODE_REVIEW_JUROR_FAILED', settled: null, spend: { usd: 0, calls: [] } };
  const first = analyse(world({
    'clear-valid.mellow-fee-per-period': noVerdict,
    'batch-2.kleidi-neighbouring-checks': verdict('LOW')
  }));
  const second = analyse(world({
    'clear-valid.mellow-performance-fee': noVerdict,
    'batch-2.kleidi-neighbouring-checks': verdict('HIGH')
  }));
  const earlier = JSON.parse(JSON.stringify(jsonOf(first, '2026-11-05')));
  const c = compareRuns(second, earlier);
  assert.deepEqual(c.arrived.map((r) => r.id), ['clear-valid.mellow-fee-per-period']);
  assert.deepEqual(c.lost.map((r) => r.id), ['clear-valid.mellow-performance-fee']);
  assert.deepEqual(c.moved.map((r) => [r.id, r.before, r.after]), [['batch-2.kleidi-neighbouring-checks', 'LOW', 'HIGH']]);
  assert.equal(c.verdictsBefore, 44);
  assert.equal(c.verdictsNow, 44);
  const text = render(second, { date: '2026-11-06', comparison: c });
  assert.match(text, /## Against the run of 2026-11-05/);
  assert.match(text, /1 claim\(s\) gained a verdict and 1 lost one/);
  assert.match(text, /False valid on the adversarial claims: 0 then, 0 now/);
  assert.match(text, /Verdicts that moved:/);
});

test('A7e: an earlier report is scored again against today\'s labels, not its own', () => {
  const first = analyse(world({ 'clear-valid.mellow-fee-per-period': verdict('HIGH') }));
  const earlier = JSON.parse(JSON.stringify(jsonOf(first, '2026-11-05')));
  // As a report from before the re-label recorded it: its label was the program's High, so the High verdict agreed.
  const old = earlier.rows.find((r) => r.id === 'clear-valid.mellow-fee-per-period');
  Object.assign(old, { expected: 'HIGH', agrees: true });
  earlier.bar.rows = [{ class: 'HIGH', cases: 7, agreed: 7, noVerdict: 0 }];
  const c = compareRuns(analyse(world()), earlier);
  assert.equal(c.rows.find((r) => r.id === 'clear-valid.mellow-fee-per-period').agreedBefore, false, 'High is not today\'s Critical');
  assert.deepEqual(c.barBefore.find((r) => r.class === 'CRITICAL'), { class: 'CRITICAL', cases: 5, agreed: 4, noVerdict: 0 });
  assert.deepEqual(c.barBefore.find((r) => r.class === 'HIGH'), { class: 'HIGH', cases: 2, agreed: 2, noVerdict: 0 });
  const text = render(analyse(world()), { date: '2026-11-08', comparison: c });
  assert.match(text, /\| CRITICAL \| 4 of 5 \| 5 of 5 \| 0 \| 0 \|/);
  assert.match(text, /scored against today's labels/);
});

test('a label names the files, and the first report is not overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jury-report-'));
  try {
    const w = world();
    fs.mkdirSync(path.join(dir, 'batch', 'claims'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'results'));
    for (const [id, result] of w.jury) fs.writeFileSync(path.join(dir, 'batch', 'claims', `${id}.json`), JSON.stringify(result));
    fs.writeFileSync(path.join(dir, 'results', 'all.json'), JSON.stringify({ cases: [...w.runner].map(([id, r]) => ({ id, actual: r.actual, disagreements: [] })) }));
    const out = path.join(dir, 'out');
    const args = ['--batch', path.join(dir, 'batch'), '--results', path.join(dir, 'results'), '--date', '2026-11-05', '--out', out];
    const deps = { root: CALIBRATION, readLedger: () => ({ calls: [], totalUsd: 0, open: 0 }), stdout: () => {} };
    assert.equal(main(args, deps), 0);
    assert.equal(main([...args, '--label', 'limit-32000', '--previous', path.join(out, '2026-11-05-jury.json')], deps), 0);
    assert.deepEqual(fs.readdirSync(out).sort(), ['2026-11-05-jury-limit-32000.json', '2026-11-05-jury-limit-32000.md', '2026-11-05-jury.json', '2026-11-05-jury.md']);
    assert.match(fs.readFileSync(path.join(out, '2026-11-05-jury-limit-32000.md'), 'utf8'), /Against the run of 2026-11-05/);
    assert.throws(() => main([...args, '--label', '../up'], deps), /--label/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
