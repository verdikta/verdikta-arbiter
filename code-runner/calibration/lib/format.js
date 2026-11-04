'use strict';

/**
 * The calibration format, verdikta.calibration-case/1 (design §18; build plan A7a). A case is
 * a folder, cases/<group>/<name>/, with
 *
 *   case.json     what it is, where it comes from, what must happen and why
 *   finding.json  report.md  poc.patch  [fix.patch]    the claim, as a hunter submits it
 *   priors/<n>/   finding.json  report.md              prior findings, if any
 *
 * and names a listing folder: listing.json (repo@commit, source, solc), code_review.json (the
 * spec, with no image: the harness fills it in), baseline.json, known_issues.json.
 *
 * The rule is that nothing is skipped. loadCorpus reads every folder whichever subset was asked
 * for and reports every problem at once, before any image or run. What can be checked without
 * running is checked: an expected result that contradicts itself, a control that is more than
 * its case minus the named lines.
 */

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { codeReview } = require('@verdikta/common');
const { gitObjects } = require('./image');
const { checkSpec } = require('../../src/classLimits');
const { ABSTAIN } = require('../../src/result');

const CASE_FORMAT = 'verdikta.calibration-case/1';
const LISTING_FORMAT = 'verdikta.calibration-listing/1';
const SUBSET_NEEDING_CONTROLS = 'adversarial';

const OUTCOMES = Object.freeze(['VALID', 'INVALID', 'DUPLICATE', 'ABSTAIN', 'REQUESTER_ERROR']);
const CLASSES = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const GATE_STATUSES = Object.freeze(['pass', 'fail', 'not-run']);
const RUNNER_GATES = Object.freeze([...codeReview.REPORT_GATES]);
const CLAIM_FILES = Object.freeze(['finding.json', 'report.md', 'poc.patch', 'fix.patch']);
const RULE = /^verdikta\.[a-z]+\.[a-z0-9.-]+$/;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** A placeholder for the format's own check of the spec: the harness fills in the image it published. */
const IMAGE_PLACEHOLDER = `127.0.0.1:5000/verdikta/placeholder@sha256:${'0'.repeat(64)}`;

class CorpusError extends Error {
  constructor(problems) {
    super(`the calibration corpus is malformed:\n  - ${problems.join('\n  - ')}`);
    this.name = 'CorpusError';
    this.problems = problems;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.trim() !== '';

/** The value at a dotted path (`tests.0.runs`) of an expected result or an observation. */
function getPath(root, dotted) {
  let at = root;
  for (const part of dotted.split('.')) {
    if (at === null || at === undefined) return undefined;
    at = at[part];
  }
  return at;
}

function readJson(file, fail) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    fail(`${path.basename(file)} is missing`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`${path.basename(file)} is not JSON: ${err.message}`);
    return null;
  }
}

function unknownFields(value, allowed, fail) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`unknown field ${key}`);
  }
}

function checkSource(source, fail) {
  if (!isObject(source)) {
    fail('has no source (url, licence, and the program\'s verdict or null)');
    return;
  }
  unknownFields(source, ['url', 'licence', 'program'], (m) => fail(`source: ${m}`));
  if (!text(source.url) || !source.url.startsWith('https://')) fail('source.url must be an https URL');
  if (!text(source.licence)) fail('source.licence is required');
  if (source.program !== null && source.program !== undefined) {
    if (!isObject(source.program) || !text(source.program.name) || !text(source.program.verdict)) {
      fail('source.program must be null, or name the program and its verdict (and class, if it gave one)');
    }
  }
}

function readTree(dir, fail) {
  const out = {};
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out[child] = fs.readFileSync(path.join(dir, child));
      else fail(`${child} is neither a file nor a directory; a fixture repository holds plain files`);
    }
  };
  walk('');
  return out;
}

