#!/bin/bash
#
# Verdikta Arbiter — Pinata JWT rotation tool
#
# Updates IPFS_PINNING_KEY (and, if missing, IPFS_PINNING_SERVICE) in the
# External Adapter's .env file, validates the JWT's format, optionally
# verifies it with a live Pinata authentication round-trip, and restarts
# the EA so the new key takes effect.
#
# Usage:
#   ./update-pinata-key.sh                 # interactive: prompts for the JWT
#   ./update-pinata-key.sh --jwt <token>   # non-interactive: pass the JWT inline
#   ./update-pinata-key.sh --dry-run       # validate + show changes; don't write
#   ./update-pinata-key.sh --no-verify     # skip Pinata live-auth probe
#   ./update-pinata-key.sh --no-restart    # update .env but don't restart the EA
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
JWT=""
DRY_RUN=0
VERIFY=1
RESTART=1
INSTALL_DIR=""

usage() {
    cat <<EOF
Usage: $0 [--jwt TOKEN] [--dry-run] [--no-verify] [--no-restart] [--install-dir DIR] [-h]

  --jwt TOKEN        Provide the new JWT inline (skip prompt). Don't share secrets in shell history.
  --dry-run          Validate the JWT and show what would change; don't write or restart.
  --no-verify        Skip the live Pinata round-trip (still validates JWT format locally).
  --no-restart       Update .env but don't restart the External Adapter.
  --install-dir DIR  Override autodetected install root (default: /root/verdikta-arbiter-node).
  -h, --help         This help.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --jwt)         shift; JWT="${1:-}"; shift ;;
        --dry-run)     DRY_RUN=1; shift ;;
        --no-verify)   VERIFY=0; shift ;;
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
    if   [ -d "/root/verdikta-arbiter-node/external-adapter" ]; then
        INSTALL_DIR="/root/verdikta-arbiter-node"
    elif [ -d "$HOME/verdikta-arbiter-node/external-adapter" ]; then
        INSTALL_DIR="$HOME/verdikta-arbiter-node"
    else
        # Walk up from script location
        d="$(dirname "$(readlink -f "$0")")"
        while [ "$d" != "/" ]; do
            if [ -d "$d/external-adapter" ]; then INSTALL_DIR="$d"; break; fi
            d="$(dirname "$d")"
        done
    fi
fi

[ -z "$INSTALL_DIR" ] && { echo -e "${C_RED}ERROR: could not locate install dir (try --install-dir).${C_NC}" >&2; exit 1; }
ADAPTER_DIR="$INSTALL_DIR/external-adapter"
ADAPTER_ENV="$ADAPTER_DIR/.env"

if [ ! -d "$ADAPTER_DIR" ]; then
    echo -e "${C_RED}ERROR: external-adapter dir not found at $ADAPTER_DIR.${C_NC}" >&2
    exit 1
fi

############################################
# Prompt if JWT not supplied
############################################
if [ -z "$JWT" ]; then
    echo -e "${C_BLUE}${C_BOLD}Verdikta Arbiter — rotate Pinata JWT${C_NC}"
    echo "Paste the JWT from https://app.pinata.cloud/developers/api-keys"
    echo "(the long ${C_BOLD}eyJ…${C_NC}-prefixed value — NOT the shorter 'API Key' field)."
    echo "Input is hidden:"
    # `read -s` hides input from terminal
    read -s -r JWT
    echo
fi

if [ -z "$JWT" ]; then
    echo -e "${C_RED}No JWT provided. Aborting.${C_NC}" >&2
    exit 1
fi

