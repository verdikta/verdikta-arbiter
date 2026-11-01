/**
 * @fileoverview Operator configuration of code-review (stake attestation) mode.
 *
 * Code review is off unless the operator turns it on. Everything here fails
 * closed: a value the adapter cannot read is a reason to refuse code mode,
 * never a guess.
 *
 *   CODE_REVIEW_ENABLED=true          code mode on (any other value: off)
 *   CODE_RUNNER_URL=http://127.0.0.1:8090
 *   CODE_RUNNER_TOKEN / CODE_RUNNER_TOKEN_FILE
 *                                     the runner's bearer token, or a file holding it (not both)
 *   CODE_REVIEW_TRUST=production|dev  which builder keys verify attestation.json (default production)
 *   CODE_REVIEW_DEV_KEYS=<b64>,<b64>  dev trust only: caller-supplied builder public keys
 *   NETWORK_CHAIN_ID / DEPLOYMENT_NETWORK
 *                                     the chain this arbiter serves (as installer/.env names it)
 *
 * Library: code mode also needs the @verdikta/common release this adapter
 * pins (package.json, exact), and the AI Node beside it on the same one. An
 * install or upgrade that replaced it (the installer's default is `latest`)
 * leaves code mode off, with the reason in /health, rather than judging
 * claims by another release's rules.
 *
 * Trust (build plan assumption A6): production trust verifies against
 * @verdikta/common's trusted-builder set and nothing else. CODE_REVIEW_TRUST=dev
 * adds the caller-supplied dev keys for attestations signed for dev trust; it
 * is refused, and code mode with it, unless the chain is positively a test
 * chain (Base Sepolia or a local node). An unknown chain counts as mainnet.
 */

const fs = require('fs');
const path = require('path');
const { codeReview } = require('@verdikta/common');

const BASE_MAINNET_CHAIN_ID = 8453;
/** Chains dev trust may run on: Base Sepolia and a local Hardhat/Anvil node. */
const DEV_TRUST_CHAIN_IDS = Object.freeze([84532, 31337]);
const TRUST_MODES = Object.freeze(['production', 'dev']);

const present = (value) => typeof value === 'string' && value.trim() !== '';

/** The runner's bearer token rule (code-runner README): 32 or more printable characters, no spaces. */
const TOKEN_RE = /^[\x21-\x7e]{32,}$/;

function readJsonVersion(file, pick) {
  try {
    return pick(JSON.parse(fs.readFileSync(file, 'utf8'))) || null;
  } catch (_error) {
    return null;
  }
}

const EA_ROOT = path.join(__dirname, '..', '..');

/**
 * The @verdikta/common versions code mode depends on: the adapter's exact pin,
 * the copy it runs, and the copy the AI Node beside it runs (null when there
 * is no AI Node there, as in a split deployment).
 */
function readCommonVersions() {
  return {
    pinned: readJsonVersion(path.join(EA_ROOT, 'package.json'), (pkg) => pkg.dependencies && pkg.dependencies['@verdikta/common']),
    installed: readJsonVersion(path.join(EA_ROOT, 'node_modules', '@verdikta', 'common', 'package.json'), (pkg) => pkg.version),
    aiNode: readJsonVersion(path.join(EA_ROOT, '..', 'ai-node', 'node_modules', '@verdikta', 'common', 'package.json'), (pkg) => pkg.version)
  };
}

function commonVersionProblems(versions) {
  const problems = [];
  if (!versions.installed || versions.installed !== versions.pinned) {
    problems.push(`the adapter runs @verdikta/common ${versions.installed || '(unknown)'}, not the ${versions.pinned || '(unknown)'} it pins`);
  }
  if (versions.aiNode && versions.aiNode !== versions.installed) {
    problems.push(`the AI Node runs @verdikta/common ${versions.aiNode}, the adapter ${versions.installed || '(unknown)'}`);
  }
  return problems;
}

/** Why a token is unusable, or null. Never echoes it. */
function tokenProblem(token, source) {
  return TOKEN_RE.test(token.trim()) ? null : `${source} does not hold a usable token (32 or more printable characters, no spaces)`;
}

