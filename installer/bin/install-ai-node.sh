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

# Set default justifier model
if ! grep -q "^JUSTIFIER_MODEL=" "$AI_NODE_DIR/.env.local"; then
    echo -e "${YELLOW}Please configure the justifier model.${NC}"
    echo -e "${BLUE}Format: Provider:Model (e.g., OpenAI:gpt-4o)${NC}"
    read -p "Enter justifier model configuration [OpenAI:gpt-4o]: " justifier_model
    if [ -n "$justifier_model" ]; then
        echo "JUSTIFIER_MODEL=$justifier_model" >> "$AI_NODE_DIR/.env.local"
        echo -e "${GREEN}Justifier model set to: $justifier_model${NC}"
    else
        echo "JUSTIFIER_MODEL=OpenAI:gpt-4o" >> "$AI_NODE_DIR/.env.local"
        echo -e "${GREEN}Using default justifier model: OpenAI:gpt-4o${NC}"
    fi
else
    # Update existing justifier model if it's the placeholder
    if grep -q "^JUSTIFIER_MODEL={Provider:Model}" "$AI_NODE_DIR/.env.local"; then
        echo -e "${YELLOW}Current justifier model is a placeholder.${NC}"
        echo -e "${BLUE}Format: Provider:Model (e.g., OpenAI:gpt-4o)${NC}"
        read -p "Enter justifier model configuration [OpenAI:gpt-4o]: " justifier_model
        if [ -n "$justifier_model" ]; then
            sed -i.bak "s/^JUSTIFIER_MODEL=.*/JUSTIFIER_MODEL=$justifier_model/" "$AI_NODE_DIR/.env.local"
            echo -e "${GREEN}Justifier model updated to: $justifier_model${NC}"
        else
            sed -i.bak "s/^JUSTIFIER_MODEL=.*/JUSTIFIER_MODEL=OpenAI:gpt-4o/" "$AI_NODE_DIR/.env.local"
            echo -e "${GREEN}Justifier model updated to default: OpenAI:gpt-4o${NC}"
        fi
    fi
fi

# Set default log level
if ! grep -q "^LOG_LEVEL=" "$AI_NODE_DIR/.env.local"; then
    echo "LOG_LEVEL=info" >> "$AI_NODE_DIR/.env.local"
    echo -e "${GREEN}Default log level set to: info${NC}"
else
    echo -e "${GREEN}Log level already configured in .env.local${NC}"
fi

# Install Ollama
echo -e "${BLUE}Checking for Ollama...${NC}"
if command_exists ollama; then
    echo -e "${GREEN}Ollama is already installed.${NC}"
else
    echo -e "${YELLOW}Ollama is not installed.${NC}"
    if ask_yes_no "Would you like to install Ollama?"; then
        echo -e "${BLUE}Installing Ollama...${NC}"
        curl -fsSL https://ollama.com/install.sh | sh
        
        if ! command_exists ollama; then
            echo -e "${RED}Failed to install Ollama. Please install manually.${NC}"
        else
            echo -e "${GREEN}Ollama installed successfully.${NC}"
        fi
    else
        echo -e "${YELLOW}Skipping Ollama installation. Some AI Node features may not work.${NC}"
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

# Pull recommended Ollama models
if command_exists ollama; then
    echo -e "${BLUE}Checking Ollama models...${NC}"
    
    # Verify Ollama is responding
    if ! curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
        echo -e "${RED}Error: Could not connect to Ollama service. Please ensure it is running with 'ollama serve'${NC}"
        exit 1
    fi
    
    # Get list of installed models
    INSTALLED_MODELS=$(ollama list)
    
    # Define recommended models
    RECOMMENDED_MODELS=("phi3" "llama3.1" "llama3.2" "llava" "deepseek-r1:8b")
    
    for model in "${RECOMMENDED_MODELS[@]}"; do
        if echo "$INSTALLED_MODELS" | grep -q "$model"; then
            echo -e "${GREEN}Ollama model '$model' is already installed.${NC}"
        else
            echo -e "${YELLOW}Ollama model '$model' is not installed.${NC}"
            if ask_yes_no "Would you like to install Ollama model '$model'?"; then
                echo -e "${BLUE}Pulling Ollama model '$model'...${NC}"
                ollama pull "$model"
                echo -e "${GREEN}Ollama model '$model' installed.${NC}"
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