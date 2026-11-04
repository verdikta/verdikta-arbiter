#!/bin/bash
# Stop the code runner (node A8). SIGTERM: it admits no new run, cancels the ones in flight and
# waits until each has removed its sandboxes. Its own Docker daemon stays up, idle: the disk and
# the warm images are what the next start needs, and nothing of the arbiter's depends on it.
cd "$(dirname "$0")" || exit 1

[ -f runner.pid ] || { echo "Code runner is not running (no runner.pid)."; exit 0; }
pid=$(cat runner.pid)
# Only ever the runner: a stale pid file can name anything by now.
if ! ps -p "$pid" -o args= 2>/dev/null | grep -q 'src/index.js'; then
    echo "Code runner is not running (stale runner.pid)."
    rm -f runner.pid
    exit 0
fi
kill -TERM "$pid" 2>/dev/null
waited=0
while ps -p "$pid" >/dev/null 2>&1 && [ "$waited" -lt "${CODE_RUNNER_STOP_TIMEOUT_SECS:-30}" ]; do
    sleep 1; waited=$((waited+1))
done
if ps -p "$pid" >/dev/null 2>&1; then
    # Its next start removes what this one left: admission stays closed until the GC has.
    echo "Code runner did not stop after ${waited}s; killing PID $pid."
    kill -KILL "$pid" 2>/dev/null
fi
rm -f runner.pid
echo "Code runner stopped."
