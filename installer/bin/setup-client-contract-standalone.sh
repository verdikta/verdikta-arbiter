#!/bin/bash

# Verdikta Validator Node - Standalone Client Contract Setup Script
# ==============================================================
#
# This script sets up the client contract for the Verdikta Validator Node.
# The client contract is essential for:
#   1. Connecting your frontend applications to the Chainlink oracle network
#   2. Making requests to your Verdikta Validator Node
#   3. Receiving validated AI evaluation results on-chain
#
# If you've already completed the rest of the Verdikta Validator Node setup,
# this script will help you add the missing client contract component.
#
# Prerequisites:
#   - Completed Verdikta Validator Node installation (Steps 1-8)
#   - Operator contract deployed and configured
#   - Chainlink node with job set up
#   - MetaMask wallet with Base Sepolia ETH for gas fees
#   - Ability to get Base Sepolia LINK tokens for oracle payments

# Include and run the main client contract setup script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "============================================================"
echo "     Verdikta Validator Node - Client Contract Setup        "
echo "============================================================"
echo ""
echo "This script will set up the client contract for your Verdikta Validator Node."
echo "The client contract is necessary for connecting frontend applications to your"
echo "validator and making requests to your Chainlink node."
echo ""
echo "The script will:"
echo "  1. Clone the client contract repository"
echo "  2. Install dependencies (Truffle, Chainlink contracts, etc.)"
echo "  3. Configure the contract with your operator address and job ID"
echo "  4. Deploy the contract to Base Sepolia testnet"
echo "  5. Guide you through funding and authorization steps"
echo ""
echo "Prerequisites:"
echo "  - Operator contract deployed (from deploy-contracts.sh)"
echo "  - Chainlink job configured (from configure-node.sh)"
echo "  - MetaMask wallet with Base Sepolia ETH for deployment"
echo "  - Access to Base Sepolia LINK tokens for oracle payments"
echo ""
echo "Press ENTER to continue or CTRL+C to cancel"
read

# Execute the client contract setup script
exec "$SCRIPT_DIR/setup-client-contract.sh" 