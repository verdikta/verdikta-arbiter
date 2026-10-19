#!/bin/bash
#
# Verdikta Arbiter - Chainlink Health Watchdog (P1-B, July 2026 incident;
# component checks + full self-heal after the 2026-10-18 reboot wave)
#
# The July 2026 commit-stage outage was silent for hours: the Chainlink node's
# RPC pool dropped to 0 live nodes ("No live RPC nodes available") and the
# TxManager could not broadcast commit transactions, while every service
# looked "up" from the outside. This watchdog is designed to run from cron
# every few minutes and page the operator within minutes of that condition.
#
# What it checks:
#   1. the four components are running: cl-postgres and chainlink containers,
#      AI Node (:3000, GET /api/health), External Adapter (:8080, GET /version)
#   2. http://localhost:6688/health — every EVM.* / core check is "passing"
#   3. recent container log lines matching "No live RPC nodes available"
#
# Alert subjects say which it is:
#   "chainlink container NOT RUNNING" / "arbiter components NOT RUNNING: ..."
#       something is down (after a host reboot: every component, and the body
#       says how long ago the host booted and whether verdikta-arbiter.service
#       is enabled)
#   "chainlink node CANNOT BROADCAST (0 live RPC / broadcaster down)"
#       the container runs but its RPC pool is dead
#   "arbiter STOPPED by operator (stop-arbiter.sh)"
#       stop-arbiter.sh left <install>/.arbiter-stopped: an upgrade or
#       maintenance window; no self-heal until start-arbiter.sh clears it
#
# How it alerts (all configured alert channels fire; syslog always fires):
#   - syslog via `logger -t verdikta-watchdog` (always)
#   - WATCHDOG_ALERT_COMMAND  — shell command the human-readable alert text is
#     piped into (paging channel; cooldown-limited)
#   - WATCHDOG_ALERT_WEBHOOK  — URL POSTed one JSON event per run: status
#     OK (heartbeat) / ALERT / RECOVERED, tagged with the node's on-chain
#     operator address and network. This is what the arbiter status page
#     (example-arbiters /api/alerts) consumes; heartbeats let it flag arbiters
#     that stop reporting entirely.
#     Events are signed with the operator owner key (PRIVATE_KEY from
#     installer/.env) — an EIP-191 personal-message signature computed locally:
#     no transaction, no gas. The server verifies the signer against owner()
#     on-chain; unsigned events are rejected, so signing (key + node + ethers,
#     all present on a standard install) is required for status-page reporting.
#     Both can be set in the environment or in <install>/installer/.env
#
# Self-heal (per incident report P1-B: restart is acceptable but must alert,
# never silently restart):
#   --self-heal           components down  -> run <install>/start-arbiter.sh
#                                             (starts whatever is missing: both
#                                             containers, AI Node, adapter)
#                         0-live RPC       -> restart the chainlink container
#                         The alert always fires first and records what was
#                         done. Rate-limited to one action per
#                         WATCHDOG_RESTART_COOLDOWN_MINUTES (default 30); never
#                         while .arbiter-stopped exists (operator stopped it).
#
# Usage:
#   chainlink-health-watchdog.sh                 # one check pass, human output
#   chainlink-health-watchdog.sh --quiet         # cron mode: output only on problems
#   chainlink-health-watchdog.sh --self-heal     # also start/restart what is down
#   chainlink-health-watchdog.sh --install-cron [N]   # install crontab entry (every N min, default 2)
#   chainlink-health-watchdog.sh --uninstall-cron
#
# Exit codes: 0 healthy, 1 unhealthy (alert fired or suppressed by cooldown), 64 misuse.
#

set -o pipefail

SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || echo "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

QUIET=0
SELF_HEAL=0
CRON_TAG="# verdikta-chainlink-watchdog"

