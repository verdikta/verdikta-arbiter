'use strict';

/**
 * A stand-in for a Base RPC node with one aggregator on it, for L4's tests. It answers on
 * loopback, keeps no chain, and records every JSON-RPC call, so a test can say "nothing
 * was asked" and read what a transaction really carried (the raw transaction's calldata,
 * not what the code meant to send).
 *
 * Kept outside __tests__ so jest does not run it as a suite.
 */

const http = require('http');
const { ethers } = require('ethers');

const AGGREGATOR = '0x00000000000000000000000000000000000a6b01';
const BLOCK = 100;
const ZERO_BLOOM = `0x${'00'.repeat(256)}`;
const HASH = (n) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
const OPERATOR = new ethers.Interface([
  'function fulfillOracleRequestV(bytes32 requestId, uint256 payment, address callbackAddress, bytes4 callbackFunctionId, uint256 expiration, bytes data)'
]);
const CODER = ethers.AbiCoder.defaultAbiCoder();
const SALT = 'a6c0a6c0a6c0a6c0a6c0';

/**
 * @param {object} o
 * @param {string[]} o.abi - the aggregator's human-readable ABI, the runner's own
 * @param {number} [o.chainId=84532]
 * @param {(request: object) => object} o.answer - the evaluation for a decoded request:
 *   { scores: bigint[], justificationCid: string, reveals?: [{ cid, scores }] }, where reveals are
 *   what the reveal transactions carry (default: one per CID of the cluster's list); or
 *   { abstain: true, commitReceived?: number } for a round nobody settles
 * @param {boolean} [o.revertOnEstimate] - estimateGas fails, as when selection would revert
 * @returns {Promise<object>}
 */
