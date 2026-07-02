// Load environment variables from .env file
require('dotenv').config();

// ──────────────────────────────────────────────────────────────────────────
// Startup invariants: surface misconfigurations loudly at boot rather than
// letting them produce opaque 4xx errors at request time.
// ──────────────────────────────────────────────────────────────────────────
function validatePinataKey() {
  const k = process.env.IPFS_PINNING_KEY;
  if (!k) {
    console.error(
      '\x1b[1;31m[FATAL CONFIG]\x1b[0m IPFS_PINNING_KEY is not set.\n' +
      '  The External Adapter needs a Pinata JWT to upload justification\n' +
      '  archives to IPFS. Without it, every reveal will fail at upload time.\n' +
      '  Set IPFS_PINNING_KEY in external-adapter/.env or rotate via:\n' +
      '    <install>/update-pinata-key.sh'
    );
    return false;
  }
  const segs = k.split('.').length;
  if (!k.startsWith('eyJ') || segs !== 3) {
    console.error(
      '\x1b[1;31m[FATAL CONFIG]\x1b[0m IPFS_PINNING_KEY is set but does not look like a JWT.\n' +
      `  observed: length=${k.length}, segments=${segs}, prefix=${k.slice(0, 3)}\n` +
      '  expected: 3 dot-separated segments, prefix "eyJ", length ~400-800.\n' +
      '  You likely pasted the Pinata "API Key" or "API Secret" field. The\n' +
      '  correct value is the JWT (third field), available at:\n' +
      '    https://app.pinata.cloud/developers/api-keys\n' +
      '  Rotate via: <install>/update-pinata-key.sh'
    );
    return false;
  }
  return true;
}

// We log the warning prominently but don't exit: the EA also serves commit
// requests (mode 1) which don't need IPFS, so partial functionality is
// better than total outage. Only reveals (mode 2) will fail at upload time.
validatePinataKey();

const express = require('express');
const bodyParser = require('body-parser');
const evaluateHandler = require('./handlers/evaluateHandler');
const { versionInfo } = require('./utils/versionInfo');

const app = express();
app.use(bodyParser.json());

// Version self-report for local ops tooling (arbiter-doctor) and debugging.
// The same block is embedded in every justification uploaded to IPFS.
app.get('/version', (req, res) => {
  res.json({
    service: 'verdikta-external-adapter',
    ...versionInfo,
    uptimeSeconds: Math.floor(process.uptime())
  });
});

// Create HTTP server to set connection limits
const server = require('http').createServer(app);
server.maxConnections = 1000;        // Handle more concurrent connections
server.timeout = parseInt(process.env.SERVER_TIMEOUT) || 300000;  // 5 minute timeout (configurable)

// Update the route handler
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

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
}); 