function runnerFromEnv(env, problems) {
  let url = null;
  if (!present(env.CODE_RUNNER_URL)) {
    problems.push('CODE_RUNNER_URL is not set');
  } else {
    try {
      const parsed = new URL(env.CODE_RUNNER_URL.trim());
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') url = parsed.toString();
      else problems.push('CODE_RUNNER_URL must be an http(s) URL');
    } catch (_error) {
      problems.push('CODE_RUNNER_URL is not a URL');
    }
  }

  let token = false;
  const inline = present(env.CODE_RUNNER_TOKEN);
  const file = present(env.CODE_RUNNER_TOKEN_FILE);
  if (inline && file) problems.push('set CODE_RUNNER_TOKEN or CODE_RUNNER_TOKEN_FILE, not both');
  else if (inline) {
    const problem = tokenProblem(env.CODE_RUNNER_TOKEN, 'CODE_RUNNER_TOKEN');
    if (problem) problems.push(problem);
    else token = true;
  } else if (file) {
    // read once to check it, never kept: the run reads the file itself (A4b)
    let contents = null;
    try {
      const tokenPath = env.CODE_RUNNER_TOKEN_FILE.trim();
      if (fs.statSync(tokenPath).isFile()) contents = fs.readFileSync(tokenPath, 'utf8');
    } catch (_error) {
      contents = null;
    }
    const problem = contents === null
      ? 'CODE_RUNNER_TOKEN_FILE does not name a readable file'
      : tokenProblem(contents, 'CODE_RUNNER_TOKEN_FILE');
    if (problem) problems.push(problem);
    else token = true;
  } else {
    problems.push('CODE_RUNNER_TOKEN (or CODE_RUNNER_TOKEN_FILE) is not set');
  }
  return { configured: url !== null && token, url };
}

function chainFromEnv(env) {
  const network = present(env.DEPLOYMENT_NETWORK) ? env.DEPLOYMENT_NETWORK.trim() : null;
  let chainId = null;
  let chainIdReadable = true;
  if (present(env.NETWORK_CHAIN_ID)) {
    const text = env.NETWORK_CHAIN_ID.trim();
    if (/^[0-9]{1,15}$/.test(text)) chainId = Number(text);
    else chainIdReadable = false;
  }
  return { chainId, network, chainIdReadable };
}

/** Why dev trust may not run on this chain, or null when it may. */
function devTrustChainRefusal(chain) {
  if (chain.network && /mainnet/i.test(chain.network)) {
    return `dev trust is refused on Base mainnet (DEPLOYMENT_NETWORK=${chain.network})`;
  }
  if (!chain.chainIdReadable) return 'dev trust is refused: NETWORK_CHAIN_ID is not a chain id';
  if (chain.chainId === BASE_MAINNET_CHAIN_ID) {
    return `dev trust is refused on Base mainnet (NETWORK_CHAIN_ID=${BASE_MAINNET_CHAIN_ID})`;
  }
  if (chain.chainId === null) {
    return 'dev trust is refused: the chain is unknown (set NETWORK_CHAIN_ID to a test chain; an unknown chain counts as mainnet)';
  }
  if (!DEV_TRUST_CHAIN_IDS.includes(chain.chainId)) {
    return `dev trust is refused on chain ${chain.chainId}: it runs only on ${DEV_TRUST_CHAIN_IDS.join(' or ')}`;
  }
  return null;
}

function devKeysFromEnv(env) {
  const keys = (env.CODE_REVIEW_DEV_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean)
    .map((publicKey) => ({ publicKey }));
  if (keys.length === 0) return { keys, refusal: 'dev trust is refused: CODE_REVIEW_DEV_KEYS is empty' };
  try {
    // resolveTrust (inside validateAttestation) reads every key before anything else
    codeReview.validateAttestation(undefined, { trust: { dev: true, keys } });
  } catch (_error) {
    return { keys: [], refusal: 'dev trust is refused: CODE_REVIEW_DEV_KEYS holds a key @verdikta/common cannot read (base64 of a 32-byte Ed25519 public key)' };
  }
  return { keys, refusal: null };
}

