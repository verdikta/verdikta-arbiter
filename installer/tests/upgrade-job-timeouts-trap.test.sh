#!/bin/bash
# upgrade-arbiter.sh's two job-timeouts blocks (node A6a, design §11) under the
# real trap. The upgrade runs under `set -e` with `trap cleanup_on_error ERR`,
# and `--config-check` / `--check` exit 1 on every node that still needs the
# change, so their exit codes must be read with `|| rc=$?` (#97). This test runs
# the script's REAL blocks, the REAL cleanup_on_error and the REAL last lines
# against a stub apply-job-timeouts.sh, with a failing step at each place.
# Run: bash installer/tests/upgrade-job-timeouts-trap.test.sh
# UPGRADE_ARBITER_SH=<path> runs it against another copy of the script.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="${UPGRADE_ARBITER_SH:-$ROOT/bin/upgrade-arbiter.sh}"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

before=$(awk '/^# Job timeouts, before the restart/{p=1} /^# Check and optionally regenerate Chainlink configuration/{p=0} p{print}' "$S")
after=$(awk '/^# Job timeouts, after the restart/{p=1} /^# Post-upgrade health check\. Best-effort/{p=0} p{print}' "$S")
lastlines=$(awk '/^# Job timeouts that were asked for and did not land/{p=1} p{print}' "$S")
trapfn=$(awk '/^cleanup_on_error\(\) \{$/{p=1} p{print} p&&/^}$/{exit}' "$S")
[ -n "$before" ] && ok || bad "could not extract the before-restart block"
[ -n "$after" ] && ok || bad "could not extract the after-restart block"
[ -n "$lastlines" ] && ok || bad "could not extract the last lines"
[ -n "$trapfn" ] && ok || bad "could not extract cleanup_on_error"
printf '%s\n' "$before" | bash -n && ok || bad "the before-restart block is not a complete shell fragment"
printf '%s\n' "$after" | bash -n && ok || bad "the after-restart block is not a complete shell fragment"
echo "$before" | grep -q 'apply-job-timeouts.sh" --config-check' && ok || bad "before: does not read --config-check"
echo "$before" | grep -q 'apply-job-timeouts.sh" --config ' && ok || bad "before: does not call --config"
echo "$after" | grep -q 'apply-job-timeouts.sh" --check' && ok || bad "after: does not read --check"
echo "$after" | grep -q 'apply-job-timeouts.sh" --apply' && ok || bad "after: does not call --apply"
# The rule itself: no `$?` read after the fact in either block.
for block in "$before" "$after"; do
    echo "$block" | grep -E '^[[:space:]]*bash .*apply-job-timeouts\.sh"' | grep -vE '\|\| [A-Z_]+=\$\?$' \
        && bad "a call to the tool that does not read its exit code with || rc=\$?" || ok
done
# Both blocks are at the top level of the script: a function has no ERR trap at all.
# (`^}` also closes a heredoc's dict in check_chainlink_config, which is why it is only used to end.)
awk '/^[a-zA-Z_]+\(\) \{$/{f=1} /^# Job timeouts, (before|after) the restart/{if (f) print "IN-FUNCTION"} /^}$/{f=0}' "$S" | grep -q IN-FUNCTION \
    && bad "a job-timeouts block sits inside a function" || ok

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/install" "$T/util" "$T/home/.chainlink-testnet"
cat > "$T/stub" <<'STUB'
#!/bin/bash
echo "STUB $*"
case "$1" in
  --config-check) exit "${CONFIG_CHECK_RC:-1}" ;;
  --config)       exit "${CONFIG_RC:-0}" ;;
  --check)
      # First --check, then the re-measure after --apply.
      n=$(cat "$COUNTER" 2>/dev/null || echo 0); echo $((n+1)) > "$COUNTER"
      if [ "$n" = "0" ]; then exit "${CHECK_RC:-1}"; else exit "${RECHECK_RC:-0}"; fi ;;
  --apply)        exit "${APPLY_RC:-0}" ;;
  *) echo "STUB: unexpected $*" >&2; exit 99 ;;
esac
STUB
chmod +x "$T/stub"
cp "$T/stub" "$T/util/apply-job-timeouts.sh"
cp "$T/stub" "$T/install/apply-job-timeouts.sh"

