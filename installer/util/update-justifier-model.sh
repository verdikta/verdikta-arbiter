#!/bin/bash
#
# Verdikta Arbiter — Justifier model rotation tool
#
# Updates JUSTIFIER_MODEL in the AI Node's .env.local file, validates the
# provider class, warns about common foot-guns (Ollama without a running
# Ollama daemon, malformed values), shows the effective OpenRouter mapping
# when applicable, and restarts the AI Node so the new value takes effect.
#
# JUSTIFIER_MODEL syntax:
#     Provider:model-name
#
#   - Provider class is normalized; accepted values:
#       OpenAI, Anthropic, xAI (Grok), Hyperbolic, Open-source (= Ollama)
#   - For OpenRouter-routed setups (no native key for that class but
#     OPENROUTER_API_KEY set), the model name is mapped through the table
#     at ai-node/src/config/openrouter-models.ts.
#   - Ollama is local-only and NEVER routed through OpenRouter.
#
# Usage:
#   ./update-justifier-model.sh                          # interactive
#   ./update-justifier-model.sh --model OpenAI:gpt-5-nano-2025-08-07
#   ./update-justifier-model.sh --dry-run                # show changes, don't write
#   ./update-justifier-model.sh --no-restart             # update .env.local but don't restart AI Node
#   ./update-justifier-model.sh --install-dir DIR        # override install root
#
# Exit codes: 0 success, 1 user-visible failure, 64 misuse.
#

set -o pipefail

############################################
# Colors
############################################
if [ -t 1 ]; then
    C_RED='\033[0;31m'; C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'
    C_BLUE='\033[0;34m'; C_DIM='\033[2m'; C_BOLD='\033[1m'; C_NC='\033[0m'
else
    C_RED='' C_GREEN='' C_YELLOW='' C_BLUE='' C_DIM='' C_BOLD='' C_NC=''
fi

############################################
# Args
############################################
MODEL=""
DRY_RUN=0
RESTART=1
INSTALL_DIR=""

usage() {
    cat <<EOF
Usage: $0 [--model "Provider:model-name"] [--dry-run] [--no-restart] [--install-dir DIR] [-h]

  --model VAL        Provide JUSTIFIER_MODEL value inline (skip prompt).
  --dry-run          Validate the value and show what would change; don't write or restart.
  --no-restart       Update .env.local but don't restart the AI Node.
  --install-dir DIR  Override autodetected install root (default: /root/verdikta-arbiter-node).
  -h, --help         This help.

Accepted provider classes (case-insensitive):
  OpenAI, Anthropic, xAI (a.k.a. Grok), Hyperbolic, Open-source (a.k.a. Ollama)

For an operator with only OPENROUTER_API_KEY, the gateway routes any non-Ollama
class through OpenRouter automatically. Suggested lightweight justifier values:
  OpenAI:gpt-5-nano-2025-08-07           → openai/gpt-5-nano
  OpenAI:gpt-5-mini-2025-08-07           → openai/gpt-5-mini
  Anthropic:claude-3-5-haiku-20241022    → anthropic/claude-3.5-haiku
  xAI:grok-code-fast-1                   → x-ai/grok-code-fast-1
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --model)       shift; MODEL="${1:-}"; shift ;;
        --dry-run)     DRY_RUN=1; shift ;;
        --no-restart)  RESTART=0; shift ;;
        --install-dir) shift; INSTALL_DIR="${1:-}"; shift ;;
        -h|--help)     usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
    esac
done

############################################
# Locate install dir
############################################
if [ -z "$INSTALL_DIR" ]; then
    if   [ -d "/root/verdikta-arbiter-node/ai-node" ]; then
        INSTALL_DIR="/root/verdikta-arbiter-node"
    elif [ -d "$HOME/verdikta-arbiter-node/ai-node" ]; then
        INSTALL_DIR="$HOME/verdikta-arbiter-node"
    else
        d="$(dirname "$(readlink -f "$0")")"
        while [ "$d" != "/" ]; do
            if [ -d "$d/ai-node" ]; then INSTALL_DIR="$d"; break; fi
            d="$(dirname "$d")"
        done
    fi
