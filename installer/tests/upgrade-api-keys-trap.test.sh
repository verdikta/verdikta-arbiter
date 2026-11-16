#!/bin/bash
# upgrade-arbiter.sh's provider-key step under the real trap (node A8c). The step
# copies each provider key from installer/.api_keys into ai-node/.env.local. It used
# to clear a key that .api_keys left empty, so a key the operator had set only in
# .env.local was wiped with one "cleared" line: on the testnet canary that was
# OPENROUTER_API_KEY, and every claim abstained until the key came back from the
# backup. It also wrote the value into a sed expression, so a `/`, `&` or `\` broke it.
#
# This test runs the script's REAL key-review prompts, the REAL apply block, the REAL
# cleanup_on_error and the REAL last lines, with installer/lib/env-file.sh, against a
# stub validate-api-keys.sh. It also runs install-ai-node.sh's real key block and the
# real validate-api-keys.sh (with a stub python3, so nothing leaves the host).
# Every key here is an obvious fake (example-key-…, a placeholder the gitleaks allowlist knows).
# Run: bash installer/tests/upgrade-api-keys-trap.test.sh
# UPGRADE_ARBITER_SH=<path> runs it against another copy of the script.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="${UPGRADE_ARBITER_SH:-$ROOT/bin/upgrade-arbiter.sh}"
IAN="$ROOT/bin/install-ai-node.sh"
LIB="$ROOT/lib/env-file.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if printf '%s\n' "$2" | grep -qF -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if printf '%s\n' "$2" | grep -qF -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }
line_is() { # line_is NAME FILE EXACT_LINE — FILE holds EXACT_LINE as a whole line
    if [ -f "$2" ] && grep -qxF -- "$3" "$2"; then ok; else bad "$1: no line [$3] in $2: $(cat "$2" 2>/dev/null)"; fi
}

PROVIDER_KEYS="OPENAI_API_KEY ANTHROPIC_API_KEY HYPERBOLIC_API_KEY XAI_API_KEY OPENROUTER_API_KEY"

# ── Static: where the code is and how it is called ──────────────────────────
apply=$(awk '/^# Update AI Node API keys in \.env\.local/{p=1} /^# Upgrade External Adapter$/{p=0} p{print}' "$S")
review=$(awk '/^    # --- Native Provider Keys \(primary\) ---/{p=1} /^    # --- Provider Routing Preference/{p=0} p{print}' "$S")
lastlines=$(awk '/^# Job timeouts that were asked for and did not land/{p=1} p{print}' "$S")
trapfn=$(awk '/^cleanup_on_error\(\) \{$/{p=1} p{print} p&&/^}$/{exit}' "$S")
ianblock=$(awk '/^# Update environment file$/{p=1} /^# Set justifier model from environment configuration$/{p=0} p{print}' "$IAN")
[ -f "$LIB" ] && ok || bad "installer/lib/env-file.sh is missing"
[ -n "$apply" ] && ok || bad "could not extract the apply block"
[ -n "$review" ] && ok || bad "could not extract the key-review prompts"
[ -n "$lastlines" ] && ok || bad "could not extract the last lines"
[ -n "$trapfn" ] && ok || bad "could not extract cleanup_on_error"
[ -n "$ianblock" ] && ok || bad "could not extract install-ai-node.sh's key block"
printf '%s\n' "$apply" | bash -n && ok || bad "the apply block is not a complete shell fragment"
printf '%s\n' "$review" | bash -n && ok || bad "the key-review prompts are not a complete shell fragment"
# Both scripts load the helpers before they use them.
grep -qE '^source "\$INSTALLER_DIR/lib/env-file\.sh"' "$S" && ok || bad "upgrade-arbiter.sh does not source lib/env-file.sh"
grep -qE '^source "\$INSTALLER_DIR/lib/env-file\.sh"' "$IAN" && ok || bad "install-ai-node.sh does not source lib/env-file.sh"
# Every provider key is applied with its failure read by `||`: a function has no ERR
# trap, and errexit inside one would end the upgrade with no message (AGENTS.md §8).
for k in $PROVIDER_KEYS; do
    n=$(printf '%s\n' "$apply" | grep -cE "^[[:space:]]*apply_env_key \"$k\" .*\|\| API_KEYS_NOT_WRITTEN=\"\\\$API_KEYS_NOT_WRITTEN $k\"\$")
    [ "$n" = "1" ] && ok || bad "apply_env_key $k is not called once with || API_KEYS_NOT_WRITTEN=… (found $n)"
