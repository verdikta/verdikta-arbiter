#!/bin/bash
# The reconfigure banner names the classes the registration actually uses:
# VA_CLASS_IDS when the answers set it, else the recorded classes (issue #55).
# Evaluates the script's REAL banner line.
# Run: bash installer/tests/reconfigure-banner-classes.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/bin/upgrade-arbiter.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
line=$(grep -E 'echo -e .*Registering the new job ids with \$RECONF_AGGREGATOR' "$S")
[ "$(printf '%s\n' "$line" | wc -l | tr -d ' ')" = "1" ] && ok || bad "expected exactly one banner line, got: $line"
banner() { ( BLUE=; NC=; RECONF_AGGREGATOR=0xAGG; RECONF_CLASSES="128"; export ${1:+VA_CLASS_IDS="$1"}; eval "$line" ); }
# Unattended answers set the classes: the banner names them.
out=$(VA_CLASS_IDS="128 5555" bash -c "BLUE=; NC=; RECONF_AGGREGATOR=0xAGG; RECONF_CLASSES=128; $line")
[ "$out" = "Registering the new job ids with 0xAGG (classes [128 5555])..." ] && ok || bad "with VA_CLASS_IDS: $out"
# No answer: the recorded classes.
out=$(env -u VA_CLASS_IDS bash -c "BLUE=; NC=; RECONF_AGGREGATOR=0xAGG; RECONF_CLASSES=128; $line")
[ "$out" = "Registering the new job ids with 0xAGG (classes [128])..." ] && ok || bad "without VA_CLASS_IDS: $out"
# The registration call right after it uses the same rule (VA_CLASS_IDS wins).
grep -q 'VA_CLASS_IDS="${VA_CLASS_IDS:-$RECONF_CLASSES}"' "$S" && ok || bad "the registration call no longer prefers VA_CLASS_IDS"
echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
