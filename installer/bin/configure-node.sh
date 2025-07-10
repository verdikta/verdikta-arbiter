#!/bin/bash

# Verdikta Validator Node - Node Jobs and Bridges Configuration Script
# Sets up bridges and jobs in the Chainlink node

set -e  # Exit on any error

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALLER_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_DIR="$INSTALLER_DIR/config"

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Configuring Node Jobs and Bridges for Verdikta Validator Node...${NC}"

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

# Define the path to the local chainlink-node directory
LOCAL_CHAINLINK_NODE_DIR="$(dirname "$INSTALLER_DIR")/chainlink-node"
JOB_SPEC_FILE="$LOCAL_CHAINLINK_NODE_DIR/basicJobSpec"

if [ ! -f "$JOB_SPEC_FILE" ]; then
    echo -e "${RED}Error: basicJobSpec not found in $LOCAL_CHAINLINK_NODE_DIR${NC}"
    exit 1
fi
echo -e "${GREEN}Using job spec template from: $JOB_SPEC_FILE${NC}"

# Load Chainlink node API credentials (used for both bridge and job creation)
if [ -f "$HOME/.chainlink-sepolia/.api" ]; then
    API_CREDENTIALS=( $(cat "$HOME/.chainlink-sepolia/.api") )
    API_EMAIL="${API_CREDENTIALS[0]}"
    API_PASSWORD="${API_CREDENTIALS[1]}"
else
    echo -e "${RED}Error: Chainlink node API credentials not found. Please run setup-chainlink.sh first.${NC}"
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

