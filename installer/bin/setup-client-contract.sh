#!/bin/bash

# Verdikta Validator Node - Client Contract Setup Script
# Sets up and deploys the client contract for the Verdikta Validator

set -e  # Exit on any error

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALLER_DIR="$(dirname "$SCRIPT_DIR")" # Define INSTALLER_DIR early
CONFIG_DIR="$INSTALLER_DIR/config" # Define CONFIG_DIR early
DEMO_CLIENT_SRC_DIR="$(dirname "$INSTALLER_DIR")/demo-client" # Define DEMO_CLIENT_SRC_DIR early

# Load INSTALL_DIR from the main .env file
if [ -f "$INSTALLER_DIR/.env" ]; then source "$INSTALLER_DIR/.env"; else echo "${RED}Error: Main .env missing${NC}"; exit 1; fi
if [ -z "$INSTALL_DIR" ]; then echo "${RED}Error: INSTALL_DIR not set in .env${NC}"; exit 1; fi
TEMP_CLIENT_BUILD_DIR="$INSTALL_DIR/temp_client_build" # Temporary build/deployment directory within INSTALL_DIR

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Setting up Client Contract for Verdikta Validator Node...${NC}"

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

# Load contract information
if [ -f "$INSTALLER_DIR/.contracts" ]; then
    source "$INSTALLER_DIR/.contracts"
else
    echo -e "${RED}Error: Contract information file not found. Please run deploy-contracts.sh first.${NC}"
    exit 1
fi

# Check prerequisites
echo -e "${BLUE}Checking prerequisites...${NC}"

# Check if Node.js is installed
if ! command_exists node; then
    echo -e "${RED}Error: Node.js is not installed.${NC}"
    echo -e "${YELLOW}Please install Node.js first:${NC}"
    echo -e "${YELLOW}  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash${NC}"
    echo -e "${YELLOW}  source ~/.bashrc${NC}"
    echo -e "${YELLOW}  nvm install 18.17${NC}"
    exit 1
fi

# Check if npm is installed
if ! command_exists npm; then
    echo -e "${RED}Error: npm is not installed.${NC}"
    echo -e "${YELLOW}Please install npm first.${NC}"
    exit 1
fi

# Check if git is installed
if ! command_exists git; then
    echo -e "${RED}Error: git is not installed.${NC}"
    echo -e "${YELLOW}Please install git first.${NC}"
    exit 1
fi

# Check if operator contract is deployed
if [ -z "$OPERATOR_ADDRESS" ]; then
    echo -e "${RED}Error: Operator contract address not found.${NC}"
    echo -e "${YELLOW}Please run deploy-contracts.sh first.${NC}"
    exit 1
fi

# Check if job ID is available
if [ -z "$JOB_ID" ] || [ -z "$JOB_ID_NO_HYPHENS" ]; then
    # Check if we have a job placeholder file instead
    if [ -f "$INSTALLER_DIR/.job_placeholder" ]; then
        echo -e "${YELLOW}Warning: Only a temporary job ID placeholder was found.${NC}"
        echo -e "${YELLOW}You need to create an actual job in the Chainlink node and get the real job ID.${NC}"
        echo -e "${YELLOW}Please run configure-node.sh first to create the job and get the actual job ID.${NC}"
        exit 1
    else
        echo -e "${RED}Error: Job ID not found.${NC}"
        echo -e "${YELLOW}Please run configure-node.sh first to create a job and get a job ID.${NC}"
        exit 1
    fi
fi

# Warn if using placeholder job ID
if [ -f "$INSTALLER_DIR/.job_placeholder" ]; then
    echo -e "${RED}Warning: You are using a placeholder job ID, not a real one from Chainlink!${NC}"
    echo -e "${YELLOW}This will likely cause your client contract to fail when making requests.${NC}"
    echo -e "${YELLOW}Please run configure-node.sh first to create a real job and get the actual job ID.${NC}"
    
    if ! ask_yes_no "Continue anyway with the placeholder job ID?"; then
        echo -e "${YELLOW}Exiting. Please run configure-node.sh first.${NC}"
        exit 1
    fi
    
    echo -e "${YELLOW}Continuing with placeholder job ID as requested. This is not recommended.${NC}"
fi

# Check if the source demo-client directory exists
if [ ! -d "$DEMO_CLIENT_SRC_DIR" ]; then
    echo -e "${RED}Error: Source demo-client directory not found at $DEMO_CLIENT_SRC_DIR${NC}"
    exit 1
