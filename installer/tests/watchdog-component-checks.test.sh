#!/bin/bash
# chainlink-health-watchdog.sh after the 2026-10-18 reboot wave. The alert must
# say "NOT RUNNING" when a component is down (and after a reboot say so) and
# keep "CANNOT BROADCAST" for a running container with a dead RPC pool;
# --self-heal must bring the node up through start-arbiter.sh, never during an
# operator stop (.arbiter-stopped), never right after a boot, and only once
# per cooldown; a dead RPC pool still restarts the container.
# A model provider that refuses the operator's API key (sections J to Q): every
# component is up and every request succeeds with one juror fewer, so the watchdog
# reads the AI Node's PROVIDER_AUTH_FAILED lines (ai-node/logs/provider-auth.log)
# and says "REFUSED the API key" while one is younger than the window.
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
mkdir -p "$I/installer" "$I/ai-node/logs" "$B"
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

reset() { rm -rf "$I/.chainlink-watchdog" "$T/alerts" "$T/starts" "$T/restarts" "$I/.arbiter-stopped" "$AUTH_LOG"; }
# all components up unless overridden
run() { env HOME="$T" PATH="$B:$PATH" FAKE_UP_chainlink=1 FAKE_UP_postgres=1 FAKE_AI=1 FAKE_EA=1 FAKE_PORTS="3000 8080" \
            FAKE_HEALTH_JSON="$HEALTH_OK" WATCHDOG_UPTIME_FILE="$T/uptime" "$@" 2>&1; }
uptime_secs() { echo "$1.00 $1.00" > "$T/uptime"; }
WD="$I/chainlink-health-watchdog.sh"
# The AI Node's refusal log: "<ISO time> PROVIDER_AUTH_FAILED: provider=.. model=.. role=.. http_status=..".
AUTH_LOG="$I/ai-node/logs/provider-auth.log"
iso_ago() { date -u -d "$1 minutes ago" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -v-"$1"M +%Y-%m-%dT%H:%M:%S.000Z; }
refused() { # refused MINUTES_AGO PROVIDER MODEL ROLE STATUS
    echo "$(iso_ago "$1") PROVIDER_AUTH_FAILED: provider=$2 model=$3 role=$4 http_status=$5" >> "$AUTH_LOG"
}
count() { grep -c -- "$1" "$2" 2>/dev/null || true; }

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

# J. A juror's provider refused the key five minutes ago; everything else is up.
#    Unhealthy, the subject says what and who, one line however many refusals,
#    and --self-heal has nothing to start or restart.
reset; uptime_secs 86400
refused 9 OpenAI gpt-4o juror 401; refused 7 OpenAI gpt-4o juror 401; refused 5 OpenAI gpt-4o juror 401
out=$(run bash "$WD" --quiet --self-heal); rc=$?
[ "$rc" = 1 ] && ok || bad "key refused: rc=$rc, expected 1: $out"
has "key refused" "$out" "^model provider REFUSED the API key: OpenAI$"
has "key refused" "$out" "the API key used for OpenAI gpt-4o was refused (juror, HTTP 401) in the last 60m: requests are answered without this model"
has "key refused" "$out" "Replace the key in $I/ai-node/.env.local"
[ "$(printf '%s\n' "$out" | grep -c 'was refused')" = 1 ] && ok || bad "key refused: three refusals of one key are not one line: $out"
hasnt "key refused" "$out" "self-heal"
[ ! -f "$T/starts" ] && [ ! -f "$T/restarts" ] && ok || bad "key refused: the self-heal started or restarted something"
[ "$(count 'model provider REFUSED the API key: OpenAI' "$T/alerts")" = 1 ] && ok || bad "key refused: the alert command did not get the subject once"

# K. The next pass, with another refusal since: the same problem, so the pager
#    stays quiet inside the cooldown (the line holds no count and no time).
refused 0 OpenAI gpt-4o juror 401
out=$(run bash "$WD" --quiet); rc=$?
[ "$rc" = 1 ] && ok || bad "key refused again: rc=$rc"
has "key refused again" "$out" "^model provider REFUSED the API key: OpenAI$"
[ "$(count 'model provider REFUSED the API key' "$T/alerts")" = 1 ] && ok || bad "key refused again: paged a second time inside the cooldown"
grep -q "alert suppressed by 30m cooldown" "$I/.chainlink-watchdog/watchdog.log" && ok || bad "key refused again: no cooldown note in the watchdog log"

# L. Two providers, a juror and the justifier, one without a status: both named
#    once in the subject, a line each. A second key is a new problem set: paged.
refused 1 Anthropic claude-opus-5-5 justifier none
refused 1 Anthropic claude-opus-5-5 juror 401
out=$(run bash "$WD" --quiet)
has "two providers" "$out" "^model provider REFUSED the API key: OpenAI, Anthropic$"
has "two providers" "$out" "the API key used for Anthropic claude-opus-5-5 was refused (justifier) in the last 60m"
has "two providers" "$out" "the API key used for Anthropic claude-opus-5-5 was refused (juror, HTTP 401) in the last 60m"
[ "$(printf '%s\n' "$out" | grep -c 'was refused')" = 3 ] && ok || bad "two providers: expected three lines: $out"
[ "$(count 'model provider REFUSED the API key: OpenAI, Anthropic' "$T/alerts")" = 1 ] && ok || bad "two providers: the new problem set was not paged"

