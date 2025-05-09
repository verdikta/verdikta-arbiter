// SPDX-License-Identifier: MIT
//
// Set the Chainlink node addresses that are allowed to call fulfillOracleRequest
//
// ──────────────── USAGE ─────────────────────────────────────────────────────────
// NODES=<comma-separated EOA addresses> \          # REQUIRED
// OPERATOR=<operatorAddr> \                        # optional (auto-detects if omitted)
// npx hardhat run scripts/setAuthorizedSenders.js --network <networkName>
//
// Example:
// NODES=0xA2944d1Dd73DB724d9bA31a80Ea240B5dF922498 \
// npx hardhat run scripts/setAuthorizedSenders.js --network base_sepolia
// ────────────────────────────────────────────────────────────────────────────────

const hre   = require("hardhat");
const fs    = require("fs");
const path  = require("path");

async function main() {
  /*── read env-vars ───────────────────────────────────────────────────────────*/
  const nodeAddrs = (process.env.NODES || "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "");

  if (nodeAddrs.length === 0) {
    throw new Error(
      "Set env-var NODES with a comma-separated list of Chainlink node addresses"
    );
  }

  let operatorAddr = process.env.OPERATOR; // optional override

  /*── if OPERATOR not provided, read from deployments file ────────────────────*/
  if (!operatorAddr) {
    const depPath = path.join(
      __dirname,
      "..",
      "deployments",
      hre.network.name,
      "ArbiterOperator.json"
    );

    if (!fs.existsSync(depPath)) {
      throw new Error(
        `Can't find ${depPath}. Provide OPERATOR env-var with the contract address.`
      );
    }
    operatorAddr = JSON.parse(fs.readFileSync(depPath, "utf8")).address;
  }

  /*── summary ─────────────────────────────────────────────────────────────────*/
  console.log("Network:          ", hre.network.name);
  console.log("Operator address: ", operatorAddr);
  console.log("New sender(s):    ", nodeAddrs.join(", "));

  /*── signer + contract ───────────────────────────────────────────────────────*/
  const [deployer] = await hre.ethers.getSigners();
  console.log("Tx signer:        ", deployer.address);

  const Operator = await hre.ethers.getContractAt("ArbiterOperator", operatorAddr);

  /*── send tx ─────────────────────────────────────────────────────────────────*/
  const tx = await Operator.setAuthorizedSenders(nodeAddrs);
  console.log("Submitted tx:     ", tx.hash);
  await tx.wait(2); // 2 confirmations

  /*── verify ─────────────────────────────────────────────────────────────────*/
  const updated = await Operator.getAuthorizedSenders();
  console.log("Authorized senders now:", updated);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

