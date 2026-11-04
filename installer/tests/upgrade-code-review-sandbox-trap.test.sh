#!/bin/bash
# upgrade-arbiter.sh and the code-review sandbox (node A8). Three blocks, each run REAL
# under the script's real semantics (errexit on, the ERR trap armed, its cleanup_on_error
# where failure must restart the arbiter): the maintenance lock around the upgrade, the
# runner's dependencies, and the offer. `status --quiet` exits non-zero on every node that
# has not opted in, so exit codes are read with `|| rc=$?`, never behind `set +e` (#97).
# Unattended, nothing is installed unless VA_UPGRADE_CODE_REVIEW_SANDBOX=y. A failure leaves
# the arbiter running, says so and ends the upgrade with exit 3, not "Upgrade failed!".
# Run: bash installer/tests/upgrade-code-review-sandbox-trap.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/bin/upgrade-arbiter.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if printf '%s\n' "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if printf '%s\n' "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

offer=$(awk '/^# The code-review sandbox, after the restart/{p=1} /^# Post-upgrade health check\. Best-effort/{p=0} p{print}' "$S")
lock=$(awk '/^# Hold the code runner.s maintenance lock/{p=1} /^# If arbiter is running, stop it/{p=0} p{print}' "$S")
deps=$(awk '/^# Code Runner dependencies/{p=1} /^# Update @verdikta\/common library to get latest/{p=0} p{print}' "$S")
tail_block=$(awk '/^# Job timeouts that were asked for and did not land/{p=1} /^# A cancelled or failed job reconfiguration/{p=0} p{print}' "$S")
trapfn=$(awk '/^cleanup_on_error\(\) \{/{p=1} p{print} p&&/^}/{exit}' "$S")
for name in offer lock deps tail_block trapfn; do
    [ -n "${!name}" ] && ok || bad "could not extract the $name block from $S"
done
has "the offer reads status --quiet" "$offer" 'code-review-sandbox.sh" status --quiet || CODE_REVIEW_STATUS_RC=\$?'
has "the offer reads enable"         "$offer" 'code-review-sandbox.sh" enable || CODE_REVIEW_ENABLE_RC=\$?'
has "the unattended default is no"   "$offer" 'VA_UPGRADE_CODE_REVIEW_SANDBOX "n"'
code=$(printf '%s\n' "$offer$lock$deps" | grep -vE '^[[:space:]]*#')
hasnt "no set +e" "$code" "set +e"
# The lock goes before the stop: nothing is admitted between them.
l1=$(grep -n "^# Hold the code runner.s maintenance lock" "$S" | cut -d: -f1); l2=$(grep -n '^# If arbiter is running, stop it' "$S" | cut -d: -f1)
[ -n "$l1" ] && [ -n "$l2" ] && [ "$l1" -lt "$l2" ] && ok || bad "the lock is not taken before the stop ($l1, $l2)"
# The offer comes after the restart, so a long pull or canary never extends the downtime.
l3=$(grep -n '^# Ask if user wants to restart the arbiter' "$S" | cut -d: -f1); l4=$(grep -n '^# The code-review sandbox, after the restart' "$S" | cut -d: -f1)
[ -n "$l3" ] && [ -n "$l4" ] && [ "$l3" -lt "$l4" ] && ok || bad "the offer does not follow the restart ($l3, $l4)"

T=$(cd "$(mktemp -d)" && pwd -P); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/install/code-runner-state" "$T/install/code-runner" "$T/bin"
cat > "$T/install/code-review-sandbox.sh" <<'STUB'
#!/bin/bash
case "$1" in
  status) exit "${STATUS_RC:-1}" ;;
  enable) echo "STUB-ENABLE-CALLED"; exit "${ENABLE_RC:-0}" ;;
  hold) echo "STUB-HOLD-CALLED"; exit "${HOLD_RC:-0}" ;;
  *) echo "STUB: unexpected $*" >&2; exit 99 ;;
esac
STUB
printf '#!/bin/bash\necho STUB-START-ARBITER\n[ -f "$LOCK" ] && echo LOCK-HELD-AT-START\nexit 0\n' > "$T/install/start-arbiter.sh"
chmod +x "$T/install/"*.sh

