#!/usr/bin/env node
/*
  scripts/register-oracle-cl.js – Hardhat + ethers

  Register one or more job IDs for a given oracle with the v2 ReputationKeeper
  (verdikta-dispatcher, beacon branch: registerArbiter).

  For each job ID this creates the job's hash chain first (external-adapter/src/health/chainStore.js,
  in <install>/health-chains, or --healthchains), then registers its head. The keeper sends health
  calls that the node must answer with the chain's next value within 60 s (the health job,
  chainlink-node/healthJobSpec); a job registered without its chain file can never answer and stays
  frozen. Back up the health-chains directory with the node's keys.

  --fee is the oracle's per-job fee in ETH (paid in ETH; no LINK anywhere in this flow). The keeper
  only selects an oracle whose fee is <= the request's ceiling, which the aggregator caps at
  maxOracleFee, so the script refuses a fee above it. Default 0.00002 ETH. The stake is the keeper's
  stakeRequirement() per job, pulled from the signer, which must be the operator's owner (or the
  keeper owner).
  --wrappedverdikta must equal the keeper's verdiktaToken(); the script checks it.
  --link is accepted for backwards compatibility and ignored.

  Example:

HARDHAT_NETWORK=base_sepolia \
node scripts/register-oracle-cl.js \
  --aggregator      <the v2 aggregator for the class — see docs/deployments.md> \
  --fee             0.00002 \
  --oracle          <your ArbiterOperator, OPERATOR_ADDR in installer/.contracts> \
  --wrappedverdikta <the keeper's verdiktaToken()> \
  --jobids          "38f19572c51041baa5f2dea284614590" "39515f75ac2947beb7f2eeae4d8eaf3e" \
  --classes         128 129


*/

require("dotenv").config();
const fs    = require("fs");
const path  = require("path");
const hre   = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const { createInFlightGuard } = require("./lib/inflight.js");
const { ensureRequestAuthorization, OperatorAuthorizationABI } = require("./lib/request-authorization.js");
const chainStore = require("../../external-adapter/src/health/chainStore");

/* ------------------------------------------------------------------- */
/* Minimal ABIs (v2)                                                   */
/* ------------------------------------------------------------------- */
const AggregatorABI = [
  "function keeper() view returns (address)",
  "function maxOracleFee() view returns (uint256)"
];

const KeeperABI = [
  "function registerArbiter(address oracle, bytes32 jobId, uint64 fee, uint64[] classes, bytes32 chainHead)",
  "function keyOf(address oracle, bytes32 jobId) view returns (bytes32)",
  "function getArbiter(bytes32 key) view returns (tuple(address oracle, uint256 quality, uint256 timeliness, uint256 offenses, uint256 flags, uint256 blockedUntil, uint256 fee, uint256 callSentAt, uint256 callAnsweredAt, uint256 stake, uint256 checkpoints))",
  "function stakeRequirement() view returns (uint256)",
  "function verdiktaToken() view returns (address)",
  "function owner() view returns (address)",
  "function isContractApproved(address) view returns (bool)"
];
const F_REGISTERED = 1n, F_BANNED = 4n, F_EXITING = 8n;

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

/* The job's hash chain: a new one for a job that is not registered. A file left by an earlier
   registration of this key (exited, or a registration that never landed) is useless now, since the
   keeper will hold the new head: it is kept as <key>.json.retired-<time>, never overwritten. */
