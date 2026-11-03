'use strict';

const fs = require('fs');
const path = require('path');
const { codeReview } = require('@verdikta/common');
const { isLikelyCid } = require('./assertions');

const E2E_ROOT = path.join(__dirname, '..');
const DEFAULT_SCENARIOS = path.join(E2E_ROOT, 'scenarios', 'scenarios.json');

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Resolve a scenario's evidence CIDs. A scenario declares exactly one of:
 *   - `cid`: a literal CID
 *   - `cidFile`: a path, relative to the e2e root, containing a CID (e.g. one
 *     written by scripts/build-archive.js --pin)
 *   - `cids`: an array of CIDs for a multi-CID request (a bounty sends
 *     [evaluation package, hunter archive])
 * Returns the CID array, or null if a cidFile is declared but not yet present.
 */
function resolveCids(scenario) {
  if (Array.isArray(scenario.cids)) return scenario.cids.map((c) => c.trim());
  if (scenario.cid) return [scenario.cid];
  if (scenario.cidFile) {
    const p = path.resolve(E2E_ROOT, scenario.cidFile);
    if (fs.existsSync(p)) {
      const cid = fs.readFileSync(p, 'utf8').trim();
      return cid ? [cid] : null;
    }
    return null;
  }
  return null;
}

/**
 * The External Adapter's `data.cid` form of a request: CIDs joined by commas,
 * then `:<addendum>` when there is one. L2 sends this to /evaluate (prefixed
 * with the mode); L4 sends `cids` and `addendum` separately on chain.
 */
function adapterCid(cids, addendum) {
  return addendum ? `${cids.join(',')}:${addendum}` : cids.join(',');
}

/** The kinds of claim scenario e2e/src/l2/claim/run-claim.js knows. They build their own archives, so they name no CID. */
const CLAIM_KINDS = Object.freeze(['valid', 'gate-fail', 'text']);

const resolvedClaim = (s) => ({ ...s, cids: [], addendum: '', cid: '' });

/** An L4 claim scenario's `claim`, and the entry of the claim set it sends (makeClaimSet's names). */
const L4_CLAIM_ENTRIES = Object.freeze({ valid: 'valid', 'front-gate': 'outOfScope', 'runner-gate': 'editsSource' });
const CLAIM_OUTCOMES = codeReview.BUG_OUTCOMES.length;
/** ReputationAggregator.sol: a longer value reverts the request. */
const MAX_CID_BYTES = 100;
const MAX_ADDENDUM_BYTES = 1000;

function validateL4ClaimScenario(s) {
  const sources = ['cid', 'cidFile', 'cids', 'addendum'].filter((k) => s[k] !== undefined);
  if (sources.length) throw new Error(`Scenario "${s.id}" is an L4 claim scenario: its request comes from its claim set, so no ${sources.join(' or ')}`);
  if (!Object.keys(L4_CLAIM_ENTRIES).includes(s.claim)) throw new Error(`Scenario "${s.id}": "claim" must be one of ${Object.keys(L4_CLAIM_ENTRIES).join(', ')}`);
  if (typeof s.claimSet !== 'string' || s.claimSet === '') throw new Error(`Scenario "${s.id}": an L4 claim scenario names its "claimSet" file`);
  if (s.minOutcomes !== CLAIM_OUTCOMES) throw new Error(`Scenario "${s.id}": a claim has ${CLAIM_OUTCOMES} outcomes, so "minOutcomes" is ${CLAIM_OUTCOMES}`);
}

/**
 * A claim set as L4 will send it, or a throw naming what is wrong: nothing here reaches the
 * chain unread. Exported for scripts/build-l4-claims.js, which holds a new set to the same.
 * @param {object} value - a parsed claim-set.json
 * @returns {object} the same value
 */
function validateClaimSet(value) {
  const bad = (what) => new Error(`the claim set is not usable: ${what}`);
  if (!value || typeof value !== 'object' || value.version !== 1) throw bad('its version is not 1');
  const cidIn = (cid, name) => {
    if (!isLikelyCid(cid) || Buffer.byteLength(cid) > MAX_CID_BYTES) throw bad(`${name} is not a CID the aggregator takes`);
  };
  cidIn(value.listingCid, 'listingCid');
  for (const key of Object.values(L4_CLAIM_ENTRIES)) {
    const entry = value.claims && value.claims[key];
    if (!entry) throw bad(`it has no entry for the ${key === 'valid' ? 'valid' : key} claim`);
    cidIn(entry.cid, `claims.${key}.cid`);
    if (entry.cid === value.listingCid) throw bad(`claims.${key}.cid is the listing's CID`);
    if (typeof entry.addendum !== 'string' || Buffer.byteLength(entry.addendum) > MAX_ADDENDUM_BYTES) {
      throw bad(`claims.${key}.addendum is over the aggregator's ${MAX_ADDENDUM_BYTES} bytes`);
    }
    const parsed = codeReview.parseAddendum(entry.addendum);
    if (!parsed.ok || parsed.dispute !== null) throw bad(`claims.${key}.addendum is not one disclosure line`);
  }
  return value;
}

