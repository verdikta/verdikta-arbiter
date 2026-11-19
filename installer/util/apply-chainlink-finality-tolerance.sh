#!/bin/bash
#
# Verdikta Arbiter - finality-tolerant RPC liveness for an existing Chainlink config
#
# July 2026 incident (P0-A): Base's `finalized` tag stalls or regresses for the
# whole chain from time to time. With Chainlink's defaults every RPC is then
# marked FinalizedBlockOutOfSync at once -> "No live RPC nodes available" ->
# commit and reveal transactions cannot be broadcast, although new heads keep
# arriving and the provider answers normally. chainlink-node/config_template.toml
# has carried the fix since cde657a:
#   [[EVM]]          NoNewFinalizedHeadsThreshold = '0s'
#   [EVM.NodePool]   EnforceRepeatableRead = false
# but upgrade-arbiter.sh rewrites config.toml from the template only when the
# operator says yes (default no, and unattended upgrades answer no), so nodes
# installed before July kept configs without them (2026-11-09: a single-arbiter
# host stayed at 0 live RPC nodes after upgrading to e6afc6e). This adds or
# corrects just those two settings in the existing config.toml; every other line
# stays as it is.
#
# The config is the one the chainlink container mounts at /chainlink (else
# ~/.chainlink-<NETWORK_TYPE>/config.toml). The edited file is checked by
# Chainlink's own `node validate` (installer/lib/chainlink-config.sh) before it
# is written, and a timestamped backup is kept next to it. A running Chainlink
# is restarted (about a minute), and if it does not stay up on the new file the
# backup is put back and Chainlink started again. A stopped one picks the
# settings up when it next starts.
#
# Usage:
#   apply-chainlink-finality-tolerance.sh --check    # exit 0 both set, 1 missing, 2 cannot check
#   apply-chainlink-finality-tolerance.sh --apply    # exit 0 done or already set, 1 failed, 2 cannot apply
#   apply-chainlink-finality-tolerance.sh            # check, then ask
#   ... --config PATH                                # a config.toml other than the container's
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
CONFIG=""
while [ $# -gt 0 ]; do
    case "$1" in
        --check) MODE="check" ;;
        --apply) MODE="apply" ;;
        --config)
            CONFIG="${2:-}"
            [ -n "$CONFIG" ] || { echo "--config needs a path" >&2; exit 64; }
            shift ;;
        -h|--help) sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 64 ;;
    esac
    shift
done

if ! command -v python3 >/dev/null 2>&1; then
    echo -e "${YELLOW}python3 not found; cannot read the Chainlink config.${NC}"
    exit 2
fi
# installer/lib/chainlink-config.sh: from the install root, or next to installer/util/.
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

[ -n "$CONFIG" ] || CONFIG=$(cl_config_path "$CL" "$SCRIPT_DIR/installer/.env" "$SCRIPT_DIR/../.env")
if [ -z "$CONFIG" ] || [ ! -f "$CONFIG" ]; then
    echo -e "${YELLOW}No Chainlink config.toml found${CONFIG:+ at $CONFIG}; nothing to check.${NC}"
    exit 2
fi

