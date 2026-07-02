'use strict';

const fs = require('fs');
const path = require('path');

const E2E_ROOT = path.join(__dirname, '..');
const DEFAULT_SCENARIOS = path.join(E2E_ROOT, 'scenarios', 'scenarios.json');

/**
 * Resolve a scenario's CID. A scenario may declare either `cid` (a literal CID)
 * or `cidFile` (a path, relative to the e2e root, containing a CID — e.g. one
 * written by scripts/build-archive.js --pin). Returns the CID string or null if
 * a cidFile is declared but not yet present.
 */
function resolveCid(scenario) {
  if (scenario.cid) return scenario.cid;
  if (scenario.cidFile) {
    const p = path.resolve(E2E_ROOT, scenario.cidFile);
    if (fs.existsSync(p)) {
      const cid = fs.readFileSync(p, 'utf8').trim();
      return cid || null;
    }
    return null;
  }
  return null;
}

/**
 * Load and validate E2E scenarios.
 * @param {string} [file] - path to a scenarios JSON file
 * @param {string[]} [ids] - optional subset of scenario ids to keep
 * @returns {Array<object>}
 */
function loadScenarios(file = DEFAULT_SCENARIOS, ids = null) {
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

  scenarios.forEach((s, i) => {
    if (!s.id) throw new Error(`Scenario at index ${i} is missing "id"`);
    if (!s.cid && !s.cidFile) throw new Error(`Scenario "${s.id}" is missing "cid" or "cidFile"`);
  });

  const explicit = Boolean(ids && ids.length);
  if (explicit) {
    const wanted = new Set(ids);
    scenarios = scenarios.filter((s) => wanted.has(s.id));
    const found = new Set(scenarios.map((s) => s.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`Unknown scenario id(s): ${missing.join(', ')}`);
  }

  // Resolve CIDs. A cidFile that isn't present yet (archive not pinned):
  //   - hard error if the scenario was requested explicitly by id
  //   - skip-with-warning during a full-suite run
  const resolved = [];
  for (const s of scenarios) {
    const cid = resolveCid(s);
    if (cid) {
      resolved.push({ ...s, cid });
    } else if (explicit) {
      throw new Error(`Scenario "${s.id}" has no resolvable CID (cidFile "${s.cidFile}" not found — pin the archive first).`);
    } else {
      console.warn(`[scenarios] skipping "${s.id}": cidFile "${s.cidFile}" not found (pin the canonical archive to enable it).`);
    }
  }

  if (resolved.length === 0) {
    throw new Error('No runnable scenarios (all CIDs unresolved). Pin the canonical archive or add a scenario with a literal "cid".');
  }
  return resolved;
}

module.exports = { loadScenarios, DEFAULT_SCENARIOS };