/**
 * The request of an L4 claim scenario, from its claim set: [listing, claim] and the
 * disclosure line, as StakeAttestation.reveal composes them (design §13.3). Any other
 * scenario comes back as it is.
 *
 * Apart from loadScenarios so that L4 decides the class first: a run on the wrong class is
 * refused for that, whether or not the claim set has been pinned yet.
 *
 * @param {object} scenario
 * @returns {object}
 */
function resolveL4Claim(scenario) {
  if (scenario.suite !== 'l4-claim') return scenario;
  const file = path.resolve(E2E_ROOT, scenario.claimSet);
  if (!fs.existsSync(file)) {
    throw new Error(`Scenario "${scenario.id}" has no claim set at ${file}: build and pin it first with scripts/build-l4-claims.js (e2e/README.md)`);
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_error) {
    throw new Error(`Scenario "${scenario.id}": ${file} is not JSON`);
  }
  let set;
  try {
    set = validateClaimSet(value);
  } catch (error) {
    throw new Error(`Scenario "${scenario.id}", ${file}: ${error.message}`);
  }
  const entry = set.claims[L4_CLAIM_ENTRIES[scenario.claim]];
  const cids = [set.listingCid, entry.cid];
  return { ...scenario, cids, addendum: entry.addendum, cid: adapterCid(cids, entry.addendum) };
}

function validateClaimScenario(s) {
  const sources = ['cid', 'cidFile', 'cids'].filter((k) => s[k] !== undefined);
  if (sources.length) throw new Error(`Scenario "${s.id}" is a claim scenario: it builds its own archives, so no ${sources.join(' or ')}`);
  if (!CLAIM_KINDS.includes(s.claim)) throw new Error(`Scenario "${s.id}": "claim" must be one of ${CLAIM_KINDS.join(', ')}`);
  if (!Array.isArray(s.modes) || s.modes.length === 0) throw new Error(`Scenario "${s.id}": a claim scenario lists its modes`);
}

function validateScenario(s, i) {
  if (!s.id) throw new Error(`Scenario at index ${i} is missing "id"`);
  if (s.suite !== undefined || s.claim !== undefined) {
    if (s.suite === 'l4-claim') validateL4ClaimScenario(s);
    else if (s.suite === 'claim') validateClaimScenario(s);
    else throw new Error(`Scenario "${s.id}": the suites are "claim" and "l4-claim"`);
    return;
  }
  const sources = ['cid', 'cidFile', 'cids'].filter((k) => s[k] !== undefined);
  if (sources.length === 0) throw new Error(`Scenario "${s.id}" is missing "cid", "cids" or "cidFile"`);
  if (sources.length > 1) throw new Error(`Scenario "${s.id}" gives ${sources.join(' and ')}; use exactly one`);
  if (s.cids !== undefined && !(Array.isArray(s.cids) && s.cids.length && s.cids.every(isNonEmptyString))) {
    throw new Error(`Scenario "${s.id}": "cids" must be a non-empty array of CID strings`);
  }
  if (s.addendum !== undefined && typeof s.addendum !== 'string') {
    throw new Error(`Scenario "${s.id}": "addendum" must be a string`);
  }
  if (s.manualOnly !== undefined && typeof s.manualOnly !== 'boolean') {
    throw new Error(`Scenario "${s.id}": "manualOnly" must be true or false`);
  }
}

