'use strict';

const { ethers } = require('ethers');
const axios = require('axios');
const chalk = require('chalk');
const A = require('../assertions');

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

/** Fetch and validate a justification CID (may be a comma-separated list). */
async function checkJustificationFetch(gateway, justificationCID, timeoutMs) {
  const first = String(justificationCID).split(',')[0].trim();
  const checks = [A.cidAssertion('justificationCid.valid', first)];
  if (!A.isLikelyCid(first)) return checks;
  const url = `${gateway.replace(/\/$/, '')}/ipfs/${first}`;
  try {
    const { data } = await axios.get(url, { timeout: timeoutMs });
    const obj = typeof data === 'string' ? JSON.parse(data) : data;
    const ok = obj && (Array.isArray(obj.scores) || typeof obj.justification === 'string');
    checks.push(A.assert('justification.fetchableJson', ok, ok ? `keys=${Object.keys(obj).join(',')}` : 'missing scores/justification'));
  } catch (err) {
    checks.push(A.assert('justification.fetchableJson', false, `fetch failed: ${err.message}`));
  }
  return checks;
}

function buildL4Config(cfg) {
  const l4 = cfg.l4 || {};
  const rpcUrl = process.env.RPC_URL || l4.rpcUrl;
  const aggregatorAddress = process.env.AGGREGATOR_ADDRESS || l4.aggregatorAddress;
  const privateKey = process.env.E2E_WALLET_PRIVATE_KEY;
  if (!rpcUrl) throw new Error('L4 requires an RPC URL (set RPC_URL or config.l4.rpcUrl).');
  if (!aggregatorAddress) throw new Error('L4 requires an aggregator address (set AGGREGATOR_ADDRESS or config.l4.aggregatorAddress).');
  if (!privateKey) throw new Error('L4 requires a funded test wallet (set E2E_WALLET_PRIVATE_KEY — use a dedicated testnet key).');
  return { ...l4, rpcUrl, aggregatorAddress, privateKey };
}

/**
 * Run the L4 (live testnet) suite.
 * @param {object} cfg - merged config (must include cfg.l4)
 * @param {Array} scenarios
 * @param {object} opts - { reporter, assertWinner }
 */
async function runL4(cfg, scenarios, opts) {
  const { reporter } = opts;
  const l4 = buildL4Config(cfg);

  const provider = new ethers.JsonRpcProvider(l4.rpcUrl);
  const wallet = new ethers.Wallet(l4.privateKey, provider);
  const aggregator = new ethers.Contract(l4.aggregatorAddress, AGGREGATOR_ABI, wallet);

  const net = await provider.getNetwork();
  const balance = await provider.getBalance(wallet.address);
  console.log(chalk.gray(`[l4] network=${l4.network} chainId=${net.chainId} aggregator=${l4.aggregatorAddress}`));
  console.log(chalk.gray(`[l4] wallet=${wallet.address} balance=${ethers.formatEther(balance)} ETH`));

  const { alpha, maxOracleFee, estimatedBaseCost, maxFeeScaling } = l4.fees;

  for (const scenario of scenarios) {
    const start = Date.now();
    try {
      const value = await aggregator.maxTotalFee(maxOracleFee);
      console.log(chalk.gray(`[l4] ${scenario.id}: submitting (value=${ethers.formatEther(value)} ETH)…`));

      const tx = await aggregator.requestAIEvaluationWithApproval(
        [scenario.cid], '', alpha, maxOracleFee, estimatedBaseCost, maxFeeScaling, l4.classId,
        { value, gasLimit: l4.gasLimit }
      );
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
          checks.push(...await checkJustificationFetch(cfg.ipfs.gateway, result.justificationCID, cfg.timeouts.ipfsFetchMs));
        }
      }
      reporter.addCase({ id: scenario.id, mode: 'l4', durationMs: Date.now() - start, checks });
    } catch (err) {
      reporter.addCase({ id: scenario.id, mode: 'l4', durationMs: Date.now() - start, error: err.message, checks: [] });
    }
  }
}

module.exports = { runL4, AGGREGATOR_ABI };
