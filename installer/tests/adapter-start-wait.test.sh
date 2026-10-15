#!/bin/bash
# start-arbiter.sh and external-adapter/start.sh used one port check after a
# fixed sleep (5 s / 2 s), so an adapter that took a moment longer to listen
# was reported as "Failed to start" though it came up fine (canary upgrade to
# d4ff0ec, 2026-10-15). Both now wait, bounded, for GET /version or :8080 and
# fail only on timeout or when the process exits.
# Runs the real scripts against a fake adapter (stub npm, curl, lsof, ss and
# docker on PATH) in a throwaway directory; no real port is bound.
# Run: bash installer/tests/adapter-start-wait.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()    { if echo "$2" | grep -q "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt()  { if echo "$2" | grep -q "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

T=$(mktemp -d)
# The fake adapter is nohup'd by start.sh; kill whatever is left.
cleanup() { pkill -f "$T/bin/npm" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
I="$T/install"; A="$I/external-adapter"; B="$T/bin"
mkdir -p "$A/src" "$B"
cp "$ROOT/installer/util/start-arbiter.sh" "$I/"
cp "$ROOT/external-adapter/start.sh" "$A/"
echo '{"name":"stub"}' > "$A/package.json"
echo '// stub' > "$A/src/index.js"
LISTEN="$T/listening"

# npm start: "listens" (creates $LISTEN) after FAKE_LISTEN_AFTER seconds, then
# runs on; FAKE_EXIT_AFTER=N exits 1 after N seconds without listening.
# One-second sleeps so that killing it leaves no long sleep behind.
cat > "$B/npm" <<EOF
#!/bin/bash
if [ -n "\${FAKE_EXIT_AFTER:-}" ]; then sleep "\$FAKE_EXIT_AFTER"; echo crashed; exit 1; fi
for ((i = 0; i < \${FAKE_LISTEN_AFTER:-0}; i++)); do sleep 1; done
echo "Server is running on port 8080"; touch "$LISTEN"
for ((i = 0; i < 120; i++)); do sleep 1; done
EOF
# curl answers /version once listening (FAKE_NO_VERSION=1: never answers).
cat > "$B/curl" <<EOF
#!/bin/bash
case "\$*" in *localhost:8080/version*)
  [ "\${FAKE_NO_VERSION:-0}" != 1 ] && [ -e "$LISTEN" ] && { echo '{"service":"verdikta-external-adapter"}'; exit 0; } ;;
