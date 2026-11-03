/**
 * @fileoverview The canary fault switch on the External Adapter (decision D9; design §11, §18).
 *
 * For the canary conditions of §11 on class 5555: a near-limit juror, a provider timeout with
 * retry, a slow justifier, a cancellation. It is off unless its flag is set (config.js, the
 * one place the environment is read), and it acts only when all of this holds:
 *
 *  - the flag names this exact claim's CID (a real claim's never is, and it gets no chain read);
 *  - the configuration says Base Sepolia, with a key and an RPC URL;
 *  - the chain says this request is for class 5555, from the request's own calldata, and that
 *    this operator and job serve it (measure.js).
 *
 * What it does then is mint a directive for the AI Node, signed with a key the AI Node holds
 * too. The AI Node waits: it holds a real answer or starts a real call late, inside the raced
 * work, so a stage's deadline still ends it. Nothing here sees a score, a report or a gate: the
 * run has settled for the jury before this is asked, and its answer is only the directive.
 */

const crypto = require('crypto');
const { CANARY_CLASS_ID, CANARY_CHAIN_ID, CANARY_AGGREGATOR, FAULTS } = require('./constants');
const { canaryFaultConfigFromEnv, loadCanaryFaultConfig, getCanaryFaultConfig } = require('./config');
const { measureRefusal } = require('./measure');

/** HMAC-SHA256 over the action and what it binds to. ai-node/src/lib/code-review/canary-fault.ts checks it. */
function directiveMac(key, action, bcid, reportSha256) {
  return crypto.createHmac('sha256', key).update(`verdikta-canary-fault/1\n${action}\n${bcid}\n${reportSha256}`).digest('hex');
}

/**
 * What the switch says about this request, for a claim that reached the jury.
 *
 * @param {{ bcid: string, aggId?: string, jobId?: string }} request
 * @param {{ config?: object, logger?: object, runTag?: string }} [options]
 * @returns {Promise<null|{ fault: string, refused: string|null, directiveFor: (attempt: number, binding: { bcid: string, reportSha256: string }) => ({ action: string, mac: string }|null) }>}
 *   null when the switch has nothing to say: off, refused, or a claim the plan does not name
 */
async function faultForRequest({ bcid, aggId, jobId }, options = {}) {
  const config = options.config || getCanaryFaultConfig();
  const logger = options.logger || { warn() {} };
  const runTag = options.runTag || '';
  if (config.state !== 'armed') return null;
  const fault = config.plan.get(bcid);
  if (!fault) return null;

  const refused = await measureRefusal({ rpcUrl: config.rpcUrl, operator: config.operator, aggId, jobId });
  if (refused) {
    config.counts.refused += 1;
    config.counts.lastRefusal = refused;
    logger.warn(`${runTag} canary fault ${fault} refused for ${bcid}: ${refused}; the claim is judged normally`);
    return { fault, refused, directiveFor: () => null };
  }
  config.counts.applied += 1;
  logger.warn(`${runTag} CANARY FAULT ${fault} applies to ${bcid}: a request for class ${CANARY_CLASS_ID}, measured`);
  const { action, firstAttemptOnly } = FAULTS[fault];
  return {
    fault,
    refused: null,
    directiveFor: (attempt, binding) => {
      if (firstAttemptOnly && attempt > 1) return null;
      return { action, mac: directiveMac(config.key, action, binding.bcid, binding.reportSha256) };
    }
  };
}

/** What /health and /version show. Never the key, the URL or the plan's CIDs. */
function describeCanaryFault(config = getCanaryFaultConfig()) {
  return {
    state: config.state,
    namedClaims: config.plan.size,
    applied: config.counts.applied,
    refused: config.counts.refused,
    lastRefusal: config.counts.lastRefusal,
    problems: [...config.problems]
  };
}

/** What every justification's arbiter block carries: the state alone. */
function canaryFaultBlock(config = getCanaryFaultConfig()) {
  return { state: config.state };
}

module.exports = {
  CANARY_CLASS_ID,
  CANARY_CHAIN_ID,
  CANARY_AGGREGATOR,
  FAULTS,
  directiveMac,
  canaryFaultConfigFromEnv,
  loadCanaryFaultConfig,
  getCanaryFaultConfig,
  faultForRequest,
  describeCanaryFault,
  canaryFaultBlock
};
