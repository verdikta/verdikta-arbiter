const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const Hash = require('ipfs-only-hash');
const { codeReview } = require('@verdikta/common');
const { buildCodeReviewAiRequest } = require('../../external-adapter/src/codeReview/aiRequest');

/**
 * The `claim` scenario type: a claim evaluation sent to the AI Node exactly as the External
 * Adapter sends it (design §18; node A6b), so the calibration set can measure the jury
 * without a chain, an arbiter or a sandbox.
 *
 * The request is A4b's buildCodeReviewAiRequest's, not a copy of it. This file only gathers
 * that function's input from a scenario folder and refuses what would make the measurement
 * mean nothing: a recorded run that belongs to another claim, a prior finding the jury
 * cannot read, a run production would not have sent to a model at all.
 *
 *   <claims dir>/<id>/
 *     scenario.json   { id, expected_outcome?, tags?, notes?, codeClass?, ... }
 *     listing.zip     the listing archive (manifest with `codeReview`, its primary file, the spec, known issues)
 *     claim.zip       the claim archive (finding.json, report.md, poc.patch)
 *     priors/*.zip    prior-finding archives, in file-name order (only finding.json and report.md are read, §13.3)
 *     run.json        the code runner's answer to POST /v1/runs: { report, reportSha256, contextPack }
 *
 * CIDs are computed from the archives' bytes (CIDv0, as `ipfs add` gives), so none can drift
 * from what they name. The run is recorded: this tool speaks only to the AI Node, and the
 * runner's harness writes run.json.
 */

/** Jurors get at most 240 s and the justifier 45 s after them (design §11): this gives each its whole budget. */
const CLAIM_DEADLINE_MS = 285000;
/** As the EA's front gates hold it, whatever class the request came on (assumption A8). */
const DEFAULT_CODE_CLASS = 'code-standard';
const SCENARIO_FILE = 'scenario.json';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const issueCodes = (issues) => issues.map((issue) => `${issue.code} at ${issue.path}`).join(', ');

function member(zip, name) {
  const entry = zip.getEntry(name);
  return entry && !entry.isDirectory ? entry.getData() : null;
}

function jsonMember(zip, name, fail) {
  const bytes = member(zip, name);
  if (!bytes) throw fail(`${name} is missing`);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (_error) {
    throw fail(`${name} is not valid JSON`);
  }
}

function openZip(file, fail) {
  if (!fs.existsSync(file)) throw fail(`${path.basename(file)} is missing`);
  const bytes = fs.readFileSync(file);
  try {
    return { bytes, zip: new AdmZip(bytes) };
  } catch (_error) {
    throw fail(`${path.basename(file)} is not a ZIP archive`);
  }
}

function readListing(folder, codeClass, fail) {
  const { bytes, zip } = openZip(path.join(folder, 'listing.zip'), fail);
  const manifest = jsonMember(zip, 'manifest.json', fail);
  if (typeof manifest.codeReview !== 'string') throw fail('listing.zip: the manifest has no codeReview key, so this is a text-mode archive');
  if (!manifest.primary || typeof manifest.primary.filename !== 'string') throw fail('listing.zip: the manifest names no primary file');
  const primary = jsonMember(zip, manifest.primary.filename, fail);
  if (typeof primary.query !== 'string' || primary.query === '') throw fail('listing.zip: the primary file has no query');
  const outcomes = codeReview.validateBugOutcomes(primary.outcomes);
  if (!outcomes.ok) throw fail(`listing.zip: the outcomes must be ${codeReview.BUG_OUTCOMES.join(', ')} (${issueCodes(outcomes.issues)})`);
  const envelope = codeReview.validateClassEnvelope(manifest.juryParameters, codeClass);
  if (!envelope.ok) throw fail(`listing.zip: the panel is outside the ${codeClass} envelope (${issueCodes(envelope.issues)})`);
  const spec = jsonMember(zip, manifest.codeReview, fail);
  const specCheck = codeReview.validateCodeReviewSpec(spec);
  if (!specCheck.ok) throw fail(`listing.zip: ${manifest.codeReview} is invalid (${issueCodes(specCheck.issues)})`);
  let knownIssues = [];
  if (typeof spec.stake.knownIssues === 'string') {
    knownIssues = jsonMember(zip, spec.stake.knownIssues, fail);
    const known = codeReview.validateKnownIssues(knownIssues);
    if (!known.ok) throw fail(`listing.zip: ${spec.stake.knownIssues} is invalid (${issueCodes(known.issues)})`);
  }
  return { bytes, query: primary.query, outcomes: primary.outcomes, juryParameters: manifest.juryParameters, spec, knownIssues };
}

/** A finding as the EA's front gates hold it: a JSON object common's schema accepts. */
function readFinding(zip, where, fail) {
  const finding = jsonMember(zip, codeReview.FINDING_FILE, (what) => fail(`${where}: ${what}`));
  const checked = codeReview.validateFinding(finding);
  if (!checked.ok) throw fail(`${where}: ${codeReview.FINDING_FILE} is invalid (${issueCodes(checked.issues)})`);
  return finding;
}

