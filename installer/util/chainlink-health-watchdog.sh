#!/bin/bash
#
# Verdikta Arbiter - Chainlink Health Watchdog (P1-B, July 2026 incident)
#
# The July 2026 commit-stage outage was silent for hours: the Chainlink node's
# RPC pool dropped to 0 live nodes ("No live RPC nodes available") and the
# TxManager could not broadcast commit transactions, while every service
# looked "up" from the outside. This watchdog is designed to run from cron
# every few minutes and page the operator within minutes of that condition.
#
# What it checks:
#   1. chainlink container is running
#   2. http://localhost:6688/health — every EVM.* / core check is "passing"
#   3. recent container log lines matching "No live RPC nodes available"
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
#     on-chain, so no shared secret is needed. WATCHDOG_ALERT_TOKEN
#     (X-Watchdog-Token header) remains as an optional fallback for nodes
#     that cannot sign. All can be set in the env or <install>/installer/.env
#
# Self-heal (stopgap, per incident report P1-B: restart is acceptable but
# must alert, never silently restart):
#   --self-heal           restart the chainlink container when the 0-live
#                         condition is detected; the alert always fires first
#                         and records the restart. Rate-limited to one restart
#                         per WATCHDOG_RESTART_COOLDOWN_MINUTES (default 30).
#
# Usage:
#   chainlink-health-watchdog.sh                 # one check pass, human output
#   chainlink-health-watchdog.sh --quiet         # cron mode: output only on problems
#   chainlink-health-watchdog.sh --self-heal     # also restart on 0-live condition
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

usage() {
    sed -n '2,40p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'
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
    _env_token=$(grep -E '^WATCHDOG_ALERT_TOKEN=' "$INSTALL_DIR/installer/.env" | tail -1 | cut -d= -f2- | tr -d '"')
    WATCHDOG_ALERT_WEBHOOK="${WATCHDOG_ALERT_WEBHOOK:-$_env_webhook}"
    WATCHDOG_ALERT_COMMAND="${WATCHDOG_ALERT_COMMAND:-$_env_command}"
    WATCHDOG_ALERT_TOKEN="${WATCHDOG_ALERT_TOKEN:-$_env_token}"
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

############################################
# Helpers
############################################
now_epoch() { date +%s; }

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
# Authentication: the event is signed with the operator owner key when
# available (the server verifies the signer matches owner() on-chain, so no
# shared token is needed). WATCHDOG_ALERT_TOKEN is still sent if configured,
# as a fallback for nodes that cannot sign.
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
            log_line "webhook signing unavailable (missing key/node/ethers) — sending unsigned"
        fi
    fi

    local payload
    payload=$(WD_STATUS="$1" WD_SEVERITY="$2" WD_SUBJECT="$3" WD_PROBLEMS="$4" WD_SELFHEAL="${5:-}" \
              WD_OPERATOR="$WD_OPERATOR" WD_NETWORK="$WD_NETWORK" WD_TS="$wd_ts" \
              WD_SIGNER="$wd_signer" WD_SIG="$wd_sig" python3 - << 'PY'
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
if os.environ.get("WD_SIGNER") and os.environ.get("WD_SIG"):
    event["signer"] = os.environ["WD_SIGNER"]
    event["sig"] = os.environ["WD_SIG"]
print(json.dumps(event))
PY
) || { log_line "webhook payload build FAILED"; return 1; }

    local -a hdr=(-H 'Content-Type: application/json')
    [ -n "$WATCHDOG_ALERT_TOKEN" ] && hdr+=(-H "X-Watchdog-Token: $WATCHDOG_ALERT_TOKEN")
    curl -fsS --max-time 10 -X POST "${hdr[@]}" \
        --data-binary "$payload" "$WATCHDOG_ALERT_WEBHOOK" >/dev/null 2>&1 \
        || log_line "webhook delivery FAILED ($WATCHDOG_ALERT_WEBHOOK)"
}

############################################
# Checks
############################################
PROBLEMS=""
ZERO_LIVE=0

add_problem() {
    PROBLEMS="${PROBLEMS}  - $1
"
}

# 1. Container running?
container_running=$(docker inspect --format '{{.State.Running}}' chainlink 2>/dev/null)
if [ "$container_running" != "true" ]; then
    add_problem "chainlink container is not running"
    ZERO_LIVE=1   # cannot broadcast anything either way
else
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
        send_alert "RECOVERED: chainlink node healthy again" "All health checks passing."
        post_status_webhook "RECOVERED" "info" "chainlink node healthy again" ""
        rm -f "$LAST_ALERT_FILE"
    else
        # Heartbeat: lets the receiving side flag arbiters that stop reporting.
        post_status_webhook "OK" "info" "healthy" ""
    fi
    echo "healthy" > "$LAST_STATE_FILE"
    say "OK: chainlink container running, all health checks passing, no recent 0-live RPC events."
    exit 0
fi

echo "unhealthy" > "$LAST_STATE_FILE"

restart_note=""
if [ "$SELF_HEAL" = "1" ] && [ "$ZERO_LIVE" = "1" ]; then
    if [ "$(minutes_since_file "$LAST_RESTART_FILE")" -ge "$RESTART_COOLDOWN_MINUTES" ]; then
        now_epoch > "$LAST_RESTART_FILE"
        restart_note="self-heal: restarting chainlink container (docker restart --time=30)"
        log_line "$restart_note"
        docker restart chainlink --time=30 >/dev/null 2>&1 \
            || restart_note="self-heal: chainlink container restart FAILED"
    else
        restart_note="self-heal: restart skipped (last restart <${RESTART_COOLDOWN_MINUTES}m ago)"
    fi
fi

subject="chainlink node UNHEALTHY"
severity="warning"
[ "$ZERO_LIVE" = "1" ] && { subject="chainlink node CANNOT BROADCAST (0 live RPC / broadcaster down)"; severity="critical"; }
body="$PROBLEMS"
[ -n "$restart_note" ] && body="$body  - $restart_note
"

# Webhook gets the current state on every unhealthy run (the receiving side
# dedupes); the paging channels below stay cooldown-limited.
post_status_webhook "ALERT" "$severity" "$subject" "$PROBLEMS" "$restart_note"

# Cooldown: alert immediately on a new problem set, re-alert only after cooldown.
fingerprint=$(printf '%s' "$PROBLEMS" | cksum | cut -d' ' -f1)
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
