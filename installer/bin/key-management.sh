#!/bin/bash

# Verdikta Validator Node - Chainlink Key Management Functions
# Handles creation and assignment of Ethereum keys for multiple arbiters

set -e  # Exit on any error

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
CHAINLINK_CONTAINER_NAME="chainlink"

# Load environment variables to get network configuration
INSTALLER_DIR="$(dirname "$(dirname "$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )")")"
if [ -f "$INSTALLER_DIR/installer/.env" ]; then
    source "$INSTALLER_DIR/installer/.env" 2>/dev/null || true
fi

# Set chain ID based on deployment network
if [ "$DEPLOYMENT_NETWORK" = "base_mainnet" ]; then
    CHAIN_ID="8453"  # Base Mainnet
else
    CHAIN_ID="84532"  # Base Sepolia (default)
fi

# Function to log verbose messages
log_verbose() {
    if [ "${VERBOSE:-false}" = "true" ]; then
        echo -e "${BLUE}[KEY-MGMT] $1${NC}" >&2
    fi
}

# Function to log info messages
log_info() {
    echo -e "${BLUE}[KEY-MGMT] $1${NC}" >&2
}

# Function to log success messages
log_success() {
    echo -e "${GREEN}[KEY-MGMT] $1${NC}" >&2
}

# Function to log warning messages
log_warning() {
    echo -e "${YELLOW}[KEY-MGMT] $1${NC}" >&2
}

# Function to log error messages
log_error() {
    echo -e "${RED}[KEY-MGMT] $1${NC}" >&2
}

# Get chainlink container ID
get_chainlink_container_id() {
    local container_id=$(docker ps -q --filter "name=$CHAINLINK_CONTAINER_NAME")
    
    if [ -z "$container_id" ]; then
        # Try to get container ID from stopped containers
        container_id=$(docker ps -aq --filter "name=$CHAINLINK_CONTAINER_NAME")
        
        if [ -z "$container_id" ]; then
            log_error "Chainlink container '$CHAINLINK_CONTAINER_NAME' not found"
            return 1
        fi
        
        log_error "Chainlink container '$CHAINLINK_CONTAINER_NAME' is not running"
        return 1
    fi
    
    log_verbose "Found chainlink container ID: $container_id"
    echo "$container_id"
    return 0
}

# Check if chainlink container is running
check_chainlink_container() {
    local container_id=$(get_chainlink_container_id)
    if [ $? -ne 0 ]; then
        return 1
    fi
    
    # Check if container is running
    if ! docker ps | grep -q "$container_id"; then
        log_error "Chainlink container is not running. Please start it first."
        return 1
    fi
    
    log_verbose "Chainlink container is running"
    return 0
}

# Login to Chainlink CLI
login_to_chainlink_cli() {
    local api_email="$1"
    local api_password="$2"
    
    if [ -z "$api_email" ] || [ -z "$api_password" ]; then
        log_error "API email and password are required for login"
        return 1
    fi
    
    # Check if container is running
    if ! check_chainlink_container; then
        return 1
    fi
    
    local container_id=$(get_chainlink_container_id)
    
    log_verbose "Logging in to Chainlink CLI"
    
    # Use expect to automate the interactive login
    if ! command -v expect >/dev/null 2>&1; then
        log_error "expect command not found. Please install expect package: sudo apt-get install expect"
        return 1
    fi
    
    # Create temporary expect script
    local expect_script=$(mktemp)
    cat > "$expect_script" << EOF
#!/usr/bin/expect -f
set timeout 10
spawn docker exec -it $container_id chainlink admin login
expect "Enter email:"
send "$api_email\r"
expect "Enter password:"
send "$api_password\r"
expect eof
catch wait result
exit [lindex \$result 3]
EOF
    
    chmod +x "$expect_script"
    
    # Run the expect script
    if "$expect_script" >/dev/null 2>&1; then
        log_verbose "Successfully logged in to Chainlink CLI"
        rm -f "$expect_script"
        return 0
    else
        log_error "Failed to login to Chainlink CLI"
        rm -f "$expect_script"
        return 1
    fi
}

