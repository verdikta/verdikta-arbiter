#!/bin/bash
# A job reconfiguration must leave installer/.contracts coherent — issue #43.
# `chainlink keys eth list` has no stable order: a 10 -> 3 reconfigure re-numbered
# five keys by address, moved the jobs onto other keys and left NODE_ADDRESS (the
# key the doctor's balance/nonce/authorization checks read) naming an idle one;
# the doctor's hint pointed at a script that cannot fix it, and the upgrade's
# closing summary counted stale JOB_ID_n shell variables ("10 job(s)" after 3).
# Runs the real key-management.sh functions, the doctor's real fix case and the
# upgrade's real summary block. Run: bash installer/tests/key-order-stability.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KM="$ROOT/bin/key-management.sh"
DOCTOR="$ROOT/util/arbiter-doctor.sh"
UPGRADE="$ROOT/bin/upgrade-arbiter.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
eq()  { if [ "$2" = "$3" ]; then ok; else bad "$1: got [$2], wanted [$3]"; fi; }

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
A=0x7682d9354E246b108247785F146EB31396c5dE64
B=0x8caaa1270A0d0d1c30A9E22A049f13928b0b951f
C=0x71C389dCE9609d106f945f0a524B1Fcff4C86562
D=0x6B31d2a6c3b122585600E3b5369ecfB2C8b2dA9e
E=0x1B41Ba5Ac19e81896e3A53aEAf0d4Ef2d6688D08
order()  { bash "$KM" order_keys_stably "$1" "$2" 2>/dev/null; }
update() { bash "$KM" update_contracts_with_keys "$1" "$2" "$3" >/dev/null 2>&1; }

# ── The incident: recorded A,B,C,D,E; the CLI now lists them sorted by address ──
F="$T/contracts.before"
cat > "$F" <<EOF
OPERATOR_ADDR="0xe00392A8DFAB155B0CA63F1f955F3d580eAcd9CF"
NODE_ADDRESS="$A"
KEY_1_ADDRESS="$A"
KEY_2_ADDRESS="$B"
KEY_3_ADDRESS="$C"
KEY_4_ADDRESS="$D"
KEY_5_ADDRESS="$E"
KEY_COUNT="5"
ARBITER_COUNT="10"
EOF
SORTED="1:$E|2:$D|3:$C|4:$A|5:$B"
eq "recorded order survives a re-sorted CLI listing" "$(order "$SORTED" "$F")" "1:$A|2:$B|3:$C|4:$D|5:$E"
eq "any CLI order gives the same numbering" "$(order "1:$C|2:$B|3:$E|4:$A|5:$D" "$F")" "1:$A|2:$B|3:$C|4:$D|5:$E"
# Address case differs between the file and the CLI: still the same key.
LOWER_A=$(echo "$A" | tr 'A-F' 'a-f')
eq "addresses match case-insensitively (CLI spelling kept)" "$(order "1:$E|2:$LOWER_A" "$F")" "1:$LOWER_A|2:$E"
# A recorded key that is gone from the node is skipped; an unknown key goes last, in CLI order.
NEW1=0x00000000000000000000000000000000000000A1
NEW2=0x00000000000000000000000000000000000000B2
eq "gone keys are skipped, new keys follow in CLI order" "$(order "1:$NEW2|2:$E|3:$NEW1|4:$B" "$F")" "1:$B|2:$E|3:$NEW2|4:$NEW1"
# KEY_10 sorts after KEY_9, not after KEY_1.
F10="$T/contracts.ten"; : > "$F10"; LIST10=""; WANT10=""
for i in 1 2 3 4 5 6 7 8 9 10; do
    addr=$(printf '0x%040d' "$i"); echo "KEY_${i}_ADDRESS=\"$addr\"" >> "$F10"
    WANT10="${WANT10:+$WANT10|}$i:$addr"; LIST10="$((11-i)):$addr${LIST10:+|$LIST10}"
done
eq "KEY_10 numbers after KEY_9" "$(order "$LIST10" "$F10")" "$WANT10"
# No file / no recorded keys / empty list: the listing passes through untouched.
eq "missing contracts file passes the list through" "$(order "$SORTED" "$T/nope")" "$SORTED"
printf 'OPERATOR_ADDR="0x1"\n' > "$T/contracts.fresh"
eq "fresh contracts file passes the list through" "$(order "$SORTED" "$T/contracts.fresh")" "$SORTED"
eq "empty list stays empty" "$(order "" "$F")" ""

