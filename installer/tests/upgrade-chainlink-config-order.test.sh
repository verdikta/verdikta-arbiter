#!/bin/bash
# The upgrade's Chainlink config steps before the restart, which all write the same
# config.toml: the job timeouts' MaxRunDuration (apply-job-timeouts.sh --config, 840 s
# limits, design §11), the template regeneration (regenerate-chainlink-config.sh, default
# yes) and the finality step (apply-chainlink-finality-tolerance.sh, default yes). The
# regeneration and the finality step restart a Chainlink that runs, and restore their
# backup when it does not come up; start-arbiter.sh does not restart a Chainlink that runs.
#
# This runs the script's REAL blocks in the order the script has them, under `set -e` and
# the REAL ERR trap, with the REAL three tools on a config.toml from before July 2026 and a
# stub docker, then a modelled arbiter start, the REAL after-restart job-timeouts block
# (with a stub that measures the config the node last started on) and the REAL last lines.
# Every answer to the regeneration and the finality questions, job timeouts answered yes:
#   - Chainlink stopped (the upgrade stops it first): config.toml ends with
#     [JobPipeline] MaxRunDuration of at least 15m, and the jobs are still measured and
#     replaced after the restart, with no failure line;
#   - Chainlink running: every restart those steps make reads a file that already has the
#     key, so the node runs it; when nothing restarts it, the run says so (exit 3), never
#     silently.
# Run: bash installer/tests/upgrade-chainlink-config-order.test.sh
# UPGRADE_ARBITER_SH=<path> runs it against another copy of the script.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(dirname "$ROOT")"
S="${UPGRADE_ARBITER_SH:-$ROOT/bin/upgrade-arbiter.sh}"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

# ── The blocks, in the script's order ────────────────────────────────────────
JT='^# Job timeouts, before the restart'
RG='^# Chainlink config from the template\. Every setting checked in to'
FN='^# Finality tolerance \(July 2026 incident, P0-A\)'
END='^# P2-A \(July 2026 incident\): docker log options'
line_of() { grep -nE "$1" "$S" | head -1 | cut -d: -f1; }
jt=$(line_of "$JT"); rg=$(line_of "$RG"); fn=$(line_of "$FN"); end=$(line_of "$END")
restart=$(grep -n 'Do you want to restart the arbiter now' "$S" | head -1 | cut -d: -f1)
for v in jt rg fn end restart; do [ -n "${!v}" ] && ok || bad "marker $v not found in $S"; done
# All three before the restart, and the stretch from the first to the last is only them.
{ [ "${jt:-0}" -lt "${restart:-0}" ] && [ "${rg:-0}" -lt "${restart:-0}" ] && [ "${fn:-0}" -lt "${restart:-0}" ]; } \
    && ok || bad "a config step is not before the restart (job timeouts ${jt:-?}, template ${rg:-?}, finality ${fn:-?}, restart ${restart:-?})"
# Each block runs from its marker to the next one; the last ends at the P2-A block.
pre=$(printf '%s %s\n%s %s\n%s %s\n%s %s\n' "${jt:-0}" jt "${rg:-0}" rg "${fn:-0}" fn "${end:-0}" end | sort -n | \
    awk -v s="$S" 'NR>1{print prev "," $1-1} {prev=$1}' | while IFS=, read -r a b; do sed -n "${a},${b}p" "$S"; done)
order=$(printf '%s jobtimeouts\n%s regeneration\n%s finality\n' "${jt:-0}" "${rg:-0}" "${fn:-0}" | sort -n | awk '{printf "%s ", $2}')
echo "order in $(basename "$S"): $order"
after=$(awk '/^# Job timeouts, after the restart/{p=1} /^# Post-upgrade health check\. Best-effort/{p=0} p{print}' "$S")
lastlines=$(awk '/^# Job timeouts that were asked for and did not land/{p=1} p{print}' "$S")
trapfn=$(awk '/^cleanup_on_error\(\) \{$/{p=1} p{print} p&&/^}$/{exit}' "$S")
[ -n "$pre" ] && ok || bad "could not extract the config blocks"
[ -n "$after" ] && ok || bad "could not extract the after-restart block"
[ -n "$lastlines" ] && ok || bad "could not extract the last lines"
[ -n "$trapfn" ] && ok || bad "could not extract cleanup_on_error"
printf '%s\n' "$pre" | bash -n && ok || bad "the config blocks are not a complete shell fragment"
echo "$pre" | grep -q '^check_chainlink_config || CHAINLINK_CONFIG_RC=\$?$' && ok || bad "the template block's call is not in the extracted blocks"
echo "$pre" | grep -q 'apply-chainlink-finality-tolerance.sh" --apply' && ok || bad "the finality block is not in the extracted blocks"
echo "$pre" | grep -q 'apply-job-timeouts.sh" --config "' && ok || bad "the job-timeouts block is not in the extracted blocks"

