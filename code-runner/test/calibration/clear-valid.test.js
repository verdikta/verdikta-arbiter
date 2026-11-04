'use strict';

// A7b, acceptance 3 and the review focus: each clear-valid case on what the real runner observed on the class platform,
// restated here apart from the case files, so that editing a case's expected result to match a wrong run fails these. The class
// is the source program's, and the words are what the finding's own numbers or revert make the test print.
//
// CALIBRATION_RESULTS_DIR names the folder `npm run calibration -- --results <dir>/<listing>.json` wrote, one per CI job.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CODE_RUNNER = path.join(__dirname, '..', '..');
const { loadCorpus } = require('../../calibration/lib/format');

const dir = process.env.CALIBRATION_RESULTS_DIR;
if (!dir) throw new Error('CALIBRATION_RESULTS_DIR must name the folder of results: these cases run on the class platform, in CI');
const byId = new Map();
for (const file of fs.readdirSync(dir)) {
  for (const c of JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).cases) byId.set(c.id, c);
}
const { cases } = loadCorpus({ root: path.join(CODE_RUNNER, 'calibration') });
const clearValid = cases.filter((c) => c.subsets.includes('clear-valid'));

const RESTATED = Object.freeze({
  'layeredge-tier-promotion': { cls: 'HIGH', words: '20000000000000000000 != 35000000000000000000' },
  'mellow-transfer-whitelist': { cls: 'MEDIUM', words: 'TransferNotAllowed(' },
  'mellow-fee-per-period': { cls: 'HIGH', words: '331000000000000000000 != 100000000000000000000' },
  'magicsea-renew-rewards': { cls: 'MEDIUM', words: '!= 0' },
  'magicsea-add-to-position': { cls: 'MEDIUM', words: '604800 != 1209600' },
  'flayer-unlock-checkpoint': { cls: 'HIGH', words: '402055890410801920 < 402485479451875840' },
  'flayer-adjust-position': { cls: 'HIGH', words: '0 != 2055890410801920' },
  'basin-upgrade-access': { cls: 'HIGH', words: 'the implementation stays the one the owner chose' },
  'basin-reserve-at-ratio': { cls: 'MEDIUM', words: 'Non convergence: calcLpTokenSupply' },
  'sequence-session-replay': { cls: 'MEDIUM', words: 'the signature is not good for the other wallet' },
  'sequence-factory-redeploy': { cls: 'MEDIUM', words: 'DeployFailed(' }
});

test('every clear-valid case in the corpus has a result: nothing was skipped', () => {
  const missing = clearValid.filter((c) => !byId.has(c.id)).map((c) => c.id);
  assert.deepEqual(missing, []);
  const restated = Object.keys(RESTATED).map((n) => `clear-valid.${n}`).sort();
  assert.deepEqual(clearValid.filter((c) => c.controlOf === undefined).map((c) => c.id).sort(), restated, 'a new case is restated here');
});

for (const [name, want] of Object.entries(RESTATED)) {
  test(`${name}: every gate passes, it reaches the jury, and its test fails with the finding's own failure`, () => {
    const r = byId.get(`clear-valid.${name}`);
    assert.ok(r, 'no result');
    assert.deepEqual(r.disagreements, []);
    assert.equal(r.expected.class, want.cls, 'the program\'s class');
    assert.equal(r.actual, 'jury');
    const o = r.observed;
    assert.deepEqual(Object.values(o.gates), Array(6).fill('pass'), JSON.stringify(o.gates));
    assert.equal(o.settlement.kind, 'jury');
    assert.equal(o.tests.length, 1);
    assert.deepEqual(o.tests[0].runs, ['fail', 'fail', 'fail']);
    assert.equal(o.tests[0].kind, 'assertion');
    assert.ok(o.tests[0].message.includes(want.words), o.tests[0].message);
    assert.deepEqual(o.integrityFailed, []);
    assert.deepEqual(o.tamperFlags, []);
  });

  test(`${name}: with the assertion turned around, it passes, so the case fails for the reason it states`, () => {
    const r = byId.get(`clear-valid.${name}.control`);
    assert.ok(r, 'no result');
    assert.deepEqual(r.disagreements, []);
    const o = r.observed;
    assert.deepEqual(o.tests[0].runs, ['pass', 'pass', 'pass']);
    assert.equal(o.gates.reproduces, 'fail');
    assert.equal(o.settlement.kind, 'invalid');
    assert.equal(o.settlement.check, 'POC_DID_NOT_REPRODUCE');
    assert.equal(o.tests[0].id, byId.get(`clear-valid.${name}`).observed.tests[0].id, 'the same test');
  });
}
