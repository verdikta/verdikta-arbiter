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

# Flag to track if jobs have been regenerated during this upgrade
JOBS_ALREADY_REGENERATED=0

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
            echo -e "${YELLOW}To restore: rm -rf $TARGET_DIR && cp -r $BACKUP_DIR $TARGET_DIR${NC}"
        else
            echo -e "${RED}No backup was created. Your installation may be in an inconsistent state.${NC}"
            echo -e "${YELLOW}You may need to run a fresh installation or manually fix any issues.${NC}"
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

# Function to load NVM and Node.js
load_nvm() {
    # Check if node is already available
    if command_exists node; then
        echo -e "${GREEN}Node.js $(node --version) already available${NC}"
        return 0
    fi
    
    # Load nvm if it exists
    if [ -d "$HOME/.nvm" ]; then
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
        
        # Verify node is available
        if command_exists node; then
            echo -e "${GREEN}Node.js $(node --version) loaded via NVM${NC}"
            return 0
        else
            echo -e "${RED}Failed to load Node.js from NVM${NC}"
            return 1
        fi
    else
        echo -e "${RED}NVM directory not found and Node.js not available.${NC}"
        echo -e "${RED}Please ensure Node.js is installed or run the original installer.${NC}"
        return 1
    fi
}

# Function to prompt for Yes/No question with optional default
ask_yes_no() {
    local prompt="$1"
    local default="$2"  # Optional: 'y' or 'n'
    local response
    
    # Build prompt with default indicator
    local prompt_text="$prompt"
    if [ "$default" = "y" ]; then
        prompt_text="$prompt (Y/n)"
    elif [ "$default" = "n" ]; then
        prompt_text="$prompt (y/N)"
    else
        prompt_text="$prompt (y/n)"
    fi
    
    while true; do
        read -p "$prompt_text: " response
        
        # Use default if response is empty
        if [ -z "$response" ] && [ -n "$default" ]; then
            response="$default"
        fi
        
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
    
    # Check if the directory exists
    if [ ! -d "$dir" ]; then
        echo -e "${RED}Error: Directory $dir does not exist.${NC}"
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

# Function to check if a process is running on a port (with fallback methods)
check_port() {
    local port=$1
    
    # Method 1: Try lsof first
    if lsof -i:$port >/dev/null 2>&1; then
        return 0
    fi
    
    # Method 2: Try netstat as fallback
    if command_exists netstat; then
        if netstat -ln 2>/dev/null | grep -q ":$port "; then
            return 0
        fi
    fi
    
    # Method 3: Try ss as another fallback
    if command_exists ss; then
        if ss -ln 2>/dev/null | grep -q ":$port "; then
            return 0
        fi
    fi
    
    # Method 4: Try curl for HTTP ports as final check
    if [ "$port" = "3000" ] || [ "$port" = "8080" ] || [ "$port" = "6688" ]; then
        if curl -s --connect-timeout 2 "http://localhost:$port" >/dev/null 2>&1; then
            return 0
        fi
    fi
    
    return 1
}

# Function to create a backup of the target directory
create_backup() {
    local dir="$1"
    local timestamp=$(date +"%Y%m%d-%H%M%S")
    local backup_dir="${dir}_backup_${timestamp}"
    
    echo -e "${BLUE}Creating backup of current installation...${NC}"
    cp -r "$dir" "$backup_dir"
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Backup created at: $backup_dir${NC}"
        BACKUP_DIR="$backup_dir"
        return 0
    else
        echo -e "${RED}Failed to create backup! Aborting upgrade.${NC}"
        return 1
    fi
}

# Function to upgrade a component using full replacement
upgrade_component() {
    local src="$1"
    local dst="$2"
    local component="$3"
    local preserve_patterns="$4"
    
    echo -e "${BLUE}Upgrading $component...${NC}"
    
    # Create component directory if it doesn't exist
    mkdir -p "$dst"
    
    # Save files that should be preserved
    local temp_dir=$(mktemp -d)
    local preserved_files=""
    
    for pattern in $preserve_patterns; do
        if ls "$dst"/$pattern 1> /dev/null 2>&1; then
            echo -e "${BLUE}Preserving existing $pattern files...${NC}"
            cp -r "$dst"/$pattern "$temp_dir"/ 2>/dev/null || true
            preserved_files="$preserved_files $pattern"
        fi
    done
    
    # Remove the old directory contents (including hidden files)
    rm -rf "$dst"/* "$dst"/.[^.]* "$dst"/..?* 2>/dev/null || true
    
    # Copy all files from source (including hidden files)
    # Enable dotglob to include hidden files in glob patterns
    shopt -s dotglob
    cp -r "$src"/* "$dst"/ 2>/dev/null || true
    shopt -u dotglob
    
    # Restore preserved files, but only if they actually existed in target
    for pattern in $preserved_files; do
        if ls "$temp_dir"/$pattern 1> /dev/null 2>&1; then
            echo -e "${BLUE}Restoring preserved $pattern files...${NC}"
            cp -r "$temp_dir"/$pattern "$dst"/ 2>/dev/null || true
        fi
    done
    
    # For files that didn't exist in target but might exist in source, 
    # check if they were copied and report
    for pattern in $preserve_patterns; do
        # Skip if this pattern was already preserved and restored
        if echo "$preserved_files" | grep -q "$pattern"; then
            continue
        fi
        
        # Check if the pattern now exists in the destination (copied from source)
        if ls "$dst"/$pattern 1> /dev/null 2>&1; then
            echo -e "${GREEN}Using $pattern from source (no existing file to preserve)${NC}"
        fi
    done
    
    # Clean up temporary directory
    rm -rf "$temp_dir"
    
    echo -e "${GREEN}Successfully upgraded $component.${NC}"
    return 0
}

# Main script execution starts here

# Load NVM and Node.js first (required for npm operations)
echo -e "${BLUE}Loading Node.js environment...${NC}"
if ! load_nvm; then
    echo -e "${RED}Error: Could not load Node.js. Please ensure NVM and Node.js are installed.${NC}"
    exit 1
fi

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

# Function to comprehensively check if a service is running (like arbiter-status.sh)
check_service_status() {
    local service_name="$1"
    local port="$2"
    local pid_file="$3"
    local target_dir="$4"
    
    # Check PID file first if provided
    if [ -n "$pid_file" ] && [ -f "$target_dir/$pid_file" ]; then
        local pid=$(cat "$target_dir/$pid_file" 2>/dev/null)
        if [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1; then
            echo -e "${GREEN}$service_name is running (PID: $pid).${NC}"
            return 0
        fi
    fi
    
    # Check port as secondary method
    if check_port "$port"; then
        echo -e "${GREEN}$service_name is running (port $port active).${NC}"
        return 0
    fi
    
    # Check for process by name as tertiary method
    case "$service_name" in
        "AI Node")
            if pgrep -f "npm.*start" >/dev/null 2>&1 && pgrep -f "ai-node" >/dev/null 2>&1; then
                echo -e "${YELLOW}$service_name appears to be running (process detected).${NC}"
                return 0
            fi
            ;;
        "External Adapter")
            if pgrep -f "external-adapter" >/dev/null 2>&1 || pgrep -f "adapter.*start" >/dev/null 2>&1; then
                echo -e "${YELLOW}$service_name appears to be running (process detected).${NC}"
                return 0
            fi
            ;;
        "Chainlink Node")
            if docker ps --filter "name=chainlink" --format "table {{.Names}}" | grep -q "chainlink"; then
                echo -e "${GREEN}$service_name is running (Docker container active).${NC}"
                return 0
            fi
            ;;
    esac
    
    echo -e "${BLUE}$service_name is not running.${NC}"
    return 1
}

# Check which components are running using comprehensive method
echo -e "${BLUE}Checking arbiter status...${NC}"
NODE_RUNNING=0
ADAPTER_RUNNING=0
CHAINLINK_RUNNING=0
ARBITER_RUNNING=0

if check_service_status "AI Node" 3000 "ai-node/ai-node.pid" "$TARGET_DIR"; then
    NODE_RUNNING=1
    ARBITER_RUNNING=1
fi

if check_service_status "External Adapter" 8080 "external-adapter/adapter.pid" "$TARGET_DIR"; then
    ADAPTER_RUNNING=1
    ARBITER_RUNNING=1
fi

if check_service_status "Chainlink Node" 6688 "" "$TARGET_DIR"; then
    CHAINLINK_RUNNING=1
    ARBITER_RUNNING=1
fi

# Track if arbiter was running
ARBITER_WAS_RUNNING=$ARBITER_RUNNING

# Offer to update API keys before upgrading
echo
echo -e "${BLUE}API Key Configuration${NC}"
echo -e "${YELLOW}Before upgrading, you can add or update your AI provider API keys.${NC}"
echo -e "${YELLOW}This is useful if you want to enable new providers (like Hyperbolic) or update existing keys.${NC}"
echo

if ask_yes_no "Would you like to review and update your API keys?" "n"; then
    # Load existing keys
    if [ -f "$TARGET_DIR/installer/.api_keys" ]; then
        source "$TARGET_DIR/installer/.api_keys"
        echo -e "${GREEN}Loaded existing API key configuration.${NC}"
    fi
    
    # Load environment for network info
    if [ -f "$TARGET_DIR/installer/.env" ]; then
        source "$TARGET_DIR/installer/.env"
    fi
    
    echo ""
    echo -e "${BLUE}Current API Key Status:${NC}"
    [ -n "$OPENAI_API_KEY" ] && echo -e "  ✓ OpenAI API Key: Configured" || echo -e "  ✗ OpenAI API Key: Not configured"
    [ -n "$ANTHROPIC_API_KEY" ] && echo -e "  ✓ Anthropic API Key: Configured" || echo -e "  ✗ Anthropic API Key: Not configured"
    [ -n "$HYPERBOLIC_API_KEY" ] && echo -e "  ✓ Hyperbolic API Key: Configured" || echo -e "  ✗ Hyperbolic API Key: Not configured"
    [ -n "$XAI_API_KEY" ] && echo -e "  ✓ xAI API Key: Configured" || echo -e "  ✗ xAI API Key: Not configured"
    [ -n "$INFURA_API_KEY" ] && echo -e "  ✓ Infura API Key: Configured" || echo -e "  ✗ Infura API Key: Configured"
    [ -n "$PINATA_API_KEY" ] && echo -e "  ✓ Pinata JWT: Configured" || echo -e "  ✗ Pinata JWT: Not configured"
    echo ""
    
    # OpenAI API Key
    if [ -n "$OPENAI_API_KEY" ]; then
        if ask_yes_no "Update OpenAI API Key? (currently configured)" "n"; then
            read -p "Enter new OpenAI API Key: " new_key
            if [ -n "$new_key" ]; then
                OPENAI_API_KEY="$new_key"
                echo -e "${GREEN}OpenAI API Key updated.${NC}"
            fi
        fi
    else
        read -p "Enter OpenAI API Key (leave blank to skip): " OPENAI_API_KEY
        [ -n "$OPENAI_API_KEY" ] && echo -e "${GREEN}OpenAI API Key added.${NC}"
    fi
    
    # Anthropic API Key
    if [ -n "$ANTHROPIC_API_KEY" ]; then
        if ask_yes_no "Update Anthropic API Key? (currently configured)" "n"; then
            read -p "Enter new Anthropic API Key: " new_key
            if [ -n "$new_key" ]; then
                ANTHROPIC_API_KEY="$new_key"
                echo -e "${GREEN}Anthropic API Key updated.${NC}"
            fi
        fi
    else
        read -p "Enter Anthropic API Key (leave blank to skip): " ANTHROPIC_API_KEY
        [ -n "$ANTHROPIC_API_KEY" ] && echo -e "${GREEN}Anthropic API Key added.${NC}"
    fi
    
    # Hyperbolic API Key (NEW!)
    if [ -n "$HYPERBOLIC_API_KEY" ]; then
        if ask_yes_no "Update Hyperbolic API Key? (currently configured)" "n"; then
            read -p "Enter new Hyperbolic API Key: " new_key
            if [ -n "$new_key" ]; then
                HYPERBOLIC_API_KEY="$new_key"
                echo -e "${GREEN}Hyperbolic API Key updated.${NC}"
            fi
        fi
    else
        echo -e "${BLUE}Hyperbolic provides cost-effective serverless inference for open-source models.${NC}"
        echo -e "${BLUE}Get your key at: https://app.hyperbolic.xyz${NC}"
        read -p "Enter Hyperbolic API Key (leave blank to skip): " HYPERBOLIC_API_KEY
        [ -n "$HYPERBOLIC_API_KEY" ] && echo -e "${GREEN}Hyperbolic API Key added.${NC}"
    fi
    
    # xAI API Key (for Grok models)
    if [ -n "$XAI_API_KEY" ]; then
        if ask_yes_no "Update xAI API Key? (currently configured)" "n"; then
            read -p "Enter new xAI API Key: " new_key
            if [ -n "$new_key" ]; then
                XAI_API_KEY="$new_key"
                echo -e "${GREEN}xAI API Key updated.${NC}"
            fi
        fi
    else
        echo -e "${BLUE}xAI provides access to Grok models (grok-4, grok-4.1, etc.) for advanced reasoning.${NC}"
        echo -e "${BLUE}Get your key at: https://console.x.ai${NC}"
        read -p "Enter xAI API Key (leave blank to skip): " XAI_API_KEY
        [ -n "$XAI_API_KEY" ] && echo -e "${GREEN}xAI API Key added.${NC}"
    fi
    
    # Infura API Key
    if [ -n "$INFURA_API_KEY" ]; then
        if ask_yes_no "Update Infura API Key? (currently configured)" "n"; then
            read -p "Enter new Infura API Key: " new_key
            if [ -n "$new_key" ]; then
                INFURA_API_KEY="$new_key"
                echo -e "${GREEN}Infura API Key updated.${NC}"
            fi
        fi
    else
        read -p "Enter Infura API Key (leave blank to skip): " INFURA_API_KEY
        [ -n "$INFURA_API_KEY" ] && echo -e "${GREEN}Infura API Key added.${NC}"
    fi
    
    # Pinata JWT
    if [ -n "$PINATA_API_KEY" ]; then
        if ask_yes_no "Update Pinata JWT? (currently configured)" "n"; then
            read -p "Enter new Pinata JWT: " new_key
            if [ -n "$new_key" ]; then
                PINATA_API_KEY="$new_key"
                echo -e "${GREEN}Pinata JWT updated.${NC}"
            fi
        fi
    else
        read -p "Enter Pinata JWT (leave blank to skip): " PINATA_API_KEY
        [ -n "$PINATA_API_KEY" ] && echo -e "${GREEN}Pinata JWT added.${NC}"
    fi
    
    # Save updated keys
    mkdir -p "$TARGET_DIR/installer"
    cat > "$TARGET_DIR/installer/.api_keys" << EOL
OPENAI_API_KEY="$OPENAI_API_KEY"
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
HYPERBOLIC_API_KEY="$HYPERBOLIC_API_KEY"
XAI_API_KEY="$XAI_API_KEY"
INFURA_API_KEY="$INFURA_API_KEY"
PINATA_API_KEY="$PINATA_API_KEY"
EOL
    
    # Also update the source installer directory for future upgrades
    cat > "$INSTALLER_DIR/.api_keys" << EOL
OPENAI_API_KEY="$OPENAI_API_KEY"
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
HYPERBOLIC_API_KEY="$HYPERBOLIC_API_KEY"
XAI_API_KEY="$XAI_API_KEY"
INFURA_API_KEY="$INFURA_API_KEY"
PINATA_API_KEY="$PINATA_API_KEY"
EOL
    
    echo -e "${GREEN}API keys saved successfully.${NC}"
    echo -e "${BLUE}Keys will be applied to AI Node during upgrade process.${NC}"
else
    echo -e "${BLUE}Skipping API key configuration. Existing keys will be preserved.${NC}"
fi

# Ask for confirmation before upgrading
echo
echo -e "${YELLOW}The following components will be upgraded:${NC}"
echo -e "- AI Node"
echo -e "- External Adapter"
echo -e "- Chainlink Node configuration files"
echo -e "- Management Scripts"
echo
if [ $ARBITER_RUNNING -eq 1 ]; then
    echo -e "${YELLOW}Note: The arbiter is currently running and will be stopped for the upgrade.${NC}"
fi
echo

if ! ask_yes_no "Do you want to proceed with the upgrade?" "y"; then
    echo -e "${YELLOW}Upgrade cancelled by user.${NC}"
    exit 0
fi

# If arbiter is running, stop it
if [ $ARBITER_RUNNING -eq 1 ]; then
    echo -e "${BLUE}Stopping arbiter...${NC}"
    "$TARGET_DIR/stop-arbiter.sh"
    echo -e "${GREEN}Arbiter stopped successfully.${NC}"
else
    echo -e "${GREEN}Arbiter is not running. Proceeding with upgrade...${NC}"
fi

# Ask if user wants to create a backup
echo -e "${BLUE}Backup Creation${NC}"
echo -e "${YELLOW}A backup of your current installation can be created before upgrading.${NC}"
echo -e "${YELLOW}This allows you to restore if something goes wrong, but takes time and disk space.${NC}"
echo ""

if ask_yes_no "Would you like to create a backup before upgrading? (Recommended for production)" "y"; then
    create_backup "$TARGET_DIR"
    if [ $? -ne 0 ]; then
        exit 1
    fi
else
    echo -e "${YELLOW}Skipping backup creation. Proceeding with upgrade...${NC}"
    echo -e "${RED}WARNING: No backup will be available if the upgrade fails!${NC}"
    if ! ask_yes_no "Are you sure you want to continue without a backup?" "n"; then
        echo -e "${YELLOW}Upgrade cancelled by user.${NC}"
        exit 0
    fi
    BACKUP_DIR=""  # Clear backup directory since no backup was created
fi

# Mark that upgrade is in progress
UPGRADE_IN_PROGRESS=1

# Check for job specification template changes BEFORE component upgrades
echo -e "${BLUE}Checking for job specification template changes...${NC}"

# Function to check and regenerate job specs if needed (following the pattern of check_chainlink_config)
check_job_spec_template() {
    local repo_job_spec="$REPO_CHAINLINK_NODE/basicJobSpec"
    local target_job_spec="$TARGET_CHAINLINK_NODE/basicJobSpec"
    local target_jobs_dir="$TARGET_CHAINLINK_NODE/jobs"
    
    echo -e "${BLUE}Checking job specification template...${NC}"
    
    # Check if current repo template exists
    if [ ! -f "$repo_job_spec" ]; then
        echo -e "${YELLOW}No basicJobSpec template found in source repository. Skipping job spec template check.${NC}"
        return 0
    fi
    
    # Check if target template exists (from previous install)
    if [ ! -f "$target_job_spec" ]; then
        echo -e "${YELLOW}No existing basicJobSpec template found in target installation. Skipping job spec template check.${NC}"
        return 0
    fi
    
    echo -e "${BLUE}Comparing job specification templates:${NC}"
    echo -e "${BLUE}  Current repo template: $repo_job_spec${NC}"
    echo -e "${BLUE}  Previous install template: $target_job_spec${NC}"
    
    # Compare the templates directly (no normalization needed since both are templates)
    if ! diff -q "$repo_job_spec" "$target_job_spec" > /dev/null 2>&1; then
        echo -e "${YELLOW}The job specification template has been updated since your last installation.${NC}"
        echo -e "${YELLOW}This may include timeout changes, new tasks, or other job improvements.${NC}"
        
        # Show the actual differences
        echo -e "${BLUE}Template differences found:${NC}"
        diff "$target_job_spec" "$repo_job_spec" || true
        echo
        
        if ask_yes_no "Would you like to regenerate the job specifications from the updated template? (This will require re-registration if you use an aggregator)" "y"; then
            # Handle the job spec regeneration with proper aggregator management
            regenerate_job_specs
            # Set flag to indicate jobs have been regenerated
            JOBS_ALREADY_REGENERATED=1
        else
            echo -e "${BLUE}Keeping existing job specifications.${NC}"
        fi
    else
        echo -e "${GREEN}Job specification template is up to date.${NC}"
    fi
}

# Function to regenerate job specs (similar to how chainlink config is regenerated)
regenerate_job_specs() {
    echo -e "${BLUE}Regenerating job specifications from template...${NC}"
    
    # Check if we have aggregator registration information
    local need_reregister=0
    local aggregator_addr=""
    local classes_id="128"
    
    if [ -f "$TARGET_DIR/installer/.contracts" ]; then
        source "$TARGET_DIR/installer/.contracts"
        
        if [ -n "$AGGREGATOR_ADDRESS" ]; then
            aggregator_addr="$AGGREGATOR_ADDRESS"
            classes_id="${CLASSES_ID:-128}"
            need_reregister=1
            
            echo -e "${YELLOW}Found existing aggregator registration: $aggregator_addr${NC}"
            echo -e "${YELLOW}Classes: [$classes_id]${NC}"
            echo
            echo -e "${YELLOW}Since job specifications are changing, the oracle will be:${NC}"
            echo -e "${YELLOW}1. Unregistered from the aggregator${NC}"
            echo -e "${YELLOW}2. Job specifications regenerated with new job IDs${NC}"
            echo -e "${YELLOW}3. Re-registered with the aggregator using new job IDs${NC}"
        else
            echo -e "${YELLOW}No aggregator registration found. Jobs will be regenerated without aggregator handling.${NC}"
        fi
    fi
    
    # Step 1: Unregister if needed
    if [ $need_reregister -eq 1 ]; then
        echo -e "${BLUE}Step 1: Unregistering from aggregator...${NC}"
        if [ -f "$TARGET_DIR/unregister-oracle.sh" ]; then
            cd "$TARGET_DIR"
            # Use the existing unregister script non-interactively
            echo -e "y\n$aggregator_addr\ny" | bash unregister-oracle.sh
            if [ $? -eq 0 ]; then
                echo -e "${GREEN}Successfully unregistered from aggregator${NC}"
            else
                echo -e "${YELLOW}Warning: Unregistration may have failed, but continuing...${NC}"
            fi
        else
            echo -e "${YELLOW}Warning: unregister-oracle.sh not found. Continuing with job regeneration...${NC}"
        fi
    fi
    
    # Step 2: Regenerate job specifications (requires Chainlink node to be running)
    echo -e "${BLUE}Step 2: Regenerating job specifications...${NC}"
    echo -e "${YELLOW}Note: The Chainlink node needs to be running for job regeneration.${NC}"
    
    # Check if Chainlink node is running
    if ! docker ps | grep -q "chainlink"; then
        echo -e "${BLUE}Starting Chainlink node temporarily for job regeneration...${NC}"
        cd "$TARGET_DIR"
        if [ -f "$TARGET_DIR/start-arbiter.sh" ]; then
            # Start just the Chainlink node (not the full arbiter)
            if docker ps -a | grep -q "chainlink"; then
                docker start chainlink
            else
                echo -e "${YELLOW}Warning: Chainlink container not found. Starting full arbiter...${NC}"
                bash "$TARGET_DIR/start-arbiter.sh"
            fi
            
            # Wait for Chainlink node to be ready
            echo -e "${BLUE}Waiting for Chainlink node to be ready...${NC}"
            for i in {1..30}; do
                if curl -s http://localhost:6688/health > /dev/null; then
                    echo -e "${GREEN}Chainlink node is ready!${NC}"
                    break
                fi
                if [ $i -eq 30 ]; then
                    echo -e "${RED}Error: Chainlink node failed to start within 60 seconds${NC}"
                    return 1
                fi
                sleep 2
            done
        else
            echo -e "${RED}Error: start-arbiter.sh not found at $TARGET_DIR${NC}"
            return 1
        fi
    else
        echo -e "${GREEN}Chainlink node is already running.${NC}"
    fi
    
    # Now run the job configuration
    cd "$SCRIPT_DIR"
    bash "$SCRIPT_DIR/configure-node.sh"
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Job specifications regenerated successfully!${NC}"
        
        # Update the target installation with the new contracts file
        if [ -f "$INSTALLER_DIR/.contracts" ]; then
            cp "$INSTALLER_DIR/.contracts" "$TARGET_DIR/installer/.contracts"
            echo -e "${GREEN}Updated contracts configuration copied to target installation${NC}"
        fi
        
        # Step 3: Re-register if needed
        if [ $need_reregister -eq 1 ]; then
            echo -e "${BLUE}Step 3: Re-registering with aggregator using new job IDs...${NC}"
            if [ -f "$TARGET_DIR/register-oracle.sh" ]; then
                cd "$TARGET_DIR"
                # Use the existing register script non-interactively
                # Input sequence: y (register?), aggregator_addr, y (continue if already registered?), classes_id, y (confirm registration?)
                echo -e "y\n$aggregator_addr\ny\n$classes_id\ny" | bash register-oracle.sh
                if [ $? -eq 0 ]; then
                    echo -e "${GREEN}Successfully re-registered with aggregator using new job IDs!${NC}"
                    echo -e "${GREEN}Job specification regeneration completed successfully!${NC}"
                else
                    echo -e "${RED}Warning: Re-registration failed. You may need to manually register.${NC}"
                    echo -e "${YELLOW}You can run: $TARGET_DIR/register-oracle.sh${NC}"
                fi
            else
                echo -e "${YELLOW}Warning: register-oracle.sh not found.${NC}"
                echo -e "${YELLOW}You may need to manually re-register with the aggregator.${NC}"
            fi
        fi
        
        # Stop the arbiter again since the upgrade script will handle restart later
        echo -e "${BLUE}Stopping arbiter to continue with upgrade process...${NC}"
        cd "$TARGET_DIR"
        if [ -f "$TARGET_DIR/stop-arbiter.sh" ]; then
            bash "$TARGET_DIR/stop-arbiter.sh"
            echo -e "${GREEN}Arbiter stopped. Upgrade will continue.${NC}"
        else
            echo -e "${YELLOW}Warning: stop-arbiter.sh not found. You may need to manually stop services.${NC}"
        fi
    else
        echo -e "${RED}Error: Job specification regeneration failed!${NC}"
        
        # If job regeneration failed, still try to stop the arbiter
        echo -e "${BLUE}Stopping arbiter after failed job regeneration...${NC}"
        cd "$TARGET_DIR"
        if [ -f "$TARGET_DIR/stop-arbiter.sh" ]; then
            bash "$TARGET_DIR/stop-arbiter.sh"
        fi
        return 1
    fi
}

# Call the job spec template check function (before component upgrades)
check_job_spec_template

# Pre-upgrade: Force fresh install of @verdikta/common in DEV folder to ensure latest ClassID data
echo -e "${BLUE}Pre-upgrade: Forcing fresh install of @verdikta/common in dev folder...${NC}"
echo -e "${BLUE}Note: This bypasses npm cache to ensure latest ClassID data (including new ClassIDs)${NC}"

# Force reinstall in DEV AI Node
if [ -d "$REPO_AI_NODE" ]; then
    echo -e "${BLUE}Updating DEV AI Node @verdikta/common...${NC}"
    cd "$REPO_AI_NODE"
    
    # Clear npm cache and force reinstall to get absolutely latest data
    echo -e "${BLUE}Clearing npm cache for @verdikta/common...${NC}"
    npm cache clean --force 2>/dev/null || true
    
    # Uninstall and reinstall to bypass any cached data
    echo -e "${BLUE}Reinstalling @verdikta/common@latest...${NC}"
    npm uninstall @verdikta/common 2>/dev/null || true
    npm install @verdikta/common@latest
    
    if [ $? -eq 0 ]; then
        DEV_VERSION=$(npm list @verdikta/common --depth=0 2>/dev/null | grep @verdikta/common | awk '{print $2}')
        echo -e "${GREEN}✓ DEV AI Node updated to @verdikta/common@${DEV_VERSION}${NC}"
    else
        echo -e "${RED}✗ Failed to install @verdikta/common in DEV AI Node${NC}"
    fi
    cd "$SCRIPT_DIR"
else
    echo -e "${YELLOW}DEV AI Node directory not found, skipping update${NC}"
fi

# Force reinstall in DEV External Adapter
if [ -d "$REPO_EXTERNAL_ADAPTER" ]; then
    echo -e "${BLUE}Updating DEV External Adapter @verdikta/common...${NC}"
    cd "$REPO_EXTERNAL_ADAPTER"
    npm cache clean --force 2>/dev/null || true
    npm uninstall @verdikta/common 2>/dev/null || true
    npm install @verdikta/common@latest
    
    if [ $? -eq 0 ]; then
        DEV_ADAPTER_VERSION=$(npm list @verdikta/common --depth=0 2>/dev/null | grep @verdikta/common | awk '{print $2}')
        echo -e "${GREEN}✓ DEV External Adapter updated to @verdikta/common@${DEV_ADAPTER_VERSION}${NC}"
    fi
    cd "$SCRIPT_DIR"
fi

echo -e "${GREEN}@verdikta/common force-reinstalled in dev folder with fresh ClassID data.${NC}"

# Show which ClassIDs are now available in DEV
if [ -d "$REPO_AI_NODE" ]; then
    DEV_CLASSIDS=$(cd "$REPO_AI_NODE" && node -e "const { classMap } = require('@verdikta/common'); console.log(classMap.listClasses().map(c => c.id).join(', '));" 2>/dev/null)
    DEV_CLASS_COUNT=$(cd "$REPO_AI_NODE" && node -e "const { classMap } = require('@verdikta/common'); console.log(classMap.listClasses().length);" 2>/dev/null)
    echo -e "${BLUE}Available ClassIDs in DEV: ${DEV_CLASSIDS} (${DEV_CLASS_COUNT} total)${NC}"
fi

# Synchronize models.ts in DEV folder from @verdikta/common
echo -e "${BLUE}Synchronizing models.ts in dev folder from @verdikta/common...${NC}"

if [ -f "$REPO_AI_NODE/src/scripts/classid-integration.js" ]; then
    echo -e "${GREEN}Found classid-integration.js in DEV folder${NC}"
    cd "$REPO_AI_NODE"
    
    # Check if classMap is available
    if node -e "const { classMap } = require('@verdikta/common'); console.log('ClassMap available:', typeof classMap?.listClasses === 'function');" 2>&1 | grep -q "true"; then
        echo -e "${GREEN}ClassMap is available, running integration...${NC}"
        echo -e "${BLUE}Auto-selecting ALL available ClassIDs (${DEV_CLASSIDS})...${NC}"
        
        # Run ClassID integration non-interactively (option 2 = integrate all classes, n = skip Ollama pull)
        echo -e "2\nn" | node src/scripts/classid-integration.js
        
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✓ DEV folder models.ts synchronized with @verdikta/common${NC}"
        else
            echo -e "${YELLOW}⚠ ClassID integration completed with warnings in dev folder${NC}"
        fi
    else
        echo -e "${RED}✗ ClassMap not available in @verdikta/common${NC}"
        echo -e "${YELLOW}Skipping dev folder models.ts sync${NC}"
    fi
    
    cd "$SCRIPT_DIR"
else
    echo -e "${YELLOW}ClassID integration script not found in dev folder${NC}"
fi

# Perform the upgrades
echo -e "${BLUE}Starting upgrade process...${NC}"

# Upgrade AI Node
echo -e "${BLUE}Upgrading AI Node...${NC}"
upgrade_component "$REPO_AI_NODE" "$TARGET_AI_NODE" "AI Node" ".env.local .env logs node_modules *.pid"

# Force clean build by removing any .next folder (ensures fresh compilation)
if [ -d "$TARGET_AI_NODE/.next" ]; then
    echo -e "${BLUE}Removing cached build to force recompilation...${NC}"
    rm -rf "$TARGET_AI_NODE/.next"
    echo -e "${GREEN}Build cache cleared. AI Node will be recompiled on next start.${NC}"
fi

# Update AI Node API keys in .env.local if they were configured
echo -e "${BLUE}Updating AI Node API keys...${NC}"
if [ -f "$TARGET_DIR/installer/.api_keys" ]; then
    source "$TARGET_DIR/installer/.api_keys"
    
    # Update OpenAI key
    if [ -n "$OPENAI_API_KEY" ]; then
        if grep -q "^OPENAI_API_KEY=" "$TARGET_AI_NODE/.env.local"; then
            sed -i.bak "s/^OPENAI_API_KEY=.*/OPENAI_API_KEY=$OPENAI_API_KEY/" "$TARGET_AI_NODE/.env.local"
        else
            echo "OPENAI_API_KEY=$OPENAI_API_KEY" >> "$TARGET_AI_NODE/.env.local"
        fi
        echo -e "${GREEN}✓ OpenAI API Key updated in AI Node${NC}"
    fi
    
    # Update Anthropic key
    if [ -n "$ANTHROPIC_API_KEY" ]; then
        if grep -q "^ANTHROPIC_API_KEY=" "$TARGET_AI_NODE/.env.local"; then
            sed -i.bak "s/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY/" "$TARGET_AI_NODE/.env.local"
        else
            echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" >> "$TARGET_AI_NODE/.env.local"
        fi
        echo -e "${GREEN}✓ Anthropic API Key updated in AI Node${NC}"
    fi
    
    # Update Hyperbolic key (NEW!)
    if [ -n "$HYPERBOLIC_API_KEY" ]; then
        if grep -q "^HYPERBOLIC_API_KEY=" "$TARGET_AI_NODE/.env.local"; then
            sed -i.bak "s/^HYPERBOLIC_API_KEY=.*/HYPERBOLIC_API_KEY=$HYPERBOLIC_API_KEY/" "$TARGET_AI_NODE/.env.local"
        else
            echo "HYPERBOLIC_API_KEY=$HYPERBOLIC_API_KEY" >> "$TARGET_AI_NODE/.env.local"
        fi
        echo -e "${GREEN}✓ Hyperbolic API Key updated in AI Node${NC}"
    fi
    
    # Update xAI key (for Grok models)
    if [ -n "$XAI_API_KEY" ]; then
        if grep -q "^XAI_API_KEY=" "$TARGET_AI_NODE/.env.local"; then
            sed -i.bak "s/^XAI_API_KEY=.*/XAI_API_KEY=$XAI_API_KEY/" "$TARGET_AI_NODE/.env.local"
        else
            echo "XAI_API_KEY=$XAI_API_KEY" >> "$TARGET_AI_NODE/.env.local"
        fi
        echo -e "${GREEN}✓ xAI API Key updated in AI Node${NC}"
    fi
    
    echo -e "${GREEN}AI Node API keys updated successfully.${NC}"
else
    echo -e "${YELLOW}No API keys configuration found. Preserving existing AI Node configuration.${NC}"
fi

# Upgrade External Adapter
echo -e "${BLUE}Upgrading External Adapter...${NC}"
upgrade_component "$REPO_EXTERNAL_ADAPTER" "$TARGET_EXTERNAL_ADAPTER" "External Adapter" ".env .env.local logs node_modules *.pid"

# Update External Adapter with current operator address if available
echo -e "${BLUE}Checking for operator address configuration...${NC}"
if [ -f "$TARGET_DIR/installer/.contracts" ]; then
    source "$TARGET_DIR/installer/.contracts"
    # Check for new naming convention first, then fallback to old
    CURRENT_OPERATOR_ADDR=""
    if [ -n "$OPERATOR_ADDR" ]; then
        CURRENT_OPERATOR_ADDR="$OPERATOR_ADDR"
    elif [ -n "$OPERATOR_ADDRESS" ]; then
        CURRENT_OPERATOR_ADDR="$OPERATOR_ADDRESS"
    fi
    
    if [ -n "$CURRENT_OPERATOR_ADDR" ]; then
        echo -e "${BLUE}Updating External Adapter with operator address: $CURRENT_OPERATOR_ADDR${NC}"
        if [ -f "$TARGET_EXTERNAL_ADAPTER/.env" ]; then
            if grep -q "^OPERATOR_ADDR=" "$TARGET_EXTERNAL_ADAPTER/.env"; then
                sed -i.bak "s|^OPERATOR_ADDR=.*|OPERATOR_ADDR=$CURRENT_OPERATOR_ADDR|" "$TARGET_EXTERNAL_ADAPTER/.env"
            else
                echo "OPERATOR_ADDR=$CURRENT_OPERATOR_ADDR" >> "$TARGET_EXTERNAL_ADAPTER/.env"
            fi
            
            # Ensure AI_TIMEOUT is set (updated: 300000ms = 300 seconds for slow model compatibility)
            if grep -q "^AI_TIMEOUT=" "$TARGET_EXTERNAL_ADAPTER/.env"; then
                # Update existing timeout to the new value
                current_timeout=$(grep "^AI_TIMEOUT=" "$TARGET_EXTERNAL_ADAPTER/.env" | cut -d'=' -f2)
                if [ -n "$current_timeout" ] && [ "$current_timeout" -lt 300000 ]; then
                    sed -i.bak "s/^AI_TIMEOUT=.*/AI_TIMEOUT=300000/" "$TARGET_EXTERNAL_ADAPTER/.env"
                    echo -e "${GREEN}AI_TIMEOUT updated from ${current_timeout}ms to 300000ms (5 minutes)${NC}"
                else
                    echo -e "${GREEN}AI_TIMEOUT already configured appropriately: ${current_timeout}ms${NC}"
                fi
            else
                echo "AI_TIMEOUT=300000" >> "$TARGET_EXTERNAL_ADAPTER/.env"
                echo -e "${GREEN}AI_TIMEOUT added to External Adapter (300 seconds)${NC}"
            fi
            
            echo -e "${GREEN}External Adapter updated with operator address.${NC}"
        else
            echo -e "${YELLOW}Warning: External Adapter .env file not found.${NC}"
        fi
    else
        echo -e "${YELLOW}No operator address found in contracts file.${NC}"
    fi
else
    echo -e "${YELLOW}No contracts file found - operator address not available.${NC}"
fi

# Upgrade Chainlink Node configurations
echo -e "${BLUE}Upgrading Chainlink Node configurations...${NC}"
upgrade_component "$REPO_CHAINLINK_NODE" "$TARGET_CHAINLINK_NODE" "Chainlink Node" "*.toml logs .api"

# Upgrade Operator Contracts
echo -e "${BLUE}Upgrading Operator Contracts...${NC}"
upgrade_component "$REPO_OPERATOR" "$TARGET_OPERATOR" "Operator Contracts" "build"

# Also copy arbiter-operator to the root for standalone registration
echo -e "${BLUE}Updating arbiter-operator for standalone registration...${NC}"
if [ -d "$REPO_OPERATOR" ]; then
    # Preserve any .env file and node_modules
    TEMP_DIR=$(mktemp -d)
    if [ -f "$TARGET_DIR/arbiter-operator/.env" ]; then
        cp "$TARGET_DIR/arbiter-operator/.env" "$TEMP_DIR/"
    fi
    if [ -d "$TARGET_DIR/arbiter-operator/node_modules" ]; then
        cp -r "$TARGET_DIR/arbiter-operator/node_modules" "$TEMP_DIR/"
    fi
    
    # Copy the updated arbiter-operator
    rm -rf "$TARGET_DIR/arbiter-operator"
    # Enable dotglob for consistency (ensures any hidden config files are copied)
    shopt -s dotglob
    cp -r "$REPO_OPERATOR" "$TARGET_DIR/arbiter-operator"
    shopt -u dotglob
    
    # Restore preserved files
    if [ -f "$TEMP_DIR/.env" ]; then
        cp "$TEMP_DIR/.env" "$TARGET_DIR/arbiter-operator/"
    fi
    if [ -d "$TEMP_DIR/node_modules" ]; then
        cp -r "$TEMP_DIR/node_modules" "$TARGET_DIR/arbiter-operator/"
    fi
    
    rm -rf "$TEMP_DIR"
    echo -e "${GREEN}Arbiter-operator updated for standalone registration.${NC}"
else
    echo -e "${YELLOW}Warning: arbiter-operator source directory not found at $REPO_OPERATOR${NC}"
fi

# Update management scripts
echo -e "${BLUE}Updating management scripts...${NC}"
cp "$UTIL_DIR/start-arbiter.sh" "$TARGET_DIR/start-arbiter.sh"
cp "$UTIL_DIR/stop-arbiter.sh" "$TARGET_DIR/stop-arbiter.sh"
cp "$UTIL_DIR/arbiter-status.sh" "$TARGET_DIR/arbiter-status.sh"

# Copy the standalone registration script (if it exists)
if [ -f "$UTIL_DIR/register-oracle.sh" ]; then
    cp "$UTIL_DIR/register-oracle.sh" "$TARGET_DIR/register-oracle.sh"
    chmod +x "$TARGET_DIR/register-oracle.sh"
    echo -e "${GREEN}Standalone registration script updated.${NC}"
else
    echo -e "${YELLOW}Warning: Standalone registration script not found at $UTIL_DIR/register-oracle.sh${NC}"
fi

chmod +x "$TARGET_DIR/start-arbiter.sh" "$TARGET_DIR/stop-arbiter.sh" "$TARGET_DIR/arbiter-status.sh"
echo -e "${GREEN}Management scripts updated.${NC}"

# Copy contracts and environment information
echo -e "${BLUE}Copying contract and environment information...${NC}"
mkdir -p "$TARGET_DIR/installer"

if [ -f "$INSTALLER_DIR/.contracts" ]; then
    cp "$INSTALLER_DIR/.contracts" "$TARGET_DIR/installer/.contracts"
    echo -e "${GREEN}Contract information copied to $TARGET_DIR/installer/.contracts${NC}"
else
    echo -e "${YELLOW}Contract information file not found at $INSTALLER_DIR/.contracts${NC}"
fi

if [ -f "$INSTALLER_DIR/.env" ]; then
    cp "$INSTALLER_DIR/.env" "$TARGET_DIR/installer/.env"
    chmod 600 "$TARGET_DIR/installer/.env"
    echo -e "${GREEN}Environment information copied to $TARGET_DIR/installer/.env${NC}"
else
    echo -e "${YELLOW}Environment file not found at $INSTALLER_DIR/.env${NC}"
fi

# Install node dependencies if needed
echo -e "${BLUE}Installing Node.js dependencies from package.json...${NC}"

# AI Node dependencies
if [ -f "$TARGET_AI_NODE/package.json" ]; then
    echo -e "${BLUE}Installing AI Node dependencies...${NC}"
    cd "$TARGET_AI_NODE" && npm install
    echo -e "${GREEN}AI Node dependencies installed.${NC}"
fi

# External Adapter dependencies
if [ -f "$TARGET_EXTERNAL_ADAPTER/package.json" ]; then
    echo -e "${BLUE}Installing External Adapter dependencies...${NC}"
    cd "$TARGET_EXTERNAL_ADAPTER" && npm install
    echo -e "${GREEN}External Adapter dependencies installed.${NC}"
fi

# Update @verdikta/common library to get latest ClassID data for both components
# NOTE: This must happen AFTER npm install to avoid being downgraded by package.json versions
echo -e "${BLUE}Updating @verdikta/common library to latest version for ClassID model pools...${NC}"
if [ -f "$UTIL_DIR/update-verdikta-common.js" ]; then
    # Load environment to get Verdikta Common version preference
    VERDIKTA_VERSION="latest"
    if [ -f "$TARGET_DIR/installer/.env" ]; then
        source "$TARGET_DIR/installer/.env"
        # Check if user has an old beta configuration and offer to update
        if [ "$VERDIKTA_COMMON_VERSION" = "beta" ]; then
            echo -e "${YELLOW}Your installation is configured to use @verdikta/common@beta.${NC}"
            echo -e "${BLUE}The recommended version is now 'latest' for better stability and ClassID support.${NC}"
            echo -e "${BLUE}Note: ClassID model pool integration requires @verdikta/common@latest (v1.3.0+).${NC}"
            if ask_yes_no "Would you like to switch to @verdikta/common@latest?" "y"; then
                VERDIKTA_VERSION="latest"
                # Update the .env file with the new preference
                sed -i.bak "s/VERDIKTA_COMMON_VERSION=\"beta\"/VERDIKTA_COMMON_VERSION=\"latest\"/" "$TARGET_DIR/installer/.env"
                echo -e "${GREEN}Updated configuration to use @verdikta/common@latest${NC}"
            else
                VERDIKTA_VERSION="beta"
                echo -e "${YELLOW}Keeping @verdikta/common@beta as requested${NC}"
                echo -e "${YELLOW}Warning: ClassID integration may not work with beta versions${NC}"
            fi
        else
            VERDIKTA_VERSION="${VERDIKTA_COMMON_VERSION:-latest}"
        fi
    fi
    
    # Update both AI Node and External Adapter (matching install.sh pattern)
    if node "$UTIL_DIR/update-verdikta-common.js" "$TARGET_AI_NODE" "$TARGET_EXTERNAL_ADAPTER" "$VERDIKTA_VERSION"; then
        echo -e "${GREEN}@verdikta/common library updated successfully in both components.${NC}"
    else
        echo -e "${YELLOW}Warning: Could not update @verdikta/common library. Continuing with existing version.${NC}"
    fi
else
    echo -e "${YELLOW}@verdikta/common update utility not found, skipping library update.${NC}"
fi

# Synchronize ClassID model pools with models.ts
echo -e "${BLUE}Synchronizing ClassID model pools with AI Node configuration...${NC}"
if [ -f "$TARGET_AI_NODE/src/scripts/classid-integration.js" ]; then
    cd "$TARGET_AI_NODE"
    
    # Display current ClassID information
    echo -e "${BLUE}Displaying latest ClassID model pool information...${NC}"
    if [ -f "src/scripts/display-classids.js" ]; then
        if node "src/scripts/display-classids.js"; then
            echo -e "${GREEN}ClassID information displayed successfully.${NC}"
        else
            echo -e "${YELLOW}Could not display ClassID information.${NC}"
        fi
    else
        echo -e "${YELLOW}ClassID display utility not found. Skipping detailed information.${NC}"
    fi
    
    echo -e "${BLUE}Checking for new models in ClassID pools...${NC}"
    echo -e "${BLUE}This will check ALL ClassIDs for new models from ANY provider:${NC}"
    echo -e "${BLUE}  • OpenAI models (GPT-4, GPT-5, GPT-6, etc.)${NC}"
    echo -e "${BLUE}  • Anthropic models (Claude-3, Claude-4, Claude-5, etc.)${NC}"
    echo -e "${BLUE}  • Ollama models (Llama, Mistral, Gemma, etc.)${NC}"
    echo -e "${BLUE}  • Any future providers and models${NC}"
    echo ""
    
    if ask_yes_no "Would you like to automatically integrate any new models from all ClassID pools into your AI Node configuration?" "y"; then
        echo -e "${BLUE}Running ClassID integration to sync models.ts with latest ClassID data...${NC}"
        echo -e "${BLUE}This will add new models from ALL ClassIDs (128, 129, 130, etc.) and ALL providers.${NC}"
        
        # Check if @verdikta/common supports classMap before running integration
        if node -e "const { classMap } = require('@verdikta/common'); console.log('ClassMap available:', typeof classMap?.listClasses === 'function');" 2>/dev/null | grep -q "true"; then
            # Run the ClassID integration script non-interactively (option 2 = all classes, n = skip Ollama pull)
            echo -e "2\nn" | node src/scripts/classid-integration.js
            
            if [ $? -eq 0 ]; then
                echo -e "${GREEN}ClassID model pools synchronized successfully!${NC}"
                echo -e "${GREEN}Your models.ts file has been updated with models from all ClassID pools.${NC}"
                echo -e "${GREEN}This includes OpenAI, Anthropic, Ollama, and any other provider models.${NC}"
                MODELS_UPDATED=true
                
                # VALIDATION: Verify DEV and TARGET have matching ClassID counts
                echo -e "${BLUE}Validating DEV and TARGET synchronization...${NC}"
                
                DEV_CLASS_COUNT=0
                TARGET_CLASS_COUNT=0
                DEV_CLASSIDS=""
                TARGET_CLASSIDS=""
                
                if [ -d "$REPO_AI_NODE" ]; then
                    DEV_CLASS_COUNT=$(cd "$REPO_AI_NODE" && node -e "const { classMap } = require('@verdikta/common'); console.log(classMap.listClasses().length);" 2>/dev/null || echo "0")
                    DEV_CLASSIDS=$(cd "$REPO_AI_NODE" && node -e "const { classMap } = require('@verdikta/common'); console.log(classMap.listClasses().map(c => c.id).join(', '));" 2>/dev/null || echo "unknown")
                fi
                
                TARGET_CLASS_COUNT=$(node -e "const { classMap } = require('@verdikta/common'); console.log(classMap.listClasses().length);" 2>/dev/null || echo "0")
                TARGET_CLASSIDS=$(node -e "const { classMap } = require('@verdikta/common'); console.log(classMap.listClasses().map(c => c.id).join(', '));" 2>/dev/null || echo "unknown")
                
                echo -e "${BLUE}DEV ClassIDs: ${DEV_CLASSIDS} (${DEV_CLASS_COUNT} total)${NC}"
                echo -e "${BLUE}TARGET ClassIDs: ${TARGET_CLASSIDS} (${TARGET_CLASS_COUNT} total)${NC}"
                
                if [ "$DEV_CLASS_COUNT" != "$TARGET_CLASS_COUNT" ] || [ "$DEV_CLASSIDS" != "$TARGET_CLASSIDS" ]; then
                    echo -e "${YELLOW}⚠️  ClassID mismatch detected between DEV and TARGET!${NC}"
                    echo -e "${YELLOW}   DEV: ${DEV_CLASS_COUNT} classes (${DEV_CLASSIDS})${NC}"
                    echo -e "${YELLOW}   TARGET: ${TARGET_CLASS_COUNT} classes (${TARGET_CLASSIDS})${NC}"
                    echo -e "${BLUE}Syncing TARGET models.ts → DEV to ensure consistency...${NC}"
                    
                    # Copy TARGET models.ts to DEV to ensure they match
                    if [ -f "$TARGET_AI_NODE/src/config/models.ts" ] && [ -d "$REPO_AI_NODE/src/config" ]; then
                        cp "$TARGET_AI_NODE/src/config/models.ts" "$REPO_AI_NODE/src/config/models.ts"
                        echo -e "${GREEN}✓ DEV models.ts synchronized from TARGET${NC}"
                        echo -e "${GREEN}✓ Both folders now have matching model configurations${NC}"
                    else
                        echo -e "${RED}✗ Could not sync models.ts files${NC}"
                    fi
                else
                    echo -e "${GREEN}✓ DEV and TARGET ClassIDs match perfectly (${DEV_CLASS_COUNT} classes)${NC}"
                fi
            else
                echo -e "${YELLOW}ClassID integration completed with warnings. Please check the output above.${NC}"
                MODELS_UPDATED=false
            fi
        else
            echo -e "${RED}ClassID integration not available: @verdikta/common version does not support classMap${NC}"
            echo -e "${YELLOW}Please ensure @verdikta/common@latest (v1.3.0+) is installed for ClassID support.${NC}"
            echo -e "${YELLOW}You can update manually with: cd $TARGET_AI_NODE && npm install @verdikta/common@latest${NC}"
            MODELS_UPDATED=false
        fi
    else
        echo -e "${BLUE}Skipping automatic ClassID model pool integration.${NC}"
        echo -e "${YELLOW}You can run this manually later with: cd $TARGET_AI_NODE && npm run integrate-classid${NC}"
        MODELS_UPDATED=false
    fi
else
    echo -e "${YELLOW}ClassID integration script not found, skipping model pool synchronization.${NC}"
fi

# Check and update Ollama version before checking models
echo -e "${BLUE}Checking Ollama version before model management...${NC}"
if [ -f "$UTIL_DIR/ollama-manager.sh" ]; then
    source "$UTIL_DIR/ollama-manager.sh"
    check_and_update_ollama "upgrade-arbiter" "false"
    
    # Start Ollama service if it was updated
    start_ollama_service
else
    echo -e "${YELLOW}Ollama manager utility not found. Proceeding with basic model check.${NC}"
fi

# Check for missing Ollama models (only needed for local downloads)
if [ "$MODELS_UPDATED" = true ]; then
    echo -e "${BLUE}Checking for missing Ollama models that need local download...${NC}"
    echo -e "${BLUE}Note: OpenAI and Anthropic models are accessed via API (no download needed).${NC}"
    echo -e "${BLUE}Only Ollama models need to be downloaded locally for offline use.${NC}"
    echo ""
else
    echo -e "${BLUE}Checking for missing Ollama models...${NC}"
fi

check_ollama_models() {
    # Check if Ollama is available
    if ! command_exists ollama; then
        echo -e "${YELLOW}Ollama not found. Skipping Ollama model check.${NC}"
        echo -e "${BLUE}If you plan to use Ollama models, please install Ollama first.${NC}"
        return 0
    fi
    
    # Get list of currently installed Ollama models
    local installed_models=$(ollama list 2>/dev/null | tail -n +2 | awk '{print $1}' | grep -v '^$' || true)
    
    # Dynamically get Ollama models from ClassID data
    local recommended_models=""
    echo -e "${BLUE}Extracting Ollama models from ClassID pools...${NC}"
    
    # Use Node.js to extract Ollama models from @verdikta/common
    if [ -f "$TARGET_AI_NODE/package.json" ]; then
        cd "$TARGET_AI_NODE"
        recommended_models=$(node -e "
            try {
                const { classMap } = require('@verdikta/common');
                const allClasses = classMap.listClasses();
                const ollamaModels = new Set();
                
                allClasses.forEach(classItem => {
                    const cls = classMap.getClass(classItem.id);
                    if (cls && cls.status === 'ACTIVE' && cls.models) {
                        cls.models.forEach(model => {
                            if (model.provider === 'ollama') {
                                ollamaModels.add(model.model);
                            }
                        });
                    }
                });
                
                console.log(Array.from(ollamaModels).join(' '));
            } catch (error) {
                // Fallback to hardcoded list if @verdikta/common is not available
                console.log('llama3.1:8b llava:7b deepseek-r1:8b qwen3:8b gemma3n:e4b');
            }
        " 2>/dev/null || echo "llama3.1:8b llava:7b deepseek-r1:8b qwen3:8b gemma3n:e4b")
    else
        # Fallback if AI Node not available
        recommended_models="llama3.1:8b llava:7b deepseek-r1:8b qwen3:8b gemma3n:e4b"
    fi
    
    local missing_models=""
    echo -e "${BLUE}Checking for recommended Ollama models from ClassID pools...${NC}"
    echo -e "${BLUE}Models to check: $recommended_models${NC}"
    
    for model in $recommended_models; do
        if ! echo "$installed_models" | grep -q "^${model}"; then
            if [ -z "$missing_models" ]; then
                missing_models="$model"
            else
                missing_models="$missing_models $model"
            fi
        fi
    done
    
    if [ -n "$missing_models" ]; then
        echo -e "${YELLOW}Missing Ollama models found: $missing_models${NC}"
        echo -e "${BLUE}These models are from your ClassID pools and need to be downloaded locally.${NC}"
        echo -e "${BLUE}(OpenAI and Anthropic models from your ClassID pools are already available via API)${NC}"
        echo
        
        if ask_yes_no "Would you like to download the missing Ollama models now? (This may take several minutes)" "n"; then
            for model in $missing_models; do
                echo -e "${BLUE}Downloading $model...${NC}"
                if ollama pull "$model"; then
                    echo -e "${GREEN}✓ Successfully downloaded $model${NC}"
                else
                    echo -e "${RED}✗ Failed to download $model${NC}"
                fi
            done
            echo -e "${GREEN}Ollama model download process completed.${NC}"
        else
            echo -e "${BLUE}Skipping Ollama model downloads.${NC}"
            echo -e "${YELLOW}You can download models manually later using:${NC}"
            for model in $missing_models; do
                echo -e "${YELLOW}  ollama pull $model${NC}"
            done
        fi
    else
        echo -e "${GREEN}All recommended Ollama models are already installed.${NC}"
    fi
}

# Call the Ollama model check function
check_ollama_models

# Check current arbiter configuration
echo -e "${BLUE}Checking current arbiter configuration...${NC}"
if [ -f "$TARGET_DIR/installer/.contracts" ]; then
    source "$TARGET_DIR/installer/.contracts"
    if [ -n "$ARBITER_COUNT" ]; then
        echo -e "${GREEN}Current configuration: $ARBITER_COUNT arbiter(s)${NC}"
        
        # Show job IDs if they exist
        JOB_COUNT=0
        for ((i=1; i<=10; i++)); do
            eval job_var="JOB_ID_$i"
            if [ -n "${!job_var}" ]; then
                JOB_COUNT=$((JOB_COUNT + 1))
            fi
        done
        
        if [ $JOB_COUNT -gt 0 ]; then
            echo -e "${GREEN}Found $JOB_COUNT existing job(s) in configuration${NC}"
        fi
    else
        echo -e "${YELLOW}No multi-arbiter configuration found (legacy single-arbiter setup)${NC}"
    fi
else
    echo -e "${YELLOW}No contracts configuration file found${NC}"
fi



# Optional job/key reconfiguration (skip if jobs were already regenerated)
if [ "$JOBS_ALREADY_REGENERATED" -eq 1 ]; then
    echo -e "${GREEN}Job specifications were already regenerated from updated template during this upgrade.${NC}"
    echo -e "${BLUE}Skipping optional job reconfiguration.${NC}"
else
    echo -e "${BLUE}Job and Key Configuration Options:${NC}"
    echo "During upgrades, your existing jobs and keys are preserved by default."
    echo "However, you can optionally reconfigure them if needed (e.g., to add more arbiters)."
    echo
    if ask_yes_no "Would you like to reconfigure your Chainlink jobs and keys? (This will recreate all jobs)" "n"; then
    echo -e "${BLUE}Starting job and key reconfiguration...${NC}"
    
    # Check if configure-node.sh exists in the source
    if [ -f "$SCRIPT_DIR/configure-node.sh" ]; then
        echo -e "${YELLOW}WARNING: This will recreate all your Chainlink jobs and may create additional keys.${NC}"
        echo -e "${YELLOW}Your existing jobs will remain in the Chainlink node but may become orphaned.${NC}"
        echo -e "${YELLOW}You should manually delete old jobs from the Chainlink UI after reconfiguration.${NC}"
        echo
        
        if ask_yes_no "Are you sure you want to proceed with job reconfiguration?" "y"; then
            # Start Chainlink node temporarily for job reconfiguration
            echo -e "${BLUE}Starting Chainlink node temporarily for job reconfiguration...${NC}"
            echo -e "${YELLOW}Note: The Chainlink node needs to be running for job and key management.${NC}"
            
            # Check if Chainlink node is running
            if ! docker ps | grep -q "chainlink"; then
                echo -e "${BLUE}Starting Chainlink node...${NC}"
                cd "$TARGET_DIR"
                if [ -f "$TARGET_DIR/start-arbiter.sh" ]; then
                    # Start just the Chainlink node (not the full arbiter)
                    if docker ps -a | grep -q "chainlink"; then
                        docker start chainlink
                    else
                        echo -e "${YELLOW}Warning: Chainlink container not found. Starting full arbiter...${NC}"
                        bash "$TARGET_DIR/start-arbiter.sh"
                    fi
                    
                    # Wait for Chainlink node to be ready
                    echo -e "${BLUE}Waiting for Chainlink node to be ready...${NC}"
                    for i in {1..30}; do
                        if curl -s http://localhost:6688/health > /dev/null; then
                            echo -e "${GREEN}Chainlink node is ready!${NC}"
                            break
                        fi
                        if [ $i -eq 30 ]; then
                            echo -e "${RED}Error: Chainlink node failed to start within 60 seconds${NC}"
                            echo -e "${YELLOW}Job reconfiguration cancelled. You can try again later.${NC}"
                            return 1
                        fi
                        sleep 2
                    done
                else
                    echo -e "${RED}Error: start-arbiter.sh not found at $TARGET_DIR${NC}"
                    echo -e "${YELLOW}Job reconfiguration cancelled.${NC}"
                    return 1
                fi
            else
                echo -e "${GREEN}Chainlink node is already running.${NC}"
            fi
            
            # Run the multi-arbiter configuration
            cd "$SCRIPT_DIR"
            bash "$SCRIPT_DIR/configure-node.sh"
            
            if [ $? -eq 0 ]; then
                echo -e "${GREEN}Job and key reconfiguration completed successfully!${NC}"
                
                # Update the target installation with the new contracts file
                if [ -f "$INSTALLER_DIR/.contracts" ]; then
                    cp "$INSTALLER_DIR/.contracts" "$TARGET_DIR/installer/.contracts"
                    echo -e "${GREEN}Updated contracts configuration copied to target installation${NC}"
                fi
                
                # Stop the Chainlink node again since it was started temporarily for reconfiguration
                echo -e "${BLUE}Stopping Chainlink node after job reconfiguration...${NC}"
                cd "$TARGET_DIR"
                if [ -f "$TARGET_DIR/stop-arbiter.sh" ]; then
                    bash "$TARGET_DIR/stop-arbiter.sh"
                    echo -e "${GREEN}Chainlink node stopped. Upgrade will continue.${NC}"
                else
                    echo -e "${YELLOW}Warning: stop-arbiter.sh not found. You may need to manually stop services.${NC}"
                fi
                
                # Authorize the newly configured keys
                echo -e "\n${BLUE}Authorizing reconfigured keys on operator contract...${NC}"
                if [ -f "$INSTALLER_DIR/.contracts" ]; then
                    source "$INSTALLER_DIR/.contracts"
                    
                    # Build the list of all key addresses
                    ALL_KEYS=""
                    for i in $(seq 1 $KEY_COUNT); do
                        KEY_VAR="KEY_${i}_ADDRESS"
                        KEY_ADDR="${!KEY_VAR}"
                        if [ -n "$KEY_ADDR" ]; then
                            if [ -z "$ALL_KEYS" ]; then
                                ALL_KEYS="$KEY_ADDR"
                            else
                                ALL_KEYS="$ALL_KEYS,$KEY_ADDR"
                            fi
                        fi
                    done
                    
                    if [ -n "$ALL_KEYS" ] && [ -n "$OPERATOR_ADDR" ]; then
                        echo -e "${BLUE}Authorizing keys: $ALL_KEYS${NC}"
                        echo -e "${BLUE}On operator contract: $OPERATOR_ADDR${NC}"
                        
                        # Check if setAuthorizedSenders script exists
                        OPERATOR_SCRIPT_DIR="$REPO_ROOT/arbiter-operator"
                        if [ -f "$OPERATOR_SCRIPT_DIR/scripts/setAuthorizedSenders.js" ]; then
                            cd "$OPERATOR_SCRIPT_DIR"
                            if env NODES="$ALL_KEYS" OPERATOR="$OPERATOR_ADDR" npx hardhat run scripts/setAuthorizedSenders.js --network $DEPLOYMENT_NETWORK; then
                                echo -e "${GREEN}✓ All keys successfully authorized on operator contract${NC}"
                            else
                                echo -e "${YELLOW}⚠ Failed to authorize keys automatically after reconfiguration${NC}"
                            fi
                        fi
                    fi
                fi
            else
                echo -e "${RED}Job and key reconfiguration failed!${NC}"
                echo -e "${YELLOW}Your existing configuration has been preserved.${NC}"
                
                # Stop the Chainlink node after failed reconfiguration
                echo -e "${BLUE}Stopping Chainlink node after failed job reconfiguration...${NC}"
                cd "$TARGET_DIR"
                if [ -f "$TARGET_DIR/stop-arbiter.sh" ]; then
                    bash "$TARGET_DIR/stop-arbiter.sh"
                    echo -e "${GREEN}Chainlink node stopped.${NC}"
                else
                    echo -e "${YELLOW}Warning: stop-arbiter.sh not found. You may need to manually stop services.${NC}"
                fi
            fi
        else
            echo -e "${BLUE}Job reconfiguration cancelled. Existing configuration preserved.${NC}"
        fi
    else
        echo -e "${RED}Error: configure-node.sh not found. Job reconfiguration not available.${NC}"
    fi
else
    echo -e "${BLUE}Keeping existing job and key configuration.${NC}"
fi
fi

# Check and optionally regenerate Chainlink configuration
echo -e "${BLUE}Checking Chainlink configuration...${NC}"

# Function to check and regenerate Chainlink config if needed
check_chainlink_config() {
    local chainlink_dir="$HOME/.chainlink-${NETWORK_TYPE}"
    local current_config="$chainlink_dir/config.toml"
    local template_file="$REPO_CHAINLINK_NODE/config_template.toml"
    
    echo -e "${BLUE}Checking Chainlink configuration...${NC}"
    
    # Check if current config exists
    if [ ! -f "$current_config" ]; then
        echo -e "${YELLOW}No existing Chainlink config found. Skipping config check.${NC}"
        return 0
    fi
    
    # Check if template exists
    if [ ! -f "$template_file" ]; then
        echo -e "${YELLOW}No config template found. Skipping config regeneration.${NC}"
        return 0
    fi
    
    # Try to load Infura API key from installation
    local infura_key=""
    if [ -f "$TARGET_DIR/installer/.api_keys" ]; then
        source "$TARGET_DIR/installer/.api_keys"
        infura_key="$INFURA_API_KEY"
    elif [ -f "$INSTALLER_DIR/.api_keys" ]; then
        source "$INSTALLER_DIR/.api_keys"
        infura_key="$INFURA_API_KEY"
    fi
    
    if [ -z "$infura_key" ]; then
        echo -e "${YELLOW}Could not find Infura API key. Skipping config regeneration.${NC}"
        return 0
    fi
    
    # Load network configuration to populate template placeholders
    local chain_id=""
    local network_name=""
    local tip_cap_default=""
    local fee_cap_default=""
    local ws_url=""
    local http_url=""
    
    # Load environment variables from target installation
    if [ -f "$TARGET_DIR/installer/.env" ]; then
        source "$TARGET_DIR/installer/.env"
        chain_id="$NETWORK_CHAIN_ID"
        network_name="$NETWORK_NAME"
        
        # Set default gas values based on network type
        if [ "$NETWORK_TYPE" = "testnet" ]; then
            tip_cap_default="2 gwei"
            fee_cap_default="30 gwei"
            ws_url="wss://base-sepolia.infura.io/ws/v3/$infura_key"
            http_url="https://base-sepolia.infura.io/v3/$infura_key"
        else
            tip_cap_default="1 gwei"
            fee_cap_default="20 gwei"
            ws_url="wss://base-mainnet.infura.io/ws/v3/$infura_key"
            http_url="https://base-mainnet.infura.io/v3/$infura_key"
        fi
    fi
    
    # Generate what the new config would look like with ALL placeholders populated
    local temp_config=$(mktemp)
    sed -e "s/<KEY>/$infura_key/g" \
        -e "s/<CHAIN_ID>/$chain_id/g" \
        -e "s/<NETWORK_NAME>/$network_name/g" \
        -e "s/<TIP_CAP_DEFAULT>/$tip_cap_default/g" \
        -e "s/<FEE_CAP_DEFAULT>/$fee_cap_default/g" \
        -e "s|<WS_URL>|$ws_url|g" \
        -e "s|<HTTP_URL>|$http_url|g" \
        "$template_file" > "$temp_config"
    
    # Create filtered versions for comparison (excluding dynamic/environment-specific lines)
    local current_filtered=$(mktemp)
    local temp_filtered=$(mktemp)
    
    # Filter out lines that are environment-specific and should not be compared
    # These include URLs (which contain API keys) and other dynamic values
    grep -v "WSURL=" "$current_config" | \
    grep -v "HTTPURL=" | \
    grep -v "ChainID=" | \
    grep -v "Name=" > "$current_filtered"
    
    grep -v "WSURL=" "$temp_config" | \
    grep -v "HTTPURL=" | \
    grep -v "ChainID=" | \
    grep -v "Name=" > "$temp_filtered"
    
    # Compare filtered configs (excluding environment-specific lines)
    if ! diff -q "$current_filtered" "$temp_filtered" > /dev/null 2>&1; then
        echo -e "${YELLOW}Your current Chainlink configuration has differences from the updated template.${NC}"
        echo -e "${YELLOW}This may include new optimization settings, timeout values, or configuration improvements.${NC}"
        echo -e "${BLUE}(Environment-specific values like ChainID, URLs, and network names are excluded from this comparison)${NC}"
        
        # Show the actual differences (excluding environment-specific values)
        echo -e "${BLUE}Configuration differences found:${NC}"
        diff "$current_filtered" "$temp_filtered" || true
        echo
        
        if ask_yes_no "Would you like to regenerate the config file from the template? (Your current config will be backed up)" "n"; then
            # Create backup of current config
            local config_backup="${current_config}.backup.$(date +%Y%m%d-%H%M%S)"
            cp "$current_config" "$config_backup"
            echo -e "${BLUE}Current config backed up to: $config_backup${NC}"
            
            # Replace with new config
            cp "$temp_config" "$current_config"
            echo -e "${GREEN}Chainlink configuration regenerated from template.${NC}"
            echo -e "${YELLOW}Note: You may need to restart the Chainlink node for changes to take effect.${NC}"
        else
            echo -e "${BLUE}Keeping existing Chainlink configuration.${NC}"
        fi
    else
        echo -e "${GREEN}Chainlink configuration is up to date with template.${NC}"
    fi
    
    # Clean up temp files
    rm -f "$temp_config" "$current_filtered" "$temp_filtered"
}

# Call the config check function
check_chainlink_config

# Optional: Fund or top-off Chainlink keys
echo
echo -e "${BLUE}============================================================${NC}"
echo -e "${BLUE}  Optional: Chainlink Key Funding${NC}"
echo -e "${BLUE}============================================================${NC}"
echo
echo -e "${BLUE}After an upgrade, you may want to check or top off your Chainlink key balances.${NC}"
echo -e "${BLUE}Your keys need native ETH to pay for gas fees during oracle operations.${NC}"
echo

# Load environment variables to determine network type
if [ -f "$TARGET_DIR/installer/.env" ]; then
    source "$TARGET_DIR/installer/.env"
fi

# Determine recommended amount based on network
if [ "$NETWORK_TYPE" = "testnet" ]; then
    RECOMMENDED_AMOUNT="0.005"
    CURRENCY_NAME="Base Sepolia ETH"
    FUNDING_INFO="This is free testnet currency from faucets."
else
    RECOMMENDED_AMOUNT="0.002"
    CURRENCY_NAME="Base ETH"
    FUNDING_INFO="This will use real ETH from your wallet."
fi

echo -e "${BLUE}Recommended funding per key: $RECOMMENDED_AMOUNT $CURRENCY_NAME${NC}"
echo -e "${YELLOW}Note: $FUNDING_INFO${NC}"
echo

if ask_yes_no "Would you like to fund or top off your Chainlink keys now?" "n"; then
    echo
    echo -e "${BLUE}Automatic Funding Configuration${NC}"
    echo -e "${BLUE}Recommended amount: $RECOMMENDED_AMOUNT $CURRENCY_NAME per key${NC}"
    echo -e "${BLUE}This amount provides approximately 50 arbitration queries worth of gas.${NC}"
    echo
    
    # Ask if user wants to use recommended amount or custom amount
    echo -e "${BLUE}Funding options:${NC}"
    echo -e "${BLUE}  1) Use recommended amount ($RECOMMENDED_AMOUNT $CURRENCY_NAME per key)${NC}"
    echo -e "${BLUE}  2) Specify custom amount${NC}"
    echo -e "${BLUE}  3) Skip automatic funding${NC}"
    echo
    
    while true; do
        read -p "Choose option (1-3) [1]: " funding_choice
        
        # Default to option 1 if empty
        if [ -z "$funding_choice" ]; then
            funding_choice=1
        fi
        
        case "$funding_choice" in
            1)
                FUNDING_AMOUNT="$RECOMMENDED_AMOUNT"
                echo -e "${GREEN}Using recommended amount: $FUNDING_AMOUNT $CURRENCY_NAME per key${NC}"
                break
                ;;
            2)
                while true; do
                    read -p "Enter custom amount per key (in $CURRENCY_NAME): " custom_amount
                    
                    if [[ "$custom_amount" =~ ^[0-9]+\.?[0-9]*$ ]] && (( $(echo "$custom_amount > 0" | bc -l) )); then
                        FUNDING_AMOUNT="$custom_amount"
                        echo -e "${GREEN}Using custom amount: $FUNDING_AMOUNT $CURRENCY_NAME per key${NC}"
                        break 2
                    else
                        echo -e "${RED}Please enter a valid positive number${NC}"
                    fi
                done
                ;;
            3)
                echo -e "${BLUE}Skipping automatic funding.${NC}"
                FUNDING_AMOUNT=""
                break
                ;;
            *)
                echo -e "${RED}Invalid choice. Please enter 1, 2, or 3.${NC}"
                ;;
        esac
    done
    
    if [ -n "$FUNDING_AMOUNT" ]; then
        echo
        echo -e "${YELLOW}⚠ IMPORTANT: This will transfer $CURRENCY_NAME from your deployment wallet.${NC}"
        echo -e "${YELLOW}⚠ Your wallet will be charged for both the funding amount and gas fees.${NC}"
        echo
        
        if ask_yes_no "Proceed with automatic funding?" "n"; then
            echo -e "${BLUE}Starting automatic funding process...${NC}"
            echo
            
            # Check if funding script exists in source or target
            FUNDING_SCRIPT=""
            if [ -f "$SCRIPT_DIR/fund-chainlink-keys.sh" ]; then
                FUNDING_SCRIPT="$SCRIPT_DIR/fund-chainlink-keys.sh"
            elif [ -f "$TARGET_DIR/fund-chainlink-keys.sh" ]; then
                FUNDING_SCRIPT="$TARGET_DIR/fund-chainlink-keys.sh"
            fi
            
            if [ -n "$FUNDING_SCRIPT" ]; then
                # Run the funding script
                if bash "$FUNDING_SCRIPT" --amount "$FUNDING_AMOUNT" --force; then
                    echo
                    echo -e "${GREEN}✓ Automatic funding completed successfully!${NC}"
                    echo -e "${GREEN}✓ Your Chainlink keys have been funded/topped off and are ready for operation.${NC}"
                    KEYS_FUNDED=true
                else
                    echo
                    echo -e "${YELLOW}⚠ Automatic funding encountered issues.${NC}"
                    echo -e "${BLUE}You can retry funding later using:${NC}"
                    echo -e "${GREEN}  $TARGET_DIR/fund-chainlink-keys.sh${NC}"
                    KEYS_FUNDED=false
                fi
            else
                echo -e "${RED}Error: Funding script not found.${NC}"
                echo -e "${YELLOW}Please run funding manually after upgrade.${NC}"
                KEYS_FUNDED=false
            fi
        else
            echo -e "${BLUE}Automatic funding cancelled.${NC}"
            KEYS_FUNDED=false
        fi
    else
        KEYS_FUNDED=false
    fi
