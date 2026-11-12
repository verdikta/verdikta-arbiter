#!/bin/bash
# upgrade-arbiter.sh, "regenerate the job specifications from the updated
# template" (VA_UPGRADE_REGENERATE_JOBS=y): every job gets a new id, so the
# old ids must be deregistered first or their stake stays on the dispatcher
# with no node behind it. The step used to pipe "y" into unregister-oracle.sh
# and carry on whatever came back:
#   - unattended, the pipe is ignored and VA_DEREGISTER_ORACLE was not set, so
#     the script answered its own "Unregister from dispatcher?" with "no",
#     exited 0, and the upgrade printed "Successfully unregistered" and went on
#     to create and register new ids;
#   - a deregistration that failed fired the ERR trap ("Upgrade failed!").
# This test runs the script's REAL regenerate_job_specs under the real trap
# semantics against stubs, and checks: the deregistration is asked for every
# job id of the operator (VA_DEREGISTER_ALL_REGISTERED=y), with the copies of
# the scripts this checkout ships; a failure leaves the job specs alone,
# reports it, and never fires the trap.
# Run: bash installer/tests/upgrade-regenerate-jobs-trap.test.sh
# UPGRADE_ARBITER_SH=<path> runs it against another copy of the script.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="${UPGRADE_ARBITER_SH:-$ROOT/bin/upgrade-arbiter.sh}"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