# Calculate number of keys needed based on job count
# Formula: ceil(job_count / 2)
calculate_keys_needed() {
    local job_count=$1
    
    if [ -z "$job_count" ] || [ "$job_count" -lt 1 ] || [ "$job_count" -gt 10 ]; then
        log_error "Invalid job count: $job_count. Must be between 1 and 10."
        return 1
    fi
    
    # Calculate ceil(job_count / 2) using bash arithmetic
    local keys_needed=$(( (job_count + 1) / 2 ))
    
    log_verbose "Job count: $job_count, Keys needed: $keys_needed"
    echo "$keys_needed"
}

# Get the appropriate key index for a given job number
# Jobs 1-2 -> Key 1, Jobs 3-4 -> Key 2, etc.
get_key_index_for_job() {
    local job_number=$1
    
    if [ -z "$job_number" ] || [ "$job_number" -lt 1 ] || [ "$job_number" -gt 10 ]; then
        log_error "Invalid job number: $job_number. Must be between 1 and 10."
        return 1
    fi
    
    # Calculate ceil(job_number / 2)
    local key_index=$(( (job_number + 1) / 2 ))
    
    log_verbose "Job $job_number -> Key $key_index"
    echo "$key_index"
}

# List existing Ethereum keys from Chainlink node using CLI
list_existing_keys() {
    local api_email="$1"
    local api_password="$2"
    
    if [ -z "$api_email" ] || [ -z "$api_password" ]; then
        log_error "API email and password are required"
        return 1
    fi
    
    # Check if container is running
    if ! check_chainlink_container; then
        return 1
    fi
    
    local container_id=$(get_chainlink_container_id)
    
    # Login to CLI
    if ! login_to_chainlink_cli "$api_email" "$api_password"; then
        return 1
    fi
    
    log_verbose "Fetching existing Ethereum keys via CLI"
    
    # Get keys from CLI
    local keys_output=$(docker exec -i "$container_id" chainlink keys eth list 2>/dev/null)
    
    if [ $? -ne 0 ]; then
        log_error "Failed to fetch keys from Chainlink CLI"
        return 1
    fi
    
    # Parse CLI output to extract addresses for the specified chain ID
    local keys_list=""
    local key_index=0
    
    # Parse the output line by line
    while IFS= read -r line; do
        if [[ "$line" =~ ^Address:[[:space:]]+([0-9a-fA-Fx]+)$ ]]; then
            local address="${BASH_REMATCH[1]}"
            # Read the next line to get chain ID
            if IFS= read -r chain_line && [[ "$chain_line" =~ ^EVM[[:space:]]+Chain[[:space:]]+ID:[[:space:]]+([0-9]+)$ ]]; then
                local chain_id="${BASH_REMATCH[1]}"
                if [ "$chain_id" = "$CHAIN_ID" ]; then
                    key_index=$((key_index + 1))
                    if [ -z "$keys_list" ]; then
                        keys_list="${key_index}:${address}"
                    else
                        keys_list="${keys_list}|${key_index}:${address}"
                    fi
                fi
            fi
        fi
    done <<< "$keys_output"
    
    log_verbose "Found $key_index keys for chain ID $CHAIN_ID"
    echo "$keys_list"
    return 0
}

