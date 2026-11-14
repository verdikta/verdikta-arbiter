#!/bin/bash
# arbiter-doctor.sh and remote-doctor.sh keep credentials out of what they print, save
# and bundle (#126, node A8d). The 2026-11-07 canary upgrade's post-upgrade doctor pasted
# Chainlink's log lines, RPC URLs with the providers' keys in them, into the upgrade's
# terminal and log: it read `docker logs ... 2>&1 > file`, which sends stderr (Chainlink's
# log) to the doctor's own output. The support bundle saved the same raw tail.
#
# 1. redact_log itself, on fake URLs shaped like real providers' (Infura /v3/<32 hex>,
#    blockpi's path key, wss://), and on key=, token=, Bearer and JWT values.
# 2. The REAL doctors, run whole against a fake install with stub docker / curl / ss /
#    timeout: human, --quiet, --json and --collect output and every file of the bundle
#    hold none of the fake secrets, and no Chainlink log line reaches the output.
# Every fake secret is built when the test runs, so none is a literal in this file.
# Run: bash installer/tests/doctor-redact.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCTOR="$ROOT/util/arbiter-doctor.sh"
REMOTE="$ROOT/util/remote-doctor.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if printf '%s\n' "$2" | grep -qF -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if printf '%s\n' "$2" | grep -qF -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

fn=$(awk '/^redact_log\(\) \{/{p=1} p{print} p&&/^}/{exit}' "$DOCTOR")
[ -n "$fn" ] && ok || bad "could not extract redact_log from $DOCTOR"
fn_remote=$(awk '/^redact_log\(\) \{/{p=1} p{print} p&&/^}/{exit}' "$REMOTE")
[ "$fn" = "$fn_remote" ] && ok || bad "remote-doctor.sh's redact_log is not the doctor's"
eval "$fn"
r() { printf '%s\n' "$1" | redact_log; }

