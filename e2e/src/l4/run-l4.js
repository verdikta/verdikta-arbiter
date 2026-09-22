'use strict';

const { ethers } = require('ethers');
const axios = require('axios');
const chalk = require('chalk');
const A = require('../assertions');
const {
  gasLimitFor,
  resolveClassId,
  splitJustificationCids,
  arbiterVersion,
  releaseCommit,
  versionChecks,
} = require('./helpers');

// Minimal human-readable ABI for the ETH-funded ReputationAggregator.
// Matches verdikta-dispatcher/reputationBasedAggregator/contracts/ReputationAggregator.sol
const AGGREGATOR_ABI = [
  'function requestAIEvaluationWithApproval(string[] cids, string addendumText, uint256 alpha, uint256 maxOracleFee, uint256 estimatedBaseCost, uint256 maxFeeScaling, uint64 requestedClass) payable returns (bytes32)',
  'function getEvaluation(bytes32 aggRequestId) view returns (uint256[] scores, string justificationCID, bool exists)',
  'function isFailed(bytes32 aggRequestId) view returns (bool)',
  'function maxTotalFee(uint256 requestedMaxOracleFee) view returns (uint256)',
  'event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Extract the aggRequestId from a request receipt by parsing RequestAIEvaluation. */
function parseAggId(contract, receipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === 'RequestAIEvaluation') return parsed.args.aggRequestId;
    } catch (_) { /* not from the aggregator */ }
  }
  return null;
}

/** Poll getEvaluation until the result exists, the request fails, or we time out. */
async function pollEvaluation(contract, aggId, { pollIntervalMs, timeoutMs }, onTick) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [scores, justificationCID, exists] = await contract.getEvaluation(aggId);
    if (exists && scores.length > 0) return { status: 'fulfilled', scores, justificationCID };
    if (await contract.isFailed(aggId)) return { status: 'failed', scores: [], justificationCID: '' };
    if (onTick) onTick(Math.max(0, deadline - Date.now()));
    await sleep(pollIntervalMs);
  }
  return { status: 'timeout', scores: [], justificationCID: '' };
}

/**
 * Fetch one justification JSON, trying each gateway in order (first success
 * wins — see run-l2.js for why). Returns { json: null, errors } when every
 * gateway failed or none returned a justification-shaped object.
 */
