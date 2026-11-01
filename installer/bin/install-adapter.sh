#!/bin/bash

# Verdikta Validator Node - External Adapter Installation Script
# Installs and configures the External Adapter component with Verdikta Common Library

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

# Default values
SKIP_TESTS=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-tests|-s)
            SKIP_TESTS=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo "Options:"
            echo "  --skip-tests, -s    Skip unit tests during installation"
            echo "  --help, -h          Show this help message"
            echo ""
            echo "Environment Variables:"
            echo "  SKIP_TESTS=true     Skip unit tests (alternative to --skip-tests)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Check environment variable as well
if [ "$SKIP_TESTS" = "true" ]; then
    SKIP_TESTS=true
fi

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to load Node.js (via nvm or system-installed)
load_node() {
    # Try loading nvm if the directory exists
    if [ -d "$HOME/.nvm" ]; then
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    fi

    # Check if node is available (installed via nvm, apt, or binary)
    if command_exists node; then
        echo -e "${GREEN}Node.js $(node --version) loaded successfully${NC}"
        return 0
    fi

    echo -e "${RED}Node.js is not available. Please run setup-environment.sh first or install Node.js v20.18.1 manually.${NC}"
    return 1
}

echo -e "${BLUE}Installing External Adapter for Verdikta Validator Node...${NC}"
if [ "$SKIP_TESTS" = "true" ]; then
    echo -e "${YELLOW}Note: Unit tests will be skipped during installation${NC}"
fi

# Load Node.js (via nvm or system-installed)
load_node || exit 1

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

# Define External Adapter directory based on script location
# ADAPTER_DIR="$INSTALL_DIR/external-adapter" # Old definition
ADAPTER_DIR="$(dirname "$INSTALLER_DIR")/external-adapter"

# Ensure the target directory exists
if [ ! -d "$ADAPTER_DIR" ]; then
    echo -e "${RED}Error: External Adapter directory not found at $ADAPTER_DIR${NC}"
    exit 1
fi
cd "$ADAPTER_DIR" # Change into the existing local directory

# Install dependencies
echo -e "${BLUE}Installing External Adapter dependencies...${NC}"
npm install

# Install Verdikta Common Library
# Check for version preference from environment setup
# Load environment to get consistent version preference
if [ -f "$INSTALLER_DIR/.env" ]; then
    source "$INSTALLER_DIR/.env"
fi
VERDIKTA_COMMON_VERSION="${VERDIKTA_COMMON_VERSION:-latest}"

# An exact pin in package.json wins over the version preference: the adapter
# needs that release (the stake-attestation prerelease carries the code-review
# gates) and `npm install` above has installed it. Only a range is updated.
if COMMON_PIN=$(node "$INSTALLER_DIR/util/common-pin.js" "$ADAPTER_DIR"); then
    echo -e "${BLUE}@verdikta/common is pinned to $COMMON_PIN in package.json; keeping it (VERDIKTA_COMMON_VERSION=$VERDIKTA_COMMON_VERSION applies to unpinned components only).${NC}"
else
echo -e "${BLUE}Installing Verdikta Common Library (@verdikta/common@$VERDIKTA_COMMON_VERSION)...${NC}"

if ! npm install @verdikta/common@$VERDIKTA_COMMON_VERSION; then
    echo -e "${RED}❌ Failed to install @verdikta/common@$VERDIKTA_COMMON_VERSION${NC}"
    echo -e "${YELLOW}Trying to install latest stable version as fallback...${NC}"
    if npm install @verdikta/common@latest; then
        echo -e "${GREEN}✅ Installed @verdikta/common@latest as fallback${NC}"
        VERDIKTA_COMMON_VERSION="latest"
    else
        echo -e "${RED}❌ Failed to install any version of @verdikta/common${NC}"
        echo -e "${YELLOW}This is required for the External Adapter to function properly.${NC}"
        exit 1
    fi
fi
fi

