#!/bin/bash
echo "Stopping AI Node..."
if [ -f ai-node.pid ]; then
    pid=$(cat ai-node.pid)
    echo "Found PID file, stopping process $pid..."
    kill -15 $pid 2>/dev/null || kill -9 $pid 2>/dev/null
    rm ai-node.pid
fi

# Cleanup any remaining processes
ps aux | grep -E "next dev|next-server" | grep -v grep | awk '{print $2}' | xargs -r kill -9
sleep 2
if ps aux | grep -E "next dev|next-server" | grep -v grep > /dev/null; then
    echo "Warning: Some processes are still running"
else
    echo "AI Node stopped successfully"
fi
