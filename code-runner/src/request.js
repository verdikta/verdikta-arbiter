'use strict';

/**
 * POST /v1/runs request validation.
 *
 * §7.2 lists { listingCid, bcid, spec, attestation, pocPatch, fixPatch,
 * baseline, deadline }; the build plan (assumption A7) adds finding, report,
 * knownIssues, priorFindings and eaGates, because the EA, not the runner,
 * shares runs and the runner needs them for the report and the context pack.
 *
 * Shapes are checked here; the meaning of each document is checked where it
 * is used (the spec's limits and image in classLimits.js now, the rest by
 * @verdikta/common's schemas from node A3b on). An invalid request is the
 * requester's broken package: a 400, before any work.
 *
 * Patches travel as base64 so their bytes, and so their hashes, survive JSON.
 */

const FIELDS = Object.freeze([
  'listingCid', 'bcid', 'spec', 'attestation', 'pocPatch', 'fixPatch', 'baseline', 'finding', 'report',
  'knownIssues', 'priorFindings', 'eaGates', 'deadline'
]);

/** CIDv0 (base58btc multihash) or CIDv1 in base32. */
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120})$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const GATE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** E2: at most 8 prior valid findings ride with a claim. */
const MAX_PRIOR_FINDINGS = 8;
/** The EA's own deadline is receipt + 780 s; nothing legitimate asks for more than this. */
const MAX_DEADLINE_MS = 900000;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {unknown} body - the parsed JSON body
 * @returns {{ ok: boolean, issues: {code:string,path:string,detail:string}[], request: object|null }}
 */
function validateRunRequest(body) {
  const issues = [];
  const issue = (path, detail, code = 'SCHEMA') => issues.push({ code, path, detail });
  if (!isPlainObject(body)) {
    issue('/', 'the body must be a JSON object');
    return { ok: false, issues, request: null };
  }
  for (const key of Object.keys(body)) {
    if (!FIELDS.includes(key)) issue(`/${key}`, `unknown field; the request has ${FIELDS.join(', ')}`, 'UNKNOWN_FIELD');
  }
  const required = (key) => {
    if (body[key] === undefined) {
      issue(`/${key}`, 'is required', 'REQUIRED');
      return false;
    }
    return true;
  };

  for (const key of ['listingCid', 'bcid']) {
    if (required(key) && (typeof body[key] !== 'string' || !CID.test(body[key]))) issue(`/${key}`, 'must be an IPFS CID (v0 or base32 v1)');
  }
  for (const key of ['spec', 'attestation', 'baseline', 'finding']) {
    if (required(key) && !isPlainObject(body[key])) issue(`/${key}`, 'must be an object');
  }

  let pocPatch = null;
  if (required('pocPatch')) {
    if (typeof body.pocPatch !== 'string' || body.pocPatch === '' || !BASE64.test(body.pocPatch)) {
      issue('/pocPatch', 'must be the patch bytes in base64, not empty');
    } else {
      pocPatch = Buffer.from(body.pocPatch, 'base64');
    }
  }
  let fixPatch = null;
  if (body.fixPatch !== undefined && body.fixPatch !== null) {
    if (typeof body.fixPatch !== 'string' || body.fixPatch === '' || !BASE64.test(body.fixPatch)) {
      issue('/fixPatch', 'must be null or the patch bytes in base64');
    } else {
      fixPatch = Buffer.from(body.fixPatch, 'base64');
    }
  }

  if (required('report') && typeof body.report !== 'string') issue('/report', 'must be a string (report.md)');

  if (required('knownIssues')) {
    if (!Array.isArray(body.knownIssues)) issue('/knownIssues', 'must be an array');
    else body.knownIssues.forEach((k, i) => { if (!isPlainObject(k)) issue(`/knownIssues/${i}`, 'must be an object'); });
  }
  if (required('priorFindings')) {
    if (!Array.isArray(body.priorFindings)) issue('/priorFindings', 'must be an array');
    else if (body.priorFindings.length > MAX_PRIOR_FINDINGS) issue('/priorFindings', `at most ${MAX_PRIOR_FINDINGS} prior findings`);
    else body.priorFindings.forEach((f, i) => { if (!isPlainObject(f)) issue(`/priorFindings/${i}`, 'must be an object'); });
  }
  if (required('eaGates')) {
    if (!isPlainObject(body.eaGates)) issue('/eaGates', 'must be an object of gate name to "pass" or "fail"');
    else {
      for (const [name, value] of Object.entries(body.eaGates)) {
        if (!GATE_NAME.test(name)) issue(`/eaGates/${name}`, 'is not a gate name');
        else if (value !== 'pass' && value !== 'fail') issue(`/eaGates/${name}`, 'must be "pass" or "fail"');
      }
    }
  }
  if (required('deadline')) {
    if (!Number.isInteger(body.deadline) || body.deadline < 1 || body.deadline > MAX_DEADLINE_MS) {
      issue('/deadline', `must be the remaining time in milliseconds, an integer from 1 to ${MAX_DEADLINE_MS}`);
    }
  }

  if (issues.length) return { ok: false, issues, request: null };
  return {
    ok: true,
    issues: [],
    request: {
      listingCid: body.listingCid,
      bcid: body.bcid,
      spec: body.spec,
      attestation: body.attestation,
      pocPatch,
      fixPatch,
      baseline: body.baseline,
      finding: body.finding,
      report: body.report,
      knownIssues: body.knownIssues,
      priorFindings: body.priorFindings,
      eaGates: body.eaGates,
      deadlineMs: body.deadline
    }
  };
}

module.exports = { validateRunRequest, FIELDS, MAX_DEADLINE_MS, MAX_PRIOR_FINDINGS };
