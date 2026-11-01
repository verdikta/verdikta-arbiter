/**
 * @fileoverview The code-review front gates: everything the External Adapter
 * decides about a claim before any runner call or model call (design §9.1,
 * §10.1, §10.4, §12, §13.3 with errata E1/E2, §14).
 *
 * Order, and why. Requester errors are decided before anything is held
 * against the claim, so a broken listing or a broken request never costs a
 * hunter the bond; static claim checks come before the one network fetch the
 * claim gates need, so an unreachable ciphertext cannot turn a malformed
 * claim into an abstention.
 *
 *  1. operator: code review enabled, runner configured, the pinned common
 *     release installed (here and in the AI Node), trust mode usable           → requester error
 *  2. request:  cids = [listing, claim, ≤ 8 prior findings], no repeats    → requester error
 *  3. listing (cids[0]): manifest and the six outcomes, code_review.json,
 *     the code-standard envelope (assumption A8: whatever class the request
 *     came on), attestation.json, known_issues.json, baseline.json            → requester error
 *  4. request composition: prior findings readable (finding.json, report.md),
 *     the dispute line (read on its own) and statement (≤ 4 KB)               → requester error
 *  5. claim (cids[1]): the archive's structure, then its members
 *     (finding.json, report.md, poc.patch; fix.patch optional)                → INVALID
 *  6. disclosure: the E1 line, the ciphertext fetched by CID, verifyDisclosure
 *     with the listing's disclosureKey (BAD_DISCLOSURE_KEY is the listing's)  → INVALID
 *  7. inScope: validateFinding against the spec                              → INVALID
 *
 * Transient failures (IPFS, disk) propagate untouched: errored, no commit.
 * Every rule here is @verdikta/common's; this module only orders the calls
 * and decides who is at fault.
 *
 * Logs carry CIDs, hashes and check codes, never archive contents or keys
 * (§16).
 */

const crypto = require('crypto');
const { codeReview, MalformedArchiveError: LibMalformedArchiveError } = require('@verdikta/common');
const { CodeReviewRequesterError, issueCodes } = require('./errors');
const { readMember, utf8, looksLikePatch, jsonObject } = require('./archiveMembers');
const { readMachineLines } = require('./addendum');
const { buildCodeReviewInvalidVerdict } = require('./verdict');
const { devTrustActive } = require('./config');

/** Assumption A8: the bridge does not tell the EA the request's class, and code-premium is not enabled. */
const CODE_CLASS = 'code-standard';
/** Erratum E2: [listing, claim, up to 8 prior valid findings]. Read at call time, not at load. */
const maxCids = () => 2 + codeReview.MAX_PRIOR_FINDINGS;

const requester = (code, detail) => new CodeReviewRequesterError(code, detail);

function describeName(name) {
  if (typeof name !== 'string') return `a ${name === null ? 'null' : typeof name}`;
  return JSON.stringify(name.length > 80 ? `${name.slice(0, 80)}…` : name);
}