# ── A checkout (the three real tools and the template) and an install ───────
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
SRC="$T/src"; I="$T/install"; H="$T/home"; CFG="$H/.chainlink-testnet/config.toml"
mkdir -p "$SRC/installer/util" "$SRC/installer/lib" "$SRC/chainlink-node" "$I/installer" "$H/.chainlink-testnet" "$T/bin"
for f in apply-job-timeouts.sh regenerate-chainlink-config.sh apply-chainlink-finality-tolerance.sh; do
    cp "$ROOT/util/$f" "$SRC/installer/util/$f"
done
cp "$ROOT/lib/chainlink-config.sh" "$SRC/installer/lib/"
cp "$REPO/chainlink-node/config_template.toml" "$SRC/chainlink-node/"
printf 'NETWORK_TYPE="testnet"\n' > "$SRC/installer/.env"
printf 'NETWORK_TYPE="testnet"\nDEPLOYMENT_NETWORK="base_sepolia"\nNETWORK_NAME="Base Sepolia"\n' > "$I/installer/.env"

# A config.toml as installs wrote it before July 2026: no finality settings, no
# MaxRunDuration (Chainlink's 10 m), the older RPC settings.
old_config() {
    cat > "$CFG" <<'EOF'
[Log]
Level="warn"

[WebServer]
AllowOrigins="*"
SecureCookies=false

[WebServer.TLS]
HTTPSPort=0

[[EVM]]
ChainID=84532
Enabled=true
MinContractPayment="0"

[EVM.GasEstimator]
Mode = "FeeHistory"
TipCapDefault = "2 gwei"
TipCapMin     = "30000000"
FeeCapDefault = "30 gwei"

[EVM.HeadTracker]
SamplingInterval = "20s"
HistoryDepth = 25

[EVM.NodePool]
PollInterval   = "80s"
NewHeadsPollInterval = "8s"
SyncThreshold = 10

[EVM.Transactions]
ReaperInterval = "30m"
ReaperThreshold = "168h"
MaxInFlight = 32
MaxQueued = 64

[[EVM.Nodes]]
Name="Base Sepolia-1"
WSURL="wss://rpc.example.test/ws"
HTTPURL="https://rpc.example.test/http"

[JobPipeline.HTTPRequest]
DefaultTimeout = "300s"

[EVM.BalanceMonitor]
Enabled = false
EOF
    cp "$CFG" "$T/effective.toml"     # what a running Chainlink started on
}

# docker: the chainlink container, stopped or running ($T/cl-state); no image to validate
# with (cl_validate then writes after the structural checks). A restart is what the node
# reads: it takes the file as it is at that moment. The tools send docker's stdout to
# /dev/null, so restarts are logged to a file.
cat > "$T/bin/docker" <<'STUB'
#!/bin/bash
state=$(cat "$CL_STATE" 2>/dev/null || echo stopped)
case "$1" in
  inspect)
    case "$3" in
      *'.State.Running'*) [ "$state" = running ] && echo true || echo false ;;
      *'.State.Status'*)  echo "$state 0" ;;
      *'.RestartCount'*)  echo 0 ;;
      *) : ;;           # no /chainlink mount, no image
    esac ;;
  restart)
    grep -q '^MaxRunDuration = "15m"' "$CFG" && key=yes || key=no
    echo "CHAINLINK-RESTARTED key=$key" >> "$RESTARTS"
    cp "$CFG" "$EFFECTIVE" ;;
  start) echo running > "$CL_STATE"; cp "$CFG" "$EFFECTIVE" ;;
  *) exit 1 ;;
esac
STUB
printf '#!/bin/bash\nexit 0\n' > "$T/bin/curl"
chmod +x "$T/bin/docker" "$T/bin/curl"

# The install's apply-job-timeouts.sh after the restart: the jobs are stale until --apply
# replaces them, and the node runs the config it last started on (measured with the real
# tool's --config-check, the same rule as its --check).
cat > "$I/apply-job-timeouts.sh" <<STUB
#!/bin/bash
case "\$1" in
  --check)
    echo "JOBS-MEASURED"
    node_ok=0; bash "$SRC/installer/util/apply-job-timeouts.sh" --config-check "\$EFFECTIVE" >/dev/null || node_ok=1
    [ -f "\$APPLIED" ] || exit 1
    exit "\$node_ok" ;;
  --apply) echo "JOBS-REPLACED"; touch "\$APPLIED"; exit 0 ;;
  *) echo "STUB: unexpected \$*" >&2; exit 99 ;;
esac
STUB
chmod +x "$I/apply-job-timeouts.sh"

