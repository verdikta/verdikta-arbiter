#!/bin/bash

# Verdikta Arbiter Node Upgrade Script
# Upgrades an existing Verdikta Arbiter installation with new code

set -e  # Exit on any error

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALLER_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$INSTALLER_DIR")"
CONFIG_DIR="$INSTALLER_DIR/config"
UTIL_DIR="$INSTALLER_DIR/util"

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Variables to track state for error recovery
UPGRADE_IN_PROGRESS=0
BACKUP_DIR=""
ARBITER_WAS_RUNNING=0

# Trap handler for errors
cleanup_on_error() {
    if [ $UPGRADE_IN_PROGRESS -eq 1 ]; then
        echo -e "\n${RED}ERROR: Upgrade failed!${NC}"
        
        if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
            echo -e "${YELLOW}A backup of your installation was created at: $BACKUP_DIR${NC}"
            echo -e "${YELLOW}You can restore from this backup if needed.${NC}"
        fi
        
        if [ $ARBITER_WAS_RUNNING -eq 1 ]; then
            echo -e "${YELLOW}Your arbiter was running before the upgrade attempt.${NC}"
            echo -e "${YELLOW}You may need to restart it manually with: $TARGET_DIR/start-arbiter.sh${NC}"
        fi
        
        echo -e "${RED}Please check the logs for more information about what went wrong.${NC}"
    fi
    exit 1
}

# Set up trap for errors
trap cleanup_on_error ERR

# Banner
echo -e "${BLUE}"
echo "===================================================="
echo "  Verdikta Arbiter Node Upgrade"
echo "===================================================="
echo -e "${NC}"

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to prompt for Yes/No question
ask_yes_no() {
    local prompt="$1"
    local response
    
    while true; do
        read -p "$prompt (y/n): " response
        case "$response" in
            [Yy]* ) return 0;;
            [Nn]* ) return 1;;
            * ) echo "Please answer yes (y) or no (n).";;
        esac
    done
}

# Function to check if a directory is a valid Verdikta arbiter installation
validate_installation() {
    local dir="$1"
    
    # Check for key directories
    if [ ! -d "$dir/ai-node" ] || [ ! -d "$dir/external-adapter" ] || [ ! -d "$dir/chainlink-node" ]; then
        echo -e "${RED}Error: $dir does not appear to be a valid Verdikta arbiter installation.${NC}"
        echo -e "${RED}Missing one or more of the required directories: ai-node, external-adapter, chainlink-node${NC}"
        return 1
    fi
    
    # Check for management scripts
    if [ ! -f "$dir/start-arbiter.sh" ] || [ ! -f "$dir/stop-arbiter.sh" ] || [ ! -f "$dir/arbiter-status.sh" ]; then
        echo -e "${RED}Error: $dir does not appear to be a valid Verdikta arbiter installation.${NC}"
        echo -e "${RED}Missing one or more of the required management scripts: start-arbiter.sh, stop-arbiter.sh, arbiter-status.sh${NC}"
        return 1
    fi
    
    return 0
}

# Function to compare directories and detect changes
compare_directories() {
    local src="$1"
    local dst="$2"
    local component="$3"
    local changes=0
    
    echo -e "${BLUE}Checking for changes in $component...${NC}"
    
    # Use rsync dry-run to identify changes
    rsync_output=$(rsync -rcn --delete --exclude="node_modules" --exclude=".env*" --exclude="*.log" --exclude=".git*" "$src/" "$dst/" 2>&1)
    
    # Count changes based on rsync output
    deleted_count=$(echo "$rsync_output" | grep "^deleting " | wc -l)
    new_files=$(echo "$rsync_output" | grep -v "^deleting " | grep -v "^$" | grep -v "sending incremental" | grep -v "bytes/sec" | grep -v "total size" | wc -l)
    
    total_changes=$((deleted_count + new_files))
    
    if [ $total_changes -gt 0 ]; then
        echo -e "${YELLOW}Found $total_changes changes in $component:${NC}"
        echo -e "${YELLOW}- $new_files new or modified files${NC}"
        echo -e "${YELLOW}- $deleted_count files to be removed${NC}"
        changes=1
    else
        echo -e "${GREEN}No changes detected in $component.${NC}"
    fi
    
    return $changes
}

