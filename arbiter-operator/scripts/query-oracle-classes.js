#!/usr/bin/env node
/*
  scripts/query-oracle-classes.js – Hardhat + ethers

  What the v2 ReputationKeeper (verdikta-dispatcher, beacon branch) holds for one job: registration
  state, classes, the two scores, offenses and blocks, fee and stake, the health-call state and an
  exit in progress.

  Example:

HARDHAT_NETWORK=base_sepolia \
node scripts/query-oracle-classes.js \
  --aggregator <the v2 aggregator — see docs/deployments.md> \
  --oracle     <your ArbiterOperator, OPERATOR_ADDR in installer/.contracts> \
  --jobid      "38f19572c51041baa5f2dea284614590"

*/

require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

const AggregatorABI = ["function keeper() view returns (address)"];
const KeeperABI = [
  "function keyOf(address oracle, bytes32 jobId) view returns (bytes32)",
  "function getArbiter(bytes32 key) view returns (tuple(address oracle, uint256 quality, uint256 timeliness, uint256 offenses, uint256 flags, uint256 blockedUntil, uint256 fee, uint256 callSentAt, uint256 callAnsweredAt, uint256 stake, uint256 checkpoints, uint256 exitAt))",
  "function arbiterClasses(bytes32 key) view returns (uint64[])",
  "function healthState(bytes32 key) view returns (bool pending, uint256 sentAt, bytes32 head)",
  "function isFrozen(bytes32 key) view returns (bool)"
];
const FLAGS = { 1: "registered", 2: "paused", 4: "banned", 8: "exiting", 16: "health call pending", 32: "under-staked" };

const toBytes32 = (id) => {
  if (/^0x[0-9a-f]{64}$/i.test(id)) return id;             // already bytes32
  const bytes = ethers.toUtf8Bytes(id);
  if (bytes.length > 32) throw new Error(`Job ID too long: ${id}`);
  return ethers.hexlify(bytes).padEnd(66, "0");
};
const when = (t) => (BigInt(t) === 0n ? "never" : new Date(Number(t) * 1000).toISOString());

(async () => {
  try {
    const argv = yargs(hideBin(process.argv))
      .option("aggregator", { alias: "a", type: "string", demandOption: true })
      .option("oracle",     { alias: "o", type: "string", demandOption: true })
      .option("jobid",      { alias: "j", type: "string", demandOption: true })
      .strict()
      .argv;

    const provider = ethers.provider;
    const keeperAddr = await new ethers.Contract(argv.aggregator, AggregatorABI, provider).keeper();
    console.log("ReputationKeeper:", keeperAddr);
    const keeper = new ethers.Contract(keeperAddr, KeeperABI, provider);
    const jobId = toBytes32(argv.jobid);
    const key = await keeper.keyOf(argv.oracle, jobId);
    console.log(`\nOracle: ${argv.oracle}`);
    console.log(`JobID: ${argv.jobid} → ${jobId}`);
    console.log(`Key: ${key}`);

    const v = await keeper.getArbiter(key);
    const flags = Number(v.flags);
    const named = Object.entries(FLAGS).filter(([bit]) => flags & Number(bit)).map(([, name]) => name);
    console.log("\nStatus:", named.length ? named.join(", ") : "not registered");
    if (!(flags & 1)) process.exit(0);

    const classes = await keeper.arbiterClasses(key);
    console.log("Classes:", classes.map(String).join(", ") || "none");
    console.log("Quality / timeliness:", v.quality.toString(), "/", v.timeliness.toString());
    console.log("Offenses:", v.offenses.toString(), " blocked until:", when(v.blockedUntil));
    console.log("Fee:", ethers.formatEther(v.fee), "ETH   stake:", ethers.formatEther(v.stake), "wVDKA");
    const [pending, sentAt, head] = await keeper.healthState(key);
    console.log("Health call:", pending ? `pending since ${when(sentAt)}` : "none pending",
      " last answered:", when(v.callAnsweredAt), " frozen:", await keeper.isFrozen(key));
    console.log("Hash-chain head:", head);
    if (flags & 8) console.log("Exit: completeExit allowed from", when(v.exitAt));
    process.exit(0);
  } catch (err) {
    console.error("Error querying oracle information:", err);
    process.exit(1);
  }
})();
