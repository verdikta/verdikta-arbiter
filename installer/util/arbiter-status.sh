#!/bin/bash

# Verdikta Arbiter Status Script
# Reports the status and health of all arbiter components

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

# Auto-detect chainlink directory
CHAINLINK_DIR=""
for dir in "$HOME/.chainlink-testnet" "$HOME/.chainlink-mainnet" "$HOME/.chainlink-sepolia"; do
    if [ -d "$dir" ]; then
        CHAINLINK_DIR="$dir"
        break
    fi
done

if [ -z "$CHAINLINK_DIR" ]; then
    CHAINLINK_DIR="$HOME/.chainlink-testnet" # Default fallback
fi

echo -e "${BLUE}Checking Verdikta Arbiter Status (Installation: $INSTALL_DIR)...${NC}\n"

# Function to check if a process is running on a port
check_port() {
    if lsof -i:$1 >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# Function to check if a Next.js process is running
check_nextjs() {
    if ps aux | grep -E "next dev|next-server" | grep -v grep >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# Function to check HTTP endpoint health
check_health() {
    local url=$1
    local endpoint=$2
    local timeout=5
    if curl -s -m $timeout "$url$endpoint" >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# Check AI Node
echo -e "${BLUE}AI Node Status:${NC}"
AI_NODE_RUNNING=false
AI_NODE_PID=""

# Check PID file first
if [ -f "$AI_NODE_DIR/ai-node.pid" ]; then
    AI_NODE_PID=$(cat "$AI_NODE_DIR/ai-node.pid")
    if ps -p "$AI_NODE_PID" >/dev/null 2>&1; then
        AI_NODE_RUNNING=true
    fi
fi

# If PID file check failed, look for Next.js process
if [ "$AI_NODE_RUNNING" = false ] && check_nextjs; then
    AI_NODE_RUNNING=true
    AI_NODE_PID=$(ps aux | grep -E "next dev|next-server" | grep -v grep | awk '{print $2}' | head -n1)
fi

if [ "$AI_NODE_RUNNING" = true ]; then
    # Get process uptime
    if [ -n "$AI_NODE_PID" ]; then
        PROC_START=$(ps -p "$AI_NODE_PID" -o lstart=)
        UPTIME=$(ps -p "$AI_NODE_PID" -o etime=)
    fi

    if check_health "http://localhost:3000" "/api/health"; then
        echo -e "  Status: ${GREEN}Running${NC}"
        echo -e "  Health: ${GREEN}Healthy${NC}"
        echo -e "  Port:   3000"
        echo -e "  PID:    $AI_NODE_PID"
        [ -n "$UPTIME" ] && echo -e "  Uptime: $UPTIME"
        
        # Check log file
        LATEST_LOG=$(ls -t "$AI_NODE_DIR/logs/"*.log 2>/dev/null | head -n1)
        if [ -n "$LATEST_LOG" ]; then
            echo -e "  Log:    $LATEST_LOG"
        fi
    else
        echo -e "  Status: ${YELLOW}Running but not responding${NC}"
        echo -e "  Health: ${RED}Unhealthy${NC}"
        echo -e "  Port:   3000"
        echo -e "  PID:    $AI_NODE_PID"
        [ -n "$UPTIME" ] && echo -e "  Uptime: $UPTIME"
        
        # Check for recent errors in log
        LATEST_LOG=$(ls -t "$AI_NODE_DIR/logs/"*.log 2>/dev/null | head -n1)
        if [ -n "$LATEST_LOG" ]; then
            echo -e "  Log:    $LATEST_LOG"
            echo -e "  Recent Errors:"
            tail -n 10 "$LATEST_LOG" | grep -i "error" | sed 's/^/    /'
        fi
    fi
else
    echo -e "  Status: ${RED}Not Running${NC}"
    # Check if port is taken
    if check_port 3000; then
        echo -e "  Warning: ${YELLOW}Port 3000 is in use by another process${NC}"
    fi
    # Check for crash logs
    LATEST_LOG=$(ls -t "$AI_NODE_DIR/logs/"*.log 2>/dev/null | head -n1)
    if [ -n "$LATEST_LOG" ]; then
        echo -e "  Last Log: $LATEST_LOG"
        echo -e "  Last Error:"
        tail -n 5 "$LATEST_LOG" | grep -i "error" | sed 's/^/    /'
    fi
fi
echo ""

# Check External Adapter
echo -e "${BLUE}External Adapter Status:${NC}"
ADAPTER_RUNNING=false
ADAPTER_PID=""

# Prefer PID file to identify adapter we manage from this install dir
if [ -f "$ADAPTER_DIR/adapter.pid" ]; then
    ADAPTER_PID=$(cat "$ADAPTER_DIR/adapter.pid")
    if ps -p "$ADAPTER_PID" >/dev/null 2>&1; then
        ADAPTER_RUNNING=true
    fi
fi

if [ "$ADAPTER_RUNNING" = true ]; then
    # Health + details
    if check_health "http://localhost:8080" "/health"; then
        echo -e "  Status: ${GREEN}Running${NC}"
        echo -e "  Health: ${GREEN}Healthy${NC}"
    else
        echo -e "  Status: ${YELLOW}Running but not responding${NC}"
        echo -e "  Health: ${RED}Unhealthy${NC}"
    fi
    echo -e "  Port:   8080"
    echo -e "  PID:    $ADAPTER_PID"

    # Check log file
    LATEST_LOG=$(ls -t "$ADAPTER_DIR/logs/"*.log 2>/dev/null | head -n1)
    if [ -n "$LATEST_LOG" ]; then
        echo -e "  Log:    $LATEST_LOG"
    fi
else
    echo -e "  Status: ${RED}Not Running${NC}"
    # If port is taken, warn that something else is listening on 8080
    if check_port 8080; then
        echo -e "  Warning: ${YELLOW}Port 8080 is in use by another process${NC}"
        # Show who owns the port (best-effort)
        LSOF_OUT=$(lsof -nP -i:8080 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print "    PID: "$2", Command: "$1", Name: "$9}')
        if [ -n "$LSOF_OUT" ]; then
            echo -e "  Listener(s):\n$LSOF_OUT"
        fi
    fi

    # Check for crash logs
    LATEST_LOG=$(ls -t "$ADAPTER_DIR/logs/"*.log 2>/dev/null | head -n1)
    if [ -n "$LATEST_LOG" ]; then
        echo -e "  Last Log: $LATEST_LOG"
        echo -e "  Last Error:"
        tail -n 5 "$LATEST_LOG" | grep -i "error" | sed 's/^/    /'
    fi
fi
echo ""

# Check Chainlink Node
echo -e "${BLUE}Chainlink Node Status:${NC}"
if check_port 6688; then
    # Check if container is running
    if docker ps | grep -q "chainlink"; then
        echo -e "  Status: ${GREEN}Running${NC}"
        echo -e "  Container: ${GREEN}Active${NC}"
        echo -e "  Port:   6688"
        
        # Get container health
        HEALTH=$(docker inspect --format='{{.State.Health.Status}}' chainlink 2>/dev/null)
        if [ ! -z "$HEALTH" ]; then
            # Capitalize first letter of health status
            HEALTH_CAP=$(echo "$HEALTH" | sed 's/^./\U&/')
            if [ "$HEALTH" = "healthy" ]; then
                echo -e "  Health: ${GREEN}$HEALTH_CAP${NC}"
            else
                echo -e "  Health: ${YELLOW}$HEALTH_CAP${NC}"
            fi
        fi
        
        # Get container uptime
        UPTIME=$(docker ps --format "{{.RunningFor}}" --filter name=chainlink)
        if [ ! -z "$UPTIME" ]; then
            echo -e "  Uptime: $UPTIME"
        fi
        
        # Show docker log commands since chainlink runs in container
        echo -e "  Logs:   Use 'docker logs -f chainlink' to view live logs"
        echo -e "          Use 'docker logs --tail 20 chainlink' to view recent logs"
    else
        echo -e "  Status: ${YELLOW}Port active but container not found${NC}"
    fi
else
    echo -e "  Status: ${RED}Not Running${NC}"
fi
echo ""

# Check PostgreSQL
echo -e "${BLUE}PostgreSQL Status:${NC}"
if docker ps | grep -q "cl-postgres"; then
    echo -e "  Status: ${GREEN}Running${NC}"
    echo -e "  Container: ${GREEN}Active${NC}"
    
    # Get container health
    HEALTH=$(docker inspect --format='{{.State.Health.Status}}' cl-postgres 2>/dev/null)
    if [ ! -z "$HEALTH" ]; then
        # Capitalize first letter of health status
        HEALTH_CAP=$(echo "$HEALTH" | sed 's/^./\U&/')
        if [ "$HEALTH" = "healthy" ]; then
            echo -e "  Health: ${GREEN}$HEALTH_CAP${NC}"
        else
            echo -e "  Health: ${YELLOW}$HEALTH_CAP${NC}"
        fi
    fi
    
    # Get container uptime
    UPTIME=$(docker ps --format "{{.RunningFor}}" --filter name=cl-postgres)
    if [ ! -z "$UPTIME" ]; then
        echo -e "  Uptime: $UPTIME"
    fi

    # Get PostgreSQL port
    PORT=$(docker port cl-postgres 5432/tcp | cut -d: -f2)
    if [ ! -z "$PORT" ]; then
        echo -e "  Port:   $PORT"
    fi
else
    echo -e "  Status: ${RED}Not Running${NC}"
fi
echo ""

# Overall Status Summary
echo -e "${BLUE}Overall System Status:${NC}"
TOTAL=4
RUNNING=0

# AI Node check
if [ "$AI_NODE_RUNNING" = true ]; then
    ((RUNNING++))
fi

# External Adapter check (only count if our managed PID is running)
if [ "$ADAPTER_RUNNING" = true ]; then
    ((RUNNING++))
fi

# Chainlink Node check
if docker ps | grep -q "chainlink"; then
    ((RUNNING++))
fi

# PostgreSQL check
if docker ps | grep -q "cl-postgres"; then
    ((RUNNING++))
fi

if [ $RUNNING -eq $TOTAL ]; then
    echo -e "  ${GREEN}All systems operational${NC} ($RUNNING/$TOTAL components running)"
elif [ $RUNNING -eq 0 ]; then
    echo -e "  ${RED}System is down${NC} ($RUNNING/$TOTAL components running)"
else
    echo -e "  ${YELLOW}Partially operational${NC} ($RUNNING/$TOTAL components running)"
fi

# Resource Usage
echo -e "\n${BLUE}Resource Usage:${NC}"
echo -e "  CPU Usage:"
top -b -n 1 | grep -E "ai-node|external-adapter|chainlink" | awk '{print "    " $12 ": " $9 "%"}'
echo -e "  Memory Usage:"
free -h | awk 'NR==2{printf "    Total: %s, Used: %s, Free: %s\n", $2, $3, $4}'
echo -e "  Disk Usage:"
df -h / | awk 'NR==2{printf "    Total: %s, Used: %s, Free: %s\n", $2, $3, $4}' 