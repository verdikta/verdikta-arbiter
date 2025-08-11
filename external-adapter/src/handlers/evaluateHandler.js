const path = require('path');
const fs = require('fs');
const os = require('os');
const { createClient, validateRequest, requestSchema } = require('@verdikta/common');
const aiClient = require('../services/aiClient');
const crypto = require('crypto');
const commitStore = require('../services/commitStore');
const ethers = require('ethers');
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

// Initialize verdikta-common client with configuration
const verdikta = createClient({
  ipfs: {
    pinningService: process.env.IPFS_PINNING_SERVICE || 'https://api.pinata.cloud',
    pinningKey: process.env.IPFS_PINNING_KEY,
    timeout: 30000
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

const evaluateHandler = async (request) => {
  const { id, data } = request;
  const aggId = (data.aggId || data.aggid || '').toLowerCase();
  const t0 = Date.now();   
  let   runTag;            
  let tempDir; // Declare here so we can reuse if provider error happens

  try {
    // console.log('Validating request:', request);
    await validateRequest(request);

    // console.log('Processing CID string:', data.cid);

    // Process mode if present
    let modeString;
    let cidString;
    if (data.cid.length >= 2 && data.cid.charAt(1) === ":" && data.cid.charAt(0) !== ":") {
      modeString = data.cid.substring(0, 1);
      cidString = data.cid.substring(2);
    } else {
      modeString = "0";
      cidString = data.cid;
    }
    logger.debug(`Mode: ${modeString}`);
    runTag = `[EA ${id} agg=${aggId} mode=${modeString}]`;

    // if mode 2, there is nothing to calculate--just reveal previously calculated information
    // (input in this case is 2:<hash>)
    if (modeString === '2') {
      const hashHex = cidString.toLowerCase();
      const t_mode2 = Date.now();
      const { result, justificationCid } = await handleMode2Reveal(hashHex, tempDir, runTag);
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
      logger.info(`Found addendum string: ${addendumString}`);
    }
    
    // Split multiple CIDs if present
    const cidArray = cidString.split(',').map(cid => cid.trim()).filter(cid => cid);
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
      const extractedPath = await archiveService.extractArchive(
        archiveData,
        'archive.zip',
        tempDir
      );
      logger.info(`${runTag} extractArchive took ${Date.now() - t2}ms`);
      
      const t3 = Date.now();
      await archiveService.validateManifest(extractedPath);
      logger.info(`${runTag} validateManifest took ${Date.now() - t3}ms`);
      
      const t4 = Date.now();
      const parsedManifest = await manifestParser.parse(extractedPath);
      logger.info(`${runTag} manifestParser.parse took ${Date.now() - t4}ms`);
      
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
        logger.info(`Adding addendum to query: ${parsedManifest.addendum}: ${sanitizedAddendum}`);
        queryObject.prompt += `\n\nAddendum: \n${parsedManifest.addendum}: ${sanitizedAddendum}`;
      }
      
      logger.debug(`${runTag} AI service call…`);
      const t5 = Date.now();
      const result = await aiClient.evaluate(queryObject, extractedPath, runTag);
      logger.info(`${runTag} aiClient.evaluate took ${Date.now() - t5}ms`);
      
      if (modeString === '1') {
        const hashDecimal = await handleMode1Commit(result, aggId, runTag);
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
      
      // Process all CIDs
      const t7 = Date.now();
      const extractedPaths = await archiveService.processMultipleCIDs(cidArray, tempDir);
      logger.info(`${runTag} processMultipleCIDs took ${Date.now() - t7}ms`);
      
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
      const result = await aiClient.evaluate(queryObject, extractedPaths[cidArray[0]], runTag);
      logger.info(`${runTag} aiClient.evaluate (multi-CID) took ${Date.now() - t11}ms`);
     
      if (modeString === '1') {
        const hashDecimal = await handleMode1Commit(result, aggId, runTag);
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
    logger.error(`Error processing evaluation for jobRunID ${id}:`, error);

    // If we detect the custom PROVIDER_ERROR prefix, handle that differently
    if (error.message && error.message.startsWith('PROVIDER_ERROR:')) {
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
      statusCode: 500,
      error: error.message,
      data: {
        aggregatedScore: [0],
        justification: '',
        error: error.message
      },
    };
  }
};

/**
 * Mode-1 (commit) helper
 * ----------------------
 *  • builds ABI-compatible encoding of (uint256[] scores, uint256 salt)
 *  • takes the SHA-256 hash, keeps the low 128 bits
 *  • stores { result, salt } under that 128-bit key
 *  • returns the decimal representation (what the aggregator expects)
 */
async function handleMode1Commit(result, aggId, runTag) {
  // ---------- 1. collect *unsigned* scores -----------------------------
  const scores = (result.scores || [{ score: 0 }]).map(s => BigInt(s.score));

  // ---------- 2. generate 80-bit salt, render it as *exactly* 20 hex ---
  const saltBytes = crypto.randomBytes(10);          // 10 bytes  == 80 bits
  const saltHex = saltBytes.toString('hex');         // 20 lowercase hex chars
  const saltUint = BigInt('0x' + saltHex);

  // ---------- 3. ABI-encode  (uint256[] scores, uint256 salt) ----------
  // We hand-roll the encoding because we only need a tiny subset:
  //
  //   0x00  0x00  0x00  0x40   offset pointer  (64 bytes) to the scores array
  //   0x…                                salt  (32 bytes, left-padded)
  //   0x…           scores.length (32 bytes)
  //   0x…           scores[0]     (32 bytes)
  //   0x…           scores[1]     (32 bytes)  (etc.)
  //
  function uint256ToBuf(u) {
    return Buffer.from(u.toString(16).padStart(64, '0'), 'hex');
  }

  const head = Buffer.concat([                       // static part
                  Buffer.from(''.padStart(64, '0'), 'hex'),  // offset 0x40
                  uint256ToBuf(saltUint)
                ]);
  const tail = Buffer.concat([
                  uint256ToBuf(BigInt(scores.length)),
                  ...scores.map(uint256ToBuf)
                ]);

  // fix the pointer in the head (0x40 == 64 bytes)
  head.writeBigUInt64BE(0n, 0);                     // already zero
  head[31] = 0x40;                                  // last byte -> 64

  const abiPayload = Buffer.concat([head, tail]);

  // ---------- 4. low 128 bits of SHA-256 -------------------------------
  const encodedData = ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint256[]', 'uint256'],
    [OPERATOR_ADDRESS, scores, saltUint]
  );
  const hashBytes = ethers.utils.sha256(encodedData);
  // Take the first 16 bytes - high 128 bits (32 hex chars after 0x prefix)
  const hashHex = hashBytes.substring(2, 34);

  // ---------- 5. persist & hand the decimal commitment back ------------
  logger.info(`EA commit → hash=${hashHex}`);

  await commitStore.save(hashHex, {
    result,
    salt: saltHex,                      // remember: 20 lowercase hex chars
    aggId,
    created: new Date().toISOString()
  });
  logger.info(`${runTag} COMMIT saved hash=${hashHex}`);

  return BigInt('0x' + hashHex).toString();        // decimal for likelihoods[0]
}

/**
 * Reveal previously committed result
 */
async function handleMode2Reveal(hashHex, tempDir, runTag) {
  // Accept decimal, 0x-prefixed, or bare hex
  if (/^[0-9]+$/.test(hashHex)) {                // decimal
    hashHex = BigInt(hashHex).toString(16);
  } else if (hashHex.startsWith('0x')) {         // 0x… hex
    hashHex = hashHex.slice(2);
  } else {                                        // bare hex
    hashHex = hashHex;
  }
  hashHex = hashHex.toLowerCase().padStart(32, '0'); // 128 bit, zero-padded
  logger.info(`${runTag} REVEAL lookup hash=${hashHex}`);
  const commit = await commitStore.get(hashHex);

  // if (!commit) throw new Error(`Unknown commit hash: ${hashHex}`);
  if (!commit) {
    logger.warn(`${runTag} REVEAL miss`);
    throw new Error(`Unknown commit hash: ${hashHex}`);
  } else {
    logger.info(`${runTag} REVEAL hit salt=${commit.salt}`);
  }

  // Create a temporary directory if one wasn't provided
  if (!tempDir) {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verdikta-extract-'));
  }

  try {
    // Build and publish justification *now*
    const revealUploadStart = Date.now();
    const justificationCid = await createAndUploadJustification(commit.result, tempDir);
    logger.info(`${runTag} Mode 2 reveal justification upload took ${Date.now() - revealUploadStart}ms`);
    await commitStore.del(hashHex);  // burn after reveal
    logger.debug(`COMMIT deleted hash=${hashHex}`);

    // Append salt after a colon
    const cidWithSalt = `${justificationCid}:${commit.salt}`;

    // Schedule general cleanup
    setImmediate(() => {
      commitStore.purgeStale()
        .catch(err => logger.error('purgeStale failed:', err));
    });

    return { result: commit.result, justificationCid: cidWithSalt };
  } finally {
    // Make sure we clean up the tempDir we created
    if (tempDir) {
      await archiveService.cleanup(tempDir).catch(err => 
        logger.error(`Error cleaning up temp directory: ${err.message}`)
      );
    }
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
  const justificationContent = {
    scores: result.scores || [{outcome: 'default', score: 0}],
    justification: result.justification || '',
    timestamp: new Date().toISOString()
  };

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
  logger.info(`Justification uploaded with CID: ${justificationCid}`);
  
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
