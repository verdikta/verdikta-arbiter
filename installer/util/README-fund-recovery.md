# Chainlink Fund Recovery

The `recover-chainlink-funds.sh` script provides automated recovery of excess ETH and accumulated LINK tokens from Chainlink node keys back to the owner's wallet. This is useful for recovering over-funded amounts, accumulated LINK rewards, or when decommissioning an oracle node.

## Overview

During oracle operation, Chainlink keys accumulate:
- **ETH**: Used for gas fees, may have excess amounts
- **LINK tokens**: Accumulated from completed oracle requests

The fund recovery script safely transfers these assets back to the owner's wallet while maintaining minimum amounts needed for future operations.

## Features

- **Dual Asset Recovery**: Handles both ETH and LINK token recovery
- **Smart Thresholds**: Leaves minimum ETH for gas fees, configurable thresholds
- **Selective Recovery**: Choose to recover ETH only, LINK only, or both
- **Balance Protection**: Never empties keys completely to avoid operational issues
- **Private Key Export**: Securely exports Chainlink private keys for transaction signing
- **Transaction Monitoring**: Waits for blockchain confirmation
- **Dry Run Mode**: Preview recovery without executing transactions
- **Error Recovery**: Detailed error handling and retry guidance

## Security Model

### How It Works
1. **Key Export**: Exports private keys from Chainlink node using CLI authentication
2. **Balance Analysis**: Checks ETH and LINK balances in each key
3. **Threshold Calculation**: Determines recoverable amounts based on thresholds
4. **Transaction Creation**: Signs transactions using exported private keys
5. **Fund Transfer**: Sends assets to owner's wallet address
6. **Cleanup**: Securely removes temporary private key data

### Security Considerations
- **Temporary Key Access**: Private keys are exported temporarily and cleaned up immediately
- **CLI Authentication**: Uses Chainlink node's existing authentication system
- **No Persistent Storage**: Never stores private keys permanently
- **Owner Verification**: Funds only go to the deployment wallet address
- **Transaction Transparency**: All transactions visible on blockchain explorer

## Usage

### Interactive Mode (Recommended)
```bash
# From installation directory
~/verdikta-arbiter-node/recover-chainlink-funds.sh
```

The script will prompt you to choose:
1. **Recover ETH only** - Get excess ETH, leave LINK tokens
2. **Recover LINK tokens only** - Get LINK rewards, leave ETH for gas
3. **Recover both** - Get all recoverable assets
4. **Cancel** - Exit without making changes

### Command Line Options

#### Selective Recovery
```bash
# Recover only ETH (leave LINK tokens)
~/verdikta-arbiter-node/recover-chainlink-funds.sh --eth-only

# Recover only LINK tokens (leave ETH for gas)
~/verdikta-arbiter-node/recover-chainlink-funds.sh --link-only

# Recover both ETH and LINK tokens
~/verdikta-arbiter-node/recover-chainlink-funds.sh --both
```

#### Custom Thresholds
```bash
# Leave more ETH in keys (0.005 instead of default 0.001)
~/verdikta-arbiter-node/recover-chainlink-funds.sh --eth-threshold 0.005

# Only recover LINK amounts above 1.0 (instead of default 0.1)
~/verdikta-arbiter-node/recover-chainlink-funds.sh --link-threshold 1.0

# Combine with recovery type
~/verdikta-arbiter-node/recover-chainlink-funds.sh --both --eth-threshold 0.002 --link-threshold 0.5
```

#### Automation and Testing
```bash
# Preview without executing (dry run)
~/verdikta-arbiter-node/recover-chainlink-funds.sh --dry-run --both

# Automated recovery (no prompts)
~/verdikta-arbiter-node/recover-chainlink-funds.sh --both --force

# Non-interactive mode for scripts
~/verdikta-arbiter-node/recover-chainlink-funds.sh --both --non-interactive
```

## Default Thresholds

### ETH Thresholds (Left in Keys)
- **Base Sepolia**: 0.001 ETH (~10-20 transactions worth of gas)
- **Base Mainnet**: 0.001 ETH (~50-100 transactions worth of gas)

