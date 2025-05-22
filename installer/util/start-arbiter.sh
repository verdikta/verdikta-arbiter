#!/bin/bash

# Verdikta Arbiter Start Script
# Starts all Verdikta Arbiter components

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Base directory (where this script runs from - should be $INSTALL_DIR)
INSTALL_DIR="$(dirname "$(readlink -f "$0")")"

# Define component directories relative to $INSTALL_DIR
AI_NODE_DIR="$INSTALL_DIR/ai-node"
ADAPTER_DIR="$INSTALL_DIR/external-adapter"

echo -e "${BLUE}Starting Verdikta Arbiter from $INSTALL_DIR...${NC}"

# Function to check if a process is running on a port
check_port() {
    if lsof -i:$1 >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# Start AI Node
echo -e "${BLUE}Starting AI Node...${NC}"
if check_port 3000; then
    echo -e "${YELLOW}AI Node is already running on port 3000.${NC}"
else
    if [ -f "$AI_NODE_DIR/start.sh" ]; then
        # Ensure the directory exists before trying to cd into it
        if [ -d "$AI_NODE_DIR" ]; then
        cd "$AI_NODE_DIR" && ./start.sh &
        echo -e "${YELLOW}AI Node is starting up. This may take a few minutes...${NC}"
        sleep 10  # Increased from 5 to 10 seconds to give AI Node more time to start
        if check_port 3000; then
            echo -e "${GREEN}AI Node started successfully.${NC}"
        else
                echo -e "${YELLOW}AI Node is still initializing. It may take a few minutes to fully start.${NC}"
                echo -e "${YELLOW}You can check its status later with arbiter-status.sh${NC}"
                echo -e "${YELLOW}If it fails to start, check the logs at $AI_NODE_DIR/logs/ai-node_*.log${NC}"
            fi
        else
             echo -e "${RED}AI Node directory not found at $AI_NODE_DIR${NC}"
        fi
    else
        echo -e "${RED}AI Node start script not found at $AI_NODE_DIR/start.sh${NC}"
    fi
fi

# Start External Adapter
echo -e "${BLUE}Starting External Adapter...${NC}"
if check_port 8080; then
    echo -e "${YELLOW}External Adapter is already running on port 8080.${NC}"
else
    if [ -f "$ADAPTER_DIR/start.sh" ]; then
        # Ensure the directory exists before trying to cd into it
        if [ -d "$ADAPTER_DIR" ]; then
        cd "$ADAPTER_DIR" && ./start.sh &
        sleep 5
        if check_port 8080; then
            echo -e "${GREEN}External Adapter started successfully.${NC}"
        else
                echo -e "${RED}Failed to start External Adapter. Check logs at $ADAPTER_DIR/logs/adapter_*.log${NC}" # Updated log path based on install-adapter.sh
            fi
        else
            echo -e "${RED}External Adapter directory not found at $ADAPTER_DIR${NC}"
        fi
    else
        echo -e "${RED}External Adapter start script not found at $ADAPTER_DIR/start.sh${NC}"
    fi
fi

# Start Chainlink Node
echo -e "${BLUE}Starting Chainlink Node...${NC}"
if check_port 6688; then
    echo -e "${YELLOW}Chainlink Node is already running on port 6688.${NC}"
else
    if docker ps -a | grep -q "chainlink"; then
        echo -e "${BLUE}Starting Chainlink container...${NC}"
        docker start chainlink
        sleep 5
        if check_port 6688; then
            echo -e "${GREEN}Chainlink Node started successfully.${NC}"
        else
            echo -e "${RED}Failed to start Chainlink Node. Check the logs with 'docker logs chainlink'${NC}"
        fi
    else
        echo -e "${RED}Chainlink container not found. Please run setup-chainlink.sh first.${NC}"
    fi
fi

# Print status
echo -e "${BLUE}Verdikta Arbiter Status:${NC}"
echo -e "  AI Node:          $(check_port 3000 && echo -e "${GREEN}Running${NC}" || echo -e "${RED}Not Running${NC}")"
echo -e "  External Adapter: $(check_port 8080 && echo -e "${GREEN}Running${NC}" || echo -e "${RED}Not Running${NC}")"
echo -e "  Chainlink Node:   $(check_port 6688 && echo -e "${GREEN}Running${NC}" || echo -e "${RED}Not Running${NC}")"

echo -e "${GREEN}Verdikta Arbiter startup completed.${NC}"
echo -e "Access your services at:"
echo -e "  - AI Node:          http://localhost:3000"
echo -e "  - External Adapter: http://localhost:8080"
echo -e "  - Chainlink Node:   http://localhost:6688" 