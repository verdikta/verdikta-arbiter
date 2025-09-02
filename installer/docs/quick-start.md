# Quick Start

Get your Verdikta Arbiter Node up and running in under 30 minutes with our automated installer. This comprehensive guide walks you through every step with all the information you need in one place.

## Prerequisites

Before starting, ensure you have:

### System Requirements
- **OS**: Ubuntu 20.04+, macOS 11+, or Windows WSL2
- **Hardware**: 8GB+ RAM, 200GB+ storage, 2+ CPU cores
- **Software**: Git, Docker, Node.js (auto-installed if missing)

### Required API Keys
- **OpenAI API Key**: For AI-powered arbitration ([Get API Key](https://platform.openai.com/))
- **Web3 Provider**: Choose Infura, Alchemy, or QuickNode ([Infura](https://infura.io/), [Alchemy](https://alchemy.com/))
- **IPFS Service**: For document storage ([Pinata](https://pinata.cloud/) recommended)
- **Optional**: Anthropic API Key for Claude AI ([Anthropic Console](https://console.anthropic.com/))

### Network Funds

**For Testing (Recommended)**:
- Base Sepolia ETH (free from [Base Sepolia Faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet))
- Base Sepolia LINK (free from [Chainlink Faucet](https://faucets.chain.link/))

**For Production**:
- Base Mainnet ETH (~$50-100 USD)
- Base Mainnet LINK (~10 LINK tokens)

### Wallet Setup
- Create a **separate test wallet** (never use your main wallet!)
- Export the private key (remove 0x prefix)
- Fund with testnet tokens for safe testing

!!! danger "Security Warning"
    Always use a separate test wallet for oracle deployment. Never use your main wallet's private key.

## Step 1: Clone Repository

Clone the Verdikta Arbiter repository and navigate to the installer:

```bash
git clone https://github.com/verdikta/verdikta-arbiter.git
cd verdikta-arbiter/installer
```

## Step 2: Run the Automated Installer

Start the installation process:

```bash
./bin/install.sh -s
```

The installer will guide you through **9 main steps**. Here's what to expect at each stage:

---

## Step 3: System Prerequisites Check

The installer first verifies your system meets all requirements.

### What It Checks
- **Operating System**: Ubuntu 20.04+, macOS 11+, or WSL2
- **Hardware**: Minimum 8GB RAM, 200GB storage
- **Software**: Node.js, Docker, Git
- **Network**: Internet connectivity

### If Prerequisites Fail
The installer will offer to install missing components automatically:

```bash
Would you like to install Node.js v20.18.0 using nvm? (y/n): y
Would you like to install Docker? (y/n): y
```

**Response**: Type `y` to install automatically, or `n` to skip (not recommended).

---

## Step 4: Environment Setup

Configure your installation directory, network selection, and API keys.

### Installation Directory

**Prompt**: `Installation directory [~/verdikta-arbiter-node]:`

**What to do**: 
- Press **Enter** for the default location
- Or type a custom path like `/opt/verdikta-arbiter`

### Network Selection ⭐ NEW FEATURE

**Prompt**: `Select deployment network:`
```
1) Base Sepolia (Testnet) - Recommended for testing
2) Base Mainnet - Production (requires real ETH)
```

**What to choose**:
- **Option 1**: Base Sepolia testnet (free, recommended for learning)
- **Option 2**: Base Mainnet (production, requires real ETH and LINK)

!!! tip "Network Recommendations"
    
    **First time users**: Choose **Base Sepolia** (testnet) to learn the system without spending real money.
    
    **Production deployments**: Choose **Base Mainnet** only after testing thoroughly on testnet.

### API Keys Configuration

#### OpenAI API Key

**Prompt**: `Enter your OpenAI API Key (leave blank to skip):`

**How to get it**:

1. Go to [OpenAI Platform](https://platform.openai.com/)

2. Sign up or log in

3. Navigate to **API Keys** → **"+ Create new secret key"**

4. Name it "Verdikta Arbiter" and copy the key

**Example**: `sk-1234567890abcdef...`

!!! warning "Important"
    Fund your OpenAI account with credits. The API requires payment for usage.

#### Anthropic API Key (Optional)

**Prompt**: `Enter your Anthropic API Key (leave blank to skip):`

**How to get it**:

1. Go to [Anthropic Console](https://console.anthropic.com/)

2. Sign up → **API Keys** → **"Create Key"**

3. Copy the key

**Example**: `sk-ant-...`

#### Infura API Key (Required)

**Prompt**: `Enter your Infura API Key:`

**How to get it**:

1. Go to [Infura.io](https://infura.io/) and sign up (free)

2. Create a new project → Select **Ethereum**

3. Copy the **Project ID** from your dashboard

**Example**: `1234567890abcdef1234567890abcdef`

!!! tip "Free Tier"
    Infura's free tier provides 100,000 requests/day - perfect for testing.

#### Pinata JWT (Optional)

**Prompt**: `Enter your Pinata JWT (leave blank to skip):`

**How to get it**:

1. Go to [Pinata.cloud](https://pinata.cloud/) and sign up

2. **API Keys** → **"New Key"** → Give admin permissions

3. Copy the JWT token

#### Wallet Private Key (Required)

**Prompt**: `Enter your wallet private key for contract deployment (without 0x prefix):`

**⚠️ CRITICAL SECURITY STEPS**:

1. **Create a NEW test wallet** in MetaMask (never use your main wallet)

2. **Get Network Funds**:
   - **Base Sepolia**: Go to [Base Sepolia Faucet](https://www.alchemy.com/faucets/base-sepolia) for free ETH
   - **Base Mainnet**: Purchase ETH and transfer to your test wallet (~$50-100 recommended)

3. **Export the private key**:
   - MetaMask → Account menu (3 dots) → **Account Details**
   - **Export Private Key** → Enter MetaMask password
   - **Remove the `0x` prefix** from the key

**Format**: Exactly 64 hexadecimal characters (no `0x`)  
**Example**: `a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456`

!!! danger "Security Warning"
    - **Never use your main wallet with real funds**
    - For testnet: Only fund test wallet with Base Sepolia ETH
    - For mainnet: Use a dedicated wallet with minimal funds for contract deployment
    - Private key should be exactly 64 characters without `0x`

---

## Step 5: Component Installation

The installer automatically installs and configures all required components.

### AI Node Installation
- Downloads and sets up the AI arbitration service
- Configures with your API keys
- **Duration**: ~5 minutes

### External Adapter Installation  
- Sets up the blockchain-AI bridge service
- Configures communication endpoints
- **Duration**: ~4 minutes

### Docker & PostgreSQL Setup
- Installs Docker containers
- Sets up PostgreSQL database for Chainlink

**Prompt**: `Please enter the existing PostgreSQL password (leave blank to generate a new one):`

**What to do**: Press **Enter** to auto-generate a secure password (recommended)

### Chainlink Node Setup
- Downloads and configures Chainlink node
- Sets up blockchain connectivity with your Infura key

**Prompt**: `Enter email for Chainlink node login [admin@example.com]:`

**What to do**: 
- Press **Enter** for default email
- Or enter your preferred email for the UI login

---

## Step 6: Smart Contract Deployment

Deploy the oracle contracts to Base Sepolia blockchain.

### Chainlink Node Address

**Prompt**: `Enter the Chainlink node address (0x...):`

**How to get it**:

1. Wait for Chainlink node to start (installer will show when ready)

2. Open [http://localhost:6688](http://localhost:6688) in your browser

3. Log in with the credentials shown by the installer

4. Navigate to **Key Management** → **EVM Chain Accounts**

5. Copy the **Node Address** (starts with `0x`)

**Format**: `0x` + 40 hexadecimal characters  
**Example**: `0x1234567890abcdef1234567890abcdef12345678`

### Contract Deployment Process

The installer will:

1. Compile the ArbiterOperator smart contract

2. Deploy it to Base Sepolia using your private key

3. Authorize your Chainlink node to interact with the contract

4. Save all contract addresses for later use

If deployment fails, check:
- Your test wallet has sufficient network funds (ETH)
- Your private key is correctly formatted (64 chars, no `0x`)
- Network connectivity is stable

---

## Step 8: Multi-Arbiter Configuration ⭐ NEW FEATURE

Configure the number of arbiters for your node with automatic key management.

### Arbiter Count Selection

**Prompt**: `How many arbiters would you like to configure? (1-10)`

**What to choose**:
- **1 arbiter**: Simple setup, good for getting started
- **2-4 arbiters**: Balanced load distribution
- **5-10 arbiters**: Maximum throughput for high-demand scenarios

!!! tip "Arbiter Recommendations"
    
    **First time setup**: Start with **1 arbiter** to understand the system
    
    **Production use**: Consider **2-4 arbiters** for optimal performance vs complexity
    
    **High volume**: Use **5-10 arbiters** if you expect heavy request volume

### Automatic Key Management

The installer automatically:

1. **Calculates required keys**: Creates 1 key for every 2 arbiters
   - 1-2 arbiters → 1 key
   - 3-4 arbiters → 2 keys  
   - 5-6 arbiters → 3 keys
   - etc.

2. **Generates keys**: Creates new Ethereum keys in your Chainlink node

3. **Assigns jobs**: Maps arbiters to keys following the pattern:
   - Arbiters 1-2 → Key 1
   - Arbiters 3-4 → Key 2
   - Arbiters 5-6 → Key 3

4. **Authorizes keys**: All keys are automatically authorized with your operator contract

**Sample Output**:
```bash
Creating jobs for 4 arbiters...
✓ Job 1 created successfully with ID: 12345678-1234-1234-1234-123456789012
✓ Job 2 created successfully with ID: 23456789-2345-2345-2345-234567890123
✓ Job 3 created successfully with ID: 34567890-3456-3456-3456-345678901234
✓ Job 4 created successfully with ID: 45678901-4567-4567-4567-456789012345
```

---

## Step 9: Final Bridge Configuration

Complete the External Adapter bridge setup for communication between Chainlink and your AI node.

### Host IP Configuration

**Prompt**: `Enter your machine's IP address or hostname [192.168.1.100]:`

**What to choose**:
- **Local testing**: Press **Enter** to use the detected IP
- **Remote access**: Enter your server's public IP or domain name
- **Docker/container setup**: Use `host.docker.internal`

!!! success "Automated Job Creation"
    
    🎉 **Jobs are now created automatically!** The installer creates all arbiter jobs for you using the API. No more manual job creation required.
    
    - Bridge created automatically
    - All arbiter jobs created via API
    - Job IDs saved to configuration files
    - Keys authorized with operator contract

### Verification

After bridge configuration, the installer will:

1. **Create External Adapter bridge** automatically
2. **Generate job specifications** for each arbiter
3. **Create all jobs via API** without manual intervention
4. **Update configuration files** with all job IDs and addresses

---

## Installation Complete! 🎉

Upon successful completion, you'll see:

```bash
============================================================
    MULTI-ARBITER CONFIGURATION COMPLETED SUCCESSFULLY     
============================================================
Configuration Summary:
✓ Bridge created/updated: verdikta-ai
✓ Arbiters configured: [Your selected number]
✓ Jobs created: [Number of successful jobs]
✓ Keys configured: [Number of keys]
✓ Configuration files updated

Access your services:
- Chainlink Node UI: http://localhost:6688
- External Adapter: http://[your-ip]:8080
- AI Node: http://localhost:3000
```

## Optional: Oracle Registration

The installer offers optional registration with the Verdikta dispatcher network.

**Prompt**: `Register with dispatcher? (y/n):`

**What to choose**:
- **`y`**: Register to participate in live arbitration requests from the network
- **`n`**: Skip for local testing and development only

If registering, you may be prompted for:
- **Aggregator address**: Provided by the Verdikta team
- **Classes ID**: Use default `128` or specific ID from team

---

## Final Installation Summary

Upon successful completion, you'll see the final summary:

```bash
====================================================
  Verdikta Arbiter Node Installation Complete!
====================================================

Access your services at:
  - AI Node:         http://localhost:3000
  - External Adapter: http://localhost:8080  
  - Chainlink Node:   http://localhost:6688
```

### Verify Everything is Working

#### 1. Check Service Status
```bash
cd ~/verdikta-arbiter-node
./arbiter-status.sh
```

**Expected output**:
```bash
[AI Node] Running on port 3000 ✓
[External Adapter] Running on port 8080 ✓
[Chainlink Node] Running on port 6688 ✓
[PostgreSQL] Running on port 5432 ✓
```

#### 2. Test AI Node Health
```bash
curl http://localhost:3000/health
```

**Expected response**:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

#### 3. Verify Chainlink Jobs (Multi-Arbiter)

1. Open [http://localhost:6688](http://localhost:6688)

2. Log in with saved credentials

3. Go to **Jobs** → Verify all your arbiter jobs are **Active**
   - Look for jobs named "Verdikta AI Arbiter 1", "Verdikta AI Arbiter 2", etc.
   - Each job should show as **Active** with unique job IDs

4. Check **Key Management** → **EVM Chain Accounts**
   - Verify all generated keys are present and funded
   - Each key should have the correct `fromAddress` assignments

## Important Files & Credentials

After installation, save these critical files:

### Multi-Arbiter Contract Information
**File**: `~/verdikta-arbiter-node/installer/.contracts`
```ini
# Network Configuration
DEPLOYMENT_NETWORK=base_sepolia
NETWORK_TYPE=testnet

# Contract Information  
OPERATOR_ADDR=0x1234...
NODE_ADDRESS=0x5678...

# Multi-Arbiter Job IDs
ARBITER_COUNT=4
JOB_ID_1=abcd1234-5678-90ef-ghij-klmnopqrstuv
JOB_ID_2=bcde2345-6789-01fe-ghij-klmnopqrstuv
JOB_ID_3=cdef3456-7890-12fe-ghij-klmnopqrstuv
JOB_ID_4=defa4567-8901-23fe-ghij-klmnopqrstuv

# Key Management
KEYS_LIST=key1:0xabc...|key2:0xdef...
```

### Chainlink Credentials  
**File Network-Specific Location**: 
- **Testnet**: `~/.chainlink-testnet/.api`
- **Mainnet**: `~/.chainlink-mainnet/.api`

**Contents**:
```
admin@verdikta.local
[your-generated-password]
```

### Multi-Arbiter Job Information
**File**: `~/verdikta-arbiter-node/chainlink-node/info/multi_arbiter_job_info.txt`
```
Verdikta Multi-Arbiter Chainlink Node Configuration
==================================================

Configuration Date: [timestamp]
Number of Arbiters: 4
Jobs Created: 4

Bridge Configuration:
- Bridge Name: verdikta-ai
- Bridge URL: http://[your-ip]:8080/evaluate

Job Details:
Arbiter 1: Job ID abc..., Key 0x123...
Arbiter 2: Job ID def..., Key 0x123...
Arbiter 3: Job ID ghi..., Key 0x456...
Arbiter 4: Job ID jkl..., Key 0x456...
```

!!! warning "Critical Backup Files"
    **Essential files to backup**:
    - `~/verdikta-arbiter-node/installer/.contracts` (contract addresses and job IDs)
    - `~/.chainlink-[network]/.api` (login credentials)
    - `~/verdikta-arbiter-node/chainlink-node/info/` (job information)
    
    **Without these files**, you'll lose access to your node and be unable to manage your arbiters.

## Management Commands

Control your arbiter node with these commands:

```bash
cd ~/verdikta-arbiter-node

# Start all services
./start-arbiter.sh

# Stop all services  
./stop-arbiter.sh

# Check status
./arbiter-status.sh
```

## Troubleshooting Quick Fixes

### Common Installation Issues

=== "Port Already in Use"
    ```bash
    # Find what's using the port
    sudo lsof -i :6688
    
    # Kill the process or use different port
    sudo kill -9 [PID]
    ```

=== "Multi-Arbiter Job Creation Failed"
    ```bash
    # Check key management logs
    cd ~/verdikta-arbiter-node
    docker logs chainlink
    
    # Retry specific job creation
    cd verdikta-arbiter/installer
    bash bin/configure-node.sh
    ```

=== "Network Directory Issues"
    ```bash
    # Check which network directory exists
    ls ~/.chainlink-*
    
    # For testnet issues
    ls ~/.chainlink-testnet/
    
    # For mainnet issues  
    ls ~/.chainlink-mainnet/
    ```

=== "Insufficient Network Funds"
    **Base Sepolia (Testnet)**:
    ```bash
    # Get free testnet ETH
    # Visit: https://www.alchemy.com/faucets/base-sepolia
    ```
    
    **Base Mainnet**:
    ```bash
    # Check your wallet balance
    # Ensure you have ~$50-100 worth of ETH for setup
    ```

=== "Docker Not Running"
    ```bash
    # Start Docker service
    sudo systemctl start docker
    
    # Retry installation
    bash bin/install.sh
    ```

=== "Insufficient Network Funds - Legacy"
    **Base Sepolia (Testnet)**:
    1. Visit [Base Sepolia Faucet](https://www.alchemy.com/faucets/base-sepolia)
    2. Request more test ETH for your wallet
    3. Retry contract deployment: `bash bin/deploy-contracts.sh`
    
    **Base Mainnet**:
    1. Add more ETH to your deployment wallet
    2. Ensure you have sufficient funds for gas fees
    3. Monitor transaction fees during deployment

---

## Next Steps & Scaling

### 🎯 Getting Started (New Users)

1. **Test with 1 Arbiter**: Understand the system basics
2. **Submit Test Requests**: Use the testing tools to validate functionality  
3. **Monitor Performance**: Check logs and metrics
4. **Scale Gradually**: Add more arbiters as you gain confidence

### 📈 Scaling Your Multi-Arbiter Setup

#### Performance Considerations
- **1-2 Arbiters**: Good for learning and light workloads
- **3-5 Arbiters**: Balanced performance for medium workloads
- **6-10 Arbiters**: High-performance setup for heavy workloads

#### Resource Planning
- **RAM**: Add ~1GB per additional arbiter
- **Storage**: Add ~20GB per additional arbiter
- **CPU**: Monitor utilization and scale accordingly

### 🛠️ Advanced Configuration

For advanced configurations, see:
- [Multi-Arbiter Design Guide](MULTI_ARBITER_DESIGN.md)
- [Management & Monitoring](management/index.md)
- [Troubleshooting Guide](troubleshooting/index.md)

### 💡 Production Deployment Tips

1. **Start on Testnet**: Always test thoroughly before mainnet
2. **Monitor Costs**: Track gas fees and optimize if needed
3. **Backup Critical Files**: Regularly backup configuration and keys
4. **Monitor Health**: Set up alerts for service availability
5. **Scale Incrementally**: Add arbiters gradually based on demand

---

🎉 **Congratulations!** Your Verdikta Multi-Arbiter Node is now running. Welcome to the future of decentralized dispute resolution!

### Getting Help

- **Complete Troubleshooting**: [Troubleshooting Guide](troubleshooting/index.md)
- **GitHub Issues**: Report problems or ask questions  
- **Discord**: Get community help in real-time
- **Email**: Contact support for urgent issues

!!! success "You're Ready!"
    
    Your Verdikta Multi-Arbiter Node is operational and ready to process arbitration requests. Welcome to the decentralized dispute resolution network! 