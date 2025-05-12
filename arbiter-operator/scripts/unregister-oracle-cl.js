#!/usr/bin/env node
/*
  scripts/unregister-oracle-cl.js – Hardhat + ethers

  CLI flags match the original Truffle version.

  Example:

HARDHAT_NETWORK=base_sepolia \

HARDHAT_NETWORK=base_sepolia node scripts/unregister-oracle-cl.js \
  --aggregator 0x262f48f06DEf1FE49e0568dB4234a3478A191cFd \
  --oracle 0xD67D6508D4E5611cd6a463Dd0969Fa153Be91101 \
  --wrappedverdikta 0x2F1d1aF9d5C25A48C29f56f57c7BAFFa7cc910a3 \
  --jobids "38f19572c51041baa5f2dea284614590" \
          "39515f75ac2947beb7f2eeae4d8eaf3e" \
          "cdee0a127bc74a5188cbabf7aadcc84f"

*/

require("dotenv").config();
const hre   = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

/* ------------------------------------------------------------------- */
/* Minimal ABIs                                                        */
/* ------------------------------------------------------------------- */
const AggregatorABI = [
  "function reputationKeeper() view returns (address)"
];

const KeeperABI = [
  "function deregisterOracle(address,bytes32)",
  "function getOracleInfo(address,bytes32) view returns (bool isActive,int256,int256,uint256,bytes32,uint256,uint256,uint256,bool)",
  "function owner() view returns (address)"
];

const ERC20_BALANCE = [
  "function balanceOf(address) view returns (uint256)"
];

const OWNER_ABI = [
  "function owner() view returns (address)"
];

/* Helper: accept bytes32 or plain text ID --------------------------- */
const toBytes32 = (id) => {
  if (/^0x[0-9a-f]{64}$/i.test(id)) return id;          // already bytes32
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
      .option("aggregator",      { alias: "a", type: "string", demandOption: true })
      .option("oracle",          { alias: "o", type: "string", demandOption: true })
      .option("wrappedverdikta", { alias: "w", type: "string", demandOption: true })
      .option("jobids",          { alias: "j", type: "array",  demandOption: true })
      .strict()
      .argv;

    const [signer] = await ethers.getSigners();
    const caller   = await signer.getAddress();
    console.log("Caller:", caller);

    /* Resolve keeper -------------------------------------------------- */
    const aggregator = new ethers.Contract(argv.aggregator, AggregatorABI, signer);
    const keeperAddr = await aggregator.reputationKeeper();
    console.log("ReputationKeeper:", keeperAddr);

    const keeper = new ethers.Contract(keeperAddr, KeeperABI, signer);

    /* Auth check (keeper owner OR oracle owner) ----------------------- */
    const [oracleOwner, keeperOwner] = await Promise.all([
      new ethers.Contract(argv.oracle, OWNER_ABI, signer).owner(),
      keeper.owner(),
    ]);

    if (
      caller.toLowerCase() !== oracleOwner.toLowerCase() &&
      caller.toLowerCase() !== keeperOwner.toLowerCase()
    ) {
      throw new Error("Caller must be oracle owner or ReputationKeeper owner");
    }

    /* wVDKA balance before ------------------------------------------- */
    const verdikta = new ethers.Contract(argv.wrappedverdikta, ERC20_BALANCE, signer);
    const balBefore = await verdikta.balanceOf(caller);
    console.log("Initial wVDKA balance:", ethers.formatEther(balBefore));

    /* Loop through job IDs ------------------------------------------- */
    for (const rawId of argv.jobids) {
      const jobId = toBytes32(rawId);
      console.log(`\nJobID ${rawId} → ${jobId}`);

      const info = await keeper.getOracleInfo(argv.oracle, jobId);
      if (!info.isActive) {
        console.log("Not registered – skipping");
        continue;
      }

      console.log("Calling deregisterOracle…");
      const tx = await keeper.deregisterOracle(argv.oracle, jobId);
      await tx.wait();
      console.log("✓ Deregistered (tx:", tx.hash, ")");
    }

    /* wVDKA balance after -------------------------------------------- */
    const balAfter = await verdikta.balanceOf(caller);
    console.log("\nFinal wVDKA balance:", ethers.formatEther(balAfter));
    console.log("Oracle deregistration completed successfully");
    process.exit(0);
  } catch (err) {
    console.error("Error during oracle deregistration:", err);
    process.exit(1);
  }
})();

