#!/usr/bin/env node
'use strict';

// Read-only deployment preflight. No wallet, package imports or transactions.
//
//   check-request-authorization.cjs OPERATOR CHAIN_ID
//       exit 0 only for an operator with request authorization v1 (the strict check).
//   check-request-authorization.cjs describe OPERATOR CHAIN_ID [--aggregator A]
//                                   [--job-ids id,id,...] [--allow-unregistered]
//       prints one line of JSON saying which operator this is:
//         {"mode":"v1"}                              admission is in the contract
//         {"mode":"legacy","keeper":"0x…","aggregator":"0x…"}
//                                                    a contract from before request
//                                                    authorization: the node's jobs ask this
//                                                    ReputationKeeper about each requester
//       exit 1: could not tell (RPC, wrong chain, no code). Never read as "legacy".
//       exit 2: a legacy operator with no keeper its jobs could ask; the reason is printed.
//
// RPC endpoints come from REQUEST_AUTH_RPC_URLS (";"-separated). Provider errors and
// credentialed URLs are never printed.
const VERSION_SELECTOR = '0xcc515b9a'; // requestAuthorizationVersion()
const REQUEST_SELECTOR = '0x9d9fca07'; // isAuthorizedRequest(bytes32,uint256,address,bytes4,uint256)
const KEEPER_LIST_EMPTY_SELECTOR = '0x1d2566a8'; // isReputationKeeperListEmpty()
const REPUTATION_KEEPER_SELECTOR = '0xcb09ef31'; // reputationKeeper()
const CONTRACT_APPROVED_SELECTOR = '0x070d39d9'; // isContractApproved(address)
const ORACLE_INFO_SELECTOR = '0x95e1c539'; // getOracleInfo(address,bytes32)
const word = value => BigInt(value).toString(16).padStart(64, '0');
const isAddress = value => /^0x[0-9a-f]{40}$/i.test(value || '') && !/^0x0{40}$/i.test(value);
const addressWord = address => address.slice(2).toLowerCase().padStart(64, '0');
const TRUE = `0x${word(1)}`, FALSE = `0x${word(0)}`;

class UnusableLegacyOperator extends Error {}

/* A Chainlink external job id (32 hex characters, hyphens or not) as the bytes32 the keeper
 * holds: its text, as UTF-8, padded with zeros. A full 0x…64 value is taken as it is. */
function jobIdWord(id) {
  const text = String(id).trim();
  if (/^0x[0-9a-f]{64}$/i.test(text)) return text.slice(2).toLowerCase();
  const plain = text.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(plain)) throw new Error('A job id is 32 hexadecimal characters.');
  return Buffer.from(plain, 'utf8').toString('hex').padEnd(64, '0');
}

function validate({ operator, chainId, rpcUrls }) {
  if (!isAddress(operator)) throw new Error('A valid OPERATOR_ADDR is required.');
  if (![8453, 84532].includes(Number(chainId))) throw new Error('Select Base Mainnet or Base Sepolia explicitly.');
  const urls = String(rpcUrls || '').split(';').map(url => url.trim()).filter(Boolean);
  if (!urls.length) throw new Error('An HTTP RPC endpoint is required for the authorization preflight.');
  return urls;
}

/* One endpoint. call() answers { result } or { reverted: true }; anything else throws, so a
 * provider's rate limit or outage is never taken for a contract's answer. */
function endpoint(url, fetchImpl) {
  let id = 0;
  const send = async (method, params) => {
    const requestId = ++id;
    const response = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
    });
    if (!response.ok) throw new Error('HTTP failure');
    const body = await response.json();
    if (body.jsonrpc !== '2.0' || body.id !== requestId) throw new Error('RPC failure');
    return body;
  };
  const rpc = async (method, params) => {
    const body = await send(method, params);
    if (body.error || typeof body.result !== 'string') throw new Error('RPC failure');
    return body.result;
  };
  const call = async (to, data) => {
    const body = await send('eth_call', [{ to, data, gas: '0x7a120' }, 'latest']);
    if (body.error) {
      // Code 3 is the execution-reverted code of geth, reth and their OP forks.
      const { code, message } = body.error;
      if (code === 3 || /execution reverted/i.test(String(message || ''))) return { reverted: true };
      throw new Error('RPC failure');
    }
    if (typeof body.result !== 'string') throw new Error('RPC failure');
    return { result: body.result };
  };
  return { rpc, call };
}

async function onChain(node, chainId) {
  const actualChain = await node.rpc('eth_chainId', []);
  return /^0x[0-9a-f]+$/i.test(actualChain) && BigInt(actualChain) === BigInt(chainId);
}
async function hasCode(node, address) {
  const code = await node.rpc('eth_getCode', [address, 'latest']);
  return /^0x(?:[0-9a-f]{2})+$/i.test(code) && !/^0x0*$/i.test(code);
}

/* v1: the version, and a fabricated, expired, nonexistent request denied. The second read
 * also detects a permissive fallback function masquerading as the version probe. */
async function isV1(node, operator) {
  const version = await node.call(operator, VERSION_SELECTOR);
  if (version.result !== TRUE) return { v1: false, reverted: Boolean(version.reverted) };
  const denied = await node.call(operator, REQUEST_SELECTOR + word(0).repeat(5));
  return { v1: denied.result === FALSE, reverted: false };
}