# Tunables (environment or installer/.env can override)
HEALTH_URL="${WATCHDOG_HEALTH_URL:-http://localhost:6688/health}"
LOG_WINDOW_MINUTES="${WATCHDOG_LOG_WINDOW_MINUTES:-10}"
ALERT_COOLDOWN_MINUTES="${WATCHDOG_ALERT_COOLDOWN_MINUTES:-30}"
RESTART_COOLDOWN_MINUTES="${WATCHDOG_RESTART_COOLDOWN_MINUTES:-30}"
# WATCHDOG_BOOT_GRACE_MINUTES (default 5): no self-heal this soon after a boot.

usage() {
    sed -n '2,64p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'
}

INSTALL_CRON=""
ACTION="check"
while [ $# -gt 0 ]; do
    case "$1" in
        --quiet) QUIET=1; shift ;;
        --self-heal) SELF_HEAL=1; shift ;;
        --install-cron)
            ACTION="install-cron"; shift
            if [ $# -gt 0 ] && [[ "$1" =~ ^[0-9]+$ ]]; then INSTALL_CRON="$1"; shift; fi
            ;;
        --uninstall-cron) ACTION="uninstall-cron"; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
    esac
done

say() { [ "$QUIET" = "1" ] || echo "$@"; }

############################################
# Locate install dir (same strategy as arbiter-doctor.sh)
############################################
INSTALL_DIR=""
if [ -d "/root/verdikta-arbiter-node" ] && [ -f "/root/verdikta-arbiter-node/installer/.env" ]; then
    INSTALL_DIR="/root/verdikta-arbiter-node"
elif [ -d "$HOME/verdikta-arbiter-node" ] && [ -f "$HOME/verdikta-arbiter-node/installer/.env" ]; then
    INSTALL_DIR="$HOME/verdikta-arbiter-node"
else
    d="$SCRIPT_DIR"
    while [ "$d" != "/" ]; do
        if [ -f "$d/installer/.env" ]; then INSTALL_DIR="$d"; break; fi
        d="$(dirname "$d")"
    done
fi

# Pick up alert configuration from the install env file (env vars win).
if [ -n "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/installer/.env" ]; then
    _env_webhook=$(grep -E '^WATCHDOG_ALERT_WEBHOOK=' "$INSTALL_DIR/installer/.env" | tail -1 | cut -d= -f2- | tr -d '"')
    _env_command=$(grep -E '^WATCHDOG_ALERT_COMMAND=' "$INSTALL_DIR/installer/.env" | tail -1 | cut -d= -f2- | tr -d '"')
    WATCHDOG_ALERT_WEBHOOK="${WATCHDOG_ALERT_WEBHOOK:-$_env_webhook}"
    WATCHDOG_ALERT_COMMAND="${WATCHDOG_ALERT_COMMAND:-$_env_command}"
fi

# Identity for structured webhook events: the on-chain operator address is how
# the arbiter status page (example-arbiters /analytics) keys its tables.
WD_OPERATOR=""
WD_NETWORK=""
WD_PRIVATE_KEY=""
if [ -n "$INSTALL_DIR" ]; then
    [ -f "$INSTALL_DIR/installer/.contracts" ] && \
        WD_OPERATOR=$(grep -E '^OPERATOR_ADDR=' "$INSTALL_DIR/installer/.contracts" | tail -1 | cut -d= -f2- | tr -d '"')
    if [ -f "$INSTALL_DIR/installer/.env" ]; then
        WD_NETWORK=$(grep -E '^DEPLOYMENT_NETWORK=' "$INSTALL_DIR/installer/.env" | tail -1 | cut -d= -f2- | tr -d '"')
        # Operator owner key (stored without 0x prefix by the installer). Used
        # ONLY to sign webhook events locally (EIP-191 personal message — no
        # transaction, no gas); never sent anywhere.
        if [ -n "$WATCHDOG_ALERT_WEBHOOK" ]; then
            WD_PRIVATE_KEY=$(grep -E '^PRIVATE_KEY=' "$INSTALL_DIR/installer/.env" | tail -1 | cut -d= -f2- | tr -d '"')
            [ -n "$WD_PRIVATE_KEY" ] && [[ "$WD_PRIVATE_KEY" != 0x* ]] && WD_PRIVATE_KEY="0x$WD_PRIVATE_KEY"
        fi
    fi
