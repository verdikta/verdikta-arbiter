#!/bin/bash
# regenerate-chainlink-config.sh applies chainlink-node/config_template.toml to
# a node's config.toml: every checked-in setting is meant to reach every node
# (2026-11-09: a node whose config was never regenerated missed the July 2026
# finality fix and sat at 0 live RPC nodes). It must keep what is the node's
# own -- RPC endpoints, ChainID, gas caps (the scripts disagree on the mainnet
# fee cap), settings the template does not mention (the canaries carried
# [JobPipeline] MaxRunDuration from a branch) -- list the changes setting by
# setting with URLs cut to their host (an agent shows that list to the owner),
# refuse layouts it would have to guess about, have Chainlink validate the new
# file before writing it, keep a backup and roll back if Chainlink does not
# come up on it.
# Runs the real script (repository layout) against a stub docker / curl / sleep.
# Run: bash installer/tests/regenerate-chainlink-config.test.sh
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
B="$T/bin"; ST="$T/state"; CFG="$T/chainlink"; R="$T/repo"; I="$T/install"
mkdir -p "$B" "$ST" "$CFG" "$R/installer/util" "$R/installer/lib" "$R/chainlink-node" "$I/installer"
cp "$ROOT/installer/util/regenerate-chainlink-config.sh" "$R/installer/util/"
cp "$ROOT/installer/lib/chainlink-config.sh" "$R/installer/lib/"
cp "$ROOT/chainlink-node/config_template.toml" "$R/chainlink-node/"
SCRIPT="$R/installer/util/regenerate-chainlink-config.sh"
cat > "$I/installer/.env" <<'EOF'
DEPLOYMENT_NETWORK="base_mainnet"
NETWORK_TYPE="mainnet"
NETWORK_NAME="Base-Mainnet"
BASE_MAINNET_RPC_HTTP_URLS="https://rpc-a.example/v3/SECRETA;https://rpc-b.example/SECRETB;https://rpc-c.example/key/SECRETC"
BASE_MAINNET_RPC_WS_URLS="wss://rpc-a.example/ws/v3/SECRETA;wss://rpc-b.example/SECRETB;wss://rpc-c.example/key/SECRETC"
EOF

# Stub docker: one container (state in $FW_ST). `run ... validate` is Chainlink's
# validator (VALIDATE=reject refuses like Chainlink). REJECT_NEW=1: a restart on a
# config with the template's settings "crashes" (restart count grows).
cat > "$B/docker" <<'EOF'
#!/bin/bash
S="$FW_ST"; echo "$*" >> "$S/calls"
case "$1" in
  run)
    [ "${VALIDATE:-ok}" = reject ] && { echo 'Error running app: failed to decode config TOML: strict mode: fields in the document are missing in the target struct'; exit 1; }
    exit 0 ;;
  inspect)
    [ "$2" = "--format" ] || exit 1
    [ -f "$S/exists" ] || exit 1
    case "$3" in
      *Mounts*)        echo "$FW_MOUNT" ;;
      *Config.Image*)  echo smartcontract/chainlink:2.23.0 ;;
      *State.Status*)  echo "$(cat "$S/status") $(cat "$S/restarts")" ;;
      *State.Running*) [ "$(cat "$S/status")" = running ] && echo true || echo false ;;
      *RestartCount*)  cat "$S/restarts" ;;
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
printf '#!/bin/bash\nexit 0\n' > "$B/curl"
printf '#!/bin/bash\nexit 0\n' > "$B/sleep"
chmod +x "$B/docker" "$B/curl" "$B/sleep"

# A May 2025 mainnet config (template b8b250f) as a node really has it: fee cap 10
# gwei (setup-chainlink.sh's value), two RPCs with keys in their URLs, and two
# settings of the node's own that no template sets: one in a table the template
# has ([EVM.NodePool] PollFailureThreshold), one in a table it lacks ([Feature]).
# (Not MaxRunDuration: the stake-attestation template adds it, so on that branch
# it is a template setting, not a kept one.)
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
FeeCapDefault = "10 gwei"

[EVM.HeadTracker]
SamplingInterval = "30s"            # coalesce heads
HistoryDepth = 25

[EVM.NodePool]
PollInterval   = "80s"
NewHeadsPollInterval = "30s"
SyncThreshold = 10
PollFailureThreshold = 3

