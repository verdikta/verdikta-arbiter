#!/bin/bash
#
# Verdikta Arbiter Doctor
#
# Comprehensive health diagnostic for a Verdikta Arbiter node.
# Catches the failure modes that produced the April–May 2026 silent outage:
#   - Node EOA unfunded
#   - setAuthorizedSenders never called
#   - Stuck transactions in chainlink TXM
#   - commitStore RAM-only flag
#   - Identity / configuration drift between .contracts, job spec, chainlink DB
#
# Operating modes:
#   ./arbiter-doctor.sh               # default: read-only diagnostic, human output
#   ./arbiter-doctor.sh --json        # one JSON object per check on stdout
#   ./arbiter-doctor.sh --quiet       # only FAIL/WARN/CRIT lines
#   ./arbiter-doctor.sh --fix         # interactive remediation (y/N per command)
#   ./arbiter-doctor.sh --collect [F] # bundle logs/state into tarball F (default ./arbiter-diag.tgz)
#
# Exit codes: 0 healthy, 1 warnings only, 2 failures, 3 critical, 64 misuse.
#

set -o pipefail

############################################
# Colors
############################################
if [ -t 1 ]; then
    C_RED='\033[0;31m'
    C_GREEN='\033[0;32m'
    C_YELLOW='\033[1;33m'
    C_BLUE='\033[0;34m'
    C_CYAN='\033[0;36m'
    C_DIM='\033[2m'
    C_BOLD='\033[1m'
    C_NC='\033[0m'
else
    C_RED='' C_GREEN='' C_YELLOW='' C_BLUE='' C_CYAN='' C_DIM='' C_BOLD='' C_NC=''
fi

############################################
# Globals
############################################
PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
CRIT_COUNT=0
INFO_COUNT=0

# Findings buffered as `severity\tid\tlabel\tdetail\thint` lines (TAB-separated)
FINDINGS_FILE=""
trap '[ -n "$FINDINGS_FILE" ] && rm -f "$FINDINGS_FILE"' EXIT

MODE="diag"        # diag | fix | collect
OUTPUT="human"     # human | json | quiet
COLLECT_OUT="./arbiter-diag.tgz"

# Discovered configuration (filled in by discover_config)
INSTALL_DIR=""
CONTRACTS_FILE=""
ENV_FILE=""
OPERATOR_ADDR=""
NODE_ADDRESS=""
KEY_1_ADDRESS=""
AGGREGATOR_ADDRESS=""
DEPLOYMENT_NETWORK=""
RPC_URL=""
CHAIN_ID=""

############################################
# Argument parsing
############################################
usage() {
    cat <<EOF
Usage: $0 [--json|--quiet] [--fix] [--collect [FILE]] [--install-dir DIR] [-h]

  --json              Emit one JSON object per check to stdout
  --quiet             Only emit FAIL/WARN/CRIT lines (good for cron)
  --fix               Interactive remediation: walk through each failure and
                      offer a y/N command to apply. No destructive action is
                      taken without confirmation.
  --collect [FILE]    Bundle sanitized logs + state into a tarball (default
                      ./arbiter-diag.tgz) and exit. Implies --quiet for the
                      doctor pass that runs first.
  --install-dir DIR   Override autodetected install root.
  -h, --help          This help.

Exit codes: 0 healthy, 1 warnings, 2 failures, 3 critical, 64 misuse.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --json) OUTPUT="json"; shift ;;
        --quiet) OUTPUT="quiet"; shift ;;
        --fix) MODE="fix"; shift ;;
        --collect)
            MODE="collect"
            shift
            if [ $# -gt 0 ] && [[ "$1" != --* ]]; then
                COLLECT_OUT="$1"; shift
            fi
            ;;
        --install-dir)
            shift
            [ -z "${1:-}" ] && { echo "--install-dir requires an argument" >&2; exit 64; }
            INSTALL_DIR="$1"; shift
            ;;
        -h|--help) usage; exit 0 ;;
        *)
            echo "unknown argument: $1" >&2
            usage >&2
            exit 64
            ;;
    esac
done

############################################
# Emit / record findings
############################################
# emit SEVERITY ID MESSAGE [HINT]
#   SEVERITY ∈ PASS WARN FAIL CRIT INFO
#   MESSAGE  — human description (shown for all severities)
#   HINT     — optional remediation hint (shown for WARN/FAIL/CRIT only)
emit() {
    local sev="$1" id="$2" msg="$3" hint="${4:-}"
    case "$sev" in
        PASS) PASS_COUNT=$((PASS_COUNT+1)) ;;
        WARN) WARN_COUNT=$((WARN_COUNT+1)) ;;
        FAIL) FAIL_COUNT=$((FAIL_COUNT+1)) ;;
        CRIT) CRIT_COUNT=$((CRIT_COUNT+1)) ;;
        INFO) INFO_COUNT=$((INFO_COUNT+1)) ;;
    esac
    printf '%s\t%s\t%s\t%s\n' "$sev" "$id" "$msg" "$hint" >> "$FINDINGS_FILE"

    case "$OUTPUT" in
        json)
            printf '{"sev":"%s","id":"%s","msg":"%s","hint":"%s"}\n' \
                "$sev" "$id" "$(json_escape "$msg")" "$(json_escape "$hint")"
            ;;
        quiet)
            case "$sev" in
                WARN|FAIL|CRIT)
                    printf '%s  %-32s  %s\n' "$(sev_label "$sev")" "$id" "$msg"
                    [ -n "$hint" ] && printf '       → %s\n' "$hint"
                    ;;
            esac
            ;;
        human)
            printf '  %s  %-32s  %s\n' "$(sev_label "$sev")" "$id" "$msg"
            [ -n "$hint" ] && [ "$sev" != "PASS" ] && [ "$sev" != "INFO" ] \
                && printf '         %s→%s %s\n' "$C_DIM" "$C_NC" "$hint"
            ;;
    esac
}

sev_label() {
    case "$1" in
        PASS) echo -e "${C_GREEN}PASS${C_NC}" ;;
        WARN) echo -e "${C_YELLOW}WARN${C_NC}" ;;
        FAIL) echo -e "${C_RED}FAIL${C_NC}" ;;
        CRIT) echo -e "${C_RED}${C_BOLD}CRIT${C_NC}" ;;
        INFO) echo -e "${C_CYAN}INFO${C_NC}" ;;
    esac
}

json_escape() {
    # Minimal JSON string escape — backslash, quote, newline, tab, CR.
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g' -e 's/\t/\\t/g' -e 's/\r/\\r/g'
}

section_header() {
    [ "$OUTPUT" = "human" ] || return 0
    printf '\n%s%s%s\n' "$C_BLUE$C_BOLD" "$1" "$C_NC"
}

