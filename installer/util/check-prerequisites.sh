#!/bin/bash

# Verdikta Arbiter Node - Prerequisites Check Script
# Checks if the system meets all requirements for installation

set -e  # Exit on any error

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Checking system prerequisites for Verdikta Arbiter Node...${NC}"

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Variables to track requirements
FAIL=0
WARNINGS=0

# Check OS
echo -e "${BLUE}Checking operating system...${NC}"
OS="$(uname -s)"
case "$OS" in
    Linux)
        if [ -f /etc/os-release ]; then
            . /etc/os-release
            if [ "$ID" = "ubuntu" ]; then
                if [ "${VERSION_ID%.*}" -lt 20 ]; then
                    echo -e "${YELLOW}WARNING: Ubuntu version $VERSION_ID detected. Recommended: Ubuntu 20.04 or newer.${NC}"
                    WARNINGS=$((WARNINGS+1))
                else
                    echo -e "${GREEN}✓ Ubuntu $VERSION_ID detected.${NC}"
                fi
            else
                echo -e "${YELLOW}WARNING: $PRETTY_NAME detected. Recommended: Ubuntu 20.04 or newer.${NC}"
                echo -e "${YELLOW}The installation may work but has not been tested on this OS.${NC}"
                WARNINGS=$((WARNINGS+1))
            fi
        else
            echo -e "${YELLOW}WARNING: Unable to determine Linux distribution. Proceeding with caution.${NC}"
            WARNINGS=$((WARNINGS+1))
        fi
        ;;
    Darwin)
        sw_vers_output=$(sw_vers)
        osx_version=$(echo "$sw_vers_output" | grep 'ProductVersion' | cut -d':' -f2 | tr -d ' \t')
        osx_major=$(echo "$osx_version" | cut -d'.' -f1)
        if [ "$osx_major" -lt 11 ]; then
            echo -e "${YELLOW}WARNING: macOS version $osx_version detected. Recommended: macOS 11.0 (Big Sur) or newer.${NC}"
            WARNINGS=$((WARNINGS+1))
        else
            echo -e "${GREEN}✓ macOS $osx_version detected.${NC}"
        fi
        ;;
    MINGW*|MSYS*|CYGWIN*)
        echo -e "${YELLOW}WARNING: Windows detected. WSL2 (Windows Subsystem for Linux 2) is required.${NC}"
        echo -e "${YELLOW}Please ensure you are running this script inside WSL2 with Ubuntu 20.04 or newer.${NC}"
        WARNINGS=$((WARNINGS+1))
        ;;
    *)
        echo -e "${RED}ERROR: Unsupported operating system: $OS${NC}"
        FAIL=1
        ;;
esac

# Check CPU
echo -e "${BLUE}Checking CPU...${NC}"
CPU_CORES=$(grep -c ^processor /proc/cpuinfo 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 0)
if [ "$CPU_CORES" -lt 2 ]; then
    echo -e "${YELLOW}WARNING: Only $CPU_CORES CPU cores detected. Recommended: 2 or more cores.${NC}"
    WARNINGS=$((WARNINGS+1))
else
    echo -e "${GREEN}✓ $CPU_CORES CPU cores detected.${NC}"
fi

# Check RAM
echo -e "${BLUE}Checking RAM...${NC}"
if [ "$OS" = "Linux" ]; then
    TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    TOTAL_RAM_GB=$((TOTAL_RAM_KB / 1024 / 1024))
elif [ "$OS" = "Darwin" ]; then
    TOTAL_RAM_B=$(sysctl hw.memsize | awk '{print $2}')
    TOTAL_RAM_GB=$((TOTAL_RAM_B / 1024 / 1024 / 1024))
else
    TOTAL_RAM_GB=0
fi

if [ "$TOTAL_RAM_GB" -lt 6 ]; then
    echo -e "${YELLOW}WARNING: Only $TOTAL_RAM_GB GB RAM detected. Recommended: 6 GB or more.${NC}"
    WARNINGS=$((WARNINGS+1))
else
    echo -e "${GREEN}✓ $TOTAL_RAM_GB GB RAM detected.${NC}"
fi

# Check disk space
echo -e "${BLUE}Checking disk space...${NC}"
INSTALL_DIR="$HOME"
AVAILABLE_SPACE_KB=$(df -k "$INSTALL_DIR" | awk 'NR==2 {print $4}')
AVAILABLE_SPACE_GB=$((AVAILABLE_SPACE_KB / 1024 / 1024))

