#!/bin/bash

# Verdikta Arbiter - NVM Installation Fix Script
# Fixes NVM installation issues on older VPS systems

set -e  # Exit on any error

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Verdikta Arbiter - NVM Installation Fix${NC}"
echo -e "${BLUE}=====================================${NC}"

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check prerequisites
echo -e "${BLUE}Checking prerequisites...${NC}"

if ! command_exists curl && ! command_exists wget; then
    echo -e "${RED}Error: Neither curl nor wget is available. Please install one of them first.${NC}"
    echo -e "${YELLOW}On Ubuntu/Debian: sudo apt-get update && sudo apt-get install curl${NC}"
    echo -e "${YELLOW}On CentOS/RHEL: sudo yum install curl${NC}"
    exit 1
fi

# Check internet connectivity
echo -e "${BLUE}Testing internet connectivity...${NC}"
if ! ping -c 1 google.com > /dev/null 2>&1 && ! ping -c 1 cloudflare.com > /dev/null 2>&1; then
    echo -e "${RED}Error: No internet connectivity detected.${NC}"
    echo -e "${YELLOW}Please check your internet connection and try again.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Internet connectivity confirmed.${NC}"

# Remove any broken NVM installation
if [ -d "$HOME/.nvm" ]; then
    echo -e "${YELLOW}Found existing NVM directory. Checking if it's working...${NC}"
    
    # Try to source NVM
    export NVM_DIR="$HOME/.nvm"
    if [ -s "$NVM_DIR/nvm.sh" ]; then
        source "$NVM_DIR/nvm.sh"
    fi
    
    if command_exists nvm; then
        echo -e "${GREEN}✓ NVM is already working properly.${NC}"
        
        # Check if Node.js 20.18.1 is available
        if nvm list | grep -q "v20.18.1"; then
            echo -e "${GREEN}✓ Node.js v20.18.1 is already installed.${NC}"
            nvm use 20.18.1
            nvm alias default 20.18.1
            echo -e "${GREEN}✓ Node.js v20.18.1 set as default.${NC}"
            echo -e "${BLUE}NVM fix completed successfully!${NC}"
            exit 0
        else
            echo -e "${YELLOW}Installing Node.js v20.18.1...${NC}"
            nvm install 20.18.1
            nvm use 20.18.1
            nvm alias default 20.18.1
            echo -e "${GREEN}✓ Node.js v20.18.1 installed and set as default.${NC}"
            echo -e "${BLUE}NVM fix completed successfully!${NC}"
            exit 0
        fi
    else
        echo -e "${YELLOW}NVM directory exists but command is not working. Reinstalling...${NC}"
        # Backup and remove broken installation
        if [ -d "$HOME/.nvm.backup" ]; then
            rm -rf "$HOME/.nvm.backup"
        fi
        mv "$HOME/.nvm" "$HOME/.nvm.backup"
        echo -e "${YELLOW}Backed up broken NVM installation to ~/.nvm.backup${NC}"
    fi
fi

# Fresh NVM installation
echo -e "${BLUE}Installing NVM (Node Version Manager)...${NC}"
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.3/install.sh | bash

# Source NVM immediately
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && source "$NVM_DIR/bash_completion"

# Verify NVM installation
if ! command_exists nvm; then
    echo -e "${RED}Error: NVM installation failed.${NC}"
    echo -e "${YELLOW}Please try the following manual steps:${NC}"
    echo -e "${YELLOW}1. Close and reopen your terminal${NC}"
    echo -e "${YELLOW}2. Run: source ~/.bashrc${NC}"
    echo -e "${YELLOW}3. Run: nvm --version${NC}"
    exit 1
fi

echo -e "${GREEN}✓ NVM installed successfully.${NC}"

# Install Node.js 20.18.1
echo -e "${BLUE}Installing Node.js v20.18.1...${NC}"
nvm install 20.18.1
nvm use 20.18.1
nvm alias default 20.18.1

# Verify Node.js installation
if command_exists node; then
    NODE_VERSION=$(node --version)
    echo -e "${GREEN}✓ Node.js $NODE_VERSION installed successfully.${NC}"
else
    echo -e "${RED}Error: Node.js installation failed.${NC}"
    exit 1
fi

# Update shell profile to ensure NVM is always available
echo -e "${BLUE}Updating shell profile...${NC}"

# Add NVM loading to .bashrc if not already present
if ! grep -q "NVM_DIR" "$HOME/.bashrc" 2>/dev/null; then
    echo "" >> "$HOME/.bashrc"
    echo "# Load NVM" >> "$HOME/.bashrc"
    echo 'export NVM_DIR="$HOME/.nvm"' >> "$HOME/.bashrc"
    echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' >> "$HOME/.bashrc"
    echo '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"' >> "$HOME/.bashrc"
    echo -e "${GREEN}✓ Added NVM loading to ~/.bashrc${NC}"
fi

# Also add to .bash_profile if it exists
if [ -f "$HOME/.bash_profile" ] && ! grep -q "NVM_DIR" "$HOME/.bash_profile" 2>/dev/null; then
    echo "" >> "$HOME/.bash_profile"
    echo "# Load NVM" >> "$HOME/.bash_profile"
    echo 'export NVM_DIR="$HOME/.nvm"' >> "$HOME/.bash_profile"
    echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' >> "$HOME/.bash_profile"
    echo '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"' >> "$HOME/.bash_profile"
    echo -e "${GREEN}✓ Added NVM loading to ~/.bash_profile${NC}"
fi

echo -e "${GREEN}"
echo "=========================================="
echo "  NVM Installation Fix Complete!"
echo "=========================================="
echo -e "${NC}"
echo "NVM and Node.js v20.18.1 have been successfully installed."
echo ""
echo "You can now:"
echo "  1. Continue with the Verdikta Arbiter installation"
echo "  2. Or run the installer again from the beginning"
echo ""
echo -e "${YELLOW}Note: If you open a new terminal, NVM will be automatically available.${NC}"
echo -e "${YELLOW}In the current terminal, you may need to run: source ~/.bashrc${NC}"



