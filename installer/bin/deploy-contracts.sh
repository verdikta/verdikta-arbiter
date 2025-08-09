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

# Automatically get Chainlink node addresses using key management API
echo -e "${BLUE}Automatically retrieving Chainlink node addresses...${NC}"

# Get API credentials from Chainlink configuration
CHAINLINK_DIR="$HOME/.chainlink-${NETWORK_TYPE}"
if [ ! -f "$CHAINLINK_DIR/.api" ]; then
    echo -e "${RED}Error: Chainlink API credentials not found at $CHAINLINK_DIR/.api${NC}"
    echo -e "${RED}Please ensure the Chainlink node is properly configured.${NC}"
    exit 1
fi

# Read API credentials
API_EMAIL=$(head -n 1 "$CHAINLINK_DIR/.api")
API_PASSWORD=$(tail -n 1 "$CHAINLINK_DIR/.api")

if [ -z "$API_EMAIL" ] || [ -z "$API_PASSWORD" ]; then
    echo -e "${RED}Error: Could not read API credentials from $CHAINLINK_DIR/.api${NC}"
    exit 1
fi

echo -e "${BLUE}Found API credentials: $API_EMAIL${NC}"

# Wait for Chainlink node to be fully ready for CLI operations
echo -e "${BLUE}Waiting for Chainlink node to be fully ready for CLI operations...${NC}"
for i in {1..30}; do
    if curl -s http://localhost:6688/health > /dev/null; then
        echo -e "${BLUE}Attempt $i: HTTP endpoint ready, testing CLI access...${NC}"
        # Test if CLI is ready by attempting a simple operation
        if timeout 10 bash -c "docker exec chainlink chainlink admin login --file /chainlink/.api > /dev/null 2>&1"; then
            echo -e "${GREEN}Chainlink CLI is ready for operations${NC}"
            break
        else
            echo -e "${YELLOW}CLI not ready yet, waiting 3 more seconds...${NC}"
            sleep 3
        fi
    else
        echo -e "${YELLOW}HTTP endpoint not ready, waiting 2 seconds...${NC}"
        sleep 2
    fi
    
    if [ $i -eq 30 ]; then
        echo -e "${YELLOW}Warning: Chainlink CLI readiness check took longer than expected${NC}"
        echo -e "${YELLOW}Proceeding anyway, but key retrieval might fail${NC}"
    fi
done

# Use key management to get all existing keys
echo -e "${BLUE}Retrieving all Chainlink keys for authorization...${NC}"

# Check if key management script exists
KEY_MGMT_SCRIPT="$SCRIPT_DIR/key-management.sh"
if [ ! -f "$KEY_MGMT_SCRIPT" ]; then
    echo -e "${RED}Error: Key management script not found at $KEY_MGMT_SCRIPT${NC}"
    exit 1
fi

# Ensure expect is installed for key management
echo -e "${BLUE}Ensuring key management dependencies are installed...${NC}"
bash "$KEY_MGMT_SCRIPT" install_expect
if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Failed to install expect dependency${NC}"
    exit 1
fi

# Get all existing keys with retry logic
echo -e "${BLUE}Retrieving Chainlink keys (with retry logic)...${NC}"
KEYS_LIST=""
KEY_RETRIEVAL_SUCCESS=false

for retry in {1..5}; do
    echo -e "${BLUE}Key retrieval attempt $retry of 5...${NC}"
    KEYS_LIST=$(bash "$KEY_MGMT_SCRIPT" list_existing_keys "$API_EMAIL" "$API_PASSWORD" 2>&1)
    
    if [ $? -eq 0 ] && [ -n "$KEYS_LIST" ] && [[ "$KEYS_LIST" =~ ^[0-9]+: ]]; then
        echo -e "${GREEN}✓ Successfully retrieved keys on attempt $retry${NC}"
        KEY_RETRIEVAL_SUCCESS=true
        break
    else
        echo -e "${YELLOW}Attempt $retry failed. Keys response: ${KEYS_LIST:-'empty'}${NC}"
        if [ $retry -lt 5 ]; then
            echo -e "${BLUE}Waiting 5 seconds before retry...${NC}"
            sleep 5
        fi
    fi
done

if [ "$KEY_RETRIEVAL_SUCCESS" != "true" ]; then
    echo -e "${RED}Error: Failed to retrieve Chainlink keys after 5 attempts${NC}"
    echo -e "${RED}Last response: $KEYS_LIST${NC}"
    echo -e "${RED}Please ensure the Chainlink node is running and has keys configured${NC}"
    exit 1
fi

# Extract all key addresses from the keys list (format: "1:address1|2:address2|...")
NODE_ADDRESSES=""
KEY_COUNT=0

