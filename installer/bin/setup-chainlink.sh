#!/bin/bash

# Verdikta Validator Node - Chainlink Node Setup Script
# Sets up and configures a Chainlink Node

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

echo -e "${BLUE}Setting up Chainlink Node for Verdikta Validator Node...${NC}"

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

# Load PostgreSQL password
if [ -f "$INSTALLER_DIR/.postgres" ]; then
    source "$INSTALLER_DIR/.postgres"
else
    echo -e "${RED}Error: PostgreSQL password file not found. Please run setup-docker.sh first.${NC}"
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

# Function to generate a secure random password
generate_password() {
    # Generate a random 20-character password
    if command_exists openssl; then
        openssl rand -base64 15 | tr -d '/+=' | cut -c1-20
    else
        # Fallback if openssl is not available
        cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 20 | head -n 1
    fi
}

# Verify Docker is installed and running
if ! command_exists docker; then
    echo -e "${RED}Error: Docker is not installed. Please run setup-environment.sh first.${NC}"
    exit 1
fi

if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}Error: Docker daemon is not running. Please start Docker and try again.${NC}"
    exit 1
fi

# Infura API key is optional and only used as a fallback if no RPC URLs are provided
if [ -z "$INFURA_API_KEY" ]; then
    echo -e "${YELLOW}Infura API key not provided. Will rely on user-supplied RPC URLs.${NC}"
fi

# Load environment variables
if [ -f "$INSTALLER_DIR/.env" ]; then
    source "$INSTALLER_DIR/.env"
else
    echo -e "${RED}Error: Environment file not found. Please run setup-environment.sh first.${NC}"
    exit 1
fi

# Setup Chainlink Node directory - use network type in directory name
CHAINLINK_DIR="$HOME/.chainlink-${NETWORK_TYPE}"
echo -e "${BLUE}Creating Chainlink Node directory at $CHAINLINK_DIR for $NETWORK_NAME...${NC}"
mkdir -p "$CHAINLINK_DIR"

# Generate Chainlink Node keystore password
KEYSTORE_PASSWORD=$(generate_password)
echo "KEYSTORE_PASSWORD=\"$KEYSTORE_PASSWORD\"" > "$INSTALLER_DIR/.chainlink"
echo -e "${GREEN}Chainlink Node keystore password saved to $INSTALLER_DIR/.chainlink${NC}"
echo -e "${YELLOW}Important: Keep this password safe, it will be needed for accessing the Chainlink node.${NC}"

# Create Chainlink Node configuration
echo -e "${BLUE}Creating Chainlink Node configuration...${NC}"

# Path to the config template file
TEMPLATE_FILE="$(dirname "$INSTALLER_DIR")/chainlink-node/config_template.toml"

# Check if template file exists
if [ ! -f "$TEMPLATE_FILE" ]; then
    echo -e "${RED}Error: Config template file not found at $TEMPLATE_FILE${NC}"
    exit 1
fi

# Set network-specific configuration values
if [ "$DEPLOYMENT_NETWORK" = "base_mainnet" ]; then
    CHAIN_ID="8453"
    TIP_CAP_DEFAULT="1 gwei"
    FEE_CAP_DEFAULT="10 gwei"
    NETWORK_NAME_CONFIG="Base-Mainnet"
    WS_URL="wss://base-mainnet.infura.io/ws/v3/$INFURA_API_KEY"
    HTTP_URL="https://base-mainnet.infura.io/v3/$INFURA_API_KEY"
    RPC_HTTP_URLS="${BASE_MAINNET_RPC_HTTP_URLS:-}"
    RPC_WS_URLS="${BASE_MAINNET_RPC_WS_URLS:-}"
else
    # Default to Base Sepolia
    CHAIN_ID="84532"
    TIP_CAP_DEFAULT="2 gwei"
    FEE_CAP_DEFAULT="30 gwei"
    NETWORK_NAME_CONFIG="Base-Sepolia"
    WS_URL="wss://base-sepolia.infura.io/ws/v3/$INFURA_API_KEY"
    HTTP_URL="https://base-sepolia.infura.io/v3/$INFURA_API_KEY"
    RPC_HTTP_URLS="${BASE_SEPOLIA_RPC_HTTP_URLS:-}"
    RPC_WS_URLS="${BASE_SEPOLIA_RPC_WS_URLS:-}"
fi

