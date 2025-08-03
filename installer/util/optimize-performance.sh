#!/bin/bash

# Verdikta Arbiter Performance Optimization Script
# Applies performance optimizations to Chainlink and PostgreSQL

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALLER_DIR="$(dirname "$SCRIPT_DIR")"

echo -e "${BLUE}Verdikta Arbiter Performance Optimization${NC}\n"

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

# Load environment variables
if [ -f "$INSTALLER_DIR/.env" ]; then
    source "$INSTALLER_DIR/.env"
else
    echo -e "${RED}Error: Environment file not found. Cannot proceed.${NC}"
    exit 1
fi

# Find Chainlink directory
CHAINLINK_DIR=""
for dir in "$HOME/.chainlink-testnet" "$HOME/.chainlink-mainnet" "$HOME/.chainlink-sepolia"; do
    if [ -d "$dir" ]; then
        CHAINLINK_DIR="$dir"
        break
    fi
done

if [ -z "$CHAINLINK_DIR" ]; then
    echo -e "${RED}Error: Chainlink directory not found${NC}"
    exit 1
fi

echo -e "Found Chainlink directory: ${GREEN}$CHAINLINK_DIR${NC}"

# 1. Backup current configuration
echo -e "\n${BLUE}1. Backing up current configuration...${NC}"
BACKUP_DIR="$CHAINLINK_DIR/backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp "$CHAINLINK_DIR/config.toml" "$BACKUP_DIR/config.toml.backup" 2>/dev/null || echo -e "${YELLOW}No existing config.toml found${NC}"
echo -e "Backup created: ${GREEN}$BACKUP_DIR${NC}"

# 2. Apply optimized Chainlink configuration
echo -e "\n${BLUE}2. Applying optimized Chainlink configuration...${NC}"

OPTIMIZED_TEMPLATE="$(dirname "$INSTALLER_DIR")/chainlink-node/config_template_optimized.toml"

if [ ! -f "$OPTIMIZED_TEMPLATE" ]; then
    echo -e "${RED}Error: Optimized template not found at $OPTIMIZED_TEMPLATE${NC}"
    exit 1
fi

if ask_yes_no "Apply optimized Chainlink configuration?"; then
    # Set network-specific configuration values
    if [ "$DEPLOYMENT_NETWORK" = "base_mainnet" ]; then
        CHAIN_ID="8453"
        TIP_CAP_DEFAULT="1 gwei"
        FEE_CAP_DEFAULT="10 gwei"
        NETWORK_NAME_CONFIG="Base-Mainnet"
        
        # Load API keys for mainnet
        if [ -f "$INSTALLER_DIR/.api_keys" ]; then
            source "$INSTALLER_DIR/.api_keys"
            WS_URL="wss://base-mainnet.infura.io/ws/v3/$INFURA_API_KEY"
            HTTP_URL="https://base-mainnet.infura.io/v3/$INFURA_API_KEY"
        else
            echo -e "${YELLOW}Warning: API keys not found${NC}"
            WS_URL="wss://base-mainnet.infura.io/ws/v3/YOUR_API_KEY"
            HTTP_URL="https://base-mainnet.infura.io/v3/YOUR_API_KEY"
        fi
    else
        # Default to Base Sepolia
        CHAIN_ID="84532"
        TIP_CAP_DEFAULT="2 gwei"
        FEE_CAP_DEFAULT="30 gwei"
        NETWORK_NAME_CONFIG="Base-Sepolia"
        
        # Load API keys for testnet
        if [ -f "$INSTALLER_DIR/.api_keys" ]; then
            source "$INSTALLER_DIR/.api_keys"
            WS_URL="wss://base-sepolia.infura.io/ws/v3/$INFURA_API_KEY"
            HTTP_URL="https://base-sepolia.infura.io/v3/$INFURA_API_KEY"
        else
            echo -e "${YELLOW}Warning: API keys not found${NC}"
            WS_URL="wss://base-sepolia.infura.io/ws/v3/YOUR_API_KEY"
            HTTP_URL="https://base-sepolia.infura.io/v3/YOUR_API_KEY"
        fi
    fi
    
    # Create optimized config.toml
    sed -e "s/<CHAIN_ID>/$CHAIN_ID/g" \
        -e "s/<TIP_CAP_DEFAULT>/$TIP_CAP_DEFAULT/g" \
        -e "s/<FEE_CAP_DEFAULT>/$FEE_CAP_DEFAULT/g" \
        -e "s/<NETWORK_NAME>/$NETWORK_NAME_CONFIG/g" \
        -e "s|<WS_URL>|$WS_URL|g" \
        -e "s|<HTTP_URL>|$HTTP_URL|g" \
        "$OPTIMIZED_TEMPLATE" > "$CHAINLINK_DIR/config.toml"
    
    echo -e "${GREEN}Optimized Chainlink configuration applied${NC}"