function ensureChain(key, dir) {
  const file = path.join(dir, `${key.toLowerCase()}.json`);
  if (fs.existsSync(file)) {
    const retired = `${file}.retired-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.renameSync(file, retired);
    console.log(`  Retired an earlier hash chain: ${retired}`);
  }
  return chainStore.createChain(key, { dir });
}

/* ------------------------------------------------------------------- */
/* Main                                                                */
/* ------------------------------------------------------------------- */
(async () => {
  try {
    /* Args ------------------------------------------------------------ */
    const argv = yargs(hideBin(process.argv))
      .option("aggregator",      { alias: "a", type: "string", demandOption: true })
      .option("link",            { alias: "l", type: "string", demandOption: false, describe: "ignored (legacy LINK-fee generation)" })
      .option("fee",             { alias: "f", type: "string", default: "0.00002", describe: "oracle fee per job in ETH (must be <= the aggregator's maxOracleFee)" })
      .option("oracle",          { alias: "o", type: "string", demandOption: true })
      .option("wrappedverdikta", { alias: "w", type: "string", demandOption: true })
      .option("jobids",          { alias: "j", type: "array",  demandOption: true })
      .option("classes",         { alias: "c", type: "array",  demandOption: true })
      .option("healthchains",    { type: "string", describe: "hash-chain directory (default <install>/health-chains, or HEALTH_CHAIN_DIR)" })
      .strict()
      .argv;

    const [signer] = await ethers.getSigners();
    const owner    = await signer.getAddress();
    console.log("Using owner:", owner);

    /* Contracts ------------------------------------------------------- */
    const provider   = ethers.provider;
    const aggregator = new ethers.Contract(argv.aggregator, AggregatorABI, provider);

    const keeperAddr = await aggregator.keeper();
    console.log("ReputationKeeper:", keeperAddr);

    const keeper     = new ethers.Contract(keeperAddr, KeeperABI, signer);
    const token      = await keeper.verdiktaToken();
    if (token.toLowerCase() !== String(argv.wrappedverdikta).toLowerCase()) {
      throw new Error(`--wrappedverdikta ${argv.wrappedverdikta} is not this keeper's staking token ${token}`);
    }
    const verdikta   = new ethers.Contract(token, ERC20_ABI, signer);
    if (argv.link) console.log("Note: --link is ignored — oracle fees are paid in ETH, not LINK.");

    const oracleAddr = argv.oracle;
    const classes    = argv.classes.map(Number);
    const chainDir   = argv.healthchains ? path.resolve(argv.healthchains) : chainStore.defaultDir();
    const { sendWithRetry } = createInFlightGuard({ provider, sender: owner });
    await ensureRequestAuthorization({
      operator: new ethers.Contract(oracleAddr, OperatorAuthorizationABI, signer),
      keeper, keeperAddress: keeperAddr, aggregatorAddress: argv.aggregator,
      signerAddress: owner, sendWithRetry,
    });

    /* Fees & stake ---------------------------------------------------- */
    if (!/^[0-9]+(\.[0-9]+)?$/.test(String(argv.fee))) throw new Error(`--fee must be a decimal ETH amount, got "${argv.fee}"`);
    const ORACLE_FEE = ethers.parseUnits(String(argv.fee), 18);   // ETH per job, in wei
    if (ORACLE_FEE <= 0n) throw new Error("--fee must be greater than 0");
    if (ORACLE_FEE >= 2n ** 64n) throw new Error("--fee does not fit the keeper's uint64 fee");
    const STAKE = await keeper.stakeRequirement();

    /* Which job ids still need registering? Registered ones cost no stake, so a partial
       registration (issue #26) can be completed with exactly the remaining stake. */
    const pendingJobs = [];
    for (const raw of argv.jobids) {
      const jobId = toBytes32(raw);
      const key = await keeper.keyOf(oracleAddr, jobId);
      const flags = BigInt((await keeper.getArbiter(key)).flags);
      if (flags & F_BANNED) throw new Error(`JobID ${raw} (key ${key}) is banned: it cannot register again`);
      if (flags & F_REGISTERED) {
        console.log(`JobID ${raw}: already registered${flags & F_EXITING ? " (exiting)" : ""} – skipping`);
        if (!chainStore.currentHead(key, { dir: chainDir })) {
          console.warn(`  WARNING: no hash chain for ${key} in ${chainDir}: this job cannot answer health calls`);
        }
      } else pendingJobs.push({ raw, jobId, key });
    }
    if (pendingJobs.length === 0) {
      console.log("\nAll job ids are already registered. Nothing to do.");
      process.exit(0);
    }
    const totalStake = STAKE * BigInt(pendingJobs.length);

    /* Ceiling: an oracle whose fee exceeds the aggregator's maxOracleFee is never eligible
       (the keeper selects only fee <= the request's ceiling). Refuse rather than register a node
       that can never be picked. */
    const feeCeiling = await aggregator.maxOracleFee();
    if (ORACLE_FEE > feeCeiling) {
      throw new Error(
        `--fee ${ethers.formatEther(ORACLE_FEE)} ETH exceeds this aggregator's maxOracleFee ` +
        `${ethers.formatEther(feeCeiling)} ETH — the keeper would never select this oracle. Use a lower fee.`
      );
    }

    console.log("\n=== Registration ===");
    console.log(`Oracle address: ${oracleAddr}`);
    console.log(`Classes: [${classes.join(', ')}]`);
    console.log(`Keeper address: ${keeperAddr}`);
    console.log(`Hash chains: ${chainDir}`);
    console.log(`Oracle fee per job: ${ethers.formatEther(ORACLE_FEE)} ETH (aggregator ceiling ${ethers.formatEther(feeCeiling)} ETH)`);
    console.log(`Job IDs to register: ${pendingJobs.length} of ${argv.jobids.length}`);

    /* stake allowance (one approval covers every job) ------------------ */
    const bal = await verdikta.balanceOf(owner);
    console.log(`Owner wVDKA balance: ${ethers.formatEther(bal)}; required stake: ${ethers.formatEther(totalStake)}`);
    if (bal < totalStake) {
      throw new Error(
        `Insufficient wVDKA: ${ethers.formatEther(bal)} available, ${ethers.formatEther(totalStake)} needed ` +
        `(${ethers.formatEther(STAKE)} per job for the ${pendingJobs.length} job id(s) not yet registered).`
      );
    }
    let allow = await verdikta.allowance(owner, keeperAddr);
    if (allow < totalStake) {
      console.log(`Approving ${ethers.formatEther(totalStake)} wVDKA…`);
      await (await verdikta.approve(keeperAddr, totalStake)).wait();
    }

    /* Register each pending job ID ----------------------------------- */
    for (const { raw, jobId, key } of pendingJobs) {
      console.log(`\nJobID ${raw} → ${jobId} (key ${key})`);
      const head = ensureChain(key, chainDir);
      console.log(`  Hash chain head: ${head}`);
      const args = [oracleAddr, jobId, ORACLE_FEE, classes, head];
      let gasLimit = 600000;
      try {
        gasLimit = Math.ceil(Number(await keeper.registerArbiter.estimateGas(...args)) * 1.2);
      } catch (e) {
        // estimation reverts for the same reasons the transaction would: show why
        try { await keeper.registerArbiter.staticCall(...args); } catch (s) {
          throw new Error(`registerArbiter would revert for ${raw}: ${s.shortMessage || s.message}`);
        }
      }
      await sendWithRetry(`registerArbiter ${raw}`, async () => {
        const tx = await keeper.registerArbiter(...args, { gasLimit });
        await tx.wait();
      });
      console.log("✓ Registered");
    }

    console.log("\nAll done.");
    process.exit(0);
  } catch (err) {
    console.error("Error during oracle registration:", err);
    process.exit(1);
  }
})();

