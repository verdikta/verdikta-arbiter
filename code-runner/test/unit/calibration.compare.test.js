'use strict';

// A7a's review focus: a case holds for the reason it states. The comparison is exact on everything that names a reason,
// and any change to an expected value is noticed (the mutations also run against real observations in CI: --self-check).

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareCase, observe, relationProblems, agreement, renderReport, mutations, actualLabel } = require('../../calibration/lib/compare');
const { juryCase, controlCase, GATES_PASS, TEST_ID } = require('../helpers/calibrationCorpus');

function observedFrom(runner, over = {}) {
  return {
    result: runner.result,
    abstain: runner.abstain || null,
    issues: runner.issues || null,
    gates: runner.gates || null,
    gateDetails: Object.fromEntries(Object.keys(runner.gateDetails || {}).map((g) => [g, `the runner says ${runner.gateDetails[g]} here`])),
    settlement: runner.settlement ? { ...runner.settlement, reason: 'text settleReport writes' } : null,
    honestyFlags: runner.honestyFlags || [],
    tests: runner.tests || [],
    rawRuns: Object.fromEntries((runner.tests || []).map((t) => [t.id, t.runs])),
    flags: { existingTestsModified: [], skipMarkersAdded: [], protectedPathsTouched: [] },
    findings: [],
    fix: null,
    pack: [{ tier: 'poc', text: 'the PoC' }, { tier: 'claim', text: 'the report' }],
    ...over
  };
}

test('an observation equal to the expected result agrees', () => {
  const { runner } = juryCase().expected;
  assert.deepEqual(compareCase(runner, observedFrom(runner)), []);
  const control = controlCase().expected.runner;
  assert.deepEqual(compareCase(control, observedFrom(control)), []);
});

test('the settlement\'s own text is not compared: only what names the rule', () => {
  const { runner } = controlCase().expected;
  const seen = observedFrom(runner);
  seen.settlement.reason = 'any words';
  assert.deepEqual(compareCase(runner, seen), []);
});

function differs(expected, seen, pathRe) {
  const found = compareCase(expected, seen);
  assert.ok(found.some((d) => pathRe.test(d.path)), `a disagreement at ${pathRe}: ${JSON.stringify(found)}`);
  for (const d of found) {
    assert.ok('expected' in d && 'actual' in d, 'names both sides');
  }
}

test('another gate status disagrees', () => {
  const { runner } = juryCase().expected;
  differs(runner, observedFrom(runner, { gates: { ...GATES_PASS, integrity: 'fail' } }), /^gates\.integrity$/);
});

test('a flag on another line disagrees', () => {
  const { runner } = juryCase().expected;
  differs(runner, observedFrom(runner, { honestyFlags: [{ ...runner.honestyFlags[0], line: 4, message: 'm' }] }), /^honestyFlags/);
});

test('a flag no one expected disagrees', () => {
  const { runner } = juryCase().expected;
  differs(runner, observedFrom(runner, { honestyFlags: [...runner.honestyFlags, { rule: 'verdikta.honesty.clock', file: 'test/Claim.t.sol', line: 9, message: 'm' }] }), /^honestyFlags/);
});

test('a missing flag disagrees: a case cannot pass if the rule it is for did not fire', () => {
  const { runner } = juryCase().expected;
  differs(runner, observedFrom(runner, { honestyFlags: [] }), /^honestyFlags/);
});

test('the same gates but another test message disagrees: an incidental failure cannot pass', () => {
  const { runner } = juryCase().expected;
  differs(runner, observedFrom(runner, { tests: [{ ...runner.tests[0], message: 'a revert from somewhere else' }] }), /^tests\.0\.message$/);
});

test('another run pattern disagrees', () => {
  const { runner } = juryCase().expected;
  differs(runner, observedFrom(runner, { tests: [{ ...runner.tests[0], runs: ['fail', 'fail', 'error'] }] }), /^tests\.0\.runs$/);
});

test('raw runs: what each run did, which the report folds for a flaky test', () => {
  const { runner } = juryCase().expected;
  const flaky = { ...runner, rawRuns: { [TEST_ID]: ['pass', 'fail', 'fail'] } };
  assert.deepEqual(compareCase(flaky, observedFrom(runner, { rawRuns: { [TEST_ID]: ['pass', 'fail', 'fail'] } })), []);
  differs(flaky, observedFrom(runner, { rawRuns: { [TEST_ID]: ['fail', 'pass', 'pass'] } }), /^rawRuns/);
});

test('raw runs left out must equal the report\'s runs', () => {
  const { runner } = juryCase().expected;
  differs(runner, observedFrom(runner, { rawRuns: { [TEST_ID]: ['pass', 'fail', 'fail'] } }), /^rawRuns/);
});

