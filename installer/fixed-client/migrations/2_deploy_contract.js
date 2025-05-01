const AIChainlinkRequest = artifacts.require("AIChainlinkRequest");

module.exports = function(deployer, network, accounts) {
  // Deployment parameters
  const linkTokenAddress = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410"; // Base Sepolia LINK Token address
  const oracleAddress = "0x565d2Be50501f7eCbaAD81d388530Bf8032f51dD"; // Operator contract address with fulfillOracleRequest3 support
  
  // The Job ID must be converted to bytes32
  // Job ID from Chainlink UI: 61746bd4-9cdf-4ff9-b596-311474f0b026
  const jobId = web3.utils.toHex("61746bd49cdf4ff9b596311474f0b026");
  
  // Fee to use for requests (0.05 LINK)
  const fee = web3.utils.toWei("0.05", "ether");
  
  console.log("Deploying with:");
  console.log("- Link Token Address:", linkTokenAddress);
  console.log("- Oracle Address:", oracleAddress);
  console.log("- Job ID:", jobId);
  console.log("- Fee:", fee, "wei");
  
  // Deploy the contract with these parameters
  deployer.deploy(AIChainlinkRequest, oracleAddress, jobId, fee, linkTokenAddress);
}; 