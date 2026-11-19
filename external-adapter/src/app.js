const express = require('express');
const { requireServiceAuth } = require('./utils/serviceAuth');
const { collectVersionInfo } = require('./utils/versionInfo');

function createApp(evaluateHandler = require('./handlers/evaluateHandler')) {
  const app = express();
  app.disable('x-powered-by');
  // Read-only local monitoring remains available without a service credential.
  app.get('/version', (_req, res) => res.json({
    service: 'verdikta-external-adapter', ...collectVersionInfo(),
    uptimeSeconds: Math.floor(process.uptime()),
    ipfsFetchCache: evaluateHandler.fetchCache ? evaluateHandler.fetchCache.stats() : null
  }));
  // Authenticate before JSON parsing, evidence fetching, or any state mutation.
  app.post('/evaluate', requireServiceAuth, express.json(), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await evaluateHandler(req.body);
      res.status(result.statusCode || 200).json(result);
    } catch {
      res.status(500).json({ status: 'errored', statusCode: 500, error: 'Evaluation failed' });
    }
  });
  app.use((err, _req, res, _next) => {
    const status = err.type === 'entity.too.large' ? 413 : 400;
    res.status(status).json({ status: 'errored', statusCode: status, error: 'Invalid request body' });
  });
  return app;
}

module.exports = { createApp };
