#!/bin/bash

# Verdikta Arbiter Ollama Management Utility
# Shared functions for checking and updating Ollama across install and upgrade scripts

# Color definitions (if not already defined)
if [ -z "$GREEN" ]; then
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    RED='\033[0;31m'
    BLUE='\033[0;34m'
    NC='\033[0m' # No Color
fi

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to prompt for Yes/No question (if not already defined)
if ! declare -f ask_yes_no >/dev/null 2>&1; then
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
fi

# Function to check and update Ollama version
check_and_update_ollama() {
    local script_name="${1:-script}"
    local skip_if_current="${2:-false}"
    
    echo -e "${BLUE}Checking Ollama installation and version...${NC}"
    
    if command_exists ollama; then
        CURRENT_VERSION=$(ollama --version 2>/dev/null | awk '{print $4}' | sed 's/v//' | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1)
        if [ -n "$CURRENT_VERSION" ]; then
            echo -e "${GREEN}Ollama is installed (version: $CURRENT_VERSION).${NC}"
        else
            echo -e "${YELLOW}Ollama is installed but version could not be determined.${NC}"
            CURRENT_VERSION="unknown"
        fi
        
        # Check for latest version
        echo -e "${BLUE}Checking for latest Ollama version...${NC}"
        LATEST_VERSION=""
        
        # Try to get latest version from GitHub API
        if command_exists curl; then
            LATEST_VERSION=$(curl -s https://api.github.com/repos/ollama/ollama/releases/latest | grep -o '"tag_name": "[^"]*' | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1)
        fi
        
        if [ -z "$LATEST_VERSION" ]; then
            echo -e "${YELLOW}Could not check for latest version. Proceeding with current installation.${NC}"
            return 0
        else
            echo -e "${BLUE}Latest available version: $LATEST_VERSION${NC}"
            
            # Compare versions (simple numeric comparison)
            if [ "$CURRENT_VERSION" = "unknown" ]; then
                echo -e "${YELLOW}Ollama version could not be determined. Updating to latest version.${NC}"
                echo -e "${YELLOW}Some newer models (like deepseek-r1:8b) require the latest Ollama version.${NC}"
                UPDATE_NEEDED=true
            elif [ "$CURRENT_VERSION" = "$LATEST_VERSION" ]; then
                echo -e "${GREEN}Ollama is up to date.${NC}"
                UPDATE_NEEDED=false
            else
                echo -e "${YELLOW}Ollama version $CURRENT_VERSION is outdated. Latest version is $LATEST_VERSION.${NC}"
                echo -e "${YELLOW}Some newer models (like deepseek-r1:8b) require the latest Ollama version.${NC}"
                UPDATE_NEEDED=true
            fi
            
            # Skip update prompt if requested and version is current
            if [ "$skip_if_current" = "true" ] && [ "$UPDATE_NEEDED" = "false" ]; then
                return 0
            fi
            
            if [ "$UPDATE_NEEDED" = "true" ]; then
                if ask_yes_no "Would you like to update Ollama to the latest version?"; then
                    update_ollama_to_latest "$LATEST_VERSION"
                else
                    echo -e "${YELLOW}Skipping Ollama update. Some newer models may not work.${NC}"
                fi
            else
                echo -e "${GREEN}Ollama is up to date, no update needed.${NC}"
            fi
        fi
    else
        echo -e "${YELLOW}Ollama is not installed.${NC}"
        echo -e "${BLUE}Ollama is required for running local AI models (Ollama-based ClassIDs).${NC}"
        echo -e "${BLUE}This includes models like: deepseek-r1:8b, gemma3n:e4b, llama3.1:8b${NC}"
        
        if ask_yes_no "Would you like to install Ollama?"; then
            install_ollama_fresh
        else
            echo -e "${YELLOW}Skipping Ollama installation. Ollama-based models will not be available.${NC}"
            echo -e "${YELLOW}You can install Ollama later and the system will detect it automatically.${NC}"
        fi
    fi
}

# Function to update Ollama to latest version
update_ollama_to_latest() {
    local target_version="$1"
    
    echo -e "${BLUE}Updating Ollama to version $target_version...${NC}"
    
    # Stop Ollama service if running
    if pgrep -f "ollama serve" > /dev/null; then
        echo -e "${BLUE}Stopping Ollama service...${NC}"
        pkill -f "ollama serve" || true
        sleep 2
    fi
    
    # Detect OS
    local os_id=""
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        os_id="$ID"
    elif command_exists uname; then
        case "$(uname -s)" in
            Darwin*) os_id="macos";;
            Linux*) os_id="linux";;
            *) os_id="unknown";;
        esac
    fi
    
    # Download and install latest version
    case "$os_id" in
        ubuntu|debian|linux|"")
            echo -e "${BLUE}Installing latest Ollama on Linux...${NC}"
            curl -fsSL https://ollama.com/install.sh | sh
            ;;
        macos)
            echo -e "${BLUE}Installing latest Ollama on macOS...${NC}"
            curl -fsSL https://ollama.com/install.sh | sh
            ;;
        *)
            echo -e "${YELLOW}Automatic update not supported for this OS.${NC}"
            echo -e "${YELLOW}Please download the latest version from: https://ollama.com/download${NC}"
            return 1
            ;;
    esac
    
    # Verify update
    if command_exists ollama; then
        NEW_VERSION=$(ollama --version 2>/dev/null | awk '{print $4}' | sed 's/v//' | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1)
        if [ -n "$NEW_VERSION" ] && [ "$NEW_VERSION" = "$target_version" ]; then
            echo -e "${GREEN}Successfully updated Ollama to version $NEW_VERSION${NC}"
        elif [ -n "$NEW_VERSION" ]; then
            echo -e "${YELLOW}Ollama was updated to version $NEW_VERSION (expected $target_version)${NC}"
        else
            echo -e "${YELLOW}Ollama was updated but version could not be determined${NC}"
        fi
    else
        echo -e "${RED}Failed to update Ollama. Please install manually.${NC}"
        return 1
    fi
    
    return 0
}