echo "$KEYS_LIST" | tr '|' '\n' | while IFS=':' read key_index key_address; do
    if [ -n "$key_address" ]; then
        if [ -z "$NODE_ADDRESSES" ]; then
            NODE_ADDRESSES="$key_address"
        else
            NODE_ADDRESSES="$NODE_ADDRESSES,$key_address"
        fi
        KEY_COUNT=$((KEY_COUNT + 1))
        echo -e "${GREEN}Found key $key_index: $key_address${NC}"
    fi
done

# Use a different approach to extract addresses since the while loop runs in a subshell
NODE_ADDRESSES=$(echo "$KEYS_LIST" | tr '|' '\n' | cut -d':' -f2 | tr '\n' ',' | sed 's/,$//')
KEY_COUNT=$(echo "$KEYS_LIST" | tr '|' '\n' | wc -l)

if [ -z "$NODE_ADDRESSES" ]; then
    echo -e "${RED}Error: No valid node addresses found${NC}"
    exit 1
fi

echo -e "${GREEN}Found $KEY_COUNT Chainlink keys to authorize:${NC}"
echo -e "${GREEN}Addresses: $NODE_ADDRESSES${NC}"

# Validate all addresses
OLD_IFS="$IFS"
IFS=','
for addr in $NODE_ADDRESSES; do
    if [[ ! "$addr" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
        echo -e "${RED}Error: Invalid Ethereum address format: $addr${NC}"
        exit 1
    fi
done
IFS="$OLD_IFS"

# For backward compatibility, also set NODE_ADDRESS to the first key
FIRST_NODE_ADDRESS=$(echo "$NODE_ADDRESSES" | cut -d',' -f1)
NODE_ADDRESS="$FIRST_NODE_ADDRESS"

echo -e "${GREEN}Using first key as primary node address: $NODE_ADDRESS${NC}"

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
# The operator now imports Chainlink contracts from the npm package.
# We no longer require or copy a local lib directory.
# Copy the Hardhat-deploy 'deploy' scripts folder if it exists (standard for hardhat-deploy)
if [ -d "$ARBITER_OPERATOR_SRC_DIR/deploy" ]; then
    cp -r "$ARBITER_OPERATOR_SRC_DIR/deploy" "$OPERATOR_BUILD_DIR/"
fi
# Copy our custom scripts folder (scripts/deploy.js, scripts/setAuthorizedSenders.js)
cp -r "$ARBITER_OPERATOR_SRC_DIR/scripts" "$OPERATOR_BUILD_DIR/"
# Copy deployment-addresses.json
if [ -f "$ARBITER_OPERATOR_SRC_DIR/deployment-addresses.json" ]; then
    cp "$ARBITER_OPERATOR_SRC_DIR/deployment-addresses.json" "$OPERATOR_BUILD_DIR/"
else
    echo -e "${RED}Error: deployment-addresses.json not found in $ARBITER_OPERATOR_SRC_DIR${NC}"
    exit 1
fi

# Extract LINK token address for the selected network from deployment-addresses.json
LINK_TOKEN_ADDRESS=""
if command -v jq >/dev/null 2>&1; then
    LINK_TOKEN_ADDRESS=$(jq -r ".$DEPLOYMENT_NETWORK.linkTokenAddress" "$OPERATOR_BUILD_DIR/deployment-addresses.json")
    if [ -z "$LINK_TOKEN_ADDRESS" ] || [ "$LINK_TOKEN_ADDRESS" == "null" ]; then
        echo -e "${RED}Error: Could not extract LINK token address for $DEPLOYMENT_NETWORK from deployment-addresses.json using jq.${NC}"
        echo -e "${YELLOW}Please ensure deployment-addresses.json is correctly formatted and contains the required key.${NC}"
        exit 1 # Exit if critical info is missing
    else
        echo -e "${GREEN}Extracted LINK token address for $NETWORK_NAME: $LINK_TOKEN_ADDRESS${NC}"
    fi
else
    echo -e "${RED}Error: jq is not installed. This is required to parse deployment-addresses.json.${NC}"
    echo -e "${YELLOW}Please install jq (e.g., sudo apt-get install jq) and try again.${NC}"
    exit 1 # Exit if jq is missing
fi

cd "$OPERATOR_BUILD_DIR"

# Ensure Node.js and npm are available (load nvm if installed)
NODE_VERSION="20.18.1"
if ! command_exists npm; then
    if [ -d "$HOME/.nvm" ]; then
        echo -e "${BLUE}Loading nvm and selecting Node.js v$NODE_VERSION...${NC}"
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
        # Try to use the desired version; if not installed, install it
        nvm use "$NODE_VERSION" >/dev/null 2>&1 || {
            echo -e "${BLUE}Installing Node.js v$NODE_VERSION via nvm...${NC}"
            nvm install "$NODE_VERSION"
            nvm use "$NODE_VERSION"
        }
    fi
fi

if ! command_exists npm; then
    echo -e "${RED}Error: npm not found. Please ensure Node.js/npm are installed (nvm recommended) and re-run this step.${NC}"
    echo -e "${YELLOW}Tip: Install nvm and run: nvm install $NODE_VERSION && nvm use $NODE_VERSION${NC}"
    exit 1
fi

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

echo -e "${BLUE}Deploying ArbiterOperator contract via Hardhat to $NETWORK_NAME...${NC}"
# Run the custom deploy script and capture its output
DEPLOY_OUTPUT_FILE="deploy_output.log"
if npx hardhat run scripts/deploy.js --network $DEPLOYMENT_NETWORK > "$DEPLOY_OUTPUT_FILE" 2>&1; then
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
# Use OPERATOR_ADDR for consistency with the External Adapter code
echo "OPERATOR_ADDR=\"$CONTRACT_ADDRESS\"" > "$INSTALLER_DIR/.contracts"
echo "NODE_ADDRESS=\"$NODE_ADDRESS\"" >> "$INSTALLER_DIR/.contracts"
if [ -n "$LINK_TOKEN_ADDRESS" ]; then
    echo "LINK_TOKEN_ADDRESS_${DEPLOYMENT_NETWORK^^}=\"$LINK_TOKEN_ADDRESS\"" >> "$INSTALLER_DIR/.contracts"
fi
echo -e "${GREEN}Operator contract address saved to $INSTALLER_DIR/.contracts: $CONTRACT_ADDRESS${NC}"
echo -e "${GREEN}Node address saved to $INSTALLER_DIR/.contracts: $NODE_ADDRESS${NC}"
if [ -n "$LINK_TOKEN_ADDRESS" ]; then
    echo -e "${GREEN}$NETWORK_NAME LINK token address saved to $INSTALLER_DIR/.contracts: $LINK_TOKEN_ADDRESS${NC}"
fi

# Update External Adapter .env file with the real operator address
echo -e "${BLUE}Updating External Adapter with deployed operator address...${NC}"

# Update function to handle updating .env files
update_external_adapter_env() {
    local adapter_dir="$1"
    local label="$2"
    
    if [ -f "$adapter_dir/.env" ]; then
        # Update the OPERATOR_ADDR in the External Adapter's .env file
        if grep -q "^OPERATOR_ADDR=" "$adapter_dir/.env"; then
            sed -i.bak "s|^OPERATOR_ADDR=.*|OPERATOR_ADDR=$CONTRACT_ADDRESS|" "$adapter_dir/.env"
        else
            echo "OPERATOR_ADDR=$CONTRACT_ADDRESS" >> "$adapter_dir/.env"
        fi
        echo -e "${GREEN}$label updated with operator address: $CONTRACT_ADDRESS${NC}"
        return 0
    else
        echo -e "${YELLOW}Warning: $label .env file not found at $adapter_dir/.env${NC}"
        return 1
    fi
}

# Update source External Adapter (for new installations)
EXTERNAL_ADAPTER_DIR="$(dirname "$INSTALLER_DIR")/external-adapter"
update_external_adapter_env "$EXTERNAL_ADAPTER_DIR" "Source External Adapter"

# Update installed External Adapter (only if it already exists - for upgrades)
if [ -n "$INSTALL_DIR" ]; then
    INSTALLED_ADAPTER_DIR="$INSTALL_DIR/external-adapter"
    if [ -f "$INSTALLED_ADAPTER_DIR/.env" ]; then
        update_external_adapter_env "$INSTALLED_ADAPTER_DIR" "Installed External Adapter"
    else
        echo -e "${BLUE}Installed External Adapter not found yet at $INSTALLED_ADAPTER_DIR${NC}"
        echo -e "${BLUE}The real OPERATOR_ADDR will be copied when installation completes.${NC}"
    fi
fi

# --- NODE AUTHORIZATION LOGIC USING HARDHAT ---

echo -e "${BLUE}🔐 Authorizing Chainlink node with ArbiterOperator contract...${NC}"
echo -e "${BLUE}   Expected time: 1-3 minutes (depending on network conditions)${NC}"
echo -e "${BLUE}⏳ Running Hardhat script to authorize node on $NETWORK_NAME (timeout: 10 minutes)...${NC}"
if timeout 600 env OPERATOR="$CONTRACT_ADDRESS" NODES="$NODE_ADDRESSES" npx hardhat run scripts/setAuthorizedSenders.js --network $DEPLOYMENT_NETWORK; then
    echo -e "${GREEN}Chainlink node authorization script executed successfully.${NC}"
else
    local exit_code=$?
    if [ $exit_code -eq 124 ]; then
        echo -e "${YELLOW}⚠ Authorization timed out after 10 minutes${NC}"
        echo -e "${YELLOW}  The transaction may still be processing. Check BaseScan for transaction status.${NC}"
    else
        echo -e "${RED}Chainlink node authorization script failed (exit code: $exit_code).${NC}"
    fi
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