############################################
# 1. Format validation (local, no network)
############################################
echo
echo -e "${C_BLUE}Validating JWT format…${C_NC}"
KLEN=${#JWT}
PREFIX3="${JWT:0:3}"
# Count dots → segments = dots + 1
SEGS_DOTS="${JWT//[^.]/}"
SEGS=$(( ${#SEGS_DOTS} + 1 ))

printf '  length:   %d\n' "$KLEN"
printf '  segments: %d\n' "$SEGS"
printf '  prefix:   %s…\n' "$PREFIX3"

if [ "$PREFIX3" != "eyJ" ] || [ "$SEGS" -ne 3 ]; then
    echo -e "${C_RED}ERROR: input does not look like a JWT.${C_NC}"
    echo -e "${C_YELLOW}A valid Pinata JWT:${C_NC}"
    echo -e "${C_YELLOW}  - starts with 'eyJ' (base64-encoded '{\"alg\":...')${C_NC}"
    echo -e "${C_YELLOW}  - has exactly 3 dot-separated segments (header.payload.signature)${C_NC}"
    echo -e "${C_YELLOW}  - is typically 400-800 characters long${C_NC}"
    echo -e "${C_YELLOW}You may have pasted the 'API Key' or 'API Secret' field instead.${C_NC}"
    exit 1
fi

if [ "$KLEN" -lt 200 ]; then
    echo -e "${C_YELLOW}⚠ JWT is unusually short ($KLEN chars). Real Pinata JWTs are typically 400-800.${C_NC}"
    echo -e "${C_YELLOW}  Continuing, but double-check you copied the entire token.${C_NC}"
fi

echo -e "${C_GREEN}  ✓ format OK${C_NC}"

############################################
# 2. Live verify against Pinata (optional)
############################################
if [ "$VERIFY" = "1" ]; then
    echo
    echo -e "${C_BLUE}Verifying with Pinata (GET /data/testAuthentication)…${C_NC}"
    if ! command -v curl >/dev/null 2>&1; then
        echo -e "${C_YELLOW}  curl not available; skipping live verification.${C_NC}"
    else
        # The Pinata endpoint /data/testAuthentication returns 200 with a tiny
        # JSON payload if the JWT is accepted; 401 + INVALID_CREDENTIALS otherwise.
        TMP_BODY=$(mktemp)
        HTTP_CODE=$(curl -sS --max-time 15 -o "$TMP_BODY" -w '%{http_code}' \
                     -H "Authorization: Bearer $JWT" \
                     https://api.pinata.cloud/data/testAuthentication 2>/dev/null || echo "000")
        case "$HTTP_CODE" in
            200)
                echo -e "${C_GREEN}  ✓ Pinata accepted the JWT (HTTP 200).${C_NC}"
                ;;
            401)
                echo -e "${C_RED}  ✗ Pinata rejected the JWT (HTTP 401).${C_NC}"
                # show the reason body (small, never contains the JWT)
                echo -e "${C_DIM}  $(head -c 300 "$TMP_BODY")${C_NC}"
                rm -f "$TMP_BODY"
                exit 1
                ;;
            403)
                echo -e "${C_RED}  ✗ Pinata returned HTTP 403 — JWT format OK but lacks required scope.${C_NC}"
                echo -e "${C_DIM}  $(head -c 300 "$TMP_BODY")${C_NC}"
                echo -e "${C_YELLOW}  The verdikta EA uses the legacy /pinning/pinFileToIPFS endpoint.${C_NC}"
                echo -e "${C_YELLOW}  Create a key with admin permissions, or with the 'pinFileToIPFS'${C_NC}"
                echo -e "${C_YELLOW}  endpoint enabled under 'Pinning Services'. The newer 'Files API'${C_NC}"
                echo -e "${C_YELLOW}  scope (v3 endpoints) does NOT cover the legacy pinning endpoint.${C_NC}"
                rm -f "$TMP_BODY"
                exit 1
                ;;
            000)
                echo -e "${C_YELLOW}  ⚠ Could not reach api.pinata.cloud (network issue). Continuing without verification.${C_NC}"
                ;;
            *)
                echo -e "${C_YELLOW}  ⚠ Unexpected HTTP $HTTP_CODE from Pinata. Continuing — review response:${C_NC}"
                echo -e "${C_DIM}  $(head -c 300 "$TMP_BODY")${C_NC}"
                ;;
        esac
        rm -f "$TMP_BODY"
    fi
