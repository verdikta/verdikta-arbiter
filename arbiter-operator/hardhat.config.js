require("dotenv").config();
const https = require("https");
require("@nomicfoundation/hardhat-ethers");
require("hardhat-deploy");
// Compile with the exact local compiler, including in offline test runs.
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }, _hre, runSuper) => {
  if (solcVersion !== "0.8.19") return runSuper();
  const solc = require("solc");
  if (!solc.version().startsWith("0.8.19+")) throw new Error("Install the pinned solc 0.8.19 compiler");
  return { compilerPath: require.resolve("solc/soljson.js"), isSolcJs: true, version: solcVersion, longVersion: solc.version() };
});

// ──────────────────────────────────────────────────────────────────────────
// 1. Keep the Truffle variable names
//    PRIVATE_KEY  → primary / owner / deployer
//    PRIVATE_KEY_2→ secondary (optional)
// ──────────────────────────────────────────────────────────────────────────
const ACCOUNTS = [process.env.PRIVATE_KEY, process.env.PRIVATE_KEY_2].filter(Boolean);

const keepAliveAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 60_000 });

const firstRpcFromList = (value) => {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, "").replace(/;+\s*$/, "");
  const first = normalized.split(";")[0];
  return first || "";
};

const rpcUrlForNetwork = ({ directEnv, listEnv, infuraUrl }) => {
  if (directEnv) return directEnv;
  const listFirst = firstRpcFromList(listEnv);
  if (listFirst) return listFirst;
  return infuraUrl;
};

// ──────────────────────────────────────────────────────────────────────────
// 2. Gas price: the network's, unless VERDIKTA_GAS_PRICE_GWEI pins one
//
//    "auto" is Hardhat's own default: an EIP-1559 transaction whose max fee is
//    the next block's base fee with room for two full blocks, plus the last
//    block's median tip. It pays the base fee and that tip, nothing more.
//
//    Until 2026-11 these networks had fixed prices here (5 gwei on Base
//    Sepolia, 1 gwei on Base). A fixed price is sent as a legacy transaction,
//    which pays all of it: on 2026-11-21 Base Sepolia asked 0.005 gwei, one
//    deregisterOracle cost 0.0009 ETH instead of about 0.000001, and ten of
//    them emptied an owner wallet in the middle of a job-count change.
//
//    VERDIKTA_GAS_PRICE_GWEI=<gwei> (in the environment of the command, or in
//    this directory's .env) pins a legacy price again: for an RPC endpoint
//    with no eth_feeHistory, or to push a transaction through a fee spike.
//
//    Keep this in this file: configure-node.sh and deploy-contracts.sh copy
//    hardhat.config.js alone into a build directory, so it can require nothing
//    of ours.
// ──────────────────────────────────────────────────────────────────────────
const MAX_PINNED_GAS_PRICE_GWEI = 500;
const gasPriceSetting = (env = process.env) => {
  const raw = String(env.VERDIKTA_GAS_PRICE_GWEI ?? "").trim();
  if (raw === "" || raw.toLowerCase() === "auto") return "auto";
  const problem = (why) =>
    new Error(`VERDIKTA_GAS_PRICE_GWEI="${raw}" ${why}. Give a gas price in gwei (for example 0.05), or leave it unset to pay the network's price.`);
  if (!/^[0-9]+(\.[0-9]{1,9})?$/.test(raw)) throw problem("is not a decimal number of gwei");
  const [whole, fraction = ""] = raw.split(".");
  const wei = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
  if (wei === 0n) throw problem("is zero");
  if (wei > BigInt(MAX_PINNED_GAS_PRICE_GWEI) * 1_000_000_000n) throw problem(`is above ${MAX_PINNED_GAS_PRICE_GWEI} gwei`);
  return Number(wei);
};
const GAS_PRICE = gasPriceSetting();

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
      url: rpcUrlForNetwork({
        directEnv: process.env.SEPOLIA_RPC_URL,
        listEnv: process.env.SEPOLIA_RPC_HTTP_URLS,
        infuraUrl: `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`,
      }),
      httpAgent: keepAliveAgent,
      httpsAgent: keepAliveAgent,
      chainId: 11155111,
      gas: 18_500_000,
      gasPrice: GAS_PRICE,
      accounts: ACCOUNTS,
    },

    base_sepolia: {
      url: rpcUrlForNetwork({
        directEnv: process.env.BASE_SEPOLIA_RPC_URL,
        listEnv: process.env.BASE_SEPOLIA_RPC_HTTP_URLS,
        infuraUrl: `https://base-sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`,
      }),
      httpAgent: keepAliveAgent,
      httpsAgent: keepAliveAgent,
      chainId: 84532,
      gas: 10_000_000,
      gasPrice: GAS_PRICE,
      accounts: ACCOUNTS,
    },

    base_mainnet: {
      url: rpcUrlForNetwork({
        directEnv: process.env.BASE_MAINNET_RPC_URL,
        listEnv: process.env.BASE_MAINNET_RPC_HTTP_URLS,
        infuraUrl: `https://base-mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`,
      }),
      httpAgent: keepAliveAgent,
      httpsAgent: keepAliveAgent,
      chainId: 8453,
      // Remove hardcoded gas limit to let ethers estimate it
      // gas: 10_000_000,  
      gasPrice: GAS_PRICE,
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

