#!/usr/bin/env node
'use strict';

/**
 * npm run calibration: every case through the real code runner, its result against what the case says.
 *
 *   npm run calibration [-- --subset <name>] [--case <id>]... [--self-check] [--results <file>] [--export <dir>]
 *
 * Runner only: no jury, no chain, no provider, no pin service. Exit 0 when every case agrees;
 * 1 on any disagreement; 2 when the corpus or the command is malformed, before anything ran;
 * 3 when the harness could not measure (no Docker, a listing the runner refuses).
 *
 * --self-check alters each expected value and requires the comparison to notice, against what
 * the runner really did. --results writes what happened. --export writes the cases that reach
 * the jury as the testing tool's scenario folders (A6b), which needs a report from the runner,
 * so the class platform.
 */

const fs = require('node:fs');
const path = require('node:path');
const { codeReview } = require('@verdikta/common');
const { loadCorpus, selectCases, CorpusError } = require('./lib/format');
const { observe, compareCase, relationProblems, mutations, agreement, renderReport, actualLabel, classOf } = require('./lib/compare');
const { EXIT, HarnessError, listingView, caseRequest, checkListing } = require('./lib/harness');
const { buildReport } = require('../src/report');
const { validateRunRequest } = require('../src/request');

const ROOT = __dirname;

