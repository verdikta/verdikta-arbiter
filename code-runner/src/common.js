'use strict';

/**
 * What the runner reads from @verdikta/common (pinned exactly, like the EA,
 * the AI Node and e2e): the class hard limits and the platform, the pinned
 * forge base image, the fuzz seed every forge run uses, the gVisor release and
 * the Semgrep rule set, the test-paths gate with its glob matcher (so the
 * runner, the site and the EA match paths the same way), the baseline rule and
 * schema the listing check writes baseline.json by (node A2b), the report's
 * schema, limits and hash, the class envelopes that set the pack's budget
 * (node A3b), and the canary's published hash and the package's own version,
 * which a conformance pass is held to (node A8).
 *
 * Only these modules are loaded (they need nothing but ajv): the package's
 * main entry brings the IPFS client and its HTTP stack, which the runner has
 * no use for.
 */

const { BASE_IMAGE_PINS, FORGE_FUZZ_SEED, GVISOR_RELEASE, SEMGREP_RULES_VERSION, CONFORMANCE_CANARY } = require('@verdikta/common/src/codeReview/pins');
const COMMON_VERSION = require('@verdikta/common/package.json').version;
const { pocPatchPathsGate, matchesAny, normalizePath, splitByStakeScope } = require('@verdikta/common/src/codeReview/scope');
const { baselineSets, validateBaseline } = require('@verdikta/common/src/codeReview/baseline');
const { BASELINE_RUNS, CLASS_HARD_LIMITS, SPEC_LIMIT_MAXIMA, OCI_PLATFORM } = require('@verdikta/common/src/codeReview/constants');
const { REPORT_LIMITS, POC_RUNS, validateClaimReport, canonicalReportJson, reportSha256 } = require('@verdikta/common/src/codeReview/report');
const { MAX_PRIOR_FINDINGS } = require('@verdikta/common/src/codeReview/request');
const { canonicalJson } = require('@verdikta/common/src/codeReview/canonical');
const { validateFinding, validateKnownIssues } = require('@verdikta/common/src/codeReview/validate');
const { getCodeClass, CODE_CLASSES } = require('@verdikta/common/src/codeReview/classes');
const SPEC_SCHEMA = require('@verdikta/common/schemas/code_review.v1.json');
const REPORT_SCHEMA = require('@verdikta/common/schemas/claim_report.v1.json');

/** The report's bounds its limits object does not name: a line number and a test id. */
const REPORT_MAX_LINE = REPORT_SCHEMA.definitions.Line.oneOf[0].maximum;
const REPORT_MAX_TEST_ID = REPORT_SCHEMA.definitions.TestId.maxLength;
const REPORT_MAX_REGRESSIONS = REPORT_SCHEMA.properties.fix.properties.regressionCount.maximum;

module.exports = {
  BASE_IMAGE_PINS,
  FORGE_FUZZ_SEED,
  GVISOR_RELEASE,
  SEMGREP_RULES_VERSION,
  CONFORMANCE_CANARY,
  COMMON_VERSION,
  pocPatchPathsGate,
  matchesAny,
  normalizePath,
  splitByStakeScope,
  baselineSets,
  validateBaseline,
  BASELINE_RUNS,
  CLASS_HARD_LIMITS,
  SPEC_LIMIT_MAXIMA,
  OCI_PLATFORM,
  REPORT_LIMITS,
  REPORT_MAX_LINE,
  REPORT_MAX_TEST_ID,
  REPORT_MAX_REGRESSIONS,
  POC_RUNS,
  validateClaimReport,
  canonicalReportJson,
  reportSha256,
  MAX_PRIOR_FINDINGS,
  canonicalJson,
  validateFinding,
  validateKnownIssues,
  getCodeClass,
  CODE_CLASSES,
  SPEC_SCHEMA
};
