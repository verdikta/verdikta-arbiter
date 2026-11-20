const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  createClient, validateRequest, validator, DEFAULT_IPFS_GATEWAYS,
  MalformedArchiveError: LibMalformedArchiveError
} = require('@verdikta/common');
const { buildIpfsGatewayConfig } = require('../utils/ipfsGatewayConfig');
const aiClient = require('../services/aiClient');
const crypto = require('crypto');
const commitStore = require('../services/commitStore');
const ethers = require('ethers');
const { collectVersionInfo } = require('../utils/versionInfo');
const {
  assertBareCID, assertSafeManifest, extractEvidenceArchive, isUnsafeEvidenceError
} = require('../utils/evidenceBoundary');
const {
  fetchAndTriageArchives,
  buildMalformedSubmissionVerdict,
  isMalformedArchiveError
} = require('../utils/bcidValidation');
const {
  installCidFetchCache,
  cidFetchCacheOptionsFromEnv,
  runWithRequestContext,
  setRunTag
} = require('../services/cidFetchCache');
const codeReviewMode = require('../codeReview');
const { getCodeReviewConfig, devTrustActive } = require('../codeReview/config');
const { addendumForLog, redactMachineLines } = require('../codeReview/addendum');
const { describeCanaryFault } = require('../canaryFault');
// Validator is sourced from @verdikta/common; remove local validator import

const OPERATOR_ADDRESS = (() => {
  const addr = process.env.OPERATOR_ADDR;
  if (!addr) {
    throw new Error('OPERATOR_ADDR missing – set it in .env or the shell');
  }
  try {
    return ethers.utils.getAddress(addr);    // checksums & validates
  } catch (e) {
    throw new Error(`OPERATOR_ADDR is not a valid address: ${addr}`);
  }
})();

// Operator-preferred IPFS gateways (IPFS_GATEWAY, tried first) and the optional
// dedicated-gateway key (IPFS_GATEWAY_TOKEN); see utils/ipfsGatewayConfig.js.
// @verdikta/common ≤ 1.6.x ignores these keys (and exports no
// DEFAULT_IPFS_GATEWAYS), so they are forward-compatible.
const ipfsGatewayConfig = buildIpfsGatewayConfig(process.env, {
  builtInGateways: DEFAULT_IPFS_GATEWAYS
});

// Initialize verdikta-common client with configuration
const verdikta = createClient({
  ipfs: {
    pinningService: process.env.IPFS_PINNING_SERVICE || 'https://api.pinata.cloud',
    pinningKey: process.env.IPFS_PINNING_KEY,
    timeout: 30000,
    ...ipfsGatewayConfig.ipfs
  },
  logging: {
    level: process.env.LOG_LEVEL || 'warn',
    console: true,
    file: false,
    // Disable colors when output is not a TTY or when explicitly disabled
    colors: process.env.DISABLE_COLORS === 'true' ? false : process.stdout.isTTY
  }
});

const { manifestParser, archiveService, logger, ipfsClient } = verdikta;

for (const warning of ipfsGatewayConfig.warnings) {
  logger.warn(`IPFS gateway configuration: ${warning}`);
}

// One dispatcher request fans out to several of this node's jobs within
// milliseconds, and each used to download the same archive CIDs on its own.
// Downloads of a CID are shared while in flight and kept briefly for the next
// selected job (#69). Wrapping the library client covers the archive fetches
// and the manifest parser's ipfs/cid additional-file fetches alike.
const fetchCache = installCidFetchCache(ipfsClient, { ...cidFetchCacheOptionsFromEnv(process.env), logger });
logger.info(`IPFS fetch cache: ttl=${fetchCache.ttlMs}ms maxEntries=${fetchCache.maxEntries} maxBytes=${fetchCache.maxBytes}`);
const COMMIT_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const revealOperations = new Map();
const requestError = (message, statusCode) => Object.assign(new Error(message), { statusCode });

