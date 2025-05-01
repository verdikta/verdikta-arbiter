#!/bin/bash
cd "$(dirname "$0")"

# Check for PID file first (our preferred method)
if [ -f adapter.pid ]; then
    pid=$(cat adapter.pid)
    echo "Found PID file, stopping process $pid..."
    kill -15 $pid 2>/dev/null || kill -9 $pid 2>/dev/null
    rm adapter.pid
    echo "External Adapter stopped."
    exit 0
fi

# Fallback to port check if PID file doesn't exist or is invalid
PID=$(lsof -i:8080 -t)
if [ -n "$PID" ]; then
  echo "Stopping External Adapter (PID: $PID)..."
  kill -15 $PID 2>/dev/null || kill -9 $PID 2>/dev/null
  echo "External Adapter stopped."
else
  echo "External Adapter is not running."
fi

# Final cleanup of any npm processes related to the adapter
ps aux | grep "npm start" | grep -v grep | awk '{print $2}' | xargs -r kill -9 2>/dev/null

echo "All External Adapter processes should be stopped now."
