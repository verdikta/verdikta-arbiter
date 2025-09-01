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
  
  // Deploy with proper gas settings for Base mainnet
  console.log("Deploying contract...");
  
  // Get current gas price from the network
  const feeData = await hre.ethers.provider.getFeeData();
  console.log(`Current gas price: ${hre.ethers.formatUnits(feeData.gasPrice, "gwei")} gwei`);
  
  // Deploy with a small buffer on gas price to ensure it goes through
  const gasPrice = (feeData.gasPrice * 120n) / 100n; // 20% buffer
  console.log(`Using gas price: ${hre.ethers.formatUnits(gasPrice, "gwei")} gwei`);
  
  const op = await ArbiterOperator.deploy(LINK, {
    gasPrice: gasPrice,
    gasLimit: 3500000 // 3.5M gas should be sufficient
  });
  
  console.log("Transaction sent, waiting for confirmation...");
  console.log("Transaction hash:", op.deploymentTransaction().hash);
  
  await op.waitForDeployment();

  console.log("ArbiterOperator deployed to", await op.getAddress());
}

main().catch((err) => { console.error(err); process.exitCode = 1; });


