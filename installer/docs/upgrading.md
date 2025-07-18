# Upgrading the Verdikta Arbiter Node

This document explains how to use the `upgrade-arbiter.sh` script to upgrade an existing Verdikta Arbiter installation with the latest code.

## Overview

The upgrade process:
1. Checks for changes between your installed Arbiter and the current repository
2. Creates a backup of your current installation
3. Stops the Arbiter if it's running
4. Updates components while preserving your configuration
5. Restarts the Arbiter if it was running before the upgrade

## Prerequisites

- An existing Verdikta Arbiter installation
- The latest version of the `verdikta-arbiter` repository
- Sufficient disk space for a backup of your current installation

## Upgrade Steps

1. Clone or update the Verdikta Arbiter repository:
   ```bash
   # If you don't have the repository yet
   git clone https://github.com/verdikta/verdikta-arbiter.git
   cd verdikta-arbiter
   
   # If you already have the repository
   cd verdikta-arbiter
   git pull
   ```

2. Run the upgrade script:
   ```bash
   cd installer
   bash bin/upgrade-arbiter.sh
   ```

3. When prompted, enter the path to your existing Arbiter installation:
   ```
   Enter the target installation directory [/root/verdikta-arbiter-node]:
   ```
   The default will be the same directory used during initial installation.

4. The script will check for changes in each component:
   ```
   Checking for changes in AI Node...
   Found 12 changes in AI Node:
   - 12 new or modified files
   - 0 files to be removed
   
   Checking for changes in External Adapter...
   Found 3 changes in External Adapter:
   - 3 new or modified files
   - 0 files to be removed
   
   ...
   ```

5. If changes are detected, you'll be asked to confirm the upgrade:
   ```
   Changes were detected in the following components:
   - AI Node
   - External Adapter
   - Management Scripts
   
   Do you want to proceed with the upgrade? (y/n):
   ```

6. If your Arbiter is currently running, the script will inform you and ask for confirmation before stopping it:
   ```
   Arbiter is currently running and will be stopped for the upgrade.
   Do you want to continue? (y/n):
   ```

7. The script will create a backup before making any changes:
   ```
   Creating backup of current installation...
   Backup created at: /root/verdikta-arbiter-node_backup_20230815-123045
   ```

8. The script will then upgrade each component that has changes:
   ```
   Starting upgrade process...
   Upgrading AI Node...
   Successfully upgraded AI Node.
   
   Upgrading External Adapter...
   Successfully upgraded External Adapter.
   
   Upgrading management scripts...
   Updated start-arbiter.sh
   Updated stop-arbiter.sh
   Updated arbiter-status.sh
   
   Upgrade completed successfully!
   ```

9. If your Arbiter was running, you'll be asked if you want to restart it:
   ```
   Do you want to restart the arbiter now? (y/n):
   ```

## What Gets Preserved During Upgrade

The upgrade process preserves:

- **AI Node**: 
  - `.env.local` file with API keys
  - Log files
  - Node modules

- **External Adapter**:
  - `.env` file with configuration settings
  - Log files
  - Node modules

- **Chainlink Node**:
  - Configuration files (`.toml` files)
  - Log files
  - Database data
  - `.api` file with login credentials

- **Contract Information**:
  - `.contracts` file with deployment addresses and configuration

## Important Configuration Files and Their Locations

After installation or upgrade, important configuration and data files are stored in these locations:

### Contract Information
- **Path**: `~/verdikta-arbiter-node/installer/.contracts`
- **Contains**: 
  - Operator contract address
  - Node address
  - LINK token address
  - Job ID (with and without hyphens)
  - Aggregator address
  - Classes ID (when registered with an aggregator)

### Chainlink Node Credentials
- **Path**: `~/verdikta-arbiter-node/chainlink-node/info.txt`
- **Contains**: 
  - UI login email
  - UI login password
  - Keystore password
  - Configuration directory location

### Environment Variables
- **AI Node**: `~/verdikta-arbiter-node/ai-node/.env.local`
- **External Adapter**: `~/verdikta-arbiter-node/external-adapter/.env`
- **Chainlink Node**: `~/.chainlink-sepolia/.api` (for UI credentials)

## Querying Oracle Contract Information

The installer includes a script to query information about registered oracles:

### Using query-oracle-classes.js

This script allows you to verify if your oracle is registered with an aggregator and check its class ID:

1. Navigate to the arbiter-operator directory:
   ```bash
   cd ~/verdikta-arbiter/arbiter-operator
   ```

2. Run the query script with your contract addresses:
   ```bash
   HARDHAT_NETWORK=base_sepolia node scripts/query-oracle-classes.js \
     --aggregator YOUR_AGGREGATOR_ADDRESS \
     --oracle YOUR_OPERATOR_ADDRESS \
     --jobid YOUR_JOB_ID_WITHOUT_HYPHENS
   ```

3. You can get these values from your `.contracts` file:
   ```bash
   cat ~/verdikta-arbiter-node/installer/.contracts
   ```

4. Example output:
   ```
   ReputationKeeper: 0x6def65a003F9d9d80Cb9f6216dBF0282c8563a27

   Querying information for Oracle: 0x91A5fe7FC3A729BD38602d4bD5a7F9b6aCA6C7A9
   JobID: 517f743acd75461c840ea0a93164285c → 0x3531376637343361636437353436316338343065613061393331363432383563

   Oracle Status:
     Active: true
     Reputation: 0
     Min Reputation: 0
     Fee: 0.0 LINK
     Staked Amount: 0.0 wVDKA

   Registered Class ID: 128
   ```

This information is useful for verifying your oracle's registration status and configuration when integrating with client applications.

## Troubleshooting

### The upgrade failed or caused issues

If you encounter problems after upgrading, you can restore from the backup:

```bash
# Stop the arbiter if it's running
cd /path/to/verdikta-arbiter-node
./stop-arbiter.sh

# Remove or rename the problematic directory
mv /path/to/verdikta-arbiter-node /path/to/verdikta-arbiter-node-broken

# Restore from backup
cp -r /path/to/verdikta-arbiter-node_backup_TIMESTAMP /path/to/verdikta-arbiter-node

# Restart the arbiter
cd /path/to/verdikta-arbiter-node
./start-arbiter.sh
```

### The script doesn't detect my installation

Ensure your installation matches the expected structure:
- It should have `ai-node`, `external-adapter`, and `chainlink-node` directories
- It should have the management scripts: `start-arbiter.sh`, `stop-arbiter.sh`, and `arbiter-status.sh`

### Components fail to restart after upgrade

If components don't restart properly:

1. Check the logs:
   - AI Node: `/path/to/verdikta-arbiter-node/ai-node/logs/`
   - External Adapter: `/path/to/verdikta-arbiter-node/external-adapter/logs/`
   - Chainlink Node: `docker logs chainlink`

2. Try stopping and starting manually:
   ```bash
   cd /path/to/verdikta-arbiter-node
   ./stop-arbiter.sh
   # Wait a moment
   ./start-arbiter.sh
   ```

## Additional Notes

- The upgrade process doesn't modify your database or blockchain state
- It's recommended to perform upgrades during maintenance windows
- Always ensure you have sufficient disk space for the backup
- If you've made custom modifications to the code, they may be overwritten during upgrade 