# Create a new Ethereum key using CLI
create_chainlink_key() {
    local api_email="$1"
    local api_password="$2"
    
    if [ -z "$api_email" ] || [ -z "$api_password" ]; then
        log_error "API email and password are required"
        return 1
    fi
    
    # Check if container is running
    if ! check_chainlink_container; then
        return 1
    fi
    
    local container_id=$(get_chainlink_container_id)
    
    # Login to CLI
    if ! login_to_chainlink_cli "$api_email" "$api_password"; then
        return 1
    fi
    
    log_info "Creating new Ethereum key via CLI"
    
    # Create key using CLI
    local create_output=$(docker exec -i "$container_id" chainlink keys eth create --evm-chain-id "$CHAIN_ID" 2>/dev/null)
    
    if [ $? -ne 0 ]; then
        log_error "Failed to create key via Chainlink CLI"
        return 1
    fi
    
    # Parse the output to extract the new key address
    local new_address=""
    while IFS= read -r line; do
        if [[ "$line" =~ ^Address:[[:space:]]+([0-9a-fA-Fx]+)$ ]]; then
            new_address="${BASH_REMATCH[1]}"
            break
        fi
    done <<< "$create_output"
    
    if [ -z "$new_address" ]; then
        log_error "Failed to extract new key address from CLI output"
        return 1
    fi
    
    log_success "Created new key: $new_address"
    echo "$new_address"
    return 0
}

# Ensure we have the required number of keys, creating them if necessary
ensure_keys_exist() {
    local job_count="$1"
    local api_email="$2"
    local api_password="$3"
    
    if [ -z "$job_count" ] || [ -z "$api_email" ] || [ -z "$api_password" ]; then
        log_error "Missing required parameters: job_count, api_email, api_password"
        return 1
    fi
    
    local keys_needed=$(calculate_keys_needed "$job_count")
    if [ $? -ne 0 ]; then
        return 1
    fi
    
    log_info "Ensuring $keys_needed keys exist for $job_count arbiters"
    
    # Get existing keys
    local existing_keys=$(list_existing_keys "$api_email" "$api_password")
    if [ $? -ne 0 ]; then
        log_error "Failed to list existing keys"
        return 1
    fi
    
    # Count existing keys
    local existing_count=0
    if [ -n "$existing_keys" ]; then
        existing_count=$(echo "$existing_keys" | tr '|' '\n' | wc -l)
    fi
    
    log_info "Found $existing_count existing keys, need $keys_needed total"
    
    # Create additional keys if needed
    local keys_to_create=$((keys_needed - existing_count))
    
    if [ "$keys_to_create" -gt 0 ]; then
        log_info "Creating $keys_to_create additional keys"
        
        # Store the original existing count to avoid index calculation errors
        local original_existing_count=$existing_count
        
        for ((i=1; i<=keys_to_create; i++)); do
            local new_key_index=$((original_existing_count + i))
            log_info "Creating key $new_key_index of $keys_needed"
            
            local new_key_address=$(create_chainlink_key "$api_email" "$api_password")
            if [ $? -ne 0 ]; then
                log_error "Failed to create key $new_key_index"
                return 1
            fi
            
            # Add to existing keys list
            if [ -z "$existing_keys" ]; then
                existing_keys="${new_key_index}:${new_key_address}"
            else
                existing_keys="${existing_keys}|${new_key_index}:${new_key_address}"
            fi
        done
        
        log_success "Successfully created $keys_to_create new keys"
    else
        log_info "Sufficient keys already exist"
    fi
    
    # Return all keys in format "1:address1|2:address2|..."
    echo "$existing_keys"
    return 0
}

# Get the key address for a specific job number
get_key_address_for_job() {
    local job_number="$1"
    local keys_list="$2"
    
    if [ -z "$job_number" ] || [ -z "$keys_list" ]; then
        log_error "Missing required parameters: job_number, keys_list"
        return 1
    fi
    
    local key_index=$(get_key_index_for_job "$job_number")
    if [ $? -ne 0 ]; then
        return 1
    fi
    
    # Extract the address for the specified key index
    local key_address=$(echo "$keys_list" | tr '|' '\n' | grep "^$key_index:" | cut -d':' -f2)
    
    if [ -z "$key_address" ]; then
        log_error "Could not find key $key_index for job $job_number"
        return 1
    fi
    
    log_verbose "Job $job_number uses key $key_index: $key_address"
    echo "$key_address"
    return 0
}

