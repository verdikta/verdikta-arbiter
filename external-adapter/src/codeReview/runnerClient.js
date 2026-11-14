/**
 * @fileoverview The adapter's calls to the code runner (design §7.2, §9, §12;
 * code-runner/README.md, API), and how it reads the answers.
 *
 * Reading is one-sided: anything that is not exactly a definitive answer with a
 * report common accepts and whose hash is its own is not a fact, and the arbiter
 * abstains. Messages name codes and listing-level facts only, because they travel
 * to the Chainlink node: never `detail`, which can quote a run, and never `reasons`.
 * The token is sent only to the configured runner: no redirects, no proxy.
 */

const axios = require('axios');
const { codeReview } = require('@verdikta/common');
const { CodeReviewRequesterError, CodeReviewAbstain, issueCodes } = require('./errors');

/** A `/health` that takes this long is not a healthy runner. */
const HEALTH_TIMEOUT_MS = 15000;
/** The most a runner's answer may hold: its logs, report and pack are far smaller. */
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
/** A cause, an issue code or a step (the runner names steps `patch:apply`, `poc:run-1`). */
const CODE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;
/**
 * What of a prior finding's report.md goes to the runner, which does not read it
 * (README, POST /v1/runs): the shape, and no way for one prior finding's padding to
 * take a later claim's request over the runner's limit.
 */
const PRIOR_REPORT_MAX_CHARS = 4096;
/** The pack's own token rule (code-runner/src/pack.js). */
const BYTES_PER_PACK_TOKEN = 4;
const IMAGE_CACHE = Object.freeze(['hit', 'pulled', 'shared']);

const abstain = (code, detail) => new CodeReviewAbstain(code, detail);
/** A code from an answer, only when it looks like one. */
const codeOf = (value) => (typeof value === 'string' && CODE.test(value) ? value : 'unknown');

function httpOptions(runner, signal) {
  return {
    signal,
    headers: { Authorization: `Bearer ${runner.readToken()}` },
    validateStatus: () => true,
    maxRedirects: 0,
    proxy: false,
    maxBodyLength: Infinity,
    maxContentLength: MAX_ANSWER_BYTES
  };
}

function runnerEndpoint(runner, route) {
  return `${runner.url.replace(/\/+$/, '')}${route}`;
}

/**
 * @param {{ url: string, readToken: () => string }} runner
 * @param {{ deadline: object }} options
 * @returns {Promise<{ version: string }>}
 * @throws {CodeReviewAbstain} unreachable or unhealthy
 */
async function runnerHealth(runner, { deadline }) {
  const stop = deadline.abortAtDeadline({ maxMs: HEALTH_TIMEOUT_MS });
  let response;
  try {
    response = await axios.get(runnerEndpoint(runner, '/health'), httpOptions(runner, stop.signal));
  } catch (error) {
    if (stop.signal.aborted) {
      throw stop.byDeadline
        ? deadline.expired('runner\'s health check answered')
        : abstain('CODE_REVIEW_RUNNER_UNHEALTHY', `the runner's /health did not answer within ${HEALTH_TIMEOUT_MS} ms`);
    }
    throw abstain('CODE_REVIEW_RUNNER_UNREACHABLE', `the runner cannot be reached (${codeOf(error.code)})`);
  } finally {
    stop.clear();
  }
  const body = response.data;
  if (response.status !== 200 || !body || typeof body !== 'object' || body.ok !== true) {
    throw abstain('CODE_REVIEW_RUNNER_UNHEALTHY', `the runner's /health answered ${response.status}`);
  }
  if (typeof body.version !== 'string' || !VERSION.test(body.version)) {
    throw abstain('CODE_REVIEW_RUNNER_UNHEALTHY', 'the runner\'s /health names no version');
  }
  return { version: body.version };
}

