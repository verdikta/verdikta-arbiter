# Automated Installation

The automated installation is the recommended method for most users. It provides a guided, interactive setup process that handles all components and configuration automatically.

!!! success "Recommended Installation Method"

    The automated installer is thoroughly tested and provides the most reliable setup experience. It's suitable for both beginners and experienced users.

## Before You Begin

Ensure you have completed the [Prerequisites](../prerequisites.md) checklist:

- [ ] System meets minimum requirements (Ubuntu 20.04+, macOS 11+, or WSL2)
- [ ] API keys for OpenAI, Anthropic, Web3 provider, and IPFS service
- [ ] Testnet funds (Base Sepolia ETH and LINK)
- [ ] Stable internet connection

## Installation Process

### Step 1: Repository Setup

Clone the Verdikta Arbiter repository:

```bash
git clone https://github.com/verdikta/verdikta-arbiter.git
cd verdikta-arbiter/installer
```

### Step 2: Launch Installer

Start the automated installation:

```bash
bash bin/install.sh
```

The installer will display a welcome banner:

```
====================================================
  Verdikta Arbiter Node Installation
====================================================

[1/9] Checking prerequisites...
```

### Step 3: Prerequisites Check

The installer automatically verifies system requirements:

```bash
Checking system prerequisites for Verdikta Arbiter Node...
✓ Ubuntu 22.04 detected.
✓ 8 CPU cores detected.
✓ 16 GB RAM detected.
✓ 250 GB available disk space detected.
✓ Git version 2.34.1 detected.
✓ Node.js version 18.19.0 detected.
✓ Docker version 24.0.7 detected.
✓ Docker daemon is running.
✓ Docker Compose plugin version 2.21.0 detected.
✓ Internet connectivity detected.
✓ jq version 1.6 detected.

=== Prerequisite Check Summary ===
All prerequisites met! Your system is ready for Verdikta Arbiter Node installation.
```

If any prerequisites fail, address them before continuing.

### Step 4: Environment Configuration

The installer will prompt for configuration details. Have your API keys ready:

#### Installation Directory

```
Enter installation directory [~/verdikta-arbiter-node]: 
```

- **Default**: `~/verdikta-arbiter-node`
- **Custom**: Enter your preferred path
- **Note**: Ensure the user has write permissions

#### OpenAI Configuration

```
Enter your OpenAI API key: sk-...
Select OpenAI model:
1) gpt-4-turbo-preview (Recommended)
2) gpt-4
3) gpt-3.5-turbo
Choose [1-3]: 1
```

!!! tip "Model Selection"
    
    - **gpt-4-turbo-preview**: Latest and most capable model
    - **gpt-4**: Stable version with proven performance  
    - **gpt-3.5-turbo**: Cost-effective but less capable

#### Anthropic Configuration

```
Enter your Anthropic API key: sk-ant-...
Select Claude model:
1) claude-3-opus-20240229 (Most capable)
2) claude-3-sonnet-20240229 (Recommended)
3) claude-3-haiku-20240307 (Fastest)
Choose [1-3]: 2
```

#### Web3 Provider Setup

```
Select Web3 provider:
1) Infura
2) Alchemy
3) QuickNode
4) Custom RPC
Choose [1-4]: 1

Enter your Infura API key: ...
Enter Base Sepolia RPC URL [https://base-sepolia.infura.io/v3/YOUR_KEY]: 
```

#### IPFS Service Configuration

```
Select IPFS provider:
1) Pinata (Recommended)
2) Infura IPFS
Choose [1-2]: 1

Enter Pinata API Key: ...
Enter Pinata Secret Key: ...
```

#### Wallet Configuration

```
Enter your wallet private key (for testnet only): 0x...
```

!!! danger "Security Warning"
    
    - **TESTNET ONLY**: Never use mainnet private keys
    - **Secure Storage**: Store private keys separately from code
    - **No Sharing**: Never commit private keys to version control

### Step 5: Installation Progress

Monitor the automated installation through 9 steps:

#### Step 1: Prerequisites Check ✓

```
[1/9] Checking prerequisites...
✓ Prerequisites check passed.
```

#### Step 2: Environment Setup ✓

```
[2/9] Setting up environment...
Creating environment files...
Configuring API keys...
Setting up directory structure...
✓ Environment setup completed.
```

#### Step 3: AI Node Installation ✓

```
[3/9] Installing AI Node...
Copying AI Node files...
Installing Node.js dependencies...
Configuring environment variables...
Setting up AI model configurations...
✓ AI Node installation completed.
```

#### Step 4: External Adapter Installation ✓

```
[4/9] Installing External Adapter...
Copying External Adapter files...
Installing dependencies...
Configuring bridge settings...
✓ External Adapter installation completed.
```

#### Step 5: Docker & PostgreSQL Setup ✓

```
[5/9] Setting up Docker and PostgreSQL...
Pulling PostgreSQL Docker image...
Creating database container...
Configuring database settings...
✓ Docker and PostgreSQL setup completed.
```

#### Step 6: Chainlink Node Setup ✓

```
[6/9] Setting up Chainlink Node...
Pulling Chainlink Docker image...
Creating Chainlink configuration...
Generating node credentials...
Starting Chainlink node...
✓ Chainlink Node setup completed.
```

#### Step 7: Smart Contract Deployment ✓

```
[7/9] Deploying Smart Contracts...
Compiling contracts...
Deploying Operator contract...
Contract deployed at: 0x1234567890abcdef...
Authorizing Chainlink node...
✓ Smart Contract deployment completed.
```

#### Step 8: Job Configuration ✓

```
[8/9] Configuring Node Jobs and Bridges...
Creating External Adapter bridge...
Deploying job specification...
Job ID: abcd1234-5678-90ef-ghij-klmnopqrstuv
✓ Node Jobs and Bridges configuration completed.
```

