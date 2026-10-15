#!/bin/bash
cd "$(dirname "$0")"
echo "Stopping AI Node..."

# A rebuild that start.sh is running would start the server when it ends:
# stop that start.sh, then build.sh and its next build.
bpid=$(cat .build-in-progress 2>/dev/null)
if [ -n "$bpid" ] && kill -0 "$bpid" 2>/dev/null; then
    echo "Stopping the AI Node build in progress (pid $bpid)..."
    spid=$(ps -o ppid= -p "$bpid" 2>/dev/null | tr -d ' ')
    if [ -n "$spid" ] && ps -o args= -p "$spid" 2>/dev/null | grep -q 'start\.sh'; then
        kill -15 "$spid" 2>/dev/null
    fi
    pkill -15 -P "$bpid" 2>/dev/null
    kill -15 "$bpid" 2>/dev/null
fi

if [ -f ai-node.pid ]; then
    pid=$(cat ai-node.pid)
    echo "Found PID file, stopping process $pid..."
    kill -15 $pid 2>/dev/null || kill -9 $pid 2>/dev/null
    rm ai-node.pid
fi

# Cleanup any remaining processes (next dev, or next start / next-server)
ps aux | grep -E "next dev|next start|next-server" | grep -v grep | awk '{print $2}' | xargs -r kill -9
sleep 2
if ps aux | grep -E "next dev|next start|next-server" | grep -v grep > /dev/null; then
    echo "Warning: Some processes are still running"
else
    echo "AI Node stopped successfully"
fi
