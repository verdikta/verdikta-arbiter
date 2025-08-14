#!/bin/bash
cd "$(dirname "$0")"

kill_port_8080() {
  local pids
  pids=$(lsof -nP -i:8080 -sTCP:LISTEN -t 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "Port 8080 is in use by PID(s): $pids — sending SIGTERM..."
    echo "$pids" | xargs -r kill -TERM 2>/dev/null || true
    sleep 1
    # If still alive, force kill
    local still
    still=$(lsof -nP -i:8080 -sTCP:LISTEN -t 2>/dev/null)
    if [ -n "$still" ]; then
      echo "PID(s) still listening on 8080: $still — sending SIGKILL..."
      echo "$still" | xargs -r kill -KILL 2>/dev/null || true
    fi
  fi
}

# Check for PID file first (preferred)
if [ -f adapter.pid ]; then
  pid=$(cat adapter.pid)
  if [ -n "$pid" ]; then
    echo "Found PID file, attempting to stop process group for $pid..."
    # Try to terminate the entire process group and children gracefully
    kill -TERM -"$pid" 2>/dev/null || true
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    sleep 1

    # If still running, force kill
    if kill -0 "$pid" 2>/dev/null; then
      echo "Process $pid still running — forcing kill of group and children..."
      kill -KILL -"$pid" 2>/dev/null || true
      pkill -KILL -P "$pid" 2>/dev/null || true
      kill -KILL "$pid" 2>/dev/null || true
      sleep 1
    fi
  fi

  # Ensure port 8080 is freed
  kill_port_8080

  rm -f adapter.pid
  if lsof -nP -i:8080 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Warning: port 8080 is still in use by another process."
  else
    echo "External Adapter stopped."
  fi
  echo "All External Adapter processes should be stopped now."
  exit 0
fi

# Fallback to port-based stop when no PID file
PID=$(lsof -nP -i:8080 -sTCP:LISTEN -t 2>/dev/null)
if [ -n "$PID" ]; then
  echo "Stopping External Adapter listener(s) on port 8080 (PID: $PID)..."
  kill -TERM $PID 2>/dev/null || true
  sleep 1
  # Force if needed
  PID_STILL=$(lsof -nP -i:8080 -sTCP:LISTEN -t 2>/dev/null)
  if [ -n "$PID_STILL" ]; then
    echo "PID(s) still listening: $PID_STILL — sending SIGKILL..."
    kill -KILL $PID_STILL 2>/dev/null || true
  fi
  echo "External Adapter stopped."
else
  echo "External Adapter is not running."
fi

echo "All External Adapter processes should be stopped now."
