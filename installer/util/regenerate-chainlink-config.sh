#!/bin/bash
#
# Verdikta Arbiter - bring the Chainlink config.toml up to the checked-in template
#
# Every setting in chainlink-node/config_template.toml is meant to reach every
# node. Until 2026-11 the upgrade rewrote config.toml from it only on a yes
# (default no, and unattended upgrades answered no), so nodes kept whatever
# their install wrote: a host whose config dated from May still lacked the July
# 2026 finality fix and sat at 0 live RPC nodes after upgrading (2026-11-09).
#
# The new file is the template filled with THIS node's own values, so applying
# it changes only what the template changed:
#   - the [[EVM.Nodes]] entries (RPC endpoints) are kept as they are, unless
#     --rpcs-from-env, which builds them from installer/.env's RPC lists (the
#     upgrade passes it when the operator changed the RPCs in that run);
#   - ChainID, TipCapDefault and FeeCapDefault are kept from the current file
#     (the network defaults fill them only when it has none). The scripts that
#     write them have not always agreed (mainnet fee cap 10 vs 20 gwei), and an
#     upgrade must not change a node's gas caps by the back door.
#
# --check prints what would change, setting by setting (URLs cut to their host),
# for the operator or for a Verdikta agent to show the owner before an upgrade:
#   [[EVM]] NoNewFinalizedHeadsThreshold: added "0s"
#   [EVM.NodePool] NewHeadsPollInterval: "30s" -> "8s"
#   [[EVM]] FinalityDepth: removed (was 5)
# Settings the template does not mention are this node's own and stay where
# they are (listed as "kept"; on 2026-11-09 the testnet canaries carried
# [JobPipeline] MaxRunDuration from a branch), except the few the template
# dropped on purpose (RETIRED below: FinalityDepth). Comments, blank lines and
# order are not changes. --apply writes the file only
# after Chainlink's own `node validate` accepts it (installer/lib/chainlink-config.sh),
# keeps a timestamped backup, restarts a running Chainlink and puts the backup
# back if Chainlink does not stay up. A stopped one reads it when it next starts.
#
# Usage:
#   regenerate-chainlink-config.sh --check   # exit 0 matches, 1 would change (listed), 2 cannot compare
#   regenerate-chainlink-config.sh --apply   # exit 0 done or nothing to do, 1 refused/rolled back, 2 cannot
#   regenerate-chainlink-config.sh           # check, then ask
# Options:
#   --target-dir DIR    the installation (installer/.env); default: this script's install root
#   --config PATH       a config.toml other than the one the chainlink container mounts
#   --template PATH     a template other than chainlink-node/config_template.toml next to this script
#   --rpcs-from-env     [[EVM.Nodes]] from installer/.env's RPC lists instead of the current file
#
# Test hooks: VERDIKTA_CHAINLINK_CONTAINER (container name),
# VERDIKTA_CHAINLINK_WAIT_SECS (how long to wait for the API after a restart).
#

set -o pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CL="${VERDIKTA_CHAINLINK_CONTAINER:-chainlink}"
WAIT_SECS="${VERDIKTA_CHAINLINK_WAIT_SECS:-120}"
MODE="interactive"
TARGET_DIR=""
CONFIG=""
TEMPLATE=""
RPCS_FROM_ENV=0
while [ $# -gt 0 ]; do
    case "$1" in
        --check) MODE="check" ;;
        --apply) MODE="apply" ;;
        --rpcs-from-env) RPCS_FROM_ENV=1 ;;
        --target-dir|--config|--template)
            [ -n "${2:-}" ] || { echo "$1 needs a path" >&2; exit 64; }
            case "$1" in
                --target-dir) TARGET_DIR="$2" ;;
                --config) CONFIG="$2" ;;
                --template) TEMPLATE="$2" ;;
            esac
            shift ;;
        -h|--help) sed -n '2,47p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 64 ;;
    esac
    shift
done

if ! command -v python3 >/dev/null 2>&1; then
    echo -e "${YELLOW}python3 not found; cannot compare the Chainlink config.${NC}"
    exit 2