function loadListing(root, rel, problems) {
  const dir = path.join(root, rel);
  const fail = (m) => problems.push(`listing ${rel}: ${m}`);
  const raw = readJson(path.join(dir, 'listing.json'), fail);
  if (!isObject(raw)) return null;
  unknownFields(raw, ['format', 'id', 'repo', 'commit', 'source', 'solc'], fail);
  if (raw.format !== LISTING_FORMAT) fail(`format must be ${LISTING_FORMAT}`);
  if (!text(raw.id) || !/^[a-z0-9][a-z0-9-]*$/.test(raw.id)) fail('id must be a lower-case slug');
  checkSource(raw.source, fail);
  if (typeof raw.commit !== 'string' || !COMMIT.test(raw.commit)) fail('commit must be a full commit id');
  const listing = { id: raw.id, dir, rel, repo: raw.repo, commit: raw.commit, source: raw.source, solc: raw.solc };

  if (!isObject(raw.repo) || !['fixture', 'git'].includes(raw.repo.kind)) {
    fail('repo must be { kind: "fixture", path } or { kind: "git", url }');
  } else if (raw.repo.kind === 'git') {
    if (!text(raw.repo.url) || !raw.repo.url.startsWith('https://')) fail('repo.url must be an https URL');
  } else {
    if (!text(raw.repo.path)) {
      fail('repo.path names the fixture repository under the corpus');
    } else if (!fs.existsSync(path.join(root, raw.repo.path))) {
      fail(`repo.path ${raw.repo.path} does not exist`);
    } else {
      listing.files = readTree(path.join(root, raw.repo.path), fail);
      listing.imageOnly = {};
      if (raw.repo.imageOnly !== undefined) {
        if (!fs.existsSync(path.join(root, raw.repo.imageOnly))) fail(`repo.imageOnly ${raw.repo.imageOnly} does not exist`);
        else listing.imageOnly = readTree(path.join(root, raw.repo.imageOnly), fail);
      }
      const { commit } = gitObjects(listing.files);
      if (commit !== raw.commit) fail(`the repository's files make commit ${commit}, and listing.json names ${raw.commit}`);
    }
    if (!text(raw.solc) || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(raw.solc)) fail('solc must name the official release the image installs');
  }

  const spec = readJson(path.join(dir, 'code_review.json'), fail);
  if (isObject(spec)) {
    listing.spec = spec;
    if (spec.baseCommit !== raw.commit) fail(`code_review.json's baseCommit ${spec.baseCommit} is not the listing's commit`);
    if (!isObject(spec.env)) {
      fail('code_review.json has no env');
    } else {
      if (spec.env.image !== undefined) fail('code_review.json must not name an image: the harness publishes it');
      const filled = { ...spec, env: { ...spec.env, image: IMAGE_PLACEHOLDER } };
      const checked = codeReview.validateCodeReviewSpec(filled);
      if (!checked.ok) fail(`code_review.json is invalid: ${checked.issues.map((i) => `${i.code} at ${i.path}`).join(', ')}`);
      const limits = checkSpec(filled);
      if (!limits.ok) fail(`code_review.json is over the class limits: ${limits.issues.map((i) => i.path).join(', ')}`);
    }
  }
  const baseline = readJson(path.join(dir, 'baseline.json'), fail);
  if (baseline !== null) {
    listing.baseline = baseline;
    const checked = codeReview.validateBaseline(baseline);
    if (!checked.ok) fail(`baseline.json is invalid: ${checked.issues.map((i) => `${i.code} at ${i.path}`).join(', ')}`);
    if (baseline.baseCommit !== raw.commit) fail('baseline.json\'s baseCommit is not the listing\'s commit');
  }
  const knownIssues = readJson(path.join(dir, 'known_issues.json'), fail);
  if (knownIssues !== null) {
    listing.knownIssues = knownIssues;
    const checked = codeReview.validateKnownIssues(knownIssues);
    if (!checked.ok) fail(`known_issues.json is invalid: ${checked.issues.map((i) => `${i.code} at ${i.path}`).join(', ')}`);
  }
  return listing;
}

