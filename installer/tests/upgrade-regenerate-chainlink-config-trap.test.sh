#!/bin/bash
# upgrade-arbiter.sh applies chainlink-node/config_template.toml to the node's
# config.toml by default (regenerate-chainlink-config.sh): every checked-in
# Chainlink setting is meant to reach every node, and the old default of "no"
# left a node without the July 2026 finality fix (2026-11-09). Default yes,
# unattended too (VA_UPGRADE_REGENERATE_CHAINLINK_CONFIG); a Verdikta agent
# answers with the owner's decision after showing them --check. RPC changes made
# earlier in the same upgrade are carried in (--rpcs-from-env). The upgrade runs
# under `set -e` with an ERR trap (#97) and `--check` exits 1 whenever there is
# something to apply, so exit codes must be read with `|| rc=$?`. This test runs
# the script's REAL block under the real trap against a stub
# regenerate-chainlink-config.sh.
# Run: bash installer/tests/upgrade-regenerate-chainlink-config-trap.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/bin/upgrade-arbiter.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

block=$(awk '/^# Chainlink config from the template\. Every setting checked in to/{p=1} /^# Finality tolerance \(July 2026 incident, P0-A\)/{p=0} p{print}' "$S")
[ -n "$block" ] && ok || bad "could not extract the template block from $S"
echo "$block" | grep -q '^check_chainlink_config$' && ok || bad "block does not call check_chainlink_config"
grep -qE '^    regenerate-chainlink-config.sh \\$' "$S" && ok || bad "regenerate-chainlink-config.sh is not in the _util copy loop"
grep -q 'regenerate-chainlink-config.sh' "$ROOT/bin/install.sh" && ok || bad "install.sh does not copy regenerate-chainlink-config.sh"
grep -q '^#VA_UPGRADE_REGENERATE_CHAINLINK_CONFIG="y"' "$ROOT/config/unattended.env.example" && ok || bad "unattended.env.example does not document the default y"
# The old inline regeneration (default no, URL lines filtered out of the comparison) is gone.
grep -q 'Would you like to regenerate the config file from the template' "$S" && bad "the old default-no regeneration prompt is still there" || ok

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/util"
cat > "$T/util/regenerate-chainlink-config.sh" <<'STUB'
#!/bin/bash
echo "STUB-ARGS: $*"
case "$1" in
  --check) echo "  [[EVM]] NoNewFinalizedHeadsThreshold: added \"0s\""; exit "${CHECK_RC:-1}" ;;
  --apply) echo "STUB-APPLY-CALLED"; exit "${APPLY_RC:-0}" ;;
  *) echo "STUB: unexpected $*" >&2; exit 99 ;;
esac
STUB
chmod +x "$T/util/regenerate-chainlink-config.sh"

# run CHECK_RC APPLY_RC UNATTENDED(1|0) [ANSWER] [VA_UPGRADE_REGENERATE_CHAINLINK_CONFIG]
run() {
    local answer="${4-}" key="${5:-}"
    printf '%s\n' "$answer" | \
    CHECK_RC="$1" APPLY_RC="$2" VERDIKTA_UNATTENDED="$3" VA_UPGRADE_REGENERATE_CHAINLINK_CONFIG="$key" \
    UTIL_DIR="$T/util" TARGET_DIR="$T/install" RPCS_CHANGED="${RPCS_CHANGED:-false}" \
    bash -c '
        set -e
        trap "echo TRAP-FIRED; exit 9" ERR
        [ -z "$VA_UPGRADE_REGENERATE_CHAINLINK_CONFIG" ] && unset VA_UPGRADE_REGENERATE_CHAINLINK_CONFIG
        source "$1/lib/prompts.sh"
        GREEN= YELLOW= RED= BLUE= NC=
        eval "$2"
        echo "REACHED-END"
    ' _ "$ROOT" "$block" 2>&1
    echo "rc=$?"
}