# run REGEN FINALITY CHAINLINK(stopped|running)
run() {
    old_config
    rm -f "$T/applied" "$T/restarts"
    echo "$3" > "$T/cl-state"
    PATH="$T/bin:$PATH" HOME="$H" NETWORK_TYPE=testnet TARGET_DIR="$I" UTIL_DIR="$SRC/installer/util" \
    CFG="$CFG" EFFECTIVE="$T/effective.toml" CL_STATE="$T/cl-state" APPLIED="$T/applied" RESTARTS="$T/restarts" \
    VERDIKTA_UNATTENDED=1 VA_UPGRADE_JOB_TIMEOUTS=y \
    VA_UPGRADE_REGENERATE_CHAINLINK_CONFIG="$1" VA_UPGRADE_CHAINLINK_FINALITY="$2" \
    VERDIKTA_CHAINLINK_WAIT_SECS=4 VERDIKTA_JOB_CHECK_WAIT=1 \
    UPGRADE_IN_PROGRESS=1 BACKUP_DIR="" ARBITER_WAS_RUNNING=0 RECONF_FAILED=0 RECONF_SUMMARY="" \
    PRE="$pre" AFTER="$after" LAST="$lastlines" TRAPFN="$trapfn" ROOT="$ROOT" \
    bash -c '
        set -e
        eval "$TRAPFN"
        trap "echo TRAP-FIRED; cleanup_on_error" ERR
        source "$ROOT/lib/prompts.sh"
        GREEN= YELLOW= RED= BLUE= NC=
        eval "$PRE"
        echo "CONFIG-STEPS-DONE"
        # start-arbiter.sh: starts a stopped Chainlink, leaves a running one as it is.
        [ "$(cat "$CL_STATE")" = running ] || docker start chainlink
        SERVICES_STARTED_FOR_DOCTOR=1
        eval "$AFTER"
        echo "AFTER-DONE"
        eval "$LAST"
        echo "REACHED-END"
    ' 2>&1
    echo "rc=$?"
    cat "$T/restarts" 2>/dev/null
}

config_ok() { bash "$SRC/installer/util/apply-job-timeouts.sh" --config-check "$1" >/dev/null; }

for regen in y n; do
    for finality in y n; do
        c="regen=$regen finality=$finality"
        # ── Chainlink stopped, as the upgrade leaves it ──────────────────────
        out=$(run "$regen" "$finality" stopped)
        has   "$c: steps ran"            "$out" "CONFIG-STEPS-DONE"
        hasnt "$c: trap"                 "$out" "TRAP-FIRED"
        config_ok "$CFG" && ok || bad "$c: config.toml ends below 15m: $(grep -n 'MaxRunDuration' "$CFG")"
        [ "$(grep -c '^\[JobPipeline\]$' "$CFG")" = "1" ] && ok || bad "$c: [JobPipeline] is not in config.toml once"
        [ "$(grep -c '^MaxRunDuration' "$CFG")" = "1" ] && ok || bad "$c: MaxRunDuration is not in config.toml once"
        config_ok "$T/effective.toml" && ok || bad "$c: the node started on a file below 15m"
        has   "$c: jobs measured after the restart" "$out" "JOBS-MEASURED"
        has   "$c: stale jobs replaced"  "$out" "JOBS-REPLACED"
        hasnt "$c: no failure line"      "$out" "JOB TIMEOUTS FAILED"
        has   "$c: end"                  "$out" "REACHED-END"
        has   "$c: exit 0"               "$out" "rc=0"
        hasnt "$c: nothing restarted a stopped Chainlink" "$out" "CHAINLINK-RESTARTED"
        # The answers were honoured: the template's own settings only on a yes, the
        # finality settings on either yes.
        if [ "$regen" = y ]; then
            grep -q '^FinalityDepth = 10' "$CFG" && ok || bad "$c: the template was not applied"
        else
            grep -q 'FinalityDepth' "$CFG" && bad "$c: the template was applied on a no" || ok
        fi
        if [ "$regen" = y ] || [ "$finality" = y ]; then
            grep -q "^NoNewFinalizedHeadsThreshold = '0s'" "$CFG" && ok || bad "$c: no finality settings"
        else
            grep -q 'NoNewFinalizedHeadsThreshold' "$CFG" && bad "$c: finality settings on two noes" || ok
        fi

        # ── Chainlink running at that point ──────────────────────────────────
        out=$(run "$regen" "$finality" running)
        hasnt "$c, running: trap"        "$out" "TRAP-FIRED"
        config_ok "$CFG" && ok || bad "$c, running: config.toml ends below 15m"
        hasnt "$c, running: a restart read a file without the key" "$out" "CHAINLINK-RESTARTED key=no"
        has   "$c, running: jobs measured after the restart" "$out" "JOBS-MEASURED"
        if echo "$out" | grep -q "CHAINLINK-RESTARTED"; then
            config_ok "$T/effective.toml" && ok || bad "$c, running: the node runs below 15m after a restart"
            hasnt "$c, running: no failure line" "$out" "JOB TIMEOUTS FAILED"
            has   "$c, running: exit 0"          "$out" "rc=0"
        else
            # Nothing restarted it: the node still runs the old file, and the run says so.
            has   "$c, running, no restart: reported" "$out" "JOB TIMEOUTS FAILED:"
            has   "$c, running, no restart: exit 3"   "$out" "rc=3"
        fi
    done
done

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
