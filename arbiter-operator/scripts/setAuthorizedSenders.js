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

  /*──────── guarded read: prevent RPC hang ───*/
  const readWithTimeout = (promise, ms, label = "read") =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)),
    ]);

  let existing;
  try {
    existing = (await readWithTimeout(op.getAuthorizedSenders(), 60_000, "getAuthorizedSenders")).map((a) => a.toLowerCase());
  } catch (err) {
    console.log("⚠ Could not read current authorized senders:", err.message);
    console.log("  Proceeding to submit a transaction anyway (will merge client-provided addresses)." );
    existing = [];
  }

  /*──────── merge instead of overwrite ───*/
  const merged   = Array.from(new Set([...existing, ...nodeAddrs.map((n) => n.toLowerCase())]));

  if (merged.length === existing.length) {
    console.log("Nothing new to add – all nodes already authorised.");
    return;
  }

  /*──────── fee strategy (EIP-1559 preferred) ───*/
  let overrides = {};
  try {
    const feeData = await signer.provider.getFeeData();
    const fmt = (v) => (v ? Number(hre.ethers.formatUnits(v, 'gwei')).toFixed(2) + ' gwei' : null);
    console.log("Fee data:", {
      maxFeePerGas: fmt(feeData.maxFeePerGas),
      maxPriorityFeePerGas: fmt(feeData.maxPriorityFeePerGas),
      gasPrice: fmt(feeData.gasPrice),
    });

    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      overrides = {
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      };
      console.log("Using EIP-1559 overrides (type-2).");
    } else if (feeData.gasPrice) {
      overrides = { gasPrice: feeData.gasPrice };
      console.log("Using legacy gasPrice override.");
    } else {
      console.log("No fee data available from provider; sending without explicit overrides.");
    }
  } catch (e) {
    console.log("⚠ Failed to fetch fee data:", e.message);
  }

  // Add timeout protection for transaction submission
  console.log("Submitting transaction...");
  let tx;
  try {
    const txPromise = op.setAuthorizedSenders(merged, overrides);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Transaction submission timeout after 60 seconds')), 60000)
    );
    tx = await Promise.race([txPromise, timeoutPromise]);
    console.log("Tx submitted :", tx.hash);
  } catch (error) {
    if (error.message.includes('Transaction submission timeout')) {
      console.error("⚠ Transaction submission timed out after 60 seconds.");
      console.error("  The RPC endpoint may be unresponsive. Please try again later.");
      process.exit(1);
    }
    throw error; // Re-throw other errors
  }
  console.log("⏳ Waiting for transaction confirmation (timeout: 5 minutes)...");
  
  try {
    // Add timeout to prevent infinite hanging
    const receipt = await Promise.race([
      tx.wait(2), // Wait for 2 block confirmations
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Transaction timeout after 5 minutes')), 300000)
      )
    ]);
    console.log("✓ Authorised senders updated.");
  } catch (error) {
    if (error.message.includes('timeout')) {
      console.log("⚠ Transaction timed out but may still be mining.");
      console.log("  Check transaction status at: https://sepolia.basescan.org/tx/" + tx.hash);
      console.log("  If successful, authorization is complete. If failed, you may need to retry with higher gas.");
      process.exitCode = 0; // Don't fail the script for timeouts
      // Force exit to prevent hanging
      setTimeout(() => process.exit(0), 100); // Small delay to ensure logs are flushed
      return; // Exit the function
    } else {
      throw error; // Re-throw other errors
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

