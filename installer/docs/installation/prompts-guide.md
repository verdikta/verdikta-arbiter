# Installer Prompts Guide

This guide explains every prompt you'll encounter during the automated Verdikta Arbiter Node installation and provides detailed instructions on how to obtain the required information.

## Installation Prompts

### 1. Installation Directory

**Prompt:** `Installation directory [~/verdikta-arbiter-node]:`

**What it means:** Where to install your Verdikta Arbiter Node files.

**How to respond:**
- Press **Enter** to use the default directory (`~/verdikta-arbiter-node`)
- Or type a custom path like `/opt/verdikta-arbiter`

**Example:**
```bash
Installation directory [~/verdikta-arbiter-node]: /opt/verdikta-arbiter
```

### 2. API Keys Configuration

#### OpenAI API Key

**Prompt:** `Enter your OpenAI API Key (leave blank to skip):`

**What it means:** Required for AI processing using GPT models.

**How to obtain:**
1. Go to [OpenAI Platform](https://platform.openai.com/)
2. Sign up or log in
3. Navigate to **API Keys**
4. Click **"+ Create new secret key"**
5. Copy the key (starts with `sk-...`)

**Example:**
```bash
Enter your OpenAI API Key (leave blank to skip): sk-1234567890abcdef...
```

#### Anthropic API Key

**Prompt:** `Enter your Anthropic API Key (leave blank to skip):`

**What it means:** Alternative AI provider using Claude models.

**How to obtain:**
1. Go to [Anthropic Console](https://console.anthropic.com/)
2. Sign up or log in
3. Navigate to **API Keys**
4. Click **"Create Key"**
5. Copy the key

**Example:**
```bash
Enter your Anthropic API Key (leave blank to skip): sk-ant-...
```

#### Infura API Key

**Prompt:** `Enter your Infura API Key (leave blank to skip):`

**What it means:** Web3 provider for blockchain connectivity.

**How to obtain:**
1. Go to [Infura.io](https://infura.io/)
2. Create a free account and new project
3. Copy the **Project ID**

**Example:**
```bash
Enter your Infura API Key (leave blank to skip): 1234567890abcdef...
```

#### Pinata JWT Token

**Prompt:** `Enter your Pinata JWT (leave blank to skip):`

**What it means:** IPFS storage service for decentralized file storage.

**How to obtain:**
1. Go to [Pinata.cloud](https://pinata.cloud/)
2. Sign up and navigate to **API Keys**
3. Create a new key with admin permissions
4. Copy the JWT token

**Example:**
```bash
Enter your Pinata JWT (leave blank to skip): eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### 3. Network Selection

**Prompt:** `Select network (1 for Base Sepolia, 2 for Base Mainnet) [1]:`

**What it means:** Choose which blockchain network to deploy contracts on.

**How to respond:**
- Press **Enter** or type `1` for Base Sepolia (testnet - recommended)
- Type `2` for Base Mainnet (production - requires real ETH)

**Example:**
```bash
Select network (1 for Base Sepolia, 2 for Base Mainnet) [1]: 1
```

### 4. Wallet Private Key

**Prompt:** `Enter your wallet private key for contract deployment (without 0x prefix):`

**What it means:** Private key from a wallet with Base Sepolia ETH for deploying smart contracts.

**How to obtain:**
1. Create a wallet using MetaMask, Trust Wallet, or similar
2. Export the private key (remove the `0x` prefix)
3. Fund it with Base Sepolia ETH from a faucet
4. Also add Base Sepolia LINK tokens

!!! danger "Security Warning"
    **TESTNET ONLY**: Never use mainnet private keys. Keep private keys secure and never share them.

**Example:**
```bash
Enter your wallet private key (without 0x prefix): 1234567890abcdef1234567890abcdef...
```

### 5. Logging Level

**Prompt:** `Enter your choice (1-4) [3 for info]:`

**What it means:** Choose the logging verbosity for your services.

**Options:**
- `1` - error: Only error messages
- `2` - warn: Warnings and errors  
- `3` - info: General information (recommended)
- `4` - debug: Detailed debugging information

**Example:**
```bash
Choose a logging level:
1) error   2) warn   3) info (recommended)   4) debug
Enter your choice (1-4) [3 for info]: 3
```

### 6. Service Startup

**Prompt:** `Start Verdikta Arbiter services? (y/n):`

**What it means:** Whether to start all services immediately after installation.

**How to respond:**
- Type `y` to start services now
- Type `n` to start them manually later

**Example:**
```bash
Start Verdikta Arbiter services? (y/n): y
```

## Getting Testnet Funds

You'll need Base Sepolia ETH and LINK tokens:

### Base Sepolia ETH
- [Base Sepolia Faucet](https://faucet.quicknode.com/base/sepolia)
- [Coinbase Wallet Faucet](https://coinbase.com/faucets/base-ethereum-sepolia-faucet)

### Base Sepolia LINK  
- [Chainlink Faucet](https://faucets.chain.link/base-sepolia)

## Installation Flow

The installer will prompt for these items in order:

1. **Installation directory** - Where to install files
2. **OpenAI API key** - For AI processing  
3. **Anthropic API key** - Alternative AI provider
4. **Infura API key** - Web3 provider
5. **Pinata JWT** - IPFS storage
6. **Network selection** - Base Sepolia (recommended)
7. **Wallet private key** - For contract deployment
8. **Logging level** - Service verbosity
9. **Start services** - Whether to start immediately

After these prompts, the installer runs automatically through all 9 installation steps.

## Tips for Success

1. **Prepare API Keys**: Have all API keys ready before starting
2. **Use Test Wallet**: Create a separate wallet for testnet only
3. **Fund Test Wallet**: Get Base Sepolia ETH and LINK from faucets
4. **Secure Storage**: Save all credentials securely
5. **Default Values**: Press Enter to accept recommended defaults

## Need Help?

If you encounter issues with prompts:

- **API Key Errors**: Verify keys are correct and accounts are funded
- **Network Errors**: Check internet connection and firewall settings
- **Format Errors**: Ensure addresses are properly formatted (0x + 40 hex characters)

For additional help, refer to the [Troubleshooting Guide](../troubleshooting/index.md). 