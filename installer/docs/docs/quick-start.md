# Quick Start

Get your Verdikta Arbiter Node up and running in under 30 minutes with our automated installer. This guide will walk you through the fastest path to a fully operational node.

!!! info "Before You Begin"
    
    Ensure you've completed the [Prerequisites](prerequisites.md) checklist, including gathering all required API keys and testnet funds.

## Installation Overview

The automated installation performs these steps:

1. **System Check** - Verifies prerequisites and dependencies
2. **Environment Setup** - Configures API keys and settings
3. **Component Installation** - Installs AI Node, External Adapter, and dependencies
4. **Docker Setup** - Configures PostgreSQL and Chainlink Node
5. **Contract Deployment** - Deploys oracle contracts to Base Sepolia
6. **Configuration** - Sets up jobs, bridges, and oracle registration
7. **Verification** - Confirms all services are running correctly

## Step 1: Clone Repository

First, clone the Verdikta Arbiter repository to your system:

```bash
git clone https://github.com/verdikta/verdikta-arbiter.git
cd verdikta-arbiter/installer
```

## Step 2: Run Automated Installer

Execute the main installation script:

```bash
bash bin/install.sh
```

The installer will display a welcome banner and begin the process:

```
====================================================
  Verdikta Arbiter Node Installation
====================================================

[1/9] Checking prerequisites...
```

## Step 3: Interactive Setup

The installer will prompt you for configuration details. Have your API keys ready:

### Environment Configuration

You'll be prompted to enter:

=== "Installation Path"

    ```
    Enter installation directory [~/verdikta-arbiter-node]: 
    ```
    
    **Default**: `~/verdikta-arbiter-node`  
    **Note**: Press Enter to use default or specify custom path

=== "OpenAI Configuration"

    ```
    Enter your OpenAI API key: sk-...
    Select OpenAI model:
    1) gpt-4-turbo-preview
    2) gpt-4
    3) gpt-3.5-turbo
    Choose [1-3]: 1
    ```

=== "Anthropic Configuration"

    ```
    Enter your Anthropic API key: sk-ant-...
    Select Claude model:
    1) claude-3-opus-20240229
    2) claude-3-sonnet-20240229
    3) claude-3-haiku-20240307
    Choose [1-3]: 2
    ```

=== "Web3 Provider"

    ```
    Enter your Infura/Alchemy API key: ...
    Enter Base Sepolia RPC URL [https://base-sepolia.infura.io/v3/YOUR_KEY]: 
    ```

=== "IPFS Service"

    ```
    Select IPFS provider:
    1) Pinata
    2) Infura IPFS
    Choose [1-2]: 1
    
    Enter Pinata API Key: ...
    Enter Pinata Secret Key: ...
    ```

=== "Wallet Configuration"

    ```
    Enter your wallet private key (for testnet only): 0x...
    ```

    !!! warning "Security Reminder"
        Only use testnet private keys. Never enter mainnet credentials.

## Step 4: Monitor Installation Progress

Watch the installation progress through each component:

### Component Installation Timeline

```mermaid
gantt
    title Installation Timeline
    dateFormat X
    axisFormat %M:%S
    
    section Prerequisites
    System Check           :0, 1m
    
    section Environment  
    API Key Setup         :1m, 2m
    Environment Files     :2m, 3m
    
    section Components
    AI Node Install      :3m, 8m
    External Adapter     :8m, 12m
    Docker Setup         :12m, 15m
    Chainlink Node       :15m, 20m
    
    section Blockchain
    Contract Deployment  :20m, 25m
    Oracle Registration  :25m, 28m
    
    section Verification
    Service Check        :28m, 30m
```

### Expected Output

```bash
[1/9] Checking prerequisites...
✓ Prerequisites check passed.

[2/9] Setting up environment...
✓ Environment setup completed.

[3/9] Installing AI Node...
✓ AI Node installation completed.

[4/9] Installing External Adapter...
✓ External Adapter installation completed.

[5/9] Setting up Docker and PostgreSQL...
✓ Docker and PostgreSQL setup completed.

[6/9] Setting up Chainlink Node...
✓ Chainlink Node setup completed.

[7/9] Deploying Smart Contracts...
✓ Smart Contract deployment completed.

[8/9] Configuring Node Jobs and Bridges...
✓ Node Jobs and Bridges configuration completed.

[9/9] Registering Oracle with Dispatcher (Optional)...
✓ Oracle registration step completed.
```

