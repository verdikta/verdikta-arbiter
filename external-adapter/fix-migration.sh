#!/bin/bash

# Fix JobID encoding in migration file and redeploy client contract
# This script updates the client contract migration file with the correct
# JobID encoding method and redeploys the contract

set -e  # Exit on any error

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

CLIENT_DIR="/root/verdikta-validator/client-contract"
INSTALLER_DIR="/root/verdikta-external-adapter/installer"
MIGRATION_FILE="$CLIENT_DIR/migrations/2_deploy_contract.js"

echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}  Fixing JobID Encoding in Client Contract         ${NC}"
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

# Check if the client directory exists
if [ ! -d "$CLIENT_DIR" ]; then
    echo -e "${RED}Error: Client contract directory not found at $CLIENT_DIR${NC}"
    exit 1
fi

# Backup the original migration file
echo -e "${BLUE}Creating backup of original migration file...${NC}"
BACKUP_FILE="$MIGRATION_FILE.bak.$(date +%Y%m%d%H%M%S)"
cp "$MIGRATION_FILE" "$BACKUP_FILE"
echo -e "${GREEN}Backup created: $BACKUP_FILE${NC}"

# Get the job ID from .contracts file
echo -e "${BLUE}Reading JobID from .contracts file...${NC}"
if [ -f "$INSTALLER_DIR/.contracts" ]; then
    source "$INSTALLER_DIR/.contracts"
    if [ -n "$JOB_ID_NO_HYPHENS" ]; then
        echo -e "${GREEN}Found JobID: $JOB_ID_NO_HYPHENS${NC}"
    else
        echo -e "${RED}Error: JobID_NO_HYPHENS not found in .contracts file${NC}"
        exit 1
    fi
else
    echo -e "${RED}Error: .contracts file not found${NC}"
    exit 1
fi

# Update the migration file with the correct encoding method
echo -e "${BLUE}Updating migration file with corrected JobID encoding...${NC}"
cat > "$MIGRATION_FILE" << EOL
const AIChainlinkRequest = artifacts.require("AIChainlinkRequest");

module.exports = function (deployer) {
    const oracleAddress = "$OPERATOR_ADDRESS"; // Oracle address
    
    // FIXED: Use the direct no-hyphens version with proper encoding
    const jobId = web3.utils.toHex("$JOB_ID_NO_HYPHENS");
    
    const fee = web3.utils.toWei("0.05", "ether"); // Example fee in LINK tokens
    const linkTokenAddress = "0xE4aB69C077896252FAFBD49EFD26B5D171A32410"; // Sepolia Base LINK token address

    deployer.deploy(AIChainlinkRequest, oracleAddress, jobId, fee, linkTokenAddress);
};
EOL

echo -e "${GREEN}Migration file updated with correct encoding${NC}"

# Ask to redeploy the client contract
if ask_yes_no "Do you want to redeploy the client contract now?"; then
    echo -e "${BLUE}Redeploying client contract...${NC}"
    cd "$CLIENT_DIR"
    
    # Check if we need to install dependencies
    if [ ! -d "$CLIENT_DIR/node_modules" ]; then
        echo -e "${BLUE}Installing dependencies...${NC}"
        npm install --legacy-peer-deps
    fi
    
    # Deploy the contract
    echo -e "${BLUE}Running deployment...${NC}"
    npx truffle migrate --network baseSepolia --reset
    
    # Check if deployment was successful
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Client contract redeployed successfully!${NC}"
        
        # Extract contract address
        NEW_CLIENT_ADDRESS=$(grep -r "\"address\":" "$CLIENT_DIR/build/contracts" | grep -i "AIChainlinkRequest" | head -1 | sed -E 's/.*"address": "([^"]+)".*/\1/')
        
        if [ -n "$NEW_CLIENT_ADDRESS" ]; then
            echo -e "${GREEN}New client contract deployed at: $NEW_CLIENT_ADDRESS${NC}"
            
            # Update the .contracts file with the new address
            sed -i "s/CLIENT_ADDRESS=\"[^\"]*\"/CLIENT_ADDRESS=\"$NEW_CLIENT_ADDRESS\"/" "$INSTALLER_DIR/.contracts"
            echo -e "${GREEN}Updated .contracts file with new client address${NC}"
            
            echo -e "${YELLOW}Important: Don't forget to fund the new client contract with LINK tokens${NC}"
            echo -e "${YELLOW}You can send LINK to: $NEW_CLIENT_ADDRESS${NC}"
        else
            echo -e "${YELLOW}Unable to extract new client contract address${NC}"
            echo -e "${YELLOW}Please check the deployment logs and update the .contracts file manually${NC}"
        fi
    else
        echo -e "${RED}Client contract deployment failed${NC}"
        echo -e "${YELLOW}Please check the error messages above${NC}"
    fi
else
    echo -e "${YELLOW}Client contract redeployment skipped${NC}"
    echo -e "${YELLOW}You can redeploy manually by running:${NC}"
    echo -e "${YELLOW}  cd $CLIENT_DIR && npx truffle migrate --network baseSepolia --reset${NC}"
fi

echo -e "${BLUE}==================================================${NC}"
echo -e "${GREEN}  JobID encoding fix complete!                    ${NC}"
echo -e "${BLUE}==================================================${NC}"
echo
echo -e "${YELLOW}Next steps:${NC}"
echo -e "1. Fund the client contract with LINK tokens"
echo -e "2. Test the integration by making a request"
echo
echo -e "${YELLOW}To test the integration, you can:${NC}"
echo -e "- Use a frontend application that calls requestAIEvaluation()"
echo -e "- Or create a simple test script to call the function directly"
echo
echo -e "${YELLOW}If you need to revert to the original migration file:${NC}"
echo -e "cp $BACKUP_FILE $MIGRATION_FILE" 