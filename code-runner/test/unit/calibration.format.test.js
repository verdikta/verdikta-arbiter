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

for (const [name, bytes] of [['null', 'null\n'], ['a list', '[]\n'], ['a string', '"case"\n'], ['a number', '1\n']]) {
  test(`R1-F1: a case.json that is ${name} fails the load, and is not skipped`, () => {
    const corpus = writeCorpus();
    try {
      fs.writeFileSync(path.join(corpus.casePath('store.control'), 'case.json'), bytes);
      assert.throws(() => loadCorpus({ root: corpus.root }), (e) => e instanceof CorpusError && e.problems.some((p) => /adversarial\.store\.control.*case\.json.*JSON object/.test(p)));
    } finally {
      corpus.cleanup();
    }
  });

  test(`R1-F1: a listing.json that is ${name} fails the load`, () => {
    const corpus = writeCorpus();
    try {
      fs.writeFileSync(path.join(corpus.root, 'listings/vault/listing.json'), bytes);
      assert.throws(() => loadCorpus({ root: corpus.root }), (e) => e instanceof CorpusError && e.problems.some((p) => /listing\.json.*JSON object/.test(p)));
    } finally {
      corpus.cleanup();
    }
  });

  test(`R1-F1: a code_review.json that is ${name} fails the load`, () => {
    const corpus = writeCorpus();
    try {
      fs.writeFileSync(path.join(corpus.root, 'listings/vault/code_review.json'), bytes);
      assert.throws(() => loadCorpus({ root: corpus.root }), (e) => e instanceof CorpusError && e.problems.some((p) => /code_review\.json.*JSON object/.test(p)));
    } finally {
      corpus.cleanup();
    }
  });

  test(`R1-F1: a baseline.json that is ${name} fails the load`, () => {
    const corpus = writeCorpus();
    try {
      fs.writeFileSync(path.join(corpus.root, 'listings/vault/baseline.json'), bytes);
      assert.throws(() => loadCorpus({ root: corpus.root }), (e) => e instanceof CorpusError && e.problems.some((p) => /baseline\.json/.test(p)));
    } finally {
      corpus.cleanup();
    }
  });

  test(`R1-F1: a finding.json that is ${name} fails the load`, () => {
    const corpus = writeCorpus();
    try {
      fs.writeFileSync(path.join(corpus.casePath('store'), 'finding.json'), bytes);
      assert.throws(() => loadCorpus({ root: corpus.root }), (e) => e instanceof CorpusError && e.problems.some((p) => /adversarial\.store: finding\.json.*JSON object/.test(p)));
    } finally {
      corpus.cleanup();
    }
  });

  test(`R1-F1: a prior's finding.json that is ${name} fails the load, and the prior is not dropped`, () => {
    const corpus = writeCorpus({ adversarial: { priorFindings: ['priors/01'] } });
    try {
      const dir = path.join(corpus.casePath('store'), 'priors/01');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'finding.json'), bytes);
      fs.writeFileSync(path.join(dir, 'report.md'), '# Earlier\n');
      assert.throws(() => loadCorpus({ root: corpus.root }), (e) => e instanceof CorpusError && e.problems.some((p) => /priors\/01\/finding\.json.*JSON object/.test(p)));
    } finally {
      corpus.cleanup();
    }
  });
}

test('known_issues.json must be a list', () => {
  const corpus = writeCorpus();
  try {
    fs.writeFileSync(path.join(corpus.root, 'listings/vault/known_issues.json'), '{}\n');
    assert.throws(() => loadCorpus({ root: corpus.root }), (e) => e instanceof CorpusError && e.problems.some((p) => /known_issues\.json.*JSON list/.test(p)));
  } finally {
    corpus.cleanup();
  }
});

test('a file in a case folder that the case does not name fails the load: a fix.patch left out of claim.fix would never run', () => {
  const corpus = writeCorpus();
  try {
    fs.writeFileSync(path.join(corpus.casePath('store'), 'fix.patch'), 'diff\n');
    assert.throws(() => loadCorpus({ root: corpus.root }), (e) => e instanceof CorpusError && e.problems.some((p) => /adversarial\.store.*fix\.patch.*names/.test(p)));
  } finally {
    corpus.cleanup();
  }
});

test('a prior folder the case does not name fails the load', () => {
  const corpus = writeCorpus();
  try {
    const dir = path.join(corpus.casePath('store'), 'priors/01');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'finding.json'), '{}\n');
    assert.throws(() => loadCorpus({ root: corpus.root }), (e) => e instanceof CorpusError && e.problems.some((p) => /priors\/01\/finding\.json.*names/.test(p)));
  } finally {
    corpus.cleanup();
  }
});