/** The text cut to at most `max` UTF-16 units, never through a character. */
function cutText(text, max) {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * POST /v1/runs's body for a claim that passed the EA's gates: a pure function
 * of the context and the time remaining.
 *
 * Nothing the claim holds can take it over the runner's 16 MiB limit, which would
 * make every arbiter abstain: the front gates have already settled a poc.patch over
 * maxPatchBytes and dropped such a fix.patch, and report.md goes only as far as the
 * whole pack could hold of it (each UTF-16 unit is at least a byte). An empty fix.patch
 * goes as absent, since the runner refuses an empty field.
 *
 * @param {object} context - see frontGates.runFrontGates
 * @param {number} deadlineMs
 * @returns {object}
 */
function buildRunRequest(context, deadlineMs) {
  const { listing, claim } = context;
  const reportMax = codeReview.getCodeClass(context.codeClass).envelope.contextPackTokens * BYTES_PER_PACK_TOKEN;
  return {
    listingCid: listing.cid,
    bcid: claim.bcid,
    spec: listing.spec,
    attestation: listing.attestation,
    pocPatch: Buffer.from(claim.pocPatch).toString('base64'),
    fixPatch: claim.fixPatch && claim.fixPatch.length > 0 ? Buffer.from(claim.fixPatch).toString('base64') : null,
    baseline: listing.baseline,
    finding: claim.finding,
    report: cutText(claim.report, reportMax),
    knownIssues: listing.knownIssues,
    priorFindings: context.priorFindings.map((prior) => ({ ...prior, report: cutText(prior.report, PRIOR_REPORT_MAX_CHARS) })),
    eaGates: context.eaGates,
    deadline: deadlineMs,
    codeClass: context.codeClass
  };
}

/** How the env image was had, the runner's operational fact: differs between arbiters, and never in the report. Or null. */
function imageFact(image) {
  if (!image || typeof image !== 'object' || !IMAGE_CACHE.includes(image.cache)) return null;
  return Number.isSafeInteger(image.durationMs) && image.durationMs >= 0 ? { cache: image.cache, durationMs: image.durationMs } : null;
}

/**
 * Read POST /v1/runs's answer.
 * @param {number} status
 * @param {unknown} body
 * @returns {{ report: object, reportSha256: string, contextPack: object|null }} the report canonical, checked by common
 * @throws {CodeReviewRequesterError} the runner refused the requester's package
 * @throws {CodeReviewAbstain} anything else that is not a fact
 */
function readRunAnswer(status, body) {
  const answer = body && typeof body === 'object' ? body : {};
  if (status === 400 && answer.outcome === 'requester_error') {
    const issues = Array.isArray(answer.issues) ? answer.issues : [];
    throw new CodeReviewRequesterError('CODE_REVIEW_RUNNER_REFUSED',
      `the runner refused the request: ${issueCodes(issues.map((issue) => ({ code: codeOf(issue && issue.code) })))}`);
  }
  if (status === 503 && answer.outcome === 'abstain') {
    const cause = answer.abstain && answer.abstain.cause;
    const step = answer.abstain && answer.abstain.step;
    throw abstain('CODE_REVIEW_RUNNER_ABSTAIN', `the runner abstained (cause ${codeOf(cause)}, step ${codeOf(step)})`);
  }
  if (status !== 200 || answer.outcome !== 'definitive') {
    throw abstain('CODE_REVIEW_RUNNER_ANSWER', `the runner answered ${status} with outcome ${codeOf(answer.outcome)}`);
  }
  if (answer.report === null && typeof answer.reportUnavailable === 'string') {
    throw abstain('CODE_REVIEW_REPORT_UNAVAILABLE', 'the run has no report: it ran on a development platform the report\'s schema has no value for');
  }
  if (!answer.report || typeof answer.report !== 'object') {
    throw abstain('CODE_REVIEW_REPORT_MISSING', 'a definitive answer came without a report');
  }
  const checked = codeReview.validateClaimReport(answer.report);
  if (!checked.ok) {
    throw abstain('CODE_REVIEW_REPORT_INVALID', `the report does not validate: ${issueCodes(checked.issues)}`);
  }
  const hash = codeReview.reportSha256(answer.report);
  if (hash !== answer.reportSha256) {
    throw abstain('CODE_REVIEW_REPORT_HASH', 'the report\'s hash is not what the answer says');
  }
  return {
    report: JSON.parse(codeReview.canonicalReportJson(answer.report)),
    reportSha256: hash,
    warnings: checked.warnings.map((warning) => warning.code),
    contextPack: answer.contextPack && typeof answer.contextPack === 'object' ? answer.contextPack : null,
    image: imageFact(answer.image)
  };
}

/**
 * POST /v1/runs. Closing the socket at the deadline cancels the run: the runner
 * kills its sandbox when its caller goes.
 * @param {{ url: string, readToken: () => string }} runner
 * @param {object} body
 * @param {{ deadline: object }} options
 * @returns {Promise<object>} readRunAnswer's
 */
async function postRun(runner, body, { deadline }) {
  const stop = deadline.abortAtDeadline();
  let response;
  try {
    response = await axios.post(runnerEndpoint(runner, '/v1/runs'), body, httpOptions(runner, stop.signal));
  } catch (error) {
    if (stop.signal.aborted) throw deadline.expired('runner answered');
    throw abstain(error.code === 'ERR_BAD_RESPONSE' ? 'CODE_REVIEW_RUNNER_ANSWER' : 'CODE_REVIEW_RUNNER_UNREACHABLE',
      `the runner's answer did not arrive (${codeOf(error.code)})`);
  } finally {
    stop.clear();
  }
  return readRunAnswer(response.status, response.data);
}

module.exports = { runnerHealth, buildRunRequest, readRunAnswer, postRun };