else
    echo -e "${YELLOW}Skipping Chainlink configuration optimization${NC}"
fi

# 3. Optimize PostgreSQL configuration
echo -e "\n${BLUE}3. Optimizing PostgreSQL configuration...${NC}"

if ask_yes_no "Apply PostgreSQL performance optimizations?"; then
    echo -e "Creating optimized PostgreSQL configuration..."
    
    # Create custom postgresql.conf
    cat > "/tmp/postgresql_optimized.conf" << 'EOF'
# Optimized PostgreSQL configuration for Chainlink
# Memory settings
shared_buffers = 256MB
effective_cache_size = 1GB
work_mem = 16MB
maintenance_work_mem = 64MB

# Connection settings  
max_connections = 100
shared_preload_libraries = 'pg_stat_statements'

# Checkpoint settings
checkpoint_timeout = 10min
checkpoint_completion_target = 0.9
wal_buffers = 16MB
default_statistics_target = 100

# Query performance
random_page_cost = 1.1
effective_io_concurrency = 200

# Logging (for debugging)
log_min_duration_statement = 1000  # Log slow queries
log_checkpoints = on
log_connections = on
log_disconnections = on
log_lock_waits = on

# WAL settings
wal_level = replica
max_wal_size = 2GB
min_wal_size = 80MB

# Autovacuum optimization
autovacuum = on
autovacuum_max_workers = 3
autovacuum_naptime = 20s
autovacuum_vacuum_threshold = 50
autovacuum_analyze_threshold = 50
EOF

    # Apply to PostgreSQL container
    if docker ps | grep -q "cl-postgres"; then
        echo -e "Copying optimized configuration to PostgreSQL container..."
        docker cp "/tmp/postgresql_optimized.conf" cl-postgres:/etc/postgresql/postgresql.conf
        
        # Create a script to modify postgresql.conf
        cat > "/tmp/apply_pg_config.sh" << 'EOF'
