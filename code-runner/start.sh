#!/bin/bash
# Start the code runner (node A8; design §9.1). start-arbiter.sh and the boot unit call this.
# It reads .env as data and starts the runner with that and nothing else: the runner holds no
# secrets, and refuses to start when its environment looks as if it does. It refuses any Docker
# endpoint but a runner's own socket: the arbiter's Docker holds cl-postgres and chainlink.
cd "$(dirname "$0")" || exit 1
HERE="$(pwd -P)"

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
done < <(cat .env; echo)

# What the runner will see: the last assignment, as env takes it.
word_value() { # word_value KEY DEFAULT
    local word value="$2"
    for word in "${ARGS[@]}"; do
        case "$word" in "$1"=*) value="${word#"$1"=}" ;; esac
    done
    echo "$value"
}
host_value="$(word_value DOCKER_HOST "")"
# This script is how an arbiter runs it, and an arbiter's runner holds itself to a conformance pass.
if [[ "$(word_value CODE_RUNNER_CONFORMANCE_FILE "")" =~ ^[[:space:]]*$ ]]; then
    echo "Error: $HERE/.env does not set CODE_RUNNER_CONFORMANCE_FILE, so this runner would admit claims with no pass. Run code-review-sandbox.sh enable" >&2
    exit 1
fi
case "$host_value" in
    unix:///var/run/docker.sock|unix:///run/docker.sock|'')
        echo "Error: DOCKER_HOST in $HERE/.env is [$host_value]: the runner never drives the arbiter's Docker. Run code-review-sandbox.sh enable" >&2
        exit 1 ;;
    unix://*) ;;
    *)
        echo "Error: DOCKER_HOST in $HERE/.env is [$host_value]: the runner's daemon is on its own Unix socket. Run code-review-sandbox.sh enable" >&2
        exit 1 ;;
esac

PORT="$(word_value CODE_RUNNER_PORT 8090)"
BIND="$(word_value CODE_RUNNER_HOST 127.0.0.1)"

TOKEN_FILE="$(word_value CODE_RUNNER_TOKEN_FILE "$HERE/../code-runner-state/token")"
# Anything on the port at all, whatever it is.
port_answers() {
    [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://$BIND:$PORT/health" 2>/dev/null)" != "000" ]
}
# This runner: it takes this token and names itself, 503 and all (the lock). The token goes on stdin, never argv.
runner_answers() {
    printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TOKEN_FILE" 2>/dev/null)" \
        | curl -s -m 2 -K - "http://$BIND:$PORT/health" 2>/dev/null | grep -q '"service":"verdikta-code-runner"'
}
# The adapter runs as `node src/index.js` too, so a stale pid file can name it: the working directory decides.
is_this_runner() {
    local cwd
    cwd=$(readlink "/proc/$1/cwd" 2>/dev/null) || cwd=$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    [ "$cwd" = "$HERE" ] && ps -p "$1" -o args= 2>/dev/null | grep -q 'src/index.js'
}

if [ -f runner.pid ]; then
    pid=$(cat runner.pid)
    if is_this_runner "$pid"; then
        echo "Code runner is already running with PID $pid"
        exit 0
    fi
    rm -f runner.pid
fi

# Something else on the port would answer for a runner that exits on EADDRINUSE.
if port_answers; then
    echo "Error: something already answers on $BIND:$PORT, and it is not this runner. Stop it, or change CODE_RUNNER_PORT." >&2
    exit 1
fi

if ! command -v node >/dev/null 2>&1; then
    echo "Error: node not found. Ensure Node.js is installed and NVM is loaded." >&2
    exit 1
fi

# At boot its daemon may still be starting. The runner starts anyway: /health says what is missing.
socket="${host_value#unix://}"
waited=0
until [ -e "$socket" ] || [ "$waited" -ge "${CODE_RUNNER_DAEMON_WAIT_SECS:-60}" ]; do
    sleep 2; waited=$((waited+2))
done
[ -e "$socket" ] || echo "Warning: the runner's Docker socket $socket is not there yet." >&2

mkdir -p logs
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