fn=$(awk '/^regenerate_job_specs\(\) \{$/{p=1} p{print} p&&/^}$/{exit}' "$S")
[ -n "$fn" ] && ok || bad "could not extract regenerate_job_specs from $S"
printf '%s\n' "$fn" | bash -n && ok || bad "regenerate_job_specs is not a complete function"
# The caller's three lines, as the script has them.
caller=$(awk '/^[[:space:]]*REGEN_ABORTED=0$/{p=1} p{print} p&&/JOBS_ALREADY_REGENERATED=1/{exit}' "$S")
[ -n "$caller" ] || caller=$'regenerate_job_specs\nJOBS_ALREADY_REGENERATED=1'   # the pre-fix script

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
I="$T/install"; REPO="$T/repo"; SRC="$REPO/installer"
setup() {
    rm -rf "$I" "$REPO"
    mkdir -p "$I/installer/lib" "$I/arbiter-operator/scripts" "$SRC/bin" "$SRC/util" "$SRC/lib" "$REPO/arbiter-operator/scripts/lib" "$T/bin"
    printf 'AGGREGATOR_ADDRESS="0xAGG"\nCLASSES_ID="128,5555"\nJOB_ID_1="job-one"\n' > "$I/installer/.contracts"
    cp "$I/installer/.contracts" "$SRC/.contracts"
    # The install's copy predates the fix; the checkout's is the one that must run.
    printf '#!/bin/bash\necho "OLD-UNREGISTER (the install'"'"'s stale copy ran)"\nexit 0\n' > "$I/unregister-oracle.sh"
    cat > "$SRC/util/unregister-oracle.sh" <<'STUB'
#!/bin/bash
echo "STUB-UNREGISTER args=[$*] VA_DEREGISTER_ORACLE=${VA_DEREGISTER_ORACLE:-} agg=${VA_AGGREGATOR_ADDRESS:-} all=${VA_DEREGISTER_ALL_REGISTERED:-}"
if [ "${1:-}" != "--unattended" ]; then read -r a; read -r b; read -r c; echo "STUB-UNREGISTER answers=$a,$b,$c"; fi
exit "${DEREG_RC:-0}"
STUB
    echo '// new' > "$REPO/arbiter-operator/scripts/unregister-oracle-cl.js"
    echo '// new' > "$REPO/arbiter-operator/scripts/lib/registry.js"
    echo '// old' > "$I/arbiter-operator/scripts/unregister-oracle-cl.js"
    cp "$ROOT/lib/prompts.sh" "$SRC/lib/prompts.sh"
    printf '#!/bin/bash\necho STUB-CONFIGURE\nexit 0\n' > "$SRC/bin/configure-node.sh"
    printf '#!/bin/bash\necho "STUB-REGISTER classes=${VA_CLASS_IDS:-}"\nexit 0\n' > "$I/register-oracle.sh"
    # `docker ps` shows a running chainlink, so the function does not try to start one.
    printf '#!/bin/bash\necho "abc123  smartcontract/chainlink  Up 3 hours  chainlink"\n' > "$T/bin/docker"
    chmod +x "$I"/*.sh "$SRC/bin"/*.sh "$SRC/util"/*.sh "$T/bin/docker"
}
# run DEREG_RC [VERDIKTA_UNATTENDED] — errexit on, the ERR trap armed.
run() {
    setup
    DEREG_RC="$1" VERDIKTA_UNATTENDED="${2-1}" PATH="$T/bin:$PATH" \
    TARGET_DIR="$I" SCRIPT_DIR="$SRC/bin" INSTALLER_DIR="$SRC" UTIL_DIR="$SRC/util" REPO_ROOT="$REPO" \
    bash -c '
        set -e
        trap "echo TRAP-FIRED; exit 9" ERR
        source "$1/lib/prompts.sh"
        GREEN= YELLOW= RED= BLUE= NC=
        JOBS_ALREADY_REGENERATED=0
        eval "$2"
        eval "$3"
        echo "REACHED-END regenerated=$JOBS_ALREADY_REGENERATED aborted=${REGEN_ABORTED:-} failed=${RECONF_FAILED:-0}"
        echo "SUMMARY=${RECONF_SUMMARY:-}"
    ' _ "$ROOT" "$fn" "$caller" 2>&1
    echo "rc=$?"
}

# 1. Unattended, deregistration succeeds: it was really asked for
#    (VA_DEREGISTER_ORACLE=y — without it the script cancels and exits 0), for
#    every job id of the operator, with this checkout's scripts.
out=$(run 0)
has   "ok: asked, all ids"   "$out" "STUB-UNREGISTER args=\[--unattended\] VA_DEREGISTER_ORACLE=y agg=0xAGG all=y"
hasnt "ok: stale copy"       "$out" "OLD-UNREGISTER"
has   "ok: configured"       "$out" "STUB-CONFIGURE"
has   "ok: registered"       "$out" "STUB-REGISTER classes=128,5555"
has   "ok: flags"            "$out" "REACHED-END regenerated=1 aborted=0 failed=0"
hasnt "ok: trap"             "$out" "TRAP-FIRED"
grep -q '// new' "$I/arbiter-operator/scripts/unregister-oracle-cl.js" && [ -f "$I/arbiter-operator/scripts/lib/registry.js" ] && [ -f "$I/installer/lib/prompts.sh" ] && ok || bad "ok: the checkout's deregistration scripts were not put in place first"

# 2. Unattended, deregistration fails (a dispatcher call failed, or the keeper
#    still lists a job id): the job specs are left alone and it is reported.
out=$(run 1)
has   "fails: asked"         "$out" "STUB-UNREGISTER args=\[--unattended\]"
has   "fails: said so"       "$out" "Regenerating the jobs now would strand the stake"
hasnt "fails: no success"    "$out" "Successfully unregistered"
hasnt "fails: configure"     "$out" "STUB-CONFIGURE"
hasnt "fails: register"      "$out" "STUB-REGISTER"
has   "fails: flags"         "$out" "REACHED-END regenerated=0 aborted=1 failed=1"
has   "fails: summary"       "$out" "SUMMARY=job specifications were NOT regenerated"
hasnt "fails: trap"          "$out" "TRAP-FIRED"
has   "fails: exit 0"        "$out" "rc=0"

# 3. Interactive: the answers are piped in and the same rule applies.
out=$(run 0 "")
has   "tty: answers, all ids" "$out" "STUB-UNREGISTER args=\[\] VA_DEREGISTER_ORACLE= agg= all=y"
has   "tty: answers"          "$out" "STUB-UNREGISTER answers=y,0xAGG,y"
has   "tty: configured"       "$out" "STUB-CONFIGURE"
out=$(run 1 "")
hasnt "tty-fails: configure"  "$out" "STUB-CONFIGURE"
has   "tty-fails: flags"      "$out" "REACHED-END regenerated=0 aborted=1 failed=1"
hasnt "tty-fails: trap"       "$out" "TRAP-FIRED"

# 4. No unregister script anywhere: the stake cannot be released, so nothing is regenerated.
setup_orig=$(declare -f setup)
eval "$(echo "$setup_orig" | sed 's/^setup /setup_base /')"
setup() { setup_base; rm -f "$I/unregister-oracle.sh" "$SRC/util/unregister-oracle.sh"; }
out=$(run 0)
has   "no-script: said so"    "$out" "cannot release the stake on the current jobs"
hasnt "no-script: configure"  "$out" "STUB-CONFIGURE"
has   "no-script: flags"      "$out" "REACHED-END regenerated=0 aborted=1 failed=1"
hasnt "no-script: trap"       "$out" "TRAP-FIRED"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
