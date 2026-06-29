#!/bin/bash
#
# Verdikta Arbiter — API key validation & native-first routing
#
# Validates each configured AI provider API key with a lightweight authenticated
# request, reports which keys work, and (optionally) writes the resulting
# provider routing into the AI Node's .env.local so that:
#
#   • Native provider keys are ALWAYS preferred when they are present and working.
#   • OpenRouter is only used to cover a provider whose native key is missing or
#     is failing/unresponsive (and only when a working OpenRouter key exists).
#
# Routing is expressed with the existing gateway env knobs read at runtime by
# ai-node/src/lib/llm/provider-config.ts:
#
#   • <CLASS>_CLASS_PROVIDER=openrouter   per-class override (auto-managed here)
#   • AI_GATEWAY=openrouter|native        global override (managed by --global)
#
# The per-class overrides are owned by this script: a class whose native key
# fails is pinned to OpenRouter; once the native key works again (next install/
# upgrade or re-run), the override is removed and native-first takes over.
#
# Usage:
#   validate-api-keys.sh [--api-keys-file FILE] [--env-file FILE]
#                        [--global native|openrouter|keep] [--quiet]
#
#   --api-keys-file FILE  Source provider keys from FILE (installer/.api_keys
#                         style). If omitted, keys are read from the environment.
#   --env-file FILE       AI Node .env.local to update with routing decisions.
#                         If omitted, the script only validates and reports.
#   --global VALUE        native     → remove AI_GATEWAY (native-first default)
#                         openrouter → set AI_GATEWAY=openrouter (route all)
#                         keep       → leave AI_GATEWAY untouched (default)
#   --quiet               Reduce output.
#
# Exit codes: always 0 (advisory). Validation problems are reported, not fatal.
#

set -o pipefail

############################################
# Colors
############################################
if [ -t 1 ]; then
    C_RED='\033[0;31m'; C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'
    C_BLUE='\033[0;34m'; C_DIM='\033[2m'; C_BOLD='\033[1m'; C_NC='\033[0m'
else
    C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_DIM=''; C_BOLD=''; C_NC=''
fi

############################################
# Args
############################################
API_KEYS_FILE=""
ENV_FILE=""
GLOBAL="keep"
QUIET=0

while [ $# -gt 0 ]; do
    case "$1" in
        --api-keys-file) shift; API_KEYS_FILE="${1:-}"; shift ;;
        --env-file)      shift; ENV_FILE="${1:-}"; shift ;;
        --global)        shift; GLOBAL="${1:-keep}"; shift ;;
        --quiet)         QUIET=1; shift ;;
        -h|--help)
            grep '^#' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "validate-api-keys.sh: unknown argument: $1" >&2; exit 0 ;;
    esac
done

case "$GLOBAL" in
    native|openrouter|keep) ;;
    *) GLOBAL="keep" ;;
esac

say() { [ "$QUIET" = "1" ] || echo -e "$@"; }

############################################
# Load provider keys
############################################
if [ -n "$API_KEYS_FILE" ] && [ -f "$API_KEYS_FILE" ]; then
    # shellcheck disable=SC1090
    set +u; source "$API_KEYS_FILE"; set +u 2>/dev/null || true
fi

# xAI accepts either variable name.
XAI_EFFECTIVE_KEY="${XAI_API_KEY:-${GROK_API_KEY:-}}"

############################################
# Validation helper (python3 — same dependency the installer already relies on)
############################################
# Echoes one of: ok | bad | unknown | absent
check_key() {
    local provider="$1"
    local key="$2"
    if [ -z "$key" ]; then
        echo "absent"
        return
    fi
    python3 - "$provider" "$key" << 'PY'
import sys, urllib.request, urllib.error

provider, key = sys.argv[1], sys.argv[2]

endpoints = {
    "openai":     ("https://api.openai.com/v1/models",      {"Authorization": "Bearer " + key}),
    "anthropic":  ("https://api.anthropic.com/v1/models",   {"x-api-key": key, "anthropic-version": "2023-06-01"}),
    "xai":        ("https://api.x.ai/v1/models",            {"Authorization": "Bearer " + key}),
    "hyperbolic": ("https://api.hyperbolic.xyz/v1/models",  {"Authorization": "Bearer " + key}),
    "openrouter": ("https://openrouter.ai/api/v1/key",      {"Authorization": "Bearer " + key}),
}

if provider not in endpoints:
    print("unknown"); sys.exit(0)

url, headers = endpoints[provider]
headers["User-Agent"] = "verdikta-arbiter/1.0"

req = urllib.request.Request(url, headers=headers, method="GET")
try:
    with urllib.request.urlopen(req, timeout=12) as resp:
        print("ok" if 200 <= resp.status < 300 else "unknown")
except urllib.error.HTTPError as e:
    # 401/403 are definitive auth failures (bad/expired/revoked key).
    print("bad" if e.code in (401, 403) else "unknown")
except Exception:
    print("unknown")
PY
}

status_label() {
    case "$1" in
        ok)      echo -e "${C_GREEN}✓ working${C_NC}" ;;
        bad)     echo -e "${C_RED}✗ not working (auth failed)${C_NC}" ;;
        unknown) echo -e "${C_YELLOW}? could not verify${C_NC}" ;;
        absent)  echo -e "${C_DIM}– not configured${C_NC}" ;;
    esac
}

############################################
# Run validation
############################################
say "${C_BLUE}${C_BOLD}Validating AI provider API keys…${C_NC}"

