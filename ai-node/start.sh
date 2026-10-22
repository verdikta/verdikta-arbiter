#!/bin/bash
cd "$(dirname "$0")"

# Load NVM if available
if [ -d "$HOME/.nvm" ]; then
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    nvm use 20.18.1 2>/dev/null || true
fi

# Verify Node.js is available
if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: Node.js is not available. Please install Node.js v20.18.0+ first."
    exit 1
fi

node_version=$(node --version)
echo "Using Node.js version: $node_version"

# Serve the production build (`next start`) by default. AI_NODE_MODE=dev, or a
# file named .use-next-dev in this directory, runs `next dev` instead.
MODE="${AI_NODE_MODE:-}"
if [ -z "$MODE" ]; then
    if [ -f .use-next-dev ]; then MODE=dev; else MODE=production; fi
fi

# Cleanup any existing instances first (the pid file holds the npm parent,
# which the patterns below do not match; build.sh refuses while it lives)
echo "Checking for existing Next.js processes..."
if [ -f ai-node.pid ]; then
    kill -15 "$(cat ai-node.pid)" 2>/dev/null || true
    rm -f ai-node.pid
fi
existing_pids=$(ps aux | grep -E "next dev|next start|next-server" | grep -v grep | awk '{print $2}')
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

export PORT=3000
export NEXT_TELEMETRY_DISABLED=1

RUN_SCRIPT=dev
if [ "$MODE" = "dev" ]; then
    echo "AI_NODE_MODE=dev / .use-next-dev: starting with next dev."
    echo dev > .run-mode
    # next dev writes its own files into .next: the next production start
    # must rebuild rather than trust the stamp.
    rm -f .next/VERDIKTA_BUILD_FINGERPRINT
else
    # Install and upgrade build up front, so this is normally a no-op. It
    # rebuilds when the code or dependencies changed since (a ClassID or
    # @verdikta/common update, a hand edit). Its output goes to the log.
    echo "Checking the production build (rebuilds first if the code changed; that takes a few minutes)..."
    ./build.sh --if-needed >> "$LOG_FILE" 2>&1
    build_rc=$?
    if [ "$build_rc" -eq 0 ]; then
        RUN_SCRIPT=start
        echo production > .run-mode
    elif [ "$build_rc" -eq 3 ]; then
        echo "Another AI Node build is running; the start.sh that launched it will start the server."
        exit 1
    elif [ "$build_rc" -ge 128 ]; then
        echo "The AI Node build was interrupted (stop.sh?); not starting." | tee -a "$LOG_FILE"
        exit 1
    else
        # Keep the arbiter answering: next dev is what ran before production
        # builds. The doctor flags this mode until a build succeeds.
        echo "WARNING: production build failed (exit $build_rc, see $LOG_FILE); falling back to next dev." | tee -a "$LOG_FILE"
        echo dev-fallback > .run-mode
    fi
fi

# Which address to listen on. Only the External Adapter (http://127.0.0.1:3000)
# and the operator's own tools (curl localhost:3000) talk to the AI Node, and it
# sits in front of the operator's paid LLM keys with no authentication of its
# own, so installs hardened by arbiter-firewall.sh (and fresh installs) bind
# loopback only. Two switches, either is enough:
#   AI_NODE_HOST=<address>   in the environment of this script, or
#   <install-dir>/.ai-node-loopback   (a file; lives outside ai-node/ so an
#                            upgrade of the component never removes it)
# Neither set = Next.js's default (all interfaces), exactly as before.
BIND_ARGS=()
AI_HOST="${AI_NODE_HOST:-}"
if [ -z "$AI_HOST" ] && [ -f ../.ai-node-loopback ]; then
    AI_HOST=127.0.0.1
fi
case "$AI_HOST" in
    *[!0-9A-Za-z.:_-]*) echo "WARNING: ignoring AI_NODE_HOST='$AI_HOST' (not an address)"; AI_HOST="" ;;
esac
if [ -n "$AI_HOST" ]; then
    BIND_ARGS=(-- -H "$AI_HOST")
    echo "AI Node listens on $AI_HOST only."
fi

# Start the server in persistent background mode
echo "Starting AI Node in persistent mode (npm run $RUN_SCRIPT)..."
echo "Logs will be available at: $LOG_FILE"

# Use nohup to keep the process running after terminal disconnects.
# Append mode (>>) so rotate-logs.sh can safely copy-truncate a live log.
nohup npm run "$RUN_SCRIPT" "${BIND_ARGS[@]}" >> "$LOG_FILE" 2>&1 &
echo $! > ai-node.pid
echo "AI Node started with PID $(cat ai-node.pid)"
