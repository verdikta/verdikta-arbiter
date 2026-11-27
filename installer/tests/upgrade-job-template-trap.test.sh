#!/bin/bash
# upgrade-arbiter.sh's operator-mode read (before the stop) and its "Job template, after the
# restart" block, under the real trap. The upgrade runs under `set -e` with
# `trap cleanup_on_error ERR`; `job-template.cjs mode` exits non-zero when the operator cannot
# be told, and `check` exits 1 on every node whose jobs are stale, so their exit codes must be
# read with `|| rc=$?` (#97). This test runs the script's REAL blocks, the REAL
# cleanup_on_error and the REAL last lines against a stub job-template.cjs, with a failing
# step at each place. What the real tool does: job-template.test.cjs.
# Run: bash installer/tests/upgrade-job-template-trap.test.sh
# UPGRADE_ARBITER_SH=<path> runs it against another copy of the script.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="${UPGRADE_ARBITER_SH:-$ROOT/bin/upgrade-arbiter.sh}"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

mode=$(awk '/^# Which operator contract is this\? Read before anything is stopped/{p=1} /^JOB_PREFLIGHT_RC=0$/{p=0} p{print}' "$S")
after=$(awk '/^# Job template, after the restart\./{p=1} /^# Job timeouts, after the restart/{p=0} p{print}' "$S")
lastlines=$(awk '/^# Job timeouts that were asked for and did not land/{p=1} p{print}' "$S")
trapfn=$(awk '/^cleanup_on_error\(\) \{$/{p=1} p{print} p&&/^}$/{exit}' "$S")
[ -n "$mode" ] && ok || bad "could not extract the operator-mode block"
[ -n "$after" ] && ok || bad "could not extract the after-restart block"
[ -n "$lastlines" ] && ok || bad "could not extract the last lines"
[ -n "$trapfn" ] && ok || bad "could not extract cleanup_on_error"
printf '%s\n' "$mode" | bash -n && ok || bad "the operator-mode block is not a complete shell fragment"
printf '%s\n' "$after" | bash -n && ok || bad "the after-restart block is not a complete shell fragment"
# The rule itself: every call to the tool reads its exit code with || rc=$?.
for block in "$mode" "$after"; do
    echo "$block" | grep -E 'node "\$(UTIL_DIR|TARGET_DIR)/job-template\.cjs"' | grep -vE '\|\| [A-Z_]+=\$\?$' \
        && bad "a call to job-template.cjs that does not read its exit code with || rc=\$?" || ok
done
# Both blocks are at the top level of the script: a function has no ERR trap at all.
awk '/^[a-zA-Z_]+\(\) \{$/{f=1} /^# (Which operator contract is this\?|Job template, after the restart\.)/{if (f) print "IN-FUNCTION"} /^}$/{f=0}' "$S" | grep -q IN-FUNCTION \
    && bad "a job-template block sits inside a function" || ok
# The operator is read before the first stop; the jobs are replaced after the restart, unasked.
mode_line=$(grep -nE '^OPERATOR_MODE_JSON=\$\(' "$S" | head -1 | cut -d: -f1)
stop_line=$(grep -nE '^[[:space:]]*"\$TARGET_DIR/stop-arbiter\.sh"$' "$S" | head -1 | cut -d: -f1)
[ -n "$mode_line" ] && [ -n "$stop_line" ] && [ "$mode_line" -lt "$stop_line" ] && ok || bad "the operator is not read before the stop (read at ${mode_line:-none}, stop at ${stop_line:-none})"
echo "$after" | grep -q 'ask_yes_no' && bad "the in-place job update is asked about: a declined one leaves a node that answers nothing" || ok
echo "$mode" | grep -q 'stop-arbiter\|cleanup_on_error' && bad "the operator-mode block stops or restarts something" || ok

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/install" "$T/util"
cat > "$T/stub.cjs" <<'STUB'
const fs = require('fs');
const [command, ...rest] = process.argv.slice(2);
console.error(`STUB ${command} ${rest.join(' ')} mode=${process.env.VERDIKTA_OPERATOR_MODE_JSON || ''} rpc=${process.env.REQUEST_AUTH_RPC_URLS || ''}`);
if (command === 'mode') {
  if (process.env.MODE_OUT) console.log(process.env.MODE_OUT);
  process.exit(Number(process.env.MODE_RC || 0));
}
if (command === 'check') {
  // First check, then the re-measure after apply.
  let n = 0; try { n = Number(fs.readFileSync(process.env.COUNTER, 'utf8')); } catch {}
  fs.writeFileSync(process.env.COUNTER, String(n + 1));
  process.exit(Number(n === 0 ? (process.env.CHECK_RC || 1) : (process.env.RECHECK_RC || 0)));
}
if (command === 'apply') process.exit(Number(process.env.APPLY_RC || 0));
process.exit(99);
STUB
cp "$T/stub.cjs" "$T/util/job-template.cjs"
cp "$T/stub.cjs" "$T/install/job-template.cjs"
V1='{"mode":"v1"}'
LEGACY='{"mode":"legacy","keeper":"0x2D96cc4F6619d08FC14b7ee0eec02d1F3eE1d0b0","aggregator":"0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a"}'