function bounded(text, max = 300) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function u8(buffer) {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function sha256Hex0x(bytes) {
  return `0x${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

/** Common's validator reports a content problem as a MalformedArchiveError (>= 1.9) or by message prefix. */
function isContentRejection(error) {
  return error instanceof LibMalformedArchiveError
    || (error instanceof Error && /^(Invalid manifest:|Invalid JSON in primary file:|Invalid primary file content:|Primary file outcomes count)/.test(error.message));
}

function jsonValue(bytes) {
  const text = utf8(bytes);
  if (text === null) return { problem: 'is not valid UTF-8' };
  try {
    return { value: JSON.parse(text) };
  } catch (_error) {
    return { problem: 'is not valid JSON' };
  }
}

// ---------------------------------------------------------------------------
// 1–2. operator and request layout

function assertOperatorReady(config) {
  if (!config.ready) {
    throw requester('CODE_REVIEW_DISABLED',
      `code review is not enabled on this arbiter (${config.problems.join('; ') || 'not ready'})`);
  }
}

function assertRequestLayout(cidArray) {
  if (cidArray.length < 2) {
    throw requester('CODE_REVIEW_CIDS', 'a code-review request is [listing, claim, prior findings…]; this one names no claim');
  }
  if (cidArray.length > maxCids()) {
    throw requester('CODE_REVIEW_CIDS',
      `at most ${maxCids()} CIDs (the listing, the claim and ${codeReview.MAX_PRIOR_FINDINGS} prior findings); this request has ${cidArray.length}`);
  }
  if (new Set(cidArray).size !== cidArray.length) {
    throw requester('CODE_REVIEW_CIDS', 'a CID appears more than once in the request');
  }
}

/** A single-CID request whose manifest has codeReview has no claim to judge. */
function refuseSingleCid(config) {
  assertOperatorReady(config);
  throw requester('CODE_REVIEW_CIDS', 'a code-review request is [listing, claim, prior findings…]; this one names no claim');
}

// ---------------------------------------------------------------------------
// 3. the listing archive at cids[0]

async function listingMember(root, name, what) {
  const member = await readMember(root, name);
  if (member.status === 'unsafe') {
    throw requester('CODE_REVIEW_LISTING', `the listing names ${describeName(name)} as ${what}, but ${member.reason}`);
  }
  return member.status === 'ok' ? member.bytes : null;
}

async function readListing(root, cid, { validator, config, logger, runTag }) {
  const manifestBytes = await listingMember(root, 'manifest.json', 'its manifest');
  const parsedManifest = manifestBytes ? jsonObject(manifestBytes) : { problem: 'is missing' };
  if (parsedManifest.problem) throw requester('CODE_REVIEW_LISTING', `manifest.json ${parsedManifest.problem}`);
  const manifest = parsedManifest.value;
  try {
    await validator.validateManifest(manifest, { extractedPath: root, archiveRole: 'primary', cid });
  } catch (error) {
    if (!isContentRejection(error)) throw error;
    throw requester('CODE_REVIEW_LISTING', `the listing manifest is invalid: ${bounded(error.message)}`);
  }

  if (!manifest.primary || typeof manifest.primary.filename !== 'string') {
    throw requester('CODE_REVIEW_LISTING', 'a listing manifest names its primary file by filename');
  }
  const primaryBytes = await listingMember(root, manifest.primary.filename, 'its primary file');
  const primaryText = primaryBytes ? utf8(primaryBytes) : null;
  if (primaryText === null) {
    throw requester('CODE_REVIEW_LISTING', `the primary file ${describeName(manifest.primary.filename)} is missing or not UTF-8`);
  }
  let primary;
  try {
    primary = await validator.validateCompleteWorkflow(manifest, primaryText, { archiveRole: 'primary', cid });
  } catch (error) {
    if (!isContentRejection(error)) throw error;
    throw requester('CODE_REVIEW_LISTING', `the listing's primary file is invalid: ${bounded(error.message)}`);
  }
  const outcomes = codeReview.validateBugOutcomes(primary.outcomes);
  if (!outcomes.ok) {
    throw requester('CODE_REVIEW_LISTING',
      `a claim evaluation's outcomes are ${codeReview.BUG_OUTCOMES.join(', ')}, in that order (${issueCodes(outcomes.issues)})`);
  }

  // code_review.json
  const specBytes = await listingMember(root, manifest.codeReview, 'its codeReview spec');
  if (!specBytes) {
    throw requester('CODE_REVIEW_LISTING',
      `the manifest names ${describeName(manifest.codeReview)} as its codeReview spec, which the listing archive does not hold`);
  }
  const parsedSpec = jsonObject(specBytes);
  if (parsedSpec.problem) throw requester('CODE_REVIEW_SPEC', `code_review.json ${parsedSpec.problem}`);
  const spec = parsedSpec.value;
  const specResult = codeReview.validateCodeReviewSpec(spec);
  if (!specResult.ok) throw requester('CODE_REVIEW_SPEC', `code_review.json is invalid: ${issueCodes(specResult.issues)}`);

  // the class envelope, always code-standard (assumption A8): the archive cannot widen it
  const envelope = codeReview.validateClassEnvelope(manifest.juryParameters, CODE_CLASS);
  if (!envelope.ok) {
    throw requester('CODE_REVIEW_ENVELOPE', `the panel is outside the ${CODE_CLASS} envelope: ${issueCodes(envelope.issues)}`);
  }

  // attestation.json and the files it binds
  const attestationName = typeof spec.attestation === 'string' ? spec.attestation : codeReview.ATTESTATION_FILE;
  const attestationBytes = await listingMember(root, attestationName, 'its attestation');
  let attestation;
  if (attestationBytes) {
    const parsed = jsonObject(attestationBytes);
    if (parsed.problem) throw requester('CODE_REVIEW_ATTESTATION', `attestation.json ${parsed.problem}`);
    attestation = parsed.value;
  }
  const files = { codeReview: specBytes };
  if (typeof spec.baseline === 'string') {
    const bytes = await listingMember(root, spec.baseline, 'its baseline');
    if (bytes) files.baseline = bytes;
  }
  const knownIssuesName = typeof spec.stake.knownIssues === 'string' ? spec.stake.knownIssues : null;
  if (knownIssuesName) {
    const bytes = await listingMember(root, knownIssuesName, 'its known issues');
    if (bytes) files.knownIssues = bytes;
  }
  // The statement's own (signed) `trust` picks the verification: dev keys
  // only for a dev statement on an arbiter in dev trust; production otherwise.
  const trust = devTrustActive(config) && attestation && attestation.trust === 'dev'
    ? { dev: true, keys: config.trust.devKeys }
    : undefined;
  const verified = codeReview.validateAttestation(attestation, { files, trust });
  if (!verified.ok) {
    throw requester('CODE_REVIEW_ATTESTATION',
      `attestation.json does not verify under ${trust ? 'dev' : 'production'} trust: ${issueCodes(verified.issues)}`);
  }
  for (const warning of verified.warnings) {
    logger.warn(`${runTag} code-review listing ${cid}: attestation ${warning.code}`);
  }

  // known_issues.json and baseline.json, bound by the attestation, read for the run
  let knownIssues = [];
  if (knownIssuesName) {
    const parsed = jsonValue(files.knownIssues);
    const result = parsed.problem ? null : codeReview.validateKnownIssues(parsed.value);
    if (!result || !result.ok) {
      throw requester('CODE_REVIEW_KNOWN_ISSUES',
        `known_issues.json ${parsed.problem || `is invalid: ${issueCodes(result.issues)}`}`);
    }
    knownIssues = parsed.value;
  }
  // (validateAttestation has already failed a spec that names no baseline, or an absent one)
  const parsedBaseline = files.baseline ? jsonObject(files.baseline) : { problem: 'is missing' };
  const baselineResult = parsedBaseline.problem ? null : codeReview.validateBaseline(parsedBaseline.value, spec);
  if (!baselineResult || !baselineResult.ok) {
    throw requester('CODE_REVIEW_BASELINE',
      `baseline.json ${parsedBaseline.problem || `is invalid: ${issueCodes(baselineResult.issues)}`}`);
  }

  return {
    cid,
    extractedPath: root,
    manifest,
    outcomes: primary.outcomes,
    juryParameters: manifest.juryParameters,
    spec,
    attestation,
    knownIssues,
    baseline: parsedBaseline.value,
    files,
    trust: trust ? 'dev' : 'production'
  };
}

