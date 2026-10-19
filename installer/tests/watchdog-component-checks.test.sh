#!/bin/bash
# chainlink-health-watchdog.sh after the 2026-10-18 reboot wave. The alert must
# say "NOT RUNNING" when a component is down (and after a reboot say so) and
# keep "CANNOT BROADCAST" for a running container with a dead RPC pool;
# --self-heal must bring the node up through start-arbiter.sh, never during an
# operator stop (.arbiter-stopped), never right after a boot, and only once
# per cooldown; a dead RPC pool still restarts the container.
# Runs the real script against stub docker/curl/ss/lsof/logger on PATH.
# Run: bash installer/tests/watchdog-component-checks.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

T=$(cd "$(mktemp -d)" && pwd -P)   # resolved: readlink -f in the scripts yields the real path
trap 'rm -rf "$T"' EXIT
I="$T/install"; B="$T/bin"
mkdir -p "$I/installer" "$I/ai-node" "$B"
cp "$ROOT/installer/util/chainlink-health-watchdog.sh" "$I/"
chmod +x "$I/chainlink-health-watchdog.sh"
# The watchdog finds its install dir by walking up to installer/.env (HOME=$T
# keeps the real ~/verdikta-arbiter-node out of the picture). The alert text
# is piped into WATCHDOG_ALERT_COMMAND; webhook stays off.
echo "WATCHDOG_ALERT_COMMAND=\"cat >> $T/alerts\"" > "$I/installer/.env"
# Stub start-arbiter.sh for the self-heal: records every run.
printf '#!/bin/bash\necho run >> %s/starts\n' "$T" > "$I/start-arbiter.sh"; chmod +x "$I/start-arbiter.sh"

# docker: container state from FAKE_UP_<name> (1 = running), restarts recorded.
cat > "$B/docker" <<EOF
#!/bin/bash
name="\${@: -1}"
case "\$*" in
  "inspect --format {{.State.Running}} chainlink")   [ "\${FAKE_UP_chainlink:-0}" = 1 ] && echo true || echo false ;;
  "inspect --format {{.State.Running}} cl-postgres") [ "\${FAKE_UP_postgres:-0}" = 1 ] && echo true || echo false ;;
  "inspect "*) exit 0 ;;
  "restart chainlink --time=30") echo restart >> "$T/restarts" ;;
  "logs "*) : ;;
esac
exit 0
EOF
# curl: AI Node health (FAKE_AI=1), adapter /version (FAKE_EA=1), chainlink /health JSON.
cat > "$B/curl" <<'EOF'
#!/bin/bash
case "$*" in
  *localhost:3000/api/health*) [ "${FAKE_AI:-0}" = 1 ] && { echo '{"status":"ok"}'; exit 0; }; exit 7 ;;
  *localhost:8080/version*)    [ "${FAKE_EA:-0}" = 1 ] && { echo '{"service":"ea"}'; exit 0; }; exit 7 ;;
  *localhost:6688/health*)     printf '%s' "${FAKE_HEALTH_JSON:-}"; exit 0 ;;
