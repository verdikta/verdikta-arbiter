'use strict';

/**
 * Every reveal the aggregator recorded for a request, read from the chain. getEvaluation names
 * only the clustered arbiters (P of N), the pair chosen for being closest, so hash agreement
 * and the spread of the valid mass cannot be read from it. NewOracleResponseRecorded gives each
 * reveal's transaction, and its calldata the vector and the `cid:salt` the arbiter revealed
 * (chainlink-node/basicJobSpec's encode_tx). The fourth arbiter asked to reveal, after the
 * round finished, leaves no event, so it is not here.
 */

const { ethers } = require('ethers');

const OPERATOR = new ethers.Interface([
  'function fulfillOracleRequestV(bytes32 requestId, uint256 payment, address callbackAddress, bytes4 callbackFunctionId, uint256 expiration, bytes data)'
]);
const CODER = ethers.AbiCoder.defaultAbiCoder();

/**
 * @param {import('ethers').Provider} provider
 * @param {import('ethers').Contract} aggregator
 * @param {string} aggId
 * @param {number} fromBlock - the request's block
 * @returns {Promise<{ reveals: Array<{ slot: number, operator: string, cid: string, scores: number[] }>, error: string|null }>}
 */
async function readReveals(provider, aggregator, aggId, fromBlock) {
  try {
    const event = aggregator.interface.getEvent('NewOracleResponseRecorded');
    const logs = await provider.getLogs({
      address: await aggregator.getAddress(),
      topics: [event.topicHash, aggId],
      fromBlock,
      toBlock: await provider.getBlockNumber()
    });
    const reveals = [];
    for (const log of logs) {
      const parsed = aggregator.interface.parseLog(log);
      const tx = await provider.send('eth_getTransactionByHash', [log.transactionHash]);
      if (!tx) throw new Error(`the reveal transaction ${log.transactionHash} is not there`);
      const call = OPERATOR.decodeFunctionData('fulfillOracleRequestV', tx.input);
      const [requestId, scores, cidWithSalt] = CODER.decode(['bytes32', 'uint256[]', 'string'], call.data);
      if (requestId !== parsed.args.requestId) throw new Error(`the reveal transaction ${log.transactionHash} answers another request`);
      reveals.push({
        slot: Number(parsed.args.pollIndex),
        operator: parsed.args.operator,
        cid: String(cidWithSalt).split(':')[0],
        scores: [...scores].map(Number)
      });
    }
    return { reveals, error: null };
  } catch (error) {
    return { reveals: [], error: error.shortMessage || error.message };
  }
}

module.exports = { readReveals };
