#!/bin/bash

# Verdikta Arbiter - Chainlink Node Start Script
# Cleanly starts the Chainlink node with health monitoring

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Starting Verdikta Chainlink Node...${NC}\n"

# Function to check if a port is in use
check_port() {
    if lsof -i:$1 >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# Function to check Chainlink API health
check_chainlink_health() {
    local timeout=${1:-30}
    local count=0
    
    while [ $count -lt $timeout ]; do
        if curl -s -f http://localhost:6688/health >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
        count=$((count + 2))
    done
    return 1
}

# Check if Chainlink is already running
if check_port 6688; then
    echo -e "${YELLOW}⚠ Chainlink Node is already running on port 6688${NC}"
    
    # Check if it's healthy
    if check_chainlink_health 5; then
        echo -e "${GREEN}✓ Chainlink API is responding normally${NC}"
        echo -e "${GREEN}✓ Chainlink Node is already running and healthy${NC}"
        exit 0
    else
        echo -e "${YELLOW}⚠ Port 6688 is in use but Chainlink API is not responding${NC}"
        echo -e "${YELLOW}  This might be a stale process. Consider stopping first.${NC}"
        exit 1
    fi
fi

# Check if Chainlink container exists
if ! docker ps -a | grep -q "chainlink"; then
    echo -e "${RED}✗ Chainlink container not found${NC}"
    echo -e "${RED}  Please run the installer setup-chainlink.sh first${NC}"
    exit 1
fi

# Check if container is stopped
if docker ps | grep -q "chainlink"; then
    echo -e "${YELLOW}⚠ Chainlink container is running but port 6688 is not accessible${NC}"
    echo -e "${BLUE}  Checking container status...${NC}"
    docker ps --filter name=chainlink --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    exit 1
fi

# Check PostgreSQL dependency
echo -e "${BLUE}→ Checking PostgreSQL dependency...${NC}"
if ! docker ps | grep -q "cl-postgres"; then
    echo -e "${YELLOW}⚠ PostgreSQL container (cl-postgres) is not running${NC}"
    echo -e "${BLUE}  Starting PostgreSQL first...${NC}"
    docker start cl-postgres
    
    # Wait for PostgreSQL to be ready
    for i in {1..15}; do
        if docker exec cl-postgres pg_isready -q 2>/dev/null; then
            echo -e "${GREEN}✓ PostgreSQL is ready${NC}"
            break
        fi
        if [ $i -eq 15 ]; then
            echo -e "${RED}✗ PostgreSQL failed to start${NC}"
            echo -e "${RED}  Cannot start Chainlink without database${NC}"
            exit 1
        fi
        sleep 2
    done
else
    echo -e "${GREEN}✓ PostgreSQL is running${NC}"
fi

# Start Chainlink container
echo -e "${BLUE}→ Starting Chainlink container...${NC}"
docker start chainlink

if [ $? -ne 0 ]; then
    echo -e "${RED}✗ Failed to start Chainlink container${NC}"
    echo -e "${RED}  Check container logs: docker logs chainlink${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Chainlink container started${NC}"

# Wait for Chainlink to be fully ready
echo -e "${BLUE}→ Waiting for Chainlink API to become available...${NC}"
printf "   "

if check_chainlink_health 60; then
    echo -e "\n${GREEN}✓ Chainlink API is responding${NC}"
else
    echo -e "\n${YELLOW}⚠ Chainlink API not responding after 60 seconds${NC}"
    echo -e "${YELLOW}  The node may still be starting up. Check logs:${NC}"
    echo -e "${YELLOW}  docker logs -f chainlink${NC}"
fi

# Get container status
CONTAINER_STATUS=$(docker ps --filter name=chainlink --format "{{.Status}}")
CONTAINER_HEALTH=$(docker inspect --format='{{.State.Health.Status}}' chainlink 2>/dev/null)

# Display final status
echo -e "\n${BLUE}=== Chainlink Node Status ===${NC}"
echo -e "Container Status: ${GREEN}$CONTAINER_STATUS${NC}"

if [ -n "$CONTAINER_HEALTH" ]; then
    if [ "$CONTAINER_HEALTH" = "healthy" ]; then
        echo -e "Health Status:    ${GREEN}$CONTAINER_HEALTH${NC}"
    else
        echo -e "Health Status:    ${YELLOW}$CONTAINER_HEALTH${NC}"
    fi
fi

if check_port 6688; then
    echo -e "API Port (6688):  ${GREEN}Active${NC}"
    echo -e "Web UI:           ${GREEN}http://localhost:6688${NC}"
else
    echo -e "API Port (6688):  ${YELLOW}Not yet accessible${NC}"
fi

# Show recent logs
echo -e "\n${BLUE}Recent Chainlink logs:${NC}"
docker logs --tail 5 chainlink | sed 's/^/  /'

echo -e "\n${GREEN}✓ Chainlink Node startup completed!${NC}"
echo -e "\n${BLUE}Useful commands:${NC}"
echo -e "  Monitor logs:    ${YELLOW}docker logs -f chainlink${NC}"
echo -e "  Check status:    ${YELLOW}./chainlink-status.sh${NC}"
echo -e "  Stop node:       ${YELLOW}./stop-chainlink.sh${NC}"