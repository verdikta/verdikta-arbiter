#!/bin/bash

# Verdikta Arbiter System Resource Monitor
# Monitors system resources and container performance

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Verdikta Arbiter System Resource Monitor${NC}\n"

# Function to get container stats
get_container_stats() {
    local container_name="$1"
    if docker ps | grep -q "$container_name"; then
        docker stats --no-stream --format "table {{.MemUsage}}\t{{.CPUPerc}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}" "$container_name" 2>/dev/null
    else
        echo "Container not running"
    fi
}

# Function to convert memory to MB
mem_to_mb() {
    local mem="$1"
    echo "$mem" | sed 's/[^0-9.]//g'
}

# 1. Overall System Resources
echo -e "${BLUE}1. System Resource Overview:${NC}"

# CPU Information
CPU_CORES=$(nproc)
CPU_USAGE=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)
LOAD_AVG=$(uptime | awk -F'load average:' '{print $2}')

echo -e "CPU:"
echo -e "  Cores: $CPU_CORES"
echo -e "  Usage: $CPU_USAGE%"
echo -e "  Load Average:$LOAD_AVG"

# Memory Information
MEMORY_INFO=$(free -h)
TOTAL_MEM=$(echo "$MEMORY_INFO" | awk 'NR==2{print $2}')
USED_MEM=$(echo "$MEMORY_INFO" | awk 'NR==2{print $3}')
FREE_MEM=$(echo "$MEMORY_INFO" | awk 'NR==2{print $4}')
MEM_PERCENT=$(echo "$MEMORY_INFO" | awk 'NR==2{printf "%.1f", $3/$2 * 100}')

echo -e "Memory:"
echo -e "  Total: $TOTAL_MEM"
echo -e "  Used:  $USED_MEM ($MEM_PERCENT%)"
echo -e "  Free:  $FREE_MEM"

# Swap Information
SWAP_INFO=$(echo "$MEMORY_INFO" | awk 'NR==3{print $2, $3, $4}')
if [ "$SWAP_INFO" != "0B 0B 0B" ] && [ -n "$SWAP_INFO" ]; then
    SWAP_TOTAL=$(echo "$SWAP_INFO" | awk '{print $1}')
    SWAP_USED=$(echo "$SWAP_INFO" | awk '{print $2}')
    echo -e "Swap:"
    echo -e "  Total: $SWAP_TOTAL"
    echo -e "  Used:  $SWAP_USED"
fi

# Disk Information
echo -e "Disk Usage:"
df -h | grep -E "^/dev/" | while read line; do
    USAGE=$(echo "$line" | awk '{print $5}' | sed 's/%//')
    MOUNT=$(echo "$line" | awk '{print $6}')
    SIZE=$(echo "$line" | awk '{print $2}')
    USED=$(echo "$line" | awk '{print $3}')
    FREE=$(echo "$line" | awk '{print $4}')
    
    if [ "$USAGE" -gt 90 ]; then
        echo -e "  ${RED}$MOUNT: $USED/$SIZE ($USAGE%) - Critical${NC}"
    elif [ "$USAGE" -gt 80 ]; then
        echo -e "  ${YELLOW}$MOUNT: $USED/$SIZE ($USAGE%) - Warning${NC}"
    else
        echo -e "  ${GREEN}$MOUNT: $USED/$SIZE ($USAGE%)${NC}"
    fi
done

echo ""

# 2. Docker System Resources
echo -e "${BLUE}2. Docker System Resources:${NC}"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    # Docker system info
    DOCKER_VERSION=$(docker version --format '{{.Server.Version}}' 2>/dev/null)
    echo -e "Docker Version: $DOCKER_VERSION"
    
    # Docker system df
    echo -e "Docker Storage:"
    docker system df 2>/dev/null | tail -n +2 | while read line; do
        echo "  $line"
    done
    
    # Container resource usage
    echo -e "Container Resource Usage:"
    if docker ps --format "table {{.Names}}" | grep -q "chainlink\|cl-postgres\|external-adapter"; then
        docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}" 2>/dev/null | grep -E "NAME|chainlink|cl-postgres|external-adapter"
    else
        echo -e "  ${YELLOW}No Verdikta containers running${NC}"
    fi
