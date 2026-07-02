'use strict';

/**
 * Deterministic mock of the AI Node's rank-and-justify service.
 *
 * The External Adapter (when its AI_NODE_URL points here) will POST to
 * /api/rank-and-justify. This mock returns a fixed, valid score distribution
 * so L2 pipeline runs are deterministic and free (no LLM calls): the winner is
 * always `winnerIndex`, scores are integers summing to exactly 1,000,000, and a
 * canned justification is returned. Response shape matches the real AI Node
 * (see ai-node/src/app/api/rank-and-justify/route.ts).
 */

const express = require('express');

const SCORE_TOTAL = 1000000;

/**
 * Build a deterministic score vector of length n where `winnerIndex` receives
 * ~winnerShare of the total and the remainder is split evenly. Integer values
 * always sum to exactly SCORE_TOTAL (rounding remainder is given to the winner).
 */
function buildScores(n, winnerIndex, winnerShare) {
  const count = Math.max(2, n || 2);
  const win = Math.min(Math.max(0, winnerIndex || 0), count - 1);
  const winnerScore = Math.floor(SCORE_TOTAL * winnerShare);
  const others = count - 1;
  const perOther = others > 0 ? Math.floor((SCORE_TOTAL - winnerScore) / others) : 0;

  const scores = new Array(count).fill(0).map((_, i) => (i === win ? winnerScore : perOther));
  const drift = SCORE_TOTAL - scores.reduce((a, b) => a + b, 0);
  scores[win] += drift; // absorb any rounding remainder into the winner
  return scores;
}

function makeApp(opts = {}) {
  const winnerIndex = opts.winnerIndex ?? 0;
  const winnerShare = opts.winnerShare ?? 0.6;
  const justificationTpl = opts.justification
    || '[mock] Deterministic E2E justification: winner is outcome index {winnerIndex}.';

  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', mock: true }));

  app.post('/api/rank-and-justify', (req, res) => {
    const body = req.body || {};
    const outcomes = Array.isArray(body.outcomes) && body.outcomes.length ? body.outcomes : ['A', 'B'];
    const values = buildScores(outcomes.length, winnerIndex, winnerShare);

    const scores = outcomes.map((outcome, i) => ({ outcome, score: values[i] }));
    const modelCount = Array.isArray(body.models) ? body.models.length : 0;

    res.json({
      scores,
      justification: justificationTpl.replace('{winnerIndex}', String(winnerIndex)),
      metadata: {
        models_requested: modelCount,
        models_successful: modelCount,
        models_failed: 0,
        success_threshold_met: true,
      },
      model_results: (body.models || []).map((m) => ({
        provider: m.provider,
        model: m.model,
        status: 'success',
        duration_ms: 1,
      })),
    });
  });

  return app;
}

/**
 * Start the mock AI Node.
 * @returns {Promise<{server: import('http').Server, url: string, close: () => Promise<void>}>}
 */
function startMockAiNode(opts = {}) {
  const port = opts.port || 8547;
  const app = makeApp(opts);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      const url = `http://localhost:${port}`;
      resolve({
        server,
        url,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
    server.on('error', reject);
  });
}

module.exports = { makeApp, startMockAiNode, buildScores, SCORE_TOTAL };

// Allow running standalone: `node src/l2/mock-ai-node.js`
if (require.main === module) {
  const port = parseInt(process.env.MOCK_AI_PORT || '8547', 10);
  startMockAiNode({ port })
    .then(({ url }) => console.log(`Mock AI Node listening at ${url} (POST /api/rank-and-justify, GET /api/health)`))
    .catch((err) => {
      console.error('Failed to start mock AI Node:', err.message);
      process.exit(1);
    });
}
