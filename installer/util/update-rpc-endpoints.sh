#!/bin/bash

# Verdikta Arbiter - Update RPC Endpoints Utility
# Standalone utility to change Chainlink node RPC endpoints,
# regenerate config.toml, and optionally restart the node.

set -e

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# ── Locate installer .env ────────────────────────────────────────────────────

ENV_FILE=""
ENV_SEARCH_LOCATIONS=(
    "$SCRIPT_DIR/../installer/.env"        # From install target root's installer/util/
    "$SCRIPT_DIR/installer/.env"           # From install target root
    "$SCRIPT_DIR/../.env"                  # From installer/util/ in repo
    "$SCRIPT_DIR/.env"                     # Fallback: same directory
)
for _env_path in "${ENV_SEARCH_LOCATIONS[@]}"; do
    if [ -f "$_env_path" ]; then
        ENV_FILE="$(cd "$(dirname "$_env_path")" && pwd)/$(basename "$_env_path")"
        break
    fi
done

if [ -z "$ENV_FILE" ]; then
    echo -e "${RED}Error: installer .env not found in any of these locations:${NC}"
    for _env_path in "${ENV_SEARCH_LOCATIONS[@]}"; do
        echo -e "${RED}  - $_env_path${NC}"
    done
    exit 1
fi

source "$ENV_FILE"

# ── Locate config template ───────────────────────────────────────────────────

TEMPLATE_FILE=""
TEMPLATE_SEARCH_LOCATIONS=(
    "$SCRIPT_DIR/../chainlink-node/config_template.toml"       # Install target root
    "$SCRIPT_DIR/../../chainlink-node/config_template.toml"    # Repo: installer/util/ -> repo root
    "$SCRIPT_DIR/chainlink-node/config_template.toml"          # Fallback
)
for _tpl_path in "${TEMPLATE_SEARCH_LOCATIONS[@]}"; do
    if [ -f "$_tpl_path" ]; then
        TEMPLATE_FILE="$(cd "$(dirname "$_tpl_path")" && pwd)/$(basename "$_tpl_path")"
        break
    fi
done

if [ -z "$TEMPLATE_FILE" ]; then
    echo -e "${RED}Error: config_template.toml not found. Cannot regenerate Chainlink config.${NC}"
    exit 1
fi

# ── Resolve network settings ─────────────────────────────────────────────────

NETWORK_TYPE="${NETWORK_TYPE:-testnet}"
DEPLOYMENT_NETWORK="${DEPLOYMENT_NETWORK:-base_sepolia}"

if [ "$DEPLOYMENT_NETWORK" = "base_mainnet" ]; then
    CHAIN_ID="8453"
    NETWORK_NAME_CONFIG="Base-Mainnet"
    NETWORK_LABEL="Base Mainnet"
    TIP_CAP_DEFAULT="1 gwei"
    FEE_CAP_DEFAULT="10 gwei"
    CURRENT_HTTP_URLS="${BASE_MAINNET_RPC_HTTP_URLS:-}"
    CURRENT_WS_URLS="${BASE_MAINNET_RPC_WS_URLS:-}"
else
    CHAIN_ID="84532"
    NETWORK_NAME_CONFIG="Base-Sepolia"
    NETWORK_LABEL="Base Sepolia"
    TIP_CAP_DEFAULT="2 gwei"
    FEE_CAP_DEFAULT="30 gwei"
    CURRENT_HTTP_URLS="${BASE_SEPOLIA_RPC_HTTP_URLS:-}"
    CURRENT_WS_URLS="${BASE_SEPOLIA_RPC_WS_URLS:-}"
fi

CHAINLINK_DIR="$HOME/.chainlink-${NETWORK_TYPE}"

# ── Helper functions ──────────────────────────────────────────────────────────

ask_yes_no() {
    local prompt="$1"
    local default="${2:-y}"
    local yn_hint="[Y/n]"
    [ "$default" = "n" ] && yn_hint="[y/N]"
    while true; do
        read -p "$prompt $yn_hint: " answer
        answer="${answer:-$default}"
        case "$answer" in
            [Yy]*) return 0 ;;
            [Nn]*) return 1 ;;
            *) echo -e "${RED}Please answer yes or no.${NC}" ;;
        esac
    done
}

normalize_rpc_list() {
    local raw="$1"
    raw="$(echo "$raw" | tr -d ' ' | sed 's/;*$//')"
    echo "$raw"
}