fi
[ -z "$INSTALL_DIR" ] && { echo -e "${C_RED}ERROR: could not locate install dir (try --install-dir).${C_NC}" >&2; exit 1; }
AI_NODE_DIR="$INSTALL_DIR/ai-node"
AI_NODE_ENV="$AI_NODE_DIR/.env.local"

if [ ! -d "$AI_NODE_DIR" ]; then
    echo -e "${C_RED}ERROR: ai-node directory not found at $AI_NODE_DIR.${C_NC}" >&2
    exit 1
fi

############################################
# Prompt if --model not supplied
############################################
echo -e "${C_BLUE}${C_BOLD}Verdikta Arbiter — rotate JUSTIFIER_MODEL${C_NC}"

# Show current value (if any) so the operator has context
if [ -f "$AI_NODE_ENV" ] && grep -q '^JUSTIFIER_MODEL=' "$AI_NODE_ENV"; then
    CURRENT=$(grep '^JUSTIFIER_MODEL=' "$AI_NODE_ENV" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
    echo "Current value: ${C_DIM}${CURRENT}${C_NC}"
else
    CURRENT=""
    echo "Current value: ${C_DIM}(not set; AI Node falls back to default-justifier-model which fails at runtime)${C_NC}"
fi

if [ -z "$MODEL" ]; then
    echo
    echo "Enter the new value in the form ${C_BOLD}Provider:model-name${C_NC}."
    echo "Suggested lightweight options for OpenRouter-routed setups:"
    echo "  ${C_BOLD}OpenAI:gpt-5-nano-2025-08-07${C_NC}        (→ openai/gpt-5-nano via OpenRouter)"
    echo "  ${C_BOLD}OpenAI:gpt-5-mini-2025-08-07${C_NC}        (→ openai/gpt-5-mini via OpenRouter)"
    echo "  ${C_BOLD}Anthropic:claude-3-5-haiku-20241022${C_NC} (→ anthropic/claude-3.5-haiku via OpenRouter)"
    echo "  ${C_BOLD}xAI:grok-code-fast-1${C_NC}                (→ x-ai/grok-code-fast-1 via OpenRouter)"
    echo
    read -r -p "JUSTIFIER_MODEL=" MODEL
fi

if [ -z "$MODEL" ]; then
    echo -e "${C_RED}No value provided. Aborting.${C_NC}" >&2
    exit 1
fi

############################################
# 1. Format validation
############################################
echo
echo -e "${C_BLUE}Validating value…${C_NC}"
if [[ "$MODEL" != *:* ]]; then
    echo -e "${C_RED}ERROR: missing ':' separator.${C_NC}"
    echo -e "${C_YELLOW}Format must be Provider:model-name (e.g. OpenAI:gpt-5-nano-2025-08-07)${C_NC}"
    exit 1
fi
PROVIDER_RAW="${MODEL%%:*}"
MODEL_NAME="${MODEL#*:}"

if [ -z "$PROVIDER_RAW" ] || [ -z "$MODEL_NAME" ]; then
    echo -e "${C_RED}ERROR: both provider and model name must be non-empty.${C_NC}"
    echo -e "${C_YELLOW}You provided: provider='$PROVIDER_RAW' model='$MODEL_NAME'${C_NC}"
    exit 1
fi

# Normalize provider class to canonical buckets (case-insensitive)
PROVIDER_LC=$(echo "$PROVIDER_RAW" | tr '[:upper:]' '[:lower:]')
PROVIDER_CLASS=""
case "$PROVIDER_LC" in
    openai)               PROVIDER_CLASS="openai" ;;
    anthropic)            PROVIDER_CLASS="anthropic" ;;
    xai|grok)             PROVIDER_CLASS="xai" ;;
    hyperbolic|"hyperbolic api") PROVIDER_CLASS="hyperbolic" ;;
    ollama|open-source)   PROVIDER_CLASS="ollama" ;;
    *)
        echo -e "${C_RED}ERROR: unknown provider class '$PROVIDER_RAW'.${C_NC}"
        echo -e "${C_YELLOW}Accepted classes: OpenAI, Anthropic, xAI (Grok), Hyperbolic, Open-source (Ollama)${C_NC}"
        exit 1
        ;;
