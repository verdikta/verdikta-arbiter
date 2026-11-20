/**
 * @fileoverview The adapter's HTTP routes, apart from the server (index.js),
 * so tests can drive them.
 *
 *   POST /evaluate  the Chainlink bridge's call (handlers/evaluateHandler.js), and the health job's
 *                   (a body with data.healthKey: health/healthHandler.js)
 *   GET  /version   version self-report for the doctor and debugging
 *   GET  /health    liveness, the code-review mode (trust, readiness) and the canary fault switch
 */

const http = require('http');
const express = require('express');
const { requireServiceAuth } = require('./utils/serviceAuth');
const { collectVersionInfo } = require('./utils/versionInfo');
const { getCodeReviewConfig, describeCodeReviewConfig } = require('./codeReview/config');
const { describeCanaryFault } = require('./canaryFault');
const { serverTimeoutMs } = require('./utils/serverTimeout');
const { createHealthHandler, isHealthRequest } = require('./health/healthHandler');

const SERVICE = 'verdikta-external-adapter';

/**
 * @param {{ evaluateHandler?: Function, healthHandler?: Function }} [options]
 * @returns {import('express').Express}
 */
function createApp(options = {}) {
  const evaluateHandler = (typeof options === 'function' ? options : options.evaluateHandler) || require('./handlers/evaluateHandler');
  const healthHandler = (typeof options === 'object' && options.healthHandler) ||
    createHealthHandler({ logger: evaluateHandler.logger });
  const app = express();
  app.disable('x-powered-by');

  // Version self-report for local ops tooling (arbiter-doctor) and debugging.
  // The same block is embedded in every justification uploaded to IPFS.
  app.get('/version', (req, res) => {
    res.json({
      service: SERVICE,
      ...collectVersionInfo(),
      uptimeSeconds: Math.floor(process.uptime()),
      // #69: shared/cached IPFS fetches (hits, in-flight reuses, entries, bytes)
      ipfsFetchCache: evaluateHandler.fetchCache ? evaluateHandler.fetchCache.stats() : null,
      codeReview: describeCodeReviewConfig(getCodeReviewConfig()),
      canaryFault: describeCanaryFault()
    });
  });

  // Liveness, and whether code-review mode is on and under which trust: an
  // arbiter in dev trust says so here (build plan assumption A6).
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: SERVICE,
      codeReview: describeCodeReviewConfig(getCodeReviewConfig()),
      canaryFault: describeCanaryFault()
    });
  });

  // The service credential is checked before JSON parsing or either evaluation mode.
  app.post('/evaluate', requireServiceAuth, express.json(), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = isHealthRequest(req.body) ? await healthHandler(req.body) : await evaluateHandler(req.body);
      res.status(result.statusCode || 200).json(result);
    } catch (error) {
      res.status(500).json({
        jobRunID: req.body?.id || 'unknown',
        status: 'errored',
        statusCode: 500,
        error: 'Evaluation failed'
      });
    }
  });

  // Error handling middleware
  app.use((err, req, res, next) => {
    const status = err.type === 'entity.too.large' ? 413 : 400;
    res.status(status).json({
      jobRunID: req.body?.id || 'unknown',
      status: 'errored',
      statusCode: status,
      error: 'Invalid request body'
    });
  });

  return app;
}

/**
 * The HTTP server around the app, with its connection limit and socket timeout.
 * @param {import('express').Express} app
 * @param {object} [env]
 * @returns {import('http').Server}
 */
function createHttpServer(app, env = process.env) {
  const server = http.createServer(app);
  server.maxConnections = 1000;        // Handle more concurrent connections
  server.timeout = serverTimeoutMs(env);
  return server;
}

module.exports = { createApp, createHttpServer, serverTimeoutMs };
