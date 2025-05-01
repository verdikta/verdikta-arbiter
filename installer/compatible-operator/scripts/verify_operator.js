const CompatibleOperator = artifacts.require("CompatibleOperator");

module.exports = async function(callback) {
  try {
    const operator = await CompatibleOperator.deployed();
    
    console.log("Contract address:", operator.address);
    console.log("Owner:", await operator.owner());
    
    // Get the LINK token address
    const linkTokenAddress = await operator.getChainlinkToken();
    console.log("LINK token:", linkTokenAddress);
    
    // Get authorized senders
    const authorizedSenders = await operator.getAuthorizedSenders();
    console.log("Authorized senders:", authorizedSenders);

    // Check if the node is authorized
    const nodeAddress = "0xf9809c6D7b7FF992975A838A20CB20206CE2a956";
    const isAuthorized = await operator.isAuthorizedSender(nodeAddress);
    console.log("Is node authorized:", isAuthorized);

    // Exit successfully
    callback();
  } catch (error) {
    console.error("Error during verification:", error);
    callback(error);
  }
}; 