#!/bin/bash
# Update postgresql.conf with optimized settings
sed -i "s/#shared_buffers = 128MB/shared_buffers = 256MB/" /var/lib/postgresql/data/postgresql.conf
sed -i "s/#effective_cache_size = 4GB/effective_cache_size = 1GB/" /var/lib/postgresql/data/postgresql.conf
sed -i "s/#work_mem = 4MB/work_mem = 16MB/" /var/lib/postgresql/data/postgresql.conf
sed -i "s/#maintenance_work_mem = 64MB/maintenance_work_mem = 64MB/" /var/lib/postgresql/data/postgresql.conf
sed -i "s/#max_connections = 100/max_connections = 100/" /var/lib/postgresql/data/postgresql.conf
sed -i "s/#checkpoint_timeout = 5min/checkpoint_timeout = 10min/" /var/lib/postgresql/data/postgresql.conf
sed -i "s/#wal_buffers = -1/wal_buffers = 16MB/" /var/lib/postgresql/data/postgresql.conf
sed -i "s/#random_page_cost = 4.0/random_page_cost = 1.1/" /var/lib/postgresql/data/postgresql.conf
sed -i "s/#effective_io_concurrency = 1/effective_io_concurrency = 200/" /var/lib/postgresql/data/postgresql.conf
sed -i "s/#log_min_duration_statement = -1/log_min_duration_statement = 1000/" /var/lib/postgresql/data/postgresql.conf
EOF
        
        docker cp "/tmp/apply_pg_config.sh" cl-postgres:/tmp/apply_pg_config.sh
        docker exec cl-postgres chmod +x /tmp/apply_pg_config.sh
        docker exec cl-postgres /tmp/apply_pg_config.sh
        
        echo -e "${GREEN}PostgreSQL configuration optimized${NC}"
        echo -e "${YELLOW}Note: PostgreSQL restart required for some changes to take effect${NC}"
    else
        echo -e "${YELLOW}PostgreSQL container not running - cannot apply optimizations${NC}"
    fi
    
    # Cleanup temp files
    rm -f "/tmp/postgresql_optimized.conf" "/tmp/apply_pg_config.sh"
else
    echo -e "${YELLOW}Skipping PostgreSQL optimization${NC}"
fi

# 4. Restart services if requested
echo -e "\n${BLUE}4. Restart services to apply changes?${NC}"
if ask_yes_no "Restart Chainlink and PostgreSQL to apply optimizations?"; then
    echo -e "Restarting services..."
    
    # Restart PostgreSQL first
    if docker ps | grep -q "cl-postgres"; then
        echo -e "Restarting PostgreSQL..."
        docker restart cl-postgres
        
        # Wait for PostgreSQL to be ready
        echo -e "Waiting for PostgreSQL to restart..."
        sleep 10
        for i in {1..30}; do
            if docker exec cl-postgres pg_isready -q; then
                echo -e "${GREEN}PostgreSQL is ready${NC}"
                break
            fi
            if [ $i -eq 30 ]; then
                echo -e "${YELLOW}PostgreSQL taking longer than expected${NC}"
            fi
            sleep 2
        done
    fi
    
    # Restart Chainlink
    if docker ps | grep -q "chainlink"; then
        echo -e "Restarting Chainlink..."
        docker restart chainlink
        
        # Wait for Chainlink to be ready
        echo -e "Waiting for Chainlink to restart..."
        sleep 15
        for i in {1..30}; do
            if curl -s http://localhost:6688/health > /dev/null; then
                echo -e "${GREEN}Chainlink is ready${NC}"
                break
            fi
            if [ $i -eq 30 ]; then
                echo -e "${YELLOW}Chainlink taking longer than expected${NC}"
            fi
            sleep 3
        done
    fi
    
    echo -e "${GREEN}Services restarted${NC}"
else
    echo -e "${YELLOW}Services not restarted - manual restart required for changes to take effect${NC}"
fi

# 5. Summary
echo -e "\n${BLUE}Optimization Summary:${NC}"
echo -e "- Configuration backup: $BACKUP_DIR"
echo -e "- Chainlink config: $([ -f "$CHAINLINK_DIR/config.toml" ] && echo "Updated" || echo "Not changed")"
echo -e "- PostgreSQL optimizations: Applied (restart required)"
echo -e "- Services: $(docker ps | grep -q "chainlink\|cl-postgres" && echo "Running" || echo "Check status")"

echo -e "\n${GREEN}Performance optimization completed!${NC}"
echo -e "\n${YELLOW}Recommended next steps:${NC}"
echo -e "1. Monitor job completion rates"
echo -e "2. Check logs: docker logs -f chainlink"
echo -e "3. Use the diagnostic script: ./diagnose-jobs.sh"
echo -e "4. Monitor resource usage with: docker stats"

# Clean up
rm -f "/tmp/postgresql_optimized.conf" "/tmp/apply_pg_config.sh"