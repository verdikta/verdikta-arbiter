#!/usr/bin/env node
/*
  scripts/operator-migration.js – Hardhat + ethers

  The reads of installer/bin/migrate-operator.sh. Nothing here sends a transaction.

HARDHAT_NETWORK=base_sepolia node scripts/operator-migration.js plan \
  --operator <the old ArbiterOperator> --aggregator <AGGREGATOR_ADDRESS> \
  --wrappedverdikta <the keeper's verdiktaToken()> --jobids <the node's job ids…> --out plan.json

HARDHAT_NETWORK=base_sepolia node scripts/operator-migration.js deployed --new-operator <address>

HARDHAT_NETWORK=base_sepolia node scripts/operator-migration.js verify \
  --operator <old> --new-operator <new> --aggregator <AGGREGATOR_ADDRESS> \
  --senders <node key,…> --jobids <the job ids that were registered…>

  plan      writes what is registered and what the migration needs (--out FILE, else stdout)
            as JSON; exit 0 when it can run, 1 when `problems` is not empty.
  deployed  exit 0 when the address holds this release's operator, owned by the key in .env.
  verify    exit 0 when the migration's end state holds; each problem is printed.
*/
require("dotenv").config();
const fs = require("fs");
const hre = require("hardhat");
const { ethers } = hre;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const { readPlan, checkDeployment, verifyMigration } = require("./lib/migration.js");
const { contractRefused } = require("./lib/request-authorization.js");

const AggregatorABI = [
  "function reputationKeeper() view returns (address)",
  "function responseTimeoutSeconds() view returns (uint256)",
];
const KeeperABI = [
  "function getOracleInfo(address,bytes32) view returns (bool isActive,int256,int256,uint256,bytes32,uint256 fee,uint256 stakeAmount,uint256 lockedUntil,bool blocked)",
  "function getOracleClassesByKey(address,bytes32) view returns (uint64[])",
  "function getRegisteredOraclesCount() view returns (uint256)",
  "function registeredOracles(uint256) view returns (address oracle, bytes32 jobId)",
  "function isContractApproved(address) view returns (bool)",
  "function STAKE_REQUIREMENT() view returns (uint256)",
];
const OperatorABI = [
  "function owner() view returns (address)",
  "function getAuthorizedSenders() view returns (address[])",
  "function requestAuthorizationVersion() view returns (uint256)",
  "function isReputationKeeper(address) view returns (bool)",
  "function isRequesterApproved(address) view returns (bool)",
  "function getChainlinkToken() view returns (address)",
  "function oracleRequest(address,uint256,bytes32,address,bytes4,uint256,uint256,bytes)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const ERC677_ABI = ["function transferAndCall(address,uint256,bytes) returns (bool)"];

(async () => {
  try {
    const argv = yargs(hideBin(process.argv))
      .command("plan").command("deployed").command("verify").demandCommand(1)
      .option("operator", { type: "string" })
      .option("new-operator", { type: "string" })
      .option("aggregator", { type: "string" })
      .option("wrappedverdikta", { type: "string" })
      // string: a job id is 32 hex characters, and one made of digits (and an "e") would be read as a number.
      .option("jobids", { type: "array", string: true, default: [] })
      .option("senders", { type: "string", default: "" })
      .option("out", { type: "string" })
      .strict().argv;
    const command = argv._[0];
    const [signer] = await ethers.getSigners();
    const signerAddress = await signer.getAddress();
    const provider = ethers.provider;
    const jobIds = argv.jobids.map(String).filter(Boolean);

    if (command === "deployed") {
      const problems = await checkDeployment({ operator: new ethers.Contract(argv.newOperator, OperatorABI, provider), signerAddress });
      for (const problem of problems) console.error(`Problem: ${problem}`);
      process.exit(problems.length ? 1 : 0);
    }

    const aggregator = new ethers.Contract(argv.aggregator, AggregatorABI, provider);
    const keeperAddress = await aggregator.reputationKeeper();
    const keeper = new ethers.Contract(keeperAddress, KeeperABI, provider);

    if (command === "plan") {
      const plan = await readPlan({
        provider, signerAddress, operator: new ethers.Contract(argv.operator, OperatorABI, provider), operatorAddress: argv.operator,
        aggregator, aggregatorAddress: argv.aggregator, keeper, keeperAddress,
        token: new ethers.Contract(argv.wrappedverdikta, ERC20_ABI, provider), nodeJobIds: jobIds,
      });
      const text = JSON.stringify(plan, null, 2);
      if (argv.out) fs.writeFileSync(argv.out, `${text}\n`, { mode: 0o600 }); else console.log(text);
      for (const problem of plan.problems) console.error(`Problem: ${problem}`);
      process.exit(plan.problems.length ? 1 : 0);
    }

    if (command === "verify") {
      const newOperator = new ethers.Contract(argv.newOperator, OperatorABI, provider);
      /* The hole the migration closes, tried: an address no keeper approves asks the new
         operator for work through the LINK token, with a callback to itself and data
         version 2, as a real request has. It must revert. Simulated; nothing is sent. */
      const anonymousRequestReverts = async () => {
        const stranger = ethers.Wallet.createRandom().address;
        const link = await newOperator.getChainlinkToken();
        const request = newOperator.interface.encodeFunctionData("oracleRequest",
          [stranger, 0, ethers.encodeBytes32String("verdikta-migration"), stranger, "0x12345678", 1, 2, "0x"]);
        const data = new ethers.Interface(ERC677_ABI).encodeFunctionData("transferAndCall", [argv.newOperator, 0, request]);
        try { await provider.call({ from: stranger, to: link, data }); return false; } catch (error) {
          if (contractRefused(error)) return true;
          throw error;
        }
      };
      const result = await verifyMigration({
        signerAddress, oldOperatorAddress: argv.operator, newOperator, newOperatorAddress: argv.newOperator,
        aggregatorAddress: argv.aggregator, keeper, keeperAddress,
        senders: argv.senders.split(",").map((a) => a.trim()).filter(Boolean), expectedJobIds: jobIds, anonymousRequestReverts,
      });
      for (const problem of result.problems) console.error(`Problem: ${problem}`);
      if (!result.problems.length) console.log(`Verified: ${result.registered.length} job(s) registered on ${argv.newOperator}, none left on ${argv.operator}; an unapproved request is refused.`);
      process.exit(result.problems.length ? 1 : 0);
    }
    throw new Error(`Unknown command ${command}`);
  } catch (err) {
    console.error("Error:", err && err.message ? err.message : err);
    process.exit(2);
  }
})();
