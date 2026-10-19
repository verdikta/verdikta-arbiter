#!/bin/bash

# Verdikta Arbiter Start Script
# Starts all Verdikta Arbiter components

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Base directory (where this script runs from - should be $INSTALL_DIR)
INSTALL_DIR="$(dirname "$(readlink -f "$0")")"

# Define component directories relative to $INSTALL_DIR
AI_NODE_DIR="$INSTALL_DIR/ai-node"
ADAPTER_DIR="$INSTALL_DIR/external-adapter"

echo -e "${BLUE}Starting Verdikta Arbiter from $INSTALL_DIR...${NC}"

# stop-arbiter.sh leaves this marker so the watchdog knows the node is down on
# purpose (upgrade, maintenance) and must not self-heal it. Starting clears it.
# verdikta-arbiter.service (arbiter-boot-service.sh) runs this script at boot.
rm -f "$INSTALL_DIR/.arbiter-stopped"

# Function to check if a process is running on a port
check_port() {
    if lsof -i:$1 >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# The AI Node (Next.js) listens on :3000 well before /api/health answers —
# ~60 s on a small VPS. Anything that checks status right after a start
# (install.sh, upgrade-arbiter.sh, the doctor, an operator) saw a FAIL and
# restarted it, which only resets the warm-up (issue #23). Wait, bounded,
# until it actually answers "ok". AI_NODE_START_TIMEOUT_SECS overrides.
ai_node_healthy() {
    curl -fsS --max-time 3 http://localhost:3000/api/health 2>/dev/null | grep -q '"status" *: *"ok"'
}
# ai-node/start.sh rebuilds the production bundle first when the code changed
# since the last build (install and upgrade build up front, so this is rare).
# That build gets its own budget: AI_NODE_BUILD_TIMEOUT_SECS, default 20 min.
ai_node_building() {
    local pid
    pid=$(cat "$AI_NODE_DIR/.build-in-progress" 2>/dev/null) && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}
wait_for_ai_node() {
    local timeout="${AI_NODE_START_TIMEOUT_SECS:-180}" waited=0
    local build_timeout="${AI_NODE_BUILD_TIMEOUT_SECS:-1200}" built=0
    while [ "$waited" -lt "$timeout" ]; do
        if ai_node_healthy; then
            echo -e "${GREEN}AI Node is healthy (answered /api/health after $((waited+built))s).${NC}"
            return 0
        fi
        if [ "$built" -lt "$build_timeout" ] && ai_node_building; then
            [ $((built % 30)) -eq 0 ] && echo -e "${YELLOW}AI Node is building its production bundle (${built}s so far)...${NC}"
            sleep 3; built=$((built+3))
            continue
        fi
        sleep 3; waited=$((waited+3))
    done
    echo -e "${YELLOW}AI Node has not answered /api/health after ${timeout}s.${NC}"
    echo -e "${YELLOW}It may still be starting; check the logs at $AI_NODE_DIR/logs/ai-node_*.log${NC}"
    return 1
}

# The External Adapter (npm start → node) needs a few seconds to listen on
# :8080, more on a busy VPS right after an upgrade. A single check after a
# fixed `sleep 5` printed "Failed to start" for adapters that came up a moment
# later (canary upgrade to d4ff0ec, 2026-10-15). Wait, bounded, until GET
# /version answers or the port listens; fail early only if start.sh gives up
# or the adapter process dies. ADAPTER_START_TIMEOUT_SECS overrides the 60 s.
adapter_up() {
    curl -fsS --max-time 2 http://localhost:8080/version >/dev/null 2>&1 || check_port 8080
}
adapter_process_alive() {
    local pid
    pid=$(cat "$ADAPTER_DIR/adapter.pid" 2>/dev/null) && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}
wait_for_adapter() {
    local starter="$1" timeout="${ADAPTER_START_TIMEOUT_SECS:-60}" waited=0 status=""
    while true; do
        if adapter_up; then
            echo -e "${GREEN}External Adapter started successfully (answered on port 8080 after ${waited}s).${NC}"
            return 0
        fi
        # start.sh returns once the adapter answers or it has given up; from
        # then on the adapter's own process (adapter.pid) has to stay alive.
        if [ -z "$status" ] && ! kill -0 "$starter" 2>/dev/null; then
            if wait "$starter"; then status=0; else status=$?; fi
        fi
        if [ -n "$status" ] && [ "$status" -ne 0 ]; then
            echo -e "${RED}Failed to start External Adapter (start.sh exited with status $status; see its output above). Check logs at $ADAPTER_DIR/logs/adapter_*.log${NC}"
            return 1
        fi
        if [ "$status" = 0 ] && ! adapter_process_alive; then
            echo -e "${RED}Failed to start External Adapter: its process exited. Check logs at $ADAPTER_DIR/logs/adapter_*.log${NC}"
            return 1
        fi
        [ "$waited" -ge "$timeout" ] && break
        sleep 1; waited=$((waited+1))
    done
    echo -e "${RED}Failed to start External Adapter: no answer on port 8080 after ${timeout}s. Check logs at $ADAPTER_DIR/logs/adapter_*.log${NC}"
    return 1
}

# Start AI Node
echo -e "${BLUE}Starting AI Node...${NC}"
if check_port 3000; then
    echo -e "${YELLOW}AI Node is already running on port 3000.${NC}"
    # A listener is not readiness: it may be mid warm-up from an earlier start.
    wait_for_ai_node || true
else
    if [ -f "$AI_NODE_DIR/start.sh" ]; then
        # Ensure the directory exists before trying to cd into it
        if [ -d "$AI_NODE_DIR" ]; then
        cd "$AI_NODE_DIR" && ./start.sh &
        echo -e "${YELLOW}AI Node is starting up (a few seconds; minutes if it has to rebuild first)...${NC}"
        wait_for_ai_node || true
        else
             echo -e "${RED}AI Node directory not found at $AI_NODE_DIR${NC}"
        fi
    else
        echo -e "${RED}AI Node start script not found at $AI_NODE_DIR/start.sh${NC}"
    fi
fi

# Start External Adapter
echo -e "${BLUE}Starting External Adapter...${NC}"
if check_port 8080; then
    echo -e "${YELLOW}External Adapter is already running on port 8080.${NC}"
else
    if [ -f "$ADAPTER_DIR/start.sh" ]; then
        # Ensure the directory exists before trying to cd into it
        if [ -d "$ADAPTER_DIR" ]; then
        (cd "$ADAPTER_DIR" && ./start.sh) &
        # Callers run under set -e (install.sh, upgrade-arbiter.sh); a slow
        # or failed adapter is reported, never turned into a non-zero exit.
        wait_for_adapter $! || true
        else
            echo -e "${RED}External Adapter directory not found at $ADAPTER_DIR${NC}"
        fi
    else
        echo -e "${RED}External Adapter start script not found at $ADAPTER_DIR/start.sh${NC}"
    fi
fi

# Containers. After a host reboot Docker brings both back on its own when they
# carry --restart unless-stopped (installs since the 2026-10-18 reboot wave;
# arbiter-boot-service.sh sets it on older ones), possibly still starting when
# this runs at boot: `docker start` on a running container is a no-op, and the
# waits below are bounded.
container_exists()  { docker inspect "$1" >/dev/null 2>&1; }
container_running() { [ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]; }

# Start PostgreSQL (the Chainlink node exits without its database).
echo -e "${BLUE}Starting PostgreSQL (cl-postgres)...${NC}"
if ! container_exists cl-postgres; then
    echo -e "${RED}cl-postgres container not found. Please run setup-docker.sh first.${NC}"
else
    if container_running cl-postgres; then
        echo -e "${YELLOW}PostgreSQL container is already running.${NC}"
    else
        docker start cl-postgres >/dev/null
    fi
    pg_waited=0
    until docker exec cl-postgres pg_isready -q >/dev/null 2>&1; do
        if [ "$pg_waited" -ge 60 ]; then
            echo -e "${RED}PostgreSQL is not accepting connections after ${pg_waited}s. Check 'docker logs cl-postgres'${NC}"
            break
        fi
        sleep 2; pg_waited=$((pg_waited+2))
    done
    [ "$pg_waited" -lt 60 ] && echo -e "${GREEN}PostgreSQL is ready.${NC}"
fi

# Start Chainlink Node
echo -e "${BLUE}Starting Chainlink Node...${NC}"
if check_port 6688; then
    echo -e "${YELLOW}Chainlink Node is already running on port 6688.${NC}"
elif ! container_exists chainlink; then
    echo -e "${RED}Chainlink container not found. Please run setup-chainlink.sh first.${NC}"
else
    if container_running chainlink; then
        echo -e "${YELLOW}Chainlink container is running; waiting for it to listen on port 6688...${NC}"
    else
        echo -e "${BLUE}Starting Chainlink container...${NC}"
        docker start chainlink >/dev/null
    fi
    cl_waited=0
    until check_port 6688; do
        if ! container_running chainlink; then
            echo -e "${RED}Chainlink container is not running (it exited, or docker start failed). Check the logs with 'docker logs chainlink'${NC}"
            break
        fi
        if [ "$cl_waited" -ge "${CHAINLINK_START_TIMEOUT_SECS:-90}" ]; then
            echo -e "${RED}Chainlink Node is not listening on port 6688 after ${cl_waited}s. Check the logs with 'docker logs chainlink'${NC}"
            break
        fi
        sleep 3; cl_waited=$((cl_waited+3))
    done
    check_port 6688 && echo -e "${GREEN}Chainlink Node started successfully (listening after ${cl_waited}s).${NC}"
fi

# Print status
echo -e "${BLUE}Verdikta Arbiter Status:${NC}"
echo -e "  AI Node:          $(check_port 3000 && echo -e "${GREEN}Running${NC}" || echo -e "${RED}Not Running${NC}")"
echo -e "  External Adapter: $(check_port 8080 && echo -e "${GREEN}Running${NC}" || echo -e "${RED}Not Running${NC}")"
echo -e "  Chainlink Node:   $(check_port 6688 && echo -e "${GREEN}Running${NC}" || echo -e "${RED}Not Running${NC}")"

echo -e "${GREEN}Verdikta Arbiter startup completed.${NC}"
echo -e "Access your services at:"
echo -e "  - AI Node:          http://localhost:3000"
echo -e "  - External Adapter: http://localhost:8080"
echo -e "  - Chainlink Node:   http://localhost:6688" 