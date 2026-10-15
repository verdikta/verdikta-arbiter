/**
 * @fileoverview Express application for the External Adapter.
 *
 * Extracted from index.js so the routes can be exercised by unit tests
 * (supertest) without binding port 8080 or running the startup side effects
 * (dotenv, Pinata key validation, http server creation) that belong to the
 * process entrypoint. index.js remains the entrypoint: it requires this
 * module and wraps it in an http server.
 */

const express = require('express');
const bodyParser = require('body-parser');
const evaluateHandler = require('./handlers/evaluateHandler');
const { collectVersionInfo } = require('./utils/versionInfo');

const app = express();
app.use(bodyParser.json());

// Liveness/health probe for local ops tooling (arbiter-status.sh,
// arbiter-doctor.sh) and container orchestration. Deliberately cheap: no IPFS,
// chain or LLM calls, so it stays answerable while the adapter is busy.
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'verdikta-external-adapter',
    release: collectVersionInfo().release,
    uptimeSeconds: Math.floor(process.uptime())
  });
});

// Version self-report for local ops tooling (arbiter-doctor) and debugging.
// The same block is embedded in every justification uploaded to IPFS.
app.get('/version', (req, res) => {
  res.json({
    service: 'verdikta-external-adapter',
    ...collectVersionInfo(),
    uptimeSeconds: Math.floor(process.uptime()),
    // #69: shared/cached IPFS fetches (hits, in-flight reuses, entries, bytes)
    ipfsFetchCache: evaluateHandler.fetchCache ? evaluateHandler.fetchCache.stats() : null
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

module.exports = app;