#### Step 9: Oracle Registration ✓

```
[9/9] Registering Oracle with Dispatcher (Optional)...
Creating oracle registration...
Submitting to aggregator contract...
Oracle registered with class ID: 128
✓ Oracle registration step completed.
```

### Step 6: Installation Completion

Upon successful completion:

```
====================================================
  Verdikta Arbiter Node Installation Complete!
====================================================

Congratulations! Your Verdikta Arbiter Node has been successfully installed.

Access your services at:
  - AI Node:         http://localhost:3000
  - External Adapter: http://localhost:8080
  - Chainlink Node:   http://localhost:6688

Management scripts created:
  - To start all services: ~/verdikta-arbiter-node/start-arbiter.sh
  - To stop all services:  ~/verdikta-arbiter-node/stop-arbiter.sh
  - To check status:       ~/verdikta-arbiter-node/arbiter-status.sh

Contract information saved to: ~/verdikta-arbiter-node/installer/.contracts
```

## Post-Installation Verification

### Service Status Check

Verify all services are running:

```bash
cd ~/verdikta-arbiter-node
./arbiter-status.sh
```

Expected output:
```
=== Verdikta Arbiter Node Status ===

[AI Node] Running on port 3000 ✓
[External Adapter] Running on port 8080 ✓
[Chainlink Node] Running on port 6688 ✓
[PostgreSQL] Running on port 5432 ✓

All services are running correctly!
```

### Web Interface Access

#### Chainlink Node UI

1. Open [http://localhost:6688](http://localhost:6688)
2. Get credentials from `~/verdikta-arbiter-node/chainlink-node/info.txt`:
   ```
   Chainlink Node UI: http://localhost:6688
   Email: admin@verdikta.local
   Password: [generated-password]
   ```
3. Login and verify the job is active in the Jobs section

#### AI Node Health Check

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00Z",
  "version": "1.0.0",
  "components": {
    "openai": "connected",
    "anthropic": "connected",
    "ipfs": "connected"
  }
}
```

### Configuration Files Review

Important files created during installation:

#### Contract Information

**File**: `~/verdikta-arbiter-node/installer/.contracts`

```ini
OPERATOR_ADDRESS=0x1234567890abcdef...
NODE_ADDRESS=0x9876543210fedcba...
LINK_TOKEN_ADDRESS=0x84b9B910527Ad5C03A9Ca831909E21e236EA7b06
JOB_ID=abcd1234-5678-90ef-ghij-klmnopqrstuv
AGGREGATOR_ADDRESS=0xE75426Ed0491a8290fC55CAA71ab5e1d95F4BaF6
CLASSES_ID=128
```

#### Environment Variables

- **AI Node**: `~/verdikta-arbiter-node/ai-node/.env.local`
- **External Adapter**: `~/verdikta-arbiter-node/external-adapter/.env`
- **Chainlink Config**: `~/.chainlink-sepolia/config.toml`

## Troubleshooting Installation

### Common Issues and Solutions

#### Port Already in Use

**Error**: `Port 6688 is already in use`

**Solution**:
```bash
# Check what's using the port
sudo lsof -i :6688

# Stop the conflicting service or change port
sudo kill -9 <PID>

# Restart installation
bash bin/install.sh
```

#### Docker Service Not Running

**Error**: `Cannot connect to the Docker daemon`

**Solution**:
```bash
# Start Docker service
sudo systemctl start docker
sudo systemctl enable docker

# Verify Docker is running
docker info

# Restart installation
bash bin/install.sh
```

#### API Key Authentication Failed

**Error**: `OpenAI API authentication failed`

**Solution**:
```bash
# Re-run environment setup with correct keys
bash bin/setup-environment.sh

# Verify API key format and permissions
curl -H "Authorization: Bearer YOUR_API_KEY" \
  https://api.openai.com/v1/models
```

#### Contract Deployment Failed

**Error**: `Insufficient funds for intrinsic transaction cost`

**Solution**:
```bash
# Check wallet balance
# Get more testnet funds from faucets
# Verify RPC endpoint is working

# Re-run contract deployment
bash bin/deploy-contracts.sh
```

#### Services Won't Start

**Error**: Various service startup failures

**Solution**:
```bash
# Check Docker container status
docker ps -a

# Review logs for specific errors
docker logs chainlink-node
docker logs postgres-db

# Restart services
cd ~/verdikta-arbiter-node
./stop-arbiter.sh
./start-arbiter.sh
```

### Getting Help

If you encounter issues:

1. **Check Logs**: Review service logs for specific error messages
2. **Verify Prerequisites**: Re-run `bash util/check-prerequisites.sh`
3. **Documentation**: Consult the [Troubleshooting Guide](../troubleshooting/index.md)
4. **Community Support**: Ask for help in Discord or GitHub Issues

## Next Steps

After successful automated installation:

1. **Service Management**: Learn to [start, stop, and monitor](../management/index.md) your services
2. **Oracle Registration**: Complete [dispatcher registration](../oracle/dispatcher.md) for production use
3. **Monitoring Setup**: Configure [status monitoring](../management/status.md) and alerts
4. **Backup Creation**: Set up [backup procedures](../maintenance/backup.md) for your configuration

## Manual Override

If you need to customize specific components after automated installation:

- **Environment Changes**: Re-run `bash bin/setup-environment.sh`
- **Contract Redeployment**: Run `bash bin/deploy-contracts.sh`
- **Job Reconfiguration**: Execute `bash bin/configure-node.sh`
- **Component Updates**: Use individual component installation scripts

!!! success "Installation Complete"

    Your Verdikta Arbiter Node is now operational and ready to process arbitration requests. The automated installation ensures all components are properly configured and integrated. 