# Verify Verdikta Common installation
if npm list @verdikta/common > /dev/null 2>&1; then
    VERDIKTA_VERSION=$(npm list @verdikta/common --depth=0 2>/dev/null | grep @verdikta/common | awk '{print $2}')
    echo -e "${GREEN}✅ Verdikta Common Library installed successfully (version: $VERDIKTA_VERSION)${NC}"
else
    echo -e "${RED}❌ Failed to install Verdikta Common Library${NC}"
    echo -e "${YELLOW}This is required for the External Adapter to function properly.${NC}"
    exit 1
fi

# Test Verdikta Common imports
echo -e "${BLUE}Testing Verdikta Common Library imports...${NC}"
if node -e "
try {
  const { manifestParser, validateRequest, createClient } = require('@verdikta/common');
  console.log('✅ All imports successful');
  process.exit(0);
} catch (error) {
  console.log('❌ Import error:', error.message);
  process.exit(1);
}
" 2>/dev/null; then
    echo -e "${GREEN}✅ Verdikta Common Library imports working correctly${NC}"
else
    echo -e "${YELLOW}⚠️  Warning: Verdikta Common Library imports failed${NC}"
    echo -e "${YELLOW}The External Adapter may not function correctly${NC}"
fi

# Configure environment
echo -e "${BLUE}Configuring External Adapter environment...${NC}"
if [ -f "$ADAPTER_DIR/.env" ]; then
    echo -e "${YELLOW}External Adapter environment file already exists. Updating...${NC}"
    # Backup existing file
    cp "$ADAPTER_DIR/.env" "$ADAPTER_DIR/.env.backup"
else
    # Copy template
    if [ -f "$ADAPTER_DIR/.env.example" ]; then
        cp "$ADAPTER_DIR/.env.example" "$ADAPTER_DIR/.env"
    else
        echo -e "${BLUE}Creating .env file for External Adapter...${NC}"
        touch "$ADAPTER_DIR/.env"
    fi
fi

# Update environment file
# Set PORT (default: 8080)
if grep -q "^PORT=" "$ADAPTER_DIR/.env"; then
    sed -i.bak "s/^PORT=.*/PORT=8080/" "$ADAPTER_DIR/.env"
else
    echo "PORT=8080" >> "$ADAPTER_DIR/.env"
fi

# Set HOST (default: 0.0.0.0)
if grep -q "^HOST=" "$ADAPTER_DIR/.env"; then
    sed -i.bak "s/^HOST=.*/HOST=0.0.0.0/" "$ADAPTER_DIR/.env"
else
    echo "HOST=0.0.0.0" >> "$ADAPTER_DIR/.env"
fi

# Set AI_NODE_URL. 127.0.0.1, not localhost: the AI Node listens on loopback only
# (ai-node/start.sh, .ai-node-loopback), and with a loopback-only listener the
# answer must not depend on whether the resolver returns ::1 first.
if grep -q "^AI_NODE_URL=" "$ADAPTER_DIR/.env"; then
    sed -i.bak "s|^AI_NODE_URL=.*|AI_NODE_URL=http://127.0.0.1:3000|" "$ADAPTER_DIR/.env"
else
    echo "AI_NODE_URL=http://127.0.0.1:3000" >> "$ADAPTER_DIR/.env"
fi

# Set AI_TIMEOUT (updated: 300000ms = 300 seconds for slow model compatibility)
if grep -q "^AI_TIMEOUT=" "$ADAPTER_DIR/.env"; then
    sed -i.bak "s/^AI_TIMEOUT=.*/AI_TIMEOUT=300000/" "$ADAPTER_DIR/.env"
else
    echo "AI_TIMEOUT=300000" >> "$ADAPTER_DIR/.env"
fi

