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
if [ -z "$OPERATOR_ADDR" ]; then
    echo -e "${RED}Error: Operator contract address not found in .contracts file${NC}"
    exit 1
fi

# Construct LINK token address variable name based on selected network
LINK_TOKEN_VAR="LINK_TOKEN_ADDRESS_${DEPLOYMENT_NETWORK^^}"
LINK_TOKEN_ADDRESS=$(eval echo \$$LINK_TOKEN_VAR)

if [ -z "$LINK_TOKEN_ADDRESS" ]; then
    echo -e "${RED}Error: LINK token address for $NETWORK_NAME not found in .contracts file (looking for $LINK_TOKEN_VAR)${NC}"
    exit 1
fi

if [ -z "$NODE_ADDRESS" ]; then
    echo -e "${RED}Error: Node address not found in .contracts file${NC}"
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
    echo -e "${RED}Error: No valid job IDs found in .contracts file${NC}"
    echo -e "${RED}Please ensure jobs have been created successfully${NC}"
    exit 1
fi

# Use ALL job IDs for registration (space-separated)
REGISTRATION_JOB_IDS=$(printf '"%s" ' "${JOB_IDS_AVAILABLE[@]}")
REGISTRATION_JOB_IDS=${REGISTRATION_JOB_IDS% }  # Remove trailing space
echo -e "${BLUE}Using ALL job IDs for registration:${NC}"
for i in "${!JOB_IDS_AVAILABLE[@]}"; do
    echo -e "${GREEN}  Job $((i+1)): ${JOB_IDS_AVAILABLE[i]}${NC}"
done
echo -e "${BLUE}Registration job IDs (space-separated): $REGISTRATION_JOB_IDS${NC}"
echo -e "${BLUE}Total jobs to register: ${#JOB_IDS_AVAILABLE[@]}${NC}"

# Create .env file in arbiter-operator directory
echo -e "${BLUE}Creating .env file in arbiter-operator directory...${NC}"
cat > "$ARBITER_OPERATOR_DIR/.env" << EOL
PRIVATE_KEY=$PRIVATE_KEY
INFURA_API_KEY=$INFURA_API_KEY
EOL
chmod 600 "$ARBITER_OPERATOR_DIR/.env"
echo -e "${GREEN}.env file created in arbiter-operator directory${NC}"

# Ensure dependencies are installed in arbiter-operator
echo -e "${BLUE}Checking dependencies for arbiter-operator...${NC}"
if [ ! -d "$ARBITER_OPERATOR_DIR/node_modules" ]; then
    echo -e "${YELLOW}node_modules not found in $ARBITER_OPERATOR_DIR. Running npm install...${NC}"
    cd "$ARBITER_OPERATOR_DIR"
    
    # Load nvm if it exists, and set Node version
    if [ -d "$HOME/.nvm" ]; then
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
        [ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"
        
        echo -e "${BLUE}Using Node.js v20.18.1 for arbiter-operator dependency installation...${NC}"
        nvm_output=$(nvm use 20.18.1 2>&1)
        if [[ $nvm_output == *"N/A"* ]]; then
            echo -e "${YELLOW}Node.js v20.18.1 not installed via NVM. Installing...${NC}"
            nvm install 20.18.1
            nvm use 20.18.1
        fi
        echo -e "${GREEN}Node.js version set: $(node --version)${NC}"
    else
        echo -e "${YELLOW}NVM not found. Assuming Node.js v20.18.1 is available in PATH.${NC}"
    fi

    npm install
    if [ $? -ne 0 ]; then
        echo -e "${RED}Failed to install dependencies in $ARBITER_OPERATOR_DIR${NC}"
        exit 1
    fi
    echo -e "${GREEN}Dependencies installed for arbiter-operator.${NC}"
else
    echo -e "${GREEN}node_modules found in $ARBITER_OPERATOR_DIR.${NC}"
fi
# Return to the original SCRIPT_DIR or ensure subsequent cd is explicit
cd "$SCRIPT_DIR" 

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

# Construct the registration command with ALL job IDs
REGISTER_CMD="HARDHAT_NETWORK=$DEPLOYMENT_NETWORK node scripts/register-oracle-cl.js \
  --aggregator $AGGREGATOR_ADDRESS \
  --link $LINK_TOKEN_ADDRESS \
  --oracle $OPERATOR_ADDR \
  --wrappedverdikta $WRAPPED_VERDIKTA_ADDRESS \
  --jobids $REGISTRATION_JOB_IDS \
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
    
    # Save the classes ID to .contracts file
    if grep -q "CLASSES_ID=" "$INSTALLER_DIR/.contracts" 2>/dev/null; then
        # Update existing classes ID entry
        sed -i "s/CLASSES_ID=.*/CLASSES_ID=\"$CLASSES_ID\"/" "$INSTALLER_DIR/.contracts"
    else
        # Append new classes ID entry
        echo "CLASSES_ID=\"$CLASSES_ID\"" >> "$INSTALLER_DIR/.contracts"
    fi
    echo -e "${GREEN}Classes ID saved to .contracts file: $CLASSES_ID${NC}"
else
    echo -e "${RED}Oracle registration script failed. Please check the output above for errors.${NC}"
    exit 1
fi

exit 0 