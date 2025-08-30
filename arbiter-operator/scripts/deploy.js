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
  
  let op;
  try {
    // Estimate gas for deployment
    console.log("Estimating deployment gas...");
    const deployTx = await ArbiterOperator.getDeployTransaction(LINK);
    const gasEstimate = await hre.ethers.provider.estimateGas(deployTx);
    
    // Add buffer to gas estimate for safety (50% buffer for contract deployment)
    const gasLimit = Math.ceil(Number(gasEstimate) * 1.5);
    console.log(`Gas estimate: ${gasEstimate.toString()}, using limit: ${gasLimit}`);
    
    op = await ArbiterOperator.deploy(LINK, { gasLimit });
  } catch (estimateError) {
    console.log("Gas estimation failed, using fallback gas limit...");
    console.log("Estimate error:", estimateError.message);
    
    // Use a reasonable fallback gas limit for contract deployment on mainnet
    const fallbackGasLimit = 2000000; // 2M gas for contract deployment
    console.log(`Using fallback gas limit: ${fallbackGasLimit}`);
    
    op = await ArbiterOperator.deploy(LINK, { gasLimit: fallbackGasLimit });
  }
  
  await op.waitForDeployment();

  console.log("ArbiterOperator deployed to", await op.getAddress());
}

main().catch((err) => { console.error(err); process.exitCode = 1; });


