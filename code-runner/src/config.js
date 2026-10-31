'use strict';

/**
 * Configuration, from the environment only (design §9.1).
 *
 * - Listens on 127.0.0.1 (default port 8090) or a Unix socket. Any other
 *   address is refused unless CODE_RUNNER_ALLOW_REMOTE_BIND=true (the remote
 *   placement mode, where the runner sits on its own VPS).
 * - Every request needs the shared bearer token (CODE_RUNNER_TOKEN or
 *   CODE_RUNNER_TOKEN_FILE), at least 32 printable characters.
 * - Holds no secrets: no keys, no wallet, no provider or pinning credentials.
 *   It refuses to start when its environment carries anything that looks like
 *   one, so an operator cannot hand it the EA's environment by accident.
 * - Docker endpoint: DOCKER_HOST (production: the runner's own dockerd).
 */

const fs = require('node:fs');
const path = require('node:path');

const CODE_RUNNER_ROOT = path.join(__dirname, '..');

const DEFAULT_PORT = 8090;
const MIN_TOKEN_LENGTH = 32;
const RUNTIMES = ['runsc', 'runc'];
const INSTANCE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** 2 x 2 MB patches in base64 plus the report, finding and listing JSON. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Names that hold credentials elsewhere in an arbiter install, and their usual shapes. */
const SECRET_NAME = /(^|_)(API_KEY|APIKEY|SECRET|SECRET_KEY|PRIVATE_KEY|MNEMONIC|SEED_PHRASE|PASSWORD|PASSPHRASE|JWT|PINNING_KEY|ACCESS_KEY|TOKEN|CREDENTIALS)$/i;
const OWN_SECRET = new Set(['CODE_RUNNER_TOKEN']);

