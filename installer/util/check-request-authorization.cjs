#!/usr/bin/env node
'use strict';

// Read-only deployment preflight. No wallet, package imports or transactions.
const VERSION_SELECTOR = '0xcc515b9a'; // requestAuthorizationVersion()
const REQUEST_SELECTOR = '0x9d9fca07'; // isAuthorizedRequest(bytes32,uint256,address,bytes4,uint256)
const word = value => BigInt(value).toString(16).padStart(64, '0');

async function checkRequestAuthorization({ operator, chainId, rpcUrls, fetchImpl = fetch }) {
  if (!/^0x[0-9a-f]{40}$/i.test(operator || '') || /^0x0{40}$/i.test(operator)) {
    throw new Error('A valid OPERATOR_ADDR is required.');
  }
  if (![8453, 84532].includes(Number(chainId))) throw new Error('Select Base Mainnet or Base Sepolia explicitly.');
  const urls = String(rpcUrls || '').split(';').map(url => url.trim()).filter(Boolean);
  if (!urls.length) throw new Error('An HTTP RPC endpoint is required for the authorization preflight.');
  for (const url of urls) {
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) continue;
      let id = 0;
      const rpc = async (method, params) => {
        const requestId = ++id;
        const response = await fetchImpl(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
          signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        });
        if (!response.ok) throw new Error('HTTP failure');
        const body = await response.json();
        if (body.jsonrpc !== '2.0' || body.id !== requestId || body.error || typeof body.result !== 'string') {
          throw new Error('RPC failure');
        }
        return body.result;
      };
      const actualChain = await rpc('eth_chainId', []);
      if (!/^0x[0-9a-f]+$/i.test(actualChain) || BigInt(actualChain) !== BigInt(chainId)) continue;
      const code = await rpc('eth_getCode', [operator, 'latest']);
      if (!/^0x(?:[0-9a-f]{2})+$/i.test(code) || /^0x0*$/i.test(code)) continue;
      const call = data => rpc('eth_call', [{ to: operator, data, gas: '0x7a120' }, 'latest']);
      if (await call(VERSION_SELECTOR) !== `0x${word(1)}`) continue;
      // A fabricated, expired, nonexistent request must be denied. Also detects
      // permissive fallback functions masquerading as the version probe.
      if (await call(REQUEST_SELECTOR + word(0).repeat(5)) !== `0x${word(0)}`) continue;
      return;
    } catch {
      // Try another configured RPC. Never echo provider errors or credentialed URLs.
    }
  }
  throw new Error('Cannot verify request-authorization v1 on the selected chain. Check RPC connectivity and OPERATOR_ADDR. Legacy operators require a new deployment and job migration; see docs/development/request-authorization.md. No jobs should be replaced.');
}

if (require.main === module) {
  checkRequestAuthorization({ operator: process.argv[2], chainId: process.argv[3], rpcUrls: process.env.REQUEST_AUTH_RPC_URLS })
    .then(() => console.log('Operator request-authorization v1 verified.'))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { checkRequestAuthorization, VERSION_SELECTOR, REQUEST_SELECTOR };
