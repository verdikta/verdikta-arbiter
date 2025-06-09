# Quick Start

Get your Verdikta Arbiter Node up and running in under 30 minutes with our automated installer. This comprehensive guide walks you through every step with all the information you need in one place.

!!! info "What You'll Need"
    
    Before starting, gather these required items:
    
    - **OpenAI API Key** (for AI arbitration)
    - **Infura API Key** (for blockchain access) 
    - **Base Sepolia ETH** (~0.01 ETH for contract deployment)
    - **Test Wallet Private Key** (never use your main wallet!)
    
    📋 Full checklist: [Prerequisites Guide](prerequisites.md)

## Step 1: Clone Repository

Clone the Verdikta Arbiter repository and navigate to the installer:

```bash
git clone https://github.com/verdikta/verdikta-arbiter.git
cd verdikta-arbiter/installer
```

## Step 2: Run the Automated Installer

Start the installation process:

```bash
bash bin/install.sh
```

The installer will guide you through 7 main steps. Here's what to expect at each stage:

---

## Step 3: System Prerequisites Check

The installer first verifies your system meets all requirements.

### What It Checks
- **Operating System**: Ubuntu 20.04+, macOS 11+, or WSL2
- **Hardware**: Minimum 6GB RAM, 100GB storage
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

Configure your installation directory and API keys.

### Installation Directory

**Prompt**: `Installation directory [~/verdikta-arbiter-node]:`

**What to do**: 
- Press **Enter** for the default location
- Or type a custom path like `/opt/verdikta-arbiter`

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

2. **Get Base Sepolia ETH**:
   - Go to [Base Sepolia Faucet](https://www.alchemy.com/faucets/base-sepolia)
   - Connect your test wallet and request ETH

3. **Export the private key**:
   - MetaMask → Account menu (3 dots) → **Account Details**
   - **Export Private Key** → Enter MetaMask password
   - **Remove the `0x` prefix** from the key

**Format**: Exactly 64 hexadecimal characters (no `0x`)  
**Example**: `a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456`

!!! danger "Security Warning"
    - **Never use your main wallet with real funds**
    - Only fund test wallet with Base Sepolia ETH
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
- Your test wallet has sufficient Base Sepolia ETH
- Your private key is correctly formatted (64 chars, no `0x`)
- Network connectivity is stable

---

## Step 7: Node Configuration

Set up bridges and jobs in the Chainlink node.

### Host IP Configuration

**Prompt**: `Enter your machine's IP address or hostname [192.168.1.100]:`

**What to choose**:
- **Local testing**: Press **Enter** to use the detected IP
- **Remote access**: Enter your server's public IP or domain name
- **Docker/container setup**: Use `host.docker.internal`

### Manual Job Creation

The installer will prepare a job specification file and guide you through manual creation:

1. **Job file location**: The installer shows the path to the job spec file

2. **Copy the contents**: You'll need to copy the entire TOML specification

3. **Create in Chainlink UI**:
   - Go to [http://localhost:6688](http://localhost:6688)
   - Navigate to **Jobs** → **New Job**
   - Select **TOML** format
   - Paste the job specification
   - Click **Create Job**

**Prompt**: `Have you created the job in the Chainlink UI? (y/n):`

**What to do**: Type `y` after successfully creating the job

**Prompt**: `Please enter the job ID from the UI:`

**How to find it**: 

1. After creating the job, the job details page shows the Job ID

2. Copy the full UUID (format: `12345678-1234-1234-1234-123456789012`)

---

## Step 8: Oracle Registration (Optional)

Register your oracle with the Verdikta dispatcher to participate in the network.

**Prompt**: `Register with dispatcher? (y/n):`

**What to choose**:
- **`y`**: Register to participate in live arbitration requests
- **`n`**: Skip for local testing only

If registering, you may be prompted for:
- **Aggregator address**: Provided by the Verdikta team
- **Classes ID**: Use default `128` or specific ID from team

---

## Step 9: Installation Complete!

Upon successful completion, you'll see:

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

#### 3. Verify Chainlink Job

1. Open [http://localhost:6688](http://localhost:6688)

2. Log in with saved credentials

3. Go to **Jobs** → Find your job → Verify it's **Active**

## Important Files & Credentials

After installation, save these critical files:

### Contract Information
**File**: `~/verdikta-arbiter-node/installer/.contracts`
```ini
OPERATOR_ADDRESS=0x1234...
NODE_ADDRESS=0x5678...
JOB_ID=abcd1234-5678-90ef-ghij-klmnopqrstuv
```

### Chainlink Credentials  
**File**: `~/verdikta-arbiter-node/chainlink-node/info.txt`
```
Chainlink UI: http://localhost:6688
Email: admin@verdikta.local
Password: [your-generated-password]
```

!!! warning "Backup These Files"
    Keep these files secure and backed up - they contain critical information for node operation.

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

=== "Docker Not Running"
    ```bash
    # Start Docker service
    sudo systemctl start docker
    
    # Retry installation
    bash bin/install.sh
    ```

=== "Insufficient Base Sepolia ETH"
    1. Visit [Base Sepolia Faucet](https://www.alchemy.com/faucets/base-sepolia)

    2. Request more test ETH for your wallet

    3. Retry contract deployment: `bash bin/deploy-contracts.sh`

=== "API Key Errors"
    ```bash
    # Reconfigure API keys
    bash bin/setup-environment.sh
    ```

=== "Job Creation Failed"
    1. Check Chainlink node is running: `docker ps | grep chainlink`

    2. Verify UI access: [http://localhost:6688](http://localhost:6688)

    3. Retry job configuration: `bash bin/configure-node.sh`

### Getting Help

- **Complete Troubleshooting**: [Troubleshooting Guide](troubleshooting/index.md)
- **GitHub Issues**: Report problems or ask questions
- **Discord**: Get community help in real-time
- **Email**: Contact support for urgent issues

## Next Steps

With your node running successfully:

1. **🔍 Monitor Operations**: [Status Monitoring Guide](management/status.md)

2. **🔧 Learn Management**: [Service Management Guide](management/index.md)  

3. **🌐 Join Network**: [Oracle Registration Guide](oracle/dispatcher.md)

4. **💾 Setup Backups**: [Backup Procedures](maintenance/backup.md)

!!! success "You're Ready!"
    
    Your Verdikta Arbiter Node is operational and ready to process arbitration requests. Welcome to the decentralized dispute resolution network! 