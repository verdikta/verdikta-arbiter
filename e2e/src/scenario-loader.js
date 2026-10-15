'use strict';

const fs = require('fs');
const path = require('path');

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

function validateScenario(s, i) {
  if (!s.id) throw new Error(`Scenario at index ${i} is missing "id"`);
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
 * @param {{ allowManualOnly?: boolean }} [opts] - true for L4
 * @returns {Array<object>}
 */
function loadScenarios(file = DEFAULT_SCENARIOS, ids = null, { allowManualOnly = false } = {}) {
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
  } else {
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

module.exports = { loadScenarios, adapterCid, DEFAULT_SCENARIOS };
