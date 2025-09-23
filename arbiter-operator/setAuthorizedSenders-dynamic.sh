#!/bin/bash

# Dynamic setAuthorizedSenders script that reads from current deployment
# This script automatically uses the correct operator and node addresses from the latest deployment
# Use this script when you want automatic address detection after a clean install

set -e  # Exit on any error

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Dynamic setAuthorizedSenders Script${NC}"
echo -e "${BLUE}This script automatically detects current deployment addresses${NC}"
echo ""

# Find the installer directory (look for .contracts file)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALLER_DIR=""

# Check if we're running from the installed location
if [ -f "$SCRIPT_DIR/../installer/.contracts" ]; then
    INSTALLER_DIR="$SCRIPT_DIR/../installer"
    echo -e "${GREEN}✓ Found contracts from installed location: $INSTALLER_DIR/.contracts${NC}"
elif [ -f "$(dirname "$SCRIPT_DIR")/installer/.contracts" ]; then
    INSTALLER_DIR="$(dirname "$SCRIPT_DIR")/installer"
    echo -e "${GREEN}✓ Found contracts from repository location: $INSTALLER_DIR/.contracts${NC}"
else
    echo -e "${RED}Error: Cannot find .contracts file${NC}"
    echo -e "${RED}Please ensure this script is run from a properly installed arbiter directory${NC}"
    echo -e "${YELLOW}Expected locations:${NC}"
    echo -e "${YELLOW}  - $SCRIPT_DIR/../installer/.contracts${NC}"
    echo -e "${YELLOW}  - $(dirname "$SCRIPT_DIR")/installer/.contracts${NC}"
    echo -e "${YELLOW}Or provide OPERATOR and NODES environment variables manually:${NC}"
    echo -e "${YELLOW}  OPERATOR=0x... NODES=0x...,0x... $0${NC}"
    exit 1
fi

# Load contract information
if [ -f "$INSTALLER_DIR/.contracts" ]; then
    source "$INSTALLER_DIR/.contracts"
    echo -e "${GREEN}✓ Loaded contract information${NC}"
else
    echo -e "${RED}Error: .contracts file not found at $INSTALLER_DIR/.contracts${NC}"
    exit 1
fi

# Load environment information for network
if [ -f "$INSTALLER_DIR/.env" ]; then
    source "$INSTALLER_DIR/.env"
    echo -e "${GREEN}✓ Loaded environment configuration${NC}"
else
    echo -e "${RED}Error: .env file not found at $INSTALLER_DIR/.env${NC}"
    exit 1
fi

# Validate required variables
if [ -z "$OPERATOR_ADDR" ]; then
    echo -e "${RED}Error: OPERATOR_ADDR not found in .contracts file${NC}"
    echo -e "${YELLOW}Expected format: OPERATOR_ADDR=\"0x...\"${NC}"
    exit 1
fi

if [ -z "$DEPLOYMENT_NETWORK" ]; then
    echo -e "${RED}Error: DEPLOYMENT_NETWORK not found in .env file${NC}"
    echo -e "${YELLOW}Expected format: DEPLOYMENT_NETWORK=\"base_sepolia\"${NC}"
    exit 1
fi

# Build comma-separated list of all node addresses
NODE_LIST=""
if [ -n "$KEY_COUNT" ] && [ "$KEY_COUNT" -gt 0 ]; then
    # Multi-key setup - use all keys
    echo -e "${BLUE}Detected multi-key setup with $KEY_COUNT keys${NC}"
    for i in $(seq 1 $KEY_COUNT); do
        KEY_VAR="KEY_${i}_ADDRESS"
        KEY_ADDR="${!KEY_VAR}"
        if [ -n "$KEY_ADDR" ]; then
            if [ -z "$NODE_LIST" ]; then
                NODE_LIST="$KEY_ADDR"
            else
                NODE_LIST="$NODE_LIST,$KEY_ADDR"
            fi
            echo -e "${GREEN}  ✓ Key $i: $KEY_ADDR${NC}"
        fi
    done
elif [ -n "$NODE_ADDRESS" ]; then
    # Single key setup - use NODE_ADDRESS
    echo -e "${BLUE}Detected single-key setup${NC}"
    NODE_LIST="$NODE_ADDRESS"
    echo -e "${GREEN}  ✓ Node: $NODE_ADDRESS${NC}"
else
    echo -e "${RED}Error: No node addresses found in .contracts file${NC}"
    echo -e "${YELLOW}Expected either KEY_*_ADDRESS entries or NODE_ADDRESS${NC}"
    exit 1
fi

if [ -z "$NODE_LIST" ]; then
    echo -e "${RED}Error: Could not build node address list${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}Authorization Configuration:${NC}"
echo -e "${CYAN}  Network:  $DEPLOYMENT_NETWORK${NC}"
echo -e "${CYAN}  Operator: $OPERATOR_ADDR${NC}"
echo -e "${CYAN}  Nodes:    $NODE_LIST${NC}"
echo ""

# Confirm before proceeding
read -p "Proceed with authorization? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Authorization cancelled${NC}"
    exit 0
fi

# Run the authorization
echo -e "${BLUE}Running setAuthorizedSenders with detected addresses...${NC}"
env OPERATOR="$OPERATOR_ADDR" NODES="$NODE_LIST" npx hardhat run scripts/setAuthorizedSenders.js --network $DEPLOYMENT_NETWORK
