#!/bin/bash

# Verdikta ClassID Data Update Script
# Updates @verdikta/common library and displays latest ClassID information

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALLER_DIR="$(dirname "$SCRIPT_DIR")"

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}======================================================${NC}"
echo -e "${CYAN}  Verdikta ClassID Data Update Utility${NC}"
echo -e "${CYAN}======================================================${NC}"
echo -e "${BLUE}This utility updates @verdikta/common and displays the latest ClassID model pools.${NC}"
echo ""

# Find AI Node directory
AI_NODE_DIR=""
if [ -d "$(dirname "$INSTALLER_DIR")/ai-node" ]; then
    AI_NODE_DIR="$(dirname "$INSTALLER_DIR")/ai-node"
elif [ -d "$INSTALLER_DIR/../ai-node" ]; then
    AI_NODE_DIR="$INSTALLER_DIR/../ai-node"
elif [ -d "./ai-node" ]; then
    AI_NODE_DIR="./ai-node"
else
    echo -e "${RED}Error: Could not find AI Node directory.${NC}"
    echo -e "${YELLOW}Please run this script from the Verdikta installation directory.${NC}"
    exit 1
fi

echo -e "${BLUE}Found AI Node directory: $AI_NODE_DIR${NC}"

# Load environment configuration if available
VERDIKTA_VERSION="beta"
if [ -f "$INSTALLER_DIR/.env" ]; then
    source "$INSTALLER_DIR/.env"
    VERDIKTA_VERSION="${VERDIKTA_COMMON_VERSION:-beta}"
fi

echo -e "${BLUE}Using @verdikta/common version: $VERDIKTA_VERSION${NC}"
echo ""

# Update @verdikta/common library
echo -e "${YELLOW}Updating @verdikta/common library...${NC}"
if [ -f "$SCRIPT_DIR/update-verdikta-common.js" ]; then
    if node "$SCRIPT_DIR/update-verdikta-common.js" "$AI_NODE_DIR" "$VERDIKTA_VERSION" "$@"; then
        echo -e "${GREEN}@verdikta/common library update completed successfully!${NC}"
    else
        echo -e "${RED}Failed to update @verdikta/common library.${NC}"
        echo -e "${YELLOW}Displaying information with current version...${NC}"
    fi
else
    echo -e "${YELLOW}Update utility not found, skipping update check.${NC}"
fi

echo ""

# Display ClassID information
echo -e "${YELLOW}Displaying latest ClassID Model Pool information...${NC}"
if [ -f "$SCRIPT_DIR/display-classids.js" ]; then
    cd "$AI_NODE_DIR"
    if node "$SCRIPT_DIR/display-classids.js"; then
        echo ""
        echo -e "${GREEN}ClassID information displayed successfully!${NC}"
        echo ""
        echo -e "${BLUE}💡 Use this information to:${NC}"
        echo -e "${BLUE}   • Plan which ClassIDs to support in your deployment${NC}"
        echo -e "${BLUE}   • Verify your API key configuration matches your needs${NC}"
        echo -e "${BLUE}   • Check model availability and capabilities${NC}"
        echo -e "${BLUE}   • Make informed decisions about open source vs commercial models${NC}"
    else
        echo -e "${RED}Failed to display ClassID information.${NC}"
        echo -e "${YELLOW}Make sure the AI Node is properly installed with @verdikta/common.${NC}"
    fi
    cd - > /dev/null
else
    echo -e "${RED}ClassID display utility not found.${NC}"
fi

echo ""
echo -e "${GREEN}ClassID data update completed!${NC}"

