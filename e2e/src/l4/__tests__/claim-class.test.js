'use strict';

// Node A6b: the code path that resolves the class. A claim scenario on class 128 would
// spend real money on real arbiters, and nothing on an arbiter stops it (the bridge does
// not tell the EA the class), so this is the only place it can be refused.

const fs = require('fs');
const path = require('path');
const {
  CANARY_CLASS_ID, CANARY_CHAIN_ID, isCanaryOnly, resolveRunClass, assertCanaryChain, assertVersionsNamed, resolveFaultSwitch, resolveClassId
} = require('../helpers');
const { loadScenarios, DEFAULT_SCENARIOS } = require('../../scenario-loader');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'config', 'e2e-config.json'), 'utf8'));
const claim = { id: 'claim-l4-valid', suite: 'l4-claim', claim: 'valid' };
const plain = { id: 'canonical-vuln', cids: ['QmA'], addendum: '' };

describe('the canary class and chain are the code\'s, not the config\'s', () => {
  it('names class 5555 on Base Sepolia, and the default stays 128 for what is not a claim', () => {
    expect(CANARY_CLASS_ID).toBe(5555);
    expect(CANARY_CHAIN_ID).toBe(84532);
    expect(CONFIG.l4.classId).toBe(128);
  });
});

describe('isCanaryOnly', () => {
  it('holds for the suite, and for a hand-written scenario carrying a machine line', () => {
    expect(isCanaryOnly(claim)).toBe(true);
    expect(isCanaryOnly({ id: 'x', cids: ['QmA', 'QmB'], addendum: 'verdikta-disclosure: 0x1 0x2 Qm 0x3 0x4' })).toBe(true);
    expect(isCanaryOnly({ id: 'x', cids: ['QmA', 'QmB'], addendum: 'x\nverdikta-dispute: Qm' })).toBe(true);
    expect(isCanaryOnly({ id: 'x', cids: ['QmA', 'QmB'], addendum: 'VERDIKTA-DISCLOSURE: 0x1' })).toBe(true);
    expect(isCanaryOnly({ id: 'x', cid: 'QmA,QmB:verdikta-disclosure: 0x1', cids: ['QmA,QmB:verdikta-disclosure: 0x1'], addendum: '' })).toBe(true);
  });

  it('does not hold for a text scenario, whatever its addendum', () => {
    expect(isCanaryOnly(plain)).toBe(false);
    expect(isCanaryOnly({ id: 'x', cids: ['QmA'], addendum: 'price=42' })).toBe(false);
    expect(isCanaryOnly({ id: 'x', cids: ['QmA'] })).toBe(false);
  });
});

