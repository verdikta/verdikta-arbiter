#!/bin/bash

# Verdikta Arbiter Stop Script
# Stops all Verdikta Arbiter components

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

echo -e "${BLUE}Stopping Verdikta Arbiter services located in $INSTALL_DIR...${NC}"

# Function to check if a process is running on a port
check_port() {
    if lsof -i:$1 >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# Stop AI Node
echo -e "${BLUE}Stopping AI Node...${NC}"
if [ -f "$AI_NODE_DIR/stop.sh" ]; then
    # Ensure the directory exists before trying to cd into it
    if [ -d "$AI_NODE_DIR" ]; then
    cd "$AI_NODE_DIR" && ./stop.sh
    if ! check_port 3000; then
        echo -e "${GREEN}AI Node stopped successfully.${NC}"
    else
            echo -e "${RED}Failed to stop AI Node via script.${NC}"
        # Force stop as a backup
        AI_NODE_PID=$(lsof -i:3000 -t 2>/dev/null)
        if [ -n "$AI_NODE_PID" ]; then
            echo -e "${YELLOW}Forcing AI Node to stop (PID: $AI_NODE_PID)...${NC}"
            kill -9 $AI_NODE_PID 2>/dev/null
        fi
        fi
    else
        echo -e "${RED}AI Node directory not found at $AI_NODE_DIR${NC}"
    fi
else
    echo -e "${YELLOW}AI Node stop script not found. Attempting direct process termination...${NC}"
    AI_NODE_PID=$(lsof -i:3000 -t 2>/dev/null)
    if [ -n "$AI_NODE_PID" ]; then
        echo -e "${BLUE}Stopping AI Node process (PID: $AI_NODE_PID)...${NC}"
        kill -9 $AI_NODE_PID 2>/dev/null
        echo -e "${GREEN}AI Node process terminated.${NC}"
    else
        echo -e "${YELLOW}No AI Node process found running on port 3000.${NC}"
    fi
fi

# Stop External Adapter
echo -e "${BLUE}Stopping External Adapter...${NC}"
if [ -f "$ADAPTER_DIR/stop.sh" ]; then
    # Ensure the directory exists before trying to cd into it
    if [ -d "$ADAPTER_DIR" ]; then
    cd "$ADAPTER_DIR" && ./stop.sh
    if ! check_port 8080; then
        echo -e "${GREEN}External Adapter stopped successfully.${NC}"
    else
            echo -e "${RED}Failed to stop External Adapter via script.${NC}"
        # Force stop as a backup
        ADAPTER_PID=$(lsof -i:8080 -t 2>/dev/null)
        if [ -n "$ADAPTER_PID" ]; then
            echo -e "${YELLOW}Forcing External Adapter to stop (PID: $ADAPTER_PID)...${NC}"
            kill -9 $ADAPTER_PID 2>/dev/null
        fi
        fi
    else
        echo -e "${RED}External Adapter directory not found at $ADAPTER_DIR${NC}"
    fi
else
    echo -e "${YELLOW}External Adapter stop script not found. Attempting direct process termination...${NC}"
    ADAPTER_PID=$(lsof -i:8080 -t 2>/dev/null)
    if [ -n "$ADAPTER_PID" ]; then
        echo -e "${BLUE}Stopping External Adapter process (PID: $ADAPTER_PID)...${NC}"
        kill -9 $ADAPTER_PID 2>/dev/null
        echo -e "${GREEN}External Adapter process terminated.${NC}"
    else
        echo -e "${YELLOW}No External Adapter process found running on port 8080.${NC}"
    fi
fi

# Stop Chainlink Node
echo -e "${BLUE}Stopping Chainlink Node...${NC}"
if docker ps | grep -q "chainlink"; then
    echo -e "${BLUE}Stopping Chainlink container...${NC}"
    docker stop chainlink
    echo -e "${GREEN}Chainlink Node stopped successfully.${NC}"
else
    echo -e "${YELLOW}Chainlink container is not running.${NC}"
fi

# Print status
# echo -e "${BLUE}Verdikta Validator Status:${NC}"
echo -e "${BLUE}Verdikta Arbiter Status:${NC}"
echo -e "  AI Node:          $(check_port 3000 && echo -e "${RED}Still Running${NC}" || echo -e "${GREEN}Stopped${NC}")"
echo -e "  External Adapter: $(check_port 8080 && echo -e "${RED}Still Running${NC}" || echo -e "${GREEN}Stopped${NC}")"
echo -e "  Chainlink Node:   $(check_port 6688 && echo -e "${RED}Still Running${NC}" || echo -e "${GREEN}Stopped${NC}")"

# echo -e "${GREEN}Verdikta Validator shutdown completed.${NC}"
echo -e "${GREEN}Verdikta Arbiter shutdown completed.${NC}" 