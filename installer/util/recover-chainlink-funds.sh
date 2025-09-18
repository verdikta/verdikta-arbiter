#!/bin/bash

# Verdikta Arbiter Node - Chainlink Key Defunding Script
# Recovers ETH and LINK tokens from Chainlink keys back to the owner's wallet

set -e  # Exit on any error

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALLER_DIR="$(dirname "$SCRIPT_DIR")"
KEY_MGMT_SCRIPT="$SCRIPT_DIR/key-management.sh"

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration defaults
MIN_ETH_THRESHOLD="0.001"  # Minimum ETH to leave in each key for future operations
MIN_LINK_THRESHOLD="0.1"   # Minimum LINK to recover (to avoid dust amounts)

# Command line options
DRY_RUN=false
FORCE_DEFUND=false
INTERACTIVE=true
DEFUND_ETH=false
DEFUND_LINK=false
DEFUND_BOTH=false
CUSTOM_ETH_THRESHOLD=""
CUSTOM_LINK_THRESHOLD=""

usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Recover ETH and LINK tokens from Chainlink keys back to owner's wallet"
    echo ""
    echo "Options:"
    echo "  --eth-only              Recover only ETH (leave LINK tokens)"
    echo "  --link-only             Recover only LINK tokens (leave ETH for gas)"
    echo "  --both                  Recover both ETH and LINK tokens"
    echo "  --eth-threshold AMOUNT  Minimum ETH to leave in keys (default: $MIN_ETH_THRESHOLD)"
    echo "  --link-threshold AMOUNT Minimum LINK required to recover (default: $MIN_LINK_THRESHOLD)"
    echo "  --dry-run              Show what would be recovered without sending transactions"
    echo "  --force                Skip confirmation prompts"
    echo "  --non-interactive      Run without user prompts (for automation)"
    echo "  --help, -h             Show this help message"
    echo ""
    echo "Recovery Options:"
    echo "  ETH Recovery:"
    echo "  - Transfers excess ETH from Chainlink keys to owner wallet"
    echo "  - Leaves minimum amount for future gas fees"
    echo "  - Uses Chainlink node's private keys for authorization"
    echo ""
    echo "  LINK Recovery:"
    echo "  - Transfers accumulated LINK tokens to owner wallet"
    echo "  - Requires ERC-20 token transfer transactions"
    echo "  - Uses Chainlink node's private keys for authorization"
    echo ""
    echo "Examples:"
    echo "  $0                                    # Interactive mode - choose what to recover"
    echo "  $0 --both                            # Recover both ETH and LINK"
    echo "  $0 --eth-only --eth-threshold 0.002  # Recover ETH, leave 0.002 per key"
    echo "  $0 --link-only --dry-run             # Preview LINK recovery only"
    echo "  $0 --both --force                    # Auto-recover everything"
    echo ""
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --eth-only)
            DEFUND_ETH=true
            shift
            ;;
        --link-only)
            DEFUND_LINK=true
            shift
            ;;
        --both)
            DEFUND_BOTH=true
            shift
            ;;
        --eth-threshold)
            CUSTOM_ETH_THRESHOLD="$2"
            shift 2
            ;;
        --link-threshold)
            CUSTOM_LINK_THRESHOLD="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --force)
            FORCE_DEFUND=true
            INTERACTIVE=false
            shift
            ;;
        --non-interactive)
            INTERACTIVE=false
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Set operation mode based on flags
if [ "$DEFUND_BOTH" = "true" ]; then
    DEFUND_ETH=true
    DEFUND_LINK=true
elif [ "$DEFUND_ETH" = "false" ] && [ "$DEFUND_LINK" = "false" ]; then
    # No specific mode chosen, will prompt user in interactive mode
    INTERACTIVE_MODE_SELECTION=true
fi

# Find environment files - check multiple possible locations
ENV_FILE=""
CONTRACTS_FILE=""

# Possible locations for environment files
POSSIBLE_LOCATIONS=(
    "$INSTALLER_DIR"                    # Original installer directory
    "$(dirname "$SCRIPT_DIR")/installer"  # Target installation: ../installer/
    "$SCRIPT_DIR/../installer"          # Alternative path
    "$(pwd)/installer"                  # Current directory + installer
)

# Find .env file
for location in "${POSSIBLE_LOCATIONS[@]}"; do
    if [ -f "$location/.env" ]; then
        ENV_FILE="$location/.env"
        break
    fi
done

# Find .contracts file
for location in "${POSSIBLE_LOCATIONS[@]}"; do
    if [ -f "$location/.contracts" ]; then
        CONTRACTS_FILE="$location/.contracts"
        break
    fi
done

# Load environment variables
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
    source "$ENV_FILE"
else
    echo -e "${RED}Error: Environment file (.env) not found in any of these locations:${NC}"
    for location in "${POSSIBLE_LOCATIONS[@]}"; do
        echo -e "${RED}  - $location/.env${NC}"
    done
    echo -e "${RED}Please run the installer first.${NC}"
    exit 1
fi

# Load contract information (includes key addresses)
if [ -n "$CONTRACTS_FILE" ] && [ -f "$CONTRACTS_FILE" ]; then
    source "$CONTRACTS_FILE"
else
    echo -e "${RED}Error: Contract information file (.contracts) not found in any of these locations:${NC}"
    for location in "${POSSIBLE_LOCATIONS[@]}"; do
        echo -e "${RED}  - $location/.contracts${NC}"
    done
    echo -e "${RED}Please run the installer first.${NC}"
    exit 1
fi

# Validate required environment variables
if [ -z "$DEPLOYMENT_NETWORK" ]; then
    echo -e "${RED}Error: DEPLOYMENT_NETWORK not found in environment. Please run the installer first.${NC}"
    exit 1
fi

if [ -z "$INFURA_API_KEY" ]; then
    echo -e "${RED}Error: INFURA_API_KEY not found in environment. Please run the installer first.${NC}"
    exit 1
fi

