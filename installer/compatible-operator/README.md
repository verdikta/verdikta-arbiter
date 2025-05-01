# Compatible Operator

This project provides a Chainlink Operator contract compatible with client contracts using Chainlink v0.4.1.

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Edit the `.env` file with your private key and RPC URL:
   ```
   # Private key without 0x prefix
   PRIVATE_KEY=your_private_key_here_without_0x_prefix
   
   # Base Sepolia RPC URL
   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
   
   # Optional: Chainlink node address for authorization
   NODE_ADDRESS=your_chainlink_node_address
   ```

## Deployment

1. Deploy the contract:
   ```
   npx truffle migrate --network baseSepolia
   ```

2. Authorize your Chainlink node:
   ```
   npx truffle exec scripts/authorize_node.js --network baseSepolia
   ```

3. Verify the deployment:
   ```
   npx truffle exec scripts/verify_operator.js --network baseSepolia
   ```

## Using with Client Contracts

Update your client contracts to use the deployed operator address.

The deployed CompatibleOperator contract is fully compatible with client contracts using Chainlink v0.4.1. 