# run_blocks — the real trap, the operator-mode block, a marker for "the stop would come here",
# the after-restart block, the real last lines.
run_blocks() {
    rm -f "$T/counter"
    COUNTER="$T/counter" TARGET_DIR="$T/install" UTIL_DIR="$T/util" RPC_HTTP_URLS="https://rpc.invalid" \
    SERVICES_STARTED_FOR_DOCTOR="${SERVICES_STARTED:-1}" \
    UPGRADE_IN_PROGRESS=1 BACKUP_DIR="" ARBITER_WAS_RUNNING=0 RECONF_FAILED=0 RECONF_SUMMARY="" \
    MODE="$mode" AFTER="$after" LAST="$lastlines" TRAPFN="$trapfn" ROOT="$ROOT" \
    bash -c '
        set -e
        eval "$TRAPFN"
        trap "echo TRAP-FIRED; cleanup_on_error" ERR
        unset VERDIKTA_OPERATOR_MODE_JSON
        source "$ROOT/lib/prompts.sh"
        GREEN= YELLOW= RED= BLUE= NC=
        eval "$MODE"
        echo "STOP-WOULD-COME-HERE exported=[$(printenv VERDIKTA_OPERATOR_MODE_JSON)]"
        eval "$AFTER"
        echo "AFTER-DONE"
        eval "$LAST"
        echo "REACHED-END"
    ' 2>&1
    echo "rc=$?"
}

# 1. A v1 operator whose jobs are this release's: nothing to do, nothing said about legacy.
out=$(MODE_OUT="$V1" CHECK_RC=0 run_blocks)
has   "v1, up to date: verified"       "$out" "request-authorization v1 verified"
has   "v1, up to date: mode passed on" "$out" 'exported=\[{"mode":"v1"}\]'
has   "v1, up to date: measured"       "$out" "STUB check --install-dir $T/install --wait 180 mode={\"mode\":\"v1\"} rpc=https://rpc.invalid"
hasnt "v1, up to date: no apply"       "$out" "STUB apply"
hasnt "v1, up to date: no legacy text" "$out" "predates"
has   "v1, up to date: end"            "$out" "REACHED-END"
has   "v1, up to date: exit 0"         "$out" "rc=0"
hasnt "v1, up to date: trap"           "$out" "TRAP-FIRED"

# 2. A legacy operator, stale jobs (the node every operator outside the canaries has): the
#    upgrade goes on, says what its jobs will do, and replaces them after the restart.
out=$(MODE_OUT="$LEGACY" run_blocks)
has   "legacy: goes on"            "$out" "STOP-WOULD-COME-HERE"
has   "legacy: says it is legacy"  "$out" "predates request authorization"
has   "legacy: names the keeper"   "$out" "ReputationKeeper 0x2D96cc4F6619d08FC14b7ee0eec02d1F3eE1d0b0"
has   "legacy: nothing on chain"   "$out" "job ids, registration, stake and reputation stay"
has   "legacy: names the migration" "$out" "migrate-operator.sh"
has   "legacy: mode passed on"     "$out" 'exported=\[{"mode":"legacy"'
has   "legacy: apply ran"          "$out" "STUB apply --install-dir $T/install mode={\"mode\":\"legacy\""
[ "$(echo "$out" | grep -c 'STUB check')" = "2" ] && ok || bad "legacy: check should run before and after apply: $out"
has   "legacy: end"                "$out" "REACHED-END"
has   "legacy: exit 0"             "$out" "rc=0"
hasnt "legacy: no failure line"    "$out" "JOB UPDATE FAILED"
hasnt "legacy: trap"               "$out" "TRAP-FIRED"
hasnt "legacy: not asked"          "$out" "\[VA_"

