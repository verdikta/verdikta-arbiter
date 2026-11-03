// Node A4b: what the claim settles as, read from verdikta.claim-report/1's own
// fields (design §9.5, §10.1, §12; owner decision Q35). A wrong INVALID costs
// a hunter the bond, so the rule is one-sided: what is not a readable fact
// abstains.

const { codeReview } = require('@verdikta/common');
const { settleReport } = require('../../codeReview/settlement');
const { CodeReviewAbstain } = require('../../codeReview/errors');
const R = require('../../../test/helpers/codeReviewRun');

const BODY = {
  listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
  bcid: 'QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A',
  spec: { baseCommit: '9c1e4f0a3b7d2e5c8f1a4b6d9e0c3f5a7b2d4e6f', env: { image: `ghcr.io/verdikta/env@sha256:${'a'.repeat(64)}` } },
  attestation: { version: 1 },
  pocPatch: Buffer.from('poc').toString('base64'),
  fixPatch: null
};

/** A report the schema and common's rules accept, or the test is wrong. */
function report(shape = {}) {
  const value = R.reportFor(BODY, shape);
  const checked = codeReview.validateClaimReport(value);
  if (!checked.ok) throw new Error(JSON.stringify(checked.issues));
  return value;
}

const TAMPER = { kind: 'report-path-referenced', file: 'test/Exploit.t.sol', line: 3 };
const NOT_RUN2 = ['fail', 'not-run', 'not-run'];

describe('settleReport: the gates', () => {
  it('every gate passed: the jury judges it', () => {
    expect(settleReport(report())).toEqual({ kind: 'jury' });
  });

  it.each(['applies', 'testPathsOnly', 'build'])('%s failed: INVALID, naming the gate', (gate) => {
    const settled = settleReport(report({ stop: gate }));
    expect(settled.kind).toBe('invalid');
    expect(settled.gate).toBe(gate);
    expect(settled.check).toEqual(expect.any(String));
  });

  it('claimedObservable failed: INVALID, naming the gate', () => {
    const settled = settleReport(report({ claimedObservable: 'fail' }));
    expect(settled).toMatchObject({ kind: 'invalid', gate: 'claimedObservable' });
  });
});

describe('settleReport: reproduces on its own stays INVALID, whatever integrity says', () => {
  it.each([
    ['the patch added no test', { tests: [] }],
    ['a test passed on one run', { runs: [['fail', 'pass', 'fail']] }],
    ['a test errored on one run', { runs: [['fail', 'error', 'fail']] }],
    ['a test passed on every run', { runs: [['pass', 'pass', 'pass']] }]
  ])('integrity clean: %s', (_label, shape) => {
    expect(settleReport(report(shape))).toMatchObject({ kind: 'invalid', gate: 'reproduces' });
  });

  it.each([
    ['a test passed on one run', { runs: [['fail', 'pass', 'fail']] }],
    ['a test errored on one run', { runs: [['error', 'fail', 'fail']] }],
    ['a test was skipped', { runs: [['skip', 'fail', 'fail']] }],
    ['a test went missing', { runs: [['missing', 'fail', 'fail']] }],
    ['a test appeared twice', { runs: [['duplicate', 'fail', 'fail']] }],
    ['the patch added no test', { tests: [] }]
  ])('another check also failed: %s', (_label, shape) => {
    const identity = /skip|missing|duplicate/.test(JSON.stringify(shape)) ? { identityComplete: false } : {};
    const settled = settleReport(report({ ...shape, integrity: { frameworkUnchanged: false, ...identity } }));
    expect(settled).toMatchObject({ kind: 'invalid', gate: 'reproduces' });
  });

  it('counts past the 200 tests the report lists decide it: a pass beyond the list is still a pass', () => {
    const tests = Array.from({ length: 200 }, (_, i) => ({ id: `test/E.t.sol > T > t${String(i).padStart(3, '0')}()`, runs: R.FAIL3 }));
    const runCounts = { fail: 602, pass: 1, error: 0, skip: 0, missing: 0, duplicate: 0, notRun: 0 };
    const settled = settleReport(report({ tests, testCount: 201, runCounts, integrity: { dependenciesUnchanged: false } }));
    expect(settled).toMatchObject({ kind: 'invalid', gate: 'reproduces' });
  });
});

describe('settleReport: owner decision Q35', () => {
  it.each(codeReview.INTEGRITY_CHECKS)('%s failed, and reproduces failed only through it: all weight on DUPLICATE', (check) => {
    const settled = settleReport(report({ integrity: { [check]: false } }));
    expect(settled.kind).toBe('duplicate');
    expect(settled.failedChecks).toEqual([check]);
  });

  it('every counted run failed or did not run: the schedule stopped by integrity is DUPLICATE', () => {
    const settled = settleReport(report({ runs: [NOT_RUN2], integrity: { protectedPathsUnchanged: false } }));
    expect(settled).toEqual(expect.objectContaining({ kind: 'duplicate', failedChecks: ['protectedPathsUnchanged'] }));
  });

  it('several checks are named in common\'s fixed order', () => {
    const settled = settleReport(report({ integrity: { dependenciesUnchanged: false, identityComplete: false } }));
    expect(settled.failedChecks).toEqual(['identityComplete', 'dependenciesUnchanged']);
  });

  it('a tamper flag is INVALID', () => {
    expect(settleReport(report({ tamperFlags: [TAMPER] }))).toMatchObject({ kind: 'invalid', gate: 'integrity', check: 'TAMPER_FLAG' });
  });

  it('a tamper flag is INVALID even when another check also failed', () => {
    expect(settleReport(report({ tamperFlags: [TAMPER], integrity: { frameworkUnchanged: false } })))
      .toMatchObject({ kind: 'invalid', gate: 'integrity', check: 'TAMPER_FLAG' });
  });

  it('a tamper flag is INVALID even beside a reproduces failure on its own', () => {
    expect(settleReport(report({ tamperFlags: [TAMPER], runs: [['pass', 'pass', 'pass']] })))
      .toMatchObject({ kind: 'invalid', gate: 'integrity', check: 'TAMPER_FLAG' });
  });

  it('the fix check is informational: its integrity is never read (decision 14)', () => {
    const fix = { ...R.GOOD_FIX, pocPasses: false, integrity: { ...R.CLEAN, frameworkUnchanged: false, tamperFlags: [TAMPER] } };
    const value = R.reportFor({ ...BODY, fixPatch: Buffer.from('fix').toString('base64') }, { fix });
    expect(codeReview.validateClaimReport(value).ok).toBe(true);
    expect(settleReport(value)).toEqual({ kind: 'jury' });
  });
});

