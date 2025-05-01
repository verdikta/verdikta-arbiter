#!/bin/bash

# Verdikta Arbiter Node - Installation Verification Script
# Checks if all components are installed and configured correctly

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

echo -e "${BLUE}Verifying Verdikta Arbiter Node Installation...${NC}"

# Load environment variables
if [ -f "$INSTALLER_DIR/.env" ]; then
    source "$INSTALLER_DIR/.env"
else
    echo -e "${RED}Error: Environment file not found. Installation may be incomplete.${NC}"
    exit 1
fi

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to check if a service is running
check_service() {
    local name="$1"
    local url="$2"
    local message="${3:-Running}"
    
    echo -ne "${BLUE}Checking $name... ${NC}"
    if curl -s "$url" > /dev/null; then
        echo -e "${GREEN}$message${NC}"
        return 0
    else
        echo -e "${RED}Not running${NC}"
        return 1
    fi
}

# Variables to track checks
FAIL=0
WARNINGS=0

# Verify AI Node
echo -e "${BLUE}Verifying AI Node...${NC}"
AI_NODE_DIR="$(dirname "$INSTALLER_DIR")/ai-node"
if [ -d "$AI_NODE_DIR" ] && [ -f "$AI_NODE_DIR/.env.local" ]; then
    echo -e "${GREEN}✓ AI Node files found at $AI_NODE_DIR${NC}"
    
    # Check if it's running
    AI_NODE_RUNNING=0
    check_service "AI Node" "http://localhost:3000/health" || AI_NODE_RUNNING=1
    
    if [ $AI_NODE_RUNNING -eq 1 ]; then
        echo -e "${YELLOW}NOTICE: AI Node is not running. To start it:${NC}"
        echo -e "${YELLOW}cd $AI_NODE_DIR && ./start.sh${NC}"
        WARNINGS=$((WARNINGS+1))
    fi
else
    echo -e "${RED}✗ AI Node files not found at $AI_NODE_DIR${NC}"
    echo -e "${RED}AI Node installation appears to be incomplete or missing.${NC}"
    FAIL=1
fi

# Verify External Adapter
echo -e "${BLUE}Verifying External Adapter...${NC}"
ADAPTER_DIR="$(dirname "$INSTALLER_DIR")/external-adapter"
if [ -d "$ADAPTER_DIR" ] && [ -f "$ADAPTER_DIR/.env" ]; then
    echo -e "${GREEN}✓ External Adapter files found at $ADAPTER_DIR${NC}"
    
    # Check if it's running
    ADAPTER_RUNNING=0
    check_service "External Adapter" "http://localhost:8080/health" || ADAPTER_RUNNING=1
    
    if [ $ADAPTER_RUNNING -eq 1 ]; then
        echo -e "${YELLOW}NOTICE: External Adapter is not running. To start it:${NC}"
        echo -e "${YELLOW}cd $ADAPTER_DIR && ./start.sh${NC}"
        WARNINGS=$((WARNINGS+1))
    fi
else
    echo -e "${RED}✗ External Adapter files not found at $ADAPTER_DIR${NC}"
    echo -e "${RED}External Adapter installation appears to be incomplete or missing.${NC}"
    FAIL=1
fi

# Verify Docker
echo -e "${BLUE}Verifying Docker...${NC}"
if command_exists docker; then
    echo -e "${GREEN}✓ Docker is installed${NC}"
    
    # Check if Docker daemon is running
    if docker info > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Docker daemon is running${NC}"
    else
        echo -e "${RED}✗ Docker daemon is not running${NC}"
        FAIL=1
    fi
else
    echo -e "${RED}✗ Docker is not installed${NC}"
    FAIL=1
fi

# Verify PostgreSQL
echo -e "${BLUE}Verifying PostgreSQL...${NC}"
if docker ps | grep -q "cl-postgres"; then
    echo -e "${GREEN}✓ PostgreSQL container is running${NC}"
    
    # Check if PostgreSQL is responsive
    if docker exec cl-postgres pg_isready -q; then
        echo -e "${GREEN}✓ PostgreSQL is responsive${NC}"
    else
        echo -e "${RED}✗ PostgreSQL is not responsive${NC}"
        FAIL=1
    fi
else
    echo -e "${RED}✗ PostgreSQL container is not running${NC}"
    echo -e "${YELLOW}To start PostgreSQL: docker start cl-postgres${NC}"
    FAIL=1
fi

# Verify Chainlink Node
echo -e "${BLUE}Verifying Chainlink Node...${NC}"
CHAINLINK_DIR="$HOME/.chainlink-sepolia"
if [ -d "$CHAINLINK_DIR" ] && [ -f "$CHAINLINK_DIR/config.toml" ] && [ -f "$CHAINLINK_DIR/secrets.toml" ]; then
    echo -e "${GREEN}✓ Chainlink Node configuration found at $CHAINLINK_DIR${NC}"
    
    # Check if it's running
    CHAINLINK_RUNNING=0
    check_service "Chainlink Node" "http://localhost:6688/health" || CHAINLINK_RUNNING=1
    
    if [ $CHAINLINK_RUNNING -eq 1 ]; then
        echo -e "${YELLOW}NOTICE: Chainlink Node is not running. To start it:${NC}"
        echo -e "${YELLOW}docker start chainlink${NC}"
        WARNINGS=$((WARNINGS+1))
    fi
else
    echo -e "${RED}✗ Chainlink Node configuration not found at $CHAINLINK_DIR${NC}"
    echo -e "${RED}Chainlink Node installation appears to be incomplete or missing.${NC}"
    FAIL=1