# The fakes: low-entropy repeats, assembled here.
K32=$(printf 'f00d%.0s' 1 2 3 4 5 6 7 8)                                 # Infura-style project id
K64=$(printf 'beef%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16)        # blockpi-style path key
PW=$(printf 'pw9%.0s' 1 2 3 4 5 6)
JWT="eyJ$(printf 'aGVsbG8%.0s' 1 2 3).eyJ$(printf 'd29ybGQ%.0s' 1 2 3).$(printf 'c2ln%.0s' 1 2 3 4)"
B64="$(printf 'QmFzZTY0%.0s' 1 2 3)+/=="
SECRETS="$K32 $K64 $PW $JWT"

# --- 1. redact_log
out=$(r "https://base-sepolia.infura.io/v3/$K32")
[ "$out" = "https://base-sepolia.infura.io/<redacted>" ] && ok || bad "infura https: [$out]"
out=$(r "wss://base-sepolia.infura.io/ws/v3/$K32")
[ "$out" = "wss://base-sepolia.infura.io/<redacted>" ] && ok || bad "infura wss: [$out]"
out=$(r "https://base-sepolia.blockpi.network/v1/rpc/$K64")
[ "$out" = "https://base-sepolia.blockpi.network/<redacted>" ] && ok || bad "blockpi path key: [$out]"
out=$(r "ws://rpc.example.net:8546/$K32")
[ "$out" = "ws://rpc.example.net:8546/<redacted>" ] && ok || bad "ws with a port: [$out]"
out=$(r "https://rpc.example.net?apikey=$K32#frag")
[ "$out" = "https://rpc.example.net/<redacted>" ] && ok || bad "query key: [$out]"
out=$(r "HTTPS://RPC.EXAMPLE.NET/v3/$K32")
[ "$out" = "HTTPS://RPC.EXAMPLE.NET/<redacted>" ] && ok || bad "upper-case scheme: [$out]"
# userinfo, also with an @ in the password
out=$(r "url=https://user:$PW@rpc.example.net:8545/path end")
[ "$out" = "url=https://rpc.example.net:8545/<redacted> end" ] && ok || bad "userinfo: [$out]"
out=$(r "wss://user:p@$PW@rpc.example.net")
[ "$out" = "wss://rpc.example.net/<redacted>" ] && ok || bad "userinfo with @, no path: [$out]"
out=$(r "postgresql://postgres:$PW@cl-postgres:5432/postgres?sslmode=disable")
[ "$out" = "postgresql://<redacted>@cl-postgres:5432/postgres?sslmode=disable" ] && ok || bad "other scheme's userinfo: [$out]"
# A Chainlink line as it logs an RPC node (name:ws:http) and a Go error quoting a URL:
# the JSON stays valid, the closing \" and the text after it stay.
line="2026-11-07T01:02:03.000Z [ERROR] RPC failed {\"node\":\"(primary)primary-0:wss://base-sepolia.infura.io/ws/v3/$K32:https://base-sepolia.infura.io/v3/$K32\",\"err\":\"Post \\\"https://base-sepolia.blockpi.network/v1/rpc/$K64\\\": dial tcp\"}"
out=$(r "$line")
[ "$out" = '2026-11-07T01:02:03.000Z [ERROR] RPC failed {"node":"(primary)primary-0:wss://base-sepolia.infura.io/<redacted>","err":"Post \"https://base-sepolia.blockpi.network/<redacted>\": dial tcp"}' ] \
    && ok || bad "chainlink line: [$out]"
printf '%s' "$out" | python3 -c 'import json,sys; json.loads(sys.stdin.read().split(" RPC failed ",1)[1])' 2>/dev/null && ok || bad "the chainlink line is no longer JSON: $out"
# A comma-separated list, as installer/.env keeps them.
out=$(r "BASE_SEPOLIA_RPC_HTTP_URLS=\"https://a.example/v3/$K32,https://b.example/rpc/$K64\"")
hasnt "list: first key" "$out" "$K32"; hasnt "list: second key" "$out" "$K64"
has   "list: first host" "$out" "https://a.example/<redacted>"
# psql -At separates columns with |, which is never part of a URL: the next column stays.
out=$(r "1|0|fatal_error|Post https://rpc.example.net/v3/$K32|2026-11-07 12:00:00+00")
[ "$out" = "1|0|fatal_error|Post https://rpc.example.net/<redacted>|2026-11-07 12:00:00+00" ] && ok || bad "a psql row: [$out]"
out=$(r "x|https://user:$PW@rpc.example.net|y")
[ "$out" = "x|https://rpc.example.net/<redacted>|y" ] && ok || bad "a psql row, userinfo: [$out]"
# Node's util.inspect quotes with '.
out=$(r "{ url: 'https://gw.example.net/ipfs/Qm1?pinataGatewayToken=$K32', x: 1 }")
[ "$out" = "{ url: 'https://gw.example.net/<redacted>', x: 1 }" ] && ok || bad "single-quoted url: [$out]"
# key= / token= / quoted key: / Bearer / JWT
out=$(r "apikey=$K32 token=\"$K64\" api_key='$B64' IPFS_PINNING_KEY=$JWT access_token=$K32")
[ "$out" = "apikey=<redacted> token=\"<redacted>\" api_key='<redacted>' IPFS_PINNING_KEY=<redacted> access_token=<redacted>" ] && ok || bad "key=/token=: [$out]"
out=$(r "{\"apiKey\":\"$K64\",\"x\":1} { authToken: '$B64' }")
[ "$out" = "{\"apiKey\":\"<redacted>\",\"x\":1} { authToken: '<redacted>' }" ] && ok || bad "quoted key: [$out]"
out=$(r "Authorization: Bearer $JWT")
[ "$out" = "Authorization: Bearer <redacted>" ] && ok || bad "bearer: [$out]"
out=$(r "headers {x-auth: $JWT}")
[ "$out" = "headers {x-auth: <redacted-jwt>}" ] && ok || bad "a bare JWT: [$out]"
# What must stay: a host alone, short values, addresses after "key:", the patterns the doctor counts.
for keep in "https://mainnet.base.org is up" "key=short token=abc" \
            "node key: 0x1111111111111111111111111111111111111111" \
            "2026-11-07T01:02:03.000Z [CRIT] No live RPC nodes available" \
            "RPC endpoint detected out of sync; Invalid params" ; do
    out=$(r "$keep"); [ "$out" = "$keep" ] && ok || bad "changed what it should keep: [$keep] -> [$out]"
done
# A byte that is not UTF-8 does not stop it.
out=$(printf 'a\377b https://h.example/v3/%s\n' "$K32" | redact_log)
hasnt "a non-UTF-8 line" "$out" "$K32"

# --- 2. the real doctors, whole, against a fake install
T=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$T"' EXIT
I="$T/install"
mkdir -p "$T/bin" "$I/installer" "$I/external-adapter/logs" "$I/ai-node/logs"
cat > "$I/installer/.contracts" <<E
OPERATOR_ADDR="0x2222222222222222222222222222222222222222"
NODE_ADDRESS="0x3333333333333333333333333333333333333333"
KEY_1_ADDRESS="0x3333333333333333333333333333333333333333"
AGGREGATOR_ADDRESS="0x4444444444444444444444444444444444444444"
E
cat > "$I/installer/.env" <<E
DEPLOYMENT_NETWORK="base_sepolia"
BASE_SEPOLIA_RPC_URL="https://base-sepolia.infura.io/v3/$K32"
BASE_SEPOLIA_RPC_HTTP_URLS="https://base-sepolia.blockpi.network/v1/rpc/$K64,https://base-sepolia.infura.io/v3/$K32"
BASE_SEPOLIA_RPC_WS_URLS="wss://base-sepolia.infura.io/ws/v3/$K32"
BACKUP_RPC_URL="https://user:$PW@rpc.example.net/"
E
printf '{"level":"info","msg":"pin","headers":{"authorization":"Bearer %s"}}\n{"url":"https://gw.example.net/ipfs/Qm1?pinataGatewayToken=%s"}\n' "$JWT" "$K32" \
    > "$I/external-adapter/logs/adapter_20261107.log"
printf "provider error { apiKey: '%s' } calling https://api.example.net/v1/%s\n" "$K64" "$K32" > "$I/ai-node/logs/ai-node_20261107.log"
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
# docker: Chainlink's log comes on stderr (one stdout line, to see both reach the bundle).
cat > "$T/bin/docker" <<E
#!/bin/bash
case "\$1" in
  logs)
    echo "STDOUT-MARKER plain line"
    echo "$NOW [CRIT] CL-LOG-MARKER RPC node failed {\"node\":\"(primary)p-0:wss://base-sepolia.infura.io/ws/v3/$K32:https://base-sepolia.blockpi.network/v1/rpc/$K64\"}" >&2
    echo "$NOW [ERROR] CL-LOG-MARKER Post \"https://user:$PW@rpc.example.net/x\": EOF" >&2 ;;
  ps) printf 'chainlink\ncl-postgres\n' ;;
  inspect) case "\$*" in *Health*) echo healthy ;; *) echo 2026-11-07T00:00:00Z ;; esac ;;
  exec)
    case "\$*" in
      *pg_isready*) exit 0 ;;
      *"DISTINCT error"*) echo "Post \"https://base-sepolia.infura.io/v3/$K32\": context deadline exceeded" ;;
      *"fatal_error' AND created_at > now()"*) echo 1 ;;
      *"FROM evm.txes ORDER BY id"*) echo "1|0|fatal_error|Post \"https://base-sepolia.blockpi.network/v1/rpc/$K64\": EOF|2026-11-07"
                                     echo "2|1|fatal_error|dial https://base-sepolia.infura.io/v3/$K32|2026-11-07 12:00:00+00" ;;
      *"key_states WHERE"*) echo "84532|f" ;;
      *COALESCE*) echo -1 ;;
      *) echo 0 ;;
    esac ;;
