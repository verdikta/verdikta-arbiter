const axios = require('axios');
const retry = require('retry');
const config = require('../config');
const { createClient } = require('@verdikta/common');
const path = require('path');
const { summarizePayload } = require('../utils/payloadSummary');
const fs = require('fs');
const { readEvidenceFile, resolveAttachmentPath, isUnsafeEvidenceError } = require('../utils/evidenceBoundary');
const { WorkBudgetError, isWorkBudgetError, workBudgetFromEnv, assertJuryBudget } = require('../utils/workBudget');
const { validServiceToken } = require('../utils/serviceAuth');

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

  // Text: the whole file is valid UTF-8 with no control characters but tab and line
  // breaks. Text in any language counts; it used to be printable ASCII in the first 100
  // bytes, so a file opening with non-ASCII text went to the AI node as opaque base64
  // and reached the models without the quoting text attachments get.
  if (isPlainText(buffer)) return 'text/plain';

  // Default to octet-stream for unknown types
  return 'application/octet-stream';
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });
function isPlainText(buffer) {
  let text;
  try {
    text = UTF8.decode(buffer);
  } catch {
    return false;
  }
  // eslint-disable-next-line no-control-regex -- text files hold no other control characters
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

/**
 * The AI node's scores must be what a commit can carry: integers from 0 to 1,000,000. Anything
 * else fails this attempt (transient: no commit) instead of reaching BigInt/abi.encode or the
 * aggregator as an extreme value.
 */
function committableScoresProblem(data) {
  const scores = data && data.scores;
  if (!Array.isArray(scores) || scores.length === 0 ||
      scores.some(s => !s || !Number.isSafeInteger(s.score) || s.score < 0 || s.score > 1000000)) {
    return 'AI Node returned scores that are not integers from 0 to 1,000,000';
  }
  return null;
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

/**
 * The name an attachment had in its archive (e.g. "submission/medium_article.png"),
 * falling back to its manifest name, then to the file on disk.
 */
function attachmentName(file, filePath) {
  return file.filename || file.name || path.basename(filePath);
}

/**
 * Count and size the attachments a run would read, before reading any (utils/workBudget.js). Every
 * entry counts, so one CID listed under many names is counted (and sized) as often as it is sent.
 * Entries the run would skip (no path or filename, missing files) are skipped here too; an unsafe
 * one throws, as the read would.
 */
function assertAttachmentBudget(query, extractedPath, evidenceRoots, manifest, budget) {
  const entries = [
    ...(Array.isArray(query.additional) ? query.additional.map(file => [file, evidenceRoots]) : []),
    ...(manifest && Array.isArray(manifest.support) ? manifest.support.map(file => [file, [extractedPath]]) : [])
  ].filter(([file]) => file && (file.path || file.filename));
  if (entries.length > budget.maxAttachments) {
    throw new WorkBudgetError(`${entries.length} attachments (at most ${budget.maxAttachments})`);
  }
  let bytes = 0;
  for (const [file, roots] of entries) {
    let stat;
    try {
      stat = fs.lstatSync(resolveAttachmentPath(roots, file));
    } catch (error) {
      if (isUnsafeEvidenceError(error)) throw error;
      continue; // unreadable: the run skips it as well
    }
    bytes += stat.size;
    if (bytes > budget.maxAttachmentBytes) {
      throw new WorkBudgetError(`attachments over ${budget.maxAttachmentBytes} bytes`);
    }
  }
}

/**
 * Whether a failed AI Node call may be retried. Not a timeout: the AI Node does not abort a jury that
 * ran past its deadline, so a retry starts a second full jury while the first is still being paid for.
 */
function retryable(error) {
  if (error.response?.status === 408 || error.response?.data?.timeout === true) return false;
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return false;
  return true;
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

  async evaluate(query, extractedPath, runTag = '', evidenceRoots = [extractedPath]) {
    const token = process.env.AI_NODE_API_TOKEN;
    if (!validServiceToken(token)) throw new Error('AI Node service authentication is not configured');
    const requestStartTime = Date.now();
    // The work this request asks for, refused before any model call (utils/workBudget.js).
    const budget = workBudgetFromEnv();
    assertJuryBudget(query, budget);
    if (extractedPath) {
      const manifest = JSON.parse(await readEvidenceFile([extractedPath], { filename: 'manifest.json' }, 'utf8'));
      assertAttachmentBudget(query, extractedPath, evidenceRoots, manifest, budget);
    }
    return new Promise((resolve, reject) => {
      const operation = retry.operation(this.retryOptions);
      
      operation.attempt(async (currentAttempt) => {
        const tEvalStart = Date.now();
        try {
          logger.info(`${runTag} Sending evaluation request to AI Node, attempt ${currentAttempt}`);
          
          let manifest;
          let attachments = [];
          // Original file names, index-aligned with attachments; the AI Node uses them
          // to name an image it had to split or omit.
          let attachmentNames = [];
          // Who supplied each attachment, index-aligned: 'requester' or 'submitted'. The AI
          // node quotes text attachments and only labels a requester file as one on this word.
          let attachmentSources = [];
          
          if (extractedPath) {
            // Read manifest if path provided
            const tManifestStart = Date.now();
            manifest = JSON.parse(await readEvidenceFile([extractedPath], { filename: 'manifest.json' }, 'utf8'));
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
                  let filePath;
                  
                  // Use file.path if available, otherwise construct from extractedPath and filename
                  if (file.path) {
                    filePath = file.path;
                  } else if (file.filename) {
                    filePath = path.join(extractedPath, file.filename);
                  } else {
                    logger.warn(`${runTag} File has neither path nor filename:`, file);
                    continue;
                  }
                  
                  const tFileStart = Date.now();
                  fileData = await readEvidenceFile(evidenceRoots, file);
                  
                  // Detect MIME type from file content if not provided or if it's a generic type
                  // "ipfs/cid" says where the manifest parser fetched the file from, not what it is
                  let mimeType = file.type;
                  if (!mimeType || mimeType === 'UTF8' || mimeType === 'application/octet-stream' || mimeType === 'ipfs/cid') {
                    mimeType = detectMimeType(fileData);
                    logger.info(`${runTag} Detected MIME type for additional file: ${mimeType}`);
                  }
                  
                  // Use the same encodeAttachment function for consistent formatting
                  const attachment = encodeAttachment(fileData, mimeType);
                  attachments.push(attachment);
                  attachmentNames.push(attachmentName(file, filePath));
                  attachmentSources.push(file.evidenceSource === 'submitted' ? 'submitted' : 'requester');
                  const fileProcessTime = Date.now() - tFileStart;
                  logger.info(`${runTag} Added file to attachments: ${filePath}, type: ${mimeType}, format: ${typeof attachment === 'object' ? attachment.type : 'string'}, processing time: ${fileProcessTime}ms`);
                } catch (fileError) {
                  if (isUnsafeEvidenceError(fileError)) throw fileError;
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
                  let filePath;
                  
                  // Use file.path if available, otherwise construct from extractedPath and filename
                  if (file.path) {
                    filePath = file.path;
                  } else if (file.filename) {
                    filePath = path.join(extractedPath, file.filename);
                  } else {
                    logger.warn(`${runTag} Support file has neither path nor filename:`, file);
                    continue;
                  }
                  
                  const tSupportFileStart = Date.now();
                  const fileData = await readEvidenceFile([extractedPath], file);
                  // Detect MIME type from file content
                  const mimeType = detectMimeType(fileData);
                  logger.info(`${runTag} Detected MIME type for support file: ${mimeType}`);
                  
                  const attachment = encodeAttachment(fileData, mimeType);
                  attachments.push(attachment);
                  attachmentNames.push(attachmentName(file, filePath));
                  attachmentSources.push('requester'); // support files come from the primary manifest
                  const supportFileTime = Date.now() - tSupportFileStart;
                  logger.info(`${runTag} Added support file to attachments: ${file.name || filePath}, size: ${fileData.length} bytes, type: ${mimeType}, format: ${typeof attachment === 'object' ? attachment.type : 'string'}, processing time: ${supportFileTime}ms`);
                } catch (fileError) {
                  if (isUnsafeEvidenceError(fileError)) throw fileError;
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
            attachments,
            attachmentNames,
            attachmentSources,
            requestTag: runTag || undefined
          };
          
          // If query contains outcomes array, include it in payload
          if (query.outcomes) {
            payload.outcomes = query.outcomes;
          }
          const payloadConstructTime = Date.now() - tPayloadStart;
          logger.info(`${runTag} Payload construction took ${payloadConstructTime}ms`);
          
          // Attachments are logged by shape only: their contents are the evidence
          // itself, megabytes of base64 for a single image.
          logger.info(`${runTag} Sending request to AI Node:`, summarizePayload(payload));
          logger.debug(`${runTag} Prompt:`, { prompt: payload.prompt });

          const tApiStart = Date.now();
          const response = await this.client.post('/api/rank-and-justify', payload, {
            headers: { Authorization: `Bearer ${token}` },
            // Never forward the service credential to a redirect target.
            maxRedirects: 0
          });
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
          
          const scoreProblem = committableScoresProblem(response.data);
          if (scoreProblem) {
            // a property of this answer, not of the network: no retry, no commit
            reject(new Error(scoreProblem));
            return;
          }
          resolve(response.data);
        } catch (error) {
          if (isUnsafeEvidenceError(error) || isWorkBudgetError(error)) {
            reject(error); // never omit unsafe evidence, retry it, or call the AI
            return;
          }
          const errorTime = Date.now() - tEvalStart;
          logger.error(`${runTag} AI Node error after ${errorTime}ms:`, {
            message: error.message,
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            // Never error.config.data: that is the request body, attachments included.
            config: {
              url: error.config?.url,
              method: error.config?.method,
              // Authorization headers must never reach operator logs.
            }
          });

          if (error.response?.status === 401 || error.response?.status === 403) {
            reject(new Error('AI Node service authentication failed'));
            return;
          }

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

          // Retry for non-provider errors, except a timeout (see retryable)
          if (!retryable(error)) {
            reject(error);
            return;
          }
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
module.exports.detectMimeType = detectMimeType;
module.exports.committableScoresProblem = committableScoresProblem;
module.exports.assertAttachmentBudget = assertAttachmentBudget;