function trustFromEnv(env, chain) {
  const requested = present(env.CODE_REVIEW_TRUST) ? env.CODE_REVIEW_TRUST.trim() : 'production';
  if (!TRUST_MODES.includes(requested)) {
    return { mode: 'unknown', devKeys: [], refused: `CODE_REVIEW_TRUST must be production or dev (got an unknown mode)` };
  }
  if (requested === 'production') return { mode: 'production', devKeys: [], refused: null };

  const chainRefusal = devTrustChainRefusal(chain);
  if (chainRefusal) return { mode: 'dev', devKeys: [], refused: chainRefusal };
  const { keys, refusal } = devKeysFromEnv(env);
  if (refusal) return { mode: 'dev', devKeys: [], refused: refusal };
  return { mode: 'dev', devKeys: keys, refused: null };
}

/**
 * Read the code-review configuration from an environment. Reads `env`, the
 * token file when one is named, and the @verdikta/common versions (or
 * `options.versions`, for tests).
 * @param {object} env
 * @param {{ versions?: { pinned: string|null, installed: string|null, aiNode: string|null } }} [options]
 * @returns {{ enabled: boolean, ready: boolean, runner: { configured: boolean, url: string|null },
 *   trust: { mode: string, devKeys: { publicKey: string }[], refused: string|null },
 *   chain: { chainId: number|null, network: string|null }, problems: string[] }}
 */
function codeReviewConfigFromEnv(env = {}, options = {}) {
  const problems = [];
  const enabled = typeof env.CODE_REVIEW_ENABLED === 'string' && env.CODE_REVIEW_ENABLED.trim().toLowerCase() === 'true';
  if (!enabled) problems.push('CODE_REVIEW_ENABLED is not true');

  const runnerProblems = [];
  const runner = runnerFromEnv(env, runnerProblems);
  if (enabled) problems.push(...runnerProblems);

  const versions = options.versions || readCommonVersions();
  const libraryProblems = commonVersionProblems(versions);
  if (enabled) problems.push(...libraryProblems);

  const chain = chainFromEnv(env);
  const trust = trustFromEnv(env, chain);
  if (trust.refused) problems.push(trust.refused);

  return {
    enabled,
    ready: enabled && runner.configured && libraryProblems.length === 0 && trust.refused === null,
    runner,
    trust,
    chain: { chainId: chain.chainId, network: chain.network },
    commonVersion: versions.installed,
    problems
  };
}

/**
 * What /health and /version show: modes, readiness and the reasons code mode
 * is refused. Never the runner URL or token.
 */
function describeCodeReviewConfig(config) {
  let trust = config.trust.mode;
  if (config.trust.refused) trust = config.trust.mode === 'dev' ? 'dev-refused' : 'refused';
  return {
    enabled: config.enabled,
    ready: config.ready,
    runnerConfigured: config.runner.configured,
    commonVersion: config.commonVersion,
    trust,
    devKeyCount: config.trust.devKeys.length,
    chainId: config.chain.chainId,
    network: config.chain.network,
    problems: [...config.problems]
  };
}

let current = null;

/** Re-read the configuration (startup, tests) and keep it for getCodeReviewConfig. */
function loadCodeReviewConfig(env = process.env) {
  current = Object.freeze(codeReviewConfigFromEnv(env));
  return current;
}

/** The configuration in force, read from process.env on first use. */
function getCodeReviewConfig() {
  return current || loadCodeReviewConfig(process.env);
}

/** True when attestations signed for dev trust are being accepted. */
function devTrustActive(config) {
  return config.trust.mode === 'dev' && config.trust.refused === null;
}

module.exports = {
  BASE_MAINNET_CHAIN_ID,
  DEV_TRUST_CHAIN_IDS,
  readCommonVersions,
  codeReviewConfigFromEnv,
  describeCodeReviewConfig,
  loadCodeReviewConfig,
  getCodeReviewConfig,
  devTrustActive
};
