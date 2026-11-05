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
 * A listing's repo is a Verdikta fixture in the tree (`fixture`), or a public repository at a
 * commit (`git`, node A7b), fetched at run time and never committed. A case on a `git` listing is
 * held to more: where it comes from, a label that is the program's, a claim that does not carry its
 * label, and a poc.patch that only adds files, so no context or removed line carries someone's code.
 * The harness then measures its text against the real sources (provenance.js).
 *
 * A case in the subset batch-2 (node A7c) says what kind of case it is and where its label comes from
 * (`label`): a clear invalid, a duplicate, a known issue or a severity boundary. Its gates all pass,
 * and the jury it reaches decides the rest, so what the loader holds is the label against the
 * program's record or the listing's own text.
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
const { gitObjects, rootedCommit } = require('./image');
const { checkSpec } = require('../../src/classLimits');
const { parseCommand } = require('../../src/commands');
const { officialList } = require('../../src/solcReleases');
const { ABSTAIN } = require('../../src/result');
const { functionName } = require('../../src/observable');

const CASE_FORMAT = 'verdikta.calibration-case/1';
const LISTING_FORMAT = 'verdikta.calibration-listing/1';
const SUBSET_NEEDING_CONTROLS = 'adversarial';
const SUBSET_CLEAR_VALID = 'clear-valid';
const SUBSET_BATCH_2 = 'batch-2';
/** Each kind's outcome: what the design's rule settles it as (§8.4, §8.7, §18), which the jury is asked to reach. */
const LABEL_KINDS = Object.freeze({
  'clear-invalid.intended-behaviour': 'INVALID',
  'clear-invalid.outside-scope': 'INVALID',
  'clear-invalid.excluded-precondition': 'INVALID',
  'duplicate.rephrased': 'DUPLICATE',
  'duplicate.entry-point': 'DUPLICATE',
  'duplicate.victim': 'DUPLICATE',
  'known-issue.before': 'DUPLICATE',
  'known-issue.after': 'VALID',
  'severity-boundary': 'VALID'
});
/** A label from the listing's own text rather than the program's record is open to these only: a duplicate or a class is the program's call. */
const LISTING_BASIS_KINDS = Object.freeze(['clear-invalid.outside-scope', 'clear-invalid.excluded-precondition', 'known-issue.before']);
const RUN_RECIPIENT = codeReview.generateDisclosureKeyPair().recipient;
/** The class platform's official releases: a release must exist there, wherever this harness runs. */
const OFFICIAL_SOLC = officialList(codeReview.CLASS_HARD_LIMITS.platform);

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

/**
 * A file's JSON value, of the shape asked for. Anything else is a problem reported through `fail`, and null: a value
 * that parses and is the wrong shape (null, a list, a string) is as malformed as one that does not parse.
 * @param {string} file
 * @param {Function} fail
 * @param {{label?:string, shape?:'object'|'list'}} [o]
 */
function readJson(file, fail, { label = path.basename(file), shape = 'object' } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    fail(`${label} is missing`);
    return null;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    fail(`${label} is not JSON: ${err.message}`);
    return null;
  }
  const right = shape === 'list' ? Array.isArray(value) : isObject(value);
  if (!right) {
    fail(`${label} must be a JSON ${shape}`);
    return null;
  }
  return value;
}

/** A path under the corpus (or under a case): relative, with no way out. */
function insidePath(rel) {
  return text(rel) && !path.isAbsolute(rel) && !rel.split('/').includes('..') && !rel.includes('\\');
}

/** Every file under a folder, relative to it. */
function filesUnder(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(dir, child));
    else out.push(child);
  }
  return out;
}