if [ "$AVAILABLE_SPACE_GB" -lt 100 ]; then
    echo -e "${YELLOW}WARNING: Only $AVAILABLE_SPACE_GB GB available disk space. Recommended: 100 GB or more.${NC}"
    WARNINGS=$((WARNINGS+1))
else
    echo -e "${GREEN}✓ $AVAILABLE_SPACE_GB GB available disk space detected.${NC}"
fi

# Check Git
echo -e "${BLUE}Checking for Git...${NC}"
if command_exists git; then
    GIT_VERSION=$(git --version | awk '{print $3}')
    echo -e "${GREEN}✓ Git version $GIT_VERSION detected.${NC}"
else
    echo -e "${RED}ERROR: Git is not installed. Please install Git and try again.${NC}"
    FAIL=1
fi

# Check Node.js
echo -e "${BLUE}Checking for Node.js...${NC}"
if command_exists node; then
    NODE_VERSION=$(node --version | cut -d 'v' -f 2)
    NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d'.' -f1)
    NODE_MINOR=$(echo "$NODE_VERSION" | cut -d'.' -f2)
    
    if [ "$NODE_MAJOR" -lt 18 ] || ([ "$NODE_MAJOR" -eq 18 ] && [ "$NODE_MINOR" -lt 17 ]); then
        echo -e "${YELLOW}WARNING: Node.js version $NODE_VERSION detected. Recommended: v18.17.0 or newer.${NC}"
        echo -e "${YELLOW}We will attempt to install/update Node.js during setup.${NC}"
        WARNINGS=$((WARNINGS+1))
    else
        echo -e "${GREEN}✓ Node.js version $NODE_VERSION detected.${NC}"
    fi
else
    echo -e "${YELLOW}WARNING: Node.js is not installed. We will attempt to install it during setup.${NC}"
    WARNINGS=$((WARNINGS+1))
fi

# Check Docker
echo -e "${BLUE}Checking for Docker...${NC}"
if command_exists docker; then
    DOCKER_VERSION=$(docker --version | awk '{print $3}' | sed 's/,//')
    DOCKER_MAJOR=$(echo "$DOCKER_VERSION" | cut -d'.' -f1)
    DOCKER_MINOR=$(echo "$DOCKER_VERSION" | cut -d'.' -f2)
    
    if [ "$DOCKER_MAJOR" -lt 24 ]; then
        echo -e "${YELLOW}WARNING: Docker version $DOCKER_VERSION detected. Recommended: 24.0.0 or newer.${NC}"
        echo -e "${YELLOW}We will attempt to update Docker during setup.${NC}"
        WARNINGS=$((WARNINGS+1))
    else
        echo -e "${GREEN}✓ Docker version $DOCKER_VERSION detected.${NC}"
    fi
    
    # Check if Docker is running
    if docker info > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Docker daemon is running.${NC}"
    else
        echo -e "${YELLOW}WARNING: Docker daemon is not running. Please start Docker and try again.${NC}"
        WARNINGS=$((WARNINGS+1))
    fi
else
    echo -e "${YELLOW}WARNING: Docker is not installed. We will attempt to install it during setup.${NC}"
    WARNINGS=$((WARNINGS+1))
fi

# Check Docker Compose
echo -e "${BLUE}Checking for Docker Compose...${NC}"
if command_exists docker-compose; then
    COMPOSE_VERSION=$(docker-compose --version | awk '{print $3}' | sed 's/,//' | sed 's/v//')
    COMPOSE_MAJOR=$(echo "$COMPOSE_VERSION" | cut -d'.' -f1)
    COMPOSE_MINOR=$(echo "$COMPOSE_VERSION" | cut -d'.' -f2)
    
    if [ "$COMPOSE_MAJOR" -lt 2 ] || ([ "$COMPOSE_MAJOR" -eq 2 ] && [ "$COMPOSE_MINOR" -lt 20 ]); then
        echo -e "${YELLOW}WARNING: Docker Compose version $COMPOSE_VERSION detected. Recommended: 2.20.0 or newer.${NC}"
        echo -e "${YELLOW}We will attempt to update Docker Compose during setup.${NC}"
        WARNINGS=$((WARNINGS+1))
    else
        echo -e "${GREEN}✓ Docker Compose version $COMPOSE_VERSION detected.${NC}"
    fi