done
printf '%s\n' "$apply" | grep -E '^[[:space:]]*apply_env_key ' | grep -vqE '\|\| API_KEYS_NOT_WRITTEN=' \
    && bad "an apply_env_key call whose failure is not read" || ok
# No value goes into a sed expression any more, in either script.
printf '%s\n' "$apply" | grep -qE 'sed .*key_value' && bad "apply block still writes a value through sed" || ok
printf '%s\n' "$ianblock" | grep -qE 'sed .*_API_KEY' && bad "install-ai-node.sh still writes a key through sed" || ok
# The review records each key it removes, and the record starts empty, before the review.
for k in $PROVIDER_KEYS; do
    printf '%s\n' "$review" | grep -qE "API_KEYS_REMOVED=\"\\\$API_KEYS_REMOVED $k\"" && ok || bad "the review does not record a removed $k"
done
init_line=$(grep -nE '^API_KEYS_REMOVED=""$' "$S" | head -1 | cut -d: -f1)
review_line=$(grep -n 'Would you like to review and update your API keys' "$S" | head -1 | cut -d: -f1)
[ -n "$init_line" ] && [ -n "$review_line" ] && [ "$init_line" -lt "$review_line" ] && ok || bad "API_KEYS_REMOVED is not set to empty before the review"
# The apply block is at the top level: a function has no ERR trap at all.
awk '/^[a-zA-Z_]+\(\) \{$/{f=1} /^# Update AI Node API keys in \.env\.local/{if (f) print "IN-FUNCTION"} /^}$/{f=0}' "$S" | grep -q IN-FUNCTION \
    && bad "the apply block sits inside a function" || ok
# A key write that failed is said near the last line, with exit 3.
printf '%s\n' "$lastlines" | grep -q 'API KEYS FAILED: ' && ok || bad "the last lines do not report API KEYS FAILED"