save_env_var() {
    local var_name="$1"
    local var_val="$2"
    local env_file="$3"

    if [ -z "$var_val" ]; then
        return
    fi

    if [ -f "$env_file" ]; then
        grep -v "^$var_name=" "$env_file" > "${env_file}.tmp" 2>/dev/null || true
        mv "${env_file}.tmp" "$env_file"
    fi
    echo "$var_name=\"$var_val\"" >> "$env_file"
}

extract_infura_key_from_urls() {
    local urls="$1"
    local key=""
    IFS=';' read -r -a url_array <<< "$urls"
    for url in "${url_array[@]}"; do
        if echo "$url" | grep -q "infura.io/v3/"; then
            key="$(echo "$url" | sed 's|.*infura.io/v3/||' | sed 's|[/?].*||')"
            if [ -n "$key" ]; then echo "$key"; return 0; fi
        fi
        if echo "$url" | grep -q "infura.io/ws/v3/"; then
            key="$(echo "$url" | sed 's|.*infura.io/ws/v3/||' | sed 's|[/?].*||')"
            if [ -n "$key" ]; then echo "$key"; return 0; fi
        fi
    done
    echo ""
}

check_rpc_url() {
    local url="$1"
    local type="$2"
    python3 - "$url" "$type" << 'PY'
import json, sys
from urllib.parse import urlparse

url = sys.argv[1]
kind = sys.argv[2]
timeout_seconds = 7

if kind == "http":
    try:
        import urllib.request
        payload = json.dumps({"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}).encode("utf-8")
        headers = {"Content-Type":"application/json", "User-Agent":"verdikta-arbiter/1.0"}
        req = urllib.request.Request(url, data=payload, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            if resp.status < 200 or resp.status >= 300:
                sys.exit(1)
            body = resp.read().decode("utf-8", errors="ignore")
            if '"result"' not in body:
                sys.exit(1)
        sys.exit(0)
    except Exception:
        sys.exit(1)

if kind == "ws":
    try:
        import socket
        parsed = urlparse(url)
        host = parsed.hostname
        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        if not host:
            sys.exit(1)
        sock = socket.create_connection((host, port), timeout=timeout_seconds)
        sock.close()
        sys.exit(0)
    except Exception:
        sys.exit(1)

sys.exit(1)
PY
}

check_chainlink_health() {
    local timeout=${1:-30}
    local count=0
    while [ $count -lt $timeout ]; do
        if curl -s -f http://localhost:6688/health >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
        count=$((count + 2))
    done
    return 1
}

# ── Display header ────────────────────────────────────────────────────────────

echo ""
echo -e "${BLUE}============================================================${NC}"
echo -e "${BLUE}  Verdikta Arbiter - Update RPC Endpoints${NC}"
echo -e "${BLUE}============================================================${NC}"
echo ""
echo -e "${BLUE}Network:     ${NC}$NETWORK_LABEL ($DEPLOYMENT_NETWORK)"
echo -e "${BLUE}Config dir:  ${NC}$CHAINLINK_DIR"
echo -e "${BLUE}Environment: ${NC}$ENV_FILE"
echo ""

# ── Show current endpoints ────────────────────────────────────────────────────

echo -e "${BLUE}Current RPC Endpoints:${NC}"
if [ -n "$CURRENT_HTTP_URLS" ]; then
    IFS=';' read -r -a _display_http <<< "$CURRENT_HTTP_URLS"
    for i in "${!_display_http[@]}"; do
        echo -e "  HTTP $((i+1)): ${_display_http[$i]}"
    done
else
    echo -e "  HTTP: ${YELLOW}(none configured)${NC}"
fi
if [ -n "$CURRENT_WS_URLS" ]; then
    IFS=';' read -r -a _display_ws <<< "$CURRENT_WS_URLS"
    for i in "${!_display_ws[@]}"; do
        echo -e "  WS   $((i+1)): ${_display_ws[$i]}"
    done
else
    echo -e "  WS:   ${YELLOW}(none configured)${NC}"
fi
echo ""

# ── Prompt for new endpoints ──────────────────────────────────────────────────

echo -e "${BLUE}Choose how to configure your new RPC endpoints:${NC}"
echo -e "  1) Enter an Infura API Key (endpoints will be generated automatically)"
echo -e "  2) Enter custom RPC URLs (Alchemy, QuickNode, your own Infura URLs, etc.)"
echo ""

NEW_HTTP_URLS=""
NEW_WS_URLS=""
NEW_INFURA_KEY=""

while true; do
    read -p "Select option (1 or 2) [2]: " rpc_method_choice
    rpc_method_choice="${rpc_method_choice:-2}"

    case "$rpc_method_choice" in
        1)
            echo ""
            echo -e "${BLUE}Infura will provide HTTP and WebSocket RPC endpoints for $NETWORK_LABEL.${NC}"
            echo -e "${YELLOW}Get your key at: https://app.infura.io${NC}"

            local_default_key="${INFURA_API_KEY:-}"
            if [ -n "$local_default_key" ]; then
                read -p "Enter your Infura API Key [existing key]: " input_key
                input_key="${input_key:-$local_default_key}"
            else
                read -p "Enter your Infura API Key: " input_key
            fi

            if [ -z "$input_key" ]; then
                echo -e "${RED}Error: Infura API Key is required.${NC}"
                continue
            fi

            NEW_INFURA_KEY="$input_key"
            if [ "$DEPLOYMENT_NETWORK" = "base_mainnet" ]; then
                NEW_HTTP_URLS="https://base-mainnet.infura.io/v3/$input_key"
                NEW_WS_URLS="wss://base-mainnet.infura.io/ws/v3/$input_key"
            else
                NEW_HTTP_URLS="https://base-sepolia.infura.io/v3/$input_key"
                NEW_WS_URLS="wss://base-sepolia.infura.io/ws/v3/$input_key"
            fi
            echo -e "${GREEN}Generated $NETWORK_LABEL RPC endpoints from Infura key.${NC}"
            break
            ;;
        2)
            echo ""
            echo -e "${YELLOW}Provide semicolon-separated HTTP and WS URLs (no spaces).${NC}"
            echo -e "${YELLOW}Example: https://base-sepolia.g.alchemy.com/v2/KEY;https://other-rpc.example.com${NC}"
            echo ""
            echo -e "${BLUE}${NETWORK_LABEL} RPC endpoints:${NC}"

            read -p "Enter HTTP RPC URLs (semicolon-separated) [$CURRENT_HTTP_URLS]: " http_input
            read -p "Enter WS RPC URLs (semicolon-separated) [$CURRENT_WS_URLS]: " ws_input

            http_input="${http_input:-$CURRENT_HTTP_URLS}"
            ws_input="${ws_input:-$CURRENT_WS_URLS}"
            http_input="$(normalize_rpc_list "$http_input")"
            ws_input="$(normalize_rpc_list "$ws_input")"

            if [ -z "$http_input" ] || [ -z "$ws_input" ]; then
                echo -e "${RED}Error: Both HTTP and WS URL lists are required.${NC}"
                read -p "Enter HTTP RPC URLs (semicolon-separated): " http_input
                read -p "Enter WS RPC URLs (semicolon-separated): " ws_input
                http_input="$(normalize_rpc_list "$http_input")"
                ws_input="$(normalize_rpc_list "$ws_input")"
                if [ -z "$http_input" ] || [ -z "$ws_input" ]; then
                    echo -e "${RED}Error: Both HTTP and WS URL lists are required. Aborting.${NC}"
                    exit 1
                fi
            fi

            IFS=';' read -r -a _h_arr <<< "$http_input"
            IFS=';' read -r -a _w_arr <<< "$ws_input"
            if [ "${#_h_arr[@]}" -ne "${#_w_arr[@]}" ]; then
                echo -e "${RED}Error: HTTP URL count (${#_h_arr[@]}) does not match WS URL count (${#_w_arr[@]}).${NC}"
                echo -e "${RED}Each HTTP endpoint needs a corresponding WS endpoint. Aborting.${NC}"
                exit 1
            fi

            NEW_HTTP_URLS="$http_input"
            NEW_WS_URLS="$ws_input"

            extracted_key="$(extract_infura_key_from_urls "$http_input")"
            if [ -z "$extracted_key" ]; then
                extracted_key="$(extract_infura_key_from_urls "$ws_input")"
            fi
            if [ -n "$extracted_key" ]; then
                NEW_INFURA_KEY="$extracted_key"
                echo -e "${GREEN}Detected Infura API key from your URLs.${NC}"
            fi
            break
            ;;
        *)
            echo -e "${RED}Invalid choice. Please enter 1 or 2.${NC}"
            ;;
    esac