// ---------------------------------------------------------------------------
// 4. the rest of the request: prior findings and the dispute statement

async function readPriorFinding(cid, root) {
  const fail = (what) => requester('CODE_REVIEW_PRIOR_FINDING', `prior finding ${cid}: ${what}`);
  const findingMember = await readMember(root, codeReview.FINDING_FILE);
  if (findingMember.status !== 'ok') throw fail(`${codeReview.FINDING_FILE} is ${findingMember.status === 'missing' ? 'missing' : 'unsafe'}`);
  const finding = jsonObject(findingMember.bytes);
  if (finding.problem) throw fail(`${codeReview.FINDING_FILE} ${finding.problem}`);
  const valid = codeReview.validateFinding(finding.value);
  if (!valid.ok) throw fail(`${codeReview.FINDING_FILE} is invalid (${issueCodes(valid.issues)})`);

  const reportMember = await readMember(root, codeReview.REPORT_FILE);
  if (reportMember.status !== 'ok') throw fail(`${codeReview.REPORT_FILE} is ${reportMember.status === 'missing' ? 'missing' : 'unsafe'}`);
  const report = utf8(reportMember.bytes);
  if (report === null || report.trim() === '') throw fail(`${codeReview.REPORT_FILE} is empty or not UTF-8`);
  // only these two members of a prior finding enter the evaluation (§13.3)
  return { bcid: cid, finding: finding.value, report };
}

async function readPriorFindings(priorCids, { extractedPaths, malformedBCIDs }) {
  const priors = [];
  for (const cid of priorCids) {
    const malformed = malformedBCIDs.find((error) => error.cid === cid);
    if (malformed) {
      throw requester('CODE_REVIEW_PRIOR_FINDING', `prior finding ${cid} is not a well-formed claim archive (${malformed.check})`);
    }
    priors.push(await readPriorFinding(cid, extractedPaths[cid]));
  }
  return priors;
}

