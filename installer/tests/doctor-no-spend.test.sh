#!/bin/bash
# `arbiter-doctor.sh --fix --yes` auto-confirms every repair, and the repair for a
# failing node-key balance SPENDS (fund-chainlink-keys.sh --amount 0.001). Automated
# callers gate spending separately, so --no-spend must skip it — issue #45.
# Runs the doctor's real balance fix case against a recording fake fund script.
# Run: bash installer/tests/doctor-no-spend.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCTOR="$ROOT/util/arbiter-doctor.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }

fix_case=$(awk '/^            chain\.node_balance_zero\|chain\.node_balance\)$/{p=1} p{print} p&&/^                ;;$/{exit}' "$DOCTOR")
[ -n "$fix_case" ] && ok || bad "could not extract the balance fix case"

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
printf '#!/bin/bash\necho "FUNDED $*" >> "%s/calls"\n' "$T" > "$T/fund-chainlink-keys.sh"; chmod +x "$T/fund-chainlink-keys.sh"
run_case() { # run_case NO_SPEND ID -> output; prompts auto-confirm (as --yes does)
    bash -c 'INSTALL_DIR="$1"; NO_SPEND="$2"; prompt_yes_no() { return 0; }
f() { local id="$3"; case "$id" in
'"$fix_case"'
esac; }; f "$@"' _ "$T" "$1" "$2" 2>&1
}

for id in chain.node_balance_zero chain.node_balance; do
    rm -f "$T/calls"
    out=$(run_case 1 "$id")
    [ ! -f "$T/calls" ] && ok || bad "$id: --no-spend still ran the fund script: $(cat "$T/calls")"
    echo "$out" | grep -q 'skipped: this repair spends ETH' && ok || bad "$id: the skip is not reported: $out"
    echo "$out" | grep -q 'fund-chainlink-keys.sh --amount <eth>' && ok || bad "$id: the skip does not name the command to run"
done
# Without the flag the repair is unchanged.
rm -f "$T/calls"; run_case 0 chain.node_balance_zero >/dev/null
grep -q '^FUNDED --amount 0.001$' "$T/calls" 2>/dev/null && ok || bad "without --no-spend the repair no longer funds"

# Flag parsing and help.
grep -qE '^\s*--no-spend\) NO_SPEND=1; shift ;;' "$DOCTOR" && ok || bad "--no-spend is not parsed"
grep -qE '^NO_SPEND=0' "$DOCTOR" && ok || bad "NO_SPEND has no default"
bash "$DOCTOR" --help 2>/dev/null | grep -q -- '--no-spend' && ok || bad "--help does not document --no-spend"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
