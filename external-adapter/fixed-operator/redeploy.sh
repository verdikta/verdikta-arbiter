#!/bin/bash

# Script for redeploying the fixed Operator contract and client contract
# This script is intended for testing the fixed implementation of fulfillOracleRequest3

set -e  # Exit on any error

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
INSTALLER_DIR="$ROOT_DIR/installer"

echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}  Redeploying Fixed Operator Contract for Verdikta ${NC}"
echo -e "${BLUE}==================================================${NC}"

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

echo -e "${YELLOW}This script will redeploy the Operator contract with the FIXED implementation${NC}"
echo -e "${YELLOW}of fulfillOracleRequest3 that properly includes the requestId in callbacks.${NC}"
echo -e "${YELLOW}Then it will update your .contracts file and help redeploy the client contract.${NC}"
echo -e "${YELLOW}This is intended for testing on testnets only.${NC}"
echo

if ! ask_yes_no "Do you want to proceed with redeployment?"; then
    echo -e "${RED}Redeployment cancelled.${NC}"
    exit 1
fi

# Step 1: Redeploy the Operator contract using the fixed script
echo -e "${BLUE}Step 1: Redeploying fixed Operator contract...${NC}"

echo -e "${BLUE}Running the updated deployment script...${NC}"
bash "$INSTALLER_DIR/bin/deploy-contracts-automated.sh"

if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Failed to deploy the Operator contract.${NC}"
    exit 1
fi

# Step 2: Read the newly deployed contract address
echo -e "${BLUE}Step 2: Reading the new contract address...${NC}"
if [ -f "$INSTALLER_DIR/.contracts" ]; then
    source "$INSTALLER_DIR/.contracts"
    if [ -z "$OPERATOR_ADDRESS" ]; then
        echo -e "${RED}Error: Operator address not found in .contracts file.${NC}"
        exit 1
    else
        echo -e "${GREEN}New Operator contract deployed at: $OPERATOR_ADDRESS${NC}"
    fi
else
    echo -e "${RED}Error: .contracts file not found.${NC}"
    exit 1
fi

# Step 3: Ask if user wants to redeploy the client contract
echo -e "${BLUE}Step 3: Client contract redeployment...${NC}"
echo -e "${YELLOW}The client contract needs to be redeployed to use the new Operator address.${NC}"

if ask_yes_no "Do you want to redeploy the client contract now?"; then
    echo -e "${BLUE}Running client contract setup script...${NC}"
    bash "$INSTALLER_DIR/bin/setup-client-contract.sh"
    
    if [ $? -ne 0 ]; then
        echo -e "${RED}Error: Failed to set up the client contract.${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}Client contract redeployment skipped.${NC}"
    echo -e "${YELLOW}Remember to redeploy the client contract manually later.${NC}"
fi

echo -e "${GREEN}==================================================${NC}"
echo -e "${GREEN}  Redeployment process completed!                 ${NC}"
echo -e "${GREEN}==================================================${NC}"
echo
echo -e "New Operator contract: ${GREEN}$OPERATOR_ADDRESS${NC}"
echo -e "Node address: ${GREEN}$NODE_ADDRESS${NC}"
echo -e "Job ID: ${GREEN}$JOB_ID${NC}"

if [ -n "$CLIENT_ADDRESS" ]; then
    echo -e "Client contract: ${GREEN}$CLIENT_ADDRESS${NC}"
fi

echo
echo -e "${BLUE}To test your client contract, make sure it has LINK tokens${NC}"
echo -e "${BLUE}and try making a request through your frontend application.${NC}" 