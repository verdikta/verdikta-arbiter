#!/usr/bin/env node
/*
  scripts/query-oracle-classes.js – Hardhat + ethers

  Query oracle information including registered class IDs

  Example:

HARDHAT_NETWORK=base_sepolia \
node scripts/query-oracle-classes.js \
  --aggregator 0x262f48f06DEf1FE49e0568dB4234a3478A191cFd \
  --oracle     0xD67D6508D4E5611cd6a463Dd0969Fa153Be91101 \
  --jobid      "38f19572c51041baa5f2dea284614590"

*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

/* ------------------------------------------------------------------- */
/* Minimal ABIs                                                        */
/* ------------------------------------------------------------------- */
const AggregatorABI = [
  "function reputationKeeper() view returns (address)",
  "function getContractConfig() view returns (address oracleAddr,address linkAddr,bytes32 jobId,uint256 fee)"
];

const KeeperABI = [
  "function registerOracle(address,bytes32,uint256,uint64[])",
  "function getOracleInfo(address,bytes32) view returns (bool isActive,int256 reputation,int256 minReputation,uint256 fee,bytes32 jobId,uint256 lastChallenged,uint256 lastResponse,uint256 stakedAmount,bool inDispute)",
  "function getOracleClasses(address,bytes32) view returns (uint64[])",
  "function getOracleClass(address,bytes32) view returns (uint64)",
  "function getLastOracleResponse(address,bytes32) view returns (uint256)",
  "function getValidChain(uint64) view returns (bool)"
];

/* Helpers ------------------------------------------------------------ */
const toBytes32 = (id) => {
  if (/^0x[0-9a-f]{64}$/i.test(id)) return id;             // already bytes32
  const bytes = ethers.toUtf8Bytes(id);
  if (bytes.length > 32) throw new Error(`Job ID too long: ${id}`);
  return ethers.hexlify(bytes).padEnd(66, "0");
};

/* ------------------------------------------------------------------- */
/* Main                                                                */
/* ------------------------------------------------------------------- */
(async () => {
  try {
    /* Args ------------------------------------------------------------ */
    const argv = yargs(hideBin(process.argv))
      .option("aggregator", { alias: "a", type: "string", demandOption: true })
      .option("oracle",     { alias: "o", type: "string", demandOption: true })
      .option("jobid",      { alias: "j", type: "string", demandOption: true })
      .strict()
      .argv;

    /* Contracts ------------------------------------------------------- */
    const provider = ethers.provider;
    const aggregator = new ethers.Contract(argv.aggregator, AggregatorABI, provider);

    const keeperAddr = await aggregator.reputationKeeper();
    console.log("ReputationKeeper:", keeperAddr);

    const keeper = new ethers.Contract(keeperAddr, KeeperABI, provider);
    const oracleAddr = argv.oracle;
    const jobId = toBytes32(argv.jobid);

    console.log(`\nQuerying information for Oracle: ${oracleAddr}`);
    console.log(`JobID: ${argv.jobid} → ${jobId}`);

    /* Get Oracle Info ------------------------------------------------- */
    const info = await keeper.getOracleInfo(oracleAddr, jobId);
    
    console.log("\nOracle Status:");
    console.log("  Active:", info.isActive);
    console.log("  Reputation:", info.reputation.toString());
    console.log("  Min Reputation:", info.minReputation.toString());
    console.log("  Fee:", ethers.formatEther(info.fee), "LINK");
    console.log("  Staked Amount:", ethers.formatEther(info.stakedAmount), "wVDKA");

    if (!info.isActive) {
      console.log("This oracle is not registered for the given job ID.");
      process.exit(0);
    }

    /* Get Oracle Class ------------------------------------------------- */
    try {
      // Try the direct getOracleClass method first
      const classId = await keeper.getOracleClass(oracleAddr, jobId);
      console.log("\nRegistered Class ID:", classId.toString());

      // Check if this class is valid
      try {
        const isValid = await keeper.getValidChain(classId);
        console.log("  Valid Chain:", isValid);
      } catch (error) {
        console.log("  Could not verify chain validity");
      }
    } catch (error) {
      console.log("\nCould not retrieve class directly. This likely means class ID is 128 (default).");
      console.log("Alternative class validation methods failed:", error.message);
    }

    process.exit(0);
  } catch (err) {
    console.error("Error querying oracle information:", err);
    process.exit(1);
  }
})(); 