else
    # Check if it's integrated with Docker
    if docker compose version > /dev/null 2>&1; then
        COMPOSE_VERSION=$(docker compose version --short)
        echo -e "${GREEN}✓ Docker Compose plugin version $COMPOSE_VERSION detected.${NC}"
    else
        echo -e "${YELLOW}WARNING: Docker Compose is not installed. We will attempt to install it during setup.${NC}"
        WARNINGS=$((WARNINGS+1))
    fi
fi

# Check internet connectivity
echo -e "${BLUE}Checking internet connectivity...${NC}"
if ping -c 1 google.com > /dev/null 2>&1 || ping -c 1 cloudflare.com > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Internet connectivity detected.${NC}"
else
    echo -e "${RED}ERROR: No internet connectivity. Please check your connection and try again.${NC}"
    FAIL=1
fi

# Check for jq (JSON processor)
echo -e "${BLUE}Checking for jq...${NC}"
if ! command_exists jq; then
    echo -e "${YELLOW}jq (JSON processor) is not installed.${NC}"
    if [ "$OS_ID" = "ubuntu" ] || [ "$OS_ID" = "debian" ]; then
        echo -e "${BLUE}Attempting to install jq using apt-get...${NC}"
        sudo apt-get update > /dev/null 2>&1
        if sudo apt-get install -y jq > /dev/null 2>&1; then
            echo -e "${GREEN}✓ jq successfully installed.${NC}"
        else
            echo -e "${RED}ERROR: Failed to automatically install jq using apt-get.${NC}"
            FAIL=1 # Mark as failure if auto-install fails
        fi
    elif [ "$OS_ID" = "macos" ] && command_exists brew; then
        echo -e "${BLUE}Attempting to install jq using Homebrew...${NC}"
        if brew install jq > /dev/null 2>&1; then
            echo -e "${GREEN}✓ jq successfully installed.${NC}"
        else
            echo -e "${RED}ERROR: Failed to automatically install jq using Homebrew.${NC}"
            FAIL=1 # Mark as failure if auto-install fails
        fi
    elif [ "$OS_ID" = "fedora" ] || [ "$OS_ID" = "centos" ] || [ "$OS_ID" = "rhel" ]; then # Basic check for yum/dnf systems
        echo -e "${BLUE}Attempting to install jq using yum or dnf...${NC}"
        if sudo yum install -y jq > /dev/null 2>&1 || sudo dnf install -y jq > /dev/null 2>&1; then
             echo -e "${GREEN}✓ jq successfully installed.${NC}"
        else
            echo -e "${RED}ERROR: Failed to automatically install jq using yum/dnf.${NC}"
            FAIL=1
        fi
    else
        # If not a recognized OS for auto-install, or auto-install failed, mark as failure.
        FAIL=1 
    fi

    # If still not found after attempting install (or if OS wasn't right for auto-install)
    if ! command_exists jq; then
        echo -e "${RED}ERROR: jq is still not installed after attempting automatic installation.${NC}"
        echo -e "${YELLOW}Please install jq manually. Examples:${NC}"
        echo -e "${YELLOW}  On Debian/Ubuntu: sudo apt-get update && sudo apt-get install -y jq${NC}"
        echo -e "${YELLOW}  On macOS (with Homebrew): brew install jq${NC}"
        echo -e "${YELLOW}  On Fedora/CentOS/RHEL: sudo yum install jq || sudo dnf install jq${NC}"
        # FAIL is already set to 1 if we reach here and jq isn't installed
    fi
else
    JQ_VERSION=$(jq --version 2>/dev/null || echo "unknown") 
    echo -e "${GREEN}✓ jq version $JQ_VERSION detected.${NC}"
fi

# Summary
echo -e "\n${BLUE}=== Prerequisite Check Summary ===${NC}"
if [ $FAIL -eq 0 ]; then
    if [ $WARNINGS -eq 0 ]; then
        echo -e "${GREEN}All prerequisites met! Your system is ready for Verdikta Arbiter Node installation.${NC}"
    else
        echo -e "${YELLOW}System check completed with $WARNINGS warning(s).${NC}"
        echo -e "${YELLOW}The installer will attempt to resolve these issues, but manual intervention may be required.${NC}"
        echo -e "${YELLOW}You can proceed with installation, but some components may not work optimally.${NC}"
    fi
    exit 0
else
    echo -e "${RED}System check failed! Please address the errors above before proceeding with installation.${NC}"
    exit 1
fi 