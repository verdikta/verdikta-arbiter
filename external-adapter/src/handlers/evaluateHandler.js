const path = require('path');
const fs = require('fs');
const os = require('os');
const archiveService = require('../services/archiveService');
const aiClient = require('../services/aiClient');
const { validateRequest, requestSchema } = require('../utils/validator');
const ipfsClient = require('../services/ipfsClient');
const manifestParser = require('../utils/manifestParser');
const logger = require('../utils/logger');

const evaluateHandler = async (request) => {
  const { id, data } = request;
  let tempDir; // Declare here so we can reuse if provider error happens

  try {
    console.log('Validating request:', request);
    await validateRequest(request);

    console.log('Processing CID string:', data.cid);
    // Process CID string and parse addendum if present
    const firstColonIndex = data.cid.indexOf(':'); 
    
    let cidString;
    let addendumString = "";
    
    if (firstColonIndex !== -1) {
      cidString = data.cid.substring(0, firstColonIndex);
      addendumString = data.cid.substring(firstColonIndex + 1);
      logger.info(`Found addendum string: ${addendumString}`);
    } else {
      cidString = data.cid;
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
      
      // Create justification file
      const justificationCID = await createAndUploadJustification(result, tempDir);
      
      // Clean up
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
      
      // Create justification file
      const justificationCID = await createAndUploadJustification(result, tempDir);
      
      // Clean up
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
