'use strict';

/**
 * Listing checks: POST /v1/listing-checks (design §8.2 steps 2-3, §8.3;
 * node A2b). The attestation site's validator (P3a) calls this, so a listing
 * is validated on the arbiters' own runner (build plan, assumption A4).
 *
 * In sandboxes launched, limited and timed exactly as a claim's (the same
 * engine, admission, image pull and isolation; pipeline.js), one at a time:
 *
 *   image     the env image's unpacked size, from the runner's daemon
 *   prepare   the claim pipeline's own prepare (claim.js): the processes
 *             recorded and the forced checkout of the listed commit; then
 *             the work tree's free space and its tracked files; then a
 *             claim's integrity reference (node A2c): an image a claim would
 *             refuse is refused here with the same code, as the same 400
 *   compilers the look at any solc in the image (owner Q35 condition 2,
 *             integrity.officialCompilers): anything that is not an official
 *             release is SOLC_NOT_OFFICIAL, before any build. Listing only: a
 *             claim never reads the list (solcReleases.js). And the look at
 *             any vyper (owner Q40, integrity.vyperProblems): one on PATH or a
 *             vyper setting is VYPER_NOT_SUPPORTED, before any build, also
 *             listing only. A .vy file alone is no reason
 *   build     the declared build command, once, at the listed commit (every
 *             command is parsed by src/commands.js and run as forge's argv,
 *             the reference's forge with its pin, as a claim runs it), then
 *             the same comparison as a claim's
 *   suite     the declared test command three times, with the runner's
 *             reporter flags (--junit, the fixed --fuzz-seed) and no
 *             network; the tracked files reset to the listed commit before
 *             runs 2 and 3; after each run a claim's post-run checksums, and a
 *             run that changed a watched set is IMAGE_WATCH_CHANGED_BY_SUITE,
 *             the paths named. Every test the JUnit names, with its result on
 *             each run, is baseline.json (common's rule: passed all three
 *             runs = stable, anything else unstable)
 *   limits    defaults of 3x the measured times plus the repeat-schedule
 *             reserve (below); a listing whose limits would pass the class's
 *             90 s build or 360 s run cap is too heavy for v1
 *   harness   the harness proof: trivial tests under paths.tests, each run
 *             as a claim is, in a fresh sandbox of its own (the forced
 *             checkout, then applies, testPathsOnly, the protected reset,
 *             the commit, what a context pack reads, the reference) and through testFiles and testIds
 *             under the default limits by the claim pipeline's own reproduces
 *             gate, each run followed by the same snapshot. The trivially
 *             failing test must fail as an assertion on all three runs; a
 *             trivially broken one (a compile error, a failing setUp) must be
 *             an error. Otherwise the listing cannot host claims (§10.1 depends
 *             on the distinction). A probe's run that changed a watched set is
 *             HARNESS_INTEGRITY_FAILED, the paths named
 *
 * The check runs no claim. Its request has no patch, no baseline and no
 * claim fields (they are refused as unknown); the only patches it applies
 * are the runner's own probe files, fixed here; it records no gate
 * (`ctx.gate` is never reached: the claim functions it reuses gate into a
 * scope of their own) and its answer carries no `gates`, report or context
 * pack, so nothing in it can be taken for a claim's result.
 *
 * Time. Measured wall-clock times, in ms: P (prepare, free space, tracked
 * files, what a context pack reads, the reference), B (the build, its cleanup and its comparison), T (the
 * longest suite run, with its reset, its cleanup and its snapshot), so the
 * defaults count what a claim's run does. The look is not in them: a claim
 * does not run it. The defaults are
 *
 *   buildSeconds = ceil(3 B)
 *   testSeconds  = ceil(3 T)
 *   runSeconds   = ceil(3 (P + B + T)) + 2 testSeconds    (runs 2 and 3: the repeat reserve)
 *
 * Each measured step is stopped at the point beyond which those limits can
 * no longer fit the class caps, and a step stopped by its own limit is a
 * refusal (LISTING_TOO_HEAVY), not an abstain: the measurement is the
 * answer. The run's own budget, the deadline and every other limit event
 * abstain as for /v1/runs.
 */

const { ABSTAIN, Abstain, RequesterError, makeGate } = require('./result');
const { Prefix } = require('./capture');
const { runText, isUnreachableText } = require('./docker');
const { git } = require('./git');
const forge = require('./forge');
const integrity = require('./integrity');
const { officialList, SOURCE: SOLC_SOURCE } = require('./solcReleases');
const { claimSession, checkForgeSpec, FREE_SPACE_SCRIPT, FREE_SPACE_MARGIN_BYTES, RUNS: CLAIM_RUNS } = require('./claim');
const { commandIssues } = require('./commands');

/** The leftover-process records of the claim steps' facts (A3a: a tier-A fact, `{ tier, steps }`). */
function leftovers(facts) {
  const f = facts.leftoverProcesses;
  return f && Array.isArray(f.steps) ? f.steps : [];
}
const { checkSpec, CLASS_HARD_LIMITS, IMAGE_REF, OCI_PLATFORM } = require('./classLimits');
const { parseImageRef } = require('./registry');
const { matchesAny, normalizePath, pocPatchPathsGate, baselineSets, validateBaseline, BASELINE_RUNS } = require('./common');
const { parseLsTreeZ, reportablePath } = require('./patch');
const { MAX_DEADLINE_MS } = require('./request');

/** The only fields a listing check takes. */
const LISTING_FIELDS = Object.freeze(['spec', 'image', 'deadline']);
/** The suite's runs (common's BASELINE_RUNS), which are also the claim's fixed repeat schedule. */
const RUNS = BASELINE_RUNS;
if (RUNS !== CLAIM_RUNS) throw new Error('the baseline runs and the claim repeat schedule must agree');
/** Default limits are this many times the measured time (§8.2 step 2, §9.3). */
const MARGIN = 3;
/**
 * The check's own run budget: the baseline (whose measured steps are bounded
 * so the limits fit the class's 360 s) and the harness proof (under those
 * limits). The deadline must leave this much, as runSeconds for a claim.
 */
