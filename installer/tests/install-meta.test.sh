#!/bin/bash
# Tests for installer/lib/install-meta.sh (issue #25). Run: bash installer/tests/install-meta.test.sh
set -u
LIB="$(cd "$(dirname "$0")/.." && pwd)/lib/install-meta.sh"
pass=0; fail=0
T=$(mktemp -d); mkdir -p "$T/clone/installer" "$T/target/installer"
source "$LIB"
# live file present -> kept byte-for-byte, clone ignored
printf 'OPERATOR_ADDR="0xold"\nAGGREGATOR_ADDRESS="0xe8a3"\n' > "$T/target/installer/.contracts"
printf 'OPERATOR_ADDR="0xold"\n' > "$T/clone/installer/.contracts"
out=$(copy_if_missing "$T/clone/installer/.contracts" "$T/target/installer/.contracts" "Contract information")
grep -q AGGREGATOR_ADDRESS "$T/target/installer/.contracts" && echo "$out" | grep -q "Keeping the live" && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: live file clobbered or wrong message: $out"; }
# live file missing, clone has one -> copied
rm -f "$T/target/installer/.env"; printf 'BASE_SEPOLIA_RPC_URL=x\n' > "$T/clone/installer/.env"
out=$(copy_if_missing "$T/clone/installer/.env" "$T/target/installer/.env" "Environment information")
[ -f "$T/target/installer/.env" ] && echo "$out" | grep -q "copied to" && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: not copied: $out"; }
# neither -> no error, says so
out=$(copy_if_missing "$T/clone/nope" "$T/target/nope" "Thing"); rc=$?
[ "$rc" = "0" ] && echo "$out" | grep -q "not found" && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: missing-both: rc=$rc $out"; }
echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
