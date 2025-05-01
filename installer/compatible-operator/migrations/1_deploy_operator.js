const CompatibleOperator = artifacts.require("CompatibleOperator");

// Base Sepolia LINK token address (CORRECT address)
const LINK_TOKEN_ADDRESS = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410";

module.exports = async function(deployer, network, accounts) {
  const owner = accounts[0];
  console.log("Deploying with owner:", owner);
  
  await deployer.deploy(CompatibleOperator, LINK_TOKEN_ADDRESS, owner);
  const operatorContract = await CompatibleOperator.deployed();
  
  console.log("CompatibleOperator deployed at:", operatorContract.address);
  console.log("Owner:", owner);
  console.log("LINK Token:", LINK_TOKEN_ADDRESS);
}; 