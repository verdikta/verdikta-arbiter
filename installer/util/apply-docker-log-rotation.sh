#!/bin/bash
#
# Verdikta Arbiter - Apply Docker Log Rotation (P2-A, July 2026 incident)
#
# Docker log options are fixed at container creation, so existing installs
# keep an unbounded json-file log (1.8 GB observed in the July 2026 incident)
# even after the installer scripts started passing --log-opt. This utility
# recreates the *chainlink* container in place with bounded logging
# (json-file, max-size=100m, max-file=5). It preserves the existing image
# tag, /chainlink volume mount, port mapping, and network attachments.
#
# The cl-postgres container is intentionally NOT recreated: it has no data
# volume, so removing it would destroy the Chainlink database. Its log is
# checked and reported only; bound it via /etc/docker/daemon.json defaults
# if needed.
#
# Usage:
#   apply-docker-log-rotation.sh            # check + interactive apply
#   apply-docker-log-rotation.sh --check    # report only; exit 0 if bounded, 1 if not
#   apply-docker-log-rotation.sh --apply    # recreate chainlink container without prompting
#

set -o pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

MAX_SIZE="100m"
MAX_FILE="5"

MODE="interactive"
case "${1:-}" in
    --check) MODE="check" ;;
    --apply) MODE="apply" ;;
    "") ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
esac

log_config_bounded() {
    # bounded = json-file (or local) driver with a max-size option set
    local name="$1" driver opts
    driver=$(docker inspect --format '{{.HostConfig.LogConfig.Type}}' "$name" 2>/dev/null)
    [ -z "$driver" ] && return 2   # container missing
    if [ "$driver" = "local" ]; then
        return 0   # local driver rotates by default
    fi
    opts=$(docker inspect --format '{{index .HostConfig.LogConfig.Config "max-size"}}' "$name" 2>/dev/null)
    [ "$driver" = "json-file" ] && [ -n "$opts" ] && [ "$opts" != "<no value>" ] && return 0
    return 1
}

report_container() {
    local name="$1" driver size logpath
    driver=$(docker inspect --format '{{.HostConfig.LogConfig.Type}}' "$name" 2>/dev/null)
    if [ -z "$driver" ]; then
        echo -e "  $name: ${YELLOW}container not found${NC}"
        return
    fi
    logpath=$(docker inspect --format '{{.LogPath}}' "$name" 2>/dev/null)
    size="?"
    [ -n "$logpath" ] && [ -f "$logpath" ] && size=$(du -h "$logpath" 2>/dev/null | cut -f1)
    if log_config_bounded "$name"; then
        echo -e "  $name: ${GREEN}bounded${NC} (driver=$driver, current log: $size)"
    else
        echo -e "  $name: ${RED}UNBOUNDED${NC} (driver=$driver, current log: $size)"
    fi
}

echo -e "${BLUE}Container log rotation status:${NC}"
report_container chainlink
report_container cl-postgres

chainlink_bounded=0
log_config_bounded chainlink; rc=$?
if [ $rc -eq 2 ]; then
    echo -e "${YELLOW}chainlink container not found; nothing to do.${NC}"
    exit 0
elif [ $rc -eq 0 ]; then
    chainlink_bounded=1
fi

if ! log_config_bounded cl-postgres && docker inspect cl-postgres >/dev/null 2>&1; then
    echo -e "${YELLOW}Note: cl-postgres logging is unbounded, but it cannot be safely recreated"
    echo -e "(no data volume — recreation would destroy the Chainlink database)."
    echo -e "Bound it daemon-wide via /etc/docker/daemon.json instead:${NC}"
    echo '  { "log-driver": "json-file", "log-opts": { "max-size": "100m", "max-file": "5" } }'
fi

if [ "$chainlink_bounded" = "1" ]; then
    echo -e "${GREEN}chainlink container logging is already bounded.${NC}"
    exit 0
fi

if [ "$MODE" = "check" ]; then
    exit 1
fi

if [ "$MODE" = "interactive" ]; then
    read -p "Recreate the chainlink container with bounded logging (max-size=$MAX_SIZE, max-file=$MAX_FILE)? (y/n): " resp
    case "$resp" in
        [Yy]*) ;;
        *) echo "Aborted; no changes made."; exit 1 ;;
    esac
fi

# ── Gather the existing container's parameters ───────────────────────────────
IMAGE=$(docker inspect --format '{{.Config.Image}}' chainlink)
CHAINLINK_MOUNT=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/chainlink"}}{{.Source}}{{end}}{{end}}' chainlink)
WAS_RUNNING=$(docker inspect --format '{{.State.Running}}' chainlink)

if [ -z "$IMAGE" ] || [ -z "$CHAINLINK_MOUNT" ]; then
    echo -e "${RED}Could not determine image or /chainlink mount of the existing container. Aborting.${NC}"
    exit 1
fi

echo -e "${BLUE}Recreating chainlink container:${NC}"
echo "  image:  $IMAGE"
echo "  volume: $CHAINLINK_MOUNT -> /chainlink"

if [ "$WAS_RUNNING" = "true" ]; then
    echo -e "${BLUE}→ Stopping chainlink container (graceful, 30s)...${NC}"
    docker stop chainlink --time=30 || { echo -e "${RED}Failed to stop container. Aborting.${NC}"; exit 1; }
fi

echo -e "${BLUE}→ Removing old container (config/keys live in postgres + $CHAINLINK_MOUNT, not the container)...${NC}"
docker rm chainlink || { echo -e "${RED}Failed to remove container. Aborting.${NC}"; exit 1; }

echo -e "${BLUE}→ Creating new container with bounded logging...${NC}"
docker create --platform linux/amd64 \
    --name chainlink \
    -v "$CHAINLINK_MOUNT:/chainlink" \
    -it \
    -p 6688:6688 \
    --log-driver json-file \
    --log-opt max-size=$MAX_SIZE \
    --log-opt max-file=$MAX_FILE \
    --add-host=host.docker.internal:host-gateway \
    --network verdikta-network \
    "$IMAGE" \
    node \
    -config /chainlink/config.toml \
    -secrets /chainlink/secrets.toml \
    start \
    -a /chainlink/.api

if [ $? -ne 0 ]; then
    echo -e "${RED}Failed to create the new container. Recover manually with:${NC}"
    echo "  docker run --platform linux/amd64 --name chainlink -v \"$CHAINLINK_MOUNT:/chainlink\" -it -d -p 6688:6688 --add-host=host.docker.internal:host-gateway --network verdikta-network $IMAGE node -config /chainlink/config.toml -secrets /chainlink/secrets.toml start -a /chainlink/.api"
    exit 1
fi

if [ "$WAS_RUNNING" != "true" ]; then
    echo -e "${GREEN}✓ Container recreated with bounded logging (left stopped, matching its previous state).${NC}"
    report_container chainlink
    exit 0
fi

echo -e "${BLUE}→ Starting chainlink container...${NC}"
docker start chainlink || { echo -e "${RED}Failed to start the new container. Check: docker logs chainlink${NC}"; exit 1; }

echo -e "${BLUE}→ Waiting for Chainlink API to respond...${NC}"
for i in {1..30}; do
    if curl -s -f http://localhost:6688/health >/dev/null 2>&1; then
        echo -e "${GREEN}✓ Chainlink node is up with bounded logging.${NC}"
        report_container chainlink
        exit 0
    fi
    sleep 2
done

echo -e "${YELLOW}⚠ Container recreated but the API is not responding yet.${NC}"
echo -e "${YELLOW}  Monitor with: docker logs -f chainlink${NC}"
exit 0
