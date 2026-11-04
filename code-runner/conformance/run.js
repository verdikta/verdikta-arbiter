#!/usr/bin/env node
'use strict';

/**
 * npm run conformance: the fixed canary (design §16) through the real code runner.
 *
 *   npm run conformance [-- --repeat <n>] [--json <file>]
 *   npm run conformance -- --write-lock     after changing the canary: what it now pins
 *
 * A report exists only on the class platform, and its hash names the gVisor release measured
 * (A3b), so the canonical hash has one home: linux/amd64 under common's GVISOR_RELEASE. There,
 * and only when the runner's own answer says so, this prints the hash. CI records it and C5 pins
 * it in @verdikta/common.
 *
 * Anywhere else (a laptop under runc, arm64) the canary still runs and must reach its expected
 * gates, flags and runs, and the run says plainly that it has no hash: nothing it prints has the
 * shape of one, so a local number can never be taken for the canonical one.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { codeReview } = require('@verdikta/common');
const { loadCorpus, CorpusError } = require('../calibration/lib/format');
const { observe, compareCase } = require('../calibration/lib/compare');
const { EXIT, HarnessError, listingView, caseRequest, checkListing } = require('../calibration/lib/harness');
const { developmentReport } = require('../calibration/run');
const { validateRunRequest } = require('../src/request');

const ROOT = __dirname;
const LOCK_FILE = path.join(ROOT, 'canary.lock.json');
const CLASS_PLATFORM = codeReview.CLASS_HARD_LIMITS.platform;
const GVISOR = codeReview.GVISOR_RELEASE;
/** The reference is in the attestation and the listing's spec, so in the hash: one registry address everywhere. */
const CANARY_REGISTRY_PORT = 5987;
const CANARY_REPOSITORY = 'verdikta/conformance-canary';
const INPUT_DIRS = Object.freeze(['canary', 'cases']);

/** The hash of everything the canary is made of: changing any of it is a new canary, and a new report hash. */
function inputsSha256() {
  const files = [];
  const walk = (rel) => {
    const entries = fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const child = path.join(rel, e.name);
      if (e.isDirectory()) walk(child);
      else files.push(child);
    }
  };
  INPUT_DIRS.forEach(walk);
  const hash = crypto.createHash('sha256');
  for (const f of files) hash.update(`${f}\0`).update(fs.readFileSync(path.join(ROOT, f)));
  return hash.digest('hex');
}

function parseArgs(argv) {
  const o = { repeat: 1, writeLock: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--repeat') {
      o.repeat = Number(value());
      if (!Number.isInteger(o.repeat) || o.repeat < 1) throw new Error('--repeat needs a whole number of runs');
    } else if (arg === '--json') o.json = value();
    else if (arg === '--write-lock') o.writeLock = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return o;
}

function readLock() {
  return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
}

/**
 * Why this answer's hash is not the canonical one: every condition read from what the runner measured.
 * @returns {string[]} empty when it is
 */
function canonicalProblems(answer, { lock, published, listingCid, bcid, reportHash }) {
  const out = [];
  const runner = answer.runner || {};
  if (runner.runtime !== 'runsc') out.push(`the runtime was ${runner.runtime}, not runsc`);
  if (runner.gvisor !== GVISOR) out.push(`the runner measured gVisor ${runner.gvisor}, not the pinned ${GVISOR}`);
  if (runner.platform !== CLASS_PLATFORM) out.push(`the platform was ${runner.platform}, not ${CLASS_PLATFORM}`);
  const { report } = answer;
  if (!report) {
    out.push('the runner gave no report');
  } else {
    const { inputs } = report;
    if (inputs.gvisor !== GVISOR) out.push(`the report names gVisor ${inputs.gvisor}`);
    if (inputs.platform !== CLASS_PLATFORM) out.push(`the report names the platform ${inputs.platform}`);
    if (inputs.envImage !== lock.imageDigest) out.push('the report\'s envImage is not the locked image');
    if (inputs.listingCid !== listingCid || inputs.listingCid !== lock.listingCid) out.push('the report\'s listingCid is not the locked listing');
    if (inputs.bcid !== bcid || inputs.bcid !== lock.bcid) out.push('the report\'s bcid is not the locked claim');
    if (reportHash(report) !== answer.reportSha256) out.push('the runner\'s hash is not the report\'s hash as common computes it');
  }
  if (published.digest !== lock.imageDigest) out.push(`the image's digest is not the one in ${path.basename(LOCK_FILE)}`);
  return out;
}

async function writeLock(entry, stdout) {
  const { buildImage } = require('../calibration/lib/session');
  const image = await buildImage(entry.listing, CLASS_PLATFORM);
  const ref = `127.0.0.1:${CANARY_REGISTRY_PORT}/${CANARY_REPOSITORY}@${image.digest}`;
  const view = listingView(entry.listing, { image: ref, digest: image.digest });
  const { body } = caseRequest(entry, view);
  const lock = {
    platform: CLASS_PLATFORM, image: ref, imageDigest: image.digest, baseCommit: entry.listing.commit,
    listingCid: view.cid, bcid: body.bcid, inputsSha256: inputsSha256()
  };
  fs.writeFileSync(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);
  stdout(`conformance: wrote ${path.relative(process.cwd(), LOCK_FILE)}`);
}

/**
 * @param {string[]} argv
 * @param {object} [deps] - for the tests
 * @returns {Promise<number>}
 */