function checkRunner(runner, outcome, fail) {
  if (!isObject(runner)) {
    fail('expected.runner is required');
    return;
  }
  const where = (m) => fail(`expected.runner: ${m}`);
  if (runner.result === 'abstain') {
    unknownFields(runner, ['result', 'abstain'], (m) => where(`an abstention holds its cause and step only: ${m}`));
    if (!isObject(runner.abstain) || !Object.values(ABSTAIN).includes(runner.abstain.cause) || !text(runner.abstain.step)) {
      where('abstain must name a cause of the runner\'s taxonomy and a step');
    }
    if (outcome !== 'ABSTAIN') where('an abstention\'s outcome is ABSTAIN');
    return;
  }
  if (runner.result === 'requester_error') {
    unknownFields(runner, ['result', 'issues'], (m) => where(`a requester error holds its issue codes only: ${m}`));
    if (!Array.isArray(runner.issues) || runner.issues.length === 0 || !runner.issues.every(text)) where('issues must list the codes');
    if (outcome !== 'REQUESTER_ERROR') where('a requester error\'s outcome is REQUESTER_ERROR');
    return;
  }
  if (runner.result !== 'definitive') {
    where('result must be definitive, abstain or requester_error');
    return;
  }
  unknownFields(runner, ['result', 'gates', 'gateDetails', 'settlement', 'honestyFlags', 'tests', 'rawRuns', 'flags', 'findings', 'fix', 'pack'], where);

  const gates = isObject(runner.gates) ? runner.gates : {};
  for (const gate of RUNNER_GATES) {
    if (!GATE_STATUSES.includes(gates[gate])) where(`gates.${gate} must be ${GATE_STATUSES.join(', ')}`);
  }
  unknownFields(gates, RUNNER_GATES, (m) => where(`gates: ${m}`));
  const failed = RUNNER_GATES.filter((g) => gates[g] === 'fail');
  const details = isObject(runner.gateDetails) ? runner.gateDetails : {};
  for (const gate of failed) {
    if (!text(details[gate])) where(`the failed gate ${gate} must state its reason in gateDetails`);
  }
  for (const gate of Object.keys(details)) {
    if (!failed.includes(gate)) where(`gateDetails.${gate}: that gate does not fail`);
  }

  const s = runner.settlement;
  if (!isObject(s)) {
    where('settlement is required');
  } else if (s.kind === 'jury') {
    unknownFields(s, ['kind'], (m) => where(`settlement: ${m}`));
    if (failed.length > 0) where(`settlement says the jury, and gates fail: ${failed.join(', ')}`);
    if (!['VALID', 'INVALID', 'DUPLICATE'].includes(outcome)) where(`settlement says the jury, and the outcome is ${outcome}`);
  } else if (s.kind === 'invalid') {
    unknownFields(s, ['kind', 'gate', 'check', 'tamperFlagKinds'], (m) => where(`settlement: ${m}`));
    if (!text(s.gate) || !text(s.check)) where('settlement: invalid must name its gate and its check');
    if (s.gate && gates[s.gate] !== 'fail') where(`settlement names the gate ${s.gate}, which does not fail`);
    if (s.check === 'TAMPER_FLAG' && (!Array.isArray(s.tamperFlagKinds) || s.tamperFlagKinds.length === 0)) where('settlement: a tamper flag must name its kinds in tamperFlagKinds');
    if (outcome !== 'INVALID') where(`settlement invalid contradicts the outcome ${outcome}`);
  } else if (s.kind === 'duplicate') {
    unknownFields(s, ['kind', 'gate', 'check', 'failedChecks'], (m) => where(`settlement: ${m}`));
    if (s.gate !== 'integrity' || s.check !== 'INTEGRITY_CHECK_FAILED') where('settlement: duplicate is integrity, INTEGRITY_CHECK_FAILED');
    if (!Array.isArray(s.failedChecks) || s.failedChecks.length === 0 || !s.failedChecks.every((c) => codeReview.INTEGRITY_CHECKS.includes(c))) {
      where('settlement: failedChecks must name the integrity checks that failed');
    }
    if (outcome !== 'DUPLICATE') where(`settlement duplicate contradicts the outcome ${outcome}`);
  } else {
    where('settlement.kind must be jury, invalid or duplicate');
  }

  if (!Array.isArray(runner.honestyFlags) || !runner.honestyFlags.every((f) => isObject(f) && typeof f.rule === 'string' && RULE.test(f.rule) && text(f.file) && (Number.isInteger(f.line) || f.line === null))) {
    where('honestyFlags must list each flag\'s rule (verdikta.<set>.<name>), file and line');
  }
  const ran = gates.reproduces === 'pass' || gates.reproduces === 'fail';
  if (!Array.isArray(runner.tests) || (ran && runner.tests.length === 0)) {
    where('tests must list each test the patch added: where the PoC ran there is at least one');
  } else {
    for (const t of runner.tests) {
      if (!isObject(t) || !text(t.id) || !Array.isArray(t.runs) || t.runs.length !== 3) where('each of tests must have an id and its three runs');
    }
  }
}

