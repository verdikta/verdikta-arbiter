#!/usr/bin/env node
'use strict';

/**
 * Audit the oracles that served aggregator request(s): which operators/jobs
 * were selected, who committed and revealed, each revealed oracle's
 * justification (scores, per-model failures), and — for arbiters running
 * version self-reporting — the software version that produced each response.
 *
 * Usage:
 *   node scripts/audit-oracles.js <aggId> [<aggId>…] [options]
 *
 * Options:
 *   --rpc <url>         RPC endpoint        (default: RPC_URL env or config l4.rpcUrl)
 *   --aggregator <addr> Aggregator address  (default: AGGREGATOR_ADDRESS env or config)
 *   --lookback <blocks> How far back to scan for events (default 20000 ≈ 11h)
 *
 * Event scans are chunked to respect public-RPC eth_getLogs limits.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const axios = require('axios');

const CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'e2e-config.json'), 'utf8')
);

const ABI = [
  'function getEvaluation(bytes32) view returns (uint256[] scores, string justificationCID, bool exists)',
  'function isFailed(bytes32) view returns (bool)',
  'event OracleSelected(bytes32 indexed aggRequestId, uint256 indexed pollIndex, address oracle, bytes32 jobId)',
  'event CommitReceived(bytes32 indexed aggRequestId, uint256 pollIndex, address operator, bytes16 commitHash)',
  'event NewOracleResponseRecorded(bytes32 requestId, uint256 pollIndex, bytes32 indexed aggRequestId, address operator)',
];

const GETLOGS_CHUNK = 1999; // public Base Sepolia RPC caps eth_getLogs at 2000 blocks

function parseArgs(argv) {
  const opts = { aggIds: [], lookback: 20000 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rpc') opts.rpc = argv[++i];
    else if (a === '--aggregator') opts.aggregator = argv[++i];
    else if (a === '--lookback') opts.lookback = parseInt(argv[++i], 10);
    else if (/^0x[0-9a-fA-F]{64}$/.test(a)) opts.aggIds.push(a);
    else throw new Error(`Unknown argument: ${a} (aggIds must be 0x + 64 hex chars)`);
  }
  if (opts.aggIds.length === 0) {
    throw new Error('Usage: node scripts/audit-oracles.js <aggId> [<aggId>…] [--rpc url] [--aggregator addr] [--lookback blocks]');
  }
  opts.rpc = opts.rpc || process.env.RPC_URL || CONFIG.l4.rpcUrl;
  opts.aggregator = opts.aggregator || process.env.AGGREGATOR_ADDRESS || CONFIG.l4.aggregatorAddress;
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * queryFilter in chunks to respect RPC block-range caps, throttled and with
 * backoff retries — public RPCs also rate-limit request frequency.
 */
async function chunkedQuery(contract, filter, fromBlock, toBlock) {
  const events = [];
  for (let start = fromBlock; start <= toBlock; start += GETLOGS_CHUNK + 1) {
    const end = Math.min(start + GETLOGS_CHUNK, toBlock);
    for (let attempt = 1; ; attempt++) {
      try {
        events.push(...await contract.queryFilter(filter, start, end));
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        await sleep(1000 * Math.pow(2, attempt - 1)); // 1s, 2s, 4s, 8s
      }
    }
    await sleep(150); // stay under public-RPC request-rate limits
  }
  return events;
}

async function fetchJson(cid) {
  for (const gw of CONFIG.ipfs.gateways) {
    try {
      const { data } = await axios.get(`${gw.replace(/\/$/, '')}/ipfs/${cid}`, { timeout: 20000 });
      return typeof data === 'string' ? JSON.parse(data) : data;
    } catch (_) { /* try next gateway */ }
  }
  return null;
}

function summarizeJustification(j) {
  if (!j) return null;
  const out = {
    scores: (j.scores || []).map((s) => `${s.outcome}:${s.score}`).join(', '),
    version: j.arbiter || null, // self-reported version block (newer arbiters only)
    modelFailures: [],
  };
  if (Array.isArray(j.model_results)) {
    out.modelFailures = j.model_results
      .filter((m) => m.status !== 'success')
      .map((m) => `${m.provider}/${m.model}: ${m.status}${m.error_message ? ` — ${String(m.error_message).slice(0, 100)}` : ''}`);
  }
  // Fallback heuristics when model_results is absent: scan the justification text.
  const text = JSON.stringify(j);
  if (out.modelFailures.length === 0) {
    if (/top_p/i.test(text)) out.modelFailures.push('(heuristic) justification mentions a top_p error');
    if (/model not found/i.test(text)) out.modelFailures.push('(heuristic) justification mentions "model not found"');
  }
  return out;
}

(async () => {
  const opts = parseArgs(process.argv);
  const provider = new ethers.JsonRpcProvider(opts.rpc);
  const agg = new ethers.Contract(opts.aggregator, ABI, provider);
  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - opts.lookback);

  console.log(`aggregator=${opts.aggregator} rpc=${opts.rpc}`);
  console.log(`scanning events in blocks ${fromBlock}..${latest} (lookback ${opts.lookback})`);

  for (const aggId of opts.aggIds) {
    console.log(`\n═══ aggId ${aggId} ═══`);
    const [scores, justCids, exists] = await agg.getEvaluation(aggId);
    const failed = await agg.isFailed(aggId);
    console.log(`status: ${exists && scores.length ? 'FULFILLED' : failed ? 'FAILED' : 'PENDING/UNKNOWN'}`);
    if (scores.length) console.log(`aggregated scores: [${scores.map(String).join(', ')}]`);

    // Sequential on purpose: parallel scans trip public-RPC rate limits.
    const selected = await chunkedQuery(agg, agg.filters.OracleSelected(aggId), fromBlock, latest);
    const commits = await chunkedQuery(agg, agg.filters.CommitReceived(aggId), fromBlock, latest);
    const reveals = await chunkedQuery(agg, agg.filters.NewOracleResponseRecorded(null, null, aggId), fromBlock, latest);

    console.log(`\nselected (${selected.length}):`);
    selected.forEach((e) => console.log(`  slot ${e.args.pollIndex}: oracle=${e.args.oracle} jobId=${e.args.jobId}`));
    console.log(`commits (${commits.length}):`);
    commits.forEach((e) => console.log(`  slot ${e.args.pollIndex}: operator=${e.args.operator}`));
    console.log(`reveals (${reveals.length}):`);
    reveals.forEach((e) => console.log(`  slot ${e.args.pollIndex}: operator=${e.args.operator}`));

    const distinctOperators = [...new Set(commits.map((e) => e.args.operator))];
    console.log(`distinct committing operators: ${distinctOperators.length} → ${distinctOperators.join(', ')}`);

    const cids = String(justCids).split(',').map((s) => s.trim()).filter(Boolean);
    console.log(`\nper-oracle justifications (${cids.length}):`);
    for (const cid of cids) {
      const summary = summarizeJustification(await fetchJson(cid));
      console.log(`  ${cid}`);
      if (!summary) {
        console.log('    (fetch failed on all gateways)');
        continue;
      }
      console.log(`    scores: [${summary.scores}]`);
      console.log(`    version: ${summary.version ? JSON.stringify(summary.version) : '(not reported — pre-versioning arbiter)'}`);
      if (summary.modelFailures.length) {
        summary.modelFailures.forEach((f) => console.log(`    model failure: ${f}`));
      } else {
        console.log('    model failures: none detected');
      }
    }
  }
})().catch((err) => {
  console.error(`audit-oracles failed: ${err.message}`);
  process.exit(1);
});