else
    echo -e "${C_DIM}  (--no-verify; skipping Pinata round-trip)${C_NC}"
fi

############################################
# 3. Update external-adapter/.env
############################################
echo
echo -e "${C_BLUE}Updating $ADAPTER_ENV…${C_NC}"

if [ "$DRY_RUN" = "1" ]; then
    echo -e "${C_DIM}  (--dry-run; .env would be modified as follows:)${C_NC}"
    if [ -f "$ADAPTER_ENV" ] && grep -q '^IPFS_PINNING_KEY=' "$ADAPTER_ENV"; then
        old=$(grep '^IPFS_PINNING_KEY=' "$ADAPTER_ENV" | head -1 | cut -d= -f2-)
        printf '  - IPFS_PINNING_KEY: replace value (old prefix=%s…, new prefix=%s…)\n' "${old:0:6}" "${JWT:0:6}"
    else
        printf '  - IPFS_PINNING_KEY: append (new prefix=%s…)\n' "${JWT:0:6}"
    fi
    if [ ! -f "$ADAPTER_ENV" ] || ! grep -q '^IPFS_PINNING_SERVICE=' "$ADAPTER_ENV"; then
        printf '  - IPFS_PINNING_SERVICE: append (https://api.pinata.cloud)\n'
    else
        printf '  - IPFS_PINNING_SERVICE: unchanged\n'
    fi
    echo -e "${C_GREEN}Dry run complete.${C_NC}"
    exit 0
fi

# Real write — backup, then replace or append.
if [ ! -f "$ADAPTER_ENV" ]; then
    echo -e "${C_YELLOW}  $ADAPTER_ENV does not exist; creating it.${C_NC}"
    touch "$ADAPTER_ENV"
fi
cp "$ADAPTER_ENV" "${ADAPTER_ENV}.bak.$(date +%Y%m%d-%H%M%S)"

if grep -q '^IPFS_PINNING_KEY=' "$ADAPTER_ENV"; then
    # Escape characters in JWT that could confuse sed's replacement.
    # Use a python one-liner for safety; JWT chars are URL-safe base64 + dots
    # which is sed-safe in a `|` delimiter, but defending is cheap.
    python3 -c '
import sys, re
path, jwt = sys.argv[1], sys.argv[2]
with open(path) as f: s = f.read()
s = re.sub(r"^IPFS_PINNING_KEY=.*$", "IPFS_PINNING_KEY=" + jwt, s, count=1, flags=re.MULTILINE)
with open(path, "w") as f: f.write(s)
' "$ADAPTER_ENV" "$JWT"
    echo -e "${C_GREEN}  ✓ IPFS_PINNING_KEY updated in $ADAPTER_ENV${C_NC}"
else
    printf '\nIPFS_PINNING_KEY=%s\n' "$JWT" >> "$ADAPTER_ENV"
    echo -e "${C_GREEN}  ✓ IPFS_PINNING_KEY appended to $ADAPTER_ENV${C_NC}"
fi

if ! grep -q '^IPFS_PINNING_SERVICE=' "$ADAPTER_ENV"; then
    printf 'IPFS_PINNING_SERVICE=https://api.pinata.cloud\n' >> "$ADAPTER_ENV"
    echo -e "${C_GREEN}  ✓ IPFS_PINNING_SERVICE=https://api.pinata.cloud appended${C_NC}"
fi

############################################
# 4. Restart EA (optional)
############################################

# Helper: is port 8080 still bound?  Use ss (kernel-backed, reliable) and
# fall back to lsof only if ss is unavailable. `lsof -i` is known to miss
# listening sockets on some installs (different cgroup/namespace, long-
# running process), which is exactly the kind of false-clear that causes
# orphaned listeners to survive a "successful" stop.sh.
port_8080_held() {
    if command -v ss >/dev/null 2>&1; then
        ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE '[:.]8080$' && return 0
        return 1
    fi
    lsof -nP -iTCP:8080 -sTCP:LISTEN >/dev/null 2>&1
}

