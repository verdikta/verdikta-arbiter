#!/bin/bash
# apply-chainlink-finality-tolerance.sh adds the July 2026 finality settings
# (NoNewFinalizedHeadsThreshold='0s' in [[EVM]], EnforceRepeatableRead=false in
# [EVM.NodePool]) to an existing config.toml that predates them: upgrades never
# rewrote the file on their own, and a host installed in May stayed at 0 live
# RPC nodes after upgrading (2026-11-09). It must touch nothing else, refuse
# layouts it would have to guess about, keep a backup and the file's mode,
# restart a running Chainlink and put the old file back if Chainlink does not
# come up on the new one.
# Runs the real script against a stub docker / curl / sleep.
# Run: bash installer/tests/chainlink-finality-tolerance.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
eq()    { if [ "$2" = "$3" ]; then ok; else bad "$1: expected [$3], got [$2]"; fi; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

T=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$T"' EXIT
B="$T/bin"; ST="$T/state"; CFG="$T/chainlink"
mkdir -p "$B" "$ST" "$CFG"
SCRIPT="$T/apply-chainlink-finality-tolerance.sh"
cp "$ROOT/installer/util/apply-chainlink-finality-tolerance.sh" "$SCRIPT"
mkdir -p "$T/installer/lib"
cp "$ROOT/installer/lib/chainlink-config.sh" "$T/installer/lib/"

# Stub docker: one container whose state lives in $FW_ST (running = true|false,
# status, restarts); every call is logged. With REJECT_NEW=1 a restart on a
# config that has the new settings "crashes" (the restart policy brings it back,
# so status is restarting and the restart count grows), as Chainlink does on a
# config it cannot load. `docker run ... validate` is Chainlink's validator:
# VALIDATE=reject refuses the file the way Chainlink does, VALIDATE=broken is
# docker itself failing.
cat > "$B/docker" <<'EOF'
#!/bin/bash
S="$FW_ST"; echo "$*" >> "$S/calls"
case "$1" in
  run)
    case "${VALIDATE:-ok}" in
      reject) echo 'Error running app: failed to decode config TOML: toml: strict mode: fields in the document are missing in the target struct'; exit 1 ;;
      broken) echo 'docker: Cannot connect to the Docker daemon.' >&2; exit 125 ;;
    esac
    exit 0 ;;
  inspect)
    [ "$2" = "--format" ] || exit 1
    [ -f "$S/exists" ] || exit 1
    case "$3" in
      *Mounts*)       echo "$FW_MOUNT" ;;
      *Config.Image*) echo smartcontract/chainlink:2.23.0 ;;
      *State.Status*) echo "$(cat "$S/status") $(cat "$S/restarts")" ;;
      *State.Running*) [ "$(cat "$S/status")" = running ] && echo true || echo false ;;
      *RestartCount*) cat "$S/restarts" ;;
    esac ;;
  restart|start)
    if [ "${REJECT_NEW:-0}" = 1 ] && grep -q '^EnforceRepeatableRead = false' "$FW_MOUNT/config.toml"; then
        echo restarting > "$S/status"; echo $(( $(cat "$S/restarts") + 1 )) > "$S/restarts"
    else
        echo running > "$S/status"
    fi ;;
esac
exit 0
EOF
printf '#!/bin/bash\n[ "${CURL_UP:-1}" = 1 ]\n' > "$B/curl"
printf '#!/bin/bash\nexit 0\n' > "$B/sleep"
chmod +x "$B/docker" "$B/curl" "$B/sleep"

# A config as setup-chainlink.sh wrote it in May 2025 (template b8b250f), mainnet.
MAY='[Log]
Level="warn"

[WebServer]
AllowOrigins="*"
SecureCookies=false

[WebServer.TLS]
HTTPSPort=0

[[EVM]]
ChainID=8453
Enabled=true
FinalityDepth=5
MinContractPayment=0

[EVM.GasEstimator]
Mode = "FeeHistory"
TipCapDefault = "1 gwei"
TipCapMin     = "30000000"       # 0.03 gwei
FeeCapDefault = "20 gwei"
# EstimateLimit = true

[EVM.HeadTracker]
SamplingInterval = "30s"            # coalesce heads
HistoryDepth = 25

[EVM.NodePool]
PollInterval   = "80s"
NewHeadsPollInterval = "30s"
SyncThreshold = 10