esac
exit 0
E
printf '#!/bin/bash\nexit 7\n' > "$T/bin/curl"                       # every HTTP call fails
printf '#!/bin/bash\nexit 0\n' > "$T/bin/ss"                         # nothing listens
printf '#!/bin/bash\nshift\nexec "$@"\n' > "$T/bin/timeout"          # macOS has none
chmod +x "$T/bin/"*

secret_free() { # secret_free NAME TEXT
    local s
    for s in $SECRETS; do hasnt "$1: a secret" "$2" "$s"; done
}
for d in "$DOCTOR" "$REMOTE"; do
    name=$(basename "$d")
    for mode in "" --quiet --json; do
        out=$(cd "$T" && PATH="$T/bin:$PATH" bash "$d" --install-dir "$I" $mode 2>&1)
        secret_free "$name ${mode:-human}" "$out"
        hasnt "$name ${mode:-human}: no Chainlink line pasted" "$out" "CL-LOG-MARKER"
        hasnt "$name ${mode:-human}: no Chainlink stdout either" "$out" "STDOUT-MARKER"
    done
    out=$(cd "$T" && PATH="$T/bin:$PATH" bash "$d" --install-dir "$I" 2>&1)
    has "$name: the banner names the RPC host"        "$out" "rpc:      https://base-sepolia.infura.io/<redacted>"
    # check_config stops at the doctors' ${a,,} under bash 3.2 (macOS), before cfg.rpc_url.
    if [ "${BASH_VERSINFO[0]}" -ge 4 ]; then
        has "$name: cfg.rpc_url names the host"        "$out" "https://base-sepolia.infura.io/<redacted>  (no response to eth_blockNumber)"
    fi
    has "$name: a fatal tx's error, redacted"          "$out" "Post \"https://base-sepolia.infura.io/<redacted>\": context deadline exceeded"
    # The log checks now see Chainlink's lines (they read stdout only before).
    has "$name: the [CRIT] line on stderr is counted"  "$out" "txm.crit_lines_recent"
    hasnt "$name: ... and not missed"                  "$(printf '%s\n' "$out" | grep 'txm.crit_lines_recent')" "no occurrences"
