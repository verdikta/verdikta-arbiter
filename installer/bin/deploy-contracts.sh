#!/bin/bash

# Verdikta Validator Node - Smart Contracts Deployment Script
# Deploys the necessary smart contracts to Base Sepolia network

set -e  # Exit on any error

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALLER_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_DIR="$INSTALLER_DIR/config"
COMPATIBLE_OPERATOR_DIR="$INSTALLER_DIR/compatible-operator"

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Deploying Smart Contracts for Verdikta Validator Node...${NC}"

# Load environment variables
if [ -f "$INSTALLER_DIR/.env" ]; then
    source "$INSTALLER_DIR/.env"
else
    echo -e "${RED}Error: Environment file not found. Please run setup-environment.sh first.${NC}"
    exit 1
fi

# Load API keys
if [ -f "$INSTALLER_DIR/.api_keys" ]; then
    source "$INSTALLER_DIR/.api_keys"
else
    echo -e "${RED}Error: API keys file not found. Please run setup-environment.sh first.${NC}"
    exit 1
fi

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to prompt for Yes/No question
ask_yes_no() {
    local prompt="$1"
    local response
    
    while true; do
        read -p "$prompt (y/n): " response
        case "$response" in
            [Yy]* ) return 0;;
            [Nn]* ) return 1;;
            * ) echo "Please answer yes (y) or no (n).";;
        esac
    done
}

# Setup contracts directory
CONTRACTS_DIR="$INSTALL_DIR/contracts"
echo -e "${BLUE}Setting up contracts directory at $CONTRACTS_DIR...${NC}"
mkdir -p "$CONTRACTS_DIR"

# Check if the compatible-operator directory exists
if [ ! -d "$COMPATIBLE_OPERATOR_DIR" ]; then
    echo -e "${RED}Error: Compatible operator directory not found at $COMPATIBLE_OPERATOR_DIR${NC}"
    exit 1
fi

# Copy basicJobSpec from local chainlink-node directory
LOCAL_CHAINLINK_NODE_DIR="$(dirname "$INSTALLER_DIR")/chainlink-node"
if [ ! -f "$CONTRACTS_DIR/basicJobSpec" ]; then
    echo -e "${BLUE}Getting basicJobSpec template...${NC}"
    if [ -f "$LOCAL_CHAINLINK_NODE_DIR/basicJobSpec" ]; then
        cp "$LOCAL_CHAINLINK_NODE_DIR/basicJobSpec" "$CONTRACTS_DIR/basicJobSpec"
        echo -e "${GREEN}Copied basicJobSpec from $LOCAL_CHAINLINK_NODE_DIR${NC}"
    else
        echo -e "${RED}Error: basicJobSpec not found in $LOCAL_CHAINLINK_NODE_DIR${NC}"
        exit 1
    fi
fi

# Copy the compatible operator files to the contracts directory
OPERATOR_PROJECT_DIR="$CONTRACTS_DIR/compatible-operator"
echo -e "${BLUE}Setting up compatible operator at $OPERATOR_PROJECT_DIR...${NC}"

# Create directory if it doesn't exist
mkdir -p "$OPERATOR_PROJECT_DIR"

# Copy all files from the compatible-operator directory
echo -e "${BLUE}Copying compatible operator files...${NC}"
cp -r "$COMPATIBLE_OPERATOR_DIR"/* "$OPERATOR_PROJECT_DIR/"

# Instructions for getting the Chainlink node address
echo
echo -e "${YELLOW}You need your Chainlink node address for contract authorization:${NC}"
echo -e "${YELLOW}1. Go to the Chainlink node UI at http://localhost:6688${NC}"
echo -e "${YELLOW}2. Navigate to 'Key Management' -> 'EVM Chain Accounts'${NC}"
echo -e "${YELLOW}3. Copy the Node Address (starts with 0x)${NC}"

# Ask for the Chainlink node address
echo
read -p "Enter the Chainlink node address (0x...): " NODE_ADDRESS

# Validate the address
if [[ ! "$NODE_ADDRESS" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
    echo -e "${RED}Error: Invalid Ethereum address format. Please enter a valid address starting with '0x'.${NC}"
    exit 1
fi

# Check if private key exists in environment variables
if [ -z "$PRIVATE_KEY" ]; then
    echo
    echo -e "${YELLOW}To deploy the operator contract, a wallet private key is needed.${NC}"
    echo -e "${YELLOW}This key will be used only for deployment and should have Base Sepolia ETH.${NC}"
    read -p "Enter your wallet private key (without 0x prefix): " PRIVATE_KEY

    # Validate private key format (basic check)
    if [[ ! "$PRIVATE_KEY" =~ ^[a-fA-F0-9]{64}$ ]]; then
        echo -e "${RED}Error: Invalid private key format. It should be 64 hexadecimal characters without 0x prefix.${NC}"
        exit 1
    fi
    
    # Save the private key for future use
    if grep -q "PRIVATE_KEY=" "$INSTALLER_DIR/.env" 2>/dev/null; then
        # Update existing private key entry
        sed -i "s/PRIVATE_KEY=.*/PRIVATE_KEY=\"$PRIVATE_KEY\"/" "$INSTALLER_DIR/.env"
    else
        # Append new private key entry
        echo "PRIVATE_KEY=\"$PRIVATE_KEY\"" >> "$INSTALLER_DIR/.env"
    fi
    
    # Set restrictive permissions on .env file
    chmod 600 "$INSTALLER_DIR/.env"
else
    echo -e "${GREEN}Using private key from environment configuration.${NC}"
