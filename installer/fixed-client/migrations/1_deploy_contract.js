const AIChainlinkRequest = artifacts.require("AIChainlinkRequest");

module.exports = async function(deployer, network, accounts) {
  console.log('Deploying AIChainlinkRequest contract...');
  
  // Base Sepolia LINK token address
  const LINK_TOKEN_ADDRESS = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410";
  
  // Oracle address (operator contract)
  const ORACLE_ADDRESS = "0xbA6e6db45F11c5b787224C0bED7ba8dF913161Ff";
  
  // Job ID converted to bytes32 (remove hyphens)
  const jobId = "0x" + "36b5d5428d7f49e9bd38ff3ec01ae6d5".padEnd(64, '0');
  
  // Fee in LINK (0.05 LINK)
  const fee = "50000000000000000";
  
  await deployer.deploy(
    AIChainlinkRequest,
    ORACLE_ADDRESS,      // oracle address
    jobId,               // job ID
    fee,                 // fee in LINK
    LINK_TOKEN_ADDRESS   // LINK token address
  );
  
  const client = await AIChainlinkRequest.deployed();
  
  console.log("AIChainlinkRequest deployed at:", client.address);
  console.log("Using oracle at:", ORACLE_ADDRESS);
  console.log("Using LINK token at:", LINK_TOKEN_ADDRESS);
  console.log("Using job ID:", jobId);
  console.log("Using fee:", fee);
  
  // Verify contract configuration
  const config = await client.getContractConfig();
  console.log("\nContract configuration:");
  console.log("Oracle address:", config.oracleAddr);
  console.log("LINK address:", config.linkAddr);
  console.log("Job ID:", config.jobid);
  console.log("Fee:", config.currentFee.toString());
}; 