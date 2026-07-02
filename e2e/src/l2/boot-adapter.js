'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const chalk = require('chalk');

const DEFAULT_EA_DIR = path.join(__dirname, '..', '..', '..', 'external-adapter');
// A syntactically valid address; the External Adapter requires OPERATOR_ADDR at
// startup (it's mixed into commit hashes). For L2 pipeline testing any valid
// address works; override via OPERATOR_ADDR for realistic commit-reveal hashes.
const DUMMY_OPERATOR = '0x0000000000000000000000000000000000000001';

/** Poll until the adapter accepts connections (any HTTP response = up). */
async function waitReachable(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await axios.get(url, { timeout: 2000, validateStatus: () => true });
      return true;
    } catch (err) {
      const connErr = ['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND'].includes(err.code);
      if (!connErr) return true; // HTTP-level error means the server is up
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Spawn the External Adapter as a child process configured for a test run.
 * @returns {Promise<{child: import('child_process').ChildProcess, close: () => Promise<void>}>}
 */
async function bootAdapter({ adapterUrl, aiNodeUrl, eaDir = DEFAULT_EA_DIR, timeoutMs = 30000 }) {
  if (!fs.existsSync(path.join(eaDir, 'src', 'index.js'))) {
    throw new Error(`External Adapter not found at ${eaDir} (expected src/index.js).`);
  }
  if (!fs.existsSync(path.join(eaDir, 'node_modules'))) {
    throw new Error(`External Adapter dependencies missing. Run: (cd ${eaDir} && npm ci)`);
  }

  const port = new URL(adapterUrl).port || '8080';
  const env = {
    ...process.env,
    PORT: port,
    AI_NODE_URL: aiNodeUrl,
    OPERATOR_ADDR: process.env.OPERATOR_ADDR || DUMMY_OPERATOR,
    IPFS_GATEWAY: process.env.IPFS_GATEWAY || 'https://ipfs.io',
    LOG_LEVEL: process.env.LOG_LEVEL || 'warn',
  };
  if (process.env.IPFS_PINNING_KEY) env.IPFS_PINNING_KEY = process.env.IPFS_PINNING_KEY;

  console.log(chalk.gray(`[EA] spawning External Adapter on :${port} → AI_NODE_URL=${aiNodeUrl}`));
  const child = spawn('node', ['src/index.js'], { cwd: eaDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write(chalk.gray(`[EA] ${d}`)));
  child.stderr.on('data', (d) => process.stderr.write(chalk.gray(`[EA] ${d}`)));

  const ok = await waitReachable(adapterUrl, timeoutMs);
  if (!ok) {
    child.kill('SIGKILL');
    throw new Error(`External Adapter did not become reachable at ${adapterUrl} within ${timeoutMs}ms.`);
  }
  console.log(chalk.gray(`[EA] reachable at ${adapterUrl}`));

  const close = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const done = () => resolve();
    child.once('exit', done);
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} done(); }, 3000);
  });

  return { child, close };
}

module.exports = { bootAdapter };
