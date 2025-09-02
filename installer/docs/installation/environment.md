# Environment Setup

Environment configuration is handled automatically by the installer. Manual environment setup is no longer required.

## Automated Configuration

The Verdikta Arbiter installer automatically handles all environment configuration during the installation process. You no longer need to manually configure environment files or settings.

**[→ Go to Automated Installation](automated.md)**

## What Gets Configured Automatically

The installer sets up:

- API key configuration for OpenAI, Anthropic, Web3 providers
- IPFS service configuration  
- Database connection settings
- Chainlink node configuration
- Smart contract addresses
- Logging levels and service settings

## Need to Reconfigure?

If you need to change settings after installation:

1. **Re-run Environment Setup**: `bash bin/setup-environment.sh`
2. **Redeploy Contracts**: `bash bin/deploy-contracts.sh`  
3. **Reconfigure Jobs**: `bash bin/configure-node.sh`

All configuration is handled through the automated scripts for consistency and reliability.
