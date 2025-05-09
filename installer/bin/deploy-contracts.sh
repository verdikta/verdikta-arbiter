#!/bin/bash

# Verdikta Arbiter Node - Smart Contracts Deployment Script
# Deploys the necessary smart contracts to Base Sepolia network

set -e  # Exit on any error

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALLER_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_DIR="$INSTALLER_DIR/config"
# COMPATIBLE_OPERATOR_DIR="$INSTALLER_DIR/compatible-operator" # Ensure this line is removed or commented

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Deploying Smart Contracts for Verdikta Arbiter Node...${NC}"

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

# --- ALL COMPATIBLE-OPERATOR AND TRUFFLE LOGIC REMOVED FROM HERE --- 
# --- UNTIL THE "Instructions for getting the Chainlink node address" SECTION ---

# Instructions for getting the Chainlink node address (This section will be kept and used)
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

# Check if private key exists in environment variables (This section will be kept and used)
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

# Placeholder for CONTRACT_ADDRESS which will be set by Hardhat deployment
CONTRACT_ADDRESS=""

# --- NEW HARDHAT DEPLOYMENT LOGIC ---

echo -e "${BLUE}Setting up ArbiterOperator deployment using Hardhat...${NC}"

ARBITER_OPERATOR_SRC_DIR="$(dirname "$INSTALLER_DIR")/arbiter-operator"
OPERATOR_BUILD_DIR="$INSTALL_DIR/contracts/arbiter-operator-build"

if [ ! -d "$ARBITER_OPERATOR_SRC_DIR" ]; then
    echo -e "${RED}Error: ArbiterOperator source directory not found at $ARBITER_OPERATOR_SRC_DIR${NC}"
    exit 1
fi

echo -e "${BLUE}Creating temporary build directory for ArbiterOperator: $OPERATOR_BUILD_DIR${NC}"
rm -rf "$OPERATOR_BUILD_DIR"
mkdir -p "$OPERATOR_BUILD_DIR/scripts" # Ensure scripts subdirectory exists

echo -e "${BLUE}Copying ArbiterOperator files to build directory...${NC}"
cp -r "$ARBITER_OPERATOR_SRC_DIR/contracts" "$OPERATOR_BUILD_DIR/"
cp "$ARBITER_OPERATOR_SRC_DIR/hardhat.config.js" "$OPERATOR_BUILD_DIR/"
cp "$ARBITER_OPERATOR_SRC_DIR/package.json" "$OPERATOR_BUILD_DIR/"
if [ -f "$ARBITER_OPERATOR_SRC_DIR/package-lock.json" ]; then
    cp "$ARBITER_OPERATOR_SRC_DIR/package-lock.json" "$OPERATOR_BUILD_DIR/"
fi
# Copy the Hardhat-deploy 'deploy' scripts folder if it exists (standard for hardhat-deploy)
if [ -d "$ARBITER_OPERATOR_SRC_DIR/deploy" ]; then
    cp -r "$ARBITER_OPERATOR_SRC_DIR/deploy" "$OPERATOR_BUILD_DIR/"
fi
# Copy our custom scripts folder (scripts/deploy.js, scripts/setAuthorizedSenders.js)
cp -r "$ARBITER_OPERATOR_SRC_DIR/scripts" "$OPERATOR_BUILD_DIR/"
# Copy the lib directory
if [ -d "$ARBITER_OPERATOR_SRC_DIR/lib" ]; then
    cp -r "$ARBITER_OPERATOR_SRC_DIR/lib" "$OPERATOR_BUILD_DIR/"
else
    echo -e "${YELLOW}Warning: lib directory not found in $ARBITER_OPERATOR_SRC_DIR, but might be needed by contracts.${NC}"
fi
# Copy deployment-addresses.json
if [ -f "$ARBITER_OPERATOR_SRC_DIR/deployment-addresses.json" ]; then
    cp "$ARBITER_OPERATOR_SRC_DIR/deployment-addresses.json" "$OPERATOR_BUILD_DIR/"
else
    echo -e "${RED}Error: deployment-addresses.json not found in $ARBITER_OPERATOR_SRC_DIR${NC}"
    exit 1
fi

cd "$OPERATOR_BUILD_DIR"

echo -e "${BLUE}Installing ArbiterOperator dependencies...${NC}"
npm install

echo -e "${BLUE}Creating .env file for Hardhat deployment...${NC}"
# Ensure PRIVATE_KEY has 0x prefix for Hardhat/ethers
HH_PRIVATE_KEY=$PRIVATE_KEY
if [[ ! "$HH_PRIVATE_KEY" =~ ^0x ]]; then
    HH_PRIVATE_KEY="0x$HH_PRIVATE_KEY"