function checkExpected(expected, fail) {
  if (!isObject(expected)) {
    fail('expected is required');
    return;
  }
  unknownFields(expected, ['outcome', 'class', 'reason', 'runner'], (m) => fail(`expected: ${m}`));
  if (!OUTCOMES.includes(expected.outcome)) fail(`expected.outcome must be one of ${OUTCOMES.join(', ')}`);
  if (expected.outcome === 'VALID' && !CLASSES.includes(expected.class)) fail(`expected.class must be one of ${CLASSES.join(', ')} when the outcome is VALID`);
  if (expected.outcome !== 'VALID' && expected.class !== null) fail('expected.class is null unless the outcome is VALID');
  if (!text(expected.reason)) fail('expected.reason must say why, in words');
  checkRunner(expected.runner, expected.outcome, fail);
}

function loadCase(root, group, name, listings, problems) {
  const dir = path.join(root, 'cases', group, name);
  const folderId = `${group}.${name}`;
  const fail = (m) => problems.push(`${folderId}: ${m}`);
  const raw = readJson(path.join(dir, 'case.json'), fail);
  if (!isObject(raw)) return null;
  unknownFields(raw, ['format', 'id', 'subsets', 'title', 'source', 'listing', 'claim', 'priorFindings', 'expected', 'control', 'controlOf'], fail);
  if (raw.format !== CASE_FORMAT) fail(`format must be ${CASE_FORMAT}, got ${JSON.stringify(raw.format)}`);
  if (raw.id !== folderId) fail(`id must be its folder, ${folderId}`);
  if (!Array.isArray(raw.subsets) || raw.subsets.length === 0 || !raw.subsets.every(text)) fail('subsets must name at least one subset');
  if (!text(raw.title)) fail('title is required');
  checkSource(raw.source, fail);
  checkExpected(raw.expected, fail);

  let listing = null;
  if (!text(raw.listing)) {
    fail('listing must name a listing folder');
  } else {
    if (!listings.has(raw.listing)) listings.set(raw.listing, loadListing(root, raw.listing, problems));
    listing = listings.get(raw.listing);
  }

  const claim = isObject(raw.claim) ? raw.claim : {};
  unknownFields(claim, ['finding', 'report', 'poc', 'fix'], (m) => fail(`claim: ${m}`));
  if (claim.finding !== 'finding.json' || claim.report !== 'report.md' || claim.poc !== 'poc.patch' || (claim.fix !== null && claim.fix !== 'fix.patch')) {
    fail('claim must be { finding: "finding.json", report: "report.md", poc: "poc.patch", fix: "fix.patch" or null }');
  }
  const readFile = (file) => {
    try {
      return fs.readFileSync(path.join(dir, file));
    } catch (_) {
      fail(`${file} is missing`);
      return null;
    }
  };
  const loaded = { finding: null, report: null, poc: readFile('poc.patch'), fix: claim.fix ? readFile('fix.patch') : null };
  const reportBytes = readFile('report.md');
  if (reportBytes) loaded.report = reportBytes.toString('utf8');
  if (reportBytes && loaded.report.trim() === '') fail('report.md is empty');
  if (loaded.poc && loaded.poc.length === 0) fail('poc.patch is empty');
  const readFinding = (file, label) => {
    const finding = readJson(path.join(dir, file), () => fail(`${label} is missing or not JSON`));
    if (finding === null) return null;
    const checked = codeReview.validateFinding(finding);
    if (!checked.ok) fail(`${label} is invalid: ${checked.issues.map((i) => `${i.code} at ${i.path}`).join(', ')}`);
    return finding;
  };
  loaded.finding = readFinding('finding.json', 'finding.json');

  const priors = [];
  if (!Array.isArray(raw.priorFindings)) {
    fail('priorFindings must be a list of folders');
  } else {
    if (raw.priorFindings.length > codeReview.MAX_PRIOR_FINDINGS) fail(`at most ${codeReview.MAX_PRIOR_FINDINGS} prior findings`);
    for (const rel of raw.priorFindings) {
      const finding = readFinding(path.join(rel, 'finding.json'), `${rel}/finding.json`);
      const report = readFile(path.join(rel, 'report.md'));
      if (finding && report) priors.push({ name: path.basename(rel), finding, report: report.toString('utf8') });
    }
  }

  return {
    id: raw.id, group, dir, raw,
    subsets: raw.subsets, title: raw.title, source: raw.source,
    listing, claim: loaded, priors, expected: raw.expected,
    control: raw.control, controlOf: raw.controlOf
  };
}

