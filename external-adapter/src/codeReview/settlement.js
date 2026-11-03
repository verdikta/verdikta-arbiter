/**
 * @fileoverview What a claim settles as, from its Verification Report (design
 * §9.5, §10.1, §12; owner decision Q35).
 *
 * A pure function of a report common's validateClaimReport accepted, reading
 * only the schema's own fields: no `basis`, no `detail`, nothing outside
 * verdikta.claim-report/1 and no free text. So every arbiter holding the same
 * report settles the same, and nothing a hunter wrote can move it. The rules:
 *
 *   a tamper flag                                        → INVALID, even beside another failed check
 *   applies, testPathsOnly or build failed               → INVALID
 *   reproduces failed on its own                         → INVALID, whatever integrity says
 *   reproduces failed only through another failed check  → DUPLICATE: bond back, no award
 *   claimedObservable failed                             → INVALID
 *   every gate passed                                    → the jury
 *
 * The validator makes these total: a gate runs exactly when the gates before it
 * passed, integrity passes exactly when every check is true and there is no
 * flag, and reproduces passes exactly when integrity is clean and every run of
 * every test failed. A shape outside them throws rather than falling through:
 * a wrong INVALID costs a hunter the bond, so what is not a readable fact
 * abstains. The fix check is informational (decision 14) and never read here.
 */

const { codeReview } = require('@verdikta/common');
const { CodeReviewAbstain } = require('./errors');

/** Runs that disprove a reproduction by themselves; `notRun` only ever follows a failure that did. */
const DISPROVING = Object.freeze(['pass', 'error', 'skip', 'missing', 'duplicate']);

function unreadable(why) {
  return new CodeReviewAbstain('CODE_REVIEW_REPORT_UNREADABLE', `the report cannot be settled: ${why}; the arbiter abstains`);
}

const invalid = (gate, check, reason, extra = {}) => ({ kind: 'invalid', gate, check, reason, ...extra });

/** The kinds of tamper flag with their counts, in code-unit order of kind. */
function tamperCounts(flags) {
  const counts = new Map();
  for (const flag of flags) counts.set(flag.kind, (counts.get(flag.kind) || 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

function runSummary(poc) {
  const counts = poc.runCounts;
  return `of ${poc.testCount} test(s) the patch added, over the fixed schedule: `
    + `fail=${counts.fail} pass=${counts.pass} error=${counts.error} skip=${counts.skip} `
    + `missing=${counts.missing} duplicate=${counts.duplicate} notRun=${counts.notRun}`;
}

/**
 * @param {object} report - a report common's validator accepted
 * @returns {{ kind: 'jury' }
 *   | { kind: 'invalid', gate: string, check: string, reason: string, tamperFlagKinds?: string[] }
 *   | { kind: 'duplicate', gate: 'integrity', check: 'INTEGRITY_CHECK_FAILED', failedChecks: string[] }}
 * @throws {CodeReviewAbstain} on a shape the rules do not read as a fact
 */
function settleReport(report) {
  const { gates, poc } = report;
  const status = (gate) => gates[gate];

  if (poc && poc.integrity.tamperFlags.length > 0) {
    const counts = tamperCounts(poc.integrity.tamperFlags);
    return invalid('integrity', 'TAMPER_FLAG', `static tamper flags on the lines the patch added: ${counts.map(([kind, n]) => `${kind}=${n}`).join(',')}`, {
      tamperFlagKinds: counts.map(([kind]) => kind)
    });
  }

  if (status('applies') === 'fail') return invalid('applies', 'PATCH_DOES_NOT_APPLY', 'poc.patch does not apply to the listed commit, or is over the listing\'s patch limits');
  if (status('testPathsOnly') === 'fail') {
    return invalid('testPathsOnly', 'PATCH_OUTSIDE_TEST_PATHS',
      `poc.patch touches a path outside paths.tests or inside paths.protected (protected paths touched: ${report.flags.protectedPathsTouched.length})`);
  }
  if (status('build') === 'fail') return invalid('build', 'BUILD_FAILED', 'the build failed with the patch applied');
  if (!poc) throw unreadable('no gate failed and the PoC did not run');

  const failedChecks = codeReview.INTEGRITY_CHECKS.filter((check) => poc.integrity[check] === false);
  if (status('reproduces') === 'fail') {
    const onItsOwn = poc.testCount === 0 || DISPROVING.some((key) => poc.runCounts[key] > 0);
    if (onItsOwn) {
      return invalid('reproduces', poc.testCount === 0 ? 'POC_ADDED_NO_TEST' : 'POC_DID_NOT_REPRODUCE', runSummary(poc));
    }
    if (status('integrity') === 'fail' && failedChecks.length > 0) {
      return { kind: 'duplicate', gate: 'integrity', check: 'INTEGRITY_CHECK_FAILED', failedChecks };
    }
    throw unreadable('reproduces failed with every counted run failing, and no failed check');
  }
  if (status('reproduces') !== 'pass' || status('integrity') !== 'pass' || failedChecks.length > 0) {
    throw unreadable('reproduces and integrity disagree');
  }
  if (status('claimedObservable') === 'fail') {
    return invalid('claimedObservable', 'OBSERVABLE_NOT_RECORDED', 'the tests finding.json names are not the ones that failed, or the asserted observable does not appear in the recorded failure');
  }
  const allPassed = codeReview.REPORT_GATES.every((gate) => status(gate) === 'pass');
  if (!allPassed) throw unreadable('a gate neither passed nor failed');
  return { kind: 'jury' };
}

module.exports = { settleReport, tamperCounts };
