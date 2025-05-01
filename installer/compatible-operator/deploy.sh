#!/bin/bash

# Check if .env file exists
if [ ! -f .env ]; then
  echo "Error: .env file not found"
  echo "Create a .env file with PRIVATE_KEY and BASE_SEPOLIA_RPC_URL"
  exit 1
fi

# Source .env file
source .env

# Check if variables are set
if [ -z "$PRIVATE_KEY" ] || [ -z "$BASE_SEPOLIA_RPC_URL" ]; then
  echo "Error: PRIVATE_KEY or BASE_SEPOLIA_RPC_URL not set in .env file"
  exit 1
fi

# Deploy contract
echo "Deploying CompatibleOperator to Base Sepolia..."
npx truffle migrate --network baseSepolia

# Get the deployed contract address
CONTRACT_ADDRESS=$(grep -r "contract address:" build/contracts/CompatibleOperator.json | head -1 | awk '{print $3}' | tr -d ',"')

if [ -n "$CONTRACT_ADDRESS" ]; then
  echo "Contract deployed at: $CONTRACT_ADDRESS"
  
  # If NODE_ADDRESS is set, authorize it
  if [ -n "$NODE_ADDRESS" ]; then
    echo "Authorizing node $NODE_ADDRESS..."
    npx truffle exec scripts/authorize_node.js --network baseSepolia
  fi
  
  # Verify the deployment
  echo "Verifying deployment..."
  npx truffle exec scripts/verify_operator.js --network baseSepolia
else
  echo "Could not find contract address in build artifacts."
fi

echo "Deployment process completed." 