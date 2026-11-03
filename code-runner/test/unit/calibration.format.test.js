'use strict';

// A7a, acceptance 1: a versioned format, validated. A malformed case fails loudly and is never skipped.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCorpus, selectCases, CorpusError, CASE_FORMAT } = require('../../calibration/lib/format');
const { writeCorpus, juryCase, controlCase, ADVERSARIAL_LINE, patch, POC_LINES, GATES_PASS } = require('../helpers/calibrationCorpus');

const CALIBRATION = path.join(__dirname, '..', '..', 'calibration');

function problemsOf(over) {
  const corpus = writeCorpus(over);
  try {
    return loadCorpus({ root: corpus.root }) && [];
  } catch (err) {
    assert.ok(err instanceof CorpusError, err.stack);
    return err.problems;
  } finally {
    corpus.cleanup();
  }
}

function assertRefused(over, pattern) {
  const problems = problemsOf(over);
  assert.ok(problems.some((p) => pattern.test(p)), `expected a problem matching ${pattern}, got: ${JSON.stringify(problems, null, 1)}`);
}

test('the format is versioned', () => {
  assert.equal(CASE_FORMAT, 'verdikta.calibration-case/1');
});

test('a well-formed corpus loads, with everything the format carries', () => {
  const corpus = writeCorpus();
  try {
    const { cases, byId } = loadCorpus({ root: corpus.root });
    assert.equal(cases.length, 2);
    const c = byId.get('adversarial.store');
    assert.equal(c.listing.commit, corpus.commit, 'repo@commit');
    assert.equal(c.listing.spec.baseCommit, corpus.commit);
    assert.deepEqual(c.listing.knownIssues, []);
    assert.equal(c.claim.finding.claimedClass, 'HIGH');
    assert.equal(c.claim.report, '# A report\n');
    assert.ok(Buffer.isBuffer(c.claim.poc));
    assert.equal(c.claim.fix, null);
    assert.deepEqual(c.priors, []);
    assert.equal(c.expected.outcome, 'INVALID');
    assert.equal(c.source.licence, 'MIT');
  } finally {
    corpus.cleanup();
  }
});

test('the wrong format version is refused', () => assertRefused({ adversarial: { format: 'verdikta.calibration-case/2' } }, /adversarial\.store.*format/));
test('an unknown field is refused, not ignored', () => assertRefused({ adversarial: { expecting: {} } }, /adversarial\.store.*unknown field.*expecting/));
test('an id that is not its folder is refused', () => assertRefused({ adversarial: { id: 'adversarial.other' } }, /adversarial\.store.*id/));
test('a case with no source is refused', () => assertRefused({ adversarial: { source: undefined } }, /adversarial\.store.*source/));
test('a case with no licence is refused', () => assertRefused({ adversarial: { source: { url: 'https://example.org/a', program: null } } }, /adversarial\.store.*licence/));
test('a source url that is not https is refused', () => assertRefused({ adversarial: { source: { url: 'http://example.org/a', licence: 'MIT', program: null } } }, /adversarial\.store.*url/));

test('a missing claim file is refused', () => {
  const corpus = writeCorpus();
  try {
    fs.rmSync(path.join(corpus.casePath('store'), 'poc.patch'));
    assert.throws(() => loadCorpus({ root: corpus.root }), (e) => e instanceof CorpusError && e.problems.some((p) => /adversarial\.store.*poc\.patch/.test(p)));
  } finally {
    corpus.cleanup();
  }
});

test('a finding common refuses is refused', () => {
  const corpus = writeCorpus();
  try {
    fs.writeFileSync(path.join(corpus.casePath('store'), 'finding.json'), '{"version":1}\n');
    assert.throws(() => loadCorpus({ root: corpus.root }), (e) => e instanceof CorpusError && e.problems.some((p) => /adversarial\.store.*finding\.json/.test(p)));
  } finally {
    corpus.cleanup();
  }
});

test('a folder that is not a case fails the whole load, whichever subset was asked for', () => {
  const corpus = writeCorpus();
  try {
    fs.mkdirSync(path.join(corpus.root, 'cases/other/orphan'), { recursive: true });
    fs.writeFileSync(path.join(corpus.root, 'cases/other/orphan/poc.patch'), 'x');
    assert.throws(() => loadCorpus({ root: corpus.root }), (e) => e instanceof CorpusError && e.problems.some((p) => /orphan.*case\.json/.test(p)));
  } finally {
    corpus.cleanup();
  }
});

test('every problem is reported at once', () => {
  const problems = problemsOf({ adversarial: { format: 'x', source: undefined }, control: { title: '' } });
  assert.ok(problems.length >= 3, JSON.stringify(problems));
});

