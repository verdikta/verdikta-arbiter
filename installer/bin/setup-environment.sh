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
            echo -e "${RED}Failed to install nvm. Please install Node.js v20.18.1 manually.${NC}"
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
    
    # Install Node.js 20.18.1
    echo -e "${BLUE}Installing Node.js v20.18.1...${NC}"
    nvm install 20.18.1
    nvm use 20.18.1
    nvm alias default 20.18.1
    
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

# Function to ask for Yes/No question
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

# Function to check if a directory contains a Verdikta arbiter installation
is_arbiter_installation() {
    local dir="$1"
    
    # Check for management scripts that indicate an existing installation
    if [ -f "$dir/start-arbiter.sh" ] && [ -f "$dir/stop-arbiter.sh" ] && [ -f "$dir/arbiter-status.sh" ]; then
        return 0
    fi
    
    # Check for component directories that indicate a partial installation
    if [ -d "$dir/ai-node" ] || [ -d "$dir/external-adapter" ] || [ -d "$dir/chainlink-node" ] || [ -d "$dir/arbiter-operator" ]; then
        return 0
    fi
    
    return 1
}

# Function to create installation directory
create_installation_directory() {
    echo -e "${BLUE}Setting up installation directory...${NC}"
    
    while true; do
        # Default installation directory
        INSTALL_DIR="$HOME/verdikta-arbiter-node"
        
        # Ask for custom installation directory
        read -p "Installation directory [$INSTALL_DIR]: " custom_dir
        if [ -n "$custom_dir" ]; then
            INSTALL_DIR="$custom_dir"
        fi
        
        # Check if directory exists and what it contains
        if [ -d "$INSTALL_DIR" ]; then
            # Check if it's empty
            if [ -z "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
                echo -e "${GREEN}Using empty directory: $INSTALL_DIR${NC}"
                break
            # Check if it contains an existing Verdikta arbiter installation
            elif is_arbiter_installation "$INSTALL_DIR"; then
                echo -e "${YELLOW}Directory $INSTALL_DIR contains an existing Verdikta arbiter installation.${NC}"
                echo -e "${YELLOW}This appears to be a fresh installation rather than an upgrade.${NC}"
                echo
                echo "Options:"
                echo "  1. Overwrite existing installation (all data will be lost)"
                echo "  2. Choose a different directory"
                echo "  3. Cancel installation"
                echo
                read -p "Please choose an option [1-3]: " choice
                
                case "$choice" in
                    1)
                        if ask_yes_no "Are you sure you want to delete $INSTALL_DIR and all its contents?"; then
                            echo -e "${YELLOW}Removing existing installation...${NC}"
                            rm -rf "$INSTALL_DIR"
                            mkdir -p "$INSTALL_DIR"
                            echo -e "${GREEN}Created fresh installation directory: $INSTALL_DIR${NC}"
                            break
                        else
                            echo -e "${BLUE}Cancelled overwrite. Please choose a different option.${NC}"
                            continue
                        fi
                        ;;
                    2)
                        echo -e "${BLUE}Please choose a different directory.${NC}"
                        continue
                        ;;
                    3)
                        echo -e "${YELLOW}Installation cancelled by user.${NC}"
                        exit 0
                        ;;
                    *)
                        echo -e "${RED}Invalid choice. Please enter 1, 2, or 3.${NC}"
                        continue
                        ;;
                esac
            # Directory exists but doesn't appear to be a Verdikta installation
            else
                echo -e "${YELLOW}Directory $INSTALL_DIR exists and contains other files.${NC}"
                if ask_yes_no "Do you want to use this directory anyway? (Existing files may conflict with the installation)"; then
                    echo -e "${GREEN}Using existing directory: $INSTALL_DIR${NC}"
                    break
                else
                    echo -e "${BLUE}Please choose a different directory.${NC}"
                    continue
                fi
            fi
        else
            # Directory doesn't exist, create it
            mkdir -p "$INSTALL_DIR"
            echo -e "${GREEN}Created installation directory: $INSTALL_DIR${NC}"
            break
        fi
    done
    
    # Save installation directory to config file
    echo "INSTALL_DIR=\"$INSTALL_DIR\"" > "$INSTALLER_DIR/.env"
    
    # Create subdirectories (components will be copied later during installation)
    mkdir -p "$INSTALL_DIR/contracts"
    mkdir -p "$INSTALL_DIR/data"
    mkdir -p "$INSTALL_DIR/logs"
    
    echo -e "${GREEN}Installation directory structure created.${NC}"
}

