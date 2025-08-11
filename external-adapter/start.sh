#!/bin/bash
cd "$(dirname "$0")"

# Load NVM to ensure npm/node are available in non-interactive sessions
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"

# Optionally select the Node.js version used during install (fallback to system default)
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

# Use nohup to keep the process running after terminal disconnects
if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm not found. Ensure Node.js is installed and NVM is loaded." | tee -a "$LOG_FILE"
  exit 1
fi

nohup npm start > "$LOG_FILE" 2>&1 &

# Save PID for later management
echo $! > adapter.pid
echo "External Adapter started with PID $(cat adapter.pid)"
