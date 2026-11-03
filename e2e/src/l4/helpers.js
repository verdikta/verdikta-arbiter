'use strict';

/**
 * Pure helpers for the L4 (live testnet) runner: class selection, request
 * arguments and the self-reported arbiter versions found in justifications. No network, no
 * process state, so they are unit-tested in src/l4/__tests__.
 */

const A = require('../assertions');

/**
 * The canary class and its chain (docs/release-runbook.md, §3b): arbiters we control and
 * upgrade first, on Base Sepolia. Constants, not config: nothing a run reads can move them.
 */
const CANARY_CLASS_ID = 5555;
const CANARY_CHAIN_ID = 84532;

/** The addendum's machine lines (external-adapter/src/codeReview/addendum.js), as they mark a claim's request. */
const MACHINE_LINE = /verdikta-(?:disclosure|dispute)/i;

/**
 * Must this scenario stay on the canary class? An L4 claim scenario must, and so must any
 * scenario in any file that carries a claim's machine line. (A plain scenario naming a listing
 * with no such line cannot be told without fetching its archives, which the nightly must not
 * start doing. The EA's disclosure gate settles that one INVALID, with no runner and no model.) Nothing on an arbiter stops a
 * claim on another class (the bridge does not tell the EA the class), so a claim on class 128
 * would spend real money on real arbiters.
 */
function isCanaryOnly(scenario) {
  if (scenario.suite === 'l4-claim') return true;
  // In the addendum, or written into a CID field in the adapter's `cids:addendum` form.
  return [scenario.addendum, scenario.cid, ...(Array.isArray(scenario.cids) ? scenario.cids : [])]
    .some((text) => typeof text === 'string' && MACHINE_LINE.test(text));
}

/** The class and where it came from: `--class-id`, then `L4_CLASS_ID`, then the config. */
function pickClass({ cli, env, config } = {}) {
  const candidates = [
    ['--class-id', cli],
    ['L4_CLASS_ID', env],
    ['config.l4.classId', config],
  ];
  for (const [source, value] of candidates) {
    if (value === undefined || value === null || String(value).trim() === '') continue;
    const text = String(value).trim();
    if (!/^\d+$/.test(text) || Number(text) > Number.MAX_SAFE_INTEGER) {
      throw new Error(`Invalid class id from ${source}: "${value}" (expected a non-negative integer)`);
    }
    return { classId: Number(text), source };
  }
  throw new Error('No class id: pass --class-id, set L4_CLASS_ID, or set config.l4.classId');
}

/**
 * Resolve the class the on-chain request is made for.
 * Precedence: CLI `--class-id`, then `L4_CLASS_ID` in the environment, then
 * `config.l4.classId`. The value must be a non-negative integer (uint64 on
 * chain; anything beyond Number.MAX_SAFE_INTEGER is rejected rather than
 * silently rounded).
 *
 * @param {{ cli?: any, env?: any, config?: any }} sources
 * @returns {number}
 */
function resolveClassId(sources) {
  return pickClass(sources).classId;
}

const named = (scenarios) => scenarios.filter(isCanaryOnly).map((s) => `"${s.id}"`).join(', ');

/**
 * The class of this run, or a refusal. The one place L4 resolves it. A claim scenario on
 * anything but the canary class is refused rather than moved there: a run that silently went
 * to 5555 would hide a mistyped dispatch, and the default is 128. It refuses the whole run,
 * so a text scenario named beside a claim is not sent either.
 *
 * @param {{ cli?: any, env?: any, config?: any, scenarios?: object[] }} o
 * @returns {number}
 */
function resolveRunClass({ cli, env, config, scenarios = [] } = {}) {
  const { classId, source } = pickClass({ cli, env, config });
  if (scenarios.some(isCanaryOnly) && classId !== CANARY_CLASS_ID) {
    throw new Error(`Refused: ${named(scenarios)} run only on the canary class ${CANARY_CLASS_ID}, and this run resolved to class ${classId} (from ${source}). `
      + `A claim on another class would spend real money on real arbiters. Name the class: --class-id ${CANARY_CLASS_ID}.`);
  }
  return classId;
}

/** A claim run's chain, measured: the canary class is registered on Base Sepolia alone (runbook §3b). */
function assertCanaryChain(scenarios, chainId) {
  if (scenarios.some(isCanaryOnly) && BigInt(chainId) !== BigInt(CANARY_CHAIN_ID)) {
    throw new Error(`Refused: ${named(scenarios)} run only on Base Sepolia (chain ${CANARY_CHAIN_ID}), and this RPC is chain ${chainId}.`);
  }
}

/** A claim run is a release gate, and one that does not say which build it is judging answers nothing. */
function assertVersionsNamed(scenarios, { expectCommon, expectRelease } = {}) {
  if (!scenarios.some(isCanaryOnly)) return;
  const blank = (value) => value === undefined || value === null || String(value).trim() === '';
  const missing = [...(blank(expectCommon) ? ['--expect-common'] : []), ...(blank(expectRelease) ? ['--expect-release'] : [])];
  if (missing.length > 0) {
    throw new Error(`Refused: ${named(scenarios)} are a release gate, and need ${missing.join(' and ')} (or L4_EXPECT_COMMON / L4_EXPECT_RELEASE).`);
  }
}

