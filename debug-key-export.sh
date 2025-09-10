#!/bin/bash

# Debug script to test key export functionality

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== Chainlink Key Export Debug ===${NC}"

# Check if we're in the right directory
if [ ! -f "bin/key-management.sh" ]; then
    echo -e "${RED}Error: Must run from installer directory${NC}"
    exit 1
fi

# Load API credentials
CHAINLINK_DIR="$HOME/.chainlink-testnet"
if [ -f "$CHAINLINK_DIR/.api" ]; then
    API_CREDENTIALS=( $(cat "$CHAINLINK_DIR/.api") )
    API_EMAIL="${API_CREDENTIALS[0]}"
    API_PASSWORD="${API_CREDENTIALS[1]}"
    echo -e "${GREEN}✓ Found API credentials: $API_EMAIL${NC}"
else
    echo -e "${RED}✗ API credentials not found at $CHAINLINK_DIR/.api${NC}"
    exit 1
fi

# Check Docker container
echo -e "${BLUE}Checking Chainlink container...${NC}"
CONTAINER_ID=$(docker ps -q --filter "name=chainlink")
if [ -z "$CONTAINER_ID" ]; then
    echo -e "${RED}✗ Chainlink container not running${NC}"
    echo "Please start Chainlink node first"
    exit 1
else
    echo -e "${GREEN}✓ Chainlink container running: $CONTAINER_ID${NC}"
fi

# Check node health
echo -e "${BLUE}Checking node health...${NC}"
HEALTH=$(curl -s http://localhost:6688/health 2>/dev/null)
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Node is responding${NC}"
else
    echo -e "${YELLOW}⚠ Node health check failed${NC}"
fi

# Test key export with full error output
KEY_ADDRESS="0x203ac46cCD9E0fD6E5c3155fdFCC269Cd4EBE884"
echo -e "${BLUE}Testing key export for: $KEY_ADDRESS${NC}"
echo -e "${BLUE}Running: bash bin/key-management.sh export_chainlink_private_key $KEY_ADDRESS $API_EMAIL [password]${NC}"

# Run with full error output
bash bin/key-management.sh export_chainlink_private_key "$KEY_ADDRESS" "$API_EMAIL" "$API_PASSWORD"
EXPORT_RESULT=$?

echo -e "${BLUE}Export result code: $EXPORT_RESULT${NC}"

if [ $EXPORT_RESULT -ne 0 ]; then
    echo -e "${RED}Key export failed${NC}"
    echo -e "${YELLOW}Possible causes:${NC}"
    echo "1. Chainlink node not fully started"
    echo "2. API credentials incorrect"
    echo "3. Key address not found in node"
    echo "4. expect package not installed"
else
    echo -e "${GREEN}Key export succeeded${NC}"
fi
