'use strict';

/**
 * A stand-in for a Base Sepolia RPC, on loopback, for the fault switch in the claim suite: it
 * answers what the External Adapter measures a request by. A test says which class each request
 * was for. It keeps no chain, and it counts its calls. Its keeper lists classes only for the one
 * job registered here, under the key registration writes, so a request whose job id the adapter
 * reads into another key is refused, as on the chain.
 */

const http = require('http');
const { ethers } = require('ethers');
const { CANARY_AGGREGATOR, CANARY_CHAIN_ID } = require('../../../../external-adapter/src/canaryFault/constants');

const KEEPER = '0x00000000000000000000000000000000000a6c02';
const aggregator = new ethers.Interface([
  'function requestAIEvaluationWithApproval(string[] cids, string addendumText, uint256 alpha, uint256 maxOracleFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScalingFactor, uint64 requestedClass) payable returns (bytes32)',
  'function reputationKeeper() view returns (address)',
  'event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)'
]);
const keeper = new ethers.Interface(['function getOracleClassesByKey(address _oracle, bytes32 _jobId) view returns (uint64[])']);
const hash = (n) => ethers.zeroPadValue(ethers.toBeHex(n), 32);

/**
 * A job's id as the bridge sends it to the adapter: Chainlink 2.23.0 renders
 * `$(jobSpec.externalJobID)` as 0x and the UUID's 32 hex digits, not as the UUID with dashes its
 * API shows (38f19572-c510-41ba-a5f2-dea284614590 here).
 */
const JOB_ID = '0x38f19572c51041baa5f2dea284614590';
/**
 * The key that job is registered under on the keeper: arbiter-operator/scripts/register-oracle-cl.js
 * writes JOB_ID_<n>_NO_HYPHENS, the 32 digits, as UTF-8 (installer/bin/register-oracle-dispatcher.sh).
 */
const REGISTERED_JOB_KEY = ethers.hexlify(ethers.toUtf8Bytes('38f19572c51041baa5f2dea284614590'));

/**
 * @param {object} [o]
 * @param {number[]} [o.classes=[128, 5555]] - what the keeper lists for (operator, REGISTERED_JOB_KEY)
 * @param {string} [o.operator] - the adapter's OPERATOR_ADDR; unset, any oracle address
 */
async function startCanaryChain({ classes = [128, 5555], operator } = {}) {
  const requests = new Map();
  let calls = 0;
  const methods = {
    eth_chainId: () => ethers.toQuantity(CANARY_CHAIN_ID),
    eth_blockNumber: () => ethers.toQuantity(20000),
    eth_getLogs: ([filter]) => {
      const aggId = filter.topics[1];
      if (!requests.has(aggId)) return [];
      return [{ address: CANARY_AGGREGATOR, topics: filter.topics, data: '0x', blockNumber: '0x10', blockHash: hash(1), transactionHash: aggId, transactionIndex: '0x0', logIndex: '0x0', removed: false }];
    },
    eth_getTransactionByHash: ([txHash]) => ({
      hash: txHash,
      to: CANARY_AGGREGATOR,
      input: aggregator.encodeFunctionData('requestAIEvaluationWithApproval', [['QmA', 'QmB'], '', 500, 1, 1, 5, requests.get(txHash)])
    }),
    eth_call: ([call]) => {
      if (call.to.toLowerCase() === CANARY_AGGREGATOR.toLowerCase()) return aggregator.encodeFunctionResult('reputationKeeper', [KEEPER]);
      const [oracle, jobKey] = keeper.decodeFunctionData('getOracleClassesByKey', call.data);
      const registered = jobKey === REGISTERED_JOB_KEY && (!operator || oracle.toLowerCase() === operator.toLowerCase());
      return keeper.encodeFunctionResult('getOracleClassesByKey', [registered ? classes : []]);
    }
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: methods[rpc.method](rpc.params || []) }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    /** A new aggregator request id, for a request of this class. */
    request: (requestedClass) => {
      const aggId = ethers.hexlify(ethers.randomBytes(32));
      requests.set(aggId, requestedClass);
      return aggId;
    },
    calls: () => calls,
    close: () => new Promise((resolve) => {
      if (server.closeAllConnections) server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

module.exports = { startCanaryChain, JOB_ID, REGISTERED_JOB_KEY };
