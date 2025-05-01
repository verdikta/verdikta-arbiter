const fs = require('fs');
const path = require('path');
const ipfsClient = require('../services/ipfsClient');
const { validateManifest } = require('./validator');
const logger = require('./logger');

class ManifestParser {
  async parse(extractedPath) {
    const manifestPath = path.join(extractedPath, 'manifest.json');
    let manifestContent;
    try {
      manifestContent = await fs.promises.readFile(manifestPath, 'utf8');
    } catch (error) {
      throw new Error(`Failed to read manifest file: ${error.message}`);
    }

    let manifest;
    try {
      manifest = JSON.parse(manifestContent);
      console.log('Parsed manifest:', JSON.stringify(manifest, null, 2));
    } catch (error) {
      throw new Error(`Invalid JSON in manifest file: ${error.message}`);
    }

    // Validate required fields
    if (!manifest.version || !manifest.primary) {
      throw new Error('Invalid manifest: missing required fields "version" or "primary"');
    }

    // Read primary file content
    console.log('Reading primary file...');
    const primaryContent = await this.readPrimaryFile(extractedPath, manifest.primary);
    console.log('Primary file content received:', primaryContent);

    // Parse the query and references from primary content
    const { query, references, outcomes } = this.parsePrimaryContent(primaryContent);
    console.log('Parsed primary content:', { 
      query, 
      references, 
      outcomes,
      hasOutcomes: !!outcomes,
      outcomesLength: outcomes?.length || 0
    });

    // Construct AI node payload
    const parsedResult = {
      prompt: query,
      models: this.constructModels(manifest.juryParameters?.AI_NODES || [
        {
          AI_MODEL: "gpt-4",
          AI_PROVIDER: "OpenAI",
          NO_COUNTS: 1,
          WEIGHT: 1.0
        }
      ]),
      iterations: manifest.juryParameters?.ITERATIONS || 1,
      outcomes: outcomes,
      name: manifest.name,
      addendum: manifest.addendum,
      bCIDs: manifest.bCIDs,
      references
    };

    console.log('Constructed parsed result:', {
      prompt: parsedResult.prompt,
      modelsCount: parsedResult.models.length,
      iterations: parsedResult.iterations,
      hasOutcomes: !!parsedResult.outcomes,
      outcomesLength: parsedResult.outcomes?.length || 0,
      outcomes: parsedResult.outcomes
    });

    // Process additional files section if present
    if (manifest.additional) {
      console.log('Processing additional files:', manifest.additional);
      const additionalFiles = [];
      for (const file of manifest.additional) {
        try {
          if (file.hash && file.type === 'ipfs/cid') {
            // Handle IPFS CID reference
            console.log(`Fetching additional file with CID: ${file.hash}`);
            const fileContent = await ipfsClient.fetchFromIPFS(file.hash);
            console.log(`Successfully fetched additional file, size: ${fileContent.length} bytes`);
            
            // Store the file in the extracted path
            const filePath = path.join(extractedPath, `additional_${file.hash}`);
            await fs.promises.writeFile(filePath, fileContent);
            console.log(`Wrote additional file to: ${filePath}`);
            
            additionalFiles.push({
              name: file.name,
              type: 'image/webp', // Since we know this is a webp file
              path: filePath,
              description: file.description
            });
          } else if (file.filename) {
            // Handle local file reference
            additionalFiles.push({
              name: file.name,
              filename: file.filename,
              type: file.type,
              path: path.join(extractedPath, file.filename)
            });
          }
        } catch (error) {
          console.error(`Failed to process additional file:`, error);
          // Continue with other files even if one fails
        }
      }
      parsedResult.additional = additionalFiles;
      console.log('Final additional files in result:', parsedResult.additional);
    }

    // Process support files if present
    if (manifest.support) {
      console.log('Processing support files:', manifest.support);
      const supportFiles = [];
      for (const file of manifest.support) {
        const cid = file.hash?.cid || file.hash;
        if (cid) {
          try {
            console.log(`Fetching support file with CID: ${cid}`);
            const fileContent = await ipfsClient.fetchFromIPFS(cid);
            console.log(`Successfully fetched support file, size: ${fileContent.length} bytes`);
            
            const supportFilePath = path.join(extractedPath, `support_${cid}`);
            await fs.promises.writeFile(supportFilePath, fileContent);
            console.log(`Wrote support file to: ${supportFilePath}`);
            
            supportFiles.push({
              name: file.name,
              hash: file.hash,
              path: supportFilePath,
              description: file.description
            });
          } catch (error) {
            console.error(`Failed to fetch support file ${cid}:`, error);
          }
        } else {
          console.warn('Support file entry missing hash/CID:', file);
        }
      }
      parsedResult.support = supportFiles;
      console.log('Final support files in result:', parsedResult.support);
    }

    return parsedResult;
  }