// Code-review (stake attestation) mode: off unless the operator enabled it with
// a runner; dev trust only on a test chain (codeReview/config.js).
{
  const codeReviewConfig = getCodeReviewConfig();
  if (codeReviewConfig.trust.refused) {
    logger.error(`Code review: ${codeReviewConfig.trust.refused}; code-review requests are refused`);
  } else if (devTrustActive(codeReviewConfig)) {
    logger.warn('Code review: CODE_REVIEW_TRUST=dev: attestations signed by caller-supplied dev builder keys are accepted (never on mainnet)');
  }
  logger.info(`Code review: ${codeReviewConfig.ready ? 'ready' : 'off'} (trust=${codeReviewConfig.trust.mode})`);
  const canaryFault = describeCanaryFault();
  if (canaryFault.state === 'armed') {
    logger.warn(`CANARY FAULT SWITCH ARMED for ${canaryFault.namedClaims} named claim(s): it acts only on a request for class 5555, measured on Base Sepolia. Remove the flag when the canary run ends (docs/release-runbook.md, 3b).`);
  } else if (canaryFault.state === 'refused') {
    logger.error(`Canary fault switch refused, and it acts on nothing: ${canaryFault.problems.join('; ')}`);
  }
}

/** The listing manifest of an extracted primary archive, or null when it cannot be read. */
async function readManifestJson(extractedPath) {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(extractedPath, 'manifest.json'), 'utf8'));
  } catch (_error) {
    return null;
  }
}