async function readDisputeStatement(statementCid, archiveService) {
  const bytes = await archiveService.getArchive(statementCid); // a fetch failure is transient
  if (bytes.length > codeReview.MAX_DISPUTE_STATEMENT_BYTES) {
    throw requester('CODE_REVIEW_DISPUTE',
      `the dispute statement ${statementCid} is ${bytes.length} bytes; at most ${codeReview.MAX_DISPUTE_STATEMENT_BYTES}`);
  }
  const statement = utf8(bytes);
  if (statement === null) throw requester('CODE_REVIEW_DISPUTE', `the dispute statement ${statementCid} is not UTF-8 text`);
  return { statementCid, statement };
}

// ---------------------------------------------------------------------------
// 5–7. the claim at cids[1]

/** The claim's members, or the first one that fails (finding.json, report.md, poc.patch). */
async function readClaimMembers(root) {
  const failure = (member, check, reason) => ({ failure: { member, check, reason } });
  const read = async (member) => {
    const result = await readMember(root, member);
    if (result.status === 'missing') return failure(member, 'claim-member-missing', `${member} is not in the claim archive`);
    if (result.status === 'unsafe') return failure(member, 'claim-member-unsafe', `${member}: ${result.reason}`);
    return { bytes: result.bytes };
  };

  const findingMember = await read(codeReview.FINDING_FILE);
  if (findingMember.failure) return findingMember;
  const finding = jsonObject(findingMember.bytes);
  if (finding.problem) {
    return failure(codeReview.FINDING_FILE, 'claim-member-unparseable', `${codeReview.FINDING_FILE} ${finding.problem}`);
  }

  const reportMember = await read(codeReview.REPORT_FILE);
  if (reportMember.failure) return reportMember;
  const report = utf8(reportMember.bytes);
  if (report === null) return failure(codeReview.REPORT_FILE, 'claim-member-unparseable', `${codeReview.REPORT_FILE} is not valid UTF-8`);
  if (report.trim() === '') return failure(codeReview.REPORT_FILE, 'claim-member-unparseable', `${codeReview.REPORT_FILE} is empty`);

  const pocMember = await read(codeReview.POC_PATCH_FILE);
  if (pocMember.failure) return pocMember;
  if (!looksLikePatch(pocMember.bytes)) {
    return failure(codeReview.POC_PATCH_FILE, 'claim-member-unparseable',
      `${codeReview.POC_PATCH_FILE} is not a patch (no "diff --git" header and no unified-diff hunk)`);
  }

  // optional, and never gated: checked and reported by the runner (§20, decision 14)
  const fixMember = await readMember(root, codeReview.FIX_PATCH_FILE);
  const warnings = fixMember.status === 'unsafe' ? ['FIX_PATCH_UNSAFE_IGNORED'] : [];
  return {
    finding: finding.value,
    report,
    pocPatch: pocMember.bytes,
    fixPatch: fixMember.status === 'ok' ? fixMember.bytes : null,
    warnings
  };
}

/**
 * Run the front gates.
 *
 * @param {object} input
 * @param {string[]} input.cidArray
 * @param {Object<string,string>} input.extractedPaths - from fetchAndTriageArchives
 * @param {Object<string,Buffer>} input.archiveData - the fetched bytes, by CID
 * @param {Error[]} input.malformedBCIDs - deterministic archive problems found by the triage
 * @param {string} input.addendum - the request's addendum, verbatim
 * @param {object} input.config - getCodeReviewConfig()
 * @param {{ archiveService: object, validator: object, logger: object }} input.deps
 * @param {string} [input.runTag]
 * @returns {Promise<{ verdict: object } | { context: object }>} a deterministic INVALID verdict, or the run's context
 * @throws {CodeReviewRequesterError} the listing, the request or this arbiter's configuration is at fault
 */