esac
echo -e "  provider:  ${C_BOLD}$PROVIDER_RAW${C_NC}  (normalized class: $PROVIDER_CLASS)"
echo -e "  model:     ${C_BOLD}$MODEL_NAME${C_NC}"

############################################
# 2. Footgun warnings
############################################
echo
echo -e "${C_BLUE}Pre-flight checks…${C_NC}"

# Detect available API keys (read installer/.api_keys if present)
HAVE_OPENAI=0; HAVE_ANTHROPIC=0; HAVE_XAI=0; HAVE_HYPERBOLIC=0; HAVE_OPENROUTER=0
if [ -f "$INSTALL_DIR/installer/.api_keys" ]; then
    # shellcheck disable=SC1091
    set +u; source "$INSTALL_DIR/installer/.api_keys"; set -u 2>/dev/null || true
    [ -n "$OPENAI_API_KEY" ]      && HAVE_OPENAI=1
    [ -n "$ANTHROPIC_API_KEY" ]   && HAVE_ANTHROPIC=1
    [ -n "$XAI_API_KEY" ]         && HAVE_XAI=1
    [ -n "$HYPERBOLIC_API_KEY" ]  && HAVE_HYPERBOLIC=1
    [ -n "$OPENROUTER_API_KEY" ]  && HAVE_OPENROUTER=1
fi

# Ollama special case: must have a running Ollama daemon since it's never routed.
if [ "$PROVIDER_CLASS" = "ollama" ]; then
    if curl -fsS --max-time 3 http://localhost:11434/api/tags >/dev/null 2>&1; then
        echo -e "${C_GREEN}  ✓ Ollama daemon reachable at localhost:11434${C_NC}"
        if curl -fsS --max-time 3 http://localhost:11434/api/tags 2>/dev/null \
            | grep -q "\"name\":\"$MODEL_NAME\""; then
            echo -e "${C_GREEN}  ✓ Ollama has the '$MODEL_NAME' model pulled${C_NC}"
        else
            echo -e "${C_YELLOW}  ⚠ Ollama is running but does NOT have '$MODEL_NAME' pulled.${C_NC}"
            echo -e "${C_YELLOW}    Pull it first: ollama pull $MODEL_NAME${C_NC}"
            echo -e "${C_YELLOW}    Otherwise justification will fail at runtime.${C_NC}"
        fi
    else
        echo -e "${C_RED}  ✗ Ollama daemon NOT reachable at localhost:11434${C_NC}"
        echo -e "${C_RED}    The Ollama provider class is LOCAL-ONLY — never routed via OpenRouter.${C_NC}"
        echo -e "${C_RED}    Without a running Ollama daemon, every justification will fail.${C_NC}"
        if [ "$HAVE_OPENROUTER" = "1" ]; then
            echo -e "${C_YELLOW}    Tip: you have OPENROUTER_API_KEY set — pick a non-Ollama class (e.g.,${C_NC}"
            echo -e "${C_YELLOW}    OpenAI:gpt-5-nano-2025-08-07) and it will route through OpenRouter.${C_NC}"
        fi
        exit 1
    fi