# Function to backup a directory
backup_directory() {
    local dir="$1"
    local backup_name="$2"
    local timestamp=$(date +"%Y%m%d-%H%M%S")
    local backup_dir="${dir}_backup_${timestamp}"
    
    echo -e "${BLUE}Creating backup of $backup_name...${NC}"
    cp -r "$dir" "$backup_dir"
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Backup created at: $backup_dir${NC}"
        return 0
    else
        echo -e "${RED}Failed to create backup of $backup_name!${NC}"
        return 1
    fi
}

# Function to upgrade a component
upgrade_component() {
    local src="$1"
    local dst="$2"
    local component="$3"
    local exclude_patterns="$4"
    
    echo -e "${BLUE}Upgrading $component...${NC}"
    
    # Prepare rsync exclude options
    local exclude_opts=""
    for pattern in $exclude_patterns; do
        exclude_opts="$exclude_opts --exclude=$pattern"
    done
    
    # Perform the sync
    rsync -rc --delete $exclude_opts "$src/" "$dst/"
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Successfully upgraded $component.${NC}"
        return 0
    else
        echo -e "${RED}Failed to upgrade $component!${NC}"
        return 1
    fi
}

# Main script execution starts here

# Get the target installation directory
DEFAULT_INSTALL_DIR="$HOME/verdikta-arbiter-node"

# Load saved installation directory if available
if [ -f "$INSTALLER_DIR/.env" ]; then
    source "$INSTALLER_DIR/.env"
    if [ -n "$INSTALL_DIR" ]; then
        DEFAULT_INSTALL_DIR="$INSTALL_DIR"
    fi
fi

read -p "Enter the target installation directory [$DEFAULT_INSTALL_DIR]: " TARGET_DIR
TARGET_DIR=${TARGET_DIR:-$DEFAULT_INSTALL_DIR}

# Validate that the directory exists
if [ ! -d "$TARGET_DIR" ]; then
    echo -e "${RED}Error: Directory $TARGET_DIR does not exist.${NC}"
    exit 1
fi

# Validate that it's a Verdikta arbiter installation
validate_installation "$TARGET_DIR"
if [ $? -ne 0 ]; then
    exit 1
fi

echo -e "${GREEN}Found valid Verdikta arbiter installation at $TARGET_DIR${NC}"

# Define component paths in both the repository and the installation
REPO_AI_NODE="$REPO_ROOT/ai-node"
REPO_EXTERNAL_ADAPTER="$REPO_ROOT/external-adapter"
REPO_CHAINLINK_NODE="$REPO_ROOT/chainlink-node"
REPO_OPERATOR="$REPO_ROOT/arbiter-operator"

TARGET_AI_NODE="$TARGET_DIR/ai-node"
TARGET_EXTERNAL_ADAPTER="$TARGET_DIR/external-adapter"
TARGET_CHAINLINK_NODE="$TARGET_DIR/chainlink-node"
TARGET_OPERATOR="$TARGET_DIR/contracts"

# Check for changes in each component
CHANGES_DETECTED=0

compare_directories "$REPO_AI_NODE" "$TARGET_AI_NODE" "AI Node"
if [ $? -eq 1 ]; then
    CHANGES_DETECTED=1
    UPGRADE_AI_NODE=1
else
    UPGRADE_AI_NODE=0
fi

compare_directories "$REPO_EXTERNAL_ADAPTER" "$TARGET_EXTERNAL_ADAPTER" "External Adapter"
if [ $? -eq 1 ]; then
    CHANGES_DETECTED=1
    UPGRADE_ADAPTER=1
else
    UPGRADE_ADAPTER=0
fi

compare_directories "$REPO_CHAINLINK_NODE" "$TARGET_CHAINLINK_NODE" "Chainlink Node"
if [ $? -eq 1 ]; then
    CHANGES_DETECTED=1
    UPGRADE_CHAINLINK=1
else
    UPGRADE_CHAINLINK=0
fi

compare_directories "$REPO_OPERATOR" "$TARGET_OPERATOR" "Operator Contracts"
if [ $? -eq 1 ]; then
    CHANGES_DETECTED=1
    UPGRADE_OPERATOR=1
else
    UPGRADE_OPERATOR=0
fi

