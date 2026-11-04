#!/bin/bash
# Start the code runner (node A8; design §9.1). start-arbiter.sh and the boot unit call this.
# It reads .env as data and starts the runner with that and nothing else: the runner holds no
# secrets, and refuses to start when its environment looks as if it does. It refuses any Docker
# endpoint but a runner's own socket: the arbiter's Docker holds cl-postgres and chainlink.
cd "$(dirname "$0")" || exit 1
HERE="$(pwd)"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
command -v nvm >/dev/null 2>&1 && nvm use 20.18.1 >/dev/null 2>&1

if [ ! -f .env ]; then
    echo "Error: $HERE/.env not found: the code-review sandbox is not installed here (code-review-sandbox.sh enable)" >&2
    exit 1
fi

# The lines the runner gets, as words: no shell reads a value.
ARGS=()
while IFS= read -r line; do
    case "$line" in
        ''|\#*) continue ;;
    esac
    if ! [[ "$line" =~ ^[A-Z_][A-Z0-9_]*= ]]; then
        echo "Error: $HERE/.env holds a line that is not KEY=value" >&2
        exit 1
    fi
    ARGS+=("$line")
done < .env

host_value=""
for word in "${ARGS[@]}"; do
    case "$word" in DOCKER_HOST=*) host_value="${word#DOCKER_HOST=}" ;; esac
done
case "$host_value" in
    unix:///var/run/docker.sock|unix:///run/docker.sock|'')
        echo "Error: DOCKER_HOST in $HERE/.env is [$host_value]: the runner never drives the arbiter's Docker. Run code-review-sandbox.sh enable" >&2
        exit 1 ;;
    unix://*) ;;
    *)
        echo "Error: DOCKER_HOST in $HERE/.env is [$host_value]: the runner's daemon is on its own Unix socket. Run code-review-sandbox.sh enable" >&2
        exit 1 ;;
esac

word_value() { # word_value KEY DEFAULT
    local word
    for word in "${ARGS[@]}"; do
        case "$word" in "$1"=*) echo "${word#"$1"=}"; return ;; esac
    done
    echo "$2"
}
PORT="$(word_value CODE_RUNNER_PORT 8090)"
BIND="$(word_value CODE_RUNNER_HOST 127.0.0.1)"

runner_answers() { # any HTTP status: without a token it is a 401, and that is an answer
    local code
    code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://$BIND:$PORT/health" 2>/dev/null) && [ "$code" != "000" ]
}

if [ -f runner.pid ]; then
    pid=$(cat runner.pid)
    if ps -p "$pid" -o args= 2>/dev/null | grep -q 'src/index.js'; then
        echo "Code runner is already running with PID $pid"
        exit 0
    fi
    rm -f runner.pid
fi

if ! command -v node >/dev/null 2>&1; then
    echo "Error: node not found. Ensure Node.js is installed and NVM is loaded." >&2
    exit 1
fi

# At boot its daemon may still be starting. The runner starts anyway: /health says what is missing.
socket="${host_value#unix://}"
waited=0
until [ -S "$socket" ] || [ -e "$socket" ] || [ "$waited" -ge "${CODE_RUNNER_DAEMON_WAIT_SECS:-60}" ]; do
    sleep 2; waited=$((waited+2))
done
[ -e "$socket" ] || echo "Warning: the runner's Docker socket $socket is not there yet." >&2

mkdir -p logs .state
LOG_FILE="$HERE/logs/runner_$(date +%Y%m%d_%H%M%S).log"
# Append mode (>>) so rotate-logs.sh can safely copy-truncate a live log.
nohup env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production "${ARGS[@]}" node src/index.js >> "$LOG_FILE" 2>&1 &
RUNNER_PID=$!
echo "$RUNNER_PID" > runner.pid

waited=0
until runner_answers; do
    if ! ps -p "$RUNNER_PID" >/dev/null 2>&1; then
        echo "Error: the code runner exited before it answered. Check $LOG_FILE" >&2
        rm -f runner.pid
        tail -20 "$LOG_FILE" >&2
        exit 1
    fi
    if [ "$waited" -ge "${CODE_RUNNER_START_TIMEOUT_SECS:-30}" ]; then
        echo "Error: the code runner (PID $RUNNER_PID) has not answered on $BIND:$PORT after ${waited}s. Check $LOG_FILE" >&2
        exit 1
    fi
    sleep 1; waited=$((waited+1))
done
echo "Code runner started with PID $RUNNER_PID (answered on $BIND:$PORT after ${waited}s); log: $LOG_FILE"