# Function to login to Chainlink node API and get session cookie (for bridge creation)
login_to_chainlink() {
    # Get CSRF token
    CSRF_TOKEN=$(curl -sS -c /tmp/chainlink_cookies.txt "http://localhost:6688/login" | grep csrf | sed -E 's/.*content="([^"]+)".*/\1/')
    
    # Login and get session cookie
    LOGIN_RESPONSE=$(curl -sS -b /tmp/chainlink_cookies.txt -c /tmp/chainlink_cookies.txt -X POST -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF_TOKEN" -d "{\"email\":\"$API_EMAIL\",\"password\":\"$API_PASSWORD\"}" "http://localhost:6688/sessions")
    
    # Check if login was successful
    if echo "$LOGIN_RESPONSE" | grep -q "error"; then
        echo -e "${RED}Error: Failed to login to Chainlink node. Response: $LOGIN_RESPONSE${NC}"
        rm -f /tmp/chainlink_cookies.txt
        return 1
    fi
    
    return 0
}

# Check if Chainlink node is running
echo -e "${BLUE}Checking if Chainlink node is running...${NC}"
if ! curl -s http://localhost:6688/health > /dev/null; then
    echo -e "${RED}Error: Chainlink node is not running. Please start the Chainlink node:${NC}"
    echo -e "${YELLOW}docker start chainlink${NC}"
    exit 1
fi

# Get local IP address
LOCAL_IP=$(hostname -I | awk '{print $1}')
if [ -z "$LOCAL_IP" ]; then
    LOCAL_IP="localhost"
fi

# Ask for the host IP or confirm local IP
echo -e "${BLUE}Setting up External Adapter bridge connection...${NC}"
read -p "Enter your machine's IP address or hostname [$LOCAL_IP]: " HOST_IP
if [ -z "$HOST_IP" ]; then
    HOST_IP="$LOCAL_IP"
fi

# Login to Chainlink node
echo -e "${BLUE}Logging in to Chainlink node...${NC}"
if ! login_to_chainlink; then
    echo -e "${RED}Failed to login to Chainlink node. Please check your credentials and try again.${NC}"
    exit 1
fi

# Create bridge
echo -e "${BLUE}Creating bridge to External Adapter...${NC}"
BRIDGE_NAME="verdikta-ai"
BRIDGE_URL="http://$HOST_IP:8080/evaluate"

# Get CSRF token for bridge creation
CSRF_TOKEN=$(grep -i "csrf" /tmp/chainlink_cookies.txt | cut -f 7)

# Create bridge
BRIDGE_RESPONSE=$(curl -sS -b /tmp/chainlink_cookies.txt -X POST -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF_TOKEN" -d "{\"name\":\"$BRIDGE_NAME\",\"url\":\"$BRIDGE_URL\",\"confirmations\":0,\"minimumContractPayment\":\"0\"}" "http://localhost:6688/v2/bridge_types")

# Check if bridge creation was successful
if echo "$BRIDGE_RESPONSE" | grep -q "error"; then
    if echo "$BRIDGE_RESPONSE" | grep -q "bridge type already exists"; then
        echo -e "${YELLOW}Bridge '$BRIDGE_NAME' already exists. Updating...${NC}"
        BRIDGE_RESPONSE=$(curl -sS -b /tmp/chainlink_cookies.txt -X PATCH -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF_TOKEN" -d "{\"name\":\"$BRIDGE_NAME\",\"url\":\"$BRIDGE_URL\",\"confirmations\":0,\"minimumContractPayment\":\"0\"}" "http://localhost:6688/v2/bridge_types/$BRIDGE_NAME")
        if echo "$BRIDGE_RESPONSE" | grep -q "error"; then
            echo -e "${RED}Error: Failed to update bridge. Response: $BRIDGE_RESPONSE${NC}"
            rm -f /tmp/chainlink_cookies.txt
            exit 1
        fi
        echo -e "${GREEN}Bridge updated successfully.${NC}"
    else
        echo -e "${RED}Error: Failed to create bridge. Response: $BRIDGE_RESPONSE${NC}"
        rm -f /tmp/chainlink_cookies.txt
        exit 1
    fi
else
    echo -e "${GREEN}Bridge created successfully.${NC}"
fi

# Create job automatically
echo -e "${BLUE}Preparing job specification...${NC}"

# Load and customize job spec
JOB_SPEC=$(cat "$JOB_SPEC_FILE")
echo -e "${BLUE}Loaded job spec from $JOB_SPEC_FILE${NC}"

# Format the contract address properly
# Use the address format from the user's input - this is the one that worked in Remix
EIP55_ADDRESS="$OPERATOR_ADDR"
ORIGINAL_CONTRACT_ADDRESS="0xD67D6508D4E5611cd6a463Dd0969Fa153Be91101"

# Update the contract address in the job spec
if [ -n "$ORIGINAL_CONTRACT_ADDRESS" ]; then
    echo -e "${BLUE}Updating contract address in job spec...${NC}"
    JOB_SPEC=$(echo "$JOB_SPEC" | sed "s/contractAddress = \"$ORIGINAL_CONTRACT_ADDRESS\"/contractAddress = \"$EIP55_ADDRESS\"/g")
    JOB_SPEC=$(echo "$JOB_SPEC" | sed "s/to=\"$ORIGINAL_CONTRACT_ADDRESS\"/to=\"$EIP55_ADDRESS\"/g")

    # Check if the replacement was successful
    if echo "$JOB_SPEC" | grep -q "$EIP55_ADDRESS"; then
        echo -e "${GREEN}Successfully updated contract address in job spec.${NC}"
    else
        echo -e "${YELLOW}Warning: Failed to update contract address in job spec. Please replace manually.${NC}"
    fi
fi

# Save the prepared job spec to a file for automated creation
AUTOMATED_JOB_SPEC_FILE="$LOCAL_CHAINLINK_NODE_DIR/verdikta_job_spec.toml"
mkdir -p "$(dirname "$AUTOMATED_JOB_SPEC_FILE")"
echo "$JOB_SPEC" > "$AUTOMATED_JOB_SPEC_FILE"
echo -e "${GREEN}Job specification prepared and saved to: $AUTOMATED_JOB_SPEC_FILE${NC}"

# Clear any existing session cookies
rm -f /tmp/chainlink_cookies.txt

# Create job automatically using our automation script
echo -e "${BLUE}Creating Chainlink job automatically...${NC}"

# Call the automated job creation script
JOB_OUTPUT_FILE="/tmp/configure_node_job_id.txt"
if "$SCRIPT_DIR/create-chainlink-job.sh" -f "$AUTOMATED_JOB_SPEC_FILE" -o "$JOB_OUTPUT_FILE"; then
    # Job creation successful - read the job ID
    if [ -f "$JOB_OUTPUT_FILE" ]; then
        NEW_JOB_ID=$(cat "$JOB_OUTPUT_FILE")
        echo -e "${GREEN}Job created successfully with ID: $NEW_JOB_ID${NC}"
        
        # Clean up temporary file
        rm -f "$JOB_OUTPUT_FILE"
    else
        echo -e "${RED}Error: Job creation succeeded but job ID file not found.${NC}"
        exit 1
    fi
else
    echo -e "${RED}Error: Automated job creation failed.${NC}"
    echo -e "${YELLOW}Falling back to manual job creation instructions...${NC}"
    echo
    echo -e "${YELLOW}============================================================${NC}"
    echo -e "${YELLOW}                MANUAL JOB CREATION REQUIRED               ${NC}"
    echo -e "${YELLOW}============================================================${NC}"
    echo
    echo -e "${BLUE}Please follow these steps to create the Chainlink job:${NC}"
    echo -e "${BLUE}1. Open the Chainlink Operator UI in your browser:${NC}"
    echo -e "   ${GREEN}http://localhost:6688${NC}"
    echo -e "${BLUE}2. Log in with:${NC}"
    echo -e "   ${GREEN}Email:    $API_EMAIL${NC}"
    echo -e "   ${GREEN}Password: $API_PASSWORD${NC}"
    echo -e "${BLUE}3. Navigate to the 'Jobs' section in the sidebar${NC}"
    echo -e "${BLUE}4. Click '+ New Job' button${NC}"
    echo -e "${BLUE}5. Select 'TOML' format${NC}"
    echo -e "${BLUE}6. Copy and paste the entire content from this file:${NC}"
    echo -e "   ${GREEN}$AUTOMATED_JOB_SPEC_FILE${NC}"
    echo -e "${BLUE}7. Click 'Create Job'${NC}"
    echo
    echo -e "${BLUE}You can cat the file and copy its contents:${NC}"
    echo -e "${GREEN}cat $AUTOMATED_JOB_SPEC_FILE${NC}"
    echo

    # Prompt the user to continue after they've created the job manually
    read -p "Have you created the job in the Chainlink UI? (y/n): " job_created
    if [[ "$job_created" != "y" && "$job_created" != "Y" ]]; then
        echo -e "${YELLOW}Please create the job before continuing.${NC}"
        echo -e "${YELLOW}You can run this script again after creating the job.${NC}"
        exit 1
    fi

    # Ask user for the job ID from the UI
    echo -e "${BLUE}After creating the job, you'll see the job details page.${NC}"
    echo -e "${BLUE}The job ID is shown at the top of the page (typically in a UUID format like: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)${NC}"
    read -p "Please enter the job ID from the UI: " NEW_JOB_ID

    if [ -z "$NEW_JOB_ID" ]; then
        echo -e "${RED}Error: No job ID provided.${NC}"
        exit 1
    fi

    echo -e "${GREEN}Job ID entered: $NEW_JOB_ID${NC}"
fi

# Update the contracts file with the new job ID
if [ -f "$INSTALLER_DIR/.contracts" ]; then
    # Check if job IDs already exist in .contracts file
    if grep -q "^JOB_ID=" "$INSTALLER_DIR/.contracts"; then
        # Replace existing job ID entries
        sed -i "s/^JOB_ID=.*/JOB_ID=\"$NEW_JOB_ID\"/" "$INSTALLER_DIR/.contracts"
        # Remove hyphens for the no-hyphens version
        NEW_JOB_ID_NO_HYPHENS=$(echo "$NEW_JOB_ID" | tr -d '-')
        sed -i "s/^JOB_ID_NO_HYPHENS=.*/JOB_ID_NO_HYPHENS=\"$NEW_JOB_ID_NO_HYPHENS\"/" "$INSTALLER_DIR/.contracts"
    else
        # Add new job ID entries
        echo "JOB_ID=\"$NEW_JOB_ID\"" >> "$INSTALLER_DIR/.contracts"
        NEW_JOB_ID_NO_HYPHENS=$(echo "$NEW_JOB_ID" | tr -d '-')
        echo "JOB_ID_NO_HYPHENS=\"$NEW_JOB_ID_NO_HYPHENS\"" >> "$INSTALLER_DIR/.contracts"
    fi
    echo -e "${GREEN}Updated job IDs in $INSTALLER_DIR/.contracts${NC}"
    
    # Remove job placeholder file if it exists
    if [ -f "$INSTALLER_DIR/.job_placeholder" ]; then
        echo -e "${BLUE}Removing temporary job placeholder file...${NC}"
        rm -f "$INSTALLER_DIR/.job_placeholder"
    fi
else
    echo -e "${RED}Warning: Could not update job IDs in $INSTALLER_DIR/.contracts${NC}"
    echo -e "${YELLOW}Creating new .contracts file with job IDs...${NC}"
    
    # Create new .contracts file or append to it
    echo "JOB_ID=\"$NEW_JOB_ID\"" >> "$INSTALLER_DIR/.contracts"
    NEW_JOB_ID_NO_HYPHENS=$(echo "$NEW_JOB_ID" | tr -d '-')
    echo "JOB_ID_NO_HYPHENS=\"$NEW_JOB_ID_NO_HYPHENS\"" >> "$INSTALLER_DIR/.contracts"
    echo -e "${GREEN}Created .contracts file with job IDs${NC}"
fi

# Save job information
echo -e "${BLUE}Saving job information...${NC}"
JOB_INFO_DIR="$LOCAL_CHAINLINK_NODE_DIR/info"
mkdir -p "$JOB_INFO_DIR"
cat > "$JOB_INFO_DIR/job_info.txt" << EOL
Verdikta Chainlink Node Job Information
======================================

Bridge Name: $BRIDGE_NAME
Bridge URL: $BRIDGE_URL
Job ID: $NEW_JOB_ID
Job ID (no hyphens): $NEW_JOB_ID_NO_HYPHENS

The job is configured to use the External Adapter at:
http://$HOST_IP:8080/evaluate

To test the job:
1. Go to the Chainlink node UI at http://localhost:6688
2. Navigate to the 'Jobs' tab and find job with ID: $NEW_JOB_ID
3. Click on 'Run' to test the job

Your Verdikta Validator Node is now fully configured!
EOL

# Final cleanup
rm -f /tmp/chainlink_cookies.txt
echo -e "${BLUE}Job configuration process completed.${NC}"

# Save bridge and job information
echo -e "${GREEN}Node Jobs and Bridges configuration completed!${NC}"
echo -e "${GREEN}Your Verdikta Validator Node is now fully configured and ready to use.${NC}"
echo -e "${BLUE}Job ID: $NEW_JOB_ID${NC}"
echo -e "${BLUE}Bridge Name: $BRIDGE_NAME${NC}"
echo -e "${BLUE}Bridge URL: $BRIDGE_URL${NC}"
echo
echo -e "${BLUE}Automation Summary:${NC}"
echo -e "${GREEN}✓ Bridge created/updated automatically${NC}"
echo -e "${GREEN}✓ Job created automatically via API${NC}"
echo -e "${GREEN}✓ All configuration files updated${NC}"

exit 0 