/** A file nothing reads would be a claim or a listing that is not what it looks like. */
function noOtherFiles(dir, known, fail) {
  for (const file of filesUnder(dir)) {
    if (!known.has(file)) fail(`${file} is here and the format names no such file`);
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
  unknownFields(source, ['url', 'licence', 'program', 'licenceUse', 'adaptedFrom', 'adaptedHow', 'report'], (m) => fail(`source: ${m}`));
  if (!text(source.url) || !source.url.startsWith('https://')) fail('source.url must be an https URL');
  if (!text(source.licence)) fail('source.licence is required');
  if (source.program !== null && source.program !== undefined) {
    if (!isObject(source.program) || !text(source.program.name) || !text(source.program.verdict)) {
      fail('source.program must be null, or name the program and its verdict (and class, if it gave one)');
    } else {
      unknownFields(source.program, ['name', 'contest', 'verdict', 'class'], (m) => fail(`source.program: ${m}`));
    }
  }
}

/** A public finding's provenance: everything a reader needs to check the label, in the case itself. */
function checkPublicSource(source, fail, { classOptional = false } = {}) {
  if (!isObject(source)) return;
  const url = (v) => text(v) && v.startsWith('https://');
  if (!text(source.licenceUse)) fail('source.licenceUse must say what the case does with the licence');
  if (!url(source.adaptedFrom)) fail('source.adaptedFrom must be the URL the PoC was written from');
  if (!text(source.adaptedHow)) fail('source.adaptedHow must say how the PoC differs from the finding\'s');
  if (!url(source.report)) fail('source.report must be the https URL of the program\'s report, which the run compares the claim with');
  const p = source.program;
  const noClass = classOptional && isObject(p) && p.class === null;
  if (!isObject(p) || !text(p.name) || !text(p.contest) || !text(p.verdict) || (!text(p.class) && !noClass)) {
    fail(`source.program must name the program, the contest, the verdict and the class${classOptional ? ' (null where the program gave none)' : ''}`);
  } else if (!noClass && !CLASSES.includes(p.class)) {
    fail(`source.program.class must be one of ${CLASSES.join(', ')}`);
  }
}

/**
 * poc.patch on a `git` listing only adds files. A context or removed line is how a diff carries someone's code.
 * @param {Buffer} bytes
 * @returns {string[]} problems
 */
function addOnlyProblems(bytes) {
  const lines = bytes.toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const refused = (at, why) => [`poc.patch must only add new files, as a patch of new-file sections: line ${at + 1} ${why}`];
  let i = 0;
  if (lines.length === 0) return refused(0, 'is missing');
  while (i < lines.length) {
    const head = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[i]);
    if (!head || head[1] !== head[2]) return refused(i, 'should start a section for one file');
    i += 1;
    if (lines[i] !== 'new file mode 100644') return refused(i, 'should be new file mode 100644');
    i += 1;
    if (/^index [0-9a-f]+\.\.[0-9a-f]+$/.test(lines[i] || '')) i += 1;
    if (lines[i] !== '--- /dev/null') return refused(i, 'should be --- /dev/null');
    i += 1;
    if (lines[i] !== `+++ b/${head[1]}`) return refused(i, `should be +++ b/${head[1]}`);
    i += 1;
    const hunk = /^@@ -0,0 \+1(?:,([0-9]+))? @@$/.exec(lines[i] || '');
    if (!hunk) return refused(i, 'should be the one hunk of a new file');
    i += 1;
    const count = hunk[1] === undefined ? 1 : Number(hunk[1]);
    for (let k = 0; k < count; k += 1, i += 1) {
      if (!(lines[i] || '').startsWith('+')) return refused(i, 'should be an added line');
    }
    if (lines[i] === '\\ No newline at end of file') i += 1;
  }
  return [];
}