# Set network-specific configuration
if [ "$DEPLOYMENT_NETWORK" = "base_mainnet" ]; then
    CHAIN_ID="8453"
    NETWORK_NAME="Base Mainnet"
    RPC_URL="https://base-mainnet.infura.io/v3/$INFURA_API_KEY"
    CURRENCY_NAME="Base ETH"
    NETWORK_TYPE="mainnet"
    # Base Mainnet LINK token address
    LINK_TOKEN_ADDRESS="0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196"
else
    CHAIN_ID="84532"
    NETWORK_NAME="Base Sepolia"
    RPC_URL="https://base-sepolia.infura.io/v3/$INFURA_API_KEY"
    CURRENCY_NAME="Base Sepolia ETH"
    NETWORK_TYPE="testnet"
    # Base Sepolia LINK token address
    LINK_TOKEN_ADDRESS="0xE4aB69C077896252FAFBD49EFD26B5D171A32410"
fi

# Set thresholds
if [ -n "$CUSTOM_ETH_THRESHOLD" ]; then
    ETH_THRESHOLD="$CUSTOM_ETH_THRESHOLD"
else
    ETH_THRESHOLD="$MIN_ETH_THRESHOLD"
fi

if [ -n "$CUSTOM_LINK_THRESHOLD" ]; then
    LINK_THRESHOLD="$CUSTOM_LINK_THRESHOLD"
else
    LINK_THRESHOLD="$MIN_LINK_THRESHOLD"
fi

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to prompt for Yes/No question
ask_yes_no() {
    local prompt="$1"
    local response
    
    if [ "$INTERACTIVE" = "false" ]; then
        return 0  # Auto-accept in non-interactive mode
    fi
    
    while true; do
        read -p "$prompt (y/n): " response
        case "$response" in
            [Yy]* ) return 0;;
            [Nn]* ) return 1;;
            * ) echo "Please answer yes (y) or no (n).";;
        esac
    done
}

# Function to validate Ethereum address format
is_valid_address() {
    local address="$1"
    [[ "$address" =~ ^0x[a-fA-F0-9]{40}$ ]]
}

# Function to validate amount format
is_valid_amount() {
    local amount="$1"
    [[ "$amount" =~ ^[0-9]+\.?[0-9]*$ ]] && (( $(echo "$amount > 0" | bc -l) ))
}

# Function to convert ETH to Wei
eth_to_wei() {
    local eth_amount="$1"
    # Multiply by 10^18 using bc for precision
    echo "$eth_amount * 1000000000000000000" | bc -l | cut -d'.' -f1
}

# Function to convert Wei to ETH
wei_to_eth() {
    local wei_amount="$1"
    # Divide by 10^18 using bc for precision
    echo "scale=18; $wei_amount / 1000000000000000000" | bc -l | sed 's/^\./0./' | sed 's/\.?0*$//'
}

# Function to convert LINK to smallest unit (18 decimals)
link_to_wei() {
    local link_amount="$1"
    # Multiply by 10^18 using bc for precision
    echo "$link_amount * 1000000000000000000" | bc -l | cut -d'.' -f1
}

# Function to convert smallest LINK unit to LINK
wei_to_link() {
    local wei_amount="$1"
    # Divide by 10^18 using bc for precision
    echo "scale=18; $wei_amount / 1000000000000000000" | bc -l | sed 's/^\./0./' | sed 's/\.?0*$//'
}

# Function to get wallet balance using curl and RPC
get_wallet_balance() {
    local wallet_address="$1"
    local rpc_url="$2"
    
    # Make RPC call to get balance
    local rpc_response=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getBalance\",\"params\":[\"$wallet_address\",\"latest\"],\"id\":1}" \
        "$rpc_url")
    
    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to connect to RPC"
        return 1
    fi
    
    # Extract balance from response
    local balance_hex=$(echo "$rpc_response" | python3 -c "
import json
import sys
try:
    data = json.load(sys.stdin)
    if 'result' in data:
        print(data['result'])
    elif 'error' in data:
        print('ERROR: ' + str(data['error']))
        sys.exit(1)
    else:
        print('ERROR: Unexpected response format')
        sys.exit(1)
except Exception as e:
    print('ERROR: ' + str(e))
    sys.exit(1)
" 2>/dev/null)
    
    if [[ "$balance_hex" == ERROR:* ]]; then
        echo "$balance_hex"
        return 1
    fi
    
    # Convert hex to decimal
    local balance_wei=$(python3 -c "print(int('$balance_hex', 16))" 2>/dev/null)
    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to convert balance"
        return 1
    fi
    
    echo "$balance_wei"
}

