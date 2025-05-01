/**
 * Use this file to configure your truffle project.
 */
require('dotenv').config();
const HDWalletProvider = require('@truffle/hdwallet-provider');

// Configure multiple RPC endpoints to provide fallbacks
const getProvider = (privateKey) => {
  // Primary endpoint with Infura
  const endpoints = [
    `https://base-sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`,
  ];
  
  // Add public RPC endpoints as fallbacks
  endpoints.push(
    "https://sepolia.base.org",
    "https://base-sepolia-rpc.publicnode.com",
    "https://base-sepolia.blockpi.network/v1/rpc/public"
  );
  
  return () => new HDWalletProvider({
    privateKeys: [privateKey],
    providerOrUrl: endpoints[0],
    pollingInterval: 30000, // Reduce polling frequency (30 seconds)
    networkCheckTimeout: 240000, // 4 minutes
    timeoutBlocks: 200,
  });
};

module.exports = {
  networks: {
    development: {
     host: "127.0.0.1",
     port: 8545,
     network_id: "*",
    },
    baseSepolia: {
      provider: getProvider(process.env.PRIVATE_KEY),
      network_id: 84532,
      confirmations: 2,
      timeoutBlocks: 200,
      skipDryRun: true,
      gasPrice: 1000000000, // 1 gwei
      networkCheckTimeout: 240000, // 4 minutes
      deploymentPollingInterval: 30000, // Reduce deployment polling (30 seconds)
    }
  },
  compilers: {
    solc: {
      version: "0.8.19",
      settings: {
        optimizer: {
          enabled: true,
          runs: 200
        }
      }
    }
  }
}; 