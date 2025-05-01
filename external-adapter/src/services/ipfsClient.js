const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const fetch = require('node-fetch');
const retry = require('retry');
const logger = require('../utils/logger');

class IPFSClient {
  constructor() {
    // Multiple public gateways for fetching with fallbacks
    this.gateways = [
      'https://ipfs.io',
      'https://cloudflare-ipfs.com',
      'https://gateway.pinata.cloud',
      'https://dweb.link'
    ];
    // Pinata service for uploading
    this.pinningService = config.ipfs.pinningService.replace(/\/$/, '');
    this.pinningKey = config.ipfs.pinningKey;
    this.timeout = 30000;
    this.controllers = new Set();
    this.retryOptions = {
      retries: 5, // Increased from 3
      factor: 2,
      minTimeout: 1000,
      maxTimeout: 15000, // Increased from 10000
      randomize: true
    };
    
    logger.info('IPFSClient initialized with:', {
      gateways: this.gateways,
      pinningService: this.pinningService,
      pinningKeyExists: !!this.pinningKey,
      pinningKeyLength: this.pinningKey ? this.pinningKey.length : 0,
      retryConfig: this.retryOptions
    });
  }

  async fetchFromIPFS(cid) {
    return new Promise((resolve, reject) => {
      const operation = retry.operation(this.retryOptions);
      
      operation.attempt(async (currentAttempt) => {
        // Try each gateway in sequence for each retry
        const gatewayIndex = (currentAttempt - 1) % this.gateways.length;
        const gateway = this.gateways[gatewayIndex];
        const url = `${gateway}/ipfs/${cid.trim()}`;
        
        logger.info('Attempting IPFS fetch:', { 
          url,
          cid: cid.trim(),
          gateway,
          attempt: currentAttempt,
          gatewayIndex
        });

        const controller = new AbortController();
        this.controllers.add(controller);
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'Verdikta-External-Adapter/1.0'
            }
          });

          clearTimeout(timeoutId);
          this.controllers.delete(controller);

          logger.info('IPFS fetch response:', {
            status: response.status,
            statusText: response.statusText,
            ok: response.ok,
            url: response.url,
            attempt: currentAttempt,
            gateway
          });

          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          const buffer = await response.arrayBuffer();
          const result = Buffer.from(buffer);

          // Validate the response has actual content
          if (result.length === 0) {
            throw new Error('Empty response received');
          }

          logger.info('Successfully fetched from IPFS', {
            gateway,
            attempt: currentAttempt,
            responseSize: result.length
          });

          resolve(result);
        } catch (error) {
          clearTimeout(timeoutId);
          this.controllers.delete(controller);

          logger.error('IPFS fetch error:', {
            gateway,
            attempt: currentAttempt,
            error: error.message,
            name: error.name
          });

          if (error.name === 'AbortError') {
            logger.warn('Request timed out, will retry with next gateway');
          }

          // Determine if we should retry
          if (operation.retry(error)) {
            logger.info('Retrying with next gateway...', {
              remainingAttempts: operation.mainError().retries - currentAttempt
            });
            return;
          }

          // If we're out of retries, reject with a detailed error
          const finalError = new Error(`Failed to fetch from IPFS after ${currentAttempt} attempts across ${this.gateways.length} gateways: ${error.message}`);
          reject(finalError);
        }
      });
    });
  }

  async uploadToIPFS(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    return new Promise((resolve, reject) => {
      const operation = retry.operation(this.retryOptions);

      operation.attempt(async (currentAttempt) => {
        try {
          logger.info(`Attempting to upload to IPFS (attempt ${currentAttempt})`);
          
          const form = new FormData();
          const fileStream = fs.createReadStream(filePath);
          
          // Debug file stream
          logger.info('File stream details:', {
            path: filePath,
            exists: fs.existsSync(filePath),
            stats: fs.statSync(filePath),
            streamReadable: fileStream.readable,
            attempt: currentAttempt
          });

          // Add file to form
          form.append('file', fileStream);

          const controller = new AbortController();
          this.controllers.add(controller);
          const timeoutId = setTimeout(() => controller.abort(), this.timeout);

          // Get form headers
          const formHeaders = form.getHeaders();
          
          logger.info('Request details:', {
            url: `${this.pinningService}/pinning/pinFileToIPFS`,
            method: 'POST',
            headers: {
              ...formHeaders,
              'Authorization': '[REDACTED]'
            },
            attempt: currentAttempt
          });

          // Use node-fetch with proper stream handling
          const response = await fetch(`${this.pinningService}/pinning/pinFileToIPFS`, {
            method: 'POST',
            body: form,
            headers: {
              ...formHeaders,
              'Authorization': `Bearer ${this.pinningKey}`
            },
            signal: controller.signal
          });

          clearTimeout(timeoutId);
          this.controllers.delete(controller);

          if (!response.ok) {
            const errorBody = await response.text();
            logger.error('Upload error details:', {
              status: response.status,
              statusText: response.statusText,
              body: errorBody,
              attempt: currentAttempt
            });
            
            // For certain status codes, we don't want to retry
            if (response.status === 401 || response.status === 403) {
              reject(new Error(`Upload failed: Authentication error (${response.status})`));
              return;
            }
            
            throw new Error(`Upload failed with status: ${response.status}`);
          }

          const data = await response.json();
          logger.info(`Successfully uploaded to IPFS on attempt ${currentAttempt}`);
          resolve(data.IpfsHash);
        } catch (error) {
          logger.error('Upload error:', {
            name: error.name,
            message: error.message,
            stack: error.stack,
            attempt: currentAttempt
          });
          
          // Don't retry on authentication errors
          if (error.message && (error.message.includes('401') || error.message.includes('403'))) {
            reject(error);
            return;
          }

          if (operation.retry(error)) {
            logger.info(`Retrying upload after error on attempt ${currentAttempt}`);
            return;
          }
          
          reject(operation.mainError());
        }
      });
    });
  }

  cleanup() {
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.controllers.clear();
  }
}

module.exports = new IPFSClient(); 