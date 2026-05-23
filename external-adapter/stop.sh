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

# 2. Find and stop any process listening on port 8080.
#    Prefer lsof, but fall through to `ss` when lsof returns empty. `lsof -i`
#    is known to silently miss listening sockets on long-running processes in
#    some namespace/cgroup setups — leaving orphan listeners after a
#    "successful" stop. See: update-pinata-key.sh restart hardening.
PORT_PIDS=$(lsof -ti:8080 2>/dev/null)
if [ -z "$PORT_PIDS" ] && command -v ss >/dev/null 2>&1; then
    PORT_PIDS=$(ss -tlnp 2>/dev/null \
                | awk '/[:.]8080[[:space:]]/ {print $0}' \
                | grep -oE 'pid=[0-9]+' \
                | cut -d= -f2 \
                | sort -u)
fi
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

# Final verification — check via both lsof and ss; either positive means
# something is still bound. lsof-blindness affects detection on some hosts.
port_8080_still_held() {
    lsof -i:8080 >/dev/null 2>&1 && return 0
    if command -v ss >/dev/null 2>&1; then
        ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE '[:.]8080$' && return 0
    fi
    return 1
}
if port_8080_still_held; then
    echo "WARNING: Port 8080 is still in use after cleanup"
    (ss -tlnp 2>/dev/null | grep ':8080') || (lsof -i:8080 2>/dev/null)
else
    if [ $STOPPED -eq 1 ]; then
        echo "External Adapter stopped successfully."
    else
        echo "External Adapter was not running."
    fi
fi