# Function to display ClassID information and help users understand API key requirements
display_classid_info() {
    echo -e "${BLUE}Displaying available ClassID Model Pools...${NC}"
    
    # Check if we can access the ClassID information
    if command_exists node; then
        # Try to display ClassID information
        if node "$INSTALLER_DIR/util/display-classids.js" 2>/dev/null; then
            echo -e "${GREEN}ClassID information displayed successfully.${NC}"
            return 0
        else
            echo -e "${YELLOW}Note: ClassID information not available yet (will be available after AI Node installation).${NC}"
            echo -e "${YELLOW}For now, you can configure API keys based on your intended usage:${NC}"
            echo -e "${YELLOW}• OpenAI API Key: For GPT-4, GPT-4o, and other OpenAI models${NC}"
            echo -e "${YELLOW}• Anthropic API Key: For Claude models${NC}"
            echo -e "${YELLOW}• Leave keys blank if you only plan to use open-source models${NC}"
            return 1
        fi
    else
        echo -e "${YELLOW}Node.js not available yet. ClassID information will be shown after Node.js installation.${NC}"
        return 1
    fi
}

# Function to configure API keys
configure_api_keys() {
    echo -e "${BLUE}Configuring API keys...${NC}"
    
    # Display ClassID information to help users understand what they need
    echo ""
    display_classid_info
    echo ""
    
    # Load existing keys if they exist
    CONFIG_FILE="$INSTALLER_DIR/.api_keys"
    if [ -f "$CONFIG_FILE" ]; then
        source "$CONFIG_FILE"
    fi
    
    # Load existing environment configuration if it exists
    if [ -f "$INSTALLER_DIR/.env" ]; then
        source "$INSTALLER_DIR/.env"
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
    
    # Network Selection
    echo -e "${BLUE}Blockchain Network Configuration${NC}"
    echo -e "${YELLOW}Choose which Base network to deploy to:${NC}"
    echo -e "  1) Base Sepolia (Testnet) - Recommended for testing"
    echo -e "  2) Base Mainnet (Production) - Real ETH required"
    
    # Load existing network selection if available
    if [ -n "$DEPLOYMENT_NETWORK" ]; then
        if [ "$DEPLOYMENT_NETWORK" = "base_sepolia" ]; then
            echo -e "${GREEN}Current selection: Base Sepolia (Testnet)${NC}"
        elif [ "$DEPLOYMENT_NETWORK" = "base_mainnet" ]; then
            echo -e "${GREEN}Current selection: Base Mainnet${NC}"
        fi
    fi
    
    while true; do
        read -p "Select network (1 for Base Sepolia, 2 for Base Mainnet) [1]: " network_choice
        
        # Default to option 1 if empty
        if [ -z "$network_choice" ]; then
            network_choice=1
        fi
        
        case "$network_choice" in
            1)
                DEPLOYMENT_NETWORK="base_sepolia"
                NETWORK_NAME="Base Sepolia"
                NETWORK_CHAIN_ID="84532"
                NETWORK_TYPE="testnet"
                echo -e "${GREEN}Selected: Base Sepolia (Testnet)${NC}"
                break
                ;;
            2)
                DEPLOYMENT_NETWORK="base_mainnet"
                NETWORK_NAME="Base Mainnet"
                NETWORK_CHAIN_ID="8453"
                NETWORK_TYPE="mainnet"
                echo -e "${GREEN}Selected: Base Mainnet${NC}"
                
                # Warning for mainnet
                echo -e "${RED}WARNING: You selected Base Mainnet (production network)${NC}"
                echo -e "${RED}This will require real ETH for gas fees and contract deployment.${NC}"
                echo -e "${RED}Make sure you understand the costs involved.${NC}"
                
                if ! ask_yes_no "Are you sure you want to use Base Mainnet?"; then
                    echo -e "${YELLOW}Switching back to network selection...${NC}"
                    continue
                fi
                break
                ;;
            *)
                echo -e "${RED}Invalid choice. Please enter 1 or 2.${NC}"
                ;;
        esac
    done
    
    # Display network-specific requirements
    if [ "$NETWORK_TYPE" = "testnet" ]; then
        echo -e "${YELLOW}Note: You need to provide a private key for a wallet with Base Sepolia ETH for contract deployment.${NC}"
        echo -e "${YELLOW}You can get Base Sepolia ETH from: https://www.alchemy.com/faucets/base-sepolia${NC}"
    else
        echo -e "${YELLOW}Note: You need to provide a private key for a wallet with Base Mainnet ETH for contract deployment.${NC}"
        echo -e "${YELLOW}Estimated gas costs: ~0.01-0.05 ETH for full deployment${NC}"
    fi
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
    
    # Save network configuration to .env file
    if [ -n "$DEPLOYMENT_NETWORK" ]; then
        # Update or add each network configuration variable
        for var in DEPLOYMENT_NETWORK NETWORK_NAME NETWORK_CHAIN_ID NETWORK_TYPE; do
            var_value=$(eval echo \$$var)
            if grep -q "^$var=" "$INSTALLER_DIR/.env" 2>/dev/null; then
                sed -i "s/^$var=.*/$var=\"$var_value\"/" "$INSTALLER_DIR/.env"
            else
                echo "$var=\"$var_value\"" >> "$INSTALLER_DIR/.env"
            fi
        done
        chmod 600 "$INSTALLER_DIR/.env"
        echo -e "${GREEN}Network configuration saved to .env (Network: $NETWORK_NAME).${NC}"
    fi
    
    # Configure Verdikta Common Library version
    echo -e "${BLUE}Verdikta Common Library Configuration${NC}"
    echo -e "${YELLOW}The External Adapter uses the Verdikta Common Library for shared utilities.${NC}"
    echo -e "${YELLOW}Available versions: 'latest' (stable, recommended) or 'beta' (testing)${NC}"
    
    VERDIKTA_COMMON_VERSION="${VERDIKTA_COMMON_VERSION:-latest}"
    read -p "Verdikta Common Library version [latest]: " user_version
    if [ -n "$user_version" ]; then
        VERDIKTA_COMMON_VERSION="$user_version"
    fi
    
    # Save Verdikta Common version preference
    if grep -q "VERDIKTA_COMMON_VERSION=" "$INSTALLER_DIR/.env" 2>/dev/null; then
        sed -i "s/VERDIKTA_COMMON_VERSION=.*/VERDIKTA_COMMON_VERSION=\"$VERDIKTA_COMMON_VERSION\"/" "$INSTALLER_DIR/.env"
    else
        echo "VERDIKTA_COMMON_VERSION=\"$VERDIKTA_COMMON_VERSION\"" >> "$INSTALLER_DIR/.env"
    fi
    echo -e "${GREEN}Verdikta Common Library version ($VERDIKTA_COMMON_VERSION) saved to configuration.${NC}"
    
    # Configure Justification Model
    echo ""
    echo -e "${BLUE}Justification Model Configuration${NC}"
    echo -e "${YELLOW}Choose which AI model to use for generating final justifications:${NC}"
    echo -e "${YELLOW}This model combines individual model responses into a coherent explanation.${NC}"
    echo ""
    
    # Display available justification models with updated options
    echo -e "${BLUE}Available Justification Models:${NC}"
    echo -e "  1) gpt-5-nano-2025-08-07 (OpenAI) - Recommended default (requires OpenAI API key)"
    echo -e "  2) gpt-5-mini-2025-08-07 (OpenAI) - Balanced performance (requires OpenAI API key)"
    echo -e "  3) gpt-5-2025-08-07 (OpenAI) - Highest quality (requires OpenAI API key)"
    echo -e "  4) claude-sonnet-4-20250514 (Anthropic) - Excellent reasoning (requires Anthropic API key)"
    echo -e "  5) claude-3-7-sonnet-20250219 (Anthropic) - Strong performance (requires Anthropic API key)"
    echo -e "  6) gemma3n:e4b (Ollama) - Recommended for open source (no API key required)"
    echo -e "  7) deepseek-r1:8b (Ollama) - Good reasoning, free (no API key required)"
    echo -e "  8) llama3.1:8b (Ollama) - Reliable, free (no API key required)"
    echo ""
    
    # Provide intelligent recommendations based on API keys
    echo -e "${BLUE}💡 Recommendations based on your configuration:${NC}"
    if [ -n "$OPENAI_API_KEY" ] && [ -n "$ANTHROPIC_API_KEY" ]; then
        echo -e "${GREEN}   • You have both OpenAI and Anthropic keys - Option 1 (gpt-5-nano) recommended${NC}"
        DEFAULT_CHOICE=1
    elif [ -n "$OPENAI_API_KEY" ] && [ -z "$ANTHROPIC_API_KEY" ]; then
        echo -e "${YELLOW}   • You have OpenAI key only - Option 1 (gpt-5-nano) recommended${NC}"
        DEFAULT_CHOICE=1
    elif [ -z "$OPENAI_API_KEY" ] && [ -n "$ANTHROPIC_API_KEY" ]; then
        echo -e "${YELLOW}   • You have Anthropic key only - Option 4 (claude-sonnet-4) recommended${NC}"
        DEFAULT_CHOICE=4
    else
        echo -e "${CYAN}   • No API keys provided - Option 6 (gemma3n:e4b) recommended for open source${NC}"
        DEFAULT_CHOICE=6
    fi
    echo ""
    
    # Load existing justification model if available
    if [ -n "$JUSTIFICATION_MODEL_PROVIDER" ] && [ -n "$JUSTIFICATION_MODEL_NAME" ]; then
        echo -e "${GREEN}Current selection: ${JUSTIFICATION_MODEL_PROVIDER} - ${JUSTIFICATION_MODEL_NAME}${NC}"
    fi
    
    while true; do
        read -p "Select justification model (1-8) [${DEFAULT_CHOICE}]: " justification_choice
        
        # Default to recommended choice if empty
        if [ -z "$justification_choice" ]; then
            justification_choice=$DEFAULT_CHOICE
        fi
        
        case "$justification_choice" in
            1)
                JUSTIFICATION_MODEL_PROVIDER="OpenAI"
                JUSTIFICATION_MODEL_NAME="gpt-5-nano-2025-08-07"
                echo -e "${GREEN}Selected: OpenAI GPT-5 Nano${NC}"
                break
                ;;
            2)
                JUSTIFICATION_MODEL_PROVIDER="OpenAI"
                JUSTIFICATION_MODEL_NAME="gpt-5-mini-2025-08-07"
                echo -e "${GREEN}Selected: OpenAI GPT-5 Mini${NC}"
                break
                ;;
            3)
                JUSTIFICATION_MODEL_PROVIDER="OpenAI"
                JUSTIFICATION_MODEL_NAME="gpt-5-2025-08-07"
                echo -e "${GREEN}Selected: OpenAI GPT-5${NC}"
                break
                ;;
            4)
                JUSTIFICATION_MODEL_PROVIDER="Anthropic"
                JUSTIFICATION_MODEL_NAME="claude-sonnet-4-20250514"
                echo -e "${GREEN}Selected: Anthropic Claude Sonnet 4${NC}"
                break
                ;;
            5)
                JUSTIFICATION_MODEL_PROVIDER="Anthropic"
                JUSTIFICATION_MODEL_NAME="claude-3-7-sonnet-20250219"
                echo -e "${GREEN}Selected: Anthropic Claude 3.7 Sonnet${NC}"
                break
                ;;
            6)
                JUSTIFICATION_MODEL_PROVIDER="Ollama"
                JUSTIFICATION_MODEL_NAME="gemma3n:e4b"
                echo -e "${GREEN}Selected: Ollama Gemma 3N${NC}"
                break
                ;;
            7)
                JUSTIFICATION_MODEL_PROVIDER="Ollama"
                JUSTIFICATION_MODEL_NAME="deepseek-r1:8b"
                echo -e "${GREEN}Selected: Ollama DeepSeek R1${NC}"
                break
                ;;
            8)
                JUSTIFICATION_MODEL_PROVIDER="Ollama"
                JUSTIFICATION_MODEL_NAME="llama3.1:8b"
                echo -e "${GREEN}Selected: Ollama Llama 3.1 8B${NC}"
                break
                ;;
            *)
                echo -e "${RED}Invalid choice. Please enter 1-8.${NC}"
                ;;
        esac
    done
    
    # Validate that the user has the required API key for their selection
    if [ "$JUSTIFICATION_MODEL_PROVIDER" = "OpenAI" ] && [ -z "$OPENAI_API_KEY" ]; then
        echo -e "${YELLOW}Warning: You selected an OpenAI model but no OpenAI API key was provided.${NC}"
        echo -e "${YELLOW}You can set this later or the system will fall back to available models.${NC}"
    elif [ "$JUSTIFICATION_MODEL_PROVIDER" = "Anthropic" ] && [ -z "$ANTHROPIC_API_KEY" ]; then
        echo -e "${YELLOW}Warning: You selected an Anthropic model but no Anthropic API key was provided.${NC}"
        echo -e "${YELLOW}You can set this later or the system will fall back to available models.${NC}"
    fi
    
    # Save justification model configuration
    for var in JUSTIFICATION_MODEL_PROVIDER JUSTIFICATION_MODEL_NAME; do
        var_value=$(eval echo \$$var)
        if grep -q "^$var=" "$INSTALLER_DIR/.env" 2>/dev/null; then
            sed -i "s/^$var=.*/$var=\"$var_value\"/" "$INSTALLER_DIR/.env"
        else
            echo "$var=\"$var_value\"" >> "$INSTALLER_DIR/.env"
        fi
    done
    echo -e "${GREEN}Justification model configuration saved: ${JUSTIFICATION_MODEL_PROVIDER} - ${JUSTIFICATION_MODEL_NAME}${NC}"
    
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