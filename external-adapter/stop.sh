#!/bin/bash
cd "$(dirname "$0")"

STOPPED=0

# Function to kill a process and its children
kill_process_tree() {
    local pid=$1
    local children=$(pgrep -P $pid 2>/dev/null)
    
    # Kill children first
    for child in $children; do
        kill_process_tree $child
    done
    
    # Then kill the parent
    if ps -p $pid > /dev/null 2>&1; then
        kill -15 $pid 2>/dev/null
        sleep 1
        # Force kill if still running
        if ps -p $pid > /dev/null 2>&1; then
            kill -9 $pid 2>/dev/null
        fi
    fi
}

# 1. Check for PID file first (our preferred method)
if [ -f adapter.pid ]; then
    pid=$(cat adapter.pid)
    if ps -p $pid > /dev/null 2>&1; then
        echo "Found PID file, stopping process tree for $pid..."
        kill_process_tree $pid
        STOPPED=1
    else
        echo "PID file exists but process $pid is not running, cleaning up..."
    fi
    rm -f adapter.pid
fi

# 2. Find and stop any process listening on port 8080
PORT_PIDS=$(lsof -ti:8080 2>/dev/null)
if [ -n "$PORT_PIDS" ]; then
    echo "Found process(es) on port 8080: $PORT_PIDS"
    for pid in $PORT_PIDS; do
        echo "Stopping process $pid on port 8080..."
        kill_process_tree $pid
        STOPPED=1
    done
fi

# 3. Find and stop any npm/node processes running this adapter
ADAPTER_DIR=$(pwd)
ADAPTER_PIDS=$(ps aux | grep "node.*src/index.js" | grep -v grep | awk '{print $2}')
if [ -n "$ADAPTER_PIDS" ]; then
    echo "Found adapter node process(es): $ADAPTER_PIDS"
    for pid in $ADAPTER_PIDS; do
        # Check if this process is running from our directory
        PROC_CWD=$(readlink -f /proc/$pid/cwd 2>/dev/null || echo "")
        if [ "$PROC_CWD" = "$ADAPTER_DIR" ] || [ -z "$PROC_CWD" ]; then
            echo "Stopping adapter process $pid..."
            kill_process_tree $pid
            STOPPED=1
        fi
    done
fi

# 4. Cleanup any remaining npm start processes for this adapter
NPM_PIDS=$(ps aux | grep "npm.*start" | grep -v grep | awk '{print $2}')
for pid in $NPM_PIDS; do
    PROC_CWD=$(readlink -f /proc/$pid/cwd 2>/dev/null || echo "")
    if [ "$PROC_CWD" = "$ADAPTER_DIR" ]; then
        echo "Stopping npm process $pid..."
        kill_process_tree $pid
        STOPPED=1
    fi
done

# Wait a moment for processes to fully terminate
sleep 2

# Final verification
if lsof -i:8080 > /dev/null 2>&1; then
    echo "WARNING: Port 8080 is still in use after cleanup"
    lsof -i:8080
else
    if [ $STOPPED -eq 1 ]; then
        echo "External Adapter stopped successfully."
    else
        echo "External Adapter was not running."
    fi
fi