async function fetchJustificationJson(gateways, cid, timeoutMs, retry = {}) {
  // A justification is pinned seconds before the aggregator fulfils, and public
  // gateways (and even Pinata's) can take a minute or two to serve a fresh CID:
  // the first class-5555 canary run saw Pinata time out and ipfs.io/dweb.link
  // answer 403/429 on a CID that was fetchable shortly after. Sweep the
  // gateways, wait, sweep again — up to retry.attempts times.
  const attempts = Math.max(1, Number(retry.attempts) || 1);
  const delayMs = Math.max(0, Number(retry.delayMs) || 0);
  const list = Array.isArray(gateways) ? gateways : [gateways];
  let errors = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    errors = [];
    for (const gateway of list) {
      const url = `${gateway.replace(/\/$/, '')}/ipfs/${cid}`;
      try {
        const { data } = await axios.get(url, { timeout: timeoutMs });
        const obj = typeof data === 'string' ? JSON.parse(data) : data;
        if (obj && (Array.isArray(obj.scores) || typeof obj.justification === 'string')) {
          return { json: obj, gateway, errors, attempt };
        }
        errors.push(`${gateway}: missing scores/justification`);
      } catch (err) {
        errors.push(`${gateway}: ${err.message}`);
      }
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  return { json: null, gateway: null, errors, attempt: attempts };
}

/**
 * Checks on the aggregator's justificationCID (a comma-separated list, one CID
 * per revealing arbiter): the first must be a valid, fetchable justification
 * (as before), and every arbiter's self-reported version is collected — and
 * asserted when `expect.expectCommon` / `expect.expectRelease` are given.
 *
 * @returns {Promise<{ checks: Array, reports: Array<{cid, version}> }>}
 */
async function justificationChecks(cfg, justificationCID, expect) {
  const cids = splitJustificationCids(justificationCID);
  const first = cids[0] || '';
  const checks = [A.cidAssertion('justificationCid.valid', first)];
  if (!A.isLikelyCid(first)) return { checks, reports: [] };

  const reports = [];
  for (const cid of cids) {
    const { json, gateway, errors, attempt } = await fetchJustificationJson(
      cfg.ipfs.gateways, cid, cfg.timeouts.ipfsFetchMs,
      { attempts: cfg.timeouts.ipfsFetchAttempts, delayMs: cfg.timeouts.ipfsFetchRetryMs }
    );
    if (cid === first) {
      checks.push(json
        ? A.assert('justification.fetchableJson', true, `gateway=${gateway}, attempt=${attempt}, keys=${Object.keys(json).join(',')}`)
        : A.assert('justification.fetchableJson', false, `all gateways failed on ${attempt} attempt(s) — ${errors.join('; ')}`));
    }
    reports.push({ cid, version: json ? arbiterVersion(json) : null });
  }
  checks.push(...versionChecks(reports, expect));
  return { checks, reports };
}

function buildL4Config(cfg, opts = {}) {
  const l4 = cfg.l4 || {};
  // --class-id, then L4_CLASS_ID, then config; the canary gate requests class 5555.
  const classId = resolveClassId({ cli: opts.classId, env: process.env.L4_CLASS_ID, config: l4.classId });
  const rpcUrl = process.env.RPC_URL || l4.rpcUrl;
  const aggregatorAddress = process.env.AGGREGATOR_ADDRESS || l4.aggregatorAddress;
  const privateKey = process.env.E2E_WALLET_PRIVATE_KEY;
  if (!rpcUrl) throw new Error('L4 requires an RPC URL (set RPC_URL or config.l4.rpcUrl).');
  if (!aggregatorAddress) throw new Error('L4 requires an aggregator address (set AGGREGATOR_ADDRESS or config.l4.aggregatorAddress).');
  if (!privateKey) throw new Error('L4 requires a funded test wallet (set E2E_WALLET_PRIVATE_KEY — use a dedicated testnet key).');
  return { ...l4, classId, rpcUrl, aggregatorAddress, privateKey };
}

/**
 * Run the L4 (live testnet) suite.
 * @param {object} cfg - merged config (must include cfg.l4)
 * @param {Array} scenarios
 * @param {object} opts - { reporter, assertWinner, classId?, expectCommon?, expectRelease? }
 */
async function runL4(cfg, scenarios, opts) {
  const { reporter } = opts;
  const l4 = buildL4Config(cfg, opts);
  const expect = { expectCommon: opts.expectCommon, expectRelease: opts.expectRelease };

  const provider = new ethers.JsonRpcProvider(l4.rpcUrl);
  const wallet = new ethers.Wallet(l4.privateKey, provider);
  const aggregator = new ethers.Contract(l4.aggregatorAddress, AGGREGATOR_ABI, wallet);

  const net = await provider.getNetwork();
  const balance = await provider.getBalance(wallet.address);
  console.log(chalk.gray(`[l4] network=${l4.network} chainId=${net.chainId} aggregator=${l4.aggregatorAddress} classId=${l4.classId}`));
  if (expect.expectCommon || expect.expectRelease) {
    console.log(chalk.gray(`[l4] expecting every revealing arbiter to report`
      + `${expect.expectCommon ? ` @verdikta/common=${expect.expectCommon}` : ''}`
      + `${expect.expectRelease ? ` release=${expect.expectRelease}` : ''}`));
  }
  console.log(chalk.gray(`[l4] wallet=${wallet.address} balance=${ethers.formatEther(balance)} ETH`));

  const { alpha, maxOracleFee, estimatedBaseCost, maxFeeScaling } = l4.fees;

  for (const scenario of scenarios) {
    const start = Date.now();
    try {
      const value = await aggregator.maxTotalFee(maxOracleFee);
      const args = [[scenario.cid], '', alpha, maxOracleFee, estimatedBaseCost, maxFeeScaling, l4.classId];

      // Estimate rather than trust config.l4.gasLimit: selection cost grows with
      // the registry, and an out-of-gas request still pays for the whole limit.
      let estimate = null;
      try {
        estimate = await aggregator.requestAIEvaluationWithApproval.estimateGas(...args, { value });
      } catch (err) {
        console.log(chalk.yellow(`[l4] ${scenario.id}: gas estimation failed (${err.shortMessage || err.message}); using configured gasLimit=${l4.gasLimit}`));
      }
      const gasLimit = gasLimitFor(estimate, l4.gasLimit);
      console.log(chalk.gray(`[l4] ${scenario.id}: submitting (value=${ethers.formatEther(value)} ETH, gasLimit=${gasLimit}${estimate === null ? '' : `, estimate=${estimate}`})…`));

      const tx = await aggregator.requestAIEvaluationWithApproval(...args, { value, gasLimit });
      const receipt = await tx.wait(1);
      const aggId = parseAggId(aggregator, receipt);

      const checks = [];
      checks.push(A.assert('tx.mined', receipt.status === 1, `tx=${tx.hash}`));
      checks.push(A.assert('event.RequestAIEvaluation', !!aggId, aggId ? `aggId=${aggId}` : 'RequestAIEvaluation not found'));

      if (aggId) {
        console.log(chalk.gray(`[l4] ${scenario.id}: aggId=${aggId}, polling getEvaluation…`));
        const result = await pollEvaluation(aggregator, aggId, {
          pollIntervalMs: l4.pollIntervalMs, timeoutMs: l4.timeoutMs,
        }, (remainMs) => console.log(chalk.gray(`[l4]   waiting… ${Math.round(remainMs / 1000)}s left`)));

        checks.push(A.assert('evaluation.fulfilled', result.status === 'fulfilled', `status=${result.status}`));
        if (result.status === 'fulfilled') {
          checks.push(...A.structuralScoreAssertions(result.scores, {
            minOutcomes: scenario.minOutcomes || 2,
            scoreSumTarget: cfg.tolerances.scoreSumTarget,
            scoreSumSlack: cfg.tolerances.scoreSumSlack,
          }));
          if (opts.assertWinner && Number.isInteger(scenario.expectedWinnerIndex)) {
            checks.push(A.winnerAssertion(result.scores, scenario.expectedWinnerIndex));
          }
          const { checks: jChecks, reports } = await justificationChecks(cfg, result.justificationCID, expect);
          checks.push(...jChecks);
          console.log(chalk.gray(`[l4] ${scenario.id}: fulfilled in ${Math.round((Date.now() - start) / 1000)}s; ${reports.length} revealing arbiter(s)`));
          for (const r of reports) {
            const v = r.version;
            console.log(chalk.gray(`[l4]   ${r.cid}: ${v ? `common=${v.verdiktaCommon || '?'} adapter=${v.adapter || '?'} aiNode=${v.aiNode || '?'} release=${releaseCommit(v.release) || '?'}` : 'justification fetch failed'}`));
          }
        }
      }
      reporter.addCase({ id: scenario.id, mode: 'l4', durationMs: Date.now() - start, checks });
    } catch (err) {
      reporter.addCase({ id: scenario.id, mode: 'l4', durationMs: Date.now() - start, error: err.message, checks: [] });
    }
  }
}

module.exports = { runL4, AGGREGATOR_ABI, justificationChecks, fetchJustificationJson };