# Helper: find the PID(s) holding port 8080, again preferring ss over lsof.
port_8080_pids() {
    if command -v ss >/dev/null 2>&1; then
        # ss -tlnp prints lines like:  LISTEN 0 511 *:8080 *:* users:(("node",pid=12345,fd=19))
        ss -tlnp 2>/dev/null \
            | awk '/[:.]8080[[:space:]]/ {print $0}' \
            | grep -oE 'pid=[0-9]+' \
            | cut -d= -f2 \
            | sort -u
        return
    fi
    lsof -nP -iTCP:8080 -sTCP:LISTEN -t 2>/dev/null | sort -u
}

if [ "$RESTART" = "1" ]; then
    echo
    echo -e "${C_BLUE}Restarting the External Adapter to pick up the new JWT…${C_NC}"
    if [ -x "$ADAPTER_DIR/stop.sh" ] && [ -x "$ADAPTER_DIR/start.sh" ]; then
        # 4.1: run the EA's stop.sh
        (cd "$ADAPTER_DIR" && ./stop.sh) || true

        # 4.2: belt-and-suspenders — actively confirm port 8080 is free using
        # ss (which sees listening sockets even when lsof can't). If anything
        # is still bound, kill it directly; that's the failure mode the
        # operator hit before this hardening: stop.sh removed the PID file
        # but a node grandchild still owned the port, and start.sh then
        # refused to bind because the port looked occupied.
        for _i in 1 2 3 4 5; do
            port_8080_held || break
            sleep 1
        done
        if port_8080_held; then
            stragglers=$(port_8080_pids)
            if [ -n "$stragglers" ]; then
                echo -e "${C_YELLOW}  port 8080 still held after stop.sh; killing straggler(s):${C_NC} $stragglers"
                # SIGTERM first, then SIGKILL after a moment
                for pid in $stragglers; do kill -15 "$pid" 2>/dev/null || true; done
                sleep 2
                for pid in $stragglers; do
                    if kill -0 "$pid" 2>/dev/null; then
                        echo -e "${C_YELLOW}  process $pid did not exit on SIGTERM; sending SIGKILL${C_NC}"
                        kill -9 "$pid" 2>/dev/null || true
                    fi
                done
                sleep 1
            fi
        fi
        if port_8080_held; then
            echo -e "${C_RED}  port 8080 is STILL held; refusing to start a second EA.${C_NC}"
            echo -e "${C_YELLOW}  Inspect with:  ss -tlnp | grep :8080${C_NC}"
            echo -e "${C_YELLOW}  Manual recovery:  $INSTALL_DIR/stop-arbiter.sh && $INSTALL_DIR/start-arbiter.sh${C_NC}"
            exit 1
        fi

        # 4.3: actually start the EA back up
        (cd "$ADAPTER_DIR" && ./start.sh)

        # 4.4: confirm the new EA is up and responding
        for _i in 1 2 3 4 5 6 7 8 9 10; do
            if curl -fsS --max-time 2 http://localhost:8080/ -o /dev/null 2>/dev/null; then
                break
            fi
            sleep 1
        done
        if curl -fsS --max-time 2 http://localhost:8080/ -o /dev/null 2>/dev/null; then
            echo -e "${C_GREEN}  ✓ EA restarted and responding on :8080${C_NC}"
        else
            echo -e "${C_YELLOW}  EA process started but is not yet responding on :8080; check logs.${C_NC}"
        fi
    else
        echo -e "${C_YELLOW}  stop.sh/start.sh not found at $ADAPTER_DIR; please restart manually.${C_NC}"
    fi
else
    echo
    echo -e "${C_BLUE}Skipping EA restart (--no-restart). Restart manually to apply:${C_NC}"
    echo "  $ADAPTER_DIR/stop.sh && $ADAPTER_DIR/start.sh"
fi

echo
echo -e "${C_GREEN}${C_BOLD}Done.${C_NC}"
echo "Tip: run the doctor to confirm uploads succeed on the next request:"
echo "  $INSTALL_DIR/arbiter-doctor.sh --quiet"
