const FixedOperator = artifacts.require("FixedOperator");

module.exports = function(deployer) {
  // Base Sepolia LINK token address
  const linkTokenAddress = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410";
  
  deployer.deploy(FixedOperator, linkTokenAddress)
    .then(async (operatorInstance) => {
      console.log("Fixed Operator contract deployed to:", operatorInstance.address);
    });
}; 