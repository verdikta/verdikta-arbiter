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

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to load NVM
load_nvm() {
    # Load nvm if it exists
    if [ -d "$HOME/.nvm" ]; then
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
        
        # Verify node is available
        if command_exists node; then
            echo -e "${GREEN}Node.js $(node --version) loaded successfully${NC}"
            return 0
        else
            echo -e "${RED}Failed to load Node.js${NC}"
            return 1
        fi
    else
        echo -e "${RED}NVM directory not found. Please run setup-environment.sh first.${NC}"
        return 1
    fi
}

echo -e "${BLUE}Installing External Adapter for Verdikta Validator Node...${NC}"

# Load NVM and Node.js
load_nvm || exit 1

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
# Check for version preference (default to beta for integration testing)
# To use a different version, set VERDIKTA_COMMON_VERSION environment variable
# Available versions: 'beta' (recommended for testing), 'latest' (stable)
VERDIKTA_COMMON_VERSION="${VERDIKTA_COMMON_VERSION:-beta}"
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
        echo -e "${RED}Error: .env.example not found in External Adapter repository.${NC}"
        echo -e "${BLUE}Creating .env file from scratch...${NC}"
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

# Set AI_NODE_URL (default: http://localhost:3000)
if grep -q "^AI_NODE_URL=" "$ADAPTER_DIR/.env"; then
    sed -i.bak "s|^AI_NODE_URL=.*|AI_NODE_URL=http://localhost:3000|" "$ADAPTER_DIR/.env"
else
    echo "AI_NODE_URL=http://localhost:3000" >> "$ADAPTER_DIR/.env"
fi

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

# Test External Adapter
echo -e "${BLUE}Testing External Adapter installation...${NC}"

# Run a basic test with forceExit to handle any hanging async operations
npm test -- --forceExit || {
    echo -e "${YELLOW}WARNING: Some tests failed. This might be due to missing API keys or services not running.${NC}"
    echo -e "${YELLOW}You can still proceed with the installation, but some features might not work correctly.${NC}"
}

# Create a start script
echo -e "${BLUE}Creating External Adapter service...${NC}"

# Create start script
cat > "$ADAPTER_DIR/start.sh" << 'EOL'
#!/bin/bash
cd "$(dirname "$0")"

# Get the directory path and current timestamp for log file
LOG_DIR="$(pwd)/logs"
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
LOG_FILE="$LOG_DIR/adapter_${TIMESTAMP}.log"

echo "Starting External Adapter in persistent mode..."
echo "Logs will be available at: $LOG_FILE"

# Use nohup to keep the process running after terminal disconnects
nohup npm start > "$LOG_FILE" 2>&1 &

# Save PID for later management
echo $! > adapter.pid
echo "External Adapter started with PID $(cat adapter.pid)"
EOL

# Make start script executable
chmod +x "$ADAPTER_DIR/start.sh"

# Create stop script
cat > "$ADAPTER_DIR/stop.sh" << 'EOL'
#!/bin/bash
cd "$(dirname "$0")"

# Check for PID file first (our preferred method)
if [ -f adapter.pid ]; then
    pid=$(cat adapter.pid)
    echo "Found PID file, stopping process $pid..."
    kill -15 $pid 2>/dev/null || kill -9 $pid 2>/dev/null
    rm adapter.pid
    echo "External Adapter stopped."
    exit 0
fi

# Fallback to port check if PID file doesn't exist or is invalid
PID=$(lsof -i:8080 -t)
if [ -n "$PID" ]; then
  echo "Stopping External Adapter (PID: $PID)..."
  kill -15 $PID 2>/dev/null || kill -9 $PID 2>/dev/null
  echo "External Adapter stopped."
else
  echo "External Adapter is not running."
fi

# Final cleanup of any npm processes related to the adapter
ps aux | grep "npm start" | grep -v grep | awk '{print $2}' | xargs -r kill -9 2>/dev/null

echo "All External Adapter processes should be stopped now."
EOL

# Make stop script executable
chmod +x "$ADAPTER_DIR/stop.sh"

echo -e "${GREEN}External Adapter installation completed!${NC}"
echo -e "${GREEN}✅ Verdikta Common Library (@verdikta/common) successfully integrated${NC}"

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

# Ask user if they want to start the External Adapter now
echo -e "${YELLOW}Would you like to start the External Adapter service now?${NC}"
if ask_yes_no "Start External Adapter?"; then
    echo -e "${BLUE}Starting External Adapter service...${NC}"
    cd "$ADAPTER_DIR" && ./start.sh &
    echo -e "${GREEN}External Adapter service started in the background.${NC}"
else
    echo -e "${BLUE}External Adapter service is not running. You can start it later with:${NC}"
    echo -e "  cd $ADAPTER_DIR && ./start.sh"
fi

echo -e "${BLUE}To start the External Adapter manually, run:${NC}"
echo -e "  cd $ADAPTER_DIR && ./start.sh"
echo -e "${BLUE}To stop the External Adapter manually, run:${NC}"
echo -e "  cd $ADAPTER_DIR && ./stop.sh"

exit 0 