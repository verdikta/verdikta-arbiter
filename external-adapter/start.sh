#!/bin/bash
cd "$(dirname "$0")"

# Load NVM so node/npm are available in non-interactive sessions
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"

# Select the Node.js version used during install if available
if command -v nvm >/dev/null 2>&1; then
  nvm use 20.18.1 >/dev/null 2>&1 || true
fi

# Get the directory path and current timestamp for log file
LOG_DIR="$(pwd)/logs"
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
LOG_FILE="$LOG_DIR/adapter_${TIMESTAMP}.log"

echo "Starting External Adapter in persistent mode..."
echo "Logs will be available at: $LOG_FILE"

# Check if npm is available
if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm not found. Ensure Node.js is installed and NVM is loaded." | tee -a "$LOG_FILE"
  exit 1
fi

# Check if already running via PID file
if [ -f adapter.pid ]; then
    pid=$(cat adapter.pid)
    if ps -p $pid > /dev/null 2>&1; then
        echo "External Adapter is already running with PID $pid"
        echo "Use ./stop.sh to stop it first, or check 'lsof -i:8080' for port conflicts"
        exit 1
    else
        echo "Stale PID file found, cleaning up..."
        rm -f adapter.pid
    fi
fi

# Check if port 8080 is already in use
if lsof -i:8080 > /dev/null 2>&1; then
    echo "Error: Port 8080 is already in use!"
    echo "Current process(es) using port 8080:"
    lsof -i:8080
    echo ""
    echo "Please stop the conflicting process or run './stop.sh' to clean up"
    exit 1
fi

# Verify required files exist
if [ ! -f "src/index.js" ]; then
    echo "Error: src/index.js not found. Are you in the correct directory?" | tee -a "$LOG_FILE"
    exit 1
fi

if [ ! -f "package.json" ]; then
    echo "Error: package.json not found. Are you in the correct directory?" | tee -a "$LOG_FILE"
    exit 1
fi

# Use nohup to keep the process running after terminal disconnects
nohup npm start > "$LOG_FILE" 2>&1 &

# Save PID for later management
NPM_PID=$!
echo $NPM_PID > adapter.pid

# Wait a moment and verify the process started
sleep 2

# Check if the process is still running
if ! ps -p $NPM_PID > /dev/null 2>&1; then
    echo "Error: External Adapter failed to start. Check logs at: $LOG_FILE"
    rm -f adapter.pid
    tail -20 "$LOG_FILE"
    exit 1
fi

# Check if port is now listening
if lsof -i:8080 > /dev/null 2>&1; then
    echo "External Adapter started successfully with PID $NPM_PID"
    echo "Service is listening on port 8080"
else
    echo "Warning: Process started but port 8080 is not yet listening"
    echo "Check logs at: $LOG_FILE"
fi