/** The account in a GitHub URL's path: the contest's organisation. Elsewhere a path's first segment can be any word. */
function urlOwner(url) {
  const m = text(url) ? /^https:\/\/(?:github\.com|raw\.githubusercontent\.com)\/([^/#?]+)/.exec(url) : null;
  return m ? m[1] : null;
}

/** What a claim must not name: those files reach the jury, and A7d measures the jury. */
function labelNeedles(source, repoUrl) {
  const s = isObject(source) ? source : {};
  const p = isObject(s.program) ? s.program : {};
  return [s.url, s.adaptedFrom, s.report, p.name, p.contest, urlOwner(s.url), urlOwner(repoUrl)].filter(text);
}

/** What the jury would read of a case besides its claim: the prior findings, and the listing's known issues. */
function juryTexts(loaded, listing) {
  const out = {
    'report.md': loaded.report,
    'finding.json': loaded.finding ? JSON.stringify(loaded.finding) : null,
    'poc.patch': loaded.poc ? loaded.poc.toString('utf8') : null
  };
  for (const prior of loaded.priors) {
    out[`${prior.name}/report.md`] = prior.report;
    out[`${prior.name}/finding.json`] = JSON.stringify(prior.finding);
  }
  if (Array.isArray(listing.knownIssues)) out[`${listing.rel}/known_issues.json`] = JSON.stringify(listing.knownIssues);
  return out;
}

/**
 * A case in batch-2 says what kind it is and where its label comes from. So a reader can check it against the program's text, and
 * a label inferred here cannot pass for the program's.
 */
function checkLabel(raw, loaded, listing, fail) {
  const { label, expected } = raw;
  if (!isObject(label)) {
    fail('a case in batch-2 needs a label: its kind, its basis, why, and what its kind asks for');
    return;
  }
  unknownFields(label, ['kind', 'basis', 'why', 'duplicateOf', 'boundary', 'knownIssue'], (m) => fail(`label: ${m}`));
  const want = LABEL_KINDS[label.kind];
  if (want === undefined) {
    fail(`label.kind must be one of ${Object.keys(LABEL_KINDS).join(', ')}`);
    return;
  }
  const family = label.kind.split('.')[0];
  if (!Array.isArray(raw.subsets) || !raw.subsets.includes(family)) fail(`a ${label.kind} case is also in the subset ${family}`);
  if (!['program', 'listing'].includes(label.basis)) fail('label.basis must be program or listing: whose call the label is');
  if (label.basis === 'listing' && !LISTING_BASIS_KINDS.includes(label.kind)) fail(`label.basis listing is not open to ${label.kind}: that call is the program's`);
  if (!text(label.why)) fail('label.why must say what the program recorded, or which of the listing\'s text gives the reason');
  if (isObject(expected) && expected.outcome !== want) fail(`a ${label.kind} case's outcome is ${want}, what the design settles it as`);

  const programClass = isObject(raw.source) && isObject(raw.source.program) ? raw.source.program.class : undefined;
  const claimed = loaded.finding ? loaded.finding.claimedClass : undefined;
  if (want === 'VALID' && isObject(expected)) {
    if (expected.class !== programClass) fail(`expected.class ${expected.class} is not the program's class, ${programClass}`);
  } else if (family === 'duplicate') {
    if (!CLASSES.includes(programClass)) fail('a duplicate is a finding the program judged valid: source.program.class is the class it gave');
  } else if (label.basis === 'program' && programClass !== null && programClass !== undefined) {
    fail('source.program.class is null on a claim the program rejected');
  }

  const forKind = (field, on) => {
    if (on && !isObject(label[field])) fail(`a ${label.kind} case needs label.${field}`);
    if (!on && label[field] !== undefined) fail(`label.${field} does not go with ${label.kind}`);
    return on && isObject(label[field]);
  };
  const packed = isObject(expected) && isObject(expected.runner) && isObject(expected.runner.pack) ? expected.runner.pack : {};
  const contains = (tier, words) => Array.isArray(packed.contains) && packed.contains.some((p) => isObject(p) && p.tier === tier && typeof p.text === 'string' && p.text.includes(words));

  if (forKind('duplicateOf', family === 'duplicate')) {
    const d = label.duplicateOf;
    unknownFields(d, ['url', 'recorded'], (m) => fail(`label.duplicateOf: ${m}`));
    if (!text(d.url) || !d.url.startsWith('https://')) fail('label.duplicateOf.url must be the https URL of the finding it duplicates');
    if (!text(d.recorded)) fail('label.duplicateOf.recorded must say how the program recorded it');
    if (loaded.priors.length === 0) fail('a duplicate needs the finding it duplicates among its prior findings: that is what the jury compares');
    const named = loaded.priors.map((p) => p.finding && p.finding.title).find(text);
    if (named && !contains('priorFindings', named)) fail('expected.runner.pack.contains must hold the prior finding\'s title in the tier priorFindings');
  }
  if (forKind('boundary', family === 'severity-boundary')) {
    const b = label.boundary;
    unknownFields(b, ['classes', 'call', 'moved'], (m) => fail(`label.boundary: ${m}`));
    const [low, high] = Array.isArray(b.classes) ? b.classes : [];
    if (!Array.isArray(b.classes) || b.classes.length !== 2 || CLASSES.indexOf(high) - CLASSES.indexOf(low) !== 1 || !CLASSES.includes(low)) {
      fail('label.boundary.classes must be two adjacent classes, lower first');
    } else {
      if (!b.classes.includes(b.call)) fail('label.boundary.call must be one of the two classes');
      if (isObject(expected) && expected.class !== b.call) fail(`expected.class ${expected.class} is not the program's call, ${b.call}`);
      if (claimed !== undefined && !b.classes.includes(claimed)) fail(`finding.json's claimedClass ${claimed} is on neither side of the boundary`);
    }
    if (!text(b.moved)) fail('label.boundary.moved must say who moved it, and from where');
  }
  if (forKind('knownIssue', family === 'known-issue')) {
    const k = label.knownIssue;
    unknownFields(k, ['title', 'listed', 'twin', 'how'], (m) => fail(`label.knownIssue: ${m}`));
    const before = label.kind === 'known-issue.before';
    if (k.listed !== (before ? 'before' : 'after')) fail(`label.knownIssue.listed must be ${before ? 'before' : 'after'}`);
    if (!text(k.how)) fail('label.knownIssue.how must say where the entry comes from, and when it was listed');
    if (!text(k.title)) {
      fail('label.knownIssue.title must name the entry');
    } else if (Array.isArray(listing.knownIssues)) {
      const listed = listing.knownIssues.some((e) => isObject(e) && e.title === k.title);
      if (before && !listed) fail(`the listing's known_issues.json holds no entry titled ${JSON.stringify(k.title)}: a known issue listed before the commit is in the list the commit saw`);
      if (!before && listed) fail(`the listing's known_issues.json holds ${JSON.stringify(k.title)}: an issue listed after the commit cannot be in the list the commit saw`);
      if (before && !contains('knownIssues', k.title)) fail('expected.runner.pack.contains must hold the entry\'s title in the tier knownIssues');
      if (!before && !(Array.isArray(packed.absent) && packed.absent.includes(k.title))) fail('expected.runner.pack.absent must hold the entry\'s title');
    }
    if (!before && !text(k.twin)) fail('a known issue listed after the commit names its twin: the same claim on the listing that holds it');
    if (k.twin !== undefined && (!text(k.twin) || !/^batch-2\./.test(k.twin))) fail('label.knownIssue.twin must name a case in batch-2');
  }
}

/** The rules of a case on a listing of kind `git`. */
function checkPublicCase(raw, loaded, listing, fail) {
  const subsets = Array.isArray(raw.subsets) ? raw.subsets : [];
  const repoUrl = listing.repo.url;
  const batch2 = subsets.includes(SUBSET_BATCH_2);
  checkPublicSource(raw.source, fail, { classOptional: batch2 });
  if (raw.claim && raw.claim.fix) fail('fix.patch is refused on a git listing: its removed lines would be someone\'s code');
  if (loaded.poc && loaded.poc.length) for (const m of addOnlyProblems(loaded.poc)) fail(m);
  for (const [file, content] of Object.entries(juryTexts(loaded, listing))) {
    if (content === null) continue;
    const found = labelNeedles(raw.source, repoUrl).find((needle) => content.toLowerCase().includes(needle.toLowerCase()));
    if (found) fail(`${file} names the source (${found}): the claim files reach the jury, and the label must not`);
  }
  // The harness tells the runner the External Adapter's gates passed, so that has to be true: a finding naming a path out of scope never reaches a runner.
  if (loaded.finding && listing.spec && isObject(listing.spec.stake)) {
    const inScope = codeReview.validateFinding(loaded.finding, listing.spec);
    if (!inScope.ok) fail(`finding.json would fail the inScope gate, and the harness tells the runner it passed: ${inScope.issues.map((i) => i.detail).join('; ')}`);
  }
  if (raw.label !== undefined && !batch2) fail('label goes with the subset batch-2');
  if (!subsets.includes(SUBSET_CLEAR_VALID) && !batch2) return;
  if (!isObject(raw.expected) || !isObject(raw.expected.runner)) return;
  const { expected } = raw;
  const { runner } = expected;
  if (raw.controlOf !== undefined) {
    if (raw.label !== undefined) fail('a control has no label: it is its case with the assertion turned around');
    const s = runner.settlement;
    if (!isObject(s) || s.check !== 'POC_DID_NOT_REPRODUCE') fail('a control on a public finding passes where its case fails, so reproduces fails on its own');
    return;
  }
  const what = batch2 ? 'a batch-2 case' : 'a clear-valid case';
  if (batch2) {
    checkLabel(raw, loaded, listing, fail);
    if (typeof expected.reason !== 'string' || !/\bjury\b/.test(expected.reason)) fail('expected.reason must say plainly what is left to the jury');
  } else {
    const programClass = isObject(raw.source) && isObject(raw.source.program) ? raw.source.program.class : undefined;
    if (expected.outcome !== 'VALID') fail('a clear-valid case\'s outcome is VALID');
    if (expected.class !== programClass) fail(`expected.class ${expected.class} is not the program's class, ${programClass}`);
    if (loaded.finding && loaded.finding.claimedClass !== programClass) fail(`finding.json's claimedClass ${loaded.finding.claimedClass} is not the program's class, ${programClass}`);
  }
  const gates = isObject(runner.gates) ? runner.gates : {};
  if (RUNNER_GATES.some((g) => gates[g] !== 'pass') || !isObject(runner.settlement) || runner.settlement.kind !== 'jury') {
    fail(`${what} reaches the jury: every gate passes`);
  }
  const first = Array.isArray(runner.tests) ? runner.tests[0] : null;
  const poc = loaded.finding && isObject(loaded.finding.poc) ? loaded.finding.poc : null;
  if (first && poc && typeof poc.observable === 'string') {
    if (!poc.observable.includes(functionName(first.id))) fail(`poc.observable must name the test, ${functionName(first.id)}`);
    if (typeof first.message !== 'string' || !poc.observable.includes(`"${first.message}"`)) fail('poc.observable must quote the failure the case expects, in double quotes');
  }
}

/**
 * A known issue listed after the commit and its twin: one claim, byte for byte, on two listings of one repository at one commit
 * that differ only in known_issues.json. So whatever the jury does differently between them, the list is why.
 */
function checkTwin(entry, byId, problems) {
  const twinId = entry.raw.label && isObject(entry.raw.label.knownIssue) ? entry.raw.label.knownIssue.twin : undefined;
  if (twinId === undefined) return;
  const fail = (m) => problems.push(`${entry.id}: twin: ${m}`);
  const twin = byId.get(twinId);
  if (!twin) {
    fail(`${twinId} does not exist`);
    return;
  }
  const back = twin.raw.label && isObject(twin.raw.label.knownIssue) ? twin.raw.label.knownIssue : {};
  if (back.twin !== entry.id) fail(`${twinId} must name this case as its twin`);
  if (back.title !== entry.raw.label.knownIssue.title) fail(`${twinId} names another entry`);
  for (const file of CLAIM_FILES) {
    const a = claimFile(entry, file);
    const b = claimFile(twin, file);
    if ((a === null) !== (b === null) || (a && !a.equals(b))) fail(`${file} differs from ${twinId}'s`);
  }
  const [mine, theirs] = [entry.listing, twin.listing];
  if (!mine || !theirs) return;
  if (mine === theirs) {
    fail('it is on the same listing: only the list can differ');
    return;
  }
  if (!isDeepStrictEqual(mine.repo, theirs.repo) || mine.commit !== theirs.commit) fail('it is on another repository or commit');
  if (!isDeepStrictEqual(mine.baseline, theirs.baseline)) fail('the two listings hold different baselines');
  const { disclosureKey: _a, ...stakeA } = isObject(mine.spec) && isObject(mine.spec.stake) ? mine.spec.stake : {};
  const { disclosureKey: _b, ...stakeB } = isObject(theirs.spec) && isObject(theirs.spec.stake) ? theirs.spec.stake : {};
  if (!isDeepStrictEqual({ ...mine.spec, stake: stakeA }, { ...theirs.spec, stake: stakeB })) fail('the two listings hold different specs');
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
  if (raw === null) return null;
  noOtherFiles(dir, new Set(['listing.json', 'code_review.json', 'baseline.json', 'known_issues.json']), fail);
  unknownFields(raw, ['format', 'id', 'repo', 'commit', 'source', 'solc'], fail);
  if (raw.format !== LISTING_FORMAT) fail(`format must be ${LISTING_FORMAT}`);
  if (!text(raw.id) || !/^[a-z0-9][a-z0-9-]*$/.test(raw.id)) fail('id must be a lower-case slug');
  checkSource(raw.source, fail);
  if (typeof raw.commit !== 'string' || !COMMIT.test(raw.commit)) fail('commit must be a full commit id');
  const listing = { id: raw.id, dir, rel, repo: raw.repo, commit: raw.commit, source: raw.source, solc: raw.solc, solcReleases: [raw.solc], setup: null, repoPaths: [] };

  if (!isObject(raw.repo) || !['fixture', 'git'].includes(raw.repo.kind)) {
    fail('repo must be { kind: "fixture", path } or { kind: "git", url, commit }');
  } else if (raw.repo.kind === 'git') {
    unknownFields(raw.repo, ['kind', 'url', 'commit', 'subdir', 'tree'], (m) => fail(`repo: ${m}`));
    const { url, commit, subdir, tree } = raw.repo;
    if (!text(url) || !url.startsWith('https://')) fail('repo.url must be an https URL');
    if (typeof commit !== 'string' || !COMMIT.test(commit)) fail('repo.commit must be a full commit id, the upstream\'s');
    if (subdir === undefined) {
      if (tree !== undefined) fail('repo.tree goes with repo.subdir: the tree of that folder at the upstream commit');
      if (raw.commit !== commit) fail(`the listing's commit ${raw.commit} is not repo.commit, ${commit}`);
    } else {
      if (!insidePath(subdir) || subdir.includes('//') || subdir.endsWith('/')) fail('repo.subdir must be a folder inside the repository');
      if (typeof tree !== 'string' || !COMMIT.test(tree)) {
        fail('repo.tree must be the full id of that folder\'s tree at the upstream commit');
      } else if (raw.commit !== rootedCommit(tree).id) {
        fail(`the listing's commit ${raw.commit} is not the one written over the tree ${tree}, ${rootedCommit(tree).id}`);
      }
    }
    const releases = Array.isArray(raw.solc) ? raw.solc : [raw.solc];
    if (releases.length === 0 || !releases.every(text)) {
      fail('solc must name the official release the image installs, or a list of them');
    } else {
      const seen = new Set();
      for (const release of releases) {
        if (seen.has(release)) fail(`solc names ${release} twice`);
        seen.add(release);
        if (!OFFICIAL_SOLC.releases.has(release)) fail(`solc ${release} is not an official release for ${OFFICIAL_SOLC.platform}`);
      }
    }
    listing.solcReleases = releases;
  } else {
    unknownFields(raw.repo, ['kind', 'path', 'imageOnly'], (m) => fail(`repo: ${m}`));
    if (!insidePath(raw.repo.path)) {
      fail('repo.path must name the fixture repository inside the corpus');
    } else if (!fs.existsSync(path.join(root, raw.repo.path))) {
      fail(`repo.path ${raw.repo.path} does not exist`);
    } else {
      listing.files = readTree(path.join(root, raw.repo.path), fail);
      listing.imageOnly = {};
      if (raw.repo.imageOnly !== undefined) {
        if (!insidePath(raw.repo.imageOnly)) fail('repo.imageOnly must be inside the corpus');
        else if (!fs.existsSync(path.join(root, raw.repo.imageOnly))) fail(`repo.imageOnly ${raw.repo.imageOnly} does not exist`);
        else listing.imageOnly = readTree(path.join(root, raw.repo.imageOnly), fail);
        listing.repoPaths.push(raw.repo.imageOnly);
      }
      listing.repoPaths.push(raw.repo.path);
      const { commit } = gitObjects(listing.files);
      if (commit !== raw.commit) fail(`the repository's files make commit ${commit}, and listing.json names ${raw.commit}`);
    }
    if (!text(raw.solc) || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(raw.solc)) fail('solc must name the official release the image installs');
  }

  const spec = readJson(path.join(dir, 'code_review.json'), fail);
  if (spec !== null) {
    listing.spec = spec;
    if (spec.baseCommit !== raw.commit) fail(`code_review.json's baseCommit ${spec.baseCommit} is not the listing's commit`);
    const isGit = isObject(raw.repo) && raw.repo.kind === 'git';
    if (isGit && spec.repo !== raw.repo.url) fail(`code_review.json's repo ${spec.repo} is not the listing's, ${raw.repo.url}`);
    if (isGit && isObject(spec.stake)) {
      // A public recipient, and nothing here encrypts to it: each run makes its own, so no key-shaped text is committed for the secret scan to read.
      if (spec.stake.disclosureKey !== undefined) fail('code_review.json must not name a disclosureKey: the harness fills one in for the run');
      else spec.stake = { ...spec.stake, disclosureKey: RUN_RECIPIENT };
    }
    const setup = isObject(spec.commands) ? spec.commands.setup : undefined;
    if (setup !== undefined) {
      if (!isGit) {
        fail('a fixture listing has no commands.setup: nothing would run it');
      } else {
        // What the harness runs before the sandbox, on the same grammar as the listing's build: plain forge, allowed flags.
        const parsed = parseCommand('build', setup);
        if (!parsed.ok) fail(`commands.setup must be forge build with allowed flags: ${parsed.issue.detail}`);
        else listing.setup = setup;
      }
    }
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
  const knownIssues = readJson(path.join(dir, 'known_issues.json'), fail, { shape: 'list' });
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
  unknownFields(runner, ['result', 'gates', 'gateDetails', 'settlement', 'integrityFailed', 'tamperFlags', 'honestyFlags', 'tests', 'rawRuns', 'flags', 'findings', 'fix', 'pack'], where);

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
      const form = isObject(t) && text(t.id) && Array.isArray(t.runs) && t.runs.length === 3 && t.runs.every(text);
      if (!form || ![null, 'assertion', 'error'].includes(t.kind) || !(t.message === null || typeof t.message === 'string')) {
        where('each of tests must have an id, its three runs, a kind (assertion, error or null) and a message (or null)');
      }
    }
  }
  checkOptionalFacts(runner, where);
}

/** What a case may leave out, in its one shape: left out it means none, so a slip here must not read as none. */
function checkOptionalFacts(runner, where) {
  const { integrityFailed, tamperFlags, rawRuns, flags, findings, fix, pack } = runner;
  if (integrityFailed !== undefined && (!Array.isArray(integrityFailed) || !integrityFailed.every((c) => codeReview.INTEGRITY_CHECKS.includes(c)))) {
    where(`integrityFailed must list checks of the report: ${codeReview.INTEGRITY_CHECKS.join(', ')}`);
  }
  if (tamperFlags !== undefined && (!Array.isArray(tamperFlags) || !tamperFlags.every((f) => isObject(f) && text(f.kind) && text(f.file) && (Number.isInteger(f.line) || f.line === null)))) {
    where('tamperFlags must list each flag\'s kind, file and line');
  }
  if (rawRuns !== undefined) {
    const ok = isObject(rawRuns) && Object.values(rawRuns).every((runs) => Array.isArray(runs) && runs.length === 3 && runs.every(text));
    if (!ok) where('rawRuns must map each test\'s id to its three runs');
  }
  if (flags !== undefined) {
    const keys = ['existingTestsModified', 'skipMarkersAdded', 'protectedPathsTouched'];
    if (!isObject(flags) || !isDeepStrictEqual(Object.keys(flags).sort(), [...keys].sort()) || !keys.every((k) => Array.isArray(flags[k]))) {
      where(`flags must list ${keys.join(', ')}`);
    }
  }
  if (findings !== undefined) {
    if (!Array.isArray(findings) || !findings.every((f) => isObject(f) && text(f.rule) && text(f.file) && (Number.isInteger(f.line) || f.line === null))) {
      where('findings must list each finding\'s rule, file and line');
    }
  }
  if (fix !== undefined) {
    const keys = ['applies', 'builds', 'pocPasses', 'regressionCount'];
    if (!isObject(fix) || !isDeepStrictEqual(Object.keys(fix).sort(), [...keys].sort())) where(`fix must hold ${keys.join(', ')}`);
  }
  if (pack !== undefined) {
    if (!isObject(pack)) {
      where('pack must hold contains and absent');
    } else {
      unknownFields(pack, ['contains', 'absent'], (m) => where(`pack: ${m}`));
      if (pack.contains !== undefined && (!Array.isArray(pack.contains) || !pack.contains.every((p) => isObject(p) && text(p.tier) && text(p.text)))) {
        where('pack.contains must list a tier and a text for each');
      }
      if (pack.absent !== undefined && (!Array.isArray(pack.absent) || !pack.absent.every(text))) where('pack.absent must list texts');
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
  if (raw === null) return null;
  unknownFields(raw, ['format', 'id', 'subsets', 'title', 'source', 'listing', 'claim', 'priorFindings', 'expected', 'control', 'controlOf', 'label'], fail);
  if (raw.format !== CASE_FORMAT) fail(`format must be ${CASE_FORMAT}, got ${JSON.stringify(raw.format)}`);
  if (raw.id !== folderId) fail(`id must be its folder, ${folderId}`);
  if (!Array.isArray(raw.subsets) || raw.subsets.length === 0 || !raw.subsets.every(text)) fail('subsets must name at least one subset');
  if (!text(raw.title)) fail('title is required');
  checkSource(raw.source, fail);
  checkExpected(raw.expected, fail);

  let listing = null;
  if (!insidePath(raw.listing)) {
    fail('listing must name a listing folder inside the corpus');
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
    const finding = readJson(path.join(dir, file), fail, { label });
    if (finding === null) return null;
    const checked = codeReview.validateFinding(finding);
    if (!checked.ok) fail(`${label} is invalid: ${checked.issues.map((i) => `${i.code} at ${i.path}`).join(', ')}`);
    return finding;
  };
  loaded.finding = readFinding('finding.json', 'finding.json');

  // What this case names: any other file in its folder would be read by nothing.
  const known = new Set(['case.json', 'finding.json', 'report.md', 'poc.patch']);
  if (claim.fix) known.add('fix.patch');
  const priors = [];
  if (!Array.isArray(raw.priorFindings) || !raw.priorFindings.every(insidePath)) {
    fail('priorFindings must be a list of folders inside the case');
  } else {
    if (raw.priorFindings.length > codeReview.MAX_PRIOR_FINDINGS) fail(`at most ${codeReview.MAX_PRIOR_FINDINGS} prior findings`);
    const seen = new Set();
    for (const rel of raw.priorFindings) {
      if (seen.has(rel)) fail(`priorFindings names ${rel} more than once`);
      seen.add(rel);
      known.add(`${rel}/finding.json`);
      known.add(`${rel}/report.md`);
      const finding = readFinding(path.join(rel, 'finding.json'), `${rel}/finding.json`);
      const report = readFile(path.join(rel, 'report.md'));
      if (finding && report) priors.push({ name: path.basename(rel), finding, report: report.toString('utf8') });
    }
  }
  for (const file of filesUnder(dir)) {
    if (!known.has(file)) fail(`${file} is in the folder, and the case names no such file`);
  }
  loaded.priors = priors;
  if (listing && isObject(listing.repo) && listing.repo.kind === 'git') checkPublicCase(raw, loaded, listing, fail);

  return {
    id: raw.id, group, dir, raw,
    subsets: raw.subsets, title: raw.title, source: raw.source,
    listing, claim: loaded, priors, expected: raw.expected,
    control: raw.control, controlOf: raw.controlOf, label: raw.label
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
        const a = getPath(entry.expected.runner, p);
        // A path that names nothing would agree with itself, on every run, whatever happened.
        if (a === undefined) fail(`sameIn ${p}: the case's expected result has nothing there`);
        else if (!isDeepStrictEqual(a, getPath(control.expected.runner, p))) fail(`sameIn ${p}: the two expected results differ there`);
      }
    }
  }
}

/** What lies in the corpus and nothing reads: a vendored repository in repos/ would be third-party code in this public repo. */
function layoutProblems(root, listings) {
  const out = [];
  const allowedTop = new Set(['cases', 'listings', 'repos', 'lib', 'run.js', 'report', 'results']);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!allowedTop.has(entry.name)) out.push(`${entry.name} is at the top of the corpus, and the format names no such thing`);
  }
  const named = [...listings.values()].filter(Boolean);
  const repos = new Set(named.flatMap((l) => l.repoPaths));
  const reposDir = path.join(root, 'repos');
  if (fs.existsSync(reposDir)) {
    for (const entry of fs.readdirSync(reposDir)) {
      if (!repos.has(`repos/${entry}`)) out.push(`repos/${entry} is here, and no listing names it`);
    }
  }
  const listingsDir = path.join(root, 'listings');
  if (fs.existsSync(listingsDir)) {
    for (const entry of fs.readdirSync(listingsDir)) {
      if (!listings.has(`listings/${entry}`)) out.push(`listings/${entry} is here, and no case names it`);
    }
  }
  return out;
}

