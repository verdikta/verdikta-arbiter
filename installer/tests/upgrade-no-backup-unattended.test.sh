#!/bin/bash
# upgrade-arbiter.sh, told VA_UPGRADE_BACKUP=n unattended, must RUN: the "are you
# sure?" prompt has no answer key, and with the interactive default (n) the run
# cancelled itself and exited 0 — a no-op reported as success — issue #49.
# Runs the script's real prompt line through the real prompts library.
# Run: bash installer/tests/upgrade-no-backup-unattended.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/bin/upgrade-arbiter.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }

line=$(grep -E 'ask_yes_no "Are you sure you want to continue without a backup\?"' "$S")
[ -n "$line" ] && ok || bad "prompt line not found"
call=$(printf '%s' "$line" | sed -E 's/^[[:space:]]*if ! (ask_yes_no .*); then[[:space:]]*$/\1/')
[ "$call" != "$line" ] && ok || bad "could not isolate the ask_yes_no call from: $line"

# Unattended with no key set: the call must answer yes (return 0) — the backup
# question itself was already answered n on purpose.
if ( export VERDIKTA_UNATTENDED=1; source "$ROOT/lib/prompts.sh"; eval "$call" ) >/dev/null 2>&1; then ok; else bad "unattended run still cancels itself (prompt answered no)"; fi
# Interactive behaviour unchanged: an empty answer means the default, no.
if ( unset VERDIKTA_UNATTENDED; source "$ROOT/lib/prompts.sh"; eval "$call" ) </dev/null >/dev/null 2>&1; then bad "interactive default is no longer no"; else ok; fi
if ( unset VERDIKTA_UNATTENDED; source "$ROOT/lib/prompts.sh"; eval "$call" ) <<< "y" >/dev/null 2>&1; then ok; else bad "an interactive yes is not accepted"; fi
# The cancel path still exists for an interactive no.
grep -A1 'continue without a backup' "$S" | grep -q 'Upgrade cancelled by user' && ok || bad "the cancel branch is gone"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
