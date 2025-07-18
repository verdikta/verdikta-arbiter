# Installer Prompts Guide

This guide explains every prompt you'll encounter during the Verdikta Arbiter Node installation process and provides detailed instructions on how to obtain the required information.

## Environment Setup Prompts

### 1. Installation Directory

**Prompt:** `Installation directory [/home/user/verdikta-arbiter-node]:`

**What it means:** The installer asks where you want to install the Verdikta Arbiter Node files.

**How to respond:**
- Press **Enter** to use the default directory
- Or type a custom path like `/opt/verdikta-arbiter` or `/home/myuser/verdikta-node`

**Example:**
```bash
Installation directory [/home/user/verdikta-arbiter-node]: /opt/verdikta-arbiter
```

### 2. API Keys Configuration

#### OpenAI API Key

**Prompt:** `Enter your OpenAI API Key (leave blank to skip):`

**What it means:** The AI node requires an OpenAI API key to use GPT models for arbitration decisions.

**How to obtain:**
1. Go to [OpenAI Platform](https://platform.openai.com/)
2. Sign up or log in to your account
3. Navigate to **API Keys** in the left sidebar
4. Click **"+ Create new secret key"**
5. Give it a name like "Verdikta Arbiter"
6. Copy the key (starts with `sk-...`)

!!! warning "Important"
    Keep your OpenAI API key secure and never share it publicly. You'll need to fund your OpenAI account for the API to work.

**Example:**
```bash
Enter your OpenAI API Key (leave blank to skip): sk-1234567890abcdef...
```

#### Anthropic API Key

**Prompt:** `Enter your Anthropic API Key (leave blank to skip):`

**What it means:** Alternative AI provider for arbitration decisions using Claude models.

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

**Prompt:** `Enter your Infura API Key:`

**What it means:** Infura provides Ethereum node access. This is required for the Chainlink node to connect to Base Sepolia blockchain.

**How to obtain:**
1. Go to [Infura.io](https://infura.io/)
2. Sign up for a free account
3. Create a new project
4. Select **Ethereum** as the network
5. Go to your project dashboard
6. Copy the **Project ID** (this is your API key)

!!! tip "Free Tier"
    Infura's free tier provides 100,000 requests per day, which is sufficient for testing and development.

**Example:**
```bash
Enter your Infura API Key: 1234567890abcdef1234567890abcdef
```

#### Pinata JWT Token

**Prompt:** `Enter your Pinata JWT (leave blank to skip):`

**What it means:** Pinata provides IPFS storage services for decentralized file storage.

**How to obtain:**
1. Go to [Pinata.cloud](https://pinata.cloud/)
2. Sign up for an account
3. Navigate to **API Keys** in the dashboard
4. Click **"New Key"**
5. Give it admin permissions
6. Copy the JWT token

**Example:**
```bash
Enter your Pinata JWT (leave blank to skip): eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### Wallet Private Key

**Prompt:** `Enter your wallet private key for contract deployment (without 0x prefix):`

**What it means:** A private key from a wallet with Base Sepolia ETH is needed to deploy smart contracts.

**How to obtain from MetaMask:**
1. Open MetaMask extension
2. Click the account menu (three dots)
3. Select **Account Details**
4. Click **Export Private Key**
5. Enter your MetaMask password
6. Copy the private key **without the 0x prefix**

!!! danger "Security Warning"
    - **Never use your main wallet** with real funds
    - Create a separate test wallet for this purpose
    - Only fund it with Base Sepolia test ETH
    - The private key should be exactly 64 hexadecimal characters
    - Remove the `0x` prefix if present

**How to get Base Sepolia ETH:**
1. Go to [Base Sepolia Faucet](https://www.alchemy.com/faucets/base-sepolia)
2. Connect your test wallet
3. Request test ETH (you need about 0.01 ETH for deployment)

**Example:**
```bash
Enter your wallet private key (without 0x prefix): a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456
```

## Docker Setup Prompts

### PostgreSQL Password

**Prompt:** `Please enter the existing PostgreSQL password (leave blank to generate a new one):`

**What it means:** The system needs a password for the PostgreSQL database that stores Chainlink node data.

**How to respond:**
- Press **Enter** to generate a secure random password (recommended)
- Or enter a custom password (must be strong)

**Example:**
```bash
Please enter the existing PostgreSQL password (leave blank to generate a new one): [ENTER]
```

## Chainlink Node Setup Prompts

### Chainlink UI Login Email

**Prompt:** `Enter email for Chainlink node login [admin@example.com]:`

**What it means:** Email address for logging into the Chainlink node web interface.

**How to respond:**
- Press **Enter** to use the default email
- Or enter your preferred email address

**Example:**
```bash
Enter email for Chainlink node login [admin@example.com]: myemail@example.com
```

## Contract Deployment Prompts

### Chainlink Node Address

**Prompt:** `Enter the Chainlink node address (0x...):`

**What it means:** The Ethereum address of your Chainlink node, needed for contract authorization.

**How to obtain:**
1. Open Chainlink node UI at `http://localhost:6688`
2. Log in with your credentials
3. Navigate to **Key Management** → **EVM Chain Accounts**
4. Copy the **Node Address** (starts with 0x)

!!! note "Format"
    The address must be exactly 42 characters: `0x` followed by 40 hexadecimal characters.

**Example:**
```bash
Enter the Chainlink node address (0x...): 0x1234567890abcdef1234567890abcdef12345678
```

### Manual Contract Address Entry

**Prompt:** `Please enter the deployed ArbiterOperator contract address manually:`

**What it means:** If automatic contract deployment detection fails, you need to provide the contract address manually.

**How to respond:**
- Check the deployment logs for the contract address
- Look for a line like "ArbiterOperator deployed to: 0x..."
- Copy the address from the deployment output

**Example:**
```bash
Please enter the deployed ArbiterOperator contract address manually: 0xabcdef1234567890abcdef1234567890abcdef12
```

## Node Configuration Prompts

### Host IP Address

**Prompt:** `Enter your machine's IP address or hostname [192.168.1.100]:`

**What it means:** The IP address where the External Adapter will be accessible to the Chainlink node.

**How to determine:**
- For local testing: use `localhost` or `127.0.0.1`
- For network access: use your machine's local IP (shown in brackets)
- For production: use your server's public IP or domain name

**Finding your IP:**
```bash
# Linux/macOS
hostname -I | awk '{print $1}'

# Or check network settings in your OS
```

**Example:**
```bash
Enter your machine's IP address or hostname [192.168.1.100]: 192.168.1.100
```

### Job Creation Confirmation

**Prompt:** `Have you created the job in the Chainlink UI? (y/n):`

**What it means:** The installer needs confirmation that you've manually created the Chainlink job through the web interface.

**What to do:**
1. Go to `http://localhost:6688`
2. Navigate to **Jobs** → **New Job**
3. Select **TOML** format
4. Copy the job specification from the file shown in the instructions
5. Paste it and click **Create Job**
6. Return to terminal and type `y`

**Example:**
```bash
Have you created the job in the Chainlink UI? (y/n): y
```

### Job ID Entry

**Prompt:** `Please enter the job ID from the UI:`

**What it means:** After creating the job, you need to provide its UUID for configuration.

**How to find:**
1. After creating the job, you'll see the job details page
2. The Job ID is displayed at the top (UUID format)
3. Copy the entire UUID including hyphens

**Example:**
```bash
Please enter the job ID from the UI: 12345678-1234-1234-1234-123456789012
```

## Oracle Registration Prompts

### Dispatcher Registration

**Prompt:** `Register with dispatcher? (y/n):`

**What it means:** Whether to register your oracle with the Verdikta dispatcher for receiving arbitration requests.

**How to respond:**
- Type `y` if you want to participate in the network
- Type `n` if you're just testing locally

### Aggregator Address

**Prompt:** `Aggregator address:`

**What it means:** The address of the price aggregator contract (if applicable).

**How to respond:**
- This is typically provided by the Verdikta team
- Check the documentation or Discord for current addresses

### Classes ID

**Prompt:** `Classes ID [128]:`

**What it means:** The classification ID for your oracle's capabilities.

**How to respond:**
- Press **Enter** to use the default value (128)
- Or enter a specific class ID if provided by the team

## Upgrade Prompts

### Installation Directory for Upgrade

**Prompt:** `Enter the target installation directory [/home/user/verdikta-arbiter-node]:`

**What it means:** Where to install the upgraded version.

**How to respond:**
- Press **Enter** to use the existing installation directory
- Or specify a different location for the upgrade

## General Yes/No Prompts

Throughout the installation, you'll see various confirmation prompts:

**Common prompts:**
- `Would you like to install Node.js v20.18.0 using nvm? (y/n):`
- `Would you like to install Docker? (y/n):`
- `Proceed with executing this command? (y/n):`

**How to respond:**
- Type `y` and press **Enter** to proceed
- Type `n` and press **Enter** to skip
- The installer will repeat the question if you enter anything else

## Tips for Smooth Installation

1. **Prepare API Keys in Advance**: Have all your API keys ready before starting
2. **Use a Test Wallet**: Never use your main wallet's private key
3. **Fund Your Test Wallet**: Ensure you have Base Sepolia ETH for deployment
4. **Keep Credentials Safe**: Save all generated passwords and credentials securely
5. **Follow the Order**: Run installation scripts in the recommended sequence
6. **Check Logs**: If prompts fail, check the logs for specific error messages

## Troubleshooting Prompts

If you encounter issues with prompts:

1. **Invalid Format Errors**: Ensure addresses are properly formatted (0x + 40 hex characters)
2. **API Key Errors**: Verify your keys are correct and accounts are funded
3. **Network Errors**: Check your internet connection and firewall settings
4. **Permission Errors**: Ensure you have proper permissions for installation directories

## Next Steps

After completing all prompts successfully:

1. Verify all services are running
2. Check the Chainlink node UI is accessible
3. Test your oracle registration
4. Monitor logs for any issues

For additional help, refer to the [Troubleshooting Guide](../troubleshooting/index.md) or the [Support](../troubleshooting/support.md) section. 