else
    echo -e "${BLUE}Skipping key funding.${NC}"
    KEYS_FUNDED=false
fi

if [ "$KEYS_FUNDED" = "false" ]; then
    echo
    echo -e "${YELLOW}💡 Reminder: Check your key balances regularly${NC}"
    echo -e "${BLUE}You can fund your keys anytime using:${NC}"
    echo -e "${GREEN}  $TARGET_DIR/fund-chainlink-keys.sh${NC}"
    echo
    echo -e "${BLUE}Or check key addresses in:${NC}"
    echo -e "${GREEN}  $TARGET_DIR/installer/.contracts${NC}"
    echo
fi

echo -e "${GREEN}Upgrade completed successfully!${NC}"

# Clear the upgrade in progress flag
UPGRADE_IN_PROGRESS=0

# Ask if user wants to restart the arbiter
if [ $ARBITER_WAS_RUNNING -eq 1 ]; then
    if ask_yes_no "Do you want to restart the arbiter now?" "y"; then
        echo -e "${BLUE}Restarting arbiter...${NC}"
        "$TARGET_DIR/start-arbiter.sh"
        
        # Verify restart
        echo -e "${BLUE}Waiting for services to fully start...${NC}"
        # Increase delay to give AI Node more time to start
        sleep 20  # Increased from 10 to 20 seconds
        RESTART_SUCCESS=1
        
        if [ $NODE_RUNNING -eq 1 ] && ! check_port 3000; then
            echo -e "${RED}Warning: AI Node failed to restart.${NC}"
            echo -e "${YELLOW}AI Node may still be starting up. Please check status again after a few minutes.${NC}"
            RESTART_SUCCESS=0
        fi
        
        if [ $ADAPTER_RUNNING -eq 1 ] && ! check_port 8080; then
            echo -e "${RED}Warning: External Adapter failed to restart.${NC}"
            RESTART_SUCCESS=0
        fi
        
        if [ $CHAINLINK_RUNNING -eq 1 ] && ! check_port 6688; then
            echo -e "${RED}Warning: Chainlink Node failed to restart.${NC}"
            RESTART_SUCCESS=0
        fi
        
        if [ $RESTART_SUCCESS -eq 1 ]; then
            echo -e "${GREEN}Arbiter restarted successfully.${NC}"
        else
            echo -e "${YELLOW}Some arbiter components did not restart properly.${NC}"
            echo -e "${YELLOW}The AI Node may still be starting up and could take a few minutes to fully initialize.${NC}"
            echo -e "${YELLOW}Run the status script after a few minutes to verify: $TARGET_DIR/arbiter-status.sh${NC}"
        fi
    else
        echo -e "${YELLOW}Please restart the arbiter manually when ready:${NC}"
        echo -e "${YELLOW}  - $TARGET_DIR/start-arbiter.sh${NC}"
    fi