test('expected: an outcome outside the set', () => assertRefused({ adversarial: { expected: { ...juryCase().expected, outcome: 'MAYBE' } } }, /outcome/));
test('expected: VALID needs a class', () => assertRefused({ adversarial: { expected: { ...juryCase().expected, outcome: 'VALID', class: null } } }, /class/));
test('expected: a class beside INVALID', () => assertRefused({ adversarial: { expected: { ...juryCase().expected, outcome: 'INVALID', class: 'HIGH' } } }, /class/));
test('expected: no reason', () => assertRefused({ adversarial: { expected: { ...juryCase().expected, reason: '' } } }, /reason/));

function withRunner(base, runner) {
  return { expected: { ...base.expected, runner: { ...base.expected.runner, ...runner } } };
}

test('expected: every gate must be named', () => {
  const { integrity, ...gates } = GATES_PASS;
  assertRefused({ adversarial: withRunner(juryCase(), { gates }) }, /gates.*integrity/);
});
test('expected: a failed gate must state its reason', () => assertRefused({ control: withRunner(controlCase(), { gateDetails: {} }) }, /reproduces.*gateDetails|gateDetails.*reproduces/));
test('expected: a settlement that contradicts the gates (jury with a failed gate)', () => assertRefused({ control: withRunner(controlCase(), { settlement: { kind: 'jury' } }) }, /settlement/));
test('expected: a settlement that contradicts the gates (invalid with every gate passed)', () => assertRefused({ adversarial: withRunner(juryCase(), { settlement: { kind: 'invalid', gate: 'build', check: 'BUILD_FAILED' } }) }, /settlement/));
test('expected: an invalid settlement must name its gate and check', () => assertRefused({ control: withRunner(controlCase(), { settlement: { kind: 'invalid' } }) }, /settlement.*(gate|check)/));
test('expected: a settlement that contradicts the outcome', () => {
  const c = controlCase();
  assertRefused({ control: { expected: { ...c.expected, outcome: 'DUPLICATE' } } }, /settlement.*outcome|outcome.*settlement/);
});
test('expected: a duplicate settlement must name the checks that failed', () => {
  const c = controlCase();
  assertRefused({
    control: {
      expected: {
        ...c.expected,
        outcome: 'DUPLICATE',
        runner: { ...c.expected.runner, gates: { ...GATES_PASS, reproduces: 'fail', integrity: 'fail', claimedObservable: 'not-run' }, gateDetails: { reproduces: 'x', integrity: 'y' }, settlement: { kind: 'duplicate', gate: 'integrity', check: 'INTEGRITY_CHECK_FAILED', failedChecks: [] } }
      }
    }
  }, /failedChecks/);
});
test('expected: an honesty flag with no line is refused', () => assertRefused({ adversarial: withRunner(juryCase(), { honestyFlags: [{ rule: 'verdikta.honesty.storage-overwrite', file: 'test/Claim.t.sol' }] }) }, /honestyFlags/));
test('expected: a rule outside the rule set', () => assertRefused({ adversarial: withRunner(juryCase(), { honestyFlags: [{ rule: 'storage-overwrite', file: 'test/Claim.t.sol', line: 3 }] }) }, /honestyFlags/));
test('expected: no tests where the PoC ran', () => assertRefused({ adversarial: withRunner(juryCase(), { tests: [] }) }, /tests/));
test('expected: an abstention with a settlement is refused', () => {
  const c = juryCase();
  assertRefused({ adversarial: { expected: { ...c.expected, outcome: 'ABSTAIN', runner: { result: 'abstain', abstain: { cause: 'nonzero', step: 'poc:1' }, settlement: { kind: 'jury' } } } } }, /abstain/);
});

// --------------------------------------------------- the control: the same PoC without the adversarial part

