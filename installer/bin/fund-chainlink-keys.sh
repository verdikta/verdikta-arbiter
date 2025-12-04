#!/bin/bash

# Verdikta Arbiter Node - Automatic Chainlink Key Funding Script
# Automatically funds Chainlink keys with native ETH for gas fees

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
DEFAULT_FUNDING_AMOUNT_TESTNET="0.005"  # 0.005 Base Sepolia ETH per key (~50 queries worth)
DEFAULT_FUNDING_AMOUNT_MAINNET="0.002"  # 0.002 Base ETH per key (~50 queries worth)
MIN_WALLET_BALANCE_THRESHOLD="0.01"     # Minimum wallet balance to proceed

# Command line options
DRY_RUN=false
FORCE_FUNDING=false
INTERACTIVE=true
CUSTOM_AMOUNT=""

usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Automatically fund Chainlink keys with native ETH for gas fees"
    echo ""
    echo "Options:"
    echo "  --amount AMOUNT      Custom funding amount per key (in ETH)"
    echo "  --dry-run           Show what would be funded without sending transactions"
    echo "  --force             Skip confirmation prompts"
    echo "  --non-interactive   Run without user prompts (for automation)"
    echo "  --help, -h          Show this help message"
    echo ""
    echo "Network Detection:"
    echo "  - Automatically detects Base Sepolia vs Base Mainnet from configuration"
    echo "  - Uses appropriate default funding amounts for each network"
    echo ""
    echo "Default Funding Amounts:"
    echo "  - Base Sepolia: $DEFAULT_FUNDING_AMOUNT_TESTNET ETH per key (~50 queries)"
    echo "  - Base Mainnet: $DEFAULT_FUNDING_AMOUNT_MAINNET ETH per key (~50 queries)"
    echo ""
    echo "Examples:"
    echo "  $0                                    # Interactive funding with defaults"
    echo "  $0 --amount 0.01                     # Fund each key with 0.01 ETH"
    echo "  $0 --dry-run                         # Preview funding without executing"
    echo "  $0 --force --amount 0.005            # Auto-fund without confirmation"
    echo ""
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --amount)
            CUSTOM_AMOUNT="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --force)
            FORCE_FUNDING=true
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
    echo -e "${GREEN}Found environment file: $ENV_FILE${NC}"
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
    echo -e "${GREEN}Found contracts file: $CONTRACTS_FILE${NC}"
else
    echo -e "${RED}Error: Contract information file (.contracts) not found in any of these locations:${NC}"
    for location in "${POSSIBLE_LOCATIONS[@]}"; do
        echo -e "${RED}  - $location/.contracts${NC}"
    done
    echo -e "${RED}Please run the installer first.${NC}"
    exit 1
fi

# Validate required environment variables
if [ -z "$PRIVATE_KEY" ]; then
    echo -e "${RED}Error: PRIVATE_KEY not found in environment. Please run the installer first.${NC}"
    exit 1
fi

if [ -z "$INFURA_API_KEY" ]; then
    echo -e "${RED}Error: INFURA_API_KEY not found in environment. Please run the installer first.${NC}"
    exit 1
fi

if [ -z "$DEPLOYMENT_NETWORK" ]; then
    echo -e "${RED}Error: DEPLOYMENT_NETWORK not found in environment. Please run the installer first.${NC}"
    exit 1
fi

# Set network-specific configuration
if [ "$DEPLOYMENT_NETWORK" = "base_mainnet" ]; then
    CHAIN_ID="8453"
    NETWORK_NAME="Base Mainnet"
    RPC_URL="https://base-mainnet.infura.io/v3/$INFURA_API_KEY"
    DEFAULT_FUNDING_AMOUNT="$DEFAULT_FUNDING_AMOUNT_MAINNET"
    CURRENCY_NAME="Base ETH"
    NETWORK_TYPE="mainnet"
else
    CHAIN_ID="84532"
    NETWORK_NAME="Base Sepolia"
    RPC_URL="https://base-sepolia.infura.io/v3/$INFURA_API_KEY"
    DEFAULT_FUNDING_AMOUNT="$DEFAULT_FUNDING_AMOUNT_TESTNET"
    CURRENCY_NAME="Base Sepolia ETH"
    NETWORK_TYPE="testnet"
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

# Function to get wallet address from private key
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