const evaluate = async (request) => {
  const { id } = request || {};
  const data = request?.data || {};
  const aggId = typeof data.aggId === 'string' ? data.aggId.toLowerCase() : '';
  const t0 = Date.now();   
  let   runTag;
  let tempDir; // Declare here so we can reuse if provider error happens
  let modeString = '0'; // visible to the catch: a provider error in mode 1 must not look like a commit
  let cidArray = [];    // visible to the catch: a malformed archive must not stay cached

  try {
    // console.log('Validating request:', request);
    try {
      await validateRequest(request);
    } catch (validationError) {
      // The caller gets a fixed message; the operator's log keeps the reason (it can quote
      // data.cid, whose addendum carries the stake-attestation machine lines: redacted).
      logger.warn(`Request validation failed: ${redactMachineLines(String(validationError && validationError.message))}`);
      throw requestError('Invalid evaluation request', 400);
    }

    // console.log('Processing CID string:', data.cid);

    // Process mode if present
    let cidString;
    if (data.cid.length >= 2 && data.cid.charAt(1) === ":" && data.cid.charAt(0) !== ":") {
      modeString = data.cid.substring(0, 1);
      cidString = data.cid.substring(2);
    } else {
      modeString = "0";
      cidString = data.cid;
    }
    logger.debug(`Mode: ${modeString}`);
    if (!['0', '1', '2'].includes(modeString)) throw requestError('Invalid evaluation mode', 400);
    // id is jobSpec.externalJobID in basicJobSpec: stable across commit/reveal,
    // unlike the Chainlink run ID or the per-phase on-chain request ID.
    if (modeString !== '0' && (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !/^0x[0-9a-f]{64}$/.test(aggId))) {
      throw requestError('Commit/reveal requires a job ID and bytes32 aggregation ID', 400);
    }
    const scope = { jobId: id, aggId, operator: OPERATOR_ADDRESS.toLowerCase() };
    runTag = `[EA ${id} agg=${aggId} mode=${modeString}]`;
    setRunTag(runTag); // fetch-cache log lines made by library code carry this job's tag
    if (devTrustActive(getCodeReviewConfig())) {
      logger.warn(`${runTag} CODE_REVIEW_TRUST=dev: listing attestations signed by caller-supplied dev builder keys are accepted on this arbiter`);
    }

    // if mode 2, there is nothing to calculate--just reveal previously calculated information
    // (input in this case is 2:<hash>)
    if (modeString === '2') {
      const hashHex = cidString.toLowerCase();
      const t_mode2 = Date.now();
      const { result, justificationCid } = await handleMode2Reveal(hashHex, scope, runTag);
      logger.info(`${runTag} Mode 2 reveal took ${Date.now() - t_mode2}ms`);
      logger.info(`${runTag} TOTAL execution time: ${Date.now() - t0}ms`);
      return createSuccessResponse(id, result, justificationCid);
    }

    // Process CID string with mode removed and parse addendum if present
    const firstColonIndex = cidString.indexOf(':');
    
    let addendumString = "";
    
    if (firstColonIndex !== -1) {
      addendumString = cidString.substring(firstColonIndex + 1);
      cidString = cidString.substring(0, firstColonIndex);
      // the stake-attestation machine lines carry keys: never logged (design §16)
      logger.info(`Found addendum string: ${addendumForLog(addendumString)}`);
    }
    
    // Split multiple CIDs if present
    cidArray = cidString.split(',').map(cid => cid.trim()).filter(cid => cid);
    for (const cid of cidArray) await assertBareCID(cid);
    // logger.info(`Processing ${cidArray.length} CIDs:`, cidArray);
    logger.debug(`CID list count = ${cidArray.length}`);
    
    // Create temp directory
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verdikta-extract-'));
    
    // For backward compatibility, if only one CID, process as before
    if (cidArray.length === 1) {
      logger.info('Single-CID flow start');
      
      const t1 = Date.now();
      const archiveData = await archiveService.getArchive(cidArray[0]);
      logger.info(`${runTag} IPFS getArchive took ${Date.now() - t1}ms`);
      
      const t2 = Date.now();
      const extractedPath = await extractEvidenceArchive(
        archiveService,
        archiveData,
        'archive.zip',
        tempDir
      );
      logger.info(`${runTag} extractArchive took ${Date.now() - t2}ms`);
      
      const t3 = Date.now();
      await assertSafeManifest(extractedPath);
      await archiveService.validateManifest(extractedPath);
      logger.info(`${runTag} validateManifest took ${Date.now() - t3}ms`);

      // A code-review listing needs its claim: [listing, claim, prior findings…]
      if (codeReviewMode.isCodeReviewManifest(await readManifestJson(extractedPath))) {
        codeReviewMode.refuseSingleCid(getCodeReviewConfig());
      }
      
      const t4 = Date.now();
      const parsedManifest = await manifestParser.parse(extractedPath);
      logger.info(`${runTag} manifestParser.parse took ${Date.now() - t4}ms`);
      // fail closed: a code-review listing never reaches the text-mode jury
      if (parsedManifest && parsedManifest.codeReview !== undefined) {
        codeReviewMode.refuseSingleCid(getCodeReviewConfig());
      }
      
      // Construct query object
      const queryObject = {
        prompt: parsedManifest.prompt,
        models: parsedManifest.models,
        iterations: parsedManifest.iterations,
        additional: parsedManifest.additional,
        outcomes: parsedManifest.outcomes
      };
      
      // If addendum is present and manifest has addendum field, append it
      if (addendumString && parsedManifest.addendum) {
        const sanitizedAddendum = addendumString.replace(/[<>{}]/g, '');
        logger.info(`Adding addendum to query: ${parsedManifest.addendum}: ${addendumForLog(sanitizedAddendum)}`);
        queryObject.prompt += `\n\nAddendum: \n${parsedManifest.addendum}: ${sanitizedAddendum}`;
      }
      
      logger.debug(`${runTag} AI service call…`);
      const t5 = Date.now();
      const result = await aiClient.evaluate(queryObject, extractedPath, runTag);
      logger.info(`${runTag} aiClient.evaluate took ${Date.now() - t5}ms`);
      
      if (modeString === '1') {
        const hashDecimal = await handleMode1Commit(result, scope, runTag);
        await archiveService.cleanup(tempDir);
        logger.info(`${runTag} TOTAL execution time: ${Date.now() - t0}ms`);
        logger.info(`${runTag} RETURN commit (empty CID)`);
        return {
          jobRunID: id,
          status: 'success',
          statusCode: 200,
          data: {                     // Vector contains only the commitment
            aggregatedScore: [hashDecimal],
            justificationCid: ''      // posted later in Mode 2
          }
        };
      }
 
      // MODE 0 (standard flow) 
      const t6 = Date.now();
      const justificationCid = await createAndUploadJustification(result, tempDir);
      logger.info(`${runTag} createAndUploadJustification took ${Date.now() - t6}ms`);
      await archiveService.cleanup(tempDir);
      logger.info(`${runTag} TOTAL execution time: ${Date.now() - t0}ms`);
      return createSuccessResponse(id, result, justificationCid);
    } 
    // Multi-CID processing
    else {
      logger.info(`Multi-CID (${cidArray.length}) start`);

      // Fetch + extract all archives and triage the bCID (submitted-work) ones.
      // IPFS/extraction failures and anything wrong with the PRIMARY archive throw
      // here and stay on the errored path below; only a deterministically malformed
      // bCID archive is collected, because that is the one case every arbiter can
      // settle identically without an AI call (see utils/bcidValidation.js).
      const t7 = Date.now();
      let stoppedWaiting = false;
      const triage = fetchAndTriageArchives(
        cidArray, tempDir, {
          archiveService, validator, logger, runTag,
          // a code-review request on an arbiter that does not serve one, or with a
          // bad layout, is refused before any claim archive is extracted
          checkPrimary: (manifest) => {
            if (codeReviewMode.isCodeReviewManifest(manifest)) {
              codeReviewMode.assertCodeReviewRequest(getCodeReviewConfig(), cidArray);
            }
          },
          shouldStop: () => stoppedWaiting
        }
      );
      const { extractedPaths, malformedBCIDs, archiveData, primaryManifestJson } =
        await codeReviewMode.boundFetches(getCodeReviewConfig(), t0, triage, () => {
          stoppedWaiting = true;
          // An extraction already under way may still write into tempDir after this
          // job answers: remove it again once the triage settles, without waiting for that.
          const sweep = () => archiveService.cleanup(tempDir).catch((cleanupError) => {
            logger.error(`${runTag} Error cleaning up temporary directory: ${cleanupError.message}`);
          });
          triage.then(sweep, sweep);
        });
      logger.info(`${runTag} fetchAndTriageArchives took ${Date.now() - t7}ms`);
      // Malformed archives are never kept: jobs fetching at the same moment shared
      // the bytes (and reach the same verdict), but no later job reuses them.
      for (const malformed of malformedBCIDs) fetchCache.forget(malformed.cid);

      let result;
      if (codeReviewMode.isCodeReviewManifest(primaryManifestJson)) {
        // Stake-attestation claim (cids = [listing, claim, prior findings…]): the
        // code-review front gates settle requester errors (thrown: errored, no
        // commit) and claim gate failures (a deterministic INVALID verdict) before
        // any runner or model call; a claim that passes goes to the run: the runner's
        // gates, then the jury (A4b). Whatever it returns is a commitable vector or a throw.
        const t8 = Date.now();
        result = await codeReviewMode.evaluateCodeReview({
          cidArray,
          extractedPaths,
          archiveData,
          malformedBCIDs,
          addendum: addendumString,
          config: getCodeReviewConfig(),
          deps: { archiveService, validator, logger },
          runTag,
          receivedAt: t0, // the deadline runs from receipt: the fetches above count (design §11)
          canaryRequest: { aggId, jobId: id } // what the fault switch measures this request by; it reads nothing else of it
        });
        logger.info(`${runTag} code-review evaluation took ${Date.now() - t8}ms`);
      } else if (malformedBCIDs.length > 0) {
        // The requester's package must itself be sound (it supplies the outcomes),
        // and the request must be consistent with it; both failures are the
        // requester's, not the submitter's, so they keep the errored path.
        const t8 = Date.now();
        const primaryManifest = await manifestParser.parse(extractedPaths[cidArray[0]]);
        await validator.validateMultiCIDLogic(primaryManifest, cidArray);
        logger.info(`${runTag} primary manifest parse (malformed-bCID path) took ${Date.now() - t8}ms`);

        result = buildMalformedSubmissionVerdict(primaryManifest, malformedBCIDs);
        logger.warn(`${runTag} Malformed bCID archive(s) ` +
          `${malformedBCIDs.map(e => `${e.cid}:${e.check}`).join(', ')} → deterministic verdict ` +
          `"${result.scores[0].outcome}" (no AI evaluation)`);
      } else {
        // Validate all manifests
        const t8 = Date.now();
        for (const cid of cidArray) {
          await archiveService.validateManifest(extractedPaths[cid]);
        }
        logger.info(`${runTag} validateManifest (all) took ${Date.now() - t8}ms`);

        // Parse all manifests
        const t9 = Date.now();
        const { primaryManifest, bCIDManifests } =
          await manifestParser.parseMultipleManifests(extractedPaths, cidArray);
        logger.info(`${runTag} parseMultipleManifests took ${Date.now() - t9}ms`);

        logger.info(`Parsed primary manifest and ${bCIDManifests.length} bCID manifests`);

        // Construct combined query
        const t10 = Date.now();
        let combinedQueryData = await manifestParser.constructCombinedQuery(
          primaryManifest,
          bCIDManifests,
          addendumString
        );
        logger.info(`${runTag} constructCombinedQuery took ${Date.now() - t10}ms`);

        // Fallback implementation if constructCombinedQuery returns invalid result
        if (!combinedQueryData || !combinedQueryData.prompt) {
          logger.warn('constructCombinedQuery returned invalid result, using fallback implementation');

          // Build combined query manually
          let combinedPrompt = primaryManifest.prompt || primaryManifest.query || '';
          let combinedReferences = primaryManifest.references || [];

          // Add bCID content
          for (const bCIDItem of bCIDManifests) {
            if (bCIDItem && bCIDItem.manifest) {
              const manifest = bCIDItem.manifest;
              if (manifest.prompt || manifest.query) {
                combinedPrompt += '\n\n' + (manifest.prompt || manifest.query);
              }
              if (manifest.references && Array.isArray(manifest.references)) {
                combinedReferences = [...combinedReferences, ...manifest.references];
              }
            }
          }

          // Add addendum if present
          if (addendumString && primaryManifest.addendum) {
            const sanitizedAddendum = addendumString.replace(/[<>{}]/g, '');
            combinedPrompt += `\n\nAddendum: \n${primaryManifest.addendum}: ${sanitizedAddendum}`;
          }

          combinedQueryData = {
            prompt: combinedPrompt,
            references: combinedReferences,
            outcomes: primaryManifest.outcomes || ['outcome1', 'outcome2'],
            models: primaryManifest.models || [],
            iterations: primaryManifest.iterations || 1
          };

          logger.info('Created fallback combined query with length:', combinedQueryData.prompt.length);
        }

        logger.info('Constructed combined query with length: ' + combinedQueryData.prompt.length);

        // Collect all attachments
        let allAttachments = primaryManifest.additional || [];
        for (const bCIDItem of bCIDManifests) {
          if (bCIDItem && bCIDItem.manifest && bCIDItem.manifest.additional && bCIDItem.manifest.additional.length > 0) {
            logger.info(`Adding ${bCIDItem.manifest.additional.length} attachments from ${bCIDItem.manifest.name || 'unnamed manifest'}`);
            allAttachments = [...allAttachments, ...bCIDItem.manifest.additional];
          }
        }

        // Create final query object
        const queryObject = {
          prompt: combinedQueryData.prompt,
          models: primaryManifest.models,
          iterations: primaryManifest.iterations,
          additional: allAttachments,
          outcomes: primaryManifest.outcomes
        };

        logger.info(`${runTag} Evaluating combined query with AI service...`);
        const t11 = Date.now();
        result = await aiClient.evaluate(queryObject, extractedPaths[cidArray[0]], runTag,
          Object.values(extractedPaths));
        logger.info(`${runTag} aiClient.evaluate (multi-CID) took ${Date.now() - t11}ms`);
      }

      if (modeString === '1') {
        const hashDecimal = await handleMode1Commit(result, scope, runTag);
        await archiveService.cleanup(tempDir);
        logger.info(`${runTag} TOTAL execution time: ${Date.now() - t0}ms`);
        logger.info(`${runTag} RETURN commit (empty CID)`);
        return {
          jobRunID: id,
          status: 'success',
          statusCode: 200,
          data: {                     // Vector contains only the commitment
            aggregatedScore: [hashDecimal],
            justificationCid: ''      // posted later in Mode 2
          }
        };
      }

      // MODE 0 (standard flow)
      const t12 = Date.now();
      const justificationCid = await createAndUploadJustification(result, tempDir);
      logger.info(`${runTag} createAndUploadJustification (multi-CID) took ${Date.now() - t12}ms`);
      await archiveService.cleanup(tempDir);
      logger.info(`${runTag} TOTAL execution time: ${Date.now() - t0}ms`);
      return createSuccessResponse(id, result, justificationCid);
    }
  } catch (error) {
    // an error can quote the request's addendum, whose machine lines carry keys
    const errorMessage = redactMachineLines(error.message);
    logger.error(`Error processing evaluation for jobRunID ${id}:`, {
      message: errorMessage,
      stack: redactMachineLines(error.stack),
      name: error.name,
      code: error.code
    });

    // A malformed archive on the errored path (the primary, or one the library's
    // parser rejected) must not be served from cache to the next job either.
    if (isUnsafeEvidenceError(error) || isMalformedArchiveError(error) ||
        (typeof LibMalformedArchiveError === 'function' && error instanceof LibMalformedArchiveError)) {
      for (const cid of cidArray) fetchCache.forget(cid);
    }

    // If we detect the custom PROVIDER_ERROR prefix, handle that differently.
    // Mode 0 keeps its historical contract (200 + [0] + an error justification).
    // In mode 1 the aggregator reads aggregatedScore[0] as a COMMITMENT HASH, so a
    // [0] would be accepted as a commit that can never be revealed (mode 2 has no
    // stored result for hash 0). A provider outage is transient, so it must look
    // like every other transient failure: errored, no commit, retry-able.
    if (error.message && error.message.startsWith('PROVIDER_ERROR:') && modeString !== '1') {
      const providerMessage = error.message.replace('PROVIDER_ERROR:', '').trim();
      const justificationCid = await handleProviderError(providerMessage, tempDir);
      
      logger.info(`${runTag} RETURN provider-error cid=${justificationCid}`);
      return {
        jobRunID: id,
        statusCode: 200,
        data: {
          aggregatedScore: [0],
          justification: '',
          error: providerMessage,
          justificationCid
        }
      };
    }

    // If it's some other error, clean up and return 500
    if (tempDir) {
      logger.info('Cleaning up temporary directory after error...');
      await archiveService.cleanup(tempDir);
    }

    // Return aggregatedScore with [0] instead of null
    return {
      jobRunID: id,
      status: 'errored',
      statusCode: error.statusCode || 500,
      error: errorMessage,
      data: {
        aggregatedScore: [0],
        justification: '',
        error: errorMessage
      },
    };
  }
};

