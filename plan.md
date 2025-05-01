# Verdikta Arbiter Installer Restructuring Plan

## Overview

This document outlines the changes made to move the installer scripts from the external-adapter repository to the top level of the verdikta-arbiter repository, and to update them to work with the new consolidated repository structure.

## Key Changes

1. **Installer Location**: Moved from `external-adapter/installer/` to the top-level `installer/` directory.

2. **Repository Structure Changes**:
   - Changed from several separate git repositories to a single consolidated repository
   - Updated all scripts to work with the local directories instead of cloning from GitHub

3. **Terminology Update**:
   - Changed all references from "validator" to "arbiter" to reflect the correct terminology

4. **Component Installation Updates**:
   - AI Node: Now copied from local directory instead of cloning from GitHub
   - External Adapter: Now copied from local directory instead of cloning from GitHub
   - Chainlink Node: Now uses configs from local directory
   - Demo Client: Now copied from local directory instead of using fixed-client

5. **Management Scripts**:
   - `start-arbiter.sh`: Updated to manage the local components
   - `stop-arbiter.sh`: Created to properly shut down all components
   - `arbiter-status.sh`: Created to check component status and report issues

## Directory Structure

The updated directory structure is as follows:

```
verdikta-arbiter/
├── ai-node/                # AI Node component
├── external-adapter/       # External Adapter component
├── chainlink-node/         # Chainlink Node configs and contracts
├── demo-client/            # Client contract for testing
└── installer/              # Installation scripts
    ├── bin/                # Main installation scripts
    ├── config/             # Configuration templates
    ├── docs/               # Documentation
    ├── util/               # Utility scripts
    └── README.md           # Installation guide
```

## Usage

To install a Verdikta arbiter:

1. Clone the repository:
   ```
   git clone https://github.com/verdikta/verdikta-arbiter.git
   cd verdikta-arbiter
   ```

2. Run the installer:
   ```
   cd installer
   bash bin/install.sh
   ```

3. After installation, use the management scripts:
   - `~/verdikta/start-arbiter.sh` - Start all components
   - `~/verdikta/stop-arbiter.sh` - Stop all components
   - `~/verdikta/arbiter-status.sh` - Check component status

## Next Steps

1. Test the installer in a clean environment
2. Update documentation to reflect the new structure
3. Create any additional scripts needed for specific deployment scenarios 