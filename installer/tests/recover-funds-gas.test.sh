#!/bin/bash
# recover-chainlink-funds.sh sent every ETH sweep with a hard-coded 21000 gas
# limit; an owner wallet that is a smart account (EIP-7702) needs more and
# every transfer reverted (issue #61). Runs the REAL estimation helper against
# a fake curl and pins the send call.
# Run: bash installer/tests/recover-funds-gas.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/bin/recover-chainlink-funds.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
helper=$(awk '/^estimate_transfer_gas\(\) \{/{p=1} p{print} p && /^\}/{p=0}' "$S")
[ -n "$helper" ] && ok || bad "estimate_transfer_gas() not found"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT; mkdir -p "$T/bin"
fake_curl() { printf '#!/bin/bash\ncat <<'"'"'JSON'"'"'\n%s\nJSON\n' "$1" > "$T/bin/curl"; chmod +x "$T/bin/curl"; }
run() { ( PATH="$T/bin:$PATH"; eval "$helper"; estimate_transfer_gas 0xfrom 0xto 3999874000000000 http://rpc ); }
# A smart-account owner: the node says 21220 → 25% margin → 26525.
fake_curl '{"jsonrpc":"2.0","id":1,"result":"0x52e4"}'
out=$(run); [ "$out" = "26525" ] && ok || bad "smart-account estimate: got $out, want 26525"
# A plain EOA: 21000 → margin would be 26250 (never below 21000).
fake_curl '{"jsonrpc":"2.0","id":1,"result":"0x5208"}'
out=$(run); [ "$out" = "26250" ] && ok || bad "EOA estimate: got $out"
# A failing RPC: falls back to 21000.
fake_curl '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"boom"}}'
out=$(run); [ "$out" = "21000" ] && ok || bad "error fallback: got $out"
printf '#!/bin/bash\nexit 7\n' > "$T/bin/curl"; chmod +x "$T/bin/curl"
out=$(run); [ "$out" = "21000" ] && ok || bad "curl failure fallback: got $out"
# The ETH send uses the estimate, never the literal 21000, and the cost subtracted uses it too.
grep -q 'send_eth_transaction "$CHAINLINK_PRIVATE_KEY" "$OWNER_WALLET" "$ACTUAL_ETH_AMOUNT_WEI" "$ETH_GAS_LIMIT"' "$S" && ok || bad "the ETH send does not pass the estimated limit"
grep -q 'send_eth_transaction "$CHAINLINK_PRIVATE_KEY" "$OWNER_WALLET" "$ACTUAL_ETH_AMOUNT_WEI" "21000"' "$S" && bad "the ETH send still hard-codes 21000" || ok
grep -q 'GAS_COST_WEI=$(echo "$ETH_GAS_LIMIT \* $GAS_PRICE"' "$S" && ok || bad "the subtracted gas cost does not use the estimated limit"
grep -q 'scale=4; $GAS_PRICE / 1000000000' "$S" && ok || bad "gas price still printed with 2 decimals (0.006 gwei shows as 0)"
echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