############################################
# Auto-discovery
############################################
discover_config() {
    # Find install dir if not provided
    if [ -z "$INSTALL_DIR" ]; then
        if [ -d "/root/verdikta-arbiter-node" ] && [ -f "/root/verdikta-arbiter-node/installer/.contracts" ]; then
            INSTALL_DIR="/root/verdikta-arbiter-node"
        elif [ -d "$HOME/verdikta-arbiter-node" ] && [ -f "$HOME/verdikta-arbiter-node/installer/.contracts" ]; then
            INSTALL_DIR="$HOME/verdikta-arbiter-node"
        else
            # Walk up from script location looking for installer/.contracts
            local d
            d="$(dirname "$(readlink -f "$0")")"
            while [ "$d" != "/" ]; do
                if [ -f "$d/installer/.contracts" ]; then INSTALL_DIR="$d"; break; fi
                d="$(dirname "$d")"
            done
        fi
    fi
    [ -z "$INSTALL_DIR" ] && { echo "ERROR: could not locate install dir (try --install-dir)" >&2; exit 64; }

    CONTRACTS_FILE="$INSTALL_DIR/installer/.contracts"
    ENV_FILE="$INSTALL_DIR/installer/.env"

    # Read .contracts (we still proceed even if missing — config checks will FAIL).
    if [ -f "$CONTRACTS_FILE" ]; then
        # shellcheck disable=SC1090
        set +u; source "$CONTRACTS_FILE"; set -u 2>/dev/null || true
    fi
    if [ -f "$ENV_FILE" ]; then
        # shellcheck disable=SC1090
        set +u; source "$ENV_FILE"; set -u 2>/dev/null || true
    fi

    # Determine RPC URL based on network
    case "${DEPLOYMENT_NETWORK:-}" in
        base_mainnet) RPC_URL="${BASE_MAINNET_RPC_URL:-}"; CHAIN_ID="8453" ;;
        base_sepolia) RPC_URL="${BASE_SEPOLIA_RPC_URL:-}"; CHAIN_ID="84532" ;;
        sepolia)      RPC_URL="${SEPOLIA_RPC_URL:-}";      CHAIN_ID="11155111" ;;
        *) RPC_URL="" ;;
    esac
}

############################################
# Helpers
############################################
# rpc_call METHOD PARAMS_JSON  → prints raw result, or empty on error
rpc_call() {
    local method="$1" params="$2"
    [ -z "$RPC_URL" ] && return 1
    local body
    body=$(printf '{"jsonrpc":"2.0","id":1,"method":"%s","params":%s}' "$method" "$params")
    curl -fsS --max-time 8 -H 'Content-Type: application/json' -d "$body" "$RPC_URL" 2>/dev/null \
        | python3 -c 'import sys,json
try:
    j=json.load(sys.stdin)
    if "error" in j: sys.exit(1)
    r=j.get("result")
    if r is None: sys.exit(1)
    if isinstance(r,(dict,list)): print(json.dumps(r))
    else: print(r)
except SystemExit as e: raise
except Exception: sys.exit(1)
' 2>/dev/null
}

# hex2dec HEX → decimal
hex2dec() { python3 -c "import sys; print(int(sys.argv[1],16))" "$1" 2>/dev/null; }

# wei_to_eth WEI → string with 6 decimal places
wei_to_eth() { python3 -c "import sys; print(f'{int(sys.argv[1])/1e18:.6f}')" "$1" 2>/dev/null; }

# Check whether a tcp port is listening locally.
# Prefer `ss` because `lsof -i` can silently miss listening sockets when the
# binding process is in a different cgroup/namespace or was started long ago;
# we observed this on a live arbiter where `lsof -nP -iTCP:3000` returned
# empty while `ss -tln` and `curl http://localhost:3000` both worked fine.
# Fall back to lsof only if ss is unavailable.
port_listening() {
    if command -v ss >/dev/null 2>&1; then
        ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$" && return 0
        # ss returned but didn't show the port: trust it (don't fall through).
        return 1
    fi
    if command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
        return $?
    fi
    return 1
}

# pg query: run a SQL statement against cl-postgres / postgres / postgres
pg_query() {
    local sql="$1"
    docker exec cl-postgres psql -U postgres -d postgres -At -c "$sql" 2>/dev/null
}

pg_available() {
    docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^cl-postgres$' || return 1
    docker exec cl-postgres pg_isready -q 2>/dev/null
}

# safe_grep_count PATTERN FILE → integer (0 if file missing or no matches)
safe_grep_count() {
    [ -f "$2" ] || { echo 0; return; }
    # `grep -c` prints "0" with exit 1 when no matches; suppress the exit but keep output.
    grep -cE "$1" "$2" 2>/dev/null || true
}

# is_addr_lowercase_match A B → 0 if equal ignoring case and 0x
is_addr_lowercase_match() {
    local a="${1#0x}" b="${2#0x}"
    [ "${a,,}" = "${b,,}" ]
}

# Hash-encoded function selector (first 4 bytes of keccak256)
SEL_OWNER='0x8da5cb5b'                                           # owner()
SEL_GET_AUTH_SENDERS='0x2408afaa'                                # getAuthorizedSenders()
# isAuthorizedSender(address) = 0xfa00763a, then 32-byte padded address
sel_is_auth_sender_data() {
    local a="${1#0x}"
    printf '0xfa00763a000000000000000000000000%s' "${a,,}"
}

############################################
# Section checks
############################################