# Function to estimate gas for transaction
estimate_gas() {
    local from_address="$1"
    local to_address="$2"
    local value_wei="$3"
    local rpc_url="$4"
    
    # Make RPC call to estimate gas
    local rpc_response=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_estimateGas\",\"params\":[{\"from\":\"$from_address\",\"to\":\"$to_address\",\"value\":\"0x$(printf '%x' $value_wei)\"}],\"id\":1}" \
        "$rpc_url")
    
    if [ $? -ne 0 ]; then
        echo "21000"  # Default gas limit for simple transfer
        return 0
    fi
    
    # Extract gas estimate from response
    local gas_hex=$(echo "$rpc_response" | python3 -c "
import json
import sys
try:
    data = json.load(sys.stdin)
    if 'result' in data:
        print(data['result'])
    else:
        print('0x5208')  # Default 21000 in hex
except:
    print('0x5208')  # Default 21000 in hex
" 2>/dev/null)
    
    # Convert hex to decimal
    local gas_limit=$(python3 -c "print(int('$gas_hex', 16))" 2>/dev/null)
    if [ $? -ne 0 ]; then
        gas_limit="21000"  # Default
    fi
    
    echo "$gas_limit"
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
        echo "DRY_RUN: Would send transaction"
        return 0
    fi
    
    # Add 0x prefix to private key if not present
    if [[ ! "$from_private_key" =~ ^0x ]]; then
        from_private_key="0x$from_private_key"
    fi
    
    # Use Python to create and send transaction
    local tx_hash=$(timeout 60 python3 -c "
try:
    from eth_account import Account
    from web3 import Web3
    import sys
    import requests
    
    # Try to import geth_poa_middleware (different location in different web3 versions)
    try:
        from web3.middleware import geth_poa_middleware
        POA_MIDDLEWARE_AVAILABLE = True
    except ImportError:
        try:
            from web3 import middleware
            geth_poa_middleware = middleware.geth_poa_middleware
            POA_MIDDLEWARE_AVAILABLE = True
        except (ImportError, AttributeError):
            POA_MIDDLEWARE_AVAILABLE = False
    
    # Setup
    private_key = '$from_private_key'
    to_address = '$to_address'
    value_wei = $value_wei
    gas_limit = $gas_limit
    gas_price = $gas_price
    nonce = $nonce
    chain_id = $CHAIN_ID
    rpc_url = '$rpc_url'
    
    # Connection info
    print(f'Connecting to {rpc_url}...', file=sys.stderr)
    
    # Create account and web3 instance with timeout
    session = requests.Session()
    session.timeout = 30
    w3 = Web3(Web3.HTTPProvider(rpc_url, session=session))
    
    # Add middleware for Base (which is a PoA chain) if available
    if POA_MIDDLEWARE_AVAILABLE:
        w3.middleware_onion.inject(geth_poa_middleware, layer=0)
    
    # Check connection
    try:
        latest_block = w3.eth.get_block('latest')
        print(f'Connected to network (block {latest_block.number})', file=sys.stderr)
    except Exception as e:
        print(f'ERROR: Failed to connect to RPC endpoint: {e}')
        sys.exit(1)
    
    # Create account
    account = Account.from_key(private_key)
    
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
    
    # Send transaction with timeout using direct RPC call
    
    # Handle different attribute names in different eth-account versions
    if hasattr(signed_txn, 'rawTransaction'):
        raw_tx_hex = signed_txn.rawTransaction.hex()
    elif hasattr(signed_txn, 'raw_transaction'):
        raw_tx_hex = signed_txn.raw_transaction.hex()
    else:
        raw_tx_hex = signed_txn.hex()
    
    # Ensure hex string has 0x prefix
    if not raw_tx_hex.startswith('0x'):
        raw_tx_hex = '0x' + raw_tx_hex
    
    # Use direct RPC call instead of Web3.py
    import json
    rpc_payload = {
        'jsonrpc': '2.0',
        'method': 'eth_sendRawTransaction',
        'params': [raw_tx_hex],
        'id': 1
    }
    
    response = requests.post(rpc_url, json=rpc_payload, timeout=30)
    response.raise_for_status()
    
    result = response.json()
    
    if 'error' in result:
        raise Exception(f'RPC error: {result[\"error\"]}')
    
    tx_hash_hex = result['result']
    print(tx_hash_hex)
    
except ImportError as e:
    print('ERROR: Missing required packages. Please install: pip3 install eth-account web3')
    sys.exit(1)
except Exception as e:
    print('ERROR: ' + str(e))
    sys.exit(1)
")
    
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

# Function to install pip if missing
install_pip_if_missing() {
    if ! command_exists pip3 && ! command_exists pip; then
        echo -e "${YELLOW}pip/pip3 not found. Installing pip...${NC}"
        
        # Try different methods to install pip
        if command_exists apt-get; then
            # Ubuntu/Debian
            if command_exists sudo; then
                sudo apt-get update >/dev/null 2>&1 && sudo apt-get install -y python3-pip >/dev/null 2>&1
            else
                apt-get update >/dev/null 2>&1 && apt-get install -y python3-pip >/dev/null 2>&1
            fi
        elif command_exists yum; then
            # CentOS/RHEL
            if command_exists sudo; then
                sudo yum install -y python3-pip >/dev/null 2>&1
            else
                yum install -y python3-pip >/dev/null 2>&1
            fi
        elif command_exists dnf; then
            # Fedora
            if command_exists sudo; then
                sudo dnf install -y python3-pip >/dev/null 2>&1
            else
                dnf install -y python3-pip >/dev/null 2>&1
            fi
        elif command_exists brew; then
            # macOS
            brew install python3 >/dev/null 2>&1
        else
            # Try to install using get-pip.py
            echo -e "${BLUE}Attempting to install pip using get-pip.py...${NC}"
            if command_exists curl; then
                curl -sS https://bootstrap.pypa.io/get-pip.py | python3 >/dev/null 2>&1
            elif command_exists wget; then
                wget -qO- https://bootstrap.pypa.io/get-pip.py | python3 >/dev/null 2>&1
            else
                echo -e "${RED}Error: Cannot install pip automatically. Please install manually:${NC}"
                echo -e "${RED}  On Ubuntu/Debian: sudo apt-get install python3-pip${NC}"
                echo -e "${RED}  On CentOS/RHEL: sudo yum install python3-pip${NC}"
                echo -e "${RED}  On Fedora: sudo dnf install python3-pip${NC}"
                echo -e "${RED}  On macOS: brew install python3${NC}"
                exit 1
            fi
        fi
        
        # Clear shell command cache so newly installed pip can be found
        hash -r
        
        # Verify pip installation using direct path check as fallback
        if ! command_exists pip3 && ! command_exists pip; then
            # Try common installation paths directly
            if [ -x "/usr/bin/pip3" ]; then
                echo -e "${GREEN}✓ pip3 found at /usr/bin/pip3${NC}"
            elif [ -x "/usr/local/bin/pip3" ]; then
                echo -e "${GREEN}✓ pip3 found at /usr/local/bin/pip3${NC}"
            else
                echo -e "${RED}Error: Failed to install pip. Please install manually:${NC}"
                echo -e "${RED}  On Ubuntu/Debian: sudo apt-get install python3-pip${NC}"
                echo -e "${RED}  On CentOS/RHEL: sudo yum install python3-pip${NC}"
                echo -e "${RED}  On Fedora: sudo dnf install python3-pip${NC}"
                echo -e "${RED}  On macOS: brew install python3${NC}"
                exit 1
            fi
        fi
        
        echo -e "${GREEN}✓ pip successfully installed${NC}"
    fi
}

# Check if required Python packages are installed
check_python_dependencies() {
    echo -e "${BLUE}Checking Python dependencies...${NC}"
    
    # First ensure pip is available
    install_pip_if_missing
    
    # Clear shell command cache to ensure we find newly installed commands
    hash -r
    
    if ! python3 -c "import eth_account, web3" 2>/dev/null; then
        echo -e "${YELLOW}Installing required Python packages...${NC}"
        
        # Determine which pip command to use (check command_exists first, then direct paths)
        PIP_CMD=""
        if command_exists pip3; then
            PIP_CMD="pip3"
        elif command_exists pip; then
            PIP_CMD="pip"
        elif [ -x "/usr/bin/pip3" ]; then
            PIP_CMD="/usr/bin/pip3"
        elif [ -x "/usr/local/bin/pip3" ]; then
            PIP_CMD="/usr/local/bin/pip3"
        elif [ -x "/usr/bin/pip" ]; then
            PIP_CMD="/usr/bin/pip"
        fi
        
        if [ -z "$PIP_CMD" ]; then
            echo -e "${RED}Error: pip/pip3 not found after installation attempt. Please install manually:${NC}"
            echo -e "${RED}  pip3 install eth-account web3${NC}"
            exit 1
        fi
        
        echo -e "${BLUE}Using pip command: $PIP_CMD${NC}"
        
        # Install required packages
        if ! $PIP_CMD install eth-account web3 2>&1; then
            echo -e "${YELLOW}First install attempt failed, retrying with --break-system-packages...${NC}"
            # Some newer systems require --break-system-packages flag
            $PIP_CMD install --break-system-packages eth-account web3 2>&1 || true
        fi
        
        # Verify installation
        if ! python3 -c "import eth_account, web3" 2>/dev/null; then
            echo -e "${RED}Error: Failed to install required packages. Please install manually:${NC}"
            echo -e "${RED}  pip3 install eth-account web3${NC}"
            echo -e "${RED}  (On newer systems, you may need: pip3 install --break-system-packages eth-account web3)${NC}"
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

# Main execution starts here
echo -e "${BLUE}"
echo "============================================================"
echo "  Verdikta Arbiter - Automatic Chainlink Key Funding"
echo "============================================================"
echo -e "${NC}"

if [ "$DRY_RUN" = "true" ]; then
    echo -e "${YELLOW}DRY RUN MODE: No transactions will be sent${NC}"
    echo ""
fi

echo -e "${BLUE}Network: $NETWORK_NAME (Chain ID: $CHAIN_ID)${NC}"
echo -e "${BLUE}Currency: $CURRENCY_NAME${NC}"
echo ""

# Check dependencies
check_python_dependencies
check_bc_dependency

# Get funding amount
if [ -n "$CUSTOM_AMOUNT" ]; then
    if ! is_valid_amount "$CUSTOM_AMOUNT"; then
        echo -e "${RED}Error: Invalid custom amount '$CUSTOM_AMOUNT'${NC}"
        exit 1
    fi
    FUNDING_AMOUNT="$CUSTOM_AMOUNT"
    echo -e "${BLUE}Using custom funding amount: $FUNDING_AMOUNT $CURRENCY_NAME per key${NC}"
else
    FUNDING_AMOUNT="$DEFAULT_FUNDING_AMOUNT"
    echo -e "${BLUE}Using default funding amount: $FUNDING_AMOUNT $CURRENCY_NAME per key${NC}"
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

echo -e "${GREEN}Found $KEY_COUNT Chainlink keys to fund:${NC}"
for i in "${!KEY_ADDRESSES[@]}"; do
    echo -e "${GREEN}  Key $((i+1)): ${KEY_ADDRESSES[$i]}${NC}"
done
echo ""

# Get funding wallet address
echo -e "${BLUE}Getting funding wallet address...${NC}"
FUNDING_WALLET=$(get_wallet_address_from_private_key "$PRIVATE_KEY")
if [[ "$FUNDING_WALLET" == ERROR:* ]]; then
    echo -e "${RED}Error getting wallet address: $FUNDING_WALLET${NC}"
    exit 1
fi

echo -e "${GREEN}Funding wallet: $FUNDING_WALLET${NC}"

# Check funding wallet balance
echo -e "${BLUE}Checking funding wallet balance...${NC}"
WALLET_BALANCE_WEI=$(get_wallet_balance "$FUNDING_WALLET" "$RPC_URL")
if [[ "$WALLET_BALANCE_WEI" == ERROR:* ]]; then
    echo -e "${RED}Error checking wallet balance: $WALLET_BALANCE_WEI${NC}"
    exit 1
fi

WALLET_BALANCE_ETH=$(wei_to_eth "$WALLET_BALANCE_WEI")
echo -e "${GREEN}Current wallet balance: $WALLET_BALANCE_ETH $CURRENCY_NAME${NC}"

# Check if wallet has sufficient funds
TOTAL_FUNDING_NEEDED=$(echo "$FUNDING_AMOUNT * $KEY_COUNT" | bc -l)
MIN_BALANCE_NEEDED=$(echo "$TOTAL_FUNDING_NEEDED + 0.01" | bc -l)  # Add buffer for gas

if (( $(echo "$WALLET_BALANCE_ETH < $MIN_BALANCE_NEEDED" | bc -l) )); then
    echo -e "${RED}Error: Insufficient wallet balance${NC}"
    echo -e "${RED}  Available: $WALLET_BALANCE_ETH $CURRENCY_NAME${NC}"
    echo -e "${RED}  Required: $MIN_BALANCE_NEEDED $CURRENCY_NAME (includes gas buffer)${NC}"
    echo ""
    
    if [ "$NETWORK_TYPE" = "testnet" ]; then
        echo -e "${YELLOW}To get testnet funds:${NC}"
        echo -e "${YELLOW}  Visit: https://www.alchemy.com/faucets/base-sepolia${NC}"
        echo -e "${YELLOW}  Address: $FUNDING_WALLET${NC}"
    else
        echo -e "${YELLOW}Please add more $CURRENCY_NAME to your wallet:${NC}"
        echo -e "${YELLOW}  Address: $FUNDING_WALLET${NC}"
    fi
    exit 1
fi

# Get current gas price
echo -e "${BLUE}Getting current gas price...${NC}"
GAS_PRICE=$(get_gas_price "$RPC_URL")
GAS_PRICE_GWEI=$(echo "scale=2; $GAS_PRICE / 1000000000" | bc -l)
echo -e "${GREEN}Current gas price: $GAS_PRICE_GWEI gwei${NC}"

# Calculate total cost including gas
FUNDING_AMOUNT_WEI=$(eth_to_wei "$FUNDING_AMOUNT")
ESTIMATED_GAS_PER_TX="21000"  # Standard ETH transfer
GAS_COST_PER_TX=$(echo "$ESTIMATED_GAS_PER_TX * $GAS_PRICE" | bc -l)
GAS_COST_PER_TX_ETH=$(wei_to_eth "$GAS_COST_PER_TX")
TOTAL_GAS_COST_ETH=$(echo "$GAS_COST_PER_TX_ETH * $KEY_COUNT" | bc -l)
TOTAL_COST_ETH=$(echo "$TOTAL_FUNDING_NEEDED + $TOTAL_GAS_COST_ETH" | bc -l)

echo ""
echo -e "${BLUE}Funding Summary:${NC}"
echo -e "${BLUE}  Keys to fund: $KEY_COUNT${NC}"
echo -e "${BLUE}  Amount per key: $FUNDING_AMOUNT $CURRENCY_NAME${NC}"
echo -e "${BLUE}  Total funding: $TOTAL_FUNDING_NEEDED $CURRENCY_NAME${NC}"
echo -e "${BLUE}  Estimated gas cost: $TOTAL_GAS_COST_ETH $CURRENCY_NAME${NC}"
echo -e "${BLUE}  Total cost: $TOTAL_COST_ETH $CURRENCY_NAME${NC}"
echo -e "${BLUE}  Remaining balance: $(echo "$WALLET_BALANCE_ETH - $TOTAL_COST_ETH" | bc -l) $CURRENCY_NAME${NC}"
echo ""

# Final confirmation
if [ "$FORCE_FUNDING" = "false" ] && [ "$INTERACTIVE" = "true" ]; then
    echo -e "${YELLOW}⚠ This will send $CURRENCY_NAME from your wallet to each Chainlink key.${NC}"
    echo -e "${YELLOW}⚠ Total cost: $TOTAL_COST_ETH $CURRENCY_NAME (including gas)${NC}"
    echo ""
    
    if ! ask_yes_no "Do you want to proceed with funding?"; then
        echo -e "${BLUE}Funding cancelled by user.${NC}"
        exit 0
    fi
    echo ""
fi

# Fund each key
echo -e "${BLUE}Starting funding process...${NC}"
SUCCESSFUL_FUNDING=0
FAILED_FUNDING=0

for i in "${!KEY_ADDRESSES[@]}"; do
    KEY_ADDRESS="${KEY_ADDRESSES[$i]}"
    KEY_NUMBER=$((i+1))
    
    echo -e "\n${BLUE}Funding Key $KEY_NUMBER/$KEY_COUNT: $KEY_ADDRESS${NC}"
    
    # Check if key already has sufficient balance
    KEY_BALANCE_WEI=$(get_wallet_balance "$KEY_ADDRESS" "$RPC_URL")
    if [[ "$KEY_BALANCE_WEI" != ERROR:* ]]; then
        KEY_BALANCE_ETH=$(wei_to_eth "$KEY_BALANCE_WEI")
        echo -e "${BLUE}  Current balance: $KEY_BALANCE_ETH $CURRENCY_NAME${NC}"
        
        # Skip if already has sufficient funds (more than 80% of funding amount)
        THRESHOLD=$(echo "$FUNDING_AMOUNT * 0.8" | bc -l)
        if (( $(echo "$KEY_BALANCE_ETH >= $THRESHOLD" | bc -l) )); then
            echo -e "${YELLOW}  ⚠ Key already has sufficient funds, skipping...${NC}"
            SUCCESSFUL_FUNDING=$((SUCCESSFUL_FUNDING + 1))
            continue
        fi
    fi
    
    # Estimate gas for this transaction
    GAS_LIMIT=$(estimate_gas "$FUNDING_WALLET" "$KEY_ADDRESS" "$FUNDING_AMOUNT_WEI" "$RPC_URL")
    
    # Send transaction
    if [ "$DRY_RUN" = "false" ]; then
        # Get fresh nonce for each transaction
        echo -e "${BLUE}  Getting current nonce...${NC}"
        CURRENT_NONCE=$(get_nonce "$FUNDING_WALLET" "$RPC_URL")
        echo -e "${BLUE}  Using nonce: $CURRENT_NONCE${NC}"
        
        echo -e "${BLUE}  Sending $FUNDING_AMOUNT $CURRENCY_NAME...${NC}"
        TX_HASH=$(send_eth_transaction "$PRIVATE_KEY" "$KEY_ADDRESS" "$FUNDING_AMOUNT_WEI" "$GAS_LIMIT" "$GAS_PRICE" "$CURRENT_NONCE" "$RPC_URL")
        
        if [[ "$TX_HASH" == ERROR:* ]]; then
            echo -e "${RED}  ✗ Failed to send transaction: $TX_HASH${NC}"
            FAILED_FUNDING=$((FAILED_FUNDING + 1))
        else
            echo -e "${GREEN}  ✓ Transaction sent: $TX_HASH${NC}"
            
            # Wait for confirmation
            if wait_for_transaction "$TX_HASH" "$RPC_URL"; then
                SUCCESSFUL_FUNDING=$((SUCCESSFUL_FUNDING + 1))
                echo -e "${GREEN}  ✓ Key $KEY_NUMBER funded successfully${NC}"
            else
                FAILED_FUNDING=$((FAILED_FUNDING + 1))
                echo -e "${RED}  ✗ Transaction may have failed${NC}"
            fi
            
            # Nonce will be fetched fresh for next transaction
            
            # Brief delay between transactions
            if [ $KEY_NUMBER -lt $KEY_COUNT ]; then
                echo -e "${BLUE}  Waiting 5 seconds before next transaction...${NC}"
                sleep 5
            fi
        fi
    else
        echo -e "${BLUE}  DRY RUN: Would send $FUNDING_AMOUNT $CURRENCY_NAME${NC}"
        echo -e "${BLUE}  DRY RUN: Transaction hash would be generated${NC}"
        SUCCESSFUL_FUNDING=$((SUCCESSFUL_FUNDING + 1))
    fi
done

# Final summary
echo ""
echo -e "${BLUE}============================================================${NC}"
echo -e "${BLUE}  Funding Complete${NC}"
echo -e "${BLUE}============================================================${NC}"

if [ "$DRY_RUN" = "true" ]; then
    echo -e "${YELLOW}DRY RUN SUMMARY:${NC}"
    echo -e "${GREEN}✓ Would have funded: $KEY_COUNT keys${NC}"
    echo -e "${GREEN}✓ Total cost would be: $TOTAL_COST_ETH $CURRENCY_NAME${NC}"
    echo -e "${BLUE}Run without --dry-run to execute actual funding${NC}"
else
    echo -e "${GREEN}✓ Successfully funded: $SUCCESSFUL_FUNDING keys${NC}"
    if [ $FAILED_FUNDING -gt 0 ]; then
        echo -e "${RED}✗ Failed to fund: $FAILED_FUNDING keys${NC}"
        echo -e "${YELLOW}You may need to retry failed transactions manually${NC}"
    fi
    
    echo ""
    echo -e "${BLUE}Your Chainlink keys are now funded and ready for operation!${NC}"
    
    if [ "$NETWORK_TYPE" = "testnet" ]; then
        echo -e "${BLUE}You can view transactions on: https://sepolia.basescan.org/address/$FUNDING_WALLET${NC}"
    else
        echo -e "${BLUE}You can view transactions on: https://basescan.org/address/$FUNDING_WALLET${NC}"
    fi
fi

echo ""

exit 0