done

# ── Show what will change ─────────────────────────────────────────────────────

echo ""
echo -e "${BLUE}New RPC Endpoints:${NC}"
IFS=';' read -r -a _new_http <<< "$NEW_HTTP_URLS"
for i in "${!_new_http[@]}"; do
    echo -e "  HTTP $((i+1)): ${GREEN}${_new_http[$i]}${NC}"
done
IFS=';' read -r -a _new_ws <<< "$NEW_WS_URLS"
for i in "${!_new_ws[@]}"; do
    echo -e "  WS   $((i+1)): ${GREEN}${_new_ws[$i]}${NC}"
done
echo ""

# ── RPC connectivity check ───────────────────────────────────────────────────

echo -e "${BLUE}Checking RPC endpoint connectivity...${NC}"
FAILED_CHECKS=""

IFS=';' read -r -a HTTP_URL_ARRAY <<< "$NEW_HTTP_URLS"
IFS=';' read -r -a WS_URL_ARRAY <<< "$NEW_WS_URLS"

for url in "${HTTP_URL_ARRAY[@]}"; do
    if check_rpc_url "$url" "http"; then
        echo -e "  ${GREEN}✓${NC} HTTP: $url"
    else
        echo -e "  ${RED}✗${NC} HTTP: $url"
        FAILED_CHECKS="${FAILED_CHECKS}\n  HTTP: $url"
    fi
