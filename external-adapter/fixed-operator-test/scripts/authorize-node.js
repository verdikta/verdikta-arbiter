const FixedOperator = artifacts.require("FixedOperator");

module.exports = async function(callback) {
  try {
    const operatorInstance = await FixedOperator.deployed();
    const nodeAddress = process.env.NODE_ADDRESS;
    
    if (!nodeAddress) {
      console.error("NODE_ADDRESS environment variable is not set");
      callback(new Error("NODE_ADDRESS not set"));
      return;
    }
    
    console.log('Authorizing node address:', nodeAddress);
    await operatorInstance.setAuthorizedSenders([nodeAddress]);
    console.log('Node authorized successfully');
    
    callback();
  } catch (err) {
    console.error('Error:', err);
    callback(err);
  }
}; 