else
    echo -e "${RED}Docker not available${NC}"
fi

echo ""

# 3. Detailed Container Analysis
echo -e "${BLUE}3. Container Resource Analysis:${NC}"

# Chainlink Container
echo -e "Chainlink Node:"
if docker ps | grep -q "chainlink"; then
    CHAINLINK_STATS=$(docker stats --no-stream --format "{{.MemUsage}}\t{{.CPUPerc}}\t{{.MemPerc}}" chainlink 2>/dev/null)
    if [ -n "$CHAINLINK_STATS" ]; then
        MEM_USAGE=$(echo "$CHAINLINK_STATS" | awk '{print $1}')
        CPU_PERC=$(echo "$CHAINLINK_STATS" | awk '{print $2}')
        MEM_PERC=$(echo "$CHAINLINK_STATS" | awk '{print $3}')
        
        echo -e "  Status: ${GREEN}Running${NC}"
        echo -e "  Memory: $MEM_USAGE ($MEM_PERC)"
        echo -e "  CPU: $CPU_PERC"
        
        # Check if memory usage is high
        MEM_NUM=$(echo "$MEM_PERC" | sed 's/%//')
        if [ -n "$MEM_NUM" ] && [ "${MEM_NUM%.*}" -gt 80 ]; then
            echo -e "  ${YELLOW}Warning: High memory usage${NC}"
        fi
    fi
    
    # Container uptime
    UPTIME=$(docker ps --format "{{.RunningFor}}" --filter name=chainlink)
    echo -e "  Uptime: $UPTIME"
    
    # Recent restarts
    RESTART_COUNT=$(docker inspect chainlink --format='{{.RestartCount}}' 2>/dev/null)
    echo -e "  Restart Count: $RESTART_COUNT"
else
    echo -e "  Status: ${RED}Not Running${NC}"
fi

echo ""

# PostgreSQL Container
echo -e "PostgreSQL:"
if docker ps | grep -q "cl-postgres"; then
    POSTGRES_STATS=$(docker stats --no-stream --format "{{.MemUsage}}\t{{.CPUPerc}}\t{{.MemPerc}}" cl-postgres 2>/dev/null)
    if [ -n "$POSTGRES_STATS" ]; then
        MEM_USAGE=$(echo "$POSTGRES_STATS" | awk '{print $1}')
        CPU_PERC=$(echo "$POSTGRES_STATS" | awk '{print $2}')
        MEM_PERC=$(echo "$POSTGRES_STATS" | awk '{print $3}')
        
        echo -e "  Status: ${GREEN}Running${NC}"
        echo -e "  Memory: $MEM_USAGE ($MEM_PERC)"
        echo -e "  CPU: $CPU_PERC"
    fi
    
    UPTIME=$(docker ps --format "{{.RunningFor}}" --filter name=cl-postgres)
    echo -e "  Uptime: $UPTIME"
    
    RESTART_COUNT=$(docker inspect cl-postgres --format='{{.RestartCount}}' 2>/dev/null)
    echo -e "  Restart Count: $RESTART_COUNT"
else
    echo -e "  Status: ${RED}Not Running${NC}"
fi

echo ""

# 4. Process Analysis
echo -e "${BLUE}4. Process Analysis:${NC}"

# Top CPU consuming processes
echo -e "Top CPU consumers:"
ps aux --sort=-%cpu | head -6 | tail -5 | while read line; do
    echo "  $line" | awk '{printf "  %-10s %5s%% %s\n", $1, $3, $11}'
done

echo ""

# Top Memory consuming processes  
echo -e "Top Memory consumers:"
ps aux --sort=-%mem | head -6 | tail -5 | while read line; do
    echo "  $line" | awk '{printf "  %-10s %5s%% %s\n", $1, $4, $11}'
done

echo ""

