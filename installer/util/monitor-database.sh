#!/bin/bash

# Verdikta Arbiter Database Performance Monitor
# Monitors PostgreSQL performance and identifies bottlenecks

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Verdikta Arbiter Database Performance Monitor${NC}\n"

# Function to execute PostgreSQL queries
run_pg_query() {
    local query="$1"
    docker exec cl-postgres psql -U postgres -c "$query" 2>/dev/null
}

# Function to execute PostgreSQL queries and return only data
run_pg_query_data() {
    local query="$1"
    docker exec cl-postgres psql -U postgres -t -c "$query" 2>/dev/null | sed 's/^[ \t]*//;s/[ \t]*$//'
}

# Check if PostgreSQL container is running
if ! docker ps | grep -q "cl-postgres"; then
    echo -e "${RED}Error: PostgreSQL container 'cl-postgres' is not running${NC}"
    exit 1
fi

echo -e "${GREEN}PostgreSQL container is running${NC}\n"

# 1. Connection Status
echo -e "${BLUE}1. Connection Status:${NC}"
CONN_QUERY="SELECT state, count(*) as connections FROM pg_stat_activity WHERE state IS NOT NULL GROUP BY state ORDER BY connections DESC;"
echo -e "Current connections by state:"
run_pg_query "$CONN_QUERY" | grep -v "count" | grep -v "\-\-" | while read line; do
    [ -n "$line" ] && echo "  $line"
done

TOTAL_CONN=$(run_pg_query_data "SELECT count(*) FROM pg_stat_activity;")
MAX_CONN=$(run_pg_query_data "SELECT setting FROM pg_settings WHERE name = 'max_connections';")
echo -e "  Total active connections: $TOTAL_CONN/$MAX_CONN"

# Check for connection leaks (idle in transaction)
IDLE_IN_TRANS=$(run_pg_query_data "SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction';")
if [ "$IDLE_IN_TRANS" -gt 0 ]; then
    echo -e "  ${YELLOW}Warning: $IDLE_IN_TRANS connections idle in transaction${NC}"
fi

echo ""

# 2. Long Running Queries
echo -e "${BLUE}2. Long Running Queries:${NC}"
LONG_QUERY="SELECT pid, now() - pg_stat_activity.query_start AS duration, state, left(query, 50) as query_snippet FROM pg_stat_activity WHERE (now() - pg_stat_activity.query_start) > interval '1 minute' AND state != 'idle' ORDER BY duration DESC;"

LONG_COUNT=$(run_pg_query_data "SELECT count(*) FROM pg_stat_activity WHERE (now() - pg_stat_activity.query_start) > interval '1 minute' AND state != 'idle';")

if [ "$LONG_COUNT" -gt 0 ]; then
    echo -e "Found $LONG_COUNT long-running queries (>1 minute):"
    run_pg_query "$LONG_QUERY"
else
    echo -e "${GREEN}No long-running queries detected${NC}"
fi

echo ""

# 3. Database Size and Growth
echo -e "${BLUE}3. Database Size:${NC}"
DB_SIZE=$(run_pg_query_data "SELECT pg_size_pretty(pg_database_size('postgres'));")
echo -e "Database size: $DB_SIZE"

# Table sizes
echo -e "Largest tables:"
TABLE_SIZE_QUERY="SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size FROM pg_tables WHERE schemaname NOT IN ('information_schema', 'pg_catalog') ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC LIMIT 10;"
run_pg_query "$TABLE_SIZE_QUERY" | head -12

echo ""

# 4. Performance Metrics
echo -e "${BLUE}4. Performance Metrics:${NC}"

# Cache hit ratio
CACHE_HIT=$(run_pg_query_data "SELECT round(100.0 * sum(blks_hit) / (sum(blks_hit) + sum(blks_read)), 2) as cache_hit_ratio FROM pg_stat_database WHERE datname = 'postgres';")
echo -e "Cache hit ratio: $CACHE_HIT%"

if [ -n "$CACHE_HIT" ] && [ "${CACHE_HIT%.*}" -lt 95 ]; then
    echo -e "  ${YELLOW}Warning: Cache hit ratio below 95% indicates insufficient memory${NC}"
fi

# Transaction stats
echo -e "Transaction statistics:"
TRANS_QUERY="SELECT datname, xact_commit, xact_rollback, round(100.0 * xact_rollback / (xact_commit + xact_rollback), 2) as rollback_ratio FROM pg_stat_database WHERE datname = 'postgres';"
run_pg_query "$TRANS_QUERY"

echo ""

