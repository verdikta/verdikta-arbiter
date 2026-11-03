// Node A6c: the switch can't run unnoticed. /health and /version say its state, and every
// justification's arbiter block carries it (the only thing L4 can read from outside the host).

jest.mock('../../handlers/evaluateHandler', () => {
  const handler = jest.fn(async (body) => ({ jobRunID: body.id, statusCode: 200, status: 'success', data: {} }));
  handler.fetchCache = { stats: () => ({ entries: 0 }) };
  return handler;
});

const supertest = require('supertest');
const { createApp } = require('../../app');
const { loadCanaryFaultConfig } = require('../../canaryFault');
const { collectVersionInfo } = require('../../utils/versionInfo');

const CLAIM = `Qm${'C'.repeat(44)}`;
const KEY = 'k'.repeat(48);
const RPC = 'http://127.0.0.1:1/secret-rpc-path';
const armed = {
  VERDIKTA_CANARY_FAULTS: `${CLAIM}=near-limit-juror`,
  VERDIKTA_CANARY_FAULT_KEY: KEY,
  VERDIKTA_CANARY_RPC_URL: RPC,
  NETWORK_CHAIN_ID: '84532',
  DEPLOYMENT_NETWORK: 'base_sepolia',
  OPERATOR_ADDR: '0x00000000000000000000000000000000000a6c01'
};

afterAll(() => loadCanaryFaultConfig({}));

describe.each(['/health', '/version'])('GET %s', (route) => {
  it('off by default', async () => {
    loadCanaryFaultConfig({});
    const res = await supertest(createApp()).get(route);
    expect(res.body.canaryFault).toMatchObject({ state: 'off', namedClaims: 0, problems: [] });
  });

  it('armed says so, with no key, URL or claim in it', async () => {
    loadCanaryFaultConfig(armed);
    const res = await supertest(createApp()).get(route);
    expect(res.body.canaryFault).toMatchObject({ state: 'armed', namedClaims: 1 });
    const shown = JSON.stringify(res.body);
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain('secret-rpc-path');
    expect(JSON.stringify(res.body.canaryFault)).not.toContain(CLAIM);
  });

  it('a mainnet node with the flag set says refused', async () => {
    loadCanaryFaultConfig({ ...armed, NETWORK_CHAIN_ID: '8453', DEPLOYMENT_NETWORK: 'base_mainnet' });
    const res = await supertest(createApp()).get(route);
    expect(res.body.canaryFault.state).toBe('refused');
    expect(res.body.canaryFault.problems.length).toBeGreaterThan(0);
  });
});

describe('the arbiter block of every justification', () => {
  it.each([
    [{}, 'off'],
    [armed, 'armed'],
    [{ ...armed, NETWORK_CHAIN_ID: '8453' }, 'refused']
  ])('%#: state %s, the state alone', (env, state) => {
    loadCanaryFaultConfig(env);
    expect(collectVersionInfo().canaryFault).toEqual({ state });
  });
});
