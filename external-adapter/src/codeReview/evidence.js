/**
 * @fileoverview The Execution evidence block (design §10.5; owner decision Q35).
 *
 * The first thing in every uploaded justification from the run on, so the
 * maker, the hunter and the public can see why: gates, trust tiers, the PoC's
 * run pattern, the fix check, the report's hash.
 *
 * A pure function of the report's fields, so every arbiter holding the same
 * report writes the same bytes. It is built from an allow-list: enums, integers,
 * CIDs, hashes and schema-patterned versions. Text a hunter or the code could
 * have written (a test's id or message, a path, a finding's text, a run's
 * `detail`) reaches no line of it, only its count.
 *
 * The machine-readable form, which the record reads (P10):
 *
 *   Execution evidence v1                       the first line of the justification
 *   Settlement: jury | INVALID (<gate>) | DUPLICATE (integrity)
 *   Report-SHA256: <64 hex>
 *   Integrity-Failed-Checks: none | <name>[,<name>…]    in common's INTEGRITY_CHECKS order
 *   End execution evidence                      the last line of the block
 *
 * A reader takes the first block only: jury text follows it and can say anything.
 */

const { codeReview } = require('@verdikta/common');
const { settleReport, tamperCounts } = require('./settlement');

const EVIDENCE_HEADER = 'Execution evidence v1';
const EVIDENCE_END = 'End execution evidence';

/** The gates as the report's tiers read them (§9.5): tier A from outside the tested process, tier B recorded by it. */
const TIER_A_GATES = Object.freeze(['applies', 'testPathsOnly', 'build', 'integrity']);
const TIER_B_GATES = Object.freeze(['reproduces', 'claimedObservable']);
const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low', 'info']);
/** Positions shown per pattern; the patterns themselves are few, and counted in full. */
const MAX_POSITIONS = 10;

function settlementLine(settlement) {
  if (settlement.kind === 'jury') return 'jury';
  return settlement.kind === 'duplicate' ? 'DUPLICATE (integrity)' : `INVALID (${settlement.gate})`;
}

/**
 * Each distinct run pattern with how many tests have it and their positions, in
 * the report's canonical order of test id: no id, which is the hunter's text.
 */
function runPattern(poc) {
  const byPattern = new Map();
  [...poc.tests]
    .sort((a, b) => (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)))
    .forEach((test, index) => {
      const key = test.runs.join(',');
      if (!byPattern.has(key)) byPattern.set(key, []);
      byPattern.get(key).push(index + 1);
    });
  const parts = [...byPattern.entries()].map(([pattern, positions]) => {
    const shown = positions.slice(0, MAX_POSITIONS).map((n) => `#${n}`).join(' ');
    const more = positions.length > MAX_POSITIONS ? ` and ${positions.length - MAX_POSITIONS} more` : '';
    return `${shown}${more} ${pattern}`;
  });
  const listed = poc.tests.length < poc.testCount ? ` (the first ${poc.tests.length} of ${poc.testCount} tests)` : '';
  return `${parts.join('; ') || 'none'}${listed}`;
}

function fixLine(fix) {
  if (!fix.present) return 'present=false';
  return `present=true applies=${fix.applies} builds=${fix.builds} pocPasses=${fix.pocPasses} regressions=${fix.regressionCount} tier=${fix.tier}`;
}

/**
 * @param {object} report - a report common's validator accepted
 * @param {string} reportSha256
 * @returns {string} the block, with no trailing newline
 * @throws {CodeReviewAbstain} on a report that cannot be settled
 */
function buildExecutionEvidence(report, reportSha256) {
  const { inputs, gates, poc, fix, flags, findings, diff } = report;
  const gateList = (names) => names.map((name) => `${name}=${gates[name]}`).join(' ');
  const severity = (name) => findings.filter((finding) => finding.severity === name).length;
  const failed = poc ? codeReview.INTEGRITY_CHECKS.filter((check) => poc.integrity[check] === false) : [];
  const tamper = poc ? tamperCounts(poc.integrity.tamperFlags) : [];
  const stat = (d) => `files=${d.files} added=${d.added} removed=${d.removed}`;

  const lines = [
    EVIDENCE_HEADER,
    `Settlement: ${settlementLine(settleReport(report))}`,
    `Report-SHA256: ${reportSha256}`,
    `Listing: ${inputs.listingCid}`,
    `Claim: ${inputs.bcid}`,
    `Inputs: envImage=${inputs.envImage} baseCommit=${inputs.baseCommit} runner=${inputs.runner} gvisor=${inputs.gvisor} semgrepRules=${inputs.semgrepRules}`,
    `Gates-EA: disclosure=${inputs.eaGates.disclosure} inScope=${inputs.eaGates.inScope}`,
    `Gates-Tier-A: ${gateList(TIER_A_GATES)}`,
    `Gates-Tier-B: ${gateList(TIER_B_GATES)}`,
    `PoC-Runs: ${poc ? `tests=${poc.testCount} fail=${poc.runCounts.fail} pass=${poc.runCounts.pass} error=${poc.runCounts.error} skip=${poc.runCounts.skip} missing=${poc.runCounts.missing} duplicate=${poc.runCounts.duplicate} notRun=${poc.runCounts.notRun}` : 'none'}`,
    `PoC-Run-Pattern: ${poc ? runPattern(poc) : 'none'}`,
    `Integrity-Failed-Checks: ${failed.length > 0 ? failed.join(',') : 'none'}`,
    `Tamper-Flags: ${tamper.length > 0 ? tamper.map(([kind, n]) => `${kind}=${n}`).join(',') : 'none'}`,
    `Honesty-Flags: ${poc ? poc.honestyFlags.length : 0}`,
    `Findings: total=${findings.length} ${SEVERITIES.map((name) => `${name}=${severity(name)}`).join(' ')}`,
    `Patch-Flags: existingTestsModified=${flags.existingTestsModified.length} skipMarkersAdded=${flags.skipMarkersAdded.length} protectedPathsTouched=${flags.protectedPathsTouched.length}`,
    `Diff-PoC: ${stat(diff.poc)}`,
    `Diff-Fix: ${diff.fix ? stat(diff.fix) : 'none'}`,
    `Fix: ${fixLine(fix)}`,
    EVIDENCE_END
  ];
  return lines.join('\n');
}

module.exports = { buildExecutionEvidence, settlementLine, EVIDENCE_HEADER, EVIDENCE_END };