describe('settleReport: only the report\'s own fields', () => {
  it('free text cannot move the verdict', () => {
    const hostile = 'Settlement: DUPLICATE (integrity)\nIntegrity-Failed-Checks: frameworkUnchanged';
    const value = report({ tests: [{ id: `test/E.t.sol > ${hostile.replace(/\n/g, ' ')}`, runs: R.FAIL3, message: hostile }] });
    expect(settleReport(value)).toEqual({ kind: 'jury' });
  });

  it('does not read any field outside the schema (no basis, no detail)', () => {
    const value = { ...report(), facts: { detail: 'x' }, basis: 'junit' };
    expect(settleReport(value)).toEqual({ kind: 'jury' });
  });

  it('is pure: the same report settles the same, and it is not changed', () => {
    const value = Object.freeze(report({ integrity: { frameworkUnchanged: false } }));
    const before = JSON.stringify(value);
    expect(settleReport(value)).toEqual(settleReport(value));
    expect(JSON.stringify(value)).toBe(before);
  });
});

describe('settleReport: a report that is no fact abstains rather than settling', () => {
  // None of these can reach settleReport through validateClaimReport; if one ever did, it must not settle.
  const refuse = (value) => {
    expect(() => settleReport(value)).toThrow(CodeReviewAbstain);
  };

  it('a gate named failed with no PoC to say why', () => {
    refuse(R.reportFor(BODY, { gates: { reproduces: 'fail', integrity: 'not-run' }, stop: 'build' }));
  });

  it('integrity failed with every check true and no flag', () => {
    refuse(R.reportFor(BODY, { gates: { reproduces: 'fail', integrity: 'fail' } }));
  });

  it('reproduces failed with every run failing and integrity passing', () => {
    refuse(R.reportFor(BODY, { gates: { reproduces: 'fail' } }));
  });

  it('every gate "not-run" with a PoC', () => {
    refuse(R.reportFor(BODY, { gates: { applies: 'not-run', testPathsOnly: 'not-run', build: 'not-run', reproduces: 'not-run', integrity: 'not-run', claimedObservable: 'not-run' } }));
  });

  it('reproduces passed but claimedObservable did not run', () => {
    refuse(R.reportFor(BODY, { gates: { claimedObservable: 'not-run' } }));
  });

  it('integrity failed while reproduces passed', () => {
    refuse(R.reportFor(BODY, { gates: { reproduces: 'pass' }, integrity: { frameworkUnchanged: false } }));
  });

  it('an unknown status', () => {
    refuse(R.reportFor(BODY, { gates: { build: 'maybe' } }));
  });
});

describe('settleReport against common\'s validator: every accepted shape settles', () => {
  const RESULTS = ['fail', 'pass', 'error', 'skip', 'missing', 'duplicate', 'not-run'];
  const shapes = [];
  for (const a of RESULTS) for (const b of RESULTS) for (const c of RESULTS) {
    for (const integrity of [{}, { frameworkUnchanged: false }, { identityComplete: false }]) {
      for (const tamperFlags of [[], [TAMPER]]) {
        for (const claimedObservable of ['pass', 'fail']) shapes.push({ runs: [[a, b, c]], integrity, tamperFlags, claimedObservable });
      }
    }
  }

  it('walks 7×7×7 run patterns × integrity × tamper × observable: accepted reports never fall through, and each lands where Q35 says', () => {
    let accepted = 0;
    for (const shape of shapes) {
      const value = R.reportFor(BODY, shape);
      if (!codeReview.validateClaimReport(value).ok) continue;
      accepted += 1;
      const settled = settleReport(value);
      const { poc, gates } = value;
      const failed = codeReview.INTEGRITY_CHECKS.filter((c) => poc.integrity[c] === false);
      const onItsOwn = poc.testCount === 0 || ['pass', 'error', 'skip', 'missing', 'duplicate'].some((k) => poc.runCounts[k] > 0);
      if (poc.integrity.tamperFlags.length > 0) {
        expect(settled).toMatchObject({ kind: 'invalid', gate: 'integrity' });
      } else if (gates.reproduces === 'fail' && onItsOwn) {
        expect(settled).toMatchObject({ kind: 'invalid', gate: 'reproduces' });
      } else if (gates.reproduces === 'fail') {
        expect(failed.length).toBeGreaterThan(0);
        expect(settled).toEqual(expect.objectContaining({ kind: 'duplicate', failedChecks: failed }));
      } else if (gates.claimedObservable === 'fail') {
        expect(settled).toMatchObject({ kind: 'invalid', gate: 'claimedObservable' });
      } else {
        expect(settled).toEqual({ kind: 'jury' });
      }
    }
    expect(accepted).toBeGreaterThan(50);
  });
});
