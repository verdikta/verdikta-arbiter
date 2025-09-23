const axios = require('axios');
const retry = require('retry');
const config = require('../config');
const { createClient } = require('@verdikta/common');
const fs = require('fs').promises;
const path = require('path');

// Initialize verdikta-common client for logging
const verdikta = createClient({
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    console: true,
    file: false,
    // Disable colors when output is not a TTY or when explicitly disabled
    colors: process.env.DISABLE_COLORS === 'true' ? false : process.stdout.isTTY
  }
});
const { logger } = verdikta;

function detectMimeType(buffer) {
  // Check for WEBP signature
  // WEBP files start with "RIFF" followed by 4 bytes, then "WEBP"
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && // 'R' 'I'
      buffer[2] === 0x46 && buffer[3] === 0x46 && // 'F' 'F'
      buffer[8] === 0x57 && buffer[9] === 0x45 && // 'W' 'E'
      buffer[10] === 0x42 && buffer[11] === 0x50) { // 'B' 'P'
    return 'image/webp';
  }

  // Check for PNG signature
  if (buffer.length >= 8 && 
      buffer[0] === 0x89 && buffer[1] === 0x50 && 
      buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'image/png';
  }
  
  // Check for JPEG signature
  if (buffer.length >= 2 && 
      buffer[0] === 0xFF && buffer[1] === 0xD8) {
    return 'image/jpeg';
  }

  // Check for GIF signature
  if (buffer.length >= 6 &&
      buffer[0] === 0x47 && buffer[1] === 0x49 && // 'G' 'I'
      buffer[2] === 0x46 && buffer[3] === 0x38 && // 'F' '8'
      (buffer[4] === 0x37 || buffer[4] === 0x39) && // '7' or '9'
      buffer[5] === 0x61) { // 'a'
    return 'image/gif';
  }

  // Check for SVG (text-based, look for <?xml or <svg)
  if (buffer.length >= 5) {
    const start = buffer.toString('ascii', 0, 5).toLowerCase();
    if (start.includes('<?xml') || start.includes('<svg')) {
      return 'image/svg+xml';
    }
  }

  // For text files, try to detect if it's UTF-8 text
  try {
    const textSample = buffer.toString('utf8', 0, Math.min(buffer.length, 100));
    // If we can decode it as UTF-8 and it contains mostly printable characters
    if (/^[\x20-\x7E\n\r\t]*$/.test(textSample)) {
      return 'text/plain';
    }
  } catch (e) {
    // Not UTF-8 text, continue to default
  }

  // Default to octet-stream for unknown types
  return 'application/octet-stream';
}

function encodeAttachment(fileData, mimeType) {
  // If fileData is already a string, assume it's properly formatted
  if (typeof fileData === 'string') {
    return fileData;
  }
  
  // If it's a Buffer, encode it properly
  if (Buffer.isBuffer(fileData)) {
    // For images, use proper MIME type and format exactly as AI node expects
    if (mimeType.startsWith('image/')) {
      // Create a data URI for images
      const base64Data = fileData.toString('base64');
      logger.info(`Encoded image with MIME type ${mimeType}, base64 length: ${base64Data.length}`);
      return `data:${mimeType};base64,${base64Data}`;
    }
    // For text files, return as a data URI but without base64 encoding
    if (mimeType === 'text/plain') {
      const textContent = fileData.toString('utf8');
      logger.info(`Encoded text with length: ${textContent.length}`);
      
      // Raw text content as string - server will process this as a non-image attachment
      return textContent;
    }
    // For other binary types, use base64 encoding in a data URI
    const base64Data = fileData.toString('base64');
    return `data:${mimeType};base64,${base64Data}`;
  }
  
  // If we don't know how to handle it, return as is
  return fileData;
}

