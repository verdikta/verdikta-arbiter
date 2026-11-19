#!/bin/bash
# upgrade-arbiter.sh adds the July 2026 finality settings to a Chainlink
# config.toml that predates them (apply-chainlink-finality-tolerance.sh), also
# when the operator declined regenerating the config from the template: the
# regeneration defaults to no, so unattended upgrades never delivered the fix and
# a host installed in May stayed at 0 live RPC nodes (2026-11-09). Default yes,
# unattended too (VA_UPGRADE_CHAINLINK_FINALITY). The upgrade runs under `set -e`
# with an ERR trap that fires on any failing plain command (#97), and `--check`
# exits 1 on every config that still needs the settings, so exit codes must be
# read with `|| rc=$?`. This test runs the script's REAL block under the real
# trap against a stub apply-chainlink-finality-tolerance.sh.
# Run: bash installer/tests/upgrade-finality-tolerance-trap.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/bin/upgrade-arbiter.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

block=$(awk '/^# Finality tolerance \(July 2026 incident, P0-A\)/{p=1} /^# P2-A \(July 2026 incident\): docker log options/{p=0} p{print}' "$S")
[ -n "$block" ] && ok || bad "could not extract the finality block from $S"
echo "$block" | grep -q 'apply-chainlink-finality-tolerance.sh" --check' && ok || bad "block does not read --check"
echo "$block" | grep -q 'apply-chainlink-finality-tolerance.sh" --apply' && ok || bad "block does not call --apply"
grep -qE '^    apply-chainlink-finality-tolerance.sh \\$' "$S" && ok || bad "apply-chainlink-finality-tolerance.sh is not in the _util copy loop"
grep -q 'apply-chainlink-finality-tolerance.sh' "$ROOT/bin/install.sh" && ok || bad "install.sh does not copy apply-chainlink-finality-tolerance.sh"
grep -q 'VA_UPGRADE_CHAINLINK_FINALITY' "$ROOT/bin/validate-answers.sh" && ok || bad "validate-answers.sh does not know VA_UPGRADE_CHAINLINK_FINALITY"
grep -q '^#VA_UPGRADE_CHAINLINK_FINALITY="y"' "$ROOT/config/unattended.env.example" && ok || bad "unattended.env.example does not document VA_UPGRADE_CHAINLINK_FINALITY"

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/util"
cat > "$T/util/apply-chainlink-finality-tolerance.sh" <<'STUB'
#!/bin/bash
case "$1" in
  --check) echo "STUB-CHECK"; exit "${CHECK_RC:-1}" ;;
  --apply) echo "STUB-APPLY-CALLED"; exit "${APPLY_RC:-0}" ;;
  *) echo "STUB: unexpected $*" >&2; exit 99 ;;
esac
STUB
chmod +x "$T/util/apply-chainlink-finality-tolerance.sh"

# run CHECK_RC APPLY_RC UNATTENDED(1|0) [ANSWER] [VA_UPGRADE_CHAINLINK_FINALITY]
run() {
    local answer="${4-}" key="${5:-}"
    printf '%s\n' "$answer" | \
    CHECK_RC="$1" APPLY_RC="$2" VERDIKTA_UNATTENDED="$3" VA_UPGRADE_CHAINLINK_FINALITY="$key" \
    UTIL_DIR="$T/util" TARGET_DIR="$T/install" \
    bash -c '
        set -e
        trap "echo TRAP-FIRED; exit 9" ERR
        [ -z "$VA_UPGRADE_CHAINLINK_FINALITY" ] && unset VA_UPGRADE_CHAINLINK_FINALITY
        source "$1/lib/prompts.sh"
        GREEN= YELLOW= RED= BLUE= NC=
        eval "$2"
        echo "REACHED-END"
    ' _ "$ROOT" "$block" 2>&1
    echo "rc=$?"
}

