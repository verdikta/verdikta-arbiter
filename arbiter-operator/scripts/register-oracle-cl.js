#!/usr/bin/env node
/*
  scripts/register-oracle-cl.js – Hardhat + ethers

  Register one or more job IDs for a given oracle.

  --fee is the oracle's per-job fee in ETH (the current dispatcher generation
  pays oracles in ETH; there is no LINK anywhere in this flow). The keeper only
  ever SELECTS an oracle whose fee is <= the request's max fee, which is capped
  by the aggregator's maxOracleFee (0.0004 ETH at the time of writing), so the
  script reads that ceiling and refuses a fee above it. Default 0.00002 ETH —
  what the fleet runs with; lower fees also rank higher in selection.
  --link is accepted for backwards compatibility and ignored.

  Example:

HARDHAT_NETWORK=base_sepolia \
node scripts/register-oracle-cl.js \
  --aggregator      0xe8a385E473EA710c5a88Cc72681a16a26fe380e4   # current Base Sepolia dispatcher — see docs/deployments.md \
  --fee             0.00002 \
  --oracle          <your ArbiterOperator, OPERATOR_ADDR in installer/.contracts> \
  --wrappedverdikta 0x94e3c031fe9403c80E14DaFbCb73f191C683c2B1   # must equal the dispatcher keeper's verdiktaToken() \
  --jobids          "38f19572c51041baa5f2dea284614590" "39515f75ac2947beb7f2eeae4d8eaf3e" \
  --classes         128 129


*/

require("dotenv").config();
const hre   = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const { createInFlightGuard } = require("./lib/inflight.js");
const { ensureRequestAuthorization, OperatorAuthorizationABI } = require("./lib/request-authorization.js");
const { OWNER_FUNDS, checkGasBudget, isInsufficientFunds, describeRefusedSend } = require("./lib/funds.js");

/* The most gas one call below is given, for the check that the owner wallet
   can pay for all of them before any is sent. registerOracle is estimated per
   call (about 360,000 with 30 identities in the keeper's registry, which it
   walks) and falls back to 500,000. */
const REGISTER_GAS_BUDGET = 500_000;
const APPROVE_GAS_BUDGET  = 100_000;

/* ------------------------------------------------------------------- */
/* Minimal ABIs                                                        */
/* ------------------------------------------------------------------- */
const AggregatorABI = [
  "function reputationKeeper() view returns (address)",
  "function maxOracleFee() view returns (uint256)",
  "function getContractConfig() view returns (address oracleAddr,address linkAddr,bytes32 jobId,uint256 fee)"
];