# 5. Lock Information
echo -e "${BLUE}5. Lock Analysis:${NC}"
LOCK_COUNT=$(run_pg_query_data "SELECT count(*) FROM pg_locks WHERE NOT granted;")
if [ "$LOCK_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}Warning: $LOCK_COUNT ungranted locks detected${NC}"
    
    # Show blocked queries
    BLOCKED_QUERY="SELECT blocked_locks.pid AS blocked_pid, blocked_activity.usename AS blocked_user, blocking_locks.pid AS blocking_pid, blocking_activity.usename AS blocking_user, blocked_activity.query AS blocked_statement FROM pg_catalog.pg_locks blocked_locks JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid JOIN pg_catalog.pg_locks blocking_locks ON blocking_locks.locktype = blocked_locks.locktype AND blocking_locks.relation = blocked_locks.relation JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid WHERE NOT blocked_locks.granted;"
    
    echo -e "Blocked queries:"
    run_pg_query "$BLOCKED_QUERY"
else
    echo -e "${GREEN}No lock conflicts detected${NC}"
fi

echo ""

# 6. WAL and Checkpoint Information
echo -e "${BLUE}6. WAL and Checkpoint Status:${NC}"

# WAL file count
WAL_COUNT=$(run_pg_query_data "SELECT count(*) FROM pg_ls_waldir();")
echo -e "WAL files: $WAL_COUNT"

# Last checkpoint
CHECKPOINT_QUERY="SELECT pg_postmaster_start_time() as postmaster_start, stats_reset as stats_reset_time, checkpoints_timed, checkpoints_req, buffers_checkpoint, buffers_clean, buffers_backend FROM pg_stat_bgwriter;"
echo -e "Checkpoint statistics:"
run_pg_query "$CHECKPOINT_QUERY"

echo ""

# 7. Index Usage
echo -e "${BLUE}7. Index Usage:${NC}"
echo -e "Tables without primary keys or with unused indexes:"

# Unused indexes
UNUSED_IDX_QUERY="SELECT schemaname, tablename, indexname, idx_tup_read, idx_tup_fetch FROM pg_stat_user_indexes WHERE idx_tup_read = 0 AND idx_tup_fetch = 0;"
UNUSED_COUNT=$(run_pg_query_data "SELECT count(*) FROM pg_stat_user_indexes WHERE idx_tup_read = 0 AND idx_tup_fetch = 0;")

if [ "$UNUSED_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}Found $UNUSED_COUNT potentially unused indexes:${NC}"
    run_pg_query "$UNUSED_IDX_QUERY"
else
    echo -e "${GREEN}All indexes appear to be used${NC}"
fi

echo ""

# 8. Memory Usage
echo -e "${BLUE}8. Memory Configuration:${NC}"
MEMORY_QUERY="SELECT name, setting, unit FROM pg_settings WHERE name IN ('shared_buffers', 'effective_cache_size', 'work_mem', 'maintenance_work_mem') ORDER BY name;"
run_pg_query "$MEMORY_QUERY"

echo ""

# 9. Recommendations
echo -e "${BLUE}9. Performance Recommendations:${NC}"

# Analyze cache hit ratio
if [ -n "$CACHE_HIT" ]; then
    if [ "${CACHE_HIT%.*}" -lt 90 ]; then
        echo -e "• ${RED}Critical: Increase shared_buffers (current cache hit ratio: $CACHE_HIT%)${NC}"
    elif [ "${CACHE_HIT%.*}" -lt 95 ]; then
        echo -e "• ${YELLOW}Warning: Consider increasing shared_buffers (current cache hit ratio: $CACHE_HIT%)${NC}"
    else
        echo -e "• ${GREEN}Cache performance is good ($CACHE_HIT%)${NC}"
    fi
fi

# Check connection usage
if [ -n "$TOTAL_CONN" ] && [ -n "$MAX_CONN" ]; then
    CONN_USAGE=$((100 * TOTAL_CONN / MAX_CONN))
    if [ "$CONN_USAGE" -gt 80 ]; then
        echo -e "• ${YELLOW}High connection usage: $TOTAL_CONN/$MAX_CONN ($CONN_USAGE%)${NC}"
        echo -e "  Consider using connection pooling"
    fi
fi

# Check for idle in transaction connections
if [ "$IDLE_IN_TRANS" -gt 5 ]; then
    echo -e "• ${YELLOW}Many idle-in-transaction connections ($IDLE_IN_TRANS)${NC}"
    echo -e "  Check application connection handling"
fi

# Check WAL files
if [ -n "$WAL_COUNT" ] && [ "$WAL_COUNT" -gt 100 ]; then
    echo -e "• ${YELLOW}High WAL file count ($WAL_COUNT)${NC}"
    echo -e "  Consider adjusting checkpoint frequency"
fi

echo ""
echo -e "${BLUE}Monitoring Complete${NC}"
echo -e "\n${YELLOW}Useful Commands:${NC}"
echo -e "• Monitor live activity: docker exec cl-postgres psql -U postgres -c \"SELECT * FROM pg_stat_activity;\""
echo -e "• Check locks: docker exec cl-postgres psql -U postgres -c \"SELECT * FROM pg_locks WHERE NOT granted;\""
echo -e "• Reset statistics: docker exec cl-postgres psql -U postgres -c \"SELECT pg_stat_reset();\""
echo -e "• Analyze all tables: docker exec cl-postgres psql -U postgres -c \"ANALYZE;\""