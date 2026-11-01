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
 * Trust (build plan assumption A6): production trust verifies against
 * @verdikta/common's trusted-builder set and nothing else. CODE_REVIEW_TRUST=dev
 * adds the caller-supplied dev keys for attestations signed for dev trust; it
 * is refused, and code mode with it, unless the chain is positively a test
 * chain (Base Sepolia or a local node). An unknown chain counts as mainnet.
 */

const fs = require('fs');
const { codeReview } = require('@verdikta/common');

const BASE_MAINNET_CHAIN_ID = 8453;
/** Chains dev trust may run on: Base Sepolia and a local Hardhat/Anvil node. */
const DEV_TRUST_CHAIN_IDS = Object.freeze([84532, 31337]);
const TRUST_MODES = Object.freeze(['production', 'dev']);

const present = (value) => typeof value === 'string' && value.trim() !== '';

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
  else if (inline) token = true;
  else if (file) {
    if (fs.existsSync(env.CODE_RUNNER_TOKEN_FILE.trim())) token = true;
    else problems.push('CODE_RUNNER_TOKEN_FILE names a file that does not exist');
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
 * Read the code-review configuration from an environment. Pure: reads only
 * `env` (and checks that a token file exists).
 * @param {object} env
 * @returns {{ enabled: boolean, ready: boolean, runner: { configured: boolean, url: string|null },
 *   trust: { mode: string, devKeys: { publicKey: string }[], refused: string|null },
 *   chain: { chainId: number|null, network: string|null }, problems: string[] }}
 */
function codeReviewConfigFromEnv(env = {}) {
  const problems = [];
  const enabled = typeof env.CODE_REVIEW_ENABLED === 'string' && env.CODE_REVIEW_ENABLED.trim().toLowerCase() === 'true';
  if (!enabled) problems.push('CODE_REVIEW_ENABLED is not true');

  const runnerProblems = [];
  const runner = runnerFromEnv(env, runnerProblems);
  if (enabled) problems.push(...runnerProblems);

  const chain = chainFromEnv(env);
  const trust = trustFromEnv(env, chain);
  if (trust.refused) problems.push(trust.refused);

  return {
    enabled,
    ready: enabled && runner.configured && trust.refused === null,
    runner,
    trust,
    chain: { chainId: chain.chainId, network: chain.network },
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
  codeReviewConfigFromEnv,
  describeCodeReviewConfig,
  loadCodeReviewConfig,
  getCodeReviewConfig,
  devTrustActive
};
