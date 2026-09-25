'use strict';

/**
 * Pure helpers for the L4 (live testnet) runner: class selection and the
 * self-reported arbiter versions found in justifications. No network, no
 * process state, so they are unit-tested in src/l4/__tests__.
 */

const A = require('../assertions');

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
function resolveClassId({ cli, env, config } = {}) {
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
    return Number(text);
  }
  throw new Error('No class id: pass --class-id, set L4_CLASS_ID, or set config.l4.classId');
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
 * ETH to attach to a request. The aggregator funds a round from the caller's
 * ethOwed credit first (ReputationAggregator._fundFromCredit) and needs
 * msg.value only for the shortfall; anything more is refunded as further
 * credit at settlement. Sending the full maxTotalFee every run therefore moves
 * the wallet's ETH into credit that is never spent.
 *
 * @param {bigint|number|string} required - maxTotalFee(maxOracleFee), in wei
 * @param {bigint|number|string} credit - ethOwed(wallet), in wei
 * @returns {{ value: bigint, fromCredit: bigint }}
 */
function requestFunding(required, credit) {
  const req = BigInt(required);
  const cred = BigInt(credit);
  const fromCredit = cred < req ? cred : req;
  return { value: req - fromCredit, fromCredit };
}

module.exports = {
  gasLimitFor,
  requestFunding,
  resolveClassId,
  splitJustificationCids,
  arbiterVersion,
  releaseCommit,
  commitMatches,
  versionChecks,
};