/** Lines of a claim file, without a patch's hunk headers (whose counts follow the lines). */
function linesOf(file, bytes) {
  const lines = bytes.toString('utf8').split('\n');
  return file.endsWith('.patch') ? lines.filter((l) => !l.startsWith('@@ ')) : lines;
}

/** `lines` less each of `named` once, in order; what could not be found goes in `missing`. */
function without(lines, named, missing) {
  const out = [...lines];
  for (const line of named) {
    const at = out.indexOf(line);
    if (at < 0) missing.push(line);
    else out.splice(at, 1);
  }
  return out;
}

function claimFile(entry, file) {
  if (file === 'finding.json') {
    try {
      return fs.readFileSync(path.join(entry.dir, file));
    } catch (_) {
      return null;
    }
  }
  if (file === 'report.md') return entry.claim.report === null ? null : Buffer.from(entry.claim.report);
  if (file === 'poc.patch') return entry.claim.poc;
  return entry.claim.fix;
}

/** A control is its case minus the named lines: anything else that differs is an accident the result could rest on. */
function checkControl(entry, byId, problems) {
  const fail = (m) => problems.push(`${entry.id}: control: ${m}`);
  const c = entry.control;
  if (!isObject(c)) {
    fail('must be { case, removes, adds, differsIn, sameIn }');
    return;
  }
  unknownFields(c, ['case', 'removes', 'adds', 'differsIn', 'sameIn'], fail);
  const control = byId.get(c.case);
  if (!control) {
    fail(`${c.case} does not exist`);
    return;
  }
  if (control.controlOf !== entry.id) problems.push(`${c.case}: controlOf must be ${entry.id}`);
  if (control.listing !== entry.listing) fail(`${c.case} is on another listing`);
  if (!isDeepStrictEqual(control.subsets, entry.subsets)) fail(`${c.case} is in other subsets`);
  const removes = isObject(c.removes) ? c.removes : {};
  const adds = isObject(c.adds) ? c.adds : {};
  const named = new Set([...Object.keys(removes), ...Object.keys(adds)]);
  if (named.size === 0) fail('removes and adds are both empty, so the control is the case');
  for (const file of named) if (!CLAIM_FILES.includes(file)) fail(`${file} is not a claim file`);
  for (const file of CLAIM_FILES) {
    const a = claimFile(entry, file);
    const b = claimFile(control, file);
    if (!named.has(file)) {
      if ((a === null) !== (b === null) || (a && !a.equals(b))) fail(`${file} differs from the control's, and the control names no line of it`);
      continue;
    }
    if (a === null || b === null) {
      fail(`${file} is in removes or adds, and one of the two has no such file`);
      continue;
    }
    const missing = [];
    const left = without(linesOf(file, a), removes[file] || [], missing);
    for (const line of missing) fail(`${file}: the case has no line ${JSON.stringify(line)}`);
    const missingAdded = [];
    const right = without(linesOf(file, b), adds[file] || [], missingAdded);
    for (const line of missingAdded) fail(`${file}: the control has no line ${JSON.stringify(line)}`);
    if (!isDeepStrictEqual(left, right)) {
      const extra = right.find((l) => !left.includes(l)) || left.find((l) => !right.includes(l));
      fail(`${file}: the case and the control differs by more than the named lines (${JSON.stringify(extra)})`);
    }
  }
  if (!Array.isArray(c.differsIn) || c.differsIn.length === 0 || !c.differsIn.every(text)) {
    fail('differsIn must name what the adversarial part changes');
  } else if (entry.expected && control.expected) {
    for (const p of c.differsIn) {
      if (isDeepStrictEqual(getPath(entry.expected.runner, p), getPath(control.expected.runner, p))) fail(`differsIn ${p}: the two expected results agree there`);
    }
  }
  if (c.sameIn !== undefined) {
    if (!Array.isArray(c.sameIn) || !c.sameIn.every(text)) {
      fail('sameIn must list what the adversarial part leaves alone');
    } else if (entry.expected && control.expected) {
      for (const p of c.sameIn) {
        if (!isDeepStrictEqual(getPath(entry.expected.runner, p), getPath(control.expected.runner, p))) fail(`sameIn ${p}: the two expected results differ there`);
      }
    }
  }
}