# Check for changes in management scripts
UTIL_FILES=("start-arbiter.sh" "stop-arbiter.sh" "arbiter-status.sh")
UPGRADE_SCRIPTS=0

for script in "${UTIL_FILES[@]}"; do
    repo_script="$UTIL_DIR/$script"
    target_script="$TARGET_DIR/$script"
    
    if [ -f "$repo_script" ] && [ -f "$target_script" ]; then
        if ! diff -q "$repo_script" "$target_script" > /dev/null; then
            echo -e "${YELLOW}Found changes in $script${NC}"
            CHANGES_DETECTED=1
            UPGRADE_SCRIPTS=1
        fi
    elif [ -f "$repo_script" ] && [ ! -f "$target_script" ]; then
        echo -e "${YELLOW}New script found: $script${NC}"
        CHANGES_DETECTED=1
        UPGRADE_SCRIPTS=1
    fi
done

# If no changes detected, exit early
if [ $CHANGES_DETECTED -eq 0 ]; then
    echo -e "${GREEN}No changes detected. Your arbiter installation is up-to-date.${NC}"
    exit 0
fi

# Ask for confirmation before upgrading
echo
echo -e "${YELLOW}Changes were detected in the following components:${NC}"
[ $UPGRADE_AI_NODE -eq 1 ] && echo -e "- AI Node"
[ $UPGRADE_ADAPTER -eq 1 ] && echo -e "- External Adapter"
[ $UPGRADE_CHAINLINK -eq 1 ] && echo -e "- Chainlink Node"
[ $UPGRADE_OPERATOR -eq 1 ] && echo -e "- Operator Contracts"
[ $UPGRADE_SCRIPTS -eq 1 ] && echo -e "- Management Scripts"
echo

if ! ask_yes_no "Do you want to proceed with the upgrade?"; then
    echo -e "${YELLOW}Upgrade cancelled by user.${NC}"
    exit 0
fi

# Check if arbiter is running
echo -e "${BLUE}Checking if arbiter is running...${NC}"
ARBITER_RUNNING=0

# Check if we need to stop the arbiter
NODE_RUNNING=0
ADAPTER_RUNNING=0
CHAINLINK_RUNNING=0

if lsof -i:3000 >/dev/null 2>&1; then
    NODE_RUNNING=1
    ARBITER_RUNNING=1
fi

if lsof -i:8080 >/dev/null 2>&1; then
    ADAPTER_RUNNING=1
    ARBITER_RUNNING=1
fi

if lsof -i:6688 >/dev/null 2>&1; then
    CHAINLINK_RUNNING=1
    ARBITER_RUNNING=1
fi

# Track if arbiter was running
ARBITER_WAS_RUNNING=$ARBITER_RUNNING

# If arbiter is running, stop it
if [ $ARBITER_RUNNING -eq 1 ]; then
    echo -e "${YELLOW}Arbiter is currently running and will be stopped for the upgrade.${NC}"
    if ask_yes_no "Do you want to continue?"; then
        echo -e "${BLUE}Stopping arbiter...${NC}"
        "$TARGET_DIR/stop-arbiter.sh"
        echo -e "${GREEN}Arbiter stopped successfully.${NC}"
    else
        echo -e "${YELLOW}Upgrade cancelled by user.${NC}"
        exit 0
    fi
else
    echo -e "${GREEN}Arbiter is not running. Proceeding with upgrade...${NC}"
fi

# Create backup
echo -e "${BLUE}Creating backup of current installation...${NC}"
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
BACKUP_DIR="${TARGET_DIR}_backup_${TIMESTAMP}"

cp -r "$TARGET_DIR" "$BACKUP_DIR"
if [ $? -ne 0 ]; then
    echo -e "${RED}Failed to create backup! Aborting upgrade.${NC}"
    exit 1
fi
echo -e "${GREEN}Backup created at: $BACKUP_DIR${NC}"

# Mark that upgrade is in progress
UPGRADE_IN_PROGRESS=1

# Perform the upgrades
echo -e "${BLUE}Starting upgrade process...${NC}"

# Upgrade AI Node if needed
if [ $UPGRADE_AI_NODE -eq 1 ]; then
    echo -e "${BLUE}Upgrading AI Node...${NC}"
    # Exclude files that should be preserved
    upgrade_component "$REPO_AI_NODE" "$TARGET_AI_NODE" "AI Node" "node_modules .env.local logs"
