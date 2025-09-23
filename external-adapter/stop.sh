#!/bin/bash
cd "$(dirname "$0")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if a process is running
is_process_running() {
    local pid=$1
    if [ -z "$pid" ]; then
        return 1
    fi
    if ps -p "$pid" >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# Function to wait for process to die
wait_for_process_death() {
    local pid=$1
    local timeout=${2:-10}
    local count=0
    
    while [ $count -lt $timeout ]; do
        if ! is_process_running "$pid"; then
            return 0
        fi
        sleep 1
        ((count++))
    done
    return 1
}

# Function to kill process gracefully then forcefully
kill_process_graceful() {
    local pid=$1
    local name=${2:-"process"}
    
    if ! is_process_running "$pid"; then
        echo -e "${YELLOW}Process $pid ($name) is not running${NC}"
        return 0
    fi
    
    echo "Sending SIGTERM to $name (PID: $pid)..."
    kill -15 "$pid" 2>/dev/null
    
    if wait_for_process_death "$pid" 5; then
        echo -e "${GREEN}Process $pid ($name) terminated gracefully${NC}"
        return 0
    fi
    
    echo -e "${YELLOW}Process $pid ($name) did not respond to SIGTERM, sending SIGKILL...${NC}"
    kill -9 "$pid" 2>/dev/null
    
    if wait_for_process_death "$pid" 3; then
        echo -e "${GREEN}Process $pid ($name) killed forcefully${NC}"
        return 0
    else
        echo -e "${RED}Failed to kill process $pid ($name)${NC}"
        return 1
    fi
}

PROCESSES_KILLED=0

# Step 1: Check PID file and validate it
if [ -f adapter.pid ]; then
    pid=$(cat adapter.pid)
    echo "Found PID file with process $pid..."
    
    if is_process_running "$pid"; then
        # Verify this is actually our adapter process by checking if it's listening on port 8080
        if lsof -p "$pid" -i:8080 >/dev/null 2>&1; then
            echo "Confirmed PID $pid is the external adapter process"
            if kill_process_graceful "$pid" "External Adapter"; then
                ((PROCESSES_KILLED++))
            fi
        else
            echo -e "${YELLOW}PID $pid exists but is not listening on port 8080, cleaning up stale PID file${NC}"
        fi
    else
        echo -e "${YELLOW}PID file contains stale process ID $pid, cleaning up${NC}"
    fi
    rm -f adapter.pid
fi

# Step 2: Find any processes listening on port 8080 (our adapter port)
echo "Checking for processes on port 8080..."
PORT_PIDS=$(lsof -i:8080 -t 2>/dev/null)

if [ -n "$PORT_PIDS" ]; then
    for pid in $PORT_PIDS; do
        # Get process command to identify it
        PROC_CMD=$(ps -p "$pid" -o comm= 2>/dev/null)
        echo "Found process on port 8080: PID $pid ($PROC_CMD)"
        
        if kill_process_graceful "$pid" "Port 8080 listener ($PROC_CMD)"; then
            ((PROCESSES_KILLED++))
        fi
    done
else
    echo "No processes found listening on port 8080"
fi

# Step 3: Find any npm processes that might be running our adapter
echo "Checking for npm processes related to external-adapter..."
NPM_PIDS=$(ps aux | grep -E "npm.*start|node.*src/index.js" | grep -v grep | awk '{print $2}')

if [ -n "$NPM_PIDS" ]; then
    for pid in $NPM_PIDS; do
        # Check if this npm process is in our directory or related to adapter
        PROC_CMD=$(ps -p "$pid" -o args= 2>/dev/null)
        if echo "$PROC_CMD" | grep -q -E "external-adapter|adapter.*start"; then
            echo "Found related npm/node process: PID $pid"
            if kill_process_graceful "$pid" "NPM/Node process"; then
                ((PROCESSES_KILLED++))
            fi
        fi
    done
fi

# Step 4: Final verification
echo "Performing final verification..."
REMAINING_PIDS=$(lsof -i:8080 -t 2>/dev/null)

if [ -n "$REMAINING_PIDS" ]; then
    echo -e "${RED}Warning: The following processes are still listening on port 8080:${NC}"
    for pid in $REMAINING_PIDS; do
        PROC_INFO=$(ps -p "$pid" -o pid,comm,args 2>/dev/null)
        echo "  $PROC_INFO"
    done
    echo -e "${RED}You may need to manually kill these processes${NC}"
    exit 1
else
    if [ $PROCESSES_KILLED -gt 0 ]; then
        echo -e "${GREEN}Successfully stopped $PROCESSES_KILLED External Adapter process(es)${NC}"
    else
        echo -e "${GREEN}External Adapter was not running${NC}"
    fi
    echo -e "${GREEN}Port 8080 is now free${NC}"
    exit 0
fi