done
for url in "${WS_URL_ARRAY[@]}"; do
    if check_rpc_url "$url" "ws"; then
        echo -e "  ${GREEN}✓${NC} WS:   $url"
    else
        echo -e "  ${RED}✗${NC} WS:   $url"
        FAILED_CHECKS="${FAILED_CHECKS}\n  WS:   $url"
    fi
done

if [ -n "$FAILED_CHECKS" ]; then
    echo ""
    echo -e "${RED}Some RPC endpoints failed connectivity checks:${NC}${FAILED_CHECKS}"
    if ! ask_yes_no "Continue anyway?" "n"; then
        echo -e "${YELLOW}Aborted. No changes were made.${NC}"
        exit 0
    fi
else
    echo -e "${GREEN}All endpoints passed connectivity checks.${NC}"
fi
echo ""

# ── Confirm before applying ──────────────────────────────────────────────────

if ! ask_yes_no "Apply these new RPC endpoints?" "y"; then
    echo -e "${YELLOW}Aborted. No changes were made.${NC}"
    exit 0
fi

# ── Update .env file(s) ──────────────────────────────────────────────────────

echo ""
echo -e "${BLUE}Updating environment configuration...${NC}"

if [ "$DEPLOYMENT_NETWORK" = "base_mainnet" ]; then
    save_env_var "BASE_MAINNET_RPC_HTTP_URLS" "$NEW_HTTP_URLS" "$ENV_FILE"
    save_env_var "BASE_MAINNET_RPC_WS_URLS" "$NEW_WS_URLS" "$ENV_FILE"
    DEFAULT_RPC_URL="$(echo "$NEW_HTTP_URLS" | cut -d';' -f1)"
    save_env_var "BASE_MAINNET_RPC_URL" "$DEFAULT_RPC_URL" "$ENV_FILE"
else
    save_env_var "BASE_SEPOLIA_RPC_HTTP_URLS" "$NEW_HTTP_URLS" "$ENV_FILE"
    save_env_var "BASE_SEPOLIA_RPC_WS_URLS" "$NEW_WS_URLS" "$ENV_FILE"
    DEFAULT_RPC_URL="$(echo "$NEW_HTTP_URLS" | cut -d';' -f1)"
    save_env_var "BASE_SEPOLIA_RPC_URL" "$DEFAULT_RPC_URL" "$ENV_FILE"
fi

if [ -n "$NEW_INFURA_KEY" ]; then
    save_env_var "INFURA_API_KEY" "$NEW_INFURA_KEY" "$ENV_FILE"
fi

chmod 600 "$ENV_FILE"
echo -e "${GREEN}✓ Environment file updated: $ENV_FILE${NC}"

# Also update the repo-side .env if it exists and is different from ENV_FILE
REPO_ENV_FILE=""
REPO_ENV_CANDIDATES=(
    "$SCRIPT_DIR/../.env"                  # installer/util/ -> installer/.env (repo)
    "$SCRIPT_DIR/../../installer/.env"     # install target util -> repo installer/.env
)
for _repo_env in "${REPO_ENV_CANDIDATES[@]}"; do
    if [ -f "$_repo_env" ]; then
        _repo_env_abs="$(cd "$(dirname "$_repo_env")" && pwd)/$(basename "$_repo_env")"
        if [ "$_repo_env_abs" != "$ENV_FILE" ]; then
            REPO_ENV_FILE="$_repo_env_abs"
            break
        fi
    fi
done

