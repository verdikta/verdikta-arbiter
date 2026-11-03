'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadScenarios, adapterCid, DEFAULT_SCENARIOS } = require('../scenario-loader');
const { requestArgs } = require('../l4/helpers');

let dir;
let warn;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-scenarios-'));
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write a scenarios file and return its path. */
function scenariosFile(scenarios) {
  const file = path.join(dir, 'scenarios.json');
  fs.writeFileSync(file, JSON.stringify(scenarios));
  return file;
}

const single = { id: 'single', cid: 'QmSingle', modes: ['0'] };
const multi = { id: 'multi', cids: ['QmPackage', 'QmArchive'], addendum: '', modes: ['commit-reveal'] };
const paid = { id: 'paid', cids: ['QmPaidPackage', 'QmPaidArchive'], manualOnly: true, modes: ['commit-reveal'] };

describe('adapterCid', () => {
  it('joins CIDs with commas and appends a non-empty addendum after a colon', () => {
    expect(adapterCid(['QmA'], '')).toBe('QmA');
    expect(adapterCid(['QmA', 'QmB'], '')).toBe('QmA,QmB');
    expect(adapterCid(['QmA', 'QmB'], 'price=42')).toBe('QmA,QmB:price=42');
  });
});

describe('loadScenarios — cids and addendum', () => {
  it('keeps a multi-CID scenario\'s array and gives L2 the comma-joined form', () => {
    const [s] = loadScenarios(scenariosFile([multi]));
    expect(s.cids).toEqual(['QmPackage', 'QmArchive']);
    expect(s.addendum).toBe('');
    expect(s.cid).toBe('QmPackage,QmArchive');
  });

  it('normalizes a single cid to a one-element array with an empty addendum', () => {
    const [s] = loadScenarios(scenariosFile([single]));
    expect(s.cids).toEqual(['QmSingle']);
    expect(s.addendum).toBe('');
    expect(s.cid).toBe('QmSingle');
  });

  it('resolves a cidFile to a one-element array', () => {
    fs.writeFileSync(path.join(dir, 'archive.cid'), 'QmFromFile\n');
    const [s] = loadScenarios(scenariosFile([{ id: 'pinned', cidFile: path.join(dir, 'archive.cid') }]));
    expect(s.cids).toEqual(['QmFromFile']);
    expect(s.cid).toBe('QmFromFile');
  });

  it('carries the addendum separately and in the adapter form', () => {
    const [s] = loadScenarios(scenariosFile([{ ...multi, addendum: 'price=42' }]));
    expect(s.cids).toEqual(['QmPackage', 'QmArchive']);
    expect(s.addendum).toBe('price=42');
    expect(s.cid).toBe('QmPackage,QmArchive:price=42');

    const [one] = loadScenarios(scenariosFile([{ ...single, addendum: 'note' }]));
    expect(one.cids).toEqual(['QmSingle']);
    expect(one.cid).toBe('QmSingle:note');
  });

  it('rejects malformed cids, addendum and manualOnly values', () => {
    const bad = (s) => () => loadScenarios(scenariosFile([s]));
    expect(bad({ id: 'x', cids: [] })).toThrow(/"cids" must be a non-empty array/);
    expect(bad({ id: 'x', cids: 'QmA,QmB' })).toThrow(/"cids" must be a non-empty array/);
    expect(bad({ id: 'x', cids: ['QmA', ''] })).toThrow(/"cids" must be a non-empty array/);
    expect(bad({ id: 'x', cids: ['QmA', 7] })).toThrow(/"cids" must be a non-empty array/);
    expect(bad({ id: 'x', cid: 'QmA', cids: ['QmB'] })).toThrow(/gives cid and cids; use exactly one/);
    expect(bad({ id: 'x', cid: 'QmA', addendum: 42 })).toThrow(/"addendum" must be a string/);
    expect(bad({ id: 'x', cid: 'QmA', manualOnly: 'true' })).toThrow(/"manualOnly" must be true or false/);
    expect(bad({ id: 'x' })).toThrow(/missing "cid", "cids" or "cidFile"/);
  });
});

