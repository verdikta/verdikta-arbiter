# Automatic Chainlink Key Funding

The `fund-chainlink-keys.sh` script provides automated funding for Chainlink node keys, removing the need for manual ETH transfers to each key address.

## Overview

During Verdikta Arbiter installation, multiple Chainlink keys are created to handle oracle requests. Each key requires native ETH (Base ETH or Base Sepolia ETH) to pay for gas fees when processing arbitration requests. Previously, users had to manually send ETH to each key address - this script automates that process.

## Features

- **Automatic Key Discovery**: Finds all Chainlink keys from your installation
- **Network Detection**: Automatically detects Base Mainnet vs Base Sepolia
- **Balance Checking**: Verifies wallet balance before funding
- **Smart Funding**: Skips keys that already have sufficient funds
- **Transaction Monitoring**: Waits for transaction confirmation
- **Dry Run Mode**: Preview funding without sending transactions
- **Customizable Amounts**: Use recommended amounts or specify custom values

## Usage

### Basic Usage (Interactive)
```bash
# During installation - automatically prompted
./installer/bin/install.sh

# Post-installation from installed directory
~/verdikta-arbiter-node/fund-chainlink-keys.sh
```

### Command Line Options
```bash
# Use recommended amounts (interactive)
~/verdikta-arbiter-node/fund-chainlink-keys.sh

# Use custom amount per key
~/verdikta-arbiter-node/fund-chainlink-keys.sh --amount 0.01

# Preview funding without executing
~/verdikta-arbiter-node/fund-chainlink-keys.sh --dry-run

# Automated funding (no prompts)
~/verdikta-arbiter-node/fund-chainlink-keys.sh --amount 0.005 --force

# Non-interactive mode (for scripts)
~/verdikta-arbiter-node/fund-chainlink-keys.sh --non-interactive --amount 0.003
```

## Recommended Funding Amounts

### Base Sepolia (Testnet)
- **Amount**: 0.005 ETH per key
- **Purpose**: ~50 arbitration queries worth of gas
- **Cost**: Free (testnet currency)

### Base Mainnet (Production)
- **Amount**: 0.002 ETH per key  
- **Purpose**: ~50 arbitration queries worth of gas
- **Cost**: Real ETH (~$5-10 per key depending on ETH price)

## How It Works

1. **Environment Loading**: Reads configuration from installer `.env` and `.contracts` files
2. **Key Discovery**: Finds all `KEY_*_ADDRESS` entries in the contracts file
3. **Network Detection**: Determines Base Mainnet vs Sepolia from deployment configuration
4. **Balance Verification**: Checks funding wallet has sufficient ETH for all transfers plus gas
5. **Transaction Creation**: Uses the deployment wallet's private key to send ETH to each Chainlink key
6. **Confirmation Waiting**: Monitors blockchain for transaction confirmation
7. **Status Reporting**: Provides detailed success/failure reporting

## Security Notes

- **Uses Deployment Key**: Funding uses the same private key used for contract deployment
- **Read-Only Access**: Never stores or modifies private keys
- **Transaction Transparency**: All transactions are visible on BaseScan
- **Balance Verification**: Always checks available balance before proceeding

## Network Configuration

The script automatically detects your network configuration:

### Base Sepolia
- **Chain ID**: 84532
- **RPC**: Infura Base Sepolia endpoint
- **Explorer**: https://sepolia.basescan.org/

### Base Mainnet  
- **Chain ID**: 8453
- **RPC**: Infura Base Mainnet endpoint
- **Explorer**: https://basescan.org/

## Dependencies

The script automatically installs required Python packages:
- `eth-account`: For private key to address conversion and transaction signing
- `web3`: For blockchain interaction
- `bc`: For precise decimal calculations

## Error Handling

Common scenarios and solutions:

### Insufficient Wallet Balance
```
Error: Insufficient wallet balance
Available: 0.001 Base ETH
Required: 0.025 Base ETH (includes gas buffer)
```
**Solution**: Add more ETH to your deployment wallet

### RPC Connection Issues
```
Error: Failed to connect to RPC
```
**Solution**: Check internet connection and Infura API key

### Transaction Failures
```
Transaction may have failed (status: 0x0)
```
**Solution**: Check BaseScan for transaction details, may need to retry with higher gas

### Missing Dependencies
```
Error: eth_account not installed
```
**Solution**: Script will attempt auto-installation, or manually run:
```bash
pip3 install eth-account web3
```

## Integration with Installer

### During Installation
The funding feature is integrated into the main installer workflow:

1. **Automatic Prompt**: After node configuration, users are prompted for automatic funding
2. **Network-Aware**: Shows appropriate amounts and warnings for testnet vs mainnet
3. **Optional Step**: Users can skip and fund manually later
4. **Error Recovery**: If funding fails, installation continues with manual funding instructions

### Post-Installation
The funding script is copied to the installation directory and can be run anytime:

```bash
# From installation directory
~/verdikta-arbiter-node/fund-chainlink-keys.sh

# Check current balances first (dry run)
~/verdikta-arbiter-node/fund-chainlink-keys.sh --dry-run
```

## Transaction Costs

### Gas Estimation
- **Simple Transfer**: ~21,000 gas per transaction
- **Current Gas Price**: Fetched from network (typically 1-2 gwei on Base)
- **Total Cost per Key**: Funding amount + gas cost

### Example Costs (Base Mainnet)
```
Keys to fund: 4
Amount per key: 0.002 ETH
Gas per transaction: ~0.000021 ETH (21,000 gas × 1 gwei)
Total funding: 0.008 ETH
Total gas: 0.000084 ETH  
Total cost: 0.008084 ETH
```

## Troubleshooting

### Check Key Addresses
```bash
# View all configured keys
cat ~/verdikta-arbiter-node/installer/.contracts | grep KEY_.*_ADDRESS
```

### Verify Network Configuration
```bash
# Check deployment network
cat ~/verdikta-arbiter-node/installer/.env | grep DEPLOYMENT_NETWORK
```

### Manual Funding Alternative
If automatic funding fails, you can manually send ETH:
1. Get key addresses from `.contracts` file
2. Send recommended amount to each address using your preferred wallet
3. Verify funding in Chainlink UI at http://localhost:6688

## Support

For issues with the funding script:
1. Check the troubleshooting section above
2. Run with `--dry-run` to preview without executing
3. Verify your wallet has sufficient balance
4. Check network connectivity and API keys
5. Review transaction details on BaseScan

The funding feature enhances the Verdikta Arbiter installation by automating one of the most error-prone manual steps, ensuring your oracle is ready to process requests immediately after installation.