if [ -n "$REPO_ENV_FILE" ]; then
    if [ "$DEPLOYMENT_NETWORK" = "base_mainnet" ]; then
        save_env_var "BASE_MAINNET_RPC_HTTP_URLS" "$NEW_HTTP_URLS" "$REPO_ENV_FILE"
        save_env_var "BASE_MAINNET_RPC_WS_URLS" "$NEW_WS_URLS" "$REPO_ENV_FILE"
        save_env_var "BASE_MAINNET_RPC_URL" "$DEFAULT_RPC_URL" "$REPO_ENV_FILE"
    else
        save_env_var "BASE_SEPOLIA_RPC_HTTP_URLS" "$NEW_HTTP_URLS" "$REPO_ENV_FILE"
        save_env_var "BASE_SEPOLIA_RPC_WS_URLS" "$NEW_WS_URLS" "$REPO_ENV_FILE"
        save_env_var "BASE_SEPOLIA_RPC_URL" "$DEFAULT_RPC_URL" "$REPO_ENV_FILE"
    fi
    if [ -n "$NEW_INFURA_KEY" ]; then
        save_env_var "INFURA_API_KEY" "$NEW_INFURA_KEY" "$REPO_ENV_FILE"
    fi
    chmod 600 "$REPO_ENV_FILE"
    echo -e "${GREEN}✓ Repo environment file also updated: $REPO_ENV_FILE${NC}"
fi

# ── Regenerate config.toml ───────────────────────────────────────────────────

echo ""
echo -e "${BLUE}Regenerating Chainlink config.toml...${NC}"

CONFIG_FILE="$CHAINLINK_DIR/config.toml"

if [ ! -d "$CHAINLINK_DIR" ]; then
    echo -e "${YELLOW}Warning: Chainlink directory $CHAINLINK_DIR does not exist.${NC}"
    echo -e "${YELLOW}Environment files have been updated. Run setup-chainlink.sh to create the config.${NC}"
    exit 0
fi

# Build EVM nodes block
EVM_NODES_BLOCK=""
for i in "${!HTTP_URL_ARRAY[@]}"; do
    node_index=$((i + 1))
    http_url="${HTTP_URL_ARRAY[$i]}"
    ws_url="${WS_URL_ARRAY[$i]}"
    EVM_NODES_BLOCK="${EVM_NODES_BLOCK}[[EVM.Nodes]]
Name=\"${NETWORK_NAME_CONFIG}-${node_index}\"
WSURL=\"${ws_url}\"
HTTPURL=\"${http_url}\"

"
done

# Back up current config
if [ -f "$CONFIG_FILE" ]; then
    BACKUP_FILE="${CONFIG_FILE}.backup.$(date +%Y%m%d-%H%M%S)"
    cp "$CONFIG_FILE" "$BACKUP_FILE"
    echo -e "${BLUE}Current config backed up to: $BACKUP_FILE${NC}"
fi

# Generate new config from template
export CHAIN_ID TIP_CAP_DEFAULT FEE_CAP_DEFAULT NETWORK_NAME_CONFIG EVM_NODES_BLOCK TEMPLATE_FILE CONFIG_FILE
python3 - << 'PY'
import os

template_path = os.environ["TEMPLATE_FILE"]
output_path = os.environ["CONFIG_FILE"]

with open(template_path, "r", encoding="utf-8") as f:
    content = f.read()

replacements = {
    "<CHAIN_ID>": os.environ["CHAIN_ID"],
    "<TIP_CAP_DEFAULT>": os.environ["TIP_CAP_DEFAULT"],
    "<FEE_CAP_DEFAULT>": os.environ["FEE_CAP_DEFAULT"],
    "<NETWORK_NAME>": os.environ["NETWORK_NAME_CONFIG"],
    "<EVM_NODES_BLOCK>": os.environ["EVM_NODES_BLOCK"].rstrip() + "\n",
}

for key, value in replacements.items():
    content = content.replace(key, value)

with open(output_path, "w", encoding="utf-8") as f:
    f.write(content)
PY

echo -e "${GREEN}✓ Config regenerated: $CONFIG_FILE${NC}"

# ── Restart Chainlink node ───────────────────────────────────────────────────

echo ""

NODE_RUNNING=false
if docker ps 2>/dev/null | grep -q "chainlink"; then
    NODE_RUNNING=true
fi

