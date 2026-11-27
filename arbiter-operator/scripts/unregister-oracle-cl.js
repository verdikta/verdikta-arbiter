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

  --all-registered   also exit every other job id the keeper holds for --oracle
                     (read from its ArbiterRegistered events), and fail unless
                     none of the operator's job ids is left selectable
                     afterwards. A job id that installer/.contracts no longer
                     names cannot then be left registered with no node behind
                     it. --jobids is optional with it. Without it such ids are
                     reported and left alone.
  --from-block N     the first block searched for ArbiterRegistered events
                     (default 0; give the keeper's deployment block when the
                     RPC limits the range of a log query).

  --wrappedverdikta is accepted for backwards compatibility; the keeper names its token.
*/

require("dotenv").config();
const hre   = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const { createInFlightGuard } = require("./lib/inflight.js");
const { runExits, when } = require("./lib/registry.js");

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
  "function owner() view returns (address)",
  "event ArbiterRegistered(bytes32 indexed key, address indexed oracle, bytes32 jobId, uint256 fee)"
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
      .option("wrappedverdikta", { alias: "w", type: "string", demandOption: false, describe: "ignored: the keeper names its token" })
      // string: true — yargs would turn an all-digit job id into a number.
      .option("jobids",          { alias: "j", type: "array",  string: true, default: [] })
      .option("all-registered",  { type: "boolean", default: false })
      .option("from-block",      { type: "number", default: 0 })
      .check((a) => a.jobids.length > 0 || a["all-registered"] || "Give --jobids, --all-registered, or both")
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

    /* Exit ------------------------------------------------------------ */
    /* The keeper keeps no per-operator list: the keys it ever registered for
       this operator are in its ArbiterRegistered events (the operator is
       indexed); registry.js reads each one's state with getArbiter. A count
       change exits every job in a row; on a delegated (EIP-7702) sender Infura
       rejects the next send once a few are in flight (#38), so every send is
       settled and retried. */
    const reader = {
      registrations: async (oracle) => {
        const logs = await keeper.queryFilter(keeper.filters.ArbiterRegistered(null, oracle), argv["from-block"], "latest");
        return logs.map((l) => ({ key: l.args.key, jobId: l.args.jobId }));
      },
      keyOf: (oracle, jobId) => keeper.keyOf(oracle, jobId),
      getArbiter: (key) => keeper.getArbiter(key),
    };
    const now = async () => BigInt((await ethers.provider.getBlock("latest")).timestamp);

    const result = await runExits({
      keeper: reader,
      oracle: argv.oracle,
      jobIds: argv.jobids,
      allRegistered: argv["all-registered"],
      now,
      requestExit: (key, label) =>
        sendWithRetry(`requestExit ${label}`, async () => {
          const tx = await keeper.requestExit(key);
          await tx.wait();
          console.log("✓ Exit requested (tx:", tx.hash, ")");
        }),
      completeExit: (key, label) =>
        sendWithRetry(`completeExit ${label}`, async () => {
          const tx = await keeper.completeExit(key);
          await tx.wait();
          console.log("✓ Exit completed: stake refunded to the operator's owner (tx:", tx.hash, ")");
        }),
    });

    const balAfter = await verdikta.balanceOf(oracleOwner);
    console.log("\nOperator owner's wVDKA balance:", ethers.formatEther(balAfter));
    const { requested, completed, pending, latestExit } = result;
    console.log(`Exits requested: ${requested.length}, completed: ${completed.length}, still pending: ${pending.length}`);
    if (requested.length + pending.length > 0) console.log(`Run this script again from ${when(latestExit)} to complete the pending exits.`);
    console.log("Oracle exit step completed successfully");
    process.exit(0);
  } catch (err) {
    console.error("Error during oracle exit:", err);
    process.exit(1);
  }
})();