async function main(argv, deps = {}) {
  const stdout = deps.stdout || ((s) => process.stdout.write(`${s}\n`));
  const stderr = deps.stderr || ((s) => process.stderr.write(`${s}\n`));
  let args;
  let entry;
  try {
    args = parseArgs(argv);
    const { cases } = loadCorpus({ root: ROOT });
    if (cases.length !== 1) throw new Error(`the canary is one case; ${cases.length} found`);
    [entry] = cases;
  } catch (err) {
    stderr(err instanceof CorpusError ? err.message : `conformance: ${err.message}`);
    return EXIT.MALFORMED;
  }
  if (args.writeLock) {
    await writeLock(entry, stdout);
    return EXIT.OK;
  }
  const lock = readLock();
  const makeSession = deps.makeSession || ((o) => require('../calibration/lib/session').createSession(o));
  const settle = deps.settle || require('../calibration/lib/settle').settleReport;
  const validate = deps.validate || validateRunRequest;
  const assemble = deps.developmentReport || developmentReport;
  const reportHash = deps.reportHash || ((report) => codeReview.reportSha256(report));

  let session;
  try {
    session = await makeSession({ registryPort: CANARY_REGISTRY_PORT });
  } catch (err) {
    stderr(`conformance: the runner session did not start: ${err.message}`);
    return EXIT.HARNESS;
  }
  try {
    const { listing } = entry;
    const published = await session.publish(listing, { repository: CANARY_REPOSITORY });
    // An image that is not the locked one could only give a hash nobody else gets: stop before any claim.
    if (session.platform === CLASS_PLATFORM && published.digest !== lock.imageDigest) {
      throw new HarnessError(`the canary's image is not the one in ${path.basename(LOCK_FILE)}: the recipe, its inputs or a pin moved. A new canary is a new report hash: run --write-lock, and update C5's value with a runner release`);
    }
    const view = listingView(listing, published);
    await checkListing(session, listing, published, view);

    const hashes = new Set();
    let answer = null;
    for (let i = 0; i < args.repeat; i += 1) {
      const request = caseRequest(entry, view);
      const res = await session.run(request.body);
      answer = res.body;
      if (!answer || !answer.outcome) throw new HarnessError(`the runner answered HTTP ${res.status}`);
      const observed = observe(answer, validate(request.body).request, { settle, developmentReport: assemble });
      const disagreements = compareCase(entry.expected.runner, observed);
      if (disagreements.length) {
        stdout(`conformance: FAILED. The canary did not reach its expected result on run ${i + 1}:`);
        for (const d of disagreements) stdout(`  ${d.path}: expected ${JSON.stringify(d.expected)}, actual ${JSON.stringify(d.actual)}`);
        return EXIT.DISAGREE;
      }
      if (session.runtime === 'runsc') {
        const problems = canonicalProblems(answer, { lock, published, listingCid: view.cid, bcid: request.body.bcid, reportHash });
        if (problems.length) {
          stderr(`conformance: run ${i + 1} is not canonical, so this has no hash to print:\n  - ${problems.join('\n  - ')}`);
          return EXIT.HARNESS;
        }
        hashes.add(answer.reportSha256);
      }
    }
    stdout(`conformance: the canary reached its expected gates, flags and runs${args.repeat > 1 ? ` on all ${args.repeat} runs` : ''}`);

    if (session.runtime !== 'runsc') {
      stdout(`conformance: LOCAL RUN, no report hash. This run used ${session.runtime} on ${session.platform}. The canonical hash exists only on ${CLASS_PLATFORM} under gVisor ${GVISOR}; CI records it there and @verdikta/common pins it (C5).`);
      if (args.json) fs.writeFileSync(args.json, `${JSON.stringify({ canonical: false, runtime: session.runtime, platform: session.platform }, null, 2)}\n`);
      return EXIT.OK;
    }
    if (hashes.size !== 1) {
      stderr(`conformance: the same canary gave ${hashes.size} different report hashes in ${args.repeat} runs on this host`);
      return EXIT.DISAGREE;
    }
    const [sha] = hashes;
    const { inputs } = answer.report;
    stdout(`conformance report sha256: ${sha}`);
    stdout(`conformance: from runner ${inputs.runner}, gVisor ${inputs.gvisor}, Semgrep rules ${inputs.semgrepRules}, image ${inputs.envImage}, listing ${inputs.listingCid}, claim ${inputs.bcid}`);
    if (args.json) {
      fs.writeFileSync(args.json, `${JSON.stringify({
        canonical: true,
        reportSha256: sha,
        runner: inputs.runner,
        gvisor: inputs.gvisor,
        semgrepRules: inputs.semgrepRules,
        platform: inputs.platform,
        imageDigest: inputs.envImage,
        baseCommit: inputs.baseCommit,
        listingCid: inputs.listingCid,
        bcid: inputs.bcid,
        runs: args.repeat,
        report: answer.report
      }, null, 2)}\n`);
    }
    return EXIT.OK;
  } catch (err) {
    stderr(`conformance: ${err.message}`);
    return EXIT.HARNESS;
  } finally {
    await session.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`conformance: ${err.stack}\n`);
    process.exitCode = EXIT.HARNESS;
  });
}

module.exports = { main, canonicalProblems, inputsSha256, EXIT, CANARY_REGISTRY_PORT, CANARY_REPOSITORY };