fi
if [ ! -d "$DEMO_CLIENT_SRC_DIR/contracts" ] || [ ! -d "$DEMO_CLIENT_SRC_DIR/migrations" ]; then
    echo -e "${RED}Error: Source demo-client directory $DEMO_CLIENT_SRC_DIR is missing 'contracts' or 'migrations' subdirectories.${NC}"
    exit 1
fi

# Create temporary build directory
echo -e "${BLUE}Creating temporary directory for client contract build: $TEMP_CLIENT_BUILD_DIR${NC}"
rm -rf "$TEMP_CLIENT_BUILD_DIR" # Clean up previous build if exists
mkdir -p "$TEMP_CLIENT_BUILD_DIR"

# Copy necessary files from demo-client source to temporary directory
echo -e "${BLUE}Copying necessary files from $DEMO_CLIENT_SRC_DIR to $TEMP_CLIENT_BUILD_DIR...${NC}"
cp -r "$DEMO_CLIENT_SRC_DIR/contracts" "$TEMP_CLIENT_BUILD_DIR/"
cp -r "$DEMO_CLIENT_SRC_DIR/migrations" "$TEMP_CLIENT_BUILD_DIR/"
cp "$DEMO_CLIENT_SRC_DIR/truffle-config.js" "$TEMP_CLIENT_BUILD_DIR/"
cp "$DEMO_CLIENT_SRC_DIR/package.json" "$TEMP_CLIENT_BUILD_DIR/"
# Optionally copy package-lock.json if needed for exact dependency versions
# cp "$DEMO_CLIENT_SRC_DIR/package-lock.json" "$TEMP_CLIENT_BUILD_DIR/"

# --- Operations within the temporary directory ---
echo -e "${BLUE}Changing working directory to $TEMP_CLIENT_BUILD_DIR...${NC}"
cd "$TEMP_CLIENT_BUILD_DIR"

# Install dependencies in the temporary directory
echo -e "${BLUE}Installing npm dependencies in temporary directory...${NC}"
npm install --legacy-peer-deps

# Explicitly install dotenv package (required by truffle-config.js)
echo -e "${BLUE}Installing dotenv package in temporary directory...${NC}"
npm install dotenv --save

# Check if Truffle is installed (already checked globally, but good practice)
if ! command_exists truffle; then
    echo -e "${YELLOW}Truffle not found. Installing globally...${NC}"
    npm install -g truffle
    if ! command_exists truffle; then
        echo -e "${RED}Failed to install Truffle. Please install manually:${NC}"
        echo -e "${YELLOW}  npm install -g truffle${NC}"
        exit 1
    fi
    echo -e "${GREEN}Truffle installed successfully.${NC}"
fi

# Ask for private key
echo -e "${YELLOW}You need to provide a private key for a wallet with Base Sepolia ETH for deployment.${NC}"
echo -e "${YELLOW}IMPORTANT: Never use your main wallet key. Use a testing wallet with minimal funds.${NC}"
echo -e "${YELLOW}NOTE: Do NOT include the '0x' prefix - Truffle does not expect it.${NC}"

# Check if private key exists in environment variables
if [ -z "$PRIVATE_KEY" ]; then
    read -p "Enter private key (without 0x prefix): " PRIVATE_KEY

    # Validate private key format (without 0x prefix)
    if [[ ! "$PRIVATE_KEY" =~ ^[a-fA-F0-9]{64}$ ]]; then
        echo -e "${RED}Error: Invalid private key format. It should be a 64-character hex string without 0x prefix.${NC}"
        exit 1
    fi
    
    # Save the private key for future use
    if grep -q "PRIVATE_KEY=" "$INSTALLER_DIR/.env" 2>/dev/null; then
        # Update existing private key entry
        sed -i "s/PRIVATE_KEY=.*/PRIVATE_KEY=\\"$PRIVATE_KEY\\"/" "$INSTALLER_DIR/.env"
    else
        # Append new private key entry
        echo "PRIVATE_KEY=\"$PRIVATE_KEY\"" >> "$INSTALLER_DIR/.env"
    fi
    
    # Set restrictive permissions on .env file
    chmod 600 "$INSTALLER_DIR/.env"
else
    echo -e "${GREEN}Using private key from environment configuration.${NC}"
fi

# Create .env file inside the temporary directory
echo -e "${BLUE}Creating .env file in temporary directory...${NC}"
cat > "$TEMP_CLIENT_BUILD_DIR/.env" << EOL
PRIVATE_KEY=$PRIVATE_KEY
INFURA_API_KEY=$INFURA_API_KEY
EOL