test('a file in a listing folder the format does not name fails the load', () => {
  const corpus = writeCorpus();
  try {
    fs.writeFileSync(path.join(corpus.root, 'listings/vault/known-issues.json'), '[]\n');
    assert.throws(() => loadCorpus({ root: corpus.root }), (e) => e instanceof CorpusError && e.problems.some((p) => /known-issues\.json/.test(p)));
  } finally {
    corpus.cleanup();
  }
});

test('subsets that are not a list are a problem to report, not a crash', () => {
  assertRefused({ adversarial: { subsets: 'adversarial' } }, /adversarial\.store.*subsets/);
});

test('a prior listed twice, or not as a path, is refused', () => {
  assertRefused({ adversarial: { priorFindings: ['priors/01', 'priors/01'] } }, /priors\/01.*more than once/);
  assertRefused({ adversarial: { priorFindings: [1] } }, /priorFindings/);
});

test('a path that leaves the corpus is refused', () => {
  assertRefused({ adversarial: { listing: '../outside' } }, /listing.*inside the corpus/);
  assertRefused({ adversarial: { listing: '/etc' } }, /listing.*inside the corpus/);
  assertRefused({ adversarial: { priorFindings: ['../other/priors/01'] } }, /priorFindings.*inside/);
  assertRefused({ listing: { repo: { kind: 'fixture', path: '../outside' } } }, /repo\.path.*inside the corpus/);
});

test('a repo with a field of the other kind, or an unknown one, is refused', () => {
  assertRefused({ listing: { repo: { kind: 'fixture', path: 'repos/vault', url: 'https://example.org/x' } } }, /repo: unknown field url/);
  assertRefused({ listing: { repo: { kind: 'git', url: 'https://example.org/x', path: 'repos/vault' } } }, /repo: unknown field path/);
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
test('source.program: null, or the program and its verdict', () => {
  const source = { url: 'https://example.org/a', licence: 'CC-BY-4.0' };
  assertRefused({ adversarial: { source: { ...source, program: { name: 'A contest' } } } }, /source\.program/);
  assert.deepEqual(problemsOf({ adversarial: { source: { ...source, program: { name: 'A contest', verdict: 'valid', class: 'HIGH' } } } }), []);
});
test('expected: a test with no kind is refused', () => assertRefused({ adversarial: withRunner(juryCase(), { tests: [{ id: 'x', runs: ['fail', 'fail', 'fail'], message: 'm' }] }) }, /tests/));
test('expected: raw runs of the wrong shape', () => assertRefused({ adversarial: withRunner(juryCase(), { rawRuns: { x: ['fail'] } }) }, /rawRuns/));
test('expected: flags that do not name all three lists', () => assertRefused({ adversarial: withRunner(juryCase(), { flags: { skipMarkersAdded: [] } }) }, /flags/));
test('expected: findings with no line', () => assertRefused({ adversarial: withRunner(juryCase(), { findings: [{ rule: 'r', file: 'f' }] }) }, /findings/));
test('expected: a fix check missing a field', () => assertRefused({ adversarial: withRunner(juryCase(), { fix: { applies: 'pass' } }) }, /fix must hold/));
test('expected: a pack entry with no tier', () => assertRefused({ adversarial: withRunner(juryCase(), { pack: { contains: [{ text: 'x' }] } }) }, /pack\.contains/));
test('expected: a pack with an unknown key', () => assertRefused({ adversarial: withRunner(juryCase(), { pack: { contain: [] } }) }, /pack: unknown field contain/));
test('expected: too many prior findings', () => assertRefused({ adversarial: { priorFindings: Array.from({ length: 9 }, (_, i) => `priors/${i}`) } }, /at most 8/));
test('expected: tamper flags must name their kind, file and line', () => assertRefused({ adversarial: withRunner(juryCase(), { tamperFlags: [{ kind: 'reporter-patched' }] }) }, /tamperFlags/));
test('expected: integrityFailed must name the checks of the report', () => assertRefused({ adversarial: withRunner(juryCase(), { integrityFailed: ['noSuchCheck'] }) }, /integrityFailed/));
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
test('a sameIn path that names nothing is refused: it would agree with itself whatever happened', () => {
  assertRefused({ adversarial: { control: { ...juryCase().control, sameIn: ['gates.aplies'] } } }, /sameIn gates\.aplies/);
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