# 5. Network Analysis
echo -e "${BLUE}5. Network Analysis:${NC}"

# Network connections
ESTABLISHED=$(netstat -an 2>/dev/null | grep -c ESTABLISHED)
LISTEN=$(netstat -an 2>/dev/null | grep -c LISTEN)
TIME_WAIT=$(netstat -an 2>/dev/null | grep -c TIME_WAIT)

echo -e "Network Connections:"
echo -e "  Established: $ESTABLISHED"
echo -e "  Listening: $LISTEN"
echo -e "  Time Wait: $TIME_WAIT"

# Specific service ports
echo -e "Service Port Status:"
PORTS=("3000:AI Node" "6688:Chainlink" "8080:External Adapter" "5432:PostgreSQL")

for port_info in "${PORTS[@]}"; do
    PORT=$(echo "$port_info" | cut -d: -f1)
    SERVICE=$(echo "$port_info" | cut -d: -f2)
    
    if netstat -an 2>/dev/null | grep -q ":$PORT.*LISTEN"; then
        echo -e "  $SERVICE (port $PORT): ${GREEN}Active${NC}"
    else
        echo -e "  $SERVICE (port $PORT): ${RED}Not listening${NC}"
    fi
done

echo ""

# 6. Performance Recommendations
echo -e "${BLUE}6. Performance Recommendations:${NC}"

# Memory recommendations
MEM_USAGE_NUM=$(echo "$MEM_PERCENT" | cut -d. -f1)
if [ "$MEM_USAGE_NUM" -gt 90 ]; then
    echo -e "• ${RED}Critical: Memory usage is very high ($MEM_PERCENT%)${NC}"
    echo -e "  Consider adding more RAM or optimizing container memory limits"
elif [ "$MEM_USAGE_NUM" -gt 80 ]; then
    echo -e "• ${YELLOW}Warning: High memory usage ($MEM_PERCENT%)${NC}"
    echo -e "  Monitor memory usage and consider optimization"
else
    echo -e "• ${GREEN}Memory usage is acceptable ($MEM_PERCENT%)${NC}"
fi

# CPU recommendations
CPU_USAGE_NUM=$(echo "$CPU_USAGE" | cut -d. -f1)
if [ "$CPU_USAGE_NUM" -gt 80 ]; then
    echo -e "• ${YELLOW}High CPU usage ($CPU_USAGE%)${NC}"
    echo -e "  Monitor CPU-intensive processes"
fi

# Disk recommendations  
df -h | grep -E "^/dev/" | while read line; do
    USAGE=$(echo "$line" | awk '{print $5}' | sed 's/%//')
    MOUNT=$(echo "$line" | awk '{print $6}')
    
    if [ "$USAGE" -gt 90 ]; then
        echo -e "• ${RED}Critical: Disk space very low on $MOUNT ($USAGE%)${NC}"
        echo -e "  Clean up logs, temporary files, or add storage"
    elif [ "$USAGE" -gt 80 ]; then
        echo -e "• ${YELLOW}Warning: Disk space low on $MOUNT ($USAGE%)${NC}"
        echo -e "  Monitor disk usage and plan for cleanup"
    fi
done

# Docker recommendations
if docker system df 2>/dev/null | grep -q "RECLAIMABLE"; then
    RECLAIMABLE=$(docker system df 2>/dev/null | tail -1 | awk '{print $4}')
    if [ "$RECLAIMABLE" != "0B" ]; then
        echo -e "• ${YELLOW}Docker has reclaimable space: $RECLAIMABLE${NC}"
        echo -e "  Run 'docker system prune' to clean up"
    fi
fi

echo ""
echo -e "${BLUE}Resource Monitoring Complete${NC}"
echo -e "\n${YELLOW}Useful Commands:${NC}"
echo -e "• Live container stats: docker stats"
echo -e "• System monitoring: htop or top"
echo -e "• Docker cleanup: docker system prune"
echo -e "• Check logs size: du -sh /var/lib/docker/containers/*/*-json.log"