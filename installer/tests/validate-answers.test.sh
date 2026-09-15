#!/bin/bash
# Tests for installer/bin/validate-answers.sh (run: bash installer/tests/validate-answers.test.sh)
set -u
V="$(cd "$(dirname "$0")/.." && pwd)/bin/validate-answers.sh"
pass=0; fail=0
expect() { # expect CODE MODE ENV...
    local code="$1" mode="$2"; shift 2
    env -i PATH="$PATH" HOME="$HOME" "$@" bash "$V" "$mode" >/dev/null 2>&1; local rc=$?
    if [ "$rc" = "$code" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: expected $code got $rc for [$mode] $*"; fi
}
PK="VA_PRIVATE_KEY=$(printf 'a%.0s' $(seq 1 64))"
RPC="VA_RPC_HTTP_URLS=https://a;https://b" ; WS="VA_RPC_WS_URLS=wss://a;wss://b"
expect 65 install                                        # nothing set
expect 65 install "$PK"                                  # no RPC
expect 0  install "$PK" "$RPC" "$WS"                     # minimal valid
expect 0  install "$PK" VA_INFURA_API_KEY=abc            # infura route
expect 0  install "VA_PRIVATE_KEY=0x$(printf 'b%.0s' $(seq 1 64))" VA_INFURA_API_KEY=abc   # 0x tolerated
expect 65 install "VA_PRIVATE_KEY=deadbeef" VA_INFURA_API_KEY=abc                          # bad key shape
expect 65 install "$PK" "$RPC" "VA_RPC_WS_URLS=wss://a"                                    # unpaired lists
expect 65 install "$PK" "$RPC" "$WS" VA_NETWORK=polygon
expect 0  install "$PK" "$RPC" "$WS" VA_NETWORK=base_mainnet
expect 65 install "$PK" "$RPC" "$WS" VA_START_SERVICES=maybe
expect 65 install "$PK" "$RPC" "$WS" VA_ARBITER_COUNT=11
expect 0  install "$PK" "$RPC" "$WS" VA_ARBITER_COUNT=10 VA_JUSTIFICATION_MODEL=4 VA_LOG_LEVEL=debug
expect 65 install "$PK" "$RPC" "$WS" VA_REGISTER_ORACLE=y                                  # needs aggregator
expect 65 install "$PK" "$RPC" "$WS" VA_REGISTER_ORACLE=y VA_AGGREGATOR_ADDRESS=0x123
expect 0  install "$PK" "$RPC" "$WS" VA_REGISTER_ORACLE=y "VA_AGGREGATOR_ADDRESS=0x$(printf 'c%.0s' $(seq 1 40))" "VA_CLASS_IDS=128,129"
expect 65 install "$PK" "$RPC" "$WS" VA_REGISTER_ORACLE=y "VA_AGGREGATOR_ADDRESS=0x$(printf 'c%.0s' $(seq 1 40))" "VA_CLASS_IDS=128;x"
expect 65 install "$PK" "$RPC" "$WS" VA_FUND_AMOUNT=-1
expect 0  install "$PK" "$RPC" "$WS" VA_FUND_KEYS=y VA_FUND_AMOUNT=0.005
expect 65 install "$PK" "$RPC" "$WS" VA_ORACLE_FEE_ETH=0.002       # above the 0.0004 ceiling (the value the old script hard-coded)
expect 65 install "$PK" "$RPC" "$WS" VA_ORACLE_FEE_ETH=abc
expect 0  install "$PK" "$RPC" "$WS" VA_ORACLE_FEE_ETH=0.00002
expect 65 install "$PK" "$RPC" "$WS" VA_CHAINLINK_EMAIL=notanemail
expect 0  upgrade                                        # upgrade needs nothing
expect 65 upgrade VA_UPGRADE_REVIEW_API_KEYS=y
expect 65 upgrade VA_UPGRADE_UPDATE_JUSTIFIER=y
expect 0  upgrade VA_UPGRADE_UPDATE_JUSTIFIER=y "VA_JUSTIFIER_MODEL=OpenAI:gpt-5-nano"
expect 65 upgrade VA_UPGRADE_UPDATE_RPC=y
expect 0  upgrade VA_UPGRADE_UPDATE_RPC=y VA_INFURA_API_KEY=k
# secrets never echoed
out=$(env -i PATH="$PATH" HOME="$HOME" VA_PRIVATE_KEY=deadbeef VA_INFURA_API_KEY=SECRETINFURA bash "$V" install 2>&1)
if echo "$out" | grep -q 'SECRETINFURA\|deadbeef'; then fail=$((fail+1)); echo "FAIL: secret echoed"; else pass=$((pass+1)); fi
echo "pass=$pass fail=$fail"; [ "$fail" -eq 0 ]
