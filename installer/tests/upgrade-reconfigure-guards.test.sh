#!/bin/bash
# Pins for the job-reconfiguration path of installer/bin/upgrade-arbiter.sh (issue #38):
# the script runs under `set -e` with an ERR trap, so every dispatcher/installer
# call whose failure must reach an `if [ "$rc" … ]` check has to read its exit
# code as `rc=0; cmd || rc=$?`. `set +e` … `set -e` around the call does not
# help: the ERR trap fires on a failing plain command whether or not errexit is
# on (#97 — the start-at-boot block died that way on the first canary upgrade).
# A failed reconfiguration must be reported on the last line with exit 3, and
# the error trap must restart an arbiter that was running before the attempt.
# These are static pins; upgrade-reconfigure-trap.test.sh runs the real block
# under the real trap semantics. The JS retry is covered by
# arbiter-operator/scripts/lib/inflight.test.js.
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
# Deregistration: its rc read with `||` (unattended and interactive call alike),
# its output counted.
check "dereg rc initialised" '^[[:space:]]*dereg_rc=0[[:space:]]*$'
check "dereg rc" 'run_echo_capture bash unregister-oracle.sh --unattended [|][|] dereg_rc=\$\?'
check "dereg rc (interactive)" 'run_echo_capture bash unregister-oracle.sh <<< .* [|][|] dereg_rc=\$\?'
check "dereg env reaches the script" 'VA_DEREGISTER_ORACLE=y VA_AGGREGATOR_ADDRESS="\$RECONF_AGGREGATOR" run_echo_capture'
check "dereg output captured" 'dereg_out="\$CAPTURED_OUT"'
check "capture keeps the pipe status" 'set -o pipefail; "\$@" 2>&1 \| tee "\$_cap" >&2'
check "dereg count" 'RECONF_DEREGISTERED=\$\(printf'
check "dereg abort sets failed" 'RECONF_ABORT=1' 
check "dereg summary" 'RECONF_SUMMARY="deregistered \$RECONF_DEREGISTERED of \$RECONF_TOTAL job'
# configure-node and registration: their rc read with `||`.
check "configure guarded" 'bash "\$SCRIPT_DIR/configure-node.sh"' 
check "configure rc initialised" '^[[:space:]]*RECONF_RC=0[[:space:]]*$'
check "configure rc" 'bash "\$SCRIPT_DIR/configure-node.sh" [|][|] RECONF_RC=\$\?'
check "register rc initialised" '^[[:space:]]*reg_rc=0[[:space:]]*$'
check "register rc" 'bash register-oracle.sh --unattended [|][|] reg_rc=\$\?'
check "register rc (interactive)" 'bash register-oracle.sh [|][|] reg_rc=\$\?'
check "register summary" 'RECONF_SUMMARY="the new jobs and keys were created but registering them'
# No `set +e` guard anywhere in the script: it never shields a command from the
# ERR trap, so one is a bug waiting for the first non-zero exit (#97).
plus=$(grep -cE '^[[:space:]]*set \+e' "$S")
[ "$plus" -eq 0 ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL set +e guards present: $plus (read exit codes with 'rc=0; cmd || rc=\$?')"; }
# The failure is the LAST thing the script says, with exit 3.
tail -6 "$S" | grep -q 'RECONFIGURE FAILED: \${RECONF_SUMMARY}' && tail -6 "$S" | grep -qE '^\s*exit 3\s*$' && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL final exit 3"; }
# The error trap restarts a node that was running before the attempt.
awk '/^cleanup_on_error\(\)/,/^}/' "$S" | grep -q 'bash "\$TARGET_DIR/start-arbiter.sh" ||' && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL trap restart"; }

# ── The job log survives the capture (#42) ───────────────────────────────────
# `tee /dev/stderr` re-opens the path with O_TRUNC: with stderr on a file (the
# agents platform's job log) it wiped every earlier line and left a NUL hole.
# Run the script's REAL run_echo_capture with stderr on a file that already has
# content, opened the way the job launcher opens it (truncate once, no append).
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL $1"; }
fn=$(awk '/^run_echo_capture\(\) \{$/{p=1} p{print} p&&/^}$/{exit}' "$S")
[ -n "$fn" ] && ok || bad "could not extract run_echo_capture"
LOG=$(mktemp); trap 'rm -f "$LOG"' EXIT
bash -c "$fn"'
echo "before-1" >&2
echo "before-2" >&2
FOO=bar run_echo_capture bash -c "echo out-line; echo err-line >&2; echo env=\$FOO; exit 7"; rc=$?
echo "after rc=$rc captured=[$(printf %s "$CAPTURED_OUT" | sort | tr "\n" "|")]" >&2
run_echo_capture bash -c "read a; read b; read c; echo answers=\$a,\$b,\$c" <<< "$(printf "y\n%s\ny" 0xAGG)"; rc=$?
echo "stdin rc=$rc captured=[$CAPTURED_OUT]" >&2
' 2> "$LOG"
grep -q '^before-1$' "$LOG" && grep -q '^before-2$' "$LOG" && ok || bad "lines logged before the capture were lost"
[ "$(tr -cd '\000' < "$LOG" | wc -c | tr -d ' ')" = "0" ] && ok || bad "the log has a NUL hole"
grep -q '^out-line$' "$LOG" && grep -q '^err-line$' "$LOG" && ok || bad "the command output was not echoed to the log"
grep -q '^after rc=7 captured=\[env=bar|err-line|out-line|\]$' "$LOG" && ok || bad "rc / captured output / env prefix: $(grep '^after' "$LOG")"
grep -q '^stdin rc=0 captured=\[answers=y,0xAGG,y\]$' "$LOG" && ok || bad "stdin answers did not reach the command: $(grep '^stdin' "$LOG")"
[ "$(grep -n -E '^(before-2|out-line|after rc)' "$LOG" | cut -d: -f2 | tr '\n' ' ')" = "before-2 out-line after rc=7 captured=[env=bar|err-line|out-line|] " ] && ok || bad "log order"
# No script may tee onto a re-opened standard stream (comment lines may name the idiom).
tee_hits=$(grep -rnE 'tee +(-a +)?(/dev/(std(err|out)|fd/[0-9])|/proc/self/fd)' "$ROOT/bin" "$ROOT/util" "$ROOT/lib" 2>/dev/null | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)
[ -z "$tee_hits" ] && ok || bad "tee onto a re-opened standard stream: $tee_hits"

echo "pass=$pass fail=$fail"
[ "$fail" = "0" ]