# finality_edit check|fix SRC [DST] — reads the TOML line by line (no TOML library
# on Ubuntu 20.04's Python 3.8), tracking which table each line belongs to. check:
# prints both settings, exit 0 both right / 1 not. fix: writes SRC with the two
# settings added or corrected to DST and prints what changed. Exit 2 (nothing
# written) for a layout it will not guess about: not exactly one [[EVM]], a
# repeated [EVM.NodePool] or setting, or NodePool written as dotted keys.
finality_edit() {
    python3 - "$@" <<'PY'
import os
import re
import sys


# An unreadable file is "cannot check" (2), never "settings missing" (1, which is
# also the exit code of an uncaught exception).
def cannot_read(kind, value, tb):
    print(f"  cannot read {sys.argv[2]}: {value}")
    sys.stdout.flush()
    os._exit(2)


sys.excepthook = cannot_read

mode, src = sys.argv[1], sys.argv[2]
dst = sys.argv[3] if len(sys.argv) > 3 else None
with open(src, encoding="utf-8") as f:
    lines = f.read().splitlines(keepends=True)

HEADER = re.compile(r'^\s*(\[\[|\[)\s*([^\[\]#]+?)\s*(\]\]|\])\s*(#.*)?$')
ZERO = re.compile(r'([\'"])(0+(\.0*)?|\.0+)(ns|us|µs|ms|s|m|h)?\1')


def unsupported(why):
    print(f"  cannot edit {src} automatically: {why}")
    sys.exit(2)


# sections: [header line, end (exclusive), table name, is array-of-tables]
sections = []
for i, line in enumerate(lines):
    m = HEADER.match(line)
    if m:
        name = ".".join(p.strip().strip('"\'') for p in m.group(2).split("."))
        sections.append([i, len(lines), name, m.group(1) == "[["])
for k in range(len(sections) - 1):
    sections[k][1] = sections[k + 1][0]

evm = [s for s in sections if s[2] == "EVM" and s[3]]
if len(evm) != 1:
    unsupported(f"expected one [[EVM]] table, found {len(evm)}")
evm = evm[0]
pools = [s for s in sections if s[2] == "EVM.NodePool" and not s[3]]
if len(pools) > 1:
    unsupported("[EVM.NodePool] appears more than once")
pool = pools[0] if pools else None
if pool and pool[0] < evm[0]:
    unsupported("[EVM.NodePool] comes before [[EVM]]")
if any(re.match(r'\s*NodePool\s*\.', lines[i]) for i in range(evm[0] + 1, evm[1])):
    unsupported("[[EVM]] sets NodePool.* as dotted keys")


def find(sec, key):
    rx = re.compile(r'^(\s*)' + key + r'\s*=\s*(\'[^\']*\'|"[^"]*"|[^\s#]+)\s*(#.*)?$')
    hits = [(i, rx.match(lines[i])) for i in range(sec[0] + 1, sec[1]) if rx.match(lines[i])]
    if len(hits) > 1:
        unsupported(f"{key} is set more than once")
    return hits[0] if hits else None


def last_setting(sec):
    """Index of the section's last key line (or its header): new lines go after it."""
    idx = sec[0]
    for i in range(sec[0] + 1, sec[1]):
        s = lines[i].strip()
        if s and not s.startswith("#"):
            idx = i
    return idx


THR_NOTE = ("# July 2026 incident: a stalled Base `finalized` tag must not take every RPC\n"
            "# out of the pool (added by apply-chainlink-finality-tolerance.sh).\n")
ERR_NOTE = ("# July 2026 incident: a lagging or regressing finalized block must not mark\n"
            "# an RPC out of sync (added by apply-chainlink-finality-tolerance.sh).\n")

thr = find(evm, "NoNewFinalizedHeadsThreshold")
err = find(pool, "EnforceRepeatableRead") if pool else None
thr_ok = thr is not None and ZERO.fullmatch(thr[1].group(2)) is not None
err_ok = err is not None and err[1].group(2) == "false"

if mode == "check":
    print(f"  [[EVM]] NoNewFinalizedHeadsThreshold = {thr[1].group(2) if thr else 'not set (chain default)'}"
          f"  -> {'ok' if thr_ok else 'needs 0s'}")
    print(f"  [EVM.NodePool] EnforceRepeatableRead = {err[1].group(2) if err else 'not set (default true)'}"
          f"  -> {'ok' if err_ok else 'needs false'}")
    sys.exit(0 if thr_ok and err_ok else 1)

replace, insert = {}, {}
if not thr:
    insert.setdefault(last_setting(evm), []).extend([THR_NOTE, "NoNewFinalizedHeadsThreshold = '0s'\n"])
    print("  [[EVM]] NoNewFinalizedHeadsThreshold: added '0s'")
elif not thr_ok:
    replace[thr[0]] = f"{thr[1].group(1)}NoNewFinalizedHeadsThreshold = '0s'\n"
    print(f"  [[EVM]] NoNewFinalizedHeadsThreshold: {thr[1].group(2)} -> '0s'")
if pool is None:
    insert.setdefault(last_setting(evm), []).extend(
        ["\n", "[EVM.NodePool]\n", ERR_NOTE, "EnforceRepeatableRead = false\n"])
    print("  [EVM.NodePool] EnforceRepeatableRead: added false (new [EVM.NodePool] table)")
elif not err:
    insert.setdefault(last_setting(pool), []).extend([ERR_NOTE, "EnforceRepeatableRead = false\n"])
    print("  [EVM.NodePool] EnforceRepeatableRead: added false")
elif not err_ok:
    replace[err[0]] = f"{err[1].group(1)}EnforceRepeatableRead = false\n"
    print(f"  [EVM.NodePool] EnforceRepeatableRead: {err[1].group(2)} -> false")

out = []
for i, line in enumerate(lines):
    line = replace.get(i, line)
    if i in insert and not line.endswith("\n"):
        line += "\n"
    out.append(line)
    out.extend(insert.get(i, []))
with open(dst, "w", encoding="utf-8") as f:
    f.write("".join(out))
PY
}

echo -e "${BLUE}Chainlink finality settings in $CONFIG:${NC}"
check_rc=0
finality_edit check "$CONFIG" || check_rc=$?
if [ "$check_rc" = "0" ]; then
    echo -e "${GREEN}Both finality settings are in place.${NC}"
    exit 0
fi
[ "$check_rc" = "1" ] || exit 2
if [ "$MODE" = "check" ]; then
    exit 1
fi

if [ "$MODE" = "interactive" ]; then
    read -r -p "Add the two settings to $CONFIG? A backup is kept; a running Chainlink is restarted. (y/n): " resp
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
fix_rc=0
finality_edit fix "$CONFIG" "$NEW" || fix_rc=$?
[ "$fix_rc" = "0" ] || exit 2
# Never write a file that would still fail the check (or that lost the [[EVM]] table).
if ! finality_edit check "$NEW" >/dev/null; then
    echo -e "${RED}The edited config does not pass the check; $CONFIG was not changed.${NC}"
    exit 1
fi
validate_rc=0
cl_validate "$CL" "$NEW" || validate_rc=$?
if [ "$validate_rc" = "1" ]; then
    echo -e "${RED}Chainlink rejects the edited config (above); $CONFIG was not changed.${NC}"
    exit 1
elif [ "$validate_rc" = "2" ]; then
    echo -e "${YELLOW}Could not ask Chainlink to validate the edited config; writing it after the structural checks.${NC}"
fi

BACKUP="${CONFIG}.backup.$(date +%Y%m%d-%H%M%S)"
cp -p "$CONFIG" "$BACKUP" || { echo -e "${RED}Could not back up $CONFIG; nothing changed.${NC}"; exit 1; }
# Write through the existing file: it keeps its owner and mode (the chainlink
# container runs as an unprivileged user and must still be able to read it).
cat "$NEW" > "$CONFIG" || { cat "$BACKUP" > "$CONFIG"; echo -e "${RED}Could not write $CONFIG; restored it.${NC}"; exit 1; }
echo -e "${GREEN}✓ Updated $CONFIG (backup: $BACKUP)${NC}"

restart_rc=0
cl_restart_or_restore "$CL" "$CONFIG" "$BACKUP" "$WAIT_SECS" || restart_rc=$?
exit "$restart_rc"
