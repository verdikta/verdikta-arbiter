#!/bin/bash
# Shared by the scripts that change the Chainlink node's config.toml
# (regenerate-chainlink-config.sh, apply-chainlink-finality-tolerance.sh):
# which file Chainlink reads, asking Chainlink whether it accepts a new one,
# and restarting it on the new file with a way back.

# cl_config_path CONTAINER ENV_FILE... -> the config.toml Chainlink reads: the
# container's /chainlink mount, else ~/.chainlink-<NETWORK_TYPE> named by the
# first ENV_FILE that sets NETWORK_TYPE (setup-chainlink.sh mounts that
# directory). Prints nothing when neither exists.
cl_config_path() {
    local cl="$1" mount net env_file
    shift
    mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/chainlink"}}{{.Source}}{{end}}{{end}}' "$cl" 2>/dev/null)
    if [ -n "$mount" ] && [ -f "$mount/config.toml" ]; then
        echo "$mount/config.toml"
        return 0
    fi
    for env_file in "$@"; do
        [ -f "$env_file" ] || continue
        net=$(sed -n 's/^NETWORK_TYPE=["'\'']\{0,1\}\([a-z]*\).*/\1/p' "$env_file" | tail -1)
        [ -n "$net" ] && break
    done
    if [ -n "$net" ] && [ -f "$HOME/.chainlink-$net/config.toml" ]; then
        echo "$HOME/.chainlink-$net/config.toml"
    fi
    return 0
}

# cl_redact_urls -> stdin with every URL cut to scheme://host/… (RPC URLs carry API keys).
cl_redact_urls() {
    sed -E 's#(wss?|https?)://([^/"'\'' ]+)[^"'\'' ]*#\1://\2/…#g'
}

# cl_validate CONTAINER CANDIDATE -> 0 Chainlink accepts CANDIDATE, 1 it does not
# (its reason printed, URLs redacted), 2 it could not be asked (no container,
# no secrets.toml, docker failed). Runs `chainlink node validate` from the
# node's own image in a throwaway container with no network and the config
# directory mounted read-only, so the running node is never touched. CANDIDATE
# must sit in the live config's directory (that directory is what is mounted)
# and be readable by the container's user (copy the live file's mode).
cl_validate() {
    local cl="$1" cand="$2" dir img out rc
    dir=$(cd "$(dirname "$cand")" && pwd)
    [ -f "$dir/secrets.toml" ] || return 2
    img=$(docker inspect --format '{{.Config.Image}}' "$cl" 2>/dev/null)
    [ -n "$img" ] || return 2
    out=$(mktemp)
    rc=0
    docker run --rm --network none --platform linux/amd64 -v "$dir:/chainlink:ro" "$img" \
        node -config "/chainlink/$(basename "$cand")" -secrets /chainlink/secrets.toml validate \
        > "$out" 2>&1 || rc=$?
    if [ "$rc" = "0" ]; then
        rm -f "$out"
        return 0
    fi
    # "Error running app: ..." is Chainlink refusing the file; anything else is docker.
    if grep -q 'Error running app' "$out"; then
        grep -A5 'Error running app' "$out" | head -6 | cl_redact_urls | sed 's/^/    /'
        rm -f "$out"
        return 1
    fi
    tail -2 "$out" | cl_redact_urls | sed 's/^/    /'
    rm -f "$out"
    return 2
}

# cl_restart_or_restore CONTAINER CONFIG BACKUP [WAIT_SECS] -> 0 when Chainlink is
# not running (it reads CONFIG when it next starts) or came back on it, 1 when it
# did not stay up: BACKUP is then written back over CONFIG and Chainlink started
# on it again. A running node whose API is still not answering after WAIT_SECS
# (database migrations) is left as it is, with a warning, and returns 0.
cl_restart_or_restore() {
    local cl="$1" config="$2" backup="$3" wait_secs="${4:-120}" restarts_before status waited
    if [ "$(docker inspect --format '{{.State.Running}}' "$cl" 2>/dev/null)" != "true" ]; then
        echo -e "${BLUE:-}Chainlink is not running; the new config takes effect when it next starts.${NC:-}"
        return 0
    fi
    # The restart policy (unless-stopped) brings a crashing Chainlink straight
    # back, so "it crashed" shows up as a restart count that grew, not only as "exited".
    restarts_before=$(docker inspect --format '{{.RestartCount}}' "$cl" 2>/dev/null)
    echo -e "${BLUE:-}→ Restarting $cl so it reads the new config (graceful, 30s)...${NC:-}"
    if docker restart --time=30 "$cl" >/dev/null; then
        echo -e "${BLUE:-}→ Waiting for the Chainlink API to respond...${NC:-}"
        waited=0
        while [ "$waited" -lt "$wait_secs" ]; do
            status=$(docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$cl" 2>/dev/null)
            if [ "${status%% *}" != "running" ] || [ "${status##* }" != "${restarts_before:-0}" ]; then
                echo -e "${RED:-}Chainlink stopped after the restart (${status:-no status}).${NC:-}" >&2
                break
            fi
            if curl -s -f "http://127.0.0.1:6688/health" >/dev/null 2>&1; then
                echo -e "${GREEN:-}✓ Chainlink is answering on the new config.${NC:-}"
                return 0
            fi
            sleep 2
            waited=$((waited + 2))
        done
        if [ "$waited" -ge "$wait_secs" ]; then
            echo -e "${YELLOW:-}⚠ Chainlink is running but its API is not answering yet (database migrations can take a while). Watch: docker logs -f $cl${NC:-}"
            return 0
        fi
    else
        echo -e "${RED:-}Chainlink did not restart.${NC:-}" >&2
    fi
    echo -e "${RED:-}Restoring the previous config ($backup) and starting Chainlink on it.${NC:-}" >&2
    cat "$backup" > "$config"
    docker restart --time=30 "$cl" >/dev/null 2>&1 || docker start "$cl" >/dev/null 2>&1
    echo -e "${YELLOW:-}Look for the reason in: docker logs --tail 100 $cl${NC:-}" >&2
    return 1
}