async function startStubChain({ abi, chainId = 84532, answer, revertOnEstimate = false }) {
  const iface = new ethers.Interface(abi);
  const calls = [];
  const sent = [];
  const reads = [];
  const receipts = new Map();
  const evaluations = new Map();
  const revealLogs = [];
  const revealTxs = new Map();

  const decodeRequest = (data) => {
    const args = iface.decodeFunctionData('requestAIEvaluationWithApproval', data);
    return {
      cids: [...args[0]],
      addendum: args[1],
      alpha: args[2],
      maxOracleFee: args[3],
      estimatedBaseCost: args[4],
      maxFeeScaling: args[5],
      requestedClass: Number(args[6])
    };
  };

  const send = (raw) => {
    const tx = ethers.Transaction.from(raw);
    const request = decodeRequest(tx.data);
    const aggId = HASH(sent.length + 1);
    sent.push({ ...request, hash: tx.hash, value: tx.value, to: tx.to, aggId });
    const evaluation = answer(request);
    evaluations.set(aggId, evaluation);
    if (!evaluation.abstain) {
      const reveals = evaluation.reveals || evaluation.justificationCid.split(',').map((cid) => ({ cid, scores: evaluation.scores }));
      reveals.forEach(({ cid, scores }, slot) => {
        const requestId = HASH(9000 + slot);
        const hash = ethers.keccak256(ethers.concat([aggId, ethers.toBeHex(slot, 32)]));
        const data = CODER.encode(['bytes32', 'uint256[]', 'string'], [requestId, scores, `${cid}:${SALT}`]);
        revealTxs.set(hash, {
          hash,
          input: OPERATOR.encodeFunctionData('fulfillOracleRequestV', [requestId, 0, AGGREGATOR, '0x12345678', 0, data])
        });
        const operator = ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(0xa6c0 + slot), 20));
        const log = iface.encodeEventLog('NewOracleResponseRecorded', [requestId, slot, aggId, operator]);
        revealLogs.push({
          address: AGGREGATOR,
          topics: log.topics,
          data: log.data,
          blockNumber: ethers.toQuantity(BLOCK),
          blockHash: HASH(BLOCK),
          transactionHash: hash,
          transactionIndex: '0x0',
          logIndex: ethers.toQuantity(slot),
          removed: false
        });
      });
    }
    const event = iface.encodeEventLog('RequestAIEvaluation', [aggId, request.cids]);
    receipts.set(tx.hash, {
      transactionHash: tx.hash,
      transactionIndex: '0x0',
      blockHash: HASH(BLOCK),
      blockNumber: ethers.toQuantity(BLOCK),
      from: tx.from,
      to: tx.to,
      cumulativeGasUsed: '0x5208',
      gasUsed: '0x5208',
      effectiveGasPrice: '0x1',
      contractAddress: null,
      logs: [{
        address: AGGREGATOR,
        topics: event.topics,
        data: event.data,
        blockNumber: ethers.toQuantity(BLOCK),
        blockHash: HASH(BLOCK),
        transactionHash: tx.hash,
        transactionIndex: '0x0',
        logIndex: '0x0',
        removed: false
      }],
      logsBloom: ZERO_BLOOM,
      status: '0x1',
      type: '0x2'
    });
    return tx.hash;
  };

  const read = ({ data }) => {
    const parsed = iface.parseTransaction({ data });
    reads.push(parsed.name);
    const output = {
      maxTotalFee: () => [parsed.args[0] * 12n],
      getEvaluation: () => {
        const found = evaluations.get(parsed.args[0]);
        return found && !found.abstain ? [found.scores, found.justificationCid, true] : [[], '', false];
      },
      isFailed: () => [false],
      getAggregationStatus: () => {
        const found = evaluations.get(parsed.args[0]);
        const done = Boolean(found) && !found.abstain;
        const commits = done ? 4 : ((found && found.commitReceived) || 0);
        return [done, false, done, 6, commits, done ? 3 : 0, 3, 2, ethers.ZeroAddress, 1];
      },
      responseTimeoutSeconds: () => [300n]
    }[parsed.name];
    if (!output) throw new Error(`the stub has no answer to ${parsed.name}`);
    return iface.encodeFunctionResult(parsed.name, output());
  };

  const methods = {
    eth_chainId: () => ethers.toQuantity(chainId),
    net_version: () => String(chainId),
    eth_blockNumber: () => ethers.toQuantity(BLOCK),
    eth_getBalance: () => ethers.toQuantity(ethers.parseEther('1')),
    eth_getTransactionCount: () => ethers.toQuantity(sent.length),
    eth_gasPrice: () => '0x1',
    eth_maxPriorityFeePerGas: () => '0x1',
    eth_getBlockByNumber: () => ({
      number: ethers.toQuantity(BLOCK),
      hash: HASH(BLOCK),
      parentHash: HASH(BLOCK - 1),
      timestamp: '0x1',
      nonce: '0x0000000000000000',
      difficulty: '0x0',
      gasLimit: '0x1c9c380',
      gasUsed: '0x0',
      miner: ethers.ZeroAddress,
      extraData: '0x',
      baseFeePerGas: '0x1',
      transactions: []
    }),
    eth_estimateGas: () => {
      if (revertOnEstimate) {
        const error = new Error('execution reverted: No active oracles available');
        error.rpcCode = 3;
        throw error;
      }
      return ethers.toQuantity(3000000);
    },
    eth_call: ([tx]) => read(tx),
    eth_sendRawTransaction: ([raw]) => send(raw),
    eth_getTransactionReceipt: ([hash]) => receipts.get(hash) || null,
    eth_getTransactionByHash: ([hash]) => revealTxs.get(hash) || null,
    eth_getLogs: ([filter]) => revealLogs.filter((log) => (filter.topics || []).every((topic, i) => topic === null || topic === undefined || log.topics[i] === topic))
  };

  const handle = (rpc) => {
    calls.push(rpc.method);
    const method = methods[rpc.method];
    if (!method) return { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `the stub has no ${rpc.method}` } };
    try {
      return { jsonrpc: '2.0', id: rpc.id, result: method(rpc.params || []) };
    } catch (error) {
      return { jsonrpc: '2.0', id: rpc.id, error: { code: error.rpcCode || -32000, message: error.message } };
    }
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const reply = Array.isArray(body) ? body.map(handle) : handle(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    aggregator: AGGREGATOR,
    calls,
    sent,
    reads,
    close: () => new Promise((resolve) => {
      if (server.closeAllConnections) server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

module.exports = { startStubChain, AGGREGATOR };
