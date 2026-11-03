/**
 * A stand-in for a Base Sepolia RPC node, on loopback, for the canary fault switch's tests.
 * It keeps no chain: a test says what each request looks like and which classes each
 * identity has. It records every call, so a test can say "nothing was asked".
 * Kept outside __tests__ so jest does not run it as a suite.
 */

const http = require('http');
const { ethers } = require('ethers');

const AGGREGATOR = '0xe8a385E473EA710c5a88Cc72681a16a26fe380e4';
const KEEPER = '0xE09821277D9af702F7910a57e85EaC6D83e4d794';
const OPERATOR = '0x00000000000000000000000000000000000A6c01';
/** A job's external id as the bridge sends it, and its id on-chain (arbiter-operator/scripts/register-oracle-cl.js). */
const JOB_ID = '38f19572-c510-41ba-a5f2-dea284614590';
const JOB_BYTES32 = ethers.utils.hexlify(ethers.utils.toUtf8Bytes('38f19572c51041baa5f2dea284614590'));
const AGG_ID = `0x${'a6'.repeat(32)}`;

const aggregator = new ethers.utils.Interface([
  'function requestAIEvaluationWithApproval(string[] cids, string addendumText, uint256 alpha, uint256 maxOracleFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScalingFactor, uint64 requestedClass) payable returns (bytes32)',
  'function reputationKeeper() view returns (address)',
  'event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)'
]);
const keeper = new ethers.utils.Interface([
  'function getOracleClassesByKey(address _oracle, bytes32 _jobId) view returns (uint64[])'
]);
const REQUEST_TOPIC = aggregator.getEventTopic('RequestAIEvaluation');

/** A request's calldata, for the class given. */
const requestInput = (requestedClass, cids = ['QmA', 'QmB']) => aggregator.encodeFunctionData('requestAIEvaluationWithApproval', [cids, '', 500, 150000000000000n, 8000000000n, 5, requestedClass]);

const hash = (n) => ethers.utils.hexZeroPad(ethers.utils.hexlify(n), 32);

/**
 * @param {object} [o]
 * @param {number} [o.chainId=84532]
 * @param {number} [o.requestedClass=5555] - the class in the request's calldata
 * @param {number[]} [o.classes=[128, 5555]] - what the keeper lists for (OPERATOR, JOB_ID)
 * @param {object} [o.scenario] - overrides: logs (the eth_getLogs answer), tx (the eth_getTransactionByHash answer), fail ({ method: 'http500'|'rpcError'|'garbage'|'hang' })
 */
async function startCanaryChain(o = {}) {
  const state = { chainId: 84532, requestedClass: 5555, classes: [128, 5555], fail: {}, ...o };
  const calls = [];
  const txHash = hash(77);

  const logOf = (aggId) => ({
    address: AGGREGATOR,
    topics: [REQUEST_TOPIC, aggId],
    data: '0x',
    blockNumber: '0x10',
    blockHash: hash(16),
    transactionHash: txHash,
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false
  });

  const methods = {
    eth_chainId: () => ethers.utils.hexValue(state.chainId),
    eth_blockNumber: () => '0x4e20',
    eth_getLogs: ([filter]) => {
      if (state.logs !== undefined) return state.logs;
      const wanted = filter.topics && filter.topics[1];
      return filter.address && filter.address.toLowerCase() === AGGREGATOR.toLowerCase() && wanted === AGG_ID ? [logOf(wanted)] : [];
    },
    eth_getTransactionByHash: ([asked]) => {
      if (state.tx !== undefined) return state.tx;
      return asked === txHash ? { hash: txHash, to: AGGREGATOR, input: requestInput(state.requestedClass) } : null;
    },
    eth_call: ([call]) => {
      const to = call.to.toLowerCase();
      if (to === AGGREGATOR.toLowerCase() && call.data === aggregator.encodeFunctionData('reputationKeeper')) {
        return state.keeperResult !== undefined ? state.keeperResult : aggregator.encodeFunctionResult('reputationKeeper', [KEEPER]);
      }
      if (to === KEEPER.toLowerCase()) {
        const [oracle, job] = keeper.decodeFunctionData('getOracleClassesByKey', call.data);
        const mine = oracle.toLowerCase() === OPERATOR.toLowerCase() && job === JOB_BYTES32;
        return keeper.encodeFunctionResult('getOracleClassesByKey', [mine ? state.classes : []]);
      }
      throw new Error('unknown call');
    }
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls.push(rpc.method);
      const failing = state.fail[rpc.method] || state.fail['*'];
      if (failing === 'hang') return;
      if (failing === 'http500') { res.writeHead(500); res.end('no'); return; }
      if (failing === 'garbage') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"not":"json-rpc"}'); return; }
      const reply = { jsonrpc: '2.0', id: rpc.id };
      try {
        if (failing === 'rpcError') throw new Error('execution reverted');
        reply.result = methods[rpc.method](rpc.params || []);
      } catch (error) {
        reply.error = { code: -32000, message: error.message };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    state,
    txHash,
    close: () => new Promise((resolve) => {
      if (server.closeAllConnections) server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

module.exports = { startCanaryChain, requestInput, AGGREGATOR, KEEPER, OPERATOR, JOB_ID, JOB_BYTES32, AGG_ID };
