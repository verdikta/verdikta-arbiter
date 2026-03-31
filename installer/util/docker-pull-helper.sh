#!/bin/bash

# Verdikta Arbiter - Docker Pull Helper
# Shared utility for pulling Docker images with retry logic and DNS fallback.
# Expects the calling script to define: ask_yes_no(), color variables (GREEN, YELLOW, RED, BLUE, NC).

# Guard against multiple sourcing
if [ -n "$_DOCKER_PULL_HELPER_LOADED" ]; then
    return 0 2>/dev/null || true
fi
_DOCKER_PULL_HELPER_LOADED=true

# Pull a Docker image with retries; on persistent failure offer to configure Docker DNS.
docker_pull_with_retry() {
    local image="$1"
    local max_attempts=3

    for attempt in $(seq 1 $max_attempts); do
        echo -e "${BLUE}Pulling Docker image '$image' (attempt $attempt of $max_attempts)...${NC}"
        if docker pull "$image" 2>&1; then
            return 0
        fi
        if [ "$attempt" -lt "$max_attempts" ]; then
            echo -e "${YELLOW}Pull attempt $attempt failed. Retrying in 5 seconds...${NC}"
            sleep 5
        fi
    done

    echo -e "${RED}Failed to pull '$image' after $max_attempts attempts.${NC}"
    echo -e "${YELLOW}This is usually caused by DNS resolution issues on this server.${NC}"
    echo -e "${BLUE}Would you like to configure Docker to use public DNS servers (Google 8.8.8.8, Cloudflare 1.1.1.1)?${NC}"
    echo -e "${BLUE}This only affects Docker's DNS and will not change your system DNS settings.${NC}"

    if ask_yes_no "Configure Docker DNS and retry?"; then
        echo -e "${BLUE}Configuring Docker DNS...${NC}"
        local daemon_json="/etc/docker/daemon.json"

        if [ -f "$daemon_json" ]; then
            sudo cp "$daemon_json" "${daemon_json}.bak"
            if command -v python3 >/dev/null 2>&1; then
                sudo python3 -c "
import json
with open('$daemon_json') as f:
    cfg = json.load(f)
cfg['dns'] = ['8.8.8.8', '1.1.1.1']
with open('$daemon_json', 'w') as f:
    json.dump(cfg, f, indent=2)
"
            else
                echo '{"dns": ["8.8.8.8", "1.1.1.1"]}' | sudo tee "$daemon_json" > /dev/null
            fi
        else
            echo '{"dns": ["8.8.8.8", "1.1.1.1"]}' | sudo tee "$daemon_json" > /dev/null
        fi

        echo -e "${BLUE}Restarting Docker daemon...${NC}"
        sudo systemctl restart docker
        sleep 3

        echo -e "${BLUE}Retrying image pull with updated DNS...${NC}"
        for attempt in $(seq 1 $max_attempts); do
            echo -e "${BLUE}Pull attempt $attempt of $max_attempts...${NC}"
            if docker pull "$image" 2>&1; then
                echo -e "${GREEN}Successfully pulled '$image' after DNS fix.${NC}"
                return 0
            fi
            [ "$attempt" -lt "$max_attempts" ] && sleep 5
        done

        echo -e "${RED}Still unable to pull '$image'. Please check your network connectivity.${NC}"
        return 1
    else
        echo -e "${RED}Cannot proceed without the '$image' Docker image.${NC}"
        return 1
    fi
}
