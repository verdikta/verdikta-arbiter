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

const { validServiceToken } = require('./utils/serviceAuth');
for (const key of ['EA_API_TOKEN', 'AI_NODE_API_TOKEN']) {
  if (!validServiceToken(process.env[key])) {
    throw new Error(`${key} must be configured with a 32–128 character service token`);
  }
}
if (process.env.EA_API_TOKEN === process.env.AI_NODE_API_TOKEN) {
  throw new Error('EA and AI Node must use separate service tokens');
}
const { createApp, createHttpServer } = require('./app');
const { listenArgs } = require('./utils/listenArgs');

// Routes (POST /evaluate, GET /version, GET /health) live in app.js.
const app = createApp();

// The connection limit and the socket timeout (SERVER_TIMEOUT, 840 s by default).
const server = createHttpServer(app);

// HOST is optional; unset = every interface, as always (see utils/listenArgs.js
// for why that stays the default and what protects port 8080).
const listenOn = listenArgs();
server.listen(...listenOn, () => {
  console.log(`Server is running on port ${listenOn[0]}${listenOn[1] ? ` (address ${listenOn[1]})` : ''}`);
});

const commitStore = require('./services/commitStore');
// Load the commits a previous run left (restart or upgrade between a commit and its reveal).
commitStore.init()
  .then(n => console.log(`Commit store: ${n} record(s) in ${commitStore.dir}`))
  .catch(e => console.error(`Commit store at ${commitStore.dir} cannot be loaded (${e.code || 'error'}): commits will fail until it can`));
// Expire both unrevealed and revealed entries even when no requests arrive.
setInterval(() => commitStore.purgeStale().catch(() => console.error('Commit cleanup failed')),
  15 * 60 * 1000).unref();
