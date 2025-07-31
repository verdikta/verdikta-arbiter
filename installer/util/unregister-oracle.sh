#!/bin/bash

# Verdikta Arbiter Node - Standalone Oracle Unregistration Script
# Unregisters the oracle from dispatcher (aggregator) contracts
# This script can be run multiple times to unregister from different dispatchers

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

echo -e "${BLUE}Verdikta Arbiter - Oracle Unregistration from Dispatcher${NC}"
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

# Load environment variables first (contains DEPLOYMENT_NETWORK)
ENV_FILE="$INSTALL_DIR/installer/.env"
if [ -f "$ENV_FILE" ]; then
    source "$ENV_FILE"
else
    echo -e "${RED}Error: Environment file not found at $ENV_FILE${NC}"
    echo -e "${YELLOW}Please ensure your arbiter installation is complete.${NC}"
    exit 1
fi

# Load contract information
source "$CONTRACTS_FILE"

# Verify required variables
if [ -z "$OPERATOR_ADDR" ]; then
    echo -e "${RED}Error: Operator contract address not found in contracts file${NC}"
    exit 1
fi

if [ -z "$DEPLOYMENT_NETWORK" ]; then
    echo -e "${RED}Error: DEPLOYMENT_NETWORK not found in environment file${NC}"
    echo -e "${YELLOW}Expected DEPLOYMENT_NETWORK in .env file${NC}"
    exit 1
fi

if [ -z "$NODE_ADDRESS" ]; then
    echo -e "${RED}Error: Node address not found in contracts file${NC}"
    exit 1
fi

# Handle multi-arbiter job IDs
echo -e "${BLUE}Detecting job configuration...${NC}"

# Check if we have multiple arbiters
ARBITER_COUNT=${ARBITER_COUNT:-1}
JOB_IDS_AVAILABLE=()

# Collect all available job IDs
for ((i=1; i<=10; i++)); do
    eval job_var="JOB_ID_${i}_NO_HYPHENS"
    if [ -n "${!job_var}" ]; then
        # Clean the job ID to extract only the UUID part
        clean_job_id=$(echo "${!job_var}" | grep -oE '[a-f0-9]{32}' | head -1)
        if [ -n "$clean_job_id" ]; then
            JOB_IDS_AVAILABLE+=("$clean_job_id")
            echo -e "${GREEN}Found job $i: $clean_job_id${NC}"
        fi
    fi
done

# If no multi-arbiter job IDs found, try the legacy single job ID
if [ ${#JOB_IDS_AVAILABLE[@]} -eq 0 ] && [ -n "$JOB_ID_NO_HYPHENS" ]; then
    clean_job_id=$(echo "$JOB_ID_NO_HYPHENS" | grep -oE '[a-f0-9]{32}' | head -1)
    if [ -n "$clean_job_id" ]; then
        JOB_IDS_AVAILABLE+=("$clean_job_id")
        echo -e "${GREEN}Found legacy job: $clean_job_id${NC}"
    fi
fi

# Validate we have at least one job ID
if [ ${#JOB_IDS_AVAILABLE[@]} -eq 0 ]; then
    echo -e "${RED}Error: No valid job IDs found in contracts file${NC}"
    echo -e "${RED}Please ensure jobs have been created successfully${NC}"
    exit 1
fi

# Use ALL job IDs for unregistration (space-separated)
UNREGISTRATION_JOB_IDS=$(printf '"%s" ' "${JOB_IDS_AVAILABLE[@]}")
UNREGISTRATION_JOB_IDS=${UNREGISTRATION_JOB_IDS% }  # Remove trailing space

# Verify required environment variables
if [ -z "$PRIVATE_KEY" ]; then
    echo -e "${RED}Error: Private key not found in environment configuration${NC}"
    exit 1
fi

if [ -z "$INFURA_API_KEY" ]; then
    echo -e "${RED}Error: Infura API key not found in environment configuration${NC}"
    exit 1
fi

# Display current unregistration information
echo -e "${BLUE}Current Oracle Information:${NC}"
echo -e "  Operator Address: $OPERATOR_ADDR"
echo -e "  Node Address:     $NODE_ADDRESS"
echo ""
echo -e "${BLUE}Available Jobs for Unregistration:${NC}"
for i in "${!JOB_IDS_AVAILABLE[@]}"; do
    echo -e "${GREEN}  Job $((i+1)): ${JOB_IDS_AVAILABLE[i]}${NC}"
done
echo -e "${BLUE}Unregistration job IDs (space-separated): $UNREGISTRATION_JOB_IDS${NC}"
echo -e "${BLUE}Total jobs to unregister: ${#JOB_IDS_AVAILABLE[@]}${NC}"
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

# Define network-specific wrapped VDKA addresses
if [ "$DEPLOYMENT_NETWORK" = "base_mainnet" ]; then
    WRAPPED_VERDIKTA_ADDRESS="0x1EA68D018a11236E07D5647175DAA8ca1C3D0280"  # Base Mainnet wrapped VDKA address
else
    WRAPPED_VERDIKTA_ADDRESS="0x94e3c031fe9403c80E14DaFbCb73f191C683c2B1"  # Base Sepolia wrapped VDKA address
fi

echo -e "${GREEN}Using wrapped VDKA address for $NETWORK_NAME: $WRAPPED_VERDIKTA_ADDRESS${NC}"

# Ask if user wants to unregister from a dispatcher
echo -e "${YELLOW}Would you like to unregister the oracle from a dispatcher (aggregator) contract?${NC}"
read -p "Unregister from dispatcher? (y/n): " unregister_response
if [[ ! "$unregister_response" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Oracle unregistration cancelled.${NC}"
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

# Construct the unregistration command with ALL job IDs
UNREGISTER_CMD="HARDHAT_NETWORK=$DEPLOYMENT_NETWORK node scripts/unregister-oracle-cl.js \
  --aggregator $NEW_AGGREGATOR_ADDRESS \
  --oracle $OPERATOR_ADDR \
  --wrappedverdikta $WRAPPED_VERDIKTA_ADDRESS \
  --jobids $UNREGISTRATION_JOB_IDS"

# Display the command and ask for confirmation
echo ""
echo -e "${BLUE}Unregistration Summary:${NC}"
echo -e "  Aggregator Address: $NEW_AGGREGATOR_ADDRESS"
echo -e "  Oracle Address:     $OPERATOR_ADDR"
echo -e "  Total Jobs:         ${#JOB_IDS_AVAILABLE[@]}"
echo ""
echo -e "${BLUE}The following command will be executed:${NC}"
echo "$UNREGISTER_CMD"
echo ""
read -p "Proceed with unregistration? (y/n): " response
if [[ ! "$response" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Oracle unregistration cancelled.${NC}"
    exit 0
fi

# Execute the unregistration command
echo -e "${BLUE}Executing oracle unregistration...${NC}"
cd "$ARBITER_OPERATOR_DIR"
eval "$UNREGISTER_CMD"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}Oracle unregistration completed successfully!${NC}"
    echo ""
    echo -e "${BLUE}Unregistration Complete!${NC}"
    echo -e "Your oracle has been unregistered from the dispatcher contract."
    echo -e "You can run this script again to unregister from additional dispatchers."
    
else
    echo -e "${RED}Oracle unregistration failed. Please check the output above for errors.${NC}"
    exit 1
fi

exit 0