describe('loadScenarios — manualOnly', () => {
  it('skips manualOnly scenarios in a full-suite run, for L4 as well as L2', () => {
    const file = scenariosFile([single, multi, paid]);
    expect(loadScenarios(file).map((s) => s.id)).toEqual(['single', 'multi']);
    expect(loadScenarios(file, null, { allowManualOnly: true }).map((s) => s.id)).toEqual(['single', 'multi']);
    expect(loadScenarios(file, [], { allowManualOnly: true }).map((s) => s.id)).toEqual(['single', 'multi']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping "paid": manualOnly'));
  });

  it('runs a manualOnly scenario when L4 names it', () => {
    const file = scenariosFile([single, multi, paid]);
    const scenarios = loadScenarios(file, ['paid'], { allowManualOnly: true });
    expect(scenarios.map((s) => s.id)).toEqual(['paid']);
    expect(scenarios[0].cids).toEqual(['QmPaidPackage', 'QmPaidArchive']);
    expect(loadScenarios(file, ['single', 'paid'], { allowManualOnly: true }).map((s) => s.id)).toEqual(['single', 'paid']);
  });

  it('refuses a named manualOnly scenario when the caller does not allow it (L2)', () => {
    const file = scenariosFile([single, paid]);
    expect(() => loadScenarios(file, ['paid'])).toThrow(/"paid" are manualOnly: run them with L4/);
    expect(() => loadScenarios(file, ['single', 'paid'])).toThrow(/manualOnly/);
    expect(loadScenarios(file, ['single']).map((s) => s.id)).toEqual(['single']);
  });

  it('fails a full-suite run in which every scenario is manualOnly', () => {
    expect(() => loadScenarios(scenariosFile([paid]))).toThrow(/No runnable scenarios/);
  });

  it('treats manualOnly: false like an ordinary scenario', () => {
    expect(loadScenarios(scenariosFile([{ ...single, manualOnly: false }])).map((s) => s.id)).toEqual(['single']);
  });
});

describe('committed scenarios.json', () => {
  const BOUNTY_171 = ['QmR8nMcL3UgKQZ93YTjXyaTSPdwHhf36LVgce635bA5Eb9', 'QmfGZLLN7YVwT6b9RKjxVPinb1c1zozu6w8xuxeTwFxX1B'];

  it('keeps the paid bounty-171 replay out of the nightly and L2 full-suite runs', () => {
    expect(loadScenarios(DEFAULT_SCENARIOS, null, { allowManualOnly: true }).map((s) => s.id))
      .not.toContain('bounty-171-replay');
    expect(loadScenarios(DEFAULT_SCENARIOS).map((s) => s.id)).not.toContain('bounty-171-replay');
  });

  it('sends bounty 171\'s [evaluation package, hunter archive] with an empty addendum when named on L4', () => {
    const [s] = loadScenarios(DEFAULT_SCENARIOS, ['bounty-171-replay'], { allowManualOnly: true });
    const fees = { alpha: 500, maxOracleFee: '150000000000000', estimatedBaseCost: '8000000000', maxFeeScaling: 5 };
    expect(requestArgs(s, fees, 5555)).toEqual([BOUNTY_171, '', 500, '150000000000000', '8000000000', 5, 5555]);
    expect(s.cid).toBe(BOUNTY_171.join(','));
  });
});

describe('claim scenarios are their own suite (node A6a)', () => {
  const claim = { id: 'claim-x', suite: 'claim', claim: 'valid', modes: ['0'] };
  const plain = { id: 'plain', cid: 'QmPlain', modes: ['0'] };

  it('a full run leaves them out: they need Docker, the plain job needs Pinata', () => {
    const file = scenariosFile([plain, claim]);
    expect(loadScenarios(file).map((s) => s.id)).toEqual(['plain']);
  });

  it('--suite claim runs them and nothing else', () => {
    const file = scenariosFile([plain, claim]);
    const got = loadScenarios(file, null, { suite: 'claim' });
    expect(got.map((s) => s.id)).toEqual(['claim-x']);
    expect(got[0]).toMatchObject({ suite: 'claim', claim: 'valid', cids: [], cid: '' });
  });

  it('naming one runs it on L2, beside plain scenarios', () => {
    const file = scenariosFile([plain, claim]);
    expect(loadScenarios(file, ['claim-x', 'plain'], { allowClaim: true }).map((s) => s.id)).toEqual(['plain', 'claim-x']);
  });

  it('L4 never runs one: not in its nightly, and naming one is an error', () => {
    const file = scenariosFile([plain, claim]);
    expect(loadScenarios(file, null, { allowManualOnly: true }).map((s) => s.id)).toEqual(['plain']);
    expect(() => loadScenarios(file, ['claim-x'], { allowManualOnly: true })).toThrow(/claim-x.*L2/);
  });

  it('a suite with no scenarios is an error, not an empty pass', () => {
    const file = scenariosFile([plain]);
    expect(() => loadScenarios(file, null, { suite: 'claim' })).toThrow(/claim/);
    expect(() => loadScenarios(scenariosFile([plain, claim]), null, { suite: 'nope' })).toThrow(/nope/);
  });

  it('a claim scenario names no CID and a known kind', () => {
    expect(() => loadScenarios(scenariosFile([{ ...claim, cid: 'QmNo' }]))).toThrow(/claim-x/);
    expect(() => loadScenarios(scenariosFile([{ ...claim, claim: 'nonsense' }]))).toThrow(/claim-x/);
    expect(() => loadScenarios(scenariosFile([{ id: 'y', suite: 'claim', modes: ['0'] }]))).toThrow(/"y"/);
  });

  it('the committed scenarios carry the three the build plan names', () => {
    const got = loadScenarios(DEFAULT_SCENARIOS, null, { suite: 'claim' });
    expect(got.map((s) => s.id)).toEqual(['claim-valid', 'claim-gate-fail', 'claim-text-unaffected']);
    expect(got[0].modes).toEqual(['0', 'commit-reveal', 'juror-deadline']);
    expect(got[1].modes).toEqual(['front-gate', 'runner-gate', 'commit-reveal']);
    expect(loadScenarios(DEFAULT_SCENARIOS).map((s) => s.id)).not.toContain('claim-valid');
  });
});