# Update the .contracts file with key information
update_contracts_with_keys() {
    local contracts_file="$1"
    local keys_list="$2"
    local job_count="$3"
    
    if [ -z "$contracts_file" ] || [ -z "$keys_list" ] || [ -z "$job_count" ]; then
        log_error "Missing required parameters: contracts_file, keys_list, job_count"
        return 1
    fi
    
    log_info "Updating $contracts_file with key information"
    
    # Ensure contracts file exists
    if [ ! -f "$contracts_file" ]; then
        log_error "Contracts file not found: $contracts_file"
        return 1
    fi
    
    # Remove existing key entries to avoid duplicates
    sed -i '/^KEY_[0-9]*_ADDRESS=/d' "$contracts_file"
    sed -i '/^KEY_COUNT=/d' "$contracts_file"
    
    # Add key information
    echo "$keys_list" | tr '|' '\n' | while IFS=':' read key_index key_address; do
        echo "KEY_${key_index}_ADDRESS=\"$key_address\"" >> "$contracts_file"
    done
    
    # Add key count
    local total_keys=$(calculate_keys_needed "$job_count")
    echo "KEY_COUNT=\"$total_keys\"" >> "$contracts_file"
    
    log_success "Updated contracts file with $total_keys key(s)"
    return 0
}

# Install expect if not available
install_expect() {
    if ! command -v expect >/dev/null 2>&1; then
        log_info "Installing expect package for automated CLI login"
        
        # Detect package manager and install expect
        if command -v apt-get >/dev/null 2>&1; then
            sudo apt-get update && sudo apt-get install -y expect
        elif command -v yum >/dev/null 2>&1; then
            sudo yum install -y expect
        elif command -v dnf >/dev/null 2>&1; then
            sudo dnf install -y expect
        else
            log_error "Could not detect package manager. Please install 'expect' package manually."
            return 1
        fi
        
        if command -v expect >/dev/null 2>&1; then
            log_success "Successfully installed expect package"
            return 0
        else
            log_error "Failed to install expect package"
            return 1
        fi
    else
        log_verbose "expect package is already installed"
        return 0
    fi
}

# Display usage information
usage() {
    echo "Usage: $0 <function> [arguments]"
    echo ""
    echo "Available functions:"
    echo "  calculate_keys_needed <job_count>"
    echo "  get_key_index_for_job <job_number>"
    echo "  list_existing_keys <api_email> <api_password>"
    echo "  create_chainlink_key <api_email> <api_password>"
    echo "  ensure_keys_exist <job_count> <api_email> <api_password>"
    echo "  get_key_address_for_job <job_number> <keys_list>"
    echo "  update_contracts_with_keys <contracts_file> <keys_list> <job_count>"
    echo "  install_expect"
    echo ""
    echo "Examples:"
    echo "  $0 calculate_keys_needed 8"
    echo "  $0 get_key_index_for_job 3"
    echo "  $0 ensure_keys_exist 6 admin@example.com password123"
    echo ""
    echo "Environment variables:"
    echo "  VERBOSE=true    Enable verbose logging"
}

# Main execution logic
if [ $# -eq 0 ]; then
    usage
    exit 1
fi

FUNCTION_NAME="$1"
shift

case "$FUNCTION_NAME" in
    calculate_keys_needed)
        calculate_keys_needed "$@"
        ;;
    get_key_index_for_job)
        get_key_index_for_job "$@"
        ;;
    list_existing_keys)
        list_existing_keys "$@"
        ;;
    create_chainlink_key)
        create_chainlink_key "$@"
        ;;
    ensure_keys_exist)
        ensure_keys_exist "$@"
        ;;
    get_key_address_for_job)
        get_key_address_for_job "$@"
        ;;
    update_contracts_with_keys)
        update_contracts_with_keys "$@"
        ;;
    install_expect)
        install_expect
        ;;
    usage|help|--help|-h)
        usage
        ;;
    *)
        log_error "Unknown function: $FUNCTION_NAME"
        usage
        exit 1
        ;;
esac 