/**
 * Entry point. Runs the evaluation inside a request context so that fetches
 * made by library code (which never sees the job) are logged with this job's
 * run tag. The fetch cache is exposed for /version and tests.
 */
const evaluateHandler = (request) =>
  runWithRequestContext({ runTag: `[EA ${request && request.id}]` }, () => evaluate(request));
evaluateHandler.fetchCache = fetchCache;
evaluateHandler.logger = logger;

/**
 * Mode-1 (commit) helper
 * ----------------------
 * The aggregator (v2) checks a reveal against
 *   keccak256(abi.encode(bytes32 aggId, address operator, uint256[] scores, uint256 salt))
 * in full (all 32 bytes), with a 128-bit salt. The node picks its own salt, so only the hash
 * keeps it from opening one commit two ways; binding the round (aggId) and keeping every bit
 * put a reusable collision out of reach. Stores the result, salt, caller scope and expiry under
 * the 64-hex hash and returns the hash in decimal (what the aggregator reads from scores[0]).
 */
async function handleMode1Commit(result, scope, runTag) {
  const scores = (result.scores || [{ score: 0 }]).map(s => BigInt(s.score));
  const saltHex = crypto.randomBytes(16).toString('hex');   // 128 bits, exactly 32 lowercase hex
  const hashHex = commitmentHash(scope.aggId, OPERATOR_ADDRESS, scores, BigInt('0x' + saltHex));

  logger.info(`EA commit → hash=${hashHex}`);
  await commitStore.save(hashHex, {
    result,
    salt: saltHex,
    aggId: scope.aggId,
    scope,
    expiresAt: Date.now() + COMMIT_TTL_MS,
    created: new Date().toISOString()
  });
  logger.info(`${runTag} COMMIT saved hash=${hashHex}`);

  return BigInt('0x' + hashHex).toString();        // decimal for likelihoods[0]
}