const LISTING_CHECK_SECONDS = 2 * CLASS_HARD_LIMITS.runSeconds;
/** Other names a probe file may take when the first is taken: <stem>2.t.sol … <stem>9.t.sol. */
const PROBE_ALTERNATES = 8;
const GIT_TIMEOUT_MS = 120000;
const FREE_SPACE_TIMEOUT_MS = 120000;
const IMAGE_SIZE_TIMEOUT_MS = 30000;
/** The listed commit's paths are read up to this (the claim pipeline's own cap). */
const TREE_LIST_MAX = 16 * 1024 * 1024;
const MAX_LISTED = 20;

const OWN_TIMEOUT = /^the step reached its wall-clock limit/;
const SAFE_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
/** The checks that compare a snapshot with the reference: the ones a probe's own run can trip however its test ends. */
const CHECKSUM_CHECKS = Object.freeze(['protectedPathsUnchanged', 'frameworkUnchanged', 'dependenciesUnchanged']);
const PROBE_STEM = 'VerdiktaHarness';
/** forge's default `test` directory (foundry.toml `test = "test"`). */
const FORGE_TEST_DIR = 'test';
/**
 * The probes' pragmas: forge-std's own floor for the one that imports it;
 * the oldest compiler with revert reasons for the others (R3-F2), which use
 * nothing newer (a revert with a reason, pure functions, an undeclared name).
 */
const PRAGMA_FORGE_STD = 'pragma solidity >=0.6.2;';
const PRAGMA_PLAIN = 'pragma solidity >=0.4.22;';

/**
 * The harness probes: fixed sources, never the request's. `fails` uses the
 * listing's own forge-std assertion when forge-std resolves (so non-reverting,
 * legacy assertions are caught), else a plain revert.
 */
