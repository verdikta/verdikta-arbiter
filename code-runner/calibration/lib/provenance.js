'use strict';

/**
 * "No third-party text is committed" as a check (node A7b). This public repository holds a case's
 * finding.json, report.md and poc.patch, and those must be Verdikta's own: many of the public
 * repositories have no licence, others are GPL, AGPL or BUSL, and a program's report is its
 * authors'. So before any image, the harness fetches the repository at its commit and the
 * program's report, and measures the longest run of tokens each claim file shares with them. Over
 * the limit, the run stops, exit 2. The message names the file and the length, and quotes nothing of
 * theirs. The measured numbers are printed on every run.
 *
 * A token is a word or an identifier, without case, punctuation or layout, so reformatting does
 * not hide a copy. Runs shorter than GRAM tokens are not measured: a shared identifier or call is no
 * copy. What this cannot catch is close rewording; that stays with the reviewer, and each file is
 * short enough to read.
 *
 * The limits were set from the corpus's real numbers (`code-runner/README.md`, "Public findings"):
 * a test legitimately shares its imports and the project's calls with the repository's own tests,
 * so code gets more room than prose.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fetchRepo } = require('./gitRepo');
const { cacheRoot } = require('./prebuild');

/** Runs shorter than this are not measured. */
const GRAM = 6;
const LIMITS = Object.freeze({ prose: 14, code: 48 });
const TEXT_FILE = /\.(?:sol|md|txt|toml|ya?ml)$/i;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const FETCH_ATTEMPTS = 3;

function tokens(text) {
  return String(text).toLowerCase().match(/[a-z0-9_]+/g) || [];
}

const P1 = 67108859;
const P2 = 67108837;

function tokenHash(token) {
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < token.length; i += 1) {
    const c = token.charCodeAt(i);
    a = ((a ^ c) * 16777619) % P1;
    b = (b * 33 + c) % P2;
  }
  return [a, b];
}

/** Each run of GRAM tokens, as one 52-bit number. */
function grams(text) {
  const hashes = tokens(text).map(tokenHash);
  const out = [];
  for (let i = 0; i + GRAM <= hashes.length; i += 1) {
    let a = 0;
    let b = 0;
    for (let k = 0; k < GRAM; k += 1) {
      a = (a * 131 + hashes[i + k][0]) % P1;
      b = (b * 137 + hashes[i + k][1]) % P2;
    }
    out.push(a * 67108864 + b);
  }
  return out;
}

/** @param {string[]} texts @returns {Set<number>} */
function indexTexts(texts) {
  const index = new Set();
  for (const text of texts) for (const g of grams(text)) index.add(g);
  return index;
}

/** The longest run of tokens of `text` that is also in `index`; 0 under GRAM. Runs of shared grams, so at worst a little over. */
function longestSharedRun(text, index) {
  let streak = 0;
  let best = 0;
  for (const g of grams(text)) {
    streak = index.has(g) ? streak + 1 : 0;
    if (streak > best) best = streak;
  }
  return best === 0 ? 0 : best + GRAM - 1;
}

function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, '\'');
}

/** What the jury reads of a claim, file by file: the patch's added lines without its marks. */
function claimTexts(entry) {
  const poc = entry.claim.poc.toString('utf8').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
  return [
    { file: 'report.md', text: entry.claim.report, kind: 'prose' },
    { file: 'finding.json', text: JSON.stringify(entry.claim.finding), kind: 'prose' },
    { file: 'poc.patch', text: poc, kind: 'code' }
  ];
}

/**
 * @param {object} entry - a loaded case
 * @param {{report:Set<number>, repo:Set<number>}} sources - indexTexts() of the program's report and of the repository's text files
 * @param {{measured?:object[]}} [o] - receives what was measured
 * @returns {string[]} problems
 */
function claimProblems(entry, sources, { measured = [] } = {}) {
  const out = [];
  for (const { file, text, kind } of claimTexts(entry)) {
    const limit = LIMITS[kind];
    const report = longestSharedRun(text, sources.report);
    const repo = longestSharedRun(text, sources.repo);
    measured.push({ id: entry.id, file, report, repo, limit });
    if (report > limit) out.push(`${entry.id}: ${file} shares a run of ${report} tokens with the program's report (at most ${limit})`);
    if (repo > limit) out.push(`${entry.id}: ${file} shares a run of ${repo} tokens with the repository (at most ${limit})`);
  }
  return out;
}

/** A report's text, kept by URL so a run reads each once. */
async function reportText(url, { cacheDir, fetchImpl = fetch }) {
  const file = path.join(cacheDir, 'reports', crypto.createHash('sha256').update(url).digest('hex'));
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  let last;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetchImpl(url);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const raw = await res.text();
      const text = /html/i.test(res.headers.get('content-type') || '') ? htmlToText(raw) : raw;
      if (tokens(text).length < 100) throw new Error('it holds almost no text');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return text;
    } catch (err) {
      last = err;
      if (attempt < FETCH_ATTEMPTS) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error(`the report at ${url} could not be read: ${last.message}`);
}

/**
 * Each chosen case on a `git` listing against its real sources. A case on a fixture has nothing to compare.
 * @param {object[]} cases - loaded cases
 * @param {object} [o]
 * @param {Function} [o.stdout]
 * @param {string} [o.cacheDir]
 * @returns {Promise<string[]>} problems
 * @throws {Error} a source that could not be read: nothing was measured
 */
async function checkCases(cases, { stdout = () => {}, cacheDir = cacheRoot(), fetchImpl = fetch } = {}) {
  const publicCases = cases.filter((c) => c.listing.repo.kind === 'git');
  const repos = new Map();
  const problems = [];
  for (const entry of publicCases) {
    if (!repos.has(entry.listing)) {
      const repo = await fetchRepo(entry.listing.repo, { cacheDir });
      const texts = repo.files.filter((f) => f.bytes && f.bytes.length <= MAX_FILE_BYTES && TEXT_FILE.test(f.path)).map((f) => f.bytes.toString('utf8'));
      repos.set(entry.listing, indexTexts(texts));
    }
    const report = indexTexts([await reportText(entry.source.report, { cacheDir, fetchImpl })]);
    const measured = [];
    problems.push(...claimProblems(entry, { report, repo: repos.get(entry.listing) }, { measured }));
    stdout(`calibration: provenance ${entry.id}: ${measured.map((m) => `${m.file} ${m.report}/${m.repo} (limit ${m.limit})`).join(', ')}`);
  }
  return problems;
}

module.exports = { tokens, indexTexts, longestSharedRun, htmlToText, claimProblems, checkCases, reportText, LIMITS, GRAM };