[EVM.Transactions]
ReaperInterval = "30m"
ReaperThreshold = "168h"

[[EVM.Nodes]]
Name="Base-Mainnet-1"
WSURL="wss://base-mainnet.infura.io/ws/v3/KEYONE"
HTTPURL="https://base-mainnet.infura.io/v3/KEYONE"

[[EVM.Nodes]]
Name="Base-Mainnet-2"
WSURL="wss://base.blockpi.network/v1/ws/KEYTWO"
HTTPURL="https://base.blockpi.network/v1/rpc/KEYTWO"

[Feature]
LogPoller = true
'

container() { : > "$ST/exists"; echo "$1" > "$ST/status"; echo 0 > "$ST/restarts"; : > "$ST/calls"; }
put() { printf '%s' "$1" > "$CFG/config.toml"; rm -f "$CFG"/config.toml.backup.*; }
: > "$CFG/secrets.toml"
run() { env PATH="$B:$PATH" FW_ST="$ST" FW_MOUNT="$CFG" VERDIKTA_CHAINLINK_WAIT_SECS=10 "$@" bash "$SCRIPT" --target-dir "$I" ${ARGS[@]+"${ARGS[@]}"} 2>&1 | sed 's/\x1b\[[0-9;]*m//g'; echo "rc=${PIPESTATUS[0]}"; }
backups() { ls "$CFG"/config.toml.backup.* 2>/dev/null | wc -l | tr -d ' '; }
leftovers() { ls -a "$CFG" | grep -c '^\.config\.toml\.candidate' | tr -d ' '; }
# toml FILE EXPR -> EXPR evaluated on the parsed file (d), or "no-tomllib".
toml() {
    python3 - "$1" "$2" <<'PY' 2>&1
import sys
try:
    import tomllib
except ImportError:
    print("no-tomllib"); sys.exit(0)
d = tomllib.load(open(sys.argv[1], "rb"))
e = d["EVM"][0]
print(eval(sys.argv[2]))
PY
}

# 1. The May config: --check lists the template's changes, keeps the node's own.
container exited; put "$MAY"; chmod 640 "$CFG/config.toml"
ARGS=(--check); out=$(run)
has   "may: rc 1"                 "$out" "rc=1"
has   "may: threshold added"      "$out" '\[\[EVM\]\] NoNewFinalizedHeadsThreshold: added "0s"'
has   "may: repeatable read"      "$out" '\[EVM.NodePool\] EnforceRepeatableRead: added false'
has   "may: changed value"        "$out" '\[EVM.NodePool\] NewHeadsPollInterval: "30s" -> "8s"'
has   "may: finality depth"       "$out" '\[\[EVM\]\] FinalityDepth: 5 -> 10'
has   "may: sync threshold"       "$out" '\[EVM.NodePool\] SyncThreshold: 10 -> 100'
has   "may: finalized poll"       "$out" '\[EVM.NodePool\] FinalizedBlockPollInterval: added "60s"'
hasnt "may: nothing retired"      "$out" "removed (was"
has   "may: own table kept"       "$out" '\[Feature\] LogPoller: kept true'
has   "may: operator setting kept" "$out" '\[EVM.NodePool\] PollFailureThreshold: kept 3'
hasnt "may: fee cap untouched"    "$out" "FeeCapDefault"
hasnt "may: chain id untouched"   "$out" "ChainID"
hasnt "may: RPCs untouched"       "$out" "EVM.Nodes"
hasnt "may: no key in output"     "$out" "KEYONE"
eq    "may: check writes nothing" "$(backups)" "0"
ARGS=(--apply); out=$(run)
has   "may apply: rc 0"           "$out" "rc=0"
has   "may apply: validated"      "$(cat "$ST/calls")" "^run --rm --network none .* node -config /chainlink/.config.toml.candidate.[0-9]* -secrets /chainlink/secrets.toml validate"
has   "may apply: stopped"        "$out" "Chainlink is not running; the new config takes effect when it next starts"
eq    "may apply: one backup"     "$(backups)" "1"
eq    "may apply: backup is the old file" "$(cat "$CFG"/config.toml.backup.*)" "$(printf '%s' "$MAY")"
eq    "may apply: no candidate left" "$(leftovers)" "0"
eq    "may apply: mode kept"      "$(ls -l "$CFG/config.toml" | cut -c1-10)" "-rw-r-----"
r=$(toml "$CFG/config.toml" '(e["ChainID"], e["GasEstimator"]["FeeCapDefault"], e["NoNewFinalizedHeadsThreshold"], e["NodePool"]["EnforceRepeatableRead"], e["NodePool"]["PollFailureThreshold"], e["FinalityDepth"], e["NodePool"]["SyncThreshold"], e["NodePool"]["FinalizedBlockPollInterval"], [n["Name"] for n in e["Nodes"]], e["Nodes"][1]["WSURL"], d["Feature"]["LogPoller"], d["JobPipeline"]["HTTPRequest"]["DefaultTimeout"])')
[ "$r" = "no-tomllib" ] || eq "may apply: parsed" "$r" "(8453, '10 gwei', '0s', False, 3, 10, 100, '60s', ['Base-Mainnet-1', 'Base-Mainnet-2'], 'wss://base.blockpi.network/v1/ws/KEYTWO', True, '300s')"
ARGS=(--check); out=$(run)
has   "after: rc 0"               "$out" "rc=0"
has   "after: matches"            "$out" "matches the template"
has   "after: still lists kept"   "$out" "LogPoller: kept"
ARGS=(--apply); out=$(run)
has   "second apply: rc 0"        "$out" "rc=0"
eq    "second apply: no new backup" "$(backups)" "1"

