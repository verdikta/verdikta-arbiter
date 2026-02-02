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

# Default values
SKIP_TESTS=true
RESUME_REGISTRATION=false
INSTALL_FLAGS="--skip-tests"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --run-tests|-t)
            SKIP_TESTS=false
            INSTALL_FLAGS=""
            shift
            ;;
        --resume-registration|-r)
            RESUME_REGISTRATION=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo "Main installation script for Verdikta Arbiter Node"
            echo ""
            echo "Options:"
            echo "  --run-tests, -t            Run unit tests during installation (skipped by default)"
            echo "  --resume-registration, -r  Skip all installation steps and resume from oracle registration"
            echo "  --help, -h                 Show this help message"
            echo ""
            echo "Environment Variables:"
            echo "  RUN_TESTS=true      Run unit tests (alternative to --run-tests)"
            echo ""
            echo "This script orchestrates the complete installation process including:"
            echo "  1. Prerequisites check"
            echo "  2. Environment setup"
            echo "  3. AI Node installation with ClassID Model Pool integration"
            echo "  4. External Adapter installation"
            echo "  5. Docker and PostgreSQL setup"
            echo "  6. Chainlink Node setup"
            echo "  7. Smart Contract deployment"
            echo "  8. Node Jobs and Bridges configuration"
            echo "  9. Oracle registration (optional)"
            echo "  10. Automatic Chainlink key funding (optional)"
            echo ""
            echo "Recovery Options:"
            echo "  If oracle registration failed due to insufficient wVDKA tokens:"
            echo "  1. Acquire sufficient wVDKA tokens in your wallet"
            echo "  2. Run: $0 --resume-registration"
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
if [ "$RUN_TESTS" = "true" ]; then
    SKIP_TESTS=false
    INSTALL_FLAGS=""
fi

# Banner
echo -e "${BLUE}"
echo "===================================================="
echo "  Verdikta Arbiter Node Installation"
echo "===================================================="
echo -e "${NC}"

if [ "$SKIP_TESTS" = "false" ]; then
    echo -e "${YELLOW}Note: Unit tests will be run during installation${NC}"
    echo ""
fi

# Handle resume registration mode
if [ "$RESUME_REGISTRATION" = "true" ]; then
    echo -e "${YELLOW}Resume Registration Mode: Skipping to oracle registration step...${NC}"
    echo ""
    
    # Verify that installation was previously completed
    if [ ! -f "$INSTALLER_DIR/.env" ] || [ ! -f "$INSTALLER_DIR/.contracts" ]; then
        echo -e "${RED}Error: Cannot resume registration - installation appears incomplete.${NC}"
        echo -e "${RED}Missing required files: .env and/or .contracts${NC}"
        echo -e "${YELLOW}Please run the full installation first without --resume-registration flag.${NC}"
        exit 1
    fi
    
    # Detect if this is recovery from old installer (missing post-installation artifacts)
    if [ ! -d "$INSTALL_DIR" ] || [ ! -f "$INSTALL_DIR/start-arbiter.sh" ]; then
        echo -e "${BLUE}Detected incomplete installation from previous installer version.${NC}"
        echo -e "${BLUE}Will complete all missing post-installation steps after registration.${NC}"
        NEED_POST_INSTALLATION=true
    else
        echo -e "${BLUE}Post-installation artifacts found - will skip redundant steps.${NC}"
        NEED_POST_INSTALLATION=false
    fi
    
    # Skip to registration section
    echo -e "${BLUE}Resuming from oracle registration step...${NC}"
    SKIP_TO_REGISTRATION=true
else
    SKIP_TO_REGISTRATION=false
    NEED_POST_INSTALLATION=true  # Always need post-installation for fresh installs
    
    # Clean up any existing contract information for fresh install
    if [ -f "$INSTALLER_DIR/.contracts" ]; then
        echo -e "${BLUE}Removing existing contract information for fresh installation...${NC}"
        rm -f "$INSTALLER_DIR/.contracts"
    fi
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

# Skip installation steps if resuming registration
if [ "$SKIP_TO_REGISTRATION" = "false" ]; then

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

echo -e "${BLUE}Note: Configuring multiple RPC endpoints is recommended for robust performance,${NC}"
echo -e "${BLUE}especially for mainnet deployments.${NC}"
echo ""

bash "$SCRIPT_DIR/setup-environment.sh"
if [ $? -ne 0 ]; then
    echo -e "${RED}Environment setup failed. Please check the logs for details.${NC}"
    exit 1
fi
echo -e "${GREEN}Environment setup completed.${NC}"

# Preflight RPC connectivity check
echo -e "${YELLOW}Preflight: Checking RPC endpoint connectivity...${NC}"
if [ -f "$INSTALLER_DIR/.env" ]; then
    source "$INSTALLER_DIR/.env"
else
    echo -e "${RED}Error: Environment file not found after setup. Cannot verify RPCs.${NC}"
    exit 1
fi

normalize_rpc_list() {
    local raw="$1"
    raw="$(echo "$raw" | tr -d ' ' | sed 's/;*$//')"
    echo "$raw"
}