# Build EVM nodes block from RPC lists (semicolon-separated)
normalize_rpc_list() {
    local raw="$1"
    raw="$(echo "$raw" | tr -d ' ' | sed 's/;*$//')"
    echo "$raw"
}

RPC_HTTP_URLS="$(normalize_rpc_list "$RPC_HTTP_URLS")"
RPC_WS_URLS="$(normalize_rpc_list "$RPC_WS_URLS")"

if [ -n "$RPC_HTTP_URLS" ] || [ -n "$RPC_WS_URLS" ]; then
    if [ -z "$RPC_HTTP_URLS" ] || [ -z "$RPC_WS_URLS" ]; then
        echo -e "${RED}Error: Both HTTP and WS RPC URL lists are required when configuring custom RPCs.${NC}"
        exit 1
    fi
fi

if [ -z "$RPC_HTTP_URLS" ] && [ -z "$RPC_WS_URLS" ]; then
    if [ -n "$INFURA_API_KEY" ]; then
        echo -e "${YELLOW}No custom RPC URLs provided. Falling back to Infura endpoints.${NC}"
        RPC_HTTP_URLS="$HTTP_URL"
        RPC_WS_URLS="$WS_URL"
    else
        echo -e "${RED}Error: No RPC URLs provided and Infura fallback is not available.${NC}"
        echo -e "${RED}Please configure RPC URLs in setup-environment.sh and retry.${NC}"
        exit 1
    fi
fi

IFS=';' read -r -a HTTP_URL_ARRAY <<< "$RPC_HTTP_URLS"
IFS=';' read -r -a WS_URL_ARRAY <<< "$RPC_WS_URLS"

if [ "${#HTTP_URL_ARRAY[@]}" -ne "${#WS_URL_ARRAY[@]}" ]; then
    echo -e "${RED}Error: HTTP and WS RPC URL list counts do not match.${NC}"
    echo -e "${RED}HTTP count: ${#HTTP_URL_ARRAY[@]}, WS count: ${#WS_URL_ARRAY[@]}${NC}"
    exit 1
fi

EVM_NODES_BLOCK=""
for i in "${!HTTP_URL_ARRAY[@]}"; do
    node_index=$((i + 1))
    http_url="${HTTP_URL_ARRAY[$i]}"
    ws_url="${WS_URL_ARRAY[$i]}"
    if [ -z "$http_url" ] || [ -z "$ws_url" ]; then
        echo -e "${RED}Error: Empty RPC URL detected at index $node_index.${NC}"
        exit 1
    fi
    EVM_NODES_BLOCK="${EVM_NODES_BLOCK}[[EVM.Nodes]]
Name=\"${NETWORK_NAME_CONFIG}-${node_index}\"
WSURL=\"${ws_url}\"
HTTPURL=\"${http_url}\"

"
done

# Create config.toml from template, replacing all placeholders
echo -e "${BLUE}Using config template from $TEMPLATE_FILE for $NETWORK_NAME...${NC}"
export CHAIN_ID TIP_CAP_DEFAULT FEE_CAP_DEFAULT NETWORK_NAME_CONFIG EVM_NODES_BLOCK TEMPLATE_FILE CHAINLINK_DIR
python3 - << 'PY'
import os

template_path = os.environ["TEMPLATE_FILE"]
output_path = os.path.join(os.environ["CHAINLINK_DIR"], "config.toml")

with open(template_path, "r", encoding="utf-8") as f:
    content = f.read()

replacements = {
    "<CHAIN_ID>": os.environ["CHAIN_ID"],
    "<TIP_CAP_DEFAULT>": os.environ["TIP_CAP_DEFAULT"],
    "<FEE_CAP_DEFAULT>": os.environ["FEE_CAP_DEFAULT"],
    "<NETWORK_NAME>": os.environ["NETWORK_NAME_CONFIG"],
    "<EVM_NODES_BLOCK>": os.environ["EVM_NODES_BLOCK"].rstrip() + "\n",
}

for key, value in replacements.items():
    content = content.replace(key, value)

with open(output_path, "w", encoding="utf-8") as f:
    f.write(content)
PY

echo -e "${GREEN}Config file created from template for $NETWORK_NAME with all network-specific values substituted.${NC}"

# Create secrets.toml
cat > "$CHAINLINK_DIR/secrets.toml" << EOL
[Password]
Keystore = '$KEYSTORE_PASSWORD'

[Database]
URL = 'postgresql://postgres:$POSTGRES_PASSWORD@host.docker.internal:5432/postgres?sslmode=disable'
EOL