async function runFrontGates(input) {
  const { cidArray, extractedPaths, archiveData, malformedBCIDs, addendum, config, runTag = '' } = input;
  const { archiveService, validator, logger } = input.deps;

  // 1–2
  assertOperatorReady(config);
  assertRequestLayout(cidArray);
  const [listingCid, claimCid, ...priorCids] = cidArray;
  logger.info(`${runTag} code-review listing=${listingCid} claim=${claimCid} priors=${priorCids.length}`);

  // 3
  const listing = await readListing(extractedPaths[listingCid], listingCid, { validator, config, logger, runTag });
  logger.info(`${runTag} code-review listing ${listingCid} passed (${CODE_CLASS}, ${listing.trust} trust)`);

  // 4
  const priorFindings = await readPriorFindings(priorCids, { extractedPaths, malformedBCIDs });
  // the dispute line is the disputing maker's: read and checked on its own,
  // before the claim is judged, whatever the disclosure line looks like
  const machineLines = readMachineLines(addendum);
  if (!machineLines.ok && machineLines.fault === 'requester') {
    throw requester('CODE_REVIEW_DISPUTE', `the dispute line does not parse: ${issueCodes(machineLines.issues)}`);
  }
  const dispute = machineLines.dispute
    ? await readDisputeStatement(machineLines.dispute.statementCid, archiveService)
    : null;

  // 5–7: from here on a failure is the claim's
  const claimBytes = archiveData[claimCid];
  const archiveSha256 = sha256Hex0x(claimBytes);
  logger.info(`${runTag} code-review claim ${claimCid} archiveSha256=${archiveSha256}`);
  const invalid = (failure) => {
    logger.warn(`${runTag} code-review claim ${claimCid}: gate ${failure.gate} failed (${failure.check}) → ${listing.outcomes[0]}`);
    return { verdict: buildCodeReviewInvalidVerdict(listing.outcomes, { ...failure, bcid: claimCid }) };
  };

  // 5. structure (from the triage), then members
  const malformedClaim = malformedBCIDs.find((error) => error.cid === claimCid);
  if (malformedClaim) {
    return invalid({ gate: 'claim-archive', check: malformedClaim.check, reason: malformedClaim.reason });
  }
  const members = await readClaimMembers(extractedPaths[claimCid]);
  if (members.failure) return invalid({ gate: 'claim-archive', ...members.failure });

  // 6. disclosure
  if (!machineLines.ok) {
    return invalid({
      gate: 'disclosure',
      check: machineLines.issues[0].code,
      reason: `the addendum's disclosure line does not parse strictly: ${machineLines.issues
        .map((issue) => `${issue.code}${issue.path ? ` at ${issue.path}` : ''}: ${issue.detail}`).join('; ')}`
    });
  }
  const line = machineLines.disclosure;
  const ciphertext = await archiveService.getArchive(line.ciphertextCid); // a fetch failure is transient
  const disclosure = codeReview.verifyDisclosure({
    plaintext: u8(claimBytes),
    ciphertext: u8(ciphertext),
    archiveSha256: line.archiveSha256,
    ciphertextSha256: line.ciphertextSha256,
    contentKey: line.contentKey,
    ephemeralKey: line.ephemeralKey,
    disclosureKey: listing.spec.stake.disclosureKey
  });
  if (!disclosure.ok) {
    if (disclosure.code === 'BAD_DISCLOSURE_KEY') {
      // the listing registered a key no claim can be encrypted to: the listing's fault
      throw requester('CODE_REVIEW_DISCLOSURE_KEY', 'BAD_DISCLOSURE_KEY: the listing\'s disclosureKey cannot be used');
    }
    return invalid({ gate: 'disclosure', check: disclosure.code, reason: disclosure.reason });
  }

  // 7. inScope
  const scope = codeReview.validateFinding(members.finding, listing.spec);
  if (!scope.ok) {
    return invalid({
      gate: 'inScope',
      check: scope.issues[0].code,
      reason: scope.issues.map((issue) => `${issue.code} at ${issue.path}: ${issue.detail}`).join('; ')
    });
  }
  logger.info(`${runTag} code-review claim ${claimCid}: gates disclosure and inScope passed`);

  return {
    context: {
      codeClass: CODE_CLASS,
      trust: listing.trust,
      listing,
      claim: {
        bcid: claimCid,
        archiveSha256,
        extractedPath: extractedPaths[claimCid],
        finding: members.finding,
        report: members.report,
        pocPatch: members.pocPatch,
        fixPatch: members.fixPatch
      },
      priorFindings,
      disclosure: {
        archiveSha256: line.archiveSha256,
        ciphertextSha256: line.ciphertextSha256,
        ciphertextCid: line.ciphertextCid
      },
      dispute,
      // what of the addendum a model may see: '' for every addendum the contract writes
      addendumText: machineLines.text,
      eaGates: { disclosure: 'pass', inScope: 'pass' },
      warnings: [...members.warnings, ...scope.warnings.map((warning) => warning.code)]
    }
  };
}

module.exports = {
  CODE_CLASS,
  maxCids,
  runFrontGates,
  refuseSingleCid,
  assertOperatorReady,
  assertRequestLayout
};
