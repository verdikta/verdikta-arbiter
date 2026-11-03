'use strict';

/**
 * The Verification Report (design §9.3, §9.4; node A3b): the facts a run
 * measured, laid out field by field in @verdikta/common's
 * verdikta.claim-report/1, validated and hashed by common. Nothing else
 * reaches it, so it has no duration, host name, path or per-run directory.
 *
 * Two forms keep it the same on every host, while `facts` keep what each run
 * did (pocReportForm, called when the PoC's facts are recorded):
 *
 * - A test's message is carried only when it is byte-identical on all three
 *   runs of the fixed schedule, else null: a clock, an unseeded random value or
 *   a run directory moves between runs, and is measured doing so.
 * - A test whose results (pass, fail, error) disagree across the schedule is
 *   reported as `error` on all three runs with one fixed message, whichever run
 *   passed: on a fast and a slow host a flaky PoC reads the same. It disproved
 *   the claim either way, so what settlement reads does not change.
 *
 * And nothing a hunter writes can make a report invalid, which would make every
 * arbiter abstain: a test id the schema could not carry becomes a prefix and its
 * SHA-256, and text is made well-formed and cut on a whole character. What the
 * requester sends is checked before any work (request.js, claim.js).
 *
 * Not in the report, for want of a field: the compiler the run pinned (owner
 * decision Q37; `facts.compiler`). It is a function of the image and the listed
 * commit, which are.
 */

const crypto = require('node:crypto');
const {
  OCI_PLATFORM, SEMGREP_RULES_VERSION, REPORT_LIMITS, canonicalJson, validateClaimReport, canonicalReportJson, reportSha256
} = require('./common');
const { RUNNER_VERSION } = require('./version');

const GATES = Object.freeze(['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable']);
/** A test's results that N1 folds: the ones that decide nothing about its identity (skip, missing and duplicate are integrity's). */
const FOLDED = Object.freeze(['pass', 'fail', 'error']);
/** The fixed message of a test whose runs disagreed. */
const SCHEDULE_DISAGREED = 'the runs of the fixed schedule disagreed';
const MAX_TEST_ID = 1024;
/** How much of a long or unprintable test id stays readable beside its hash. */
const TEST_ID_PREFIX = 900;
const RUN_COUNT_KEY = Object.freeze({ fail: 'fail', pass: 'pass', error: 'error', skip: 'skip', missing: 'missing', duplicate: 'duplicate', 'not-run': 'notRun' });

class ReportUnavailable extends Error {}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Text in one form: well-formed Unicode, at most `max` UTF-16 units, never cut through a character. */
function boundedText(text, max) {
  const whole = String(text).toWellFormed();
  if (whole.length <= max) return whole;
  const head = whole.slice(0, max);
  const last = head.charCodeAt(max - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, max - 1) : head;
}

/** A test id as the report can carry it (common's TestId): the same id when it can, else a readable prefix and its hash. */
function reportTestId(id) {
  const clean = String(id).toWellFormed().replace(/[\u0000-\u001f\u007f]/g, '?');
  if (clean === id && clean !== '' && [...clean].length <= MAX_TEST_ID) return id;
  return `${boundedText(clean, TEST_ID_PREFIX)} [sha256:${sha256(Buffer.from(String(id), 'utf16le'))}]`;
}

/** One test on the schedule, as the report carries it. `list`: each run's { result, message }. */
function reportTestForm(list) {
  const runs = list.map((e) => e.result);
  const uniform = runs.every((r) => r === runs[0]);
  if (!uniform && runs.every((r) => FOLDED.includes(r))) {
    return { runs: runs.map(() => 'error'), kind: 'error', message: SCHEDULE_DISAGREED };
  }
  // common's rule: any error on any run makes the test's kind `error`, else any failure `assertion`.
  const worst = runs.includes('error') ? 'error' : runs.includes('fail') ? 'fail' : null;
  if (worst === null) return { runs, kind: null, message: null };
  const messages = list.filter((e) => e.result === worst).map((e) => (typeof e.message === 'string' ? e.message : null));
  return { runs, kind: worst === 'error' ? 'error' : 'assertion', message: messages.every((m) => m === messages[0]) ? messages[0] : null };
}

/**
 * The PoC's results in the report's form: over every test and run, the first
 * tests in code-unit order of id, up to the report's bound.
 * @param {Array<[string, Array<{result:string, message:string|null}>]>} entries - id and runs, ids sorted
 * @returns {{testCount:number, runCounts:object, tests:object[]}}
 */