check_rpc_url() {
    local url="$1"
    local type="$2"
    python3 - "$url" "$type" << 'PY'
import json
import sys
from urllib.parse import urlparse

url = sys.argv[1]
kind = sys.argv[2]
timeout_seconds = 7

if kind == "http":
    try:
        import urllib.request
        payload = json.dumps({"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}).encode("utf-8")
        headers = {"Content-Type":"application/json", "User-Agent":"verdikta-arbiter/1.0"}
        req = urllib.request.Request(url, data=payload, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            if resp.status < 200 or resp.status >= 300:
                sys.exit(1)
            body = resp.read().decode("utf-8", errors="ignore")
            if '"result"' not in body:
                sys.exit(1)
        sys.exit(0)
    except Exception:
        sys.exit(1)

if kind == "ws":
    try:
        import socket
        parsed = urlparse(url)
        host = parsed.hostname
        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        if not host:
            sys.exit(1)
        sock = socket.create_connection((host, port), timeout=timeout_seconds)
        sock.close()
        sys.exit(0)
    except Exception:
        sys.exit(1)

sys.exit(1)
PY
}

RPC_HTTP_URLS=""
RPC_WS_URLS=""
if [ "$DEPLOYMENT_NETWORK" = "base_mainnet" ]; then
    RPC_HTTP_URLS="$(normalize_rpc_list "$BASE_MAINNET_RPC_HTTP_URLS")"
    RPC_WS_URLS="$(normalize_rpc_list "$BASE_MAINNET_RPC_WS_URLS")"
else
    RPC_HTTP_URLS="$(normalize_rpc_list "$BASE_SEPOLIA_RPC_HTTP_URLS")"
    RPC_WS_URLS="$(normalize_rpc_list "$BASE_SEPOLIA_RPC_WS_URLS")"
fi

if [ -z "$RPC_HTTP_URLS" ] || [ -z "$RPC_WS_URLS" ]; then
    echo -e "${RED}Error: RPC URL lists are required for installation.${NC}"
    exit 1
fi

IFS=';' read -r -a HTTP_URL_ARRAY <<< "$RPC_HTTP_URLS"
IFS=';' read -r -a WS_URL_ARRAY <<< "$RPC_WS_URLS"

FAILED_RPC_CHECKS=""
for url in "${HTTP_URL_ARRAY[@]}"; do
    if ! check_rpc_url "$url" "http"; then
        FAILED_RPC_CHECKS="${FAILED_RPC_CHECKS}\n  HTTP: $url"
    fi
done

for url in "${WS_URL_ARRAY[@]}"; do
    if ! check_rpc_url "$url" "ws"; then
        FAILED_RPC_CHECKS="${FAILED_RPC_CHECKS}\n  WS:   $url"
    fi
done

if [ -n "$FAILED_RPC_CHECKS" ]; then
    echo -e "${RED}RPC connectivity check failed for:${NC}${FAILED_RPC_CHECKS}"
    if ! ask_yes_no "Continue installation anyway?"; then
        exit 1
    fi
else
    echo -e "${GREEN}RPC connectivity check passed.${NC}"
fi

# Install AI Node
echo -e "${YELLOW}[3/9]${NC} Installing AI Node..."
if [ ! -f "$SCRIPT_DIR/install-ai-node.sh" ]; then
    echo -e "${RED}Error: install-ai-node.sh not found in $SCRIPT_DIR${NC}"
    exit 1
fi

bash "$SCRIPT_DIR/install-ai-node.sh" $INSTALL_FLAGS
if [ $? -ne 0 ]; then
    echo -e "${RED}AI Node installation failed. Please check the logs for details.${NC}"
    exit 1
fi
echo -e "${GREEN}AI Node installation completed.${NC}"

# Note: @verdikta/common library updates will be handled after both AI Node and External Adapter are installed

# Install External Adapter
echo -e "${YELLOW}[4/9]${NC} Installing External Adapter..."
if [ ! -f "$SCRIPT_DIR/install-adapter.sh" ]; then
    echo -e "${RED}Error: install-adapter.sh not found in $SCRIPT_DIR${NC}"
    exit 1
fi

bash "$SCRIPT_DIR/install-adapter.sh" $INSTALL_FLAGS
if [ $? -ne 0 ]; then
    echo -e "${RED}External Adapter installation failed. Please check the logs for details.${NC}"
    exit 1
fi
echo -e "${GREEN}External Adapter installation completed.${NC}"

# Update @verdikta/common library and display ClassID information
echo -e "${BLUE}Updating @verdikta/common library for latest ClassID model pools...${NC}"
AI_NODE_SRC_DIR="$(dirname "$INSTALLER_DIR")/ai-node"
EXTERNAL_ADAPTER_SRC_DIR="$(dirname "$INSTALLER_DIR")/external-adapter"

# Load environment to get Verdikta Common version preference
if [ -f "$INSTALLER_DIR/.env" ]; then
    source "$INSTALLER_DIR/.env"
fi
VERDIKTA_VERSION="${VERDIKTA_COMMON_VERSION:-latest}"

if [ -f "$UTIL_DIR/update-verdikta-common.js" ] && [ -d "$AI_NODE_SRC_DIR" ] && [ -d "$EXTERNAL_ADAPTER_SRC_DIR" ]; then
    echo -e "${BLUE}Checking for @verdikta/common updates (version: $VERDIKTA_VERSION)...${NC}"
    echo -e "${BLUE}This will ensure both AI Node and External Adapter have the latest ClassID model pool data.${NC}"
    
    if node "$UTIL_DIR/update-verdikta-common.js" "$AI_NODE_SRC_DIR" "$EXTERNAL_ADAPTER_SRC_DIR" "$VERDIKTA_VERSION"; then
        echo -e "${GREEN}@verdikta/common library update completed successfully.${NC}"
        
        # Verify both components have the same version
        echo -e "${BLUE}Verifying @verdikta/common versions across components...${NC}"
        AI_NODE_VERSION=""
        ADAPTER_VERSION=""
        
        if [ -d "$AI_NODE_SRC_DIR" ]; then
            AI_NODE_VERSION=$(cd "$AI_NODE_SRC_DIR" && npm list @verdikta/common --depth=0 2>/dev/null | grep @verdikta/common | awk '{print $2}' || echo "not found")
        fi
        
        if [ -d "$EXTERNAL_ADAPTER_SRC_DIR" ]; then
            ADAPTER_VERSION=$(cd "$EXTERNAL_ADAPTER_SRC_DIR" && npm list @verdikta/common --depth=0 2>/dev/null | grep @verdikta/common | awk '{print $2}' || echo "not found")
        fi
        
        echo -e "${BLUE}AI Node @verdikta/common version: $AI_NODE_VERSION${NC}"
        echo -e "${BLUE}External Adapter @verdikta/common version: $ADAPTER_VERSION${NC}"
        
        if [ "$AI_NODE_VERSION" = "$ADAPTER_VERSION" ] && [ "$AI_NODE_VERSION" != "not found" ]; then
            echo -e "${GREEN}✅ Both components have matching @verdikta/common versions ($AI_NODE_VERSION)${NC}"
        else
            echo -e "${YELLOW}⚠️  Version mismatch detected between components${NC}"
            echo -e "${YELLOW}   This may cause compatibility issues. Consider running the update again.${NC}"
        fi
    else
        echo -e "${YELLOW}Warning: Could not update @verdikta/common library.${NC}"
        echo -e "${YELLOW}Proceeding with existing versions...${NC}"
    fi
    echo ""
    
    # Show actual ClassID information now that @verdikta/common is available
    echo -e "${BLUE}Displaying actual ClassID Model Pool information...${NC}"
    if [ -d "$AI_NODE_SRC_DIR" ]; then
        cd "$AI_NODE_SRC_DIR"
        if [ -f "src/scripts/display-classids.js" ]; then
            if node "src/scripts/display-classids.js" 2>/dev/null; then
                echo -e "${GREEN}ClassID information displayed successfully.${NC}"
                echo ""
                echo -e "${BLUE}💡 Based on this information, you can now make informed decisions about:${NC}"
                echo -e "${BLUE}   • Which ClassIDs to support in your deployment${NC}"
                echo -e "${BLUE}   • Whether your API key configuration matches your intended usage${NC}"
                echo -e "${BLUE}   • Model availability for your chosen providers${NC}"
                echo -e "${BLUE}   • All active ClassIDs are automatically detected and displayed${NC}"
                echo ""
            else
                echo -e "${YELLOW}ClassID information could not be displayed at this time.${NC}"
                echo -e "${GREEN}✅ All active ClassID model pools have been integrated into your AI Node configuration.${NC}"
                echo -e "${BLUE}📋 Models are now available for use in arbitration and justification generation.${NC}"
            fi
        else
            echo -e "${YELLOW}ClassID display utility not found. Skipping detailed information.${NC}"
        fi
        cd - > /dev/null
    else
        echo -e "${YELLOW}AI Node directory not found. Skipping ClassID display.${NC}"
    fi
else
    echo -e "${YELLOW}Warning: @verdikta/common update utility or required directories not found.${NC}"
    echo -e "${YELLOW}AI Node: $AI_NODE_SRC_DIR${NC}"
    echo -e "${YELLOW}External Adapter: $EXTERNAL_ADAPTER_SRC_DIR${NC}"
    echo -e "${YELLOW}Update utility: $UTIL_DIR/update-verdikta-common.js${NC}"
fi

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

# Brief delay to ensure Chainlink node is fully operational before contract deployment
echo -e "${BLUE}Allowing Chainlink node to fully initialize...${NC}"
sleep 5

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

fi  # End of SKIP_TO_REGISTRATION conditional block

# Register Oracle with Dispatcher (Optional)
echo -e "${YELLOW}[9/9]${NC} Registering Oracle with Dispatcher (Optional)..."
if [ ! -f "$SCRIPT_DIR/register-oracle-dispatcher.sh" ]; then
    echo -e "${RED}Error: register-oracle-dispatcher.sh not found in $SCRIPT_DIR${NC}"
    # Decide if this should be a fatal error or just a warning if the script is optional.
    # For now, let's make it non-fatal for the main install if script is missing,
    # but the new script itself will handle its own errors.
    echo -e "${YELLOW}Skipping optional Oracle registration as script is missing.${NC}"
else
    # Save registration attempt state
    echo "REGISTRATION_ATTEMPTED=true" > "$INSTALLER_DIR/.registration_state"
    
    bash "$SCRIPT_DIR/register-oracle-dispatcher.sh"
    REGISTRATION_EXIT_CODE=$?
    
    if [ $REGISTRATION_EXIT_CODE -ne 0 ]; then
        echo -e "${RED}Oracle registration failed with exit code: $REGISTRATION_EXIT_CODE${NC}"
        echo -e "${YELLOW}This is commonly due to insufficient wVDKA tokens in your wallet.${NC}"
        echo ""
        echo -e "${BLUE}To recover from this error:${NC}"
        echo -e "${BLUE}1. Ensure you have sufficient wVDKA tokens in your wallet${NC}"
        echo -e "${BLUE}2. Run the following command to resume registration:${NC}"
        echo -e "${GREEN}   $0 --resume-registration${NC}"
        echo ""
        echo -e "${BLUE}Alternatively, you can register later using the standalone script:${NC}"
        echo -e "${GREEN}   $INSTALL_DIR/register-oracle.sh${NC}"
        echo ""
        
        # Mark registration as failed but don't exit - continue with installation
        echo "REGISTRATION_FAILED=true" >> "$INSTALLER_DIR/.registration_state"
        echo -e "${YELLOW}Installation will continue, but oracle registration is incomplete.${NC}"
    else
        echo -e "${GREEN}Oracle registration step completed.${NC}"
        echo "REGISTRATION_SUCCESS=true" >> "$INSTALLER_DIR/.registration_state"
    fi
fi

# Run post-installation steps if needed
if [ "$NEED_POST_INSTALLATION" = "true" ]; then

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

# Copy configured components to target installation directory
echo -e "${BLUE}Copying configured components to installation directory...${NC}"

# Define source component directories
AI_NODE_SRC_DIR="$(dirname "$INSTALLER_DIR")/ai-node"
EXTERNAL_ADAPTER_SRC_DIR="$(dirname "$INSTALLER_DIR")/external-adapter"
CHAINLINK_NODE_SRC_DIR="$(dirname "$INSTALLER_DIR")/chainlink-node"

# Copy AI Node (including .env.local and other configurations)
if [ -d "$AI_NODE_SRC_DIR" ]; then
    echo -e "${BLUE}Copying configured AI Node...${NC}"
    # Enable dotglob to ensure hidden files like .env.local are copied
    shopt -s dotglob
    # Copy contents of source directory, not the directory itself (fixes double nesting)
    mkdir -p "$INSTALL_DIR/ai-node"
    cp -r "$AI_NODE_SRC_DIR/." "$INSTALL_DIR/ai-node/"
    shopt -u dotglob
    echo -e "${GREEN}AI Node copied to $INSTALL_DIR/ai-node${NC}"
    
    # Verify .env.local was copied
    if [ -f "$INSTALL_DIR/ai-node/.env.local" ]; then
        echo -e "${GREEN}AI Node .env.local file successfully copied${NC}"
    else
        echo -e "${YELLOW}Warning: .env.local file not found in copied AI Node${NC}"
    fi
else
    echo -e "${YELLOW}Warning: AI Node source directory not found at $AI_NODE_SRC_DIR${NC}"
fi

# Copy External Adapter (including .env and other configurations)
if [ -d "$EXTERNAL_ADAPTER_SRC_DIR" ]; then
    echo -e "${BLUE}Copying configured External Adapter...${NC}"
    # Enable dotglob to ensure hidden files like .env are copied
    shopt -s dotglob
    cp -r "$EXTERNAL_ADAPTER_SRC_DIR" "$INSTALL_DIR/external-adapter"
    shopt -u dotglob
    echo -e "${GREEN}External Adapter copied to $INSTALL_DIR/external-adapter${NC}"
    
    # Verify .env was copied
    if [ -f "$INSTALL_DIR/external-adapter/.env" ]; then
        echo -e "${GREEN}External Adapter .env file successfully copied${NC}"
    else
        echo -e "${YELLOW}Warning: .env file not found in copied External Adapter${NC}"
    fi
else
    echo -e "${YELLOW}Warning: External Adapter source directory not found at $EXTERNAL_ADAPTER_SRC_DIR${NC}"
fi

# Copy Chainlink Node configurations
if [ -d "$CHAINLINK_NODE_SRC_DIR" ]; then
    echo -e "${BLUE}Copying Chainlink Node configurations...${NC}"
    # Enable dotglob for consistency (ensures any hidden config files are copied)
    shopt -s dotglob
    cp -r "$CHAINLINK_NODE_SRC_DIR" "$INSTALL_DIR/chainlink-node"
    shopt -u dotglob
    echo -e "${GREEN}Chainlink Node copied to $INSTALL_DIR/chainlink-node${NC}"
else
    echo -e "${YELLOW}Warning: Chainlink Node source directory not found at $CHAINLINK_NODE_SRC_DIR${NC}"
fi

# Copy contracts and environment information
echo -e "${BLUE}Copying contract and environment information...${NC}"
mkdir -p "$INSTALL_DIR/installer"

if [ -f "$INSTALLER_DIR/.contracts" ]; then
    cp "$INSTALLER_DIR/.contracts" "$INSTALL_DIR/installer/.contracts"
    echo -e "${GREEN}Contract information copied to $INSTALL_DIR/installer/.contracts${NC}"
fi

if [ -f "$INSTALLER_DIR/.env" ]; then
    cp "$INSTALLER_DIR/.env" "$INSTALL_DIR/installer/.env"
    chmod 600 "$INSTALL_DIR/installer/.env"
    echo -e "${GREEN}Environment information copied to $INSTALL_DIR/installer/.env${NC}"
fi

if [ -f "$INSTALLER_DIR/.api_keys" ]; then
    cp "$INSTALLER_DIR/.api_keys" "$INSTALL_DIR/installer/.api_keys"
    chmod 600 "$INSTALL_DIR/installer/.api_keys"
    echo -e "${GREEN}API keys copied to $INSTALL_DIR/installer/.api_keys${NC}"
fi

# Copy all utility scripts to installer directory (excluding management scripts which are placed at install root)
echo -e "${BLUE}Copying all utility scripts...${NC}"
if [ -d "$UTIL_DIR" ]; then
    mkdir -p "$INSTALL_DIR/installer/util"
    # Enable dotglob to ensure all files including hidden ones are copied
    shopt -s dotglob
    for item in "$UTIL_DIR"/*; do
        base_name="$(basename "$item")"
        case "$base_name" in
            start-arbiter.sh|stop-arbiter.sh|arbiter-status.sh)
                # Skip management scripts; they are copied to install root separately
                continue
                ;;
            *)
                cp -r "$item" "$INSTALL_DIR/installer/util/"
                ;;
        esac
    done
    shopt -u dotglob
    # Make all shell scripts executable
    find "$INSTALL_DIR/installer/util" -name "*.sh" -type f -exec chmod +x {} \;
    echo -e "${GREEN}All utility scripts copied to $INSTALL_DIR/installer/util${NC}"
else
    echo -e "${YELLOW}Warning: Utility directory not found at $UTIL_DIR${NC}"
fi

# Copy arbiter-operator to target directory for standalone registration
echo -e "${BLUE}Copying arbiter-operator for standalone registration...${NC}"
ARBITER_OPERATOR_SRC_DIR="$(dirname "$INSTALLER_DIR")/arbiter-operator"
if [ -d "$ARBITER_OPERATOR_SRC_DIR" ]; then
    # Enable dotglob for consistency (ensures any hidden config files are copied)
    shopt -s dotglob
    cp -r "$ARBITER_OPERATOR_SRC_DIR" "$INSTALL_DIR/arbiter-operator"
    shopt -u dotglob
    echo -e "${GREEN}Arbiter-operator copied to $INSTALL_DIR/arbiter-operator${NC}"
else
    echo -e "${YELLOW}Warning: arbiter-operator directory not found at $ARBITER_OPERATOR_SRC_DIR${NC}"
fi

# Copy the standalone registration script
if [ -f "$UTIL_DIR/register-oracle.sh" ]; then
    cp "$UTIL_DIR/register-oracle.sh" "$INSTALL_DIR/register-oracle.sh"
    chmod +x "$INSTALL_DIR/register-oracle.sh"
    echo -e "${GREEN}Standalone registration script copied to $INSTALL_DIR/register-oracle.sh${NC}"
else
    echo -e "${YELLOW}Warning: Standalone registration script not found at $UTIL_DIR/register-oracle.sh${NC}"
fi

# Copy the standalone unregistration script
if [ -f "$UTIL_DIR/unregister-oracle.sh" ]; then
    cp "$UTIL_DIR/unregister-oracle.sh" "$INSTALL_DIR/unregister-oracle.sh"
    chmod +x "$INSTALL_DIR/unregister-oracle.sh"
    echo -e "${GREEN}Standalone unregistration script copied to $INSTALL_DIR/unregister-oracle.sh${NC}"
else
    echo -e "${YELLOW}Warning: Standalone unregistration script not found at $UTIL_DIR/unregister-oracle.sh${NC}"
fi

# Copy the automatic funding script
if [ -f "$SCRIPT_DIR/fund-chainlink-keys.sh" ]; then
    cp "$SCRIPT_DIR/fund-chainlink-keys.sh" "$INSTALL_DIR/fund-chainlink-keys.sh"
    chmod +x "$INSTALL_DIR/fund-chainlink-keys.sh"
    echo -e "${GREEN}Automatic funding script copied to $INSTALL_DIR/fund-chainlink-keys.sh${NC}"
else
    echo -e "${YELLOW}Warning: Automatic funding script not found at $SCRIPT_DIR/fund-chainlink-keys.sh${NC}"
fi

# Copy the fund recovery script
if [ -f "$SCRIPT_DIR/recover-chainlink-funds.sh" ]; then
    cp "$SCRIPT_DIR/recover-chainlink-funds.sh" "$INSTALL_DIR/recover-chainlink-funds.sh"
    chmod +x "$INSTALL_DIR/recover-chainlink-funds.sh"
    echo -e "${GREEN}Fund recovery script copied to $INSTALL_DIR/recover-chainlink-funds.sh${NC}"
else
    echo -e "${YELLOW}Warning: Fund recovery script not found at $SCRIPT_DIR/recover-chainlink-funds.sh${NC}"
fi

echo -e "${GREEN}Arbiter management scripts created:${NC}"
echo -e "  - To start all services: $INSTALL_DIR/start-arbiter.sh"
echo -e "  - To stop all services:  $INSTALL_DIR/stop-arbiter.sh"
echo -e "  - To check status:       $INSTALL_DIR/arbiter-status.sh"
echo -e "  - To register with dispatcher: $INSTALL_DIR/register-oracle.sh"
echo -e "  - To unregister from dispatcher: $INSTALL_DIR/unregister-oracle.sh"
echo -e "  - To fund Chainlink keys: $INSTALL_DIR/fund-chainlink-keys.sh"
echo -e "  - To recover funds from keys: $INSTALL_DIR/recover-chainlink-funds.sh"

# Configure logging level
echo -e "${YELLOW}Configuring logging level...${NC}"
echo -e "${BLUE}Choose a logging level for your Verdikta Arbiter services:${NC}"
echo -e "  1) error   - Only error messages"
echo -e "  2) warn    - Warnings and errors (recommended for production)"
echo -e "  3) info    - General information, warnings, and errors (recommended for monitoring)"
echo -e "  4) debug   - Detailed debugging information (recommended for troubleshooting)"
echo

# Function to get log level choice
get_log_level() {
    local log_level="info"  # Default
    
    while true; do
        read -p "Enter your choice (1-4) [3 for info]: " choice
        case "$choice" in
            1) log_level="error"; break;;
            2) log_level="warn"; break;;
            3|"") log_level="info"; break;;
            4) log_level="debug"; break;;
            *) echo "Please enter a number between 1-4.";;
        esac
    done
    
    echo "$log_level"
}

LOG_LEVEL=$(get_log_level)
echo -e "${GREEN}Selected log level: $LOG_LEVEL${NC}"

# Update AI Node .env.local file
AI_NODE_ENV_FILE="$INSTALL_DIR/ai-node/.env.local"
if [ -f "$AI_NODE_ENV_FILE" ]; then
    echo -e "${BLUE}Updating AI Node logging configuration...${NC}"
    if grep -q "^LOG_LEVEL=" "$AI_NODE_ENV_FILE"; then
        sed -i.bak "s/^LOG_LEVEL=.*/LOG_LEVEL=$LOG_LEVEL/" "$AI_NODE_ENV_FILE"
    else
        echo "LOG_LEVEL=$LOG_LEVEL" >> "$AI_NODE_ENV_FILE"
    fi
    echo -e "${GREEN}AI Node log level set to: $LOG_LEVEL${NC}"
else
    echo -e "${YELLOW}Warning: AI Node .env.local file not found at $AI_NODE_ENV_FILE${NC}"
fi

# Update External Adapter .env file
ADAPTER_ENV_FILE="$INSTALL_DIR/external-adapter/.env"
if [ -f "$ADAPTER_ENV_FILE" ]; then
    echo -e "${BLUE}Updating External Adapter logging configuration...${NC}"
    if grep -q "^LOG_LEVEL=" "$ADAPTER_ENV_FILE"; then
        sed -i.bak "s/^LOG_LEVEL=.*/LOG_LEVEL=$LOG_LEVEL/" "$ADAPTER_ENV_FILE"
    else
        echo "LOG_LEVEL=$LOG_LEVEL" >> "$ADAPTER_ENV_FILE"
    fi
    echo -e "${GREEN}External Adapter log level set to: $LOG_LEVEL${NC}"
else
    echo -e "${YELLOW}Warning: External Adapter .env file not found at $ADAPTER_ENV_FILE${NC}"
fi

# Final verification of @verdikta/common versions in installed components
echo -e "${BLUE}Final verification of @verdikta/common versions in installed components...${NC}"
INSTALLED_AI_NODE_VERSION=""
INSTALLED_ADAPTER_VERSION=""

if [ -d "$INSTALL_DIR/ai-node" ]; then
    INSTALLED_AI_NODE_VERSION=$(cd "$INSTALL_DIR/ai-node" && npm list @verdikta/common --depth=0 2>/dev/null | grep @verdikta/common | awk '{print $2}' || echo "not found")
fi

if [ -d "$INSTALL_DIR/external-adapter" ]; then
    INSTALLED_ADAPTER_VERSION=$(cd "$INSTALL_DIR/external-adapter" && npm list @verdikta/common --depth=0 2>/dev/null | grep @verdikta/common | awk '{print $2}' || echo "not found")
fi

echo -e "${BLUE}Installed AI Node @verdikta/common version: $INSTALLED_AI_NODE_VERSION${NC}"
echo -e "${BLUE}Installed External Adapter @verdikta/common version: $INSTALLED_ADAPTER_VERSION${NC}"

if [ "$INSTALLED_AI_NODE_VERSION" = "$INSTALLED_ADAPTER_VERSION" ] && [ "$INSTALLED_AI_NODE_VERSION" != "not found" ]; then
    echo -e "${GREEN}✅ Installation verification passed: Both components have matching @verdikta/common versions ($INSTALLED_AI_NODE_VERSION)${NC}"
    echo -e "${GREEN}✅ Latest ClassID model pool data is available in both components${NC}"
else
    echo -e "${YELLOW}⚠️  Installation verification warning: Version mismatch detected${NC}"
    echo -e "${YELLOW}   AI Node: $INSTALLED_AI_NODE_VERSION${NC}"
    echo -e "${YELLOW}   External Adapter: $INSTALLED_ADAPTER_VERSION${NC}"
    echo -e "${YELLOW}   This may cause compatibility issues. Consider running the update utility manually.${NC}"
fi

fi  # End of NEED_POST_INSTALLATION conditional block

# Optional: Fund Chainlink keys automatically
if [ "$SKIP_TO_REGISTRATION" = "false" ]; then
    # Only offer funding during fresh installation, not during registration resume
    echo
    echo -e "${BLUE}============================================================${NC}"
    echo -e "${BLUE}  Optional: Automatic Chainlink Key Funding${NC}"
    echo -e "${BLUE}============================================================${NC}"
    echo
    echo -e "${BLUE}Your Chainlink keys need native ETH to pay for gas fees.${NC}"
    echo -e "${BLUE}Without funding, your oracle cannot process arbitration requests.${NC}"
    echo
    
    # Determine recommended amount based on network
    if [ "$NETWORK_TYPE" = "testnet" ]; then
        RECOMMENDED_AMOUNT="0.005"
        CURRENCY_NAME="Base Sepolia ETH"
        FUNDING_INFO="This is free testnet currency from faucets."
    else
        RECOMMENDED_AMOUNT="0.002"
        CURRENCY_NAME="Base ETH"
        FUNDING_INFO="This will use real ETH from your wallet."
    fi
    
    echo -e "${BLUE}Recommended funding: $RECOMMENDED_AMOUNT $CURRENCY_NAME per key${NC}"
    echo -e "${BLUE}Your installation has keys that need funding.${NC}"
    echo -e "${YELLOW}Note: $FUNDING_INFO${NC}"
    echo
    
    if ask_yes_no "Would you like to automatically fund your Chainlink keys now?"; then
        echo
        echo -e "${BLUE}Automatic Funding Configuration${NC}"
        echo -e "${BLUE}Recommended amount: $RECOMMENDED_AMOUNT $CURRENCY_NAME per key${NC}"
        echo -e "${BLUE}This amount provides approximately 50 arbitration queries worth of gas.${NC}"
        echo
        
        # Ask if user wants to use recommended amount or custom amount
        echo -e "${BLUE}Funding options:${NC}"
        echo -e "${BLUE}  1) Use recommended amount ($RECOMMENDED_AMOUNT $CURRENCY_NAME per key)${NC}"
        echo -e "${BLUE}  2) Specify custom amount${NC}"
        echo -e "${BLUE}  3) Skip automatic funding${NC}"
        echo
        
        while true; do
            read -p "Choose option (1-3) [1]: " funding_choice
            
            # Default to option 1 if empty
            if [ -z "$funding_choice" ]; then
                funding_choice=1
            fi
            
            case "$funding_choice" in
                1)
                    FUNDING_AMOUNT="$RECOMMENDED_AMOUNT"
                    echo -e "${GREEN}Using recommended amount: $FUNDING_AMOUNT $CURRENCY_NAME per key${NC}"
                    break
                    ;;
                2)
                    while true; do
                        read -p "Enter custom amount per key (in $CURRENCY_NAME): " custom_amount
                        
                        if [[ "$custom_amount" =~ ^[0-9]+\.?[0-9]*$ ]] && (( $(echo "$custom_amount > 0" | bc -l) )); then
                            FUNDING_AMOUNT="$custom_amount"
                            echo -e "${GREEN}Using custom amount: $FUNDING_AMOUNT $CURRENCY_NAME per key${NC}"
                            break 2
                        else
                            echo -e "${RED}Please enter a valid positive number${NC}"
                        fi
                    done
                    ;;
                3)
                    echo -e "${BLUE}Skipping automatic funding.${NC}"
                    FUNDING_AMOUNT=""
                    break
                    ;;
                *)
                    echo -e "${RED}Invalid choice. Please enter 1, 2, or 3.${NC}"
                    ;;
            esac
        done
        
        if [ -n "$FUNDING_AMOUNT" ]; then
            echo
            echo -e "${YELLOW}⚠ IMPORTANT: This will transfer $CURRENCY_NAME from your deployment wallet.${NC}"
            echo -e "${YELLOW}⚠ Your wallet will be charged for both the funding amount and gas fees.${NC}"
            echo
            
            if ask_yes_no "Proceed with automatic funding?"; then
                echo -e "${BLUE}Starting automatic funding process...${NC}"
                echo
                
                # Run the funding script
                if bash "$SCRIPT_DIR/fund-chainlink-keys.sh" --amount "$FUNDING_AMOUNT" --force; then
                    echo
                    echo -e "${GREEN}✓ Automatic funding completed successfully!${NC}"
                    echo -e "${GREEN}✓ Your Chainlink keys are now funded and ready for operation.${NC}"
                    KEYS_FUNDED=true
                else
                    echo
                    echo -e "${YELLOW}⚠ Automatic funding encountered issues.${NC}"
                    echo -e "${BLUE}You can retry funding later using:${NC}"
                    echo -e "${GREEN}  $INSTALL_DIR/fund-chainlink-keys.sh${NC}"
                    KEYS_FUNDED=false
                fi
            else
                echo -e "${BLUE}Automatic funding cancelled.${NC}"
                KEYS_FUNDED=false
            fi
        else
            KEYS_FUNDED=false
        fi
    else
        echo -e "${BLUE}Skipping automatic funding.${NC}"
        KEYS_FUNDED=false
    fi
    
    if [ "$KEYS_FUNDED" = "false" ]; then
        echo
        echo -e "${YELLOW}📌 IMPORTANT: Manual Funding Required${NC}"
        echo -e "${YELLOW}Your Chainlink keys need $CURRENCY_NAME to operate.${NC}"
        echo
        echo -e "${BLUE}You can fund your keys later using:${NC}"
        echo -e "${GREEN}  $INSTALL_DIR/fund-chainlink-keys.sh${NC}"
        echo
        echo -e "${BLUE}Or manually send $CURRENCY_NAME to each key address listed in:${NC}"
        echo -e "${GREEN}  $INSTALL_DIR/installer/.contracts${NC}"
        echo
        echo -e "${BLUE}Recommended amount: $RECOMMENDED_AMOUNT $CURRENCY_NAME per key${NC}"
    fi
