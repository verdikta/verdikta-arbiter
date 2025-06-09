const fs = require('fs-extra');
const path = require('path');
const AdmZip = require('adm-zip');
const os = require('os');
const logger = require('./logger');

/**
 * Attachment handler for processing ZIP archives containing manifests and attachments
 */
class AttachmentHandler {
  constructor() {
    this.attachmentsDir = path.join(__dirname, '../scenarios/attachments');
  }

  /**
   * Process a ZIP archive for a scenario
   * @param {string} archiveFilename - Name of the ZIP file in attachments directory
   * @param {import('./types').JuryConfig} juryConfig - Jury configuration to inject
   * @returns {Object} Processed archive data ready for AI node
   */
  async processArchive(archiveFilename, juryConfig) {
    const archivePath = path.join(this.attachmentsDir, archiveFilename);
    
    if (!await fs.pathExists(archivePath)) {
      throw new Error(`Archive not found: ${archiveFilename}`);
    }

    // Create temporary directory for extraction
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verdikta-test-'));
    
    try {
      // Extract archive
      logger.debug(`Extracting archive: ${archiveFilename}`);
      const zip = new AdmZip(archivePath);
      zip.extractAllTo(tempDir, true);

      // Read and parse manifest
      const manifestPath = path.join(tempDir, 'manifest.json');
      if (!await fs.pathExists(manifestPath)) {
        throw new Error(`Manifest not found in archive: ${archiveFilename}`);
      }

      const manifest = await this.readManifest(manifestPath);
      
      // Override jury parameters with provided jury config
      manifest.juryParameters = this.convertJuryConfigToManifestFormat(juryConfig);
      
      // Process primary file
      const primaryData = await this.processPrimaryFile(tempDir, manifest.primary);
      
      // Process attachments
      const attachments = await this.processAttachments(tempDir, manifest);
      
      // Build final request object for AI node
      const requestData = {
        prompt: primaryData.query,
        outcomes: primaryData.outcomes,
        models: this.convertModelsToAINodeFormat(manifest.juryParameters.AI_NODES),
        iterations: manifest.juryParameters.ITERATIONS || 1,
        attachments: attachments
      };

      logger.debug(`Processed archive for ${archiveFilename}:`, {
        prompt: requestData.prompt.substring(0, 100) + '...',
        outcomes: requestData.outcomes,
        models: requestData.models.length,
        attachments: requestData.attachments?.length || 0
      });

      return {
        requestData,
        tempDir,
        manifest
      };

    } catch (error) {
      // Clean up on error
      await this.cleanup(tempDir);
      throw error;
    }
  }