fi
cat > .env << EOL
PRIVATE_KEY=$HH_PRIVATE_KEY
INFURA_API_KEY=$INFURA_API_KEY
NODE_ADDRESS=$NODE_ADDRESS
EOL
# Note: NODE_ADDRESS is added here for setAuthorizedSenders.js to potentially pick up if needed

echo -e "${BLUE}Deploying ArbiterOperator contract via Hardhat...${NC}"
# Run the custom deploy script and capture its output
DEPLOY_OUTPUT_FILE="deploy_output.log"
if npx hardhat run scripts/deploy.js --network base_sepolia > "$DEPLOY_OUTPUT_FILE" 2>&1; then
    echo -e "${GREEN}ArbiterOperator deployment script executed. Output in $DEPLOY_OUTPUT_FILE${NC}"
    cat "$DEPLOY_OUTPUT_FILE" # Display output for user
else
    echo -e "${RED}ArbiterOperator deployment script failed. Output in $DEPLOY_OUTPUT_FILE${NC}"
    cat "$DEPLOY_OUTPUT_FILE" # Display error output for user
    exit 1
fi

echo -e "${BLUE}Extracting deployed ArbiterOperator address from script output...${NC}"
CONTRACT_ADDRESS=$(grep 'ArbiterOperator deployed to' "$DEPLOY_OUTPUT_FILE" | awk '{print $NF}')

if [[ ! "$CONTRACT_ADDRESS" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
    echo -e "${RED}Failed to extract contract address from deployment script output.${NC}"
    echo -e "${YELLOW}Output was:${NC}"
    cat "$DEPLOY_OUTPUT_FILE"
    read -p "Please enter the deployed ArbiterOperator contract address manually: " CONTRACT_ADDRESS
fi

if [[ ! "$CONTRACT_ADDRESS" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
    echo -e "${RED}Invalid or empty contract address obtained for ArbiterOperator: '$CONTRACT_ADDRESS'${NC}"
    exit 1
fi
echo -e "${GREEN}ArbiterOperator deployed at: $CONTRACT_ADDRESS${NC}"

# Save the contract address (This will be updated after Hardhat deployment)
# The OPERATOR_ADDRESS will be the $CONTRACT_ADDRESS from Hardhat
echo "OPERATOR_ADDRESS=\"$CONTRACT_ADDRESS\"" > "$INSTALLER_DIR/.contracts"
echo "NODE_ADDRESS=\"$NODE_ADDRESS\"" >> "$INSTALLER_DIR/.contracts"
echo -e "${GREEN}Operator contract address saved to $INSTALLER_DIR/.contracts: $CONTRACT_ADDRESS${NC}"
echo -e "${GREEN}Node address saved to $INSTALLER_DIR/.contracts: $NODE_ADDRESS${NC}"

# --- NODE AUTHORIZATION LOGIC USING HARDHAT ---

echo -e "${BLUE}Authorizing Chainlink node with ArbiterOperator contract...${NC}"
# The NODE_ADDRESS is already in the .env file in OPERATOR_BUILD_DIR
# The setAuthorizedSenders.js script should read CONTRACT_ADDRESS (as OPERATOR) from env or accept as param
# For now, let's assume setAuthorizedSenders.js uses process.env.OPERATOR_ADDRESS and process.env.NODE_ADDRESS
# We need to set OPERATOR_ADDRESS in the environment for the script
# We are already in $OPERATOR_BUILD_DIR
echo -e "${BLUE}Running Hardhat script to authorize node...${NC}"
if env OPERATOR="$CONTRACT_ADDRESS" NODES="$NODE_ADDRESS" npx hardhat run scripts/setAuthorizedSenders.js --network base_sepolia; then
    echo -e "${GREEN}Chainlink node authorization script executed successfully.${NC}"
else
    echo -e "${RED}Chainlink node authorization script failed.${NC}"
    # It's not critical to exit here, user can do it manually later if needed
    echo -e "${YELLOW}You may need to authorize the node manually using Hardhat tasks or scripts in $OPERATOR_BUILD_DIR/scripts.${NC}"
fi
# --- END NODE AUTHORIZATION LOGIC ---

# Generate a random job ID (This section can be kept)
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

Operator Contract Address: $CONTRACT_ADDRESS # This will be the new Hardhat deployed address
Chainlink Node Address: $NODE_ADDRESS
Job ID: $JOB_ID
Job ID (no hyphens): $JOB_ID_NO_HYPHENS

For detailed instructions, please refer to the official Verdikta Arbiter documentation.
EOL

echo -e "${GREEN}Smart Contract deployment steps completed!${NC}"
echo -e "${BLUE}Next step: Configuring Node Jobs and Bridges${NC}"

exit 0 