[EVM.Transactions]
ReaperInterval = "30m"              # Less frequent cleanup
ReaperThreshold = "168h"            # Keep txns longer before cleanup

[[EVM.Nodes]]
Name="Base-Mainnet"
WSURL="wss://base-mainnet.infura.io/ws/v3/KEY"
HTTPURL="https://base-mainnet.infura.io/v3/KEY"
'

# state: exists + status (running|exited); resets the call log and restart count.
container() { : > "$ST/exists"; echo "$1" > "$ST/status"; echo 0 > "$ST/restarts"; : > "$ST/calls"; }
no_container() { rm -f "$ST/exists"; : > "$ST/calls"; }
put() { printf '%s' "$1" > "$CFG/config.toml"; rm -f "$CFG"/config.toml.backup.*; }
: > "$CFG/secrets.toml"   # the validator needs it; without it validation is skipped
leftovers() { ls -a "$CFG" | grep -c '^\.config\.toml\.candidate' | tr -d ' '; }
run() { env PATH="$B:$PATH" FW_ST="$ST" FW_MOUNT="$CFG" VERDIKTA_CHAINLINK_WAIT_SECS=10 "$@" bash "$SCRIPT" ${ARGS[@]+"${ARGS[@]}"} 2>&1; echo "rc=$?"; }
backups() { ls "$CFG"/config.toml.backup.* 2>/dev/null | wc -l | tr -d ' '; }
# toml_check FILE -> "threshold|EnforceRepeatableRead" read by a real TOML parser, when this Python has one.
toml_check() {
    python3 - "$1" <<'PY' 2>/dev/null
import sys
try:
    import tomllib
except ImportError:
    print("no-tomllib"); sys.exit(0)
d = tomllib.load(open(sys.argv[1], "rb"))
e = d["EVM"][0]
print(f'{e.get("NoNewFinalizedHeadsThreshold")}|{e.get("NodePool", {}).get("EnforceRepeatableRead")}|{len(e.get("Nodes", []))}')
PY
}

# 1. The May 2025 config, Chainlink stopped: --check says 1; --apply adds both, nothing else.
container exited; put "$MAY"; chmod 640 "$CFG/config.toml"
ARGS=(--check); out=$(run)
has "may check: rc 1"            "$out" "rc=1"
has "may check: threshold"       "$out" "NoNewFinalizedHeadsThreshold = not set"
has "may check: repeatable read" "$out" "EnforceRepeatableRead = not set"
eq  "may check: no backup"       "$(backups)" "0"
ARGS=(--apply); out=$(run)
has   "may apply: rc 0"          "$out" "rc=0"
has   "may apply: added thr"     "$out" "NoNewFinalizedHeadsThreshold: added '0s'"
has   "may apply: added err"     "$out" "EnforceRepeatableRead: added false"
has   "may apply: stopped note"  "$out" "Chainlink is not running; the new config takes effect when it next starts"
has   "may apply: validated"     "$(cat "$ST/calls")" "^run --rm --network none .* node -config /chainlink/.config.toml.candidate.[0-9]* -secrets /chainlink/secrets.toml validate"
eq    "may apply: no candidate left" "$(leftovers)" "0"
hasnt "may apply: no restart"    "$(cat "$ST/calls")" "restart"
eq    "may apply: one backup"    "$(backups)" "1"
eq    "may apply: backup is the old file" "$(cat "$CFG"/config.toml.backup.*)" "$(printf '%s' "$MAY")"
d=$(diff "$CFG"/config.toml.backup.* "$CFG/config.toml")
hasnt "may apply: no line removed or changed" "$d" "^<"
eq    "may apply: six lines added" "$(echo "$d" | grep -c '^>')" "6"
eq    "may apply: mode kept"     "$(ls -l "$CFG/config.toml" | cut -c1-10)" "-rw-r-----"
r=$(toml_check "$CFG/config.toml")
[ "$r" = "no-tomllib" ] || eq "may apply: TOML parser reads both in the right tables" "$r" "0s|False|1"
ARGS=(--check); out=$(run)
has "may apply: check passes after" "$out" "rc=0"
# Idempotent: a second --apply changes nothing and makes no backup.
ARGS=(--apply); out=$(run)
has   "second apply: rc 0"       "$out" "rc=0"
has   "second apply: in place"   "$out" "Both finality settings are in place"
eq    "second apply: still one backup" "$(backups)" "1"