fi

STATE_DIR="${INSTALL_DIR:-$HOME}/.chainlink-watchdog"
mkdir -p "$STATE_DIR" 2>/dev/null
WATCHDOG_LOG="$STATE_DIR/watchdog.log"
LAST_ALERT_FILE="$STATE_DIR/last-alert"
LAST_RESTART_FILE="$STATE_DIR/last-restart"
LAST_STATE_FILE="$STATE_DIR/last-state"
STOPPED_MARKER="${INSTALL_DIR:-$HOME}/.arbiter-stopped"   # written by stop-arbiter.sh, removed by start-arbiter.sh

############################################
# Cron management
############################################
if [ "$ACTION" = "install-cron" ]; then
    interval="${INSTALL_CRON:-2}"
    extra=""
    [ "$SELF_HEAL" = "1" ] && extra=" --self-heal"
    entry="*/$interval * * * * $SCRIPT_PATH --quiet$extra $CRON_TAG"
    ( crontab -l 2>/dev/null | grep -vF "$CRON_TAG"; echo "$entry" ) | crontab -
    echo "Installed cron entry (every $interval min):"
    echo "  $entry"
    echo "Configure alerting by setting WATCHDOG_ALERT_WEBHOOK and/or WATCHDOG_ALERT_COMMAND"
    echo "in $INSTALL_DIR/installer/.env (syslog via 'logger' is always used)."
    exit 0
fi
if [ "$ACTION" = "uninstall-cron" ]; then
    crontab -l 2>/dev/null | grep -vF "$CRON_TAG" | crontab -
    echo "Removed watchdog cron entry (if present)."
    exit 0
fi

# One check pass at a time: a self-heal via start-arbiter.sh can run for
# minutes, longer than the cron interval; a second pass must not start the
# components again on top of it. Skipped silently when flock is unavailable.
if command -v flock >/dev/null 2>&1; then
    exec 9>"$STATE_DIR/run.lock" 2>/dev/null && ! flock -n 9 && { say "another watchdog pass is still running; skipping"; exit 0; }
fi

############################################
# Helpers
############################################
now_epoch() { date +%s; }