# Set proper permissions
chmod 600 "$TEMP_CLIENT_BUILD_DIR/.env"
echo -e "${GREEN}.env file created in temporary directory.${NC}"

# Update migration file (in the temporary directory) with the correct oracle address and job ID
echo -e "${BLUE}Updating migration file in temporary directory with oracle address and job ID...${NC}"
MIGRATION_FILE="$TEMP_CLIENT_BUILD_DIR/migrations/2_deploy_contract.js"

# Make backup of original migration file (in temp directory)
cp "$MIGRATION_FILE" "$MIGRATION_FILE.backup"

# Corrected sed commands based on the provided migration file structure
# Use different delimiters (#) for sed to avoid issues with slashes or pipes
# Update the oracle address
sed -i.bak "s#const oracleAddress = \".*\";#const oracleAddress = \"$OPERATOR_ADDRESS\";#" "$MIGRATION_FILE"
# Update the job ID within the fromAscii function
sed -i.bak "s#web3.utils.fromAscii(\".*\")#web3.utils.fromAscii(\"$JOB_ID_NO_HYPHENS\")#" "$MIGRATION_FILE"


# Check that the changes were made
# Adjust grep patterns to match the updated lines exactly
# Use printf and grep -F for safer checking
pattern1=$(printf 'const oracleAddress = "%s";' "$OPERATOR_ADDRESS")
pattern2=$(printf 'web3.utils.fromAscii("%s")' "$JOB_ID_NO_HYPHENS")
if grep -qF -- "$pattern1" "$MIGRATION_FILE" && grep -qF -- "$pattern2" "$MIGRATION_FILE"; then
    echo -e "${GREEN}Migration file updated successfully in temporary directory with:${NC}"
    echo -e "${GREEN}- Oracle Address: $OPERATOR_ADDRESS${NC}"
    echo -e "${GREEN}- Job ID (used in fromAscii): $JOB_ID_NO_HYPHENS${NC}"
else
    echo -e "${RED}Failed to update migration file in temporary directory.${NC}"
    # Optional: Display the sed commands and file content for debugging
    # echo "sed command 1: sed -i.bak \"s|const oracleAddress = \\\"\\\".*\\\\\"\\\";|const oracleAddress = \\\"$OPERATOR_ADDRESS\\\";|\" \"$MIGRATION_FILE\""
    # echo "sed command 2: sed -i.bak \"s|web3.utils.fromAscii(\\\".*\\\")|web3.utils.fromAscii(\\\"$JOB_ID_NO_HYPHENS\\\")|\" \"$MIGRATION_FILE\""
    # echo "Checking for pattern1: [$pattern1]"
    # echo "Checking for pattern2: [$pattern2]"
    # cat "$MIGRATION_FILE"
    exit 1
fi

# Deploy contract from the temporary directory
echo -e "${BLUE}Deploying client contract from temporary directory...${NC}"
echo -e "${YELLOW}WARNING: This will deploy the contract to the Base Sepolia testnet.${NC}"
echo -e "${YELLOW}Make sure your wallet has enough Base Sepolia ETH for gas fees.${NC}"

if ask_yes_no "Do you want to deploy the contract now?"; then
    # We are already in TEMP_CLIENT_BUILD_DIR
    
    # Explicitly source the .env file in this specific subshell/command context
    # to ensure the correct variables are used by Truffle
    echo -e "${BLUE}Sourcing environment for Truffle deployment...${NC}"
    TEMP_ENV_FILE="$TEMP_CLIENT_BUILD_DIR/.env"
    if [ -f "$TEMP_ENV_FILE" ]; then
        # Read variables directly from the temp .env file
        source "$TEMP_ENV_FILE"
        echo -e "${GREEN}Environment sourced.${NC}"
    else
        echo -e "${RED}Error: Temporary .env file not found at $TEMP_ENV_FILE${NC}"
        exit 1
    fi

    # Try to deploy the contract, explicitly passing env vars
    echo -e "${BLUE}Running truffle migrate to deploy the contract...${NC}"
    # Prepend command with env vars to ensure correct context for truffle
    if env PRIVATE_KEY="$PRIVATE_KEY" INFURA_API_KEY="$INFURA_API_KEY" truffle migrate --network base_sepolia; then
        echo -e "${GREEN}Client contract deployed successfully!${NC}"

        # Created simplified address extraction that avoids complex nesting and escaping
        # Write a dedicated extraction script instead
        EXTRACT_SCRIPT="$TEMP_CLIENT_BUILD_DIR/extract_address.sh"
        cat > "$EXTRACT_SCRIPT" << 'EXTRACT_EOF'
