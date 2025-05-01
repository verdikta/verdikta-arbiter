# Multi-CID and Addendum Support Design Document

## Overview

This document outlines the design and implementation plan for enhancing the Verdikta External Adapter to support multiple content identifiers (CIDs) and an optional addendum string. This feature will allow the adapter to process multiple archives simultaneously while maintaining backward compatibility with the current implementation.

## Requirements

1. **Support for Multiple CIDs:**
   - Allow the adapter to process a comma-separated list of CIDs
   - The first CID will serve as the "Primary CID" containing the main manifest
   - Additional CIDs will serve as "bCIDs" (blockchain CIDs) with supplementary content

2. **Enhanced Manifest Structure:**
   - Add a `name` field to identify each archive
   - Add a `bCIDs` section to the primary manifest to provide descriptions for each bCID
   - Add an `addendum` field to describe optional addendum text

3. **Query Construction:**
   - Combine the primary query with all bCID queries
   - Format with appropriate headers and sections
   - Append the addendum text if provided
   - Collect references and attachments from all CIDs

4. **Backward Compatibility:**
   - Maintain full compatibility with the current single-CID implementation

## Manifest Schema

### Primary Manifest Example

```json
{
  "version": "1.0",
  "name": "Dispute over Eth price",
  "primary": {
    "filename": "primary_query.json"
  },
  "juryParameters": {
    "NUMBER_OF_OUTCOMES": 2,
    "AI_NODES": [
      {
        "AI_MODEL": "gpt-4",
        "AI_PROVIDER": "OpenAI",
        "NO_COUNTS": 2,
        "WEIGHT": 0.7
      },
      {
        "AI_MODEL": "claude-3-sonnet-20240229",
        "AI_PROVIDER": "Anthropic",
        "NO_COUNTS": 1,
        "WEIGHT": 0.3
      }
    ],
    "ITERATIONS": 1
  },
  "bCIDs": {
    "plaintiffComplaint": "the dispute launched by client X",
    "defendantRebuttal": "Rebuttal by vendor Y"
  },
  "addendum": "The price of Ethereum at the time of the dispute"
}
```

### bCID Manifest Example

```json
{
  "version": "1.0",
  "name": "plaintiffComplaint",
  "primary": {
    "filename": "primary_query.json"
  },
  "additional": [
    {
      "name": "argument-transcript",
      "type": "UTF8",
      "filename": "transcript.txt"
    }
  ]
}
```

## Implementation Plan

### 1. Update Schema Validation

Extend the manifest validator to support the new fields:

```javascript
manifest: Joi.object({
  version: Joi.string().required(),
  name: Joi.string().optional(),
  primary: Joi.object({
    filename: Joi.string().required(),
    hash: Joi.string().optional()
  }).required(),
  bCIDs: Joi.object().pattern(
    Joi.string(),
    Joi.string()
  ).optional(),
  addendum: Joi.string().optional(),
  // ... existing fields
})
```

### 2. Modify Archive Service

Extend the `archiveService` to handle multiple CIDs:

```javascript
/**
 * Process multiple CIDs and extract their archives
 * @param {string[]} cids - Array of CIDs to process
 * @param {string} tempDir - Directory to extract archives to
 * @returns {Object} Map of CIDs to their extracted paths
 */
async processMultipleCIDs(cids, tempDir) {
  const extractedPaths = {};
  
  for (let i = 0; i < cids.length; i++) {
    const cid = cids[i];
    try {
      const archiveData = await this.getArchive(cid);
      const subDirName = `archive_${i}_${cid.substring(0, 10)}`;
      const extractPath = await this.extractArchive(
        archiveData,
        `archive_${cid}.zip`,
        path.join(tempDir, subDirName)
      );
      extractedPaths[cid] = extractPath;
    } catch (error) {
      throw new Error(`Failed to process CID ${cid}: ${error.message}`);
    }
  }
  
  return extractedPaths;
}
```

### 3. Enhance Manifest Parser

Create a new method to process multiple manifests:

```javascript
/**
 * Parse multiple manifests from different CIDs
 * @param {Object} extractedPaths - Map of CIDs to their extracted paths
 * @param {string[]} cidOrder - The order of CIDs as provided in the input
 * @returns {Object} Combined manifest data from all CIDs
 */
async parseMultipleManifests(extractedPaths, cidOrder) {
  // Parse primary manifest (first CID)
  const primaryCID = cidOrder[0];
  const primaryManifest = await this.parse(extractedPaths[primaryCID]);
  
  // Validate bCIDs against provided CIDs
  if (primaryManifest.bCIDs && Object.keys(primaryManifest.bCIDs).length !== cidOrder.length - 1) {
    throw new Error(`Number of bCIDs in manifest (${Object.keys(primaryManifest.bCIDs).length}) does not match number of provided bCIDs (${cidOrder.length - 1})`);
  }
  
  // Parse bCID manifests
  const bCIDManifests = [];
  const bCIDNames = primaryManifest.bCIDs ? Object.keys(primaryManifest.bCIDs) : [];
  
  for (let i = 1; i < cidOrder.length; i++) {
    const cid = cidOrder[i];
    const expectedName = bCIDNames[i-1]; // Get expected name from primary manifest
    const manifest = await this.parse(extractedPaths[cid]);
    
    // Validate name matches expected name
    if (manifest.name && manifest.name !== expectedName) {
      console.warn(`Warning: bCID manifest name "${manifest.name}" does not match expected name "${expectedName}" from primary manifest`);
    }
    
    bCIDManifests.push({
      cid,
      expectedName,
      manifest
    });
  }
  
  return { primaryManifest, bCIDManifests };
}
```

