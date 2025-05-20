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