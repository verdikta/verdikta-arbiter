#!/bin/bash

# Verdikta Arbiter Job Diagnostic Script
# Diagnoses job completion issues and performance bottlenecks

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Verdikta Arbiter Job Diagnostics${NC}\n"

# Function to check if chainlink API is accessible
check_chainlink_api() {
    if curl -s -f http://localhost:6688/health >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# 1. Check Chainlink Node Status
echo -e "${BLUE}1. Chainlink Node Status:${NC}"
if docker ps | grep -q "chainlink"; then
    echo -e "  Container: ${GREEN}Running${NC}"
    
    if check_chainlink_api; then
        echo -e "  API: ${GREEN}Accessible${NC}"
    else
        echo -e "  API: ${RED}Not accessible${NC}"
        echo -e "  ${YELLOW}Check if node is still starting up${NC}"
    fi
    
    # Check recent logs for errors
    echo -e "\n  Recent errors in logs:"
    docker logs --tail 20 chainlink 2>&1 | grep -i "error\|fatal\|panic" | tail -5 || echo "    No recent errors found"
    
else
    echo -e "  Container: ${RED}Not Running${NC}"
    exit 1
fi

# 2. Check Job Status
echo -e "\n${BLUE}2. Job Status Check:${NC}"
if check_chainlink_api; then
    # Get Chainlink credentials
    CHAINLINK_DIR=""
    for dir in "$HOME/.chainlink-testnet" "$HOME/.chainlink-mainnet" "$HOME/.chainlink-sepolia"; do
        if [ -d "$dir" ] && [ -f "$dir/.api" ]; then
            CHAINLINK_DIR="$dir"
            break
        fi
    done
    
    if [ -n "$CHAINLINK_DIR" ] && [ -f "$CHAINLINK_DIR/.api" ]; then
        EMAIL=$(head -n1 "$CHAINLINK_DIR/.api")
        PASSWORD=$(tail -n1 "$CHAINLINK_DIR/.api")
        
        echo -e "  Attempting to retrieve job information..."
        
        # Login and get session cookie
        COOKIE_JAR=$(mktemp)
        LOGIN_RESPONSE=$(curl -s -c "$COOKIE_JAR" -X POST \
            -H "Content-Type: application/json" \
            -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
            http://localhost:6688/sessions)
        
        if echo "$LOGIN_RESPONSE" | grep -q "authenticated"; then
            echo -e "  ${GREEN}Successfully authenticated${NC}"
            
            # Get jobs
            JOBS_RESPONSE=$(curl -s -b "$COOKIE_JAR" http://localhost:6688/v2/jobs)
            
            if [ $? -eq 0 ]; then
                echo -e "  Jobs count: $(echo "$JOBS_RESPONSE" | jq -r '.data | length' 2>/dev/null || echo "Unable to parse")"
                
                # Get job runs
                RUNS_RESPONSE=$(curl -s -b "$COOKIE_JAR" http://localhost:6688/v2/pipeline/runs)
                
                if [ $? -eq 0 ]; then
                    echo -e "  Recent runs:"
                    echo "$RUNS_RESPONSE" | jq -r '.data[0:10][] | "    ID: \(.id) | Status: \(if .attributes.finishedAt then "completed" else "running" end) | Created: \(.attributes.createdAt[0:19])"' 2>/dev/null || echo "    Unable to parse runs data"
                    
                    # Count by status  
                    echo -e "  Run status summary:"
                    echo "$RUNS_RESPONSE" | jq -r '.data[] | 
                        if .attributes.finishedAt then
                            if (.attributes.fatalErrors and (.attributes.fatalErrors | map(select(. != null)) | length) > 0) or (.attributes.allErrors and .attributes.allErrors != null) then "errored" else "completed" end
                        else "running" end' 2>/dev/null | sort | uniq -c | awk '{print "    " $2 ": " $1}' || echo "    Unable to parse status summary"
                fi
            fi
        else
            echo -e "  ${RED}Authentication failed${NC}"
            echo -e "  ${YELLOW}Check credentials in $CHAINLINK_DIR/.api${NC}"
        fi
        
        # Cleanup
        rm -f "$COOKIE_JAR"
    else
        echo -e "  ${YELLOW}No API credentials found${NC}"
        echo -e "  ${YELLOW}Manual check required via UI at http://localhost:6688${NC}"
    fi
else
    echo -e "  ${RED}Cannot check jobs - API not accessible${NC}"
fi

# 3. Database Connection Check
echo -e "\n${BLUE}3. Database Status:${NC}"
if docker ps | grep -q "cl-postgres"; then
    echo -e "  Container: ${GREEN}Running${NC}"
    
    # Check database connections
    DB_STATS=$(docker exec cl-postgres psql -U postgres -c "SELECT state, count(*) FROM pg_stat_activity GROUP BY state;" 2>/dev/null)
    if [ $? -eq 0 ]; then
        echo -e "  Connection states:"
        echo "$DB_STATS" | grep -v "count" | grep -v "\-\-" | while read line; do
            [ -n "$line" ] && echo "    $line"
        done
    fi
    
    # Check for long-running queries
    LONG_QUERIES=$(docker exec cl-postgres psql -U postgres -c "SELECT pid, now() - pg_stat_activity.query_start AS duration, query FROM pg_stat_activity WHERE (now() - pg_stat_activity.query_start) > interval '5 minutes';" 2>/dev/null)
    if [ $? -eq 0 ]; then
        QUERY_COUNT=$(echo "$LONG_QUERIES" | grep -c "SELECT\|INSERT\|UPDATE\|DELETE")
        if [ "$QUERY_COUNT" -gt 0 ]; then
            echo -e "  ${YELLOW}Found $QUERY_COUNT long-running queries (>5min)${NC}"
        else
            echo -e "  ${GREEN}No long-running queries detected${NC}"
        fi
    fi
    
    # Check database size
    DB_SIZE=$(docker exec cl-postgres psql -U postgres -c "SELECT pg_size_pretty(pg_database_size('postgres'));" -t 2>/dev/null | tr -d ' ')
    if [ -n "$DB_SIZE" ]; then
        echo -e "  Database size: $DB_SIZE"
    fi
    
else
    echo -e "  Container: ${RED}Not Running${NC}"
fi

# 4. Resource Usage
echo -e "\n${BLUE}4. Resource Usage:${NC}"

# Memory usage
MEMORY_USAGE=$(free | awk 'NR==2{printf "%.1f%%", $3*100/$2}')
echo -e "  System Memory: $MEMORY_USAGE used"

# Docker container memory
if command -v docker >/dev/null 2>&1; then
    echo -e "  Container memory usage:"
    docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}" | grep -E "chainlink|cl-postgres" | while read line; do
        echo "    $line"
    done
fi

# Disk usage for chainlink data
CHAINLINK_DIR=""
for dir in "$HOME/.chainlink-testnet" "$HOME/.chainlink-mainnet" "$HOME/.chainlink-sepolia"; do
    if [ -d "$dir" ]; then
        CHAINLINK_DIR="$dir"
        break
    fi
done

if [ -n "$CHAINLINK_DIR" ]; then
    DISK_USAGE=$(du -sh "$CHAINLINK_DIR" 2>/dev/null | cut -f1)
    echo -e "  Chainlink data size: $DISK_USAGE"
fi

# 5. Network Connectivity
echo -e "\n${BLUE}5. Network Connectivity:${NC}"

# Load environment to get network info
INSTALLER_DIR="$(dirname "$(dirname "$(readlink -f "$0")")")"
if [ -f "$INSTALLER_DIR/.env" ]; then
    source "$INSTALLER_DIR/.env"
    
    if [ "$DEPLOYMENT_NETWORK" = "base_mainnet" ]; then
        RPC_URL="https://base-mainnet.infura.io/v3/"
    else
        RPC_URL="https://base-sepolia.infura.io/v3/"
    fi
    
    # Test RPC connectivity (without API key to avoid exposing it)
    if curl -s -m 5 "https://base-sepolia.infura.io" >/dev/null 2>&1; then
        echo -e "  Base network: ${GREEN}Reachable${NC}"
    else
        echo -e "  Base network: ${YELLOW}Connection issue${NC}"
    fi
else
    echo -e "  ${YELLOW}Cannot check network - environment file not found${NC}"
fi

echo -e "\n${BLUE}Diagnostic Complete${NC}"
echo -e "\n${YELLOW}Recommended Actions:${NC}"
echo -e "1. Check Chainlink UI at http://localhost:6688 for detailed job status"
echo -e "2. Review container logs: docker logs -f chainlink"
echo -e "3. Monitor database performance: docker exec cl-postgres psql -U postgres -c \"SELECT * FROM pg_stat_activity;\""
echo -e "4. If jobs are stuck, consider restarting Chainlink: docker restart chainlink"
echo -e "5. For persistent issues, check network connectivity and RPC endpoint health"