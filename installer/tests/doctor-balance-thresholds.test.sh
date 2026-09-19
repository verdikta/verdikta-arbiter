#!/bin/bash
# Node-key ETH thresholds and default funding are sized for Base gas, not L1
# (issue #58): PASS >= 0.001 ETH, WARN >= 0.0002, FAIL below; recommended and
# default mainnet funding 0.001. Static pins on the constants.
# Run: bash installer/tests/doctor-balance-thresholds.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
for D in util/arbiter-doctor.sh util/remote-doctor.sh; do
  f="$ROOT/$D"
  grep -q 'int(sys.argv\[1\])>=2\*10\*\*14' "$f" && ok || bad "$D: FAIL boundary is not 0.0002 ETH"
  grep -q 'int(sys.argv\[1\])>=10\*\*15 else 1)" "$bal_wei"; then' "$f" && ok || bad "$D: PASS boundary is not 0.001 ETH"
  grep -q '>=5\*10\*\*15' "$f" && bad "$D: the L1-era 0.005 PASS boundary is back" || ok
  grep -q 'below 0.0002 threshold' "$f" && ok || bad "$D: FAIL message does not say 0.0002"
  grep -q -- '--amount 0.01"' "$f" && bad "$D: a hint still says --amount 0.01" || ok
  grep -q -- '--amount 0.001' "$f" && ok || bad "$D: no --amount 0.001 hint"
done
grep -q '^        RECOMMENDED_AMOUNT="0.001"' "$ROOT/bin/install.sh" && ok || bad "install.sh: recommended mainnet amount is not 0.001"
grep -q '^        RECOMMENDED_AMOUNT="0.005"' "$ROOT/bin/install.sh" && ok || bad "install.sh: testnet amount changed"
grep -q '^DEFAULT_FUNDING_AMOUNT_MAINNET="0.001"' "$ROOT/bin/fund-chainlink-keys.sh" && ok || bad "fund-chainlink-keys.sh: mainnet default is not 0.001"
grep -q 'MIN_WALLET_BALANCE_THRESHOLD' "$ROOT/bin/fund-chainlink-keys.sh" && bad "fund-chainlink-keys.sh: dead 0.01 constant is back" || ok
echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
