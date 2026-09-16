/**
 * @fileoverview Pre-validation of submitted-work (bCID) archives.
 *
 * In a multi-CID evaluation the first CID is the requester's package (for a
 * bounty: the creator's evaluation package) and every further CID is a bCID
 * archive supplied by another party (for a bounty: the hunter's submitted
 * work). `@verdikta/common`'s `manifestParser.parseMultipleManifests` runs the
 * full `parse()` on every archive and throws a plain `Error` when a bCID
 * archive is malformed — e.g. `primary.filename` pointing at a markdown file.
 * The adapter used to turn that into an errored job run, so no arbiter ever
 * committed and the aggregator round could only time out (Base mainnet bounty
 * 59 / submission 0, 2026-09-15: 0 of 6 commits).
 *
 * A malformed bCID archive is a property of the CONTENT: every honest arbiter
 * sees the same bytes and reaches the same conclusion. That makes it safe to
 * settle the round with a deterministic verdict instead of aborting. A
 * transient failure (IPFS gateway timeout/429, AI provider outage, disk, RPC)
 * is NOT a property of the content and must never become a verdict against an
 * innocent party — those keep the errored (non-committing) path.
 *
 * This module draws that line. It only ever raises `MalformedArchiveError` for
 * checks that are pure functions of the archive bytes (plus the primary
 * manifest's bCID names). Anything else propagates as-is and stays transient.
 *
 * The checks deliberately reuse `@verdikta/common`'s own validator so that a
 * bCID archive this module accepts is one `parse()` will accept too, and one it
 * rejects is one `parse()` would have thrown on.
 */

const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');

const FULL_SCORE = 1000000; // scores are micro-probabilities summing to 1,000,000

/** Stable identifiers for the check that failed (surface in the justification). */
const CHECKS = Object.freeze({
  NOT_A_ZIP: 'archive-not-a-zip',
  MANIFEST_MISSING: 'manifest-missing',
  MANIFEST_NOT_JSON: 'manifest-not-json',
  PRIMARY_MISSING: 'manifest-primary-missing',
  MANIFEST_SCHEMA: 'manifest-schema',
  PRIMARY_FILE_MISSING: 'primary-file-missing',
  PRIMARY_NOT_JSON: 'primary-not-json',
  PRIMARY_SCHEMA: 'primary-schema',
  NAME_MISMATCH: 'bcid-name-mismatch'
});

/** The shape the bounty API builds and every arbiter accepts. */
const CONFORMING_MANIFEST_EXAMPLE = {
  version: '1.0',
  name: '<bCID name from the primary manifest, e.g. submittedWork>',
  primary: { filename: 'primary_query.json' },
  additional: [
    {
      name: 'content',
      type: 'utf8/file',
      filename: 'submission.md',
      description: 'The submitted work product'
    }
  ]
};

/**
 * Raised when an archive is malformed in a way every arbiter will see
 * identically. `archiveRole` is 'bCID' for submitted-work archives; the
 * primary (requester) archive is never classified here, so today it is always
 * 'bCID', but the field exists so callers never have to guess.
 */
class MalformedArchiveError extends Error {
  constructor({ cid, archiveRole = 'bCID', expectedName, check, reason, manifest = null }) {
    super(`Malformed ${archiveRole} archive ${cid} (${check}): ${reason}`);
    this.name = 'MalformedArchiveError';
    this.archiveRole = archiveRole;
    this.cid = cid;
    this.expectedName = expectedName;
    this.check = check;
    this.reason = reason;
    this.manifest = manifest; // parsed manifest.json when one could be read, else null
  }
}

function isMalformedArchiveError(error) {
  return error instanceof MalformedArchiveError || Boolean(error && error.name === 'MalformedArchiveError');
}

/**
 * 'deterministic' when the failure is a property of the archive content that
 * every arbiter will reproduce; 'transient' for everything else (IPFS, AI
 * provider, disk, RPC, unknown). Only MalformedArchiveError is deterministic:
 * the default is transient because a wrong "deterministic" turns a flaky
 * gateway into a verdict against an innocent party, while a wrong "transient"
 * merely keeps today's behaviour.
 */
function classifyEvaluationError(error) {
  return isMalformedArchiveError(error) ? 'deterministic' : 'transient';
}

/**
 * Check that a fetched archive is a readable ZIP before anything touches the
 * disk. `unzipper.Open.buffer` only parses the central directory in memory, so
 * a failure here cannot be a disk or network problem. (Bounty 57's "archive"
 * was the markdown itself, pinned under the CID: 2302 bytes, no ZIP structure.)
 *
 * @throws {MalformedArchiveError}
 */
async function assertArchiveIsZip(archiveData, { cid, expectedName }) {
  try {
    await unzipper.Open.buffer(archiveData);
  } catch (err) {
    throw new MalformedArchiveError({
      cid,
      expectedName,
      check: CHECKS.NOT_A_ZIP,
      reason: `the content behind the CID is not a ZIP archive (${archiveData.length} bytes, ` +
              `unzip: ${err && err.message ? err.message : 'unreadable'})`
    });
  }
}