fi

# Verify Smart Contracts
echo -e "${BLUE}Verifying Smart Contracts...${NC}"
if [ -f "$INSTALLER_DIR/.contracts" ]; then
    source "$INSTALLER_DIR/.contracts"
    if [ -n "$OPERATOR_ADDRESS" ] && [ -n "$NODE_ADDRESS" ] && [ -n "$JOB_ID" ]; then
        echo -e "${GREEN}✓ Contract information found${NC}"
        echo -e "${GREEN}  Operator Contract: $OPERATOR_ADDRESS${NC}"
        echo -e "${GREEN}  Node Address: $NODE_ADDRESS${NC}"
        echo -e "${GREEN}  Job ID: $JOB_ID${NC}"
    else
        echo -e "${YELLOW}WARNING: Contract information appears incomplete.${NC}"
        WARNINGS=$((WARNINGS+1))
    fi
else
    echo -e "${YELLOW}WARNING: Contract information not found.${NC}"
    echo -e "${YELLOW}Smart Contracts may not have been deployed yet.${NC}"
    WARNINGS=$((WARNINGS+1))
fi

# Verify network connectivity between components
echo -e "${BLUE}Verifying network connectivity between components...${NC}"

# Check AI Node to External Adapter connectivity
if [ $AI_NODE_RUNNING -eq 0 ] && [ $ADAPTER_RUNNING -eq 0 ]; then
    # Test using curl from external adapter to AI node
    if docker exec cl-postgres curl -s http://localhost:3000/health > /dev/null; then
        echo -e "${GREEN}✓ AI Node is accessible from Docker network${NC}"
    else
        echo -e "${YELLOW}WARNING: AI Node may not be accessible from Docker network.${NC}"
        echo -e "${YELLOW}This may cause issues with the External Adapter connecting to the AI Node.${NC}"
        WARNINGS=$((WARNINGS+1))
    fi
else
    echo -e "${YELLOW}WARNING: Cannot verify network connectivity because some services are not running.${NC}"
    WARNINGS=$((WARNINGS+1))
fi

# Verify client contract setup
echo -e "${BLUE}Verifying client contract setup...${NC}"
CLIENT_CONTRACT_VERIFIED=true

# Check if client contract address exists in .contracts file
if [ -f "$INSTALLER_DIR/.contracts" ]; then
    source "$INSTALLER_DIR/.contracts"
    if [ -z "$CLIENT_ADDRESS" ]; then
        echo -e "${YELLOW}Warning: Client contract address not found in .contracts file.${NC}"
        echo -e "${YELLOW}This may indicate the client contract was not deployed or configured properly.${NC}"
        CLIENT_CONTRACT_VERIFIED=false
    else
        echo -e "${GREEN}Client contract address found: $CLIENT_ADDRESS${NC}"
    fi
else
    echo -e "${YELLOW}Warning: Contract information file not found.${NC}"
    CLIENT_CONTRACT_VERIFIED=false
fi

# Check if client contract directory exists
CLIENT_DIR="$(dirname "$INSTALLER_DIR")/demo-client"
if [ ! -d "$CLIENT_DIR" ]; then
    echo -e "${YELLOW}Warning: Client contract directory not found at $CLIENT_DIR.${NC}"
    CLIENT_CONTRACT_VERIFIED=false
else
    echo -e "${GREEN}Client contract directory exists.${NC}"
    
    # Check for migration file
    if [ -f "$CLIENT_DIR/migrations/2_deploy_contract.js" ]; then
        echo -e "${GREEN}Migration file exists.${NC}"
        
        # Check if migration file has been configured
        if grep -q "const oracleAddress = \"$OPERATOR_ADDRESS\"" "$CLIENT_DIR/migrations/2_deploy_contract.js" && \
           grep -q "const jobId = \"$JOB_ID_NO_HYPHENS\"" "$CLIENT_DIR/migrations/2_deploy_contract.js"; then
            echo -e "${GREEN}Migration file is properly configured.${NC}"
        else
            echo -e "${YELLOW}Warning: Migration file may not be properly configured.${NC}"
            CLIENT_CONTRACT_VERIFIED=false
        fi
    else
        echo -e "${YELLOW}Warning: Migration file not found.${NC}"
        CLIENT_CONTRACT_VERIFIED=false
    fi
    
    # Check for build artifacts
    if [ -d "$CLIENT_DIR/build" ]; then
        echo -e "${GREEN}Build artifacts directory exists, indicating contract was compiled.${NC}"
    else
        echo -e "${YELLOW}Warning: Build artifacts directory not found. Contract may not have been compiled.${NC}"
        CLIENT_CONTRACT_VERIFIED=false
    fi
fi

# Update the verification summary to include client contract status
if [ "$CLIENT_CONTRACT_VERIFIED" = false ]; then
    VERIFICATION_FAILED=true
fi

# Summary
echo -e "\n${BLUE}=== Verification Summary ===${NC}"
if [ $FAIL -eq 0 ]; then
    if [ $WARNINGS -eq 0 ]; then
        echo -e "${GREEN}✓ All checks passed! Your Verdikta Arbiter Node is properly installed and configured.${NC}"
    else
        echo -e "${YELLOW}⚠ Verification completed with $WARNINGS warning(s).${NC}"
        echo -e "${YELLOW}Your installation may be complete, but some components need attention.${NC}"
    fi
    exit 0
else
    echo -e "${RED}✗ Verification failed with errors.${NC}"
    echo -e "${RED}Please address the issues above before using your Verdikta Arbiter Node.${NC}"
    exit 1
fi 