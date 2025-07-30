#!/bin/bash
cd "$(dirname "$0")"

echo "Stopping External Adapter..."

# Method 1: Check for PID file first (our preferred method)
if [ -f adapter.pid ]; then
    pid=$(cat adapter.pid)
    if ps -p $pid > /dev/null 2>&1; then
        echo "Found PID file, stopping process $pid..."
        kill -15 $pid 2>/dev/null && sleep 2
        if ps -p $pid > /dev/null 2>&1; then
            echo "SIGTERM failed, using SIGKILL..."
            kill -9 $pid 2>/dev/null
        fi
        rm adapter.pid
        echo "External Adapter stopped (PID file method)."
    else
        echo "PID file exists but process $pid is not running. Cleaning up..."
        rm adapter.pid
    fi
fi

# Method 2: Check using netstat (same method as diagnostics script)
NETSTAT_PID=$(sudo netstat -tulpn | grep ":8080" | awk '{print $7}' | cut -d'/' -f1)
if [ -n "$NETSTAT_PID" ] && [ "$NETSTAT_PID" != "-" ]; then
    echo "Found process on port 8080 via netstat (PID: $NETSTAT_PID)..."
    kill -15 $NETSTAT_PID 2>/dev/null && sleep 2
    if ps -p $NETSTAT_PID > /dev/null 2>&1; then
        echo "SIGTERM failed, using SIGKILL..."
        kill -9 $NETSTAT_PID 2>/dev/null
    fi
    echo "External Adapter stopped (netstat method)."
fi

# Method 3: Fallback to lsof check
LSOF_PID=$(lsof -i:8080 -t 2>/dev/null)
if [ -n "$LSOF_PID" ]; then
    echo "Found process on port 8080 via lsof (PID: $LSOF_PID)..."
    kill -15 $LSOF_PID 2>/dev/null && sleep 2
    if ps -p $LSOF_PID > /dev/null 2>&1; then
        echo "SIGTERM failed, using SIGKILL..."
        kill -9 $LSOF_PID 2>/dev/null
    fi
    echo "External Adapter stopped (lsof method)."
fi

# Method 4: Final cleanup of any npm processes related to the adapter
npm_pids=$(ps aux | grep "node src/index.js" | grep -v grep | awk '{print $2}')
if [ -n "$npm_pids" ]; then
    echo "Found remaining node processes, cleaning up..."
    echo $npm_pids | xargs -r kill -9 2>/dev/null
fi

# Verify everything is stopped
FINAL_CHECK=$(sudo netstat -tulpn | grep ":8080")
if [ -z "$FINAL_CHECK" ]; then
    echo "✓ All External Adapter processes confirmed stopped."
else
    echo "⚠ Warning: Process may still be running:"
    echo "$FINAL_CHECK"
fi
