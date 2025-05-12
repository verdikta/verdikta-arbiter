#!/usr/bin/env node
/*
  scripts/register-oracle-cl.js – Hardhat + ethers

  Register one or more job IDs for a given oracle, using flags identical to
  the original Truffle script.

  Example:

HARDHAT_NETWORK=base_sepolia \
node scripts/register-oracle-cl.js \
  --aggregator      0x262f48f06DEf1FE49e0568dB4234a3478A191cFd \
  --link            0xE4aB69C077896252FAFBD49EFD26B5D171A32410 \
  --oracle          0xD67D6508D4E5611cd6a463Dd0969Fa153Be91101 \
  --wrappedverdikta 0x2F1d1aF9d5C25A48C29f56f57c7BAFFa7cc910a3 \
  --jobids          "38f19572c51041baa5f2dea284614590" "39515f75ac2947beb7f2eeae4d8eaf3e" \
  --classes         128 129


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
  "function reputationKeeper() view returns (address)",
  "function getContractConfig() view returns (address oracleAddr,address linkAddr,bytes32 jobId,uint256 fee)"
];

const KeeperABI = [
  "function registerOracle(address,bytes32,uint256,uint64[])",
  "function getOracleInfo(address,bytes32) view returns (bool isActive,int256,int256,uint256,bytes32,uint256,uint256,uint256,bool)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)"
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
      .option("aggregator",      { alias: "a", type: "string", demandOption: true })
      .option("link",            { alias: "l", type: "string", demandOption: true })
      .option("oracle",          { alias: "o", type: "string", demandOption: true })
      .option("wrappedverdikta", { alias: "w", type: "string", demandOption: true })
      .option("jobids",          { alias: "j", type: "array",  demandOption: true })
      .option("classes",         { alias: "c", type: "array",  demandOption: true })
      .strict()
      .argv;

    const [signer] = await ethers.getSigners();
    const owner    = await signer.getAddress();
    console.log("Using owner:", owner);

    /* Contracts ------------------------------------------------------- */
    const provider   = ethers.provider;
    const aggregator = new ethers.Contract(argv.aggregator, AggregatorABI, provider);

    const keeperAddr = await aggregator.reputationKeeper();
    console.log("ReputationKeeper:", keeperAddr);

    const keeper     = new ethers.Contract(keeperAddr, KeeperABI, signer);
    const verdikta   = new ethers.Contract(argv.wrappedverdikta, ERC20_ABI, signer);
    const linkToken  = new ethers.Contract(argv.link,           ERC20_ABI, signer);

    const oracleAddr = argv.oracle;
    const classes    = argv.classes.map(Number);

    /* Fees & stake ---------------------------------------------------- */
    const LINK_FEE   = ethers.parseUnits("0.05", 18);  // 0.05 LINK
    const VDKA_STAKE = ethers.parseUnits("100", 18);   // 100 wVDKA
    const totalStake = VDKA_STAKE * BigInt(argv.jobids.length);

    /* wVDKA allowance (one approval covers every job) ----------------- */
    const bal = await verdikta.balanceOf(owner);
    if (bal < totalStake) throw new Error("Insufficient wVDKA");

    let allow = await verdikta.allowance(owner, keeperAddr);
    if (allow < totalStake) {
      console.log(`Approving ${ethers.formatEther(totalStake)} wVDKA…`);
      await (await verdikta.approve(keeperAddr, totalStake)).wait();
    }

    /* Register each job ID ------------------------------------------- */
    for (const raw of argv.jobids) {
      const jobId = toBytes32(raw);
      console.log(`\nJobID ${raw} → ${jobId}`);

      const info = await keeper.getOracleInfo(oracleAddr, jobId);
      if (info.isActive) {
        console.log("Already registered – skipping");
        continue;
      }

      console.log("Calling registerOracle…");
      await (
        await keeper.registerOracle(oracleAddr, jobId, LINK_FEE, classes)
      ).wait();
      console.log("✓ Registered");
    }

    /* LINK allowance for aggregator ---------------------------------- */
    const linkAllow = await linkToken.allowance(owner, argv.aggregator);
    if (linkAllow < LINK_FEE) {
      console.log("Approving LINK for aggregator…");
      await (await linkToken.approve(argv.aggregator, LINK_FEE)).wait();
    }

    console.log("\nAll done.");
    process.exit(0);
  } catch (err) {
    console.error("Error during oracle registration:", err);
    process.exit(1);
  }
})();

