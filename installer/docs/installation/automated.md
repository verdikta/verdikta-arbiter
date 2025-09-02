# Automated Installation

The automated installer handles the complete setup of your Verdikta Arbiter Node in 9 automated steps. It provides interactive prompts for configuration and handles all technical setup automatically.

!!! success "Complete Automation"

    The installer performs all setup steps automatically - from prerequisites checking to service startup. No manual configuration required.

## Prerequisites

Before starting, ensure you have:

- [ ] **System**: Ubuntu 20.04+, macOS 11+, or WSL2
- [ ] **API Keys**: OpenAI, Anthropic, Web3 provider, IPFS service
- [ ] **Testnet Funds**: Base Sepolia ETH and LINK tokens
- [ ] **Internet**: Stable connection for downloads

## Installation Process

### Step 1: Get the Code

Clone the repository and navigate to the installer:

```bash
git clone https://github.com/verdikta/verdikta-arbiter.git
cd verdikta-arbiter/installer
```

### Step 2: Run the Installer

Start the automated installation:

```bash
./bin/install.sh -s
```

The installer displays a welcome banner and begins the 9-step process:

```
====================================================
  Verdikta Arbiter Node Installation
====================================================

[1/9] Checking prerequisites...
```

### Step 3: Configuration Prompts

The installer will prompt you for configuration details. Have your API keys ready:

**Installation Directory**
```
Enter installation directory [~/verdikta-arbiter-node]: 
```

**API Keys Setup**
```
Enter your OpenAI API key: sk-...
Enter your Anthropic API key: sk-ant-...
Enter your Web3 provider API key: ...
Enter your IPFS provider keys: ...
Enter your wallet private key (testnet only): 0x...
```

**Logging Configuration**
```
Choose logging level:
1) error   2) warn   3) info (recommended)   4) debug
```

### Step 4: Automated Installation Steps

After configuration, the installer runs through 9 automated steps:

**[1/9] Prerequisites Check**
```
✓ Ubuntu 22.04 detected
✓ Docker running
✓ Node.js installed
✓ All prerequisites met
```

**[2/9] Environment Setup**
```
✓ Creating environment files
✓ Configuring API keys
✓ Setting up directories
```

**[3/9] AI Node Installation**
```
✓ Installing AI Node dependencies
✓ Configuring AI models
✓ Setting up environment
```

**[4/9] External Adapter Installation**
```
✓ Installing adapter dependencies
✓ Configuring bridge settings
```

**[5/9] Docker & PostgreSQL Setup**
```
✓ Pulling PostgreSQL image
✓ Creating database container
✓ Configuring database
```

**[6/9] Chainlink Node Setup**
```
✓ Pulling Chainlink image
✓ Creating node configuration
✓ Starting Chainlink node
```

**[7/9] Smart Contract Deployment**
```
✓ Compiling contracts
✓ Deploying to Base Sepolia
✓ Contract deployed at: 0x1234...
```

**[8/9] Job Configuration**
```
✓ Creating External Adapter bridge
✓ Deploying job specification
✓ Job ID: abcd1234-5678...
```

**[9/9] Oracle Registration**
```
✓ Registering with dispatcher
✓ Oracle class ID: 128
```

### Step 5: Installation Completion

Upon successful completion, you'll see:

```
====================================================
  Verdikta Arbiter Node Installation Complete!
====================================================

Access your services at:
  - AI Node:         http://localhost:3000
  - External Adapter: http://localhost:8080
  - Chainlink Node:   http://localhost:6688

Management scripts created:
  - Start services:  ~/verdikta-arbiter-node/start-arbiter.sh
  - Stop services:   ~/verdikta-arbiter-node/stop-arbiter.sh
  - Check status:    ~/verdikta-arbiter-node/arbiter-status.sh
```

The installer will ask if you want to start the services immediately.

## Verification

After installation, verify everything is working:

### Check Service Status

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
```

### Access Chainlink UI

1. Open [http://localhost:6688](http://localhost:6688)
2. Get credentials from `~/verdikta-arbiter-node/chainlink-node/info.txt`
3. Verify the job is active in the Jobs section

### Test AI Node

```bash
curl http://localhost:3000/health
```

Should return a healthy status response.

## Troubleshooting

If you encounter issues during installation:

### Common Problems

**Port conflicts**: Check for services using required ports (3000, 6688, 8080, 5432)
```bash
sudo lsof -i :6688
```

**Docker not running**: Start Docker service
```bash
sudo systemctl start docker
```

**API key errors**: Re-run environment setup
```bash
./bin/setup-environment.sh
```

**Contract deployment fails**: Check testnet funds and network connectivity

### Getting Help

- **Logs**: Check service logs for specific errors
- **Documentation**: [Troubleshooting Guide](../troubleshooting/index.md)
- **Community**: GitHub Issues or Discord

## Next Steps

After successful installation:

1. **Service Management**: Use the provided management scripts
2. **Oracle Registration**: Register with dispatcher for production
3. **Monitoring**: Set up status monitoring and alerts
4. **Backup**: Create backup procedures for your configuration

!!! success "Installation Complete"

    Your Verdikta Arbiter Node is operational and ready to process arbitration requests. 