# 1. Something to apply, unattended, no key: applied (the new default).
out=$(run 1 0 1)
has   "unattended default: listed"     "$out" 'NoNewFinalizedHeadsThreshold: added'
has   "unattended default: apply"      "$out" "STUB-APPLY-CALLED"
has   "unattended default: answered y" "$out" "(y/n): y  \[unattended: VA_UPGRADE_REGENERATE_CHAINLINK_CONFIG\]"
has   "unattended default: target"     "$out" "STUB-ARGS: --apply --target-dir $T/install$"
has   "unattended default: finished"   "$out" "REACHED-END"
hasnt "unattended default: trap"       "$out" "TRAP-FIRED"
has   "unattended default: exit 0"     "$out" "rc=0"

# 2. The owner (or operator) said no: kept, with the command for later.
out=$(run 1 0 1 "" n)
hasnt "declined: apply"    "$out" "STUB-APPLY-CALLED"
has   "declined: later"    "$out" "Apply later with:.*regenerate-chainlink-config.sh --apply"
has   "declined: finished" "$out" "REACHED-END"

# 3. Interactive: Enter is yes; n keeps the file.
out=$(run 1 0 0 "")
has   "interactive Enter: apply" "$out" "STUB-APPLY-CALLED"
out=$(run 1 0 0 "n")
hasnt "interactive n: apply"     "$out" "STUB-APPLY-CALLED"

# 4. RPCs changed earlier in this upgrade: the .env lists go in.
out=$(RPCS_CHANGED=true run 1 0 1)
has   "rpcs changed: check flag" "$out" "STUB-ARGS: --check --target-dir $T/install --rpcs-from-env"
has   "rpcs changed: apply flag" "$out" "STUB-ARGS: --apply --target-dir $T/install --rpcs-from-env"

# 5. --apply refused (1: Chainlink rejected it / rolled back) or could not (2): warn, carry on.
for rc in 1 2; do
    out=$(run 1 $rc 1)
    has   "apply $rc: warning"  "$out" "keeps its previous settings (exit $rc)"
    has   "apply $rc: retry"    "$out" "regenerate-chainlink-config.sh --apply"
    has   "apply $rc: finished" "$out" "REACHED-END"
    hasnt "apply $rc: trap"     "$out" "TRAP-FIRED"
done

# 6. Matches (0): nothing asked. Cannot compare (2): a note, nothing asked.
out=$(run 0 0 1)
hasnt "check 0: apply"    "$out" "STUB-APPLY-CALLED"
hasnt "check 0: prompt"   "$out" "VA_UPGRADE_REGENERATE_CHAINLINK_CONFIG"
has   "check 0: finished" "$out" "REACHED-END"
out=$(run 2 0 1)
hasnt "check 2: apply"    "$out" "STUB-APPLY-CALLED"
has   "check 2: note"     "$out" "Could not compare the Chainlink configuration"
has   "check 2: finished" "$out" "REACHED-END"
hasnt "check 2: trap"     "$out" "TRAP-FIRED"

# 7. Script absent (an older checkout): skipped.
mv "$T/util/regenerate-chainlink-config.sh" "$T/off"
out=$(run 1 0 1)
has   "script absent: note"     "$out" "regenerate-chainlink-config.sh not found"
has   "script absent: finished" "$out" "REACHED-END"
mv "$T/off" "$T/util/regenerate-chainlink-config.sh"

# Placement: before the finality fallback, and before the arbiter is restarted.
c=$(grep -n '^check_chainlink_config$' "$S" | head -1 | cut -d: -f1)
f=$(grep -n '^# Finality tolerance (July 2026 incident, P0-A)' "$S" | head -1 | cut -d: -f1)
r=$(grep -n 'Do you want to restart the arbiter now' "$S" | head -1 | cut -d: -f1)
{ [ -n "$c" ] && [ -n "$f" ] && [ -n "$r" ] && [ "$c" -lt "$f" ] && [ "$f" -lt "$r" ]; } && ok || bad "order is not template (line ${c:-?}) < finality (line ${f:-?}) < restart (line ${r:-?})"

code=$(echo "$block" | grep -vE '^[[:space:]]*#')
hasnt "no set +e in block"  "$code" "set +e"
has   "check read with ||"  "$block" '--check "${flags\[@\]}" || check_rc=\$?'
has   "apply read with ||"  "$block" '--apply "${flags\[@\]}" || apply_rc=\$?'
has   "default is yes"      "$block" '"y" VA_UPGRADE_REGENERATE_CHAINLINK_CONFIG; then'

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