### LINK Thresholds (Minimum to Recover)
- **All Networks**: 0.1 LINK (avoids recovering dust amounts)

### Why Thresholds Matter
- **ETH Threshold**: Ensures keys retain enough gas for future operations
- **LINK Threshold**: Prevents expensive gas fees for tiny token amounts
- **Operational Safety**: Keeps oracle functional after fund recovery

## Recovery Process

### Phase 1: Discovery and Analysis
1. **Load Configuration**: Read network settings and key addresses
2. **Authenticate**: Login to Chainlink node CLI
3. **Discover Keys**: Find all configured Chainlink key addresses
4. **Check Balances**: Query ETH and LINK balances for each key
5. **Calculate Recovery**: Determine recoverable amounts after thresholds

### Phase 2: Transaction Preparation
1. **Export Private Keys**: Temporarily export keys for transaction signing
2. **Estimate Gas**: Calculate transaction costs for each recovery
3. **Prepare Transactions**: Build ETH transfers and ERC-20 token transfers
4. **Validate Amounts**: Ensure sufficient gas remains in keys

### Phase 3: Execution and Confirmation
1. **Send Transactions**: Submit signed transactions to blockchain
2. **Monitor Progress**: Wait for transaction confirmations
3. **Verify Success**: Check transaction status and update balances
4. **Cleanup**: Remove temporary private key data
5. **Report Results**: Provide detailed summary of recovered funds

## Transaction Types

### ETH Recovery
```
Transaction Type: Native ETH Transfer
Gas Limit: 21,000 gas
Gas Source: Deducted from transferred amount
Destination: Owner wallet address
```

### LINK Recovery
```
Transaction Type: ERC-20 Token Transfer
Gas Limit: 65,000 gas (estimated)
Gas Source: Paid from key's ETH balance
Token Contract: Base LINK token address
Destination: Owner wallet address
```

## Example Scenarios

### Scenario 1: Regular Maintenance
**Situation**: Oracle has been running for months, accumulated LINK rewards
```bash
# Check what's available
~/verdikta-arbiter-node/recover-chainlink-funds.sh --dry-run --both

# Recover accumulated LINK tokens
~/verdikta-arbiter-node/recover-chainlink-funds.sh --link-only
```

### Scenario 2: Over-funded Keys
**Situation**: Accidentally sent too much ETH to keys
```bash
# Recover excess ETH, leave operational amount
~/verdikta-arbiter-node/recover-chainlink-funds.sh --eth-only --eth-threshold 0.002
```

### Scenario 3: Node Decommissioning
**Situation**: Shutting down oracle, recover all possible funds
```bash
# Recover everything, leave minimal amounts
~/verdikta-arbiter-node/recover-chainlink-funds.sh --both --eth-threshold 0.0005
```

### Scenario 4: Testnet Cleanup
**Situation**: Done testing, recover testnet tokens
```bash
# Recover all testnet funds (thresholds less important)
~/verdikta-arbiter-node/recover-chainlink-funds.sh --both --eth-threshold 0.0001
```

## Cost Analysis

### Gas Costs (Base Mainnet Example)
```
ETH Recovery per key: ~21,000 gas × 1 gwei = 0.000021 ETH
LINK Recovery per key: ~65,000 gas × 1 gwei = 0.000065 ETH
4 keys, both assets: ~0.000344 ETH total gas cost
```

### Net Recovery Calculation
```
Example: Key with 0.010 ETH, 2.5 LINK
ETH recoverable: 0.010 - 0.001 (threshold) - 0.000065 (LINK gas) = 0.008935 ETH
LINK recoverable: 2.5 LINK (all, since above 0.1 threshold)
Total value: ~0.008935 ETH + 2.5 LINK
```

## Network Configuration

### Base Sepolia (Testnet)
- **Chain ID**: 84532
- **LINK Token**: 0xE4aB69C077896252FAFBD49EFD26B5D171A32410
- **Explorer**: https://sepolia.basescan.org/
- **Gas Price**: ~2 gwei (typical)