T=$(mktemp -d)
cleanup() { chmod -R u+w "$T" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
mkdir -p "$T/util" "$T/bin"
cat > "$T/util/validate-api-keys.sh" <<'STUB'
#!/bin/bash
echo "VALIDATE-STUB $*"
STUB

# The fixtures are written by these helpers from NAME VALUE pairs, so that no
# "NAME=value" text sits in this file for the secret scan to read as a key.
# keys_lines NAME VALUE … — NAME="VALUE" lines, as the upgrade writes installer/.api_keys.
keys_lines() { while [ $# -ge 2 ]; do printf '%s="%s"\n' "$1" "$2"; shift 2; done; }
# env_lines NAME VALUE … — NAME=VALUE lines, as in ai-node/.env.local.
env_lines() { while [ $# -ge 2 ]; do printf '%s=%s\n' "$1" "$2"; shift 2; done; }
# kv NAME VALUE — one NAME=VALUE line, to compare with.
kv() { printf '%s=%s' "$1" "$2"; }
# fresh — a new install with no .api_keys and no .env.local yet.
fresh() { rm -rf "$T/install"; mkdir -p "$T/install/installer" "$T/install/ai-node"; }
KEYSF="$T/install/installer/.api_keys"
ENVF="$T/install/ai-node/.env.local"
# Stub tools. python3: a provider check (`python3 - <provider> <key>`) answers "ok",
# or "bad" for a provider named in STUB_BAD, and logs "<provider> <key>" to
# $T/checked, so no request leaves the host; any other call (env_file_value) runs the
# real python3. sed: -i fails, as on a full disk. grep: -v writes half a line and
# fails, as on a full disk. nopy: a python3 that does not run.
REAL_PY=$(command -v python3); REAL_SED=$(command -v sed); REAL_GREP=$(command -v grep)
mkdir -p "$T/pystub" "$T/sedfail" "$T/grepfail" "$T/nopy"
cat > "$T/pystub/python3" <<STUB
#!/bin/bash
if [ "\$1" = "-" ] && [ \$# -eq 3 ]; then
    case "\$2" in openai|anthropic|xai|hyperbolic|openrouter)
        cat > /dev/null
        echo "\$2 \$3" >> "$T/checked"
        case " \${STUB_BAD:-} " in *" \$2 "*) echo bad ;; *) echo ok ;; esac
        exit 0 ;;
    esac
fi
exec "$REAL_PY" "\$@"
STUB
cat > "$T/sedfail/sed" <<STUB
#!/bin/bash
for a in "\$@"; do case "\$a" in -i*) echo "sed: couldn't write: No space left on device" >&2; exit 4 ;; esac; done
exec "$REAL_SED" "\$@"
STUB
cat > "$T/grepfail/grep" <<STUB
#!/bin/bash
for a in "\$@"; do [ "\$a" = "-v" ] && { printf 'LOG_LE'; exit 2; }; done
exec "$REAL_GREP" "\$@"
STUB
printf '#!/bin/bash\nexit 127\n' > "$T/nopy/python3"
chmod +x "$T/pystub/python3" "$T/sedfail/sed" "$T/grepfail/grep" "$T/nopy/python3"

# keys_empty — the .api_keys of an install whose operator gave no provider key.
keys_empty() {
    keys_lines OPENROUTER_API_KEY "" OPENAI_API_KEY "" ANTHROPIC_API_KEY "" HYPERBOLIC_API_KEY "" \
        XAI_API_KEY "" INFURA_API_KEY "" PINATA_API_KEY "" > "$KEYSF"
}

# run_apply — the real trap, the real apply block, a marker, the real last lines.
# REMOVED is what this run's key review removed (API_KEYS_REMOVED); XPATH goes in
# front of PATH (stub tools); VUTIL replaces the stub validator's directory.
run_apply() {
    env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u HYPERBOLIC_API_KEY -u XAI_API_KEY -u OPENROUTER_API_KEY \
    REMOVED="${REMOVED-}" TARGET_DIR="$T/install" TARGET_AI_NODE="$T/install/ai-node" UTIL_DIR="${VUTIL:-$T/util}" \
    UPGRADE_IN_PROGRESS=1 BACKUP_DIR="" ARBITER_WAS_RUNNING=0 RECONF_FAILED=0 \
    APPLY="$apply" LAST="$lastlines" TRAPFN="$trapfn" ROOT="$ROOT" PATH="${XPATH:+$XPATH:}$PATH" \
    bash -c '
        set -e
        eval "$TRAPFN"
        trap "echo TRAP-FIRED; cleanup_on_error" ERR
        source "$ROOT/lib/prompts.sh"
        source "$ROOT/lib/env-file.sh"
        GREEN= YELLOW= RED= BLUE= NC=
        API_KEYS_REMOVED="$REMOVED"
        eval "$APPLY"
        echo "APPLY-DONE"
        eval "$LAST"
        echo "REACHED-END"
    ' 2>&1
    echo "rc=$?"
}

# 1. The canary: OPENROUTER_API_KEY only in .env.local. Kept, with a warning that
#    names the key and .api_keys and never prints the value.
fresh; keys_empty
env_lines OPENAI_API_KEY "" OPENROUTER_API_KEY example-key-openrouter-envlocal-only LOG_LEVEL info > "$ENVF"
cp "$ENVF" "$T/before"
out=$(run_apply)
cmp -s "$T/before" "$ENVF" && ok || bad "only in .env.local: the file changed: $(cat "$ENVF")"
line_is "only in .env.local: kept" "$ENVF" "$(kv OPENROUTER_API_KEY example-key-openrouter-envlocal-only)"
has   "only in .env.local: warns"          "$out" "OPENROUTER_API_KEY is set in ai-node/.env.local but not in installer/.api_keys"
has   "only in .env.local: says kept"      "$out" "Kept."
has   "only in .env.local: says where"     "$out" "$KEYSF"
hasnt "only in .env.local: no value"       "$out" "example-key-openrouter-envlocal-only"
hasnt "only in .env.local: not cleared"    "$out" "cleared"
hasnt "only in .env.local: not removed"    "$out" "removed from AI Node"
hasnt "only in .env.local: no warning for an empty key" "$out" "OPENAI_API_KEY is set"
has   "only in .env.local: validator ran"  "$out" "VALIDATE-STUB --api-keys-file $KEYSF --env-file $ENVF"
has   "only in .env.local: end"            "$out" "REACHED-END"
has   "only in .env.local: exit 0"         "$out" "rc=0"
hasnt "only in .env.local: trap"           "$out" "TRAP-FIRED"

# 2. In both, different values: .api_keys wins, as before. A key missing from
#    .env.local is added.
fresh
keys_lines OPENROUTER_API_KEY example-key-openrouter-from-api-keys OPENAI_API_KEY example-key-openai-from-api-keys \
    ANTHROPIC_API_KEY "" > "$KEYSF"
env_lines OPENROUTER_API_KEY example-key-openrouter-old LOG_LEVEL info > "$ENVF"
out=$(run_apply)
line_is "in both: .api_keys wins" "$ENVF" "$(kv OPENROUTER_API_KEY example-key-openrouter-from-api-keys)"
[ "$(grep -c '^OPENROUTER_API_KEY' "$ENVF")" = "1" ] && ok || bad "in both: duplicated line: $(cat "$ENVF")"
line_is "in both: a new key appended" "$ENVF" "$(kv OPENAI_API_KEY example-key-openai-from-api-keys)"
line_is "in both: the rest kept"      "$ENVF" "LOG_LEVEL=info"
has   "in both: says set"   "$out" "OpenRouter API Key set in AI Node"
hasnt "in both: no warning" "$out" "but not in installer/.api_keys"
has   "in both: end"        "$out" "REACHED-END"
hasnt "in both: trap"       "$out" "TRAP-FIRED"

# 3. In neither: an empty line, a quoted-empty line, a blank-only line and a missing
#    line stay as they are, with nothing said about them.
fresh; keys_empty
env_lines OPENAI_API_KEY "" ANTHROPIC_API_KEY '""' XAI_API_KEY "   " LOG_LEVEL info > "$ENVF"
cp "$ENVF" "$T/before"
out=$(run_apply)
cmp -s "$T/before" "$ENVF" && ok || bad "in neither: the file changed: $(cat "$ENVF")"
hasnt "in neither: no warning" "$out" "but not in installer/.api_keys"
hasnt "in neither: nothing set" "$out" "set in AI Node"
hasnt "in neither: nothing cleared" "$out" "cleared"
has   "in neither: end"  "$out" "REACHED-END"
has   "in neither: exit 0" "$out" "rc=0"
hasnt "in neither: trap" "$out" "TRAP-FIRED"

# 4. Values with `/`, `&` and `\`: written literally, over an existing line and as a
#    new one. (In double quotes, `\x` stays a backslash and an x when sourced.)
fresh
keys_lines OPENROUTER_API_KEY 'example-key/or&key\x/2' OPENAI_API_KEY 'example-key-openai/with/slashes' \
    XAI_API_KEY 'example-key&xai' > "$KEYSF"
env_lines OPENROUTER_API_KEY example-key-old OPENAI_API_KEY "" LOG_LEVEL info > "$ENVF"
out=$(run_apply)
line_is "slash: OpenRouter literal" "$ENVF" "$(kv OPENROUTER_API_KEY 'example-key/or&key\x/2')"
line_is "slash: OpenAI literal"     "$ENVF" "$(kv OPENAI_API_KEY 'example-key-openai/with/slashes')"
line_is "ampersand: xAI appended"   "$ENVF" "$(kv XAI_API_KEY 'example-key&xai')"
line_is "slash: the rest kept"      "$ENVF" "LOG_LEVEL=info"
has   "slash: end"  "$out" "REACHED-END"
hasnt "slash: trap" "$out" "TRAP-FIRED"
hasnt "slash: sed error" "$out" "unknown option to"

# 5. A file with no final newline: an appended key starts its own line.
fresh
keys_lines ANTHROPIC_API_KEY example-key-anthropic > "$KEYSF"
printf 'LOG_LEVEL=info' > "$ENVF"
out=$(run_apply)
line_is "no final newline: old line intact" "$ENVF" "LOG_LEVEL=info"
line_is "no final newline: key on its own line" "$ENVF" "$(kv ANTHROPIC_API_KEY example-key-anthropic)"

# 6. Removed in this run's key review: cleared, as the prompt says ("blank to remove").
fresh; keys_empty
env_lines OPENAI_API_KEY example-key-openai-removed OPENROUTER_API_KEY example-key-openrouter-stays > "$ENVF"
out=$(REMOVED=" OPENAI_API_KEY" run_apply)
line_is "removed: cleared" "$ENVF" "$(kv OPENAI_API_KEY "")"
line_is "removed: the other kept" "$ENVF" "$(kv OPENROUTER_API_KEY example-key-openrouter-stays)"
has   "removed: says so"   "$out" "OpenAI API Key removed from AI Node"
has   "removed: warns for the other" "$out" "OPENROUTER_API_KEY is set in ai-node/.env.local but not in installer/.api_keys"
hasnt "removed: no value"  "$out" "example-key-openai-removed"
has   "removed: end"  "$out" "REACHED-END"
hasnt "removed: trap" "$out" "TRAP-FIRED"

# 7. No .api_keys at all: nothing touched, as before.
fresh
env_lines OPENROUTER_API_KEY example-key-openrouter-no-api-keys > "$ENVF"
cp "$ENVF" "$T/before"
out=$(run_apply)
cmp -s "$T/before" "$ENVF" && ok || bad "no .api_keys: the file changed"
has   "no .api_keys: says so" "$out" "No API keys configuration found"
hasnt "no .api_keys: no validator" "$out" "VALIDATE-STUB"
has   "no .api_keys: end"  "$out" "REACHED-END"

# 8. .env.local cannot be written: the upgrade carries on, says which keys, and ends
#    on exit 3 with API KEYS FAILED; the trap does not fire.
if [ "$(id -u)" != "0" ]; then
    fresh
    keys_lines OPENAI_API_KEY example-key-openai-unwritable OPENROUTER_API_KEY example-key-openrouter-unwritable > "$KEYSF"
    env_lines OPENAI_API_KEY example-key-old > "$ENVF"
    chmod 444 "$ENVF"; chmod 555 "$T/install/ai-node"
    out=$(run_apply)
    chmod 755 "$T/install/ai-node"; chmod 644 "$ENVF"
    line_is "unwritable: unchanged" "$ENVF" "$(kv OPENAI_API_KEY example-key-old)"
    has   "unwritable: carries on"   "$out" "APPLY-DONE"
    has   "unwritable: names keys"   "$out" "API KEYS FAILED: could not write OPENAI_API_KEY OPENROUTER_API_KEY to $ENVF"
    has   "unwritable: exit 3"       "$out" "rc=3"
    hasnt "unwritable: trap"         "$out" "TRAP-FIRED"
    hasnt "unwritable: not a clean end" "$out" "REACHED-END"
    hasnt "unwritable: no value"     "$out" "example-key-openai-unwritable"
    printf '%s\n' "$out" | grep -E 'FAILED:' | tail -1 | grep -q "API KEYS FAILED" && ok || bad "unwritable: API KEYS FAILED is not the last failure line"
else
    echo "skip: running as root, file modes do not stop writes"
fi

# 8b. The disk fills while a key is written (sed fails, .env.local intact): the real
#     validator does not run, because its routing would rewrite .env.local too.
#     Here it would remove OPENAI_CLASS_PROVIDER, so a changed file means it ran.
fresh
keys_lines OPENAI_API_KEY example-key-openai-new > "$KEYSF"
env_lines OPENAI_API_KEY example-key-openai-old OPENAI_CLASS_PROVIDER openrouter LOG_LEVEL info > "$ENVF"
cp "$ENVF" "$T/before"; rm -f "$T/checked"
out=$(XPATH="$T/sedfail:$T/pystub" VUTIL="$ROOT/util" run_apply)
cmp -s "$T/before" "$ENVF" && ok || bad "full disk: .env.local changed: $(cat "$ENVF")"
[ -f "$T/checked" ] && bad "full disk: the validator checked keys: $(cat "$T/checked")" || ok
has   "full disk: routing skipped" "$out" "Skipping key validation and provider routing: .env.local could not be written."
has   "full disk: says so last"    "$out" "API KEYS FAILED: could not write OPENAI_API_KEY to $ENVF"
has   "full disk: exit 3"          "$out" "rc=3"
hasnt "full disk: trap"            "$out" "TRAP-FIRED"

# 8c. python3 does not run: .env.local cannot be read the AI Node's way, so it is left
#     as it is, with a line that says so; nothing fails.
fresh; keys_empty
env_lines OPENROUTER_API_KEY example-key-openrouter-nopy > "$ENVF"
cp "$ENVF" "$T/before"
out=$(XPATH="$T/nopy" run_apply)
cmp -s "$T/before" "$ENVF" && ok || bad "no python3: the file changed"
has   "no python3: says so" "$out" "Could not read OPENROUTER_API_KEY from $ENVF (it is read with python3); left as it is."
hasnt "no python3: no value" "$out" "example-key-openrouter-nopy"
has   "no python3: end"     "$out" "REACHED-END"
has   "no python3: exit 0"  "$out" "rc=0"
hasnt "no python3: trap"    "$out" "TRAP-FIRED"

# 9. The real key review, answered on stdin: OpenAI removed, OpenRouter kept as it is,
#    the rest skipped. Its record reaches the apply block, which clears only OpenAI.
fresh
keys_lines OPENROUTER_API_KEY example-key-openrouter-reviewed OPENAI_API_KEY example-key-openai-reviewed > "$KEYSF"
env_lines OPENAI_API_KEY example-key-openai-reviewed OPENROUTER_API_KEY example-key-openrouter-reviewed \
    XAI_API_KEY example-key-xai-envlocal-only > "$ENVF"
out=$(printf 'y\n\n\n\n\nn\n' | \
    env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u HYPERBOLIC_API_KEY -u XAI_API_KEY -u OPENROUTER_API_KEY -u VERDIKTA_UNATTENDED \
    TARGET_DIR="$T/install" TARGET_AI_NODE="$T/install/ai-node" UTIL_DIR="$T/util" \
    UPGRADE_IN_PROGRESS=1 BACKUP_DIR="" ARBITER_WAS_RUNNING=0 RECONF_FAILED=0 \
    REVIEW="$review" APPLY="$apply" TRAPFN="$trapfn" ROOT="$ROOT" \
    bash -c '
        set -e
        eval "$TRAPFN"
        trap "echo TRAP-FIRED; cleanup_on_error" ERR
        source "$ROOT/lib/prompts.sh"
        source "$ROOT/lib/env-file.sh"
        GREEN= YELLOW= RED= BLUE= NC=
        API_KEYS_REMOVED=""
        source "$TARGET_DIR/installer/.api_keys"
        eval "$REVIEW"
        echo "REVIEW-DONE removed=[$API_KEYS_REMOVED]"
        # What the review saves (the heredoc after the prompts), for the apply block to source.
        for k in OPENROUTER_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY HYPERBOLIC_API_KEY XAI_API_KEY; do
            printf "%s=\"%s\"\n" "$k" "${!k}"
        done > "$TARGET_DIR/installer/.api_keys"
        eval "$APPLY"
        echo "APPLY-DONE"
    ' 2>&1)
has   "review: records only OpenAI" "$out" "REVIEW-DONE removed=[ OPENAI_API_KEY]"
line_is "review: OpenAI cleared"    "$ENVF" "$(kv OPENAI_API_KEY "")"
line_is "review: OpenRouter kept"   "$ENVF" "$(kv OPENROUTER_API_KEY example-key-openrouter-reviewed)"
line_is "review: xAI (skipped) kept" "$ENVF" "$(kv XAI_API_KEY example-key-xai-envlocal-only)"
has   "review: xAI warned"          "$out" "XAI_API_KEY is set in ai-node/.env.local but not in installer/.api_keys"
has   "review: end"                 "$out" "APPLY-DONE"
hasnt "review: trap"                "$out" "TRAP-FIRED"

# ── install-ai-node.sh's real key block: literal values, nothing cleared ─────
mkdir -p "$T/ain"
env_lines OPENROUTER_API_KEY example-key-old OPENAI_API_KEY example-key-openai-kept LOG_LEVEL info > "$T/ain/.env.local"
out=$(env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u HYPERBOLIC_API_KEY -u XAI_API_KEY -u OPENROUTER_API_KEY \
    AI_NODE_DIR="$T/ain" BLOCK="$ianblock" ROOT="$ROOT" IAN_OR='example-key/or&key\y' IAN_HYP='example-key/hyp' \
    bash -c '
        set -e
        source "$ROOT/lib/env-file.sh"
        GREEN= YELLOW= RED= BLUE= NC=
        OPENROUTER_API_KEY="$IAN_OR"; HYPERBOLIC_API_KEY="$IAN_HYP"
        eval "$BLOCK"
        echo "BLOCK-DONE"
    ' 2>&1)
has "install: end" "$out" "BLOCK-DONE"
line_is "install: OpenRouter literal"  "$T/ain/.env.local" "$(kv OPENROUTER_API_KEY 'example-key/or&key\y')"
line_is "install: Hyperbolic appended" "$T/ain/.env.local" "$(kv HYPERBOLIC_API_KEY example-key/hyp)"
line_is "install: empty key leaves the line" "$T/ain/.env.local" "$(kv OPENAI_API_KEY example-key-openai-kept)"
line_is "install: the rest kept"       "$T/ain/.env.local" "LOG_LEVEL=info"

# ── validate-api-keys.sh checks the key the node will use ────────────────────
# The real validator with the python3 stub: no request leaves the host.
run_validate() { # run_validate ARGS… — the real validator, python3 stubbed, keys unset
    env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u HYPERBOLIC_API_KEY -u XAI_API_KEY -u OPENROUTER_API_KEY -u GROK_API_KEY \
        PATH="${XPATH:+$XPATH:}$T/pystub:$PATH" bash "$ROOT/util/validate-api-keys.sh" "$@" 2>&1
}
# A quoted key with a comment after it (R1-F1): the credential checked is the one
# dotenv loads, without its quotes, and routing follows its result.
keys_lines OPENROUTER_API_KEY "" OPENAI_API_KEY example-key-openai-from-api-keys ANTHROPIC_API_KEY "" > "$T/vkeys"
env_lines OPENROUTER_API_KEY 'example-key-or-envlocal # fallback' OPENAI_API_KEY example-key-openai-envlocal \
    ANTHROPIC_API_KEY '"example-key-anthropic-envlocal" # production' XAI_API_KEY "" > "$T/venv"
rm -f "$T/checked"
out=$(STUB_BAD=anthropic run_validate --api-keys-file "$T/vkeys" --env-file "$T/venv")
grep -qxF "anthropic example-key-anthropic-envlocal" "$T/checked" && ok || bad "validate: the quoted, commented Anthropic key was not checked as dotenv reads it: $(cat "$T/checked" 2>/dev/null)"
grep -qxF "openrouter example-key-or-envlocal" "$T/checked" && ok || bad "validate: the commented OpenRouter key was not checked as dotenv reads it: $(cat "$T/checked" 2>/dev/null)"
grep -qxF "openai example-key-openai-from-api-keys" "$T/checked" && ok || bad "validate: .api_keys no longer wins for OpenAI: $(cat "$T/checked" 2>/dev/null)"
grep -q "^xai " "$T/checked" && bad "validate: an empty key was checked" || ok
line_is "validate: a failing native key is routed via the kept OpenRouter key" "$T/venv" "ANTHROPIC_CLASS_PROVIDER=openrouter"
line_is "validate: the key lines stay" "$T/venv" "$(kv ANTHROPIC_API_KEY '"example-key-anthropic-envlocal" # production')"
has   "validate: says where the key is" "$out" "OPENROUTER_API_KEY: none in vkeys, checking the one in venv"
hasnt "validate: no value printed"      "$out" "example-key-or-envlocal"
hasnt "validate: no value printed (2)"  "$out" "example-key-anthropic-envlocal"
# Without --env-file it reads .api_keys only, as before.
rm -f "$T/checked"
out=$(run_validate --api-keys-file "$T/vkeys")
grep -q "^openrouter " "$T/checked" && bad "validate without --env-file: checked an OpenRouter key" || ok
# A routing write that fails half way (R1-F2): .env.local is left as it was, not
# replaced by the partial copy, and the run says so.
keys_lines OPENAI_API_KEY example-key-openai-routing > "$T/vkeys"
env_lines OPENAI_API_KEY example-key-openai-routing OPENAI_CLASS_PROVIDER openrouter LOG_LEVEL info > "$T/venv"
cp "$T/venv" "$T/venv.before"
out=$(XPATH="$T/grepfail" run_validate --api-keys-file "$T/vkeys" --env-file "$T/venv")
cmp -s "$T/venv.before" "$T/venv" && ok || bad "validate, failed write: .env.local was replaced: $(cat "$T/venv")"
[ -e "$T/venv.vtmp" ] && bad "validate, failed write: the partial copy was left behind" || ok
has "validate, failed write: says so" "$out" "Could not update venv for OPENAI_CLASS_PROVIDER; it is left as it was."
# The same write that succeeds removes the override, as before.
out=$(run_validate --api-keys-file "$T/vkeys" --env-file "$T/venv")
grep -q '^OPENAI_CLASS_PROVIDER=' "$T/venv" && bad "validate: a working native key kept its override" || ok
line_is "validate: the rest kept" "$T/venv" "LOG_LEVEL=info"

# ── installer/lib/env-file.sh on its own ─────────────────────────────────────
# shellcheck disable=SC1090
source "$LIB"
printf 'A=1\nKEY="quoted value"\nE=""\nS=  \nC= # a comment\nD=first\nD=last\nQ='"'"'single'"'"'\nW=  spaced  \n' > "$T/lib.env"
[ "$(env_file_value KEY "$T/lib.env")" = "quoted value" ] && ok || bad "lib: double quotes"
[ "$(env_file_value Q "$T/lib.env")" = "single" ] && ok || bad "lib: single quotes"
[ -z "$(env_file_value E "$T/lib.env")" ] && ok || bad "lib: quoted empty"
[ -z "$(env_file_value S "$T/lib.env")" ] && ok || bad "lib: blanks only"
[ -z "$(env_file_value C "$T/lib.env")" ] && ok || bad "lib: a comment is not a value"
[ "$(env_file_value D "$T/lib.env")" = "last" ] && ok || bad "lib: the last line wins (dotenv)"
[ "$(env_file_value W "$T/lib.env")" = "spaced" ] && ok || bad "lib: blanks around"
[ -z "$(env_file_value MISSING "$T/lib.env")" ] && ok || bad "lib: missing key"
[ -z "$(env_file_value A "$T/nope.env")" ] && ok || bad "lib: missing file"
env_file_value A "$T/nope.env" && ok || bad "lib: missing file returns non-zero"
# dotenv's grammar: a quoted value with a comment, export, blanks around =, # inside quotes.
printf '%s\n' 'DQC="dq-value" # production' "SQC='sq-value'   # note" 'export EXP=exported' 'SPC = spaced-eq' \
    "SQH='a#b'" 'UQH=a#b' 'BQ=`bq-value`' 'CR=cr-value' > "$T/dotenv.env"
printf 'CRLF=crlf-value\r\n' >> "$T/dotenv.env"
[ "$(env_file_value DQC "$T/dotenv.env")" = "dq-value" ] && ok || bad "lib: a double-quoted value with a comment: [$(env_file_value DQC "$T/dotenv.env")]"
[ "$(env_file_value SQC "$T/dotenv.env")" = "sq-value" ] && ok || bad "lib: a single-quoted value with a comment"
[ "$(env_file_value EXP "$T/dotenv.env")" = "exported" ] && ok || bad "lib: export"
[ "$(env_file_value SPC "$T/dotenv.env")" = "spaced-eq" ] && ok || bad "lib: blanks around ="
[ "$(env_file_value SQH "$T/dotenv.env")" = "a#b" ] && ok || bad "lib: # inside quotes"
[ "$(env_file_value UQH "$T/dotenv.env")" = "a" ] && ok || bad "lib: # ends an unquoted value"
[ "$(env_file_value BQ "$T/dotenv.env")" = "bq-value" ] && ok || bad "lib: backticks"
[ "$(env_file_value CRLF "$T/dotenv.env")" = "crlf-value" ] && ok || bad "lib: CRLF"
PATH="$T/nopy:$PATH" env_file_value DQC "$T/dotenv.env" >/dev/null && bad "lib: no python3 returned 0" || ok
env_file_set A 'x/y&z\w' "$T/lib.env" && ok || bad "lib: set failed"
grep -qxF 'A=x/y&z\w' "$T/lib.env" && ok || bad "lib: literal set: $(grep '^A=' "$T/lib.env")"
env_file_set D 'one' "$T/lib.env" && [ "$(grep -c '^D=one$' "$T/lib.env")" = "2" ] && ok || bad "lib: every KEY= line is set"
env_file_set NEW 'n/1' "$T/new.env" && grep -qxF 'NEW=n/1' "$T/new.env" && ok || bad "lib: creates the file"
cp "$T/lib.env" "$T/lib.before"
env_file_set A "$(printf 'two\nlines')" "$T/lib.env" && bad "lib: a value with a line break was written" || ok
cmp -s "$T/lib.before" "$T/lib.env" && ok || bad "lib: a refused value changed the file"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
