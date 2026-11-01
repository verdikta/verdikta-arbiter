/**
 * @fileoverview The requester error of code-review mode.
 *
 * A code-review request settles one of three ways before any runner or model
 * call (design §12):
 *  - requester error: the listing, the request's composition or this
 *    arbiter's configuration is at fault. Errored path (HTTP 500), no
 *    commit, in mode 1 too: the hunter must not forfeit a bond for a package
 *    they did not write. Thrown as CodeReviewRequesterError.
 *  - deterministic INVALID: the claim is at fault. A verdict with the full
 *    mass on INVALID through the normal commit/reveal tail (verdict.js).
 *  - transient: IPFS, disk, anything else. Errored path, no commit. Any other
 *    thrown error.
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

/** `code at path, …` for common's { code, path } issues, bounded. */
function issueCodes(issues, max = 8) {
  const shown = issues.slice(0, max).map((issue) => (issue.path ? `${issue.code} at ${issue.path}` : issue.code));
  if (issues.length > max) shown.push(`${issues.length - max} more`);
  return shown.join(', ');
}

module.exports = { CodeReviewRequesterError, issueCodes };