# --- the offer, under the trap. run STATUS_RC ENABLE_RC UNATTENDED [ANSWER] [KEY]
run() {
    local answer="${4-}" key="${5:-}"
    printf '%s\n' "$answer" | \
    STATUS_RC="$1" ENABLE_RC="$2" VERDIKTA_UNATTENDED="$3" VA_UPGRADE_CODE_REVIEW_SANDBOX="$key" TARGET_DIR="$T/install" UTIL_DIR="$T/install" \
    bash -c '
        set -e
        trap "echo TRAP-FIRED; exit 9" ERR
        [ -z "$VA_UPGRADE_CODE_REVIEW_SANDBOX" ] && unset VA_UPGRADE_CODE_REVIEW_SANDBOX
        source "$1/lib/prompts.sh"
        GREEN= YELLOW= RED= BLUE= NC=
        eval "$2"
        echo "FAILED=[${CODE_REVIEW_SANDBOX_FAILED:-}]"
        echo "REACHED-END"
    ' _ "$ROOT" "$offer" 2>&1
    echo "rc=$?"
}
# 1. Unattended, not installed (1), no key: nothing happens. The default for every unattended upgrade.
out=$(run 1 0 1)
hasnt "unattended default: enable" "$out" "STUB-ENABLE-CALLED"
has   "unattended default: key named" "$out" "VA_UPGRADE_CODE_REVIEW_SANDBOX"
has   "unattended default: later hint" "$out" "code-review-sandbox.sh enable"
has   "unattended default: finished" "$out" "REACHED-END"
hasnt "unattended default: trap"   "$out" "TRAP-FIRED"
has   "unattended default: exit 0" "$out" "rc=0"
# 2. Opted in: enable runs.
out=$(run 1 0 1 "" y)
has   "opted in: enable called" "$out" "STUB-ENABLE-CALLED"
has   "opted in: nothing failed" "$out" "FAILED=\[\]"
has   "opted in: finished" "$out" "REACHED-END"
hasnt "opted in: trap" "$out" "TRAP-FIRED"
# 3. Interactive: Enter is no, y is yes.
out=$(run 1 0 0 "")
hasnt "interactive Enter: enable" "$out" "STUB-ENABLE-CALLED"
out=$(run 1 0 0 "y")
has   "interactive y: enable" "$out" "STUB-ENABLE-CALLED"
# 4. enable fails, any way: warn, say what to run, carry on. Never "Upgrade failed!".
for rc in 1 3 4 64; do
    out=$(run 1 "$rc" 1 "" y)
    has   "enable $rc: reason kept" "$out" "FAILED=\[.*code-review-sandbox.sh enable"
    has   "enable $rc: finished" "$out" "REACHED-END"
    hasnt "enable $rc: trap" "$out" "TRAP-FIRED"
done
# 5. Ready (0): nothing to ask or do. Installed but stale (2): refreshed with no question, the operator opted in before.
out=$(run 0 0 1 "" n)
hasnt "ready: enable" "$out" "STUB-ENABLE-CALLED"
has   "ready: finished" "$out" "REACHED-END"
out=$(run 2 0 1 "" n)
has   "stale: refreshed whatever the key says" "$out" "STUB-ENABLE-CALLED"
has   "stale: finished" "$out" "REACHED-END"
out=$(run 2 1 1 "" n)
has   "stale, refresh fails: reason kept" "$out" "FAILED=\[.*code-review-sandbox.sh enable"
hasnt "stale, refresh fails: trap" "$out" "TRAP-FIRED"
# 6. A host that cannot (4): nothing asked, nothing failed.
out=$(run 4 0 1 "" y)
hasnt "cannot: enable" "$out" "STUB-ENABLE-CALLED"
has   "cannot: nothing failed" "$out" "FAILED=\[\]"
hasnt "cannot: trap" "$out" "TRAP-FIRED"
# 7. A host without the tool: skipped.
mv "$T/install/code-review-sandbox.sh" "$T/install/off"
out=$(run 1 0 1 "" y)
has "no tool: finished" "$out" "REACHED-END"
hasnt "no tool: prompt" "$out" "VA_UPGRADE_CODE_REVIEW_SANDBOX"
mv "$T/install/off" "$T/install/code-review-sandbox.sh"