/** The v2 commitment: 64 lowercase hex chars, no prefix. */
function commitmentHash(aggId, operator, scores, salt) {
  const encoded = ethers.utils.defaultAbiCoder.encode(
    ['bytes32', 'address', 'uint256[]', 'uint256'],
    [aggId, operator, scores, salt]
  );
  return ethers.utils.keccak256(encoded).slice(2);
}

/**
 * Reveal previously committed result
 */
async function handleMode2Reveal(value, scope, runTag) {
  let hash;
  if (/^[0-9]{1,78}$/.test(value)) hash = BigInt(value);
  else if (/^(?:0x)?[0-9a-f]{1,64}$/.test(value)) hash = BigInt(`0x${value.replace(/^0x/, '')}`);
  else throw requestError('Invalid commitment hash', 400);
  if (hash >= (1n << 256n)) throw requestError('Invalid commitment hash', 400);
  const candidates = new Set([hash.toString(16).padStart(64, '0')]);
  // The dispatcher sends exactly 64 bare hex digits, which can occasionally
  // contain only 0–9. Also support decimal commitments returned by mode 1.
  // Resolve that ambiguity only against this caller's stored scope.
  if (/^[0-9]{64}$/.test(value)) candidates.add(value);
  const matches = [];
  for (const candidate of candidates) {
    const entry = await commitStore.get(candidate);
    if (entry?.scope && Number.isFinite(entry.expiresAt) && Date.now() < entry.expiresAt &&
        entry.scope.jobId === scope.jobId && entry.scope.aggId === scope.aggId &&
        entry.scope.operator === scope.operator) matches.push([candidate, entry]);
  }
  // Check every caller, including callers joining an in-flight upload. The
  // commitment hash and aggId are public protocol data, not credentials.
  if (matches.length !== 1) {
    throw requestError('Reveal not authorized for this request', 403);
  }
  const [hashHex, commit] = matches[0];
  const response = entry => ({ result: entry.result, justificationCid: `${entry.justificationCid}:${entry.salt}` });
  if (commit.justificationCid) return response(commit);
  if (revealOperations.has(hashHex)) return revealOperations.get(hashHex);

  const operation = (async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verdikta-extract-'));
    try {
      const justificationCid = await createAndUploadJustification(commit.result, tempDir);
      const revealed = { ...commit, justificationCid };
      // Keep the exact artifact/salt for lost responses, transaction retries,
      // and concurrent reveals. Expiry, not serving a response, retires state.
      await commitStore.save(hashHex, revealed);
      logger.info(`${runTag} REVEAL prepared hash=${hashHex}`);
      return response(revealed);
    } finally {
      await archiveService.cleanup(tempDir).catch(() => logger.error('Reveal temporary-directory cleanup failed'));
    }
  })();
  revealOperations.set(hashHex, operation);
  try {
    return await operation;
  } finally {
    revealOperations.delete(hashHex);
  }
}

