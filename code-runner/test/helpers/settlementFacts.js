'use strict';

/**
 * What settlement reads from a claim's result (design §9.5, owner decision
 * Q35), in the fields of common's verdikta.claim-report/1 alone: no `basis`, no
 * `detail`, no fact outside the schema. A test's mirror of what A4b will read;
 * the rule itself is A4b's. `reportOf` is the real report's assembly (src/report.js,
 * node A3b) on stubbed inputs, so common's own validator checks what A4b will read.
 */

const { validateClaimReport } = require('@verdikta/common/src/codeReview/report');
const { assembleReport } = require('../../src/report');

const CHECKS = Object.freeze(['identityComplete', 'summaryConsistent', 'exitConsistent', 'protectedPathsUnchanged', 'frameworkUnchanged', 'dependenciesUnchanged']);
/** A run that disproves the reproduction by itself; `notRun` only ever follows a failure that did. */
const DISPROVING = Object.freeze(['pass', 'error', 'skip', 'missing', 'duplicate']);
const SHA = 'a'.repeat(64);

/** The inputs a run's result does not hold, stubbed; the fix patch's presence follows the result. */
function stubRequest(result) {
  const present = Boolean(result.facts.fix && result.facts.fix.present);
  return {
    listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', bcid: 'QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A',
    spec: { baseCommit: '9c1e4f0a3b7d2e5c8f1a4b6d9e0c3f5a7b2d4e6f', env: { image: `ghcr.io/verdikta/env@sha256:${SHA}` } },
    attestation: {}, pocPatch: Buffer.from('poc'), fixPatch: present ? Buffer.from('fix') : null,
    eaGates: { disclosure: 'pass', inScope: 'pass' }
  };
}

/** The real report's layout (src/report.js), on any platform the test ran on. */
function reportOf(result) {
  return assembleReport(result, stubRequest(result), { gvisor: 'release-20260921.0' });
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
