#!/bin/bash
cd "$(dirname "$0")"

# Load NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# Use the correct Node.js version
nvm use 20.18.1 || nvm install 20.18.1

# Verify Node.js version
node_version=$(node --version)
echo "Using Node.js version: $node_version"

# Cleanup any existing instances first
echo "Checking for existing Next.js processes..."
existing_pids=$(ps aux | grep -E "next dev|next-server" | grep -v grep | awk '{print $2}')
if [ -n "$existing_pids" ]; then
    echo "Found existing processes. Terminating..."
    for pid in $existing_pids; do
        echo "Killing process $pid..."
        kill -9 $pid 2>/dev/null || true
    done
    sleep 2
fi

# Get the directory path and current timestamp for log file
LOG_DIR="$(pwd)/logs"
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
LOG_FILE="$LOG_DIR/ai-node_${TIMESTAMP}.log"

# Start the server in persistent background mode
echo "Starting AI Node in persistent mode..."
echo "Logs will be available at: $LOG_FILE"

# Use nohup to keep the process running after terminal disconnects
export PORT=3000
nohup npm run dev > "$LOG_FILE" 2>&1 &
echo $! > ai-node.pid
echo "AI Node started with PID $(cat ai-node.pid)"