/**
 * Creates and uploads a justification file to IPFS
 * @param {Object} result - The AI evaluation result
 * @param {string} tempDir - Temporary directory path
 * @returns {string} The CID of the uploaded justification
 */
async function createAndUploadJustification(result, tempDir) {
  logger.info('Creating justification archive...');
  
  // Build justification content with backward compatibility
  const justificationContent = {
    scores: result.scores || [{outcome: 'default', score: 0}],
    justification: result.justification || '',
    timestamp: new Date().toISOString(),
    // Self-reported arbiter version: responses are the only remote observation
    // channel for deployed arbiters, so each justification identifies the
    // software that produced it (consumers ignore unknown fields).
    arbiter: collectVersionInfo()
  };
  
  // Include enhanced error reporting fields if present (backward compatible)
  if (result.metadata) {
    justificationContent.metadata = result.metadata;
  }
  
  if (result.model_results && result.model_results.length > 0) {
    justificationContent.model_results = result.model_results;
  }
  
  if (result.warnings && result.warnings.length > 0) {
    justificationContent.warnings = result.warnings;
  }
  
  // Include error field if present (for catastrophic failures)
  if (result.error) {
    justificationContent.error = result.error;
  }

  // Create temporary file for justification
  const justificationPath = path.join(tempDir, 'justification.json');
  await fs.promises.writeFile(
    justificationPath, 
    JSON.stringify(justificationContent, null, 2)
  );

  // Upload justification to IPFS
  logger.info('Uploading justification to IPFS...');
  const ipfsUploadStart = Date.now();
  const justificationCid = await ipfsClient.uploadToIPFS(justificationPath);
  logger.info(`IPFS justification upload took ${Date.now() - ipfsUploadStart}ms`);
  
  // Log summary of what was uploaded
  const uploadSummary = {
    cid: justificationCid,
    hasMetadata: !!result.metadata,
    hasModelResults: !!(result.model_results && result.model_results.length > 0),
    hasWarnings: !!(result.warnings && result.warnings.length > 0),
    hasError: !!result.error
  };
  logger.info(`Justification uploaded:`, uploadSummary);
  
  return justificationCid;
}