/** The aggregator returns the revealing oracles' justification CIDs joined by commas. */
function splitJustificationCids(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * The `arbiter` block an External Adapter embeds in every justification
 * (external-adapter/src/utils/versionInfo.js). Pre-versioning arbiters have
 * none: every field is then null.
 */
function arbiterVersion(justification) {
  const block = justification && typeof justification === 'object' &&
    justification.arbiter && typeof justification.arbiter === 'object'
    ? justification.arbiter
    : {};
  const pick = (key) => (block[key] === undefined ? null : block[key]);
  return {
    adapter: pick('adapter'),
    aiNode: pick('aiNode'),
    verdiktaCommon: pick('verdiktaCommon'),
    release: pick('release'),
  };
}

/** `release` stamps look like "b9a58e2 2026-07-06T21:20:25Z"; keep the commit. */
function releaseCommit(release) {
  if (!release) return null;
  const commit = String(release).trim().split(/\s+/)[0];
  return commit || null;
}

/** Either side may be the short form: "b9a58e2" matches "b9a58e2f…" and vice versa. */
function commitMatches(reported, expected) {
  if (!reported || !expected) return false;
  const a = String(reported).toLowerCase();
  const b = String(expected).toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

const shortCid = (cid) => `${String(cid).slice(0, 8)}…`;

function describe(report) {
  if (!report.version) return `${shortCid(report.cid)}: fetch failed`;
  const v = report.version;
  return `${shortCid(report.cid)}: common=${v.verdiktaCommon || '?'} adapter=${v.adapter || '?'} release=${releaseCommit(v.release) || '?'}`;
}

/**
 * Version checks for one fulfilled request.
 *
 * `arbiter.versions` fails only when a justification could not be fetched at
 * all — an arbiter that predates version reporting is shown as "?" but does
 * not fail the run. The strict checks exist only when an expectation is given,
 * which is what the testnet canary gate uses: every revealing arbiter must
 * report the build that is about to go to mainnet.
 *
 * @param {Array<{cid: string, version: object|null}>} reports - one per justification CID
 * @param {{ expectCommon?: string, expectRelease?: string }} [expect]
 * @returns {Array<{ name: string, ok: boolean, detail: string }>}
 */
function versionChecks(reports, expect = {}) {
  const checks = [];
  const summary = reports.map(describe).join('; ') || 'no justification CIDs';
  checks.push(A.assert(
    'arbiter.versions',
    reports.length > 0 && reports.every((r) => r.version !== null),
    summary
  ));

  const expectCommon = expect.expectCommon && String(expect.expectCommon).trim();
  if (expectCommon) {
    const bad = reports.filter((r) => !r.version || r.version.verdiktaCommon !== expectCommon);
    checks.push(A.assert(
      'arbiter.verdiktaCommon===expected',
      reports.length > 0 && bad.length === 0,
      bad.length === 0
        ? `all ${reports.length} report ${expectCommon}`
        : `expected ${expectCommon}; mismatched: ${bad.map(describe).join('; ')}`
    ));
  }

  const expectRelease = expect.expectRelease && String(expect.expectRelease).trim();
  if (expectRelease) {
    const bad = reports.filter((r) => !r.version || !commitMatches(releaseCommit(r.version.release), expectRelease));
    checks.push(A.assert(
      'arbiter.release===expected',
      reports.length > 0 && bad.length === 0,
      bad.length === 0
        ? `all ${reports.length} report ${expectRelease}`
        : `expected ${expectRelease}; mismatched: ${bad.map(describe).join('; ')}`
    ));
  }
  return checks;
}

/**
 * Gas limit for the request transaction: the node's estimate plus 30 %
 * headroom. Oracle selection iterates the whole keeper registry, so the cost
 * grows as identities register — the old fixed 3,000,000 limit ran out of gas
 * once Base Sepolia reached 30 identities (needs ~3.07M for class 5555, ~3.11M
 * for class 128). Falls back to the configured limit when estimation failed.
 *
 * @param {bigint|number|null|undefined} estimate
 * @param {bigint|number} fallback
 * @returns {bigint}
 */
function gasLimitFor(estimate, fallback) {
  const fb = BigInt(fallback);
  if (estimate === null || estimate === undefined) return fb;
  const est = BigInt(estimate);
  if (est <= 0n) return fb;
  return (est * 13n) / 10n;
}

/**
 * Arguments for `requestAIEvaluationWithApproval(cids, addendumText, alpha,
 * maxOracleFee, estimatedBaseCost, maxFeeScaling, requestedClass)`. A loaded
 * scenario carries its CID array (one entry, or e.g. a bounty's [evaluation
 * package, hunter archive]) and its addendum, sent exactly as a client would.
 *
 * @param {{ cids?: string[], cid?: string, addendum?: string }} scenario
 * @param {{ alpha, maxOracleFee, estimatedBaseCost, maxFeeScaling }} fees - config.l4.fees
 * @param {number} classId
 * @returns {Array}
 */
function requestArgs(scenario, fees, classId) {
  const cids = Array.isArray(scenario.cids) && scenario.cids.length ? [...scenario.cids] : [scenario.cid];
  const { alpha, maxOracleFee, estimatedBaseCost, maxFeeScaling } = fees;
  return [cids, scenario.addendum || '', alpha, maxOracleFee, estimatedBaseCost, maxFeeScaling, classId];
}

module.exports = {
  CANARY_CLASS_ID,
  CANARY_CHAIN_ID,
  isCanaryOnly,
  resolveRunClass,
  assertCanaryChain,
  assertVersionsNamed,
  gasLimitFor,
  requestArgs,
  resolveClassId,
  splitJustificationCids,
  arbiterVersion,
  releaseCommit,
  commitMatches,
  versionChecks,
};
