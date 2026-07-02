'use strict';

const axios = require('axios');
const crypto = require('crypto');
const chalk = require('chalk');
const A = require('../assertions');
const { startMockAiNode } = require('./mock-ai-node');
const { bootAdapter } = require('./boot-adapter');

/** POST a request to the External Adapter's /evaluate endpoint. */
async function callEvaluate(adapterUrl, cid, { aggId = '', timeoutMs = 180000 } = {}) {
  const id = `e2e-${crypto.randomBytes(4).toString('hex')}`;
  const { data } = await axios.post(
    `${adapterUrl.replace(/\/$/, '')}/evaluate`,
    { id, data: { cid, aggId } },
    { timeout: timeoutMs, headers: { 'Content-Type': 'application/json' } }
  );
  return data;
}

/** Verify the returned justification CID is fetchable and looks like a result JSON. */
async function checkJustificationFetch(gateway, cid, timeoutMs) {
  const url = `${gateway.replace(/\/$/, '')}/ipfs/${cid}`;
  try {
    const { data } = await axios.get(url, { timeout: timeoutMs });
    const obj = typeof data === 'string' ? JSON.parse(data) : data;
    const ok = obj && (Array.isArray(obj.scores) || typeof obj.justification === 'string');
    return A.assert('justification.fetchableJson', ok, ok ? `keys=${Object.keys(obj).join(',')}` : 'missing scores/justification');
  } catch (err) {
    return A.assert('justification.fetchableJson', false, `fetch failed: ${err.message}`);
  }
}

/** Run one scenario in mode 0 (standard evaluate). */
async function runMode0(cfg, scenario, expectedWinnerIndex, assertWinner) {
  const checks = [];
  const resp = await callEvaluate(cfg.adapterUrl, scenario.cid, { timeoutMs: cfg.timeouts.evaluateMs });
  const scoreArr = resp?.data?.aggregatedScore;
  const cid = resp?.data?.justificationCid;

  checks.push(A.assert('response.status===success', resp?.status === 'success' || resp?.statusCode === 200,
    `status=${resp?.status}, code=${resp?.statusCode}`));
  checks.push(...A.structuralScoreAssertions(scoreArr, {
    minOutcomes: scenario.minOutcomes || 2,
    scoreSumTarget: cfg.tolerances.scoreSumTarget,
    scoreSumSlack: cfg.tolerances.scoreSumSlack,
  }));
  checks.push(A.cidAssertion('justificationCid.valid', cid));
  if (assertWinner && Number.isInteger(expectedWinnerIndex)) {
    checks.push(A.winnerAssertion(scoreArr, expectedWinnerIndex));
  }
  if (cfg.ipfs.checkJustificationFetch && A.isLikelyCid(cid)) {
    checks.push(await checkJustificationFetch(cfg.ipfs.gateway, cid, cfg.timeouts.ipfsFetchMs));
  }
  return checks;
}

/** Run one scenario through commit (mode 1) then reveal (mode 2). */
async function runCommitReveal(cfg, scenario) {
  const checks = [];
  const aggId = crypto.randomBytes(8).toString('hex');

  const commit = await callEvaluate(cfg.adapterUrl, `1:${scenario.cid}`, { aggId, timeoutMs: cfg.timeouts.evaluateMs });
  const commitScore = commit?.data?.aggregatedScore;
  checks.push(...A.commitAssertions(commitScore, commit?.data?.justificationCid));

  const commitment = commitScore && commitScore[0];
  if (!/^[0-9]+$/.test(String(commitment))) {
    checks.push(A.assert('reveal.skipped', false, 'no valid commitment to reveal'));
    return checks;
  }

  const reveal = await callEvaluate(cfg.adapterUrl, `2:${commitment}`, { aggId, timeoutMs: cfg.timeouts.evaluateMs });
  checks.push(...A.structuralScoreAssertions(reveal?.data?.aggregatedScore, {
    minOutcomes: scenario.minOutcomes || 2,
    scoreSumTarget: cfg.tolerances.scoreSumTarget,
    scoreSumSlack: cfg.tolerances.scoreSumSlack,
  }));
  checks.push(...A.cidWithSaltAssertion(reveal?.data?.justificationCid));
  return checks;
}

/** Preflight: confirm the External Adapter is reachable (any HTTP response counts). */
async function assertAdapterReachable(adapterUrl) {
  try {
    await axios.get(adapterUrl, { timeout: 5000, validateStatus: () => true });
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND') {
      throw new Error(`External Adapter not reachable at ${adapterUrl} (${err.code}). Start it first, or pass --adapter-url.`);
    }
    // Any HTTP-level error (e.g. 404 on GET /) means the server is up — that's fine.
  }
}

/**
 * Run the L2 suite.
 * @param {object} cfg - merged config
 * @param {Array} scenarios
 * @param {object} opts - { mock: boolean, reporter }
 */
async function runL2(cfg, scenarios, opts) {
  const { mock, reporter } = opts;
  let mockAi = null;
  let adapter = null;

  if (mock) {
    mockAi = await startMockAiNode(cfg.mockAi);
    console.log(chalk.gray(`[mock] AI Node started at ${mockAi.url} (winnerIndex=${cfg.mockAi.winnerIndex})`));
    if (!opts.bootAdapter) {
      console.log(chalk.yellow(
        `[mock] Ensure the External Adapter at ${cfg.adapterUrl} is running with AI_NODE_URL=${mockAi.url}`
      ));
    }
  } else {
    console.log(chalk.gray(`[real] Using External Adapter at ${cfg.adapterUrl} (expects a real AI Node behind it)`));
  }

  try {
    if (opts.bootAdapter) {
      const aiNodeUrl = mock ? mockAi.url : cfg.aiNodeUrl;
      adapter = await bootAdapter({ adapterUrl: cfg.adapterUrl, aiNodeUrl });
    }

    await assertAdapterReachable(cfg.adapterUrl);

    for (const scenario of scenarios) {
      const modes = scenario.modes && scenario.modes.length ? scenario.modes : ['0'];
      // In mock mode the winner is deterministic (mockAi.winnerIndex); in real
      // mode only assert the winner if the scenario declares an expected index.
      const expectedWinnerIndex = mock ? cfg.mockAi.winnerIndex : scenario.expectedWinnerIndex;
      const assertWinner = mock ? true : opts.assertWinner && Number.isInteger(scenario.expectedWinnerIndex);

      for (const mode of modes) {
        const start = Date.now();
        try {
          const checks = mode === '0'
            ? await runMode0(cfg, scenario, expectedWinnerIndex, assertWinner)
            : await runCommitReveal(cfg, scenario);
          reporter.addCase({ id: scenario.id, mode, durationMs: Date.now() - start, checks });
        } catch (err) {
          const detail = err.response
            ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
            : err.message;
          reporter.addCase({ id: scenario.id, mode, durationMs: Date.now() - start, error: detail, checks: [] });
        }
      }
    }
  } finally {
    if (adapter) await adapter.close();
    if (mockAi) await mockAi.close();
  }
}

module.exports = { runL2, callEvaluate };