/**
 * Read every case under `root`/cases. Throws CorpusError with every problem found: nothing is ever skipped.
 * @param {{root:string, layout?:boolean}} o - `layout` also holds what lies around the cases to the format (calibration/'s, not the canary's)
 * @returns {{cases:object[], byId:Map<string,object>}}
 */
function loadCorpus({ root, layout = false }) {
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
    if (Array.isArray(entry.subsets) && entry.subsets.includes(SUBSET_NEEDING_CONTROLS) && entry.control === undefined && entry.controlOf === undefined) {
      problems.push(`${entry.id}: an adversarial case needs a control: the same PoC without the adversarial part`);
    }
    if (Array.isArray(entry.subsets) && entry.subsets.includes(SUBSET_BATCH_2)) {
      if (entry.control === undefined && entry.controlOf === undefined) problems.push(`${entry.id}: a batch-2 case needs a control: the same test with its assertion turned around`);
      checkTwin(entry, byId, problems);
    }
  }
  if (layout) problems.push(...layoutProblems(root, listings));
  if (problems.length) throw new CorpusError(problems);
  return { cases, byId };
}

/**
 * The cases to run, each with its control or its case: a relation needs both ends.
 * @param {{cases:object[], byId:Map}} corpus
 * @param {{subset?:string, cases?:string[], listing?:string}} o
 */
function selectCases(corpus, { subset, cases: ids, listing }) {
  let chosen = corpus.cases;
  if (subset !== undefined) {
    chosen = chosen.filter((c) => c.subsets.includes(subset));
    if (chosen.length === 0) throw new Error(`no case is in the subset ${subset}: nothing to measure`);
  }
  if (listing !== undefined) {
    chosen = chosen.filter((c) => c.listing && c.listing.id === listing);
    if (chosen.length === 0) throw new Error(`no case${subset === undefined ? '' : ` in the subset ${subset}`} is on the listing ${listing}: nothing to measure`);
  }
  if (ids !== undefined && ids.length > 0) {
    for (const id of ids) if (!corpus.byId.has(id)) throw new Error(`no case is called ${id}`);
    chosen = chosen.filter((c) => ids.includes(c.id) || ids.includes(c.controlOf) || (c.control && ids.includes(c.control.case)));
    if (chosen.length === 0) throw new Error(`no case in the subset ${subset} is called ${ids.join(', ')}`);
  }
  return chosen;
}

module.exports = {
  CASE_FORMAT, LISTING_FORMAT, RUNNER_GATES, CLAIM_FILES, LABEL_KINDS, CorpusError, loadCorpus, selectCases, getPath
};
