/**
 * @fileoverview Configuration management for the Chainlink External Adapter
 * @module config
 */

require('dotenv').config();

const { buildIpfsGatewayConfig } = require('./utils/ipfsGatewayConfig');

// Operator-preferred IPFS gateways (IPFS_GATEWAY, comma-separated, tried
// first) and the optional dedicated-gateway key (IPFS_GATEWAY_TOKEN). No
// default: an empty list means "use @verdikta/common's built-in order".
const ipfsGatewayConfig = buildIpfsGatewayConfig(process.env).ipfs;

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
    ...ipfsGatewayConfig,
    // First operator gateway, for callers that still read the singular form.
    gateway: ipfsGatewayConfig.gateways ? ipfsGatewayConfig.gateways[0] : undefined,
    pinningService: process.env.IPFS_PINNING_SERVICE || 'https://api.pinata.cloud',
    // No hardcoded fallback: a missing IPFS_PINNING_KEY should be a loud,
    // clear failure rather than a silent fallback to a bogus default that
    // produces an opaque 401 from Pinata at request time. Operators should
    // populate external-adapter/.env via the installer or
    // installer/util/update-pinata-key.sh.
    pinningKey: process.env.IPFS_PINNING_KEY,
  },
  ai: {
    nodeUrl: process.env.AI_NODE_URL || 'http://localhost:3000',
    timeout: parseInt(process.env.AI_TIMEOUT) || 300000,
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