# run_blocks ANSWER KEY — runs: real trap, before block, after block, a marker, the real last lines.
run_blocks() {
    local answer="${1-}" key="${2-}"
    rm -f "$T/counter"
    printf '%s\n%s\n' "$answer" "$answer" | \
    COUNTER="$T/counter" TARGET_DIR="$T/install" UTIL_DIR="$T/util" HOME="$T/home" NETWORK_TYPE=testnet \
    VA_UPGRADE_JOB_TIMEOUTS="$key" SERVICES_STARTED_FOR_DOCTOR="${SERVICES_STARTED:-1}" \
    UPGRADE_IN_PROGRESS=1 BACKUP_DIR="" ARBITER_WAS_RUNNING=0 RECONF_FAILED="${RECONF_FAILED:-0}" RECONF_SUMMARY="${RECONF_SUMMARY:-}" \
    BEFORE="$before" AFTER="$after" LAST="$lastlines" TRAPFN="$trapfn" ROOT="$ROOT" \
    bash -c '
        set -e
        eval "$TRAPFN"
        trap "echo TRAP-FIRED; cleanup_on_error" ERR
        [ -z "$VA_UPGRADE_JOB_TIMEOUTS" ] && unset VA_UPGRADE_JOB_TIMEOUTS
        source "$ROOT/lib/prompts.sh"
        GREEN= YELLOW= RED= BLUE= NC=
        eval "$BEFORE"
        echo "BEFORE-DONE"
        eval "$AFTER"
        echo "AFTER-DONE"
        eval "$LAST"
        echo "REACHED-END"
    ' 2>&1
    echo "rc=$?"
}
export -f run_blocks 2>/dev/null || true

# 1. The usual upgrade, unattended and unanswered: the canaries get the change.
out=$(VERDIKTA_UNATTENDED=1 run_blocks "" "")
has   "default: --config ran"    "$out" "STUB --config $T/home/.chainlink-testnet/config.toml"
has   "default: --apply ran"     "$out" "STUB --apply"
has   "default: re-measured"     "$out" "REACHED-END"
hasnt "default: trap"            "$out" "TRAP-FIRED"
has   "default: exit 0"          "$out" "rc=0"
hasnt "default: no failure line" "$out" "JOB TIMEOUTS"
[ "$(echo "$out" | grep -c 'STUB --check')" = "2" ] && ok || bad "default: --check should run before and after --apply: $out"
# Asked once, for both.
[ "$(echo "$out" | grep -c 'VA_UPGRADE_JOB_TIMEOUTS\]')" = "1" ] && ok || bad "default: expected one question for both steps: $out"

# 2. Nothing to do: nothing is asked, nothing changes.
out=$(VERDIKTA_UNATTENDED=1 CONFIG_CHECK_RC=0 CHECK_RC=0 run_blocks "" "")
hasnt "up to date: no --config" "$out" "STUB --config /"
hasnt "up to date: no --apply"  "$out" "STUB --apply"
hasnt "up to date: not asked"   "$out" "VA_UPGRADE_JOB_TIMEOUTS\]"
has   "up to date: end"         "$out" "REACHED-END"
hasnt "up to date: trap"        "$out" "TRAP-FIRED"

# 3. Declined: the node keeps its limits, the run says how to do it, and does not fail.
out=$(VERDIKTA_UNATTENDED=1 run_blocks "" n)
hasnt "declined: no --config" "$out" "STUB --config /"
hasnt "declined: no --apply"  "$out" "STUB --apply"
has   "declined: later hint"  "$out" "apply-job-timeouts.sh --apply"
has   "declined: end"         "$out" "REACHED-END"
has   "declined: exit 0"      "$out" "rc=0"
hasnt "declined: trap"        "$out" "TRAP-FIRED"

# 4. Interactive: Enter is yes, n is no, and the question comes once.
out=$(run_blocks "" "")
has   "interactive Enter: --config" "$out" "STUB --config /"
has   "interactive Enter: --apply"  "$out" "STUB --apply"
out=$(run_blocks n "")
hasnt "interactive n: --config" "$out" "STUB --config /"
hasnt "interactive n: --apply"  "$out" "STUB --apply"

# 5. The config step fails: the upgrade carries on and ends on exit 3 with the reason.
out=$(VERDIKTA_UNATTENDED=1 CONFIG_RC=1 run_blocks "" "")
has   "--config fails: carries on"  "$out" "BEFORE-DONE"
has   "--config fails: --apply ran" "$out" "STUB --apply"
has   "--config fails: last line"   "$out" "JOB TIMEOUTS FAILED:.*config.toml"
has   "--config fails: exit 3"      "$out" "rc=3"
hasnt "--config fails: trap"        "$out" "TRAP-FIRED"

# 6. No config file: nothing to patch, not a failure (a node on another layout is told).
out=$(VERDIKTA_UNATTENDED=1 CONFIG_CHECK_RC=2 CHECK_RC=0 run_blocks "" "")
hasnt "no config: --config" "$out" "STUB --config /"
has   "no config: end"      "$out" "REACHED-END"
has   "no config: exit 0"   "$out" "rc=0"
hasnt "no config: trap"     "$out" "TRAP-FIRED"

