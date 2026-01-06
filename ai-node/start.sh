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

# Build production bundle if .next directory doesn't exist or is older than package.json
if [ ! -d ".next" ] || [ "package.json" -nt ".next" ]; then
    echo "Building production bundle..."
    npm run build
    if [ $? -ne 0 ]; then
        echo "ERROR: Build failed! Please check for errors and try again."
        exit 1
    fi
    echo "Build completed successfully."
fi

# Start the server in persistent background mode (PRODUCTION MODE)
echo "Starting AI Node in production mode..."
echo "Logs will be available at: $LOG_FILE"

# Use nohup to keep the process running after terminal disconnects
export PORT=3000
export NODE_ENV=production

# Start with log filtering to remove noisy Next.js errors
# Filter out known harmless errors: Server Action "x", workers, digest
nohup bash -c "npm start 2>&1 | grep -v 'Failed to find Server Action \"x\"' | grep -v \"Cannot read properties of undefined (reading 'workers')\" | grep -v \"Cannot read properties of null (reading 'digest')\" > '$LOG_FILE'" &
echo $! > ai-node.pid

echo "AI Node started with PID $(cat ai-node.pid) in PRODUCTION mode"
echo "For better performance, production mode is now enabled."
echo "If you need development mode for debugging, use: npm run dev"
echo "Note: Harmless Next.js server action errors are filtered from logs for readability."
