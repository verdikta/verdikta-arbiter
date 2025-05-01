#!/bin/bash

# Verdikta Validator Node - Docker and PostgreSQL Setup Script
# Sets up Docker containers for PostgreSQL database

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

echo -e "${BLUE}Setting up Docker and PostgreSQL for Verdikta Validator Node...${NC}"

# Load environment variables
if [ -f "$INSTALLER_DIR/.env" ]; then
    source "$INSTALLER_DIR/.env"
else
    echo -e "${RED}Error: Environment file not found. Please run setup-environment.sh first.${NC}"
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

# Verify Docker installation
if ! command_exists docker; then
    echo -e "${RED}Error: Docker is not installed. Please run setup-environment.sh first.${NC}"
    exit 1
fi

# Check if Docker daemon is running
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}Error: Docker daemon is not running. Please start Docker and try again.${NC}"
    exit 1
fi

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

# PostgreSQL configuration
echo -e "${BLUE}Configuring PostgreSQL...${NC}"

# Check if PostgreSQL container already exists
POSTGRES_CONTAINER="cl-postgres"
if docker ps -a | grep -q "$POSTGRES_CONTAINER"; then
    echo -e "${YELLOW}PostgreSQL container '$POSTGRES_CONTAINER' already exists.${NC}"
    if ask_yes_no "Would you like to remove the existing container and create a new one?"; then
        echo -e "${BLUE}Removing existing PostgreSQL container...${NC}"
        docker rm -f "$POSTGRES_CONTAINER"
    else
        echo -e "${GREEN}Using existing PostgreSQL container.${NC}"
        # Get the password from the existing container
        POSTGRES_PASSWORD=$(docker inspect --format='{{range .Config.Env}}{{if eq (index (split . "=") 0) "POSTGRES_PASSWORD"}}{{index (split . "=") 1}}{{end}}{{end}}' "$POSTGRES_CONTAINER")
        if [ -z "$POSTGRES_PASSWORD" ]; then
            echo -e "${YELLOW}Could not retrieve PostgreSQL password from existing container.${NC}"
            read -p "Please enter the existing PostgreSQL password (leave blank to generate a new one): " input_password
            if [ -n "$input_password" ]; then
                POSTGRES_PASSWORD="$input_password"
            else
                POSTGRES_PASSWORD=$(generate_password)
                echo -e "${YELLOW}Generated a new password for PostgreSQL. Please note this down.${NC}"
            fi
        fi
    fi
else
    # Generate a secure password
    POSTGRES_PASSWORD=$(generate_password)
    echo -e "${BLUE}Generated a secure password for PostgreSQL.${NC}"
fi

# Save PostgreSQL password to config
echo "POSTGRES_PASSWORD=\"$POSTGRES_PASSWORD\"" > "$INSTALLER_DIR/.postgres"
echo -e "${GREEN}PostgreSQL password saved to $INSTALLER_DIR/.postgres${NC}"
echo -e "${YELLOW}Important: Keep this password safe, it will be needed for Chainlink node configuration.${NC}"

# Create PostgreSQL container if it doesn't exist
if ! docker ps -a | grep -q "$POSTGRES_CONTAINER"; then
    echo -e "${BLUE}Creating PostgreSQL container...${NC}"
    docker run --name "$POSTGRES_CONTAINER" \
        -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
        -p 5432:5432 \
        -d postgres:14
    
    echo -e "${GREEN}PostgreSQL container created successfully.${NC}"
else
    # Check if container is running
    if ! docker ps | grep -q "$POSTGRES_CONTAINER"; then
        echo -e "${BLUE}Starting PostgreSQL container...${NC}"
        docker start "$POSTGRES_CONTAINER"
    fi
    echo -e "${GREEN}PostgreSQL container is running.${NC}"
fi

# Wait for PostgreSQL to start
echo -e "${BLUE}Waiting for PostgreSQL to start...${NC}"
for i in {1..10}; do
    if docker exec "$POSTGRES_CONTAINER" pg_isready -q; then
        echo -e "${GREEN}PostgreSQL is ready.${NC}"
        break
    fi
    if [ $i -eq 10 ]; then
        echo -e "${RED}Failed to connect to PostgreSQL. Please check the container logs:${NC}"
        echo -e "${YELLOW}docker logs $POSTGRES_CONTAINER${NC}"
        exit 1
    fi
    sleep 2
done

# Create a Docker network for all services if it doesn't exist
NETWORK_NAME="verdikta-network"
if ! docker network inspect "$NETWORK_NAME" > /dev/null 2>&1; then
    echo -e "${BLUE}Creating Docker network '$NETWORK_NAME'...${NC}"
    docker network create "$NETWORK_NAME"
    echo -e "${GREEN}Docker network created successfully.${NC}"
else
    echo -e "${GREEN}Docker network '$NETWORK_NAME' already exists.${NC}"
fi

# Connect PostgreSQL container to the network
if ! docker network inspect "$NETWORK_NAME" | grep -q "\"$POSTGRES_CONTAINER\""; then
    echo -e "${BLUE}Connecting PostgreSQL container to network...${NC}"
    docker network connect "$NETWORK_NAME" "$POSTGRES_CONTAINER"
    echo -e "${GREEN}PostgreSQL container connected to network.${NC}"
else
    echo -e "${GREEN}PostgreSQL container is already connected to the network.${NC}"
fi

# Create Docker Compose file
echo -e "${BLUE}Creating Docker Compose file...${NC}"
mkdir -p "$INSTALL_DIR/docker"
cat > "$INSTALL_DIR/docker/docker-compose.yml" << EOL
version: '3.8'

services:
  chainlink:
    image: smartcontract/chainlink:2.13.0
    platform: linux/x86_64/v8
    container_name: chainlink
    depends_on:
      - postgres
    ports:
      - "6688:6688"
    volumes:
      - ~/.chainlink-sepolia:/chainlink
    command: ["node", "-config", "/chainlink/config.toml", "-secrets", "/chainlink/secrets.toml", "start", "-a", "/chainlink/.api"]
    restart: unless-stopped
    networks:
      - verdikta-network
    extra_hosts:
      - "host.docker.internal:host-gateway"

  postgres:
    image: postgres:14
    container_name: cl-postgres
    ports:
      - "5432:5432"
    environment:
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    restart: unless-stopped
    networks:
      - verdikta-network

networks:
  verdikta-network:
    external: true

volumes:
  postgres-data:
    driver: local
EOL

echo -e "${GREEN}Docker Compose file created at $INSTALL_DIR/docker/docker-compose.yml${NC}"
echo -e "${GREEN}Docker and PostgreSQL setup completed!${NC}"
echo -e "${BLUE}Next step: Setting up the Chainlink Node${NC}"

exit 0 