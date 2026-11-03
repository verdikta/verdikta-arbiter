'use strict';

/**
 * Starts the real services of a claim run as child processes, each with its own small
 * environment: nothing of this shell's reaches them, and each setting below is what the
 * service runs on. A service's own .env file, on a developer's machine, still loads.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const axios = require('axios');

const REPO = path.join(__dirname, '..', '..', '..', '..');
const EA_DIR = path.join(REPO, 'external-adapter');
const AI_DIR = path.join(REPO, 'ai-node');
const RUNNER_DIR = path.join(REPO, 'code-runner');
const LOG_TAIL_BYTES = 8192;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function assertInstalled(dir, what) {
  if (!fs.existsSync(path.join(dir, 'node_modules'))) throw new Error(`${what} dependencies are missing: run (cd ${dir} && npm ci)`);
}

const running = new Set();
process.on('exit', () => {
  for (const child of running) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (_) { /* gone */ }
  }
});

/** A child in its own process group (next dev has children of its own), its output kept in a file and a tail. */
function launch(name, argv, { cwd, env, logDir }) {
  const file = path.join(logDir, `${name}.log`);
  const out = fs.openSync(file, 'a');
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  running.add(child);
  let exited = null;
  child.once('exit', (code, signal) => {
    exited = { code, signal };
    running.delete(child);
  });
  child.once('error', (err) => {
    exited = { code: null, signal: err.message };
    running.delete(child);
  });
  const tail = () => {
    try {
      const text = fs.readFileSync(file, 'utf8');
      return text.slice(-LOG_TAIL_BYTES);
    } catch (_) {
      return '';
    }
  };
  const close = () => new Promise((resolve) => {
    if (exited || !child.pid) return resolve();
    const done = () => resolve();
    child.once('exit', done);
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (_) {
      return resolve();
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (_) { /* gone */ }
      setTimeout(done, 500);
    }, 8000).unref();
  });
  return { name, child, tail, close, exited: () => exited, log: file };
}

/** Poll until `ready()` is true, the child died, or time runs out; each ends in a message that says which. */
async function waitUntil(proc, what, ready, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    if (proc.exited()) throw new Error(`${proc.name} exited ${JSON.stringify(proc.exited())} while ${what}:\n${proc.tail()}`);
    try {
      const v = await ready();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${proc.name}: timed out ${what} after ${timeoutMs} ms${last ? ` (${last.message})` : ''}:\n${proc.tail()}`);
}

const baseEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME || os.homedir() });

/** The real AI Node under `next dev`: the mock provider is refused in a production build (A5). */
async function startAiNode({ logDir, callLog, script, justifierModel }) {
  assertInstalled(AI_DIR, 'the AI Node\'s');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc = launch('ai-node', [path.join(AI_DIR, 'node_modules', '.bin', 'next'), 'dev', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: AI_DIR,
    logDir,
    env: {
      ...baseEnv(),
      NEXT_TELEMETRY_DISABLED: '1',
      VERDIKTA_TEST_MOCK_PROVIDER: '1',
      VERDIKTA_TEST_MOCK_SCRIPT: JSON.stringify(script),
      VERDIKTA_TEST_MOCK_CALL_LOG: callLog,
      JUSTIFIER_MODEL: justifierModel,
      LOG_LEVEL: 'warn'
    }
  });
  await waitUntil(proc, 'waiting for /api/health', async () => (await axios.get(`${url}/api/health`, { timeout: 120000, validateStatus: () => true })).status === 200, 300000);
  // next dev compiles a route on its first request: done here, so it counts against no deadline.
  await waitUntil(proc, 'compiling /api/rank-and-justify', async () => {
    const r = await axios.post(`${url}/api/rank-and-justify`, {}, { timeout: 180000, validateStatus: () => true });
    return r.status >= 400 && r.status < 500;
  }, 300000);
  return { url, ...proc };
}

/** The real code runner: runc (CI's other job runs gVisor), with a registry allowlist of the local registry alone. */
async function startCodeRunner({ logDir, stateDir, token, platform, allowlist, classPlatform, instance }) {
  assertInstalled(RUNNER_DIR, 'the code runner\'s');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const entry = classPlatform ? path.join(RUNNER_DIR, 'src', 'index.js') : path.join(__dirname, 'dev-report-runner.js');
  const env = {
    ...baseEnv(),
    CODE_RUNNER_TOKEN: token,
    CODE_RUNNER_RUNTIME: 'runc',
    CODE_RUNNER_PLATFORM: platform,
    CODE_RUNNER_PORT: String(port),
    CODE_RUNNER_STATE_DIR: stateDir,
    CODE_RUNNER_REGISTRY_ALLOWLIST: allowlist,
    CODE_RUNNER_INSTANCE: instance,
    LOG_LEVEL: 'warn'
  };
  if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;
  const proc = launch('code-runner', [process.execPath, entry], { cwd: RUNNER_DIR, logDir, env });
  await waitUntil(proc, 'waiting for /health', async () => {
    const r = await axios.get(`${url}/health`, { headers: { authorization: `Bearer ${token}` }, timeout: 15000, validateStatus: () => true });
    if (r.status === 200 && r.data && r.data.ok) return true;
    if (r.status === 503 && r.data && r.data.reasons) throw new Error(`/health says: ${r.data.reasons.join('; ')}`);
    return false;
  }, 60000);
  return { url, ...proc };
}

/** The real External Adapter, code review on, dev trust set explicitly, every IPFS call pointed here. */
async function startAdapter({ logDir, aiNodeUrl, runnerUrl, runnerToken, ipfsUrl, pinKey, devKey, operator }) {
  assertInstalled(EA_DIR, 'the External Adapter\'s');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc = launch('external-adapter', [process.execPath, 'src/index.js'], {
    cwd: EA_DIR,
    logDir,
    env: {
      ...baseEnv(),
      PORT: String(port),
      HOST: '127.0.0.1',
      OPERATOR_ADDR: operator,
      AI_NODE_URL: aiNodeUrl,
      IPFS_GATEWAY: ipfsUrl,
      IPFS_PINNING_SERVICE: ipfsUrl,
      IPFS_PINNING_KEY: pinKey,
      CODE_REVIEW_ENABLED: 'true',
      CODE_RUNNER_URL: runnerUrl,
      CODE_RUNNER_TOKEN: runnerToken,
      CODE_REVIEW_TRUST: 'dev',
      CODE_REVIEW_DEV_KEYS: devKey,
      NETWORK_CHAIN_ID: '31337',
      DEPLOYMENT_NETWORK: 'local',
      LOG_LEVEL: 'info'
    }
  });
  const health = await waitUntil(proc, 'waiting for /health', async () => {
    const r = await axios.get(`${url}/health`, { timeout: 5000, validateStatus: () => true });
    return r.status === 200 ? r.data : false;
  }, 60000);
  const cr = health.codeReview || {};
  if (!cr.ready || cr.trust !== 'dev') throw new Error(`the adapter is not in code mode with dev trust: ${JSON.stringify(cr)}\n${proc.tail()}`);
  return { url, health, ...proc };
}

module.exports = { freePort, startAiNode, startCodeRunner, startAdapter };