fi
CL_LIB=""
for cand in "$SCRIPT_DIR/installer/lib/chainlink-config.sh" "$SCRIPT_DIR/../lib/chainlink-config.sh"; do
    [ -f "$cand" ] && { CL_LIB="$cand"; break; }
done
if [ -z "$CL_LIB" ]; then
    echo -e "${YELLOW}installer/lib/chainlink-config.sh not found next to this script; upgrade the installation first.${NC}"
    exit 2
fi
# shellcheck source=../lib/chainlink-config.sh
. "$CL_LIB"

# The installation: this script's install root when it runs from there.
if [ -z "$TARGET_DIR" ] && [ -f "$SCRIPT_DIR/installer/.env" ]; then
    TARGET_DIR="$SCRIPT_DIR"
fi
ENV_FILE="${TARGET_DIR:+$TARGET_DIR/installer/.env}"

# The template: the install root's chainlink-node/, else the one two levels up
# from installer/util/ (the repository, or the install's installer/util copy).
# Never further up, and only a file with the nodes placeholder (the same rule as
# update-rpc-endpoints.sh: a stray template once took a node down).
if [ -z "$TEMPLATE" ]; then
    for cand in "$SCRIPT_DIR/chainlink-node/config_template.toml" "$SCRIPT_DIR/../../chainlink-node/config_template.toml"; do
        if [ -f "$cand" ] && grep -q '<EVM_NODES_BLOCK>' "$cand"; then
            TEMPLATE="$(cd "$(dirname "$cand")" && pwd)/$(basename "$cand")"
            break
        fi
    done
fi
if [ -z "$TEMPLATE" ] || [ ! -f "$TEMPLATE" ]; then
    echo -e "${YELLOW}chainlink-node/config_template.toml not found; nothing to compare with.${NC}"
    exit 2
fi

[ -n "$CONFIG" ] || CONFIG=$(cl_config_path "$CL" ${ENV_FILE:+"$ENV_FILE"})
if [ -z "$CONFIG" ] || [ ! -f "$CONFIG" ]; then
    echo -e "${YELLOW}No Chainlink config.toml found${CONFIG:+ at $CONFIG}; nothing to compare.${NC}"
    exit 2
fi

# Network defaults (used only for values the current file does not have) and,
# with --rpcs-from-env, the RPC lists. Read in a subshell: .env is shell.
env_value() {
    [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] || return 0
    ( set +u; . "$ENV_FILE" >/dev/null 2>&1; eval "printf '%s' \"\${$1:-}\"" )
}
DEPLOYMENT_NETWORK=$(env_value DEPLOYMENT_NETWORK)
if [ "$DEPLOYMENT_NETWORK" = "base_mainnet" ]; then
    export CL_DEFAULT_CHAIN_ID="8453" CL_DEFAULT_TIP_CAP="1 gwei" CL_DEFAULT_FEE_CAP="20 gwei"
    rpc_http=$(env_value BASE_MAINNET_RPC_HTTP_URLS); rpc_ws=$(env_value BASE_MAINNET_RPC_WS_URLS)
else
    export CL_DEFAULT_CHAIN_ID="84532" CL_DEFAULT_TIP_CAP="2 gwei" CL_DEFAULT_FEE_CAP="30 gwei"
    rpc_http=$(env_value BASE_SEPOLIA_RPC_HTTP_URLS); rpc_ws=$(env_value BASE_SEPOLIA_RPC_WS_URLS)
fi
CL_NETWORK_NAME=$(env_value NETWORK_NAME)
export CL_NETWORK_NAME="${CL_NETWORK_NAME:-Base}"
export CL_ENV_NODES=""
if [ "$RPCS_FROM_ENV" = "1" ]; then
    rpc_http="$(echo "$rpc_http" | tr -d ' ' | sed 's/;*$//')"
    rpc_ws="$(echo "$rpc_ws" | tr -d ' ' | sed 's/;*$//')"
    IFS=';' read -r -a http_urls <<< "$rpc_http"
    IFS=';' read -r -a ws_urls <<< "$rpc_ws"
    if [ -z "$rpc_http" ] || [ -z "$rpc_ws" ] || [ "${#http_urls[@]}" -ne "${#ws_urls[@]}" ]; then
        echo -e "${YELLOW}--rpcs-from-env: installer/.env has no matching HTTP and WS RPC lists for ${DEPLOYMENT_NETWORK:-this network}.${NC}"
        exit 2
    fi
    for i in "${!http_urls[@]}"; do
        if [ -z "${http_urls[$i]}" ] || [ -z "${ws_urls[$i]}" ]; then
            echo -e "${YELLOW}--rpcs-from-env: the RPC lists in installer/.env contain an empty entry.${NC}"
            exit 2
        fi
        CL_ENV_NODES="${CL_ENV_NODES}[[EVM.Nodes]]