# 7. --apply fails, the old jobs restored (1).
out=$(VERDIKTA_UNATTENDED=1 CONFIG_CHECK_RC=0 APPLY_RC=1 run_blocks "" "")
has   "--apply fails: last line" "$out" "JOB TIMEOUTS FAILED:.*exit 1"
has   "--apply fails: exit 3"    "$out" "rc=3"
has   "--apply fails: retry"     "$out" "apply-job-timeouts.sh --apply"
hasnt "--apply fails: trap"      "$out" "TRAP-FIRED"
hasnt "--apply fails: not the end marker of a success" "$out" "REACHED-END"

# 8. --apply lost a job (3): the last line says so.
out=$(VERDIKTA_UNATTENDED=1 CONFIG_CHECK_RC=0 APPLY_RC=3 run_blocks "" "")
has   "--apply lost: last line" "$out" "JOB TIMEOUTS FAILED:.*could not be restored"
has   "--apply lost: exit 3"    "$out" "rc=3"
hasnt "--apply lost: trap"      "$out" "TRAP-FIRED"

# 9. --apply says done, the measure disagrees: a measured failure.
out=$(VERDIKTA_UNATTENDED=1 CONFIG_CHECK_RC=0 RECHECK_RC=1 run_blocks "" "")
has   "re-measure fails: last line" "$out" "JOB TIMEOUTS FAILED:"
has   "re-measure fails: exit 3"    "$out" "rc=3"
hasnt "re-measure fails: trap"      "$out" "TRAP-FIRED"

# 10. The node cannot be measured: exit 3, not silence, or a stale job would ride past the canary.
out=$(VERDIKTA_UNATTENDED=1 CONFIG_CHECK_RC=0 CHECK_RC=2 run_blocks "" "")
hasnt "not measured: no --apply" "$out" "STUB --apply"
has   "not measured: last line"  "$out" "JOB TIMEOUTS FAILED:.*could not be measured"
has   "not measured: exit 3"     "$out" "rc=3"
hasnt "not measured: trap"       "$out" "TRAP-FIRED"

# 11. The arbiter was left stopped: nothing to measure, a hint, no failure.
out=$(VERDIKTA_UNATTENDED=1 SERVICES_STARTED=0 CONFIG_CHECK_RC=0 run_blocks "" "")
hasnt "stopped: no --check" "$out" "STUB --check"
has   "stopped: hint"       "$out" "apply-job-timeouts.sh --check"
has   "stopped: end"        "$out" "REACHED-END"
has   "stopped: exit 0"     "$out" "rc=0"
hasnt "stopped: trap"       "$out" "TRAP-FIRED"

# 12. A reconfigure failure and a timeouts failure: both are said, RECONFIGURE last (its pin), exit 3.
out=$(VERDIKTA_UNATTENDED=1 CONFIG_CHECK_RC=0 APPLY_RC=1 RECONF_FAILED=1 RECONF_SUMMARY="stub summary" run_blocks "" "")
has   "both: timeouts line"    "$out" "JOB TIMEOUTS FAILED:"
has   "both: reconfigure line" "$out" "RECONFIGURE FAILED: stub summary"
has   "both: exit 3"           "$out" "rc=3"
echo "$out" | grep -E 'FAILED:' | tail -1 | grep -q "RECONFIGURE FAILED" && ok || bad "both: RECONFIGURE FAILED is not the last failure line: $out"

# 13. The old tool is not in the install (an install from before this release, copy failed): the blocks do nothing.
rm -f "$T/util/apply-job-timeouts.sh" "$T/install/apply-job-timeouts.sh"
out=$(VERDIKTA_UNATTENDED=1 run_blocks "" "")
has   "no tool: end"  "$out" "REACHED-END"
hasnt "no tool: trap" "$out" "TRAP-FIRED"
hasnt "no tool: stub" "$out" "STUB"

# ── The real tool, an old config and a dead node, under the real trap ────────
# No stub: the upgrade's own script at each exit code a real node gives.
cp "$ROOT/util/apply-job-timeouts.sh" "$T/util/apply-job-timeouts.sh"
cp "$ROOT/util/apply-job-timeouts.sh" "$T/install/apply-job-timeouts.sh"
printf '[Log]\nLevel = "warn"\n' > "$T/home/.chainlink-testnet/config.toml"
printf 'nobody@example.test\nnope\n' > "$T/home/.chainlink-testnet/.api"
out=$(VERDIKTA_UNATTENDED=1 VERDIKTA_CHAINLINK_URL=http://127.0.0.1:9 VERDIKTA_JOB_CHECK_WAIT=1 run_blocks "" "")
has   "real tool: config set"       "$out" "BEFORE-DONE"
grep -q '^MaxRunDuration = "15m"$' "$T/home/.chainlink-testnet/config.toml" && ok || bad "real tool: MaxRunDuration was not set"
has   "real tool, dead node: exit 3" "$out" "rc=3"
has   "real tool, dead node: says"   "$out" "JOB TIMEOUTS FAILED:.*could not be measured"
hasnt "real tool, dead node: trap"   "$out" "TRAP-FIRED"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
