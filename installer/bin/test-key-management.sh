#!/bin/bash

# Test script for CLI-based key management functions

set -e

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
KEY_MGMT_SCRIPT="$SCRIPT_DIR/key-management.sh"

echo -e "${BLUE}Testing CLI-based Key Management Functions${NC}"
echo "========================================"

# Check if key management script exists
if [ ! -f "$KEY_MGMT_SCRIPT" ]; then
    echo -e "${RED}Error: Key management script not found at $KEY_MGMT_SCRIPT${NC}"
    exit 1
fi

# Get credentials from chainlink info file
CHAINLINK_INFO_FILE="$HOME/.chainlink-sepolia/../chainlink-node/info.txt"
if [ ! -f "$CHAINLINK_INFO_FILE" ]; then
    CHAINLINK_INFO_FILE="$(dirname "$SCRIPT_DIR")/../chainlink-node/info.txt"
fi

if [ ! -f "$CHAINLINK_INFO_FILE" ]; then
    echo -e "${RED}Error: Chainlink info file not found. Please provide credentials manually.${NC}"
    read -p "Enter Chainlink email: " API_EMAIL
    read -s -p "Enter Chainlink password: " API_PASSWORD
    echo
else
    echo -e "${BLUE}Reading credentials from $CHAINLINK_INFO_FILE${NC}"
    API_EMAIL=$(grep "Login Email:" "$CHAINLINK_INFO_FILE" | cut -d' ' -f3)
    API_PASSWORD=$(grep "Login Password:" "$CHAINLINK_INFO_FILE" | cut -d' ' -f3)
    
    if [ -z "$API_EMAIL" ] || [ -z "$API_PASSWORD" ]; then
        echo -e "${RED}Error: Could not extract credentials from info file${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}Found credentials: $API_EMAIL${NC}"
fi

# Function to run test
run_test() {
    local test_name="$1"
    local command="$2"
    
    echo -e "\n${YELLOW}Test: $test_name${NC}"
    echo "Command: $command"
    echo "Result:"
    
    if eval "$command"; then
        echo -e "${GREEN}✓ $test_name passed${NC}"
        return 0
    else
        echo -e "${RED}✗ $test_name failed${NC}"
        return 1
    fi
}

# Install expect if needed
echo -e "\n${BLUE}Installing expect if needed...${NC}"
bash "$KEY_MGMT_SCRIPT" install_expect

# Test 1: Calculate keys needed
run_test "Calculate keys needed for 1 job" "bash '$KEY_MGMT_SCRIPT' calculate_keys_needed 1"
run_test "Calculate keys needed for 5 jobs" "bash '$KEY_MGMT_SCRIPT' calculate_keys_needed 5"
run_test "Calculate keys needed for 10 jobs" "bash '$KEY_MGMT_SCRIPT' calculate_keys_needed 10"

# Test 2: Get key index for job
run_test "Get key index for job 1" "bash '$KEY_MGMT_SCRIPT' get_key_index_for_job 1"
run_test "Get key index for job 3" "bash '$KEY_MGMT_SCRIPT' get_key_index_for_job 3"
run_test "Get key index for job 5" "bash '$KEY_MGMT_SCRIPT' get_key_index_for_job 5"

# Test 3: List existing keys
echo -e "\n${BLUE}Testing key listing...${NC}"
EXISTING_KEYS=$(bash "$KEY_MGMT_SCRIPT" list_existing_keys "$API_EMAIL" "$API_PASSWORD")
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ List existing keys passed${NC}"
    echo "Existing keys: $EXISTING_KEYS"
    
    # Count existing keys
    if [ -n "$EXISTING_KEYS" ]; then
        KEY_COUNT=$(echo "$EXISTING_KEYS" | tr '|' '\n' | wc -l)
        echo "Found $KEY_COUNT existing keys"
    else
        KEY_COUNT=0
        echo "No existing keys found"
    fi
else
    echo -e "${RED}✗ List existing keys failed${NC}"
    exit 1
fi

# Test 4: Create a new key (only if we have fewer than 2 keys)
if [ "$KEY_COUNT" -lt 2 ]; then
    echo -e "\n${BLUE}Testing key creation...${NC}"
    NEW_KEY_ADDRESS=$(bash "$KEY_MGMT_SCRIPT" create_chainlink_key "$API_EMAIL" "$API_PASSWORD")
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Create key passed${NC}"
        echo "New key address: $NEW_KEY_ADDRESS"
        
        # Update existing keys list
        if [ -z "$EXISTING_KEYS" ]; then
            EXISTING_KEYS="1:$NEW_KEY_ADDRESS"
        else
            EXISTING_KEYS="$EXISTING_KEYS|$((KEY_COUNT + 1)):$NEW_KEY_ADDRESS"
        fi
        KEY_COUNT=$((KEY_COUNT + 1))
    else
        echo -e "${RED}✗ Create key failed${NC}"
    fi
else
    echo -e "${YELLOW}Skipping key creation test - already have sufficient keys${NC}"
fi

# Test 5: Get key address for job
if [ -n "$EXISTING_KEYS" ]; then
    echo -e "\n${BLUE}Testing key address retrieval...${NC}"
    for job_num in 1 2; do
        if [ "$job_num" -le "$KEY_COUNT" ]; then
            KEY_ADDRESS=$(bash "$KEY_MGMT_SCRIPT" get_key_address_for_job "$job_num" "$EXISTING_KEYS")
            if [ $? -eq 0 ]; then
                echo -e "${GREEN}✓ Get key address for job $job_num passed${NC}"
                echo "Job $job_num uses key: $KEY_ADDRESS"
            else
                echo -e "${RED}✗ Get key address for job $job_num failed${NC}"
            fi
        fi
    done
fi

# Test 6: Ensure keys exist
echo -e "\n${BLUE}Testing ensure keys exist...${NC}"
for job_count in 2 4 6; do
    echo -e "\nTesting with $job_count jobs:"
    RESULT_KEYS=$(bash "$KEY_MGMT_SCRIPT" ensure_keys_exist "$job_count" "$API_EMAIL" "$API_PASSWORD")
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Ensure keys exist for $job_count jobs passed${NC}"
        echo "Result keys: $RESULT_KEYS"
    else
        echo -e "${RED}✗ Ensure keys exist for $job_count jobs failed${NC}"
    fi
done

# Test 7: Update contracts file (if we have keys)
if [ -n "$EXISTING_KEYS" ]; then
    echo -e "\n${BLUE}Testing contracts file update...${NC}"
    
    # Create temporary contracts file
    TEMP_CONTRACTS=$(mktemp)
    echo "# Test contracts file" > "$TEMP_CONTRACTS"
    echo "CONTRACT_ADDRESS=\"0x1234567890123456789012345678901234567890\"" >> "$TEMP_CONTRACTS"
    
    if bash "$KEY_MGMT_SCRIPT" update_contracts_with_keys "$TEMP_CONTRACTS" "$EXISTING_KEYS" "4"; then
        echo -e "${GREEN}✓ Update contracts file passed${NC}"
        echo "Updated contracts file:"
        cat "$TEMP_CONTRACTS"
    else
        echo -e "${RED}✗ Update contracts file failed${NC}"
    fi
    
    rm -f "$TEMP_CONTRACTS"
fi

echo -e "\n${GREEN}Key management testing completed!${NC}"
echo "========================================" 