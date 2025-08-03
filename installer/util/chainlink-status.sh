#!/bin/bash

# Verdikta Arbiter - Chainlink Node Status Script
# Displays comprehensive status information for the Chainlink node

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Verdikta Chainlink Node Status${NC}\n"

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
    if curl -s -f http://localhost:6688/health >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# Function to format bytes to human readable
format_bytes() {
    local bytes=$1
    if [ $bytes -gt 1073741824 ]; then
        echo "$(echo "scale=1; $bytes/1073741824" | bc)GB"
    elif [ $bytes -gt 1048576 ]; then
        echo "$(echo "scale=1; $bytes/1048576" | bc)MB"
    elif [ $bytes -gt 1024 ]; then
        echo "$(echo "scale=1; $bytes/1024" | bc)KB"
    else
        echo "${bytes}B"
    fi
}

# 1. Container Status
echo -e "${BLUE}=== Container Status ===${NC}"

if docker ps -a | grep -q "chainlink"; then
    CONTAINER_EXISTS=true
    
    if docker ps | grep -q "chainlink"; then
        CONTAINER_RUNNING=true
        STATUS=$(docker ps --filter name=chainlink --format "{{.Status}}")
        echo -e "Container:      ${GREEN}Running${NC} ($STATUS)"
        
        # Get container health if available
        HEALTH=$(docker inspect --format='{{.State.Health.Status}}' chainlink 2>/dev/null)
        if [ -n "$HEALTH" ] && [ "$HEALTH" != "<no value>" ]; then
            if [ "$HEALTH" = "healthy" ]; then
                echo -e "Health:         ${GREEN}$HEALTH${NC}"
            else
                echo -e "Health:         ${YELLOW}$HEALTH${NC}"
            fi
        fi
        
        # Container uptime
        UPTIME=$(docker ps --format "{{.RunningFor}}" --filter name=chainlink)
        echo -e "Uptime:         ${GREEN}$UPTIME${NC}"
        
        # Restart count
        RESTART_COUNT=$(docker inspect chainlink --format='{{.RestartCount}}' 2>/dev/null)
        if [ -n "$RESTART_COUNT" ]; then
            if [ "$RESTART_COUNT" -eq 0 ]; then
                echo -e "Restart Count:  ${GREEN}$RESTART_COUNT${NC}"
            else
                echo -e "Restart Count:  ${YELLOW}$RESTART_COUNT${NC}"
            fi
        fi
    else
        CONTAINER_RUNNING=false
        STATUS=$(docker ps -a --filter name=chainlink --format "{{.Status}}")
        echo -e "Container:      ${RED}Stopped${NC} ($STATUS)"
    fi
else
    CONTAINER_EXISTS=false
    echo -e "Container:      ${RED}Not Found${NC}"
    echo -e "${RED}Run setup-chainlink.sh to create the container${NC}"
fi

echo ""

# 2. Network Status
echo -e "${BLUE}=== Network Status ===${NC}"

if check_port 6688; then
    echo -e "Port 6688:      ${GREEN}Active${NC}"
    
    if check_chainlink_health; then
        echo -e "API Health:     ${GREEN}Responding${NC}"
        echo -e "Web UI:         ${GREEN}http://localhost:6688${NC}"
    else
        echo -e "API Health:     ${YELLOW}Not Responding${NC}"
        echo -e "Web UI:         ${YELLOW}Not Accessible${NC}"
    fi
else
    echo -e "Port 6688:      ${RED}Not Active${NC}"
    echo -e "API Health:     ${RED}Not Available${NC}"
    echo -e "Web UI:         ${RED}Not Accessible${NC}"
fi

echo ""

# 3. Database Connection
echo -e "${BLUE}=== Database Connection ===${NC}"

if docker ps | grep -q "cl-postgres"; then
    echo -e "PostgreSQL:     ${GREEN}Running${NC}"
    
    # Test database connection if Chainlink is running
    if [ "$CONTAINER_RUNNING" = true ]; then
        # Check for database connection errors in recent logs
        DB_ERRORS=$(docker logs --tail 50 chainlink 2>&1 | grep -i "database\|postgres\|connection" | grep -i "error\|failed" | wc -l)
        if [ "$DB_ERRORS" -eq 0 ]; then
            echo -e "DB Connection:  ${GREEN}Healthy${NC}"
        else
            echo -e "DB Connection:  ${YELLOW}$DB_ERRORS recent error(s)${NC}"
        fi
    else
        echo -e "DB Connection:  ${YELLOW}Cannot test (Chainlink stopped)${NC}"
    fi
else
    echo -e "PostgreSQL:     ${RED}Not Running${NC}"
    echo -e "DB Connection:  ${RED}Database Unavailable${NC}"
fi

echo ""

# 4. Resource Usage
echo -e "${BLUE}=== Resource Usage ===${NC}"