const PROBES = Object.freeze({
  failsForgeStd: Object.freeze({
    name: 'fails', variant: 'forge-std', build: true, contract: `${PROBE_STEM}Fails`, test: 'test_verdiktaHarnessFails()',
    lines: Object.freeze([
      '// SPDX-License-Identifier: MIT',
      PRAGMA_FORGE_STD,
      'import {Test} from "forge-std/Test.sol";',
      `contract ${PROBE_STEM}Fails is Test {`,
      '    function test_verdiktaHarnessFails() public {',
      '        assertEq(uint256(1), uint256(2), "verdikta harness: a trivially failing test");',
      '    }',
      '}'
    ])
  }),
  failsPlain: Object.freeze({
    name: 'fails', variant: 'plain', build: true, contract: `${PROBE_STEM}Fails`, test: 'test_verdiktaHarnessFails()',
    lines: Object.freeze([
      '// SPDX-License-Identifier: MIT',
      PRAGMA_PLAIN,
      `contract ${PROBE_STEM}Fails {`,
      '    function test_verdiktaHarnessFails() public pure {',
      '        revert("verdikta harness: a trivially failing test");',
      '    }',
      '}'
    ])
  }),
  // Run straight through testFiles, without the build: the JUnit route is what is proven.
  compileError: Object.freeze({
    name: 'compileError', variant: null, build: false, contract: `${PROBE_STEM}CompileError`, test: 'test_verdiktaHarnessCompileError()',
    lines: Object.freeze([
      '// SPDX-License-Identifier: MIT',
      PRAGMA_PLAIN,
      `contract ${PROBE_STEM}CompileError {`,
      '    function test_verdiktaHarnessCompileError() public pure {',
      '        verdiktaHarnessUndeclared();',
      '    }',
      '}'
    ])
  }),
  setUpError: Object.freeze({
    name: 'setUpError', variant: null, build: true, contract: `${PROBE_STEM}SetUpError`, test: 'test_verdiktaHarnessSetUpError()',
    lines: Object.freeze([
      '// SPDX-License-Identifier: MIT',
      PRAGMA_PLAIN,
      `contract ${PROBE_STEM}SetUpError {`,
      '    function setUp() public pure {',
      '        revert("verdikta harness: a trivially broken setUp");',
      '    }',
      '    function test_verdiktaHarnessSetUpError() public pure {}',
      '}'
    ])
  })
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function firstLine(text) {
  const line = String(text || '').split(/\r?\n/).find((l) => l.trim());
  return line ? line.trim().slice(0, 300) : '';
}

function seconds(ms) {
  return Math.round(ms) / 1000;
}

function listed(items) {
  const shown = items.slice(0, 5).join(', ');
  return items.length > 5 ? `${shown} and ${items.length - 5} more` : shown;
}

// ------------------------------------------------------------------ request

/**
 * Validate a POST /v1/listing-checks body.
 *
 * `spec` is code_review.json as the maker drafted it: the commands, the
 * listed commit, the paths, `env.from`, and optionally `limits` (cpus and
 * memory the check then runs with; time limits are checked against the
 * measured defaults), `env.image` (equal to `image`), `env.platform` and
 * `env.unpackedBytes` (checked against the class maximum only: the draft's
 * size is not attested, so the pull's disk check always reserves the class
 * maximum). `image` is the env image, pinned by digest.
 * `deadline` is the remaining time in ms, as for /v1/runs.
 *
 * @param {unknown} body
 * @returns {{ok:boolean, issues:object[], request:object|null, limits:object|null}}
 *   `limits`: what the check runs under (the spec's cpus, memory and patch
 *   size within the class; the class's build and test limits; its own budget)
 */
function validateListingRequest(body) {
  const issues = [];
  const issue = (code, path, detail) => issues.push({ code, path, detail });
  const failed = () => ({ ok: false, issues, request: null, limits: null });
  if (!isPlainObject(body)) {
    issue('SCHEMA', '/', 'the body must be a JSON object');
    return failed();
  }
  for (const key of Object.keys(body)) {
    if (!LISTING_FIELDS.includes(key)) {
      issue('UNKNOWN_FIELD', `/${key}`, `unknown field; a listing check takes ${LISTING_FIELDS.join(', ')} only (it runs no claim: no patch, no baseline)`);
    }
  }
  let imageOk = false;
  if (body.image === undefined) issue('REQUIRED', '/image', 'is required');
  else if (typeof body.image !== 'string' || !IMAGE_REF.test(body.image)) issue('SCHEMA', '/image', 'must be the env image pinned by digest (name@sha256:<64 hex>)');
  else {
    try {
      parseImageRef(body.image);
      imageOk = true;
    } catch (err) {
      issue('SCHEMA', '/image', `is not an image reference Docker resolves as written: ${err.message}`);
    }
  }
  if (body.deadline === undefined) issue('REQUIRED', '/deadline', 'is required');
  else if (!Number.isInteger(body.deadline) || body.deadline < 1 || body.deadline > MAX_DEADLINE_MS) {
    issue('SCHEMA', '/deadline', `must be the remaining time in milliseconds, an integer from 1 to ${MAX_DEADLINE_MS}`);
  }
  if (body.spec === undefined) {
    issue('REQUIRED', '/spec', 'is required');
    return failed();
  }
  const spec = body.spec;
  if (!isPlainObject(spec)) {
    issue('SCHEMA', '/spec', 'must be an object (code_review.json)');
    return failed();
  }

  // The parts of the spec a claim's run enforces, checked the same way (classLimits.checkSpec): the env the check runs is
  // `image`, the platform the class's, the size the declared one or the class maximum.
  const env = spec.env === undefined ? {} : spec.env;
  if (!isPlainObject(env)) issue('SCHEMA', '/spec/env', 'must be an object');
  else if (env.image !== undefined && env.image !== body.image) {
    issue('IMAGE_MISMATCH', '/spec/env/image', 'code_review.json names another image than the one to check');
  }
  const effectiveEnv = {
    image: imageOk ? body.image : undefined,
    platform: isPlainObject(env) && env.platform !== undefined ? env.platform : OCI_PLATFORM,
    unpackedBytes: isPlainObject(env) && env.unpackedBytes !== undefined ? env.unpackedBytes : CLASS_HARD_LIMITS.imageUnpackedBytes
  };
  const s = checkSpec({ env: effectiveEnv, ...(spec.limits !== undefined ? { limits: spec.limits } : {}) });
  for (const i of s.issues) if (i.path !== '/spec/env/image') issues.push(i);

  // What the forge adapter needs (claim.js), and the full suite's command: one grammar (commands.js), so a listing is
  // refused here for exactly the forms a claim would refuse.
  issues.push(...checkForgeSpec({ ...spec, env: isPlainObject(env) ? env : {} }), ...commandIssues(spec.commands, 'test'));

  const stake = spec.stake;
  if (stake !== undefined && isPlainObject(stake) && stake.scope !== undefined) {
    const sc = stake.scope;
    const globs = (v) => Array.isArray(v) && v.every((g) => typeof g === 'string' && g !== '');
    if (!isPlainObject(sc) || !globs(sc.include) || sc.include.length === 0) issue('SCHEMA', '/spec/stake/scope/include', 'must be a non-empty list of globs');
    else if (sc.exclude !== undefined && !globs(sc.exclude)) issue('SCHEMA', '/spec/stake/scope/exclude', 'must be a list of globs');
  }

  if (issues.length) return failed();
  const specLimits = s.limits;
  const limits = Object.freeze({
    ...specLimits,
    buildSeconds: CLASS_HARD_LIMITS.buildSeconds,
    testSeconds: CLASS_HARD_LIMITS.runSeconds,
    runSeconds: LISTING_CHECK_SECONDS
  });
  return {
    ok: true,
    issues: [],
    // The pull's disk admission (images.js) reserves what a run declares; a draft's size is the maker's word, not an
    // attested one, so a listing check always reserves the class maximum (R1-F1). The measured size is in the answer.
    request: { spec, image: body.image, deadlineMs: body.deadline, unpackedBytes: CLASS_HARD_LIMITS.imageUnpackedBytes, specLimits },
    limits
  };
}

// -------------------------------------------------------------- the numbers

/**
 * The default limits from the measured times (ms), and the caps they pass.
 * @returns {{limits:object, over:string[]}}
 */
function deriveLimits({ prepareMs, buildMs, testMs }, specLimits, caps = CLASS_HARD_LIMITS) {
  const longest = Math.max(...testMs);
  const buildSeconds = Math.max(1, Math.ceil((MARGIN * buildMs) / 1000));
  const testSeconds = Math.max(1, Math.ceil((MARGIN * longest) / 1000));
  const runSeconds = Math.ceil((MARGIN * (prepareMs + buildMs + longest)) / 1000) + (RUNS - 1) * testSeconds;
  const over = [];
  if (buildSeconds > caps.buildSeconds) over.push(`buildSeconds would be ${buildSeconds}, above the class's ${caps.buildSeconds}`);
  if (runSeconds > caps.runSeconds) over.push(`runSeconds would be ${runSeconds}, above the class's ${caps.runSeconds}`);
  return {
    limits: {
      cpus: specLimits.cpus,
      memoryMb: specLimits.memoryMb,
      buildSeconds,
      testSeconds,
      runSeconds,
      maxPatchBytes: specLimits.maxPatchBytes
    },
    over
  };
}

/** The longest build (ms) after which the limits can no longer fit the caps, whatever the suite takes. */
function buildBudgetMs(prepareMs, caps = CLASS_HARD_LIMITS) {
  return Math.floor(Math.min((caps.buildSeconds * 1000) / MARGIN, ((caps.runSeconds - RUNS) * 1000) / MARGIN - prepareMs));
}

/** The longest suite run (ms) after which runSeconds can no longer fit the cap. */
function suiteBudgetMs(prepareMs, buildMs, caps = CLASS_HARD_LIMITS) {
  return Math.floor(((caps.runSeconds - RUNS) * 1000 - MARGIN * (prepareMs + buildMs)) / (MARGIN * RUNS));
}

/** The smallest runSeconds the measured preparation allows (a build and suite of no time at all). */
function minimumRunSeconds(prepareMs) {
  return Math.ceil((MARGIN * prepareMs) / 1000) + (RUNS - 1);
}

/**
 * baseline.json from the three suite runs: every test function the JUnit
 * names (forge's identity, forge.testIdentity), its result on each run by
 * the claim pipeline's own classifier; missing or duplicated on a run is an
 * error there. Harness records (a failing setUp) are not tests: they are
 * returned per run for a warning.
 */
function baselineOf(runs, { baseCommit, timings }) {
  const perRun = runs.map((run) => {
    const records = new Map();
    const harness = [];
    for (const s of run.suites) {
      for (const c of s.cases) {
        if (forge.isHarnessRecord(c.name)) {
          if (c.outcome === 'failure' || c.outcome === 'error') harness.push(`${s.file}:${s.contract} ${c.name}`);
          continue;
        }
        if (!forge.isTestFunction(c.name)) continue;
        const id = forge.testIdentity(s.file, s.contract, c.name);
        if (!records.has(id)) records.set(id, []);
        records.get(id).push(c);
      }
    }
    return { records, harness: [...new Set(harness)].sort() };
  });
  const ids = [...new Set(perRun.flatMap((r) => [...r.records.keys()]))].sort();
  const tests = ids.map((id) => ({
    id,
    results: perRun.map((r) => {
      const got = r.records.get(id);
      return got && got.length === 1 ? forge.classifyRecord(got[0]).result : 'error';
    })
  }));
  const { stable, unstable } = baselineSets(tests);
  return {
    baseline: { version: 1, baseCommit, framework: 'forge', runs: RUNS, tests, stable, unstable, timings },
    harness: perRun.map((r) => r.harness)
  };
}

/** Paths a probe could take for one glob of paths.tests: its literal directory, and the glob with its wildcards filled. */
function probeCandidates(glob) {
  const g = normalizePath(glob);
  const segments = g.split('/');
  const literal = [];
  for (const seg of segments) {
    if (/[*?]/.test(seg)) break;
    literal.push(seg);
  }
  if (literal.length === segments.length) return [g];
  const filled = g
    .replace(/\*\*\//g, '')
    .replace(/\/\*\*$/, `/${PROBE_STEM}.t.sol`)
    .replace(/\*\*/g, `${PROBE_STEM}.t.sol`)
    .replace(/\*/g, PROBE_STEM)
    .replace(/\?/g, 'v');
  return [...new Set([[...literal, `${PROBE_STEM}.t.sol`].join('/'), filled])];
}

/**
 * Where the probes go: the first candidate that is a plain Solidity path the
 * claim gates admit (under paths.tests, not protected) and that no tracked
 * file holds, sits under or sits on. A candidate taken is tried again with
 * a number (VerdiktaHarness2.t.sol, … 9). The directories the suite's own
 * test files ran from come first (R5-F1: forge ran tests there, whatever
 * foundry.toml calls its test directory), then forge's default test
 * directory (a glob such as `**` would otherwise put the probe at the root,
 * where forge looks for no test), then glob by glob.
 * @param {object} spec
 * @param {string[]} tracked - the listed commit's files
 * @param {{suiteFiles?: string[]}} [o] - the files the suite's JUnit named
 * @returns {string|null}
 */
function harnessPath(spec, tracked, { suiteFiles = [] } = {}) {
  const files = new Set(tracked);
  const counts = new Map();
  for (const f of suiteFiles) {
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : null;
    if (dir) counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  // Most test files first, then code-unit order: the same choice on every host.
  const ran = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([dir]) => `${dir}/${PROBE_STEM}.t.sol`);
  const fallback = [`${FORGE_TEST_DIR}/${PROBE_STEM}.t.sol`, ...spec.paths.tests.flatMap(probeCandidates)];
  // A candidate, then the same with a number, for a name the repository already uses (R1-F3): every name in the
  // directories the suite ran from before any fallback (R5-F1), then the fallbacks' first names, then their numbered.
  const numbered = (p) => Array.from({ length: PROBE_ALTERNATES }, (_, i) => p.replace(/((?:\.t)?\.sol)$/, `${i + 2}$1`));
  const candidates = [...ran.flatMap((p) => [p, ...numbered(p)]), ...fallback, ...fallback.flatMap(numbered)];
  for (const p of new Set(candidates)) {
    if (!p.endsWith('.sol') || !SAFE_PATH.test(p) || !reportablePath(p)) continue;
    if (!pocPatchPathsGate([p], spec).pass) continue;
    if (files.has(p)) continue;
    const parts = p.split('/');
    if (parts.slice(1).some((_, i) => files.has(parts.slice(0, i + 1).join('/')))) continue;
    if (tracked.some((f) => f.startsWith(`${p}/`))) continue;
    return p;
  }
  return null;
}

/** A git patch that adds the probe file. */
function probePatch(path, lines) {
  return Buffer.from([
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    ''
  ].join('\n'));
}

/**
 * The env image's unpacked size: the sum of its layers' sizes as the
 * runner's daemon reports them (`docker history`), the figure its disk holds
 * once the image is pulled and extracted.
 * @returns {Promise<number>}
 * @throws {Abstain}
 */
async function imageUnpackedBytes(docker, image, { timeoutMs = IMAGE_SIZE_TIMEOUT_MS } = {}) {
  const step = 'image:size';
  const r = await runText(docker, ['history', '--human=false', '--no-trunc', '--format', '{{.Size}}', image], { timeoutMs });
  if (r.spawnError) throw new Abstain(ABSTAIN.DOCKER_UNREACHABLE, `the docker CLI could not be started: ${r.spawnError}`, { step });
  if (r.timedOut) throw new Abstain(ABSTAIN.DOCKER_ERROR, 'docker history did not answer in time', { step });
  if (r.exitCode !== 0) {
    throw new Abstain(isUnreachableText(r.stderr) ? ABSTAIN.DOCKER_UNREACHABLE : ABSTAIN.DOCKER_ERROR,
      `the env image's layers could not be read: ${firstLine(r.stderr) || `exit ${r.exitCode}`}`, { step });
  }
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0 || r.stdoutOverLimit || !lines.every((l) => /^[0-9]{1,15}$/.test(l))) {
    throw new Abstain(ABSTAIN.DOCKER_ERROR, 'docker history did not list the env image\'s layer sizes', { step });
  }
  return lines.reduce((n, l) => n + Number(l), 0);
}

// -------------------------------------------------------------------- steps

/**
 * What a suite run changed, from the reference's record: the failures in their words, every path it names.
 * @param {{protected:string[], framework:string[], dependencies:string[]}} failures - Watch.failures
 * @param {{protected:string[], framework:string[], dependencies:string[]}} changed - Watch.changedFacts()
 * @returns {{detail:string, paths:string[]}|null}
 */
function watchedChanges(failures, changed) {
  const all = [...failures.protected, ...failures.dependencies, ...failures.framework];
  if (all.length === 0) return null;
  const details = [...new Set(all)];
  return { detail: listed(details), paths: [...new Set([...changed.protected, ...changed.dependencies, ...changed.framework])].sort() };
}

/** A step that ran into its own wall-clock limit (not the run's, not the deadline's). */
function ownTimeout(err, isStep) {
  return err instanceof Abstain && err.cause === ABSTAIN.STEP_TIMEOUT && OWN_TIMEOUT.test(err.detail || '') && isStep(err.step || '');
}

/**
 * A context for the claim functions the check reuses: their gates and facts
 * stay in `gates` and `facts` (never the run's), and their steps are named
 * under `prefix`. With `stopAt` (epoch ms), every step is also bounded by
 * it, as a claim's steps are by its runSeconds: a step that the bound (not
 * its own limit) stopped is named in `overBudget`.
 */
function scoped(ctx, prefix = null, { stopAt = null } = {}) {
  const gates = {};
  const facts = {};
  const scope = { gates, facts, overBudget: null, ctx: null };
  const named = (name) => (prefix && name ? `${prefix}:${name}` : name);
  const bounded = (run, fallback) => async (target, o = {}) => {
    const name = named(o.name || fallback(target));
    if (stopAt === null) return run(target, { ...o, name });
    const left = Math.max(0, stopAt - Date.now());
    const own = Number.isFinite(o.timeoutMs) ? o.timeoutMs : Infinity;
    try {
      return await run(target, { ...o, name, timeoutMs: Math.min(own, left) });
    } catch (err) {
      if (left < own && ownTimeout(err, (st) => st === name)) scope.overBudget = name;
      throw err;
    }
  };
  scope.ctx = {
    ...ctx,
    exec: bounded((argv, o) => ctx.exec(argv, o), (argv) => argv[0]),
    readFile: bounded((p, o) => ctx.readFile(p, o), (p) => `read:${p}`),
    gate(name, status, basis, detail) {
      gates[name] = makeGate(status, basis, detail);
    },
    fact(name, value) {
      facts[name] = value;
    }
  };
  return scope;
}

/**
 * The listing check's steps.
 * @param {object} request - validateListingRequest().request
 * @param {object} limits - validateListingRequest().limits
 * @param {object} o
 * @param {Function} o.imageSize - async () => unpacked bytes (imageUnpackedBytes on the runner's docker)
 * @param {string} o.platform - the runner's platform, whose official solc releases the look reads
 * @param {object} [o.solcList] - another list than the runner's (solcReleases.makeList; tests only)
 * @param {object} [o.caps] - the class caps the defaults must fit (the class's hard limits)
 * @returns {Function[]}
 */
function listingSteps(request, limits, { imageSize, platform, solcList = null, caps = CLASS_HARD_LIMITS } = {}) {
  if (typeof imageSize !== 'function') throw new TypeError('listingSteps needs imageSize');
  if (typeof platform !== 'string') throw new TypeError('listingSteps needs the runner\'s platform');
  const official = solcList || officialList(platform);
  const spec = request.spec;
  const out = {
    status: null,
    refusals: [],
    warnings: [],
    image: { ref: request.image, unpackedBytes: null },
    compilers: null,
    checkout: null,
    timings: null,
    baseline: null,
    limits: null,
    suite: null,
    harness: null,
    leftoverProcesses: []
  };
  const state = { stop: false, first: null, base: null, tracked: null, scope: null, prepareMs: 0, buildMs: 0, testMs: [], defaults: null, sandbox: null, suiteFiles: [] };
  const refuse = (code, detail, extra = {}) => {
    out.refusals.push({ code, detail, ...extra });
    state.stop = true;
  };
  const warn = (code, detail) => out.warnings.push({ code, detail });
  const stub = { spec, pocPatch: Buffer.alloc(0), baseline: { tests: [] } };
  const runnerError = (step, detail) => new Abstain(ABSTAIN.RUNNER_ERROR, detail, { step });

  async function resetToListed(ctx, name) {
    const r = await ctx.exec(git(['reset', '--quiet', '--hard', state.base.prepared]), { name, timeoutMs: GIT_TIMEOUT_MS });
    if (r.exitCode !== 0) throw runnerError(name, `the work tree could not be reset to the listed commit: ${firstLine(r.stderr.text)}`);
  }

  async function image() {
    const bytes = await imageSize();
    out.image.unpackedBytes = bytes;
    if (bytes > caps.imageUnpackedBytes) {
      refuse('IMAGE_ABOVE_CLASS_MAX', `the env image is ${bytes} bytes unpacked; the class allows ${caps.imageUnpackedBytes}`);
    }
  }

  async function prepare(ctx) {
    const t0 = Date.now();
    state.scope = scoped(ctx);
    const s0 = claimSession(stub, limits);
    await s0.prepare(state.scope.ctx);
    state.first = s0;
    state.base = s0.state;
    out.checkout = state.scope.facts.checkout || null;
    if (out.checkout && out.checkout.corrected > 0) {
      warn('CHECKOUT_CORRECTED', `${out.checkout.corrected} tracked path${out.checkout.corrected === 1 ? '' : 's'} in the image differ from the listed commit `
        + `(${listed(out.checkout.correctedPaths || [])}); claims run on the listed commit's files, and so did this check`);
    }

    // A claim needs this much room before its patch is applied (claim.js); a listing whose image leaves less would
    // make every claim the requester's error.
    const free = new Prefix(256);
    const space = await ctx.exec(['/bin/sh', '-c', FREE_SPACE_SCRIPT, 'vcr-freespace'], { name: 'prepare:space', timeoutMs: FREE_SPACE_TIMEOUT_MS, tee: free });
    const m = /vcr-free ([0-9]+)/.exec(free.bytes().toString('utf8'));
    if (space.exitCode !== 0 || !m) throw runnerError('prepare:space', `the work tree's free space could not be read (exit ${space.exitCode})`);
    const need = limits.patchExpansionBytes + FREE_SPACE_MARGIN_BYTES;
    if (Number(m[1]) < need) {
      throw new RequesterError([{ code: 'IMAGE_WORKDIR_FULL', path: '/spec/env/image',
        detail: `the env image's checkout and installed dependencies leave only ${m[1]} bytes free in the work tree; a claim needs room to write up to ${limits.patchExpansionBytes} (patchExpansionBytes) plus a ${FREE_SPACE_MARGIN_BYTES}-byte margin` }]);
    }

    // The listed commit's files, as a claim's protected reset lists them.
    const list = new Prefix(TREE_LIST_MAX);
    const tree = await ctx.exec(git(['ls-tree', '-r', '-z', '--full-tree', '--name-only', '--end-of-options', state.base.prepared]), {
      name: 'prepare:files', timeoutMs: GIT_TIMEOUT_MS, tee: list
    });
    if (tree.exitCode !== 0) throw runnerError('prepare:files', `the listed commit's files could not be listed: ${firstLine(tree.stderr.text)}`);
    if (list.truncated) {
      refuse('CHECKOUT_PATHS_TOO_LARGE', `the listed commit's paths take more than ${TREE_LIST_MAX} bytes to list; a claim's protected reset could not list them`);
      return;
    }
    const files = parseLsTreeZ(list.bytes());
    if (!files) throw runnerError('prepare:files', 'the listed commit\'s files could not be read');
    state.tracked = files;

    const scope = spec.stake && spec.stake.scope;
    if (scope && Array.isArray(scope.include)) {
      const inScope = files.filter((p) => {
        const name = Buffer.from(p, 'latin1').toString('utf8');
        return matchesAny(name, scope.include) && !matchesAny(name, scope.exclude || []);
      });
      if (inScope.length === 0) {
        refuse('SCOPE_EMPTY', 'no file of the listed commit is in stake.scope (include minus exclude): a finding could name no path');
        return;
      }
    }

    // What a claim's context pack reads (no patch here, so the listed commit's side of it): in P, as it is in a claim's run.
    await s0.packInputs(state.scope.ctx);
    // A claim's reference, before any maker command: what it refuses is refused here with the same code. A claim's listings
    // hold its patch and the git objects of its commit too, so these keep room under the caps for what any patch can add.
    await s0.watch(state.scope.ctx, { reserve: integrity.LISTING_RESERVE });
    state.prepareMs = Date.now() - t0;
    if (minimumRunSeconds(state.prepareMs) > caps.runSeconds) {
      refuse('LISTING_TOO_HEAVY', `preparing the sandbox took ${seconds(state.prepareMs)} s; ${MARGIN}x that alone is above the class's ${caps.runSeconds} s run`);
    }
  }

  /**
   * The look at any solc in the image, before the build can run one. forge has already started a configured compiler to
   * read its configuration, so whatever that left running is killed first: nothing of the maker's is alive while the bytes
   * are read and their hashes reported, as nothing of a claim's is at a snapshot.
   */
  async function compilers() {
    await state.first.cleanup(state.scope.ctx, 'compilers');
    out.leftoverProcesses = leftovers(state.scope.facts);
    const look = await integrity.officialCompilers(state.scope.ctx, { pin: state.base.solcPin, pathDirs: state.base.watch.ref.pathDirs, list: official });
    out.compilers = { platform: official.platform, listAsOf: official.asOf, newest: official.newest, checked: look.checked };
    if (look.problems.length) {
      refuse('SOLC_NOT_OFFICIAL', `the env image holds a solc that is not an official release for ${official.platform}: ${listed(look.problems)}. `
        + `The runner's list comes from ${SOLC_SOURCE} (as of ${official.asOf}, newest ${official.newest}); a release newer than that waits for the runner's list`);
    }
    // One check and one code, easy to lift when Vyper has an official hash list: see integrity.vyperProblems.
    const vyper = await integrity.vyperProblems(state.scope.ctx, { config: state.base.watch.ref.config, pathDirs: state.base.watch.ref.pathDirs });
    if (vyper.length) {
      refuse('VYPER_NOT_SUPPORTED', `Vyper is refused at listing for now: it has no official list of release hashes to read a compiler against, as solc has. ${vyper.join('; ')}`);
    }
  }

  async function build(ctx) {
    const budget = buildBudgetMs(state.prepareMs, caps);
    if (budget < 1) {
      refuse('LISTING_TOO_HEAVY', `preparing the sandbox took ${seconds(state.prepareMs)} s, which leaves no time for a build within the class's caps`);
      return;
    }
    const s1 = claimSession(stub, { ...limits, buildSeconds: budget / 1000 }, { adopt: state.base });
    const t0 = Date.now();
    try {
      await s1.build(state.scope.ctx);
    } catch (err) {
      if (!ownTimeout(err, (s) => s === 'build')) throw err;
      refuse('LISTING_TOO_HEAVY', `the build ran past ${seconds(budget)} s and was stopped: ${MARGIN}x its time would pass the class's ${caps.buildSeconds} s build or ${caps.runSeconds} s run`);
      return;
    }
    state.buildMs = Date.now() - t0;
    out.leftoverProcesses = leftovers(state.scope.facts);
    const gate = state.scope.gates.build;
    if (!gate || gate.status !== 'pass') {
      refuse('BUILD_FAILED', `at the listed commit, ${gate ? gate.detail : 'the build did not run'}`);
    }
  }

  async function suite(ctx) {
    const budget = suiteBudgetMs(state.prepareMs, state.buildMs, caps);
    if (budget < 1) {
      refuse('LISTING_TOO_HEAVY', `the preparation (${seconds(state.prepareMs)} s) and the build (${seconds(state.buildMs)} s) leave no time for the suite within the class's ${caps.runSeconds} s run`);
      return;
    }
    const s2 = claimSession(stub, { ...limits, testSeconds: budget / 1000 }, { adopt: state.base });
    const runs = [];
    for (let k = 1; k <= RUNS; k += 1) {
      const t0 = Date.now();
      if (k > 1) {
        await resetToListed(state.scope.ctx, `suite:reset:${k}`);
        await state.base.watch.afterReset(state.scope.ctx, `run ${k}`);
      }
      let run;
      try {
        run = await s2.pocRun(state.scope.ctx, k, 'test', {}, { step: `suite:${k}` });
      } catch (err) {
        if (!ownTimeout(err, (s) => s === `suite:${k}`)) throw err;
        refuse('LISTING_TOO_HEAVY', `suite run ${k} ran past ${seconds(budget)} s and was stopped: ${MARGIN * RUNS}x a run's time would pass the class's ${caps.runSeconds} s run`);
        return;
      }
      state.testMs.push(Date.now() - t0);
      // As a claim's run would be held: what this run changed is named, and nothing later could be taken for a clean result.
      const changed = watchedChanges(state.base.watch.failures, state.base.watch.changedFacts());
      if (changed) {
        refuse('IMAGE_WATCH_CHANGED_BY_SUITE', `the suite changed what the runner holds claims to, before any claim: ${changed.detail}`, { paths: changed.paths });
        return;
      }
      if (!run.suites) {
        refuse('SUITE_JUNIT_UNREADABLE', `the test command gave no readable JUnit on run ${k} (exit ${run.exitCode}): ${run.reason}`);
        return;
      }
      runs.push(run);
    }
    state.suiteFiles = [...new Set(runs.flatMap((r) => r.suites.map((x) => x.file)))].sort();
    out.leftoverProcesses = leftovers(state.scope.facts);
    out.timings = { prepareSeconds: seconds(state.prepareMs), buildSeconds: seconds(state.buildMs), testSeconds: state.testMs.map(seconds) };

    const { baseline, harness } = baselineOf(runs, {
      baseCommit: spec.baseCommit,
      timings: { buildSeconds: seconds(state.buildMs), testSeconds: state.testMs.map(seconds) }
    });
    out.suite = {
      tests: baseline.tests.length,
      stable: baseline.stable.length,
      unstable: baseline.unstable.length,
      exitCodes: runs.map((r) => r.exitCode),
      harnessErrors: harness.map((h) => h.slice(0, MAX_LISTED))
    };
    const checked = validateBaseline(baseline, spec);
    if (!checked.ok) {
      refuse('BASELINE_INVALID', `the suite's results do not make a valid baseline.json: ${checked.issues.slice(0, 3).map((i) => `${i.path} ${i.detail}`).join('; ')}`);
      return;
    }
    out.baseline = baseline;
    for (const w of checked.warnings) warn(w.code, w.detail);
    const broken = [...new Set(harness.flat())].sort();
    if (broken.length) {
      warn('SUITE_HARNESS_ERRORS', `test contracts failed before their tests ran (their tests are not in the baseline): ${listed(broken)}`);
    }

    const d = deriveLimits({ prepareMs: state.prepareMs, buildMs: state.buildMs, testMs: state.testMs }, request.specLimits, caps);
    if (d.over.length) {
      refuse('LISTING_TOO_HEAVY', `from the measured times (preparation ${seconds(state.prepareMs)} s, build ${seconds(state.buildMs)} s, `
        + `longest suite run ${seconds(Math.max(...state.testMs))} s): ${d.over.join('; ')}`);
      return;
    }
    state.defaults = d.limits;
    out.limits = d.limits;
    const declared = isPlainObject(spec.limits) ? spec.limits : {};
    const low = ['buildSeconds', 'testSeconds', 'runSeconds'].filter((k) => Number.isInteger(declared[k]) && declared[k] < d.limits[k]);
    if (low.length) {
      refuse('LIMITS_BELOW_DEFAULTS', `code_review.json sets ${low.map((k) => `${k} ${declared[k]}`).join(', ')}, below the measured defaults (${low.map((k) => `${k} ${d.limits[k]}`).join(', ')}): claims would run out of time and abstain`);
    }
  }

  /**
   * A fresh sandbox from the image for the next probe (R1-F2): nothing the
   * suite or an earlier probe left (in the work tree, $HOME or /tmp) can make
   * a probe pass where a claim, which starts from a fresh sandbox, would not.
   * The one in use is removed first, so there is never more than one: the
   * memory admitted for the run covers them.
   */
  async function closeCurrent(ctx) {
    if (state.sandbox) await state.sandbox.close();
    else await ctx.closeSandbox();
    state.sandbox = null;
  }

  async function freshSandbox(ctx) {
    state.sandbox = await ctx.openSandbox();
    return { ...ctx, exec: state.sandbox.exec, readFile: state.sandbox.readFile, sandboxName: state.sandbox.name };
  }

  /**
   * One probe, run as a claim is: a fresh sandbox, the claim pipeline's
   * prepare (the forced checkout), the probe put in place as a PoC, then the
   * claim's build and reproduces gate under the default limits, the whole of
   * it, from the launch on, within the default runSeconds (R3-F1), as a
   * claim's run is held to it.
   */
  async function runProbe(ctx, probe, path, probeLimits, runSeconds) {
    const prefix = `harness:${probe.name}${probe.variant ? `:${probe.variant}` : ''}`;
    await closeCurrent(ctx);
    const t0 = Date.now();
    const stopAt = t0 + runSeconds * 1000;
    const scope = scoped(await freshSandbox(ctx), prefix, { stopAt });
    const session = claimSession({ spec, pocPatch: probePatch(path, probe.lines), baseline: out.baseline }, probeLimits);
    const steps = probe.build
      ? ['prepare', 'applies', 'testPathsOnly', 'resetAndCommit', 'packInputs', 'watch', 'build', 'reproduces']
      : ['prepare', 'applies', 'testPathsOnly', 'resetAndCommit', 'packInputs', 'watch', 'reproduces'];
    let timedOut = null;
    for (const name of steps) {
      if (session.state.done || scope.overBudget) break;
      try {
        await session[name](scope.ctx);
      } catch (err) {
        if (scope.overBudget) break;
        if (!ownTimeout(err, (s) => s === `${prefix}:build` || s.startsWith(`${prefix}:poc:`))) throw err;
        timedOut = `${err.step} ran past the default limits`;
        break;
      }
    }
    // The bound stopped a step (read first: a claim function may turn its own timeout into a gate), or the launch and
    // the steps together ran past runSeconds.
    const elapsed = Date.now() - t0;
    if (scope.overBudget) timedOut = `${scope.overBudget} was stopped at runSeconds ${runSeconds}: the probe's run, from its launch, did not fit`;
    else if (!timedOut && elapsed > runSeconds * 1000) timedOut = `the probe's run took ${seconds(elapsed)} s from its launch, past runSeconds ${runSeconds}`;
    return { probe, prefix, gates: scope.gates, facts: scope.facts, timedOut };
  }

  /** What the claim pipeline made of a probe's test. */
  function judge(r, path) {
    const id = forge.testIdentity(path, r.probe.contract, r.probe.test);
    const poc = r.facts.poc || null;
    const test = poc ? poc.tests.find((t) => t.id === id) || null : null;
    const run1 = poc && poc.runs[0] ? poc.runs[0] : null;
    const base = { id, gates: r.gates, run1: run1 ? { junit: run1.junit, exitCode: run1.exitCode, reason: run1.reason, harnessErrors: run1.harnessErrors } : null, test };
    if (r.timedOut) return { ...base, verdict: 'too_slow', detail: r.timedOut };
    for (const g of ['applies', 'testPathsOnly']) {
      if (r.gates[g] && r.gates[g].status === 'fail') return { ...base, verdict: 'rejected', detail: `${g}: ${r.gates[g].detail}` };
    }
    // Whatever the probe's test did: a claim that ran this way would fail these checks.
    const recorded = r.facts.integrity && r.facts.integrity.poc;
    const tripped = recorded ? recorded.failures.filter((f) => CHECKSUM_CHECKS.includes(f.check)) : [];
    if (tripped.length) {
      const c = recorded.changed;
      return { ...base, verdict: 'integrity', detail: tripped.map((f) => `${f.check} (${f.detail})`).join('; '), paths: [...new Set([...c.protected, ...c.framework, ...c.dependencies])].sort() };
    }
    if (r.gates.build && r.gates.build.status === 'fail') return { ...base, verdict: 'not_run', detail: r.gates.build.detail };
    const rep = r.gates.reproduces;
    if (!rep) return { ...base, verdict: 'not_run', detail: 'the reproduces gate was not reached' };
    if (rep.status === 'pass') {
      return test && test.kind === 'assertion' && poc.testCount === 1
        ? { ...base, verdict: 'assertion', detail: rep.detail }
        : { ...base, verdict: 'unexpected', detail: `reproduces passed on other tests than ${id}` };
    }
    if (test) {
      if (test.runs[0] === 'fail') return { ...base, verdict: 'unstable', detail: rep.detail };
      return { ...base, verdict: 'not_assertion', detail: rep.detail };
    }
    return { ...base, verdict: run1 && run1.junit !== 'ok' ? 'no_junit' : run1 && run1.harnessErrors.length ? 'harness_error' : 'not_run', detail: rep.detail };
  }

  async function harness(ctx) {
    const path = harnessPath(spec, state.tracked, { suiteFiles: state.suiteFiles });
    if (!path) {
      refuse('HARNESS_NO_PATH', `no plain Solidity path under paths.tests (${listed(spec.paths.tests)}) outside paths.protected is free for a test file`);
      return;
    }
    const d = state.defaults;
    // A claim's limits: the listing's defaults for its steps, the class's for everything else.
    const probeLimits = Object.freeze({ ...limits, buildSeconds: d.buildSeconds, testSeconds: d.testSeconds });
    const probes = [];
    out.harness = { path, probes };
    const probe = async (p) => {
      const r = await runProbe(ctx, p, path, probeLimits, d.runSeconds);
      const j = judge(r, path);
      probes.push({ name: p.name, variant: p.variant, verdict: j.verdict, detail: j.detail, test: j.id, gates: j.gates, run1: j.run1 });
      return j;
    };
    const slow = (j) => {
      if (j.verdict !== 'too_slow') return false;
      refuse('HARNESS_TOO_SLOW', `a trivial test did not finish within the default limits (buildSeconds ${d.buildSeconds}, testSeconds ${d.testSeconds}, runSeconds ${d.runSeconds}): ${j.detail}`);
      return true;
    };
    const rejected = (j) => {
      if (j.verdict === 'integrity') {
        refuse('HARNESS_INTEGRITY_FAILED', `a trivial test at ${path} changed what the runner holds claims to, so a claim run the same way would fail its integrity checks: ${j.detail}`, { paths: j.paths });
        return true;
      }
      if (j.verdict !== 'rejected') return false;
      refuse('HARNESS_PROBE_REJECTED', `the claim gates refused a test file at ${path}: ${j.detail}`);
      return true;
    };

    // 1. A trivially failing test: an assertion failure on all three runs, with the listing's forge-std if it has one.
    let fails = await probe(PROBES.failsForgeStd);
    if (slow(fails) || rejected(fails)) return;
    if (fails.verdict === 'not_assertion') {
      refuse('LEGACY_ASSERTIONS', `forge-std's assertEq(1, 2) in ${fails.id} ${fails.test.runs[0] === 'pass' ? 'passed' : 'did not fail as an assertion'} on run 1`
        + `${fails.test.message ? ` (${fails.test.message.slice(0, 200)})` : ''}: the listing's assertions do not revert (legacy, non-reverting assertions, or assertions_revert = false), `
        + 'so a PoC written with them would be an error, not an assertion failure');
      return;
    }
    if (fails.verdict === 'no_junit' || fails.verdict === 'not_run' || fails.verdict === 'harness_error') {
      // No forge-std at forge-std/Test.sol (or it does not build): the same test with a plain revert.
      fails = await probe(PROBES.failsPlain);
      if (slow(fails) || rejected(fails)) return;
    }
    if (fails.verdict !== 'assertion') {
      refuse('HARNESS_ASSERTION_NOT_REPORTED', `a trivially failing test at ${path}, run through testFiles, was not an assertion failure on all ${RUNS} runs: ${fails.detail}`);
      return;
    }

    // 2. A trivially broken test (a compile error), straight through testFiles: no readable JUnit, an error.
    const compile = await probe(PROBES.compileError);
    if (slow(compile) || rejected(compile)) return;
    if (compile.verdict !== 'no_junit') {
      refuse('HARNESS_ERROR_NOT_REPORTED', `a test at ${path} that does not compile was not reported as an error by testFiles (no readable JUnit expected): ${compile.detail}`);
      return;
    }

    // 3. A trivially broken suite (a failing setUp): a collection error in the JUnit, not a test result.
    const setUp = await probe(PROBES.setUpError);
    if (slow(setUp) || rejected(setUp)) return;
    const suiteName = `${path}:${PROBES.setUpError.contract}`;
    const reported = setUp.verdict === 'harness_error' && setUp.run1 && setUp.run1.harnessErrors.some((h) => h.name === 'setUp()' && h.suite === suiteName);
    if (!reported) {
      refuse('HARNESS_ERROR_NOT_REPORTED', `a test contract at ${path} whose setUp() reverts was not reported as a setUp error in the JUnit: ${setUp.detail}`);
    }
  }

  async function finish(ctx) {
    out.status = out.refusals.length ? 'refused' : 'accepted';
    ctx.fact('listing', out);
  }

  const guarded = [image, prepare, compilers, build, suite, harness].map((step) => {
    const wrapped = async (ctx) => { if (!state.stop) await step(ctx); };
    Object.defineProperty(wrapped, 'name', { value: step.name });
    return wrapped;
  });
  return [...guarded, finish];
}

module.exports = {
  validateListingRequest, listingSteps, imageUnpackedBytes, deriveLimits, buildBudgetMs, suiteBudgetMs, minimumRunSeconds,
  baselineOf, harnessPath, probeCandidates, probePatch, PROBES, LISTING_FIELDS, LISTING_CHECK_SECONDS, MARGIN, RUNS
};
