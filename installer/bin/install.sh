#!/bin/bash

# Verdikta Arbiter Node Installation Script
# Main orchestrator for the installation process

set -e  # Exit on any error

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALLER_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_DIR="$INSTALLER_DIR/config"
UTIL_DIR="$INSTALLER_DIR/util"

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Banner
echo -e "${BLUE}"
echo "===================================================="
echo "  Verdikta Arbiter Node Installation"
echo "===================================================="
echo -e "${NC}"

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

# Check prerequisites
echo -e "${YELLOW}[1/9]${NC} Checking prerequisites..."
if [ ! -f "$UTIL_DIR/check-prerequisites.sh" ]; then
    echo -e "${RED}Error: check-prerequisites.sh not found in $UTIL_DIR${NC}"
    exit 1
fi

bash "$UTIL_DIR/check-prerequisites.sh"
if [ $? -ne 0 ]; then
    echo -e "${RED}Prerequisites check failed. Please address the issues and try again.${NC}"
    exit 1
fi
echo -e "${GREEN}Prerequisites check passed.${NC}"

# Setup environment
echo -e "${YELLOW}[2/9]${NC} Setting up environment..."
if [ ! -f "$SCRIPT_DIR/setup-environment.sh" ]; then
    echo -e "${RED}Error: setup-environment.sh not found in $SCRIPT_DIR${NC}"
    exit 1
fi

bash "$SCRIPT_DIR/setup-environment.sh"
if [ $? -ne 0 ]; then
    echo -e "${RED}Environment setup failed. Please check the logs for details.${NC}"
    exit 1
fi
echo -e "${GREEN}Environment setup completed.${NC}"

# Install AI Node
echo -e "${YELLOW}[3/9]${NC} Installing AI Node..."
if [ ! -f "$SCRIPT_DIR/install-ai-node.sh" ]; then
    echo -e "${RED}Error: install-ai-node.sh not found in $SCRIPT_DIR${NC}"
    exit 1
fi

bash "$SCRIPT_DIR/install-ai-node.sh"
if [ $? -ne 0 ]; then
    echo -e "${RED}AI Node installation failed. Please check the logs for details.${NC}"
    exit 1
fi
echo -e "${GREEN}AI Node installation completed.${NC}"

# Install External Adapter
echo -e "${YELLOW}[4/9]${NC} Installing External Adapter..."
if [ ! -f "$SCRIPT_DIR/install-adapter.sh" ]; then
    echo -e "${RED}Error: install-adapter.sh not found in $SCRIPT_DIR${NC}"
    exit 1
fi

bash "$SCRIPT_DIR/install-adapter.sh"
if [ $? -ne 0 ]; then
    echo -e "${RED}External Adapter installation failed. Please check the logs for details.${NC}"
    exit 1
fi
echo -e "${GREEN}External Adapter installation completed.${NC}"

# Setup Docker and PostgreSQL
echo -e "${YELLOW}[5/9]${NC} Setting up Docker and PostgreSQL..."
if [ ! -f "$SCRIPT_DIR/setup-docker.sh" ]; then
    echo -e "${RED}Error: setup-docker.sh not found in $SCRIPT_DIR${NC}"
    exit 1
fi

bash "$SCRIPT_DIR/setup-docker.sh"
if [ $? -ne 0 ]; then
    echo -e "${RED}Docker and PostgreSQL setup failed. Please check the logs for details.${NC}"
    exit 1
fi
echo -e "${GREEN}Docker and PostgreSQL setup completed.${NC}"

# Setup Chainlink Node
echo -e "${YELLOW}[6/9]${NC} Setting up Chainlink Node..."
if [ ! -f "$SCRIPT_DIR/setup-chainlink.sh" ]; then
    echo -e "${RED}Error: setup-chainlink.sh not found in $SCRIPT_DIR${NC}"
    exit 1
fi

bash "$SCRIPT_DIR/setup-chainlink.sh"
if [ $? -ne 0 ]; then
    echo -e "${RED}Chainlink Node setup failed. Please check the logs for details.${NC}"
    exit 1
fi
echo -e "${GREEN}Chainlink Node setup completed.${NC}"

# Deploy Smart Contracts
echo -e "${YELLOW}[7/9]${NC} Deploying Smart Contracts..."
if [ ! -f "$SCRIPT_DIR/deploy-contracts.sh" ]; then
    echo -e "${RED}Error: deploy-contracts.sh not found in $SCRIPT_DIR${NC}"
    exit 1
fi

bash "$SCRIPT_DIR/deploy-contracts.sh"
if [ $? -ne 0 ]; then
    echo -e "${RED}Smart Contract deployment failed. Please check the logs for details.${NC}"
    exit 1
fi
echo -e "${GREEN}Smart Contract deployment completed.${NC}"

