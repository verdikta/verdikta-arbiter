#!/bin/bash
# Tests for installer/util/unregister-oracle.sh in unattended mode (issue #22):
# the aggregator recorded in installer/.contracts is the one deregistered from.
# Run: bash installer/tests/unregister-unattended.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0
mk() { # mk AGG_LINE -> prints fake install dir
    local d; d=$(mktemp -d)
    mkdir -p "$d/arbiter-operator/scripts" "$d/installer/lib" "$d/bin"
    cp "$ROOT/lib/prompts.sh" "$d/installer/lib/"; cp "$ROOT/util/unregister-oracle.sh" "$d/"
    echo '{"name":"fake"}' > "$d/arbiter-operator/package.json"
    printf 'PRIVATE_KEY=%s\nBASE_SEPOLIA_RPC_URL=https://sepolia.base.org\n' "$(printf 'a%.0s' $(seq 1 64))" > "$d/installer/.env"
    printf 'DEPLOYMENT_NETWORK="base_sepolia"\nOPERATOR_ADDR="0x3DFb5e4Ef9374D899E178a10279CA89Ef1bc00FD"\nNODE_ADDRESS="0xa5Dc7F0f28976Db89d8E0c41d29027EFb0950e1b"\nJOB_ID_1_NO_HYPHENS="bd5c4128cd444437a5448cd616dcd009"\nCLASSES_ID="128"\n%s\n' "$1" > "$d/installer/.contracts"
    printf '#!/bin/bash\necho "FAKE node $*"\n' > "$d/bin/node"; printf '#!/bin/bash\n' > "$d/bin/npm"; chmod +x "$d/bin/node" "$d/bin/npm"
    echo "$d"
}
run() { # run DIR ENV... -> stdout+stderr
    local d="$1"; shift
    (cd "$d" && env "$@" PATH="$d/bin:$PATH" VERDIKTA_UNATTENDED= bash ./unregister-oracle.sh --unattended 2>&1)
}
REC=0xe8a385E473EA710c5a88Cc72681a16a26fe380e4
OTHER=0x262f48f06DEf1FE49e0568dB4234a3478A191cFd
# 1. recorded aggregator, nothing given -> used
d=$(mk "AGGREGATOR_ADDRESS=\"$REC\""); out=$(run "$d" VA_DEREGISTER_ORACLE=y)
echo "$out" | grep -q -- "--aggregator $REC" && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL 1: $out" | tail -5; }
# 2. recorded aggregator, a DIFFERENT one given -> recorded wins, with a warning
d=$(mk "AGGREGATOR_ADDRESS=\"$REC\""); out=$(run "$d" VA_DEREGISTER_ORACLE=y VA_AGGREGATOR_ADDRESS=$OTHER)
echo "$out" | grep -q -- "--aggregator $REC" && echo "$out" | grep -q "differs from the aggregator this node registered with" && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL 2: $out" | tail -5; }
# 3. nothing recorded, one given -> given
d=$(mk ""); out=$(run "$d" VA_DEREGISTER_ORACLE=y VA_AGGREGATOR_ADDRESS=$OTHER)
echo "$out" | grep -q -- "--aggregator $OTHER" && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL 3: $out" | tail -5; }
# 4. nothing recorded, nothing given -> exit 65, node never called
d=$(mk ""); (cd "$d" && env VA_DEREGISTER_ORACLE=y PATH="$d/bin:$PATH" bash ./unregister-oracle.sh --unattended >/dev/null 2>&1); rc=$?
[ "$rc" = "65" ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL 4: rc=$rc"; }
# 5. not asked to deregister -> cancels, exit 0, node never called
d=$(mk "AGGREGATOR_ADDRESS=\"$REC\""); out=$(run "$d"); rc=$?
[ "$rc" = "0" ] && echo "$out" | grep -q "cancelled" && ! echo "$out" | grep -q "FAKE node" && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL 5: rc=$rc $out" | tail -3; }
echo "pass=$pass fail=$fail"
[ "$fail" = "0" ]
