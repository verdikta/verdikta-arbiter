#!/bin/bash
# register-oracle-dispatcher.sh and register-oracle.sh refuse a code ClassID (133, 134),
# or 5555 while code review is on, without a conformance pass, and refuse one job on
# both code classes: such a job is eligible for both price tiers (S1). Runs the REAL
# scripts and the REAL code-review-check.js in a throwaway tree, with a stub
# register-oracle-cl.js recording what would have gone on chain.
# Run: bash installer/tests/code-review-gate.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if printf '%s\n' "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if printf '%s\n' "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

T=$(cd "$(mktemp -d)" && pwd -P); trap 'rm -rf "$T"' EXIT
HASH=$(printf 'cafe%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16)

tree() { # a repo-shaped tree and an install-shaped tree, in one directory $I
    rm -rf "$T/i"; I="$T/i"
    mkdir -p "$I/installer/bin" "$I/installer/lib" "$I/installer/util" "$I/arbiter-operator/scripts" "$I/arbiter-operator/node_modules" "$I/external-adapter" "$I/code-runner/.state" "$I/code-runner/node_modules/@verdikta/common"
    cp "$ROOT/bin/register-oracle-dispatcher.sh" "$I/installer/bin/"
    cp "$ROOT/lib/prompts.sh" "$I/installer/lib/"
    cp "$ROOT/util/code-review-check.js" "$I/installer/util/"
    cp "$ROOT/util/code-review-check.js" "$I/"
    cp "$ROOT/util/register-oracle.sh" "$I/"
    cat > "$I/installer/.env" <<E
DEPLOYMENT_NETWORK="base_sepolia"
NETWORK_NAME="Base Sepolia"
NETWORK_TYPE="testnet"
PRIVATE_KEY="not-a-real-key"
INSTALL_DIR="$I"
BASE_SEPOLIA_RPC_HTTP_URLS="http://127.0.0.1:1"
E
    cat > "$I/installer/.contracts" <<'E'
OPERATOR_ADDR="0x1111111111111111111111111111111111111111"
NODE_ADDRESS="0x2222222222222222222222222222222222222222"
LINK_TOKEN_ADDRESS_BASE_SEPOLIA="0x3333333333333333333333333333333333333333"
JOB_ID_1_NO_HYPHENS="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
JOB_ID_2_NO_HYPHENS="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
ARBITER_COUNT=2
E
    cat > "$I/arbiter-operator/scripts/register-oracle-cl.js" <<'E'
require('fs').appendFileSync(process.env.REG_LOG, process.argv.slice(2).join(' ') + '\n');
E
    cat > "$I/code-runner/package.json" <<'J'
{ "name": "verdikta-code-runner", "version": "0.1.0", "dependencies": { "@verdikta/common": "9.9.9-test" } }
J
    cat > "$I/code-runner/node_modules/@verdikta/common/package.json" <<'J'
{ "name": "@verdikta/common", "version": "9.9.9-test", "main": "index.js" }
J
    cat > "$I/code-runner/node_modules/@verdikta/common/index.js" <<J
module.exports = { codeReview: { CODE_CLASS_IDS: [133, 134], GVISOR_RELEASE: 'release-20260921.0',
  CONFORMANCE_CANARY: { reportSha256: '$HASH', runner: '0.1.0' } } };
J
    : > "$T/reg.log"
}
good_pass() {
    printf '{"pass":true,"reportSha256":"%s","runner":"0.1.0","gvisor":"release-20260921.0","commonVersion":"9.9.9-test","at":"2026-11-04T00:00:00Z"}\n' "$HASH" > "$I/code-runner/.state/conformance.json"
}
dispatcher() { # dispatcher CLASSES [more env]
    env REG_LOG="$T/reg.log" VERDIKTA_UNATTENDED=1 VA_REGISTER_ORACLE=y VA_AGGREGATOR_ADDRESS=0x4444444444444444444444444444444444444444 VA_CLASS_IDS="$1" "${@:2}" \
        bash "$I/installer/bin/register-oracle-dispatcher.sh" 2>&1
}
standalone() { # the install root's script
    env REG_LOG="$T/reg.log" VERDIKTA_UNATTENDED=1 VA_REGISTER_ORACLE=y VA_AGGREGATOR_ADDRESS=0x4444444444444444444444444444444444444444 NEW_AGGREGATOR_ADDRESS=0x4444444444444444444444444444444444444444 VA_CLASS_IDS="$1" "${@:2}" \
        bash "$I/register-oracle.sh" --unattended 2>&1
}
refused() { # refused NAME OUT RC [TEXT]
    [ "$3" != 0 ] && ok || bad "$1: exit 0"
    [ -s "$T/reg.log" ] && bad "$1: reached register-oracle-cl.js: $(cat "$T/reg.log")" || ok
    [ -n "${4:-}" ] && has "$1" "$2" "$4"
}
went() { # went NAME OUT RC
    [ "$3" = 0 ] && ok || bad "$1: exit $3: $2"
    [ -s "$T/reg.log" ] && ok || bad "$1: never reached register-oracle-cl.js: $2"
}

for script in dispatcher standalone; do
    # A text class needs nothing.
    tree; out=$($script 128); rc=$?; went "$script 128, no sandbox" "$out" $rc
    # A code class needs a pass.
    tree; out=$($script 133); rc=$?; refused "$script 133, no pass" "$out" $rc "conformance"
    tree; out=$($script 134); rc=$?; refused "$script 134, no pass" "$out" $rc "conformance"
    tree; out=$($script "128 133"); rc=$?; refused "$script 128 133, no pass" "$out" $rc "conformance"
    tree; out=$($script "128,133"); rc=$?; refused "$script comma-separated, no pass" "$out" $rc "conformance"
    tree; good_pass; out=$($script 133); rc=$?; went "$script 133, pass" "$out" $rc
    has "$script 133, pass: the classes reach the script" "$(cat "$T/reg.log")" "--classes 133"
    # A pass is for this release: another hash, runner or common is none.
    tree; good_pass; sed -i.b 's/"reportSha256":"cafe/"reportSha256":"beef/' "$I/code-runner/.state/conformance.json"; out=$($script 133); rc=$?; refused "$script 133, another hash" "$out" $rc "conformance"
    tree; good_pass; sed -i.b 's/"runner":"0.1.0"/"runner":"0.0.9"/' "$I/code-runner/.state/conformance.json"; out=$($script 133); rc=$?; refused "$script 133, older runner's pass" "$out" $rc "conformance"
    tree; good_pass; sed -i.b 's/"commonVersion":"9.9.9-test"/"commonVersion":"1.0.0"/' "$I/code-runner/.state/conformance.json"; out=$($script 133); rc=$?; refused "$script 133, older common's pass" "$out" $rc "conformance"
    tree; good_pass; sed -i.b 's/"pass":true/"pass":false/' "$I/code-runner/.state/conformance.json"; out=$($script 133); rc=$?; refused "$script 133, recorded fail" "$out" $rc "conformance"
    tree; echo 'not json' > "$I/code-runner/.state/conformance.json"; out=$($script 133); rc=$?; refused "$script 133, unreadable pass" "$out" $rc "conformance"
    # 5555: the canary class, text until code review is on.
    tree; out=$($script 5555); rc=$?; went "$script 5555, code review off" "$out" $rc
    tree; echo 'CODE_REVIEW_ENABLED=false' > "$I/external-adapter/.env"; out=$($script 5555); rc=$?; went "$script 5555, code review false" "$out" $rc
    tree; echo 'CODE_REVIEW_ENABLED=true' > "$I/external-adapter/.env"; out=$($script 5555); rc=$?; refused "$script 5555, code review on, no pass" "$out" $rc "conformance"
    tree; echo 'CODE_REVIEW_ENABLED=true' > "$I/external-adapter/.env"; good_pass; out=$($script 5555); rc=$?; went "$script 5555, code review on, pass" "$out" $rc
    # One job on both tiers, even with a pass.
    tree; good_pass; out=$($script "133 134"); rc=$?; refused "$script both tiers" "$out" $rc "both"
    tree; good_pass; out=$($script "134,128,133"); rc=$?; refused "$script both tiers, mixed" "$out" $rc "both"
    # Separate jobs are how the tiers coexist: a registration can name its jobs.
    tree; good_pass; out=$($script 133 VA_REGISTER_JOB_IDS=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa); rc=$?; went "$script one job" "$out" $rc
    has "$script names that job" "$(cat "$T/reg.log")" "--jobids aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --classes"
    hasnt "$script leaves the other" "$(cat "$T/reg.log")" "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    tree; good_pass; out=$($script 133 VA_REGISTER_JOB_IDS=cccccccccccccccccccccccccccccccc); rc=$?; refused "$script an unknown job" "$out" $rc "not one of this node's jobs"
    # A class id that hides the digits is not a way round.
    tree; out=$($script "0133"); rc=$?; refused "$script 0133" "$out" $rc "conformance"
    # The helper missing: code classes refused, text still goes.
    tree; rm -f "$I/code-review-check.js" "$I/installer/util/code-review-check.js"; out=$($script 133); rc=$?; refused "$script no helper, 133" "$out" $rc
    tree; rm -f "$I/code-review-check.js" "$I/installer/util/code-review-check.js"; echo 'CODE_REVIEW_ENABLED=true' > "$I/external-adapter/.env"; out=$($script 5555); rc=$?; refused "$script no helper, 5555" "$out" $rc
    tree; rm -f "$I/code-review-check.js" "$I/installer/util/code-review-check.js"; out=$($script 128); rc=$?; went "$script no helper, 128" "$out" $rc
done

echo "code-review-gate: pass=$pass fail=$fail"; [ "$fail" = 0 ]
