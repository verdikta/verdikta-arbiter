'use strict';

const {
  gasLimitFor,
  resolveClassId,
  splitJustificationCids,
  arbiterVersion,
  releaseCommit,
  commitMatches,
  versionChecks,
} = require('../helpers');

describe('resolveClassId', () => {
  it('prefers the CLI value, then the environment, then the config', () => {
    expect(resolveClassId({ cli: '5555', env: '129', config: 128 })).toBe(5555);
    expect(resolveClassId({ cli: undefined, env: '129', config: 128 })).toBe(129);
    expect(resolveClassId({ cli: '', env: '', config: 128 })).toBe(128);
  });

  it('rejects values that are not non-negative integers', () => {
    expect(() => resolveClassId({ cli: 'abc' })).toThrow(/Invalid class id from --class-id/);
    expect(() => resolveClassId({ env: '-1' })).toThrow(/Invalid class id from L4_CLASS_ID/);
    expect(() => resolveClassId({ config: 1.5 })).toThrow(/Invalid class id from config.l4.classId/);
    expect(() => resolveClassId({ cli: '99999999999999999999' })).toThrow(/Invalid class id/);
  });

  it('fails loudly when nothing is configured', () => {
    expect(() => resolveClassId({})).toThrow(/No class id/);
  });
});

describe('splitJustificationCids', () => {
  it('splits the aggregator value and drops blanks', () => {
    expect(splitJustificationCids('QmA, QmB,,QmC ')).toEqual(['QmA', 'QmB', 'QmC']);
    expect(splitJustificationCids('')).toEqual([]);
    expect(splitJustificationCids(undefined)).toEqual([]);
  });
});

describe('arbiterVersion / releaseCommit / commitMatches', () => {
  it('reads the arbiter block and tolerates its absence', () => {
    expect(arbiterVersion({ arbiter: { adapter: '1.0.0', aiNode: '0.1.0', verdiktaCommon: '1.7.0', release: 'b9a58e2 2026-07-06T21:20:25Z' } }))
      .toEqual({ adapter: '1.0.0', aiNode: '0.1.0', verdiktaCommon: '1.7.0', release: 'b9a58e2 2026-07-06T21:20:25Z' });
    expect(arbiterVersion({ scores: [] })).toEqual({ adapter: null, aiNode: null, verdiktaCommon: null, release: null });
    expect(arbiterVersion(null).verdiktaCommon).toBeNull();
  });

  it('extracts the commit from a release stamp and matches short or long forms', () => {
    expect(releaseCommit('b9a58e2 2026-07-06T21:20:25Z')).toBe('b9a58e2');
    expect(releaseCommit(null)).toBeNull();
    expect(commitMatches('b9a58e2', 'B9A58E2F1234')).toBe(true);
    expect(commitMatches('b9a58e2f1234', 'b9a58e2')).toBe(true);
    expect(commitMatches('b9a58e2', 'deadbee')).toBe(false);
    expect(commitMatches(null, 'b9a58e2')).toBe(false);
  });
});

describe('versionChecks', () => {
  const reported = (cid, verdiktaCommon, release = '21bc669 2026-09-22T15:00:00Z') => ({
    cid, version: { adapter: '1.0.0', aiNode: '0.1.0', verdiktaCommon, release },
  });

  it('is informational without expectations: only an unfetchable justification fails it', () => {
    const ok = versionChecks([reported('QmA', '1.7.0'), reported('QmB', null, null)]);
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ name: 'arbiter.versions', ok: true });
    expect(ok[0].detail).toContain('QmB');
    expect(ok[0].detail).toContain('common=?');

    const bad = versionChecks([reported('QmA', '1.7.0'), { cid: 'QmB', version: null }]);
    expect(bad[0]).toMatchObject({ name: 'arbiter.versions', ok: false });
    expect(bad[0].detail).toContain('fetch failed');

    expect(versionChecks([])[0]).toMatchObject({ ok: false, detail: 'no justification CIDs' });
  });

  it('asserts the @verdikta/common version on every revealing arbiter when expected', () => {
    const pass = versionChecks([reported('QmA', '1.7.0'), reported('QmB', '1.7.0')], { expectCommon: '1.7.0' });
    expect(pass.find((c) => c.name === 'arbiter.verdiktaCommon===expected')).toMatchObject({ ok: true, detail: 'all 2 report 1.7.0' });

    const fail = versionChecks([reported('QmA', '1.7.0'), reported('QmB', '1.6.0')], { expectCommon: '1.7.0' });
    const check = fail.find((c) => c.name === 'arbiter.verdiktaCommon===expected');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('QmB');
    expect(check.detail).toContain('common=1.6.0');
  });

  it('asserts the release commit by prefix when expected, and a missing stamp fails', () => {
    const pass = versionChecks([reported('QmA', '1.7.0')], { expectRelease: '21bc669abcdef' });
    expect(pass.find((c) => c.name === 'arbiter.release===expected').ok).toBe(true);

    const fail = versionChecks([reported('QmA', '1.7.0', null)], { expectRelease: '21bc669' });
    expect(fail.find((c) => c.name === 'arbiter.release===expected').ok).toBe(false);
  });

  it('ignores blank expectations', () => {
    expect(versionChecks([reported('QmA', '1.7.0')], { expectCommon: '  ', expectRelease: '' })).toHaveLength(1);
  });
});

describe('gasLimitFor', () => {
  it('adds 30% headroom to the estimate and falls back to the configured limit without one', () => {
    expect(gasLimitFor(3073632n, 4000000)).toBe(3995721n);
    expect(gasLimitFor(1000000, 4000000)).toBe(1300000n);
    expect(gasLimitFor(null, 4000000)).toBe(4000000n);
    expect(gasLimitFor(undefined, 4000000n)).toBe(4000000n);
    expect(gasLimitFor(0n, 4000000)).toBe(4000000n);
  });
});