/**
 * Read every case under `root`/cases. Throws CorpusError with every problem found: nothing is ever skipped.
 * @param {{root:string}} o
 * @returns {{cases:object[], byId:Map<string,object>}}
 */
function loadCorpus({ root }) {
  const problems = [];
  const listings = new Map();
  const cases = [];
  const casesDir = path.join(root, 'cases');
  if (!fs.existsSync(casesDir)) throw new CorpusError([`${casesDir} does not exist`]);
  for (const group of fs.readdirSync(casesDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!group.isDirectory()) {
      problems.push(`cases/${group.name} is not a folder of cases`);
      continue;
    }
    for (const name of fs.readdirSync(path.join(casesDir, group.name), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!name.isDirectory()) {
        problems.push(`cases/${group.name}/${name.name} is not a case folder`);
        continue;
      }
      const entry = loadCase(root, group.name, name.name, listings, problems);
      if (entry) cases.push(entry);
    }
  }
  const byId = new Map(cases.map((c) => [c.id, c]));
  for (const entry of cases) {
    if (entry.control !== undefined) checkControl(entry, byId, problems);
    if (entry.controlOf !== undefined && !(byId.get(entry.controlOf) && byId.get(entry.controlOf).control)) {
      problems.push(`${entry.id}: controlOf names ${entry.controlOf}, which is not a case with a control`);
    }
    if (entry.subsets.includes(SUBSET_NEEDING_CONTROLS) && entry.control === undefined && entry.controlOf === undefined) {
      problems.push(`${entry.id}: an adversarial case needs a control: the same PoC without the adversarial part`);
    }
  }
  if (problems.length) throw new CorpusError(problems);
  return { cases, byId };
}

/**
 * The cases to run, each with its control or its case: a relation needs both ends.
 * @param {{cases:object[], byId:Map}} corpus
 * @param {{subset?:string, cases?:string[]}} o
 */
function selectCases(corpus, { subset, cases: ids }) {
  let chosen = corpus.cases;
  if (subset !== undefined) {
    chosen = chosen.filter((c) => c.subsets.includes(subset));
    if (chosen.length === 0) throw new Error(`no case is in the subset ${subset}: nothing to measure`);
  }
  if (ids !== undefined && ids.length > 0) {
    for (const id of ids) if (!corpus.byId.has(id)) throw new Error(`no case is called ${id}`);
    chosen = chosen.filter((c) => ids.includes(c.id) || ids.includes(c.controlOf) || (c.control && ids.includes(c.control.case)));
    if (chosen.length === 0) throw new Error(`no case in the subset ${subset} is called ${ids.join(', ')}`);
  }
  return chosen;
}

module.exports = {
  CASE_FORMAT, LISTING_FORMAT, RUNNER_GATES, CLAIM_FILES, CorpusError, loadCorpus, selectCases, getPath
};
