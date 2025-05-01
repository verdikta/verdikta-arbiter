const AIChainlinkRequest = artifacts.require("AIChainlinkRequest");

// ERC20 ABI for the LINK token (approve function)
const ERC20_ABI = [
  {
    "constant": true,
    "inputs": [{ "name": "_owner", "type": "address" }],
    "name": "balanceOf",
    "outputs": [{ "name": "balance", "type": "uint256" }],
    "type": "function"
  },
  {
    "constant": false,
    "inputs": [
      { "name": "_spender", "type": "address" },
      { "name": "_value", "type": "uint256" }
    ],
    "name": "approve",
    "outputs": [{ "name": "", "type": "bool" }],
    "type": "function"
  }
];

module.exports = async function(callback) {
  try {
    const accounts = await web3.eth.getAccounts();
    const sender = accounts[0];
    console.log("Using account:", sender);
    
    // Get deployed instance
    const contract = await AIChainlinkRequest.deployed();
    console.log("Contract deployed at:", contract.address);
    
    // Updated Job ID for the new job pointing to the correct operator contract
    console.log("Job ID: 61746bd4-9cdf-4ff9-b596-311474f0b026");
    
    // IMPORTANT: Use the correct LINK token address
    const linkTokenAddress = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410"; // Base Sepolia LINK
    console.log("LINK token address:", linkTokenAddress);
    
    // Create LINK token contract instance
    const linkToken = new web3.eth.Contract(ERC20_ABI, linkTokenAddress);
    
    // Check LINK balance of the sender
    const userLinkBalance = await linkToken.methods.balanceOf(sender).call();
    console.log("Your LINK balance:", web3.utils.fromWei(userLinkBalance, "ether"), "LINK");
    
    if (userLinkBalance === "0") {
      console.log("\nWARNING: You have no LINK tokens!");
      console.log("Please get LINK tokens from the Base Sepolia faucet: https://faucets.chain.link");
      return callback();
    }
    
    // Prepare to make a request
    console.log("\nPreparing to make a request...");
    
    // Example CIDs - replace with your actual CIDs
    const cids = ["QmPK1s3pNYLi9ERiq3BDxKa4XosgWwFRQUydHUtz4YgpqB"];
    console.log("Using CIDs:", cids);
    
    // Approve the contract to use LINK tokens
    const fee = web3.utils.toWei("0.05", "ether"); // 0.05 LINK fee
    console.log(`\nApproving contract to transfer ${web3.utils.fromWei(fee, "ether")} LINK tokens from your wallet...`);
    try {
      await linkToken.methods.approve(contract.address, fee).send({ from: sender });
      console.log("Approval successful!");
    } catch (error) {
      console.error("Error approving LINK transfer:", error.message);
      return callback(error);
    }
    
    // Make the request
    console.log("\nSending AI evaluation request...");
    try {
      const tx = await contract.requestAIEvaluationWithApproval(
        cids,
        0, 0, 0, 0, // Extra parameters (ignored)
        { from: sender }
      );
      console.log("Request sent successfully!");
      console.log("Transaction hash:", tx.tx);
      
      if (tx.logs && tx.logs.length > 0) {
        const requestId = tx.logs[0].args.requestId;
        console.log("Request ID:", requestId);
      }
    } catch (error) {
      console.error("Error making request:", error.message);
      return callback(error);
    }
    
    console.log("\nNext steps:");
    console.log("1. The Chainlink node should pick up this request");
    console.log("2. Monitor the Chainlink node for the fulfillment");
    
    callback();
  } catch (error) {
    console.error("Error:", error);
    callback(error);
  }
} 