# 3. The operator cannot be told (RPC down, wrong chain), or is a legacy one with no keeper
#    its jobs could ask: the upgrade ends before the stop, by its own word and not by the trap.
for rc in 1 2; do
    out=$(MODE_RC=$rc run_blocks)
    has   "mode exit $rc: says nothing changed" "$out" "Nothing was changed, and the arbiter was not stopped"
    hasnt "mode exit $rc: never reaches the stop" "$out" "STOP-WOULD-COME-HERE"
    has   "mode exit $rc: exit 1" "$out" "rc=1"
    hasnt "mode exit $rc: trap" "$out" "TRAP-FIRED"
    hasnt "mode exit $rc: not 'Upgrade failed'" "$out" "Upgrade failed"
done
# An answer that describes no operator is no answer.
out=$(MODE_OUT='{"mode":"open"}' run_blocks)
hasnt "unknown mode: never reaches the stop" "$out" "STOP-WOULD-COME-HERE"
has   "unknown mode: exit 1" "$out" "rc=1"
hasnt "unknown mode: trap" "$out" "TRAP-FIRED"
out=$(MODE_OUT='' run_blocks)
hasnt "empty answer: never reaches the stop" "$out" "STOP-WOULD-COME-HERE"
has   "empty answer: exit 1" "$out" "rc=1"

# 4. apply fails with the old jobs in place (1): the upgrade is done, and ends on exit 3 saying
#    that such a job answers nothing.
out=$(MODE_OUT="$LEGACY" APPLY_RC=1 run_blocks)
has   "apply fails: carries on"  "$out" "AFTER-DONE"
has   "apply fails: last line"   "$out" "JOB UPDATE FAILED:.*exit 1"
has   "apply fails: consequence" "$out" "answers nothing"
has   "apply fails: retry"       "$out" "job-template.cjs apply"
has   "apply fails: exit 3"      "$out" "rc=3"
hasnt "apply fails: trap"        "$out" "TRAP-FIRED"
hasnt "apply fails: not the end marker of a success" "$out" "REACHED-END"

# 5. apply lost a job (3): the last line says so.
out=$(MODE_OUT="$V1" APPLY_RC=3 run_blocks)
has   "job lost: last line" "$out" "JOB UPDATE FAILED:.*could not be restored"
has   "job lost: exit 3"    "$out" "rc=3"
hasnt "job lost: trap"      "$out" "TRAP-FIRED"

# 6. The jobs could not be measured (2): a failure, not a pass.
out=$(MODE_OUT="$V1" CHECK_RC=2 run_blocks)
hasnt "unmeasured: no apply"  "$out" "STUB apply"
has   "unmeasured: last line" "$out" "JOB UPDATE FAILED:.*could not be measured"
has   "unmeasured: exit 3"    "$out" "rc=3"
hasnt "unmeasured: trap"      "$out" "TRAP-FIRED"

# 7. Replaced, and the node still shows a stale job.
out=$(MODE_OUT="$V1" RECHECK_RC=1 run_blocks)
has   "still stale: last line" "$out" "JOB UPDATE FAILED:.*still does not show"
has   "still stale: exit 3"    "$out" "rc=3"

# 8. The services were not started by this run: nothing is measured, the operator is told how.
out=$(MODE_OUT="$V1" SERVICES_STARTED=0 run_blocks)
hasnt "not started: no check" "$out" "STUB check"
has   "not started: hint"     "$out" "job-template.cjs check"
has   "not started: end"      "$out" "REACHED-END"
has   "not started: exit 0"   "$out" "rc=0"

# 9. An install without the tool (it is copied before this block; a partial copy must not end the run).
rm "$T/install/job-template.cjs"
out=$(MODE_OUT="$V1" run_blocks)
hasnt "no tool: no check" "$out" "STUB check"
has   "no tool: end"      "$out" "REACHED-END"
hasnt "no tool: trap"     "$out" "TRAP-FIRED"

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