function readClaim(folder, fail) {
  const { bytes, zip } = openZip(path.join(folder, 'claim.zip'), fail);
  const finding = readFinding(zip, 'claim.zip', fail);
  const pocPatch = member(zip, codeReview.POC_PATCH_FILE);
  if (!pocPatch) throw fail(`claim.zip: ${codeReview.POC_PATCH_FILE} is missing`);
  return { bytes, finding, pocPatch };
}

async function readPriors(folder, fail) {
  const dir = path.join(folder, 'priors');
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.zip')).sort();
  if (names.length > codeReview.MAX_PRIOR_FINDINGS) {
    throw fail(`a request carries at most ${codeReview.MAX_PRIOR_FINDINGS} prior findings; priors/ holds ${names.length}`);
  }
  const priors = [];
  for (const name of names) {
    const { bytes, zip } = openZip(path.join(dir, name), fail);
    const finding = readFinding(zip, `priors/${name}`, fail);
    const reportBytes = member(zip, codeReview.REPORT_FILE);
    const report = reportBytes ? reportBytes.toString('utf8') : '';
    if (report.trim() === '') throw fail(`priors/${name}: ${codeReview.REPORT_FILE} is missing or empty`);
    // Only these two members of a prior finding enter the evaluation (§13.3).
    priors.push({ bcid: await Hash.of(bytes), finding, report });
  }
  if (new Set(priors.map((prior) => prior.bcid)).size !== priors.length) throw fail('a prior finding appears more than once in priors/');
  return priors;
}