/**
 * `@verdikta/common`'s validator reports every content problem as a plain Error
 * with one of these message prefixes (validator.js: validateManifest,
 * validatePrimaryFile, validateCompleteWorkflow). Anything else coming out of
 * it — a TypeError from a bug, an I/O error — is not a verdict about the
 * archive and must propagate as transient.
 */
const VALIDATOR_REJECTION = /^(Invalid manifest:|Invalid JSON in primary file:|Invalid primary file content:|Primary file outcomes count)/;
function isValidatorRejection(err) {
  return err instanceof Error && VALIDATOR_REJECTION.test(err.message);
}

function readIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8'); // I/O errors other than ENOENT propagate (transient)
}

/**
 * Validate an EXTRACTED bCID archive the same way `manifestParser.parse` will,
 * but report a typed, deterministic error instead of a plain Error.
 *
 * @param {string} extractedPath - directory the archive was extracted to
 * @param {object} opts
 * @param {string} opts.cid
 * @param {string|undefined} opts.expectedName - the bCID name the primary manifest declares for this slot
 * @param {object} opts.validator - `@verdikta/common`'s validator (injected so the check and the parser agree)
 * @returns {Promise<{manifest: object}>}
 * @throws {MalformedArchiveError}
 */
async function validateBCIDArchive(extractedPath, { cid, expectedName, validator }) {
  const fail = (check, reason, manifest = null) =>
    new MalformedArchiveError({ cid, expectedName, check, reason, manifest });

  // 1. manifest.json must exist and be JSON
  const manifestText = readIfExists(path.join(extractedPath, 'manifest.json'));
  if (manifestText === null) {
    throw fail(CHECKS.MANIFEST_MISSING, 'the archive contains no manifest.json');
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (err) {
    throw fail(CHECKS.MANIFEST_NOT_JSON, `manifest.json is not valid JSON: ${err.message}`);
  }

  // 2. It must declare a primary file (bounty 58 declared `files: [...]` instead)
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      !manifest.primary || typeof manifest.primary !== 'object') {
    throw fail(
      CHECKS.PRIMARY_MISSING,
      'manifest.json has no "primary" object; it must be {"primary": {"filename": "primary_query.json"}}',
      manifest
    );
  }

  // 3. Schema + file references, using the library's own validator so we agree with parse()
  if (typeof manifest.primary.filename === 'string' &&
      !fs.existsSync(path.join(extractedPath, manifest.primary.filename))) {
    throw fail(
      CHECKS.PRIMARY_FILE_MISSING,
      `primary.filename "${manifest.primary.filename}" is not in the archive`,
      manifest
    );
  }
  try {
    await validator.validateManifest(manifest, { extractedPath });
  } catch (err) {
    if (!isValidatorRejection(err)) throw err;
    throw fail(CHECKS.MANIFEST_SCHEMA, err.message, manifest);
  }

  // 4. The bCID name must match the slot the primary manifest reserved for it
  if (expectedName && manifest.name && manifest.name !== expectedName) {
    throw fail(
      CHECKS.NAME_MISMATCH,
      `manifest "name" is "${manifest.name}" but the primary manifest expects "${expectedName}"`,
      manifest
    );
  }

  // 5. The primary file must be a JSON object with a query (bounty 59 pointed it at markdown).
  //    A hash-referenced primary lives on IPFS; fetching it is the parser's job and a fetch
  //    failure is transient, so there is nothing deterministic left to check locally.
  if (typeof manifest.primary.filename === 'string') {
    const primaryText = fs.readFileSync(path.join(extractedPath, manifest.primary.filename), 'utf8');
    try {
      JSON.parse(primaryText);
    } catch (err) {
      throw fail(
        CHECKS.PRIMARY_NOT_JSON,
        `primary file "${manifest.primary.filename}" is not valid JSON: ${err.message}`,
        manifest
      );
    }
    try {
      // validates {query: string, references?, outcomes?} and the NUMBER_OF_OUTCOMES cross-check
      await validator.validateCompleteWorkflow(manifest, primaryText);
    } catch (err) {
      if (!isValidatorRejection(err)) throw err;
      throw fail(CHECKS.PRIMARY_SCHEMA, err.message, manifest);
    }
  }

  return { manifest };
}

/**
 * Fetch every archive of a multi-CID request, extract them, and triage the
 * bCID archives.
 *
 * Stage by stage:
 *  - fetch (IPFS): any failure propagates untouched — transient.
 *  - primary archive: extracted and manifest-checked with the library; any
 *    failure propagates untouched — the requester's package is never turned
 *    into a verdict (see PR discussion: the requester chose the outcomes and
 *    wrote the question, so "their archive is broken" has no honest default).
 *  - each bCID archive: in-memory ZIP check, extraction, then
 *    `validateBCIDArchive`. Deterministic problems are COLLECTED (so the
 *    justification can name every broken archive); transient ones propagate.
 *
 * @returns {Promise<{extractedPaths: Object<string,string>, malformedBCIDs: MalformedArchiveError[]}>}
 */
