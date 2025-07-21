#!/bin/bash

# Verdikta Arbiter Node - Standalone Oracle Registration Script
# Registers the oracle with dispatcher (aggregator) contracts
# This script can be run multiple times to register with different dispatchers

set -e  # Exit on any error

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Base directory (where this script runs from - should be $INSTALL_DIR)
INSTALL_DIR="$(dirname "$(readlink -f "$0")")"
ARBITER_OPERATOR_DIR="$INSTALL_DIR/arbiter-operator"
CONTRACTS_FILE="$INSTALL_DIR/installer/.contracts"

echo -e "${BLUE}Verdikta Arbiter - Oracle Registration with Dispatcher${NC}"
echo -e "${BLUE}Installation Directory: $INSTALL_DIR${NC}"
echo ""

# Verify installation structure
if [ ! -d "$ARBITER_OPERATOR_DIR" ]; then
    echo -e "${RED}Error: arbiter-operator directory not found at $ARBITER_OPERATOR_DIR${NC}"
    echo -e "${YELLOW}This script must be run from a properly installed Verdikta arbiter directory.${NC}"
    exit 1
fi

if [ ! -f "$CONTRACTS_FILE" ]; then
    echo -e "${RED}Error: Contract information file not found at $CONTRACTS_FILE${NC}"
    echo -e "${YELLOW}Please ensure your arbiter installation is complete.${NC}"
    exit 1
fi

# Load contract information
source "$CONTRACTS_FILE"

# Verify required contract variables
if [ -z "$OPERATOR_ADDRESS" ]; then
    echo -e "${RED}Error: Operator contract address not found in contracts file${NC}"
    exit 1
fi

# Construct LINK token address variable name based on selected network
LINK_TOKEN_VAR="LINK_TOKEN_ADDRESS_${DEPLOYMENT_NETWORK^^}"
LINK_TOKEN_ADDRESS=$(eval echo \$$LINK_TOKEN_VAR)

if [ -z "$LINK_TOKEN_ADDRESS" ]; then
    echo -e "${RED}Error: LINK token address for $NETWORK_NAME not found in contracts file (looking for $LINK_TOKEN_VAR)${NC}"
    exit 1
fi

if [ -z "$NODE_ADDRESS" ]; then
    echo -e "${RED}Error: Node address not found in contracts file${NC}"
    exit 1
fi

if [ -z "$JOB_ID_NO_HYPHENS" ]; then
    echo -e "${RED}Error: Job ID (no hyphens) not found in contracts file${NC}"
    exit 1
fi

# Load environment variables (private key and Infura API key)
ENV_FILE="$INSTALL_DIR/installer/.env"
if [ -f "$ENV_FILE" ]; then
    source "$ENV_FILE"
else
    echo -e "${RED}Error: Environment file not found at $ENV_FILE${NC}"
    echo -e "${YELLOW}Please ensure your arbiter installation is complete.${NC}"
    exit 1
fi

if [ -z "$PRIVATE_KEY" ]; then
    echo -e "${RED}Error: Private key not found in environment configuration${NC}"
    exit 1
fi

if [ -z "$INFURA_API_KEY" ]; then
    echo -e "${RED}Error: Infura API key not found in environment configuration${NC}"
    exit 1
fi

# Display current registration information
echo -e "${BLUE}Current Oracle Information:${NC}"
echo -e "  Operator Address: $OPERATOR_ADDRESS"
echo -e "  Node Address:     $NODE_ADDRESS"
echo -e "  Job ID:           $JOB_ID_NO_HYPHENS"
echo -e "  LINK Token:       $LINK_TOKEN_ADDRESS"
echo ""

# List existing registrations if any
if [ -n "$AGGREGATOR_ADDRESS" ]; then
    echo -e "${BLUE}Previously Registered Dispatchers:${NC}"
    echo -e "  Aggregator: $AGGREGATOR_ADDRESS"
    if [ -n "$CLASSES_ID" ]; then
        echo -e "  Classes ID: $CLASSES_ID"
    fi
    echo ""
fi

# Create .env file in arbiter-operator directory
echo -e "${BLUE}Preparing arbiter-operator environment...${NC}"
cat > "$ARBITER_OPERATOR_DIR/.env" << EOL
PRIVATE_KEY=$PRIVATE_KEY
INFURA_API_KEY=$INFURA_API_KEY
EOL
chmod 600 "$ARBITER_OPERATOR_DIR/.env"
echo -e "${GREEN}Environment file created in arbiter-operator directory${NC}"