class ConfigError extends Error {
  constructor(problems) {
    super(`code-runner configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function isLoopbackHost(host) {
  if (host === '::1') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host));
  return Boolean(m) && m.slice(1).every((o) => Number(o) <= 255);
}

/** Names (never values) of environment variables that look like credentials. */
function secretLookingEnv(env) {
  return Object.keys(env).filter((k) => !OWN_SECRET.has(k) && SECRET_NAME.test(k) && typeof env[k] === 'string' && env[k] !== '');
}

function blank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

/**
 * @param {object} [env] - process.env
 * @param {object} [o]
 * @param {string} [o.root] - the code-runner directory (state lives under it)
 * @param {Function} [o.readFile] - for CODE_RUNNER_TOKEN_FILE
 * @returns {object} the config
 * @throws {ConfigError}
 */
function loadConfig(env = process.env, { root = CODE_RUNNER_ROOT, readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const problems = [];

  const secrets = secretLookingEnv(env);
  if (secrets.length) {
    problems.push(`the code runner holds no secrets, but its environment carries ${secrets.sort().join(', ')}; `
      + 'start it with its own environment (see code-runner/README.md)');
  }

  const allowRemoteBind = env.CODE_RUNNER_ALLOW_REMOTE_BIND === 'true';
  let listen;
  if (!blank(env.CODE_RUNNER_SOCKET)) {
    const socket = String(env.CODE_RUNNER_SOCKET).trim();
    if (!blank(env.CODE_RUNNER_HOST) || !blank(env.CODE_RUNNER_PORT)) {
      problems.push('set either CODE_RUNNER_SOCKET or CODE_RUNNER_HOST/CODE_RUNNER_PORT, not both');
    }
    if (!path.isAbsolute(socket)) problems.push(`CODE_RUNNER_SOCKET must be an absolute path, got ${JSON.stringify(socket)}`);
    listen = { socket };
  } else {
    const host = blank(env.CODE_RUNNER_HOST) ? '127.0.0.1' : String(env.CODE_RUNNER_HOST).trim();
    if (!isLoopbackHost(host) && !allowRemoteBind) {
      problems.push(`CODE_RUNNER_HOST ${JSON.stringify(host)} is not a loopback address; the runner listens on 127.0.0.1, ::1 `
        + 'or a Unix socket unless CODE_RUNNER_ALLOW_REMOTE_BIND=true');
    }
    let port = DEFAULT_PORT;
    if (!blank(env.CODE_RUNNER_PORT)) {
      const raw = String(env.CODE_RUNNER_PORT).trim();
      port = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`CODE_RUNNER_PORT must be 1-65535, got ${JSON.stringify(raw)}`);
    }
    listen = { host, port };
  }

  let token = null;
  const hasToken = !blank(env.CODE_RUNNER_TOKEN);
  const hasFile = !blank(env.CODE_RUNNER_TOKEN_FILE);
  if (hasToken && hasFile) {
    problems.push('set CODE_RUNNER_TOKEN or CODE_RUNNER_TOKEN_FILE, not both');
  } else if (hasFile) {
    try {
      token = String(readFile(String(env.CODE_RUNNER_TOKEN_FILE).trim())).trim();
    } catch (err) {
      problems.push(`cannot read CODE_RUNNER_TOKEN_FILE: ${err.code || err.message}`);
    }
  } else if (hasToken) {
    token = String(env.CODE_RUNNER_TOKEN);
  } else {
    problems.push('CODE_RUNNER_TOKEN (or CODE_RUNNER_TOKEN_FILE) is required: every request carries it as a bearer token');
  }
  if (token !== null) {
    if (token.length < MIN_TOKEN_LENGTH) problems.push(`the bearer token must be at least ${MIN_TOKEN_LENGTH} characters`);
    else if (!/^[\x21-\x7e]+$/.test(token)) problems.push('the bearer token must be printable ASCII without spaces');
  }

  const runtime = blank(env.CODE_RUNNER_RUNTIME) ? 'runsc' : String(env.CODE_RUNNER_RUNTIME).trim();
  if (!RUNTIMES.includes(runtime)) problems.push(`CODE_RUNNER_RUNTIME must be runsc or runc, got ${JSON.stringify(runtime)}`);

  // The class platform is linux/amd64 (§9.3). Apple-silicon development
  // without amd64 emulation can run arm64 variants of multi-platform test
  // images, under runc only; the run reports the platform it used.
  const platform = blank(env.CODE_RUNNER_PLATFORM) ? 'linux/amd64' : String(env.CODE_RUNNER_PLATFORM).trim();
  if (platform !== 'linux/amd64' && platform !== 'linux/arm64') {
    problems.push(`CODE_RUNNER_PLATFORM must be linux/amd64 (or linux/arm64 for runc development), got ${JSON.stringify(platform)}`);
  } else if (platform !== 'linux/amd64' && runtime !== 'runc') {
    problems.push('CODE_RUNNER_PLATFORM=linux/arm64 is a development setting: it needs CODE_RUNNER_RUNTIME=runc');
  }

  const instance = blank(env.CODE_RUNNER_INSTANCE) ? 'default' : String(env.CODE_RUNNER_INSTANCE).trim();
  if (!INSTANCE.test(instance)) problems.push(`CODE_RUNNER_INSTANCE must be a lowercase slug of up to 32 characters, got ${JSON.stringify(instance)}`);

  const absolute = (name, fallback) => {
    if (blank(env[name])) return fallback;
    const v = String(env[name]).trim();
    if (!path.isAbsolute(v)) problems.push(`${name} must be an absolute path, got ${JSON.stringify(v)}`);
    return v;
  };
  const stateDir = absolute('CODE_RUNNER_STATE_DIR', path.join(root, '.state'));
  const maintenanceFile = absolute('CODE_RUNNER_MAINTENANCE_FILE', path.join(stateDir, 'maintenance'));
  const dataRoot = absolute('CODE_RUNNER_DATA_ROOT', null);

  const number = (name, fallback, min, max) => {
    if (blank(env[name])) return fallback;
    const n = Number(env[name]);
    if (!Number.isInteger(n) || n < min || n > max) problems.push(`${name} must be an integer from ${min} to ${max}`);
    return n;
  };
  const gcIntervalMs = number('CODE_RUNNER_GC_INTERVAL_SECONDS', 60, 0, 86400) * 1000;
  const deadlineReserveMs = number('CODE_RUNNER_DEADLINE_RESERVE_MS', 5000, 0, 60000);

  if (problems.length) throw new ConfigError(problems);

  return {
    listen,
    allowRemoteBind,
    token,
    runtime,
    platform,
    dockerHost: blank(env.DOCKER_HOST) ? null : String(env.DOCKER_HOST).trim(),
    dockerBin: blank(env.CODE_RUNNER_DOCKER_BIN) ? 'docker' : String(env.CODE_RUNNER_DOCKER_BIN).trim(),
    instance,
    stateDir,
    dockerConfigDir: path.join(stateDir, 'docker-config'),
    maintenanceFile,
    dataRoot,
    gcIntervalMs,
    deadlineReserveMs,
    maxBodyBytes: MAX_BODY_BYTES
  };
}

module.exports = { loadConfig, ConfigError, isLoopbackHost, secretLookingEnv, DEFAULT_PORT, MAX_BODY_BYTES, CODE_RUNNER_ROOT };
