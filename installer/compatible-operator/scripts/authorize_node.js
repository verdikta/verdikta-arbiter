const CompatibleOperator = artifacts.require("CompatibleOperator");

module.exports = async function(callback) {
  try {
    const operator = await CompatibleOperator.deployed();
    
    // Replace with your Chainlink node address
    const nodeAddress = process.env.NODE_ADDRESS || "0x0000000000000000000000000000000000000000";
    
    console.log("Authorizing Chainlink node at address:", nodeAddress);
    
    // Set the node as an authorized sender
    await operator.setAuthorizedSenders([nodeAddress]);
    
    console.log("Node authorized successfully!");
    callback();
  } catch (error) {
    console.error("Error authorizing node:", error);
    callback(error);
  }
}; 