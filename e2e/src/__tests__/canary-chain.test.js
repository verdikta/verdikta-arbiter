'use strict';

// The claim suite's stand-in chain, for the fault switch (issue #126). The suite's fault scenarios
// prove the adapter read the job id into the key registration wrote only if this keeper refuses
// every other key: before, it listed the classes for any key, and the bridge's id was the UUID with
// dashes, which Chainlink 2.23.0 never sends.

const axios = require('axios');
const { ethers } = require('ethers');
const { CANARY_AGGREGATOR } = require('../../../external-adapter/src/canaryFault/constants');
const { startCanaryChain, JOB_ID, REGISTERED_JOB_KEY } = require('../l2/claim/canary-chain');

const OPERATOR = '0x0000000000000000000000000000000000000001';
const keeper = new ethers.Interface(['function getOracleClassesByKey(address _oracle, bytes32 _jobId) view returns (uint64[])']);
const aggregator = new ethers.Interface(['function reputationKeeper() view returns (address)']);

let chain;
beforeEach(async () => { chain = await startCanaryChain({ operator: OPERATOR }); });
afterEach(async () => { await chain.close(); });

async function rpc(method, params) {
  const { data } = await axios.post(chain.url, { jsonrpc: '2.0', id: 1, method, params }, { proxy: false });
  return data.result;
}

async function classesOf(oracle, jobKey) {
  const [keeperAddress] = aggregator.decodeFunctionResult('reputationKeeper',
    await rpc('eth_call', [{ to: CANARY_AGGREGATOR, data: aggregator.encodeFunctionData('reputationKeeper') }, 'latest']));
  const answer = await rpc('eth_call', [{ to: keeperAddress, data: keeper.encodeFunctionData('getOracleClassesByKey', [oracle, jobKey]) }, 'latest']);
  return keeper.decodeFunctionResult('getOracleClassesByKey', answer)[0].map(Number);
}

describe('the stand-in chain\'s job: as the bridge sends it, and as it is registered', () => {
  it('the job id has Chainlink 2.23.0\'s form: 0x and 32 hex digits', () => {
    expect(JOB_ID).toMatch(/^0x[0-9a-f]{32}$/);
  });

  it('the key is the 32 digits as UTF-8, as register-oracle-cl.js writes them', () => {
    expect(REGISTERED_JOB_KEY).toBe(ethers.hexlify(ethers.toUtf8Bytes(JOB_ID.slice(2))));
    expect(REGISTERED_JOB_KEY).toBe('0x3338663139353732633531303431626161356632646561323834363134353930');
  });

  it('the keeper lists the classes for that operator and key', async () => {
    expect(await classesOf(OPERATOR, REGISTERED_JOB_KEY)).toEqual([128, 5555]);
  });

  it.each([
    ['another job\'s key', OPERATOR, ethers.hexlify(ethers.toUtf8Bytes('39515f75ac2947beb7f2eeae4d8eaf3e'))],
    ['the job id\'s 16 bytes, padded', OPERATOR, ethers.zeroPadBytes(JOB_ID, 32)],
    ['another operator', '0x0000000000000000000000000000000000000002', REGISTERED_JOB_KEY]
  ])('and nothing for %s', async (_name, oracle, jobKey) => {
    expect(await classesOf(oracle, jobKey)).toEqual([]);
  });
});
