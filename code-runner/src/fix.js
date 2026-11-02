'use strict';

/**
 * The fix check (design §9.2 step 8, §20 decision 14; node A3a). Only when
 * the claim carries fix.patch; informational: the outcome never depends on
 * it, and it decides no gate. It runs in a second sandbox (ctx.openSandbox,
 * the same flags; the run is admitted for both sandboxes' memory), started
 * before the PoC's own steps and run beside them (§11):
 *
 *   prepare   the processes recorded, the forced checkout (as the PoC's)
 *   the PoC   poc.patch applied, its paths checked, protected paths reset
 *             and committed, as the PoC's sandbox does (the check runs the
 *             PoC with the fix); a PoC that fails there fails the fix check
 *   applies   fix.patch: the same host-side checks as poc.patch (size, no
 *             NUL, no rename or copy, no binary change: the rule this node
 *             proposes), git apply on top of the PoC commit, the measured
 *             expansion; every path it touches outside paths.tests and
 *             paths.protected (source allowed, tests and protected paths
 *             not), each one a report can name; committed
 *   builds    the reference snapshot (integrity.js), then the declared build
 *   suite     the maker's full suite (commands.test) once, with the runner's
 *             reporter flags, then a snapshot. pocPasses: every test the
 *             patch added has exactly one record and passes; regressions:
 *             every baseline `stable` test that does not pass (fails,
 *             errors, is skipped, missing or duplicated)
 *   integrity the §9.5 checks on the suite run: identity (the PoC's tests
 *             and every stable identity, each exactly once, none skipped),
 *             forge's summary, the exit code, the post-run checksums and the
 *             static flags of both patches
 *
 * One run of the suite, not the PoC and the suite apart: a second run in
 * the same sandbox would execute what the first run's claim code left
 * behind (an artifact, a cache). One run starts from verified inputs.
 *
 * A step that hits a limit abstains the whole run (an informational fact is
 * still a fact every arbiter must agree on). The report's form holds: a fix
 * that applied is always built (builds is pass or fail, never not-run).
 */

const integrity = require('./integrity');
const forge = require('./forge');
const { forceCheckout } = require('./checkout');
const { matchesAny, pocPatchPathsGate } = require('./common');
const { reportablePath } = require('./patch');
const crypto = require('node:crypto');
const { Abstain, ABSTAIN, RequesterError } = require('./result');

const MAX_REGRESSIONS = 200;
const MAX_TESTS = 200;

/** The fix facts when the claim has no fix.patch: every field at its not-run value. */
function notRunFix() {
  return {
    tier: 'B', present: false, applies: 'not-run', builds: 'not-run', pocPasses: null, regressions: [], regressionCount: 0, integrity: null,
    detail: { applies: null, builds: null }
  };
}

/**
 * Run the fix check in a second sandbox.
 * @param {object} parent - the PoC sandbox's ctx (openSandbox, remainingMs)
 * @param {object} o
 * @param {object} o.request - the claim request
 * @param {object} o.limits - the effective limits
 * @param {object} o.kit - claim.js's shared steps
 * @param {Function} o.halted - true once the PoC's sandbox stopped the run
 * @returns {Promise<{fact:object, integrity:object|null}>}
 */