else
    # Arbiter was not running before upgrade - ask if user wants to start it now
    if ask_yes_no "The arbiter was not running before the upgrade. Would you like to start it now?" "y"; then
        echo -e "${BLUE}Starting arbiter...${NC}"
        "$TARGET_DIR/start-arbiter.sh"
        
        # Verify startup
        echo -e "${BLUE}Waiting for services to fully start...${NC}"
        sleep 20  # Give services time to start
        
        # Check if services started successfully
        STARTUP_SUCCESS=1
        
        if ! check_port 3000; then
            echo -e "${RED}Warning: AI Node failed to start.${NC}"
            echo -e "${YELLOW}AI Node may still be starting up. Please check status again after a few minutes.${NC}"
            STARTUP_SUCCESS=0
        fi
        
        if ! check_port 8080; then
            echo -e "${RED}Warning: External Adapter failed to start.${NC}"
            STARTUP_SUCCESS=0
        fi
        
        if ! check_port 6688; then
            echo -e "${RED}Warning: Chainlink Node failed to start.${NC}"
            STARTUP_SUCCESS=0
        fi
        
        if [ $STARTUP_SUCCESS -eq 1 ]; then
            echo -e "${GREEN}Arbiter started successfully.${NC}"
        else
            echo -e "${YELLOW}Some arbiter components did not start properly.${NC}"
            echo -e "${YELLOW}The AI Node may still be starting up and could take a few minutes to fully initialize.${NC}"
            echo -e "${YELLOW}Run the status script after a few minutes to verify: $TARGET_DIR/arbiter-status.sh${NC}"
        fi
    else
        echo -e "${BLUE}You can start the arbiter later using: $TARGET_DIR/start-arbiter.sh${NC}"
    fi