if [ "$NODE_RUNNING" = true ]; then
    echo -e "${YELLOW}The Chainlink node must be restarted for the new endpoints to take effect.${NC}"
    if ask_yes_no "Restart the Chainlink node now?" "y"; then
        echo -e "${BLUE}→ Stopping Chainlink container...${NC}"
        docker stop chainlink --time=30
        if [ $? -ne 0 ]; then
            echo -e "${YELLOW}⚠ Graceful shutdown failed, forcing stop...${NC}"
            docker kill chainlink 2>/dev/null || true
        fi
        echo -e "${GREEN}✓ Chainlink container stopped${NC}"

        # Ensure PostgreSQL is running before starting Chainlink
        if ! docker ps | grep -q "cl-postgres"; then
            echo -e "${BLUE}→ Starting PostgreSQL...${NC}"
            docker start cl-postgres 2>/dev/null || true
            for i in {1..15}; do
                if docker exec cl-postgres pg_isready -q 2>/dev/null; then
                    echo -e "${GREEN}✓ PostgreSQL is ready${NC}"
                    break
                fi
                if [ $i -eq 15 ]; then
                    echo -e "${RED}⚠ PostgreSQL may not be ready${NC}"
                fi
                sleep 2
            done
        fi

        echo -e "${BLUE}→ Starting Chainlink container...${NC}"
        docker start chainlink
        if [ $? -ne 0 ]; then
            echo -e "${RED}✗ Failed to start Chainlink container${NC}"
            echo -e "${RED}  Check container logs: docker logs chainlink${NC}"
            exit 1
        fi
        echo -e "${GREEN}✓ Chainlink container started${NC}"

        echo -e "${BLUE}→ Waiting for Chainlink API to become available...${NC}"
        if check_chainlink_health 60; then
            echo -e "${GREEN}✓ Chainlink API is responding${NC}"
        else
            echo -e "${YELLOW}⚠ Chainlink API not responding after 60 seconds${NC}"
            echo -e "${YELLOW}  The node may still be starting up. Check logs:${NC}"
            echo -e "${YELLOW}  docker logs -f chainlink${NC}"
        fi
    else
        echo -e "${YELLOW}Skipping restart. Remember to restart the Chainlink node for changes to take effect.${NC}"
        echo -e "${YELLOW}  Restart with: docker restart chainlink${NC}"
    fi
elif docker ps -a 2>/dev/null | grep -q "chainlink"; then
    echo -e "${BLUE}Chainlink node is currently stopped. New config will apply on next start.${NC}"
    if ask_yes_no "Start the Chainlink node now?" "n"; then
        if ! docker ps | grep -q "cl-postgres"; then
            echo -e "${BLUE}→ Starting PostgreSQL...${NC}"
            docker start cl-postgres 2>/dev/null || true
            for i in {1..15}; do
                if docker exec cl-postgres pg_isready -q 2>/dev/null; then
                    echo -e "${GREEN}✓ PostgreSQL is ready${NC}"
                    break
                fi
                sleep 2
            done
        fi

        echo -e "${BLUE}→ Starting Chainlink container...${NC}"
        docker start chainlink
        if [ $? -ne 0 ]; then
            echo -e "${RED}✗ Failed to start Chainlink container${NC}"
            exit 1
        fi

        echo -e "${BLUE}→ Waiting for Chainlink API...${NC}"
        if check_chainlink_health 60; then
            echo -e "${GREEN}✓ Chainlink API is responding${NC}"
        else
            echo -e "${YELLOW}⚠ Chainlink API not responding after 60 seconds${NC}"
            echo -e "${YELLOW}  docker logs -f chainlink${NC}"
        fi
    fi
else
    echo -e "${YELLOW}No Chainlink container found. Config has been updated for the next deployment.${NC}"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${BLUE}============================================================${NC}"
echo -e "${GREEN}  RPC Endpoint Update Complete${NC}"
echo -e "${BLUE}============================================================${NC}"
echo ""
echo -e "${BLUE}Updated files:${NC}"
echo -e "  Environment: $ENV_FILE"
[ -n "$REPO_ENV_FILE" ] && echo -e "  Repo env:    $REPO_ENV_FILE"
echo -e "  Config:      $CONFIG_FILE"
[ -n "$BACKUP_FILE" ] && echo -e "  Backup:      $BACKUP_FILE"
echo ""
echo -e "${BLUE}Active endpoints:${NC}"
for i in "${!HTTP_URL_ARRAY[@]}"; do
    echo -e "  Node $((i+1)): HTTP=${HTTP_URL_ARRAY[$i]}"
    echo -e "          WS=${WS_URL_ARRAY[$i]}"
done
echo ""