else
    # Non-Ollama: must have either the matching native key OR OpenRouter
    HAVE_NATIVE_VAR="HAVE_$(echo "$PROVIDER_CLASS" | tr '[:lower:]' '[:upper:]')"
    HAVE_NATIVE="${!HAVE_NATIVE_VAR:-0}"
    if [ "$HAVE_NATIVE" = "1" ]; then
        echo -e "${C_GREEN}  ✓ Native API key found for $PROVIDER_CLASS — will route directly to the provider${C_NC}"
    elif [ "$HAVE_OPENROUTER" = "1" ]; then
        # Compute what OpenRouter will actually call (best-effort table lookup)
        case "$PROVIDER_CLASS" in
            openai)     PREFIX="openai" ;;
            anthropic)  PREFIX="anthropic" ;;
            xai)        PREFIX="x-ai" ;;
            hyperbolic) PREFIX="meta-llama" ;;
        esac
        # Mirror resolveOpenRouterModelId() from openrouter-models.ts
        EFFECTIVE=""
        if [ "$PROVIDER_CLASS" = "hyperbolic" ] && [[ "$MODEL_NAME" == *"/"* ]]; then
            EFFECTIVE="$MODEL_NAME"
        else
            EFFECTIVE="$PREFIX/$MODEL_NAME"
        fi
        # Strip trailing -YYYY-MM-DD date suffix
        STRIPPED=$(echo "$EFFECTIVE" | sed -E 's/-[0-9]{4}-[0-9]{2}-[0-9]{2}$//')
        if [ "$STRIPPED" != "$EFFECTIVE" ]; then
            EFFECTIVE="$STRIPPED"
        fi
        # Mirror OPENROUTER_MODEL_MAP from ai-node/src/config/openrouter-models.ts.
        # We check BEFORE date-stripping (some map entries include the date),
        # so the lookup order matches the TS resolver: exact → strip-date → fallback.
        # First, exact-with-date hits:
        case "$EFFECTIVE" in
            openai/gpt-5-2025-08-07)                  EFFECTIVE="openai/gpt-5" ;;
            openai/gpt-5-mini-2025-08-07)             EFFECTIVE="openai/gpt-5-mini" ;;
            openai/gpt-5-nano-2025-08-07)             EFFECTIVE="openai/gpt-5-nano" ;;
            openai/gpt-5.1-2025-11-13)                EFFECTIVE="openai/gpt-5.1" ;;
            openai/gpt-5.1-codex-2025-11-13)          EFFECTIVE="openai/gpt-5.1-codex" ;;
            openai/gpt-5.1-codex-mini-2025-11-13)     EFFECTIVE="openai/gpt-5.1-codex-mini" ;;
            openai/gpt-5.2-2025-12-11)                EFFECTIVE="openai/gpt-5.2" ;;
            anthropic/claude-3-sonnet-20240229)       EFFECTIVE="anthropic/claude-3-sonnet" ;;
            anthropic/claude-3-5-sonnet-20241022)     EFFECTIVE="anthropic/claude-3.5-sonnet" ;;
            anthropic/claude-3-5-sonnet-20240620)     EFFECTIVE="anthropic/claude-3.5-sonnet-20240620" ;;
            anthropic/claude-3-5-haiku-20241022)      EFFECTIVE="anthropic/claude-3.5-haiku" ;;
            anthropic/claude-3-7-sonnet-20250219)     EFFECTIVE="anthropic/claude-3.7-sonnet" ;;
            anthropic/claude-sonnet-4-20250514)       EFFECTIVE="anthropic/claude-sonnet-4" ;;
            anthropic/claude-sonnet-4-5-20250929)     EFFECTIVE="anthropic/claude-sonnet-4.5" ;;
            anthropic/claude-haiku-4-5-20251001)      EFFECTIVE="anthropic/claude-haiku-4.5" ;;
            x-ai/grok-4-1-fast-reasoning|x-ai/grok-4-1-fast-non-reasoning) EFFECTIVE="x-ai/grok-4.1-fast" ;;
            x-ai/grok-4-fast-reasoning|x-ai/grok-4-fast-non-reasoning)     EFFECTIVE="x-ai/grok-4-fast" ;;
            x-ai/grok-4-0709)                         EFFECTIVE="x-ai/grok-4" ;;
            x-ai/grok-code-fast-1)                    EFFECTIVE="x-ai/grok-code-fast-1" ;;
        esac
        echo -e "${C_GREEN}  ✓ OPENROUTER_API_KEY set — will route via OpenRouter${C_NC}"
        echo -e "${C_GREEN}  ✓ Effective OpenRouter model: ${C_BOLD}$EFFECTIVE${C_NC}"
    else
        echo -e "${C_RED}  ✗ No API key configured for $PROVIDER_CLASS AND no OPENROUTER_API_KEY set${C_NC}"
        echo -e "${C_YELLOW}    The AI Node won't be able to invoke this justifier.${C_NC}"
        echo -e "${C_YELLOW}    Add OPENROUTER_API_KEY (or the native key) before applying.${C_NC}"
        exit 1
    fi
fi