  /**
   * Parse multiple manifests from different CIDs
   * @param {Object} extractedPaths - Map of CIDs to their extracted paths
   * @param {string[]} cidOrder - The order of CIDs as provided in the input
   * @returns {Object} Combined manifest data from all CIDs
   */
  async parseMultipleManifests(extractedPaths, cidOrder) {
    // Parse primary manifest (first CID)
    const primaryCID = cidOrder[0];
    logger.info(`Parsing primary manifest from CID: ${primaryCID}`);
    const primaryManifest = await this.parse(extractedPaths[primaryCID]);
    
    // If there's only one CID, return just the primary manifest
    if (cidOrder.length === 1) {
      return { primaryManifest, bCIDManifests: [] };
    }
    
    // Validate bCIDs against provided CIDs
    if (!primaryManifest.bCIDs || Object.keys(primaryManifest.bCIDs).length === 0) {
      logger.error('Primary manifest missing bCIDs section but multiple CIDs provided');
      throw new Error('Primary manifest is missing bCIDs section but multiple CIDs were provided');
    }
    
    if (Object.keys(primaryManifest.bCIDs).length !== cidOrder.length - 1) {
      logger.error(`Number of bCIDs in manifest (${Object.keys(primaryManifest.bCIDs).length}) does not match number of provided bCIDs (${cidOrder.length - 1})`);
      throw new Error(`Number of bCIDs in manifest (${Object.keys(primaryManifest.bCIDs).length}) does not match number of provided bCIDs (${cidOrder.length - 1})`);
    }
    
    // Parse bCID manifests
    const bCIDManifests = [];
    const bCIDNames = Object.keys(primaryManifest.bCIDs);
    
    for (let i = 1; i < cidOrder.length; i++) {
      const cid = cidOrder[i];
      const expectedName = bCIDNames[i-1]; // Get expected name from primary manifest
      logger.info(`Parsing bCID manifest from CID: ${cid}, expected name: ${expectedName}`);
      
      const manifest = await this.parse(extractedPaths[cid]);
      
      // Validate name matches expected name
      if (manifest.name && manifest.name !== expectedName) {
        logger.warn(`Warning: bCID manifest name "${manifest.name}" does not match expected name "${expectedName}" from primary manifest`);
      }
      
      bCIDManifests.push({
        cid,
        expectedName,
        manifest
      });
    }
    
    return { primaryManifest, bCIDManifests };
  }

  /**
   * Construct a combined query from primary and bCID manifests
   * @param {Object} primaryManifest - The parsed primary manifest
   * @param {Array} bCIDManifests - Array of parsed bCID manifests
   * @param {string} addendumString - Optional addendum string
   * @returns {Object} Combined query data for the AI
   */
  constructCombinedQuery(primaryManifest, bCIDManifests, addendumString) {
    let combinedQuery = primaryManifest.prompt;
    let allReferences = [...primaryManifest.references];
    let referencesSection = "";
    
    // Add bCID content
    if (bCIDManifests && bCIDManifests.length > 0) {
      logger.info(`Combining content from ${bCIDManifests.length} bCIDs`);
      
      for (const { expectedName, manifest } of bCIDManifests) {
        const description = primaryManifest.bCIDs[expectedName];
        
        // Add query section
        combinedQuery += `\n\n**\n${description}:\n`;
        if (manifest.name) combinedQuery += `Name: ${manifest.name}\n`;
        combinedQuery += manifest.prompt;
        
        // Prepare references section
        if (manifest.references && manifest.references.length > 0) {
          referencesSection += `${manifest.name || expectedName}: \n`;
          referencesSection += manifest.references.join('\n') + '\n\n';
          
          // Add to all references
          allReferences = [...allReferences, ...manifest.references];
        }
      }
    }
    
    // Add references section if we have any
    if (referencesSection) {
      combinedQuery += "\n\nReferences:\n" + referencesSection;
    }
    
    // Add addendum if provided
    if (primaryManifest.addendum && addendumString) {
      // Basic security check - remove any potential code injection characters
      const sanitizedAddendum = addendumString.replace(/[<>{}]/g, '');
      combinedQuery += `\n\nAddendum: \n${primaryManifest.addendum}: ${sanitizedAddendum}`;
    }
    
    return {
      prompt: combinedQuery,
      references: allReferences,
      outcomes: primaryManifest.outcomes,
      models: primaryManifest.models,
      iterations: primaryManifest.iterations
    };
  }

