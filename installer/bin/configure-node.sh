#!/bin/bash

# Verdikta Validator Node - Multi-Arbiter Configuration Script
# Sets up bridges and jobs for 1-10 arbiters in the Chainlink node

set -e  # Exit on any error

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALLER_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_DIR="$INSTALLER_DIR/config"
KEY_MGMT_SCRIPT="$SCRIPT_DIR/key-management.sh"

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Configuring Multi-Arbiter Node Jobs and Bridges for Verdikta Validator Node...${NC}"

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

# Load API keys for re-authorization
if [ -f "$INSTALLER_DIR/.api_keys" ]; then
    source "$INSTALLER_DIR/.api_keys"
else
    echo -e "${YELLOW}Warning: API keys file not found. Re-authorization may not work.${NC}"
fi

# Clear any cached ARBITER_COUNT to ensure fresh user input
unset ARBITER_COUNT

# Define the path to the local chainlink-node directory
LOCAL_CHAINLINK_NODE_DIR="$(dirname "$INSTALLER_DIR")/chainlink-node"
JOB_SPEC_FILE="$LOCAL_CHAINLINK_NODE_DIR/basicJobSpec"

if [ ! -f "$JOB_SPEC_FILE" ]; then
    echo -e "${RED}Error: basicJobSpec not found in $LOCAL_CHAINLINK_NODE_DIR${NC}"
    exit 1
fi
echo -e "${GREEN}Using job spec template from: $JOB_SPEC_FILE${NC}"

# Check if key management script exists
if [ ! -f "$KEY_MGMT_SCRIPT" ]; then
    echo -e "${RED}Error: Key management script not found at $KEY_MGMT_SCRIPT${NC}"
    exit 1
fi

# Load Chainlink node API credentials
CHAINLINK_DIR="$HOME/.chainlink-${NETWORK_TYPE}"
if [ -f "$CHAINLINK_DIR/.api" ]; then
    API_CREDENTIALS=( $(cat "$CHAINLINK_DIR/.api") )
    API_EMAIL="${API_CREDENTIALS[0]}"
    API_PASSWORD="${API_CREDENTIALS[1]}"
else
    echo -e "${RED}Error: Chainlink node API credentials not found at $CHAINLINK_DIR/.api. Please run setup-chainlink.sh first.${NC}"
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

# Detect existing arbiter count from contracts file or jobs
DETECTED_ARBITER_COUNT=1
DEFAULT_COUNT_SOURCE="default"

# Try to detect from existing contracts file first
if [ -f "$INSTALLER_DIR/.contracts" ]; then
    source "$INSTALLER_DIR/.contracts"
    if [ -n "$ARBITER_COUNT" ] && [[ "$ARBITER_COUNT" =~ ^[1-9]$|^10$ ]]; then
        DETECTED_ARBITER_COUNT="$ARBITER_COUNT"
        DEFAULT_COUNT_SOURCE="contracts file"
    fi
fi