# 2. The current template rendered as setup-chainlink.sh writes it: nothing to do.
sed -e 's/<CHAIN_ID>/8453/' -e 's/<TIP_CAP_DEFAULT>/1 gwei/' -e 's/<FEE_CAP_DEFAULT>/20 gwei/' \
    -e 's|<EVM_NODES_BLOCK>|[[EVM.Nodes]]\nName="Base-Mainnet-1"\nWSURL="wss://x/k"\nHTTPURL="https://x/k"|' \
    "$ROOT/chainlink-node/config_template.toml" > "$T/current.toml"
container exited; put "$(cat "$T/current.toml")"
ARGS=(--check); out=$(run)
has "template: rc 0"              "$out" "rc=0"
# Quote style, comments and blank lines are not changes.
put "$(sed -e "s/NewHeadsPollInterval = \"8s\"/NewHeadsPollInterval = '8s'   # faster/" -e '/^#/d' -e '/^$/d' "$T/current.toml")"
ARGS=(--check); out=$(run)
has "noise only: rc 0"            "$out" "rc=0"

# 3. --rpcs-from-env (the upgrade passes it when the RPCs were changed in that run).
container exited; put "$MAY"
ARGS=(--check --rpcs-from-env); out=$(run)
has   "env rpcs: rc 1"            "$out" "rc=1"
has   "env rpcs: url to host"     "$out" '\[\[EVM.Nodes\]\] #1 WSURL: "wss://base-mainnet.infura.io/…" -> "wss://rpc-a.example/…"'
has   "env rpcs: third added"     "$out" '\[\[EVM.Nodes\]\] #3 HTTPURL: added "https://rpc-c.example/…"'
hasnt "env rpcs: no secret"       "$out" "SECRET"
ARGS=(--apply --rpcs-from-env); out=$(run)
has   "env rpcs apply: rc 0"      "$out" "rc=0"
r=$(toml "$CFG/config.toml" '[(n["Name"], n["HTTPURL"]) for n in e["Nodes"]]')
[ "$r" = "no-tomllib" ] || eq "env rpcs apply: nodes" "$r" "[('Base-Mainnet-1', 'https://rpc-a.example/v3/SECRETA'), ('Base-Mainnet-2', 'https://rpc-b.example/SECRETB'), ('Base-Mainnet-3', 'https://rpc-c.example/key/SECRETC')]"
cp "$I/installer/.env" "$T/env.bak"
sed -i.x 's/^BASE_MAINNET_RPC_WS_URLS=.*/BASE_MAINNET_RPC_WS_URLS="wss:\/\/only-one"/' "$I/installer/.env"
put "$MAY"; ARGS=(--check --rpcs-from-env); out=$(run)
has   "env rpcs mismatch: rc 2"   "$out" "rc=2"
has   "env rpcs mismatch: says"   "$out" "no matching HTTP and WS RPC lists"
cp "$T/env.bak" "$I/installer/.env"