# 1. Missing (check 1), unattended, no key: applied (the regeneration's "n" does not block it).
out=$(run 1 0 1)
has   "unattended default: apply"       "$out" "STUB-APPLY-CALLED"
has   "unattended default: answered y"  "$out" "(y/n): y  \[unattended: VA_UPGRADE_CHAINLINK_FINALITY\]"
has   "unattended default: why"         "$out" "0 live RPC nodes"
has   "unattended default: finished"    "$out" "REACHED-END"
hasnt "unattended default: trap"        "$out" "TRAP-FIRED"
has   "unattended default: exit 0"      "$out" "rc=0"

# 2. Opted out: not applied, the later command is printed.
out=$(run 1 0 1 "" n)
hasnt "opted out: apply"     "$out" "STUB-APPLY-CALLED"
has   "opted out: later"     "$out" "Apply later with:.*apply-chainlink-finality-tolerance.sh --apply"
has   "opted out: finished"  "$out" "REACHED-END"

# 3. Interactive: Enter is yes; n skips.
out=$(run 1 0 0 "")
has   "interactive Enter: apply" "$out" "STUB-APPLY-CALLED"
out=$(run 1 0 0 "n")
hasnt "interactive n: apply"     "$out" "STUB-APPLY-CALLED"
has   "interactive n: finished"  "$out" "REACHED-END"

# 4. --apply fails (1: rolled back) or refuses (2: layout): warn with the retry, carry on.
for rc in 1 2; do
    out=$(run 1 $rc 1)
    has   "apply $rc: warning"  "$out" "keeps its previous settings (exit $rc)"
    has   "apply $rc: retry"    "$out" "apply-chainlink-finality-tolerance.sh --apply"
    has   "apply $rc: finished" "$out" "REACHED-END"
    hasnt "apply $rc: trap"     "$out" "TRAP-FIRED"
done

# 5. Already set (0): nothing asked. Cannot check (2): a note, nothing asked.
out=$(run 0 0 1)
hasnt "check 0: apply"    "$out" "STUB-APPLY-CALLED"
hasnt "check 0: prompt"   "$out" "VA_UPGRADE_CHAINLINK_FINALITY"
has   "check 0: finished" "$out" "REACHED-END"
out=$(run 2 0 1)
hasnt "check 2: apply"    "$out" "STUB-APPLY-CALLED"
has   "check 2: note"     "$out" "Could not check the Chainlink finality settings"
has   "check 2: finished" "$out" "REACHED-END"
hasnt "check 2: trap"     "$out" "TRAP-FIRED"

# 6. Script absent (an older checkout): skipped.
mv "$T/util/apply-chainlink-finality-tolerance.sh" "$T/off"
out=$(run 1 0 1)
has   "script absent: finished" "$out" "REACHED-END"
hasnt "script absent: prompt"   "$out" "VA_UPGRADE_CHAINLINK_FINALITY"
mv "$T/off" "$T/util/apply-chainlink-finality-tolerance.sh"

# Placement: right after the template regeneration (whatever its answer), before the
# arbiter is restarted, so a stopped Chainlink starts on the new settings.
c=$(grep -nE '^check_chainlink_config( |$)' "$S" | head -1 | cut -d: -f1)
blk=$(grep -n '^# Finality tolerance (July 2026 incident, P0-A)' "$S" | head -1 | cut -d: -f1)
r=$(grep -n 'Do you want to restart the arbiter now' "$S" | head -1 | cut -d: -f1)
{ [ -n "$c" ] && [ -n "$blk" ] && [ -n "$r" ] && [ "$c" -lt "$blk" ] && [ "$blk" -lt "$r" ]; } && ok || bad "block is not between check_chainlink_config (line ${c:-?}) and the restart (line ${r:-?}): line ${blk:-?}"

# The pattern itself.
code=$(echo "$block" | grep -vE '^[[:space:]]*#')
hasnt "no set +e in block"  "$code" "set +e"
has   "check read with ||"  "$block" '--check || CL_FINALITY_CHECK_RC=\$?'
has   "apply read with ||"  "$block" '--apply || CL_FINALITY_RC=\$?'
has   "default is yes"      "$block" '"y" VA_UPGRADE_CHAINLINK_FINALITY; then'

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
