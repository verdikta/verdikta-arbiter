#!/bin/bash
#
# Validate the VA_* answers of an unattended run BEFORE anything is installed.
#
#   validate-answers.sh install   # answers for install.sh --answers/--unattended
#   validate-answers.sh upgrade   # answers for upgrade-arbiter.sh
#
# Reads the answers from the environment (install.sh / upgrade-arbiter.sh
# export the answers file before calling this). Prints every problem it finds
# and exits 65 if there is at least one; exits 0 when the answers are usable.
# Secrets are never echoed — only their presence and shape are reported.
#
# The full key reference lives in installer/config/unattended.env.example.

MODE="${1:-install}"
PROBLEMS=0

problem() {
    echo "  ✗ $1" >&2
    PROBLEMS=$((PROBLEMS + 1))
}

is_yes_no() {
    case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
        y|yes|true|1|n|no|false|0|"") return 0 ;;
        *) return 1 ;;
    esac
}

is_yes() {
    case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
        y|yes|true|1) return 0 ;;
        *) return 1 ;;
    esac
}

check_yes_no_keys() {
    local key
    for key in "$@"; do
        local val
        val="$(eval "printf '%s' \"\${${key}:-}\"")"
        if ! is_yes_no "$val"; then
            problem "$key='$val' must be y or n"
        fi
    done
}

echo "Validating unattended answers ($MODE)..." >&2

# ---- keys common to install and upgrade -----------------------------------
check_yes_no_keys VA_CONTINUE_ON_RPC_FAILURE VA_PULL_OLLAMA_MODELS VA_INSTALL_CRON \
    VA_INSTALL_LOG_ROTATION_CRON VA_STATUS_PAGE_REPORTING VA_FUND_KEYS \
    VA_START_SERVICES VA_RESTART_SERVICES

if [ -n "${VA_FUND_AMOUNT:-}" ]; then
    if ! [[ "$VA_FUND_AMOUNT" =~ ^[0-9]+\.?[0-9]*$ ]] || ! awk "BEGIN{exit !($VA_FUND_AMOUNT > 0)}"; then
        problem "VA_FUND_AMOUNT='$VA_FUND_AMOUNT' must be a positive number (ETH per key)"
    fi
fi

if [ -n "${VA_RPC_HTTP_URLS:-}" ] || [ -n "${VA_RPC_WS_URLS:-}" ]; then
    [ -z "${VA_RPC_HTTP_URLS:-}" ] && problem "VA_RPC_WS_URLS is set but VA_RPC_HTTP_URLS is empty (both are needed)"
    [ -z "${VA_RPC_WS_URLS:-}" ] && problem "VA_RPC_HTTP_URLS is set but VA_RPC_WS_URLS is empty (both are needed)"
    if [ -n "${VA_RPC_HTTP_URLS:-}" ] && [ -n "${VA_RPC_WS_URLS:-}" ]; then
        http_n=$(printf '%s' "$VA_RPC_HTTP_URLS" | tr -d ' ' | sed 's/;*$//' | awk -F';' '{print NF}')
        ws_n=$(printf '%s' "$VA_RPC_WS_URLS" | tr -d ' ' | sed 's/;*$//' | awk -F';' '{print NF}')
        [ "$http_n" != "$ws_n" ] && problem "VA_RPC_HTTP_URLS has $http_n endpoint(s) but VA_RPC_WS_URLS has $ws_n; the lists must pair up"
        case "$VA_RPC_HTTP_URLS" in http://*|https://*) ;; *) problem "VA_RPC_HTTP_URLS must start with http:// or https://" ;; esac
        case "$VA_RPC_WS_URLS" in ws://*|wss://*) ;; *) problem "VA_RPC_WS_URLS must start with ws:// or wss://" ;; esac
    fi
fi

if [ -n "${VA_STATUS_PAGE_WEBHOOK:-}" ]; then
    case "$VA_STATUS_PAGE_WEBHOOK" in http://*|https://*) ;; *) problem "VA_STATUS_PAGE_WEBHOOK must be an http(s) URL" ;; esac
fi

