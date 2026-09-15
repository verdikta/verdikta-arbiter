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

# The AI Node (Next.js) listens on :3000 well before /api/health answers —
# ~60 s on a small VPS. Anything that checks status right after a start
# (install.sh, upgrade-arbiter.sh, the doctor, an operator) saw a FAIL and
# restarted it, which only resets the warm-up (issue #23). Wait, bounded,
# until it actually answers "ok". AI_NODE_START_TIMEOUT_SECS overrides.
ai_node_healthy() {
    curl -fsS --max-time 3 http://localhost:3000/api/health 2>/dev/null | grep -q '"status" *: *"ok"'
}
wait_for_ai_node() {
    local timeout="${AI_NODE_START_TIMEOUT_SECS:-180}" waited=0
    while [ "$waited" -lt "$timeout" ]; do
        if ai_node_healthy; then
            echo -e "${GREEN}AI Node is healthy (answered /api/health after ${waited}s).${NC}"
            return 0
        fi
        sleep 3; waited=$((waited+3))
    done
    echo -e "${YELLOW}AI Node has not answered /api/health after ${timeout}s.${NC}"
    echo -e "${YELLOW}It may still be starting; check the logs at $AI_NODE_DIR/logs/ai-node_*.log${NC}"
    return 1
}

# Start AI Node
echo -e "${BLUE}Starting AI Node...${NC}"
if check_port 3000; then
    echo -e "${YELLOW}AI Node is already running on port 3000.${NC}"
    # A listener is not readiness: it may be mid warm-up from an earlier start.
    wait_for_ai_node || true
else
    if [ -f "$AI_NODE_DIR/start.sh" ]; then
        # Ensure the directory exists before trying to cd into it
        if [ -d "$AI_NODE_DIR" ]; then
        cd "$AI_NODE_DIR" && ./start.sh &
        echo -e "${YELLOW}AI Node is starting up. This usually takes about a minute...${NC}"
        wait_for_ai_node || true
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