# 4. Layouts it will not guess about: exit 2, untouched.
for bad_cfg in \
    "two EVM tables|$(printf '%s' "$MAY")
[[EVM]]
ChainID=84532" \
    "no RPC entries|[[EVM]]
ChainID=8453"; do
    label="${bad_cfg%%|*}"; content="${bad_cfg#*|}"
    container running; put "$content"
    ARGS=(--apply); out=$(run)
    has "$label: rc 2"            "$out" "rc=2"
    eq  "$label: untouched"       "$(cat "$CFG/config.toml")" "$content"
    eq  "$label: no backup"       "$(backups)" "0"
    hasnt "$label: no restart"    "$(cat "$ST/calls")" "^restart"
done
# A placeholder the script does not know: the template is wrong, nothing is written.
sed 's/^HistoryDepth = 25$/HistoryDepth = <HISTORY_DEPTH>/' "$ROOT/chainlink-node/config_template.toml" > "$T/odd_template.toml"
container exited; put "$MAY"
ARGS=(--apply --template "$T/odd_template.toml"); out=$(run)
has "odd template: rc 2"          "$out" "rc=2"
has "odd template: names it"      "$out" "<HISTORY_DEPTH>"
eq  "odd template: no backup"     "$(backups)" "0"

# 5. Chainlink's validator rejects the new file: nothing written, no restart.
container running; put "$MAY"
ARGS=(--apply); out=$(VALIDATE=reject run)
has   "rejected: rc 1"            "$out" "rc=1"
has   "rejected: reason"          "$out" "Error running app"
eq    "rejected: unchanged"       "$(cat "$CFG/config.toml")" "$(printf '%s' "$MAY")"
eq    "rejected: no backup"       "$(backups)" "0"
eq    "rejected: no candidate"    "$(leftovers)" "0"
hasnt "rejected: no restart"      "$(cat "$ST/calls")" "^restart"

# 6. Running, and Chainlink does not stay up on the new file: the old one is put back.
container running; put "$MAY"
ARGS=(--apply); out=$(REJECT_NEW=1 run)
has "crash: rc 1"                 "$out" "rc=1"
has "crash: restoring"            "$out" "Restoring the previous config"
eq  "crash: old file back"        "$(cat "$CFG/config.toml")" "$(printf '%s' "$MAY")"
eq  "crash: running again"        "$(cat "$ST/status")" "running"
# Running and healthy: one restart.
container running; put "$MAY"
ARGS=(--apply); out=$(run)
has "running: answering"          "$out" "Chainlink is answering on the new config"
eq  "running: one restart"        "$(grep -c '^restart' "$ST/calls")" "1"

# 7. Install-root layout: the template next to the script, the .env under installer/.
mkdir -p "$T/root/installer/lib" "$T/root/chainlink-node"
cp "$SCRIPT" "$T/root/"; cp "$ROOT/installer/lib/chainlink-config.sh" "$T/root/installer/lib/"
cp "$ROOT/chainlink-node/config_template.toml" "$T/root/chainlink-node/"; cp "$I/installer/.env" "$T/root/installer/"
container exited; put "$MAY"
out=$(env PATH="$B:$PATH" FW_ST="$ST" FW_MOUNT="$CFG" bash "$T/root/regenerate-chainlink-config.sh" --check 2>&1; echo "rc=$?")
has "install root: template found" "$out" "compared with $T/root/chainlink-node/config_template.toml"
has "install root: rc 1"           "$out" "rc=1"
# No template anywhere: 2.
rm "$T/root/chainlink-node/config_template.toml"
out=$(env PATH="$B:$PATH" FW_ST="$ST" FW_MOUNT="$CFG" bash "$T/root/regenerate-chainlink-config.sh" --check 2>&1; echo "rc=$?")
has "no template: rc 2"            "$out" "rc=2"

# 8. Interactive: anything but y changes nothing.
container exited; put "$MAY"
ARGS=(); out=$(echo n | run)
has "interactive n: rc 1"         "$out" "rc=1"
eq  "interactive n: no backup"    "$(backups)" "0"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
