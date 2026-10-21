#!/bin/bash
# upgrade-arbiter.sh's optional second port-hardening question: recreate the
# chainlink container with 6688 published on 127.0.0.1 only
# (apply-chainlink-loopback.sh). It restarts Chainlink on a live node, so it is a
# separate question from the firewall: interactive default no, UNATTENDED default
# no unless VA_UPGRADE_BIND_CHAINLINK_LOCAL=y. The upgrade runs under `set -e`
# with an ERR trap that fires on any failing plain command (#97), and
# `--check` exits 1 on every install that still publishes 6688 publicly, so the
# exit codes must be read with `|| rc=$?`. This test runs the script's REAL block
# under the real trap against a stub apply-chainlink-loopback.sh.
# Run: bash installer/tests/upgrade-chainlink-loopback-trap.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/bin/upgrade-arbiter.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

block=$(awk '/^# Optional second layer: publish the Chainlink UI\/API/{p=1} /^# Post-upgrade health check\. Best-effort/{p=0} p{print}' "$S")
[ -n "$block" ] && ok || bad "could not extract the loopback block from $S"
echo "$block" | grep -q 'apply-chainlink-loopback.sh" --check' && ok || bad "block does not read --check"
echo "$block" | grep -q 'apply-chainlink-loopback.sh" --apply' && ok || bad "block does not call --apply"
grep -qE '^    apply-chainlink-loopback.sh; do' "$S" && ok || bad "apply-chainlink-loopback.sh is not in the _util copy loop"

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/install"
cat > "$T/install/apply-chainlink-loopback.sh" <<'STUB'
#!/bin/bash
case "$1" in
  --check) echo "STUB-CHECK (6688 published on: 0.0.0.0:6688)"; exit "${CHECK_RC:-1}" ;;
  --apply) echo "STUB-APPLY-CALLED"; exit "${APPLY_RC:-0}" ;;
  *) echo "STUB: unexpected $*" >&2; exit 99 ;;
esac
STUB
chmod +x "$T/install/apply-chainlink-loopback.sh"

# run CHECK_RC APPLY_RC UNATTENDED(1|0) [ANSWER] [VA_UPGRADE_BIND_CHAINLINK_LOCAL]
# SERVICES_STARTED (env, default 1) = SERVICES_STARTED_FOR_DOCTOR: whether the
# upgrade has restarted the arbiter by the time the block runs.
run() {
    local answer="${4-}" key="${5:-}"
    printf '%s\n' "$answer" | \
    CHECK_RC="$1" APPLY_RC="$2" VERDIKTA_UNATTENDED="$3" VA_UPGRADE_BIND_CHAINLINK_LOCAL="$key" TARGET_DIR="$T/install" \
    SERVICES_STARTED_FOR_DOCTOR="${SERVICES_STARTED:-1}" \
    bash -c '
        set -e
        trap "echo TRAP-FIRED; exit 9" ERR
        [ -z "$VA_UPGRADE_BIND_CHAINLINK_LOCAL" ] && unset VA_UPGRADE_BIND_CHAINLINK_LOCAL
        source "$1/lib/prompts.sh"
        GREEN= YELLOW= RED= BLUE= NC=
        eval "$2"
        echo "REACHED-END"
    ' _ "$ROOT" "$block" 2>&1
    echo "rc=$?"
}

# 1. Public (check 1), unattended, no key: NOT recreated (Chainlink is not restarted silently).
out=$(run 1 0 1)
hasnt "unattended default: apply"    "$out" "STUB-APPLY-CALLED"
has   "unattended default: answered no" "$out" "(y/n): n  \[unattended: VA_UPGRADE_BIND_CHAINLINK_LOCAL\]"
has   "unattended default: later hint" "$out" "Do it later with:.*apply-chainlink-loopback.sh --apply"
has   "unattended default: finished" "$out" "REACHED-END"
hasnt "unattended default: trap"     "$out" "TRAP-FIRED"
has   "unattended default: exit 0"   "$out" "rc=0"

