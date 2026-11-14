'use strict';

// A7c, acceptance 3 and the review focus: each batch-2 case on what the real runner observed on the class platform, restated here
// apart from the case files, so that editing a case's expected result to match a wrong run fails these. The label is the source
// program's, or the listing's own text where the case says so; a valid case's class is the one under immunefi-v2.3 (`cls`, A7e),
// with the program's beside it (`program`), which source.program keeps. The words are what the test prints.
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
const batch = cases.filter((c) => c.subsets.includes('batch-2'));

const RESTATED = Object.freeze({
  'basin-third-token-swap': { kind: 'clear-invalid.excluded-precondition', outcome: 'INVALID', basis: 'program', words: 'what the swap takes in for the third token: 0 <= 0' },
  'basin-rate-across-decimals': { kind: 'clear-invalid.intended-behaviour', outcome: 'INVALID', basis: 'program', words: 'the rate between the two tokens: 452252694 != 1000000' },
  'basin-supply-without-convergence': { kind: 'severity-boundary', outcome: 'VALID', program: 'LOW', cls: 'LOW', basis: 'program', words: 'moves on one more step: 341995 > 1' },
  'basin-upgrade-and-call': { kind: 'duplicate.entry-point', outcome: 'DUPLICATE', basis: 'program', words: 'the proxy still points where the owner set it' },
  'basin-upgrade-token-order': { kind: 'duplicate.victim', outcome: 'DUPLICATE', basis: 'program', words: 'the first reserve still belongs to the first token' },
  'kleidi-partial-whitelist': { kind: 'clear-invalid.intended-behaviour', outcome: 'INVALID', basis: 'program', words: 'an amount the owners never whitelisted is refused' },
  'kleidi-shorter-expiry': { kind: 'duplicate.rephrased', outcome: 'DUPLICATE', basis: 'program', words: 'Timelock: operation is not ready' },
  'kleidi-pause-gas': { kind: 'severity-boundary', outcome: 'VALID', program: 'MEDIUM', cls: 'MEDIUM', basis: 'program', words: '>= 30000000' },
  'kleidi-neighbouring-checks': { kind: 'severity-boundary', outcome: 'VALID', program: 'MEDIUM', cls: 'LOW', basis: 'program', words: 'CalldataList: Partial check overlap' },
  'kleidi-spell-before-answer': { kind: 'known-issue.before', outcome: 'DUPLICATE', basis: 'program', words: 'the spell waits for the answer from the owners' },
  'mellow-cancel-listed-before': { kind: 'known-issue.before', outcome: 'DUPLICATE', basis: 'listing', words: 'IndexOutOfBounds()' },
  'mellow-cancel-listed-after': { kind: 'known-issue.after', outcome: 'VALID', program: 'MEDIUM', cls: 'HIGH', basis: 'program', words: 'IndexOutOfBounds()' },
  'mellow-fee-on-falling-price': { kind: 'clear-invalid.intended-behaviour', outcome: 'INVALID', basis: 'program', words: '10000000000000000000 != 0' },
  'mellow-stale-report': { kind: 'clear-invalid.excluded-precondition', outcome: 'INVALID', basis: 'program', words: 'a price checked against a report a year old is not valid' },
  'sequence-plain-transfer': { kind: 'known-issue.before', outcome: 'DUPLICATE', basis: 'listing', words: '0 != 1' },
  'sequence-simulator-open-call': { kind: 'clear-invalid.outside-scope', outcome: 'INVALID', basis: 'listing', words: '0 != 1000000000000000000' }
});

test('every batch-2 case has a result: nothing was skipped', () => {
  assert.deepEqual(batch.filter((c) => !byId.has(c.id)).map((c) => c.id), []);
  assert.deepEqual(batch.filter((c) => c.controlOf === undefined).map((c) => c.id).sort(), Object.keys(RESTATED).map((n) => `batch-2.${n}`).sort(), 'a new case is restated here');
});

for (const [name, want] of Object.entries(RESTATED)) {
  test(`${name}: every gate passes, it reaches the jury, and its test fails with the claim's own failure`, () => {
    const entry = batch.find((c) => c.id === `batch-2.${name}`);
    assert.ok(entry, 'no such case');
    assert.equal(entry.label.kind, want.kind);
    assert.equal(entry.label.basis, want.basis);
    const r = byId.get(`batch-2.${name}`);
    assert.ok(r, 'no result');
    assert.deepEqual(r.disagreements, []);
    assert.equal(r.expected.outcome, want.outcome);
    assert.equal(r.expected.class, want.cls || null);
    assert.equal(entry.expected.class, want.cls || null, 'the class under immunefi-v2.3, in expected');
    if (want.outcome === 'VALID') assert.equal(entry.source.program.class, want.program, 'the program\'s class, in source.program');
    assert.equal(r.actual, 'jury', 'the gates decide none of these');
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
    const r = byId.get(`batch-2.${name}.control`);
    assert.ok(r, 'no result');
    assert.deepEqual(r.disagreements, []);
    const o = r.observed;
    assert.deepEqual(o.tests[0].runs, ['pass', 'pass', 'pass']);
    assert.equal(o.gates.reproduces, 'fail');
    assert.equal(o.settlement.kind, 'invalid');
    assert.equal(o.settlement.check, 'POC_DID_NOT_REPRODUCE');
    assert.equal(o.tests[0].id, byId.get(`batch-2.${name}`).observed.tests[0].id, 'the same test');
  });
}

test('the twins: one claim on two lists, the same run on both, and only the known issues between them', () => {
  const twins = batch.filter((c) => c.label && c.label.kind === 'known-issue.after');
  assert.ok(twins.length > 0);
  for (const after of twins) {
    const a = byId.get(after.id);
    const b = byId.get(after.label.knownIssue.twin);
    assert.ok(a && b, `results for ${after.id} and its twin`);
    assert.deepEqual(a.observed.gates, b.observed.gates);
    assert.deepEqual(a.observed.tests, b.observed.tests);
    assert.deepEqual(a.observed.settlement, b.observed.settlement);
    assert.deepEqual(a.observed.honestyFlags, b.observed.honestyFlags);
    assert.notEqual(a.observed.packSha256, b.observed.packSha256, 'the pack differs, by the list');
    assert.notEqual(a.expected.outcome, b.expected.outcome, 'and so does what the jury should reach');
    assert.equal(a.expected.outcome, 'VALID');
    assert.equal(b.expected.outcome, 'DUPLICATE');
  }
});