esac
exit 7
EOF
# lsof/ss see :8080 once listening (FAKE_LSOF_BLIND=1: neither ever does,
# the namespace blindness start.sh guards against). Nothing else listens.
cat > "$B/lsof" <<EOF
#!/bin/bash
[ "\${FAKE_LSOF_BLIND:-0}" != 1 ] && [ -e "$LISTEN" ] && case "\$*" in *8080*) exit 0 ;; esac
exit 1
EOF
cat > "$B/ss" <<EOF
#!/bin/bash
echo "State Recv-Q Send-Q Local_Address:Port Peer_Address:Port"
[ "\${FAKE_LSOF_BLIND:-0}" != 1 ] && [ -e "$LISTEN" ] && echo "LISTEN 0 511 0.0.0.0:8080 0.0.0.0:*"
exit 0
EOF
printf '#!/bin/bash\nexit 0\n' > "$B/docker"
chmod +x "$B"/* "$I/start-arbiter.sh" "$A/start.sh"

reset() { pkill -f "$B/npm" 2>/dev/null; sleep 0.2; rm -f "$LISTEN" "$A/adapter.pid"; }
# HOME=$T keeps nvm out: `nvm use` would put the real npm ahead of the stub.
run() { env HOME="$T" PATH="$B:$PATH" "$@" 2>&1; }
now() { date +%s; }

# 1. start.sh: listens after 4 s, past the old fixed `sleep 2`.
reset; t0=$(now)
out=$(cd "$A" && FAKE_LISTEN_AFTER=4 run ./start.sh); rc=$?; dt=$(( $(now) - t0 ))
[ "$rc" = 0 ] && ok || bad "slow listen: start.sh exited $rc: $out"
has "slow listen" "$out" "started successfully with PID"
hasnt "slow listen" "$out" "not yet listening"
[ "$dt" -ge 4 ] && [ "$dt" -le 10 ] && ok || bad "slow listen: returned after ${dt}s, expected ~4s"
kill -0 "$(cat "$A/adapter.pid" 2>/dev/null)" 2>/dev/null && ok || bad "slow listen: adapter.pid is not the live adapter"

# 2. start-arbiter.sh: listens after 7 s, past the old fixed `sleep 5`.
reset; t0=$(now)
out=$(FAKE_LISTEN_AFTER=7 run bash "$I/start-arbiter.sh"); rc=$?; dt=$(( $(now) - t0 ))
[ "$rc" = 0 ] && ok || bad "start-arbiter slow listen: exited $rc"
has "start-arbiter slow listen" "$out" "External Adapter started successfully (answered on port 8080 after"
hasnt "start-arbiter slow listen" "$out" "Failed to start External Adapter"
echo "$out" | grep "External Adapter:" | grep -v "Not Running" | grep -q Running && ok || bad "start-arbiter slow listen: status line does not say Running"
[ "$dt" -ge 7 ] && [ "$dt" -le 15 ] && ok || bad "start-arbiter slow listen: took ${dt}s, expected ~7s"

# 3. Only GET /version answers (lsof and ss blind): still a success.
reset
out=$(cd "$A" && FAKE_LISTEN_AFTER=2 FAKE_LSOF_BLIND=1 run ./start.sh); rc=$?
[ "$rc" = 0 ] && ok || bad "/version only: start.sh exited $rc: $out"
has "/version only" "$out" "started successfully"

# 4. The process exits before it listens: failure right away, not at timeout.
reset; t0=$(now)
out=$(cd "$A" && FAKE_EXIT_AFTER=2 ADAPTER_START_TIMEOUT_SECS=30 run ./start.sh); rc=$?; dt=$(( $(now) - t0 ))
[ "$rc" = 1 ] && ok || bad "process exit: start.sh exited $rc, wanted 1"
has "process exit" "$out" "exited before it answered on port 8080"
has "process exit" "$out" "crashed"   # tail of the log
[ "$dt" -le 8 ] && ok || bad "process exit: took ${dt}s, should not wait for the timeout"
[ -e "$A/adapter.pid" ] && bad "process exit: adapter.pid left behind" || ok
reset; t0=$(now)
out=$(FAKE_EXIT_AFTER=2 ADAPTER_START_TIMEOUT_SECS=30 run bash "$I/start-arbiter.sh"); rc=$?; dt=$(( $(now) - t0 ))
[ "$rc" = 0 ] && ok || bad "start-arbiter process exit: exit status changed to $rc (callers run under set -e)"
has "start-arbiter process exit" "$out" "Failed to start External Adapter (start.sh exited with status 1"
[ "$dt" -le 8 ] && ok || bad "start-arbiter process exit: took ${dt}s, should not wait for the timeout"

# 5. Never answers: failure only once ADAPTER_START_TIMEOUT_SECS runs out.
reset; t0=$(now)
out=$(cd "$A" && FAKE_LISTEN_AFTER=100 ADAPTER_START_TIMEOUT_SECS=3 run ./start.sh); rc=$?; dt=$(( $(now) - t0 ))
[ "$rc" = 1 ] && ok || bad "timeout: start.sh exited $rc, wanted 1"
has "timeout" "$out" "has not answered on port 8080 after 3s"
[ "$dt" -ge 3 ] && [ "$dt" -le 8 ] && ok || bad "timeout: took ${dt}s, expected ~3s"
reset; t0=$(now)
out=$(FAKE_LISTEN_AFTER=100 ADAPTER_START_TIMEOUT_SECS=3 run bash "$I/start-arbiter.sh"); rc=$?; dt=$(( $(now) - t0 ))
[ "$rc" = 0 ] && ok || bad "start-arbiter timeout: exit status changed to $rc"
has "start-arbiter timeout" "$out" "Failed to start External Adapter"
[ "$dt" -ge 3 ] && [ "$dt" -le 10 ] && ok || bad "start-arbiter timeout: took ${dt}s, expected ~3s"

# 6. start.sh succeeded but the adapter died afterwards (start-arbiter's own
#    process check): simulated with a start.sh that only writes a dead pid.
reset
mv "$A/start.sh" "$A/start.sh.real"
printf '#!/bin/bash\necho 999999 > adapter.pid\nexit 0\n' > "$A/start.sh"; chmod +x "$A/start.sh"
out=$(ADAPTER_START_TIMEOUT_SECS=10 run bash "$I/start-arbiter.sh")
has "dead after start.sh" "$out" "Failed to start External Adapter: its process exited"
mv "$A/start.sh.real" "$A/start.sh"

reset
echo "adapter-start-wait: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