fi

# Upgrade External Adapter if needed
if [ $UPGRADE_ADAPTER -eq 1 ]; then
    echo -e "${BLUE}Upgrading External Adapter...${NC}"
    # Exclude files that should be preserved
    upgrade_component "$REPO_EXTERNAL_ADAPTER" "$TARGET_EXTERNAL_ADAPTER" "External Adapter" "node_modules .env logs"
fi

# Upgrade Chainlink Node if needed
if [ $UPGRADE_CHAINLINK -eq 1 ]; then
    echo -e "${BLUE}Upgrading Chainlink Node...${NC}"
    # Exclude configuration files
    upgrade_component "$REPO_CHAINLINK_NODE" "$TARGET_CHAINLINK_NODE" "Chainlink Node" "*.toml logs"
fi

# Upgrade Operator Contracts if needed
if [ $UPGRADE_OPERATOR -eq 1 ]; then
    echo -e "${BLUE}Upgrading Operator Contracts...${NC}"
    upgrade_component "$REPO_OPERATOR" "$TARGET_OPERATOR" "Operator Contracts" "build"
fi

# Upgrade management scripts if needed
if [ $UPGRADE_SCRIPTS -eq 1 ]; then
    echo -e "${BLUE}Upgrading management scripts...${NC}"
    for script in "${UTIL_FILES[@]}"; do
        repo_script="$UTIL_DIR/$script"
        target_script="$TARGET_DIR/$script"
        
        if [ -f "$repo_script" ]; then
            cp "$repo_script" "$target_script"
            chmod +x "$target_script"
            echo -e "${GREEN}Updated $script${NC}"
        fi
    done
fi

echo -e "${GREEN}Upgrade completed successfully!${NC}"

# Clear the upgrade in progress flag
UPGRADE_IN_PROGRESS=0

# Ask if user wants to restart the arbiter
if [ $ARBITER_WAS_RUNNING -eq 1 ]; then
    if ask_yes_no "Do you want to restart the arbiter now?"; then
        echo -e "${BLUE}Restarting arbiter...${NC}"
        "$TARGET_DIR/start-arbiter.sh"
        
        # Verify restart
        RESTART_SUCCESS=1
        
        if [ $NODE_RUNNING -eq 1 ] && ! lsof -i:3000 >/dev/null 2>&1; then
            echo -e "${RED}Warning: AI Node failed to restart.${NC}"
            RESTART_SUCCESS=0
        fi
        
        if [ $ADAPTER_RUNNING -eq 1 ] && ! lsof -i:8080 >/dev/null 2>&1; then
            echo -e "${RED}Warning: External Adapter failed to restart.${NC}"
            RESTART_SUCCESS=0
        fi
        
        if [ $CHAINLINK_RUNNING -eq 1 ] && ! lsof -i:6688 >/dev/null 2>&1; then
            echo -e "${RED}Warning: Chainlink Node failed to restart.${NC}"
            RESTART_SUCCESS=0
        fi
        
        if [ $RESTART_SUCCESS -eq 1 ]; then
            echo -e "${GREEN}Arbiter restarted successfully.${NC}"
        else
            echo -e "${YELLOW}Some arbiter components did not restart properly.${NC}"
            echo -e "${YELLOW}Please check the logs and restart manually if needed:${NC}"
            echo -e "${YELLOW}  - $TARGET_DIR/start-arbiter.sh${NC}"
        fi
    else
        echo -e "${YELLOW}Please restart the arbiter manually when ready:${NC}"
        echo -e "${YELLOW}  - $TARGET_DIR/start-arbiter.sh${NC}"
    fi
fi

# Success!
echo -e "${GREEN}"
echo "===================================================="
echo "  Verdikta Arbiter Node Upgrade Complete!"
echo "===================================================="
echo -e "${NC}"
echo "Access your services at:"
echo "  - AI Node:          http://localhost:3000"
echo "  - External Adapter: http://localhost:8080"
echo "  - Chainlink Node:   http://localhost:6688"
echo
echo "If you encounter any issues, you can restore from backup at:"
echo "  - $BACKUP_DIR"
echo
echo "For troubleshooting, consult the documentation in the installer/docs directory."
echo
echo "Thank you for using Verdikta Arbiter Node!" 