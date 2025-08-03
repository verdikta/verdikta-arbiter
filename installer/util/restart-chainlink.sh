#!/bin/bash

# Verdikta Arbiter - Chainlink Node Restart Script
# Cleanly restarts the Chainlink node with health monitoring

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Restarting Verdikta Chainlink Node...${NC}\n"

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

# Check if container exists
if ! docker ps -a | grep -q "chainlink"; then
    echo -e "${RED}✗ Chainlink container not found${NC}"
    echo -e "${RED}  Please run the installer setup-chainlink.sh first${NC}"
    exit 1
fi

# Get current status
WAS_RUNNING=false
if docker ps | grep -q "chainlink"; then
    WAS_RUNNING=true
    echo -e "${BLUE}→ Chainlink is currently running${NC}"
else
    echo -e "${BLUE}→ Chainlink is currently stopped${NC}"
fi

# Check PostgreSQL dependency
echo -e "${BLUE}→ Verifying PostgreSQL dependency...${NC}"
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
            echo -e "${RED}  Cannot restart Chainlink without database${NC}"
            exit 1
        fi
        sleep 2
    done
else
    echo -e "${GREEN}✓ PostgreSQL is running${NC}"
fi

# Perform the restart
echo -e "${BLUE}→ Restarting Chainlink container...${NC}"

if [ "$WAS_RUNNING" = true ]; then
    # Graceful restart for running container
    docker restart chainlink --time=30
else
    # Start if it was stopped
    docker start chainlink
fi

if [ $? -ne 0 ]; then
    echo -e "${RED}✗ Failed to restart Chainlink container${NC}"
    echo -e "${RED}  Check container logs: docker logs chainlink${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Chainlink container restarted${NC}"

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

# Show current status
echo -e "\n${BLUE}=== Post-Restart Status ===${NC}"

# Container status
CONTAINER_STATUS=$(docker ps --filter name=chainlink --format "{{.Status}}")
echo -e "Container:      ${GREEN}$CONTAINER_STATUS${NC}"

# Health status
CONTAINER_HEALTH=$(docker inspect --format='{{.State.Health.Status}}' chainlink 2>/dev/null)
if [ -n "$CONTAINER_HEALTH" ]; then
    if [ "$CONTAINER_HEALTH" = "healthy" ]; then
        echo -e "Health:         ${GREEN}$CONTAINER_HEALTH${NC}"
    else
        echo -e "Health:         ${YELLOW}$CONTAINER_HEALTH (may still be starting)${NC}"
    fi
fi

# API status
if check_port 6688; then
    echo -e "API (6688):     ${GREEN}Active${NC}"
    if check_chainlink_health 5; then
        echo -e "API Health:     ${GREEN}Responding${NC}"
        echo -e "Web UI:         ${GREEN}http://localhost:6688${NC}"
    else
        echo -e "API Health:     ${YELLOW}Starting up${NC}"
    fi
else
    echo -e "API (6688):     ${YELLOW}Not yet active${NC}"
fi

# Show recent restart logs
echo -e "\n${BLUE}Recent restart logs:${NC}"
docker logs --since 30s chainlink | tail -3 | sed 's/^/  /' | while read line; do
    if echo "$line" | grep -qi "error\|fail\|fatal"; then
        echo -e "${RED}$line${NC}"
    elif echo "$line" | grep -qi "warn"; then
        echo -e "${YELLOW}$line${NC}"
    else
        echo -e "${GREEN}$line${NC}"
    fi
done

echo -e "\n${GREEN}✓ Chainlink Node restart completed!${NC}"
echo -e "\n${BLUE}Next steps:${NC}"
echo -e "  Check status:   ${YELLOW}./chainlink-status.sh${NC}"
echo -e "  Monitor logs:   ${YELLOW}docker logs -f chainlink${NC}"
echo -e "  Check jobs:     ${YELLOW}./diagnose-jobs.sh${NC}"

if check_port 6688 && check_chainlink_health 5; then
    echo -e "  Access Web UI:  ${YELLOW}http://localhost:6688${NC}"
fi