test('an adversarial case with no control is refused', () => assertRefused({ adversarial: { control: undefined } }, /adversarial\.store.*control/));
test('a control that does not exist', () => assertRefused({ adversarial: { control: { ...juryCase().control, case: 'adversarial.nothing' } } }, /adversarial\.nothing/));
test('a control that does not point back', () => assertRefused({ control: { controlOf: 'adversarial.other' } }, /controlOf/));
test('a line the case says it has, and has not', () => assertRefused({ adversarial: { control: { ...juryCase().control, removes: { 'poc.patch': ['+    nothing like it'] } } } }, /nothing like it/));
test('a control that differs by more than the named lines', () => {
  const controlPoc = patch(POC_LINES.filter((l) => l !== ADVERSARIAL_LINE).concat(['+// and something else']));
  assertRefused({ controlPoc }, /poc\.patch.*something else|differs/);
});
test('a claim file not named must be byte-identical', () => {
  const corpus = writeCorpus();
  try {
    fs.writeFileSync(path.join(corpus.casePath('store.control'), 'report.md'), '# Another report\n');
    assert.throws(() => loadCorpus({ root: corpus.root }), (e) => e instanceof CorpusError && e.problems.some((p) => /report\.md/.test(p)));
  } finally {
    corpus.cleanup();
  }
});
test('a control with nothing removed or added is refused', () => assertRefused({ adversarial: { control: { ...juryCase().control, removes: {}, adds: {} } } }, /removes|adds/));
test('a control whose expected result does not differ where the case says', () => {
  assertRefused({ adversarial: { control: { ...juryCase().control, differsIn: ['gates.applies'] } } }, /differsIn.*gates\.applies/);
});
test('a control whose expected result differs where the case says it is the same', () => {
  assertRefused({ adversarial: { control: { ...juryCase().control, sameIn: ['settlement.kind'] } } }, /sameIn.*settlement\.kind/);
});
test('a control with no differsIn is refused', () => assertRefused({ adversarial: { control: { ...juryCase().control, differsIn: [] } } }, /differsIn/));

// --------------------------------------------------- subsets

test('a subset selects its cases; an empty or unknown subset is an error, never zero cases that pass', () => {
  const corpus = writeCorpus();
  try {
    const loaded = loadCorpus({ root: corpus.root });
    assert.equal(selectCases(loaded, { subset: 'adversarial' }).length, 2);
    assert.throws(() => selectCases(loaded, { subset: 'clear-valid' }), /no case.*clear-valid/);
    assert.equal(selectCases(loaded, {}).length, 2, 'no subset: every case');
  } finally {
    corpus.cleanup();
  }
});

test('selecting one case brings its control or its case', () => {
  const corpus = writeCorpus();
  try {
    const loaded = loadCorpus({ root: corpus.root });
    assert.deepEqual(selectCases(loaded, { cases: ['adversarial.store'] }).map((c) => c.id).sort(), ['adversarial.store', 'adversarial.store.control']);
    assert.deepEqual(selectCases(loaded, { cases: ['adversarial.store.control'] }).map((c) => c.id).sort(), ['adversarial.store', 'adversarial.store.control']);
    assert.throws(() => selectCases(loaded, { cases: ['adversarial.nothing'] }), /adversarial\.nothing/);
  } finally {
    corpus.cleanup();
  }
});

// --------------------------------------------------- the real corpus

test('the real corpus loads, and holds the adversarial kinds of design §18', () => {
  const { byId } = loadCorpus({ root: CALIBRATION });
  for (const name of ['vm-store', 'vm-etch', 'mocked-module', 'fixture-creates-bug', 'unchecked-message', 'flaky', 'injected-critical', 'observable-mismatch']) {
    const c = byId.get(`adversarial.${name}`);
    assert.ok(c, `adversarial.${name}`);
    assert.ok(c.subsets.includes('adversarial'));
    const control = byId.get(c.control.case);
    assert.ok(control, `${c.control.case}`);
    assert.equal(control.controlOf, c.id);
  }
});

test('the real corpus holds the required counterexamples of design §18 in forge\'s form', () => {
  const { byId } = loadCorpus({ root: CALIBRATION });
  for (const name of ['forged-junit-exit', 'protected-file-at-runtime', 'reporter-patched', 'dependency-edited-during-run']) {
    assert.ok(byId.get(`adversarial.${name}`), name);
    assert.ok(byId.get(`adversarial.${name}.control`), `${name}.control`);
  }
});

test('the fixture repository is Verdikta\'s: every case says so and carries a licence', () => {
  const { cases } = loadCorpus({ root: CALIBRATION });
  for (const c of cases) {
    assert.match(c.source.url, /^https:\/\/github\.com\/verdikta\//, c.id);
    assert.equal(c.source.licence, 'MIT', c.id);
    assert.equal(c.listing.repo.kind, 'fixture', c.id);
  }
});

test('the flaky PoC reads no clock and no randomness: its mechanism is a file it writes', () => {
  const { byId } = loadCorpus({ root: CALIBRATION });
  const text = byId.get('adversarial.flaky').claim.poc.toString('utf8');
  assert.match(text, /vm\.isFile\("\.\/state\/flaky-first-run"\)/);
  assert.match(text, /vm\.writeFile\("\.\/state\/flaky-first-run"/);
  assert.doesNotMatch(text, /unixTime|randomUint|prevrandao|block\.timestamp|sleep|urandom/);
});

test('the external adapter and the runner pin the same @verdikta/common, so settleReport reads the same rules', () => {
  const pin = (dir) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', dir, 'package.json'), 'utf8')).dependencies['@verdikta/common'];
  assert.equal(pin('external-adapter'), pin('code-runner'));
});