# 2. Opted in.
out=$(run 1 0 1 "" y)
has   "opted in: apply called" "$out" "STUB-APPLY-CALLED"
has   "opted in: finished"     "$out" "REACHED-END"
hasnt "opted in: trap"         "$out" "TRAP-FIRED"
out=$(run 1 0 1 "" n)
hasnt "opted out: apply"       "$out" "STUB-APPLY-CALLED"

# 3. Interactive: Enter is no (it restarts Chainlink); y proceeds.
out=$(run 1 0 0 "")
hasnt "interactive Enter: apply" "$out" "STUB-APPLY-CALLED"
has   "interactive Enter: finished" "$out" "REACHED-END"
out=$(run 1 0 0 "y")
has   "interactive y: apply called" "$out" "STUB-APPLY-CALLED"

# 4. The recreate fails or refuses (exit 1): warn with the retry command, carry on.
out=$(run 1 1 1 "" y)
has   "apply fails: warning" "$out" "the chainlink container was not changed (exit 1)"
has   "apply fails: retry"   "$out" "apply-chainlink-loopback.sh --apply"
has   "apply fails: finished" "$out" "REACHED-END"
hasnt "apply fails: trap"    "$out" "TRAP-FIRED"

# 5. Already loopback / unpublished (0) or no container (2): nothing asked.
for rc in 0 2; do
    out=$(run $rc 0 1 "" y)
    hasnt "check $rc: apply"    "$out" "STUB-APPLY-CALLED"
    hasnt "check $rc: prompt"   "$out" "VA_UPGRADE_BIND_CHAINLINK_LOCAL"
    has   "check $rc: finished" "$out" "REACHED-END"
    hasnt "check $rc: trap"     "$out" "TRAP-FIRED"
done

# 5b. The arbiter was not restarted (declined, or never running): the recreate
#     needs a running container, so nothing is asked; the command is printed.
out=$(SERVICES_STARTED=0 run 1 0 1 "" y)
hasnt "not restarted: apply"   "$out" "STUB-APPLY-CALLED"
hasnt "not restarted: prompt"  "$out" "VA_UPGRADE_BIND_CHAINLINK_LOCAL"
has   "not restarted: hint"    "$out" "Once the arbiter is running"
has   "not restarted: command" "$out" "apply-chainlink-loopback.sh --apply"
has   "not restarted: finished" "$out" "REACHED-END"
hasnt "not restarted: trap"    "$out" "TRAP-FIRED"

# 6. Script absent (old install): skipped.
mv "$T/install/apply-chainlink-loopback.sh" "$T/install/off"
out=$(run 1 0 1 "" y)
has   "script absent: finished" "$out" "REACHED-END"
hasnt "script absent: prompt"   "$out" "VA_UPGRADE_BIND_CHAINLINK_LOCAL"
mv "$T/install/off" "$T/install/apply-chainlink-loopback.sh"

# Placement: after the arbiter is restarted, before the post-upgrade health check.
r=$(grep -n 'Do you want to restart the arbiter now' "$S" | head -1 | cut -d: -f1)
blk=$(grep -n '^# Optional second layer: publish the Chainlink UI/API' "$S" | head -1 | cut -d: -f1)
d=$(grep -n '^# Post-upgrade health check\. Best-effort' "$S" | head -1 | cut -d: -f1)
{ [ -n "$r" ] && [ -n "$blk" ] && [ -n "$d" ] && [ "$r" -lt "$blk" ] && [ "$blk" -lt "$d" ]; } && ok || bad "block is not between the restart step (line ${r:-?}) and the health check (line ${d:-?}): line ${blk:-?}"

# The pattern itself.
code=$(echo "$block" | grep -vE '^[[:space:]]*#')
hasnt "no set +e in block"     "$code" "set +e"
has   "check read with ||"     "$block" '--check || CL_LOOPBACK_CHECK_RC=\$?'
has   "apply read with ||"     "$block" '--apply || CL_LOOPBACK_RC=\$?'
has   "default is no"          "$block" 'VA_UPGRADE_BIND_CHAINLINK_LOCAL "n"'

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
