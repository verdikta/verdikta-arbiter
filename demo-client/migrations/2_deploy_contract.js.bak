const AIChainlinkRequest = artifacts.require("AIChainlinkRequest");

module.exports = function (deployer) {
	          const oracleAddress = "0x205aD129bF48E7f6b352ED615564511B70648377"; // Oracle address
                  const jobId = web3.utils.padRight(web3.utils.fromAscii("38f19572c51041baa5f2dea284614590"), 64);

	          const fee = web3.utils.toWei("0.05", "ether"); // Example fee in LINK tokens
	          const linkTokenAddress = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410"; // Sepolia Base LINK token address
	          const requiredClass = 128; // The required oracle class

	          deployer.deploy(AIChainlinkRequest, oracleAddress, jobId, fee, linkTokenAddress, requiredClass);
};