async function runFixCheck(parent, { request, limits, kit, halted }) {
  const handle = await parent.openSandbox();
  const facts = {};
  const ctx = {
    runId: parent.runId,
    limits,
    sandboxName: handle.name,
    remainingMs: parent.remainingMs,
    exec(argv, o = {}) {
      const name = `fix:${o.name}`;
      if (halted()) return Promise.reject(new Abstain(ABSTAIN.CANCELLED, 'the run stopped in the PoC\'s sandbox', { step: name }));
      return handle.exec(argv, { ...o, name });
    },
    fact(name, value) { facts[name] = value; },
    gate() { throw new TypeError('the fix check decides no gate (§20 decision 14)'); }
  };
  const spec = request.spec;
  const base = spec.baseCommit;
  const testGlobs = spec.paths.tests;
  const protectedGlobs = spec.paths.protected || [];
  const box = kit.newBox();
  const fact = {
    tier: 'B', present: true, applies: 'fail', builds: 'not-run', pocPasses: null, regressions: [], regressionCount: 0, integrity: null,
    detail: { applies: null, builds: null },
    // The patch's own bytes, whether or not it was applied (the report's inputs.fixPatchSha256).
    patch: { tier: 'A', bytes: request.fixPatch.length, sha256: crypto.createHash('sha256').update(request.fixPatch).digest('hex'), expansionBytes: null },
    // git's stats once it applied fix.patch; zeros (applied: false) when it never did (the report's diff.fix is set whenever a fix is present).
    diff: { tier: 'A', files: 0, added: 0, removed: 0, binaryFiles: 0, applied: false }
  };
  const finish = (integrityFact = null) => {
    const done = {
      fact: { ...fact, checkout: facts.checkout, leftoverProcesses: facts.leftoverProcesses || { tier: 'A', steps: [] } },
      integrity: integrityFact
    };
    // A check that ended before the suite has nothing left to settle.
    return { ...done, settle: () => done };
  };

  await kit.recordProcesses(ctx, box);
  const checkout = await forceCheckout(ctx, { base });

  // The PoC, as the PoC's sandbox applies it: the check runs it with the fix.
  const poc = await kit.applyPatch(ctx, { bytes: request.pocPatch, label: 'poc.patch', limits, base, step: 'patch' });
  if (poc.status !== 'pass') {
    fact.detail.applies = `the fix check runs the PoC with the fix, and ${poc.detail}`;
    return finish();
  }
  const pocTouched = await kit.readTouched(ctx, 'patch', 'poc.patch');
  const pocGate = pocPatchPathsGate(pocTouched.touched.map((t) => t.path), spec);
  if (!pocGate.pass || pocTouched.touched.some((t) => !reportablePath(t.path))) {
    fact.detail.applies = 'the fix check runs the PoC with the fix, and poc.patch touches paths outside paths.tests (testPathsOnly)';
    return finish();
  }
  await kit.resetProtected(ctx, checkout.commit, protectedGlobs);
  const pocCommit = await kit.commitTree(ctx, 'poc.patch', 'patch');

  // fix.patch on top of the PoC commit.
  const fix = await kit.applyPatch(ctx, { bytes: request.fixPatch, label: 'fix.patch', limits, base, step: 'fixpatch', noRoom: 'fail' });
  fact.patch = fix.fact;
  if (fix.status !== 'pass') {
    fact.detail.applies = fix.detail;
    return finish();
  }
  const fixTouched = await kit.readTouched(ctx, 'fixpatch', 'fix.patch');
  fact.diff = { ...fixTouched.diff, applied: true };
  // git's -z names, already UTF-8 (patch.js), matched as the PoC's path gate matches them (R1-F2).
  const paths = fixTouched.touched.map((t) => t.path);
  const inTests = kit.sortedUnique(paths.filter((p) => matchesAny(p, testGlobs)));
  const inProtected = protectedGlobs.length ? kit.sortedUnique(paths.filter((p) => matchesAny(p, protectedGlobs))) : [];
  const unreportable = kit.sortedUnique(paths.filter((p) => !reportablePath(p)));
  if (inTests.length || inProtected.length || unreportable.length) {
    const parts = [];
    if (inTests.length) parts.push(`${kit.listPaths(inTests)} under paths.tests`);
    if (inProtected.length) parts.push(`${kit.listPaths(inProtected)} under paths.protected`);
    if (unreportable.length) parts.push(`${kit.listPaths(unreportable)}, which cannot be named in a report (whitespace, a control character or a backslash)`);
    fact.detail.applies = `fix.patch touches ${parts.join('; ')}: a fix may change source, not the tests or the protected paths`;
    return finish();
  }
  await kit.commitTree(ctx, 'fix.patch', 'fixpatch');
  fact.applies = 'pass';
  fact.detail.applies = `${fix.detail}, touching ${paths.length} path${paths.length === 1 ? '' : 's'} outside paths.tests and paths.protected`;

  // The fixed build, from the reference the checksums compare with. A fix that applied is always built. The PoC's
  // sandbox read the same reference without the fix, so a reference that cannot be read here is the fix's doing
  // (a malformed foundry.toml, a forge it replaced): the fixed tree does not build, a fact, never the requester's
  // error and never the claim's outcome (R4-F2).
  const watch = new integrity.Watch({ protectedGlobs, prefix: 'integrity' });
  try {
    await watch.reference(ctx);
  } catch (err) {
    if (!(err instanceof RequesterError)) throw err;
    fact.builds = 'fail';
    fact.detail.builds = `with the fix, ${err.issues.map((i) => `${i.code}: ${i.detail}`).join('; ')}`;
    return finish();
  }
  const buildExit = await kit.runBuild(ctx, box, spec.commands.build, limits);
  fact.builds = buildExit === 0 ? 'pass' : 'fail';
  fact.detail.builds = `the build command exited ${buildExit} with the fix`;
  if (fact.builds !== 'pass') return finish();

  // The maker's suite, once.
  const run = await kit.forgeRun(ctx, box, { name: 'suite', script: 'vcr-suite', command: spec.commands.test, env: {}, timeoutMs: limits.testSeconds * 1000 });
  await watch.afterRun(ctx, 'the suite', { first: true });

  const baselineIds = new Set(request.baseline.tests.map((t) => t.id));
  const pocFiles = new Set(pocTouched.touched.filter((t) => t.status !== 'D' && t.path.endsWith('.sol')).map((t) => t.path));
  const all = kit.recordsById(run.suites);
  // The tests the patch added, as this run reports them; settle() holds the run to the PoC's own run-1 identities
  // when the PoC's sandbox has them (R1-F1), so a PoC test that vanishes here (its suite's setUp failing) is a gap.
  const localIds = run.suites ? [...kit.recordsById(run.suites, (id, s) => pocFiles.has(s.file)).keys()].filter((id) => !baselineIds.has(id)).sort() : [];
  // A PoC suite that failed before its tests ran (setUp, constructor): its tests did not run with the fix.
  const harness = [];
  for (const s of run.suites || []) {
    if (!pocFiles.has(s.file)) continue;
    for (const c of s.cases) {
      if (forge.isHarnessRecord(c.name) && (c.outcome === 'failure' || c.outcome === 'error')) harness.push(`${c.name} failed in ${s.file}:${s.contract}`);
    }
  }
  harness.sort();

  const stableIdentity = [];
  const regressions = [];
  for (const id of [...new Set(request.baseline.stable)].sort()) {
    const entry = run.suites ? kit.entryOf(all.get(id)) : { result: 'error' };
    if (run.suites) {
      const gap = integrity.identityGap(id, entry);
      if (gap) stableIdentity.push(`the suite: ${gap}`);
    }
    if (entry.result !== 'pass') regressions.push(id);
  }
  fact.regressions = regressions.slice(0, MAX_REGRESSIONS);
  fact.regressionCount = regressions.length;

  const summary = [];
  const exit = [];
  kit.runConsistency(run, 'the suite', summary, exit);
  const flags = integrity.tamperFlags({
    added: new Map([...pocTouched.added, ...fixTouched.added]),
    touched: [...pocTouched.touched, ...fixTouched.touched],
    commands: spec.commands
  });

  /**
   * pocPasses and the check's integrity, once the PoC's own run 1 named the
   * tests the patch added (`expected`; this run's own when it has none).
   */
  function settle(expected) {
    const ids = expected && expected.length ? [...expected].sort() : localIds;
    const identity = [];
    const pocTests = ids.map((id) => {
      const entry = run.suites ? kit.entryOf(all.get(id)) : { result: 'error' };
      const gap = run.suites ? integrity.identityGap(id, entry) : null;
      if (gap) identity.push(`the suite: ${gap}`);
      return { id, result: entry.result };
    });
    for (const h of harness) identity.push(`the suite: ${h}: its tests did not run`);
    identity.push(...stableIdentity);
    fact.pocPasses = run.suites !== null && ids.length > 0 && harness.length === 0 && pocTests.every((t) => t.result === 'pass');
    const checks = integrity.integrityOf({ identity, summary, exit, ...watch.failures, tamperFlags: flags });
    fact.integrity = checks.integrity;
    fact.suite = {
      tier: 'B', command: 'test', junit: run.junit, reason: run.reason, exitCode: run.exitCode,
      pocCommit, pocTests: pocTests.slice(0, MAX_TESTS), testCount: pocTests.length, harnessErrors: harness.slice(0, MAX_TESTS)
    };
    return finish({ failures: checks.failures, changed: watch.changedFacts() });
  }
  return { ...settle(null), settle };
}

module.exports = { runFixCheck, notRunFix };
