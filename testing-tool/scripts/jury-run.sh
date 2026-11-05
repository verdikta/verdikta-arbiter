#!/usr/bin/env bash
# The paid half of a real-jury measurement (node A7d; README "A paid run"). Meant to run detached, so that nothing here
# needs the session that started it:
#
#   setsid nohup jury-run.sh <work dir> <key file> [test command options...] > <work dir>/run/driver.log 2>&1 < /dev/null &
#
# It starts the meter (no key), then the AI Node (the only process that gets the keys, and only the panel's), then the
# testing tool's batch (no key), and stops what it started, by PID. <work dir>/run/done appears when it ends, however it
# ends, holding the exit code; summary.json says why. Run it again to resume: the ledger and the results carry over.
set -uo pipefail
set +x

WORK=$(cd "$1" && pwd)
KEY_FILE=$2
shift 2
REPO="$WORK/repo"
RUN="$WORK/run"
NODE_BIN="$WORK/node/bin"
STOP_USD=${STOP_USD:-90}
METER_PORT=${METER_PORT:-53871}
AI_PORT=${AI_PORT:-53872}
JUSTIFIER_MODEL_NAME=${JUSTIFIER_MODEL_NAME:-anthropic:claude-haiku-5-5}

mkdir -p "$RUN"
chmod 700 "$RUN"
rm -f "$RUN/done"
METER_PID=""
AI_PID=""

stop_pid() {
  [ -n "$1" ] || return 0
  kill "$1" 2>/dev/null || return 0
  for _ in $(seq 1 50); do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.2
  done
  kill -9 "$1" 2>/dev/null || true
}

finish() {
  code=$?
  stop_pid "$AI_PID"
  stop_pid "$METER_PID"
  printf '{"exit":%d,"at":"%s"}\n' "$code" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RUN/done.partial"
  mv "$RUN/done.partial" "$RUN/done"
}
trap finish EXIT
trap 'exit 143' TERM INT HUP

wait_for() {
  for _ in $(seq 1 "$2"); do
    curl -fsS --max-time 5 "$1" > /dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

for port in "$METER_PORT" "$AI_PORT"; do
  if curl -s --max-time 2 -o /dev/null "http://127.0.0.1:$port/"; then
    echo "jury-run: port $port is taken"
    exit 8
  fi
done

env -i PATH="$NODE_BIN:/usr/bin:/bin" HOME="$WORK" "$NODE_BIN/node" "$REPO/testing-tool/src/meter.js" \
  --ledger "$RUN/ledger.jsonl" --calls "$RUN/calls" --port "$METER_PORT" --stop-usd "$STOP_USD" \
  ${METER_ARGS:-} >> "$RUN/meter.log" 2>&1 < /dev/null &
METER_PID=$!
wait_for "http://127.0.0.1:$METER_PORT/health" 20 || { echo "jury-run: the meter did not start"; exit 9; }

(
  # Only this subshell ever holds the keys, and it becomes the AI Node. The panel's providers only; never `set -x`, `env`.
  set +x
  cd "$REPO/ai-node" || exit 1
  clean_path="$NODE_BIN:/usr/bin:/bin"
  set -a
  # shellcheck disable=SC1090
  . "$KEY_FILE"
  set +a
  unset OPENAI_API_KEY XAI_API_KEY GROK_API_KEY HYPERBOLIC_API_KEY
  export PATH="$clean_path" HOME="$WORK" NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
  export JUSTIFIER_MODEL="$JUSTIFIER_MODEL_NAME"
  export ANTHROPIC_BASE_URL="http://127.0.0.1:$METER_PORT/anthropic"
  export OPENROUTER_BASE_URL="http://127.0.0.1:$METER_PORT/openrouter/api/v1"
  exec "$NODE_BIN/node" node_modules/next/dist/bin/next start -H 127.0.0.1 -p "$AI_PORT"
) >> "$RUN/ai-node.log" 2>&1 < /dev/null &
AI_PID=$!
wait_for "http://127.0.0.1:$AI_PORT/api/health" 120 || { echo "jury-run: the AI Node did not start"; exit 9; }

cd "$REPO/testing-tool" || exit 1
env -i PATH="$NODE_BIN:/usr/bin:/bin" HOME="$WORK" "$NODE_BIN/node" src/index.js test --type claim --jury real \
  --claims-dir "${CLAIMS_DIR:-$WORK/claims}" --batch-dir "$RUN" --meter-url "http://127.0.0.1:$METER_PORT" --stop-usd "$STOP_USD" \
  --ai-node-url "http://127.0.0.1:$AI_PORT" "$@"
