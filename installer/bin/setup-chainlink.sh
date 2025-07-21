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

# Verify Infura API key exists
if [ -z "$INFURA_API_KEY" ]; then
    echo -e "${YELLOW}WARNING: Infura API key not provided. The Chainlink node will not be able to connect to Base Sepolia.${NC}"
    read -p "Enter your Infura API Key: " INFURA_API_KEY
    if [ -z "$INFURA_API_KEY" ]; then
        echo -e "${RED}Error: Infura API key is required for Chainlink node setup.${NC}"
        exit 1
    fi
    # Update .api_keys file with new Infura key
    sed -i.bak "s/^INFURA_API_KEY=.*/INFURA_API_KEY=\"$INFURA_API_KEY\"/" "$INSTALLER_DIR/.api_keys"
fi

# Setup Chainlink Node directory
CHAINLINK_DIR="$HOME/.chainlink-sepolia"
echo -e "${BLUE}Creating Chainlink Node directory at $CHAINLINK_DIR...${NC}"
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

# Create config.toml from template, replacing <KEY> with actual Infura API key
echo -e "${BLUE}Using config template from $TEMPLATE_FILE...${NC}"
sed "s/<KEY>/$INFURA_API_KEY/g" "$TEMPLATE_FILE" > "$CHAINLINK_DIR/config.toml"

echo -e "${GREEN}Config file created from template with Infura API key substituted.${NC}"

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
docker run --platform linux/x86_64/v8 \
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