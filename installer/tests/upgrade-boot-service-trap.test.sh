#!/bin/bash
# upgrade-arbiter.sh runs under `set -e` with `trap cleanup_on_error ERR`. The
# ERR trap fires on any failing plain command whether or not errexit is on, so
# `set +e; cmd; rc=$?; set -e` does NOT protect a command whose non-zero exit
# is the information wanted. The start-at-boot block (#97) reads
# `arbiter-boot-service.sh status --quiet`, which exits 1 on every install that
# still needs the fix — and the first canary upgrade died right there with
# "Upgrade failed!" before enabling anything. This test runs the script's REAL
# start-at-boot block under the real trap semantics against a stub
# arbiter-boot-service.sh and checks that it reaches `enable` and carries on.
# Run: bash installer/tests/upgrade-boot-service-trap.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/bin/upgrade-arbiter.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

# The block, from its comment header to the line before the next section.
block=$(awk '/^# Start at boot \(2026-10-18 Contabo reboot wave\)/{p=1} /^# Optional: Fund or top-off Chainlink keys/{p=0} p{print}' "$S")
[ -n "$block" ] && ok || bad "could not extract the start-at-boot block from $S"
echo "$block" | grep -q 'arbiter-boot-service.sh" status --quiet' && ok || bad "block does not read status --quiet"
echo "$block" | grep -q 'arbiter-boot-service.sh" enable' && ok || bad "block does not call enable"

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/install"
# Stub: `status --quiet` exits with $STATUS_RC, `enable` with $ENABLE_RC.
cat > "$T/install/arbiter-boot-service.sh" <<'STUB'
#!/bin/bash
case "$1" in
  status) exit "${STATUS_RC:-1}" ;;
  enable) echo "STUB-ENABLE-CALLED"; exit "${ENABLE_RC:-0}" ;;
  *) echo "STUB: unexpected $*" >&2; exit 99 ;;
esac
STUB
chmod +x "$T/install/arbiter-boot-service.sh"

# run STATUS_RC ENABLE_RC [VA_INSTALL_BOOT_SERVICE] — the block, exactly as the
# script runs it: errexit on, the ERR trap armed, prompts answered unattended.
run() {
    STATUS_RC="$1" ENABLE_RC="$2" VA_INSTALL_BOOT_SERVICE="${3:-y}" \
    VERDIKTA_UNATTENDED=1 TARGET_DIR="$T/install" \
    bash -c '
        set -e
        trap "echo TRAP-FIRED; exit 9" ERR
        source "$1/lib/prompts.sh"
        GREEN= YELLOW= RED= BLUE= NC=
        eval "$2"
        echo "REACHED-END"
    ' _ "$ROOT" "$block" 2>&1
    echo "rc=$?"
}

# 1. Not configured yet (status 1), enable succeeds: the common case on every
#    existing install. Must enable and continue — this is what died on the canary.
out=$(run 1 0)
has   "needs-fix: enable called"  "$out" "STUB-ENABLE-CALLED"
has   "needs-fix: block finished" "$out" "REACHED-END"
hasnt "needs-fix: trap"           "$out" "TRAP-FIRED"
has   "needs-fix: exit 0"         "$out" "rc=0"
has   "needs-fix: answered"       "$out" "VA_INSTALL_BOOT_SERVICE"

# 2. Not configured, enable fails (3 = no root/sudo): warn, tell the operator
#    the command to run, carry on — never "Upgrade failed!".
out=$(run 1 3)
has   "enable-fails: warning"     "$out" "could not enable start-at-boot (exit 3)"
has   "enable-fails: hint"        "$out" "arbiter-boot-service.sh enable"
has   "enable-fails: finished"    "$out" "REACHED-END"
hasnt "enable-fails: trap"        "$out" "TRAP-FIRED"

# 3. No systemd (2): the containers are fixed, the operator is told about init.
out=$(run 1 2)
has   "no-systemd: message"       "$out" "No systemd on this host"
has   "no-systemd: finished"      "$out" "REACHED-END"
hasnt "no-systemd: trap"          "$out" "TRAP-FIRED"

# 4. Already configured (status 0): nothing to ask, nothing to run.
out=$(run 0 0)
hasnt "configured: enable"        "$out" "STUB-ENABLE-CALLED"
hasnt "configured: prompt"        "$out" "VA_INSTALL_BOOT_SERVICE"
has   "configured: finished"      "$out" "REACHED-END"

# 5. Operator says no: skipped with the hint, no enable.
out=$(run 1 0 n)
hasnt "declined: enable"          "$out" "STUB-ENABLE-CALLED"
has   "declined: hint"            "$out" "Enable later with"
has   "declined: finished"        "$out" "REACHED-END"

# The pattern itself: the block's code (comments aside) must not rely on
# `set +e` around the two calls.
code=$(echo "$block" | grep -vE '^[[:space:]]*#')
hasnt "no set +e in block"        "$code" "set +e"
has   "status read with ||"       "$block" 'status --quiet || BOOT_STATUS_RC=\$?'
has   "enable read with ||"       "$block" 'enable || BOOT_SERVICE_RC=\$?'

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
