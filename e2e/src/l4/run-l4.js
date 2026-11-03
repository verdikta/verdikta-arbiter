'use strict';

const { ethers } = require('ethers');
const chalk = require('chalk');
const A = require('../assertions');
const { fetchJustificationJson, justificationRetry } = require('../ipfs');
const { resolveL4Claim } = require('../scenario-loader');
const { codeReview } = require('@verdikta/common');
const { claimVerdictChecks, revealChecks, abstainChecks, observedRound, EXPECTED, VERDICT_BY_SOURCE } = require('./claim-checks');
const { readReveals } = require('./reveals');
const { validMassPoints, summarize, metricChecks } = require('./metrics');
const {
  gasLimitFor,
  isCanaryOnly,
  resolveRunClass,
  assertCanaryChain,
  assertVersionsNamed,
  resolveFaultSwitch,
  splitJustificationCids,
  arbiterVersion,
  releaseCommit,
  versionChecks,
  requestArgs,
} = require('./helpers');

// Minimal human-readable ABI for the ETH-funded ReputationAggregator.
// Matches verdikta-dispatcher/reputationBasedAggregator/contracts/ReputationAggregator.sol
const AGGREGATOR_ABI = [
  'function requestAIEvaluationWithApproval(string[] cids, string addendumText, uint256 alpha, uint256 maxOracleFee, uint256 estimatedBaseCost, uint256 maxFeeScaling, uint64 requestedClass) payable returns (bytes32)',
  'function getEvaluation(bytes32 aggRequestId) view returns (uint256[] scores, string justificationCID, bool exists)',
  'function isFailed(bytes32 aggRequestId) view returns (bool)',
  'function maxTotalFee(uint256 requestedMaxOracleFee) view returns (uint256)',
  'function responseTimeoutSeconds() view returns (uint256)',
  'function getAggregationStatus(bytes32 aggId) view returns (bool isComplete, bool failed, bool commitPhaseComplete, uint256 commitExpected, uint256 commitReceived, uint256 responseCount, uint256 requiredN, uint256 clusterP, address requester, uint256 startTimestamp)',
  'event RequestAIEvaluation(bytes32 indexed aggRequestId, string[] cids)',
  'event NewOracleResponseRecorded(bytes32 requestId, uint256 pollIndex, bytes32 indexed aggRequestId, address operator)',
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

/**
 * Poll getEvaluation until the result exists, the request fails, or we time out. With
 * `tolerateReadErrors` a read that fails is a poll that saw nothing: a claim's round goes on for
 * up to 15 minutes, and one refused read of a public RPC does not end it. A text scenario's throws.
 */
async function pollEvaluation(contract, aggId, { pollIntervalMs, timeoutMs, tolerateReadErrors = false }, onTick) {
  const deadline = Date.now() + timeoutMs;
  let readError = null;
  while (Date.now() < deadline) {
    try {
      const [scores, justificationCID, exists] = await contract.getEvaluation(aggId);
      if (exists && scores.length > 0) return { status: 'fulfilled', scores, justificationCID };
      if (await contract.isFailed(aggId)) return { status: 'failed', scores: [], justificationCID: '' };
      readError = null;
    } catch (err) {
      if (!tolerateReadErrors) throw err;
      readError = err.shortMessage || err.message;
      console.log(chalk.yellow(`[l4]   a read failed: ${readError}`));
    }
    if (onTick) onTick(Math.max(0, deadline - Date.now()));
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  return { status: 'timeout', scores: [], justificationCID: '', readError };
}

/**
 * Checks on the aggregator's justificationCID (a comma-separated list, one CID
 * per revealing arbiter): the first must be a valid, fetchable justification
 * (as before), and every arbiter's self-reported version is collected — and
 * asserted when `expect.expectCommon` / `expect.expectRelease` are given.
 *
 * @returns {Promise<{ checks: Array, reports: Array<{cid, version, json}> }>}
 */
async function justificationChecks(cfg, justificationCID, expect) {
  const cids = splitJustificationCids(justificationCID);
  const first = cids[0] || '';
  const checks = [A.cidAssertion('justificationCid.valid', first)];
  if (!A.isLikelyCid(first)) return { checks, reports: [] };

  const reports = [];
  for (const cid of cids) {
    const { json, gateway, errors, attempt } = await fetchJustificationJson(
      cfg.ipfs.gateways, cid, cfg.timeouts.ipfsFetchMs, justificationRetry(cfg)
    );
    if (cid === first) {
      checks.push(json
        ? A.assert('justification.fetchableJson', true, `gateway=${gateway}, attempt=${attempt}, keys=${Object.keys(json).join(',')}`)
        : A.assert('justification.fetchableJson', false, `all gateways failed on ${attempt} attempt(s) — ${errors.join('; ')}`));
    }
    reports.push({ cid, version: json ? arbiterVersion(json) : null, json });
  }
  checks.push(...versionChecks(reports, expect));
  return { checks, reports };
}

/** Settlement's stake argument: only `outcome` and `valid` are read here. */
const ANY_STAKE = Object.freeze({ awards: Object.freeze({ LOW: '0', MEDIUM: '0', HIGH: '0', CRITICAL: '0' }), lowestClassCounted: 'LOW' });

/**
 * The request's transaction, as a claim sends it: never on a failed estimate, since that means
 * selection would revert. A throw means the request did not start. Once it is broadcast this no
 * longer throws, so a round that started always leaves a measurement.
 */
async function sendClaimRequest({ aggregator, l4 }, scenario, request) {
  const value = await aggregator.maxTotalFee(l4.fees.maxOracleFee);
  const args = requestArgs(request, l4.fees, l4.classId);
  let estimate;
  try {
    estimate = await aggregator.requestAIEvaluationWithApproval.estimateGas(...args, { value });
  } catch (err) {
    throw new Error(`gas estimation failed (${err.shortMessage || err.message}): the request was not sent`);
  }
  const gasLimit = gasLimitFor(estimate, l4.gasLimit);
  console.log(chalk.gray(`[l4] ${scenario.id}: submitting ${args[0].length} CID(s) (value=${ethers.formatEther(value)} ETH, gasLimit=${gasLimit}, estimate=${estimate})…`));
  const tx = await aggregator.requestAIEvaluationWithApproval(...args, { value, gasLimit });
  try {
    const receipt = await tx.wait(1);
    const aggId = parseAggId(aggregator, receipt);
    return {
      aggId,
      block: receipt.blockNumber,
      checks: [
        A.assert('tx.mined', receipt.status === 1, `tx=${tx.hash}`),
        A.assert('event.RequestAIEvaluation', !!aggId, aggId ? `aggId=${aggId}` : 'RequestAIEvaluation not found'),
      ],
    };
  } catch (err) {
    return { aggId: null, block: null, checks: [A.assert('tx.mined', false, `tx=${tx.hash}: ${err.shortMessage || err.message}`)] };
  }
}

/**
 * One request to its verdict, judged over every recorded reveal (reveals.js): getEvaluation's
 * list is only the cluster. L4's clock runs from before the transaction to the poll that saw the
 * result, so a latency is at most one poll late and never early.
 *
 * @returns {Promise<{ checks: Array, round: object|null, vector: number[]|null }>}
 */
async function verdictRound(ctx, scenario, request, { kind, statementCid = null, timeoutMs }) {
  const { cfg, provider, aggregator, l4, expect, opts, faultSwitch } = ctx;
  const start = Date.now();
  const expected = EXPECTED[kind];
  const expectedRound = (latencyMs) => ({ id: scenario.id, kind, verdict: VERDICT_BY_SOURCE[expected.source], fault: Boolean(expected.fault), latencyMs });
  const unfinished = () => ({ ...expectedRound(Date.now() - start), unfinished: true, validMass: [] });

  const sent = await sendClaimRequest(ctx, scenario, request);
  const checks = [...sent.checks];
  if (!sent.aggId) return { checks, round: unfinished(), vector: null };

  console.log(chalk.gray(`[l4] ${scenario.id}: aggId=${sent.aggId}, polling getEvaluation…`));
  const result = await pollEvaluation(aggregator, sent.aggId, {
    pollIntervalMs: l4.pollIntervalMs, timeoutMs: timeoutMs || l4.timeoutMs, tolerateReadErrors: true,
  }, (remainMs) => console.log(chalk.gray(`[l4]   waiting… ${Math.round(remainMs / 1000)}s left`)));
  const latencyMs = Date.now() - start;
  checks.push(A.assert('evaluation.fulfilled', result.status === 'fulfilled', `status=${result.status}${result.readError ? `, last read: ${result.readError}` : ''}`));
  if (result.status !== 'fulfilled') return { checks, round: unfinished(), vector: null };

  const vector = [...result.scores].map(Number);
  try {
    checks.push(...A.structuralScoreAssertions(result.scores, {
      minOutcomes: scenario.minOutcomes || 2,
      scoreSumTarget: cfg.tolerances.scoreSumTarget,
      scoreSumSlack: cfg.tolerances.scoreSumSlack,
    }));
    const { reveals, responseCount, error } = await readReveals(provider, aggregator, sent.aggId, sent.block);
    const { checks: jChecks, reports } = await justificationChecks(cfg, reveals.map((r) => r.cid).join(','), expect);
    const combinedCids = splitJustificationCids(result.justificationCID);
    checks.push(...jChecks);
    checks.push(...revealChecks({ reveals, responseCount, error, reports, combinedCids }));
    checks.push(...claimVerdictChecks({
      kind,
      scores: [...result.scores],
      reports,
      cids: request.cids,
      assertWinner: opts.assertWinner,
      faultSwitch,
      statementCid,
    }));
    console.log(chalk.gray(`[l4] ${scenario.id}: fulfilled in ${Math.round(latencyMs / 1000)}s; ${reveals.length} recorded reveal(s), ${combinedCids.length} in the cluster`));
    for (const r of reports) {
      const v = r.version;
      console.log(chalk.gray(`[l4]   ${r.cid}: ${v ? `common=${v.verdiktaCommon || '?'} adapter=${v.adapter || '?'} aiNode=${v.aiNode || '?'} release=${releaseCommit(v.release) || '?'} faultSwitch=${v.canaryFault ? v.canaryFault.state : '?'}` : 'justification fetch failed'}`));
    }
    // What the uploads say happened, not what the scenario hoped: a wrong path fails its checks, and must not count as a sample of the right one.
    const seen = observedRound(reports);
    const complete = Number.isInteger(responseCount) && reveals.length === responseCount;
    const round = {
      ...expectedRound(latencyMs),
      verdict: seen.verdict,
      fault: Boolean(expected.fault) || seen.faultSeen,
      validMass: complete ? reveals.map((r) => validMassPoints(r.scores)) : [],
      ...(expected.cold ? { image: reports.map((r) => (r.json && r.json.metadata ? r.json.metadata.runner_image : null)) } : {}),
    };
    return { checks, round, vector };
  } catch (err) {
    checks.push(A.assert('round.observed', false, `the round finished and could not be read: ${err.message}`));
    return { checks, round: { ...expectedRound(latencyMs), verdict: 'unreadable', validMass: [] }, vector };
  }
}

/** Watch for a commit or a verdict until `watchMs` is up. A round already gone to either ends the watch: the answer is known. */
async function watchRound(aggregator, aggId, { pollIntervalMs, watchMs }) {
  const end = Date.now() + watchMs;
  let status = 'timeout';
  let commitReceived = null;
  for (;;) {
    try {
      const read = await aggregator.getAggregationStatus(aggId);
      commitReceived = Number(read.commitReceived);
      const [scores, , exists] = await aggregator.getEvaluation(aggId);
      if (exists && scores.length > 0) status = 'fulfilled';
      else if (read.failed) status = 'failed';
    } catch (err) {
      commitReceived = null;
      console.log(chalk.yellow(`[l4]   the round's status could not be read: ${err.shortMessage || err.message}`));
    }
    const left = end - Date.now();
    if (commitReceived > 0 || status !== 'timeout' || left <= 0) return { status, commitReceived };
    await sleep(Math.min(pollIntervalMs, left));
  }
}

/**
 * Nobody commits (design §12), and an abstaining arbiter uploads nothing, so canaries that are
 * down would look the same. So a control follows: an out-of-scope claim on the same listing, which
 * must settle at the EA's inScope gate. That shows the arbiters were there and take this listing.
 */
async function abstainRound(ctx, scenario) {
  const { aggregator, l4 } = ctx;
  const watchMs = scenario.watchSeconds * 1000;
  const sent = await sendClaimRequest(ctx, scenario, scenario);
  const checks = [...sent.checks];
  if (!sent.aggId) return { checks };
  console.log(chalk.gray(`[l4] ${scenario.id}: aggId=${sent.aggId}, watching ${scenario.watchSeconds}s for a commit, which must not come…`));
  const watched = await watchRound(aggregator, sent.aggId, { pollIntervalMs: l4.pollIntervalMs, watchMs });
  checks.push(...abstainChecks(watched));
  // A finalize applies the timeliness penalty to each polled oracle (§12): an owner's call, not this run's.
  console.log(chalk.gray(`[l4] ${scenario.id}: left unfinalized. Once responseTimeoutSeconds has passed, anyone can reclaim the prepay, at a cost to the polled oracles' reputations: cast send ${l4.aggregatorAddress} 'finalizeEvaluationTimeout(bytes32)' ${sent.aggId}`));
  try {
    const control = await verdictRound(ctx, scenario, scenario.control, { kind: 'front-gate', timeoutMs: watchMs });
    checks.push(...control.checks.map((check) => ({ ...check, name: `control.${check.name}` })));
  } catch (err) {
    checks.push(A.assert('control.started', false, err.message));
  }
  return { checks };
}

/**
 * A claim round, then the dispute round ClaimLogic.dispute composes: the listing's dispute archive
 * (its panel is the only difference) and the claim, the disclosure line and the statement by CID.
 * The contract is deployed after this gate, so L4 plays its part, as for reveal. A flip is the contract's Overturned: the outcome differs. Real jurors
 * decide that, so it is recorded and not asserted. Only a valid first outcome may be disputed.
 */
async function disputeRounds(ctx, scenario) {
  const first = await verdictRound(ctx, scenario, scenario, { kind: 'valid' });
  const settled = (vector) => codeReview.settleBugOutcome(vector, ANY_STAKE);
  const rounds = [first.round];
  if (!first.vector) return { checks: first.checks, metrics: { rounds } };
  const before = settled(first.vector);
  if (!before.valid) {
    console.log(chalk.yellow(`[l4] ${scenario.id}: the first round settled ${before.outcome}, not a valid outcome: the contract would refuse a dispute, so there is no second round and no sample`));
    return { checks: first.checks, metrics: { rounds, dispute: { countable: false, before: before.outcome } } };
  }
  let second;
  try {
    second = await verdictRound(ctx, scenario, scenario.disputeRound, { kind: 'dispute', statementCid: scenario.disputeRound.statementCid });
  } catch (err) {
    // The first round happened: its measurement stays.
    return { checks: [...first.checks, A.assert('dispute.started', false, err.message)], metrics: { rounds } };
  }
  const checks = [...first.checks, ...second.checks.map((check) => ({ ...check, name: `dispute.${check.name}` }))];
  rounds.push(second.round);
  if (!second.vector) return { checks, metrics: { rounds } };
  const after = settled(second.vector);
  console.log(chalk.gray(`[l4] ${scenario.id}: ${before.outcome} then ${after.outcome}: ${before.outcome === after.outcome ? 'held' : 'flipped'}`));
  return { checks, metrics: { rounds, dispute: { countable: true, before: before.outcome, after: after.outcome, flipped: before.outcome !== after.outcome } } };
}

/** One L4 claim scenario, by its kind. */
async function runClaimScenario(ctx, scenario) {
  if (scenario.control) return abstainRound(ctx, scenario);
  if (scenario.claim === 'dispute') return disputeRounds(ctx, scenario);
  const { checks, round } = await verdictRound(ctx, scenario, scenario, { kind: scenario.claim });
  return { checks, metrics: { rounds: [round] } };
}

function buildL4Config(cfg, scenarios, opts = {}) {
  const l4 = cfg.l4 || {};
  // --class-id, then L4_CLASS_ID, then config; the canary gate requests class 5555. A claim
  // scenario on anything else stops here, before the wallet is read or an RPC is called.
  const classId = resolveRunClass({ cli: opts.classId, env: process.env.L4_CLASS_ID, config: l4.classId, scenarios });
  assertVersionsNamed(scenarios, opts);
  const faultSwitch = resolveFaultSwitch(scenarios, opts);
  const rpcUrl = process.env.RPC_URL || l4.rpcUrl;
  const aggregatorAddress = process.env.AGGREGATOR_ADDRESS || l4.aggregatorAddress;
  const privateKey = process.env.E2E_WALLET_PRIVATE_KEY;
  if (!rpcUrl) throw new Error('L4 requires an RPC URL (set RPC_URL or config.l4.rpcUrl).');
  if (!aggregatorAddress) throw new Error('L4 requires an aggregator address (set AGGREGATOR_ADDRESS or config.l4.aggregatorAddress).');
  if (!privateKey) throw new Error('L4 requires a funded test wallet (set E2E_WALLET_PRIVATE_KEY — use a dedicated testnet key).');
  return { ...l4, classId, rpcUrl, aggregatorAddress, privateKey, faultSwitch };
}

/**
 * Run the L4 (live testnet) suite.
 * @param {object} cfg - merged config (must include cfg.l4)
 * @param {Array} scenarios
 * @param {object} opts - { reporter, assertWinner, classId?, expectCommon?, expectRelease? }
 */
async function runL4(cfg, selected, opts) {
  const { reporter } = opts;
  const l4 = buildL4Config(cfg, selected, opts);
  const scenarios = selected.map(resolveL4Claim);
  const expect = { expectCommon: opts.expectCommon, expectRelease: opts.expectRelease };

  const provider = new ethers.JsonRpcProvider(l4.rpcUrl);
  const wallet = new ethers.Wallet(l4.privateKey, provider);
  const aggregator = new ethers.Contract(l4.aggregatorAddress, AGGREGATOR_ABI, wallet);

  const net = await provider.getNetwork();
  assertCanaryChain(scenarios, net.chainId);
  const balance = await provider.getBalance(wallet.address);
  console.log(chalk.gray(`[l4] network=${l4.network} chainId=${net.chainId} aggregator=${l4.aggregatorAddress} classId=${l4.classId}`));
  if (expect.expectCommon || expect.expectRelease) {
    console.log(chalk.gray(`[l4] expecting every revealing arbiter to report`
      + `${expect.expectCommon ? ` @verdikta/common=${expect.expectCommon}` : ''}`
      + `${expect.expectRelease ? ` release=${expect.expectRelease}` : ''}`));
  }
  console.log(chalk.gray(`[l4] wallet=${wallet.address} balance=${ethers.formatEther(balance)} ETH`));
  if (scenarios.some(isCanaryOnly)) {
    // Measured, not gated: it only says when anyone may force-finalize a stuck request, and §11
    // wants a canary to pass before the timeout changes as well as after. G2 reads this line.
    const timeout = await aggregator.responseTimeoutSeconds().catch(() => 'unreadable');
    console.log(chalk.gray(`[l4] aggregator responseTimeoutSeconds=${timeout} (design §11: 900 once G2 has set it)`));
  }

  const { maxOracleFee } = l4.fees;
  const claimContext = { cfg, provider, aggregator, l4, expect, opts, faultSwitch: l4.faultSwitch };
  const claimRounds = [];
  const claimDisputes = [];

  for (const scenario of scenarios) {
    const start = Date.now();
    if (scenario.suite === 'l4-claim') {
      try {
        const { checks, metrics } = await runClaimScenario(claimContext, scenario);
        if (metrics) {
          claimRounds.push(...metrics.rounds);
          if (metrics.dispute) claimDisputes.push(metrics.dispute);
        }
        reporter.addCase({ id: scenario.id, mode: 'l4', durationMs: Date.now() - start, checks, ...(metrics ? { metrics } : {}) });
      } catch (err) {
        reporter.addCase({ id: scenario.id, mode: 'l4', durationMs: Date.now() - start, error: err.message, checks: [] });
      }
      continue;
    }
    try {
      const value = await aggregator.maxTotalFee(maxOracleFee);
      const args = requestArgs(scenario, l4.fees, l4.classId);

      // Estimate rather than trust config.l4.gasLimit: selection cost grows with
      // the registry, and an out-of-gas request still pays for the whole limit.
      let estimate = null;
      try {
        estimate = await aggregator.requestAIEvaluationWithApproval.estimateGas(...args, { value });
      } catch (err) {
        // A claim's request is not sent on a guess: a failed estimate here means selection
        // would revert (no job in the class at this fee), and a reverted request still pays gas.
        if (isCanaryOnly(scenario)) throw new Error(`gas estimation failed (${err.shortMessage || err.message}): the request was not sent`);
        console.log(chalk.yellow(`[l4] ${scenario.id}: gas estimation failed (${err.shortMessage || err.message}); using configured gasLimit=${l4.gasLimit}`));
      }
      const gasLimit = gasLimitFor(estimate, l4.gasLimit);
      console.log(chalk.gray(`[l4] ${scenario.id}: submitting ${args[0].length} CID(s) (value=${ethers.formatEther(value)} ETH, gasLimit=${gasLimit}${estimate === null ? '' : `, estimate=${estimate}`})…`));

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

  if (scenarios.some((s) => s.suite === 'l4-claim')) {
    reporter.addCase({ id: 'claim-l4-metrics', mode: 'l4', durationMs: 0, checks: metricChecks(summarize(claimRounds, claimDisputes)) });
  }
}

module.exports = { runL4, AGGREGATOR_ABI, justificationChecks, verdictRound };