/**
 * Load and validate E2E scenarios.
 *
 * A scenario with `"manualOnly": true` (e.g. one whose archive names a paid
 * jury) never runs in a full-suite run — the nightly L4 runs every other
 * scenario — and runs only when named explicitly by a caller that allows it
 * (L4's --scenario / L4_SCENARIO). Naming one elsewhere (L2) is an error.
 *
 * Each returned scenario carries `cids` (array), `addendum` (string, default
 * '') and `cid` (the adapter's comma-joined form, see adapterCid).
 *
 * @param {string} [file] - path to a scenarios JSON file
 * @param {string[]} [ids] - optional subset of scenario ids to keep
 * A scenario with `"suite": "claim"` needs Docker and the local harness, so a full run
 * (L2's, which needs Pinata, or the nightly L4) leaves it out. `suite: 'claim'` runs that
 * suite and nothing else; naming one runs it where `allowClaim` is set (L2); L4 never does.
 *
 * A scenario with `"suite": "l4-claim"` is a real request on the canary class. No full run
 * holds one, whatever the class. Naming one runs it where `allowL4Claim` is set (L4), which
 * then holds it to class 5555 (src/l4/helpers.js) before reading its claim set (resolveL4Claim).
 *
 * @param {{ allowManualOnly?: boolean, allowClaim?: boolean, allowL4Claim?: boolean, suite?: string }} [opts]
 * @returns {Array<object>}
 */
function loadScenarios(file = DEFAULT_SCENARIOS, ids = null, { allowManualOnly = false, allowClaim = false, allowL4Claim = false, suite = null } = {}) {
  if (!fs.existsSync(file)) {
    throw new Error(`Scenarios file not found: ${file}`);
  }
  let scenarios;
  try {
    scenarios = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON in scenarios file ${file}: ${err.message}`);
  }
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error(`Scenarios file must be a non-empty array: ${file}`);
  }

  scenarios.forEach(validateScenario);

  if (suite !== null) {
    if (ids && ids.length) throw new Error('Name scenarios or a suite, not both');
    if (suite !== 'claim') throw new Error(`Unknown suite: ${suite}`);
    const members = scenarios.filter((s) => s.suite === 'claim');
    if (members.length === 0) throw new Error('The claim suite has no scenarios in this file');
    return members.map(resolvedClaim);
  }

  const explicit = Boolean(ids && ids.length);
  if (explicit) {
    const wanted = new Set(ids);
    scenarios = scenarios.filter((s) => wanted.has(s.id));
    const found = new Set(scenarios.map((s) => s.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`Unknown scenario id(s): ${missing.join(', ')}`);
    const manual = scenarios.filter((s) => s.manualOnly === true);
    if (manual.length && !allowManualOnly) {
      throw new Error(`Scenario(s) ${manual.map((s) => `"${s.id}"`).join(', ')} are manualOnly: run them with L4 (--scenario / L4_SCENARIO).`);
    }
    const claims = scenarios.filter((s) => s.suite === 'claim');
    if (claims.length && !allowClaim) {
      throw new Error(`Scenario(s) ${claims.map((s) => `"${s.id}"`).join(', ')} are claim scenarios: run them with L2 (--scenario or --suite claim).`);
    }
    const l4Claims = scenarios.filter((s) => s.suite === 'l4-claim');
    if (l4Claims.length && !allowL4Claim) {
      throw new Error(`Scenario(s) ${l4Claims.map((s) => `"${s.id}"`).join(', ')} are L4 claim scenarios: run them with L4 on the canary class (--scenario, --class-id 5555).`);
    }
  } else {
    scenarios = scenarios.filter((s) => s.suite === undefined);
    scenarios = scenarios.filter((s) => {
      if (s.manualOnly !== true) return true;
      console.warn(`[scenarios] skipping "${s.id}": manualOnly (run it by name with L4 --scenario / L4_SCENARIO).`);
      return false;
    });
  }

  // Resolve CIDs. A cidFile that isn't present yet (archive not pinned):
  //   - hard error if the scenario was requested explicitly by id
  //   - skip-with-warning during a full-suite run
  const resolved = [];
  for (const s of scenarios) {
    if (s.suite !== undefined) {
      resolved.push(resolvedClaim(s));
      continue;
    }
    const cids = resolveCids(s);
    if (cids) {
      const addendum = s.addendum || '';
      resolved.push({ ...s, cids, addendum, cid: adapterCid(cids, addendum) });
    } else if (explicit) {
      throw new Error(`Scenario "${s.id}" has no resolvable CID (cidFile "${s.cidFile}" not found — pin the archive first).`);
    } else {
      console.warn(`[scenarios] skipping "${s.id}": cidFile "${s.cidFile}" not found (pin the canonical archive to enable it).`);
    }
  }

  if (resolved.length === 0) {
    throw new Error('No runnable scenarios (every scenario was manualOnly or had an unresolved cidFile). Pin the canonical archive or add a scenario with a literal "cid".');
  }
  return resolved;
}

module.exports = { loadScenarios, resolveL4Claim, validateClaimSet, adapterCid, DEFAULT_SCENARIOS };