async function checkRequestAuthorization({ operator, chainId, rpcUrls, fetchImpl = fetch }) {
  const urls = validate({ operator, chainId, rpcUrls });
  for (const url of urls) {
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) continue;
      const node = endpoint(url, fetchImpl);
      if (!await onChain(node, chainId)) continue;
      if (!await hasCode(node, operator)) continue;
      if ((await isV1(node, operator)).v1) return;
    } catch {
      // Try another configured RPC. Never echo provider errors or credentialed URLs.
    }
  }
  throw new Error('Cannot verify request-authorization v1 on the selected chain. Check RPC connectivity and OPERATOR_ADDR. Legacy operators require a new deployment and job migration; see docs/development/request-authorization.md. No jobs should be replaced.');
}

/* The keeper a legacy operator's jobs ask. Nothing on a legacy operator names it (its keeper
 * list is usually empty), so it is the keeper of the aggregator the node registered with, and
 * it is believed only if that keeper approves the aggregator and holds a registration of one
 * of this node's jobs: a stale AGGREGATOR_ADDRESS would otherwise make every job refuse the
 * live dispatcher's requests. */
async function legacyKeeper(node, { operator, aggregator, jobIds, allowUnregistered }) {
  if (!isAddress(aggregator)) {
    throw new UnusableLegacyOperator('This operator contract predates request authorization, and installer/.contracts names no aggregator (AGGREGATOR_ADDRESS), so there is no ReputationKeeper its jobs could ask about a requester.');
  }
  const answer = await node.call(aggregator, REPUTATION_KEEPER_SELECTOR);
  const keeper = answer.result && /^0x0{24}[0-9a-f]{40}$/i.test(answer.result) ? `0x${answer.result.slice(26)}` : '';
  if (!isAddress(keeper) || !await hasCode(node, keeper)) {
    throw new UnusableLegacyOperator('The aggregator in installer/.contracts (AGGREGATOR_ADDRESS) names no ReputationKeeper on this chain.');
  }
  const approved = await node.call(keeper, CONTRACT_APPROVED_SELECTOR + addressWord(aggregator));
  if (approved.result !== TRUE) {
    throw new UnusableLegacyOperator('The ReputationKeeper of the aggregator in installer/.contracts does not approve that aggregator: it is not the live dispatcher.');
  }
  if (!allowUnregistered) {
    let registered = false;
    for (const id of jobIds || []) {
      const info = await node.call(keeper, ORACLE_INFO_SELECTOR + addressWord(operator) + jobIdWord(id));
      // isActive, …, stakeAmount (word 6), lockedUntil, blocked (word 8): registry.js, isRegistered.
      if (!info.result || info.result.length !== 2 + 64 * 9) throw new Error('RPC failure');
      const at = index => BigInt(`0x${info.result.slice(2 + 64 * index, 66 + 64 * index)}`);
      if (at(0) !== 0n || at(6) !== 0n || at(8) !== 0n) { registered = true; break; }
    }
    if (!registered) {
      throw new UnusableLegacyOperator('The ReputationKeeper of the aggregator in installer/.contracts holds no registration of this node\'s jobs, so it cannot be taken for the keeper whose requests this node answers. Check AGGREGATOR_ADDRESS. If the node is registered with no dispatcher at all, say so with VERDIKTA_LEGACY_UNREGISTERED=1: its jobs then ask this keeper.');
    }
  }
  return keeper;
}

async function describeOperator({ operator, chainId, rpcUrls, aggregator, jobIds = [], allowUnregistered = false, fetchImpl = fetch }) {
  const urls = validate({ operator, chainId, rpcUrls });
  let unusable = null;
  for (const url of urls) {
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) continue;
      const node = endpoint(url, fetchImpl);
      if (!await onChain(node, chainId)) continue;
      if (!await hasCode(node, operator)) continue;
      const probe = await isV1(node, operator);
      if (probe.v1) return { mode: 'v1' };
      // Legacy only on positive evidence from this endpoint: the version read reverted (the
      // function is not there) and the contract answers as an ArbiterOperator.
      if (!probe.reverted) continue;
      const listEmpty = await node.call(operator, KEEPER_LIST_EMPTY_SELECTOR);
      if (listEmpty.result !== TRUE && listEmpty.result !== FALSE) continue;
      const keeper = await legacyKeeper(node, { operator, aggregator, jobIds, allowUnregistered });
      return { mode: 'legacy', keeper, aggregator };
    } catch (error) {
      if (error instanceof UnusableLegacyOperator) unusable = unusable || error;
      // Otherwise: try another configured RPC. Never echo provider errors or credentialed URLs.
    }
  }
  if (unusable) throw unusable;
  throw new Error('Cannot tell which operator contract this is on the selected chain. Check RPC connectivity and OPERATOR_ADDR. Nothing was changed.');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === 'describe') {
    const options = { operator: args[1], chainId: args[2], rpcUrls: process.env.REQUEST_AUTH_RPC_URLS };
    for (let i = 3; i < args.length; i++) {
      if (args[i] === '--aggregator') options.aggregator = args[++i];
      else if (args[i] === '--job-ids') options.jobIds = String(args[++i] || '').split(',').map(id => id.trim()).filter(Boolean);
      else if (args[i] === '--allow-unregistered') options.allowUnregistered = true;
      else { console.error(`Unknown option ${args[i]}`); process.exit(64); }
    }
    describeOperator(options)
      .then(description => console.log(JSON.stringify(description)))
      .catch(error => { console.error(error.message); process.exitCode = error instanceof UnusableLegacyOperator ? 2 : 1; });
  } else {
    checkRequestAuthorization({ operator: args[0], chainId: args[1], rpcUrls: process.env.REQUEST_AUTH_RPC_URLS })
      .then(() => console.log('Operator request-authorization v1 verified.'))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
module.exports = { checkRequestAuthorization, describeOperator, UnusableLegacyOperator, jobIdWord, VERSION_SELECTOR, REQUEST_SELECTOR };