function parseArgs(argv) {
  const o = { cases: [], selfCheck: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--subset') o.subset = value();
    else if (arg === '--case') o.cases.push(value());
    else if (arg === '--results') o.results = value();
    else if (arg === '--export') o.exportDir = value();
    else if (arg === '--self-check') o.selfCheck = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return o;
}

/**
 * Where the runner has no report to give (linux/arm64, a development platform, A3b), the same
 * function builds one with the class platform named, for settleReport to read. It is never
 * printed as a hash and never exported.
 */
function developmentReport(answer, request) {
  const { report } = buildReport({ gates: answer.gates, facts: answer.facts, platform: answer.runner.platform }, request, { gvisor: answer.runner.gvisor, platform: codeReview.CLASS_HARD_LIMITS.platform });
  return report;
}

function selfCheck(results, stdout) {
  let tried = 0;
  const missed = [];
  for (const r of results) {
    for (const { label, runner } of mutations(r.entry.expected.runner)) {
      tried += 1;
      if (compareCase(runner, r.observed).length === 0) missed.push(`${r.id}: altering ${label} was not noticed`);
    }
  }
  if (missed.length) return missed;
  stdout(`self-check: ${tried} alterations of the expected results, every one noticed`);
  return [];
}

/** One testing-tool scenario folder (testing-tool/README.md, "Claim Scenarios"). */
function writeScenario(dir, r) {
  const folder = path.join(dir, r.id);
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  const { expected } = r.entry;
  fs.writeFileSync(path.join(folder, 'scenario.json'), `${JSON.stringify({
    id: r.id, expected_outcome: classOf(expected), tags: r.entry.subsets, notes: `${r.entry.title}. ${expected.reason}`
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(folder, 'listing.zip'), r.view.buffer);
  fs.writeFileSync(path.join(folder, 'claim.zip'), r.request.archive);
  if (r.request.priors.length) {
    fs.mkdirSync(path.join(folder, 'priors'));
    for (const prior of r.request.priors) fs.writeFileSync(path.join(folder, 'priors', `${prior.name}.zip`), prior.buffer);
  }
  const { report, reportSha256, contextPack } = r.answer;
  fs.writeFileSync(path.join(folder, 'run.json'), JSON.stringify({ report, reportSha256, contextPack }));
}

function resultsFile({ results, runner }) {
  return {
    format: 'verdikta.calibration-results/1',
    runner,
    agreement: agreement(results),
    cases: results.map((r) => {
      const { pack: _text, ...observed } = r.observed;
      return { id: r.id, expected: { outcome: r.expected.outcome, class: r.expected.class }, actual: r.actual, disagreements: r.disagreements, ms: r.ms, observed };
    })
  };
}

/**
 * @param {string[]} argv
 * @param {object} [deps] - for the tests: root, makeSession, settle, validate, developmentReport, stdout, stderr
 * @returns {Promise<number>} the exit code
 */
async function main(argv, deps = {}) {
  const stdout = deps.stdout || ((s) => process.stdout.write(`${s}\n`));
  const stderr = deps.stderr || ((s) => process.stderr.write(`${s}\n`));
  let args;
  let chosen;
  try {
    args = parseArgs(argv);
    const corpus = loadCorpus({ root: deps.root || ROOT });
    chosen = selectCases(corpus, args);
  } catch (err) {
    stderr(err instanceof CorpusError ? err.message : `calibration: ${err.message}`);
    return EXIT.MALFORMED;
  }
  const makeSession = deps.makeSession || ((o) => require('./lib/session').createSession(o));
  const settle = deps.settle || require('./lib/settle').settleReport;
  const validate = deps.validate || validateRunRequest;
  const assemble = deps.developmentReport || developmentReport;

  let session;
  try {
    session = await makeSession({});
  } catch (err) {
    stderr(`calibration: the runner session did not start: ${err.message}`);
    return EXIT.HARNESS;
  }
  try {
    if (args.exportDir && session.platform !== codeReview.CLASS_HARD_LIMITS.platform) {
      stderr(`calibration: --export needs a report from the runner, and this host runs ${session.platform}; a report exists only on ${codeReview.CLASS_HARD_LIMITS.platform}`);
      return EXIT.MALFORMED;
    }
    const views = new Map();
    for (const listing of new Set(chosen.map((c) => c.listing))) {
      stdout(`calibration: publishing ${listing.id}'s image, then the real listing check`);
      const published = await session.publish(listing);
      const view = listingView(listing, published);
      await checkListing(session, listing, published, view);
      views.set(listing, view);
    }
    const results = [];
    for (const [i, entry] of chosen.entries()) {
      stdout(`calibration: [${i + 1}/${chosen.length}] ${entry.id}`);
      const view = views.get(entry.listing);
      const request = caseRequest(entry, view);
      const started = Date.now();
      const res = await session.run(request.body);
      const answer = res.body;
      if (!answer || !answer.outcome) throw new HarnessError(`${entry.id}: the runner answered HTTP ${res.status}: ${JSON.stringify(answer).slice(0, 400)}`);
      const checked = validate(request.body);
      const observed = observe(answer, checked.request, { settle, developmentReport: assemble });
      results.push({
        id: entry.id, entry, view, request, answer, observed,
        expected: entry.expected, actual: actualLabel(observed), disagreements: compareCase(entry.expected.runner, observed), ms: Date.now() - started
      });
    }
    const byId = new Map(results.map((r) => [r.id, r]));
    for (const r of results) {
      if (!r.entry.control) continue;
      const other = byId.get(r.entry.control.case);
      for (const problem of relationProblems(r.entry.control, r.observed, other.observed)) {
        r.disagreements.push({ path: 'relation', expected: problem, actual: `${r.id} and ${other.id}` });
      }
    }
    const note = results.some((r) => r.observed.reportSource === 'assembled-for-development')
      ? `the runner gives no report on ${session.platform}; settlement read one assembled with the class platform named, never exported, and no hash of it is shown`
      : null;
    stdout(renderReport({ results, runner: session.runner, note }));
    if (args.results) fs.writeFileSync(args.results, `${JSON.stringify(resultsFile({ results, runner: session.runner }), null, 2)}\n`);
    const disagreed = results.filter((r) => r.disagreements.length).length;
    if (disagreed) return EXIT.DISAGREE;
    if (args.selfCheck) {
      const missed = selfCheck(results, stdout);
      if (missed.length) {
        stderr(`calibration: --self-check failed:\n  - ${missed.join('\n  - ')}`);
        return EXIT.DISAGREE;
      }
    }
    if (args.exportDir) {
      fs.mkdirSync(args.exportDir, { recursive: true });
      const toJury = results.filter((r) => r.actual === 'jury');
      for (const r of toJury) writeScenario(args.exportDir, r);
      stdout(`calibration: exported ${toJury.length} scenario(s) to ${args.exportDir}: the cases that reach the jury`);
    }
    return EXIT.OK;
  } catch (err) {
    stderr(`calibration: ${err.message}`);
    return EXIT.HARNESS;
  } finally {
    await session.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`calibration: ${err.stack}\n`);
    process.exitCode = EXIT.HARNESS;
  });
}

module.exports = { main, EXIT, developmentReport };