test('another settlement check disagrees, and another tamper kind', () => {
  const { runner } = controlCase().expected;
  differs(runner, observedFrom(runner, { settlement: { kind: 'invalid', gate: 'reproduces', check: 'POC_ADDED_NO_TEST', reason: 'r' } }), /^settlement\.check$/);
  const tamper = { ...runner, settlement: { kind: 'invalid', gate: 'integrity', check: 'TAMPER_FLAG', tamperFlagKinds: ['reporter-patched'] } };
  differs(tamper, observedFrom(tamper, { settlement: { kind: 'invalid', gate: 'integrity', check: 'TAMPER_FLAG', tamperFlagKinds: ['framework-patched'], reason: 'r' } }), /tamperFlagKinds/);
});

test('a gate\'s stated reason is a substring of the runner\'s, and another one disagrees', () => {
  const { runner } = controlCase().expected;
  differs(runner, observedFrom(runner, { gateDetails: { reproduces: 'something else altogether' } }), /^gateDetails\.reproduces$/);
});

test('an abstention where a verdict was expected disagrees, and the other way round', () => {
  const { runner } = juryCase().expected;
  differs(runner, { result: 'abstain', abstain: { cause: 'timeout', step: 'build' }, detail: 'x' }, /^result$/);
  const abstaining = { result: 'abstain', abstain: { cause: 'sandbox_died', step: 'poc:1' } };
  assert.deepEqual(compareCase(abstaining, { result: 'abstain', abstain: { cause: 'sandbox_died', step: 'poc:1' } }), []);
  differs(abstaining, { result: 'abstain', abstain: { cause: 'sandbox_died', step: 'poc:2' } }, /^abstain\.step$/);
  differs(abstaining, observedFrom(runner), /^result$/);
});

test('a refusal where a verdict was expected names its code, and the codes are compared', () => {
  const { runner } = juryCase().expected;
  const refused = { result: 'requester_error', issues: ['COMMAND_NOT_ALLOWED'] };
  const [one] = compareCase(runner, refused);
  assert.equal(one.path, 'result');
  assert.match(one.actual, /COMMAND_NOT_ALLOWED/);
  assert.deepEqual(compareCase({ result: 'requester_error', issues: ['COMMAND_NOT_ALLOWED'] }, refused), []);
  differs({ result: 'requester_error', issues: ['BASELINE_INVALID'] }, refused, /^issues$/);
});

test('an abstention where a verdict was expected says which, and why', () => {
  const [one] = compareCase(juryCase().expected.runner, { result: 'abstain', abstain: { cause: 'oom', step: 'build' }, detail: 'exit 137' });
  assert.match(one.actual, /abstain \(oom at build: exit 137\)/);
});

test('integrity: a failed check or a tamper flag no one expected disagrees, and each is located', () => {
  const { runner } = juryCase().expected;
  differs(runner, observedFrom(runner, { integrityFailed: ['frameworkUnchanged'] }), /^integrityFailed$/);
  differs(runner, observedFrom(runner, { tamperFlags: [{ kind: 'reporter-patched', file: 'test/Claim.t.sol', line: 3 }] }), /^tamperFlags$/);
  const tampered = { ...runner, tamperFlags: [{ kind: 'reporter-patched', file: 'test/Claim.t.sol', line: 3 }], integrityFailed: ['frameworkUnchanged'] };
  assert.deepEqual(compareCase(tampered, observedFrom(tampered, { integrityFailed: ['frameworkUnchanged'], tamperFlags: tampered.tamperFlags })), []);
  differs(tampered, observedFrom(tampered, { integrityFailed: ['frameworkUnchanged'], tamperFlags: [{ ...tampered.tamperFlags[0], line: 4 }] }), /^tamperFlags$/);
});

test('integrity: a duplicate\'s failed checks are its settlement\'s, with no need to say so twice', () => {
  const settlement = { kind: 'duplicate', gate: 'integrity', check: 'INTEGRITY_CHECK_FAILED', failedChecks: ['dependenciesUnchanged'] };
  const runner = { ...controlCase().expected.runner, settlement };
  assert.deepEqual(compareCase(runner, observedFrom(runner, { integrityFailed: ['dependenciesUnchanged'] })), []);
  differs(runner, observedFrom(runner, { integrityFailed: ['frameworkUnchanged'] }), /^integrityFailed$/);
});

