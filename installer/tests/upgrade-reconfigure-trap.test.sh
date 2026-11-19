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
echo "$block" | grep -q 'run_echo_capture bash unregister-oracle.sh' && ok || bad "block does not call unregister-oracle.sh"
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
    cat > "$I/installer/.contracts" <<'EOF'
AGGREGATOR_ADDRESS="0xAGG"
CLASSES_ID="128,5555"
AGGREGATOR_REGISTRATION_ACTIVE="true"
JOB_ID_1="job-one"
JOB_ID_2="job-two"
EOF
    { cat "$I/installer/.contracts"; printf 'KEY_COUNT=1\nKEY_1_ADDRESS="0xKEY"\nOPERATOR_ADDR="0xOP"\n'; } > "$SRC/.contracts"
}
# Stubs. Each exits with the code the scenario sets; the interactive variants
# read the piped answers so the test can see them arrive.
cat > "$I/unregister-oracle.sh" <<'STUB'
#!/bin/bash
echo "STUB-UNREGISTER args=[$*] VA_DEREGISTER_ORACLE=${VA_DEREGISTER_ORACLE:-} agg=${VA_AGGREGATOR_ADDRESS:-}"
if [ "${1:-}" != "--unattended" ]; then read -r a; read -r b; read -r c; echo "STUB-UNREGISTER answers=$a,$b,$c"; fi
echo "Deregistered job-one"
[ "${DEREG_RC:-0}" = 0 ] && echo "Deregistered job-two"
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

# 1. The dispatcher call fails during deregistration (unattended): the block
#    must cancel the reconfiguration itself, count the jobs it did deregister,
#    stop the node it started, and carry on — never "Upgrade failed!".
out=$(run 1 0 0)
has   "dereg-fails: called"       "$out" "STUB-UNREGISTER args=\[--unattended\] VA_DEREGISTER_ORACLE=y agg=0xAGG"
has   "dereg-fails: cancelled"    "$out" "Deregistration failed. Reconfiguring now would strand the stake"
hasnt "dereg-fails: configure"    "$out" "STUB-CONFIGURE"
has   "dereg-fails: failed path"  "$out" "Job and key reconfiguration failed!"
has   "dereg-fails: node stopped" "$out" "STUB-STOP"
has   "dereg-fails: flags"        "$out" "REACHED-END abort=1 failed=1 rc=1"
has   "dereg-fails: summary"      "$out" "SUMMARY=deregistered 1 of 2 job(s) before the dispatcher call failed"
hasnt "dereg-fails: trap"         "$out" "TRAP-FIRED"
has   "dereg-fails: exit 0"       "$out" "rc=0"

# 2. Same, interactive (the here-string twin).
out=$(run 1 0 0 "")
has   "dereg-fails/tty: answers"  "$out" "STUB-UNREGISTER answers=y,0xAGG,y"
has   "dereg-fails/tty: flags"    "$out" "REACHED-END abort=1 failed=1 rc=1"
has   "dereg-fails/tty: summary"  "$out" "SUMMARY=deregistered 1 of 2 job(s)"
hasnt "dereg-fails/tty: trap"     "$out" "TRAP-FIRED"

# 3. Deregistration fine, configure-node.sh fails: reported with its exit code,
#    the node stopped, no registration attempted.
out=$(run 0 2 0)
has   "configure-fails: called"   "$out" "STUB-CONFIGURE"
hasnt "configure-fails: register" "$out" "STUB-REGISTER"
has   "configure-fails: failed"   "$out" "Job and key reconfiguration failed!"
has   "configure-fails: stopped"  "$out" "STUB-STOP"
has   "configure-fails: flags"    "$out" "REACHED-END abort=0 failed=1 rc=2"
has   "configure-fails: summary"  "$out" "SUMMARY=the 2 old job(s) were deregistered (stake refunded) but creating the new jobs and keys failed (configure-node.sh exit 2)"
hasnt "configure-fails: trap"     "$out" "TRAP-FIRED"

# 4. New jobs created, registering them fails (unattended): the classes the
#    registration used are the recorded ones, the failure names the exit code.
out=$(run 0 0 4)
has   "register-fails: called"    "$out" "STUB-REGISTER args=\[--unattended\] classes=128,5555 continue=y"
has   "register-fails: warned"    "$out" "Registration of the new job ids failed"
has   "register-fails: flags"     "$out" "REACHED-END abort=0 failed=1 rc=0"
has   "register-fails: summary"   "$out" "SUMMARY=the new jobs and keys were created but registering them with the dispatcher failed (register-oracle.sh exit 4)"
hasnt "register-fails: trap"      "$out" "TRAP-FIRED"
has   "register-fails: exit 0"    "$out" "rc=0"

# 5. Same, interactive (answers piped into register-oracle.sh).
out=$(run 0 0 4 "")
has   "register-fails/tty: answers" "$out" "STUB-REGISTER answers=y,0xAGG,y,128,5555,y"
has   "register-fails/tty: flags"   "$out" "REACHED-END abort=0 failed=1 rc=0"
hasnt "register-fails/tty: trap"    "$out" "TRAP-FIRED"

# 6. Everything succeeds: deregistered, configured, registered, nothing failed.
out=$(run 0 0 0)
has   "ok: deregistered"          "$out" "Deregistered job-two"
has   "ok: configured"            "$out" "Job and key reconfiguration completed successfully"
has   "ok: registered"            "$out" "New job ids registered with the dispatcher"
has   "ok: flags"                 "$out" "REACHED-END abort=0 failed=0 rc=0"
has   "ok: no summary"            "$out" "^SUMMARY=$"
hasnt "ok: trap"                  "$out" "TRAP-FIRED"

# The pattern itself: the block's code (comments aside) must not rely on
# `set +e` around the three calls.
code=$(echo "$block" | grep -vE '^[[:space:]]*#')
hasnt "no set +e in block"        "$code" "set +e"
has   "dereg read with ||"        "$block" 'unregister-oracle.sh --unattended || dereg_rc=\$?'
has   "configure read with ||"    "$block" 'configure-node.sh" || RECONF_RC=\$?'
has   "register read with ||"     "$block" 'register-oracle.sh --unattended || reg_rc=\$?'

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
