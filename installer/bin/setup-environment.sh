#!/bin/bash

# Verdikta Validator Node - Environment Setup Script
# Installs and configures all necessary software prerequisites

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

echo -e "${BLUE}Setting up environment for Verdikta Validator Node...${NC}"

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

# Function to detect OS
detect_os() {
    OS="$(uname -s)"
    case "$OS" in
        Linux)
            if [ -f /etc/os-release ]; then
                . /etc/os-release
                OS_ID="$ID"
                OS_VERSION="$VERSION_ID"
                OS_NAME="$PRETTY_NAME"
            else
                OS_ID="unknown"
                OS_VERSION="unknown"
                OS_NAME="Unknown Linux"
            fi
            ;;
        Darwin)
            OS_ID="macos"
            OS_VERSION=$(sw_vers -productVersion)
            OS_NAME="macOS $OS_VERSION"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            OS_ID="windows"
            OS_VERSION="unknown"
            OS_NAME="Windows"
            ;;
        *)
            OS_ID="unknown"
            OS_VERSION="unknown"
            OS_NAME="Unknown OS"
            ;;
    esac
    
    echo -e "${BLUE}Detected OS: $OS_NAME${NC}"
}

# Function to install Node.js using nvm
install_node() {
    echo -e "${BLUE}Setting up Node.js...${NC}"
    
    if command_exists node; then
        NODE_VERSION=$(node --version | cut -d 'v' -f 2)
        NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d'.' -f1)
        NODE_MINOR=$(echo "$NODE_VERSION" | cut -d'.' -f2)
        
        if [ "$NODE_MAJOR" -ge 20 ] && [ "$NODE_MINOR" -ge 18 ]; then
            echo -e "${GREEN}Node.js v$NODE_VERSION is already installed and meets requirements.${NC}"
            return 0
        else
            echo -e "${YELLOW}Node.js v$NODE_VERSION is installed but does not meet requirements (v20.18.0+).${NC}"
            if ! ask_yes_no "Would you like to install Node.js v20.18.0 using nvm?"; then
                echo -e "${YELLOW}Skipping Node.js installation. This may cause issues later.${NC}"
                return 1
            fi
        fi
    else
        echo -e "${YELLOW}Node.js is not installed.${NC}"
        if ! ask_yes_no "Would you like to install Node.js v20.18.0 using nvm?"; then
            echo -e "${YELLOW}Skipping Node.js installation. This may cause issues later.${NC}"
            return 1
        fi
    fi
    
    # Install nvm if it doesn't exist
    if ! command_exists nvm && [ ! -d "$HOME/.nvm" ]; then
        echo -e "${BLUE}Installing nvm (Node Version Manager)...${NC}"
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.3/install.sh | bash
        
        # Source nvm
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
        
        # Make sure nvm command is available
        if ! command_exists nvm; then
            echo -e "${RED}Failed to install nvm. Please install Node.js v20.18.0 manually.${NC}"
            return 1
        fi
    else
        # Source nvm if it exists but command isn't available
        if ! command_exists nvm; then
            export NVM_DIR="$HOME/.nvm"
            [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
            [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
        fi
    fi
    
    # Install Node.js 20.18
    echo -e "${BLUE}Installing Node.js v20.18.0...${NC}"
    nvm install 20.18
    nvm use 20.18
    nvm alias default 20.18
    
    # Verify installation
    if command_exists node; then
        NODE_VERSION=$(node --version)
        echo -e "${GREEN}Successfully installed Node.js $NODE_VERSION${NC}"
        return 0
    else
        echo -e "${RED}Failed to install Node.js. Please install manually.${NC}"
        return 1
    fi
}

# Function to install Docker
install_docker() {
    echo -e "${BLUE}Setting up Docker...${NC}"
    
    if command_exists docker; then
        echo -e "${GREEN}Docker is already installed.${NC}"
        
        # Check if Docker daemon is running
        if ! docker info > /dev/null 2>&1; then
            echo -e "${YELLOW}Docker daemon is not running.${NC}"
            case "$OS_ID" in
                ubuntu|debian)
                    echo -e "${BLUE}Starting Docker daemon...${NC}"
                    sudo systemctl start docker
                    sudo systemctl enable docker
                    ;;
                macos)
                    echo -e "${YELLOW}Please start Docker Desktop manually.${NC}"
                    ;;
                *)
                    echo -e "${YELLOW}Please start Docker daemon manually.${NC}"
                    ;;
            esac
        fi
    else
        echo -e "${YELLOW}Docker is not installed.${NC}"
        if ! ask_yes_no "Would you like to install Docker?"; then
            echo -e "${YELLOW}Skipping Docker installation. This may cause issues later.${NC}"
            return 1
        fi
        
        case "$OS_ID" in
            ubuntu|debian)
                echo -e "${BLUE}Installing Docker on Ubuntu/Debian...${NC}"
                # Update package index
                sudo apt-get update
                
                # Install prerequisites
                sudo apt-get install -y \
                    apt-transport-https \
                    ca-certificates \
                    curl \
                    gnupg \
                    lsb-release
                
                # Add Docker's official GPG key
                curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
                
                # Set up the stable repository
                echo \
                    "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \
                    $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
                
                # Install Docker Engine
                sudo apt-get update
                sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
                
                # Add user to docker group to run Docker without sudo
                sudo usermod -aG docker $USER
                echo -e "${YELLOW}You may need to log out and log back in for group changes to take effect.${NC}"
                
                # Start and enable Docker service
                sudo systemctl start docker
                sudo systemctl enable docker
                ;;
            macos)
                echo -e "${BLUE}Installing Docker on macOS...${NC}"
                echo -e "${YELLOW}Please download and install Docker Desktop from https://www.docker.com/products/docker-desktop/${NC}"
                echo -e "${YELLOW}After installation, please start Docker Desktop and run this script again.${NC}"
                return 1
                ;;
            *)
                echo -e "${RED}Unsupported OS for automatic Docker installation.${NC}"
                echo -e "${YELLOW}Please install Docker manually following the instructions at https://docs.docker.com/get-docker/${NC}"
                return 1
                ;;
        esac
    fi
    
    # Verify Docker installation
    if command_exists docker && docker info > /dev/null 2>&1; then
        DOCKER_VERSION=$(docker --version | awk '{print $3}' | sed 's/,//')
        echo -e "${GREEN}Successfully verified Docker $DOCKER_VERSION${NC}"
        return 0
    else
        echo -e "${RED}Docker installation could not be verified. Please install Docker manually.${NC}"
        return 1
    fi
}

