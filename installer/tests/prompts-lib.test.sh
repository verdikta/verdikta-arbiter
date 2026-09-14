#!/bin/bash
# Unit tests for installer/lib/prompts.sh (run: bash installer/tests/prompts-lib.test.sh)
set -u
LIB="$(cd "$(dirname "$0")/.." && pwd)/lib/prompts.sh"
pass=0; fail=0
t() { if "$@" >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $*"; fi; }
tn() { if ! "$@" >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL(expected nonzero): $*"; fi; }
# unattended yes/no from key
t bash -c "VERDIKTA_UNATTENDED=1 VA_X=y; export VERDIKTA_UNATTENDED VA_X; source $LIB; ask_yes_no 'Q?' '' VA_X"
tn bash -c "VERDIKTA_UNATTENDED=1 VA_X=no; export VERDIKTA_UNATTENDED VA_X; source $LIB; ask_yes_no 'Q?' '' VA_X"
# unattended default
t bash -c "export VERDIKTA_UNATTENDED=1; source $LIB; ask_yes_no 'Q?' '' VA_UNSET y"
tn bash -c "export VERDIKTA_UNATTENDED=1; source $LIB; ask_yes_no 'Q?' n VA_UNSET"
# missing -> exit 65
bash -c "export VERDIKTA_UNATTENDED=1; source $LIB; ask_yes_no 'Q?' '' VA_UNSET" >/dev/null 2>&1; [ $? -eq 65 ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: missing exit code"; }
# bad value -> 65
bash -c "export VERDIKTA_UNATTENDED=1 VA_X=maybe; source $LIB; ask_yes_no 'Q?' '' VA_X" >/dev/null 2>&1; [ $? -eq 65 ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: bad value exit"; }
# re-ask -> 65
bash -c "export VERDIKTA_UNATTENDED=1 VA_X=abc; source $LIB; prompt_value 'P: ' V VA_X; prompt_value 'P: ' V VA_X" >/dev/null 2>&1; [ $? -eq 65 ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: reask"; }
# value set
out=$(bash -c "export VERDIKTA_UNATTENDED=1 VA_X=hello; source $LIB; prompt_value 'P: ' V VA_X; echo \"got=\$V\"" | tail -1); [ "$out" = "got=hello" ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: value $out"; }
# unset value -> empty (Enter semantics)
out=$(bash -c "export VERDIKTA_UNATTENDED=1; source $LIB; prompt_value 'P: ' V VA_UNSET; echo \"got=[\$V]\"" | tail -1); [ "$out" = "got=[]" ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: empty $out"; }
# secret never echoed
out=$(bash -c "export VERDIKTA_UNATTENDED=1 VA_S=supersecret; source $LIB; prompt_secret 'K: ' V VA_S; echo done"); echo "$out" | grep -q supersecret && { fail=$((fail+1)); echo "FAIL: secret leaked"; } || pass=$((pass+1))
# interactive: piped answers
out=$(printf 'y\n' | bash -c "source $LIB; ask_yes_no 'Q?' && echo yes"); echo "$out" | grep -q yes && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: interactive yes"; }
out=$(printf '\n' | bash -c "source $LIB; ask_yes_no 'Q?' y && echo yes"); echo "$out" | grep -q yes && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: interactive default"; }
# interactive EOF -> exits 65 (no infinite loop)
bash -c "source $LIB; ask_yes_no 'Q?'" </dev/null >/dev/null 2>&1; [ $? -eq 65 ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: eof"; }
# load_answers_file
tmp=$(mktemp); echo 'VA_A="1"' > $tmp; out=$(bash -c "source $LIB; load_answers_file $tmp; bash -c 'echo \$VA_A-\$VERDIKTA_UNATTENDED'"); [ "$out" = "1-1" ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: load $out"; }
# unattended announcements go to STDERR, so helpers are safe inside $(...) (issue #17:
# install.sh's LOG_LEVEL=$(get_log_level) captured the announcement + a newline and sed died)
out=$(bash -c "export VERDIKTA_UNATTENDED=1 VA_X=info; source $LIB; f(){ local c; prompt_value 'P: ' c VA_X; echo \"\$c\"; }; v=\$(f); printf '%s' \"\$v\"" 2>/dev/null); [ "$out" = "info" ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: prompt_value polluted capture: [$out]"; }
out=$(bash -c "export VERDIKTA_UNATTENDED=1; source $LIB; f(){ local c; prompt_value 'P: ' c VA_UNSET dflt; echo \"\$c\"; }; v=\$(f); printf '%s' \"\$v\"" 2>/dev/null); [ "$out" = "dflt" ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: prompt_value default polluted capture: [$out]"; }
out=$(bash -c "export VERDIKTA_UNATTENDED=1 VA_X=y; source $LIB; f(){ ask_yes_no 'Q?' '' VA_X && echo yes; }; v=\$(f); printf '%s' \"\$v\"" 2>/dev/null); [ "$out" = "yes" ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: ask_yes_no polluted capture: [$out]"; }
out=$(bash -c "export VERDIKTA_UNATTENDED=1 VA_S=sekrit; source $LIB; f(){ local c; prompt_secret 'K: ' c VA_S; echo \"\${#c}\"; }; v=\$(f); printf '%s' \"\$v\"" 2>/dev/null); [ "$out" = "6" ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: prompt_secret polluted capture: [$out]"; }
# ...and the announcement is still visible (on stderr, which the job log captures 2>&1)
err=$(bash -c "export VERDIKTA_UNATTENDED=1 VA_X=info; source $LIB; prompt_value 'P: ' V VA_X" 2>&1 >/dev/null); echo "$err" | grep -q 'P: info  \[unattended: VA_X\]' && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: announcement missing from stderr: [$err]"; }
echo "pass=$pass fail=$fail"