############################################
# 3. Apply
############################################
echo
echo -e "${C_BLUE}Updating $AI_NODE_ENV…${C_NC}"

if [ "$DRY_RUN" = "1" ]; then
    echo -e "${C_DIM}  (--dry-run; .env.local would be modified as follows:)${C_NC}"
    if [ -n "$CURRENT" ]; then
        echo "  - JUSTIFIER_MODEL: replace '$CURRENT' → '$MODEL'"
    else
        echo "  - JUSTIFIER_MODEL: append '$MODEL'"
    fi
    echo -e "${C_GREEN}Dry run complete.${C_NC}"
    exit 0
fi

if [ ! -f "$AI_NODE_ENV" ]; then
    echo -e "${C_YELLOW}  $AI_NODE_ENV does not exist; creating it.${C_NC}"
    touch "$AI_NODE_ENV"
fi
cp "$AI_NODE_ENV" "${AI_NODE_ENV}.bak.$(date +%Y%m%d-%H%M%S)"

if grep -q '^JUSTIFIER_MODEL=' "$AI_NODE_ENV"; then
    python3 -c '
import sys, re
path, val = sys.argv[1], sys.argv[2]
with open(path) as f: s = f.read()
s = re.sub(r"^JUSTIFIER_MODEL=.*$", "JUSTIFIER_MODEL=" + val, s, count=1, flags=re.MULTILINE)
with open(path, "w") as f: f.write(s)
' "$AI_NODE_ENV" "$MODEL"
    echo -e "${C_GREEN}  ✓ JUSTIFIER_MODEL updated in $AI_NODE_ENV${C_NC}"
else
    printf '\nJUSTIFIER_MODEL=%s\n' "$MODEL" >> "$AI_NODE_ENV"
    echo -e "${C_GREEN}  ✓ JUSTIFIER_MODEL appended to $AI_NODE_ENV${C_NC}"
fi

############################################
# 4. Restart AI Node (optional)
############################################

# Port-3000 helpers (ss-first, lsof-fallback) — same pattern as the EA-side
# robustness fix in update-pinata-key.sh.
port_3000_held() {
    if command -v ss >/dev/null 2>&1; then
        ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE '[:.]3000$' && return 0
        return 1
    fi
    lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1
}

if [ "$RESTART" = "1" ]; then
    echo
    echo -e "${C_BLUE}Restarting the AI Node to pick up the new value…${C_NC}"
    if [ -x "$AI_NODE_DIR/stop.sh" ] && [ -x "$AI_NODE_DIR/start.sh" ]; then
        (cd "$AI_NODE_DIR" && ./stop.sh) || true
        # Active wait for port 3000 to release
        for _i in 1 2 3 4 5; do
            port_3000_held || break
            sleep 1
        done
        (cd "$AI_NODE_DIR" && ./start.sh)
        # Wait for AI Node to compile and bind (next dev can take 30+ seconds)
        echo -e "${C_DIM}  waiting up to 60s for AI Node to respond on :3000…${C_NC}"
        for _i in $(seq 1 60); do
            if curl -fsS --max-time 2 http://localhost:3000/api/health -o /dev/null 2>/dev/null; then
                echo -e "${C_GREEN}  ✓ AI Node restarted and responding on :3000${C_NC}"
                break
            fi
            sleep 1
        done
        if ! curl -fsS --max-time 2 http://localhost:3000/api/health -o /dev/null 2>/dev/null; then
            echo -e "${C_YELLOW}  AI Node didn't respond within 60s; check logs at $AI_NODE_DIR/logs/${C_NC}"
        fi
    else
        echo -e "${C_YELLOW}  stop.sh/start.sh not found at $AI_NODE_DIR; please restart manually.${C_NC}"
    fi
else
    echo
    echo -e "${C_BLUE}Skipping AI Node restart (--no-restart). Restart manually to apply:${C_NC}"
    echo "  $AI_NODE_DIR/stop.sh && $AI_NODE_DIR/start.sh"
fi

echo
echo -e "${C_GREEN}${C_BOLD}Done.${C_NC}"
echo "Tip: run the doctor to confirm everything is healthy:"
echo "  $INSTALL_DIR/arbiter-doctor.sh --quiet"
