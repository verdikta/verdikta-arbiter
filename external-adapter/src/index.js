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

// Routes and middleware live in app.js so they can be unit-tested without
// binding a port (see src/__tests__/handlers/health.test.js).
const app = require('./app');

// Create HTTP server to set connection limits
const server = require('http').createServer(app);
server.maxConnections = 1000;        // Handle more concurrent connections
server.timeout = parseInt(process.env.SERVER_TIMEOUT) || 300000;  // 5 minute timeout (configurable)

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

module.exports = server;