echo -e "${GREEN}Chainlink Node configuration files created.${NC}"

# Create API credentials file
echo -e "${BLUE}Creating API credentials...${NC}"

# Generate secure credentials
API_EMAIL="admin@example.com"
read -p "Enter email for Chainlink node login [$API_EMAIL]: " input_email
if [ -n "$input_email" ]; then
    API_EMAIL="$input_email"
fi

API_PASSWORD=$(generate_password)
echo -e "${GREEN}Generated API password: $API_PASSWORD${NC}"
echo -e "${YELLOW}Please save this password for logging into the Chainlink node UI.${NC}"

# Create .api file
cat > "$CHAINLINK_DIR/.api" << EOL
$API_EMAIL
$API_PASSWORD
EOL
chmod 644 "$CHAINLINK_DIR/.api"

echo -e "${GREEN}API credentials created.${NC}"

# Start Chainlink Node
echo -e "${BLUE}Starting Chainlink Node...${NC}"

# Check if container already exists
if docker ps -a | grep -q "chainlink"; then
    echo -e "${YELLOW}Chainlink container already exists. Stopping and removing...${NC}"
    docker stop chainlink || true
    docker rm chainlink || true
fi

# Start chainlink container
echo -e "${BLUE}Creating and starting Chainlink container...${NC}"
docker run --platform linux/amd64 \
    --name chainlink \
    -v "$CHAINLINK_DIR:/chainlink" \
    -it \
    -d \
    -p 6688:6688 \
    --add-host=host.docker.internal:host-gateway \
    --network verdikta-network \
    smartcontract/chainlink:2.23.0 \
    node \
    -config /chainlink/config.toml \
    -secrets /chainlink/secrets.toml \
    start \
    -a /chainlink/.api

# Wait for Chainlink Node to start
echo -e "${BLUE}Waiting for Chainlink Node to start...${NC}"
for i in {1..30}; do
    if curl -s http://localhost:6688/health > /dev/null; then
        echo -e "${GREEN}Chainlink Node is running!${NC}"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${YELLOW}Chainlink Node is taking longer than expected to start. Please check the container logs:${NC}"
        echo -e "${YELLOW}docker logs chainlink${NC}"
        echo -e "${YELLOW}You can continue with the setup, but some steps may fail.${NC}"
    fi
    sleep 2
done

# Store Chainlink container ID for later use
echo -e "${BLUE}Storing Chainlink container information...${NC}"
CHAINLINK_CONTAINER_ID=$(docker ps -q --filter "name=chainlink")
if [ -n "$CHAINLINK_CONTAINER_ID" ]; then
    # Update container info file if it exists
    CONTAINER_INFO_FILE="$INSTALLER_DIR/../docker/container-info.txt"
    if [ -f "$CONTAINER_INFO_FILE" ]; then
        echo "CHAINLINK_CONTAINER_ID=$CHAINLINK_CONTAINER_ID" >> "$CONTAINER_INFO_FILE"
    fi
    
    # Also save to chainlink-specific file
    echo "CHAINLINK_CONTAINER_ID=$CHAINLINK_CONTAINER_ID" > "$CHAINLINK_DIR/container-id.txt"
    echo -e "${GREEN}Chainlink container ID saved: $CHAINLINK_CONTAINER_ID${NC}"
else
    echo -e "${YELLOW}Warning: Could not determine Chainlink container ID${NC}"
fi

# Save Chainlink Node information
echo -e "${BLUE}Saving Chainlink Node information...${NC}"
INFO_DIR="$(dirname "$INSTALLER_DIR")/chainlink-node"
mkdir -p "$INFO_DIR"
cat > "$INFO_DIR/info.txt" << EOL
Chainlink Node Information
=========================

UI: http://localhost:6688
Login Email: $API_EMAIL
Login Password: $API_PASSWORD

Configuration Directory: $CHAINLINK_DIR
Keystore Password: $KEYSTORE_PASSWORD
EOL

echo -e "${GREEN}Chainlink Node setup completed!${NC}"
echo -e "${BLUE}You can access the Chainlink Node UI at: http://localhost:6688${NC}"
echo -e "${BLUE}Login Email: $API_EMAIL${NC}"
echo -e "${BLUE}Login Password: $API_PASSWORD${NC}"
echo -e "${YELLOW}This information has been saved to $INFO_DIR/info.txt${NC}"

exit 0 