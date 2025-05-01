require('dotenv').config();
const HDWalletProvider = require('@truffle/hdwallet-provider');
const https = require("https");
const fetch = require("node-fetch");

module.exports = {
  networks: {
    // Development network configuration (commented out for reference)
    // development: {
    //  host: "127.0.0.1",
    //  port: 8545,
    //  network_id: "*",
    // },

    // Sepolia configuration
    sepolia: {
      provider: () => {
        // Create a custom HTTPS agent with keep-alive
        const agent = new https.Agent({
          keepAlive: true,
          keepAliveMsecs: 60 * 1000 // Keep sockets around for 60 seconds
        });

        // Return an HDWalletProvider using the custom fetch
        return new HDWalletProvider({
          privateKeys: [
            process.env.PRIVATE_KEY
          ],
          providerOrUrl: `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`,
          // Override the default 'fetch' so it uses our custom agent
          fetch: (url, options) => fetch(url, { ...options, agent })
        });
      },
      network_id: 11155111,  // Sepolia network ID
      chain_id: 11155111,    // Sepolia chain ID
      gas: 13000000,
      gasPrice: 10000000000,  // 10 gwei
      confirmations: 2,
      timeoutBlocks: 200,
      networkCheckTimeout: 30000,
      skipDryRun: true
    },

    // Base Sepolia configuration
    base_sepolia: {
      provider: () => {
        // Create a custom HTTPS agent with keep-alive
        const agent = new https.Agent({
          keepAlive: true,
          keepAliveMsecs: 60 * 1000 // Keep sockets around for 60 seconds
        });

        // Return an HDWalletProvider using the custom fetch
        return new HDWalletProvider({
          privateKeys: [
            process.env.PRIVATE_KEY
          ],
          providerOrUrl: `https://base-sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`,
          // Override the default 'fetch' so it uses our custom agent
          fetch: (url, options) => fetch(url, { ...options, agent })
        });
      },
      network_id: 84532,       // Base Sepolia network ID
      chain_id: 84532,         // Base Sepolia chain ID
      gas: 10000000,           // Gas limit
      gasPrice: 1000000000,    // Gas price (1 Gwei)
      confirmations: 2,        // # of confirmations to wait between deployments
      timeoutBlocks: 400,      // # of blocks before a deployment times out
      networkCheckTimeout: 30000, // Milliseconds to wait for network to start (1/2 minute)
      skipDryRun: true         // Skip dry run before migrations
    },
  },

  plugins: ['truffle-plugin-verify'],
  
  // API keys for verification
  api_keys: {
    etherscan: process.env.ETHERSCAN_API_KEY,
    basescan: process.env.BASESCAN_API_KEY // Add this for Base verification
  },
  
  // Set default mocha options here, use special reporters, etc.
  mocha: {
    timeout: 100000
  },

  // Configure your compilers
  compilers: {
    solc: {
      version: "0.8.21",
      settings: {
        optimizer: {
          enabled: true,
          runs: 200
        },
      }
    }
  },
};