check_config() {
    section_header "CONFIGURATION"

    # contracts file
    if [ -f "$CONTRACTS_FILE" ]; then
        emit PASS cfg.contracts_file "installer/.contracts present" "$CONTRACTS_FILE"
    else
        emit CRIT cfg.contracts_file "installer/.contracts MISSING ($CONTRACTS_FILE)" \
             "Reinstall or restore from backup; required by every other check."
        return
    fi

    # env file
    if [ -f "$ENV_FILE" ]; then
        emit PASS cfg.env_file "installer/.env present" "$ENV_FILE"
    else
        emit FAIL cfg.env_file "installer/.env MISSING ($ENV_FILE)" \
             "Recreate from installer/setup-environment.sh"
    fi

    # operator addr
    if [[ "$OPERATOR_ADDR" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
        emit PASS cfg.operator_addr "$OPERATOR_ADDR" ""
    else
        emit CRIT cfg.operator_addr "invalid OPERATOR_ADDR=\"$OPERATOR_ADDR\"" \
             "Edit $CONTRACTS_FILE to set a valid address."
    fi

    # node addr
    if [[ "$NODE_ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
        emit PASS cfg.node_addr "$NODE_ADDRESS" ""
    else
        emit CRIT cfg.node_addr "invalid NODE_ADDRESS=\"$NODE_ADDRESS\"" \
             "Edit $CONTRACTS_FILE to set a valid address."
    fi

    # Node addr consistency between .contracts and KEY_1_ADDRESS
    if [ -n "$KEY_1_ADDRESS" ] && [ -n "$NODE_ADDRESS" ]; then
        if is_addr_lowercase_match "$NODE_ADDRESS" "$KEY_1_ADDRESS"; then
            emit PASS cfg.node_addr_keys "NODE_ADDRESS == KEY_1_ADDRESS" ""
        else
            emit CRIT cfg.node_addr_keys "NODE_ADDRESS ($NODE_ADDRESS) != KEY_1_ADDRESS ($KEY_1_ADDRESS)" \
                 "Edit $CONTRACTS_FILE so both refer to the same key, or run register-oracle.sh."
        fi
    fi

    # Network
    case "$DEPLOYMENT_NETWORK" in
        base_mainnet|base_sepolia|sepolia)
            emit PASS cfg.network "$DEPLOYMENT_NETWORK" "chain_id=$CHAIN_ID"
            ;;
        "")
            emit CRIT cfg.network "DEPLOYMENT_NETWORK missing" "Set DEPLOYMENT_NETWORK in $ENV_FILE"
            ;;
        *)
            emit FAIL cfg.network "unsupported network: $DEPLOYMENT_NETWORK" \
                 "Use base_mainnet, base_sepolia, or sepolia"
            ;;
    esac

    # RPC URL
    if [ -n "$RPC_URL" ]; then
        local block
        block=$(rpc_call eth_blockNumber '[]')
        if [ -n "$block" ]; then
            emit PASS cfg.rpc_url "$RPC_URL  (block $(hex2dec "$block"))" ""
        else
            emit CRIT cfg.rpc_url "$RPC_URL  (no response to eth_blockNumber)" \
                 "Check $ENV_FILE; try $INSTALL_DIR/update-rpc-endpoints.sh"
        fi
    else
        emit CRIT cfg.rpc_url "RPC URL not set for $DEPLOYMENT_NETWORK" \
             "Set BASE_MAINNET_RPC_URL / BASE_SEPOLIA_RPC_URL in $ENV_FILE"
    fi

    # Job spec consistency: fromAddress in job toml must match NODE_ADDRESS
    local job_toml="$INSTALL_DIR/chainlink-node/jobs/verdikta_job_spec_arbiter_1.toml"
    if [ -f "$job_toml" ]; then
        local jobfrom
        jobfrom=$(grep -E '^fromAddress' "$job_toml" | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
        if [ -n "$jobfrom" ] && is_addr_lowercase_match "$jobfrom" "$NODE_ADDRESS"; then
            emit PASS cfg.job_from_addr "job spec fromAddress matches NODE_ADDRESS" ""
        else
            emit CRIT cfg.job_from_addr "job spec fromAddress ($jobfrom) != NODE_ADDRESS ($NODE_ADDRESS)" \
                 "Re-run installer/util/create-chainlink-job.sh"
        fi
    else
        emit WARN cfg.job_from_addr "job spec not found ($job_toml)" \
             "Run installer/util/create-chainlink-job.sh"
    fi
}

check_services() {
    section_header "SERVICES"

    # AI Node :3000 — probe /api/health directly. The HTTP response is the
    # most reliable signal: if curl gets through, the service is up regardless
    # of whether port-detection helpers can enumerate the socket.
    local ai_health
    ai_health=$(curl -fsS --max-time 5 http://localhost:3000/api/health 2>/dev/null)
    if [ -n "$ai_health" ]; then
        local ok mode
        ok=$(printf '%s' "$ai_health" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status","")=="ok")' 2>/dev/null)
        mode=$(printf '%s' "$ai_health" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("ai_gateway",{}).get("mode",""))' 2>/dev/null)
        if [ "$ok" = "True" ]; then
            emit PASS svc.ai_node "responding on :3000  (health=ok, gateway=$mode)" ""
        else
            emit WARN svc.ai_node "responding on :3000  (health endpoint reachable but not 'ok')" ""
        fi
    elif port_listening 3000; then
        emit FAIL svc.ai_node "port :3000 has a listener but /api/health did not respond" \
             "Restart with $INSTALL_DIR/ai-node/stop.sh && $INSTALL_DIR/ai-node/start.sh"
    else
        emit FAIL svc.ai_node "not listening on :3000" \
             "Start with $INSTALL_DIR/start-arbiter.sh or $INSTALL_DIR/ai-node/start.sh"
    fi

    # EA :8080
    if port_listening 8080; then
        emit PASS svc.adapter "listening on :8080" ""
    else
        emit FAIL svc.adapter "not listening on :8080" \
             "Start with $INSTALL_DIR/external-adapter/start.sh"
    fi

    # Chainlink container
    local cl_status
    cl_status=$(docker inspect --format '{{.State.Health.Status}}' chainlink 2>/dev/null)
    if [ -z "$cl_status" ]; then
        if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^chainlink$'; then
            emit FAIL svc.chainlink "chainlink container exists but not running" \
                 "docker start chainlink  (or $INSTALL_DIR/util/start-chainlink.sh)"
        else
            emit CRIT svc.chainlink "chainlink container missing" \
                 "Reinstall the chainlink node component"
        fi
    elif [ "$cl_status" = "healthy" ]; then
        local uptime
        uptime=$(docker inspect --format '{{.State.StartedAt}}' chainlink 2>/dev/null)
        emit PASS svc.chainlink "container healthy (started $uptime)" ""
    else
        emit FAIL svc.chainlink "container state: $cl_status" \
             "Check docker logs chainlink --tail 50"
    fi

    # Postgres container
    if pg_available; then
        emit PASS svc.postgres "cl-postgres healthy" ""
    elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^cl-postgres$'; then
        emit FAIL svc.postgres "cl-postgres exists but not ready" "docker start cl-postgres"
    else
        emit CRIT svc.postgres "cl-postgres container missing" "Reinstall chainlink component"
    fi

    # Disk space
    local free_gb
    free_gb=$(df -BG "$INSTALL_DIR" 2>/dev/null | awk 'NR==2 {sub(/G/,"",$4); print $4+0}')
    if [ -n "$free_gb" ]; then
        if [ "$free_gb" -lt 2 ]; then
            emit FAIL svc.disk_space "${free_gb} GB free in $INSTALL_DIR" \
                 "Free up disk space; chainlink + logs will run out otherwise."
        elif [ "$free_gb" -lt 5 ]; then
            emit WARN svc.disk_space "${free_gb} GB free in $INSTALL_DIR" \
                 "Consider log rotation or pruning chainlink heads table."
        else
            emit PASS svc.disk_space "${free_gb} GB free in $INSTALL_DIR" ""
        fi
    fi

    # Log file sizes
    local biggest
    biggest=$(find "$INSTALL_DIR" -name "*.log" -printf '%s %p\n' 2>/dev/null \
              | sort -rn | head -1)
    if [ -n "$biggest" ]; then
        local bytes path mb
        bytes=$(echo "$biggest" | awk '{print $1}')
        path=$(echo "$biggest" | awk '{$1=""; sub(/^ /,""); print}')
        mb=$((bytes / 1024 / 1024))
        if [ "$mb" -ge 1024 ]; then
            emit WARN svc.log_size "largest log: $((mb / 1024)) GB  ($path)" \
                 "Rotate or truncate; runaway log accumulation often signals a real problem."
        elif [ "$mb" -ge 200 ]; then
            emit INFO svc.log_size "largest log: ${mb} MB  ($path)" ""
        else
            emit PASS svc.log_size "largest log: ${mb} MB" ""
        fi
    fi
}

check_onchain() {
    section_header "ON-CHAIN STATE"

    if [ -z "$RPC_URL" ]; then
        emit WARN chain "RPC unavailable — skipping on-chain checks" ""
        return
    fi
    if ! [[ "$NODE_ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
        emit WARN chain "NODE_ADDRESS invalid — skipping on-chain checks" ""
        return
    fi

    # Balance
    local bal_hex bal_wei bal_eth
    bal_hex=$(rpc_call eth_getBalance "[\"$NODE_ADDRESS\",\"latest\"]")
    if [ -n "$bal_hex" ]; then
        bal_wei=$(hex2dec "$bal_hex")
        bal_eth=$(wei_to_eth "$bal_wei")
        if [ "$bal_wei" = "0" ]; then
            emit CRIT chain.node_balance_zero "node EOA balance = 0 ETH" \
                 "run: $INSTALL_DIR/fund-chainlink-keys.sh --amount 0.01"
        else
            # min 0.001 ETH = 1e15 wei
            if python3 -c "import sys; sys.exit(0 if int(sys.argv[1])>=10**15 else 1)" "$bal_wei"; then
                if python3 -c "import sys; sys.exit(0 if int(sys.argv[1])>=5*10**15 else 1)" "$bal_wei"; then
                    emit PASS chain.node_balance "$bal_eth ETH" ""
                else
                    emit WARN chain.node_balance "$bal_eth ETH  (low)" \
                         "Top up with $INSTALL_DIR/fund-chainlink-keys.sh"
                fi
            else
                emit FAIL chain.node_balance "$bal_eth ETH  (below 0.001 threshold)" \
                     "Top up with $INSTALL_DIR/fund-chainlink-keys.sh"
            fi
        fi
    else
        emit FAIL chain.node_balance "RPC could not return balance" "Check $RPC_URL availability"
    fi

    # Nonce
    local nonce_hex nonce
    nonce_hex=$(rpc_call eth_getTransactionCount "[\"$NODE_ADDRESS\",\"latest\"]")
    if [ -n "$nonce_hex" ]; then
        nonce=$(hex2dec "$nonce_hex")
        emit INFO chain.node_nonce "on-chain nonce = $nonce" ""
        # Combined with container uptime: if nonce==0 and chainlink has been up >1d, that's a CRIT.
        local uptime_seconds=0
        local started
        started=$(docker inspect --format '{{.State.StartedAt}}' chainlink 2>/dev/null)
        if [ -n "$started" ]; then
            uptime_seconds=$(python3 -c "
import sys, datetime, re
s=sys.argv[1]
s=re.sub(r'\.[0-9]+', '', s).replace('Z','+00:00')
t=datetime.datetime.fromisoformat(s).astimezone(datetime.timezone.utc)
print(int((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()))
" "$started" 2>/dev/null)
        fi
        if [ "$nonce" = "0" ] && [ "${uptime_seconds:-0}" -gt 86400 ]; then
            local days=$((uptime_seconds / 86400))
            emit CRIT chain.node_nonce_vs_age \
                 "nonce==0 but chainlink container has been up $days day(s) — fulfillment is broken" \
                 "Almost certainly the funding step never landed; check chain.node_balance and txm.* checks"
        fi
    fi

    # Operator code exists
    local code
    code=$(rpc_call eth_getCode "[\"$OPERATOR_ADDR\",\"latest\"]")
    if [ -z "$code" ] || [ "$code" = "0x" ]; then
        emit FAIL chain.operator_code "operator $OPERATOR_ADDR has no code" \
             "Wrong network or stale .contracts. Re-deploy with installer/bin/deploy-contracts.sh"
    else
        local size=$(( (${#code} - 2) / 2 ))
        emit PASS chain.operator_code "operator deployed ($size bytes)" ""
    fi

    # Operator owner
    local owner_raw owner
    owner_raw=$(rpc_call eth_call "[{\"to\":\"$OPERATOR_ADDR\",\"data\":\"$SEL_OWNER\"},\"latest\"]")
    if [ -n "$owner_raw" ] && [ "$owner_raw" != "0x" ]; then
        owner="0x${owner_raw: -40}"
        emit INFO chain.operator_owner "owner() = $owner" ""
    else
        emit WARN chain.operator_owner "could not read owner() from operator" ""
    fi

    # Authorized senders
    local auth_data auth_raw is_auth
    auth_data=$(sel_is_auth_sender_data "$NODE_ADDRESS")
    is_auth=$(rpc_call eth_call "[{\"to\":\"$OPERATOR_ADDR\",\"data\":\"$auth_data\"},\"latest\"]")
    if [ -z "$is_auth" ]; then
        emit FAIL chain.is_authorized "could not call isAuthorizedSender" \
             "Operator contract may be wrong/missing; see chain.operator_code"
    elif [ "$(hex2dec "$is_auth" 2>/dev/null)" = "1" ]; then
        emit PASS chain.is_authorized "isAuthorizedSender($NODE_ADDRESS) = true" ""
    else
        emit CRIT chain.is_authorized "node key NOT authorized on operator" \
             "run: $INSTALL_DIR/arbiter-operator/setAuthorizedSenders-dynamic.sh"
    fi

    # Authorized senders LIST (sanity check that list isn't empty)
    auth_raw=$(rpc_call eth_call "[{\"to\":\"$OPERATOR_ADDR\",\"data\":\"$SEL_GET_AUTH_SENDERS\"},\"latest\"]")
    if [ -n "$auth_raw" ]; then
        # Layout: offset(32) + length(32) + length × 32-byte words
        # Length is at bytes 64..96 of the hex string (chars 66..130 of the 0x... blob).
        local len_hex len
        len_hex=${auth_raw:66:64}
        len=$(hex2dec "$len_hex" 2>/dev/null || echo 0)
        if [ "$len" = "0" ]; then
            emit CRIT chain.authorized_senders_list "operator has NO authorized senders" \
                 "run: $INSTALL_DIR/arbiter-operator/setAuthorizedSenders-dynamic.sh"
        else
            emit PASS chain.authorized_senders_list "operator has $len authorized sender(s)" ""
        fi
    fi
}

check_chainlink_txm() {
    section_header "CHAINLINK TXM"

    if ! pg_available; then
        emit WARN txm "postgres unreachable — skipping TXM checks" ""
        return
    fi

    # Key registered + chain id + disabled
    local key_row chain_id_pg disabled_pg
    key_row=$(pg_query "SELECT evm_chain_id || '|' || disabled FROM evm.key_states WHERE encode(address,'hex')=lower('${NODE_ADDRESS#0x}');")
    if [ -z "$key_row" ]; then
        emit CRIT txm.key_registered "node key NOT in chainlink keystore" \
             "Re-import the key via chainlink CLI or run installer/util/key-management.sh"
    else
        chain_id_pg="${key_row%%|*}"
        disabled_pg="${key_row##*|}"
        # Postgres renders boolean text form as "true"/"false" via ||; accept either
        if [ "$chain_id_pg" = "$CHAIN_ID" ] && { [ "$disabled_pg" = "f" ] || [ "$disabled_pg" = "false" ]; }; then
            emit PASS txm.key_registered "key on chain $chain_id_pg, enabled" ""
        else
            emit CRIT txm.key_registered "key chain=$chain_id_pg disabled=$disabled_pg" \
                 "Re-import key on the correct chain"
        fi
    fi

    # Queue snapshot
    local q_unconfirmed q_in_progress q_unstarted q_fatal q_finalized
    q_unconfirmed=$(pg_query "SELECT count(*) FROM evm.txes WHERE state='unconfirmed';")
    q_in_progress=$(pg_query "SELECT count(*) FROM evm.txes WHERE state='in_progress';")
    q_unstarted=$(  pg_query "SELECT count(*) FROM evm.txes WHERE state='unstarted';")
    q_fatal=$(      pg_query "SELECT count(*) FROM evm.txes WHERE state='fatal_error';")
    q_finalized=$(  pg_query "SELECT count(*) FROM evm.txes WHERE state='finalized';")

    emit INFO txm.queue_summary "unconfirmed=${q_unconfirmed:-?} in_progress=${q_in_progress:-?} unstarted=${q_unstarted:-?} fatal_error=${q_fatal:-?} finalized=${q_finalized:-?}" ""

    # Old unconfirmed
    local old_unconfirmed
    old_unconfirmed=$(pg_query "SELECT count(*) FROM evm.txes WHERE state='unconfirmed' AND created_at < now() - interval '30 minutes';")
    if [ "${old_unconfirmed:-0}" = "0" ]; then
        emit PASS txm.stuck_unconfirmed "no unconfirmed tx older than 30 min" ""
    else
        local oldest
        oldest=$(pg_query "SELECT now() - min(created_at) FROM evm.txes WHERE state='unconfirmed';")
        emit FAIL txm.stuck_unconfirmed "$old_unconfirmed unconfirmed tx older than 30 min  (oldest: $oldest)" \
             "Probably stuck due to insufficient gas, missing auth, or RPC issues. Run with --fix to wipe."
    fi

    # In-progress hangs
    local old_in_prog
    old_in_prog=$(pg_query "SELECT count(*) FROM evm.txes WHERE state='in_progress' AND created_at < now() - interval '2 minutes';")
    if [ "${old_in_prog:-0}" = "0" ]; then
        emit PASS txm.stuck_in_progress "no in_progress tx hanging" ""
    else
        emit FAIL txm.stuck_in_progress "$old_in_prog in_progress tx > 2 min" \
             "TXM broadcaster stuck. Restart chainlink container or wipe queue via --fix."
    fi

    # Recent fatal errors
    local recent_fatal
    recent_fatal=$(pg_query "SELECT count(*) FROM evm.txes WHERE state='fatal_error' AND created_at > now() - interval '1 hour';")
    if [ "${recent_fatal:-0}" = "0" ]; then
        emit PASS txm.fatal_errors_recent "no fatal_error tx in last hour" ""
    else
        local err_sample
        err_sample=$(pg_query "SELECT DISTINCT error FROM evm.txes WHERE state='fatal_error' AND created_at > now() - interval '1 hour';" | head -3 | tr '\n' ';')
        emit FAIL txm.fatal_errors_recent "$recent_fatal fatal_error tx in last hour  ($err_sample)" \
             "If 'could not get receipt': stale signed txes won nonce races. Restart chainlink + retest."
    fi

    # Local vs chain nonce
    local max_local on_chain
    max_local=$(pg_query "SELECT COALESCE(max(nonce), -1) FROM evm.txes WHERE nonce IS NOT NULL;")
    local nonce_hex on_chain_dec
    nonce_hex=$(rpc_call eth_getTransactionCount "[\"$NODE_ADDRESS\",\"latest\"]")
    if [ -n "$nonce_hex" ] && [ "$max_local" != "" ]; then
        on_chain_dec=$(hex2dec "$nonce_hex")
        local next_chain=$on_chain_dec
        local next_local=$((max_local + 1))
        if [ "$max_local" = "-1" ]; then
            emit INFO txm.local_nonce_vs_chain "no local nonces yet; chain=$on_chain_dec" ""
        elif [ "$next_local" = "$next_chain" ]; then
            emit PASS txm.local_nonce_vs_chain "local=$next_local chain=$next_chain (in sync)" ""
        elif [ "$next_local" -lt "$next_chain" ]; then
            local diff=$((next_chain - next_local))
            if [ "$diff" -ge 5 ]; then
                emit FAIL txm.local_nonce_vs_chain "chainlink lagging chain by $diff nonces (local=$next_local chain=$next_chain)" \
                     "Foreign signing detected. Restart chainlink so it re-queries on-chain nonce."
            else
                emit WARN txm.local_nonce_vs_chain "chainlink lagging chain by $diff (local=$next_local chain=$next_chain)" ""
            fi
        else
            emit WARN txm.local_nonce_vs_chain "local nonce ($next_local) > chain ($next_chain) — unexpected" \
                 "Likely chainlink-internal accounting drift. Restart chainlink container."
        fi
    fi

    # Recent CRIT lines in chainlink container logs.
    # `--since` forces a linear scan of the json log file which is unbearably
    # slow on installs with many GB of log; `--tail N` uses seek-to-end and
    # returns in milliseconds. 20000 lines typically covers minutes-to-hours
    # of recent activity depending on log volume.
    #
    # We attribute findings by RECENCY: a line is "recent" if its ISO-8601
    # timestamp is within `RECENCY_HOURS` of now. Total counts that are all
    # stale just downgrade to INFO (they'll scroll out of the rolling window
    # on their own), while recent occurrences are FAIL.
    local cl_log_tmp
    cl_log_tmp=$(mktemp)
    if timeout 15 bash -c 'docker logs chainlink --tail 20000 2>&1 > "$1"' _ "$cl_log_tmp"; then
        local line_count first_ts last_ts
        line_count=$(wc -l < "$cl_log_tmp" 2>/dev/null || echo 0)
        first_ts=$(grep -oE '^2[0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z' "$cl_log_tmp" | head -1)
        last_ts=$(grep -oE '^2[0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z'  "$cl_log_tmp" | tail -1)
        local window="last $line_count lines"
        [ -n "$first_ts" ] && [ -n "$last_ts" ] && window="$window ($first_ts → $last_ts)"

        local recency_hours=1
        local cutoff
        cutoff=$(date -u -d "$recency_hours hour ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)

        # Helper: classify a chainlink-log pattern by recency, emit appropriately.
        # Args: pattern_id, grep_pattern, severity_when_recent, hint
        _classify_chainlink_pattern() {
            local pid="$1" pat="$2" sev_when_recent="$3" hint="$4"
            local total recent
            total=$(grep -cE "$pat" "$cl_log_tmp" 2>/dev/null || true)
            total=${total:-0}
            if [ "$total" = "0" ]; then
                emit PASS "$pid" "no occurrences in $window"
                return
            fi
            # Count occurrences whose ISO-8601 timestamp is >= cutoff (string comparison works on ISO-8601).
            # Pre-filter with grep -F when the pattern is fixed-string (avoids
            # awk warnings about backslashed regex chars in shell-supplied vars).
            if [ -n "$cutoff" ]; then
                recent=$(grep -E "$pat" "$cl_log_tmp" 2>/dev/null \
                         | awk -v c="$cutoff" '
                            $0 ~ /^2[0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/ {
                                if (substr($0,1,20) >= c) n++
                            }
                            END { print n+0 }
                        ')
            else
                recent="$total"
            fi
            if [ "${recent:-0}" -gt 0 ]; then
                emit "$sev_when_recent" "$pid" "$recent occurrence(s) in last ${recency_hours}h  ($total total in $window)" "$hint"
            else
                emit INFO "$pid" "$total stale occurrence(s) in $window; none in last ${recency_hours}h" \
                     "Will scroll out of the rolling window over time. No action needed unless they recur."
            fi
        }

        _classify_chainlink_pattern txm.crit_lines_recent '\[CRIT\]' FAIL \
            "Inspect: docker logs chainlink --tail 20000 | grep CRIT | tail -10"
        _classify_chainlink_pattern txm.invalid_params_recent 'Invalid params' FAIL \
            "Usually means tx has insufficient gas budget OR sender has 0 ETH. Check chain.node_balance."
        _classify_chainlink_pattern txm.rpc_out_of_sync 'RPC endpoint detected out of sync' WARN \
            "Infura's WebSocket dropped behind. If recurrent, add a second RPC endpoint for failover."
    else
        emit WARN txm.log_scrape "could not read chainlink logs within 15s" \
             "Container may be busy or log volume excessive. Check svc.log_size."
    fi
    rm -f "$cl_log_tmp"
}

check_external_adapter() {
    section_header "EXTERNAL ADAPTER"

    # commitStore mode.
    # USE_FILE=false makes the EA keep commits in RAM only — fine for normal
    # steady-state operation (where reveals follow commits within seconds and
    # the EA process isn't bounced), but commits are lost if the EA restarts
    # mid-flight. Treat as WARN, not FAIL: it's a latent footgun rather than
    # an active outage. Real outages (e.g. unfunded node, missing auth) are
    # what actually break running arbiters.
    local cs_file="$INSTALL_DIR/external-adapter/src/services/commitStore.js"
    if [ -f "$cs_file" ]; then
        if grep -qE '^const[[:space:]]+USE_FILE[[:space:]]*=[[:space:]]*true' "$cs_file"; then
            emit PASS ea.commit_store_mode "USE_FILE=true (commits persist across EA restarts)" ""
        elif grep -qE '^const[[:space:]]+USE_FILE[[:space:]]*=[[:space:]]*false' "$cs_file"; then
            emit WARN ea.commit_store_mode "USE_FILE=false — in-flight commits are RAM-only and would be lost across an EA restart" \
                 "Steady-state operation is unaffected; only matters during recovery / rapid restarts. To eliminate the risk: patch $cs_file (USE_FILE=true) and restart EA."
        else
            emit WARN ea.commit_store_mode "could not parse USE_FILE flag in commitStore.js" ""
        fi
    else
        emit WARN ea.commit_store_mode "commitStore.js not found at expected path" "$cs_file"
    fi

    # commit-db state
    local commit_db="$INSTALL_DIR/external-adapter/src/.commit-db.json"
    if [ -f "$commit_db" ]; then
        local entries last_mtime mtime_age_sec
        entries=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$commit_db" 2>/dev/null || echo "?")
        mtime_age_sec=$(( $(date +%s) - $(stat -c %Y "$commit_db" 2>/dev/null || echo 0) ))
        emit INFO ea.commit_db "$entries open commit(s), last write ${mtime_age_sec}s ago" "$commit_db"
        # Stale entries
        local stale_count
        stale_count=$(python3 -c '
import json, sys, datetime
db=json.load(open(sys.argv[1]))
now=datetime.datetime.now(datetime.timezone.utc)
cutoff=now - datetime.timedelta(hours=72)
n=0
for h,e in db.items():
    c=e.get("created","")
    try:
        t=datetime.datetime.fromisoformat(c.replace("Z","+00:00"))
        if t < cutoff: n+=1
    except Exception:
        pass
print(n)' "$commit_db" 2>/dev/null || echo 0)
        if [ "$stale_count" != "0" ]; then
            emit WARN ea.commit_db_stale "$stale_count commit(s) older than 72h (will never be revealed)" \
                 "Safe to clear: rm $commit_db then restart EA (only if you're past those requests)."
        fi
    else
        # Acceptable if EA hasn't received any commits yet
        emit INFO ea.commit_db "commit DB not created yet" "$commit_db (created on first commit)"
    fi

    # Recent EA activity
    local latest_ea_log
    latest_ea_log=$(ls -t "$INSTALL_DIR/external-adapter/logs/"adapter_*.log 2>/dev/null | head -1)
    if [ -n "$latest_ea_log" ]; then
        local commits reveals_hit reveals_miss errs
        commits=$(safe_grep_count 'COMMIT saved hash=' "$latest_ea_log")
        reveals_hit=$(safe_grep_count 'REVEAL hit' "$latest_ea_log")
        reveals_miss=$(safe_grep_count 'REVEAL miss' "$latest_ea_log")
        errs=$(safe_grep_count '"level":"error"' "$latest_ea_log")
        emit INFO ea.recent_activity "current log: commits=$commits reveals_hit=$reveals_hit reveals_miss=$reveals_miss errors=$errs" "$(basename "$latest_ea_log")"
        if [ "${reveals_miss:-0}" -gt 0 ]; then
            emit WARN ea.recent_reveal_miss "$reveals_miss REVEAL miss(es) in current EA log" \
                 "Usually means commitStore was RAM-only at some point (or commits older than retention); see ea.commit_store_mode."
        else
            emit PASS ea.recent_reveal_miss "no REVEAL misses in current log" ""
        fi
    else
        emit WARN ea.recent_activity "no EA log files found in $INSTALL_DIR/external-adapter/logs" \
             "Verify EA was started via start.sh (which redirects to logs/)"
    fi
}

check_ai_node() {
    section_header "AI NODE"

    if ! port_listening 3000; then
        # Don't emit a duplicate WARN here — svc.ai_node above already FAILed.
        emit INFO ai.skipped "AI Node not running — see svc.ai_node above" ""
        return
    fi

    local health
    health=$(curl -fsS --max-time 5 http://localhost:3000/api/health 2>/dev/null)
    if [ -z "$health" ]; then
        emit FAIL ai.health "/api/health did not respond" "Restart ai-node"
        return
    fi
    local ok mode openrouter
    ok=$(printf '%s' "$health" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status",""))' 2>/dev/null)
    mode=$(printf '%s' "$health" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("ai_gateway",{}).get("mode",""))' 2>/dev/null)
    openrouter=$(printf '%s' "$health" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("ai_gateway",{}).get("openrouterConfigured",""))' 2>/dev/null)

    if [ "$ok" = "ok" ]; then
        emit PASS ai.health "/api/health = ok  (gateway=$mode, openrouter=$openrouter)" ""
    else
        emit WARN ai.health "/api/health returned status='$ok'" ""
    fi

    # Recent error count.
    # Be conservative about what counts as a "real" AI Node error: Next.js logs
    # many bot-scanner-induced 404s as `Error: Failed to find Server Action`,
    # and we don't want those to obscure actual service failures. We match
    # only patterns that indicate genuine runtime trouble.
    local ai_log
    ai_log=$(ls -t "$INSTALL_DIR/ai-node/logs/"ai-node_*.log 2>/dev/null | head -1)
    if [ -n "$ai_log" ]; then
        # Real-error signals (each line is a separate regex alternative).
        # Tail the last 5000 lines first so 2-month-old log files don't
        # dominate the count.
        local errs
        errs=$(tail -5000 "$ai_log" 2>/dev/null \
               | grep -cE '"level":"error"|unhandledRejection|EADDRINUSE|OPENAI_API.*missing|ANTHROPIC_API.*missing|XAI_API.*missing|Cannot find module' \
               2>/dev/null || true)
        errs=${errs:-0}
        if [ "$errs" -lt 5 ]; then
            emit PASS ai.recent_errors "$errs real error line(s) in last 5000 log lines" ""
        elif [ "$errs" -lt 50 ]; then
            emit WARN ai.recent_errors "$errs real error line(s) in last 5000 log lines" \
                 "Inspect: tail $ai_log"
        else
            emit FAIL ai.recent_errors "$errs real error line(s) in last 5000 log lines" \
                 "Inspect: tail $ai_log"
        fi
    fi
}

############################################
# Fix mode
############################################
prompt_yes_no() {
    local prompt="$1"
    [ -t 0 ] || { echo "  (no TTY — refusing material action)"; return 1; }
    local ans
    read -r -p "  ${prompt} [y/N]: " ans
    [[ "$ans" =~ ^[Yy]$ ]]
}

run_fix_mode() {
    section_header "FIX MODE — interactive remediation"
    echo "  Each material command requires y/N confirmation."

    # Walk findings file
    if [ ! -s "$FINDINGS_FILE" ]; then
        echo "  Nothing to fix."
        return
    fi

    while IFS=$'\t' read -r sev id label detail hint; do
        case "$sev" in
            FAIL|CRIT) ;;
            *) continue ;;
        esac
        echo
        echo -e "  ${C_YELLOW}${sev}${C_NC}  ${C_BOLD}${id}${C_NC}  ${detail}"
        [ -n "$hint" ] && echo -e "        ${C_DIM}hint:${C_NC} ${hint}"

        case "$id" in
            chain.node_balance_zero|chain.node_balance)
                local fund_script="$INSTALL_DIR/fund-chainlink-keys.sh"
                if [ -x "$fund_script" ]; then
                    if prompt_yes_no "Run '$fund_script --amount 0.01' to fund node key?"; then
                        "$fund_script" --amount 0.01
                    fi
                else
                    echo "  (no fund-chainlink-keys.sh found at $fund_script — manual step required)"
                fi
                ;;
            chain.is_authorized|chain.authorized_senders_list)
                local setauth="$INSTALL_DIR/arbiter-operator/setAuthorizedSenders-dynamic.sh"
                if [ -x "$setauth" ]; then
                    if prompt_yes_no "Run '$setauth' to authorize the node key on the operator?"; then
                        (cd "$INSTALL_DIR/arbiter-operator" && ./setAuthorizedSenders-dynamic.sh)
                    fi
                else
                    echo "  (no setAuthorizedSenders-dynamic.sh found — manual step required)"
                fi
                ;;
            ea.commit_store_mode)
                local cs_file="$INSTALL_DIR/external-adapter/src/services/commitStore.js"
                if [ -f "$cs_file" ]; then
                    if prompt_yes_no "Patch commitStore.js to USE_FILE=true (in place) and restart EA?"; then
                        sed -i 's/^const[[:space:]]*USE_FILE[[:space:]]*=[[:space:]]*false/const USE_FILE = true/' "$cs_file"
                        echo "  patched."
                        if [ -x "$INSTALL_DIR/external-adapter/stop.sh" ] && [ -x "$INSTALL_DIR/external-adapter/start.sh" ]; then
                            ( cd "$INSTALL_DIR/external-adapter" && ./stop.sh && sleep 2 && ./start.sh )
                            echo "  EA restarted."
                        fi
                    fi
                fi
                ;;
            txm.stuck_unconfirmed|txm.stuck_in_progress|txm.local_nonce_vs_chain)
                cat <<'PROMPT'
  Recommended remediation:
    1) docker stop chainlink
    2) wipe ALL non-final state from evm.txes / evm.tx_attempts
    3) docker start chainlink
  This abandons stale fulfillment attempts (their on-chain requests are
  likely expired already). Final/confirmed txes are preserved.
PROMPT
                if prompt_yes_no "Proceed with stop → wipe → start?"; then
                    docker stop chainlink
                    docker exec cl-postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "
                      BEGIN;
                      DELETE FROM evm.tx_attempts
                       WHERE eth_tx_id IN (SELECT id FROM evm.txes
                                           WHERE state IN ('unconfirmed','in_progress','unstarted','fatal_error'));
                      DELETE FROM evm.txes
                       WHERE state IN ('unconfirmed','in_progress','unstarted','fatal_error');
                      COMMIT;"
                    docker start chainlink
                    echo "  Wipe complete. chainlink will re-sync nonce on startup."
                fi
                ;;
            *)
                echo "  (no automated fix available; address manually using hint above)"
                ;;
        esac
    done < "$FINDINGS_FILE"
}

############################################
# Collect mode
############################################
run_collect_mode() {
    section_header "COLLECT MODE"
    local stage
    stage=$(mktemp -d)
    trap 'rm -rf "$stage"' RETURN
    mkdir -p "$stage/arbiter-diag"
    local out="$stage/arbiter-diag"

    # 1) Doctor report (this run's findings, as text and JSON)
    {
        echo "Verdikta Arbiter Doctor — collected at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "INSTALL_DIR=$INSTALL_DIR"
        echo "NETWORK=$DEPLOYMENT_NETWORK"
        echo ""
        echo "=== Findings ==="
        column -t -s $'\t' < "$FINDINGS_FILE" 2>/dev/null || cat "$FINDINGS_FILE"
    } > "$out/doctor-report.txt"

    # 2) Sanitized configuration: .contracts is fine (contains addresses, no secrets);
    #    .env may contain PRIVATE_KEY and API keys — sanitize.
    [ -f "$CONTRACTS_FILE" ] && cp "$CONTRACTS_FILE" "$out/contracts.snapshot"
    if [ -f "$ENV_FILE" ]; then
        sed -E '
            s/^(PRIVATE_KEY=).*/\1<REDACTED>/i;
            s/^(.*API_KEY=).*/\1<REDACTED>/i;
            s/^(.*SECRET.*=).*/\1<REDACTED>/i;
            s/^(IPFS_PINNING_KEY=).*/\1<REDACTED>/i
        ' "$ENV_FILE" > "$out/env.sanitized"
    fi

    # 3) Component logs (tail N lines of latest)
    mkdir -p "$out/logs"
    local ea_log ai_log
    ea_log=$(ls -t "$INSTALL_DIR/external-adapter/logs/"adapter_*.log 2>/dev/null | head -1)
    ai_log=$(ls -t "$INSTALL_DIR/ai-node/logs/"ai-node_*.log 2>/dev/null | head -1)
    [ -n "$ea_log" ] && tail -5000 "$ea_log" > "$out/logs/adapter.log.tail"
    [ -n "$ai_log" ] && tail -5000 "$ai_log" > "$out/logs/ai-node.log.tail"
    timeout 20 docker logs chainlink --tail 5000 2>&1 > "$out/logs/chainlink.log.tail" || true

    # 4) chainlink DB snapshot (sanitized — drop bodies of signed tx blobs)
    mkdir -p "$out/db"
    if pg_available; then
        pg_query "SELECT id, nonce, state, error, created_at FROM evm.txes ORDER BY id;" \
            > "$out/db/evm_txes.tsv"
        pg_query "SELECT eth_tx_id, state, broadcast_before_block_num, encode(hash,'hex') AS hash FROM evm.tx_attempts ORDER BY eth_tx_id;" \
            > "$out/db/evm_tx_attempts.tsv"
        pg_query "SELECT encode(address,'hex'), evm_chain_id, disabled FROM evm.key_states;" \
            > "$out/db/evm_key_states.tsv"
    fi

    # 5) On-chain snapshot
    if [ -n "$RPC_URL" ] && [ -n "$NODE_ADDRESS" ]; then
        {
            echo "block=$(hex2dec "$(rpc_call eth_blockNumber '[]')")"
            echo "balance=$(rpc_call eth_getBalance "[\"$NODE_ADDRESS\",\"latest\"]")"
            echo "nonce_latest=$(rpc_call eth_getTransactionCount "[\"$NODE_ADDRESS\",\"latest\"]")"
            echo "nonce_pending=$(rpc_call eth_getTransactionCount "[\"$NODE_ADDRESS\",\"pending\"]")"
            echo "operator_code_size=$(echo "$(rpc_call eth_getCode "[\"$OPERATOR_ADDR\",\"latest\"]")" | awk '{print (length($0)-2)/2}')"
        } > "$out/onchain.txt"
    fi

    # 6) Package
    tar -czf "$COLLECT_OUT" -C "$stage" arbiter-diag
    echo "  bundle written to $COLLECT_OUT  ($(du -h "$COLLECT_OUT" | awk '{print $1}'))"
}

############################################
# Summary
############################################
print_summary() {
    [ "$OUTPUT" = "json" ] && return 0

    local total=$((PASS_COUNT + WARN_COUNT + FAIL_COUNT + CRIT_COUNT))
    local color label
    if   [ "$CRIT_COUNT" -gt 0 ]; then color="$C_RED$C_BOLD"; label="CRITICAL"
    elif [ "$FAIL_COUNT" -gt 0 ]; then color="$C_RED";        label="UNHEALTHY"
    elif [ "$WARN_COUNT" -gt 0 ]; then color="$C_YELLOW";     label="HEALTHY (with warnings)"
    else                                color="$C_GREEN";     label="HEALTHY"
    fi

    if [ "$OUTPUT" = "quiet" ] && [ "$WARN_COUNT" = "0" ] && [ "$FAIL_COUNT" = "0" ] && [ "$CRIT_COUNT" = "0" ]; then
        # quiet + nothing wrong: stay silent
        return 0
    fi

    echo
    echo -e "${color}OVERALL: ${label}${C_NC}  (pass=$PASS_COUNT  warn=$WARN_COUNT  fail=$FAIL_COUNT  crit=$CRIT_COUNT  / $total checks)"
}

############################################
# Main
############################################
FINDINGS_FILE=$(mktemp)

discover_config

# Print run banner (skip when --quiet/--json keeps stdout sparse)
if [ "$OUTPUT" = "human" ]; then
    echo -e "${C_BOLD}========================================${C_NC}"
    echo -e "${C_BOLD}Verdikta Arbiter Doctor${C_NC}"
    echo -e "${C_BOLD}========================================${C_NC}"
    echo "host:     $(hostname)"
    echo "install:  $INSTALL_DIR"
    echo "network:  ${DEPLOYMENT_NETWORK:-?}  (chain $CHAIN_ID)"
    echo "rpc:      ${RPC_URL:-?}"
    echo "node key: ${NODE_ADDRESS:-?}"
    echo "operator: ${OPERATOR_ADDR:-?}"
    echo "time:     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

check_config
check_services
check_onchain
check_chainlink_txm
check_external_adapter
check_ai_node

print_summary

# Mode-specific tail action
case "$MODE" in
    fix)     run_fix_mode ;;
    collect) run_collect_mode ;;
esac

# Exit code reflects worst severity seen
if   [ "$CRIT_COUNT" -gt 0 ]; then exit 3
elif [ "$FAIL_COUNT" -gt 0 ]; then exit 2
elif [ "$WARN_COUNT" -gt 0 ]; then exit 1
else exit 0
fi