# Set OPERATOR_ADDR (required for commit hash security)
# Check if operator address is available from previous deployment
OPERATOR_ADDR=""
if [ -f "$INSTALLER_DIR/.contracts" ]; then
    source "$INSTALLER_DIR/.contracts"
    # Check for new naming convention first, then fallback to old
    if [ -n "$OPERATOR_ADDR" ]; then
        echo -e "${GREEN}Using existing operator address: $OPERATOR_ADDR${NC}"
    elif [ -n "$OPERATOR_ADDRESS" ]; then
        OPERATOR_ADDR="$OPERATOR_ADDRESS"
        echo -e "${GREEN}Using existing operator address (legacy): $OPERATOR_ADDR${NC}"
    fi
fi

# If no operator address available, set a placeholder for testing
if [ -z "$OPERATOR_ADDR" ]; then
    # Use a placeholder address for initial setup - will be updated after contract deployment
    OPERATOR_ADDR="0x0000000000000000000000000000000000000000"
    echo -e "${YELLOW}No operator address available yet. Using placeholder address.${NC}"
    echo -e "${YELLOW}This will be updated after smart contract deployment.${NC}"
fi

# Set OPERATOR_ADDR in .env file
if grep -q "^OPERATOR_ADDR=" "$ADAPTER_DIR/.env"; then
    sed -i.bak "s|^OPERATOR_ADDR=.*|OPERATOR_ADDR=$OPERATOR_ADDR|" "$ADAPTER_DIR/.env"
else
    echo "OPERATOR_ADDR=$OPERATOR_ADDR" >> "$ADAPTER_DIR/.env"
fi

# Export OPERATOR_ADDR for the current shell session (required for external-adapter service)
export OPERATOR_ADDR

# Set IPFS configuration if Pinata API key is provided
if [ -n "$PINATA_API_KEY" ]; then
    # Set IPFS_PINNING_SERVICE
    if grep -q "^IPFS_PINNING_SERVICE=" "$ADAPTER_DIR/.env"; then
        sed -i.bak "s|^IPFS_PINNING_SERVICE=.*|IPFS_PINNING_SERVICE=https://api.pinata.cloud|" "$ADAPTER_DIR/.env"
    else
        echo "IPFS_PINNING_SERVICE=https://api.pinata.cloud" >> "$ADAPTER_DIR/.env"
    fi
    
    # Set IPFS_PINNING_KEY
    if grep -q "^IPFS_PINNING_KEY=" "$ADAPTER_DIR/.env"; then
        sed -i.bak "s|^IPFS_PINNING_KEY=.*|IPFS_PINNING_KEY=$PINATA_API_KEY|" "$ADAPTER_DIR/.env"
    else
        echo "IPFS_PINNING_KEY=$PINATA_API_KEY" >> "$ADAPTER_DIR/.env"
    fi
    
    echo -e "${GREEN}IPFS configuration with Pinata completed.${NC}"
else
    echo -e "${YELLOW}WARNING: Pinata JWT not provided. IPFS functionality will be limited.${NC}"
fi

# Set default log level
if ! grep -q "^LOG_LEVEL=" "$ADAPTER_DIR/.env"; then
    echo "LOG_LEVEL=info" >> "$ADAPTER_DIR/.env"
    echo -e "${GREEN}Default log level set to: info${NC}"
else
    echo -e "${GREEN}Log level already configured in .env${NC}"
fi

# Test External Adapter (optional)
if [ "$SKIP_TESTS" = "true" ]; then
    echo -e "${YELLOW}Skipping External Adapter test suite (--skip-tests flag provided)${NC}"
