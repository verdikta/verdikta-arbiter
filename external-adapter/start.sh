#!/bin/bash
cd "$(dirname "$0")"

# Get the directory path and current timestamp for log file
LOG_DIR="$(pwd)/logs"
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
LOG_FILE="$LOG_DIR/adapter_${TIMESTAMP}.log"

echo "Starting External Adapter in persistent mode..."
echo "Logs will be available at: $LOG_FILE"

# Use nohup to keep the process running after terminal disconnects
nohup npm start > "$LOG_FILE" 2>&1 &

# Save PID for later management
echo $! > adapter.pid
echo "External Adapter started with PID $(cat adapter.pid)"
