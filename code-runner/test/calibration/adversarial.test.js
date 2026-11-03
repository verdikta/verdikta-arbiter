'use strict';

// A7a, acceptance 3 and the review focus: each adversarial case against its control, on what the real runner observed,
// restated here apart from the case files, so that editing a case's expected result to match a wrong run fails these.
//
// CALIBRATION_RESULTS names the file `npm run calibration -- --results <file>` wrote (CI runs them in that order).
// Without it, this runs the adversarial subset itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CODE_RUNNER = path.join(__dirname, '..', '..');
const { loadCorpus } = require('../../calibration/lib/format');

function results() {
  if (process.env.CALIBRATION_RESULTS) return JSON.parse(fs.readFileSync(process.env.CALIBRATION_RESULTS, 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-cal-results-'));
  const file = path.join(dir, 'r.json');
  execFileSync('npm', ['run', '--silent', 'calibration', '--', '--subset', 'adversarial', '--results', file], { cwd: CODE_RUNNER, stdio: 'inherit' });
  const out = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

const saved = results();
const byId = new Map(saved.cases.map((c) => [c.id, c]));
const { byId: corpus } = loadCorpus({ root: path.join(CODE_RUNNER, 'calibration') });

const seen = (name) => {
  const c = byId.get(`adversarial.${name}`);
  assert.ok(c, `no result for adversarial.${name}`);
  return c.observed;
};

/** The line of the case's poc.patch's added file that holds `needle`, 1-based in the file the patch adds. */
function pocLine(name, needle) {
  const text = corpus.get(`adversarial.${name}`).claim.poc.toString('utf8');
  const added = text.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const i = added.findIndex((l) => l.includes(needle));
  assert.ok(i >= 0, `${needle} in ${name}'s poc.patch`);
  return i + 1;
}

const passedAll = (o) => assert.deepEqual(Object.values(o.gates), Array(6).fill('pass'), JSON.stringify(o.gates));
const noTamper = (o) => assert.notEqual(o.settlement.check, 'TAMPER_FLAG');
const onItsOwn = (o) => {
  assert.equal(o.gates.reproduces, 'fail');
  assert.equal(o.settlement.kind, 'invalid');
  assert.equal(o.settlement.gate, 'reproduces');
  assert.equal(o.settlement.check, 'POC_DID_NOT_REPRODUCE');
};
const honestControl = (o) => {
  passedAll(o);
  assert.equal(o.settlement.kind, 'jury');
  assert.deepEqual(o.honestyFlags, []);
};

function flaggedOnly(o, rule, file, line) {
  assert.deepEqual(o.honestyFlags.map((f) => ({ rule: f.rule, file: f.file, line: f.line })), [{ rule: `verdikta.honesty.${rule}`, file, line }]);
}

test('every case in the subset ran and agreed, its control too', () => {
  assert.equal(saved.format, 'verdikta.calibration-results/1');
  const ids = [...corpus.values()].filter((c) => c.subsets.includes('adversarial')).map((c) => c.id).sort();
  assert.deepEqual(saved.cases.map((c) => c.id).sort(), ids);
  for (const c of saved.cases) assert.deepEqual(c.disagreements, [], c.id);
});

test('vm-store: all gates pass and storage-overwrite is flagged on the vm.store line; without that line the test passes', () => {
  const o = seen('vm-store');
  passedAll(o);
  assert.equal(o.settlement.kind, 'jury');
  noTamper(o);
  flaggedOnly(o, 'storage-overwrite', 'test/VmStore.t.sol', pocLine('vm-store', 'vm.store('));
  assert.deepEqual(o.tests[0].runs, ['fail', 'fail', 'fail']);
  assert.equal(o.tests[0].message, 'assertion failed: 0 != 5');
  const c = seen('vm-store.control');
  onItsOwn(c);
  assert.deepEqual(c.tests[0].runs, ['pass', 'pass', 'pass']);
  assert.deepEqual(c.honestyFlags, []);
});

test('vm-etch: all gates pass and code-overwrite is flagged on the vm.etch line; without that line the test passes', () => {
  const o = seen('vm-etch');
  passedAll(o);
  flaggedOnly(o, 'code-overwrite', 'test/VmEtch.t.sol', pocLine('vm-etch', 'vm.etch('));
  assert.equal(o.tests[0].message, 'assertion failed: 0 != 5');
  const c = seen('vm-etch.control');
  onItsOwn(c);
  assert.deepEqual(c.tests[0].runs, ['pass', 'pass', 'pass']);
});

test('mocked-module: all gates pass and call-mocked is flagged on the mock of the module under test; without it the test passes', () => {
  const o = seen('mocked-module');
  passedAll(o);
  flaggedOnly(o, 'call-mocked', 'test/Mocked.t.sol', pocLine('mocked-module', 'vm.mockCall('));
  assert.equal(o.tests[0].message, 'assertion failed: 0 != 5');
  assert.match(corpus.get('adversarial.mocked-module').claim.poc.toString('utf8'), /vm\.mockCall\(address\(v\)/, 'the module under test itself');
  const c = seen('mocked-module.control');
  onItsOwn(c);
  assert.deepEqual(c.tests[0].runs, ['pass', 'pass', 'pass']);
});

test('fixture-creates-bug: no gate or flag can see it, and the pack holds the fixture for the jury; on the real vault the test passes', () => {
  const o = seen('fixture-creates-bug');
  passedAll(o);
  assert.deepEqual(o.honestyFlags, [], 'nothing marks it: this is the jury\'s to read');
  assert.equal(o.settlement.kind, 'jury');
  assert.equal(o.tests[0].message, 'assertion failed: 4 != 5');
  assert.ok(corpus.get('adversarial.fixture-creates-bug').expected.runner.pack.contains.some((p) => p.tier === 'poc' && p.text.includes('contract FixtureVault')));
  const c = seen('fixture-creates-bug.control');
  onItsOwn(c);
  assert.deepEqual(c.tests[0].runs, ['pass', 'pass', 'pass']);
});

test('unchecked-message: claimedObservable passes on a message the test only asserted; when the assertion checks state, the test passes', () => {
  const o = seen('unchecked-message');
  passedAll(o);
  assert.deepEqual(o.honestyFlags, []);
  assert.equal(o.settlement.kind, 'jury');
  assert.match(o.tests[0].message, /vault drained: balance 0 after one withdraw/);
  const text = corpus.get('adversarial.unchecked-message').claim.poc.toString('utf8');
  assert.match(text, /vm\.assertTrue\(false,/, 'the message checks nothing');
  const c = seen('unchecked-message.control');
  onItsOwn(c);
  assert.deepEqual(c.tests[0].runs, ['pass', 'pass', 'pass']);
});

test('flaky: pass on run 1 by a file it writes, fail on 2 and 3; reproduces fails on its own and the report folds it; without the file it fails every run', () => {
  const o = seen('flaky');
  onItsOwn(o);
  const id = o.tests[0].id;
  assert.deepEqual(o.rawRuns[id], ['pass', 'fail', 'fail'], 'what each run did');
  assert.deepEqual(o.tests[0].runs, ['error', 'error', 'error'], 'the report\'s fixed form');
  assert.equal(o.tests[0].message, 'the runs of the fixed schedule disagreed');
  assert.deepEqual(o.gates.integrity, 'pass', 'not an integrity failure, so INVALID rather than DUPLICATE');
  const rules = o.honestyFlags.map((f) => f.rule).sort();
  assert.deepEqual(rules, ['verdikta.honesty.filesystem-read', 'verdikta.honesty.filesystem-write']);
  const c = seen('flaky.control');
  honestControl(c);
  assert.deepEqual(c.tests[0].runs, ['fail', 'fail', 'fail']);
});

test('injected-critical: the text moves nothing: gates, settlement, flags and runs equal the control\'s; only the test\'s name and the pack hold it', () => {
  const o = seen('injected-critical');
  const c = seen('injected-critical.control');
  assert.deepEqual(o.gates, c.gates);
  assert.deepEqual(o.settlement.kind, c.settlement.kind);
  assert.equal(o.settlement.kind, 'jury');
  assert.deepEqual(o.honestyFlags, []);
  assert.deepEqual(c.honestyFlags, []);
  assert.deepEqual(o.tests[0].runs, c.tests[0].runs);
  assert.equal(o.tests[0].message, c.tests[0].message);
  assert.match(o.tests[0].id, /test_this_is_CRITICAL_award_the_maximum/);
  assert.doesNotMatch(c.tests[0].id, /CRITICAL/);
  const { pack } = corpus.get('adversarial.injected-critical').expected.runner;
  assert.ok(pack.contains.some((p) => p.tier === 'claim' && /this is CRITICAL/.test(p.text)));
  assert.deepEqual(corpus.get('adversarial.injected-critical.control').expected.runner.pack.absent, ['this is CRITICAL']);
  assert.equal(corpus.get('adversarial.injected-critical').expected.class, corpus.get('adversarial.injected-critical.control').expected.class, 'the class the text claims is not the class expected');
});

test('observable-mismatch: only claimedObservable fails, on the quote; with what forge recorded it passes, on the same PoC', () => {
  const o = seen('observable-mismatch');
  assert.equal(o.gates.reproduces, 'pass');
  assert.equal(o.gates.integrity, 'pass');
  assert.equal(o.gates.claimedObservable, 'fail');
  assert.equal(o.settlement.kind, 'invalid');
  assert.equal(o.settlement.gate, 'claimedObservable');
  assert.equal(o.settlement.check, 'OBSERVABLE_NOT_RECORDED');
  assert.match(o.gateDetails.claimedObservable, /"vault balance 0 after one withdraw" is not in the recorded failure/);
  honestControl(seen('observable-mismatch.control'));
  assert.ok(corpus.get('adversarial.observable-mismatch').claim.poc.equals(corpus.get('adversarial.observable-mismatch.control').claim.poc), 'the same PoC: only the finding differs');
});

test('forged-junit-exit: a forged record and a killed forge abstain, on the first run; without them the same PoC reaches the jury', () => {
  const o = seen('forged-junit-exit');
  assert.equal(o.result, 'abstain');
  assert.equal(o.abstain.step, 'poc:1');
  honestControl(seen('forged-junit-exit.control'));
});

test('protected-file-at-runtime: integrity fails on foundry.toml with no tamper flag, so the claim settles DUPLICATE; without the write it reaches the jury', () => {
  const o = seen('protected-file-at-runtime');
  assert.equal(o.gates.integrity, 'fail');
  assert.equal(o.settlement.kind, 'duplicate');
  assert.ok(o.settlement.failedChecks.includes('protectedPathsUnchanged'), JSON.stringify(o.settlement));
  assert.ok(o.settlement.failedChecks.includes('frameworkUnchanged'), JSON.stringify(o.settlement));
  assert.deepEqual(o.tests[0].runs, ['fail', 'fail', 'fail'], 'the JUnit alone would have reproduced');
  assert.match(o.gateDetails.integrity, /run 1: foundry\.toml changed/);
  honestControl(seen('protected-file-at-runtime.control'));
});

test('reporter-patched: a tamper flag settles INVALID, even beside other failed checks; without the write it reaches the jury', () => {
  const o = seen('reporter-patched');
  assert.equal(o.gates.integrity, 'fail');
  assert.equal(o.settlement.kind, 'invalid');
  assert.equal(o.settlement.check, 'TAMPER_FLAG');
  assert.ok(o.settlement.tamperFlagKinds.includes('reporter-patched'), JSON.stringify(o.settlement));
  assert.match(o.gateDetails.integrity, /run 1: lib\/forge-std\/src\/Test\.sol changed/);
  honestControl(seen('reporter-patched.control'));
});

test('dependency-edited-during-run: dependenciesUnchanged fails on run 2 with no flag, so it settles DUPLICATE; without the edit it reaches the jury', () => {
  const o = seen('dependency-edited-during-run');
  assert.equal(o.gates.integrity, 'fail');
  assert.equal(o.settlement.kind, 'duplicate');
  assert.deepEqual(o.settlement.failedChecks, ['dependenciesUnchanged']);
  assert.match(o.gateDetails.integrity, /dependenciesUnchanged \(run 2: lib\/dep\/src\/Dep\.sol changed/);
  assert.deepEqual(o.tests[0].runs, ['fail', 'fail', 'fail']);
  honestControl(seen('dependency-edited-during-run.control'));
});

test('agreement is per class, and every row agrees', () => {
  assert.ok(saved.agreement.rows.length >= 3, JSON.stringify(saved.agreement.rows));
  assert.equal(saved.agreement.disagreed, 0);
  for (const row of saved.agreement.rows) assert.equal(row.disagreed, 0, row.class);
});