const KeeperABI = [
  "function registerOracle(address,bytes32,uint256,uint64[])",
  "function getOracleInfo(address,bytes32) view returns (bool isActive,int256,int256,uint256,bytes32,uint256,uint256,uint256,bool)",
  "function owner() view returns (address)",
  "function isAuthorized(address) view returns (bool)",
  "function minimumStake() view returns (uint256)",
  "function registrationFee() view returns (uint256)",
  "function isContractApproved(address) view returns (bool)"
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
  let funds = null;   // { provider, sender } once known, for the last catch
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
      .strict()
      .argv;

    const [signer] = await ethers.getSigners();
    const owner    = await signer.getAddress();
    console.log("Using owner:", owner);

    /* Contracts ------------------------------------------------------- */
    const provider   = ethers.provider;
    funds = { provider, sender: owner };
    const aggregator = new ethers.Contract(argv.aggregator, AggregatorABI, provider);

    const keeperAddr = await aggregator.reputationKeeper();
    console.log("ReputationKeeper:", keeperAddr);

    const keeper     = new ethers.Contract(keeperAddr, KeeperABI, signer);
    const verdikta   = new ethers.Contract(argv.wrappedverdikta, ERC20_ABI, signer);
    if (argv.link) console.log("Note: --link is ignored — oracle fees are paid in ETH, not LINK.");

    const oracleAddr = argv.oracle;
    const classes    = argv.classes.map(Number);
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
    const VDKA_STAKE = ethers.parseUnits("100", 18);

    /* Which job ids still need registering? Already-active ones cost no
       stake, so a partial registration (issue #26) can be completed with
       exactly the remaining 100 wVDKA per job. */
    const pendingJobs = [];
    for (const raw of argv.jobids) {
      const jobId = toBytes32(raw);
      const info = await keeper.getOracleInfo(oracleAddr, jobId);
      if (info.isActive) console.log(`JobID ${raw}: already registered – skipping`);
      else pendingJobs.push(raw);
    }
    if (pendingJobs.length === 0) {
      console.log("\nAll job ids are already registered. Nothing to do.");
      process.exit(0);
    }
    const totalStake = VDKA_STAKE * BigInt(pendingJobs.length);

    /* Ceiling: an oracle whose fee exceeds the aggregator's maxOracleFee is
       never eligible (ReputationKeeper.selectOracles: fee <= maxFee). Refuse
       here rather than register a node that can never be picked. */
    let feeCeiling = null;
    try { feeCeiling = await aggregator.maxOracleFee(); } catch { /* older aggregator generation */ }
    if (feeCeiling !== null && ORACLE_FEE > feeCeiling) {
      throw new Error(
        `--fee ${ethers.formatEther(ORACLE_FEE)} ETH exceeds this aggregator's maxOracleFee ` +
        `${ethers.formatEther(feeCeiling)} ETH — the keeper would never select this oracle. Use a lower fee.`
      );
    }

    /* Debug: Check balances ------------------------------------------ */
    console.log("\n=== Balance Checks ===");
    const vdkaBal = await verdikta.balanceOf(owner);
    console.log(`Owner wVDKA balance: ${ethers.formatEther(vdkaBal)}`);
    console.log(`Required wVDKA stake: ${ethers.formatEther(totalStake)}`);
    console.log(`Oracle fee per job: ${ethers.formatEther(ORACLE_FEE)} ETH` +
      (feeCeiling !== null ? ` (aggregator ceiling ${ethers.formatEther(feeCeiling)} ETH)` : ""));
    
    /* Debug: Validate parameters ------------------------------------- */
    console.log("\n=== Parameter Validation ===");
    console.log(`Oracle address: ${oracleAddr}`);
    console.log(`Classes array: [${classes.join(', ')}]`);
    console.log(`Classes array type: ${classes.map(c => typeof c).join(', ')}`);
    console.log(`Keeper address: ${keeperAddr}`);
    console.log(`Job IDs to register: ${pendingJobs.length} of ${argv.jobids.length}`);

    /* wVDKA allowance (one approval covers every job) ----------------- */
    const bal = await verdikta.balanceOf(owner);
    if (bal < totalStake) {
      throw new Error(
        `Insufficient wVDKA: ${ethers.formatEther(bal)} available, ${ethers.formatEther(totalStake)} needed ` +
        `(100 per job for the ${pendingJobs.length} job id(s) not yet registered).`
      );
    }

    let allow = await verdikta.allowance(owner, keeperAddr);

    /* ETH for gas: every call below at the most it can cost, before any is
       sent. A wallet that runs dry part way leaves some job ids registered and
       some not, and used to say so with a ProviderError and its stack. */
    await checkGasBudget({
      provider,
      sender: owner,
      configuredGasPrice: hre.network.config.gasPrice,
      what: `${pendingJobs.length} registration(s)`,
      calls: [
        { count: pendingJobs.length, gas: REGISTER_GAS_BUDGET },
        { count: allow < totalStake ? 1 : 0, gas: APPROVE_GAS_BUDGET },
      ],
    });

    if (allow < totalStake) {
      console.log(`Approving ${ethers.formatEther(totalStake)} wVDKA…`);
      await (await verdikta.approve(keeperAddr, totalStake)).wait();
    }

    /* Register each pending job ID ----------------------------------- */
    for (const raw of pendingJobs) {
      const jobId = toBytes32(raw);
      console.log(`\nJobID ${raw} → ${jobId}`);

      console.log("Calling registerOracle…");
      console.log(`  Oracle: ${oracleAddr}`);
      console.log(`  JobID: ${jobId}`);
      console.log(`  Oracle fee: ${ethers.formatEther(ORACLE_FEE)} ETH`);
      console.log(`  Classes: [${classes.join(', ')}]`);
      
      try {
        // Try to estimate gas first to get a better error message
        const gasEstimate = await keeper.registerOracle.estimateGas(oracleAddr, jobId, ORACLE_FEE, classes);
        console.log(`  Gas estimate: ${gasEstimate.toString()}`);
        
        // Add buffer to gas estimate for safety (20% buffer)
        const gasLimit = Math.ceil(Number(gasEstimate) * 1.2);
        console.log(`  Using gas limit: ${gasLimit}`);
        
        await sendWithRetry(`registerOracle ${raw}`, async () => {
          const tx = await keeper.registerOracle(oracleAddr, jobId, ORACLE_FEE, classes, { gasLimit });
          await tx.wait();
        });
      console.log("✓ Registered");
      } catch (estimateError) {
        /* Not a gas-limit problem: another limit, the static calls and a
           third send below cannot help, and each one buries the reason. */
        if (isInsufficientFunds(estimateError)) {
          throw await describeRefusedSend({ error: estimateError, provider, sender: owner, what: `registering job id ${raw}` });
        }
        console.error("Gas estimation failed, trying with fallback gas limit...");
        
        // Try with a reasonable fallback gas limit for mainnet
        const fallbackGasLimit = 500000; // 500k gas as fallback
        console.log(`  Using fallback gas limit: ${fallbackGasLimit}`);
        
        try {
          await sendWithRetry(`registerOracle ${raw} (fallback gas)`, async () => {
            const tx = await keeper.registerOracle(oracleAddr, jobId, ORACLE_FEE, classes, { gasLimit: fallbackGasLimit });
            await tx.wait();
          });
          console.log("✓ Registered with fallback gas limit");
          continue; // Skip the error handling below and move to next job
        } catch (fallbackError) {
          if (isInsufficientFunds(fallbackError)) {
            throw await describeRefusedSend({ error: fallbackError, provider, sender: owner, what: `registering job id ${raw}` });
          }
          console.error("Fallback transaction also failed:", fallbackError.message);
        }
        
        // If fallback also fails, try to get more details
        console.error("Both gas estimation and fallback failed, getting more details...");
        
        // Try to call the function statically to get a better error message
        try {
          await keeper.registerOracle.staticCall(oracleAddr, jobId, ORACLE_FEE, classes);
        } catch (staticError) {
          console.error("Static call error:", staticError.message);
          if (staticError.reason) {
            console.error("Revert reason:", staticError.reason);
          }
          if (staticError.data) {
            console.error("Error data:", staticError.data);
          }
        }
        
        // Try to decode the error using different methods
        try {
          console.log("Attempting to decode error...");
          
          // Try with different gas limits
          const gasLimitTests = [100000, 200000, 500000, 1000000];
          for (const gasLimit of gasLimitTests) {
            try {
              console.log(`Testing with gas limit: ${gasLimit}`);
              await keeper.registerOracle.staticCall(oracleAddr, jobId, ORACLE_FEE, classes, { gasLimit });
              console.log(`Success with gas limit: ${gasLimit}`);
              break;
            } catch (gasError) {
              console.log(`Failed with gas limit ${gasLimit}: ${gasError.message}`);
            }
          }
          
          // Try to get more detailed error info
          if (estimateError.error && estimateError.error.data) {
            console.error("Raw error data:", estimateError.error.data);
          }
          
          // Try to call with explicit overrides
          await keeper.registerOracle.staticCall(oracleAddr, jobId, ORACLE_FEE, classes, {
            from: owner,
            gasLimit: 1000000
          });
          
        } catch (decodeError) {
          console.error("Error decoding attempt failed:", decodeError.message);
          
          // Try the actual transaction with a high gas limit to see if it gives better errors
          try {
            console.log("Attempting actual transaction with high gas limit...");
            const tx = await keeper.registerOracle(oracleAddr, jobId, ORACLE_FEE, classes, { gasLimit: 1000000 });
            await tx.wait();
            console.log("✓ Registered with high gas limit");
          } catch (txError) {
            console.error("Transaction with high gas limit failed:", txError.message);
            if (txError.reason) {
              console.error("Transaction revert reason:", txError.reason);
            }
            if (txError.data) {
              console.error("Transaction error data:", txError.data);
            }
          }
        }
        
        throw estimateError;
      }
    }

    console.log("\nAll done.");
    process.exit(0);
  } catch (err) {
    /* The owner wallet cannot pay: one line, no stack. */
    let shown = err;
    if (shown && shown.code !== OWNER_FUNDS && funds && isInsufficientFunds(shown)) {
      shown = await describeRefusedSend({ error: shown, ...funds, what: "this call" });
    }
    if (shown && shown.code === OWNER_FUNDS) {
      console.error(`Error during oracle registration: ${shown.message}`);
      process.exit(1);
    }
    console.error("Error during oracle registration:", err);
    process.exit(1);
  }
})();

