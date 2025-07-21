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
  "function getOracleInfo(address,bytes32) view returns (bool isActive,int256,int256,uint256,bytes32,uint256,uint256,uint256,bool)",
  "function owner() view returns (address)",
  "function isAuthorized(address) view returns (bool)",
  "function minimumStake() view returns (uint256)",
  "function registrationFee() view returns (uint256)"
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

    /* Debug: Check balances ------------------------------------------ */
    console.log("\n=== Balance Checks ===");
    const vdkaBal = await verdikta.balanceOf(owner);
    const linkBal = await linkToken.balanceOf(owner);
    console.log(`Owner wVDKA balance: ${ethers.formatEther(vdkaBal)}`);
    console.log(`Owner LINK balance: ${ethers.formatEther(linkBal)}`);
    console.log(`Required wVDKA stake: ${ethers.formatEther(totalStake)}`);
    console.log(`Required LINK fee per job: ${ethers.formatEther(LINK_FEE)}`);
    
    if (linkBal < LINK_FEE) {
      throw new Error(`Insufficient LINK balance. Need ${ethers.formatEther(LINK_FEE)}, have ${ethers.formatEther(linkBal)}`);
    }

    /* Debug: Validate parameters ------------------------------------- */
    console.log("\n=== Parameter Validation ===");
    console.log(`Oracle address: ${oracleAddr}`);
    console.log(`Classes array: [${classes.join(', ')}]`);
    console.log(`Classes array type: ${classes.map(c => typeof c).join(', ')}`);
    console.log(`Keeper address: ${keeperAddr}`);
    console.log(`Job IDs to register: ${argv.jobids.length}`);

    /* Debug: Check contract state ------------------------------------ */
    console.log("\n=== Contract State Checks ===");
    
    try {
      // Check if keeper contract has specific requirements
      try {
        const keeperOwner = await keeper.owner();
        console.log(`Keeper owner: ${keeperOwner}`);
      } catch (e) {
        console.log("Keeper owner check failed (method may not exist)");
      }
      
      try {
        const isAuthorized = await keeper.isAuthorized(owner);
        console.log(`Is caller authorized: ${isAuthorized}`);
      } catch (e) {
        console.log("Authorization check failed (method may not exist)");
      }
      
      try {
        const minStake = await keeper.minimumStake();
        console.log(`Minimum stake required: ${ethers.formatEther(minStake)}`);
      } catch (e) {
        console.log("Minimum stake check failed (method may not exist)");
      }
      
      try {
        const regFee = await keeper.registrationFee();
        console.log(`Registration fee: ${ethers.formatEther(regFee)}`);
      } catch (e) {
        console.log("Registration fee check failed (method may not exist)");
      }
      
      // Check if oracle is already authorized for this aggregator
      try {
        const isOracleAuthorized = await keeper.isAuthorized(oracleAddr);
        console.log(`Is oracle authorized: ${isOracleAuthorized}`);
      } catch (e) {
        console.log("Oracle authorization check failed (method may not exist)");
      }
      
    } catch (stateError) {
      console.log("Contract state checks failed:", stateError.message);
    }

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
      console.log(`  Oracle: ${oracleAddr}`);
      console.log(`  JobID: ${jobId}`);
      console.log(`  LINK Fee: ${ethers.formatEther(LINK_FEE)}`);
      console.log(`  Classes: [${classes.join(', ')}]`);
      
      try {
        // Try to estimate gas first to get a better error message
        const gasEstimate = await keeper.registerOracle.estimateGas(oracleAddr, jobId, LINK_FEE, classes);
        console.log(`  Gas estimate: ${gasEstimate.toString()}`);
        
        const tx = await keeper.registerOracle(oracleAddr, jobId, LINK_FEE, classes);
        await tx.wait();
      console.log("✓ Registered");
      } catch (estimateError) {
        console.error("Gas estimation failed, trying to get more details...");
        
        // Try to call the function statically to get a better error message
        try {
          await keeper.registerOracle.staticCall(oracleAddr, jobId, LINK_FEE, classes);
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
              await keeper.registerOracle.staticCall(oracleAddr, jobId, LINK_FEE, classes, { gasLimit });
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
          await keeper.registerOracle.staticCall(oracleAddr, jobId, LINK_FEE, classes, {
            from: owner,
            gasLimit: 1000000
          });
          
        } catch (decodeError) {
          console.error("Error decoding attempt failed:", decodeError.message);
          
          // Try the actual transaction with a high gas limit to see if it gives better errors
          try {
            console.log("Attempting actual transaction with high gas limit...");
            const tx = await keeper.registerOracle(oracleAddr, jobId, LINK_FEE, classes, { gasLimit: 1000000 });
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

