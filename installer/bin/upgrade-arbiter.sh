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

# Function to check if a process is running on a port
check_port() {
    if lsof -i:$1 >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
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

# Check which components are running
echo -e "${BLUE}Checking arbiter status...${NC}"
NODE_RUNNING=0
ADAPTER_RUNNING=0
CHAINLINK_RUNNING=0
ARBITER_RUNNING=0

if check_port 3000; then
    NODE_RUNNING=1
    ARBITER_RUNNING=1
    echo -e "${BLUE}AI Node is running.${NC}"
else
    echo -e "${BLUE}AI Node is not running.${NC}"
fi

if check_port 8080; then
    ADAPTER_RUNNING=1
    ARBITER_RUNNING=1
    echo -e "${BLUE}External Adapter is running.${NC}"
else
    echo -e "${BLUE}External Adapter is not running.${NC}"
fi

if check_port 6688; then
    CHAINLINK_RUNNING=1
    ARBITER_RUNNING=1
    echo -e "${BLUE}Chainlink Node is running.${NC}"
else
    echo -e "${BLUE}Chainlink Node is not running.${NC}"
fi

# Track if arbiter was running
ARBITER_WAS_RUNNING=$ARBITER_RUNNING

# Ask for confirmation before upgrading
echo
echo -e "${YELLOW}The following components will be upgraded:${NC}"
echo -e "- AI Node"
echo -e "- External Adapter"
echo -e "- Chainlink Node configuration files"
echo -e "- Management Scripts"
echo

if ! ask_yes_no "Do you want to proceed with the upgrade?"; then
    echo -e "${YELLOW}Upgrade cancelled by user.${NC}"
    exit 0
fi

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
create_backup "$TARGET_DIR"
if [ $? -ne 0 ]; then
    exit 1
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
        
        if ask_yes_no "Would you like to regenerate the job specifications from the updated template? (This will require re-registration if you use an aggregator)"; then
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

# Perform the upgrades
echo -e "${BLUE}Starting upgrade process...${NC}"

# Upgrade AI Node
echo -e "${BLUE}Upgrading AI Node...${NC}"
upgrade_component "$REPO_AI_NODE" "$TARGET_AI_NODE" "AI Node" ".env.local .env logs node_modules *.pid"

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
echo -e "${BLUE}Checking for new Node.js dependencies...${NC}"

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
    if ask_yes_no "Would you like to reconfigure your Chainlink jobs and keys? (This will recreate all jobs)"; then
    echo -e "${BLUE}Starting job and key reconfiguration...${NC}"
    
    # Check if configure-node.sh exists in the source
    if [ -f "$SCRIPT_DIR/configure-node.sh" ]; then
        echo -e "${YELLOW}WARNING: This will recreate all your Chainlink jobs and may create additional keys.${NC}"
        echo -e "${YELLOW}Your existing jobs will remain in the Chainlink node but may become orphaned.${NC}"
        echo -e "${YELLOW}You should manually delete old jobs from the Chainlink UI after reconfiguration.${NC}"
        echo
        
        if ask_yes_no "Are you sure you want to proceed with job reconfiguration?"; then
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
    
    # Generate what the new config would look like
    local temp_config=$(mktemp)
    sed "s/<KEY>/$infura_key/g" "$template_file" > "$temp_config"
    
    # Create filtered versions for comparison (excluding WSURL and HTTPURL lines)
    local current_filtered=$(mktemp)
    local temp_filtered=$(mktemp)
    
    # Filter out WSURL and HTTPURL lines from both files for comparison
    grep -v "WSURL=" "$current_config" | grep -v "HTTPURL=" > "$current_filtered"
    grep -v "WSURL=" "$temp_config" | grep -v "HTTPURL=" > "$temp_filtered"
    
    # Compare filtered configs (excluding WSURL/HTTPURL lines which always differ)
    if ! diff -q "$current_filtered" "$temp_filtered" > /dev/null 2>&1; then
        echo -e "${YELLOW}Your current Chainlink configuration differs from the updated template.${NC}"
        echo -e "${YELLOW}This may include new optimization settings or configuration improvements.${NC}"
        
        # Show the actual differences (excluding WSURL/HTTPURL)
        echo -e "${BLUE}Differences found:${NC}"
        diff "$current_filtered" "$temp_filtered" || true
        echo
        
        if ask_yes_no "Would you like to regenerate the config file from the template? (Your current config will be backed up)"; then
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

echo -e "${GREEN}Upgrade completed successfully!${NC}"

# Clear the upgrade in progress flag
UPGRADE_IN_PROGRESS=0

# Ask if user wants to restart the arbiter
if [ $ARBITER_WAS_RUNNING -eq 1 ]; then
    if ask_yes_no "Do you want to restart the arbiter now?"; then
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
    if ask_yes_no "The arbiter was not running before the upgrade. Would you like to start it now?"; then
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