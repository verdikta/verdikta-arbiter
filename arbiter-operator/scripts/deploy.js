const hre   = require("hardhat");
const fs    = require("fs");
const path  = require("path");

async function main() {
  const networkName = hre.network.name;   // e.g. "base_sepolia"

  // Read JSON once
  const ADDRS = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployment-addresses.json"), "utf8")
  )[networkName];

  if (!ADDRS || !ADDRS.linkTokenAddress) {
    throw new Error(`No linkTokenAddress in deployment-addresses.json for ${networkName}`);
  }
  const LINK = ADDRS.linkTokenAddress;

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deploying ArbiterOperator from ${deployer.address}`);
  console.log(`Using LINK token:          ${LINK}`);

  const ArbiterOperator = await hre.ethers.getContractFactory("ArbiterOperator");
  const op = await ArbiterOperator.deploy(LINK);
  await op.waitForDeployment();

  console.log("ArbiterOperator deployed to", await op.getAddress());
}

main().catch((err) => { console.error(err); process.exitCode = 1; });


