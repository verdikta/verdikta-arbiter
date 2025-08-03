#!/bin/bash

# Comprehensive External Adapter Stop Script
# Ensures all adapter-related processes are completely stopped

cd "$(dirname "$0")"
ADAPTER_DIR="$(pwd)"

# Color definitions for better output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Stopping External Adapter...${NC}"

# Track what we stopped
STOPPED_PROCESSES=0

# Function to safely kill a process and verify it's stopped
kill_and_verify() {
    local pid=$1
    local description=$2
    
    if [ -z "$pid" ]; then
        return 1
    fi
    
    # Check if process exists
    if ! ps -p "$pid" > /dev/null 2>&1; then
        return 1
    fi
    
    echo -e "${YELLOW}Stopping $description (PID: $pid)...${NC}"
    
    # Try graceful termination first
    if kill -TERM "$pid" 2>/dev/null; then
        # Wait up to 5 seconds for graceful shutdown
        for i in {1..5}; do
            if ! ps -p "$pid" > /dev/null 2>&1; then
                echo -e "${GREEN}✓ $description stopped gracefully${NC}"
                STOPPED_PROCESSES=$((STOPPED_PROCESSES + 1))
                return 0
            fi
            sleep 1
        done
        
        # If still running, force kill
        echo -e "${YELLOW}Process didn't stop gracefully, force killing...${NC}"
        if kill -KILL "$pid" 2>/dev/null; then
            sleep 1
            if ! ps -p "$pid" > /dev/null 2>&1; then
                echo -e "${GREEN}✓ $description force stopped${NC}"
                STOPPED_PROCESSES=$((STOPPED_PROCESSES + 1))
                return 0
            fi
        fi
    fi
    
    echo -e "${RED}✗ Failed to stop $description${NC}"
    return 1
}

# 1. Stop process from PID file
if [ -f adapter.pid ]; then
    pid=$(cat adapter.pid 2>/dev/null)
    if [ -n "$pid" ] && [ "$pid" -ne 0 ] 2>/dev/null; then
        kill_and_verify "$pid" "External Adapter (from PID file)"
        rm -f adapter.pid
    else
        echo -e "${YELLOW}Invalid PID file, removing...${NC}"
        rm -f adapter.pid
    fi
fi

# 2. Stop any processes using port 8080
PORT_PIDS=$(lsof -ti:8080 2>/dev/null)
if [ -n "$PORT_PIDS" ]; then
    for pid in $PORT_PIDS; do
        kill_and_verify "$pid" "Process using port 8080"
    done
fi

# 3. Stop any npm processes running from this directory
NPM_PIDS=$(ps aux | grep "npm.*start" | grep -v grep | grep "$ADAPTER_DIR" | awk '{print $2}')
if [ -n "$NPM_PIDS" ]; then
    for pid in $NPM_PIDS; do
        kill_and_verify "$pid" "NPM process in adapter directory"
    done
fi

# 4. Stop any node processes running from this directory
NODE_PIDS=$(ps aux | grep "node.*src/index.js" | grep -v grep | grep "$ADAPTER_DIR" | awk '{print $2}')
if [ -n "$NODE_PIDS" ]; then
    for pid in $NODE_PIDS; do
        kill_and_verify "$pid" "Node.js adapter process"
    done
fi

# 5. Final cleanup - look for any remaining npm or node processes that might be related
echo -e "${BLUE}Performing final cleanup...${NC}"
REMAINING_NPM=$(ps aux | grep -E "(npm.*start|node.*chainlink-ai-adapter)" | grep -v grep | awk '{print $2}')
if [ -n "$REMAINING_NPM" ]; then
    echo -e "${YELLOW}Found remaining adapter-related processes, force killing...${NC}"
    for pid in $REMAINING_NPM; do
        kill -KILL "$pid" 2>/dev/null && echo -e "${GREEN}✓ Killed remaining process $pid${NC}"
    done
    STOPPED_PROCESSES=$((STOPPED_PROCESSES + 1))
fi

# 6. Verify port 8080 is free
sleep 2
if lsof -i:8080 >/dev/null 2>&1; then
    echo -e "${RED}✗ Warning: Port 8080 is still in use${NC}"
    lsof -i:8080
    exit 1
else
    echo -e "${GREEN}✓ Port 8080 is free${NC}"
fi

# 7. Clean up any stale PID files
rm -f adapter.pid

# Summary
if [ $STOPPED_PROCESSES -gt 0 ]; then
    echo -e "${GREEN}✓ External Adapter stopped successfully${NC}"
    echo -e "${GREEN}  Stopped $STOPPED_PROCESSES process(es)${NC}"
else
    echo -e "${BLUE}ℹ External Adapter was not running${NC}"
fi

echo -e "${GREEN}All External Adapter processes have been stopped.${NC}"