# Function to get LINK token balance
get_link_balance() {
    local wallet_address="$1"
    local rpc_url="$2"
    local token_address="$3"
    
    # ERC-20 balanceOf function signature: 0x70a08231 + address (32 bytes)
    local data="0x70a08231$(printf '%064s' "${wallet_address#0x}" | tr ' ' '0')"
    
    # Make RPC call to get token balance
    local rpc_response=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"$token_address\",\"data\":\"$data\"},\"latest\"],\"id\":1}" \
        "$rpc_url")
    
    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to connect to RPC"
        return 1
    fi
    
    # Extract balance from response
    local balance_hex=$(echo "$rpc_response" | python3 -c "
import json
import sys
try:
    data = json.load(sys.stdin)
    if 'result' in data:
        print(data['result'])
    elif 'error' in data:
        print('ERROR: ' + str(data['error']))
        sys.exit(1)
    else:
        print('ERROR: Unexpected response format')
        sys.exit(1)
except Exception as e:
    print('ERROR: ' + str(e))
    sys.exit(1)
" 2>/dev/null)
    
    if [[ "$balance_hex" == ERROR:* ]]; then
        echo "$balance_hex"
        return 1
    fi
    
    # Convert hex to decimal
    local balance_wei=$(python3 -c "print(int('$balance_hex', 16))" 2>/dev/null)
    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to convert balance"
        return 1
    fi
    
    echo "$balance_wei"
}

# Function to get owner wallet address from private key
get_wallet_address_from_private_key() {
    local private_key="$1"
    
    # Add 0x prefix if not present
    if [[ ! "$private_key" =~ ^0x ]]; then
        private_key="0x$private_key"
    fi
    
    # Use Python to derive address from private key
    local address=$(python3 -c "
try:
    from eth_account import Account
    import sys
    
    private_key = '$private_key'
    account = Account.from_key(private_key)
    print(account.address)
except ImportError:
    print('ERROR: eth_account not installed. Please install: pip3 install eth-account')
    sys.exit(1)
except Exception as e:
    print('ERROR: ' + str(e))
    sys.exit(1)
" 2>/dev/null)
    
    if [[ "$address" == ERROR:* ]]; then
        echo "$address"
        return 1
    fi
    
    echo "$address"
}

# Function to get private key for a Chainlink key using CLI
get_chainlink_private_key() {
    local key_address="$1"
    local api_email="$2"
    local api_password="$3"
    
    # Check if container is running
    local container_id=$(docker ps -q --filter "name=chainlink")
    if [ -z "$container_id" ]; then
        echo "ERROR: Chainlink container not running"
        return 1
    fi
    
    # Login to CLI first
    if ! bash "$KEY_MGMT_SCRIPT" login_to_chainlink_cli "$api_email" "$api_password" >/dev/null 2>&1; then
        echo "ERROR: Failed to login to Chainlink CLI"
        return 1
    fi
    
    # Export the key
    local export_output=$(docker exec -i "$container_id" chainlink keys eth export "$key_address" 2>/dev/null)
    
    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to export key $key_address"
        return 1
    fi
    
    # Parse the exported key JSON to get private key
    local private_key=$(echo "$export_output" | python3 -c "
import json
import sys
try:
    # Read password prompt and key data
    lines = sys.stdin.read().strip().split('\n')
    json_line = None
    for line in lines:
        if line.strip().startswith('{'):
            json_line = line.strip()
            break
    
    if not json_line:
        print('ERROR: No JSON found in export output')
        sys.exit(1)
    
    data = json.loads(json_line)
    if 'privateKey' in data:
        print(data['privateKey'])
    else:
        print('ERROR: No privateKey field found')
        sys.exit(1)
except Exception as e:
    print('ERROR: ' + str(e))
    sys.exit(1)
" 2>/dev/null)
    
    if [[ "$private_key" == ERROR:* ]]; then
        echo "$private_key"
        return 1
    fi
    
    echo "$private_key"
}

# Function to get current gas price
get_gas_price() {
    local rpc_url="$1"
    
    # Make RPC call to get gas price
    local rpc_response=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_gasPrice\",\"params\":[],\"id\":1}" \
        "$rpc_url")
    
    if [ $? -ne 0 ]; then
        # Default gas prices based on network
        if [ "$NETWORK_TYPE" = "mainnet" ]; then
            echo "1000000000"  # 1 gwei
        else
            echo "2000000000"  # 2 gwei
        fi
        return 0
    fi
    
    # Extract gas price from response
    local gas_price_hex=$(echo "$rpc_response" | python3 -c "
import json
import sys
try:
    data = json.load(sys.stdin)
    if 'result' in data:
        print(data['result'])
    else:
        print('0x3b9aca00')  # Default 1 gwei in hex
except:
    print('0x3b9aca00')  # Default 1 gwei in hex
" 2>/dev/null)
    
    # Convert hex to decimal
    local gas_price=$(python3 -c "print(int('$gas_price_hex', 16))" 2>/dev/null)
    if [ $? -ne 0 ]; then
        if [ "$NETWORK_TYPE" = "mainnet" ]; then
            gas_price="1000000000"  # 1 gwei
        else
            gas_price="2000000000"  # 2 gwei
        fi
    fi
    
    echo "$gas_price"
}

# Function to get next nonce for wallet
get_nonce() {
    local wallet_address="$1"
    local rpc_url="$2"
    
    # Make RPC call to get transaction count (nonce)
    local rpc_response=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getTransactionCount\",\"params\":[\"$wallet_address\",\"pending\"],\"id\":1}" \
        "$rpc_url")
    
    if [ $? -ne 0 ]; then
        echo "0"
        return 1
    fi
    
    # Extract nonce from response
    local nonce_hex=$(echo "$rpc_response" | python3 -c "
import json
import sys
try:
    data = json.load(sys.stdin)
    if 'result' in data:
        print(data['result'])
    else:
        print('0x0')
except:
    print('0x0')
" 2>/dev/null)
    
    # Convert hex to decimal
    local nonce=$(python3 -c "print(int('$nonce_hex', 16))" 2>/dev/null)
    if [ $? -ne 0 ]; then
        nonce="0"
    fi
    
    echo "$nonce"
}

# Function to send ETH transaction
send_eth_transaction() {
    local from_private_key="$1"
    local to_address="$2"
    local value_wei="$3"
    local gas_limit="$4"
    local gas_price="$5"
    local nonce="$6"
    local rpc_url="$7"
    
    if [ "$DRY_RUN" = "true" ]; then
        echo "DRY_RUN: Would send ETH transaction"
        return 0
    fi
    
    # Add 0x prefix to private key if not present
    if [[ ! "$from_private_key" =~ ^0x ]]; then
        from_private_key="0x$from_private_key"
    fi
    
    # Use Python to create and send transaction
    local tx_hash=$(python3 -c "
try:
    from eth_account import Account
    from web3 import Web3
    import sys
    
    # Setup
    private_key = '$from_private_key'
    to_address = '$to_address'
    value_wei = $value_wei
    gas_limit = $gas_limit
    gas_price = $gas_price
    nonce = $nonce
    chain_id = $CHAIN_ID
    rpc_url = '$rpc_url'
    
    # Create account and web3 instance
    account = Account.from_key(private_key)
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    
    # Build transaction
    transaction = {
        'nonce': nonce,
        'to': to_address,
        'value': value_wei,
        'gas': gas_limit,
        'gasPrice': gas_price,
        'chainId': chain_id
    }
    
    # Sign transaction
    signed_txn = account.sign_transaction(transaction)
    
    # Send transaction
    tx_hash = w3.eth.send_raw_transaction(signed_txn.rawTransaction)
    print(tx_hash.hex())
    
except ImportError as e:
    print('ERROR: Missing required packages. Please install: pip3 install eth-account web3')
    sys.exit(1)
except Exception as e:
    print('ERROR: ' + str(e))
    sys.exit(1)
" 2>/dev/null)
    
    if [[ "$tx_hash" == ERROR:* ]]; then
        echo "$tx_hash"
        return 1
    fi
    
    echo "$tx_hash"
}

# Function to send LINK token transfer transaction
send_link_transaction() {
    local from_private_key="$1"
    local to_address="$2"
    local amount_wei="$3"
    local gas_limit="$4"
    local gas_price="$5"
    local nonce="$6"
    local rpc_url="$7"
    local token_address="$8"
    
    if [ "$DRY_RUN" = "true" ]; then
        echo "DRY_RUN: Would send LINK transaction"
        return 0
    fi
    
    # Add 0x prefix to private key if not present
    if [[ ! "$from_private_key" =~ ^0x ]]; then
        from_private_key="0x$from_private_key"
    fi
    
    # Use Python to create and send ERC-20 transfer transaction
    local tx_hash=$(python3 -c "
try:
    from eth_account import Account
    from web3 import Web3
    import sys
    
    # Setup
    private_key = '$from_private_key'
    to_address = '$to_address'
    amount_wei = $amount_wei
    gas_limit = $gas_limit
    gas_price = $gas_price
    nonce = $nonce
    chain_id = $CHAIN_ID
    rpc_url = '$rpc_url'
    token_address = '$token_address'
    
    # Create account and web3 instance
    account = Account.from_key(private_key)
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    
    # ERC-20 transfer function signature: transfer(address,uint256)
    # Function selector: 0xa9059cbb
    # Parameters: to_address (32 bytes) + amount (32 bytes)
    data = '0xa9059cbb' + to_address[2:].zfill(64) + hex(amount_wei)[2:].zfill(64)
    
    # Build transaction
    transaction = {
        'nonce': nonce,
        'to': token_address,
        'value': 0,
        'gas': gas_limit,
        'gasPrice': gas_price,
        'data': data,
        'chainId': chain_id
    }
    
    # Sign transaction
    signed_txn = account.sign_transaction(transaction)
    
    # Send transaction
    tx_hash = w3.eth.send_raw_transaction(signed_txn.rawTransaction)
    print(tx_hash.hex())
    
except ImportError as e:
    print('ERROR: Missing required packages. Please install: pip3 install eth-account web3')
    sys.exit(1)
except Exception as e:
    print('ERROR: ' + str(e))
    sys.exit(1)
" 2>/dev/null)
    
    if [[ "$tx_hash" == ERROR:* ]]; then
        echo "$tx_hash"
        return 1
    fi
    
    echo "$tx_hash"
}

# Function to wait for transaction confirmation
wait_for_transaction() {
    local tx_hash="$1"
    local rpc_url="$2"
    local max_wait_time=300  # 5 minutes
    local wait_interval=10   # 10 seconds
    local elapsed_time=0
    
    echo -e "${BLUE}Waiting for transaction confirmation: $tx_hash${NC}"
    
    while [ $elapsed_time -lt $max_wait_time ]; do
        # Check transaction receipt
        local rpc_response=$(curl -s -X POST \
            -H "Content-Type: application/json" \
            -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$tx_hash\"],\"id\":1}" \
            "$rpc_url")
        
        if [ $? -eq 0 ]; then
            local receipt=$(echo "$rpc_response" | python3 -c "
import json
import sys
try:
    data = json.load(sys.stdin)
    if 'result' in data and data['result'] is not None:
        receipt = data['result']
        status = receipt.get('status', '0x0')
        block_number = receipt.get('blockNumber', 'unknown')
        print(f'CONFIRMED:{status}:{block_number}')
    else:
        print('PENDING')
except:
    print('PENDING')
" 2>/dev/null)
            
            if [[ "$receipt" == CONFIRMED:* ]]; then
                local status=$(echo "$receipt" | cut -d':' -f2)
                local block_number=$(echo "$receipt" | cut -d':' -f3)
                
                if [ "$status" = "0x1" ]; then
                    echo -e "${GREEN}✓ Transaction confirmed in block $block_number${NC}"
                    return 0
                else
                    echo -e "${RED}✗ Transaction failed (status: $status)${NC}"
                    return 1
                fi
            fi
        fi
        
        echo -e "${BLUE}  Still waiting... (${elapsed_time}s elapsed)${NC}"
        sleep $wait_interval
        elapsed_time=$((elapsed_time + wait_interval))
    done
    
    echo -e "${YELLOW}⚠ Transaction confirmation timeout after ${max_wait_time}s${NC}"
    echo -e "${YELLOW}  Transaction may still be processing. Check: https://basescan.org/tx/$tx_hash${NC}"
    return 1
}

# Function to collect all Chainlink key addresses
collect_chainlink_keys() {
    local keys_list=""
    local key_count=0
    
    # Look for KEY_*_ADDRESS variables in the contracts file
    while IFS='=' read -r var_name var_value; do
        if [[ "$var_name" =~ ^KEY_[0-9]+_ADDRESS$ ]]; then
            # Remove quotes from value
            var_value=$(echo "$var_value" | sed 's/^"//;s/"$//')
            
            if is_valid_address "$var_value"; then
                if [ -z "$keys_list" ]; then
                    keys_list="$var_value"
                else
                    keys_list="$keys_list|$var_value"
                fi
                key_count=$((key_count + 1))
            fi
        fi
    done < "$CONTRACTS_FILE"
    
    if [ $key_count -eq 0 ]; then
        echo "ERROR: No Chainlink keys found in contracts file"
        return 1
    fi
    
    echo "$keys_list"
}

# Check if required Python packages are installed
check_python_dependencies() {
    echo -e "${BLUE}Checking Python dependencies...${NC}"
    
    if ! python3 -c "import eth_account, web3" 2>/dev/null; then
        echo -e "${YELLOW}Installing required Python packages...${NC}"
        
        # Try to install using pip3
        if command_exists pip3; then
            pip3 install eth-account web3 >/dev/null 2>&1
        elif command_exists pip; then
            pip install eth-account web3 >/dev/null 2>&1
        else
            echo -e "${RED}Error: pip/pip3 not found. Please install manually:${NC}"
            echo -e "${RED}  pip3 install eth-account web3${NC}"
            exit 1
        fi
        
        # Verify installation
        if ! python3 -c "import eth_account, web3" 2>/dev/null; then
            echo -e "${RED}Error: Failed to install required packages. Please install manually:${NC}"
            echo -e "${RED}  pip3 install eth-account web3${NC}"
            exit 1
        fi
        
        echo -e "${GREEN}✓ Python dependencies installed${NC}"
    else
        echo -e "${GREEN}✓ Python dependencies already available${NC}"
    fi
}

# Check if bc calculator is available
check_bc_dependency() {
    if ! command_exists bc; then
        echo -e "${YELLOW}Installing bc calculator...${NC}"
        
        # Detect package manager and install bc
        if command_exists apt-get; then
            sudo apt-get update >/dev/null 2>&1 && sudo apt-get install -y bc >/dev/null 2>&1
        elif command_exists yum; then
            sudo yum install -y bc >/dev/null 2>&1
        elif command_exists dnf; then
            sudo dnf install -y bc >/dev/null 2>&1
        elif command_exists brew; then
            brew install bc >/dev/null 2>&1
        else
            echo -e "${RED}Error: Could not install bc. Please install manually.${NC}"
            exit 1
        fi
        
        if command_exists bc; then
            echo -e "${GREEN}✓ bc calculator installed${NC}"
        else
            echo -e "${RED}Error: Failed to install bc calculator${NC}"
            exit 1
        fi
    fi
}

# Load Chainlink node API credentials for key export
load_chainlink_credentials() {
    local chainlink_dir="$HOME/.chainlink-${NETWORK_TYPE}"
    if [ -f "$chainlink_dir/.api" ]; then
        local api_credentials=( $(cat "$chainlink_dir/.api") )
        API_EMAIL="${api_credentials[0]}"
        API_PASSWORD="${api_credentials[1]}"
    else
        echo -e "${RED}Error: Chainlink node API credentials not found at $chainlink_dir/.api${NC}"
        echo -e "${RED}Please ensure Chainlink node is properly configured${NC}"
        exit 1
    fi
}

# Main execution starts here
echo -e "${BLUE}"
echo "============================================================"
echo "  Verdikta Arbiter - Chainlink Key Defunding"
echo "============================================================"
echo -e "${NC}"

if [ "$DRY_RUN" = "true" ]; then
    echo -e "${YELLOW}DRY RUN MODE: No transactions will be sent${NC}"
    echo ""
fi

echo -e "${BLUE}Network: $NETWORK_NAME (Chain ID: $CHAIN_ID)${NC}"
echo -e "${BLUE}Currency: $CURRENCY_NAME${NC}"
echo -e "${BLUE}LINK Token: $LINK_TOKEN_ADDRESS${NC}"
echo ""

# Check dependencies
check_python_dependencies
check_bc_dependency

# Load Chainlink credentials
load_chainlink_credentials

# Interactive mode selection if no specific mode chosen
if [ "$INTERACTIVE_MODE_SELECTION" = "true" ] && [ "$INTERACTIVE" = "true" ]; then
    echo -e "${BLUE}What would you like to recover from your Chainlink keys?${NC}"
    echo -e "${BLUE}  1) Recover ETH only (leave LINK tokens)${NC}"
    echo -e "${BLUE}  2) Recover LINK tokens only (leave ETH for gas fees)${NC}"
    echo -e "${BLUE}  3) Recover both ETH and LINK tokens${NC}"
    echo -e "${BLUE}  4) Cancel operation${NC}"
    echo ""
    
    while true; do
        read -p "Choose option (1-4): " recovery_choice
        
        case "$recovery_choice" in
            1)
                DEFUND_ETH=true
                echo -e "${GREEN}Selected: Recover ETH only${NC}"
                break
                ;;
            2)
                DEFUND_LINK=true
                echo -e "${GREEN}Selected: Recover LINK tokens only${NC}"
                break
                ;;
            3)
                DEFUND_ETH=true
                DEFUND_LINK=true
                echo -e "${GREEN}Selected: Recover both ETH and LINK tokens${NC}"
                break
                ;;
            4)
                echo -e "${BLUE}Operation cancelled by user.${NC}"
                exit 0
                ;;
            *)
                echo -e "${RED}Invalid choice. Please enter 1, 2, 3, or 4.${NC}"
                ;;
        esac
    done
    echo ""
fi

# Validate that at least one recovery type is selected
if [ "$DEFUND_ETH" = "false" ] && [ "$DEFUND_LINK" = "false" ]; then
    echo -e "${RED}Error: No recovery operation selected. Use --eth-only, --link-only, or --both${NC}"
    exit 1
fi

# Collect Chainlink keys
echo -e "${BLUE}Collecting Chainlink key addresses...${NC}"
CHAINLINK_KEYS=$(collect_chainlink_keys)
if [ $? -ne 0 ]; then
    echo -e "${RED}$CHAINLINK_KEYS${NC}"
    exit 1
fi

KEY_ADDRESSES=($(echo "$CHAINLINK_KEYS" | tr '|' ' '))
KEY_COUNT=${#KEY_ADDRESSES[@]}

echo -e "${GREEN}Found $KEY_COUNT Chainlink keys to process:${NC}"
for i in "${!KEY_ADDRESSES[@]}"; do
    echo -e "${GREEN}  Key $((i+1)): ${KEY_ADDRESSES[$i]}${NC}"
done
echo ""

# Get owner wallet address (where funds will be sent)
if [ -n "$PRIVATE_KEY" ]; then
    echo -e "${BLUE}Getting owner wallet address...${NC}"
    OWNER_WALLET=$(get_wallet_address_from_private_key "$PRIVATE_KEY")
    if [[ "$OWNER_WALLET" == ERROR:* ]]; then
        echo -e "${RED}Error getting owner wallet address: $OWNER_WALLET${NC}"
        exit 1
    fi
    echo -e "${GREEN}Owner wallet: $OWNER_WALLET${NC}"
else
    echo -e "${RED}Error: No private key found for owner wallet${NC}"
    exit 1
fi

# Check balances and calculate recoverable amounts
echo -e "${BLUE}Checking key balances...${NC}"

TOTAL_ETH_RECOVERABLE="0"
TOTAL_LINK_RECOVERABLE="0"
TOTAL_GAS_COST="0"

# Get current gas price
GAS_PRICE=$(get_gas_price "$RPC_URL")
GAS_PRICE_GWEI=$(echo "scale=2; $GAS_PRICE / 1000000000" | bc -l)
echo -e "${GREEN}Current gas price: $GAS_PRICE_GWEI gwei${NC}"

declare -A KEY_ETH_BALANCES
declare -A KEY_LINK_BALANCES
declare -A KEY_ETH_RECOVERABLE
declare -A KEY_LINK_RECOVERABLE

for i in "${!KEY_ADDRESSES[@]}"; do
    KEY_ADDRESS="${KEY_ADDRESSES[$i]}"
    KEY_NUMBER=$((i+1))
    
    echo -e "\n${BLUE}Checking Key $KEY_NUMBER: $KEY_ADDRESS${NC}"
    
    # Get ETH balance
    if [ "$DEFUND_ETH" = "true" ]; then
        ETH_BALANCE_WEI=$(get_wallet_balance "$KEY_ADDRESS" "$RPC_URL")
        if [[ "$ETH_BALANCE_WEI" != ERROR:* ]]; then
            ETH_BALANCE_ETH=$(wei_to_eth "$ETH_BALANCE_WEI")
            KEY_ETH_BALANCES[$KEY_ADDRESS]="$ETH_BALANCE_ETH"
            
            # Calculate recoverable amount (leave threshold for gas)
            ETH_THRESHOLD_WEI=$(eth_to_wei "$ETH_THRESHOLD")
            if (( $(echo "$ETH_BALANCE_WEI > $ETH_THRESHOLD_WEI" | bc -l) )); then
                RECOVERABLE_WEI=$(echo "$ETH_BALANCE_WEI - $ETH_THRESHOLD_WEI" | bc -l)
                RECOVERABLE_ETH=$(wei_to_eth "$RECOVERABLE_WEI")
                KEY_ETH_RECOVERABLE[$KEY_ADDRESS]="$RECOVERABLE_ETH"
                TOTAL_ETH_RECOVERABLE=$(echo "$TOTAL_ETH_RECOVERABLE + $RECOVERABLE_ETH" | bc -l)
                echo -e "${GREEN}  ETH: $ETH_BALANCE_ETH (recoverable: $RECOVERABLE_ETH)${NC}"
            else
                KEY_ETH_RECOVERABLE[$KEY_ADDRESS]="0"
                echo -e "${YELLOW}  ETH: $ETH_BALANCE_ETH (below threshold, keeping all)${NC}"
            fi
        else
            echo -e "${RED}  ETH: Failed to get balance${NC}"
            KEY_ETH_BALANCES[$KEY_ADDRESS]="0"
            KEY_ETH_RECOVERABLE[$KEY_ADDRESS]="0"
        fi
    fi
    
    # Get LINK balance
    if [ "$DEFUND_LINK" = "true" ]; then
        LINK_BALANCE_WEI=$(get_link_balance "$KEY_ADDRESS" "$RPC_URL" "$LINK_TOKEN_ADDRESS")
        if [[ "$LINK_BALANCE_WEI" != ERROR:* ]]; then
            LINK_BALANCE_LINK=$(wei_to_link "$LINK_BALANCE_WEI")
            KEY_LINK_BALANCES[$KEY_ADDRESS]="$LINK_BALANCE_LINK"
            
            # Check if above minimum threshold
            if (( $(echo "$LINK_BALANCE_LINK >= $LINK_THRESHOLD" | bc -l) )); then
                KEY_LINK_RECOVERABLE[$KEY_ADDRESS]="$LINK_BALANCE_LINK"
                TOTAL_LINK_RECOVERABLE=$(echo "$TOTAL_LINK_RECOVERABLE + $LINK_BALANCE_LINK" | bc -l)
                echo -e "${GREEN}  LINK: $LINK_BALANCE_LINK (will recover all)${NC}"
            else
                KEY_LINK_RECOVERABLE[$KEY_ADDRESS]="0"
                echo -e "${YELLOW}  LINK: $LINK_BALANCE_LINK (below threshold, keeping)${NC}"
            fi
        else
            echo -e "${RED}  LINK: Failed to get balance${NC}"
            KEY_LINK_BALANCES[$KEY_ADDRESS]="0"
            KEY_LINK_RECOVERABLE[$KEY_ADDRESS]="0"
        fi
    fi
done

# Calculate total gas costs
TRANSACTIONS_NEEDED=0
for KEY_ADDRESS in "${KEY_ADDRESSES[@]}"; do
    if [ "$DEFUND_ETH" = "true" ] && (( $(echo "${KEY_ETH_RECOVERABLE[$KEY_ADDRESS]:-0} > 0" | bc -l) )); then
        TRANSACTIONS_NEEDED=$((TRANSACTIONS_NEEDED + 1))
    fi
    if [ "$DEFUND_LINK" = "true" ] && (( $(echo "${KEY_LINK_RECOVERABLE[$KEY_ADDRESS]:-0} > 0" | bc -l) )); then
        TRANSACTIONS_NEEDED=$((TRANSACTIONS_NEEDED + 1))
    fi
done

ETH_GAS_COST_PER_TX=$(echo "21000 * $GAS_PRICE" | bc -l)
LINK_GAS_COST_PER_TX=$(echo "65000 * $GAS_PRICE" | bc -l)  # ERC-20 transfers use more gas

# Estimate total gas cost
ESTIMATED_GAS_COST_WEI="0"
for KEY_ADDRESS in "${KEY_ADDRESSES[@]}"; do
    if [ "$DEFUND_ETH" = "true" ] && (( $(echo "${KEY_ETH_RECOVERABLE[$KEY_ADDRESS]:-0} > 0" | bc -l) )); then
        ESTIMATED_GAS_COST_WEI=$(echo "$ESTIMATED_GAS_COST_WEI + $ETH_GAS_COST_PER_TX" | bc -l)
    fi
    if [ "$DEFUND_LINK" = "true" ] && (( $(echo "${KEY_LINK_RECOVERABLE[$KEY_ADDRESS]:-0} > 0" | bc -l) )); then
        ESTIMATED_GAS_COST_WEI=$(echo "$ESTIMATED_GAS_COST_WEI + $LINK_GAS_COST_PER_TX" | bc -l)
    fi
done

ESTIMATED_GAS_COST_ETH=$(wei_to_eth "$ESTIMATED_GAS_COST_WEI")

# Summary
echo ""
echo -e "${BLUE}Recovery Summary:${NC}"
if [ "$DEFUND_ETH" = "true" ]; then
    echo -e "${BLUE}  Total ETH recoverable: $TOTAL_ETH_RECOVERABLE $CURRENCY_NAME${NC}"
    echo -e "${BLUE}  ETH threshold (left per key): $ETH_THRESHOLD $CURRENCY_NAME${NC}"
fi
if [ "$DEFUND_LINK" = "true" ]; then
    echo -e "${BLUE}  Total LINK recoverable: $TOTAL_LINK_RECOVERABLE LINK${NC}"
    echo -e "${BLUE}  LINK threshold (minimum to recover): $LINK_THRESHOLD LINK${NC}"
fi
echo -e "${BLUE}  Transactions needed: $TRANSACTIONS_NEEDED${NC}"
echo -e "${BLUE}  Estimated gas cost: $ESTIMATED_GAS_COST_ETH $CURRENCY_NAME${NC}"
echo ""

# Check if there's anything to recover
if (( $(echo "$TOTAL_ETH_RECOVERABLE == 0" | bc -l) )) && (( $(echo "$TOTAL_LINK_RECOVERABLE == 0" | bc -l) )); then
    echo -e "${YELLOW}No funds available for recovery.${NC}"
    echo -e "${YELLOW}All keys are either below thresholds or already empty.${NC}"
    exit 0
fi

# Final confirmation
if [ "$FORCE_DEFUND" = "false" ] && [ "$INTERACTIVE" = "true" ]; then
    echo -e "${YELLOW}⚠ This will recover funds from Chainlink keys back to your owner wallet.${NC}"
    echo -e "${YELLOW}⚠ Gas fees will be paid by each key (deducted from recoverable amounts).${NC}"
    echo ""
    
    if ! ask_yes_no "Do you want to proceed with recovery?"; then
        echo -e "${BLUE}Recovery cancelled by user.${NC}"
        exit 0
    fi
    echo ""
fi

# Start recovery process
echo -e "${BLUE}Starting recovery process...${NC}"
SUCCESSFUL_ETH_RECOVERY=0
SUCCESSFUL_LINK_RECOVERY=0
FAILED_RECOVERY=0

for i in "${!KEY_ADDRESSES[@]}"; do
    KEY_ADDRESS="${KEY_ADDRESSES[$i]}"
    KEY_NUMBER=$((i+1))
    
    echo -e "\n${BLUE}Processing Key $KEY_NUMBER/$KEY_COUNT: $KEY_ADDRESS${NC}"
    
    # Export private key for this Chainlink key
    echo -e "${BLUE}  Exporting private key...${NC}"
    CHAINLINK_PRIVATE_KEY=$(get_chainlink_private_key "$KEY_ADDRESS" "$API_EMAIL" "$API_PASSWORD")
    if [[ "$CHAINLINK_PRIVATE_KEY" == ERROR:* ]]; then
        echo -e "${RED}  ✗ Failed to export private key: $CHAINLINK_PRIVATE_KEY${NC}"
        FAILED_RECOVERY=$((FAILED_RECOVERY + 1))
        continue
    fi
    
    # Get current nonce for this key
    CURRENT_NONCE=$(get_nonce "$KEY_ADDRESS" "$RPC_URL")
    
    # Recover ETH if requested and available
    if [ "$DEFUND_ETH" = "true" ] && (( $(echo "${KEY_ETH_RECOVERABLE[$KEY_ADDRESS]:-0} > 0" | bc -l) )); then
        ETH_AMOUNT="${KEY_ETH_RECOVERABLE[$KEY_ADDRESS]}"
        ETH_AMOUNT_WEI=$(eth_to_wei "$ETH_AMOUNT")
        
        # Calculate actual amount after gas (deduct gas from transfer amount)
        GAS_COST_WEI="$ETH_GAS_COST_PER_TX"
        ACTUAL_ETH_AMOUNT_WEI=$(echo "$ETH_AMOUNT_WEI - $GAS_COST_WEI" | bc -l | cut -d'.' -f1)
        ACTUAL_ETH_AMOUNT=$(wei_to_eth "$ACTUAL_ETH_AMOUNT_WEI")
        
        if (( $(echo "$ACTUAL_ETH_AMOUNT_WEI > 0" | bc -l) )); then
            echo -e "${BLUE}  Recovering $ACTUAL_ETH_AMOUNT $CURRENCY_NAME...${NC}"
            
            if [ "$DRY_RUN" = "false" ]; then
                TX_HASH=$(send_eth_transaction "$CHAINLINK_PRIVATE_KEY" "$OWNER_WALLET" "$ACTUAL_ETH_AMOUNT_WEI" "21000" "$GAS_PRICE" "$CURRENT_NONCE" "$RPC_URL")
                
                if [[ "$TX_HASH" == ERROR:* ]]; then
                    echo -e "${RED}  ✗ Failed to send ETH transaction: $TX_HASH${NC}"
                    FAILED_RECOVERY=$((FAILED_RECOVERY + 1))
                else
                    echo -e "${GREEN}  ✓ ETH transaction sent: $TX_HASH${NC}"
                    
                    if wait_for_transaction "$TX_HASH" "$RPC_URL"; then
                        SUCCESSFUL_ETH_RECOVERY=$((SUCCESSFUL_ETH_RECOVERY + 1))
                        echo -e "${GREEN}  ✓ ETH recovery confirmed${NC}"
                    else
                        FAILED_RECOVERY=$((FAILED_RECOVERY + 1))
                        echo -e "${RED}  ✗ ETH transaction may have failed${NC}"
                    fi
                    
                    CURRENT_NONCE=$((CURRENT_NONCE + 1))
                fi
            else
                echo -e "${BLUE}  DRY RUN: Would send $ACTUAL_ETH_AMOUNT $CURRENCY_NAME${NC}"
                SUCCESSFUL_ETH_RECOVERY=$((SUCCESSFUL_ETH_RECOVERY + 1))
            fi
        else
            echo -e "${YELLOW}  ⚠ ETH amount too small after gas deduction, skipping${NC}"
        fi
    fi
    
    # Recover LINK if requested and available
    if [ "$DEFUND_LINK" = "true" ] && (( $(echo "${KEY_LINK_RECOVERABLE[$KEY_ADDRESS]:-0} > 0" | bc -l) )); then
        LINK_AMOUNT="${KEY_LINK_RECOVERABLE[$KEY_ADDRESS]}"
        LINK_AMOUNT_WEI=$(link_to_wei "$LINK_AMOUNT")
        
        echo -e "${BLUE}  Recovering $LINK_AMOUNT LINK tokens...${NC}"
        
        if [ "$DRY_RUN" = "false" ]; then
            TX_HASH=$(send_link_transaction "$CHAINLINK_PRIVATE_KEY" "$OWNER_WALLET" "$LINK_AMOUNT_WEI" "65000" "$GAS_PRICE" "$CURRENT_NONCE" "$RPC_URL" "$LINK_TOKEN_ADDRESS")
            
            if [[ "$TX_HASH" == ERROR:* ]]; then
                echo -e "${RED}  ✗ Failed to send LINK transaction: $TX_HASH${NC}"
                FAILED_RECOVERY=$((FAILED_RECOVERY + 1))
            else
                echo -e "${GREEN}  ✓ LINK transaction sent: $TX_HASH${NC}"
                
                if wait_for_transaction "$TX_HASH" "$RPC_URL"; then
                    SUCCESSFUL_LINK_RECOVERY=$((SUCCESSFUL_LINK_RECOVERY + 1))
                    echo -e "${GREEN}  ✓ LINK recovery confirmed${NC}"
                else
                    FAILED_RECOVERY=$((FAILED_RECOVERY + 1))
                    echo -e "${RED}  ✗ LINK transaction may have failed${NC}"
                fi
                
                CURRENT_NONCE=$((CURRENT_NONCE + 1))
            fi
        else
            echo -e "${BLUE}  DRY RUN: Would send $LINK_AMOUNT LINK${NC}"
            SUCCESSFUL_LINK_RECOVERY=$((SUCCESSFUL_LINK_RECOVERY + 1))
        fi
    fi
    
    # Brief delay between keys
    if [ $KEY_NUMBER -lt $KEY_COUNT ] && [ "$DRY_RUN" = "false" ]; then
        echo -e "${BLUE}  Waiting 5 seconds before next key...${NC}"
        sleep 5
    fi
done

# Final summary
echo ""
echo -e "${BLUE}============================================================${NC}"
echo -e "${BLUE}  Recovery Complete${NC}"
echo -e "${BLUE}============================================================${NC}"

if [ "$DRY_RUN" = "true" ]; then
    echo -e "${YELLOW}DRY RUN SUMMARY:${NC}"
    if [ "$DEFUND_ETH" = "true" ]; then
        echo -e "${GREEN}✓ Would have recovered ETH from: $SUCCESSFUL_ETH_RECOVERY keys${NC}"
        echo -e "${GREEN}✓ Total ETH would be recovered: $TOTAL_ETH_RECOVERABLE $CURRENCY_NAME${NC}"
    fi
    if [ "$DEFUND_LINK" = "true" ]; then
        echo -e "${GREEN}✓ Would have recovered LINK from: $SUCCESSFUL_LINK_RECOVERY keys${NC}"
        echo -e "${GREEN}✓ Total LINK would be recovered: $TOTAL_LINK_RECOVERABLE LINK${NC}"
    fi
    echo -e "${BLUE}Run without --dry-run to execute actual recovery${NC}"
else
    if [ "$DEFUND_ETH" = "true" ]; then
        echo -e "${GREEN}✓ Successfully recovered ETH from: $SUCCESSFUL_ETH_RECOVERY keys${NC}"
    fi
    if [ "$DEFUND_LINK" = "true" ]; then
        echo -e "${GREEN}✓ Successfully recovered LINK from: $SUCCESSFUL_LINK_RECOVERY keys${NC}"
    fi
    if [ $FAILED_RECOVERY -gt 0 ]; then
        echo -e "${RED}✗ Failed recovery operations: $FAILED_RECOVERY${NC}"
        echo -e "${YELLOW}You may need to retry failed operations manually${NC}"
    fi
    
    echo ""
    echo -e "${BLUE}Recovered funds have been sent to: $OWNER_WALLET${NC}"
    
    if [ "$NETWORK_TYPE" = "testnet" ]; then
        echo -e "${BLUE}You can view transactions on: https://sepolia.basescan.org/address/$OWNER_WALLET${NC}"
    else
        echo -e "${BLUE}You can view transactions on: https://basescan.org/address/$OWNER_WALLET${NC}"
    fi
fi

echo ""

exit 0