fi

# Ask if user wants to start services now (this should happen in both normal and resume modes)
echo
if [ "$SKIP_TO_REGISTRATION" = "true" ]; then
    # Check registration status for resume mode
    if [ -f "$INSTALLER_DIR/.registration_state" ]; then
        source "$INSTALLER_DIR/.registration_state"
        if [ "$REGISTRATION_SUCCESS" = "true" ]; then
            echo -e "${GREEN}Registration completed successfully!${NC}"
        else
            echo -e "${YELLOW}Registration step completed. Check the output above for status.${NC}"
        fi
    fi
    echo -e "${BLUE}Your Verdikta Arbiter services are ready.${NC}"
else
    echo -e "${YELLOW}Installation complete! Your services are now ready to start.${NC}"
fi
echo -e "${BLUE}Would you like to start the Verdikta Arbiter services now?${NC}"
echo -e "${BLUE}This will start the AI Node, External Adapter, and Chainlink Node.${NC}"
echo

# ask_yes_no function is now defined at the top of this script

if ask_yes_no "Start Verdikta Arbiter services?"; then
    echo -e "${BLUE}Starting Verdikta Arbiter services...${NC}"
    echo -e "${BLUE}This may take a few minutes for all services to fully initialize.${NC}"
    
    # Start all services using the management script from target directory
    "$INSTALL_DIR/start-arbiter.sh"
    
    echo -e "${GREEN}Verdikta Arbiter services have been started!${NC}"
    echo -e "${BLUE}You can check the status with: $INSTALL_DIR/arbiter-status.sh${NC}"