# Something listening on a local TCP port (ss first; lsof -i misses listeners
# in some namespace/cgroup setups, so it is only the fallback).
port_listening() {
    if command -v ss >/dev/null 2>&1; then
        ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
        return $?
    fi
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

container_running() {
    [ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]
}

host_uptime_minutes() {
    local secs
    secs=$(cut -d. -f1 "${WATCHDOG_UPTIME_FILE:-/proc/uptime}" 2>/dev/null)
    [[ "$secs" =~ ^[0-9]+$ ]] && echo $((secs / 60))
}

boot_service_state() {
    # enabled | disabled | not installed | (empty when there is no systemd)
    command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || return 0
    local st
    st=$(systemctl is-enabled verdikta-arbiter.service 2>/dev/null)
    echo "${st:-not installed}"
}

log_line() {
    # Bounded internal log so the watchdog itself never becomes a disk risk.
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$WATCHDOG_LOG"
    if [ "$(wc -c < "$WATCHDOG_LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
        tail -n 500 "$WATCHDOG_LOG" > "$WATCHDOG_LOG.tmp" && mv "$WATCHDOG_LOG.tmp" "$WATCHDOG_LOG"
    fi
}

minutes_since_file() {
    # prints minutes since the epoch stored on the file's first line,
    # or a huge number if the file is absent/garbled
    local f="$1" ts
    ts=$(head -n1 "$f" 2>/dev/null)
    if [[ "$ts" =~ ^[0-9]+$ ]]; then
        echo $(( ($(now_epoch) - ts) / 60 ))
    else
        echo 999999
    fi
}

# Page the operator: syslog + optional shell command (human-readable text).
# The webhook channel is separate — see post_status_webhook.
send_alert() {
    local subject="$1" body="$2"
    local msg="[verdikta-watchdog] $(hostname): $subject
$body"

    logger -t verdikta-watchdog -p daemon.err "$subject" 2>/dev/null

    if [ -n "$WATCHDOG_ALERT_COMMAND" ]; then
        printf '%s\n' "$msg" | bash -c "$WATCHDOG_ALERT_COMMAND" >/dev/null 2>&1 \
            || log_line "alert command delivery FAILED ($WATCHDOG_ALERT_COMMAND)"
    fi
    log_line "ALERT: $subject"
}

# Locate a node binary (cron has a bare PATH; prefer the newest nvm install).
wd_find_node() {
    command -v node 2>/dev/null && return 0
    ls -1 "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1
}

# Sign a message with the operator owner key (EIP-191 personal message —
# pure local computation, NO transaction and NO gas). Uses the ethers package
# already installed with the arbiter components (works with ethers v5 and v6).
# Args: MESSAGE. Echoes "signerAddress signature"; fails silently if the key,
# node, or ethers are unavailable (caller falls back to unsigned + token).
wd_sign_message() {
    [ -n "$WD_PRIVATE_KEY" ] || return 1
    local node_bin ethers_home d
    node_bin=$(wd_find_node) || return 1
    [ -n "$node_bin" ] || return 1
    for d in "$INSTALL_DIR/external-adapter" "$INSTALL_DIR/arbiter-operator" "$INSTALL_DIR/ai-node"; do
        [ -d "$d/node_modules/ethers" ] && { ethers_home="$d"; break; }
    done
    [ -n "$ethers_home" ] || return 1
    WD_SIGN_MSG="$1" WD_PK="$WD_PRIVATE_KEY" WD_ETHERS_HOME="$ethers_home" "$node_bin" -e '
const path = require("path");
const pkg = require(path.join(process.env.WD_ETHERS_HOME, "node_modules", "ethers"));
const Wallet = pkg.Wallet || (pkg.ethers && pkg.ethers.Wallet);
(async () => {
  const w = new Wallet(process.env.WD_PK);
  const sig = await w.signMessage(process.env.WD_SIGN_MSG);
  console.log(w.address + " " + sig);
})().catch(() => process.exit(1));
' 2>/dev/null
}

# Post one structured JSON event to WATCHDOG_ALERT_WEBHOOK (if configured).
# Called exactly once per run with the current state, so the receiving side
# (e.g. the arbiter status page's /api/alerts) gets both alerts AND heartbeats
# — missing heartbeats let it flag arbiters whose whole machine went dark.
#
# Authentication: the event is signed with the operator owner key (the server
# verifies the signer matches owner() on-chain and rejects unsigned events).
# Args: STATUS(OK|ALERT|RECOVERED) SEVERITY(info|warning|critical) SUBJECT PROBLEMS_TEXT [SELF_HEAL_NOTE]
post_status_webhook() {
    [ -n "$WATCHDOG_ALERT_WEBHOOK" ] || return 0

    local wd_ts wd_signer wd_sig sign_out
    wd_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    wd_signer=""
    wd_sig=""
    if [ -n "$WD_OPERATOR" ] && [ -n "$WD_PRIVATE_KEY" ]; then
        # Canonical message: pipe-free colon form, operator lowercased. Must
        # match the verification in example-arbiters alertsRoutes.js exactly.
        local op_lower msg
        op_lower=$(echo "$WD_OPERATOR" | tr '[:upper:]' '[:lower:]')
        msg="verdikta-arbiter-watchdog:v1:${op_lower}:${WD_NETWORK}:${1}:${wd_ts}"
        if sign_out=$(wd_sign_message "$msg"); then
            wd_signer="${sign_out%% *}"
            wd_sig="${sign_out##* }"
        else
            log_line "webhook signing unavailable (missing key/node/ethers) — the status page will reject unsigned events"
        fi
    fi

    # Node telemetry (informational, best-effort): host + chainlink container
    # uptime and the chainlink image tag. Missing values are simply omitted.
    local host_uptime cl_uptime cl_image cl_started
    host_uptime=$(cut -d. -f1 /proc/uptime 2>/dev/null)
    cl_image=$(docker inspect --format '{{.Config.Image}}' chainlink 2>/dev/null)
    cl_started=$(docker inspect --format '{{.State.StartedAt}}' chainlink 2>/dev/null)
    cl_uptime=""
    if [ "$(docker inspect --format '{{.State.Running}}' chainlink 2>/dev/null)" = "true" ] && [ -n "$cl_started" ]; then
        cl_uptime=$(python3 -c "
import sys, datetime, re
s = re.sub(r'\.[0-9]+', '', sys.argv[1]).replace('Z', '+00:00')
t = datetime.datetime.fromisoformat(s).astimezone(datetime.timezone.utc)
print(int((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()))
" "$cl_started" 2>/dev/null)
    fi

    local payload
    payload=$(WD_STATUS="$1" WD_SEVERITY="$2" WD_SUBJECT="$3" WD_PROBLEMS="$4" WD_SELFHEAL="${5:-}" \
              WD_OPERATOR="$WD_OPERATOR" WD_NETWORK="$WD_NETWORK" WD_TS="$wd_ts" \
              WD_SIGNER="$wd_signer" WD_SIG="$wd_sig" \
              WD_HOST_UPTIME="$host_uptime" WD_CL_UPTIME="$cl_uptime" WD_CL_IMAGE="$cl_image" python3 - << 'PY'
import json, os, socket
problems = [p.strip().lstrip("- ").strip() for p in os.environ.get("WD_PROBLEMS", "").splitlines() if p.strip()]
event = {
    "type": "verdikta-arbiter-watchdog",
    "version": 1,
    "operator": os.environ.get("WD_OPERATOR") or None,
    "network": os.environ.get("WD_NETWORK") or None,
    "hostname": socket.gethostname(),
    "status": os.environ["WD_STATUS"],
    "severity": os.environ.get("WD_SEVERITY") or "info",
    "subject": os.environ.get("WD_SUBJECT") or "",
    "problems": problems,
    "selfHeal": os.environ.get("WD_SELFHEAL") or None,
    "ts": os.environ["WD_TS"],
}
for key, env in (("hostUptimeSec", "WD_HOST_UPTIME"), ("chainlinkUptimeSec", "WD_CL_UPTIME")):
    v = os.environ.get(env, "")
    if v.isdigit():
        event[key] = int(v)
if os.environ.get("WD_CL_IMAGE"):
    event["chainlinkImage"] = os.environ["WD_CL_IMAGE"]
if os.environ.get("WD_SIGNER") and os.environ.get("WD_SIG"):
    event["signer"] = os.environ["WD_SIGNER"]
    event["sig"] = os.environ["WD_SIG"]
print(json.dumps(event))
PY
) || { log_line "webhook payload build FAILED"; return 1; }

    curl -fsS --max-time 10 -X POST -H 'Content-Type: application/json' \
        --data-binary "$payload" "$WATCHDOG_ALERT_WEBHOOK" >/dev/null 2>&1 \
        || log_line "webhook delivery FAILED ($WATCHDOG_ALERT_WEBHOOK)"
}

############################################
# Checks
############################################
PROBLEMS=""
ZERO_LIVE=0        # container up, RPC pool dead: TxManager cannot broadcast
DOWN=""            # components that are not running, comma-separated
CONTAINER_DOWN=0   # the chainlink container itself is not running

add_problem() {
    PROBLEMS="${PROBLEMS}  - $1
"
}
add_down() {
    DOWN="${DOWN}${DOWN:+, }$1"
}

# 1. Components running? One line per component; the subject names them.
if ! container_running cl-postgres; then
    if docker inspect cl-postgres >/dev/null 2>&1; then
        add_problem "cl-postgres container is not running (the Chainlink node has no database)"
    else
        add_problem "cl-postgres container does not exist"
    fi
    add_down "cl-postgres container"
fi

if ! container_running chainlink; then
    if docker inspect chainlink >/dev/null 2>&1; then
        add_problem "chainlink container is not running"
    else
        add_problem "chainlink container does not exist"
    fi
    add_down "chainlink container"
    CONTAINER_DOWN=1
fi

AI_NODE_DIR="${INSTALL_DIR:-$HOME/verdikta-arbiter-node}/ai-node"
if curl -fsS --max-time 5 http://localhost:3000/api/health 2>/dev/null | grep -q '"status" *: *"ok"'; then
    :
elif port_listening 3000; then
    # Listening but not answering: Next.js warms up for ~60 s after a start.
    add_problem "AI Node is listening on :3000 but /api/health does not answer ok (still warming up, or stuck)"
else
    ai_build_pid=$(cat "$AI_NODE_DIR/.build-in-progress" 2>/dev/null)
    if [ -n "$ai_build_pid" ] && kill -0 "$ai_build_pid" 2>/dev/null; then
        add_problem "AI Node is not serving yet: start.sh is building its production bundle (pid $ai_build_pid)"
    else
        add_problem "AI Node is not running (nothing listens on :3000)"
        add_down "AI Node"
    fi
fi

if curl -fsS --max-time 5 http://localhost:8080/version >/dev/null 2>&1 || port_listening 8080; then
    :
else
    add_problem "External Adapter is not running (nothing listens on :8080)"
    add_down "External Adapter"
fi

if [ "$CONTAINER_DOWN" = "0" ]; then
    # 2. Health endpoint: collect every check whose status != passing.
    #    /health returns 200 when all pass, 503 when any fail — both carry the
    #    JSON body, so do not use curl -f here.
    health_json=$(curl -sS --max-time 10 "$HEALTH_URL" 2>/dev/null)
    if [ -z "$health_json" ]; then
        add_problem "chainlink /health endpoint unreachable at $HEALTH_URL"
    else
        failing=$(printf '%s' "$health_json" | python3 -c '
import sys, json
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for item in doc.get("data", []):
    attrs = item.get("attributes", {})
    status = attrs.get("status")
    if status != "passing":
        name = attrs.get("name") or item.get("id") or "?"
        out = (attrs.get("output") or "").strip().splitlines()
        detail = " (" + out[0][:160] + ")" if out else ""
        print(name + ": " + str(status) + detail)
' 2>/dev/null)
        if [ -n "$failing" ]; then
            while IFS= read -r line; do
                add_problem "health check not passing: $line"
            done <<< "$failing"
            # Broadcaster/HeadTracker failing usually accompanies the 0-live state
            echo "$failing" | grep -qE 'Txm\.Broadcaster|HeadTracker' && ZERO_LIVE=1
        fi
    fi

    # 3. Recent "No live RPC nodes available" lines in the container log.
    #    Use --tail (seek-to-end, fast even on big logs) and filter by the
    #    ISO-8601 timestamp prefix, same approach as arbiter-doctor.sh.
    cutoff=$(date -u -d "$LOG_WINDOW_MINUTES minutes ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
    if [ -n "$cutoff" ]; then
        recent_zero_live=$(timeout 15 docker logs chainlink --tail 5000 2>&1 \
            | grep -F 'No live RPC nodes available' \
            | awk -v c="$cutoff" '
                $0 ~ /^2[0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/ {
                    if (substr($0,1,20) >= c) n++
                }
                END { print n+0 }')
        if [ "${recent_zero_live:-0}" -gt 0 ]; then
            add_problem "$recent_zero_live \"No live RPC nodes available\" line(s) in the last ${LOG_WINDOW_MINUTES}m — TxManager cannot broadcast (commit txs will miss their round deadline)"
            ZERO_LIVE=1
        fi
    fi
fi

############################################
# Report / alert / self-heal
############################################
if [ -z "$PROBLEMS" ]; then
    # Recovery notification: alert once when transitioning unhealthy -> healthy.
    if [ "$(cat "$LAST_STATE_FILE" 2>/dev/null)" = "unhealthy" ]; then
        send_alert "RECOVERED: arbiter healthy again" "All components running, all chainlink health checks passing."
        post_status_webhook "RECOVERED" "info" "arbiter healthy again" ""
        rm -f "$LAST_ALERT_FILE"
    else
        # Heartbeat: lets the receiving side flag arbiters that stop reporting.
        post_status_webhook "OK" "info" "healthy" ""
    fi
    echo "healthy" > "$LAST_STATE_FILE"
    say "OK: all four components running (cl-postgres, chainlink, AI Node, External Adapter), all chainlink health checks passing, no recent 0-live RPC events."
    exit 0
fi

echo "unhealthy" > "$LAST_STATE_FILE"

# Operator intent: stop-arbiter.sh leaves a marker (removed by start-arbiter.sh)
# so an upgrade or maintenance window reads as "stopped", not "down", and the
# self-heal does not start components under an upgrade's feet.
STOPPED_BY_OPERATOR=0
if [ -n "$DOWN" ] && [ -f "$STOPPED_MARKER" ]; then
    STOPPED_BY_OPERATOR=1
    add_problem "stop-arbiter.sh stopped the node at $(head -n1 "$STOPPED_MARKER" 2>/dev/null) ($STOPPED_MARKER); the watchdog does not self-heal until start-arbiter.sh runs"
fi

# After a reboot, say so: "the host came back, the arbiter did not".
up_min=""
if [ -n "$DOWN" ]; then
    up_min=$(host_uptime_minutes)
    if [ -n "$up_min" ] && [ "$up_min" -lt 180 ]; then
        boot_state=$(boot_service_state)
        add_problem "host booted ${up_min}m ago and the arbiter did not come back on its own (verdikta-arbiter.service: ${boot_state:-no systemd}; enable with $INSTALL_DIR/arbiter-boot-service.sh enable)"
    fi
fi

# A start already under way (verdikta-arbiter.service at boot, an operator, an
# upgrade) must not get a second start-arbiter.sh on top of it.
STARTING_PID=$(pgrep -f '[/ ]start-arbiter\.sh' 2>/dev/null | head -n1)
if [ -n "$DOWN" ] && [ -n "$STARTING_PID" ]; then
    add_problem "start-arbiter.sh is already running (pid $STARTING_PID): the components are being started"
fi

# Self-heal: components down -> start-arbiter.sh (idempotent: starts only what
# is missing, both containers included); 0-live with the container up -> restart
# the container. One action per cooldown, never during an operator stop, never
# on top of a start that is already running, and not in the first minutes
# after a boot (verdikta-arbiter.service gets to start the node first).
restart_note=""
if [ "$SELF_HEAL" = "1" ] && { [ -n "$DOWN" ] || [ "$ZERO_LIVE" = "1" ]; }; then
    if [ "$STOPPED_BY_OPERATOR" = "1" ]; then
        restart_note="self-heal: skipped, the node was stopped by stop-arbiter.sh (run $INSTALL_DIR/start-arbiter.sh to bring it back)"
    elif [ -n "$DOWN" ] && [ -n "$STARTING_PID" ]; then
        restart_note="self-heal: skipped, start-arbiter.sh (pid $STARTING_PID) is already starting the node"
    elif [ -n "$DOWN" ] && [ -n "${up_min:-}" ] && [ "$up_min" -lt "${WATCHDOG_BOOT_GRACE_MINUTES:-5}" ]; then
        restart_note="self-heal: waiting, host booted ${up_min}m ago (verdikta-arbiter.service gets ${WATCHDOG_BOOT_GRACE_MINUTES:-5}m to start the node)"
    elif [ "$(minutes_since_file "$LAST_RESTART_FILE")" -lt "$RESTART_COOLDOWN_MINUTES" ]; then
        restart_note="self-heal: skipped (last action <${RESTART_COOLDOWN_MINUTES}m ago)"
    elif [ -n "$DOWN" ]; then
        if [ -n "$INSTALL_DIR" ] && [ -x "$INSTALL_DIR/start-arbiter.sh" ]; then
            now_epoch > "$LAST_RESTART_FILE"
            restart_note="self-heal: running $INSTALL_DIR/start-arbiter.sh to bring up: $DOWN (output in $WATCHDOG_LOG)"
            log_line "$restart_note"
            if "$INSTALL_DIR/start-arbiter.sh" >> "$WATCHDOG_LOG" 2>&1; then
                log_line "self-heal: start-arbiter.sh finished"
            else
                restart_note="self-heal: start-arbiter.sh FAILED (exit $?); see $WATCHDOG_LOG"
                log_line "$restart_note"
            fi
        else
            restart_note="self-heal: cannot start the node, start-arbiter.sh not found under ${INSTALL_DIR:-<install dir not found>}"
        fi
    else
        now_epoch > "$LAST_RESTART_FILE"
        restart_note="self-heal: restarting chainlink container (docker restart --time=30)"
        log_line "$restart_note"
        docker restart chainlink --time=30 >/dev/null 2>&1 \
            || restart_note="self-heal: chainlink container restart FAILED"
    fi
fi

# Subject: say plainly which of the three it is.
subject="arbiter UNHEALTHY"
severity="warning"
if [ "$STOPPED_BY_OPERATOR" = "1" ]; then
    subject="arbiter STOPPED by operator (stop-arbiter.sh): $DOWN"
    severity="warning"
elif [ "$CONTAINER_DOWN" = "1" ]; then
    others="${DOWN//chainlink container, /}"; others="${others//, chainlink container/}"
    [ "$others" = "chainlink container" ] && others=""
    subject="chainlink container NOT RUNNING${others:+ (also down: $others)}"
    severity="critical"
elif [ -n "$DOWN" ]; then
    subject="arbiter components NOT RUNNING: $DOWN"
    severity="critical"
elif [ "$ZERO_LIVE" = "1" ]; then
    subject="chainlink node CANNOT BROADCAST (0 live RPC / broadcaster down)"
    severity="critical"
fi
body="$PROBLEMS"
[ -n "$restart_note" ] && body="$body  - $restart_note
"

# Webhook gets the current state on every unhealthy run (the receiving side
# dedupes); the paging channels below stay cooldown-limited.
post_status_webhook "ALERT" "$severity" "$subject" "$PROBLEMS" "$restart_note"

# Cooldown: alert immediately on a new problem set, re-alert only after cooldown.
# The uptime line changes every run, so it is left out of the fingerprint.
fingerprint=$(printf '%s' "$PROBLEMS" | grep -v '^  - host booted ' | cksum | cut -d' ' -f1)
last_fingerprint=$(sed -n '2p' "$LAST_ALERT_FILE" 2>/dev/null)
if [ "$fingerprint" != "$last_fingerprint" ] \
   || [ "$(minutes_since_file "$LAST_ALERT_FILE")" -ge "$ALERT_COOLDOWN_MINUTES" ]; then
    send_alert "$subject" "$body"
    printf '%s\n%s\n' "$(now_epoch)" "$fingerprint" > "$LAST_ALERT_FILE"
else
    log_line "unhealthy (alert suppressed by ${ALERT_COOLDOWN_MINUTES}m cooldown): $subject"
fi

# Always print problems (cron captures stdout; --quiet only silences the OK path)
echo "$subject"
printf '%s' "$body"
exit 1