class AIClient {
  constructor() {
    this.client = axios.create({
      baseURL: config.ai.nodeUrl,
      timeout: config.ai.timeout,
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    this.retryOptions = config.retry;
    logger.info(`AI Client configured`, { url: config.ai.nodeUrl, timeoutMs: config.ai.timeout });

  }

  async evaluate(query, extractedPath, runTag = '') {
    const requestStartTime = Date.now();
    return new Promise((resolve, reject) => {
      const operation = retry.operation(this.retryOptions);
      
      operation.attempt(async (currentAttempt) => {
        const tEvalStart = Date.now();
        try {
          logger.info(`${runTag} Sending evaluation request to AI Node, attempt ${currentAttempt}`);
          
          let manifest;
          let attachments = [];
          
          if (extractedPath) {
            // Read manifest if path provided
            const tManifestStart = Date.now();
            const manifestPath = path.join(extractedPath, 'manifest.json');
            manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
            const manifestReadTime = Date.now() - tManifestStart;
            logger.info(`${runTag} Manifest read took ${manifestReadTime}ms`);
            
            logger.info(`${runTag} Processing manifest for attachments:`, {
              hasAdditional: !!query.additional,
              hasSupport: !!manifest.support,
              additionalCount: query.additional?.length || 0,
              supportCount: manifest.support?.length || 0
            });

            // Load attachments from additional files if they exist
            const tAdditionalStart = Date.now();
            if (query.additional && query.additional.length > 0) {
              for (const file of query.additional) {
                try {
                  let fileData;
                  if (file.path) {
                    const tFileStart = Date.now();
                    // For both IPFS downloaded files and local files
                    fileData = await fs.readFile(file.path);
                    const mimeType = file.type === 'UTF8' ? 'text/plain' : (file.type || 'application/octet-stream');
                    
                    // Use the same encodeAttachment function for consistent formatting
                    const attachment = encodeAttachment(fileData, mimeType);
                    attachments.push(attachment);
                    const fileProcessTime = Date.now() - tFileStart;
                    logger.info(`${runTag} Added file from path to attachments: ${file.path}, type: ${mimeType}, format: ${typeof attachment === 'object' ? attachment.type : 'string'}, processing time: ${fileProcessTime}ms`);
                  }
                } catch (fileError) {
                  logger.warn(`${runTag} Failed to read file:`, fileError.message);
                  continue;
                }
              }
            }
            const additionalProcessTime = Date.now() - tAdditionalStart;
            if (query.additional && query.additional.length > 0) {
              logger.info(`${runTag} Additional files processing took ${additionalProcessTime}ms`);
            }

            // Load attachments from support files if they exist
            const tSupportStart = Date.now();
            if (manifest.support && manifest.support.length > 0) {
              for (const file of manifest.support) {
                try {
                  if (file.path) {
                    const tSupportFileStart = Date.now();
                    const fileData = await fs.readFile(file.path);
                    // Detect MIME type from file content
                    const mimeType = detectMimeType(fileData);
                    logger.info(`${runTag} Detected MIME type for support file: ${mimeType}`);
                    
                    const attachment = encodeAttachment(fileData, mimeType);
                    attachments.push(attachment);
                    const supportFileTime = Date.now() - tSupportFileStart;
                    logger.info(`${runTag} Added support file to attachments: ${file.name || file.path}, size: ${fileData.length} bytes, type: ${mimeType}, format: ${typeof attachment === 'object' ? attachment.type : 'string'}, processing time: ${supportFileTime}ms`);
                  }
                } catch (fileError) {
                  logger.error(`${runTag} Failed to read support file:`, fileError);
                  continue;
                }
              }
            }
            const supportProcessTime = Date.now() - tSupportStart;
            if (manifest.support && manifest.support.length > 0) {
              logger.info(`${runTag} Support files processing took ${supportProcessTime}ms`);
            }
          }

          const tPayloadStart = Date.now();
          const payload = {
            ...query,
            attachments
          };
          
          // If query contains outcomes array, include it in payload
          if (query.outcomes) {
            payload.outcomes = query.outcomes;
          }
          const payloadConstructTime = Date.now() - tPayloadStart;
          logger.info(`${runTag} Payload construction took ${payloadConstructTime}ms`);
          
          logger.info(`${runTag} Sending request with payload structure:`, {
            prompt: payload.prompt,
            modelsCount: payload.models.length,
            attachmentsCount: payload.attachments.length,
            outcomesCount: payload.outcomes?.length || 0,
            attachmentTypes: payload.attachments.map(a => typeof a === 'object' ? `${a.type}/${a.mediaType}` : 'unknown'),
            hasOutcomes: !!payload.outcomes,
            outcomes: payload.outcomes
          });

          // Log the full payload for debugging
          logger.info(`${runTag} Full payload:`, JSON.stringify(payload, null, 2));

          const tApiStart = Date.now();
          const response = await this.client.post('/api/rank-and-justify', payload);
          const apiCallTime = Date.now() - tApiStart;
          logger.info(`${runTag} API call to /api/rank-and-justify took ${apiCallTime}ms`);
          
          // Transform response if needed
          const tTransformStart = Date.now();
          if (response.data.score && Array.isArray(response.data.score) && query.outcomes) {
            // Map the score array to our expected format
            response.data.scores = response.data.score.map((score, index) => ({
              outcome: query.outcomes[index] || `outcome${index + 1}`,
              score
            }));
            delete response.data.score;
          }
          const transformTime = Date.now() - tTransformStart;
          logger.info(`${runTag} Response transformation took ${transformTime}ms`);
          
          const totalEvalTime = Date.now() - tEvalStart;
          logger.info(`${runTag} Total aiClient.evaluate took ${totalEvalTime}ms (attempt ${currentAttempt})`);
          
          logger.info(`${runTag} Response received:`, {
            scores: response.data?.scores?.map(s => `${s.outcome}: ${s.score}`) || [],
            justificationLength: response.data?.justification?.length || 0,
            rawResponse: response.data // Log the raw response for debugging
          });
          
          resolve(response.data);
        } catch (error) {
          const errorTime = Date.now() - tEvalStart;
          logger.error(`${runTag} AI Node error after ${errorTime}ms:`, {
            message: error.message,
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            config: {
              url: error.config?.url,
              method: error.config?.method,
              headers: error.config?.headers
            }
          });

          // --- Modified Provider Error Check ---
          let isProviderError = false;
          let providerErrorMessage = error.message; // Default to original message

          // Check status code
          if (error.response?.status === 400) {
            isProviderError = true;
            providerErrorMessage = error.response.data?.error || error.message;
          }
          // Check response data for provider-related error messages even if status is not 400
          else if (error.response?.data) {
            const errorDataString = JSON.stringify(error.response.data).toLowerCase();
            if (errorDataString.includes('provider') && (errorDataString.includes('invalid') || errorDataString.includes('not found') || errorDataString.includes('unknown')) ){
              isProviderError = true;
              providerErrorMessage = error.response.data?.error || error.response.data?.message || JSON.stringify(error.response.data);
            }
          }
          // Also check the basic error message itself
          else if (error.message && error.message.toLowerCase().includes('provider')) {
             // Simple check if the error message mentions 'provider', less reliable
             isProviderError = true;
             // Keep the original error message in this case
          }

          // If identified as a provider error, reject immediately
          if (isProviderError) {
            logger.error(`${runTag} Provider error encountered. Stopping retries.`, { providerError: providerErrorMessage });
            reject(new Error(`PROVIDER_ERROR: ${providerErrorMessage}`));
            return;
          }
          // --- End Modified Provider Error Check ---

          // Log error data if present (redundant logging removed as it's logged above)
          // if (error.response?.data) { ... }

          // Retry for non-provider errors
          if (operation.retry(error)) {
            return;
          }
          reject(operation.mainError());
        }
      });
    });
  }
}

module.exports = new AIClient(); 