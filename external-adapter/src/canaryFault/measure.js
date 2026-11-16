/**
 * @fileoverview Is this request one the switch may touch? Measured on the chain, for this
 * request (decision D9). The bridge does not tell the adapter the class, and the aggregator
 * does not keep it, so it is read from where it is: the calldata of the transaction that
 * made the request. A node may serve 5555 and 128 together, as the canaries do: a request for
 * 128 is refused here, and a request sent through a contract cannot be read, so it is too.
 *
 * Every answer is checked. Any other outcome than "yes" is a refusal code, and the claim is
 * judged normally: there is no path from a failed read to a fault.
 */

const axios = require('axios');
const { ethers } = require('ethers');
const { CANARY_CLASS_ID, CANARY_CHAIN_ID, CANARY_AGGREGATOR } = require('./constants');

const READ_TIMEOUT_MS = 5000;
/** The whole measurement: it comes out of the claim's own deadline. */
const MEASURE_BUDGET_MS = 15000;
/** About an hour on Base, under public RPCs' 2,000-block limit: a request's commit dispatch is minutes old. */
const LOOKBACK_BLOCKS = 1900;

const aggregator = new ethers.utils.Interface([
  'function requestAIEvaluationWithApproval(string[] cids, string addendumText, uint256 alpha, uint256 maxOracleFee, uint256 estimatedBaseCost, uint256 maxFeeBasedScalingFactor, uint64 requestedClass) payable returns (bytes32)',
  'function reputationKeeper() view returns (address)',
  'event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)'
]);
const keeper = new ethers.utils.Interface([
  'function getOracleClassesByKey(address _oracle, bytes32 _jobId) view returns (uint64[])'
]);
const REQUEST_TOPIC = aggregator.getEventTopic('RequestAIEvaluation');

const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** The aggregator's request id as 0x + 64 lower-case hex, or null. */
function normalAggId(aggId) {
  if (typeof aggId !== 'string') return null;
  const text = aggId.trim().toLowerCase();
  const hex = text.startsWith('0x') ? text.slice(2) : text;
  return /^[0-9a-f]{64}$/.test(hex) ? `0x${hex}` : null;
}

/**
 * A job's on-chain id from its external id: the 32 hex digits, as UTF-8, as
 * arbiter-operator/scripts/register-oracle-cl.js registers JOB_ID_<n>_NO_HYPHENS. Or null.
 *
 * The bridge sends the id as Chainlink 2.23.0 renders `$(jobSpec.externalJobID)`: 0x and the 32
 * digits. The run's inputs are stored as JSON before the pipeline runs, and that storage writes a
 * byte array, which the UUID is, as 0x-hex. The UUID with dashes and the bare 32 digits read the same.
 */
function jobIdBytes32(jobId) {
  if (typeof jobId !== 'string') return null;
  const text = jobId.trim().toLowerCase();
  const digits = text.startsWith('0x') ? text.slice(2) : text.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(digits)) return null;
  return ethers.utils.hexlify(ethers.utils.toUtf8Bytes(digits));
}

class ReadFailed extends Error {}

function rpcClient(url, signal) {
  let id = 0;
  return async (method, params = []) => {
    id += 1;
    let response;
    try {
      response = await axios.post(url, { jsonrpc: '2.0', id, method, params }, {
        signal,
        timeout: READ_TIMEOUT_MS,
        proxy: false,
        maxRedirects: 0,
        maxContentLength: 4 * 1024 * 1024,
        validateStatus: () => true
      });
    } catch (_error) {
      throw new ReadFailed(`${method} did not answer`);
    }
    const body = response.data;
    if (response.status !== 200 || !body || typeof body !== 'object' || body.error || !Object.prototype.hasOwnProperty.call(body, 'result')) {
      throw new ReadFailed(`${method} did not give a result`);
    }
    return body.result;
  };
}

function hexQuantity(value, method) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new ReadFailed(`${method} gave no quantity`);
  return Number(BigInt(value));
}

async function refusalFromChain(call, { aggId, jobBytes32, operator }) {
  const chainId = hexQuantity(await call('eth_chainId'), 'eth_chainId');
  if (chainId !== CANARY_CHAIN_ID) return `CHAIN_MEASURED ${chainId}`;

  const latest = hexQuantity(await call('eth_blockNumber'), 'eth_blockNumber');
  const logs = await call('eth_getLogs', [{
    address: CANARY_AGGREGATOR,
    topics: [REQUEST_TOPIC, aggId],
    fromBlock: ethers.utils.hexValue(Math.max(0, latest - LOOKBACK_BLOCKS)),
    toBlock: ethers.utils.hexValue(latest)
  }]);
  if (!Array.isArray(logs)) throw new ReadFailed('eth_getLogs gave no list');
  const [log] = logs;
  if (logs.length !== 1 || !log || !sameAddress(log.address, CANARY_AGGREGATOR)
    || !Array.isArray(log.topics) || log.topics[0] !== REQUEST_TOPIC || log.topics[1] !== aggId) {
    return 'REQUEST_NOT_FOUND';
  }

  const tx = await call('eth_getTransactionByHash', [log.transactionHash]);
  if (!tx || typeof tx !== 'object') return 'REQUEST_TX';
  if (!sameAddress(tx.to, CANARY_AGGREGATOR)) return 'REQUEST_NOT_DIRECT';
  let requested;
  try {
    requested = aggregator.decodeFunctionData('requestAIEvaluationWithApproval', tx.input).requestedClass.toString();
  } catch (_error) {
    return 'REQUEST_CALLDATA';
  }
  if (requested !== String(CANARY_CLASS_ID)) return `REQUEST_CLASS ${requested}`;

  let keeperAddress;
  let classes;
  try {
    const keeperAnswer = await call('eth_call', [{ to: CANARY_AGGREGATOR, data: aggregator.encodeFunctionData('reputationKeeper') }, 'latest']);
    [keeperAddress] = aggregator.decodeFunctionResult('reputationKeeper', keeperAnswer);
    const classesAnswer = await call('eth_call', [{ to: keeperAddress, data: keeper.encodeFunctionData('getOracleClassesByKey', [operator, jobBytes32]) }, 'latest']);
    [classes] = keeper.decodeFunctionResult('getOracleClassesByKey', classesAnswer);
  } catch (error) {
    if (error instanceof ReadFailed) throw error;
    throw new ReadFailed('the keeper did not give a list of classes');
  }
  if (!classes.some((value) => value.toString() === String(CANARY_CLASS_ID))) return 'IDENTITY_NOT_IN_CLASS';
  return null;
}

/**
 * @param {object} o
 * @param {string} o.rpcUrl
 * @param {string} o.operator - checksummed
 * @param {string} [o.aggId] - as the bridge gave it
 * @param {string} [o.jobId] - as the bridge gave it
 * @returns {Promise<string|null>} a refusal code, or null when this is a request for 5555 on an identity that serves it
 */
async function measureRefusal({ rpcUrl, operator, aggId, jobId }) {
  const normal = normalAggId(aggId);
  if (!normal) return 'AGG_ID_UNREADABLE';
  const jobBytes32 = jobIdBytes32(jobId);
  if (!jobBytes32) return 'JOB_ID_UNREADABLE';

  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), MEASURE_BUDGET_MS);
  try {
    return await refusalFromChain(rpcClient(rpcUrl, stop.signal), { aggId: normal, jobBytes32, operator });
  } catch (_error) {
    return 'RPC_FAILED';
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { measureRefusal, normalAggId, jobIdBytes32 };