Name=\"${CL_NETWORK_NAME}-$((i + 1))\"
WSURL=\"${ws_urls[$i]}\"
HTTPURL=\"${http_urls[$i]}\"

"
    done
fi

# regen check|write TEMPLATE CONFIG [OUT] — line-based TOML (no TOML library on
# Ubuntu 20.04's Python 3.8). Builds the template filled with the node's own
# values, plus the settings the template does not mention (kept where they
# were, by table); check: prints the settings that would change and the ones
# kept, exit 0 no change / 1 some; write: writes the new file to OUT. Exit 2
# when it cannot (not exactly one [[EVM]], no RPC entries to keep, a
# placeholder it cannot fill, a kept setting it cannot place, unreadable file).
regen() {
    python3 - "$@" <<'PY'
import os
import re
import sys


def cannot(msg):
    print(f"  {msg}")
    sys.stdout.flush()
    os._exit(2)


# Uncaught exceptions exit 1, which means "would change": make them "cannot".
sys.excepthook = lambda kind, value, tb: cannot(f"cannot read the files: {value}")

mode, template_path, config_path = sys.argv[1:4]
out_path = sys.argv[4] if len(sys.argv) > 4 else None
with open(template_path, encoding="utf-8") as f:
    template = f.read()
with open(config_path, encoding="utf-8") as f:
    current = f.read()

HEADER = re.compile(r'^\s*(\[\[|\[)\s*([^\[\]#]+?)\s*(\]\]|\])\s*(#.*)?$')
KV = re.compile(r'^\s*([A-Za-z0-9_\-]+)\s*=\s*(.*?)\s*$')


def value_of(raw):
    """The value without a trailing comment; '...' and "..." compare equal."""
    out, quote = [], None
    for ch in raw:
        if quote:
            out.append(ch)
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
            out.append(ch)
        elif ch == "#":
            break
        else:
            out.append(ch)
    v = "".join(out).strip()
    if len(v) >= 2 and v[0] == v[-1] == "'":
        v = '"' + v[1:-1] + '"'
    return v


def unquote(v):
    return v[1:-1] if len(v) >= 2 and v[0] == v[-1] == '"' else v


# Settings the template once wrote and later dropped on purpose: removed when found.
# Everything else the template does not mention is the node's own and is kept.
RETIRED = {
    ("EVM#1", "FinalityDepth"): "inert since the July 2026 finality fix (cde657a)",
}


def table_name(m, counts):
    name = ".".join(p.strip().strip("\"'") for p in m.group(2).split("."))
    if m.group(1) == "[[":
        counts[name] = counts.get(name, 0) + 1
        name = f"{name}#{counts[name]}"
    return name


def parse(text):
    """[(table, key, value, line)] in file order; array-of-tables entries are numbered (EVM.Nodes#2)."""
    table, counts, out = "", {}, []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        m = HEADER.match(line)
        if m:
            table = table_name(m, counts)
            continue
        kv = KV.match(line)
        if kv:
            out.append((table, kv.group(1), value_of(kv.group(2)), line.strip()))
    return out, counts


def node_blocks(text):
    """Each [[EVM.Nodes]] entry verbatim: its header to the next header, trailing blanks dropped."""
    blocks, cur = [], None
    for line in text.splitlines():
        m = HEADER.match(line)
        if m:
            if cur is not None:
                blocks.append(cur)
                cur = None
            name = ".".join(p.strip().strip("\"'") for p in m.group(2).split("."))
            if m.group(1) == "[[" and name == "EVM.Nodes":
                cur = [line]
            continue
        if cur is not None:
            cur.append(line)
    if cur is not None:
        blocks.append(cur)
    out = []
    for b in blocks:
        while b and not b[-1].strip():
            b.pop()
        out.append("\n".join(b) + "\n")
    return out


def keep_own(text, own):
    """Adds the node's own settings [(table, line)] to TEXT, each after the last
    setting of its table; a table the template lacks is appended."""
    lines = text.splitlines()
    sections, counts, cur_name = {}, {}, ""
    sections[""] = [-1, -1]          # top level: before the first header
    for i, line in enumerate(lines):
        m = HEADER.match(line)
        if m:
            cur_name = table_name(m, counts)
            sections[cur_name] = [i, i]
            continue
        s = line.strip()
        if s and not s.startswith("#"):
            sections[cur_name][1] = i
    insert, tail = {}, []
    for t, line in own:
        if t in sections:
            insert.setdefault(sections[t][1], []).append(line)
        elif "#" in t:
            cannot(f"this node's {t.split('#')[0]} entry has no counterpart in the template; regenerate by hand")
        else:
            if not tail or tail[-1][0] != t:
                tail.append((t, []))
            tail[-1][1].append(line)
    out = insert.get(-1, [])
    for i, line in enumerate(lines):
        out.append(line)
        out.extend(insert.get(i, []))
    for t, kept in tail:
        out.extend(["", f"[{t}]"] + kept)
    return "\n".join(out) + "\n"


cur_items, cur_counts = parse(current)
if cur_counts.get("EVM", 0) != 1:
    cannot(f"{config_path} has {cur_counts.get('EVM', 0)} [[EVM]] tables; only a single-chain config can be regenerated")
cur = {(t, k): v for t, k, v, _ in cur_items}

env_nodes = os.environ.get("CL_ENV_NODES", "")
if env_nodes:
    nodes = env_nodes.rstrip() + "\n"
    expected_nodes = env_nodes.count("[[EVM.Nodes]]")
else:
    blocks = node_blocks(current)
    if not blocks:
        cannot(f"{config_path} has no [[EVM.Nodes]] entries to keep; use --rpcs-from-env (installer/.env's RPC lists)")
    nodes = "\n".join(blocks)
    expected_nodes = len(blocks)

fill = {
    "<CHAIN_ID>": unquote(cur.get(("EVM#1", "ChainID"), "")) or os.environ["CL_DEFAULT_CHAIN_ID"],
    "<TIP_CAP_DEFAULT>": unquote(cur.get(("EVM.GasEstimator", "TipCapDefault"), "")) or os.environ["CL_DEFAULT_TIP_CAP"],
    "<FEE_CAP_DEFAULT>": unquote(cur.get(("EVM.GasEstimator", "FeeCapDefault"), "")) or os.environ["CL_DEFAULT_FEE_CAP"],
    "<NETWORK_NAME>": os.environ.get("CL_NETWORK_NAME", "Base"),
}
new_text = template
for k, v in fill.items():
    new_text = new_text.replace(k, v)
# Checked before the RPC entries go in: those are the node's own and may contain anything.
left = sorted(set(re.findall(r"<[A-Z_]+>", new_text)) - {"<EVM_NODES_BLOCK>"})
if left:
    cannot(f"the template has placeholders this script does not fill: {' '.join(left)}")
new_text = new_text.replace("<EVM_NODES_BLOCK>", nodes)

tmpl_items, _ = parse(new_text)
tmpl = {(t, k) for t, k, _, _ in tmpl_items}
own = [(t, k, v, line) for t, k, v, line in cur_items
       if (t, k) not in tmpl and (t, k) not in RETIRED and not t.startswith("EVM.Nodes#")]
retired = [(t, k, v) for t, k, v, _ in cur_items if (t, k) in RETIRED]
new_text = keep_own(new_text, [(t, line) for t, _, _, line in own])

new_items, new_counts = parse(new_text)
new = {(t, k): v for t, k, v, _ in new_items}
if new_counts.get("EVM", 0) != 1 or new_counts.get("EVM.Nodes", 0) != expected_nodes:
    cannot(f"the regenerated file has {new_counts.get('EVM', 0)} [[EVM]] and {new_counts.get('EVM.Nodes', 0)} "
           f"[[EVM.Nodes]] entries (expected 1 and {expected_nodes}); not writing it")
if any(new.get((t, k)) != v for t, k, v, _ in own):
    cannot("could not keep this node's own settings in the regenerated file; not writing it")

if mode == "write":
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(new_text)
    sys.exit(0)


def show_table(t):
    if "#" in t:
        name, n = t.split("#")
        return f"[[{name}]]" + (f" #{n}" if name == "EVM.Nodes" else "")
    return f"[{t}]" if t else "(top level)"


def show_value(v):
    return re.sub(r"((?:wss?|https?)://[^/\"' ]+)[^\"' ]*", r"\1/…", v)


changes = []
for t, k, v, _ in new_items:
    if (t, k) not in cur:
        changes.append(f"  {show_table(t)} {k}: added {show_value(v)}")
    elif cur[(t, k)] != v:
        changes.append(f"  {show_table(t)} {k}: {show_value(cur[(t, k)])} -> {show_value(v)}")
for t, k, v in retired:
    changes.append(f"  {show_table(t)} {k}: removed (was {show_value(v)}; {RETIRED[(t, k)]})")
for line in changes:
    print(line)
for t, k, v, _ in own:
    print(f"  {show_table(t)} {k}: kept {show_value(v)} (this node's own; the template does not set it)")
sys.exit(1 if changes else 0)
PY
}

