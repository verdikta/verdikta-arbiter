#!/bin/bash

# Verdikta Arbiter Documentation Server
# Convenience script for building and serving documentation

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to detect OS
detect_os() {
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        if [ -f /etc/os-release ]; then
            . /etc/os-release
            echo "$ID"
        else
            echo "linux"
        fi
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        echo "macos"
    elif [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]]; then
        echo "windows"
    else
        echo "unknown"
    fi
}

# Function to install pip
install_pip() {
    echo -e "${YELLOW}pip not found. Installing pip...${NC}"
    
    local os=$(detect_os)
    
    case "$os" in
        "ubuntu"|"debian")
            echo -e "${BLUE}Installing pip using apt-get...${NC}"
            sudo apt-get update
            sudo apt-get install -y python3-pip
            ;;
        "fedora"|"centos"|"rhel")
            echo -e "${BLUE}Installing pip using yum/dnf...${NC}"
            if command -v dnf &> /dev/null; then
                sudo dnf install -y python3-pip
            else
                sudo yum install -y python3-pip
            fi
            ;;
        "macos")
            if command -v brew &> /dev/null; then
                echo -e "${BLUE}Installing pip using Homebrew...${NC}"
                brew install python3
            else
                echo -e "${YELLOW}Homebrew not found. Please install pip manually:${NC}"
                echo -e "${YELLOW}  Visit: https://pip.pypa.io/en/stable/installation/${NC}"
                exit 1
            fi
            ;;
        *)
            echo -e "${YELLOW}Unknown OS. Attempting to install pip using get-pip.py...${NC}"
            curl https://bootstrap.pypa.io/get-pip.py -o get-pip.py
            python3 get-pip.py --user
            rm get-pip.py
            ;;
    esac
    
    echo -e "${GREEN}pip installation completed.${NC}"
}

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}Error: Python 3 is required but not installed.${NC}"
    echo -e "${YELLOW}Please install Python 3 first:${NC}"
    
    local os=$(detect_os)
    case "$os" in
        "ubuntu"|"debian")
            echo -e "${YELLOW}  sudo apt-get update && sudo apt-get install -y python3${NC}"
            ;;
        "fedora"|"centos"|"rhel")
            echo -e "${YELLOW}  sudo dnf install -y python3  # or: sudo yum install -y python3${NC}"
            ;;
        "macos")
            echo -e "${YELLOW}  brew install python3  # or download from python.org${NC}"
            ;;
        *)
            echo -e "${YELLOW}  Visit: https://www.python.org/downloads/${NC}"
            ;;
    esac
    exit 1
fi

# Check if pip is installed, install if missing
if ! command -v pip3 &> /dev/null && ! command -v pip &> /dev/null; then
    install_pip
fi

# Function to install dependencies
install_deps() {
    echo -e "${BLUE}Installing documentation dependencies...${NC}"
    
    # Use pip3 if available, otherwise pip
    if command -v pip3 &> /dev/null; then
        PIP_CMD="pip3"
    else
        PIP_CMD="pip"
    fi
    
    if [ ! -f "requirements.txt" ]; then
        echo -e "${RED}Error: requirements.txt not found.${NC}"
        exit 1
    fi
    
    # Install with user flag to avoid permission issues
    $PIP_CMD install --user -r requirements.txt
    echo -e "${GREEN}Dependencies installed successfully.${NC}"
    
    # Check if mkdocs is in PATH
    if ! command -v mkdocs &> /dev/null; then
        echo -e "${YELLOW}Warning: mkdocs not found in PATH after installation.${NC}"
        echo -e "${YELLOW}You may need to add ~/.local/bin to your PATH:${NC}"
        echo -e "${YELLOW}  export PATH=\"\$HOME/.local/bin:\$PATH\"${NC}"
        echo -e "${YELLOW}  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc${NC}"
        
        # Try to add to current session
        export PATH="$HOME/.local/bin:$PATH"
        
        if command -v mkdocs &> /dev/null; then
            echo -e "${GREEN}mkdocs now available in current session.${NC}"
        fi
    fi
}

# Function to build documentation
build_docs() {
    echo -e "${BLUE}Building documentation...${NC}"
    
    # Ensure mkdocs is available
    if ! command -v mkdocs &> /dev/null; then
        export PATH="$HOME/.local/bin:$PATH"
    fi
    
    if ! command -v mkdocs &> /dev/null; then
        echo -e "${RED}Error: mkdocs not found. Please run: $0 install${NC}"
        exit 1
    fi
    
    mkdocs build --clean
    echo -e "${GREEN}Documentation built successfully in 'site/' directory.${NC}"
}

# Function to serve documentation
serve_docs() {
    echo -e "${BLUE}Starting documentation server...${NC}"
    
    # Ensure mkdocs is available
    if ! command -v mkdocs &> /dev/null; then
        export PATH="$HOME/.local/bin:$PATH"
    fi
    
    if ! command -v mkdocs &> /dev/null; then
        echo -e "${YELLOW}MkDocs not found. Installing dependencies...${NC}"
        install_deps
        # Re-export PATH
        export PATH="$HOME/.local/bin:$PATH"
    fi
    
    if ! command -v mkdocs &> /dev/null; then
        echo -e "${RED}Error: mkdocs still not available after installation.${NC}"
        echo -e "${YELLOW}Please add ~/.local/bin to your PATH and try again:${NC}"
        echo -e "${YELLOW}  export PATH=\"\$HOME/.local/bin:\$PATH\"${NC}"
        exit 1
    fi
    
    echo -e "${YELLOW}Documentation will be available at: http://localhost:8000${NC}"
    echo -e "${YELLOW}Press Ctrl+C to stop the server.${NC}"
    echo ""
    mkdocs serve
}

# Function to deploy to GitHub Pages
deploy_docs() {
    echo -e "${BLUE}Deploying to GitHub Pages...${NC}"
    
    # Ensure mkdocs is available
    if ! command -v mkdocs &> /dev/null; then
        export PATH="$HOME/.local/bin:$PATH"
    fi
    
    if ! command -v mkdocs &> /dev/null; then
        echo -e "${RED}Error: mkdocs not found. Please run: $0 install${NC}"
        exit 1
    fi
    
    mkdocs gh-deploy
    echo -e "${GREEN}Documentation deployed to GitHub Pages.${NC}"
}

# Function to show help
show_help() {
    echo "Verdikta Arbiter Documentation Server"
    echo ""
    echo "Usage: $0 [COMMAND]"
    echo ""
    echo "Commands:"
    echo "  install    Install dependencies (including pip if missing)"
    echo "  build      Build static documentation"
    echo "  serve      Serve documentation locally (default)"
    echo "  deploy     Deploy to GitHub Pages"
    echo "  help       Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0              # Serve documentation locally"
    echo "  $0 install      # Install dependencies"
    echo "  $0 build        # Build for production"
    echo "  $0 deploy       # Deploy to GitHub Pages"
    echo ""
    echo "Prerequisites:"
    echo "  - Python 3.8+ (will be checked and guided for installation)"
    echo "  - pip (will be installed automatically if missing)"
    echo "  - Internet connection for downloading dependencies"
}

# Main logic
case "${1:-serve}" in
    "install")
        install_deps
        ;;
    "build")
        build_docs
        ;;
    "serve")
        serve_docs
        ;;
    "deploy")
        deploy_docs
        ;;
    "help"|"-h"|"--help")
        show_help
        ;;
    *)
        echo -e "${RED}Error: Unknown command '$1'${NC}"
        echo ""
        show_help
        exit 1
        ;;
esac 