### 4. Update AI Client

Create a method to construct a combined query:

```javascript
/**
 * Construct a combined query from primary and bCID manifests
 * @param {Object} primaryManifest - The parsed primary manifest
 * @param {Array} bCIDManifests - Array of parsed bCID manifests
 * @param {string} addendumString - Optional addendum string
 * @returns {string} Combined query for the AI
 */
constructCombinedQuery(primaryManifest, bCIDManifests, addendumString) {
  let combinedQuery = primaryManifest.prompt;
  let referencesSection = "";
  
  // Add bCID content
  if (bCIDManifests && bCIDManifests.length > 0) {
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
  
  return combinedQuery;
}
```

### 5. Update Evaluate Handler

Modify the handler to orchestrate the multi-CID workflow:

```javascript
const evaluateHandler = async (request) => {
  const { id, data } = request;
  let tempDir;

  try {
    console.log('Validating request:', request);
    await validateRequest(request);

    console.log('Processing CID string:', data.cid);
    // Split CID and addendum
    const firstColonIndex = data.cid.indexOf(':'); 
    
    let cidString;
    let addendumString = "";
    
    if (firstColonIndex !== -1) {
      cidString = data.cid.substring(0, firstColonIndex);
      addendumString = data.cid.substring(firstColonIndex + 1);
    } else {
      cidString = data.cid;
    }
    
    // Split multiple CIDs if present
    const cidArray = cidString.split(',').map(cid => cid.trim()).filter(cid => cid);
    console.log(`Processing ${cidArray.length} CIDs:`, cidArray);
    
    // Create temp directory
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verdikta-extract-'));
    
    // For backward compatibility, if only one CID, process as before
    if (cidArray.length === 1) {
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
      
      // If addendum is present, append it
      if (addendumString && parsedManifest.addendum) {
        const sanitizedAddendum = addendumString.replace(/[<>{}]/g, '');
        queryObject.prompt += `\n\nAddendum: \n${parsedManifest.addendum}: ${sanitizedAddendum}`;
      }
      
      const result = await aiClient.evaluate(queryObject, extractedPath);
      
      // Continue with the rest of the handler...
    } 
    // Multi-CID processing
    else {
      // Process all CIDs
      const extractedPaths = await archiveService.processMultipleCIDs(cidArray, tempDir);
      
      // Validate all manifests
      for (const cid of cidArray) {
        await archiveService.validateManifest(extractedPaths[cid]);
      }
      
      // Parse all manifests
      const { primaryManifest, bCIDManifests } = 
        await manifestParser.parseMultipleManifests(extractedPaths, cidArray);
      
      // Construct combined query
      const combinedQuery = aiClient.constructCombinedQuery(
        primaryManifest,
        bCIDManifests,
        addendumString
      );
      
      // Collect all attachments
      let allAttachments = primaryManifest.additional || [];
      for (const { manifest } of bCIDManifests) {
        if (manifest.additional) {
          allAttachments = [...allAttachments, ...manifest.additional];
        }
      }
      
      // Create final query object
      const queryObject = {
        prompt: combinedQuery,
        models: primaryManifest.models,
        iterations: primaryManifest.iterations,
        additional: allAttachments,
        outcomes: primaryManifest.outcomes
      };
      
      const result = await aiClient.evaluate(queryObject, extractedPaths[cidArray[0]]);
      
      // Continue with the rest of the handler...
    }
    
    // Rest of the handler remains the same...
  } catch (error) {
    // Error handling remains the same...
  }
};
```

## Error Handling

Based on the requirements:

1. **bCID Processing Errors**: If we fail to download and/or parse any of the CID archives, we will fail the entire request.

2. **bCID Count Mismatch**: If the number of bCIDs entries in the primary manifest doesn't match the number of bCIDs provided, we'll consider it a processing error and return.

3. **Name Mismatch**: If the name in a bCID manifest doesn't match the expected name from the primary manifest's bCIDs section, we'll log a warning but continue processing.

## Security Considerations

To prevent potential injection attacks in the addendum string, we'll implement simple sanitization by removing potentially harmful characters like `<`, `>`, `{`, and `}`.

## Testing Strategy

1. **Unit Tests**:
   - Test parsing of comma-separated CID strings
   - Test parsing with and without addendum string
   - Test manifest parsing with new fields
   - Test combined query construction

2. **Integration Tests**:
   - Test with single CID (backward compatibility)
   - Test with multiple CIDs
   - Test with addendum string
   - Test error cases (missing fields, count mismatch, etc.)

## Implementation Phases

1. **Phase 1**: Update schema and add utility functions
   - Update manifest schema validation
   - Add CID parsing functions

2. **Phase 2**: Enhance core services
   - Modify Archive Service
   - Enhance Manifest Parser
   - Update AI Client

3. **Phase 3**: Update handler logic
   - Modify Evaluate Handler
   - Implement backward compatibility

4. **Phase 4**: Testing and documentation
   - Create comprehensive tests
   - Update documentation in `parserUsage.md`

## Example Usage

### Request:

```
POST /evaluate
{
  "id": "example-job",
  "data": {
    "cid": "QmPrimary,QmSecondary,QmTertiary:2009.67"
  }
}
```

### Response:

```json
{
  "jobRunID": "example-job",
  "statusCode": 200,
  "status": "success",
  "data": {
    "aggregatedScore": [0.8, 0.2],
    "justificationCID": "QmResultJustification"
  }
}
``` 