describe('resolveRunClass refuses a claim scenario on anything but the canary class', () => {
  const refused = [
    ['no --class-id and a blank L4_CLASS_ID, as a dispatch leaves it', { cli: undefined, env: '' }],
    ['no class anywhere but the config', { cli: undefined, env: undefined }],
    ['--class-id 128', { cli: '128', env: undefined }],
    ['L4_CLASS_ID=128', { cli: undefined, env: '128' }],
    ['--class-id 128 over L4_CLASS_ID=5555', { cli: '128', env: '5555' }],
    ['a blank --class-id falling through to the config', { cli: '', env: '' }],
    ['a blank --class-id falling through to L4_CLASS_ID=128', { cli: '  ', env: '128' }],
    ['class 0', { cli: '0', env: undefined }],
    ['class 133, the code class itself', { cli: '133', env: undefined }],
    ['class 55550', { cli: '55550', env: undefined }]
  ];

  it.each(refused)('%s', (_name, { cli, env }) => {
    expect(() => resolveRunClass({ cli, env, config: CONFIG.l4.classId, scenarios: [claim] }))
      .toThrow(/claim-l4-valid.*5555/s);
  });

  it('names the class it resolved to and where that came from', () => {
    expect(() => resolveRunClass({ env: '', config: 128, scenarios: [claim] })).toThrow(/128.*config\.l4\.classId/s);
    expect(() => resolveRunClass({ cli: '128', env: '5555', config: 128, scenarios: [claim] })).toThrow(/128.*--class-id/s);
  });

  it('refuses the whole run when a claim scenario is beside a text one', () => {
    expect(() => resolveRunClass({ env: '', config: 128, scenarios: [plain, claim] })).toThrow(/claim-l4-valid/);
    expect(() => resolveRunClass({ cli: '128', config: 128, scenarios: [claim, plain] })).toThrow(/claim-l4-valid/);
  });

  it('refuses a hand-written scenario with a disclosure line', () => {
    const handWritten = { id: 'mine', cids: ['QmA', 'QmB'], addendum: 'verdikta-disclosure: 0x1' };
    expect(() => resolveRunClass({ env: '', config: 128, scenarios: [handWritten] })).toThrow(/mine/);
  });

  it('still refuses a value it cannot read, before anything else', () => {
    expect(() => resolveRunClass({ cli: 'abc', config: 128, scenarios: [claim] })).toThrow(/Invalid class id/);
    expect(() => resolveRunClass({ cli: '5555.0', config: 128, scenarios: [claim] })).toThrow(/Invalid class id/);
    expect(() => resolveRunClass({ cli: '0x15b3', config: 128, scenarios: [claim] })).toThrow(/Invalid class id/);
  });

  it('allows the canary class, however it was named', () => {
    expect(resolveRunClass({ cli: '5555', config: 128, scenarios: [claim] })).toBe(5555);
    expect(resolveRunClass({ env: '5555', config: 128, scenarios: [claim] })).toBe(5555);
    expect(resolveRunClass({ cli: '', env: '5555', config: 128, scenarios: [claim] })).toBe(5555);
    expect(resolveRunClass({ cli: ' 5555 ', config: 128, scenarios: [claim, plain] })).toBe(5555);
    expect(resolveRunClass({ config: 5555, scenarios: [claim] })).toBe(5555);
  });

  it('leaves everything else to resolveClassId: a text scenario keeps the default', () => {
    for (const sources of [{ config: 128 }, { env: '', config: 128 }, { cli: '128', config: 128 }, { cli: '5555', config: 128 }, { env: '777', config: 128 }]) {
      expect(resolveRunClass({ ...sources, scenarios: [plain] })).toBe(resolveClassId(sources));
    }
    expect(resolveRunClass({ config: 128, scenarios: [] })).toBe(128);
  });
});

describe('the committed scenarios, through the same path the CLI takes', () => {
  const selected = (ids) => loadScenarios(DEFAULT_SCENARIOS, ids, { allowManualOnly: true, allowL4Claim: true });

  const ALL = [
    'claim-l4-valid', 'claim-l4-front-gate', 'claim-l4-runner-gate', 'claim-l4-time-dependent', 'claim-l4-randomness-dependent', 'claim-l4-flaky',
    'claim-l4-registry-failure', 'claim-l4-near-limit-juror', 'claim-l4-provider-timeout', 'claim-l4-slow-justifier', 'claim-l4-cancellation',
    'claim-l4-cold-cache', 'claim-l4-dispute'
  ];

  it.each(ALL)('--scenario %s with no --class-id is refused', (id) => {
    expect(() => resolveRunClass({ env: '', config: CONFIG.l4.classId, scenarios: selected([id]) })).toThrow(new RegExp(`${id}.*5555`, 's'));
  });

  it('a full run has no claim scenario, so the default class stays for it', () => {
    const scenarios = selected(null);
    expect(scenarios.filter(isCanaryOnly)).toEqual([]);
    expect(resolveRunClass({ env: '', config: CONFIG.l4.classId, scenarios })).toBe(128);
  });
});