/** The prior findings a pack holds, from its priorFindings tier: one line of canonical JSON each, after the runner's header. */
function priorsInPack(pack) {
  const held = [];
  for (const file of pack.files) {
    if (file.tier !== 'priorFindings') continue;
    for (const line of file.text.split('\n')) {
      if (!line.startsWith('{')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (_error) {
        continue;
      }
      if (typeof entry.bcid === 'string') held.push(entry.bcid);
    }
  }
  return held;
}

function assertPack(pack, codeClass, priors, fail) {
  if (!pack || !Array.isArray(pack.files) || pack.files.length === 0) throw fail('run.json holds no contextPack with files');
  if (pack.codeClass !== codeClass) throw fail(`run.json: the pack was built for class ${pack.codeClass}, this scenario is ${codeClass}`);
  if (!Number.isInteger(pack.usedTokens) || !Number.isInteger(pack.budgetTokens) || pack.usedTokens > pack.budgetTokens) {
    throw fail('run.json: the pack is over its budget');
  }
  for (const file of pack.files) {
    if (!file || typeof file.name !== 'string' || file.name === '' || typeof file.text !== 'string') throw fail('run.json: a pack file has no name or text');
    if (file.text.startsWith('data:')) throw fail(`run.json: ${file.name} would read as a data URI`);
  }
  const held = priorsInPack(pack);
  const wanted = priors.map((prior) => prior.bcid);
  const missing = wanted.filter((bcid) => !held.includes(bcid));
  const extra = held.filter((bcid) => !wanted.includes(bcid));
  if (missing.length > 0) throw fail(`prior finding(s) ${missing.join(', ')} are not in the pack: the jury would be told of a finding it cannot read`);
  if (extra.length > 0) throw fail(`the pack holds prior finding(s) ${extra.join(', ')} with no archive in priors/`);
}

function readRun(folder, codeClass, { listingCid, bcid, pocPatch, priors }, fail) {
  const file = path.join(folder, 'run.json');
  if (!fs.existsSync(file)) throw fail('run.json is missing');
  let run;
  try {
    run = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_error) {
    throw fail('run.json is not valid JSON');
  }
  const { report, reportSha256, contextPack } = run;
  if (!report || typeof report !== 'object' || !report.inputs || !report.gates) throw fail('run.json holds no report');

  const wrong = (field, expected) => (report.inputs[field] === expected ? null : `${field} (the report's is ${report.inputs[field]}, the archives give ${expected})`);
  const mismatches = [wrong('listingCid', listingCid), wrong('bcid', bcid), wrong('pocPatchSha256', sha256(pocPatch))].filter(Boolean);
  if (mismatches.length > 0) throw fail(`run.json is not this claim's run: ${mismatches.join('; ')}`);

  // Every gate passed is the only way a report reaches a jury (external-adapter/src/codeReview/settlement.js).
  const notPassed = codeReview.REPORT_GATES.filter((gate) => report.gates[gate] !== 'pass');
  if (notPassed.length > 0) {
    throw fail(`run.json: not every gate passed (${notPassed.map((gate) => `${gate}=${report.gates[gate]}`).join(', ')}), so production calls no model on this claim`);
  }
  assertPack(contextPack, codeClass, priors, fail);
  return { report, reportSha256, contextPack };
}

function readMeta(folder, fail) {
  const file = path.join(folder, SCENARIO_FILE);
  if (!fs.existsSync(file)) throw fail(`${SCENARIO_FILE} is missing`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_error) {
    throw fail(`${SCENARIO_FILE} is not valid JSON`);
  }
}

/**
 * Read one scenario folder.
 * @param {string} folder
 * @returns {Promise<object>} the scenario: its id and labels, and `input`, buildCodeReviewAiRequest's input less the deadline
 */
async function loadClaimScenario(folder) {
  const label = path.basename(folder);
  const fail = (what) => new Error(`Claim scenario "${label}": ${what}`);

  const meta = readMeta(folder, fail);
  // The id names a saved file (results-manager.js), so it stays one path segment.
  if (typeof meta.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(meta.id)) throw fail(`${SCENARIO_FILE} needs an id of letters, digits, ".", "_" and "-"`);
  if (meta.expected_outcome !== undefined && !codeReview.BUG_OUTCOMES.includes(meta.expected_outcome)) {
    throw fail(`expected_outcome must be one of ${codeReview.BUG_OUTCOMES.join(', ')}`);
  }
  const codeClass = meta.codeClass === undefined ? DEFAULT_CODE_CLASS : meta.codeClass;

  const listing = readListing(folder, codeClass, fail);
  const claim = readClaim(folder, fail);
  const priors = await readPriors(folder, fail);
  const listingCid = await Hash.of(listing.bytes);
  const bcid = await Hash.of(claim.bytes);
  if (priors.some((prior) => prior.bcid === bcid)) throw fail('the claim is in priors/: a claim is not its own prior finding');

  const run = readRun(folder, codeClass, { listingCid, bcid, pocPatch: claim.pocPatch, priors }, fail);

  const scenario = {
    scenario_id: meta.id,
    expected_outcome: meta.expected_outcome,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    notes: meta.notes,
    codeClass,
    stake: listing.spec.stake,
    input: {
      query: listing.query,
      outcomes: listing.outcomes,
      juryParameters: listing.juryParameters,
      codeClass,
      report: run.report,
      reportSha256: run.reportSha256,
      claim: { bcid, finding: claim.finding },
      knownIssues: listing.knownIssues,
      priorFindings: priors,
      dispute: null,
      contextPack: run.contextPack
    }
  };

  // Held as the EA holds its own request before sending it: a run that fails this calls no model.
  const checked = codeReview.validateCodeReviewRequest(buildClaimRequest(scenario, { deadlineMs: CLAIM_DEADLINE_MS }).codeReview);
  if (!checked.ok) throw fail(`the request does not validate: ${issueCodes(checked.issues)}`);
  return scenario;
}

/**
 * Read a directory of scenario folders, in name order.
 * @param {string} dir
 * @param {{ scenarioIds?: string[], tags?: string[] }} [filters]
 * @returns {Promise<object[]>}
 */
async function loadClaimScenarios(dir, { scenarioIds, tags } = {}) {
  const entries = fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name)).sort()
    : [];
  const folders = entries.filter((folder) => fs.existsSync(path.join(folder, SCENARIO_FILE)));
  // Nothing leaves a measurement silently: a folder that is a scenario but for this file is an error.
  const orphan = entries.find((folder) => !folders.includes(folder) && ['listing.zip', 'claim.zip', 'run.json'].some((name) => fs.existsSync(path.join(folder, name))));
  if (orphan) throw new Error(`Claim scenario "${path.basename(orphan)}": ${SCENARIO_FILE} is missing`);
  if (folders.length === 0) throw new Error(`No claim scenarios in ${dir}: each is a folder with a ${SCENARIO_FILE} (README.md, "Claim scenarios")`);

  // Filters read scenario.json alone, so a filtered run does not depend on the other folders' archives.
  const metaOf = (folder) => readMeta(folder, (what) => new Error(`Claim scenario "${path.basename(folder)}": ${what}`));
  let chosen = folders;
  if (scenarioIds) {
    const known = new Set(folders.map((folder) => metaOf(folder).id));
    const missing = scenarioIds.filter((id) => !known.has(id));
    if (missing.length > 0) throw new Error(`Unknown claim scenario id(s): ${missing.join(', ')}`);
    chosen = chosen.filter((folder) => scenarioIds.includes(metaOf(folder).id));
  }
  if (tags) chosen = chosen.filter((folder) => (metaOf(folder).tags || []).some((tag) => tags.includes(tag)));

  const scenarios = [];
  for (const folder of chosen) scenarios.push(await loadClaimScenario(folder));
  const ids = scenarios.map((scenario) => scenario.scenario_id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated) throw new Error(`Claim scenario id "${repeated}" is in more than one folder`);
  return scenarios;
}

/**
 * The body of POST /api/rank-and-justify: A4b's builder, on the scenario's input.
 * @param {object} scenario - loadClaimScenario's
 * @param {{ deadlineMs: number, requestTag?: string }} options
 * @returns {object}
 */
function buildClaimRequest(scenario, { deadlineMs, requestTag }) {
  return buildCodeReviewAiRequest({ ...scenario.input, deadlineMs, requestTag });
}

module.exports = { CLAIM_DEADLINE_MS, loadClaimScenario, loadClaimScenarios, buildClaimRequest };