# M. A refusal older than the window is history: healthy, and the OK line says
#    what was looked at. WATCHDOG_AUTH_WINDOW_MINUTES widens the window.
reset; uptime_secs 86400
refused 120 OpenAI gpt-4o juror 401
out=$(run bash "$WD"); rc=$?
[ "$rc" = 0 ] && ok || bad "old refusal: rc=$rc: $out"
has "old refusal" "$out" "OK: all four components running"
has "old refusal" "$out" "No model provider refused an API key in the last 60m."
out=$(run env WATCHDOG_AUTH_WINDOW_MINUTES=180 bash "$WD" --quiet); rc=$?
[ "$rc" = 1 ] && ok || bad "wider window: rc=$rc"
has "wider window" "$out" "was refused (juror, HTTP 401) in the last 180m"
out=$(run env WATCHDOG_AUTH_WINDOW_MINUTES=soon bash "$WD"); rc=$?
[ "$rc" = 0 ] && ok || bad "a window that is not a number falls back to 60: rc=$rc: $out"

# N. The window passes without another refusal: one RECOVERED notice, which says
#    what it rests on.
reset; uptime_secs 86400
refused 2 xAI grok-4 juror 400
run bash "$WD" --quiet >/dev/null
grep -q "model provider REFUSED the API key: xAI" "$T/alerts" && ok || bad "recovery from a refusal: no alert first"
rm -f "$AUTH_LOG"; refused 61 xAI grok-4 juror 400
out=$(run bash "$WD"); rc=$?
[ "$rc" = 0 ] && ok || bad "recovery from a refusal: rc=$rc: $out"
grep -q "RECOVERED: arbiter healthy again" "$T/alerts" && ok || bad "recovery from a refusal: no RECOVERED alert"
grep -q "No model provider refused an API key in the last 60m." "$T/alerts" && ok || bad "recovery from a refusal: RECOVERED does not say what it rests on"

# O. Only the exact line counts. The main log's form has no time; the rest is what
#    a provider or model name could not write (the AI Node leaves no space in one)
#    and what is simply not the line.
reset; uptime_secs 86400
NOW=$(iso_ago 0)
cat >> "$AUTH_LOG" <<E
PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401
$NOW PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401 trailing
$NOW PROVIDER_AUTH_FAILED: provider=Open AI model=gpt-4o role=juror http_status=401
$NOW PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=owner http_status=401
$NOW PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=40
$NOW PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror
$NOW PROVIDER_AUTH_OK: provider=OpenAI model=gpt-4o role=juror http_status=401
$NOW  note PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401
yesterday PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401
9999-99-99 PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401

E
out=$(run bash "$WD"); rc=$?
[ "$rc" = 0 ] && ok || bad "not the line: rc=$rc: $out"
hasnt "not the line" "$out" "refused the API key\|was refused"
# ... and the exact line among them does.
refused 0 Hyperbolic_API meta-llama/Meta-Llama-3.1-405B-Instruct juror 401
out=$(run bash "$WD" --quiet)
has "the line among others" "$out" "^model provider REFUSED the API key: Hyperbolic_API$"
has "the line among others" "$out" "the API key used for Hyperbolic_API meta-llama/Meta-Llama-3.1-405B-Instruct was refused (juror, HTTP 401)"
[ "$(printf '%s\n' "$out" | grep -c 'was refused')" = 1 ] && ok || bad "the line among others: expected one line: $out"

# P. A component down as well: the subject stays with what is down, the refusal
#    is in the body, and the self-heal still brings the component up.
reset; uptime_secs 86400
refused 3 OpenAI gpt-4o juror 401
out=$(run env FAKE_EA=0 FAKE_PORTS="3000" bash "$WD" --quiet --self-heal)
has "down and refused" "$out" "^arbiter components NOT RUNNING: External Adapter"
has "down and refused" "$out" "the API key used for OpenAI gpt-4o was refused"
[ "$(wc -l < "$T/starts" 2>/dev/null | tr -d ' ')" = 1 ] && ok || bad "down and refused: start-arbiter.sh did not run once"

# Q. An AI Node that never wrote the file (an older one, or no refusal yet): as
#    before, and the OK line claims nothing about keys.
reset; uptime_secs 86400
out=$(run bash "$WD"); rc=$?
[ "$rc" = 0 ] && ok || bad "no refusal log: rc=$rc"
has "no refusal log" "$out" "no recent 0-live RPC events.$"
hasnt "no refusal log" "$out" "API key"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
