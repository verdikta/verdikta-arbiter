#!/bin/bash

# Verdikta Arbiter Node - Oracle Registration Script
# Registers the oracle with the dispatcher contract

set -e  # Exit on any error

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALLER_DIR="$(dirname "$SCRIPT_DIR")"
ARBITER_OPERATOR_DIR="$(dirname "$INSTALLER_DIR")/arbiter-operator"

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Oracle Registration with Dispatcher${NC}"

# Load environment variables
if [ -f "$INSTALLER_DIR/.env" ]; then
    source "$INSTALLER_DIR/.env"
else
    echo -e "${RED}Error: Environment file not found. Please run setup-environment.sh first.${NC}"
    exit 1
fi

# Load contract information
if [ -f "$INSTALLER_DIR/.contracts" ]; then
    source "$INSTALLER_DIR/.contracts"
else
    echo -e "${RED}Error: Contract information file not found. Please run deploy-contracts.sh first.${NC}"
    exit 1
fi

# Verify required variables
if [ -z "$OPERATOR_ADDRESS" ]; then
    echo -e "${RED}Error: Operator contract address not found in .contracts file${NC}"
    exit 1
fi

if [ -z "$LINK_TOKEN_ADDRESS_BASE_SEPOLIA" ]; then
    echo -e "${RED}Error: LINK token address not found in .contracts file${NC}"
    exit 1
fi

if [ -z "$NODE_ADDRESS" ]; then
    echo -e "${RED}Error: Node address not found in .contracts file${NC}"
    exit 1
fi

if [ -z "$JOB_ID_NO_HYPHENS" ]; then
    echo -e "${RED}Error: Job ID (no hyphens) not found in .contracts file${NC}"
    exit 1
fi

# Create .env file in arbiter-operator directory
echo -e "${BLUE}Creating .env file in arbiter-operator directory...${NC}"
cat > "$ARBITER_OPERATOR_DIR/.env" << EOL
PRIVATE_KEY=$PRIVATE_KEY
INFURA_API_KEY=$INFURA_API_KEY
EOL
chmod 600 "$ARBITER_OPERATOR_DIR/.env"
echo -e "${GREEN}.env file created in arbiter-operator directory${NC}"

# Define the correct wrapped VDKA address
WRAPPED_VERDIKTA_ADDRESS="0x2F1d1aF9d5C25A48C29f56f57c7BAFFa7cc910a3"  # Correct wrapped VDKA address

# Ask if user wants to register with a dispatcher
echo -e "${YELLOW}Would you like to register the oracle with a dispatcher (aggregator) contract?${NC}"
read -p "Register with dispatcher? (y/n): " register_response
if [[ ! "$register_response" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Oracle registration skipped.${NC}"
    exit 0
fi

# Get the Aggregator address from the user
echo -e "${YELLOW}Please enter the Aggregator contract address (0x...):${NC}"
read -p "Aggregator address: " AGGREGATOR_ADDRESS

# Validate Aggregator address format
if [[ ! "$AGGREGATOR_ADDRESS" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
    echo -e "${RED}Error: Invalid Aggregator address format. Must be a valid Ethereum address starting with 0x.${NC}"
    exit 1
fi

# Ask for classes ID with default
echo -e "${YELLOW}Please enter the classes ID (default: 128):${NC}"
read -p "Classes ID [128]: " CLASSES_ID
CLASSES_ID=${CLASSES_ID:-128}  # Use 128 as default if no input

# Validate classes ID is a number
if ! [[ "$CLASSES_ID" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}Error: Classes ID must be a number.${NC}"
    exit 1
fi

# Construct the registration command
REGISTER_CMD="HARDHAT_NETWORK=base_sepolia node scripts/register-oracle-cl.js \
  --aggregator $AGGREGATOR_ADDRESS \
  --link $LINK_TOKEN_ADDRESS_BASE_SEPOLIA \
  --oracle $OPERATOR_ADDRESS \
  --wrappedverdikta $WRAPPED_VERDIKTA_ADDRESS \
  --jobids \"$JOB_ID_NO_HYPHENS\" \
  --classes $CLASSES_ID"

# Display the command and ask for confirmation
echo -e "${BLUE}The following command will be executed:${NC}"
echo "$REGISTER_CMD"
echo
read -p "Proceed with executing this command? (y/n): " response
if [[ ! "$response" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Oracle registration cancelled.${NC}"
    exit 0
fi

# Execute the registration command
echo -e "${BLUE}Executing oracle registration script...${NC}"
cd "$ARBITER_OPERATOR_DIR"
eval "$REGISTER_CMD"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}Oracle registration completed successfully!${NC}"
    
    # Save the aggregator address to .contracts file
    if grep -q "AGGREGATOR_ADDRESS=" "$INSTALLER_DIR/.contracts" 2>/dev/null; then
        # Update existing aggregator address entry
        sed -i "s/AGGREGATOR_ADDRESS=.*/AGGREGATOR_ADDRESS=\"$AGGREGATOR_ADDRESS\"/" "$INSTALLER_DIR/.contracts"
    else
        # Append new aggregator address entry
        echo "AGGREGATOR_ADDRESS=\"$AGGREGATOR_ADDRESS\"" >> "$INSTALLER_DIR/.contracts"
    fi
    echo -e "${GREEN}Aggregator address saved to .contracts file: $AGGREGATOR_ADDRESS${NC}"
else
    echo -e "${RED}Oracle registration script failed. Please check the output above for errors.${NC}"
    exit 1
fi

exit 0 