# --- a failed refresh ends the upgrade with exit 3, on the last line, as a job limit that did not land does
out=$(CODE_REVIEW_SANDBOX_FAILED="the sandbox: run code-review-sandbox.sh enable" TARGET_DIR="$T/install" bash -c '
    set -e
    trap "echo TRAP-FIRED; exit 9" ERR
    GREEN= YELLOW= RED= BLUE= NC=
    RECONF_FAILED=0
    eval "$1"
    echo "FOLLOWUP=$JOB_FOLLOWUP_FAILED"
' _ "$tail_block" 2>&1); rc=$?
has   "tail: names it"  "$out" "code-review-sandbox.sh enable"
[ "$rc" = 3 ] && ok || bad "tail: exit $rc, expected 3"
hasnt "tail: trap"      "$out" "TRAP-FIRED"
grep -q 'CODE_REVIEW_SANDBOX_FAILED' <<< "$tail_block" && ok || bad "the tail does not read CODE_REVIEW_SANDBOX_FAILED"

# --- the lock. run_lock: the real lock block, then the real trap handler on a failure, in real script order.
run_lock() { # run_lock INSTALLED(1|0) PRE_HELD(1|0) FAIL_AFTER(1|0)
    rm -f "$T/install/code-runner-state/maintenance" "$T/install/code-runner/.env"
    [ "$1" = 1 ] && : > "$T/install/code-runner/.env"
    [ "$2" = 1 ] && echo "by hand" > "$T/install/code-runner-state/maintenance"
    LOCK="$T/install/code-runner-state/maintenance" TARGET_DIR="$T/install" FAIL_AFTER="$3" REAL_UTIL="$ROOT/util" bash -c '
        set -e
        GREEN= YELLOW= RED= BLUE= NC=
        UTIL_DIR="$REAL_UTIL"
        UPGRADE_IN_PROGRESS=1; BACKUP_DIR=""; ARBITER_WAS_RUNNING=1
        eval "$1"
        trap cleanup_on_error ERR
        eval "$2"
        echo "HELD-DURING-UPGRADE=$([ -f "$LOCK" ] && echo yes || echo no)"
        if [ "$FAIL_AFTER" = 1 ]; then false; fi
        echo "REACHED-END"
    ' _ "$trapfn" "$lock" 2>&1
    echo "rc=$?"
    echo "LOCK-AFTER=$([ -f "$T/install/code-runner-state/maintenance" ] && echo present || echo gone)"
}
out=$(run_lock 1 0 0)
has "lock: held during the upgrade" "$out" "HELD-DURING-UPGRADE=yes"
has "lock: let go at the end"       "$out" "LOCK-AFTER=gone"
has "lock: finished"                "$out" "REACHED-END"
out=$(run_lock 1 0 1)
has   "failed upgrade: says so"       "$out" "Upgrade failed"
has   "failed upgrade: arbiter restarted" "$out" "STUB-START-ARBITER"
has   "failed upgrade: lock let go"   "$out" "LOCK-AFTER=gone"
has   "failed upgrade: exit 1"        "$out" "rc=1"
out=$(run_lock 0 0 0)
has "no sandbox: no lock"  "$out" "HELD-DURING-UPGRADE=no"
has "no sandbox: finished" "$out" "REACHED-END"
out=$(run_lock 1 1 0)
has "another's lock stays" "$out" "LOCK-AFTER=present"
has "another's lock: finished" "$out" "REACHED-END"
out=$(run_lock 1 1 1)
has "another's lock stays after a failure" "$out" "LOCK-AFTER=present"
# A sandbox operation still running: no upgrade yet, or it would lift the lock from under this one.
sleep 60 & live=$!
rm -f "$T/install/code-runner-state/maintenance"; : > "$T/install/code-runner/.env"
echo "code-review-sandbox $live 2026-11-04T00:00:00Z" > "$T/install/code-runner-state/maintenance"
out=$(LOCK="$T/install/code-runner-state/maintenance" TARGET_DIR="$T/install" UTIL_DIR="$ROOT/util" bash -c '
    set -e
    trap "echo TRAP-FIRED; exit 9" ERR
    GREEN= YELLOW= RED= BLUE= NC=
    eval "$1"
    echo "STOPPED-THE-ARBITER"
' _ "$lock" 2>&1); rc=$?
[ "$rc" = 1 ] && ok || bad "a live holder: upgrade exit $rc"
has   "a live holder: says so" "$out" "$live"
hasnt "a live holder: nothing stopped" "$out" "STOPPED-THE-ARBITER"
hasnt "a live holder: trap" "$out" "TRAP-FIRED"
has   "a live holder: its lock stays" "$(cat "$T/install/code-runner-state/maintenance")" "$live"
kill "$live" 2>/dev/null; wait "$live" 2>/dev/null
# A dead holder's file is taken over, and let go.
echo "code-review-sandbox $live 2026-11-04T00:00:00Z" > "$T/install/code-runner-state/maintenance"
out=$(LOCK="$T/install/code-runner-state/maintenance" TARGET_DIR="$T/install" UTIL_DIR="$ROOT/util" bash -c '
    set -e
    GREEN= YELLOW= RED= BLUE= NC=
    eval "$1"
    echo "HOLDER=$(cat "$LOCK")"
    echo "PARENT=$CODE_REVIEW_LOCK_PARENT PID=$$"
    echo "REACHED-END"
' _ "$lock" 2>&1)
has "a dead holder: taken over" "$out" "HOLDER=code-review-sandbox [0-9]"
has "a dead holder: finished" "$out" "REACHED-END"
[ ! -f "$T/install/code-runner-state/maintenance" ] && ok || bad "a dead holder's lock stayed"
# The tool hears whose lock it is.
pid_line=$(printf '%s\n' "$out" | grep '^PARENT=')
parent=${pid_line#PARENT=}; parent=${parent%% *}
[ -n "$parent" ] && [ "$parent" = "${pid_line##*PID=}" ] && ok || bad "the upgrade does not hand its pid down: $pid_line"

# The lock is outside what an upgrade replaces: a second operation stays refused all the way through.
component=$(awk '/^upgrade_component\(\) \{/{p=1} p{print} p&&/^}/{exit}' "$S")
[ -n "$component" ] && ok || bad "could not extract upgrade_component"
mkdir -p "$T/newrunner"; echo new > "$T/newrunner/file"
echo "code-review-sandbox $$ x" > "$T/install/code-runner-state/maintenance"; mkdir -p "$T/install/code-runner"; echo old > "$T/install/code-runner/old"
out=$(TARGET_DIR="$T/install" SRC="$T/newrunner" bash -c '
    set -e
    GREEN= YELLOW= RED= BLUE= NC=
    eval "$1"
    upgrade_component "$SRC" "$TARGET_DIR/code-runner" "Code Runner" ".env logs node_modules *.pid"
    echo "REACHED-END"
' _ "$component" 2>&1)
has "the replacement ran" "$out" "REACHED-END"
[ -f "$T/install/code-runner/file" ] && [ ! -e "$T/install/code-runner/old" ] && ok || bad "the replacement did not replace"
has "the lock did not move" "$(cat "$T/install/code-runner-state/maintenance")" "sandbox $$ "
rm -f "$T/install/code-runner-state/maintenance"
mkdir -p "$T/install/code-runner"; : > "$T/install/code-runner/.env"

# What the tool pinned is no pid's: the upgrade's exit does not lift it.
rm -f "$T/install/code-runner-state/maintenance"
out=$(LOCK="$T/install/code-runner-state/maintenance" TARGET_DIR="$T/install" UTIL_DIR="$ROOT/util" bash -c '
    set -e
    GREEN= YELLOW= RED= BLUE= NC=
    eval "$1"
    echo "code-review-sandbox kept: pinned" > "$LOCK"
' _ "$lock" 2>&1)
has "a pinned lock outlives the upgrade" "$(cat "$T/install/code-runner-state/maintenance")" "kept:"
rm -f "$T/install/code-runner-state/maintenance"

# The backup comes with this run's lock: restored, it would refuse every claim from then on.
backup=$(awk '/^# Ask if user wants to create a backup/{p=1} /^# Mark that upgrade is in progress/{p=0} p{print}' "$S")
[ -n "$backup" ] && ok || bad "could not extract the backup block"
: > "$T/install/code-runner/.env"; echo "upgrade-arbiter 1 x" > "$T/install/code-runner-state/maintenance"
out=$(VERDIKTA_UNATTENDED=1 VA_UPGRADE_BACKUP=y TARGET_DIR="$T/install" BACKUP_TO="$T/backup" bash -c '
    set -e
    trap "echo TRAP-FIRED; exit 9" ERR
    source "$1/lib/prompts.sh"
    GREEN= YELLOW= RED= BLUE= NC=
    create_backup() { cp -r "$1" "$BACKUP_TO"; BACKUP_DIR="$BACKUP_TO"; }
    resolve_backup_keep() { echo 3; }
    prune_old_backups() { :; }
    eval "$2"
    echo "REACHED-END"
' _ "$ROOT" "$backup" 2>&1)
has "backup: finished" "$out" "REACHED-END"
[ -f "$T/backup/code-runner/.env" ] && ok || bad "backup: nothing was copied"
[ ! -e "$T/backup/code-runner-state/maintenance" ] && ok || bad "backup: the copy holds the lock"
[ -e "$T/install/code-runner-state/maintenance" ] && ok || bad "backup: the live lock went"
rm -f "$T/install/code-runner-state/maintenance"

# A signal: bash runs the EXIT trap on the way out. Only kill -9 can leave the lock, and then the doctor names it.
rm -f "$T/install/code-runner-state/maintenance"; : > "$T/install/code-runner/.env"
LOCK="$T/install/code-runner-state/maintenance" TARGET_DIR="$T/install" UTIL_DIR="$ROOT/util" bash -c '
    GREEN= YELLOW= RED= BLUE= NC=
    eval "$1"
    kill -TERM $$
    sleep 5
' _ "$lock" >/dev/null 2>&1
[ ! -f "$T/install/code-runner-state/maintenance" ] && ok || bad "SIGTERM left the lock"

# --- the dependencies, under the trap: npm failing warns, it does not end the upgrade
mkdir -p "$T/bin"
printf '#!/bin/bash\necho "npm $*"; exit "${NPM_RC:-0}"\n' > "$T/bin/npm"; chmod +x "$T/bin/npm"
run_deps() { # run_deps INSTALLED NPM_RC
    rm -f "$T/install/code-runner/.env"; [ "$1" = 1 ] && : > "$T/install/code-runner/.env"
    PATH="$T/bin:$PATH" NPM_RC="$2" TARGET_CODE_RUNNER="$T/install/code-runner" TARGET_DIR="$T/install" bash -c '
        set -e
        trap "echo TRAP-FIRED; exit 9" ERR
        GREEN= YELLOW= RED= BLUE= NC=
        eval "$1"
        echo "FAILED=[${CODE_REVIEW_SANDBOX_FAILED:-}]"
        echo "REACHED-END"
    ' _ "$deps" 2>&1
}
out=$(run_deps 1 0)
has   "deps: installed exactly" "$out" "npm ci"
has   "deps: finished" "$out" "REACHED-END"
has   "deps: no claim on a release with no pass" "$out" "STUB-HOLD-CALLED"
out=$(HOLD_RC=1 run_deps 1 0)
has   "hold fails: says so" "$out" "could not turn code review off"
has   "hold fails: ends the upgrade with exit 3" "$out" "FAILED=\[code review could not be turned off"
has   "hold fails: finished" "$out" "REACHED-END"
hasnt "hold fails: trap" "$out" "TRAP-FIRED"
out=$(run_deps 0 0)
hasnt "deps: not on a node without the sandbox" "$out" "npm ci"
hasnt "deps: no hold on a node without the sandbox" "$out" "STUB-HOLD-CALLED"
out=$(run_deps 1 1)
has   "deps fail: reason kept" "$out" "FAILED=\[.*code-runner"
has   "deps fail: finished" "$out" "REACHED-END"
hasnt "deps fail: trap" "$out" "TRAP-FIRED"

echo "upgrade-code-review-sandbox-trap: pass=$pass fail=$fail"; [ "$fail" = 0 ]