if [ "$MODE" = "install" ]; then
    # ---- install-only keys --------------------------------------------------
    check_yes_no_keys VA_INSTALL_NODE VA_INSTALL_DOCKER VA_USE_NONEMPTY_DIR \
        VA_ROUTE_ALL_VIA_OPENROUTER VA_DOCKER_BACKUP_EXISTING_DB \
        VA_DOCKER_CONTINUE_WITHOUT_BACKUP VA_DOCKER_REMOVE_EXISTING VA_REGISTER_ORACLE

    case "${VA_EXISTING_INSTALL_ACTION:-}" in
        ""|overwrite|cancel) ;;
        *) problem "VA_EXISTING_INSTALL_ACTION='$VA_EXISTING_INSTALL_ACTION' must be overwrite or cancel" ;;
    esac

    case "${VA_NETWORK:-}" in
        ""|base_sepolia|sepolia|testnet|1|base_mainnet|mainnet|2) ;;
        *) problem "VA_NETWORK='$VA_NETWORK' must be base_sepolia or base_mainnet" ;;
    esac

    if [ -z "${VA_PRIVATE_KEY:-}" ]; then
        problem "VA_PRIVATE_KEY is required (deployment wallet private key, 64 hex chars, no 0x)"
    else
        pk="${VA_PRIVATE_KEY#0x}"
        if ! [[ "$pk" =~ ^[a-fA-F0-9]{64}$ ]]; then
            problem "VA_PRIVATE_KEY has the wrong shape (expected 64 hex characters, with or without 0x)"
        fi
    fi

    if [ -z "${VA_RPC_HTTP_URLS:-}" ] && [ -z "${VA_INFURA_API_KEY:-}" ]; then
        problem "RPC endpoints are required: set VA_RPC_HTTP_URLS + VA_RPC_WS_URLS, or VA_INFURA_API_KEY"
    fi

    if [ -n "${VA_ARBITER_COUNT:-}" ] && ! [[ "$VA_ARBITER_COUNT" =~ ^([1-9]|10)$ ]]; then
        problem "VA_ARBITER_COUNT='$VA_ARBITER_COUNT' must be 1-10"
    fi

    if [ -n "${VA_JUSTIFICATION_MODEL:-}" ] && ! [[ "$VA_JUSTIFICATION_MODEL" =~ ^([1-9]|10)$ ]]; then
        problem "VA_JUSTIFICATION_MODEL='$VA_JUSTIFICATION_MODEL' must be a menu number 1-10"
    fi

    case "${VA_LOG_LEVEL:-}" in
        ""|1|2|3|4|error|warn|warning|info|debug) ;;
        *) problem "VA_LOG_LEVEL='$VA_LOG_LEVEL' must be error, warn, info or debug" ;;
    esac

    if [ -n "${VA_CHAINLINK_EMAIL:-}" ] && ! [[ "$VA_CHAINLINK_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
        problem "VA_CHAINLINK_EMAIL='$VA_CHAINLINK_EMAIL' is not an email address"
    fi

    if is_yes "${VA_REGISTER_ORACLE:-}"; then
        if [ -z "${VA_AGGREGATOR_ADDRESS:-}" ]; then
            problem "VA_REGISTER_ORACLE=y needs VA_AGGREGATOR_ADDRESS (the dispatcher/aggregator contract, 0x...)"
        elif ! [[ "$VA_AGGREGATOR_ADDRESS" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
            problem "VA_AGGREGATOR_ADDRESS='$VA_AGGREGATOR_ADDRESS' is not a 0x-prefixed 40-hex address"
        fi
        if [ -n "${VA_CLASS_IDS:-}" ] && ! [[ "$(printf '%s' "$VA_CLASS_IDS" | tr ',' ' ')" =~ ^[[:space:]]*[0-9]+([[:space:],]+[0-9]+)*[[:space:]]*$ ]]; then
            problem "VA_CLASS_IDS='$VA_CLASS_IDS' must be numbers separated by spaces or commas (e.g. 128 or 128,129)"
        fi
    fi
else
    # ---- upgrade-only keys --------------------------------------------------
    check_yes_no_keys VA_UPGRADE_REVIEW_API_KEYS VA_UPGRADE_UPDATE_JUSTIFIER \
        VA_UPGRADE_UPDATE_RPC VA_UPGRADE_PROCEED VA_UPGRADE_BACKUP \
        VA_UPGRADE_REGENERATE_JOBS VA_UPGRADE_SWITCH_COMMON_LATEST \
        VA_UPGRADE_INTEGRATE_MODELS VA_UPGRADE_RECONFIGURE_JOBS \
        VA_UPGRADE_REGENERATE_CHAINLINK_CONFIG VA_UPGRADE_DOCKER_LOG_ROTATION
    if is_yes "${VA_UPGRADE_REVIEW_API_KEYS:-}"; then
        problem "VA_UPGRADE_REVIEW_API_KEYS=y walks an interactive key-by-key review; leave it n and rotate keys with update-pinata-key.sh / installer/.api_keys instead"
    fi
    if is_yes "${VA_UPGRADE_UPDATE_JUSTIFIER:-}" && [ -z "${VA_JUSTIFIER_MODEL:-}" ]; then
        problem "VA_UPGRADE_UPDATE_JUSTIFIER=y needs VA_JUSTIFIER_MODEL (Provider:model)"
    fi
    if is_yes "${VA_UPGRADE_UPDATE_RPC:-}" && [ -z "${VA_RPC_HTTP_URLS:-}" ] && [ -z "${VA_INFURA_API_KEY:-}" ]; then
        problem "VA_UPGRADE_UPDATE_RPC=y needs VA_RPC_HTTP_URLS + VA_RPC_WS_URLS, or VA_INFURA_API_KEY"
    fi
fi

if [ "$PROBLEMS" -gt 0 ]; then
    echo "$PROBLEMS problem(s) found in the unattended answers." >&2
    exit 65
fi
echo "Unattended answers look valid." >&2
exit 0
