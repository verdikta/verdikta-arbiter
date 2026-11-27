#!/bin/bash
# upgrade-arbiter.sh runs under `set -e` with `trap cleanup_on_error ERR`. The
# ERR trap fires on any failing plain command whether or not errexit is on, so
# `set +e; cmd; rc=$?; set -e` does NOT protect a command whose non-zero exit
# is the information wanted (#97: the start-at-boot block died that way on the
# first canary upgrade). The job-reconfiguration path (#38 guards, reached with
# VA_UPGRADE_RECONFIGURE_JOBS=y) used the same pattern around unregister-oracle.sh,
# configure-node.sh and register-oracle.sh: a dispatcher call that failed killed
# the upgrade with "Upgrade failed!" instead of reaching the RECONF_ABORT /
# RECONF_FAILED / RECONF_SUMMARY handling that reports "RECONFIGURE FAILED" and
# restarts the node. This test runs the script's REAL reconfiguration block —
# from the deregistration through the registration — under the real trap
# semantics against stub unregister-oracle.sh / configure-node.sh /
# register-oracle.sh that exit non-zero, and checks that the block reaches its
# own failure handling and never fires the trap.
#
# v2 (2026-11-20): a job id is an arbiter key, so a registered node is refused before anything
# changes (an exit locks the stake for 2 days, new ids need a second stake and fresh scores), and
# the block never exits its keys. A node the file calls unregistered but with an aggregator recorded
# gets the exit check first (unregister-oracle.sh with VA_DEREGISTER_ALL_REGISTERED=y: the keeper,
# not the file, decides; from main's #190), is then reconfigured, and registered afterwards only
# when the answers ask for it.
# Run: bash installer/tests/upgrade-reconfigure-trap.test.sh
# UPGRADE_ARBITER_SH=<path> runs it against another copy of the script (e.g. to
# show it fails on the pre-fix version).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="${UPGRADE_ARBITER_SH:-$ROOT/bin/upgrade-arbiter.sh}"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

