#!/bin/bash

# Verdikta Validator Node - AI Node Installation Script
# Clones and configures the AI Node component

set -e  # Exit on any error

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALLER_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_DIR="$INSTALLER_DIR/config"

# Color definitions
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
SKIP_TESTS=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-tests|-s)
            SKIP_TESTS=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo "Options:"
            echo "  --skip-tests, -s    Skip unit tests during installation"
            echo "  --help, -h          Show this help message"
            echo ""
            echo "Environment Variables:"
            echo "  SKIP_TESTS=true     Skip unit tests (alternative to --skip-tests)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Check environment variable as well
if [ "$SKIP_TESTS" = "true" ]; then
    SKIP_TESTS=true
fi

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to load NVM
load_nvm() {
    # Load nvm if it exists
    if [ -d "$HOME/.nvm" ]; then
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
        
        # Verify node is available
        if command_exists node; then
            echo -e "${GREEN}Node.js $(node --version) loaded successfully${NC}"
            return 0
        else
            echo -e "${RED}Failed to load Node.js${NC}"
            return 1
        fi
    else
        echo -e "${YELLOW}NVM directory not found. Attempting to install NVM...${NC}"
        # Try to install NVM if it's missing
        if command_exists curl; then
            echo -e "${BLUE}Installing NVM...${NC}"
            curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.3/install.sh | bash
            
            # Source nvm immediately after installation
            export NVM_DIR="$HOME/.nvm"
            [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
            [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
            
            if [ -d "$HOME/.nvm" ] && command_exists nvm; then
                echo -e "${GREEN}NVM installed successfully.${NC}"
                return 1  # Return 1 to indicate Node.js still needs to be installed
            else
                echo -e "${RED}Failed to install NVM. Please install Node.js v20.18.1 manually or run setup-environment.sh.${NC}"
                return 1
            fi
        else
            echo -e "${RED}curl not found. Cannot install NVM automatically.${NC}"
            echo -e "${RED}Please run setup-environment.sh first or install Node.js v20.18.1 manually.${NC}"
            return 1
        fi
    fi
}

echo -e "${BLUE}Installing AI Node for Verdikta Validator Node...${NC}"
if [ "$SKIP_TESTS" = "true" ]; then
    echo -e "${YELLOW}Note: Unit tests will be skipped during installation${NC}"
fi

# Load NVM and Node.js
load_nvm || exit 1

# Force Node.js version 20.18.1
echo -e "${BLUE}Setting up Node.js v20.18.1...${NC}"
nvm install 20.18.1
nvm use 20.18.1
nvm alias default 20.18.1

# Verify Node.js version
NODE_VERSION=$(node --version)
if [[ ! "$NODE_VERSION" == "v20.18.1" ]]; then
    echo -e "${RED}Failed to set Node.js version to v20.18.1. Current version: $NODE_VERSION${NC}"
    echo -e "${YELLOW}Please run 'nvm use 20.18.1' manually and try again.${NC}"
    exit 1
fi
echo -e "${GREEN}Node.js version verified: $NODE_VERSION${NC}"

# Load environment variables
if [ -f "$INSTALLER_DIR/.env" ]; then
    source "$INSTALLER_DIR/.env"
else
    echo -e "${RED}Error: Environment file not found. Please run setup-environment.sh first.${NC}"
    exit 1
fi

# Load API keys
if [ -f "$INSTALLER_DIR/.api_keys" ]; then
    source "$INSTALLER_DIR/.api_keys"
else
    echo -e "${RED}Error: API keys file not found. Please run setup-environment.sh first.${NC}"
    exit 1
fi

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

# Define AI Node directory based on script location
# AI_NODE_DIR="$INSTALL_DIR/ai-node" # Old definition based on INSTALL_DIR
# WORKSPACE_ROOT="$(dirname "$INSTALLER_DIR")" # Root of verdikta-arbiter
# AI_NODE_DIR="$WORKSPACE_ROOT/ai-node" # New definition pointing to local directory
AI_NODE_DIR="$(dirname "$INSTALLER_DIR")/ai-node"

# Ensure the target directory exists
if [ ! -d "$AI_NODE_DIR" ]; then
    echo -e "${RED}Error: AI Node directory not found at $AI_NODE_DIR${NC}"
    exit 1
fi
cd "$AI_NODE_DIR" # Change into the existing local directory

# Install dependencies
echo -e "${BLUE}Installing AI Node dependencies...${NC}"
# First install the same Next.js version as the working VPS
npm install next@14.2.5
# Then install remaining dependencies
npm install

# Run test suite (optional)
if [ "$SKIP_TESTS" = "true" ]; then
    echo -e "${YELLOW}Skipping AI Node test suite (--skip-tests flag provided)${NC}"
else
    echo -e "${BLUE}Running AI Node test suite...${NC}"
    npm test || {
        echo -e "${YELLOW}WARNING: Some tests failed. This might be due to missing API keys or services not running.${NC}"
        echo -e "${YELLOW}You can still proceed with the installation, but some features might not work correctly.${NC}"
    }
fi

# Integrate ClassID Model Pools
echo -e "${BLUE}Configuring ClassID Model Pools...${NC}"
if [ -f "$AI_NODE_DIR/src/scripts/classid-integration.js" ]; then
    echo -e "${BLUE}Found ClassID integration script. Configuring model pools...${NC}"
    
    # Check if @verdikta/common is installed with correct version
    # Load environment to get consistent version preference
    if [ -f "$INSTALLER_DIR/.env" ]; then
        source "$INSTALLER_DIR/.env"
    fi
    VERDIKTA_COMMON_VERSION="${VERDIKTA_COMMON_VERSION:-latest}"
    
    if npm list @verdikta/common >/dev/null 2>&1; then
        CURRENT_VERSION=$(npm list @verdikta/common --depth=0 2>/dev/null | grep @verdikta/common | awk '{print $2}')
        echo -e "${GREEN}@verdikta/common is already installed (version: $CURRENT_VERSION).${NC}"
        echo -e "${BLUE}Will be updated to latest version during installation process.${NC}"
    else
        echo -e "${YELLOW}@verdikta/common not found. Will be installed during installation process.${NC}"
    fi
    
    # Run the ClassID integration script in non-interactive mode for installer
    echo -e "${BLUE}Integrating ClassID model pools automatically...${NC}"
    echo -e "${YELLOW}The installer will configure all available ClassID model pools.${NC}"
    echo -e "${YELLOW}You can reconfigure later using: npm run integrate-classid${NC}"
    
    # Create a non-interactive version for the installer
    cat > "$AI_NODE_DIR/classid-auto-integration.js" << 'EOCI'
const { classMap } = require('@verdikta/common');
const fs = require('fs');
const path = require('path');

console.log('🔧 Auto-configuring ClassID Model Pools...');

try {
    // Get all active classes
    const availableClasses = classMap.listClasses().filter(classItem => {
        const cls = classMap.getClass(classItem.id);
        return cls && cls.status === 'ACTIVE' && cls.models && cls.models.length > 0;
    });
    
    if (availableClasses.length === 0) {
        console.log('❌ No active classes with models found.');
        process.exit(0);
    }
    
    console.log(`✅ Found ${availableClasses.length} active ClassID model pools`);
    
    // Read current models.ts
    const modelsPath = path.join(__dirname, 'src/config/models.ts');
    const currentContent = fs.readFileSync(modelsPath, 'utf8');
    
    // Parse existing models
    const openaiMatch = currentContent.match(/openai:\s*\[([\s\S]*?)\]/);
    const anthropicMatch = currentContent.match(/anthropic:\s*\[([\s\S]*?)\]/);
    const ollamaMatch = currentContent.match(/ollama:\s*\[([\s\S]*?)\]/);
    const hyperbolicMatch = currentContent.match(/hyperbolic:\s*\[([\s\S]*?)\]/);
    
    const parseModels = (match) => {
        if (!match) return [];
        return match[1]
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('{'))
            .map(line => {
                const nameMatch = line.match(/name:\s*['"`]([^'"`]+)['"`]/);
                return nameMatch ? nameMatch[1] : null;
            })
            .filter(Boolean);
    };
    
    const existingModels = {
        openai: new Set(parseModels(openaiMatch)),
        anthropic: new Set(parseModels(anthropicMatch)),
        ollama: new Set(parseModels(ollamaMatch)),
        hyperbolic: new Set(parseModels(hyperbolicMatch))
    };
    
    // Add models from ClassID pools
    availableClasses.forEach(classItem => {
        const cls = classMap.getClass(classItem.id);
        console.log(`📋 Processing ClassID ${cls.id}: ${cls.name}`);
        
        if (cls && cls.models) {
            cls.models.forEach(model => {
                if (model.provider === 'openai' || model.provider === 'anthropic') {
                    existingModels[model.provider].add(model.model);
                    console.log(`   + Added ${model.provider}/${model.model}`);
                } else if (model.provider === 'ollama') {
                    existingModels.ollama.add(model.model);
                    console.log(`   + Added ${model.provider}/${model.model}`);
                } else if (model.provider === 'hyperbolic') {
                    existingModels.hyperbolic.add(model.model);
                    console.log(`   + Added ${model.provider}/${model.model}`);
                }
            });
        }
    });
    
    // Generate model configuration with capability detection
    const modelSupportsImages = (modelName, provider) => {
        if (provider === 'openai') {
            return modelName.includes('gpt-4') || 
                   modelName.includes('gpt-5') || 
                   modelName.includes('o3') || 
                   modelName === 'gpt-4o';
        } else if (provider === 'anthropic') {
            return modelName.includes('claude-3') || 
                   modelName.includes('claude-sonnet-4') ||
                   modelName.includes('claude-4');
        } else if (provider === 'ollama') {
            return modelName.includes('llava') || 
                   modelName.includes('vision') ||
                   modelName.includes('minicpm');
        } else if (provider === 'hyperbolic') {
            // Hyperbolic models typically support images
            return true;
        }
        return false;
    };
    
    const modelSupportsAttachments = (modelName, provider) => {
        if (provider === 'openai') {
            return !modelName.includes('3.5-turbo') || 
                   modelName.includes('gpt-4') || 
                   modelName.includes('gpt-5') ||
                   modelName.includes('o3');
        } else if (provider === 'anthropic') {
            return modelName.includes('claude-3') || 
                   modelName.includes('claude-sonnet-4') ||
                   modelName.includes('claude-4');
        } else if (provider === 'ollama') {
            return true;
        } else if (provider === 'hyperbolic') {
            // Hyperbolic models typically support attachments
            return true;
        }
        return false;
    };
    
    const generateModelEntries = (models, provider) => {
        return Array.from(models).map(model => {
            const supportsImages = modelSupportsImages(model, provider);
            const supportsAttachments = modelSupportsAttachments(model, provider);
            return `    { name: '${model}', supportsImages: ${supportsImages}, supportsAttachments: ${supportsAttachments} },`;
        }).join('\n');
    };
    
    const newContent = `export const modelConfig = {
  openai: [
${generateModelEntries(existingModels.openai, 'openai')}
  ],
  anthropic: [
${generateModelEntries(existingModels.anthropic, 'anthropic')}
  ],
  ollama: [
${generateModelEntries(existingModels.ollama, 'ollama')}
  ],
  hyperbolic: [
${generateModelEntries(existingModels.hyperbolic, 'hyperbolic')}
  ],
};
`;
    
    // Backup and write new configuration
    fs.copyFileSync(modelsPath, modelsPath + '.backup');
    fs.writeFileSync(modelsPath, newContent);
    
    console.log('✅ ClassID model pools integrated successfully!');
    console.log('📋 Configuration updated with models from all active ClassID pools');
    
    // List models by provider
    const ollamaModels = Array.from(existingModels.ollama);
    const hyperbolicModels = Array.from(existingModels.hyperbolic);
    
    if (ollamaModels.length > 0) {
        console.log('🐋 Ollama models configured:', ollamaModels.join(', '));
        console.log('   These will be pulled during Ollama installation if selected.');
    }
    
    if (hyperbolicModels.length > 0) {
        console.log('🌐 Hyperbolic models configured:', hyperbolicModels.join(', '));
        console.log('   These require Hyperbolic API key configuration.');
    }
    
} catch (error) {
    console.error('❌ ClassID integration failed:', error.message);
    process.exit(1);
}
EOCI
    
    # Run the auto-integration script
    node classid-auto-integration.js
    
    # Clean up temporary script
    rm -f classid-auto-integration.js
    
    echo -e "${GREEN}ClassID Model Pools configured successfully!${NC}"
    echo -e "${BLUE}You can reconfigure later using: npm run integrate-classid${NC}"
else
    echo -e "${YELLOW}ClassID integration script not found. Skipping ClassID configuration.${NC}"
    echo -e "${YELLOW}You can configure ClassID model pools later if the script becomes available.${NC}"
fi

# Configure environment
echo -e "${BLUE}Configuring AI Node environment...${NC}"
if [ -f "$AI_NODE_DIR/.env.local" ]; then
    echo -e "${YELLOW}AI Node environment file already exists. Updating...${NC}"
    # Backup existing file
    cp "$AI_NODE_DIR/.env.local" "$AI_NODE_DIR/.env.local.backup"
else
    # Copy template
    if [ -f "$AI_NODE_DIR/.env.local.example" ]; then
        cp "$AI_NODE_DIR/.env.local.example" "$AI_NODE_DIR/.env.local"
    else
        echo -e "${RED}Error: .env.local.example not found in AI Node repository.${NC}"
        echo -e "${BLUE}Creating .env.local file from scratch...${NC}"
        touch "$AI_NODE_DIR/.env.local"
    fi
fi

# Update environment file
if [ -n "$OPENAI_API_KEY" ]; then
    # Check if key already exists in file
    if grep -q "^OPENAI_API_KEY=" "$AI_NODE_DIR/.env.local"; then
        # Update existing key
        sed -i.bak "s/^OPENAI_API_KEY=.*/OPENAI_API_KEY=$OPENAI_API_KEY/" "$AI_NODE_DIR/.env.local"
    else
        # Add new key
        echo "OPENAI_API_KEY=$OPENAI_API_KEY" >> "$AI_NODE_DIR/.env.local"
    fi
    echo -e "${GREEN}OpenAI API Key configured.${NC}"
else
    echo -e "${YELLOW}WARNING: OpenAI API Key not provided. Some AI Node features may not work.${NC}"
fi

if [ -n "$ANTHROPIC_API_KEY" ]; then
    # Check if key already exists in file
    if grep -q "^ANTHROPIC_API_KEY=" "$AI_NODE_DIR/.env.local"; then
        # Update existing key
        sed -i.bak "s/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY/" "$AI_NODE_DIR/.env.local"
    else
        # Add new key
        echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" >> "$AI_NODE_DIR/.env.local"
    fi
    echo -e "${GREEN}Anthropic API Key configured.${NC}"
else
    echo -e "${YELLOW}WARNING: Anthropic API Key not provided. Some AI Node features may not work.${NC}"
fi

if [ -n "$HYPERBOLIC_API_KEY" ]; then
    # Check if key already exists in file
    if grep -q "^HYPERBOLIC_API_KEY=" "$AI_NODE_DIR/.env.local"; then
        # Update existing key
        sed -i.bak "s/^HYPERBOLIC_API_KEY=.*/HYPERBOLIC_API_KEY=$HYPERBOLIC_API_KEY/" "$AI_NODE_DIR/.env.local"
    else
        # Add new key
        echo "HYPERBOLIC_API_KEY=$HYPERBOLIC_API_KEY" >> "$AI_NODE_DIR/.env.local"
    fi
    echo -e "${GREEN}Hyperbolic API Key configured.${NC}"
else
    echo -e "${YELLOW}Note: Hyperbolic API Key not provided. Hyperbolic models will not be available.${NC}"
fi

# Set justifier model from environment configuration
if [ -n "$JUSTIFICATION_MODEL_PROVIDER" ] && [ -n "$JUSTIFICATION_MODEL_NAME" ]; then
    JUSTIFIER_MODEL="$JUSTIFICATION_MODEL_PROVIDER:$JUSTIFICATION_MODEL_NAME"
    echo -e "${BLUE}Using configured justification model: $JUSTIFIER_MODEL${NC}"
else
    # Fallback to new default if not configured
    JUSTIFIER_MODEL="OpenAI:gpt-5-nano-2025-08-07"
    echo -e "${YELLOW}No justification model configured, using default: $JUSTIFIER_MODEL${NC}"
fi

# Update or add justifier model to AI Node configuration
if grep -q "^JUSTIFIER_MODEL=" "$AI_NODE_DIR/.env.local"; then
    sed -i.bak "s/^JUSTIFIER_MODEL=.*/JUSTIFIER_MODEL=$JUSTIFIER_MODEL/" "$AI_NODE_DIR/.env.local"
    echo -e "${GREEN}Justifier model updated to: $JUSTIFIER_MODEL${NC}"
else
    echo "JUSTIFIER_MODEL=$JUSTIFIER_MODEL" >> "$AI_NODE_DIR/.env.local"
    echo -e "${GREEN}Justifier model set to: $JUSTIFIER_MODEL${NC}"
fi

# Set default log level
if ! grep -q "^LOG_LEVEL=" "$AI_NODE_DIR/.env.local"; then
    echo "LOG_LEVEL=info" >> "$AI_NODE_DIR/.env.local"
    echo -e "${GREEN}Default log level set to: info${NC}"
else
    echo -e "${GREEN}Log level already configured in .env.local${NC}"
fi

# Detect OS for Ollama installation
OS="$(uname -s)"
case "$OS" in
    Linux)
        if [ -f /etc/os-release ]; then
            . /etc/os-release
            OS_ID="$ID"
        else
            OS_ID="linux"
        fi
        ;;
    Darwin)
        OS_ID="macos"
        ;;
    *)
        OS_ID="unknown"
        ;;
esac

# Check and update Ollama if needed
echo -e "${BLUE}Checking Ollama installation and version...${NC}"
if command_exists ollama; then
    CURRENT_VERSION=$(ollama --version 2>/dev/null | awk '{print $2}' | sed 's/v//' | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1)
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
        
        if [ "$UPDATE_NEEDED" = "true" ]; then
            
            if ask_yes_no "Would you like to update Ollama to the latest version?"; then
                echo -e "${BLUE}Updating Ollama to version $LATEST_VERSION...${NC}"
                
                # Stop Ollama service if running
                if pgrep -f "ollama serve" > /dev/null; then
                    echo -e "${BLUE}Stopping Ollama service...${NC}"
                    pkill -f "ollama serve" || true
                    sleep 2
                fi
                
                # Download and install latest version
                case "$OS_ID" in
                    ubuntu|debian|linux)
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
                        ;;
                esac
                
                # Verify update
                if command_exists ollama; then
                    NEW_VERSION=$(ollama --version 2>/dev/null | awk '{print $2}' | sed 's/v//' | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1)
                    if [ -n "$NEW_VERSION" ] && [ "$NEW_VERSION" = "$LATEST_VERSION" ]; then
                        echo -e "${GREEN}Successfully updated Ollama to version $NEW_VERSION${NC}"
                    elif [ -n "$NEW_VERSION" ]; then
                        echo -e "${YELLOW}Ollama was updated to version $NEW_VERSION (expected $LATEST_VERSION)${NC}"
                    else
                        echo -e "${YELLOW}Ollama was updated but version could not be determined${NC}"
                    fi
                else
                    echo -e "${RED}Failed to update Ollama. Please install manually.${NC}"
                fi
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
        echo -e "${BLUE}Installing latest Ollama...${NC}"
        
        case "$OS_ID" in
            ubuntu|debian|linux)
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
                ;;
        esac
        
        # Verify installation
        if command_exists ollama; then
            INSTALLED_VERSION=$(ollama --version 2>/dev/null | awk '{print $2}' | sed 's/v//' | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1)
            if [ -n "$INSTALLED_VERSION" ]; then
                echo -e "${GREEN}Successfully installed Ollama version $INSTALLED_VERSION${NC}"
            else
                echo -e "${GREEN}Successfully installed Ollama (version could not be determined)${NC}"
            fi
        else
            echo -e "${RED}Failed to install Ollama. Please install manually.${NC}"
        fi
    else
        echo -e "${YELLOW}Skipping Ollama installation. Ollama-based models will not be available.${NC}"
        echo -e "${YELLOW}You can install Ollama later and the system will detect it automatically.${NC}"
    fi
fi

# Start Ollama service
echo -e "${BLUE}Starting Ollama service...${NC}"
if command_exists ollama; then
    # Check if Ollama is already running
    if ! curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
        # Start Ollama in the background
        ollama serve > /dev/null 2>&1 &
        OLLAMA_PID=$!
        
        # Wait for Ollama to start (up to 30 seconds)
        echo -e "${BLUE}Waiting for Ollama service to start...${NC}"
        for i in {1..30}; do
            if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
                echo -e "${GREEN}Ollama service is running.${NC}"
                break
            fi
            if [ $i -eq 30 ]; then
                echo -e "${RED}Timed out waiting for Ollama service to start.${NC}"
                echo -e "${YELLOW}Please start Ollama manually with 'ollama serve'${NC}"
            fi
            sleep 1
        done
    else
        echo -e "${GREEN}Ollama service is already running.${NC}"
    fi
fi

# Pull Ollama models from ClassID configuration
if command_exists ollama; then
    echo -e "${BLUE}Checking Ollama models from ClassID configuration...${NC}"
    
    # Verify Ollama is responding
    if ! curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
        echo -e "${RED}Error: Could not connect to Ollama service. Please ensure it is running with 'ollama serve'${NC}"
        exit 1
    fi
    
    # Get list of installed models
    INSTALLED_MODELS=$(ollama list)
    
    # Extract Ollama models from the updated models.ts configuration
    OLLAMA_MODELS=()
    if [ -f "$AI_NODE_DIR/src/config/models.ts" ]; then
        # Parse Ollama models from the configuration file
        while IFS= read -r line; do
            if echo "$line" | grep -q "name:.*'" && echo "$line" | grep -v "//"; then
                model_name=$(echo "$line" | sed "s/.*name: *['\"]\\([^'\"]*\\)['\"].*/\\1/")
                if [ -n "$model_name" ] && [ "$model_name" != "$line" ]; then
                    OLLAMA_MODELS+=("$model_name")
                fi
            fi
        done < <(sed -n '/ollama: \[/,/\]/p' "$AI_NODE_DIR/src/config/models.ts")
    fi
    
    # Add fallback models if no models found in configuration
    if [ ${#OLLAMA_MODELS[@]} -eq 0 ]; then
        echo -e "${YELLOW}No Ollama models found in ClassID configuration. Using fallback models.${NC}"
        OLLAMA_MODELS=("llama3.1:8b" "llava:7b" "deepseek-r1:8b" "qwen3:8b")
    fi
    
    echo -e "${BLUE}Found ${#OLLAMA_MODELS[@]} Ollama models from configuration${NC}"
    
    for model in "${OLLAMA_MODELS[@]}"; do
        if echo "$INSTALLED_MODELS" | grep -q "$model"; then
            echo -e "${GREEN}Ollama model '$model' is already installed.${NC}"
        else
            echo -e "${YELLOW}Ollama model '$model' is not installed.${NC}"
            if ask_yes_no "Would you like to install Ollama model '$model' from ClassID configuration?"; then
                echo -e "${BLUE}Pulling Ollama model '$model'...${NC}"
                ollama pull "$model"
                if [ $? -eq 0 ]; then
                    echo -e "${GREEN}Ollama model '$model' installed successfully.${NC}"
                else
                    echo -e "${RED}Failed to install Ollama model '$model'. You can install it later with: ollama pull $model${NC}"
                fi
            else
                echo -e "${YELLOW}Skipping installation of Ollama model '$model'.${NC}"
            fi
        fi
    done
else
    echo -e "${YELLOW}Ollama is not installed. Skipping model installation.${NC}"
fi

# Function to cleanup existing Next.js processes and ports
cleanup_existing_processes() {
    # First ensure we have netstat available
    if ! command_exists netstat; then
        echo -e "${YELLOW}netstat not found. Installing net-tools...${NC}"
        sudo apt-get update && sudo apt-get install -y net-tools
    fi

    echo -e "${BLUE}Checking for existing Next.js processes...${NC}"
    
    # Check for both 'next dev' and 'next-server' processes
    local next_pids=$(ps aux | grep -E "next dev|next-server" | grep -v grep | awk '{print $2}')
    
    if [ -n "$next_pids" ]; then
        echo -e "${YELLOW}Found existing Next.js processes. Terminating...${NC}"
        for pid in $next_pids; do
            echo -e "${BLUE}Terminating process $pid...${NC}"
            # Try graceful termination first
            kill -15 $pid
            sleep 2
            
            # Check if process still exists
            if ps -p $pid > /dev/null 2>&1; then
                echo -e "${YELLOW}Process $pid still running. Forcing termination...${NC}"
                kill -9 $pid
            fi
        done
        sleep 3
    fi

    # Additional check for any processes using our ports
    echo -e "${BLUE}Checking for processes using ports 3000-3010...${NC}"
    for port in {3000..3010}; do
        # Get all processes using this port
        local port_pids=$(lsof -ti:$port)
        if [ -n "$port_pids" ]; then
            echo -e "${YELLOW}Found processes using port $port. Terminating...${NC}"
            for pid in $port_pids; do
                echo -e "${BLUE}Terminating process $pid...${NC}"
                kill -9 $pid
            done
            sleep 1
        fi
        
        # Check for lingering sockets
        if netstat -an | grep -q ":$port .*"; then
            echo -e "${YELLOW}Found socket on port $port. Attempting to release...${NC}"
            # Adjust socket parameters
            echo -e "${BLUE}Adjusting socket parameters...${NC}"
            # Reduce TIME_WAIT timeout
            sudo sysctl -w net.ipv4.tcp_fin_timeout=15 > /dev/null
            # Enable socket reuse
            sudo sysctl -w net.ipv4.tcp_tw_reuse=1 > /dev/null
            # Allow reuse of sockets in TIME_WAIT state
            sudo sysctl -w net.ipv4.tcp_tw_recycle=1 > /dev/null 2>&1 || true
            sleep 2
        fi
    done

    # Wait for sockets to clear
    sleep 5

    # Final check for any remaining processes
    local remaining_pids=$(ps aux | grep -E "next dev|next-server" | grep -v grep | awk '{print $2}')
    if [ -n "$remaining_pids" ]; then
        echo -e "${RED}Some Next.js processes are still running. Forcing termination...${NC}"
        for pid in $remaining_pids; do
            echo -e "${BLUE}Force terminating process $pid...${NC}"
            kill -9 $pid 2>/dev/null || true
        done
        sleep 2
    fi

    # Double check ports are clear
    local ports_in_use=false
    for port in {3000..3010}; do
        if lsof -i:$port >/dev/null 2>&1 || netstat -an | grep -q ":$port .*LISTEN"; then
            echo -e "${RED}Port $port is still in use${NC}"
            echo -e "${YELLOW}Port $port status:${NC}"
            netstat -anp 2>/dev/null | grep ":$port " || true
            lsof -i:$port 2>/dev/null || true
            ports_in_use=true
        fi
    done

    if [ "$ports_in_use" = true ]; then
        echo -e "${RED}Some ports are still in use. Attempting final cleanup...${NC}"
        # Final attempt to kill any process using our ports
        for port in {3000..3010}; do
            fuser -k $port/tcp 2>/dev/null || true
        done
        sleep 2
        
        # One last check
        local final_check=false
        for port in {3000..3010}; do
            if lsof -i:$port >/dev/null 2>&1 || netstat -an | grep -q ":$port .*LISTEN"; then
                final_check=true
                break
            fi
        done
        
        if [ "$final_check" = true ]; then
            echo -e "${RED}Failed to clear all ports. Please check manually with:${NC}"
            echo -e "${YELLOW}netstat -anp | grep ':(3000|3001|3002|3003)'${NC}"
            echo -e "${YELLOW}lsof -i:3000-3010${NC}"
            return 1
        fi
    fi
    
    echo -e "${GREEN}All ports cleared successfully.${NC}"
    return 0
}

# Function to ensure port 3000 is available
wait_for_port() {
    local port=$1
    local timeout=$2
    local start_time=$(date +%s)
    
    while true; do
        # Check using both lsof and netstat
        if ! (lsof -i:$port >/dev/null 2>&1 || netstat -an | grep -q ":$port .*"); then
            return 0
        fi
        
        local current_time=$(date +%s)
        local elapsed=$((current_time - start_time))
        
        if [ $elapsed -ge $timeout ]; then
            # Show detailed information about what's using the port
            echo -e "${YELLOW}Port $port status:${NC}"
            netstat -anp 2>/dev/null | grep ":$port " || true
            lsof -i:$port 2>/dev/null || true
            return 1
        fi
        
        sleep 1
    done
}

# Test AI Node
echo -e "${BLUE}Testing AI Node installation...${NC}"

# Cleanup any existing processes first
if ! cleanup_existing_processes; then
    echo -e "${RED}Failed to cleanup existing processes. Please check manually.${NC}"
    exit 1
fi

# Wait for port 3000 to be available
echo -e "${BLUE}Waiting for port 3000 to be available...${NC}"
if ! wait_for_port 3000 30; then
    echo -e "${RED}Timed out waiting for port 3000 to be available${NC}"
    echo -e "${YELLOW}Please check what's using port 3000 with: lsof -i:3000${NC}"
    exit 1
fi

# Function to cleanup test instance
cleanup_test_instance() {
    echo -e "${BLUE}Cleaning up test instance...${NC}"
    if [ -n "$AI_NODE_PID" ]; then
        echo -e "${BLUE}Stopping AI Node parent process $AI_NODE_PID...${NC}"
        kill -15 $AI_NODE_PID 2>/dev/null || true
        sleep 2
        
        # Force kill if still running
        if ps -p $AI_NODE_PID > /dev/null 2>&1; then
            echo -e "${YELLOW}Force killing AI Node process...${NC}"
            kill -9 $AI_NODE_PID 2>/dev/null || true
        fi
    fi
    
    # Cleanup any remaining next-server processes
    local server_pids=$(ps aux | grep "next-server" | grep -v grep | awk '{print $2}')
    if [ -n "$server_pids" ]; then
        echo -e "${BLUE}Stopping next-server processes...${NC}"
        for pid in $server_pids; do
            echo -e "${BLUE}Killing process $pid...${NC}"
            kill -9 $pid 2>/dev/null || true
        done
    fi
    
    # Final verification
    if ps aux | grep -E "next dev|next-server" | grep -v grep > /dev/null; then
        echo -e "${RED}Warning: Some Next.js processes are still running. Please check manually with:${NC}"
        echo -e "${YELLOW}ps aux | grep -E \"next dev|next-server\" | grep -v grep${NC}"
    else
        echo -e "${GREEN}All Next.js processes cleaned up successfully.${NC}"
    fi
}

# Ensure cleanup happens even if script exits
trap cleanup_test_instance EXIT

echo -e "${BLUE}Starting AI Node for testing...${NC}"
# Set the port explicitly
PORT=3000 npm run dev &
AI_NODE_PID=$!

# Wait for server to start
echo -e "${BLUE}Waiting for AI Node to start...${NC}"
sleep 5

# Test if server is running
if curl -s http://localhost:3000/api/health | grep -q '"status":"ok"'; then
    echo -e "${GREEN}AI Node is running and responding to health checks.${NC}"
else
    echo -e "${RED}AI Node is not responding to health checks. Please check the logs for errors.${NC}"
    cleanup_test_instance
    exit 1
fi

# Cleanup test instance
cleanup_test_instance

# Create a service file for AI Node
echo -e "${BLUE}Creating AI Node service...${NC}"

# Create start script
cat > "$AI_NODE_DIR/start.sh" << 'EOLS'
#!/bin/bash
cd "$(dirname "$0")"

# Load NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# Use the correct Node.js version
nvm use 20.18.1 || nvm install 20.18.1

# Verify Node.js version
node_version=$(node --version)
echo "Using Node.js version: $node_version"

# Cleanup any existing instances first
echo "Checking for existing Next.js processes..."
existing_pids=$(ps aux | grep -E "next dev|next-server" | grep -v grep | awk '{print $2}')
if [ -n "$existing_pids" ]; then
    echo "Found existing processes. Terminating..."
    for pid in $existing_pids; do
        echo "Killing process $pid..."
        kill -9 $pid 2>/dev/null || true
    done
    sleep 2
fi

# Get the directory path and current timestamp for log file
LOG_DIR="$(pwd)/logs"
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
LOG_FILE="$LOG_DIR/ai-node_${TIMESTAMP}.log"

# Start the server in persistent background mode
echo "Starting AI Node in persistent mode..."
echo "Logs will be available at: $LOG_FILE"

# Use nohup to keep the process running after terminal disconnects
export PORT=3000
nohup npm run dev > "$LOG_FILE" 2>&1 &
echo $! > ai-node.pid
echo "AI Node started with PID $(cat ai-node.pid)"
EOLS

# Create stop script
cat > "$AI_NODE_DIR/stop.sh" << 'EOLT'
#!/bin/bash
echo "Stopping AI Node..."
if [ -f ai-node.pid ]; then
    pid=$(cat ai-node.pid)
    echo "Found PID file, stopping process $pid..."
    kill -15 $pid 2>/dev/null || kill -9 $pid 2>/dev/null
    rm ai-node.pid
fi

# Cleanup any remaining processes
ps aux | grep -E "next dev|next-server" | grep -v grep | awk '{print $2}' | xargs -r kill -9
sleep 2
if ps aux | grep -E "next dev|next-server" | grep -v grep > /dev/null; then
    echo "Warning: Some processes are still running"
else
    echo "AI Node stopped successfully"
fi
EOLT

# Make scripts executable
chmod +x "$AI_NODE_DIR/start.sh"
chmod +x "$AI_NODE_DIR/stop.sh"

# Verify scripts were created
if [ ! -f "$AI_NODE_DIR/start.sh" ] || [ ! -f "$AI_NODE_DIR/stop.sh" ]; then
    echo -e "${RED}Error: Failed to create service scripts${NC}"
    exit 1
fi

echo -e "${GREEN}AI Node installation completed!${NC}"
echo -e "${BLUE}Service scripts created:${NC}"
echo -e "  To start: cd $AI_NODE_DIR && ./start.sh"
echo -e "  To stop:  cd $AI_NODE_DIR && ./stop.sh"
echo
echo -e "${BLUE}Note: AI Node will be available to start after the full installation completes.${NC}"

# Remove the cleanup trap before exiting
trap - EXIT
exit 0 