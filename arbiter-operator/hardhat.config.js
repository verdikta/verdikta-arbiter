require("dotenv").config();
const https = require("https");
require("@nomicfoundation/hardhat-toolbox");
require("hardhat-deploy");

// ──────────────────────────────────────────────────────────────────────────
// 1. Keep the Truffle variable names
//    PRIVATE_KEY  → primary / owner / deployer
//    PRIVATE_KEY_2→ secondary (optional)
// ──────────────────────────────────────────────────────────────────────────
const ACCOUNTS = [process.env.PRIVATE_KEY, process.env.PRIVATE_KEY_2].filter(Boolean);

const keepAliveAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 60_000 });

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    // NOTE: We want to use 0.8.30 for our contracts in the future, but
    // we're currently limited by Chainlink contracts pinned to 0.8.19.
    // When Chainlink contracts support 0.8.30, we'll update both.
    compilers: [
      {
        version: "0.8.19",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    ],
  },

  networks: {
    development: {
      url: "http://127.0.0.1:8545",
      accounts: ACCOUNTS,          // signer[0] == PRIVATE_KEY
    },

    sepolia: {
      url: `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`,
      httpAgent: keepAliveAgent,
      httpsAgent: keepAliveAgent,
      chainId: 11155111,
      gas: 18_500_000,
      gasPrice: 10_000_000_000,
      accounts: ACCOUNTS,
    },

    base_sepolia: {
      url: `https://base-sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`,
      httpAgent: keepAliveAgent,
      httpsAgent: keepAliveAgent,
      chainId: 84532,
      gas: 10_000_000,
      gasPrice: 5_000_000_000,
      accounts: ACCOUNTS,
    },

    base_mainnet: {
      url: `https://base-mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`,
      httpAgent: keepAliveAgent,
      httpsAgent: keepAliveAgent,
      chainId: 8453,
      gas: 10_000_000,
      gasPrice: 20_000_000, // 0.02 gwei - lower than testnet
      accounts: ACCOUNTS,
    },
  },

  // hardhat-deploy "named accounts"
  namedAccounts: {
    deployer: 0,   // signer[0]  → PRIVATE_KEY   (operator/keeper owner)
    owner:    0,   // optional friendly alias
  },

  etherscan: {
    apiKey: {
      sepolia:      process.env.ETHERSCAN_API_KEY,
      base_sepolia: process.env.BASESCAN_API_KEY,
      base_mainnet: process.env.BASESCAN_API_KEY,
    },
    customChains: [
      {
        network:  "base_sepolia",
        chainId:  84532,
        urls: {
          apiURL:     "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      {
        network:  "base_mainnet",
        chainId:  8453,
        urls: {
          apiURL:     "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
    ],
  },

  mocha: { timeout: 100_000 },
};