/**
 * Handles a provider error by creating an error justification
 * @param {string} providerMessage - The error message
 * @param {string} tempDir - Temporary directory path
 * @returns {string|null} The CID of the uploaded error justification or null
 */
async function handleProviderError(providerMessage, tempDir) {
  let justificationCid = null;
  if (tempDir) {
    try {
      const justificationPath = path.join(tempDir, 'justification.json');
      const justificationContent = {
        scores: [{outcome: 'error', score: 0}],
        justification: '',
        error: providerMessage,
        timestamp: new Date().toISOString()
      };
      await fs.promises.writeFile(
        justificationPath,
        JSON.stringify(justificationContent, null, 2)
      );

      const ipfsErrorUploadStart = Date.now();
      justificationCid = await ipfsClient.uploadToIPFS(justificationPath);
      logger.info(`IPFS error justification upload took ${Date.now() - ipfsErrorUploadStart}ms`);
      logger.info(`Error justification uploaded with CID: ${justificationCid}`);

      // Clean up after uploading error justification
      logger.info('Cleaning up temporary directory after provider error...');
      await archiveService.cleanup(tempDir);
    } catch (uploadError) {
      logger.error('Failed to upload provider-error justification to IPFS:', uploadError);
      // Still try to clean up
      await archiveService.cleanup(tempDir);
    }
  }
  
  return justificationCid;
}

/**
 * Creates a success response object
 * @param {string} id - The job run ID
 * @param {Object} result - The AI evaluation result
 * @param {string} justificationCid - The CID of the uploaded justification
 * @returns {Object} The success response object
 */
function createSuccessResponse(id, result, justificationCid) {
  logger.info(`RETURN`, {
    aggScore: (result.scores || []).map(s => s.score),
    cid: justificationCid
  });
  return {
    jobRunID: id,
    statusCode: 200,
    status: 'success',
    data: { 
      aggregatedScore: (result.scores || [{score: 0}]).map(s => s.score),
      justificationCid
    },
  };
}

module.exports = evaluateHandler;
module.exports.commitmentHash = commitmentHash;
