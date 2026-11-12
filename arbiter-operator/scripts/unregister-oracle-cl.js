#!/usr/bin/env node
/*
  scripts/unregister-oracle-cl.js – Hardhat + ethers

  CLI flags match the original Truffle version.

  Example:

HARDHAT_NETWORK=base_sepolia \

HARDHAT_NETWORK=base_sepolia node scripts/unregister-oracle-cl.js \
  --aggregator 0xe8a385E473EA710c5a88Cc72681a16a26fe380e4   # current Base Sepolia dispatcher — see docs/deployments.md \
  --oracle <your ArbiterOperator, OPERATOR_ADDR in installer/.contracts> \
  --wrappedverdikta 0x94e3c031fe9403c80E14DaFbCb73f191C683c2B1 \
  --jobids "38f19572c51041baa5f2dea284614590" \
          "39515f75ac2947beb7f2eeae4d8eaf3e" \
          "cdee0a127bc74a5188cbabf7aadcc84f"

  --all-registered   also deregister every other job id the keeper lists for
                     --oracle, and fail unless it lists none afterwards. The
                     installer passes it when it replaces a node's jobs, so a
                     job id that installer/.contracts no longer names cannot be
                     left behind with its stake. --jobids is optional with it.
                     Without it such ids are reported and left alone.

*/

require("dotenv").config();
const hre   = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const { createInFlightGuard } = require("./lib/inflight.js");
const { runDeregistration } = require("./lib/registry.js");

/* ------------------------------------------------------------------- */
/* Minimal ABIs                                                        */
/* ------------------------------------------------------------------- */
const AggregatorABI = [
  "function reputationKeeper() view returns (address)"
];

const KeeperABI = [
  "function deregisterOracle(address,bytes32)",
  "function getOracleInfo(address,bytes32) view returns (bool isActive,int256,int256,uint256,bytes32,uint256,uint256 stakeAmount,uint256 lockedUntil,bool blocked)",
  "function getRegisteredOraclesCount() view returns (uint256)",
  "function registeredOracles(uint256) view returns (address oracle, bytes32 jobId)",
  "function owner() view returns (address)"
];

const ERC20_BALANCE = [
  "function balanceOf(address) view returns (uint256)"
];

const OWNER_ABI = [
  "function owner() view returns (address)"
];

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
      // string: true — yargs would turn an all-digit job id into a number.
      .option("jobids",          { alias: "j", type: "array",  string: true, default: [] })
      .option("all-registered",  { type: "boolean", default: false })
      .check((a) => a.jobids.length > 0 || a["all-registered"] || "Give --jobids, --all-registered, or both")
      .strict()
      .argv;

    const [signer] = await ethers.getSigners();
    const caller   = await signer.getAddress();
    const { sendWithRetry, isInFlightLimit } = createInFlightGuard({ provider: ethers.provider, sender: caller });
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

    /* Deregister ------------------------------------------------------ */
    /* A count change deregisters every job in a row; on a delegated
       (EIP-7702) sender Infura rejects the next send once a few are in
       flight (#38). Settle + retry around every send, like registration. */
    const deregisterOne = async (jobId, rawId) => {
      try {
        const gasEstimate = await keeper.deregisterOracle.estimateGas(argv.oracle, jobId);
        const gasLimit = Math.ceil(Number(gasEstimate) * 1.2); // 20% buffer
        console.log(`  Gas estimate: ${gasEstimate}, using limit: ${gasLimit}`);
        await sendWithRetry(`deregisterOracle ${rawId}`, async () => {
          const tx = await keeper.deregisterOracle(argv.oracle, jobId, { gasLimit });
          await tx.wait();
          console.log("✓ Deregistered (tx:", tx.hash, ")");
        });
      } catch (error) {
        if (isInFlightLimit(error)) throw error; // retries exhausted — not a gas problem
        console.error("Gas estimation failed, trying with fallback gas limit...");
        const fallbackGasLimit = 300000;
        console.log(`  Using fallback gas limit: ${fallbackGasLimit}`);
        await sendWithRetry(`deregisterOracle ${rawId} (fallback gas)`, async () => {
          const tx = await keeper.deregisterOracle(argv.oracle, jobId, { gasLimit: fallbackGasLimit });
          await tx.wait();
          console.log("✓ Deregistered with fallback gas (tx:", tx.hash, ")");
        });
      }
    };

    await runDeregistration({
      keeper,
      oracle: argv.oracle,
      jobIds: argv.jobids,
      allRegistered: argv["all-registered"],
      deregisterOne,
    });

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