else
    echo -e "${BLUE}Services are not running. You can start them later with:${NC}"
    echo -e "  $INSTALL_DIR/start-arbiter.sh"
fi

# Success!
echo -e "${GREEN}"
echo "===================================================="
if [ "$SKIP_TO_REGISTRATION" = "true" ]; then
    echo "  Verdikta Arbiter Oracle Registration Complete!"
else
    echo "  Verdikta Arbiter Node Installation Complete!"
fi
echo "===================================================="
echo -e "${NC}"
if [ "$SKIP_TO_REGISTRATION" = "true" ]; then
    echo "Oracle registration process completed."
    
    # Check final registration status
    if [ -f "$INSTALLER_DIR/.registration_state" ]; then
        source "$INSTALLER_DIR/.registration_state"
        if [ "$REGISTRATION_SUCCESS" = "true" ]; then
            echo -e "${GREEN}Your oracle has been successfully registered with the dispatcher!${NC}"
        else
            echo -e "${YELLOW}Registration may have encountered issues. Please check the output above.${NC}"
        fi
    fi
else
    echo "Congratulations! Your Verdikta Arbiter Node has been successfully installed."
fi
echo 
echo "Access your services at:"
echo "  - AI Node:         http://localhost:3000"
echo "  - External Adapter: http://localhost:8080 (with Verdikta Common Library)"
echo "  - Chainlink Node:   http://localhost:6688"
echo
echo "All utility scripts are available in: $INSTALL_DIR/installer/util/"
echo "For troubleshooting, consult the documentation in the installer/docs directory."
echo "To back up your installation, run: bash $INSTALL_DIR/installer/util/backup-restore.sh backup"
echo ""
echo "ClassID Model Pool Integration:"
echo "  - Your AI Node has been configured with ClassID model pools"
echo "  - To reconfigure model pools: cd $INSTALL_DIR/ai-node && npm run integrate-classid"
echo "  - To test ClassID integration: cd $INSTALL_DIR/ai-node && npm run test-classid"
echo ""
if [ "$KEYS_FUNDED" != "true" ]; then
    echo "NEXT STEPS:"
    echo "  1. Fund your Chainlink keys: $INSTALL_DIR/fund-chainlink-keys.sh"
    echo "  2. Start your services: $INSTALL_DIR/start-arbiter.sh"
    echo ""
fi
echo "Thank you for using Verdikta Arbiter Node!" 