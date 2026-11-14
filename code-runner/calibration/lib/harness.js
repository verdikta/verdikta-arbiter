'use strict';

/**
 * What the calibration harness and the conformance canary share: a listing's archive and the
 * request the External Adapter would send the runner, and the real listing check on a fixture.
 */

const { isDeepStrictEqual } = require('node:util');
const { codeReview } = require('@verdikta/common');
const { listingArchive, claimArchive, storedZip, cidV0 } = require('./archives');

const EXIT = Object.freeze({ OK: 0, DISAGREE: 1, MALFORMED: 2, HARNESS: 3 });
const DEADLINE_MS = 900000;
const CODE_CLASS = 'code-standard';

/** A stop the harness cannot go past: nothing was measured. */
class HarnessError extends Error {}

/** The listing with its published image: the spec as the arbiters read it, and its archive named by its bytes. */
function listingView(listing, published) {
  const spec = { ...listing.spec, env: { ...listing.spec.env, image: published.image } };
  const { image, from, platform, unpackedBytes } = spec.env;
  const attestation = { version: 1, env: { image, from, platform, unpackedBytes } };
  const buffer = listingArchive({
    spec,
    baseline: listing.baseline,
    knownIssues: listing.knownIssues,
    attestation,
    query: codeReview.buildClaimQuery(spec),
    juryParameters: codeReview.CODE_STANDARD_PANEL,
    outcomes: [...codeReview.BUG_OUTCOMES]
  });
  return { spec, attestation, buffer, cid: cidV0(buffer) };
}

function priorArchive(prior) {
  return storedZip({
    'manifest.json': { version: '1.0', name: prior.name, primary: { filename: 'primary_query.json' } },
    'primary_query.json': { query: `Claim: ${prior.finding.title || prior.name} (see report.md).` },
    'finding.json': prior.finding,
    'report.md': prior.report
  });
}

/**
 * A case's claim archive and the body of POST /v1/runs, with the EA's gates passed: the runner
 * reads this only after them, and neither is what this harness measures.
 */
function caseRequest(entry, view) {
  const { listing, claim } = entry;
  const archive = claimArchive({ name: entry.id, finding: claim.finding, report: claim.report, poc: claim.poc, fix: claim.fix });
  // The file names keep the case's order: the testing tool reads priors/ in file-name order, and the list is in commit order.
  const priors = entry.priors.map((prior, i) => {
    const buffer = priorArchive(prior);
    return { file: `${String(i + 1).padStart(2, '0')}-${prior.name}.zip`, buffer, bcid: cidV0(buffer), finding: prior.finding, report: prior.report };
  });
  const body = {
    listingCid: view.cid,
    bcid: cidV0(archive),
    spec: view.spec,
    attestation: view.attestation,
    pocPatch: claim.poc.toString('base64'),
    fixPatch: claim.fix ? claim.fix.toString('base64') : null,
    baseline: listing.baseline,
    finding: claim.finding,
    report: claim.report,
    knownIssues: listing.knownIssues,
    priorFindings: priors.map(({ bcid, finding, report }) => ({ bcid, finding, report })),
    eaGates: { disclosure: 'pass', inScope: 'pass' },
    deadline: DEADLINE_MS,
    codeClass: CODE_CLASS
  };
  return { body, archive, priors };
}

function assertBaseline(listing, measured) {
  const { timings: _measured, ...baseline } = measured;
  if (!isDeepStrictEqual(baseline, listing.baseline)) {
    throw new HarnessError(`${listing.id}: the listing check measured another baseline than baseline.json: ${JSON.stringify(baseline).slice(0, 800)}`);
  }
}

/**
 * The real listing check must accept the fixture, and measure the baseline the listing commits to.
 *
 * `slowHost` is for a host that cannot run a listing inside the class's time caps, which CI's can: a refusal for time and
 * nothing else then returns { refusedForTime } instead of stopping, and nothing about the run's own cases is relaxed. Any
 * other refusal stops as ever. The caller says so wherever the results go.
 */
async function checkListing(session, listing, published, view, { onMeasured = null, slowHost = false } = {}) {
  const res = await session.listingCheck(published, listing, view);
  const answer = res.body || {};
  if (answer.outcome !== 'definitive') {
    throw new HarnessError(`the listing check of ${listing.id} did not finish (HTTP ${res.status}): ${JSON.stringify(answer.abstain || answer.issues || answer).slice(0, 800)}`);
  }
  const found = answer.listing;
  if (found.status !== 'accepted') {
    const refusals = Array.isArray(found.refusals) ? found.refusals : [];
    if (slowHost && refusals.length > 0 && refusals.every((refusal) => refusal.code === 'LISTING_TOO_HEAVY')) {
      // A refusal from the derived limits comes after the whole measurement: what it measured still has to be the listing's.
      if (found.baseline) assertBaseline(listing, found.baseline);
      return { refusedForTime: refusals.map((refusal) => refusal.detail) };
    }
    throw new HarnessError(`the listing check refused ${listing.id}: ${JSON.stringify(found.refusals).slice(0, 800)}`);
  }
  const { timings: _measured, ...baseline } = found.baseline;
  if (onMeasured) onMeasured({ baseline, timings: found.timings, limits: found.limits, warnings: found.warnings, image: found.image, checkout: found.checkout });
  assertBaseline(listing, found.baseline);
  return found;
}

module.exports = { EXIT, DEADLINE_MS, CODE_CLASS, HarnessError, listingView, caseRequest, checkListing };