OPENAI_STATUS=$(check_key openai "${OPENAI_API_KEY:-}")
ANTHROPIC_STATUS=$(check_key anthropic "${ANTHROPIC_API_KEY:-}")
XAI_STATUS=$(check_key xai "$XAI_EFFECTIVE_KEY")
HYPERBOLIC_STATUS=$(check_key hyperbolic "${HYPERBOLIC_API_KEY:-}")
OPENROUTER_STATUS=$(check_key openrouter "${OPENROUTER_API_KEY:-}")

say ""
say "  OpenAI:     $(status_label "$OPENAI_STATUS")"
say "  Anthropic:  $(status_label "$ANTHROPIC_STATUS")"
say "  xAI:        $(status_label "$XAI_STATUS")"
say "  Hyperbolic: $(status_label "$HYPERBOLIC_STATUS")"
say "  OpenRouter: $(status_label "$OPENROUTER_STATUS")"
say ""

# OpenRouter is "usable" as a fallback if a key is present and not a definitive
# auth failure (we don't penalize on transient/unverifiable network errors).
OR_USABLE=0
if [ -n "${OPENROUTER_API_KEY:-}" ] && [ "$OPENROUTER_STATUS" != "bad" ]; then
    OR_USABLE=1
fi

############################################
# .env.local writers
############################################
set_kv() {
    local k="$1" v="$2" f="$3"
    [ -f "$f" ] || touch "$f"
    grep -v "^${k}=" "$f" > "${f}.vtmp" 2>/dev/null || true
    mv "${f}.vtmp" "$f"
    if [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ]; then
        printf '\n' >> "$f"
    fi
    printf '%s=%s\n' "$k" "$v" >> "$f"
}

remove_kv() {
    local k="$1" f="$2"
    [ -f "$f" ] || return 0
    if grep -q "^${k}=" "$f" 2>/dev/null; then
        grep -v "^${k}=" "$f" > "${f}.vtmp" 2>/dev/null || true
        mv "${f}.vtmp" "$f"
    fi
}

# Decide and (optionally) apply per-class routing for one native provider class.
#   $1 = class name (lower)  $2 = CLASS env prefix (UPPER)  $3 = key value  $4 = status
route_class() {
    local cls="$1" prefix="$2" key="$3" status="$4"
    local var="${prefix}_CLASS_PROVIDER"

    if [ -z "$key" ]; then
        # No native key: native-first already routes to OpenRouter if present.
        # Clear any stale override so we don't pin to a now-removed setup.
        [ -n "$ENV_FILE" ] && remove_kv "$var" "$ENV_FILE"
        return
    fi

    if [ "$status" = "bad" ]; then
        if [ "$OR_USABLE" = "1" ]; then
            say "${C_YELLOW}  → ${cls}: native key is failing; routing this class via OpenRouter until a working key is added.${C_NC}"
            [ -n "$ENV_FILE" ] && set_kv "$var" "openrouter" "$ENV_FILE"
        else
            say "${C_RED}  → ${cls}: native key is failing and no working OpenRouter key is available — this class will not function.${C_NC}"
            [ -n "$ENV_FILE" ] && remove_kv "$var" "$ENV_FILE"
        fi
        return
    fi

    # ok or unknown → trust native-first; remove any auto-override.
    if [ "$status" = "unknown" ]; then
        say "${C_DIM}  → ${cls}: could not verify the native key; keeping native (no override).${C_NC}"
    fi
    [ -n "$ENV_FILE" ] && remove_kv "$var" "$ENV_FILE"
}

############################################
# Apply routing
############################################
if [ -n "$ENV_FILE" ]; then
    if [ ! -f "$ENV_FILE" ]; then
        say "${C_YELLOW}Note: env file '$ENV_FILE' not found; creating it.${C_NC}"
        touch "$ENV_FILE"
    fi
    cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
    say "${C_BLUE}Applying native-first routing to $(basename "$ENV_FILE")…${C_NC}"
fi

route_class "OpenAI"     "OPENAI"     "${OPENAI_API_KEY:-}"     "$OPENAI_STATUS"
route_class "Anthropic"  "ANTHROPIC"  "${ANTHROPIC_API_KEY:-}"  "$ANTHROPIC_STATUS"
route_class "xAI"        "XAI"        "$XAI_EFFECTIVE_KEY"      "$XAI_STATUS"
route_class "Hyperbolic" "HYPERBOLIC" "${HYPERBOLIC_API_KEY:-}" "$HYPERBOLIC_STATUS"

# Global override (AI_GATEWAY) — user preference, separate from per-class health.
if [ -n "$ENV_FILE" ]; then
    case "$GLOBAL" in
        openrouter)
            set_kv "AI_GATEWAY" "openrouter" "$ENV_FILE"
            say "${C_YELLOW}Global override: AI_GATEWAY=openrouter (ALL providers routed through OpenRouter).${C_NC}"
            ;;
        native)
            remove_kv "AI_GATEWAY" "$ENV_FILE"
            say "${C_GREEN}Global routing: native-first (native keys always preferred).${C_NC}"
            ;;
        keep)
            : # leave whatever is there
            ;;
    esac
fi

############################################
# Summary / warnings
############################################
if [ "$OPENAI_STATUS" = "bad" ] || [ "$ANTHROPIC_STATUS" = "bad" ] || \
   [ "$XAI_STATUS" = "bad" ] || [ "$HYPERBOLIC_STATUS" = "bad" ]; then
    say ""
    if [ "$OR_USABLE" = "1" ]; then
        say "${C_YELLOW}One or more native keys are not working. OpenRouter will cover those providers${C_NC}"
        say "${C_YELLOW}until you add a working native key (re-run the upgrade to switch back to native).${C_NC}"
    else
        say "${C_RED}One or more native keys are not working and no working OpenRouter key is set.${C_NC}"
        say "${C_RED}Add a working native key (or an OpenRouter key) so those providers can be used.${C_NC}"
    fi
fi

exit 0
