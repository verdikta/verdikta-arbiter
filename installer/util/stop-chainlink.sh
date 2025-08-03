#!/bin/bash

# Verdikta Arbiter - Chainlink Node Stop Script
# Cleanly stops the Chainlink node with graceful shutdown

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Stopping Verdikta Chainlink Node...${NC}\n"

# Function to check if a port is in use
check_port() {
    if lsof -i:$1 >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# Function to wait for port to become free
wait_for_port_free() {
    local port=$1
    local timeout=${2:-30}
    local count=0
    
    while check_port $port && [ $count -lt $timeout ]; do
        sleep 1
        count=$((count + 1))
        if [ $((count % 5)) -eq 0 ]; then
            printf "."
        fi
    done
    
    if check_port $port; then
        return 1  # Port still in use
    else
        return 0  # Port is free
    fi
}

# Check current status
echo -e "${BLUE}→ Checking current Chainlink status...${NC}"

if ! docker ps -a | grep -q "chainlink"; then
    echo -e "${YELLOW}⚠ Chainlink container not found${NC}"
    echo -e "${GREEN}  Nothing to stop${NC}"
    exit 0
fi

if ! docker ps | grep -q "chainlink"; then
    echo -e "${YELLOW}⚠ Chainlink container is not running${NC}"
    if check_port 6688; then
        echo -e "${YELLOW}  Port 6688 is still in use by another process${NC}"
        PROCESS_INFO=$(lsof -i:6688 -t 2>/dev/null)
        if [ -n "$PROCESS_INFO" ]; then
            echo -e "${YELLOW}  Process using port 6688: $PROCESS_INFO${NC}"
        fi
    else
        echo -e "${GREEN}✓ Chainlink is already stopped${NC}"
    fi
    exit 0
fi

# Get container info before stopping
CONTAINER_STATUS=$(docker ps --filter name=chainlink --format "{{.Status}}")
echo -e "Current status: ${BLUE}$CONTAINER_STATUS${NC}"

# Check if there are any active jobs (optional warning)
if check_port 6688; then
    echo -e "${YELLOW}⚠ Chainlink API is active - stopping may interrupt running jobs${NC}"
    
    # Option to check for running jobs (commented out to avoid dependency issues)
    # echo -e "${BLUE}  Checking for active jobs...${NC}"
    # Could add job checking logic here if needed
fi

# Attempt graceful shutdown first
echo -e "${BLUE}→ Attempting graceful shutdown...${NC}"
docker stop chainlink --time=30

if [ $? -ne 0 ]; then
    echo -e "${YELLOW}⚠ Graceful shutdown failed, forcing stop...${NC}"
    docker kill chainlink
    if [ $? -ne 0 ]; then
        echo -e "${RED}✗ Failed to stop Chainlink container${NC}"
        exit 1
    fi
fi

echo -e "${GREEN}✓ Chainlink container stopped${NC}"

# Wait for port to become free
if check_port 6688; then
    echo -e "${BLUE}→ Waiting for port 6688 to become available...${NC}"
    printf "   "
    
    if wait_for_port_free 6688 30; then
        echo -e "\n${GREEN}✓ Port 6688 is now free${NC}"
    else
        echo -e "\n${YELLOW}⚠ Port 6688 is still in use after 30 seconds${NC}"
        echo -e "${YELLOW}  There may be another process using this port${NC}"
        
        # Show what's using the port
        PROCESS_INFO=$(lsof -i:6688 2>/dev/null)
        if [ -n "$PROCESS_INFO" ]; then
            echo -e "${YELLOW}  Process information:${NC}"
            echo "$PROCESS_INFO" | sed 's/^/    /'
        fi
    fi
fi

# Verify container is stopped
echo -e "\n${BLUE}→ Verifying shutdown...${NC}"
if docker ps | grep -q "chainlink"; then
    echo -e "${YELLOW}⚠ Container is still running${NC}"
    docker ps --filter name=chainlink --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
else
    echo -e "${GREEN}✓ Container is stopped${NC}"
fi

# Show container status (even if stopped)
STOPPED_STATUS=$(docker ps -a --filter name=chainlink --format "{{.Status}}")
echo -e "Final status:   ${GREEN}$STOPPED_STATUS${NC}"

# Check if PostgreSQL should also be stopped (optional)
echo -e "\n${BLUE}PostgreSQL Status:${NC}"
if docker ps | grep -q "cl-postgres"; then
    echo -e "PostgreSQL:     ${GREEN}Still running${NC}"
    echo -e "${BLUE}Note: PostgreSQL left running (shared resource)${NC}"
    echo -e "${BLUE}      To stop PostgreSQL: docker stop cl-postgres${NC}"
else
    echo -e "PostgreSQL:     ${YELLOW}Not running${NC}"
fi

# Final status summary
echo -e "\n${BLUE}=== Shutdown Summary ===${NC}"
echo -e "Chainlink Node: ${GREEN}Stopped${NC}"
echo -e "Port 6688:      $(check_port 6688 && echo -e "${YELLOW}Still in use${NC}" || echo -e "${GREEN}Available${NC}")"
echo -e "Container:      ${GREEN}Stopped${NC}"

echo -e "\n${GREEN}✓ Chainlink Node shutdown completed!${NC}"
echo -e "\n${BLUE}Useful commands:${NC}"
echo -e "  Start node:     ${YELLOW}./start-chainlink.sh${NC}"
echo -e "  Check logs:     ${YELLOW}docker logs chainlink${NC}"
echo -e "  Check status:   ${YELLOW}./chainlink-status.sh${NC}"
echo -e "  Remove logs:    ${YELLOW}docker logs chainlink --since 0m > /dev/null 2>&1${NC}"