# 2. The current template rendered: already right, nothing to do.
sed -e 's/<CHAIN_ID>/8453/' -e 's/<TIP_CAP_DEFAULT>/1 gwei/' -e 's/<FEE_CAP_DEFAULT>/20 gwei/' \
    -e 's|<EVM_NODES_BLOCK>|[[EVM.Nodes]]\nName="Base-Mainnet-1"\nWSURL="wss://x"\nHTTPURL="https://x"|' \
    "$ROOT/chainlink-node/config_template.toml" > "$T/current.toml"
container running; put "$(cat "$T/current.toml")"
ARGS=(--check); out=$(run)
has   "template: check 0"        "$out" "rc=0"
ARGS=(--apply); out=$(run)
has   "template: apply 0"        "$out" "rc=0"
eq    "template: no backup"      "$(backups)" "0"
hasnt "template: no restart"     "$(cat "$ST/calls")" "restart"

# 3. Wrong values (someone set them back), Chainlink running: corrected in place, restarted once.
WRONG="$(printf '%s' "$MAY" | sed -e "s/^MinContractPayment=0$/MinContractPayment=0\nNoNewFinalizedHeadsThreshold = '15m'   # chain default/" \
                                 -e 's/^SyncThreshold = 10$/SyncThreshold = 10\nEnforceRepeatableRead = true/')"
container running; put "$WRONG"
ARGS=(--apply); out=$(run)
has "wrong: rc 0"                "$out" "rc=0"
has "wrong: thr corrected"       "$out" "NoNewFinalizedHeadsThreshold: '15m' -> '0s'"
has "wrong: err corrected"       "$out" "EnforceRepeatableRead: true -> false"
has "wrong: answering"           "$out" "Chainlink is answering on the new config"
eq  "wrong: one restart"         "$(grep -c '^restart' "$ST/calls")" "1"
eq  "wrong: no duplicate keys"   "$(grep -c 'NoNewFinalizedHeadsThreshold' "$CFG/config.toml")" "1"
eq  "wrong: no duplicate err"    "$(grep -c 'EnforceRepeatableRead' "$CFG/config.toml")" "1"
eq  "wrong: only those two lines differ" "$(diff "$CFG"/config.toml.backup.* "$CFG/config.toml" | grep -c '^[<>]')" "4"

# 4. Chainlink does not come up on the new file: the old file is put back and started again.
container running; put "$MAY"
ARGS=(--apply); out=$(REJECT_NEW=1 run)
has "rejected: rc 1"             "$out" "rc=1"
has "rejected: says so"          "$out" "Restoring the previous config"
eq  "rejected: old file back"    "$(cat "$CFG/config.toml")" "$(printf '%s' "$MAY")"
eq  "rejected: running again"    "$(cat "$ST/status")" "running"
# Chainlink's validator refuses the edited file: nothing written, no restart.
container running; put "$MAY"
ARGS=(--apply); out=$(VALIDATE=reject run)
has   "validator rejects: rc 1"      "$out" "rc=1"
has   "validator rejects: reason"    "$out" "Error running app: failed to decode config TOML"
has   "validator rejects: unchanged" "$out" "was not changed"
eq    "validator rejects: file"      "$(cat "$CFG/config.toml")" "$(printf '%s' "$MAY")"
eq    "validator rejects: no backup" "$(backups)" "0"
eq    "validator rejects: no candidate left" "$(leftovers)" "0"
hasnt "validator rejects: no restart" "$(cat "$ST/calls")" "^restart"
# Docker cannot run the validator: written after the structural checks, with a note.
container exited; put "$MAY"
ARGS=(--apply); out=$(VALIDATE=broken run)
has   "validator broken: rc 0"   "$out" "rc=0"
has   "validator broken: note"   "$out" "Could not ask Chainlink to validate"
eq    "validator broken: backup" "$(backups)" "1"
# A running node whose API never answers in time is left running (migrations), not rolled back.
container running; put "$MAY"
ARGS=(--apply); out=$(CURL_UP=0 run)
has   "slow api: rc 0"           "$out" "rc=0"
has   "slow api: warns"          "$out" "API is not answering yet"
hasnt "slow api: kept new file"  "$out" "Restoring"

