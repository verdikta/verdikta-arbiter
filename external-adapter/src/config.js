/**
 * @fileoverview Configuration management for the Chainlink External Adapter
 * @module config
 */

require('dotenv').config();

/**
 * @typedef {Object} Config
 * @property {Object} server - Server configuration
 * @property {Object} ipfs - IPFS configuration
 * @property {Object} ai - AI Node configuration
 * @property {Object} retry - Retry configuration
 * @property {Object} temp - Temporary directory configuration
 */
const config = {
  server: {
    port: process.env.PORT || 8080,
    host: process.env.HOST || '0.0.0.0',
  },
  ipfs: {
    gateway: process.env.IPFS_GATEWAY || 'https://ipfs.io',
    pinningService: process.env.IPFS_PINNING_SERVICE || 'https://api.pinata.cloud',
    pinningKey: process.env.IPFS_PINNING_KEY || 'SCaXFElLUP98fCFWmb47vekse78ZZ6-67GoP06RdtDWYyB4P0NOFKtAZiUZVjaP4',
  },
  ai: {
    nodeUrl: process.env.AI_NODE_URL || 'http://localhost:3000',
    timeout: parseInt(process.env.AI_TIMEOUT) || 150000,
  },
  retry: {
    attempts: 3,
    factor: 2,
    minTimeout: 1000,
    maxTimeout: 4000,
  },
  temp: {
    dir: process.env.TEMP_DIR || './tmp',
  }
};

module.exports = config; 