# Configure Node Jobs and Bridges
echo -e "${YELLOW}[8/9]${NC} Configuring Node Jobs and Bridges..."
if [ ! -f "$SCRIPT_DIR/configure-node.sh" ]; then
    echo -e "${RED}Error: configure-node.sh not found in $SCRIPT_DIR${NC}"
    exit 1
fi

bash "$SCRIPT_DIR/configure-node.sh"
if [ $? -ne 0 ]; then
    echo -e "${RED}Node Jobs and Bridges configuration failed. Please check the logs for details.${NC}"
    exit 1
fi
echo -e "${GREEN}Node Jobs and Bridges configuration completed.${NC}"

# Register Oracle with Dispatcher (Optional)
echo -e "${YELLOW}[9/9]${NC} Registering Oracle with Dispatcher (Optional)..."
if [ ! -f "$SCRIPT_DIR/register-oracle-dispatcher.sh" ]; then
    echo -e "${RED}Error: register-oracle-dispatcher.sh not found in $SCRIPT_DIR${NC}"
    # Decide if this should be a fatal error or just a warning if the script is optional.
    # For now, let's make it non-fatal for the main install if script is missing,
    # but the new script itself will handle its own errors.
    echo -e "${YELLOW}Skipping optional Oracle registration as script is missing.${NC}"
else
    bash "$SCRIPT_DIR/register-oracle-dispatcher.sh"
    if [ $? -ne 0 ]; then
        echo -e "${YELLOW}Oracle registration step finished with errors or was skipped. Please check the logs for details.${NC}"
        # Not exiting install.sh, as this step is optional or might have its own non-fatal outcomes.
    else
        echo -e "${GREEN}Oracle registration step completed.${NC}"
    fi
fi

# Verify installation
echo -e "${YELLOW}Verifying installation...${NC}"
if [ ! -f "$UTIL_DIR/verify-installation.sh" ]; then
    echo -e "${RED}Error: verify-installation.sh not found in $UTIL_DIR${NC}"
    exit 1
fi

bash "$UTIL_DIR/verify-installation.sh"
if [ $? -ne 0 ]; then
    echo -e "${YELLOW}Some verification checks failed. Please check the logs for details.${NC}"
else
    echo -e "${GREEN}All verification checks passed.${NC}"
fi

# Create arbiter management scripts
echo -e "${YELLOW}Creating arbiter management scripts...${NC}"

# Load environment variables (if not already loaded)
if [ -f "$INSTALLER_DIR/.env" ]; then
    source "$INSTALLER_DIR/.env"
fi

# Copy the management scripts from util directory
if [ ! -f "$UTIL_DIR/start-arbiter.sh" ] || [ ! -f "$UTIL_DIR/stop-arbiter.sh" ] || [ ! -f "$UTIL_DIR/arbiter-status.sh" ]; then
    echo -e "${RED}Error: Arbiter management scripts not found in $UTIL_DIR${NC}"
    exit 1
fi

cp "$UTIL_DIR/start-arbiter.sh" "$INSTALL_DIR/start-arbiter.sh"
cp "$UTIL_DIR/stop-arbiter.sh" "$INSTALL_DIR/stop-arbiter.sh"
cp "$UTIL_DIR/arbiter-status.sh" "$INSTALL_DIR/arbiter-status.sh"

# Make scripts executable in the correct destination directory
chmod +x "$INSTALL_DIR/start-arbiter.sh"
chmod +x "$INSTALL_DIR/stop-arbiter.sh"
chmod +x "$INSTALL_DIR/arbiter-status.sh"

# Copy contracts information
echo -e "${BLUE}Copying contract information...${NC}"
if [ -f "$INSTALLER_DIR/.contracts" ]; then
    mkdir -p "$INSTALL_DIR/installer"
    cp "$INSTALLER_DIR/.contracts" "$INSTALL_DIR/installer/.contracts"
    echo -e "${GREEN}Contract information copied to $INSTALL_DIR/installer/.contracts${NC}"
fi

echo -e "${GREEN}Arbiter management scripts created:${NC}"
echo -e "  - To start all services: $INSTALL_DIR/start-arbiter.sh"
echo -e "  - To stop all services:  $INSTALL_DIR/stop-arbiter.sh"
echo -e "  - To check status:       $INSTALL_DIR/arbiter-status.sh"

# Success!
echo -e "${GREEN}"
echo "===================================================="
echo "  Verdikta Arbiter Node Installation Complete!"
echo "===================================================="
echo -e "${NC}"
echo "Congratulations! Your Verdikta Arbiter Node has been successfully installed."
echo 
echo "Access your services at:"
echo "  - AI Node:         http://localhost:3000"
echo "  - External Adapter: http://localhost:8080"
echo "  - Chainlink Node:   http://localhost:6688"
echo
echo "For troubleshooting, consult the documentation in the installer/docs directory."
echo "To back up your installation, run: bash $UTIL_DIR/backup-restore.sh backup"
echo
echo "Thank you for using Verdikta Arbiter Node!" 