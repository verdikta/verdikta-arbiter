#!/bin/bash
# arbiter-doctor.sh ai.provider_auth: FAIL when a model provider refuses this node's API
# key and has not answered since. One arbiter judged bounty 398 (2026-11-20) with a single
# juror, and a failed justifier, while OpenAI answered 401 to its key: the request still
# "succeeds" with the rest of the panel, and every other check was green.
# The check reads the AI Node's own PROVIDER_AUTH_FAILED lines: no provider is called and
# none of the log's text (a provider's message can quote the key) is printed.
# Runs the doctor's REAL check_ai_provider_auth against stub emit and fixture logs.
# Run: bash installer/tests/doctor-provider-auth.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCTOR="$ROOT/util/arbiter-doctor.sh"
ROUTE="$ROOT/../ai-node/src/app/api/rank-and-justify/route.ts"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
has()   { if echo "$2" | grep -q -- "$3"; then ok; else bad "$1: no [$3] in: $2"; fi; }
hasnt() { if echo "$2" | grep -q -- "$3"; then bad "$1: unexpected [$3] in: $2"; else ok; fi; }

fn=$(awk '/^check_ai_provider_auth\(\) \{/{p=1} p{print} p&&/^\}/{exit}' "$DOCTOR")
[ -n "$fn" ] && ok || bad "could not extract check_ai_provider_auth from $DOCTOR"
grep -q '^        check_ai_provider_auth "\$ai_log"$' "$DOCTOR" && ok || bad "check_ai_node does not call check_ai_provider_auth"
# The line the check reads is the line the AI Node writes.
grep -q 'PROVIDER_AUTH_FAILED: provider=\${provider} model=\${model} role=\${role} http_status=' "$ROUTE" && ok \
    || bad "the AI Node no longer writes the PROVIDER_AUTH_FAILED line this check reads"
# No spend, no key tried: the function calls no network tool.
echo "$fn" | grep -Eq 'curl|wget|api\.openai|api\.anthropic' && bad "check_ai_provider_auth calls out" || ok

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
run() {  # run <log file> -> the emitted findings, tab-separated
    INSTALL_DIR=/opt/arbiter bash -c '
        emit() { printf "%s\t%s\t%s\t%s\n" "$@"; }
        eval "$1"
        check_ai_provider_auth "$2"
    ' _ "$fn" "$1" 2>&1
}

AUTH_OPENAI='🔑 PROVIDER_AUTH_FAILED: provider=openai model=gpt-5.6-terra role=juror http_status=401'
RAW_OPENAI='❌ MODEL_FAILED: openai-gpt-5.6-terra failed: OpenAI request with attachments failed for gpt-5.6-terra (HTTP 401): 401 Incorrect API key provided: sk-SECRETSECRET. You can find your API key at https://platform.openai.com/account/api-keys.'

# 1. Bounty 398's arbiter: OpenAI refuses the key as juror and as justifier; Claude answers.
{
    echo "$RAW_OPENAI"; echo "$AUTH_OPENAI"
    echo '✅ MODEL_SUCCESS: anthropic-claude-sonnet-5 completed successfully'
    echo '🔑 PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-5-nano role=justifier http_status=401'
    echo "$RAW_OPENAI"; echo "$AUTH_OPENAI"
    echo '✅ MODEL_SUCCESS: anthropic-claude-sonnet-5 completed successfully'
} > "$T/refused.log"
out=$(run "$T/refused.log")
has   "refused: FAIL"         "$out" "^FAIL	ai.provider_auth	openai refused this node's API key (HTTP 401) 3 time(s) in the last 5000 log lines and has not answered since"
has   "refused: hint names the file" "$out" "/opt/arbiter/ai-node/.env.local"
hasnt "refused: no log text"  "$out" "sk-SECRETSECRET"
hasnt "refused: no log text"  "$out" "platform.openai.com"
hasnt "refused: Claude is fine" "$out" "anthropic"
[ "$(echo "$out" | wc -l)" = 1 ] && ok || bad "refused: expected one finding, got: $out"

# 2. The operator replaced the key: the provider answered after its last refusal.
{ cat "$T/refused.log"; echo '✅ MODEL_SUCCESS: openai-gpt-5.6-terra completed successfully'; } > "$T/fixed.log"
out=$(run "$T/fixed.log")
has   "fixed: PASS"           "$out" "^PASS	ai.provider_auth	no model provider refused this node's API key in the last 5000 log lines"
hasnt "fixed: no FAIL"        "$out" "^FAIL"

# 3. Answering as justifier counts too (a node whose only OpenAI use is the justifier).
{
    echo '🔑 PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-5-nano role=justifier http_status=401'
    echo '✅ JUSTIFIER_API_RESPONSE: OpenAI-gpt-5-nano responded in 2100ms'
} > "$T/justifier-fixed.log"
out=$(run "$T/justifier-fixed.log")
has   "justifier fixed: PASS" "$out" "^PASS	ai.provider_auth"

# 4. Another provider's success does not clear it, and two refused providers are two findings.
{
    echo "$AUTH_OPENAI"
    echo '🔑 PROVIDER_AUTH_FAILED: provider=anthropic model=claude-sonnet-5 role=juror http_status=403'
    echo '✅ MODEL_SUCCESS: xai-grok-4 completed successfully'
} > "$T/two.log"
out=$(run "$T/two.log")
has   "two: openai"           "$out" "^FAIL	ai.provider_auth	openai refused this node's API key (HTTP 401) 1 time(s)"
has   "two: anthropic"        "$out" "^FAIL	ai.provider_auth	anthropic refused this node's API key (HTTP 403) 1 time(s)"
[ "$(echo "$out" | grep -c '^FAIL')" = 2 ] && ok || bad "two: expected two findings, got: $out"

# 5. A healthy log, and a provider's 401 text alone (an older AI Node), are no finding.
printf '%s\n' '✅ MODEL_SUCCESS: openai-gpt-5.6-terra completed successfully' "$RAW_OPENAI" > "$T/healthy.log"
out=$(run "$T/healthy.log")
has   "healthy: PASS"         "$out" "^PASS	ai.provider_auth"

# 6. A crafted provider field never reaches the output or a shell.
printf '%s\n' '🔑 PROVIDER_AUTH_FAILED: provider=$(touch${IFS}'"$T"'/pwned);x model=m role=juror http_status=401' > "$T/crafted.log"
out=$(run "$T/crafted.log")
has   "crafted: ignored"      "$out" "^PASS	ai.provider_auth"
[ -e "$T/pwned" ] && bad "crafted: the provider field was executed" || ok

# 7. Only the recent log counts: a refusal more than 5000 lines back is history.
{ echo "$AUTH_OPENAI"; yes 'GET /api/health 200 in 3ms' | head -5000; } > "$T/old.log"
out=$(run "$T/old.log")
has   "old: PASS"             "$out" "^PASS	ai.provider_auth"

# 8. No log to read: nothing emitted, no error.
out=$(run "$T/absent.log"); [ -z "$out" ] && ok || bad "absent log: expected nothing, got: $out"
out=$(run ""); [ -z "$out" ] && ok || bad "empty argument: expected nothing, got: $out"

echo "doctor-provider-auth: $pass passed, $fail failed"
[ "$fail" = 0 ]