#!/bin/bash
BUILD_DIR="$1"
# Try several methods
# Method 1: From truffle output log if available
if [ -f "truffle-output.log" ]; then
    ADDR=$(grep -A 5 "Deploying 'AIChainlinkRequest'" truffle-output.log | grep "contract address:" | awk '{print $NF}')
    if [ -n "$ADDR" ]; then echo "$ADDR"; exit 0; fi
fi
# Method 2: Using find and jq
if command -v jq >/dev/null 2>&1; then
    ADDR=$(find "$BUILD_DIR/build/contracts" -name AIChainlinkRequest.json -exec jq -r '.networks | to_entries[] | .value.address' {} \; 2>/dev/null | head -1)
    if [ -n "$ADDR" ]; then echo "$ADDR"; exit 0; fi
fi
# Method 3: Direct grep on build files
ADDR=$(grep -r '"address":' "$BUILD_DIR/build/contracts" | grep -i "AIChainlinkRequest" | head -1 | sed -E 's/.*"address": "([^"]+)".*/\1/')
echo "$ADDR"
EXTRACT_EOF
        chmod +x "$EXTRACT_SCRIPT"
        CLIENT_ADDRESS=$("$EXTRACT_SCRIPT" "$TEMP_CLIENT_BUILD_DIR")
        
        if [ -n "$CLIENT_ADDRESS" ]; then
            echo -e "${GREEN}Client contract deployed at: $CLIENT_ADDRESS${NC}"
            # Save client contract address to the main installer directory
            echo "CLIENT_ADDRESS=\"$CLIENT_ADDRESS\"" >> "$INSTALLER_DIR/.contracts"
        else
            echo -e "${YELLOW}Unable to automatically extract client contract address from build artifacts in $TEMP_CLIENT_BUILD_DIR.${NC}"
            echo -e "${YELLOW}Please check the deployment logs above for the contract address.${NC}"
            read -p "Enter the deployed contract address \(0x...\): " CLIENT_ADDRESS_MANUAL
            if [ -n "$CLIENT_ADDRESS_MANUAL" ]; then
                 # Basic validation
                if [[ "$CLIENT_ADDRESS_MANUAL" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
                    CLIENT_ADDRESS="$CLIENT_ADDRESS_MANUAL"
                    echo "CLIENT_ADDRESS=\"$CLIENT_ADDRESS\"" >> "$INSTALLER_DIR/.contracts"
                    echo -e "${GREEN}Client contract address saved: $CLIENT_ADDRESS${NC}"
                else
                    echo -e "${RED}Invalid address format entered.${NC}"
                fi
            fi
        fi
    else
        echo -e "${RED}Contract deployment failed.${NC}"
        echo -e "${YELLOW}Please check the logs above for more information.${NC}"
        # Consider adding: echo -e "${YELLOW}Build artifacts are in $TEMP_CLIENT_BUILD_DIR${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}Contract deployment skipped.${NC}"
    echo -e "${YELLOW}You can deploy the contract manually later from the temporary directory:${NC}"
    echo -e "${YELLOW}  cd $TEMP_CLIENT_BUILD_DIR${NC}"
    echo -e "${YELLOW}  truffle migrate --network base_sepolia${NC}"
    # Optionally add instruction to manually update migration file first if skipped now
    exit 0
fi

# --- Post-Deployment ---
# Navigate back to installer dir or script dir if needed, or stay in temp? Let's go back.
cd "$SCRIPT_DIR"

# Contract funding instructions
echo -e "${BLUE}Contract Funding Instructions${NC}"
echo -e "${BLUE}==========================${NC}"
echo -e "${YELLOW}1. Fund your wallet with LINK tokens:${NC}"
echo -e "${YELLOW}   - Ensure the wallet you use to call the client contract has Base Sepolia LINK tokens.${NC}"
echo -e "${YELLOW}   - Get LINK from the Chainlink Faucet: https://faucets.chain.link${NC}"
echo -e "${YELLOW}2. Approve the client contract to spend your LINK:${NC}"
echo -e "${YELLOW}   - You must approve the client contract \($CLIENT_ADDRESS\) to spend LINK from your wallet.${NC}"
echo -e "${YELLOW}   - Approve an amount sufficient for the requests you plan to make \(Fee is 0.05 LINK per request\).${NC}"
echo -e "${YELLOW}   - You can use a block explorer \(like Basescan\) or the example script in the *original* demo-client:${NC}"
# Note: We need to get the relative path for the example script from the *original* demo-client
CLIENT_SCRIPT_PATH="$DEMO_CLIENT_SRC_DIR/scripts/create_request.js" # Point to original script for *usage*
echo -e "${YELLOW}     node $CLIENT_SCRIPT_PATH \(This script includes an approval step\)${NC}"
echo
echo -e "${YELLOW}3. Fund your Chainlink node with Base Sepolia ETH:${NC}"
echo -e "${YELLOW}   - Your Chainlink node needs Base Sepolia ETH to pay for gas when fulfilling requests${NC}"
echo -e "${YELLOW}   - Get Base Sepolia ETH from faucets: https://www.coinbase.com/faucets/base-sepolia-faucet${NC}"
echo -e "${YELLOW}   - Find your node\'s ETH address at: http://localhost:6688 -> Key Management -> ETH Keys${NC}"
echo -e "${YELLOW}   - Send at least 0.1 Base Sepolia ETH to your node\'s address${NC}"
echo
echo -e "${YELLOW}4. Testing the contract:${NC}"
echo -e "${YELLOW}   - The deployed client contract \($CLIENT_ADDRESS\) should now be compatible with the operator contract${NC}"
echo -e "${YELLOW}   - Use the interface in the external adapter or the example script in the *original* demo-client \($CLIENT_SCRIPT_PATH\) to make requests${NC}"
echo -e "${YELLOW}   - Check the Chainlink node UI for job runs and their status${NC}"


# Save information to a file (in the installer directory, not temp)
echo -e "${BLUE}Saving client contract information...${NC}"
# Define INFO_DIR relative to INSTALLER_DIR
INFO_DIR="$INSTALLER_DIR/info" # Store info in the installer dir
mkdir -p "$INFO_DIR"
INFO_FILE="$INFO_DIR/client_contract_info.txt" # Define info file path

cat > "$INFO_FILE" << EOL
Verdikta Client Contract Information
==================================

Deployed Client Contract Address: $CLIENT_ADDRESS
Operator Contract Address: $OPERATOR_ADDRESS
Job ID \(Full\): $JOB_ID
Job ID \(Used in Contract\): $JOB_ID_NO_HYPHENS

Deployment Source: Temporary copy from $DEMO_CLIENT_SRC_DIR
Deployment Build Artifacts: $TEMP_CLIENT_BUILD_DIR \(may be cleaned up\)

Funding Requirements:
1. User Wallet Funding & Approval:
   - Ensure your calling wallet has Base Sepolia LINK tokens \(Faucet: https://faucets.chain.link\).
   - Approve the Deployed Client Contract \($CLIENT_ADDRESS\) to spend LINK from your wallet.
   - Fee per request: 0.05 LINK. Approve enough for expected usage.

2. Chainlink Node Funding:
   - Your node needs Base Sepolia ETH to pay for transaction gas.
   - Get Base Sepolia ETH from: https://www.coinbase.com/faucets/base-sepolia-faucet
   - Find your node's address in the Chainlink UI: Key Management -> ETH Keys
   - Send at least 0.1 Base Sepolia ETH to your node's address.

Testing the Setup:
1. Ensure your calling wallet has LINK and has approved the deployed client contract \($CLIENT_ADDRESS\).
2. Ensure the Chainlink node wallet is funded with Base Sepolia ETH.
3. Make a request to the client contract \(e.g., using the example script: node $CLIENT_SCRIPT_PATH\).
4. Monitor job runs in the Chainlink UI.

About the Client Contract:
The client contract \(AIChainlinkRequest\) deployed at $CLIENT_ADDRESS was configured
by this script to interact with the deployed Operator contract \($OPERATOR_ADDRESS\)
and the specified Chainlink job \($JOB_ID / $JOB_ID_NO_HYPHENS\).
It uses a user-funded LINK model for requests.

Your Verdikta Validator Node is now fully configured!
EOL

echo -e "${GREEN}Client contract setup completed!${NC}"
echo -e "${GREEN}Your Verdikta Validator Node is now ready to use.${NC}"
echo -e "${BLUE}Deployed Client Contract Address: $CLIENT_ADDRESS${NC}"
echo -e "${BLUE}Check $INFO_FILE for all details.${NC}"

# Optional: Ask user if they want to clean up the temporary directory
# NOTE: Build artifacts might be useful for debugging or verification
if ask_yes_no "Do you want to remove the temporary client build directory ($TEMP_CLIENT_BUILD_DIR)?"; then
    echo -e "${BLUE}Removing temporary client build directory...${NC}"
    rm -rf "$TEMP_CLIENT_BUILD_DIR"
    echo -e "${GREEN}Temporary client build directory removed.${NC}"
fi

exit 0
