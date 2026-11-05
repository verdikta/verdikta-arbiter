/**
 * @fileoverview The canary fault switch's environment, read here and nowhere else (decision D9).
 *
 *   VERDIKTA_CANARY_FAULTS=<claim CID>=<fault>[,…]  the plan: exact claims, never a mode
 *   VERDIKTA_CANARY_FAULT_KEY=<32+ printable>       signs what the EA asks of the AI Node, which holds the same key
 *   VERDIKTA_CANARY_RPC_URL=<http(s) URL>           a Base Sepolia RPC, to measure each request
 *   NETWORK_CHAIN_ID=84532                          this arbiter's chain, as the installer names it
 *   DEPLOYMENT_NETWORK                              must not name mainnet
 *   OPERATOR_ADDR                                   this arbiter's operator
 *
 * With no plan the switch is off and nothing else here matters. With a plan and anything
 * wrong it is refused, and acts on nothing: a value it cannot read is a reason to refuse,
 * never a guess. No install or upgrade path sets these; the runbook's G2 step does, by hand.
 */

const { ethers } = require('ethers');
const { CANARY_CHAIN_ID, FAULTS } = require('./constants');

const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/;
const KEY_RULE = /^[\x21-\x7e]{32,}$/;

const present = (value) => typeof value === 'string' && value.trim() !== '';

/** The plan as a Map, or null when any entry of it cannot be read: a bad entry refuses the whole plan. */
function readPlan(text) {
  const plan = new Map();
  for (const entry of text.trim().split(',')) {
    const at = entry.indexOf('=');
    if (at <= 0) return null;
    const cid = entry.slice(0, at).trim();
    const fault = entry.slice(at + 1).trim();
    if (!CID.test(cid) || !Object.prototype.hasOwnProperty.call(FAULTS, fault) || plan.has(cid)) return null;
    plan.set(cid, fault);
  }
  return plan;
}

function chainProblem(env) {
  if (present(env.DEPLOYMENT_NETWORK) && /mainnet/i.test(env.DEPLOYMENT_NETWORK)) {
    return 'DEPLOYMENT_NETWORK names mainnet: the switch runs only on Base Sepolia';
  }
  if (!present(env.NETWORK_CHAIN_ID)) return 'NETWORK_CHAIN_ID is not set: an unknown chain counts as mainnet';
  const text = env.NETWORK_CHAIN_ID.trim();
  if (!/^[0-9]{1,15}$/.test(text)) return 'NETWORK_CHAIN_ID is not a chain id';
  if (Number(text) !== CANARY_CHAIN_ID) return `NETWORK_CHAIN_ID is ${text}: the switch runs only on ${CANARY_CHAIN_ID}`;
  return null;
}

function rpcUrlOf(env, problems) {
  if (!present(env.VERDIKTA_CANARY_RPC_URL)) {
    problems.push('VERDIKTA_CANARY_RPC_URL is not set');
    return null;
  }
  try {
    const url = new URL(env.VERDIKTA_CANARY_RPC_URL.trim());
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch (_error) {
    // reported below
  }
  problems.push('VERDIKTA_CANARY_RPC_URL is not an http(s) URL');
  return null;
}

function operatorOf(env, problems) {
  if (!present(env.OPERATOR_ADDR)) {
    problems.push('OPERATOR_ADDR is not set');
    return null;
  }
  try {
    return ethers.utils.getAddress(env.OPERATOR_ADDR.trim());
  } catch (_error) {
    problems.push('OPERATOR_ADDR is not an address');
    return null;
  }
}

const off = () => ({ state: 'off', plan: new Map(), problems: [], key: null, rpcUrl: null, operator: null, counts: { applied: 0, refused: 0, lastRefusal: null } });

/**
 * @param {object} env
 * @returns {{ state: 'off'|'armed'|'refused', plan: Map<string, string>, problems: string[],
 *   key: string|null, rpcUrl: string|null, operator: string|null, counts: object }}
 */
function canaryFaultConfigFromEnv(env = {}) {
  if (!present(env.VERDIKTA_CANARY_FAULTS)) return off();
  const problems = [];
  const plan = readPlan(env.VERDIKTA_CANARY_FAULTS);
  if (!plan) problems.push(`VERDIKTA_CANARY_FAULTS must be <claim CID>=<fault>,… with each fault one of ${Object.keys(FAULTS).join(', ')}`);
  const chain = chainProblem(env);
  if (chain) problems.push(chain);
  const key = present(env.VERDIKTA_CANARY_FAULT_KEY) ? env.VERDIKTA_CANARY_FAULT_KEY.trim() : null;
  if (!key || !KEY_RULE.test(key)) problems.push('VERDIKTA_CANARY_FAULT_KEY must be 32 or more printable characters with no spaces');
  const rpcUrl = rpcUrlOf(env, problems);
  const operator = operatorOf(env, problems);
  if (problems.length > 0) return { ...off(), state: 'refused', plan: plan || new Map(), problems };
  return { state: 'armed', plan, problems, key, rpcUrl, operator, counts: { applied: 0, refused: 0, lastRefusal: null } };
}

let current = null;

/** Re-read the environment (startup, tests) and keep it for getCanaryFaultConfig. */
function loadCanaryFaultConfig(env = process.env) {
  current = canaryFaultConfigFromEnv(env);
  return current;
}

/** The configuration in force, read from process.env on first use: after dotenv has loaded. */
function getCanaryFaultConfig() {
  return current || loadCanaryFaultConfig(process.env);
}

module.exports = { canaryFaultConfigFromEnv, loadCanaryFaultConfig, getCanaryFaultConfig };
