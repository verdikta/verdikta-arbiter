#!/bin/bash
# start-arbiter.sh's closing "Verdikta Arbiter Status" block asked lsof whether
# :3000 was open and printed "AI Node: Not Running" seconds after the same run
# had logged "AI Node is healthy (answered /api/health after 6s)" — seen in
# journalctl -u verdikta-arbiter on the canary host and in its upgrade log
# (2026-10-19). lsof 4.93.2 on that host (Ubuntu 20.04) drops the next-server
# process altogether — its comm is Next.js's title cut to 15 chars,
# "next-server (v1", and the unbalanced "(" breaks lsof's /proc/<pid>/stat
# parsing (reproduced in an ubuntu:20.04 container) — while ss and /api/health
# see it. The status (and the
# "already running" check, which would otherwise restart a healthy node) must
# ask the service first, as the start-up wait does.
# Runs the real script against stub lsof / curl / docker and stub component
# start scripts on PATH in a throwaway directory; nothing real is started.
# Run: bash installer/tests/start-arbiter-status.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
I="$T/install"; B="$T/bin"
mkdir -p "$I/ai-node" "$I/external-adapter" "$B"
cp "$ROOT/installer/util/start-arbiter.sh" "$I/"
# Component start scripts only record that they were called.
printf '#!/bin/bash\ntouch "%s/ai-node-started"\nexit 0\n' "$T" > "$I/ai-node/start.sh"
printf '#!/bin/bash\ntouch "%s/adapter-started"\necho 999999 > adapter.pid\nexit 0\n' "$T" > "$I/external-adapter/start.sh"
# lsof: sees :6688 always, :3000 only with FAKE_LSOF_3000=1, :8080 only with
# FAKE_LSOF_8080=1 (the canary host: blind to the AI Node, sees the rest).
cat > "$B/lsof" <<'EOF'
#!/bin/bash
case "$*" in
  *3000*) [ "${FAKE_LSOF_3000:-0}" = 1 ] && exit 0 ;;
  *8080*) [ "${FAKE_LSOF_8080:-0}" = 1 ] && exit 0 ;;
  *6688*) exit 0 ;;
esac
exit 1
EOF
# curl: /api/health answers ok unless FAKE_HEALTH_OK=0; /version answers
# unless FAKE_VERSION_OK=0.
cat > "$B/curl" <<'EOF'
#!/bin/bash
case "$*" in
  *3000/api/health*) [ "${FAKE_HEALTH_OK:-1}" = 1 ] && { echo '{"status":"ok","service":"ai-evaluation-service"}'; exit 0; } ;;
  *8080/version*)    [ "${FAKE_VERSION_OK:-1}" = 1 ] && { echo '{"service":"verdikta-external-adapter"}'; exit 0; } ;;
esac
exit 7
EOF
# docker: both containers exist and run, postgres is ready.
cat > "$B/docker" <<'EOF'
#!/bin/bash
case "$*" in
  "inspect --format {{.State.Running}} "*) echo true ;;
  "exec cl-postgres pg_isready -q") exit 0 ;;
  *) : ;;
esac
exit 0
EOF
chmod +x "$B"/* "$I/start-arbiter.sh" "$I/ai-node/start.sh" "$I/external-adapter/start.sh"
reset() { rm -f "$T/ai-node-started" "$T/adapter-started" "$I/external-adapter/adapter.pid"; }
run()   { env HOME="$T" PATH="$B:$PATH" "$@" bash "$I/start-arbiter.sh" 2>&1; }
status_line() { echo "$1" | grep "^  $2"; }   # the status line, not the "  - AI Node: http://…" access line

# 1. The canary host: /api/health answers, lsof blind to :3000 (sees :8080).
#    The node is healthy and running — say so, and do not start it again.
reset
out=$(run FAKE_LSOF_8080=1)
has   "blind lsof: healthy"        "$out" "AI Node is healthy (answered /api/health after 0s)"
has   "blind lsof: status"         "$(status_line "$out" 'AI Node:')" "Running"
hasnt "blind lsof: status"         "$(status_line "$out" 'AI Node:')" "Not Running"
has   "blind lsof: already up"     "$out" "AI Node is already running"
[ -e "$T/ai-node-started" ] && bad "blind lsof: a healthy AI Node was started again" || ok
has   "blind lsof: adapter"        "$(status_line "$out" 'External Adapter:')" "Running"
has   "blind lsof: chainlink"      "$(status_line "$out" 'Chainlink Node:')" "Running"

# 2. Port open but /api/health not ok (mid warm-up, or wedged): not "Running",
#    not "Not Running" either — a listener that does not answer yet.
reset
out=$(run FAKE_LSOF_3000=1 FAKE_LSOF_8080=1 FAKE_HEALTH_OK=0 AI_NODE_START_TIMEOUT_SECS=3)
has   "listening only: waited"     "$out" "AI Node has not answered /api/health after 3s"
has   "listening only: status"     "$(status_line "$out" 'AI Node:')" "Starting (listening on :3000, /api/health not ok yet)"
hasnt "listening only: status"     "$(status_line "$out" 'AI Node:')" "Not Running"

# 3. Nothing on :3000 and no answer: started (stub), still not answering after
#    the timeout — "Not Running" is the truth here.
reset
out=$(run FAKE_LSOF_8080=1 FAKE_HEALTH_OK=0 AI_NODE_START_TIMEOUT_SECS=3)
[ -e "$T/ai-node-started" ] && ok || bad "down: ai-node/start.sh was not called"
has   "down: status"               "$(status_line "$out" 'AI Node:')" "Not Running"

# 4. The adapter: lsof blind to :8080 but GET /version answers — running, not
#    started again, reported Running.
reset
out=$(run)
has   "adapter blind lsof: up"     "$out" "External Adapter is already running"
[ -e "$T/adapter-started" ] && bad "adapter blind lsof: a running adapter was started again" || ok
has   "adapter blind lsof: status" "$(status_line "$out" 'External Adapter:')" "Running"
# ...and when nothing answers on :8080 at all, it is started and the status
# says Not Running (the stub start.sh writes a dead pid: "its process exited").
reset
out=$(run FAKE_VERSION_OK=0 ADAPTER_START_TIMEOUT_SECS=5)
[ -e "$T/adapter-started" ] && ok || bad "adapter down: start.sh was not called"
has   "adapter down: status"       "$(status_line "$out" 'External Adapter:')" "Not Running"

echo "start-arbiter-status: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
