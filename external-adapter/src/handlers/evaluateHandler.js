const path = require('path');
const fs = require('fs');
const os = require('os');
const archiveService = require('../services/archiveService');
const aiClient = require('../services/aiClient');
const { validateRequest, requestSchema } = require('../utils/validator');
const ipfsClient = require('../services/ipfsClient');
const manifestParser = require('../utils/manifestParser');
const logger = require('../utils/logger');
const crypto = require('crypto');
const commitStore = require('../services/commitStore');
const ethers = require('ethers');

const evaluateHandler = async (request) => {
  const { id, data } = request;
  let tempDir; // Declare here so we can reuse if provider error happens

  try {
    console.log('Validating request:', request);
    await validateRequest(request);

    console.log('Processing CID string:', data.cid);

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
    console.log('Mode:', modeString);

    // if mode 2, there is nothing to calculate--just reveal previously calculated information
    // (input in this case is 2:<hash>)
    if (modeString === '2') {
      const hashHex = cidString.toLowerCase();
      const { result, justificationCID } = await handleMode2Reveal(hashHex, tempDir);
      return createSuccessResponse(id, result, justificationCID);
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
    logger.info(`Processing ${cidArray.length} CIDs:`, cidArray);
    
    // Create temp directory
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verdikta-extract-'));
    
    // For backward compatibility, if only one CID, process as before
    if (cidArray.length === 1) {
      logger.info('Processing single CID using standard flow');
      const archiveData = await archiveService.getArchive(cidArray[0]);
      const extractedPath = await archiveService.extractArchive(
        archiveData,
        'archive.zip',
        tempDir
      );
      
      await archiveService.validateManifest(extractedPath);
      const parsedManifest = await manifestParser.parse(extractedPath);
      
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
      
      logger.info('Evaluating with AI service...');
      const result = await aiClient.evaluate(queryObject, extractedPath);
      
      if (modeString === '1') {
        const hashDecimal = await handleMode1Commit(result);
        await archiveService.cleanup(tempDir);
        return {
          jobRunID: id,
          status: 'success',
          statusCode: 200,
          data: {                     // Vector contains only the commitment
            aggregatedScore: [hashDecimal],
            justificationCID: ''      // posted later in Mode 2
          }
        };
      }
 
      // MODE 0 (standard flow) 
      const justificationCID = await createAndUploadJustification(result, tempDir);
      await archiveService.cleanup(tempDir);
      return createSuccessResponse(id, result, justificationCID);
    } 
    // Multi-CID processing
    else {
      logger.info('Processing multiple CIDs');
      // Process all CIDs
      const extractedPaths = await archiveService.processMultipleCIDs(cidArray, tempDir);
      
      // Validate all manifests
      for (const cid of cidArray) {
        await archiveService.validateManifest(extractedPaths[cid]);
      }
      
      // Parse all manifests
      const { primaryManifest, bCIDManifests } = 
        await manifestParser.parseMultipleManifests(extractedPaths, cidArray);
      
      logger.info(`Parsed primary manifest and ${bCIDManifests.length} bCID manifests`);
      
      // Construct combined query
      const combinedQueryData = manifestParser.constructCombinedQuery(
        primaryManifest,
        bCIDManifests,
        addendumString
      );
      
      logger.info('Constructed combined query with length: ' + combinedQueryData.prompt.length);
      
      // Collect all attachments
      let allAttachments = primaryManifest.additional || [];
      for (const { manifest } of bCIDManifests) {
        if (manifest.additional && manifest.additional.length > 0) {
          logger.info(`Adding ${manifest.additional.length} attachments from ${manifest.name || 'unnamed manifest'}`);
          allAttachments = [...allAttachments, ...manifest.additional];
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
      
      logger.info('Evaluating combined query with AI service...');
      const result = await aiClient.evaluate(queryObject, extractedPaths[cidArray[0]]);
     
      if (modeString === '1') {
        const hashDecimal = await handleMode1Commit(result);
        await archiveService.cleanup(tempDir);
        return {
          jobRunID: id,
          status: 'success',
          statusCode: 200,
          data: {                     // Vector contains only the commitment
            aggregatedScore: [hashDecimal],
            justificationCID: ''      // posted later in Mode 2
          }
        };
      }

      // MODE 0 (standard flow)
      const justificationCID = await createAndUploadJustification(result, tempDir);
      await archiveService.cleanup(tempDir);
      return createSuccessResponse(id, result, justificationCID);
    }
  } catch (error) {
    logger.error(`Error processing evaluation for jobRunID ${id}:`, error);

    // If we detect the custom PROVIDER_ERROR prefix, handle that differently
    if (error.message && error.message.startsWith('PROVIDER_ERROR:')) {
      const providerMessage = error.message.replace('PROVIDER_ERROR:', '').trim();
      const justificationCID = await handleProviderError(providerMessage, tempDir);
      
      return {
        jobRunID: id,
        statusCode: 200,
        data: {
          aggregatedScore: [0],
          justification: '',
          error: providerMessage,
          justificationCID
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
async function handleMode1Commit(result) {
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
    ['uint256[]', 'uint256'],
    [scores, saltUint]
  );
  const hashBytes = ethers.utils.sha256(encodedData);
  // Take the first 16 bytes - high 128 bits (32 hex chars after 0x prefix)
  const hashHex = hashBytes.substring(2, 34);

  // ---------- 5. persist & hand the decimal commitment back ------------
  await commitStore.save(hashHex, {
    result,
    salt: saltHex,                      // remember: 20 lowercase hex chars
    created: new Date().toISOString()
  });

  return BigInt('0x' + hashHex).toString();        // decimal for likelihoods[0]
}

/**
 * Reveal previously committed result
 */
async function handleMode2Reveal(hashHex, tempDir) {
  // Accept decimal, 0x-prefixed, or bare hex
  if (/^[0-9]+$/.test(hashHex)) {                // decimal
    hashHex = BigInt(hashHex).toString(16);
  } else if (hashHex.startsWith('0x')) {         // 0x… hex
    hashHex = hashHex.slice(2);
  } else {                                        // bare hex
    hashHex = hashHex;
  }
  hashHex = hashHex.toLowerCase().padStart(32, '0'); // 128 bit, zero-padded
  const commit = await commitStore.get(hashHex);

  if (!commit) throw new Error(`Unknown commit hash: ${hashHex}`);

  // Create a temporary directory if one wasn't provided
  if (!tempDir) {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verdikta-extract-'));
  }

  try {
    // Build and publish justification *now*
    const justificationCID = await createAndUploadJustification(commit.result, tempDir);
    await commitStore.del(hashHex);  // burn after reveal

    // Append salt after a colon
    const cidWithSalt = `${justificationCID}:${commit.salt}`;

    // Schedule general cleanup
    setImmediate(() => {
      commitStore.purgeStale()
        .catch(err => logger.error('purgeStale failed:', err));
    });

    return { result: commit.result, justificationCID: cidWithSalt };
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
  const justificationCID = await ipfsClient.uploadToIPFS(justificationPath);
  logger.info(`Justification uploaded with CID: ${justificationCID}`);
  
  return justificationCID;
}

/**
 * Handles a provider error by creating an error justification
 * @param {string} providerMessage - The error message
 * @param {string} tempDir - Temporary directory path
 * @returns {string|null} The CID of the uploaded error justification or null
 */
async function handleProviderError(providerMessage, tempDir) {
  let justificationCID = null;
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

      justificationCID = await ipfsClient.uploadToIPFS(justificationPath);
      logger.info(`Error justification uploaded with CID: ${justificationCID}`);

      // Clean up after uploading error justification
      logger.info('Cleaning up temporary directory after provider error...');
      await archiveService.cleanup(tempDir);
    } catch (uploadError) {
      logger.error('Failed to upload provider-error justification to IPFS:', uploadError);
      // Still try to clean up
      await archiveService.cleanup(tempDir);
    }
  }
  
  return justificationCID;
}

/**
 * Creates a success response object
 * @param {string} id - The job run ID
 * @param {Object} result - The AI evaluation result
 * @param {string} justificationCID - The CID of the uploaded justification
 * @returns {Object} The success response object
 */
function createSuccessResponse(id, result, justificationCID) {
  return {
    jobRunID: id,
    statusCode: 200,
    status: 'success',
    data: { 
      aggregatedScore: (result.scores || [{score: 0}]).map(s => s.score),
      justificationCID
    },
  };
}

module.exports = evaluateHandler;
