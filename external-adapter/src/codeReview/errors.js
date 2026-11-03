/**
 * @fileoverview The errors of code-review mode.
 *
 * A code-review request settles one of three ways before any runner or model
 * call (design §12):
 *  - requester error: the listing, the request's composition or this
 *    arbiter's configuration is at fault. Errored path (HTTP 500), no
 *    commit, in mode 1 too: never an INVALID against a hunter for a package
 *    they did not write. Thrown as CodeReviewRequesterError. (No round settles,
 *    so erratum E6 decides the bond: it follows the round.)
 *  - deterministic INVALID: the claim is at fault. A verdict with the full
 *    mass on INVALID through the normal commit/reveal tail (verdict.js).
 *  - transient: IPFS, disk, anything else. Errored path, no commit. Any other
 *    thrown error.
 *
 * From the run on (claimRun.js, node A4b) the arbiter abstains on anything it
 * cannot read as a fact: CodeReviewAbstain, the same errored path, no commit.
 *
 * The message travels to the Chainlink node and into the adapter's log, so it
 * names codes and listing-level facts only: never claim contents, never key
 * material.
 */

class CodeReviewRequesterError extends Error {
  /**
   * @param {string} code - e.g. CODE_REVIEW_SPEC, CODE_REVIEW_ATTESTATION
   * @param {string} detail
   */
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'CodeReviewRequesterError';
    this.code = code;
    this.detail = detail;
  }
}

/** The arbiter abstains: errored path, no commit, in every mode. */
class CodeReviewAbstain extends Error {
  /**
   * @param {string} code - e.g. CODE_REVIEW_DEADLINE, CODE_REVIEW_RUNNER_ABSTAIN
   * @param {string} detail - codes and listing-level facts only
   */
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'CodeReviewAbstain';
    this.code = code;
    this.detail = detail;
  }
}

/** `code at path, …` for common's { code, path } issues, bounded. */
function issueCodes(issues, max = 8) {
  const shown = issues.slice(0, max).map((issue) => (issue.path ? `${issue.code} at ${issue.path}` : issue.code));
  if (issues.length > max) shown.push(`${issues.length - max} more`);
  return shown.join(', ');
}

module.exports = { CodeReviewRequesterError, CodeReviewAbstain, issueCodes };