done

# --collect: every file of the bundle
out=$(cd "$T" && PATH="$T/bin:$PATH" bash "$DOCTOR" --install-dir "$I" --collect "$T/diag.tgz" 2>&1)
secret_free "collect output" "$out"
hasnt "collect output: no Chainlink line" "$out" "CL-LOG-MARKER"
mkdir -p "$T/unpacked" && tar -xzf "$T/diag.tgz" -C "$T/unpacked" && ok || bad "no bundle: $out"
B="$T/unpacked/arbiter-diag"
for f in doctor-report.txt contracts.snapshot env.sanitized logs/adapter.log.tail logs/ai-node.log.tail \
         logs/chainlink.log.tail db/evm_txes.tsv; do
    [ -s "$B/$f" ] && ok || bad "bundle: $f missing or empty"
done
for s in $SECRETS; do
    hit=$(grep -rlF -- "$s" "$B" 2>/dev/null)
    [ -z "$hit" ] && ok || bad "bundle holds a secret in: $hit"
done
cl=$(cat "$B/logs/chainlink.log.tail" 2>/dev/null)
has "bundle: Chainlink's stderr is in it"   "$cl" "CL-LOG-MARKER"
has "bundle: and its stdout"                "$cl" "STDOUT-MARKER"
has "bundle: the wss host stays"            "$cl" "wss://base-sepolia.infura.io/<redacted>"
has "bundle: env keeps the variable names"  "$(cat "$B/env.sanitized")" "BASE_SEPOLIA_RPC_WS_URLS=\"wss://base-sepolia.infura.io/<redacted>\""
has "bundle: the tx error keeps its host"   "$(cat "$B/db/evm_txes.tsv")" "https://base-sepolia.blockpi.network/<redacted>"
has "bundle: the next column stays"         "$(cat "$B/db/evm_txes.tsv")" "https://base-sepolia.infura.io/<redacted>|2026-11-07 12:00:00+00"
has "bundle: the contracts stay"            "$(cat "$B/contracts.snapshot")" "0x2222222222222222222222222222222222222222"

echo "doctor-redact: pass=$pass fail=$fail"; [ "$fail" = 0 ]
