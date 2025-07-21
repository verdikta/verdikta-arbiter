#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Adds Chainlink node wallets to ArbiterOperator.setAuthorizedSenders
//
// NODES   – comma-separated list (required unless --nodes flag)
// OPERATOR – operator address (optional; auto-detected if omitted)
//
// Example:
// NODES=0xNodeWallet \
// npx hardhat run scripts/setAuthorizedSenders.js --network base_sepolia
//

const hre   = require("hardhat");
const fs    = require("fs");
const path  = require("path");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

async function main() {
  /*──────── CLI + env────────*/
  const argv = yargs(hideBin(process.argv))
    .option("nodes",    { type: "string", describe: "comma-separated wallets" })
    .option("operator", { type: "string", describe: "operator contract address" })
    .argv;

  const nodeAddrs = (argv.nodes || process.env.NODES || "")
    .split(",").map((a) => a.trim()).filter(Boolean);

  if (nodeAddrs.length === 0) {
    throw new Error("Provide node wallets via --nodes or NODES env-var.");
  }

  let operatorAddr = argv.operator || process.env.OPERATOR;
  if (!operatorAddr) {
    const depPath = path.join(
      __dirname, "..", "deployments", hre.network.name, "ArbiterOperator.json"
    );
    if (!fs.existsSync(depPath)) {
      throw new Error(
        `Cannot find ${depPath}. Pass --operator <addr> or set OPERATOR env-var.`
      );
    }
    operatorAddr = JSON.parse(fs.readFileSync(depPath)).address;
  }

  /*──────── status ────────*/
  console.log("Network         :", hre.network.name);
  console.log("Operator        :", operatorAddr);
  console.log("New node wallet(s):", nodeAddrs.join(", "));

  const [signer] = await hre.ethers.getSigners();
  const abi = [
    "function getAuthorizedSenders() view returns (address[])",
    "function setAuthorizedSenders(address[])"
  ];
  const op = await hre.ethers.getContractAt(abi, operatorAddr, signer);

  /*──────── merge instead of overwrite ───*/
  const existing = (await op.getAuthorizedSenders()).map((a) => a.toLowerCase());
  const merged   = Array.from(new Set([...existing, ...nodeAddrs.map((n) => n.toLowerCase())]));

  if (merged.length === existing.length) {
    console.log("Nothing new to add – all nodes already authorised.");
    return;
  }

  const tx = await op.setAuthorizedSenders(merged);
  console.log("Tx submitted :", tx.hash);
  await tx.wait(2);
  console.log("✓ Authorised senders updated.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