async function fetchAndTriageArchives(cidArray, tempDir, { archiveService, validator, logger, runTag = '' }) {
  // --- fetch everything first: a gateway failure must surface before any verdict logic runs
  const archiveData = {};
  for (let i = 0; i < cidArray.length; i++) {
    const cid = cidArray[i];
    logger.info(`${runTag} Fetching archive ${i + 1}/${cidArray.length}: ${cid}`);
    archiveData[cid] = await archiveService.getArchive(cid);
  }

  const extractedPaths = {};
  const extractOne = async (cid, index) => {
    const subDir = path.join(tempDir, `archive_${index}_${cid.substring(0, 10)}`);
    await fs.promises.mkdir(subDir, { recursive: true });
    return archiveService.extractArchive(archiveData[cid], `archive_${cid}.zip`, subDir);
  };

  // --- primary (requester) archive: library checks only, failures stay on the error path
  const primaryCid = cidArray[0];
  extractedPaths[primaryCid] = await extractOne(primaryCid, 0);
  await archiveService.validateManifest(extractedPaths[primaryCid]);
  const primaryManifestJson = JSON.parse(
    await fs.promises.readFile(path.join(extractedPaths[primaryCid], 'manifest.json'), 'utf8')
  );
  const bCIDNames = Object.keys(primaryManifestJson.bCIDs || {});

  // --- bCID archives
  const malformedBCIDs = [];
  for (let i = 1; i < cidArray.length; i++) {
    const cid = cidArray[i];
    const expectedName = bCIDNames[i - 1];
    try {
      await assertArchiveIsZip(archiveData[cid], { cid, expectedName });
      extractedPaths[cid] = await extractOne(cid, i);
      await validateBCIDArchive(extractedPaths[cid], { cid, expectedName, validator });
    } catch (err) {
      if (!isMalformedArchiveError(err)) throw err; // transient: keep today's behaviour
      logger.warn(`${runTag} bCID archive ${cid} is malformed (${err.check}): ${err.reason}`);
      malformedBCIDs.push(err);
    }
  }

  return { extractedPaths, malformedBCIDs };
}

function truncate(text, max = 1500) {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;
}

/**
 * Build the deterministic verdict for a request whose bCID archive(s) are
 * malformed. Same shape as `aiClient.evaluate` returns, so the normal
 * commit / reveal / upload tail of the handler needs no special case.
 *
 * The whole score goes to the FIRST outcome of the requester's primary
 * manifest (for bounties that is DONT_FUND; it is derived, never hard-coded).
 * Every arbiter running this code produces the identical vector, which is what
 * the aggregator's commit-reveal clustering needs to converge.
 */
function buildMalformedSubmissionVerdict(primaryManifest, malformedBCIDs) {
  const outcomes = Array.isArray(primaryManifest.outcomes) && primaryManifest.outcomes.length > 0
    ? primaryManifest.outcomes
    : ['outcome1', 'outcome2'];
  const scores = outcomes.map((outcome, index) => ({ outcome, score: index === 0 ? FULL_SCORE : 0 }));

  const details = malformedBCIDs.map((err) => {
    const lines = [
      `- Archive "${err.expectedName || 'bCID'}" (CID ${err.cid})`,
      `  Failed check: ${err.check}`,
      `  Reason: ${err.reason}`
    ];
    if (err.manifest) {
      lines.push(`  manifest.json found: ${truncate(JSON.stringify(err.manifest))}`);
    }
    return lines.join('\n');
  }).join('\n');

  const justification = [
    `Verdict: ${outcomes[0]} (deterministic, not an AI judgement).`,
    '',
    'The submitted-work archive could not be evaluated because it is malformed. ' +
    'Every arbiter applies the same structural checks before any AI model sees the ' +
    `content, so the round settles on the first outcome ("${outcomes[0]}") instead of stalling.`,
    '',
    'What was wrong:',
    details,
    '',
    'What a submitted-work archive must look like: a ZIP containing manifest.json of the form',
    JSON.stringify(CONFORMING_MANIFEST_EXAMPLE),
    'where primary_query.json is a JSON object with a "query" string (the work summary or the ' +
    'work itself) and the work product is attached under "additional". The "name" must equal ' +
    'the bCID name the evaluation package declares. See ' +
    'external-adapter/doc/MANIFEST_SPECIFICATION.md, section "Submitted-work (bCID) archives". ' +
    'Resubmitting a conforming archive will be evaluated by the AI panel.'
  ].join('\n');

  return {
    scores,
    justification,
    metadata: {
      verdict_source: 'malformed-bcid-archive',
      malformed_archives: malformedBCIDs.map((err) => ({
        cid: err.cid,
        expectedName: err.expectedName,
        check: err.check,
        reason: err.reason
      }))
    }
  };
}

module.exports = {
  CHECKS,
  CONFORMING_MANIFEST_EXAMPLE,
  FULL_SCORE,
  MalformedArchiveError,
  isMalformedArchiveError,
  classifyEvaluationError,
  assertArchiveIsZip,
  validateBCIDArchive,
  fetchAndTriageArchives,
  buildMalformedSubmissionVerdict
};