function pocReportForm(entries) {
  const runCounts = Object.fromEntries(Object.values(RUN_COUNT_KEY).map((k) => [k, 0]));
  const tests = [];
  for (const [id, list] of entries) {
    const form = reportTestForm(list);
    for (const run of form.runs) runCounts[RUN_COUNT_KEY[run]] += 1;
    if (tests.length < REPORT_LIMITS.pocTests) tests.push({ id: reportTestId(id), ...form });
  }
  return { testCount: entries.length, runCounts, tests };
}

/** The attestation's digest: SHA-256 of its canonical JSON, the bytes common signs and hashes documents as. */
function attestationSha256(attestation) {
  return sha256(Buffer.from(canonicalJson(attestation), 'utf8'));
}

/** The report's fields from a run's facts and gates and the request's bytes. Not yet validated. */
function assembleReport(result, request, { gvisor }) {
  const facts = result.facts;
  const gate = (name) => (result.gates[name] ? result.gates[name].status : 'not-run');
  const stat = (d) => (d ? { files: d.files, added: d.added, removed: d.removed } : { files: 0, added: 0, removed: 0 });
  const image = String(request.spec.env.image);
  const fix = facts.fix;
  const flags = facts.flags || { existingTestsModified: [], skipMarkersAdded: [], protectedPathsTouched: [] };
  return {
    schema: 'verdikta.claim-report/1',
    inputs: {
      listingCid: request.listingCid,
      bcid: request.bcid,
      envImage: image.slice(image.indexOf('@') + 1),
      platform: OCI_PLATFORM,
      attestationSha256: attestationSha256(request.attestation),
      baseCommit: request.spec.baseCommit,
      pocPatchSha256: sha256(request.pocPatch),
      fixPatchSha256: request.fixPatch ? sha256(request.fixPatch) : null,
      runner: RUNNER_VERSION,
      gvisor,
      semgrepRules: SEMGREP_RULES_VERSION,
      eaGates: { disclosure: request.eaGates.disclosure, inScope: request.eaGates.inScope }
    },
    gates: Object.fromEntries(GATES.map((g) => [g, gate(g)])),
    poc: facts.poc ? {
      tier: 'B', ...facts.poc.report, integrity: facts.poc.integrity, honestyFlags: facts.poc.honestyFlags || []
    } : null,
    fix: {
      present: fix.present, applies: fix.applies, builds: fix.builds, pocPasses: fix.pocPasses,
      regressions: fix.regressions, regressionCount: fix.regressionCount, tier: 'B', integrity: fix.integrity
    },
    build: { status: gate('build'), tier: 'A' },
    findings: facts.findings || [],
    flags: { existingTestsModified: flags.existingTestsModified, skipMarkersAdded: flags.skipMarkersAdded, protectedPathsTouched: flags.protectedPathsTouched },
    diff: { poc: stat(facts.diff), fix: fix.present ? stat(fix.diff) : null }
  };
}

/**
 * The report of a definitive run, in its canonical form, with its hash.
 * @param {object} result - executeRun's result
 * @param {object} request - the validated request
 * @param {object} o
 * @param {string} o.gvisor - the runtime measured (runtime.js)
 * @param {string} [o.platform] - the platform the run used (default: the result's)
 * @returns {{report:object, sha256:string, warnings:object[]}}
 * @throws {ReportUnavailable} on a platform the schema has no value for
 * @throws {Error} when the report does not validate: a bug in the runner
 */
function buildReport(result, request, { gvisor, platform = result.platform }) {
  if (platform !== OCI_PLATFORM) {
    throw new ReportUnavailable(`the report's platform is ${OCI_PLATFORM}; this run used ${platform} (a development setting)`);
  }
  const report = assembleReport(result, request, { gvisor });
  const checked = validateClaimReport(report);
  if (!checked.ok) throw new Error(`not a valid claim report: ${checked.issues.slice(0, 5).map((i) => `${i.code} ${i.path}`).join('; ')}`);
  return { report: JSON.parse(canonicalReportJson(report)), sha256: reportSha256(report), warnings: checked.warnings };
}

/** Set a definitive result's report (server.js). A run on a development platform answers why it has none. */
function finishClaim(result, request, { log } = {}) {
  try {
    const { report, sha256: hash, warnings } = buildReport(result, request, { gvisor: result.gvisor });
    result.report = report;
    result.reportSha256 = hash;
    if (warnings.length && log) log.warn('the report is off a pin, or its text names a host path', { runId: result.runId, codes: [...new Set(warnings.map((w) => w.code))] });
  } catch (err) {
    if (!(err instanceof ReportUnavailable)) throw err;
    result.reportUnavailable = err.message;
  }
}

module.exports = {
  buildReport, assembleReport, finishClaim, attestationSha256, pocReportForm, reportTestForm, reportTestId, boundedText, ReportUnavailable, SCHEDULE_DISAGREED
};
