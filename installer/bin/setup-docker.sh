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

# Check for existing Chainlink containers and offer cleanup
echo -e "${BLUE}Checking for existing Chainlink installations...${NC}"

POSTGRES_CONTAINER="cl-postgres"
CHAINLINK_CONTAINER="chainlink"
EXISTING_POSTGRES=$(docker ps -a --filter "name=^${POSTGRES_CONTAINER}$" --format "{{.Names}}" 2>/dev/null)
EXISTING_CHAINLINK=$(docker ps -a --filter "name=^${CHAINLINK_CONTAINER}$" --format "{{.Names}}" 2>/dev/null)

if [ -n "$EXISTING_POSTGRES" ] || [ -n "$EXISTING_CHAINLINK" ]; then
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}  WARNING: Existing Chainlink Installation Detected${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo
    echo -e "${BLUE}Found existing Docker containers:${NC}"
    
    if [ -n "$EXISTING_POSTGRES" ]; then
        POSTGRES_STATUS=$(docker ps --filter "name=^${POSTGRES_CONTAINER}$" --format "{{.Status}}" 2>/dev/null)
        if [ -n "$POSTGRES_STATUS" ]; then
            echo -e "${GREEN}  ✓ $POSTGRES_CONTAINER (Running: $POSTGRES_STATUS)${NC}"
        else
            echo -e "${YELLOW}  ⚠ $POSTGRES_CONTAINER (Stopped)${NC}"
        fi
    fi
    
    if [ -n "$EXISTING_CHAINLINK" ]; then
        CHAINLINK_STATUS=$(docker ps --filter "name=^${CHAINLINK_CONTAINER}$" --format "{{.Status}}" 2>/dev/null)
        if [ -n "$CHAINLINK_STATUS" ]; then
            echo -e "${GREEN}  ✓ $CHAINLINK_CONTAINER (Running: $CHAINLINK_STATUS)${NC}"
        else
            echo -e "${YELLOW}  ⚠ $CHAINLINK_CONTAINER (Stopped)${NC}"
        fi
    fi
    
    echo
    echo -e "${YELLOW}For a clean installation, the installer must remove these existing containers${NC}"
    echo -e "${YELLOW}and start from scratch. This prevents conflicts and installation errors.${NC}"
    echo
    echo -e "${BLUE}What will be removed:${NC}"
    echo -e "  • Existing Chainlink and PostgreSQL containers"
    echo -e "  • Container data and configuration"
    echo -e "  • Database volumes (unless backed up)"
    echo
    
    # Offer database backup before cleanup
    DATABASE_BACKUP_FILE=""
    if [ -n "$EXISTING_POSTGRES" ]; then
        # Check if PostgreSQL container is running
        if docker ps --filter "name=^${POSTGRES_CONTAINER}$" --format "{{.Names}}" | grep -q "$POSTGRES_CONTAINER"; then
            POSTGRES_RUNNING=true
        else
            POSTGRES_RUNNING=false
        fi
        
        echo -e "${BLUE}Database Backup Option:${NC}"
        if [ "$POSTGRES_RUNNING" = "true" ]; then
            echo -e "${BLUE}The PostgreSQL database is currently running and can be backed up.${NC}"
            echo
            
            if ask_yes_no "Would you like to back up the existing PostgreSQL database before cleanup?"; then
                BACKUP_DIR="$HOME/verdikta-backups"
                mkdir -p "$BACKUP_DIR"
                BACKUP_TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
                DATABASE_BACKUP_FILE="$BACKUP_DIR/chainlink-db-backup-${BACKUP_TIMESTAMP}.sql"
                
                echo -e "${BLUE}Creating database backup...${NC}"
                echo -e "${BLUE}Backup location: $DATABASE_BACKUP_FILE${NC}"
                
                # Get PostgreSQL password if available
                POSTGRES_PASSWORD=$(docker inspect --format='{{range .Config.Env}}{{if eq (index (split . "=") 0) "POSTGRES_PASSWORD"}}{{index (split . "=") 1}}{{end}}{{end}}' "$POSTGRES_CONTAINER" 2>/dev/null)
                
                if docker exec "$POSTGRES_CONTAINER" pg_dumpall -U postgres > "$DATABASE_BACKUP_FILE" 2>/dev/null; then
                    echo -e "${GREEN}✓ Database backup created successfully!${NC}"
                    echo -e "${GREEN}✓ Location: $DATABASE_BACKUP_FILE${NC}"
                    
                    # Create a backup info file
                    cat > "$BACKUP_DIR/backup-info-${BACKUP_TIMESTAMP}.txt" << EOL
# Verdikta Chainlink Database Backup Information
# Created: $(date)

Backup File: $DATABASE_BACKUP_FILE
PostgreSQL Container: $POSTGRES_CONTAINER
Chainlink Container: $CHAINLINK_CONTAINER

To restore this backup:
1. Ensure PostgreSQL container is running
2. Run: docker exec -i cl-postgres psql -U postgres < $DATABASE_BACKUP_FILE

Note: This backup was created before a clean installation.
EOL
                    echo -e "${BLUE}Backup information saved to: $BACKUP_DIR/backup-info-${BACKUP_TIMESTAMP}.txt${NC}"
                else
                    echo -e "${RED}✗ Failed to create database backup${NC}"
                    echo -e "${YELLOW}Attempting alternative backup method...${NC}"
                    
                    # Try backup using pg_dump for individual databases
                    if docker exec "$POSTGRES_CONTAINER" pg_dump -U postgres postgres > "$DATABASE_BACKUP_FILE" 2>/dev/null; then
                        echo -e "${GREEN}✓ Database backup created (postgres database only)${NC}"
                    else
                        echo -e "${RED}✗ Backup failed. Proceeding without backup.${NC}"
                        DATABASE_BACKUP_FILE=""
                    fi
                fi
                echo
            else
                echo -e "${YELLOW}Skipping database backup.${NC}"
                echo
            fi
        else
            echo -e "${YELLOW}The PostgreSQL container is stopped. Cannot create backup while stopped.${NC}"
            echo -e "${YELLOW}If you need to back up the database, please:${NC}"
            echo -e "${YELLOW}  1. Cancel this installation (Ctrl+C)${NC}"
            echo -e "${YELLOW}  2. Start the PostgreSQL container: docker start $POSTGRES_CONTAINER${NC}"
            echo -e "${YELLOW}  3. Create a manual backup${NC}"
            echo -e "${YELLOW}  4. Re-run the installer${NC}"
            echo
            
            if ! ask_yes_no "Continue installation without backup?"; then
                echo -e "${BLUE}Installation cancelled by user.${NC}"
                exit 0
            fi
            echo
        fi
    fi
    
    # Final confirmation before cleanup
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}  FINAL CONFIRMATION${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo
    echo -e "${RED}This will permanently remove:${NC}"
    [ -n "$EXISTING_POSTGRES" ] && echo -e "${RED}  • PostgreSQL container: $POSTGRES_CONTAINER${NC}"
    [ -n "$EXISTING_CHAINLINK" ] && echo -e "${RED}  • Chainlink container: $CHAINLINK_CONTAINER${NC}"
    echo -e "${RED}  • All container data and volumes${NC}"
    echo
    if [ -n "$DATABASE_BACKUP_FILE" ] && [ -f "$DATABASE_BACKUP_FILE" ]; then
        echo -e "${GREEN}Database backup saved at: $DATABASE_BACKUP_FILE${NC}"
        echo
    fi
    
    if ! ask_yes_no "Proceed with removing existing containers and starting clean installation?"; then
        echo -e "${BLUE}Installation cancelled by user.${NC}"
        echo -e "${YELLOW}To perform a manual cleanup, run:${NC}"
        [ -n "$EXISTING_CHAINLINK" ] && echo -e "${YELLOW}  docker rm -f $CHAINLINK_CONTAINER${NC}"
        [ -n "$EXISTING_POSTGRES" ] && echo -e "${YELLOW}  docker rm -f $POSTGRES_CONTAINER${NC}"
        echo -e "${YELLOW}  docker volume prune${NC}"
        exit 0
    fi
    
    echo
    echo -e "${BLUE}Starting cleanup of existing installation...${NC}"
    
    # Stop and remove Chainlink container
    if [ -n "$EXISTING_CHAINLINK" ]; then
        echo -e "${BLUE}Removing Chainlink container...${NC}"
        docker rm -f "$CHAINLINK_CONTAINER" 2>/dev/null || true
        echo -e "${GREEN}✓ Chainlink container removed${NC}"
    fi
    
    # Stop and remove PostgreSQL container
    if [ -n "$EXISTING_POSTGRES" ]; then
        echo -e "${BLUE}Removing PostgreSQL container...${NC}"
        docker rm -f "$POSTGRES_CONTAINER" 2>/dev/null || true
        echo -e "${GREEN}✓ PostgreSQL container removed${NC}"
    fi
    
    # Remove associated volumes
    echo -e "${BLUE}Cleaning up Docker volumes...${NC}"
    docker volume ls -q | grep -E "(postgres|chainlink)" | xargs -r docker volume rm 2>/dev/null || true
    echo -e "${GREEN}✓ Docker volumes cleaned up${NC}"
    
    # Brief delay to ensure cleanup is complete
    sleep 2
    
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  Cleanup completed successfully!${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo
    echo -e "${BLUE}Proceeding with fresh installation...${NC}"
    echo
else
    echo -e "${GREEN}No existing Chainlink containers found. Proceeding with fresh installation.${NC}"
    echo
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

# Generate a secure password (existing containers were already cleaned up)
POSTGRES_PASSWORD=$(generate_password)
echo -e "${BLUE}Generated a secure password for PostgreSQL.${NC}"

# Save PostgreSQL password to config
echo "POSTGRES_PASSWORD=\"$POSTGRES_PASSWORD\"" > "$INSTALLER_DIR/.postgres"
echo -e "${GREEN}PostgreSQL password saved to $INSTALLER_DIR/.postgres${NC}"
echo -e "${YELLOW}Important: Keep this password safe, it will be needed for Chainlink node configuration.${NC}"

# Create PostgreSQL container
echo -e "${BLUE}Creating PostgreSQL container...${NC}"
docker run --name "$POSTGRES_CONTAINER" \
    -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    -p 5432:5432 \
    -d postgres:14

echo -e "${GREEN}PostgreSQL container created successfully.${NC}"

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

# Store container information for later use
echo -e "${BLUE}Storing container information...${NC}"
mkdir -p "$INSTALL_DIR/docker"
cat > "$INSTALL_DIR/docker/container-info.txt" << EOL
# Container Information
# Generated on $(date)

POSTGRES_CONTAINER_ID=$(docker ps -q --filter "name=cl-postgres")
POSTGRES_CONTAINER_NAME="cl-postgres"
CHAINLINK_CONTAINER_NAME="chainlink"

# Note: Chainlink container ID will be available after setup-chainlink.sh runs
EOL

# Create Docker Compose file
echo -e "${BLUE}Creating Docker Compose file...${NC}"
cat > "$INSTALL_DIR/docker/docker-compose.yml" << EOL
version: '3.8'

services:
  chainlink:
    image: smartcontract/chainlink:2.23.0
    platform: linux/x86_64/v8
    container_name: chainlink
    depends_on:
      - postgres
    ports:
      - "6688:6688"
    volumes:
      - ~/.chainlink-${NETWORK_TYPE}:/chainlink
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