test('observe reads the failed checks and the tamper flags from the report', () => {
  const { runner } = controlCase().expected;
  const report = {
    gates: runner.gates, inputs: {},
    poc: { tests: runner.tests, honestyFlags: [], integrity: { identityComplete: true, frameworkUnchanged: false, dependenciesUnchanged: false, tamperFlags: [{ kind: 'reporter-patched', file: 'f', line: 2 }] } },
    fix: { present: false }, findings: [], flags: {}
  };
  const seen = observe({ outcome: 'definitive', report, reportSha256: 'a', runner: {}, gates: {}, facts: {} }, {}, { settle: () => ({ kind: 'invalid' }) });
  assert.deepEqual(seen.integrityFailed, ['frameworkUnchanged', 'dependenciesUnchanged']);
  assert.deepEqual(seen.tamperFlags, [{ kind: 'reporter-patched', file: 'f', line: 2 }]);
});

test('flags, findings and the fix check default to none, so an unexpected one disagrees', () => {
  const { runner } = juryCase().expected;
  differs(runner, observedFrom(runner, { flags: { existingTestsModified: ['test/Vault.t.sol'], skipMarkersAdded: [], protectedPathsTouched: [] } }), /^flags/);
  differs(runner, observedFrom(runner, { findings: [{ rule: 'x', file: 'src/Vault.sol', line: 1 }] }), /^findings/);
  differs(runner, observedFrom(runner, { fix: { applies: 'pass', builds: 'pass', pocPasses: true, regressionCount: 0 } }), /^fix/);
});

test('what the pack must hold, and must not', () => {
  const { runner } = juryCase().expected;
  const withPack = { ...runner, pack: { contains: [{ tier: 'poc', text: 'the PoC' }], absent: ['injected'] } };
  assert.deepEqual(compareCase(withPack, observedFrom(runner)), []);
  differs({ ...runner, pack: { contains: [{ tier: 'claim', text: 'the PoC' }] } }, observedFrom(runner), /^pack\.contains/);
  differs({ ...runner, pack: { absent: ['PoC'] } }, observedFrom(runner), /^pack\.absent/);
});

test('every alteration of an expected value is noticed', () => {
  for (const runner of [juryCase().expected.runner, controlCase().expected.runner]) {
    const seen = observedFrom(runner);
    const altered = [...mutations(runner)];
    assert.ok(altered.length > 10, `${altered.length} alterations`);
    for (const { label, runner: changed } of altered) {
      assert.notDeepEqual(compareCase(changed, seen), [], `altering ${label} was not noticed`);
    }
  }
});

test('observe reads a definitive answer: the settlement comes from the settle function, on the report', () => {
  const { runner } = juryCase().expected;
  const report = {
    gates: runner.gates, inputs: {},
    poc: { tests: runner.tests.map((t) => ({ ...t })), honestyFlags: [{ ...runner.honestyFlags[0], message: 'm' }] },
    fix: { present: false }, findings: [], flags: { existingTestsModified: [], skipMarkersAdded: [], protectedPathsTouched: [] }
  };
  const answer = {
    outcome: 'definitive', report, reportSha256: 'a'.repeat(64),
    runner: { version: '0.1.0', runtime: 'runsc', platform: 'linux/amd64', gvisor: 'release-20260921.0' },
    gates: Object.fromEntries(Object.entries(runner.gates).map(([g, s]) => [g, { status: s, basis: 'junit', detail: `detail of ${g}` }])),
    facts: { poc: { tests: runner.tests.map((t) => ({ id: t.id, runs: t.runs })) } },
    contextPack: { files: [{ tier: 'poc', name: 'x', text: 'the PoC' }] }
  };
  let settled = null;
  const seen = observe(answer, {}, { settle: (r) => { settled = r; return { kind: 'jury' }; } });
  assert.equal(settled, report);
  assert.deepEqual(compareCase(runner, seen), []);
  assert.equal(seen.gateDetails.build, 'detail of build');
  assert.equal(seen.reportSource, 'runner');
});

test('observe: the runner\'s abstention and its 400 are facts, not exceptions', () => {
  const abstain = observe({ outcome: 'abstain', abstain: { cause: 'oom', step: 'build', detail: 'd' } }, {}, { settle: () => assert.fail('nothing to settle') });
  assert.deepEqual(abstain.abstain, { cause: 'oom', step: 'build' });
  const refused = observe({ outcome: 'requester_error', issues: [{ code: 'COMMAND_NOT_ALLOWED', path: '/', detail: 'd' }] }, {}, { settle: () => assert.fail('nothing to settle') });
  assert.deepEqual(refused.issues, ['COMMAND_NOT_ALLOWED']);
  assert.equal(refused.result, 'requester_error');
});