# ── update_contracts_with_keys: KEY_n rewritten once, NODE_ADDRESS follows key 1 ──
G="$T/contracts.after"; cp "$F" "$G"; chmod 640 "$G"
update "$G" "1:$E|2:$D|3:$C|4:$A|5:$B" 3 || bad "update_contracts_with_keys failed"
eq "NODE_ADDRESS names key 1" "$(grep '^NODE_ADDRESS=' "$G")" "NODE_ADDRESS=\"$E\""
eq "exactly one NODE_ADDRESS line" "$(grep -c '^NODE_ADDRESS=' "$G")" "1"
eq "five KEY lines, no duplicates" "$(grep -c '^KEY_[0-9]*_ADDRESS=' "$G")" "5"
eq "KEY_1 rewritten" "$(grep '^KEY_1_ADDRESS=' "$G")" "KEY_1_ADDRESS=\"$E\""
eq "KEY_COUNT is the keys the jobs need (3 jobs -> 2)" "$(grep '^KEY_COUNT=' "$G")" 'KEY_COUNT="2"'
eq "unrelated lines survive" "$(grep -c '^OPERATOR_ADDR=\|^ARBITER_COUNT=' "$G")" "2"
eq "file mode kept" "$(ls -l "$G" | cut -c1-10)" "-rw-r-----"
# End to end, as configure-node.sh chains them: a re-sorted listing changes nothing.
H="$T/contracts.chain"; cp "$F" "$H"
update "$H" "$(order "$SORTED" "$H")" 3
eq "reconfigure keeps key 1" "$(grep '^KEY_1_ADDRESS=' "$H")" "KEY_1_ADDRESS=\"$A\""
eq "reconfigure keeps NODE_ADDRESS" "$(grep '^NODE_ADDRESS=' "$H")" "NODE_ADDRESS=\"$A\""
grep -q 'KEYS_CONTRACTS_FILE="\$INSTALLER_DIR/.contracts" bash "\$KEY_MGMT_SCRIPT" ensure_keys_exist' "$ROOT/bin/configure-node.sh" && ok || bad "configure-node.sh does not hand the contracts file to ensure_keys_exist"
grep -q 'existing_keys=\$(order_keys_stably "\$existing_keys" "\$contracts_file")' "$KM" && ok || bad "ensure_keys_exist does not apply the stable order"

# ── Doctor: honest hint, and --fix repairs an existing mismatch ──
for f in "$DOCTOR" "$ROOT/util/remote-doctor.sh"; do
    if grep -A2 'emit CRIT cfg.node_addr_keys' "$f" | grep -q 'register-oracle'; then bad "$(basename "$f") still sends operators to register-oracle.sh"; else ok; fi
done
fix_case=$(awk '/^            cfg\.node_addr_keys\)$/{p=1} p{print} p&&/^                ;;$/{exit}' "$DOCTOR")
[ -n "$fix_case" ] && ok || bad "could not extract the doctor's cfg.node_addr_keys fix case"
run_fix() { # run_fix CONTRACTS_FILE KEY_1_ADDRESS ANSWER(0=yes,1=no)
    bash -c 'CONTRACTS_FILE="$1"; KEY_1_ADDRESS="$2"; ANSWER="$3"; prompt_yes_no() { return "$ANSWER"; }
f() { local id=cfg.node_addr_keys; case "$id" in
'"$fix_case"'
esac; }; f' _ "$1" "$2" "$3" 2>&1
}
M="$T/contracts.mismatch"; printf 'OPERATOR_ADDR="0x1"\nNODE_ADDRESS="%s"\nKEY_1_ADDRESS="%s"\nKEY_COUNT="2"\n' "$A" "$E" > "$M"
run_fix "$M" "$E" 0 >/dev/null
eq "doctor --fix sets NODE_ADDRESS to KEY_1" "$(grep '^NODE_ADDRESS=' "$M")" "NODE_ADDRESS=\"$E\""
eq "doctor --fix leaves one NODE_ADDRESS line" "$(grep -c '^NODE_ADDRESS=' "$M")" "1"
eq "doctor --fix keeps the other lines" "$(grep -c '^OPERATOR_ADDR=\|^KEY_1_ADDRESS=\|^KEY_COUNT=' "$M")" "3"
bk=$(ls "$M".backup.* 2>/dev/null | head -1)
[ -n "$bk" ] && grep -q "^NODE_ADDRESS=\"$A\"" "$bk" && ok || bad "doctor --fix kept no backup of the previous file"
N="$T/contracts.declined"; printf 'NODE_ADDRESS="%s"\nKEY_1_ADDRESS="%s"\n' "$A" "$E" > "$N"
run_fix "$N" "$E" 1 >/dev/null
eq "a declined fix changes nothing" "$(grep '^NODE_ADDRESS=' "$N")" "NODE_ADDRESS=\"$A\""
P="$T/contracts.badkey"; printf 'NODE_ADDRESS="%s"\nKEY_1_ADDRESS="oops"\n' "$A" > "$P"
out=$(run_fix "$P" "oops" 0)
eq "an invalid KEY_1 is never written" "$(grep '^NODE_ADDRESS=' "$P")" "NODE_ADDRESS=\"$A\""
echo "$out" | grep -q 'manual step required' && ok || bad "invalid KEY_1 not reported: $out"

# ── Upgrade summary: counts the FILE's jobs, not leftover shell variables ──
count_line=$(grep -E '^\s*CONFIGURED_JOBS=\$\(grep -cE' "$UPGRADE")
[ -n "$count_line" ] && ok || bad "upgrade-arbiter.sh does not count JOB_ID lines from the file"
S3="$T/target/installer"; mkdir -p "$S3"
printf 'JOB_ID_1="a"\nJOB_ID_1_NO_HYPHENS="a"\nJOB_ID_2="b"\nJOB_ID_2_NO_HYPHENS="b"\nJOB_ID_3="c"\nJOB_ID_3_NO_HYPHENS="c"\nJOB_ID="a"\nJOB_ID_NO_HYPHENS="a"\nARBITER_COUNT="3"\n' > "$S3/.contracts"
got=$(TARGET_DIR="$T/target" JOB_ID_4=stale JOB_ID_10=stale bash -c "$count_line"'
CONFIGURED_JOBS=${CONFIGURED_JOBS:-0}; echo "$CONFIGURED_JOBS"')
eq "three jobs counted with stale JOB_ID_4..10 in the environment" "$got" "3"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
