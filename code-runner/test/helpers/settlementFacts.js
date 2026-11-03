'use strict';

/**
 * What settlement reads from a claim's result (design §9.5, owner decision
 * Q35), in the fields of common's verdikta.claim-report/1 alone: no `basis`, no
 * `detail`, no fact outside the schema. A test's mirror of what A4b will read;
 * the rule itself is A4b's, and the report's assembly A3b's. `reportOf` lays a
 * runner result out in that schema so common's own validator checks it.
 */

const { validateClaimReport } = require('@verdikta/common/src/codeReview/report');

const CHECKS = Object.freeze(['identityComplete', 'summaryConsistent', 'exitConsistent', 'protectedPathsUnchanged', 'frameworkUnchanged', 'dependenciesUnchanged']);
/** A run that disproves the reproduction by itself; `notRun` only ever follows a failure that did. */
const DISPROVING = Object.freeze(['pass', 'error', 'skip', 'missing', 'duplicate']);
const SHA = 'a'.repeat(64);

function reportOf(result) {
  const gate = (name) => (result.gates[name] ? result.gates[name].status : 'not-run');
  const facts = result.facts.poc || null;
  let poc = null;
  if (facts) {
    const { tier, testCount, runCounts, tests, integrity } = facts;
    poc = { tier, testCount, runCounts, tests, integrity, honestyFlags: [] };
  }
  return {
    schema: 'verdikta.claim-report/1',
    inputs: {
      listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', bcid: 'QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A',
      envImage: `sha256:${SHA}`, platform: 'linux/amd64', attestationSha256: SHA, baseCommit: '9c1e4f0a3b7d2e5c8f1a4b6d9e0c3f5a7b2d4e6f',
      pocPatchSha256: SHA, fixPatchSha256: null, runner: '1.0.0', gvisor: 'release-20260921.0', semgrepRules: '2026.10',
      eaGates: { disclosure: 'pass', inScope: 'pass' }
    },
    gates: Object.fromEntries(['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable'].map((g) => [g, gate(g)])),
    poc,
    fix: { present: false, applies: 'not-run', builds: 'not-run', pocPasses: null, regressions: [], regressionCount: 0, tier: 'B', integrity: null },
    build: { status: gate('build'), tier: 'A' },
    findings: [],
    flags: { existingTestsModified: [], skipMarkersAdded: [], protectedPathsTouched: [] },
    diff: { poc: { files: 1, added: 1, removed: 0 }, fix: null }
  };
}

/**
 * @returns {{valid:boolean, issues:string[], integrity:string, tampered:boolean, failedChecks:string[],
 *   reproduces:'pass'|'fail'|'not-run', reproducesFailed:null|'on-its-own'|'only-through-integrity'}}
 */
function settlementFacts(result) {
  const report = reportOf(result);
  const checked = validateClaimReport(report);
  const { gates, poc } = report;
  const tampered = Boolean(poc) && poc.integrity.tamperFlags.length > 0;
  const failedChecks = poc ? CHECKS.filter((c) => poc.integrity[c] === false) : [];
  let reproducesFailed = null;
  if (gates.reproduces === 'fail') {
    reproducesFailed = poc.testCount === 0 || DISPROVING.some((k) => poc.runCounts[k] > 0) ? 'on-its-own' : 'only-through-integrity';
  }
  return { valid: checked.ok, issues: checked.issues.map((i) => i.code), integrity: gates.integrity, tampered, failedChecks, reproduces: gates.reproduces, reproducesFailed };
}

module.exports = { settlementFacts, reportOf, CHECKS };