test('observe: a report settleReport cannot read abstains in the observation, as it would in production', () => {
  const answer = { outcome: 'definitive', report: { gates: {}, poc: null, fix: { present: false }, findings: [], flags: {} }, reportSha256: 'a', runner: {}, gates: {}, facts: {} };
  const seen = observe(answer, {}, { settle: () => { const e = new Error('unreadable'); e.code = 'CODE_REVIEW_REPORT_UNREADABLE'; throw e; } });
  assert.deepEqual(seen.settlement, { kind: 'unreadable', detail: 'unreadable' });
});

test('the control relation holds on what was observed, not only on the case file', () => {
  const a = juryCase();
  const seenA = observedFrom(a.expected.runner);
  const seenB = observedFrom(controlCase().expected.runner);
  assert.deepEqual(relationProblems(a.control, seenA, seenB), []);
  const same = relationProblems(a.control, seenA, seenA);
  assert.ok(same.some((p) => /settlement\.kind/.test(p)), JSON.stringify(same));
  const notSame = relationProblems({ differsIn: [], sameIn: ['settlement.kind'] }, seenA, seenB);
  assert.ok(notSame.some((p) => /settlement\.kind/.test(p)), JSON.stringify(notSame));
});

test('the label names what happened, in the words of the outcome set', () => {
  assert.equal(actualLabel({ result: 'definitive', settlement: { kind: 'jury' } }), 'jury');
  assert.equal(actualLabel({ result: 'definitive', settlement: { kind: 'invalid' } }), 'INVALID');
  assert.equal(actualLabel({ result: 'definitive', settlement: { kind: 'duplicate' } }), 'DUPLICATE');
  assert.equal(actualLabel({ result: 'abstain' }), 'ABSTAIN');
  assert.equal(actualLabel({ result: 'requester_error' }), 'REQUESTER_ERROR');
});

function result(id, outcome, cls, actual, disagreements = []) {
  return { id, expected: { outcome, class: cls }, actual, disagreements };
}

test('agreement is per class, with expected and actual, and counts every disagreement', () => {
  const a = agreement([
    result('a', 'INVALID', null, 'INVALID'),
    result('b', 'INVALID', null, 'jury'),
    result('c', 'VALID', 'LOW', 'jury'),
    result('d', 'VALID', 'LOW', 'INVALID', [{ path: 'settlement.kind', expected: 'jury', actual: 'invalid' }]),
    result('e', 'DUPLICATE', null, 'DUPLICATE'),
    result('f', 'ABSTAIN', null, 'ABSTAIN')
  ]);
  assert.equal(a.total, 6);
  assert.equal(a.disagreed, 1);
  const low = a.rows.find((r) => r.class === 'LOW');
  assert.deepEqual(low, { class: 'LOW', cases: 2, agreed: 1, disagreed: 1, settledByRunner: 1, reachJury: 1, abstained: 0 });
  const invalid = a.rows.find((r) => r.class === 'INVALID');
  assert.deepEqual(invalid, { class: 'INVALID', cases: 2, agreed: 2, disagreed: 0, settledByRunner: 1, reachJury: 1, abstained: 0 });
  assert.equal(a.rows.find((r) => r.class === 'ABSTAIN').abstained, 1);
});

test('the report shows each case\'s expected and actual, each disagreement, and the table', () => {
  const text = renderReport({
    results: [
      result('adversarial.ok', 'INVALID', null, 'INVALID'),
      result('adversarial.bad', 'VALID', 'LOW', 'INVALID', [{ path: 'settlement.kind', expected: 'jury', actual: 'invalid' }])
    ],
    runner: { version: '0.1.0', runtime: 'runc', platform: 'linux/arm64', gvisor: 'runc' }
  });
  assert.match(text, /adversarial\.ok.*INVALID.*INVALID/);
  assert.match(text, /adversarial\.bad.*LOW.*INVALID/);
  assert.match(text, /settlement\.kind: expected "jury", actual "invalid"/);
  assert.match(text, /LOW\s+1\s+0\s+1/);
  assert.match(text, /1 of 2 case.* disagree/);
});

test('each case\'s line says what fired: the failed gates and check, the flags, the abstention', () => {
  const fired = (observed) => renderReport({ results: [{ ...result('c', 'INVALID', null, 'INVALID'), observed }], runner: { version: '0.1.0', runtime: 'runc', platform: 'linux/arm64', gvisor: 'runc' } });
  const { runner } = controlCase().expected;
  assert.match(fired(observedFrom(runner)), /failed: reproduces \(POC_DID_NOT_REPRODUCE\)/);
  assert.match(fired(observedFrom(juryCase().expected.runner)), /every gate passed; flags: storage-overwrite/);
  assert.match(fired({ result: 'abstain', abstain: { cause: 'oom', step: 'poc:1' } }), /abstain: oom at poc:1/);
});