esac
exit 7
EOF
# ss / lsof: a port listens when it is in FAKE_PORTS.
cat > "$B/ss" <<'EOF'
#!/bin/bash
echo "State Recv-Q Send-Q Local_Address:Port Peer_Address:Port"
for p in ${FAKE_PORTS:-}; do echo "LISTEN 0 511 0.0.0.0:$p 0.0.0.0:*"; done
EOF
printf '#!/bin/bash\nexit 1\n' > "$B/lsof"
printf '#!/bin/bash\nexit 0\n' > "$B/logger"
chmod +x "$B"/*
HEALTH_OK='{"data":[{"attributes":{"name":"EVM.84532.Txm.Broadcaster","status":"passing","output":""}}]}'
HEALTH_ZERO_LIVE='{"data":[{"attributes":{"name":"EVM.84532.Txm.Broadcaster","status":"failing","output":"No live RPC nodes available"}}]}'

reset() { rm -rf "$I/.chainlink-watchdog" "$T/alerts" "$T/starts" "$T/restarts" "$I/.arbiter-stopped"; }
# all components up unless overridden
run() { env HOME="$T" PATH="$B:$PATH" FAKE_UP_chainlink=1 FAKE_UP_postgres=1 FAKE_AI=1 FAKE_EA=1 FAKE_PORTS="3000 8080" \
            FAKE_HEALTH_JSON="$HEALTH_OK" WATCHDOG_UPTIME_FILE="$T/uptime" "$@" 2>&1; }
uptime_secs() { echo "$1.00 $1.00" > "$T/uptime"; }
WD="$I/chainlink-health-watchdog.sh"

# A. Everything up: healthy, exit 0.
reset; uptime_secs 86400
out=$(run bash "$WD"); rc=$?
[ "$rc" = 0 ] && ok || bad "all up: rc=$rc: $out"
has "all up" "$out" "OK: all four components running"

# B. After a reboot nothing came back: NOT RUNNING, names every component,
#    says how long ago the host booted; --self-heal runs start-arbiter.sh.
reset; uptime_secs 600
out=$(run env FAKE_UP_chainlink=0 FAKE_UP_postgres=0 FAKE_AI=0 FAKE_EA=0 FAKE_PORTS="" bash "$WD" --quiet --self-heal); rc=$?
[ "$rc" = 1 ] && ok || bad "reboot: rc=$rc, expected 1"
has "reboot" "$out" "^chainlink container NOT RUNNING (also down: cl-postgres container, AI Node, External Adapter)"
hasnt "reboot" "$out" "CANNOT BROADCAST"
has "reboot" "$out" "host booted 10m ago and the arbiter did not come back on its own"
has "reboot" "$out" "self-heal: running $I/start-arbiter.sh to bring up: cl-postgres container, chainlink container, AI Node, External Adapter"
[ "$(wc -l < "$T/starts" 2>/dev/null | tr -d ' ')" = 1 ] && ok || bad "reboot: start-arbiter.sh ran $(cat "$T/starts" 2>/dev/null | wc -l) times, expected 1"
[ ! -f "$T/restarts" ] && ok || bad "reboot: the chainlink container was restarted instead of started through start-arbiter.sh"
grep -q "chainlink container NOT RUNNING" "$T/alerts" && ok || bad "reboot: alert command did not get the subject"

# G. Same state again within the cooldown: no second start.
out=$(run env FAKE_UP_chainlink=0 FAKE_UP_postgres=0 FAKE_AI=0 FAKE_EA=0 FAKE_PORTS="" bash "$WD" --quiet --self-heal)
has "cooldown" "$out" "self-heal: skipped (last action <30m ago)"
[ "$(wc -l < "$T/starts" | tr -d ' ')" = 1 ] && ok || bad "cooldown: start-arbiter.sh ran again"

# C. Two minutes after boot: alert, but give verdikta-arbiter.service time first.
reset; uptime_secs 120
out=$(run env FAKE_UP_chainlink=0 FAKE_UP_postgres=0 FAKE_AI=0 FAKE_EA=0 FAKE_PORTS="" bash "$WD" --quiet --self-heal)
has "boot grace" "$out" "self-heal: waiting, host booted 2m ago"
[ ! -f "$T/starts" ] && ok || bad "boot grace: start-arbiter.sh ran 2 minutes after boot"

# D. Container up, RPC pool dead: CANNOT BROADCAST; self-heal restarts the container only.
reset; uptime_secs 86400
out=$(run env FAKE_HEALTH_JSON="$HEALTH_ZERO_LIVE" bash "$WD" --quiet --self-heal); rc=$?
[ "$rc" = 1 ] && ok || bad "zero-live: rc=$rc"
has "zero-live" "$out" "^chainlink node CANNOT BROADCAST (0 live RPC / broadcaster down)"
hasnt "zero-live" "$out" "NOT RUNNING"
has "zero-live" "$out" "self-heal: restarting chainlink container"
[ -f "$T/restarts" ] && ok || bad "zero-live: docker restart chainlink not called"
[ ! -f "$T/starts" ] && ok || bad "zero-live: start-arbiter.sh ran for a 0-live condition"

# E. Operator stop (stop-arbiter.sh marker): STOPPED, no self-heal.
reset; uptime_secs 86400; echo "2026-10-19T10:00:00Z" > "$I/.arbiter-stopped"
out=$(run env FAKE_UP_chainlink=0 FAKE_AI=0 FAKE_EA=0 FAKE_PORTS="" bash "$WD" --quiet --self-heal); rc=$?
[ "$rc" = 1 ] && ok || bad "operator stop: rc=$rc"
has "operator stop" "$out" "^arbiter STOPPED by operator (stop-arbiter.sh): chainlink container, AI Node, External Adapter"
has "operator stop" "$out" "self-heal: skipped, the node was stopped by stop-arbiter.sh"
[ ! -f "$T/starts" ] && ok || bad "operator stop: start-arbiter.sh ran during an operator stop"

# F. Only the adapter died: names it, container state untouched.
reset; uptime_secs 86400
out=$(run env FAKE_EA=0 FAKE_PORTS="3000" bash "$WD" --quiet)
has "adapter down" "$out" "^arbiter components NOT RUNNING: External Adapter"
has "adapter down" "$out" "External Adapter is not running (nothing listens on :8080)"
hasnt "adapter down" "$out" "chainlink container"

# H. AI Node listening but still warming up: a problem, not "down" (no self-heal).
reset; uptime_secs 86400
out=$(run env FAKE_AI=0 bash "$WD" --quiet --self-heal)
has "warming up" "$out" "AI Node is listening on :3000 but /api/health does not answer ok"
has "warming up" "$out" "^arbiter UNHEALTHY"
[ ! -f "$T/starts" ] && ok || bad "warming up: start-arbiter.sh ran for a warming-up node"

# I. Recovery after an alert: one RECOVERED notice.
reset; uptime_secs 86400
run env FAKE_EA=0 FAKE_PORTS="3000" bash "$WD" --quiet >/dev/null
out=$(run bash "$WD"); rc=$?
[ "$rc" = 0 ] && ok || bad "recovery: rc=$rc"
grep -q "RECOVERED: arbiter healthy again" "$T/alerts" && ok || bad "recovery: no RECOVERED alert"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