fi

# Setup .env file for the compatible operator project
cat > "$OPERATOR_PROJECT_DIR/.env" << EOL
# Private key without 0x prefix
PRIVATE_KEY=$PRIVATE_KEY

# Base Sepolia RPC URL
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org

# Node Address (Chainlink node)
NODE_ADDRESS=$NODE_ADDRESS
EOL

# Navigate to the compatible operator directory and deploy
echo -e "${BLUE}Deploying compatible operator contract...${NC}"
cd "$OPERATOR_PROJECT_DIR"

# Install npm dependencies
echo -e "${BLUE}Installing npm dependencies...${NC}"
npm install

# Run deployment script
echo -e "${BLUE}Running deployment script...${NC}"
bash ./deploy.sh

# Get the contract address from the build artifacts - FIXING THE EXTRACTION PATTERN
# The original pattern was looking for "contract address:" which doesn't match
CONTRACT_ADDRESS=""

# First try to get address from deployment output directly
if [ -f "build/contracts/CompatibleOperator.json" ]; then
    # Use a more robust pattern for JSON parsing
    CONTRACT_ADDRESS=$(grep -o '"address": "[^"]*"' build/contracts/CompatibleOperator.json | head -1 | cut -d'"' -f4)
    
    # If that fails, try alternate patterns
    if [ -z "$CONTRACT_ADDRESS" ]; then
        # Try a more flexible grep approach
        CONTRACT_ADDRESS=$(grep -A 2 "networks" build/contracts/CompatibleOperator.json | grep -o '0x[a-fA-F0-9]\{40\}' | head -1)
    fi
fi

# If still not found, ask the user to provide it from the visible deployment output
if [ -z "$CONTRACT_ADDRESS" ]; then
    echo -e "${YELLOW}Unable to automatically extract the contract address from build artifacts.${NC}"
    echo -e "${YELLOW}However, the contract appears to have been deployed successfully.${NC}"
    echo -e "${YELLOW}Please copy the contract address from the deployment output above.${NC}"
    
    read -p "Enter the deployed contract address (0x...): " CONTRACT_ADDRESS
    
    # Validate the address format
    if [[ ! "$CONTRACT_ADDRESS" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
        echo -e "${RED}Error: Invalid Ethereum address format. Please enter a valid address starting with '0x'.${NC}"
        exit 1
    fi
fi

# Save the contract address
echo "OPERATOR_ADDRESS=\"$CONTRACT_ADDRESS\"" > "$INSTALLER_DIR/.contracts"
echo "NODE_ADDRESS=\"$NODE_ADDRESS\"" >> "$INSTALLER_DIR/.contracts"
echo -e "${GREEN}Operator contract address saved to $INSTALLER_DIR/.contracts: $CONTRACT_ADDRESS${NC}"
echo -e "${GREEN}Node address saved to $INSTALLER_DIR/.contracts: $NODE_ADDRESS${NC}"

# Authorize the Chainlink node with the operator contract
echo -e "${BLUE}Authorizing the Chainlink node with the operator contract...${NC}"
cd "$OPERATOR_PROJECT_DIR"
# Run the authorization script
echo -e "${BLUE}Running node authorization script...${NC}"
npx truffle exec scripts/authorize_node.js --network baseSepolia

# Verify the node authorization
echo -e "${BLUE}Verifying node authorization...${NC}"
npx truffle exec scripts/verify_operator.js --network baseSepolia

# Generate a random job ID
JOB_ID=$(openssl rand -hex 16 | sed 's/\(..\)\(..\)\(..\)\(..\)-\(..\)\(..\)-\(..\)\(..\)-\(..\)\(..\)-\(..\)\(..\)\(..\)\(..\)\(..\)\(..\)/\1\2\3\4-\5\6-\7\8-\9\10-\11\12\13\14\15\16/' | sed 's/.\{8\}/&-&/;s/.\{13\}/&-&/;s/.\{18\}/&-&/')
JOB_ID_NO_HYPHENS=$(echo "$JOB_ID" | tr -d '-')

# Save the job ID
echo "JOB_ID=\"$JOB_ID\"" >> "$INSTALLER_DIR/.contracts"
echo "JOB_ID_NO_HYPHENS=\"$JOB_ID_NO_HYPHENS\"" >> "$INSTALLER_DIR/.contracts"
echo -e "${GREEN}Job ID generated: $JOB_ID${NC}"
echo -e "${GREEN}Job ID (no hyphens): $JOB_ID_NO_HYPHENS${NC}"

# Save deployment information
echo -e "${BLUE}Saving deployment information...${NC}"
# Save info into INSTALL_DIR
if [ -z "$INSTALL_DIR" ]; then echo "${RED}INSTALL_DIR not set, cannot save deployment info.${NC}"; exit 1; fi
DEPLOYMENT_INFO_DIR="$INSTALL_DIR/info"

mkdir -p "$DEPLOYMENT_INFO_DIR"
cat > "$DEPLOYMENT_INFO_DIR/deployment.txt" << EOL
Verdikta Smart Contract Deployment Information
=============================================

Operator Contract Address: $CONTRACT_ADDRESS
Chainlink Node Address: $NODE_ADDRESS
Job ID: $JOB_ID
Job ID (no hyphens): $JOB_ID_NO_HYPHENS

For detailed instructions, please refer to the official Verdikta Arbiter documentation.
EOL

echo -e "${GREEN}Smart Contract deployment steps completed!${NC}"
echo -e "${BLUE}Next step: Configuring Node Jobs and Bridges${NC}"

exit 0 