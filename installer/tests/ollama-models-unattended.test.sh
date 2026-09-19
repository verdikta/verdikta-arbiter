#!/bin/bash
# The Ollama model loop of install-ai-node.sh asks VA_PULL_OLLAMA_MODELS once per
# missing model. The prompt library treated the second ask as a validation loop
# and exited 65 (issue #56). Runs the REAL loop against a fake ollama.
# Run: bash installer/tests/ollama-models-unattended.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/bin/install-ai-node.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
printf '#!/bin/bash\necho "$@" >> "%s/pulls"\nexit 0\n' "$T" > "$T/bin/ollama"; chmod +x "$T/bin/ollama"
block=$(awk '/Found \$\{#OLLAMA_MODELS\[@\]\} Ollama models from configuration/{p=1} p{print} p && /^    done$/{exit}' "$S")
[ -n "$block" ] && echo "$block" | grep -q 'for model in "${OLLAMA_MODELS\[@\]}"' && ok || bad "could not extract the model loop from install-ai-node.sh"
run() {
  rm -f "$T/pulls"
  ( export VERDIKTA_UNATTENDED=1 PATH="$T/bin:$PATH" VA_PULL_OLLAMA_MODELS="$1"
    source "$ROOT/lib/prompts.sh"; GREEN=; YELLOW=; BLUE=; RED=; NC=
    OLLAMA_MODELS=("llama3.1:8b" "llava:7b" "qwen3:8b"); INSTALLED_MODELS=""
    eval "$block" ) >"$T/out" 2>&1
  echo $?
}
# n: every model asked, every model skipped, exit 0 — the second ask used to be exit 65.
rc=$(run n)
[ "$rc" = "0" ] && ok || bad "VA_PULL_OLLAMA_MODELS=n: rc=$rc (tail: $(tail -2 "$T/out" | tr '\n' ' '))"
[ "$(grep -c 'Skipping installation' "$T/out")" = "3" ] && ok || bad "n: not all three models were skipped"
[ ! -e "$T/pulls" ] && ok || bad "n: a model was pulled"
# y: every model pulled.
rc=$(run y)
[ "$rc" = "0" ] && ok || bad "VA_PULL_OLLAMA_MODELS=y: rc=$rc"
[ -f "$T/pulls" ] && [ "$(wc -l < "$T/pulls" | tr -d ' ')" = "3" ] && ok || bad "y: expected 3 pulls, got $(wc -l < "$T/pulls" 2>/dev/null)"
grep -q 'pull llava:7b' "$T/pulls" 2>/dev/null && ok || bad "y: llava:7b not pulled"
echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