echo -e "${BLUE}Chainlink config $CONFIG"
echo -e "  compared with $TEMPLATE (RPC endpoints: $([ "$RPCS_FROM_ENV" = "1" ] && echo "from installer/.env" || echo "kept as they are")):${NC}"
check_rc=0
regen check "$TEMPLATE" "$CONFIG" || check_rc=$?
if [ "$check_rc" = "0" ]; then
    echo -e "${GREEN}The Chainlink config matches the template.${NC}"
    exit 0
fi
[ "$check_rc" = "1" ] || exit 2
if [ "$MODE" = "check" ]; then
    exit 1
fi
if [ "$MODE" = "interactive" ]; then
    read -r -p "Apply these changes to $CONFIG? A backup is kept; a running Chainlink is restarted. (y/n): " resp
    case "$resp" in
        [Yy]*) ;;
        *) echo "No changes made."; exit 1 ;;
    esac
fi

# The candidate sits next to the live file, with its mode and owner: that is the
# directory Chainlink's validator mounts, and its user must be able to read it.
NEW="$(dirname "$CONFIG")/.config.toml.candidate.$$"
trap 'rm -f "$NEW"' EXIT
cp -p "$CONFIG" "$NEW" || { echo -e "${RED}Could not write next to $CONFIG; nothing changed.${NC}"; exit 1; }
write_rc=0
regen write "$TEMPLATE" "$CONFIG" "$NEW" || write_rc=$?
[ "$write_rc" = "0" ] || exit 2
validate_rc=0
cl_validate "$CL" "$NEW" || validate_rc=$?
if [ "$validate_rc" = "1" ]; then
    echo -e "${RED}Chainlink rejects the regenerated config (above); $CONFIG was not changed.${NC}"
    exit 1
elif [ "$validate_rc" = "2" ]; then
    echo -e "${YELLOW}Could not ask Chainlink to validate the regenerated config; writing it after the structural checks.${NC}"
fi

BACKUP="${CONFIG}.backup.$(date +%Y%m%d-%H%M%S)"
cp -p "$CONFIG" "$BACKUP" || { echo -e "${RED}Could not back up $CONFIG; nothing changed.${NC}"; exit 1; }
# Write through the existing file: it keeps its owner and mode.
cat "$NEW" > "$CONFIG" || { cat "$BACKUP" > "$CONFIG"; echo -e "${RED}Could not write $CONFIG; restored it.${NC}"; exit 1; }
echo -e "${GREEN}✓ Chainlink config regenerated from the template (backup: $BACKUP)${NC}"

restart_rc=0
cl_restart_or_restore "$CL" "$CONFIG" "$BACKUP" "$WAIT_SECS" || restart_rc=$?
exit "$restart_rc"
