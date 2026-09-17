#!/bin/bash
# Pins for the job-reconfiguration path of installer/bin/upgrade-arbiter.sh (issue #38):
# the script runs under `set -e`, so every dispatcher/installer call whose failure
# must reach an `if [ $? … ]` check has to be wrapped in `set +e` … `set -e`,
# a failed reconfiguration must be reported on the last line with exit 3, and
# the error trap must restart an arbiter that was running before the attempt.
# These are static pins (the upgrade cannot run in a unit test); the JS retry
# is covered by arbiter-operator/scripts/lib/inflight.test.js.
# Run: bash installer/tests/upgrade-reconfigure-guards.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/bin/upgrade-arbiter.sh"
pass=0; fail=0
check() { # check NAME PATTERN [MIN_COUNT]
    local n; n=$(grep -cE -- "$2" "$S")
    if [ "$n" -ge "${3:-1}" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $1: expected /$2/ x${3:-1}, found $n"; fi
}
bash -n "$S" && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL syntax"; }
# The script really is errexit (the reason the guards exist).
check "errexit on" '^set -e'
# Deregistration: guarded, its rc captured, its output counted.
check "dereg guarded" 'set \+e' 3
check "dereg rc" 'bash unregister-oracle.sh --unattended 2>&1 \| tee /dev/stderr \); dereg_rc=\$\?'
check "dereg pipefail" 'set -o pipefail; VA_DEREGISTER_ORACLE=y'
check "dereg count" 'RECONF_DEREGISTERED=\$\(printf'
check "dereg abort sets failed" 'RECONF_ABORT=1' 
check "dereg summary" 'RECONF_SUMMARY="deregistered \$RECONF_DEREGISTERED of \$RECONF_TOTAL job'
# configure-node and registration: guarded with their rc captured.
check "configure guarded" 'bash "\$SCRIPT_DIR/configure-node.sh"' 
check "configure rc" 'RECONF_RC=\$\?'
check "register rc" 'reg_rc=\$\?'
check "register summary" 'RECONF_SUMMARY="the new jobs and keys were created but registering them'
# Every guard is closed again (as many set -e as set +e, plus the header).
plus=$(grep -cE '^\s*set \+e\s*$' "$S"); minus=$(grep -cE '^\s*set -e(\s|$)' "$S")
[ "$minus" -eq $((plus+1)) ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL guard balance: set +e=$plus set -e=$minus"; }
# The failure is the LAST thing the script says, with exit 3.
tail -6 "$S" | grep -q 'RECONFIGURE FAILED: \${RECONF_SUMMARY}' && tail -6 "$S" | grep -qE '^\s*exit 3\s*$' && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL final exit 3"; }
# The error trap restarts a node that was running before the attempt.
awk '/^cleanup_on_error\(\)/,/^}/' "$S" | grep -q 'bash "\$TARGET_DIR/start-arbiter.sh" ||' && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL trap restart"; }
echo "pass=$pass fail=$fail"
[ "$fail" = "0" ]