# Ensure dependencies are installed in arbiter-operator
echo -e "${BLUE}Checking dependencies for arbiter-operator...${NC}"
if [ ! -d "$ARBITER_OPERATOR_DIR/node_modules" ]; then
    echo -e "${YELLOW}node_modules not found. Installing dependencies...${NC}"
    cd "$ARBITER_OPERATOR_DIR"
    
    # Load nvm if it exists, and set Node version
    if [ -d "$HOME/.nvm" ]; then
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
        [ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"
        
        echo -e "${BLUE}Using Node.js v20.18.1 for arbiter-operator...${NC}"
        nvm_output=$(nvm use 20.18.1 2>&1)
        if [[ $nvm_output == *"N/A"* ]]; then
            echo -e "${YELLOW}Node.js v20.18.1 not installed via NVM. Installing...${NC}"
            nvm install 20.18.1
            nvm use 20.18.1
        fi
        echo -e "${GREEN}Node.js version set: $(node --version)${NC}"
    else
        echo -e "${YELLOW}NVM not found. Using system Node.js version.${NC}"
    fi

    npm install
    if [ $? -ne 0 ]; then
        echo -e "${RED}Failed to install dependencies in $ARBITER_OPERATOR_DIR${NC}"
        exit 1
    fi
    echo -e "${GREEN}Dependencies installed successfully.${NC}"
else
    echo -e "${GREEN}Dependencies already installed.${NC}"
fi

# Return to the original directory
cd "$INSTALL_DIR"

# Define the correct wrapped VDKA address
WRAPPED_VERDIKTA_ADDRESS="0x2F1d1aF9d5C25A48C29f56f57c7BAFFa7cc910a3"  # Correct wrapped VDKA address

# Ask if user wants to register with a new dispatcher
echo -e "${YELLOW}Would you like to register the oracle with a dispatcher (aggregator) contract?${NC}"
read -p "Register with dispatcher? (y/n): " register_response
if [[ ! "$register_response" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Oracle registration cancelled.${NC}"
    exit 0
fi

# Get the Aggregator address from the user
echo ""
echo -e "${YELLOW}Please enter the Aggregator contract address:${NC}"
read -p "Aggregator address (0x...): " NEW_AGGREGATOR_ADDRESS

# Validate Aggregator address format
if [[ ! "$NEW_AGGREGATOR_ADDRESS" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
    echo -e "${RED}Error: Invalid Aggregator address format. Must be a valid Ethereum address starting with 0x.${NC}"
    exit 1
fi

# Check if already registered with this aggregator
if [ "$NEW_AGGREGATOR_ADDRESS" = "$AGGREGATOR_ADDRESS" ]; then
    echo -e "${YELLOW}Warning: Oracle is already registered with this aggregator address.${NC}"
    read -p "Do you want to continue anyway? (y/n): " continue_response
    if [[ ! "$continue_response" =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}Registration cancelled.${NC}"
        exit 0
    fi
fi

# Ask for classes ID with default
echo ""
echo -e "${YELLOW}Please enter the classes ID (default: 128):${NC}"
read -p "Classes ID [128]: " NEW_CLASSES_ID
NEW_CLASSES_ID=${NEW_CLASSES_ID:-128}  # Use 128 as default if no input

# Validate classes ID is a number
if ! [[ "$NEW_CLASSES_ID" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}Error: Classes ID must be a number.${NC}"
    exit 1
fi

# Construct the registration command
REGISTER_CMD="HARDHAT_NETWORK=$DEPLOYMENT_NETWORK node scripts/register-oracle-cl.js \
  --aggregator $NEW_AGGREGATOR_ADDRESS \
  --link $LINK_TOKEN_ADDRESS \
  --oracle $OPERATOR_ADDRESS \
  --wrappedverdikta $WRAPPED_VERDIKTA_ADDRESS \
  --jobids \"$JOB_ID_NO_HYPHENS\" \
  --classes $NEW_CLASSES_ID"

# Display the command and ask for confirmation
echo ""
echo -e "${BLUE}Registration Summary:${NC}"
echo -e "  Aggregator Address: $NEW_AGGREGATOR_ADDRESS"
echo -e "  Classes ID:         $NEW_CLASSES_ID"
echo -e "  Oracle Address:     $OPERATOR_ADDRESS"
echo -e "  LINK Token:         $LINK_TOKEN_ADDRESS"
echo ""
echo -e "${BLUE}The following command will be executed:${NC}"
echo "$REGISTER_CMD"
echo ""
read -p "Proceed with registration? (y/n): " response
if [[ ! "$response" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Oracle registration cancelled.${NC}"
    exit 0
fi

# Execute the registration command
echo -e "${BLUE}Executing oracle registration...${NC}"
cd "$ARBITER_OPERATOR_DIR"
eval "$REGISTER_CMD"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}Oracle registration completed successfully!${NC}"
    
    # Update the contracts file with the new aggregator information
    # For multiple registrations, we'll store the most recent one
    if grep -q "AGGREGATOR_ADDRESS=" "$CONTRACTS_FILE" 2>/dev/null; then
        # Update existing aggregator address entry
        sed -i "s/AGGREGATOR_ADDRESS=.*/AGGREGATOR_ADDRESS=\"$NEW_AGGREGATOR_ADDRESS\"/" "$CONTRACTS_FILE"
    else
        # Append new aggregator address entry
        echo "AGGREGATOR_ADDRESS=\"$NEW_AGGREGATOR_ADDRESS\"" >> "$CONTRACTS_FILE"
    fi
    echo -e "${GREEN}Latest aggregator address saved: $NEW_AGGREGATOR_ADDRESS${NC}"
    
    # Update classes ID
    if grep -q "CLASSES_ID=" "$CONTRACTS_FILE" 2>/dev/null; then
        # Update existing classes ID entry
        sed -i "s/CLASSES_ID=.*/CLASSES_ID=\"$NEW_CLASSES_ID\"/" "$CONTRACTS_FILE"
    else
        # Append new classes ID entry
        echo "CLASSES_ID=\"$NEW_CLASSES_ID\"" >> "$CONTRACTS_FILE"
    fi
    echo -e "${GREEN}Latest classes ID saved: $NEW_CLASSES_ID${NC}"
    
    echo ""
    echo -e "${BLUE}Registration Complete!${NC}"
    echo -e "Your oracle is now registered with the dispatcher contract."
    echo -e "You can run this script again to register with additional dispatchers."
    
else
    echo -e "${RED}Oracle registration failed. Please check the output above for errors.${NC}"
    exit 1
fi

exit 0 