## Step 5: Installation Completion

Upon successful completion, you'll see:

```bash
====================================================
  Verdikta Arbiter Node Installation Complete!
====================================================

Congratulations! Your Verdikta Arbiter Node has been successfully installed.

Access your services at:
  - AI Node:         http://localhost:3000
  - External Adapter: http://localhost:8080
  - Chainlink Node:   http://localhost:6688
```

## Step 6: Verify Installation

### Check Service Status

Navigate to your installation directory and verify all services are running:

```bash
cd ~/verdikta-arbiter-node
./arbiter-status.sh
```

Expected output:
```bash
=== Verdikta Arbiter Node Status ===

[AI Node] Running on port 3000 ✓
[External Adapter] Running on port 8080 ✓
[Chainlink Node] Running on port 6688 ✓
[PostgreSQL] Running on port 5432 ✓

All services are running correctly!
```

### Access Chainlink UI

1. Open your browser to [http://localhost:6688](http://localhost:6688)
2. Use the credentials from `~/verdikta-arbiter-node/chainlink-node/info.txt`
3. Verify your job is active in the Jobs section

### Test AI Node

Check if the AI Node is responding:

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00Z",
  "version": "1.0.0"
}
```

## Important Information

After installation, critical information is stored in these locations:

### Contract Addresses

**File**: `~/verdikta-arbiter-node/installer/.contracts`

```ini
OPERATOR_ADDRESS=0x1234...
NODE_ADDRESS=0x5678...
LINK_TOKEN_ADDRESS=0x9abc...
JOB_ID=abcd1234-5678-90ef-ghij-klmnopqrstuv
AGGREGATOR_ADDRESS=0xdef0...
CLASSES_ID=128
```

### Chainlink Credentials

**File**: `~/verdikta-arbiter-node/chainlink-node/info.txt`

```
Chainlink Node UI: http://localhost:6688
Email: admin@verdikta.local
Password: [generated-password]
Keystore Password: [generated-keystore-password]
```

!!! warning "Secure These Files"
    
    Keep these files secure and backed up. They contain critical information for your node operation.

## Management Commands

Use these commands to manage your arbiter node:

### Start All Services

```bash
cd ~/verdikta-arbiter-node
./start-arbiter.sh
```

### Stop All Services

```bash
cd ~/verdikta-arbiter-node
./stop-arbiter.sh
```

### Check Status

```bash
cd ~/verdikta-arbiter-node
./arbiter-status.sh
```

## Next Steps

Now that your arbiter node is running:

1. **Explore Management**: Learn about [service management](management/index.md)
2. **Monitor Operations**: Set up [status monitoring](management/status.md)
3. **Oracle Registration**: Complete [dispatcher registration](oracle/dispatcher.md)
4. **Maintenance**: Review [backup procedures](maintenance/backup.md)

## Troubleshooting Quick Fixes

### Common Issues

=== "Port Already in Use"

    ```bash
    # Check what's using the port
    sudo lsof -i :6688
    
    # Stop the process or change port in config
    ```

=== "Docker Not Running"

    ```bash
    # Start Docker service
    sudo systemctl start docker
    
    # Restart installation
    bash bin/install.sh
    ```

=== "API Key Issues"

    ```bash
    # Re-run environment setup
    bash bin/setup-environment.sh
    ```

=== "Contract Deployment Failed"

    ```bash
    # Check testnet funds
    # Re-run contract deployment
    bash bin/deploy-contracts.sh
    ```

For detailed troubleshooting, see the [Troubleshooting Guide](troubleshooting/index.md).

## Support

Need help? Get assistance:

- **Documentation**: Browse the full [installation guide](installation/index.md)
- **GitHub Issues**: Report problems or ask questions
- **Discord**: Join the community for real-time help
- **Email**: Contact support for urgent issues

!!! success "Installation Complete"
    
    Congratulations! Your Verdikta Arbiter Node is now operational and ready to process arbitration requests. The node will automatically participate in the network's dispute resolution system. 