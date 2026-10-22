#!/bin/bash
# After upgrade-arbiter.sh has closed the exposed ports and restarted the arbiter,
# it checks that Chainlink still reaches the External Adapter (arbiter-firewall.sh
# check-bridge --probe): the bridge URL is looked up in Chainlink's database and
# fetched from inside the chainlink container. A failure is a loud warning with
# the undo command, never an abort (the upgrade itself is done). The block runs
# under `set -e` and the ERR trap (#97), so exit codes are read with `|| rc=$?`.
# This test runs the script's REAL block under the real trap against a stub.
# Run: bash installer/tests/upgrade-bridge-check-trap.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/bin/upgrade-arbiter.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

block=$(awk '/^# Verify that Chainlink still reaches the adapter/{p=1} /^# Optional second layer: publish the Chainlink UI\/API/{p=0} /^# Post-upgrade health check\. Best-effort/{p=0} p{print}' "$S")
[ -n "$block" ] && ok || bad "could not extract the bridge-check block from $S"
echo "$block" | grep -q 'check-bridge --probe || BRIDGE_CHECK_RC=\$?' && ok || bad "block does not read check-bridge --probe with ||"
code=$(echo "$block" | grep -vE '^[[:space:]]*#')
echo "$code" | grep -q 'set +e' && bad "block uses set +e" || ok

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/install"
cat > "$T/install/arbiter-firewall.sh" <<'STUB'
#!/bin/bash
case "$1 $2" in
  "check-bridge --probe") echo "STUB-CHECK-BRIDGE-PROBE"; exit "${BRIDGE_RC:-0}" ;;
  *) echo "STUB: unexpected $*" >&2; exit 99 ;;
esac
STUB
chmod +x "$T/install/arbiter-firewall.sh"

# run BRIDGE_RC PORTS_HARDENED SERVICES_STARTED -- the block under errexit + the ERR trap
run() {
    BRIDGE_RC="$1" PORTS_HARDENED="$2" SERVICES_STARTED_FOR_DOCTOR="$3" TARGET_DIR="$T/install" \
    bash -c '
        set -e
        trap "echo TRAP-FIRED; exit 9" ERR
        GREEN= YELLOW= RED= BLUE= NC=
        eval "$1"
        echo "REACHED-END"
    ' _ "$block" 2>&1
    echo "rc=$?"
}

# 1. Ports closed this run, arbiter restarted, bridge fine: probed, nothing alarming.
out=$(run 0 1 1)
has   "ok: probed"          "$out" "STUB-CHECK-BRIDGE-PROBE"
hasnt "ok: no warning"      "$out" "WARNING"
has   "ok: finished"        "$out" "REACHED-END"
hasnt "ok: trap"            "$out" "TRAP-FIRED"

# 2. Chainlink cannot reach the adapter (exit 1): loud warning + the undo command; the upgrade goes on.
out=$(run 1 1 1)
has   "unreachable: warning" "$out" "WARNING: Chainlink could not reach the adapter"
has   "unreachable: undo"    "$out" "arbiter-firewall.sh disable"
has   "unreachable: finished" "$out" "REACHED-END"
hasnt "unreachable: trap"    "$out" "TRAP-FIRED"
has   "unreachable: exit 0"  "$out" "rc=0"

# 3. Could not check (exit 2): say how to check by hand.
out=$(run 2 1 1)
has   "unknown: hint"        "$out" "check-bridge --probe"
hasnt "unknown: not an alarm" "$out" "WARNING"
has   "unknown: finished"    "$out" "REACHED-END"
hasnt "unknown: trap"        "$out" "TRAP-FIRED"

# 4. Nothing to verify: ports not closed this run, or the arbiter was not restarted.
for args in "1 0 1" "1 1 0" "1 0 0"; do
    out=$(run $args)
    hasnt "skipped ($args): probe" "$out" "STUB-CHECK-BRIDGE-PROBE"
    has   "skipped ($args): finished" "$out" "REACHED-END"
done

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
