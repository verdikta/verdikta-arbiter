/**
 * @fileoverview The adapter's HTTP routes, apart from the server (index.js),
 * so tests can drive them.
 *
 *   POST /evaluate  the Chainlink bridge's call (handlers/evaluateHandler.js)
 *   GET  /version   version self-report for the doctor and debugging
 *   GET  /health    liveness, the code-review mode (trust, readiness) and the canary fault switch
 */

const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const { collectVersionInfo } = require('./utils/versionInfo');
const { getCodeReviewConfig, describeCodeReviewConfig } = require('./codeReview/config');
const { describeCanaryFault } = require('./canaryFault');
const { serverTimeoutMs } = require('./utils/serverTimeout');

const SERVICE = 'verdikta-external-adapter';

/**
 * @param {{ evaluateHandler?: Function }} [options]
 * @returns {import('express').Express}
 */
function createApp(options = {}) {
  const evaluateHandler = options.evaluateHandler || require('./handlers/evaluateHandler');
  const app = express();
  app.use(bodyParser.json());

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

  app.post('/evaluate', async (req, res) => {
    try {
      const result = await evaluateHandler(req.body);
      res.status(result.statusCode || 200).json(result);
    } catch (error) {
      res.status(500).json({
        jobRunID: req.body?.id || 'unknown',
        status: 'errored',
        statusCode: 500,
        error: error.message || 'Unknown error'
      });
    }
  });

  // Error handling middleware
  app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
      jobRunID: req.body?.id || 'unknown',
      status: 'errored',
      statusCode: 500,
      error: err.message || 'Internal server error'
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