fi

# Show final configuration summary
echo -e "${BLUE}Final Configuration Summary:${NC}"
if [ -f "$TARGET_DIR/installer/.contracts" ]; then
    source "$TARGET_DIR/installer/.contracts"
    if [ -n "$ARBITER_COUNT" ]; then
        echo -e "${GREEN}✓ Multi-Arbiter Configuration: $ARBITER_COUNT arbiter(s)${NC}"
        
        # Count actual jobs configured
        CONFIGURED_JOBS=0
        for ((i=1; i<=10; i++)); do
            eval job_var="JOB_ID_$i"
            if [ -n "${!job_var}" ]; then
                CONFIGURED_JOBS=$((CONFIGURED_JOBS + 1))
            fi
        done
        
        if [ $CONFIGURED_JOBS -gt 0 ]; then
            echo -e "${GREEN}✓ Chainlink Jobs: $CONFIGURED_JOBS job(s) configured${NC}"
        fi
        
        # Show key information if available
        if [ -n "$KEY_COUNT" ]; then
            echo -e "${GREEN}✓ Ethereum Keys: $KEY_COUNT key(s) configured${NC}"
        fi
    else
        echo -e "${YELLOW}⚠ Legacy single-arbiter configuration detected${NC}"
        echo -e "${YELLOW}  Consider reconfiguring for multi-arbiter support${NC}"
    fi
else
    echo -e "${RED}⚠ No configuration file found${NC}"
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