  /**
   * Read and validate manifest file
   * @param {string} manifestPath
   * @returns {Object} Parsed manifest
   */
  async readManifest(manifestPath) {
    try {
      const manifestContent = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestContent);
      
      // Validate required fields
      if (!manifest.version || !manifest.primary) {
        throw new Error('Invalid manifest: missing required fields "version" or "primary"');
      }
      
      return manifest;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in manifest: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Process primary file from manifest
   * @param {string} tempDir - Temporary directory
   * @param {Object} primary - Primary file definition from manifest
   * @returns {Object} Query and outcomes data
   */
  async processPrimaryFile(tempDir, primary) {
    if (!primary.filename && !primary.hash) {
      throw new Error('Invalid manifest: primary must have either "filename" or "hash"');
    }

    let content;
    if (primary.filename) {
      const primaryPath = path.join(tempDir, primary.filename);
      content = await fs.readFile(primaryPath, 'utf8');
    } else {
      // For testing tool, we expect local files only, not IPFS
      throw new Error('IPFS hash references not supported in testing tool - use local files only');
    }

    // Parse primary content
    let primaryData;
    try {
      primaryData = JSON.parse(content);
    } catch (error) {
      throw new Error(`Invalid JSON in primary file: ${error.message}`);
    }

    if (!primaryData.query) {
      throw new Error('No QUERY found in primary file');
    }

    // Handle outcomes - either from file or create defaults
    let outcomes;
    if (primaryData.outcomes && primaryData.outcomes.length > 0) {
      outcomes = primaryData.outcomes;
    } else {
      // Create default outcomes - this will be overridden by scenario CSV
      outcomes = ['outcome1', 'outcome2'];
    }

    return {
      query: primaryData.query,
      outcomes: outcomes,
      references: primaryData.references || []
    };
  }

  /**
   * Process attachments from manifest
   * @param {string} tempDir - Temporary directory
   * @param {Object} manifest - Parsed manifest
   * @returns {Array} Attachment data for AI node
   */
  async processAttachments(tempDir, manifest) {
    const attachments = [];
    
    // Process additional files
    if (manifest.additional && Array.isArray(manifest.additional)) {
      for (const file of manifest.additional) {
        if (file.filename) {
          const filePath = path.join(tempDir, file.filename);
          if (await fs.pathExists(filePath)) {
            const attachment = await this.createAttachmentFromFile(filePath, file);
            if (attachment) {
              attachments.push(attachment);
            }
          } else {
            logger.warn(`Additional file not found: ${file.filename}`);
          }
        }
      }
    }

    // Process support files (legacy format)
    if (manifest.support && Array.isArray(manifest.support)) {
      for (const file of manifest.support) {
        if (file.filename) {
          const filePath = path.join(tempDir, file.filename);
          if (await fs.pathExists(filePath)) {
            const attachment = await this.createAttachmentFromFile(filePath, file);
            if (attachment) {
              attachments.push(attachment);
            }
          }
        }
      }
    }

    return attachments;
  }

  /**
   * Create attachment data from file
   * @param {string} filePath - Path to file
   * @param {Object} fileInfo - File metadata from manifest
   * @returns {string|null} Base64 encoded attachment data
   */
  async createAttachmentFromFile(filePath, fileInfo) {
    try {
      const stats = await fs.stat(filePath);
      if (stats.size > 10 * 1024 * 1024) { // 10MB limit
        logger.warn(`File too large, skipping: ${filePath}`);
        return null;
      }

      const fileBuffer = await fs.readFile(filePath);
      const mimeType = this.getMimeType(filePath, fileInfo.type);
      const base64Data = fileBuffer.toString('base64');
      
      return `data:${mimeType};base64,${base64Data}`;
    } catch (error) {
      logger.error(`Failed to process attachment ${filePath}:`, error);
      return null;
    }
  }

  /**
   * Get MIME type for file
   * @param {string} filePath
   * @param {string} [providedType] - Type from manifest
   * @returns {string}
   */
  getMimeType(filePath, providedType) {
    if (providedType) {
      return providedType;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.json': 'application/json',
      '.csv': 'text/csv'
    };

    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * Convert jury config to manifest format
   * @param {import('./types').JuryConfig} juryConfig
   * @returns {Object} Manifest jury parameters
   */
  convertJuryConfigToManifestFormat(juryConfig) {
    return {
      AI_NODES: juryConfig.models.map(model => ({
        AI_PROVIDER: model.AI_PROVIDER,
        AI_MODEL: model.AI_MODEL,
        WEIGHT: model.WEIGHT,
        NO_COUNTS: model.NO_COUNTS || 1
      })),
      ITERATIONS: juryConfig.iterations || 1,
      NUMBER_OF_OUTCOMES: 2 // This will be overridden by scenario outcomes
    };
  }

  /**
   * Convert models to AI node format
   * @param {Array} aiNodes - AI nodes from manifest
   * @returns {Array} AI node format for rank-and-justify endpoint
   */
  convertModelsToAINodeFormat(aiNodes) {
    return aiNodes.map(node => ({
      provider: node.AI_PROVIDER,
      model: node.AI_MODEL,
      weight: node.WEIGHT,
      count: node.NO_COUNTS || 1
    }));
  }

  /**
   * Clean up temporary directory
   * @param {string} tempDir
   */
  async cleanup(tempDir) {
    try {
      if (tempDir && await fs.pathExists(tempDir)) {
        await fs.remove(tempDir);
        logger.debug(`Cleaned up temp directory: ${tempDir}`);
      }
    } catch (error) {
      logger.error(`Failed to cleanup temp directory ${tempDir}:`, error);
    }
  }

  /**
   * Create example archive for testing
   * @param {string} scenarioId - Scenario identifier
   * @param {string} outputPath - Where to create the archive
   */
  async createExampleArchive(scenarioId, outputPath) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verdikta-example-'));
    
    try {
      // Create manifest
      const manifest = {
        version: "1.0",
        name: `Example scenario: ${scenarioId}`,
        primary: {
          filename: "primary.json"
        },
        juryParameters: {
          AI_NODES: [
            {
              AI_PROVIDER: "OpenAI",
              AI_MODEL: "gpt-4",
              WEIGHT: 1.0,
              NO_COUNTS: 1
            }
          ],
          ITERATIONS: 1,
          NUMBER_OF_OUTCOMES: 3
        },
        additional: [
          {
            name: "Example Image",
            filename: "example.txt",
            type: "text/plain"
          }
        ]
      };

      // Create primary file
      const primary = {
        query: `This is an example decision scenario for ${scenarioId}. Please evaluate the situation and provide your recommendation.`,
        outcomes: ["Option A", "Option B", "Option C"],
        references: [
          "Example reference 1",
          "Example reference 2"
        ]
      };

      // Write files
      await fs.writeJson(path.join(tempDir, 'manifest.json'), manifest, { spaces: 2 });
      await fs.writeJson(path.join(tempDir, 'primary.json'), primary, { spaces: 2 });
      await fs.writeFile(path.join(tempDir, 'example.txt'), 'This is example attachment content.');

      // Create ZIP archive
      const zip = new AdmZip();
      const files = await fs.readdir(tempDir);
      for (const file of files) {
        const filePath = path.join(tempDir, file);
        zip.addLocalFile(filePath);
      }
      
      zip.writeZip(outputPath);
      logger.info(`Created example archive: ${outputPath}`);

    } finally {
      await this.cleanup(tempDir);
    }
  }
}

module.exports = new AttachmentHandler(); 