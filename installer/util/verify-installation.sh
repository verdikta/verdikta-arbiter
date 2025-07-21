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
INFO=0

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
CHAINLINK_DIR="$HOME/.chainlink-${NETWORK_TYPE}"
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
    if [ -n "$OPERATOR_ADDR" ] && [ -n "$NODE_ADDRESS" ] && [ -n "$JOB_ID" ] && [ -n "$JOB_ID_NO_HYPHENS" ]; then
        echo -e "${GREEN}✓ Contract information found${NC}"
        echo -e "${GREEN}  Operator Contract: $OPERATOR_ADDR${NC}"
        echo -e "${GREEN}  Node Address: $NODE_ADDRESS${NC}"
        echo -e "${GREEN}  Job ID: $JOB_ID${NC}"
        echo -e "${GREEN}  Job ID (no hyphens): $JOB_ID_NO_HYPHENS${NC}"
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

# Check if both services are running before testing connectivity
if [ $AI_NODE_RUNNING -eq 0 ] && [ $ADAPTER_RUNNING -eq 0 ]; then
    # Test connectivity using curl directly from the host
    if curl -s http://localhost:3000/health > /dev/null; then
        echo -e "${GREEN}✓ AI Node is accessible from host${NC}"
        if curl -s http://localhost:8080/health > /dev/null; then
            echo -e "${GREEN}✓ External Adapter is accessible from host${NC}"
            echo -e "${GREEN}✓ Network connectivity between components is working${NC}"
        else
            echo -e "${YELLOW}WARNING: External Adapter is not accessible from host.${NC}"
            WARNINGS=$((WARNINGS+1))
        fi
    else
        echo -e "${YELLOW}WARNING: AI Node is not accessible from host.${NC}"
        WARNINGS=$((WARNINGS+1))
    fi
else
    echo -e "${YELLOW}INFO: Cannot verify network connectivity because some services are not running.${NC}"
    INFO=$((INFO+1))
fi

# Verify Oracle Registration (Optional)
echo -e "${BLUE}Verifying Oracle Registration...${NC}"
if [ -f "$INSTALLER_DIR/.contracts" ]; then
    source "$INSTALLER_DIR/.contracts"
    if [ -n "$AGGREGATOR_ADDRESS" ]; then
        echo -e "${GREEN}✓ Oracle is registered with aggregator: $AGGREGATOR_ADDRESS${NC}"
    else
        echo -e "${BLUE}INFO: Oracle is not registered with an aggregator.${NC}"
        echo -e "${BLUE}This is optional. To register:${NC}"
        echo -e "${BLUE}bash $INSTALLER_DIR/bin/register-oracle-dispatcher.sh${NC}"
        INFO=$((INFO+1))
    fi
else
    echo -e "${YELLOW}WARNING: Contract information not found.${NC}"
    WARNINGS=$((WARNINGS+1))
fi

# Summary
echo -e "\n${BLUE}=== Verification Summary ===${NC}"
if [ $FAIL -eq 0 ]; then
    if [ $WARNINGS -eq 0 ]; then
        echo -e "${GREEN}✓ All checks passed! Your Verdikta Arbiter Node is properly installed and configured.${NC}"
        if [ $INFO -gt 0 ]; then
            echo -e "${BLUE}Note: $INFO informational message(s) above.${NC}"
        fi
    else
        echo -e "${YELLOW}⚠ Verification completed with $WARNINGS warning(s).${NC}"
        echo -e "${YELLOW}Your installation may be complete, but some components need attention.${NC}"
        if [ $INFO -gt 0 ]; then
            echo -e "${BLUE}Note: $INFO informational message(s) above.${NC}"
        fi
    fi
    exit 0
else
    echo -e "${RED}✗ Verification failed with errors.${NC}"
    echo -e "${RED}Please address the issues above before using your Verdikta Arbiter Node.${NC}"
    if [ $INFO -gt 0 ]; then
        echo -e "${BLUE}Note: $INFO informational message(s) above.${NC}"
    fi
    exit 1
fi 