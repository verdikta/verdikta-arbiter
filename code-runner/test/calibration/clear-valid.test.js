'use strict';

// A7b, acceptance 3 and the review focus: each clear-valid case on what the real runner observed on the class platform,
// restated here apart from the case files, so that editing a case's expected result to match a wrong run fails these. Two labels
// each (A7e): `program`, the source program's class, which source.program keeps, and `cls`, the class under immunefi-v2.3 that
// expected.class holds and the bar reads. The words are what the finding's own numbers or revert make the test print.
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
  'mellow-consensus-threshold': { program: 'HIGH', cls: 'CRITICAL', words: 'one signer does not count twice' },
  'mellow-performance-fee': { program: 'HIGH', cls: 'CRITICAL', words: '900000000000000000000 != 10000000000000000000' },
  'mellow-fee-recipient-lockup': { program: 'MEDIUM', cls: 'HIGH', words: 'the lock on the recipient after a fee payment' },
  'layeredge-tier-demotion': { program: 'HIGH', cls: 'HIGH', words: '2 != 3' },
  'layeredge-tier-history-gas': { program: 'MEDIUM', cls: 'CRITICAL', words: '>= 30000000' },
  'basin-well-data-decimals': { program: 'HIGH', cls: 'LOW', words: '0 != 18' },
  'basin-swap-ratio-no-reserve': { program: 'MEDIUM', cls: 'LOW', words: '0 <= 0' },
  'basin-liquidity-ratio-underflow': { program: 'MEDIUM', cls: 'LOW', words: 'panic: arithmetic underflow or overflow (0x11)' },
  'sequence-static-signature-entry-point': { program: 'MEDIUM', cls: 'LOW', words: 'InvalidStaticSignatureWrongCaller(' },
  'sequence-sapient-image-hash': { program: 'MEDIUM', cls: 'LOW', words: '0x0000000000000000000000000000000000000000000000000000000000000001 != ' },
  'layeredge-tier-promotion': { program: 'HIGH', cls: 'LOW', words: '20000000000000000000 != 35000000000000000000' },
  'mellow-transfer-whitelist': { program: 'MEDIUM', cls: 'LOW', words: 'TransferNotAllowed(' },
  'mellow-fee-per-period': { program: 'HIGH', cls: 'CRITICAL', words: '331000000000000000000 != 100000000000000000000' },
  'basin-upgrade-access': { program: 'HIGH', cls: 'CRITICAL', words: 'the implementation stays the one the owner chose' },
  'basin-reserve-at-ratio': { program: 'MEDIUM', cls: 'LOW', words: 'Non convergence: calcLpTokenSupply' },
  'sequence-session-replay': { program: 'MEDIUM', cls: 'LOW', words: 'the signature is not good for the other wallet' },
  'sequence-factory-redeploy': { program: 'MEDIUM', cls: 'MEDIUM', words: 'DeployFailed(' }
});

test('every clear-valid case in the corpus has a result: nothing was skipped', () => {
  const missing = clearValid.filter((c) => !byId.has(c.id)).map((c) => c.id);
  assert.deepEqual(missing, []);
  const restated = Object.keys(RESTATED).map((n) => `clear-valid.${n}`).sort();
  assert.deepEqual(clearValid.filter((c) => c.controlOf === undefined).map((c) => c.id).sort(), restated, 'a new case is restated here');
});

for (const [name, want] of Object.entries(RESTATED)) {
  test(`${name}: every gate passes, it reaches the jury, and its test fails with the finding's own failure`, () => {
    const entry = clearValid.find((c) => c.id === `clear-valid.${name}`);
    assert.ok(entry, 'no such case');
    assert.equal(entry.source.program.class, want.program, 'the program\'s class, in source.program');
    assert.equal(entry.expected.class, want.cls, 'the class under immunefi-v2.3, in expected');
    const r = byId.get(`clear-valid.${name}`);
    assert.ok(r, 'no result');
    assert.deepEqual(r.disagreements, []);
    assert.equal(r.expected.class, want.cls, 'the run compared against the class under immunefi-v2.3');
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