  parsePrimaryContent(content) {
    let primaryData;
    try {
      primaryData = JSON.parse(content);
      console.log('Primary content parsed:', {
        hasQuery: !!primaryData.query,
        hasReferences: !!primaryData.references,
        hasOutcomes: !!primaryData.outcomes,
        outcomesLength: primaryData.outcomes?.length,
        rawOutcomes: primaryData.outcomes
      });
    } catch (error) {
      throw new Error(`Invalid JSON in primary file: ${error.message}`);
    }

    if (!primaryData.query) {
      throw new Error('No QUERY found in primary file');
    }

    // Get the manifest to access juryParameters
    const manifestPath = path.join(path.dirname(this.currentPrimaryPath), 'manifest.json');
    let manifest;
    try {
      const manifestContent = fs.readFileSync(manifestPath, 'utf8');
      manifest = JSON.parse(manifestContent);
    } catch (error) {
      console.warn('Failed to read manifest for jury parameters:', error);
      manifest = { juryParameters: { NUMBER_OF_OUTCOMES: 2 } }; // Default to 2 outcomes if manifest can't be read
    }

    // Handle outcomes - either use provided outcomes or create default ones
    let outcomes;
    if (primaryData.outcomes && primaryData.outcomes.length > 0) {
      outcomes = primaryData.outcomes;
    } else {
      // Create default outcomes based on NUMBER_OF_OUTCOMES from juryParameters
      const numberOfOutcomes = manifest.juryParameters?.NUMBER_OF_OUTCOMES || 2;
      outcomes = Array.from({ length: numberOfOutcomes }, (_, i) => `outcome${i + 1}`);
      console.log('Created default outcomes:', {
        numberOfOutcomes,
        outcomes
      });
    }

    const result = {
      query: primaryData.query,
      references: primaryData.references || [],
      outcomes: outcomes
    };

    console.log('Primary content processing result:', {
      queryLength: result.query.length,
      referencesCount: result.references.length,
      outcomesCount: result.outcomes.length,
      outcomes: result.outcomes,
      isDefaultOutcomes: !primaryData.outcomes
    });

    return result;
  }

  async readPrimaryFile(extractedPath, primary) {
    if ((!primary.filename && !primary.hash) || (primary.filename && primary.hash)) {
      throw new Error('Invalid manifest: primary must have either "filename" or "hash", but not both');
    }

    let content;
    if (primary.filename) {
      const primaryPath = path.join(extractedPath, primary.filename);
      this.currentPrimaryPath = primaryPath; // Store the path for use in parsePrimaryContent
      console.log('Reading primary file from:', primaryPath);
      content = await fs.promises.readFile(primaryPath, 'utf8');
      console.log('Primary file content length:', content.length);
      console.log('Primary file raw content:', content);
      return content;
    }

    // Handle hash-based primary file
    if (primary.hash) {
      try {
        const cid = primary.hash?.cid || primary.hash;
        console.log(`Fetching primary file with CID: ${cid}`);
        const content = await ipfsClient.fetchFromIPFS(cid);
        // Store the file in the extracted path for reference
        const primaryPath = path.join(extractedPath, `primary_${cid}`);
        this.currentPrimaryPath = primaryPath; // Store the path for use in parsePrimaryContent
        await fs.promises.writeFile(primaryPath, content);
        return content.toString('utf8');
      } catch (error) {
        throw new Error(`Failed to fetch primary file from IPFS: ${error.message}`);
      }
    }
  }

  constructModels(aiNodes) {
    return aiNodes.map(node => ({
      provider: node.AI_PROVIDER,
      model: node.AI_MODEL,
      weight: node.WEIGHT,
      count: node.NO_COUNTS
    }));
  }
}

module.exports = new ManifestParser();