# Function to install Ollama fresh
install_ollama_fresh() {
    echo -e "${BLUE}Installing latest Ollama...${NC}"
    
    # Detect OS
    local os_id=""
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        os_id="$ID"
    elif command_exists uname; then
        case "$(uname -s)" in
            Darwin*) os_id="macos";;
            Linux*) os_id="linux";;
            *) os_id="unknown";;
        esac
    fi
    
    case "$os_id" in
        ubuntu|debian|linux|"")
            echo -e "${BLUE}Installing Ollama on Linux...${NC}"
            curl -fsSL https://ollama.com/install.sh | sh
            ;;
        macos)
            echo -e "${BLUE}Installing Ollama on macOS...${NC}"
            curl -fsSL https://ollama.com/install.sh | sh
            ;;
        *)
            echo -e "${RED}Unsupported OS for automatic Ollama installation.${NC}"
            echo -e "${YELLOW}Please install Ollama manually from: https://ollama.com/download${NC}"
            return 1
            ;;
    esac
    
    # Verify installation
    if command_exists ollama; then
        INSTALLED_VERSION=$(ollama --version 2>/dev/null | awk '{print $4}' | sed 's/v//' | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1)
        if [ -n "$INSTALLED_VERSION" ]; then
            echo -e "${GREEN}Successfully installed Ollama version $INSTALLED_VERSION${NC}"
        else
            echo -e "${GREEN}Successfully installed Ollama (version could not be determined)${NC}"
        fi
    else
        echo -e "${RED}Failed to install Ollama. Please install manually.${NC}"
        return 1
    fi
    
    return 0
}

# Function to start Ollama service (if not already running)
start_ollama_service() {
    echo -e "${BLUE}Starting Ollama service...${NC}"
    if command_exists ollama; then
        # Check if Ollama is already running
        if pgrep -f "ollama serve" > /dev/null; then
            echo -e "${GREEN}Ollama service is already running.${NC}"
        else
            # Start Ollama service in background
            nohup ollama serve > /dev/null 2>&1 &
            sleep 3
            
            # Verify it started
            if pgrep -f "ollama serve" > /dev/null; then
                echo -e "${GREEN}Ollama service started successfully.${NC}"
            else
                echo -e "${RED}Failed to start Ollama service.${NC}"
                return 1
            fi
        fi
    else
        echo -e "${RED}Ollama not found. Cannot start service.${NC}"
        return 1
    fi
    
    return 0
}