# Function to create installation directory
create_installation_directory() {
    echo -e "${BLUE}Creating installation directory...${NC}"
    
    # Default installation directory
    INSTALL_DIR="$HOME/verdikta-arbiter-node"
    
    # Ask for custom installation directory
    read -p "Installation directory [$INSTALL_DIR]: " custom_dir
    if [ -n "$custom_dir" ]; then
        INSTALL_DIR="$custom_dir"
    fi
    
    # Create directory if it doesn't exist
    if [ ! -d "$INSTALL_DIR" ]; then
        mkdir -p "$INSTALL_DIR"
        echo -e "${GREEN}Created installation directory: $INSTALL_DIR${NC}"
    else
        echo -e "${GREEN}Using existing installation directory: $INSTALL_DIR${NC}"
    fi
    
    # Save installation directory to config file
    echo "INSTALL_DIR=\"$INSTALL_DIR\"" > "$INSTALLER_DIR/.env"
    
    # Create subdirectories (components will be copied later during installation)
    mkdir -p "$INSTALL_DIR/contracts"
    mkdir -p "$INSTALL_DIR/data"
    mkdir -p "$INSTALL_DIR/logs"
    
    echo -e "${GREEN}Installation directory structure created.${NC}"
}

# Function to configure API keys
configure_api_keys() {
    echo -e "${BLUE}Configuring API keys...${NC}"
    
    # Load existing keys if they exist
    CONFIG_FILE="$INSTALLER_DIR/.api_keys"
    if [ -f "$CONFIG_FILE" ]; then
        source "$CONFIG_FILE"
    fi
    
    # OpenAI API Key
    if [ -z "$OPENAI_API_KEY" ]; then
        read -p "Enter your OpenAI API Key (leave blank to skip): " OPENAI_API_KEY
    else
        read -p "Enter your OpenAI API Key (leave blank to use existing key): " new_key
        if [ -n "$new_key" ]; then
            OPENAI_API_KEY="$new_key"
        fi
    fi
    
    # Anthropic API Key
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        read -p "Enter your Anthropic API Key (leave blank to skip): " ANTHROPIC_API_KEY
    else
        read -p "Enter your Anthropic API Key (leave blank to use existing key): " new_key
        if [ -n "$new_key" ]; then
            ANTHROPIC_API_KEY="$new_key"
        fi
    fi
    
    # Infura API Key
    if [ -z "$INFURA_API_KEY" ]; then
        read -p "Enter your Infura API Key (leave blank to skip): " INFURA_API_KEY
    else
        read -p "Enter your Infura API Key (leave blank to use existing key): " new_key
        if [ -n "$new_key" ]; then
            INFURA_API_KEY="$new_key"
        fi
    fi
    
    # Pinata API Key
    if [ -z "$PINATA_API_KEY" ]; then
        read -p "Enter your Pinata JWT (leave blank to skip): " PINATA_API_KEY
    else
        read -p "Enter your Pinata JWT (leave blank to use existing key): " new_key
        if [ -n "$new_key" ]; then
            PINATA_API_KEY="$new_key"
        fi
    fi
    
    echo -e "${YELLOW}Note: You need to provide a private key for a wallet with Base Sepolia ETH for contract deployment.${NC}"
    echo -e "${YELLOW}IMPORTANT: Never use your main wallet key. Use a testing wallet with minimal funds.${NC}"
    echo -e "${YELLOW}NOTE: Do NOT include the '0x' prefix - Truffle does not expect it.${NC}"
    
    # Wallet Private Key
    if [ -z "$PRIVATE_KEY" ]; then
        read -p "Enter your wallet private key for contract deployment (without 0x prefix): " PRIVATE_KEY
        
        # Validate private key format (without 0x prefix)
        while [[ ! "$PRIVATE_KEY" =~ ^[a-fA-F0-9]{64}$ ]]; do
            echo -e "${RED}Error: Invalid private key format. It should be a 64-character hex string without 0x prefix.${NC}"
            read -p "Enter your wallet private key (without 0x prefix): " PRIVATE_KEY
        done
    else
        read -p "Enter your wallet private key (leave blank to use existing key): " new_key
        if [ -n "$new_key" ]; then
            # Validate new key if provided
            while [[ ! "$new_key" =~ ^[a-fA-F0-9]{64}$ ]]; do
                echo -e "${RED}Error: Invalid private key format. It should be a 64-character hex string without 0x prefix.${NC}"
                read -p "Enter your wallet private key (without 0x prefix): " new_key
                
                # If empty, keep existing
                if [ -z "$new_key" ]; then
                    break
                fi
            done
            
            if [ -n "$new_key" ]; then
                PRIVATE_KEY="$new_key"
            fi
        fi
    fi
    
    # Save API keys
    cat > "$CONFIG_FILE" << EOL
# Note: GitHub Token is temporarily required while repositories are private
# GITHUB_TOKEN="$GITHUB_TOKEN" # Removed
OPENAI_API_KEY="$OPENAI_API_KEY"
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
INFURA_API_KEY="$INFURA_API_KEY"
PINATA_API_KEY="$PINATA_API_KEY"
EOL
    
    # Save private key separately in the .env file for better security
    if [ -n "$PRIVATE_KEY" ]; then
        # Append to .env file, creating it if it doesn't exist
        if grep -q "PRIVATE_KEY=" "$INSTALLER_DIR/.env" 2>/dev/null; then
            # Update existing private key entry
            sed -i "s/PRIVATE_KEY=.*/PRIVATE_KEY=\"$PRIVATE_KEY\"/" "$INSTALLER_DIR/.env"
        else
            # Append new private key entry
            echo "PRIVATE_KEY=\"$PRIVATE_KEY\"" >> "$INSTALLER_DIR/.env"
        fi
        
        # Set restrictive permissions on .env file
        chmod 600 "$INSTALLER_DIR/.env"
        echo -e "${GREEN}Private key saved securely to .env.${NC}"
    fi

    # Save Infura API Key to .env file as well for general use by scripts
    if [ -n "$INFURA_API_KEY" ]; then
        if grep -q "INFURA_API_KEY=" "$INSTALLER_DIR/.env" 2>/dev/null; then
            sed -i "s/INFURA_API_KEY=.*/INFURA_API_KEY=\"$INFURA_API_KEY\"/" "$INSTALLER_DIR/.env"
        else
            echo "INFURA_API_KEY=\"$INFURA_API_KEY\"" >> "$INSTALLER_DIR/.env"
        fi
        chmod 600 "$INSTALLER_DIR/.env" # Ensure permissions are set if file was newly created or only had PRIVATE_KEY
        echo -e "${GREEN}Infura API Key saved to .env.${NC}"
    fi
    
    echo -e "${GREEN}API keys configured and saved.${NC}"
}

# Main execution
detect_os
install_node
install_docker
create_installation_directory
configure_api_keys

echo -e "${GREEN}Environment setup completed successfully!${NC}"
echo -e "${BLUE}Next step: Setting up the AI Node${NC}"
exit 0 