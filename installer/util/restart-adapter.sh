#!/bin/bash

# Comprehensive External Adapter Restart Script
# Safely stops, verifies shutdown, and restarts the External Adapter

cd "$(dirname "$0")"
ADAPTER_DIR="$(pwd)"

# Color definitions for better output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Restarting External Adapter...${NC}"
echo "=================================="

# Function to check if the adapter is healthy
check_adapter_health() {
    local max_attempts=30
    local attempt=1
    
    echo -e "${BLUE}Checking adapter health...${NC}"
    
    while [ $attempt -le $max_attempts ]; do
        # Check if port 8080 is listening
        if lsof -i:8080 >/dev/null 2>&1; then
            # Check if health endpoint responds
            if command -v curl >/dev/null 2>&1; then
                if curl -s -f http://localhost:8080/health >/dev/null 2>&1; then
                    echo -e "${GREEN}✓ External Adapter is healthy and responding${NC}"
                    return 0
                fi
            else
                # If curl isn't available, just check if port is listening
                echo -e "${GREEN}✓ External Adapter is listening on port 8080${NC}"
                return 0
            fi
        fi
        
        if [ $attempt -eq 1 ]; then
            echo -e "${YELLOW}Waiting for External Adapter to start...${NC}"
        fi
        
        sleep 2
        attempt=$((attempt + 1))
    done
    
    echo -e "${RED}✗ External Adapter failed to start properly${NC}"
    return 1
}

# Function to display current status
show_status() {
    echo -e "${BLUE}Current Status:${NC}"
    
    # Check PID file
    if [ -f adapter.pid ]; then
        pid=$(cat adapter.pid 2>/dev/null)
        if [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1; then
            echo -e "${GREEN}  ✓ PID file exists with running process: $pid${NC}"
        else
            echo -e "${YELLOW}  ⚠ PID file exists but process is not running${NC}"
        fi
    else
        echo -e "${YELLOW}  ⚠ No PID file found${NC}"
    fi
    
    # Check port usage
    if lsof -i:8080 >/dev/null 2>&1; then
        port_pid=$(lsof -ti:8080 2>/dev/null)
        echo -e "${GREEN}  ✓ Port 8080 is in use by PID: $port_pid${NC}"
    else
        echo -e "${RED}  ✗ Port 8080 is not in use${NC}"
    fi
    
    # Check latest log file
    if [ -d logs ]; then
        latest_log=$(ls -t logs/*.log 2>/dev/null | head -n1)
        if [ -n "$latest_log" ]; then
            echo -e "${BLUE}  ℹ Latest log: $latest_log${NC}"
        fi
    fi
}

# Step 1: Stop the External Adapter
echo -e "${YELLOW}Step 1: Stopping External Adapter...${NC}"
if [ -f stop.sh ]; then
    if ./stop.sh; then
        echo -e "${GREEN}✓ Stop script completed successfully${NC}"
    else
        echo -e "${RED}✗ Stop script failed${NC}"
        echo -e "${YELLOW}Continuing with restart attempt...${NC}"
    fi
else
    echo -e "${RED}✗ stop.sh script not found${NC}"
    exit 1
fi

# Step 2: Verify everything is stopped
echo -e "${YELLOW}Step 2: Verifying shutdown...${NC}"
sleep 3

# Check if anything is still running
if lsof -i:8080 >/dev/null 2>&1; then
    echo -e "${RED}✗ Port 8080 is still in use after stop attempt${NC}"
    echo "Processes using port 8080:"
    lsof -i:8080
    echo -e "${YELLOW}Attempting force cleanup...${NC}"
    
    # Force kill anything on port 8080
    port_pids=$(lsof -ti:8080 2>/dev/null)
    for pid in $port_pids; do
        echo -e "${YELLOW}Force killing PID $pid...${NC}"
        kill -KILL "$pid" 2>/dev/null
    done
    
    sleep 2
    
    # Final check
    if lsof -i:8080 >/dev/null 2>&1; then
        echo -e "${RED}✗ Failed to free port 8080. Cannot restart.${NC}"
        exit 1
    fi
fi

echo -e "${GREEN}✓ All processes stopped, port 8080 is free${NC}"

# Step 3: Start the External Adapter
echo -e "${YELLOW}Step 3: Starting External Adapter...${NC}"
if [ -f start.sh ]; then
    if ./start.sh; then
        echo -e "${GREEN}✓ Start script completed${NC}"
    else
        echo -e "${RED}✗ Start script failed${NC}"
        exit 1
    fi
else
    echo -e "${RED}✗ start.sh script not found${NC}"
    exit 1
fi

# Step 4: Verify the adapter started properly
echo -e "${YELLOW}Step 4: Verifying startup...${NC}"
if check_adapter_health; then
    echo -e "${GREEN}✓ External Adapter restarted successfully${NC}"
    
    # Show final status
    echo
    show_status
    
    # Show log location
    if [ -d logs ]; then
        latest_log=$(ls -t logs/*.log 2>/dev/null | head -n1)
        if [ -n "$latest_log" ]; then
            echo
            echo -e "${BLUE}Monitor logs with: tail -f $latest_log${NC}"
        fi
    fi
    
    echo
    echo -e "${GREEN}🎉 External Adapter restart completed successfully!${NC}"
    echo "=================================="
else
    echo -e "${RED}✗ External Adapter failed to start properly${NC}"
    echo
    echo -e "${YELLOW}Troubleshooting steps:${NC}"
    echo "1. Check the latest log file for errors"
    echo "2. Verify environment configuration in .env file"
    echo "3. Ensure all dependencies are installed (npm install)"
    echo "4. Check if other services (AI Node) are running"
    
    # Show current status for debugging
    echo
    show_status
    
    exit 1
fi