# 5. No [EVM.NodePool] and no newline at the end of the file: the table is added after [[EVM]]'s keys.
NOPOOL='[[EVM]]
ChainID=84532
Enabled=true

[[EVM.Nodes]]
Name="Base-Sepolia"
WSURL="wss://x"
HTTPURL="https://x"'
container exited; put "$NOPOOL"
ARGS=(--apply); out=$(run)
has "no pool: rc 0"              "$out" "rc=0"
has "no pool: new table"         "$out" "new \[EVM.NodePool\] table"
r=$(toml_check "$CFG/config.toml")
[ "$r" = "no-tomllib" ] || eq "no pool: TOML parser" "$r" "0s|False|1"
put 'Level="warn"
[[EVM]]
ChainID=84532
Enabled=true'
ARGS=(--apply); out=$(run)
has "no trailing newline: rc 0"  "$out" "rc=0"
has "no trailing newline: Enabled kept on its own line" "$(cat "$CFG/config.toml")" "^Enabled=true$"

# 6. Layouts it will not guess about: exit 2, file untouched, no backup.
for bad_cfg in \
    "two EVM tables|$(printf '%s' "$MAY")
[[EVM]]
ChainID=84532" \
    "dotted NodePool keys|[[EVM]]
ChainID=8453
NodePool.EnforceRepeatableRead = true" \
    "NodePool before EVM|[EVM.NodePool]
SyncThreshold = 10
[[EVM]]
ChainID=8453" \
    "setting twice|[[EVM]]
ChainID=8453
NoNewFinalizedHeadsThreshold = '15m'
NoNewFinalizedHeadsThreshold = '1m'"; do
    label="${bad_cfg%%|*}"; content="${bad_cfg#*|}"
    container running; put "$content"
    ARGS=(--apply); out=$(run)
    has   "$label: rc 2"         "$out" "rc=2"
    has   "$label: says why"     "$out" "cannot edit"
    eq    "$label: untouched"    "$(cat "$CFG/config.toml")" "$content"
    eq    "$label: no backup"    "$(backups)" "0"
    hasnt "$label: no restart"   "$(cat "$ST/calls")" "restart"
done
# Not UTF-8: "cannot check" (2), never "missing" (1).
container exited; printf '[[EVM]]\nChainID=\xff\xfe\n' > "$CFG/config.toml"
ARGS=(--check); out=$(run)
has "binary: rc 2"               "$out" "rc=2"
has "binary: cannot read"        "$out" "cannot read"

# 7. A zero threshold written another way is accepted as is.
container exited; put '[[EVM]]
ChainID=8453
NoNewFinalizedHeadsThreshold = "0"
[EVM.NodePool]
EnforceRepeatableRead = false'
ARGS=(--check); out=$(run)
has "zero variant: rc 0"         "$out" "rc=0"

# 8. Which file: the container's /chainlink mount; without a container,
#    ~/.chainlink-<NETWORK_TYPE> from the installer .env next to the script; else 2.
no_container
mkdir -p "$T/home/.chainlink-mainnet" "$T/installer"
printf '%s' "$MAY" > "$T/home/.chainlink-mainnet/config.toml"
echo 'NETWORK_TYPE="mainnet"' > "$T/installer/.env"
ARGS=(--check); out=$(HOME="$T/home" run)
has "env fallback: found"        "$out" "$T/home/.chainlink-mainnet/config.toml"
has "env fallback: rc 1"         "$out" "rc=1"
rm "$T/installer/.env"
ARGS=(--check); out=$(HOME="$T/home" run)
has "nothing found: rc 2"        "$out" "rc=2"
has "nothing found: says so"     "$out" "No Chainlink config.toml found"
ARGS=(--check --config "$T/home/.chainlink-mainnet/config.toml"); out=$(run)
has "--config: rc 1"             "$out" "rc=1"
ARGS=(--config); out=$(run)
has "--config without path: 64"  "$out" "rc=64"

# 9. Interactive: anything but y changes nothing.
container exited; put "$MAY"
ARGS=(); out=$(echo n | run)
has "interactive n: rc 1"        "$out" "rc=1"
eq  "interactive n: no backup"   "$(backups)" "0"
ARGS=(); out=$(echo y | run)
has "interactive y: rc 0"        "$out" "rc=0"
eq  "interactive y: backup"      "$(backups)" "1"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