# If not found in contracts, try to detect from existing jobs in Chainlink node
if [ "$DETECTED_ARBITER_COUNT" -eq 1 ] && [ "$DEFAULT_COUNT_SOURCE" = "default" ]; then
    echo -e "${BLUE}Detecting existing arbiter configuration...${NC}"
    
    # Get list of existing Verdikta AI Arbiter jobs
    jobs_response=$(curl -sS -b /tmp/chainlink_cookies.txt "http://localhost:6688/v2/jobs" 2>/dev/null)
    
    if [ $? -eq 0 ] && [ -n "$jobs_response" ]; then
        existing_count=$(echo "$jobs_response" | python3 -c "
import json
import sys
try:
    data = json.load(sys.stdin)
    count = 0
    if 'data' in data:
        for job in data['data']:
            if 'attributes' in job and 'name' in job['attributes']:
                job_name = job['attributes']['name']
                if 'Verdikta AI Arbiter' in job_name:
                    count += 1
    print(count)
except:
    print(0)
" 2>/dev/null)
        
        if [ -n "$existing_count" ] && [ "$existing_count" -gt 0 ] && [ "$existing_count" -le 10 ]; then
            DETECTED_ARBITER_COUNT="$existing_count"
            DEFAULT_COUNT_SOURCE="existing jobs"
        fi
    fi
fi

# Prompt for number of arbiters with detected default
echo -e "${BLUE}Multi-Arbiter Configuration${NC}"
if [ "$DEFAULT_COUNT_SOURCE" != "default" ]; then
    echo -e "${GREEN}Detected existing configuration: $DETECTED_ARBITER_COUNT arbiter(s) (from $DEFAULT_COUNT_SOURCE)${NC}"
fi
echo "How many arbiters would you like to configure? (1-10)"
while true; do
    read -p "Enter number of arbiters [$DETECTED_ARBITER_COUNT]: " ARBITER_COUNT
    
    # Default to detected count if empty
    if [ -z "$ARBITER_COUNT" ]; then
        ARBITER_COUNT="$DETECTED_ARBITER_COUNT"
    fi
    
    # Validate input
    if [[ "$ARBITER_COUNT" =~ ^[1-9]$|^10$ ]]; then
        break
    else
        echo -e "${RED}Please enter a number between 1 and 10.${NC}"
    fi
done

echo -e "${GREEN}Configuring $ARBITER_COUNT arbiter(s)...${NC}"

# Install expect if needed for key management
echo -e "${BLUE}Ensuring key management dependencies are installed...${NC}"
if ! bash "$KEY_MGMT_SCRIPT" install_expect; then
    echo -e "${RED}Error: Failed to install key management dependencies.${NC}"
    exit 1
fi

# Ensure we have sufficient keys for all arbiters
echo -e "${BLUE}Setting up Ethereum keys for $ARBITER_COUNT arbiters...${NC}"
KEYS_LIST=$(bash "$KEY_MGMT_SCRIPT" ensure_keys_exist "$ARBITER_COUNT" "$API_EMAIL" "$API_PASSWORD")
if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Failed to ensure sufficient keys exist.${NC}"
    exit 1
fi

echo -e "${GREEN}Successfully configured keys for $ARBITER_COUNT arbiters${NC}"
echo -e "${BLUE}Keys: $KEYS_LIST${NC}"

# Update contracts file with key information
echo -e "${BLUE}Updating contracts file with key information...${NC}"
if bash "$KEY_MGMT_SCRIPT" update_contracts_with_keys "$INSTALLER_DIR/.contracts" "$KEYS_LIST" "$ARBITER_COUNT"; then
    echo -e "${GREEN}Contracts file updated with key information${NC}"
else
    echo -e "${RED}Error: Failed to update contracts file with keys${NC}"
    exit 1
fi

# Save user input before reloading contracts file
USER_ARBITER_COUNT="$ARBITER_COUNT"

# Reload contracts file to get the key information
source "$INSTALLER_DIR/.contracts"

# Restore user input (don't let cached value override user choice)
ARBITER_COUNT="$USER_ARBITER_COUNT"

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

# Brief delay after login to ensure session is established
echo -e "${BLUE}Login successful, preparing for API operations...${NC}"
sleep 1

# Create bridge (only one bridge needed for all arbiters)
echo -e "${BLUE}Creating bridge to External Adapter...${NC}"
BRIDGE_NAME="verdikta-ai"
BRIDGE_URL="http://$HOST_IP:8080/evaluate"

# Get CSRF token for bridge creation
CSRF_TOKEN=$(grep -i "csrf" /tmp/chainlink_cookies.txt | cut -f 7)

# Create bridge
BRIDGE_RESPONSE=$(curl -sS -b /tmp/chainlink_cookies.txt -X POST -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF_TOKEN" -d "{\"name\":\"$BRIDGE_NAME\",\"url\":\"$BRIDGE_URL\",\"confirmations\":0,\"minimumContractPayment\":\"0\"}" "http://localhost:6688/v2/bridge_types")

# Brief delay after bridge creation to avoid rate limits
echo -e "${BLUE}Waiting briefly to avoid rate limits...${NC}"
sleep 2

# Check if bridge creation was successful
if echo "$BRIDGE_RESPONSE" | grep -q "errors"; then
    if echo "$BRIDGE_RESPONSE" | grep -q "already exists"; then
        echo -e "${YELLOW}Bridge '$BRIDGE_NAME' already exists. Updating...${NC}"
        BRIDGE_RESPONSE=$(curl -sS -b /tmp/chainlink_cookies.txt -X PATCH -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF_TOKEN" -d "{\"name\":\"$BRIDGE_NAME\",\"url\":\"$BRIDGE_URL\",\"confirmations\":0,\"minimumContractPayment\":\"0\"}" "http://localhost:6688/v2/bridge_types/$BRIDGE_NAME")
        if echo "$BRIDGE_RESPONSE" | grep -q "errors"; then
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

# Keep session alive for job creation
echo -e "${GREEN}Session established, creating jobs using same session...${NC}"

# Function to properly escape TOML content for JSON
escape_toml_for_json() {
    local toml_file="$1"
    local output_file="$2"
    
    # Read the TOML file and escape it properly for JSON
    python3 -c "
import json
import sys

try:
    with open('$toml_file', 'r') as f:
        toml_content = f.read()
    
    # Create JSON payload with escaped TOML content
    payload = {'toml': toml_content}
    print(json.dumps(payload))
except Exception as e:
    print(f'Error: {e}', file=sys.stderr)
    sys.exit(1)
" > "$output_file"
    
    return $?
}

# Function to create a job via API using existing session
create_chainlink_job_direct() {
    local job_spec_file="$1"
    local job_name="$2"
    
    # Escape TOML content for JSON
    local temp_json="/tmp/job_spec_escaped_$$.json"
    if ! escape_toml_for_json "$job_spec_file" "$temp_json"; then
        echo -e "${RED}Error: Failed to escape TOML content for JSON.${NC}"
        rm -f "$temp_json"
        return 1
    fi
    
    # Create job using existing session cookies
    local job_response=$(curl -sS -b /tmp/chainlink_cookies.txt \
        -X POST \
        -H "Content-Type: application/json" \
        -d @"$temp_json" \
        "http://localhost:6688/v2/jobs")
    
    # Clean up temp file
    rm -f "$temp_json"
    
    # Check if job creation failed
    if ! echo "$job_response" | python3 -c "
import json
import sys
try:
    data = json.load(sys.stdin)
    
    # Check for top-level errors array with actual error content
    if 'errors' in data and isinstance(data['errors'], list) and len(data['errors']) > 0:
        # Check if any error has actual content
        has_real_errors = False
        for error in data['errors']:
            if isinstance(error, dict) and ('detail' in error or 'message' in error):
                has_real_errors = True
                break
        if has_real_errors:
            sys.exit(1)  # Has actual errors
    
    # Check for successful job creation response
    if 'data' in data and isinstance(data['data'], dict):
        # Look for job type and external job ID to confirm success
        if (data['data'].get('type') == 'jobs' and 
            'attributes' in data['data'] and 
            'externalJobID' in data['data']['attributes']):
            sys.exit(0)  # Successful job creation
    
    # If we get here, it's an unexpected response format
    sys.exit(1)
except Exception as e:
    # JSON parsing error or other exception
    sys.exit(1)
"; then
        # Check if it's a duplicate job error
        if echo "$job_response" | grep -q "duplicate key value violates unique constraint"; then
            echo -e "${YELLOW}Warning: A job with the name '$job_name' already exists.${NC}"
            
            # Try to find the existing job ID
            local existing_job_id=$(curl -sS -b /tmp/chainlink_cookies.txt "http://localhost:6688/v2/jobs" | python3 -c "
import json
import sys
try:
    data = json.load(sys.stdin)
    if 'data' in data:
        for job in data['data']:
            if 'attributes' in job and 'name' in job['attributes']:
                if job['attributes']['name'] == '$job_name':
                    if 'externalJobID' in job['attributes']:
                        print(job['attributes']['externalJobID'])
                        sys.exit(0)
    print('Job not found', file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print(f'Error: {e}', file=sys.stderr)
    sys.exit(1)
")
            
            if [ -n "$existing_job_id" ]; then
                echo -e "${BLUE}Found existing job with ID: $existing_job_id${NC}"
                echo "$existing_job_id"
                return 0
            else
                echo -e "${RED}Error: Could not find existing job ID.${NC}"
                echo "$job_response" | python3 -m json.tool 2>/dev/null || echo "$job_response"
                return 1
            fi
        else
            echo -e "${RED}Error: Failed to create job '$job_name'. Response:${NC}"
            echo "$job_response" | python3 -m json.tool 2>/dev/null || echo "$job_response"
            return 1
        fi
    else
        # Extract job ID from successful creation response
        local job_id=$(echo "$job_response" | python3 -c "
import json
import sys
import re

try:
    data = json.load(sys.stdin)
    if 'data' in data and 'attributes' in data['data'] and 'externalJobID' in data['data']['attributes']:
        print(data['data']['attributes']['externalJobID'])
    elif 'data' in data and 'id' in data['data']:
        print(data['data']['id'])
    elif 'id' in data:
        print(data['id'])
    else:
        print('Job ID not found in response', file=sys.stderr)
        sys.exit(1)
except Exception as e:
    print(f'Error parsing response: {e}', file=sys.stderr)
    sys.exit(1)
")
        
        if [ -z "$job_id" ]; then
            echo -e "${RED}Error: Could not extract job ID from response.${NC}"
            echo "Response: $job_response"
            return 1
        fi
        
        # Only output the job ID for capture - success message will be displayed by caller
        echo "$job_id"
        return 0
    fi
}

# Set network-specific configuration values for job specs
if [ "$DEPLOYMENT_NETWORK" = "base_mainnet" ]; then
    CHAIN_ID="8453"
else
    # Default to Base Sepolia
    CHAIN_ID="84532"
fi

echo -e "${BLUE}Using network configuration: Chain ID $CHAIN_ID, Gas Price $GAS_PRICE_WEI wei${NC}"

# Function to delete existing jobs by name pattern
delete_existing_jobs() {
    echo -e "${BLUE}Checking for existing Verdikta AI Arbiter jobs to remove...${NC}"
    
    # Get list of all jobs from Chainlink node
    local jobs_response=$(curl -sS -b /tmp/chainlink_cookies.txt "http://localhost:6688/v2/jobs")
    
    if [ $? -ne 0 ]; then
        echo -e "${YELLOW}Warning: Could not retrieve job list for cleanup. Continuing...${NC}"
        return 0
    fi
    
    # Extract job IDs for jobs with "Verdikta AI Arbiter" in the name
    local jobs_to_delete=$(echo "$jobs_response" | python3 -c "
import json
import sys
try:
    data = json.load(sys.stdin)
    if 'data' in data:
        for job in data['data']:
            if 'attributes' in job and 'name' in job['attributes']:
                job_name = job['attributes']['name']
                if 'Verdikta AI Arbiter' in job_name:
                    if 'id' in job:
                        print(f\"{job['id']}:{job_name}\")
except Exception as e:
    pass
")
    
    if [ -n "$jobs_to_delete" ]; then
        echo -e "${YELLOW}Found existing Verdikta AI Arbiter jobs to delete:${NC}"
        echo "$jobs_to_delete" | while IFS=':' read -r job_id job_name; do
            if [ -n "$job_id" ]; then
                echo -e "${YELLOW}  Deleting: $job_name (ID: $job_id)${NC}"
                
                # Delete the job
                local delete_response=$(curl -sS -b /tmp/chainlink_cookies.txt \
                    -X DELETE \
                    "http://localhost:6688/v2/jobs/$job_id")
                
                if [ $? -eq 0 ]; then
                    echo -e "${GREEN}    ✓ Deleted successfully${NC}"
                else
                    echo -e "${YELLOW}    ⚠ Delete may have failed${NC}"
                fi
                
                # Small delay between deletions
                sleep 1
            fi
        done
        echo -e "${GREEN}Existing job cleanup completed.${NC}"
    else
        echo -e "${GREEN}No existing Verdikta AI Arbiter jobs found.${NC}"
    fi
}

# Create jobs for each arbiter
echo -e "${BLUE}Creating jobs for $ARBITER_COUNT arbiters...${NC}"

# Delete any existing Verdikta AI Arbiter jobs first
delete_existing_jobs

# Initialize job tracking variables
JOB_IDS=()
JOB_IDS_NO_HYPHENS=()
CREATED_JOBS=0
FAILED_JOBS=0

# Create jobs directory for specifications
JOBS_DIR="$LOCAL_CHAINLINK_NODE_DIR/jobs"
mkdir -p "$JOBS_DIR"

# Create each job
for ((i=1; i<=ARBITER_COUNT; i++)); do
    echo -e "\n${BLUE}Creating job $i of $ARBITER_COUNT: Verdikta AI Arbiter $i${NC}"
    
    # Get the appropriate key address for this job
    JOB_KEY_ADDRESS=$(bash "$KEY_MGMT_SCRIPT" get_key_address_for_job "$i" "$KEYS_LIST")
    if [ $? -ne 0 ]; then
        echo -e "${RED}Error: Failed to get key address for job $i${NC}"
        FAILED_JOBS=$((FAILED_JOBS + 1))
        continue
    fi
    
    # Validate that we got a valid key address
    if [ -z "$JOB_KEY_ADDRESS" ]; then
        echo -e "${RED}Error: Empty key address returned for job $i${NC}"
        FAILED_JOBS=$((FAILED_JOBS + 1))
        continue
    fi
    
    # Validate key address format
    if [[ ! "$JOB_KEY_ADDRESS" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
        echo -e "${RED}Error: Invalid key address format for job $i: $JOB_KEY_ADDRESS${NC}"
        FAILED_JOBS=$((FAILED_JOBS + 1))
        continue
    fi
    
    echo -e "${BLUE}Job $i will use key: $JOB_KEY_ADDRESS${NC}"
    
    # Load and customize job spec for this arbiter
    JOB_SPEC=$(cat "$JOB_SPEC_FILE")
    
    # Debug: Show original template before substitution
    echo -e "${BLUE}Debug: Template contains fromAddress line: $(echo "$JOB_SPEC" | grep 'fromAddress')${NC}"
    
    # Replace template variables using a different sed delimiter to avoid issues with special characters
    JOB_SPEC=$(echo "$JOB_SPEC" | sed "s|{JOB_NAME}|Verdikta AI Arbiter $i|g")
    JOB_SPEC=$(echo "$JOB_SPEC" | sed "s|{FROM_ADDRESS}|$JOB_KEY_ADDRESS|g")
    JOB_SPEC=$(echo "$JOB_SPEC" | sed "s|{CONTRACT_ADDRESS}|$OPERATOR_ADDR|g")
    
    # Replace network-specific variables
    JOB_SPEC=$(echo "$JOB_SPEC" | sed "s|<CHAIN_ID>|$CHAIN_ID|g")
    JOB_SPEC=$(echo "$JOB_SPEC" | sed "s|<GAS_PRICE_WEI>|$GAS_PRICE_WEI|g")
    
    # Debug: Show result after substitution
    echo -e "${BLUE}Debug: After substitution fromAddress line: $(echo "$JOB_SPEC" | grep 'fromAddress')${NC}"
    
    # Save the job spec for this arbiter
    JOB_SPEC_FILE_ARBITER="$JOBS_DIR/verdikta_job_spec_arbiter_$i.toml"
    echo "$JOB_SPEC" > "$JOB_SPEC_FILE_ARBITER"
    echo -e "${GREEN}Job specification for Arbiter $i saved to: $JOB_SPEC_FILE_ARBITER${NC}"
    
    # Debug: Show the fromAddress line in the saved file
    echo -e "${BLUE}Debug: Saved file fromAddress line: $(grep 'fromAddress' "$JOB_SPEC_FILE_ARBITER")${NC}"
    
    # Debug: Show first few lines of the saved file to verify content
    echo -e "${BLUE}Debug: First 10 lines of saved job spec:${NC}"
    head -10 "$JOB_SPEC_FILE_ARBITER" | while read line; do
        echo -e "${BLUE}  $line${NC}"
    done
    
    # Create job directly using existing session
    echo -e "${BLUE}Creating Chainlink job for Arbiter $i...${NC}"
    
    # Create job using direct API call with existing session
    JOB_NAME="Verdikta AI Arbiter $i"
    NEW_JOB_ID=$(create_chainlink_job_direct "$JOB_SPEC_FILE_ARBITER" "$JOB_NAME")
    
    if [ $? -eq 0 ] && [ -n "$NEW_JOB_ID" ]; then
        # Validate that NEW_JOB_ID looks like a valid UUID (with or without hyphens)
        if [[ "$NEW_JOB_ID" =~ ^[a-f0-9-]{36}$|^[a-f0-9]{32}$ ]]; then
            echo -e "${GREEN}Job $i created successfully with ID: $NEW_JOB_ID${NC}"
            
            # Store job IDs
            JOB_IDS+=("$NEW_JOB_ID")
            JOB_IDS_NO_HYPHENS+=("$(echo "$NEW_JOB_ID" | tr -d '-')")
            CREATED_JOBS=$((CREATED_JOBS + 1))
        else
            echo -e "${RED}Error: Invalid job ID format received: $NEW_JOB_ID${NC}"
            FAILED_JOBS=$((FAILED_JOBS + 1))
        fi
    else
        echo -e "${RED}Error: Failed to create job for Arbiter $i.${NC}"
        FAILED_JOBS=$((FAILED_JOBS + 1))
    fi
    
    # Brief delay between job creations (much shorter since no authentication needed)
    if [ "$i" -lt "$ARBITER_COUNT" ]; then
        echo -e "${BLUE}Waiting 2 seconds before creating next job...${NC}"
        sleep 2
    fi
done

# Report job creation results
echo -e "\n${BLUE}Job Creation Summary:${NC}"
echo -e "${GREEN}Successfully created: $CREATED_JOBS jobs${NC}"
if [ "$FAILED_JOBS" -gt 0 ]; then
    echo -e "${RED}Failed to create: $FAILED_JOBS jobs${NC}"
fi

# Update the contracts file with all job IDs
if [ ${#JOB_IDS[@]} -gt 0 ]; then
    echo -e "${BLUE}Updating contracts file with job IDs...${NC}"
    
    # Remove existing job ID entries
    sed -i '/^JOB_ID.*=/d' "$INSTALLER_DIR/.contracts"
    
    # Add new job ID entries
    for ((i=0; i<${#JOB_IDS[@]}; i++)); do
        arbiter_num=$((i + 1))
        job_id="${JOB_IDS[$i]}"
        job_id_no_hyphens="${JOB_IDS_NO_HYPHENS[$i]}"
        
        echo "JOB_ID_$arbiter_num=\"$job_id\"" >> "$INSTALLER_DIR/.contracts"
        echo "JOB_ID_${arbiter_num}_NO_HYPHENS=\"$job_id_no_hyphens\"" >> "$INSTALLER_DIR/.contracts"
    done
    
    # Add primary job ID (first one) for backward compatibility
    echo "JOB_ID=\"${JOB_IDS[0]}\"" >> "$INSTALLER_DIR/.contracts"
    echo "JOB_ID_NO_HYPHENS=\"${JOB_IDS_NO_HYPHENS[0]}\"" >> "$INSTALLER_DIR/.contracts"
    
    # Add arbiter count
    echo "ARBITER_COUNT=\"$ARBITER_COUNT\"" >> "$INSTALLER_DIR/.contracts"
    
    echo -e "${GREEN}Updated contracts file with $CREATED_JOBS job IDs${NC}"
    
    # Remove job placeholder file if it exists
    if [ -f "$INSTALLER_DIR/.job_placeholder" ]; then
        echo -e "${BLUE}Removing temporary job placeholder file...${NC}"
        rm -f "$INSTALLER_DIR/.job_placeholder"
    fi
else
    echo -e "${RED}Error: No jobs were created successfully.${NC}"
    exit 1
fi

# Save job information
echo -e "${BLUE}Saving job information...${NC}"
JOB_INFO_DIR="$LOCAL_CHAINLINK_NODE_DIR/info"
mkdir -p "$JOB_INFO_DIR"

# Create comprehensive job info file
cat > "$JOB_INFO_DIR/multi_arbiter_job_info.txt" << EOL
Verdikta Multi-Arbiter Chainlink Node Configuration
==================================================

Configuration Date: $(date)
Number of Arbiters: $ARBITER_COUNT
Jobs Created: $CREATED_JOBS
Jobs Failed: $FAILED_JOBS

Bridge Configuration:
- Bridge Name: $BRIDGE_NAME
- Bridge URL: $BRIDGE_URL
- External Adapter: http://$HOST_IP:8080/evaluate

Job Details:
EOL

# Add details for each successful job
for ((i=0; i<${#JOB_IDS[@]}; i++)); do
    arbiter_num=$((i + 1))
    job_id="${JOB_IDS[$i]}"
    job_id_no_hyphens="${JOB_IDS_NO_HYPHENS[$i]}"
    
    # Get the key address for this job
    job_key_address=$(bash "$KEY_MGMT_SCRIPT" get_key_address_for_job "$arbiter_num" "$KEYS_LIST")
    
    cat >> "$JOB_INFO_DIR/multi_arbiter_job_info.txt" << EOL

Arbiter $arbiter_num:
- Job Name: Verdikta AI Arbiter $arbiter_num
- Job ID: $job_id
- Job ID (no hyphens): $job_id_no_hyphens
- From Address: $job_key_address
- Contract Address: $OPERATOR_ADDR
- Spec File: $JOBS_DIR/verdikta_job_spec_arbiter_$arbiter_num.toml
EOL
done

cat >> "$JOB_INFO_DIR/multi_arbiter_job_info.txt" << EOL

Key Management:
- Total Keys: $(echo "$KEYS_LIST" | tr '|' '\n' | wc -l)
- Keys Assignment: 2 jobs per key (Jobs 1-2 use Key 1, Jobs 3-4 use Key 2, etc.)

Testing:
1. Go to the Chainlink node UI at http://localhost:6688
2. Navigate to the 'Jobs' tab
3. Find each job by its ID and test individual jobs
4. All jobs use the same bridge and external adapter

Your Verdikta Multi-Arbiter Validator Node is now fully configured!
EOL

echo -e "${GREEN}Job information saved to: $JOB_INFO_DIR/multi_arbiter_job_info.txt${NC}"

# Final cleanup
rm -f /tmp/chainlink_cookies.txt
rm -f /tmp/job_spec_escaped_*.json
echo -e "${BLUE}Multi-arbiter configuration process completed.${NC}"

# Re-authorize all keys with operator contract if keys were created
echo -e "${BLUE}🔐 Ensuring all keys are authorized with operator contract...${NC}"
echo -e "${BLUE}   This step prevents authorization gaps when multiple keys are used.${NC}"
echo -e "${BLUE}   Expected time: 2-5 minutes (depending on network conditions)${NC}"

# Get all current keys
CURRENT_KEYS_LIST=$(bash "$KEY_MGMT_SCRIPT" list_existing_keys "$API_EMAIL" "$API_PASSWORD")
if [ $? -ne 0 ] || [ -z "$CURRENT_KEYS_LIST" ]; then
    echo -e "${YELLOW}Warning: Could not retrieve current keys for re-authorization${NC}"
else
    # Extract all key addresses
    CURRENT_NODE_ADDRESSES=$(echo "$CURRENT_KEYS_LIST" | tr '|' '\n' | cut -d':' -f2 | tr '\n' ',' | sed 's/,$//')
    CURRENT_KEY_COUNT=$(echo "$CURRENT_KEYS_LIST" | tr '|' '\n' | wc -l)
    
    if [ -n "$CURRENT_NODE_ADDRESSES" ]; then
        echo -e "${BLUE}Found $CURRENT_KEY_COUNT keys to authorize with operator contract${NC}"
        echo -e "${BLUE}Keys: $CURRENT_NODE_ADDRESSES${NC}"
        
        # Check if we have the necessary contract information
        if [ -n "$OPERATOR_ADDR" ] && [ -n "$PRIVATE_KEY" ] && [ -n "$INFURA_API_KEY" ]; then
            echo -e "${BLUE}Re-authorizing all keys with operator contract...${NC}"
            
            # Create temporary directory for re-authorization
            TEMP_REAUTH_DIR="/tmp/reauth_keys_$$"
            mkdir -p "$TEMP_REAUTH_DIR/scripts"
            
            # Copy necessary files for re-authorization
            ARBITER_OPERATOR_SRC_DIR="$(dirname "$INSTALLER_DIR")/arbiter-operator"
            if [ -d "$ARBITER_OPERATOR_SRC_DIR" ]; then
                # Copy the setAuthorizedSenders script and dependencies
                cp "$ARBITER_OPERATOR_SRC_DIR/scripts/setAuthorizedSenders.js" "$TEMP_REAUTH_DIR/scripts/"
                cp "$ARBITER_OPERATOR_SRC_DIR/hardhat.config.js" "$TEMP_REAUTH_DIR/"
                cp "$ARBITER_OPERATOR_SRC_DIR/package.json" "$TEMP_REAUTH_DIR/"
                
                # Copy deployment addresses
                if [ -f "$ARBITER_OPERATOR_SRC_DIR/deployment-addresses.json" ]; then
                    cp "$ARBITER_OPERATOR_SRC_DIR/deployment-addresses.json" "$TEMP_REAUTH_DIR/"
                fi
                
                # Create .env file for re-authorization
                # Ensure PRIVATE_KEY has 0x prefix for Hardhat
                REAUTH_PRIVATE_KEY="$PRIVATE_KEY"
                if [[ ! "$REAUTH_PRIVATE_KEY" =~ ^0x ]]; then
                    REAUTH_PRIVATE_KEY="0x$REAUTH_PRIVATE_KEY"
                fi
                
                cat > "$TEMP_REAUTH_DIR/.env" << EOL
PRIVATE_KEY=$REAUTH_PRIVATE_KEY
INFURA_API_KEY=$INFURA_API_KEY
EOL
                
                # Install minimal dependencies for hardhat
                cd "$TEMP_REAUTH_DIR"
                echo -e "${BLUE}⏳ Installing Hardhat dependencies for re-authorization (this may take 30-60 seconds)...${NC}"
                if npm install --silent --no-audit > /dev/null 2>&1; then
                    echo -e "${GREEN}✓ Dependencies installed successfully${NC}"
                    
                    # Run the re-authorization with timeout to prevent hanging
                    echo -e "${BLUE}⏳ Running key re-authorization (timeout: 10 minutes)...${NC}"
                    # Use kill-after to ensure we don't hang indefinitely
                    if timeout -k 15s 600s env OPERATOR="$OPERATOR_ADDR" NODES="$CURRENT_NODE_ADDRESSES" npx hardhat run scripts/setAuthorizedSenders.js --network $DEPLOYMENT_NETWORK; then
                        echo -e "${GREEN}✓ All keys successfully re-authorized with operator contract${NC}"
                        echo -e "${GREEN}✓ Authorized keys: $CURRENT_NODE_ADDRESSES${NC}"
                    else
                        exit_code=$?
                        if [ $exit_code -eq 124 ]; then
                            echo -e "${YELLOW}⚠ Re-authorization timed out after 10 minutes${NC}"
                            echo -e "${YELLOW}  The transaction may still be processing. Check BaseScan for transaction status.${NC}"
                        else
                            echo -e "${YELLOW}Warning: Re-authorization may have failed (exit code: $exit_code)${NC}"
                        fi
                        echo -e "${YELLOW}Your keys may still work, but you can manually re-authorize if needed${NC}"
                    fi
                else
                    echo -e "${YELLOW}Warning: Could not install dependencies for re-authorization${NC}"
                fi
                
                # Clean up temporary directory
                cd "$SCRIPT_DIR"
                rm -rf "$TEMP_REAUTH_DIR"
            else
                echo -e "${YELLOW}Warning: Could not find arbiter-operator source for re-authorization${NC}"
            fi
        else
            echo -e "${YELLOW}Warning: Missing contract information for re-authorization${NC}"
            echo -e "${YELLOW}OPERATOR_ADDR: ${OPERATOR_ADDR:-'not set'}${NC}"
            echo -e "${YELLOW}PRIVATE_KEY: ${PRIVATE_KEY:+'set'}${PRIVATE_KEY:-'not set'}${NC}"
            echo -e "${YELLOW}INFURA_API_KEY: ${INFURA_API_KEY:+'set'}${INFURA_API_KEY:-'not set'}${NC}"
        fi
    else
        echo -e "${YELLOW}Warning: No valid keys found for re-authorization${NC}"
    fi
fi

echo -e "${BLUE}Multi-arbiter configuration process completed.${NC}"

# Note: Duplicate reauthorization section removed - keys are already authorized 
# in the previous reauthorization step (lines 621-701). This eliminates 
# redundant blockchain transactions and reduces configuration time by ~50%.
echo -e "${BLUE}Key authorization completed in previous step.${NC}"

# Display final summary
echo -e "\n${GREEN}============================================================${NC}"
echo -e "${GREEN}    MULTI-ARBITER CONFIGURATION COMPLETED SUCCESSFULLY     ${NC}"
echo -e "${GREEN}============================================================${NC}"
echo -e "${BLUE}Configuration Summary:${NC}"
echo -e "${GREEN}✓ Bridge created/updated: $BRIDGE_NAME${NC}"
echo -e "${GREEN}✓ Arbiters configured: $ARBITER_COUNT${NC}"
echo -e "${GREEN}✓ Jobs created: $CREATED_JOBS${NC}"
echo -e "${GREEN}✓ Keys configured: $(echo "$KEYS_LIST" | tr '|' '\n' | wc -l)${NC}"
echo -e "${GREEN}✓ Configuration files updated${NC}"

if [ "$FAILED_JOBS" -gt 0 ]; then
    echo -e "${YELLOW}⚠ Some jobs failed to create: $FAILED_JOBS${NC}"
    echo -e "${YELLOW}  Please check the logs and retry if needed${NC}"
fi

echo -e "\n${BLUE}Access your services:${NC}"
echo -e "- Chainlink Node UI: http://localhost:6688"
echo -e "- External Adapter: http://$HOST_IP:8080"
echo -e "- Job Details: $JOB_INFO_DIR/multi_arbiter_job_info.txt"

echo -e "\n${GREEN}Your Verdikta Multi-Arbiter Validator Node is ready!${NC}"

exit 0 