describe('assertCanaryChain', () => {
  it('holds a claim scenario to Base Sepolia, by the chain id measured', () => {
    expect(() => assertCanaryChain([claim], 84532n)).not.toThrow();
    expect(() => assertCanaryChain([claim], 8453n)).toThrow(/claim-l4-valid.*84532/s);
    expect(() => assertCanaryChain([claim], 1n)).toThrow(/84532/);
    expect(() => assertCanaryChain([plain, claim], 8453n)).toThrow(/claim-l4-valid/);
  });

  it('asks nothing of a run with no claim scenario', () => {
    expect(() => assertCanaryChain([plain], 8453n)).not.toThrow();
    expect(() => assertCanaryChain([], 1n)).not.toThrow();
  });
});

describe('assertVersionsNamed', () => {
  it('a claim scenario needs both versions: a release gate that does not say which build answers nothing', () => {
    expect(() => assertVersionsNamed([claim], { expectCommon: '1.9.0', expectRelease: 'abc1234' })).not.toThrow();
    expect(() => assertVersionsNamed([claim], {})).toThrow(/--expect-common.*--expect-release/s);
    expect(() => assertVersionsNamed([claim], { expectCommon: '1.9.0' })).toThrow(/--expect-release/);
    expect(() => assertVersionsNamed([claim], { expectRelease: 'abc1234' })).toThrow(/--expect-common/);
    expect(() => assertVersionsNamed([claim], { expectCommon: '  ', expectRelease: 'abc1234' })).toThrow(/--expect-common/);
  });

  it('asks nothing of a text scenario: the versions stay report-only there', () => {
    expect(() => assertVersionsNamed([plain], {})).not.toThrow();
  });
});

describe('resolveFaultSwitch: a run names what state the switch must be in', () => {
  const fault = { id: 'claim-l4-near-limit-juror', suite: 'l4-claim', claim: 'near-limit-juror' };

  it.each(['near-limit-juror', 'provider-timeout', 'slow-justifier', 'cancellation'])('a %s scenario refuses without armed: it says what it needs', (kind) => {
    const scenario = { id: `s-${kind}`, suite: 'l4-claim', claim: kind };
    expect(() => resolveFaultSwitch([scenario], {})).toThrow(new RegExp(`s-${kind}.*--expect-fault-switch armed`, 's'));
    expect(() => resolveFaultSwitch([scenario], { expectFaultSwitch: 'off' })).toThrow(/--expect-fault-switch armed/);
    expect(() => resolveFaultSwitch([scenario], { expectFaultSwitch: '' })).toThrow(/--expect-fault-switch armed/);
    expect(resolveFaultSwitch([scenario], { expectFaultSwitch: 'armed' })).toEqual({ ea: 'armed', aiNode: 'armed' });
  });

  it('any other claim run defaults to off', () => {
    expect(resolveFaultSwitch([claim], {})).toEqual({ ea: 'off', aiNode: 'off' });
    expect(resolveFaultSwitch([claim], { expectFaultSwitch: '  ' })).toEqual({ ea: 'off', aiNode: 'off' });
    expect(resolveFaultSwitch([claim], { expectFaultSwitch: 'off' })).toEqual({ ea: 'off', aiNode: 'off' });
  });

  it('armed beside a fault scenario covers the whole run', () => {
    expect(resolveFaultSwitch([claim, fault], { expectFaultSwitch: 'armed' })).toEqual({ ea: 'armed', aiNode: 'armed' });
  });

  it('another word is refused, not read as off', () => {
    expect(() => resolveFaultSwitch([claim], { expectFaultSwitch: 'on' })).toThrow(/--expect-fault-switch/);
    expect(() => resolveFaultSwitch([claim], { expectFaultSwitch: 'ARMED' })).toThrow(/--expect-fault-switch/);
  });

  it('asks nothing of a text scenario: the nightly never meets it', () => {
    expect(resolveFaultSwitch([plain], { expectFaultSwitch: 'nonsense' })).toBeNull();
    expect(resolveFaultSwitch([], {})).toBeNull();
  });
});