### Base Mainnet (Production)
- **Chain ID**: 8453
- **LINK Token**: 0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196
- **Explorer**: https://basescan.org/
- **Gas Price**: ~1 gwei (typical)

## Troubleshooting

### Common Issues

#### Chainlink Node Not Running
```
Error: Chainlink container not running
```
**Solution**: Start Chainlink node before running defunding
```bash
~/verdikta-arbiter-node/start-arbiter.sh
# Wait for startup, then retry defunding
```

#### Authentication Failed
```
Error: Failed to login to Chainlink CLI
```
**Solution**: Check API credentials and node status
```bash
# Check if node is responsive
curl -s http://localhost:6688/health

# Verify credentials file exists
ls -la ~/.chainlink-testnet/.api  # or ~/.chainlink-mainnet/.api
```

#### Insufficient ETH for Gas
```
Error: ETH amount too small after gas deduction
```
**Solution**: Key doesn't have enough ETH to cover gas and threshold
- Lower ETH threshold, or
- Add more ETH to the key first, or
- Skip ETH recovery for that key

#### LINK Transfer Failed
```
Error: LINK transaction may have failed
```
**Solution**: Check transaction on explorer, may need retry
- Verify LINK token contract address
- Check if key has sufficient ETH for gas
- Transaction may be pending (wait longer)

#### Private Key Export Failed
```
Error: Failed to export key [address]
```
**Solution**: Chainlink node issue or authentication
- Ensure node is fully synced
- Restart Chainlink node if needed
- Check node logs for specific errors

### Recovery Strategies

#### Partial Recovery
If some keys fail, others may succeed:
```bash
# Check which keys succeeded
~/verdikta-arbiter-node/recover-chainlink-funds.sh --dry-run --both

# Focus on specific recovery type
~/verdikta-arbiter-node/recover-chainlink-funds.sh --eth-only
```

#### Manual Recovery
If automation fails, you can manually recover:
1. Export keys from Chainlink UI (http://localhost:6688)
2. Import keys into MetaMask or similar wallet
3. Manually send transactions to owner wallet

#### Transaction Monitoring
Check transaction status on blockchain:
```bash
# Base Sepolia
https://sepolia.basescan.org/tx/[transaction_hash]

# Base Mainnet  
https://basescan.org/tx/[transaction_hash]
```

## Best Practices

### Regular Maintenance
- **Monthly Review**: Check accumulated LINK tokens
- **Threshold Monitoring**: Ensure keys maintain adequate gas reserves
- **Balance Optimization**: Recover excess funds to reduce attack surface

### Before Recovery
- **Backup First**: Ensure wallet backups are secure
- **Test on Testnet**: Practice on Base Sepolia before mainnet
- **Check Node Status**: Ensure oracle is operational
- **Verify Addresses**: Confirm owner wallet address is correct

### Security Practices
- **Monitor Transactions**: Watch for completion on blockchain explorer
- **Validate Amounts**: Verify recovered amounts match expectations
- **Clean Environment**: Ensure no private key remnants remain
- **Document Recovery**: Keep records of recovery operations

### Operational Considerations
- **Service Impact**: Recovery doesn't affect running oracle operations
- **Timing**: Best done during low-activity periods
- **Frequency**: Avoid excessive recovery operations (gas costs)
- **Coordination**: Inform team before large fund movements

## Integration with Oracle Lifecycle

### Initial Setup
1. Install and fund keys using funding script
2. Start oracle operations
3. Monitor performance and accumulation

### Regular Operations
1. Check balances periodically
2. Recover excess funds when thresholds exceeded
3. Maintain optimal balance levels

### Maintenance
1. Use defunding for rebalancing
2. Recover accumulated rewards
3. Optimize gas reserve levels

### Decommissioning
1. Stop oracle services
2. Allow pending transactions to complete
3. Recover all possible funds
4. Archive key information securely

The fund recovery script provides a safe, automated way to manage oracle finances throughout the entire lifecycle, from initial operation through decommissioning.
