const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const ipfsClient = require('./ipfsClient');
const logger = require('../utils/logger');

class ArchiveService {
  constructor() {
    this.testMode = process.env.TEST_MODE === 'true';
    if (this.testMode) {
      console.info('ArchiveService initialized in TEST_MODE.', { timestamp: new Date().toISOString() });
    } else {
      console.info('ArchiveService initialized in production mode.', { timestamp: new Date().toISOString() });
    }
  }

  /**
   * Obtains the archive data either from IPFS or from a local mock archive.
   * @param {string} cid - The IPFS CID of the archive.
   * @returns {Buffer} - The archive data.
   */
  async getArchive(cid) {
    if (this.testMode) {
      const mockArchivePath = path.resolve(__dirname, '../__tests__/integration/fixtures/mockArchive.zip');
      console.info(`Test Mode: Loading archive from ${mockArchivePath}`, { timestamp: new Date().toISOString() });
      try {
        const data = await fs.promises.readFile(mockArchivePath);
        logger.info(`Loaded archive from local path: ${mockArchivePath}`);
        return data;
      } catch (err) {
        logger.error('Failed to load mock archive:', err, { timestamp: new Date().toISOString() });
        throw new Error('Unable to load mock archive.');
      }
    } else {
      // Fetch from IPFS
      try {
        logger.info(`Fetching archive from IPFS with CID: ${cid}`, { timestamp: new Date().toISOString() });
        const archiveData = await ipfsClient.fetchFromIPFS(cid);
        logger.info(`Fetched archive of size: ${archiveData.length} bytes`);
        return archiveData;
      } catch (error) {
        logger.error('Failed to fetch archive from IPFS.', { error, timestamp: new Date().toISOString() });
        throw new Error('Unable to fetch archive from IPFS.');
      }
    }
  }

  /**
   * Extracts the given archive to the specified destination directory.
   * @param {Buffer} archiveData - The binary data of the archive.
   * @param {string} archiveName - The name of the archive file.
   * @param {string} destinationDir - The directory where the archive will be extracted.
   * @returns {Promise<string>} - The path to the extracted directory.
   */
  async extractArchive(archiveData, archiveName, destinationDir) {
    try {
      const extractPath = path.join(destinationDir, path.basename(archiveName, path.extname(archiveName)));
      console.info(`Extracting archive to ${extractPath}`, { timestamp: new Date().toISOString() });

      // Ensure the destination directory exists
      await fs.promises.mkdir(extractPath, { recursive: true });

      // Use unzipper to extract
      await unzipper.Open.buffer(archiveData)
        .then(d => d.extract({ path: extractPath }))
        .catch(err => {
          console.error('Failed to extract archive:', err, { timestamp: new Date().toISOString() });
          throw new Error('Failed to extract archive.');
        });

      console.info(`Extraction completed to ${extractPath}`, { timestamp: new Date().toISOString() });
      return extractPath;
    } catch (error) {
      console.error('Failed to extract archive.', error, { timestamp: new Date().toISOString() });
      throw error;
    }
  }

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
        logger.info(`Processing CID ${i+1}/${cids.length}: ${cid}`);
        const archiveData = await this.getArchive(cid);
        const subDirName = `archive_${i}_${cid.substring(0, 10)}`;
        const subDir = path.join(tempDir, subDirName);
        
        // Ensure the subdirectory exists
        await fs.promises.mkdir(subDir, { recursive: true });
        
        const extractPath = await this.extractArchive(
          archiveData,
          `archive_${cid}.zip`,
          subDir
        );
        extractedPaths[cid] = extractPath;
        logger.info(`Successfully processed CID ${cid} to ${extractPath}`);
      } catch (error) {
        logger.error(`Failed to process CID ${cid}: ${error.message}`);
        throw new Error(`Failed to process CID ${cid}: ${error.message}`);
      }
    }
    
    return extractedPaths;
  }

  /**
   * Validates the manifest file within the extracted archive.
   * @param {string} extractedPath - The path to the extracted archive directory.
   * @returns {boolean} - Whether the manifest is valid.
   */
  async validateManifest(extractedPath) {
    try {
      const manifestPath = path.join(extractedPath, 'manifest.json');
      console.info(`Validating manifest at: ${manifestPath}`, { timestamp: new Date().toISOString() });
      const manifestData = await fs.promises.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestData);

      // Implement your manifest validation logic here
      // For simplicity, let's assume it's valid if it has a 'version' field
      if (manifest.version) {
        console.info('Manifest validation successful.', { manifest, timestamp: new Date().toISOString() });
        return true;
      } else {
        throw new Error('Manifest validation failed.');
      }
    } catch (err) {
      console.error('Manifest validation failed.', err, { timestamp: new Date().toISOString() });
      throw new Error('Manifest validation failed.');
    }
  }

  /**
   * Cleans up the specified directory by removing it recursively.
   * @param {string} pathToDelete - The path to the directory to delete.
   */
  async cleanup(pathToDelete) {
    try {
      logger.info(`Cleaning up directory: ${pathToDelete}`);
      await fs.promises.rm(pathToDelete, { recursive: true, force: true });
      logger.info(`Directory cleaned up: ${pathToDelete}`);
    } catch (error) {
      logger.error(`Failed to clean up directory: ${pathToDelete}`, { error });
      throw new Error('Cleanup failed.');
    }
  }
}

module.exports = new ArchiveService();
