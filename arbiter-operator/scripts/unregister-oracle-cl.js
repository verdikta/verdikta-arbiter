#!/usr/bin/env node
/*
  scripts/unregister-oracle-cl.js – Hardhat + ethers

  Take job IDs off the v2 ReputationKeeper (verdikta-dispatcher, beacon branch). Leaving is two steps:

    requestExit   the job stops being selectable at once; its stake stays bonded for the keeper's
                  unbonding period (2 days by default)
    completeExit  after that period: the stake goes back to the operator's owner and the job's
                  class slots are freed

  Run this script to request the exit, and again after the unbonding period to complete it: for each
  job it does whichever step is due and says when the next one is. The caller must be the operator's
  owner or the keeper owner. A frozen arbiter can exit too.

  Example:

HARDHAT_NETWORK=base_sepolia node scripts/unregister-oracle-cl.js \
  --aggregator <the v2 aggregator — see docs/deployments.md> \
  --oracle <your ArbiterOperator, OPERATOR_ADDR in installer/.contracts> \
  --jobids "38f19572c51041baa5f2dea284614590" \
          "39515f75ac2947beb7f2eeae4d8eaf3e"

  --wrappedverdikta is accepted for backwards compatibility; the keeper names its token.
*/

require("dotenv").config();
const hre   = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const { createInFlightGuard } = require("./lib/inflight.js");

/* ------------------------------------------------------------------- */
/* Minimal ABIs (v2)                                                   */
/* ------------------------------------------------------------------- */
const AggregatorABI = [
  "function keeper() view returns (address)"
];

const KeeperABI = [
  "function requestExit(bytes32 key)",
  "function completeExit(bytes32 key)",
  "function keyOf(address oracle, bytes32 jobId) view returns (bytes32)",
  "function getArbiter(bytes32 key) view returns (tuple(address oracle, uint256 quality, uint256 timeliness, uint256 offenses, uint256 flags, uint256 blockedUntil, uint256 fee, uint256 callSentAt, uint256 callAnsweredAt, uint256 stake, uint256 checkpoints, uint256 exitAt))",
  "function verdiktaToken() view returns (address)",
  "function owner() view returns (address)"
];
const F_REGISTERED = 1n, F_EXITING = 8n;

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
const when = (t) => new Date(Number(t) * 1000).toISOString();

/* ------------------------------------------------------------------- */
/* Main                                                                */
/* ------------------------------------------------------------------- */
(async () => {
  try {
    /* Args ------------------------------------------------------------ */
    const argv = yargs(hideBin(process.argv))
      .option("aggregator",      { alias: "a", type: "string", demandOption: true })
      .option("oracle",          { alias: "o", type: "string", demandOption: true })
      .option("wrappedverdikta", { alias: "w", type: "string", demandOption: false, describe: "ignored: the keeper names its token" })
      .option("jobids",          { alias: "j", type: "array",  demandOption: true })
      .strict()
      .argv;

    const [signer] = await ethers.getSigners();
    const caller   = await signer.getAddress();
    const { sendWithRetry } = createInFlightGuard({ provider: ethers.provider, sender: caller });
    console.log("Caller:", caller);

    /* Resolve keeper -------------------------------------------------- */
    const aggregator = new ethers.Contract(argv.aggregator, AggregatorABI, signer);
    const keeperAddr = await aggregator.keeper();
    console.log("ReputationKeeper:", keeperAddr);
    const keeper = new ethers.Contract(keeperAddr, KeeperABI, signer);

    /* Auth check (keeper owner OR oracle owner) ----------------------- */
    const [oracleOwner, keeperOwner] = await Promise.all([
      new ethers.Contract(argv.oracle, OWNER_ABI, signer).owner(),
      keeper.owner(),
    ]);
    if (caller.toLowerCase() !== oracleOwner.toLowerCase() && caller.toLowerCase() !== keeperOwner.toLowerCase()) {
      throw new Error("Caller must be oracle owner or ReputationKeeper owner");
    }

    const verdikta = new ethers.Contract(await keeper.verdiktaToken(), ERC20_BALANCE, signer);
    const balBefore = await verdikta.balanceOf(oracleOwner);
    console.log("Operator owner's wVDKA balance:", ethers.formatEther(balBefore));

    /* Loop through job IDs ------------------------------------------- */
    let requested = 0, completed = 0, pending = 0, latestExit = 0n;
    for (const rawId of argv.jobids) {
      const jobId = toBytes32(rawId);
      const key = await keeper.keyOf(argv.oracle, jobId);
      console.log(`\nJobID ${rawId} → ${jobId} (key ${key})`);
      const v = await keeper.getArbiter(key);
      const flags = BigInt(v.flags);
      const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);

      if ((flags & F_REGISTERED) === 0n) {
        console.log("Not registered – skipping");
        continue;
      }
      if ((flags & F_EXITING) === 0n) {
        await sendWithRetry(`requestExit ${rawId}`, async () => {
          const tx = await keeper.requestExit(key);
          await tx.wait();
          console.log("✓ Exit requested (tx:", tx.hash, ")");
        });
        const exitAt = BigInt((await keeper.getArbiter(key)).exitAt);
        if (exitAt > latestExit) latestExit = exitAt;
        console.log(`  No longer selectable. The stake comes back with completeExit from ${when(exitAt)}: run this script again then.`);
        requested++;
        continue;
      }
      const exitAt = BigInt(v.exitAt);
      if (now < exitAt) {
        console.log(`Exit pending: the stake can be withdrawn from ${when(exitAt)} – skipping`);
        if (exitAt > latestExit) latestExit = exitAt;
        pending++;
        continue;
      }
      if (BigInt(v.blockedUntil) > now) {
        console.log(`Exit pending: blocked until ${when(v.blockedUntil)}, then completeExit can run – skipping`);
        pending++;
        continue;
      }
      await sendWithRetry(`completeExit ${rawId}`, async () => {
        const tx = await keeper.completeExit(key);
        await tx.wait();
        console.log("✓ Exit completed: stake refunded to the operator's owner (tx:", tx.hash, ")");
      });
      completed++;
    }

    const balAfter = await verdikta.balanceOf(oracleOwner);
    console.log("\nOperator owner's wVDKA balance:", ethers.formatEther(balAfter));
    console.log(`Exits requested: ${requested}, completed: ${completed}, still pending: ${pending}`);
    if (requested + pending > 0) console.log(`Run this script again from ${when(latestExit)} to complete the pending exits.`);
    console.log("Oracle exit step completed successfully");
    process.exit(0);
  } catch (err) {
    console.error("Error during oracle exit:", err);
    process.exit(1);
  }
})();