# The block: from the "Reconfiguration replaces EVERY job id" comment (after the
# Chainlink node has been brought up) to the `fi` that closes the RECONF_RC
# check — the line before the `else` of the "are you sure" prompt.
block=$(awk '/^[[:space:]]*# Reconfiguration replaces EVERY job id/{p=1}
             p && /Job reconfiguration cancelled\. Existing configuration preserved/{exit}
             p {if (have) print prev; prev=$0; have=1}' "$S")
[ -n "$block" ] && ok || bad "could not extract the reconfiguration block from $S"
[ "$(printf '%s\n' "$block" | tail -1 | tr -d ' ')" = "fi" ] && ok || bad "block does not end on the RECONF_RC fi: $(printf '%s\n' "$block" | tail -1)"
printf '%s\n' "$block" | bash -n && ok || bad "block is not a complete shell fragment"
echo "$block" | grep -q 'VA_DEREGISTER_ALL_REGISTERED=y VA_DEREGISTER_ORACLE=y' && ok || bad "block does not run the exit check for a node the file calls unregistered"
echo "$block" | grep -q 'configure-node.sh"' && ok || bad "block does not call configure-node.sh"
echo "$block" | grep -q 'bash register-oracle.sh' && ok || bad "block does not call register-oracle.sh"
# The block calls run_echo_capture (a function; a failing function call fires
# the trap at top level just like a command): take the script's real one.
fn=$(awk '/^run_echo_capture\(\) \{$/{p=1} p{print} p&&/^}$/{exit}' "$S")
[ -n "$fn" ] && ok || bad "could not extract run_echo_capture from $S"

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
I="$T/install"; SRC="$T/src"
mkdir -p "$I/installer" "$SRC/bin"
# The live install: two registered jobs on aggregator 0xAGG, classes 128,5555;
# and the clone's copy that configure-node.sh rewrites (sourced, then copied
# over the live one, after it succeeds — so both are re-created before each run).
contracts() {
    cat > "$I/installer/.contracts" <<EOF
AGGREGATOR_ADDRESS="0xAGG"
CLASSES_ID="128,5555"
AGGREGATOR_REGISTRATION_ACTIVE="${ACTIVE:-true}"
JOB_ID_1="job-one"
JOB_ID_2="job-two"
EOF
    # CONTRACTS_EDIT: a sed expression applied to the live file for one scenario
    # (a registration recorded as inactive, or no aggregator recorded at all).
    if [ -n "${CONTRACTS_EDIT:-}" ]; then sed -i.bak -e "$CONTRACTS_EDIT" "$I/installer/.contracts"; rm -f "$I/installer/.contracts.bak"; fi
    { cat "$I/installer/.contracts"; printf 'KEY_COUNT=1\nKEY_1_ADDRESS="0xKEY"\nOPERATOR_ADDR="0xOP"\n'; } > "$SRC/.contracts"
}
# Stubs. Each exits with the code the scenario sets; the interactive variants
# read the piped answers so the test can see them arrive.
cat > "$I/unregister-oracle.sh" <<'STUB'
#!/bin/bash
echo "STUB-UNREGISTER args=[$*] VA_DEREGISTER_ORACLE=${VA_DEREGISTER_ORACLE:-} agg=${VA_AGGREGATOR_ADDRESS:-} all=${VA_DEREGISTER_ALL_REGISTERED:-}"
if [ "${1:-}" != "--unattended" ]; then read -r a; read -r b; read -r c; echo "STUB-UNREGISTER answers=$a,$b,$c"; fi
echo "✓ Exit requested (tx: 0x01 )"
[ "${DEREG_RC:-0}" = 0 ] && echo "✓ Exit requested (tx: 0x02 )"
# What unregister-oracle-cl.js --all-registered says when the keeper still
# holds a selectable job id of this operator at the end (it exits 1).
[ -n "${DEREG_LEFT:-}" ] && echo "Error during oracle exit: Error: 1 job id(s) of this operator are still registered and not exiting: $DEREG_LEFT. With no node behind them they would still be drawn."
exit "${DEREG_RC:-0}"
STUB
cat > "$SRC/bin/configure-node.sh" <<'STUB'
#!/bin/bash
echo "STUB-CONFIGURE"
exit "${CONF_RC:-0}"
STUB
cat > "$I/register-oracle.sh" <<'STUB'
#!/bin/bash
echo "STUB-REGISTER args=[$*] classes=${VA_CLASS_IDS:-} continue=${VA_REGISTER_CONTINUE_IF_ALREADY:-}"
if [ "${1:-}" != "--unattended" ]; then read -r a; read -r b; read -r c; read -r d; read -r e; echo "STUB-REGISTER answers=$a,$b,$c,$d,$e"; fi
exit "${REG_RC:-0}"
STUB
printf '#!/bin/bash\necho STUB-STOP\n' > "$I/stop-arbiter.sh"
chmod +x "$I"/*.sh "$SRC/bin"/*.sh

# run DEREG_RC CONF_RC REG_RC [VERDIKTA_UNATTENDED] — the block exactly as the
# script runs it: errexit on, the ERR trap armed, the script's run_echo_capture,
# prompts answered unattended (or interactive, with the answers piped in).
# REPO_ROOT has no arbiter-operator, so the key authorization step is skipped.
run() {
    contracts
    DEREG_RC="$1" CONF_RC="$2" REG_RC="$3" VERDIKTA_UNATTENDED="${4-1}" \
    TARGET_DIR="$I" SCRIPT_DIR="$SRC/bin" INSTALLER_DIR="$SRC" REPO_ROOT="$T/no-repo" \
    DEPLOYMENT_NETWORK=base_sepolia \
    bash -c '
        set -e
        trap "echo TRAP-FIRED; exit 9" ERR
        source "$1/lib/prompts.sh"
        GREEN= YELLOW= RED= BLUE= NC=
        eval "$2"
        eval "$3"
        echo "REACHED-END abort=$RECONF_ABORT failed=$RECONF_FAILED rc=$RECONF_RC"
        echo "SUMMARY=$RECONF_SUMMARY"
    ' _ "$ROOT" "$fn" "$block" 2>&1
    echo "rc=$?"
}

# 1. A registered node (unattended): refused before anything changes, reported, never the trap.
out=$(run 1 0 0)
hasnt "registered: no deregistration" "$out" "STUB-UNREGISTER"
hasnt "registered: no configure"      "$out" "STUB-CONFIGURE"
hasnt "registered: no registration"   "$out" "STUB-REGISTER"
has   "registered: says why"          "$out" "second stake"
has   "registered: failed path"       "$out" "Job and key reconfiguration failed!"
has   "registered: node stopped"      "$out" "STUB-STOP"
has   "registered: flags"             "$out" "REACHED-END abort=1 failed=1 rc=1"
has   "registered: summary"           "$out" "SUMMARY=the arbiter count was not changed: this node is registered"
hasnt "registered: trap"              "$out" "TRAP-FIRED"
has   "registered: exit 0"            "$out" "rc=0"

# 2. Same, interactive.
out=$(run 1 0 0 "")
hasnt "registered/tty: no deregistration" "$out" "STUB-UNREGISTER"
has   "registered/tty: flags"             "$out" "REACHED-END abort=1 failed=1 rc=1"
hasnt "registered/tty: trap"              "$out" "TRAP-FIRED"

# 3. Unregistered, configure-node.sh fails: reported with its exit code, the node stopped.
out=$(ACTIVE=false run 0 2 0)
has   "configure-fails: called"   "$out" "STUB-CONFIGURE"
hasnt "configure-fails: register" "$out" "STUB-REGISTER"
has   "configure-fails: failed"   "$out" "Job and key reconfiguration failed!"
has   "configure-fails: stopped"  "$out" "STUB-STOP"
has   "configure-fails: flags"    "$out" "REACHED-END abort=0 failed=1 rc=2"
has   "configure-fails: summary"  "$out" "SUMMARY=creating the new jobs and keys failed (configure-node.sh exit 2)"
hasnt "configure-fails: trap"     "$out" "TRAP-FIRED"

# 4. Unregistered, reconfigured, registration asked for and failing (unattended): the classes are the
#    recorded ones, the failure names the exit code.
out=$(ACTIVE=false VA_REGISTER_ORACLE=y run 0 0 4)
has   "register-fails: called"    "$out" "STUB-REGISTER args=\[--unattended\] classes=128,5555 continue=y"
has   "register-fails: warned"    "$out" "Registration of the new job ids failed"
has   "register-fails: flags"     "$out" "REACHED-END abort=0 failed=1 rc=0"
has   "register-fails: summary"   "$out" "SUMMARY=the new jobs and keys were created but registering them with the dispatcher failed (register-oracle.sh exit 4)"
hasnt "register-fails: trap"      "$out" "TRAP-FIRED"

# 5. Unregistered, everything succeeds, no registration asked for: configured, nothing registered.
out=$(ACTIVE=false run 0 0 0)
has   "ok: exit check ran"        "$out" "STUB-UNREGISTER args=\[--unattended\] VA_DEREGISTER_ORACLE=y agg=0xAGG all=y"
has   "ok: configured"            "$out" "Job and key reconfiguration completed successfully"
hasnt "ok: not registered"        "$out" "STUB-REGISTER"
has   "ok: flags"                 "$out" "REACHED-END abort=0 failed=0 rc=0"
has   "ok: no summary"            "$out" "^SUMMARY=$"
hasnt "ok: trap"                  "$out" "TRAP-FIRED"

# 6. Same, with registration asked for: registered.
out=$(ACTIVE=false VA_REGISTER_ORACLE=y run 0 0 0)
has   "ok+register: registered"   "$out" "New job ids registered with the dispatcher"
has   "ok+register: flags"        "$out" "REACHED-END abort=0 failed=0 rc=0"

# 7. The file says the node is not registered, but an aggregator is recorded: the keeper
#    decides (main's #190, 2026-11-11), so the exit check runs first. When its dispatcher
#    call fails, the jobs are not replaced and the summary says why.
out=$(ACTIVE=false run 1 0 0)
has   "exit-check-fails: called"    "$out" "STUB-UNREGISTER args=\[--unattended\] VA_DEREGISTER_ORACLE=y agg=0xAGG all=y"
has   "exit-check-fails: cancelled" "$out" "The exit check failed. Reconfiguring now could leave a registered key"
hasnt "exit-check-fails: configure" "$out" "STUB-CONFIGURE"
has   "exit-check-fails: failed"    "$out" "Job and key reconfiguration failed!"
has   "exit-check-fails: stopped"   "$out" "STUB-STOP"
has   "exit-check-fails: flags"     "$out" "REACHED-END abort=1 failed=1 rc=1"
has   "exit-check-fails: summary"   "$out" "SUMMARY=requested the exit of 1 job id(s) before the dispatcher call failed"
hasnt "exit-check-fails: trap"      "$out" "TRAP-FIRED"
has   "exit-check-fails: exit 0"    "$out" "rc=0"
#    ...interactive: the answers arrive, every registered id is asked for.
out=$(ACTIVE=false run 1 0 0 "")
has   "exit-check-fails/tty: answers" "$out" "STUB-UNREGISTER answers=y,0xAGG,y"
has   "exit-check-fails/tty: all"     "$out" "STUB-UNREGISTER args=\[\] VA_DEREGISTER_ORACLE= agg= all=y"
has   "exit-check-fails/tty: flags"   "$out" "REACHED-END abort=1 failed=1 rc=1"
hasnt "exit-check-fails/tty: trap"    "$out" "TRAP-FIRED"

# 8. The keeper still holds a selectable job id for this operator that the file does not
#    name (the 2026-11-11 case): unregister-oracle.sh exits 1, the jobs are not replaced.
out=$(ACTIVE=false DEREG_LEFT=old-job run 1 0 0)
has   "left-behind: cancelled"    "$out" "Reconfiguring now could leave a registered key"
hasnt "left-behind: configure"    "$out" "STUB-CONFIGURE"
hasnt "left-behind: register"     "$out" "STUB-REGISTER"
has   "left-behind: flags"        "$out" "REACHED-END abort=1 failed=1 rc=1"
has   "left-behind: summary"      "$out" "SUMMARY=requested the exit of 1 job id(s), but the dispatcher still holds selectable job ids for this operator"
hasnt "left-behind: trap"         "$out" "TRAP-FIRED"

# 9. No aggregator recorded (a node that was never registered): nothing to check, the jobs
#    are reconfigured as before.
out=$(CONTRACTS_EDIT='/^AGGREGATOR_/d' run 0 0 0)
hasnt "never-registered: exit check" "$out" "STUB-UNREGISTER"
has   "never-registered: config"     "$out" "STUB-CONFIGURE"
hasnt "never-registered: register"   "$out" "STUB-REGISTER"
has   "never-registered: flags"      "$out" "REACHED-END abort=0 failed=0 rc=0"
hasnt "never-registered: trap"       "$out" "TRAP-FIRED"

# The pattern itself: the block's code (comments aside) must not rely on
# `set +e` around the three calls.
code=$(echo "$block" | grep -vE '^[[:space:]]*#')
hasnt "no set +e in block"        "$code" "set +e"
has   "configure read with ||"    "$block" 'configure-node.sh" || RECONF_RC=\$?'
has   "register read with ||"     "$block" 'register-oracle.sh --unattended || reg_rc=\$?'

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