else
    echo -e "${BLUE}Testing External Adapter installation...${NC}"

    # Check if we're using a placeholder operator address
    if [ "$OPERATOR_ADDR" = "0x0000000000000000000000000000000000000000" ]; then
        echo -e "${YELLOW}Using placeholder operator address - some tests may fail but this is expected.${NC}"
        echo -e "${YELLOW}Tests will be fully functional after smart contract deployment.${NC}"
    fi

    # Define AI Node directory for testing
    AI_NODE_DIR="$(dirname "$INSTALLER_DIR")/ai-node"
    AI_NODE_STARTED=false

    # Check if AI Node is available and start it temporarily for testing
    if [ -d "$AI_NODE_DIR" ] && [ -f "$AI_NODE_DIR/start.sh" ]; then
        echo -e "${BLUE}Starting AI Node temporarily for testing...${NC}"
        
        # Check if AI Node is already running (check if port 3000 is in use)
        if ! (command -v curl >/dev/null 2>&1 && curl -s http://localhost:3000 > /dev/null 2>&1) && ! (command -v nc >/dev/null 2>&1 && nc -z localhost 3000 > /dev/null 2>&1) && ! lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
            # Start AI Node in background
            cd "$AI_NODE_DIR"
            # Loopback only: a throwaway test start during the install (the repo's ai-node/
            # has no .ai-node-loopback marker, the installed one does).
            AI_NODE_HOST=127.0.0.1 ./start.sh > /dev/null 2>&1
            AI_NODE_STARTED=true
            
            # Wait for AI Node to be ready (max 30 seconds)
            echo -e "${BLUE}Waiting for AI Node to be ready...${NC}"
            for i in {1..30}; do
                # Check if port 3000 is listening using multiple methods
                if (command -v curl >/dev/null 2>&1 && curl -s http://localhost:3000 > /dev/null 2>&1) || \
                   (command -v nc >/dev/null 2>&1 && nc -z localhost 3000 > /dev/null 2>&1) || \
                   lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
                    echo -e "${GREEN}AI Node is ready for testing${NC}"
                    break
                fi
                sleep 1
                if [ $i -eq 30 ]; then
                    echo -e "${YELLOW}AI Node startup timeout - continuing with tests anyway${NC}"
                fi
            done
            
            # Return to adapter directory
            cd "$ADAPTER_DIR"
        else
            echo -e "${GREEN}AI Node is already running${NC}"
        fi
    else
        echo -e "${YELLOW}AI Node not found or not properly installed - some tests may fail${NC}"
    fi

    # Run tests with forceExit to handle any hanging async operations
    npm test -- --forceExit || {
        echo -e "${YELLOW}WARNING: Some tests failed. This might be due to missing API keys, services not running,${NC}"
        echo -e "${YELLOW}or placeholder operator address. You can still proceed with the installation.${NC}"
        echo -e "${YELLOW}Tests will be fully functional after smart contract deployment.${NC}"
    }

    # Stop AI Node if we started it temporarily
    if [ "$AI_NODE_STARTED" = "true" ] && [ -f "$AI_NODE_DIR/stop.sh" ]; then
        echo -e "${BLUE}Stopping AI Node after testing...${NC}"
        cd "$AI_NODE_DIR"
        ./stop.sh > /dev/null 2>&1
        cd "$ADAPTER_DIR"
        echo -e "${GREEN}AI Node stopped${NC}"
    fi
fi

# start.sh and stop.sh are tracked in the repo, and upgrades deploy exactly
# those files. This step used to overwrite both with older heredoc copies (no
# bounded wait for :8080; a stop that kill -9'd every `npm start` on the host),
# so a fresh install ran different scripts until its first upgrade.
for script in start.sh stop.sh; do
    if [ ! -f "$ADAPTER_DIR/$script" ]; then
        echo -e "${RED}Error: $ADAPTER_DIR/$script is missing from the checkout.${NC}"
        exit 1
    fi
done
chmod +x "$ADAPTER_DIR/start.sh" "$ADAPTER_DIR/stop.sh"

echo -e "${GREEN}External Adapter installation completed!${NC}"
echo -e "${GREEN}✅ Verdikta Common Library (@verdikta/common) successfully integrated${NC}"

echo -e "${BLUE}Note: External Adapter will be available to start after the full installation completes.${NC}"

echo -e "${BLUE}To start the External Adapter manually, run:${NC}"
echo -e "  cd $ADAPTER_DIR && ./start.sh"
echo -e "${BLUE}To stop the External Adapter manually, run:${NC}"
echo -e "  cd $ADAPTER_DIR && ./stop.sh"

exit 0 