if [ "$CONTAINER_RUNNING" = true ]; then
    # Get container stats
    STATS=$(docker stats --no-stream --format "{{.MemUsage}}\t{{.CPUPerc}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}" chainlink 2>/dev/null)
    
    if [ -n "$STATS" ]; then
        MEM_USAGE=$(echo "$STATS" | awk '{print $1}')
        CPU_PERC=$(echo "$STATS" | awk '{print $2}')
        MEM_PERC=$(echo "$STATS" | awk '{print $3}')
        NET_IO=$(echo "$STATS" | awk '{print $4}')
        BLOCK_IO=$(echo "$STATS" | awk '{print $5}')
        
        echo -e "Memory Usage:   ${GREEN}$MEM_USAGE ($MEM_PERC)${NC}"
        echo -e "CPU Usage:      ${GREEN}$CPU_PERC${NC}"
        echo -e "Network I/O:    ${GREEN}$NET_IO${NC}"
        echo -e "Disk I/O:       ${GREEN}$BLOCK_IO${NC}"
    else
        echo -e "Resource stats: ${YELLOW}Unable to retrieve${NC}"
    fi
    
    # Chainlink data directory size
    CHAINLINK_DIRS=("$HOME/.chainlink-testnet" "$HOME/.chainlink-mainnet" "$HOME/.chainlink-sepolia")
    for dir in "${CHAINLINK_DIRS[@]}"; do
        if [ -d "$dir" ]; then
            SIZE=$(du -sh "$dir" 2>/dev/null | cut -f1)
            NETWORK=$(basename "$dir" | sed 's/.chainlink-//')
            echo -e "Data Size ($NETWORK): ${GREEN}$SIZE${NC}"
            break
        fi
    done
else
    echo -e "Resource Usage: ${YELLOW}Container not running${NC}"
fi

echo ""

# 5. Recent Activity
echo -e "${BLUE}=== Recent Activity ===${NC}"

if [ "$CONTAINER_EXISTS" = true ]; then
    # Last container start time
    STARTED_AT=$(docker inspect chainlink --format='{{.State.StartedAt}}' 2>/dev/null | cut -d'T' -f1,2 | cut -d'.' -f1)
    if [ -n "$STARTED_AT" ]; then
        echo -e "Last Started:   ${GREEN}$STARTED_AT${NC}"
    fi
    
    # Recent log entries
    echo -e "Recent Logs:"
    docker logs --tail 3 chainlink 2>&1 | sed 's/^/  /' | while read line; do
        if echo "$line" | grep -qi "error\|fail\|fatal"; then
            echo -e "${RED}$line${NC}"
        elif echo "$line" | grep -qi "warn"; then
            echo -e "${YELLOW}$line${NC}"
        else
            echo -e "${GREEN}$line${NC}"
        fi
    done
    
    # Error count in recent logs
    ERROR_COUNT=$(docker logs --tail 20 chainlink 2>&1 | grep -i "error\|fatal" | wc -l)
    if [ "$ERROR_COUNT" -eq 0 ]; then
        echo -e "Recent Errors:  ${GREEN}None${NC}"
    else
        echo -e "Recent Errors:  ${YELLOW}$ERROR_COUNT in last 20 log entries${NC}"
    fi
else
    echo -e "Recent Activity: ${RED}Container does not exist${NC}"
fi

echo ""

# 6. Quick Actions
echo -e "${BLUE}=== Quick Actions ===${NC}"
echo -e "Start Chainlink:   ${YELLOW}./start-chainlink.sh${NC}"
echo -e "Stop Chainlink:    ${YELLOW}./stop-chainlink.sh${NC}"
echo -e "View Live Logs:    ${YELLOW}docker logs -f chainlink${NC}"
echo -e "View Recent Logs:  ${YELLOW}docker logs --tail 20 chainlink${NC}"

if [ "$CONTAINER_RUNNING" = true ] && check_chainlink_health; then
    echo -e "Access Web UI:     ${YELLOW}http://localhost:6688${NC}"
    echo -e "Check Jobs:        ${YELLOW}./diagnose-jobs.sh${NC}"
fi

# 7. Overall Status Summary
echo -e "\n${BLUE}=== Overall Status ===${NC}"

if [ "$CONTAINER_EXISTS" = false ]; then
    echo -e "${RED}❌ Chainlink not installed${NC}"
elif [ "$CONTAINER_RUNNING" = false ]; then
    echo -e "${YELLOW}⏸ Chainlink stopped${NC}"
elif ! check_port 6688; then
    echo -e "${YELLOW}⚠ Chainlink starting up${NC}"
elif ! check_chainlink_health; then
    echo -e "${YELLOW}⚠ Chainlink running but API not healthy${NC}"
else
    echo -e "${GREEN}✅ Chainlink running and healthy${NC}"
fi