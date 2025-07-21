# Prerequisites

Before installing your Verdikta Arbiter Node, ensure your system meets all requirements and you have the necessary API keys and resources.

## System Requirements

### Operating System

The Verdikta Arbiter Node supports the following operating systems:

=== "Ubuntu"

    - **Minimum**: Ubuntu 20.04 LTS
    - **Recommended**: Ubuntu 22.04 LTS or newer
    - **Architecture**: x86_64 (AMD64)

=== "macOS"

    - **Minimum**: macOS 11.0 (Big Sur)
    - **Recommended**: macOS 12.0 (Monterey) or newer
    - **Architecture**: Intel x86_64 or Apple Silicon (M1/M2)

=== "Windows"

    - **Requirement**: Windows Subsystem for Linux 2 (WSL2)
    - **WSL Distribution**: Ubuntu 20.04 or 22.04
    - **Windows Version**: Windows 10 version 2004 or Windows 11

### Hardware Requirements

| Component | Minimum | Recommended | Multi-Arbiter (5-10) | Notes |
|-----------|---------|-------------|---------------------|-------|
| **CPU** | 2 cores | 4+ cores | 6+ cores | Multi-core improves AI processing and multi-arbiter performance |
| **RAM** | 8 GB | 12+ GB | 16+ GB | Additional RAM needed for multiple arbiter jobs and key management |
| **Storage** | 200 GB | 300+ GB | 500+ GB | SSD recommended for better database performance with multiple arbiters |
| **Network** | Stable internet | High-speed broadband | High-speed broadband | Required for blockchain, IPFS, and concurrent multi-arbiter operations |

!!! tip "Multi-Arbiter Scaling"
    
    **Resource planning for multi-arbiter setups**:
    
    - **1-2 Arbiters**: Use minimum requirements
    - **3-5 Arbiters**: Use recommended requirements  
    - **6-10 Arbiters**: Use multi-arbiter requirements
    
    Each additional arbiter adds ~1GB RAM and ~20GB storage overhead.

### Software Dependencies

The following software will be automatically installed if not present:

- **Git** (required for repository cloning)
- **Node.js** 18.17.0+ (for External Adapter and AI Node)
- **Docker** 24.0.0+ (for Chainlink Node and PostgreSQL)
- **Docker Compose** 2.20.0+ (for container orchestration)
- **jq** (for JSON processing in scripts)

## API Keys and Services

### Required API Keys

You'll need API keys from the following services:

#### :simple-openai: OpenAI

- **Purpose**: GPT-4 access for AI-powered adjudication
- **Plans**: Pay-per-use or subscription plans with GPT-4 access
- **Sign up**: [OpenAI Platform](https://platform.openai.com/)

!!! tip "GPT-4 Access"
    Ensure your OpenAI account has GPT-4 API access. This may require a paid plan or API credits.

#### :simple-anthropic: Anthropic

- **Purpose**: Claude access as backup/alternative AI provider
- **Plans**: Pay-per-use API access
- **Sign up**: [Anthropic Console](https://console.anthropic.com/)

#### :simple-ethereum: Web3 Provider

Choose one of the following providers for Base network access (both testnet and mainnet):

=== "Infura"

    - **Service**: Base Sepolia (testnet) and Base Mainnet RPC endpoints
    - **Sign up**: [Infura](https://infura.io/)
    - **Free tier**: Available with rate limits
    - **Recommended**: Good for development and testing

=== "Alchemy"

    - **Service**: Base Sepolia (testnet) and Base Mainnet RPC endpoints
    - **Sign up**: [Alchemy](https://alchemy.com/)
    - **Free tier**: Available with generous limits
    - **Recommended**: Excellent for production deployments

=== "QuickNode"

    - **Service**: Base Sepolia (testnet) and Base Mainnet RPC endpoints
    - **Sign up**: [QuickNode](https://quicknode.com/)
    - **Free tier**: Limited endpoints available

#### :material-folder-network: IPFS Service

For document storage and retrieval:

=== "Pinata"

    - **Service**: IPFS pinning and gateway
    - **Sign up**: [Pinata](https://pinata.cloud/)
    - **Free tier**: 1GB storage limit
    - **Recommended**: Paid plans for production use

=== "Infura IPFS"

    - **Service**: IPFS API and gateway
    - **Sign up**: [Infura](https://infura.io/)
    - **Free tier**: Available with rate limits

### Network Funds

You'll need tokens for contract deployment and operations. Choose your deployment network:

#### Base Sepolia (Testnet) - Recommended for Testing

**Advantages**: Free tokens, risk-free learning environment, fast iterations

**Requirements**:

- **Base Sepolia ETH**: ~0.1 ETH for gas fees and contract deployment
- **Base Sepolia LINK**: ~10 LINK tokens for oracle operations
- **Faucets**:
  - [Base Sepolia ETH Faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet)
  - [Chainlink LINK Faucet](https://faucets.chain.link/)
  - [Alchemy Base Sepolia Faucet](https://sepoliafaucet.com/)

!!! success "Free & Risk-Free"
    Perfect for learning, development, and testing. No real money required.

#### Base Mainnet - Production Ready

**Advantages**: Real network, actual value, production-ready

**Requirements**:

- **Base Mainnet ETH**: $50-100 USD worth for deployment and operations
- **Base Mainnet LINK**: ~10 LINK tokens (~$50-150 depending on price)
- **Purchase**: Buy ETH and LINK on exchanges, transfer to your deployment wallet

**Cost Breakdown**:
- Contract deployment: ~$5-15 in gas fees
- Initial LINK funding: ~$50-150 for oracle operations  
- Reserve funds: ~$30-50 for ongoing operations

!!! warning "Production Deployment"
    **Use only dedicated wallets with minimal funds**. Never use your main wallet for deployment.
    
    **Recommended approach**: 
    1. Test thoroughly on Base Sepolia first
    2. Start with 1-2 arbiters on mainnet
    3. Scale up gradually as you gain confidence

## Pre-Installation Checklist

Before starting the installation, verify you have:

### :material-check-circle: System Preparation

- [ ] Supported operating system (Ubuntu 20.04+, macOS 11+, or WSL2)
- [ ] Adequate hardware resources (see table above for your planned arbiter count)
- [ ] Stable internet connection with sufficient bandwidth
- [ ] Administrative/sudo access for software installation

### :material-key: API Keys and Credentials

- [ ] OpenAI API key with GPT-4 access and funded account
- [ ] Anthropic API key for Claude access (optional but recommended)
- [ ] Web3 provider API key (Infura/Alchemy/QuickNode) supporting Base network
- [ ] IPFS service credentials (Pinata/Infura IPFS)

### :material-wallet: Network Selection & Blockchain Resources

Choose one deployment option:

#### For Testnet Deployment (Recommended First)
- [ ] Wallet private key for a dedicated test wallet
- [ ] Base Sepolia ETH (~0.1 ETH from faucets)
- [ ] Base Sepolia LINK tokens (~10 LINK from faucets)

#### For Mainnet Deployment (Production)
- [ ] Wallet private key for a dedicated deployment wallet  
- [ ] Base Mainnet ETH ($50-100 worth for deployment and operations)
- [ ] Base Mainnet LINK (~10 LINK tokens, $50-150 depending on price)

### :material-settings: Multi-Arbiter Planning

- [ ] Decided on number of arbiters (1-10)
- [ ] Understood resource scaling (each arbiter adds ~1GB RAM, ~20GB storage)
- [ ] Planned for automatic key management (1 key per 2 arbiters)

### :material-file-document: Documentation Access

- [ ] Access to this documentation
- [ ] Repository clone or download completed
- [ ] Notepad for recording generated addresses and credentials

## Security Considerations

### Private Key Security

!!! danger "Critical Security Warning"
    
    - **Never** use mainnet private keys or funds
    - **Never** commit private keys to version control
    - Use dedicated testnet wallets only
    - Store private keys securely and separately from the codebase

### API Key Management

- Keep API keys secure and never share them
- Use environment variables for key storage
- Rotate keys periodically for security
- Monitor API usage for unexpected activity

### Network Security

- Ensure your system is behind a firewall
- Keep software dependencies updated
- Use strong passwords for all accounts
- Enable two-factor authentication where available

## Prerequisites Verification

The installer includes an automated prerequisites checker. You can run it independently:

```bash
cd verdikta-arbiter/installer
bash util/check-prerequisites.sh
```

### Sample Output

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

## Next Steps

Once all prerequisites are met:

1. **Quick Start**: Follow the [Quick Start Guide](quick-start.md) for automated installation
2. **Detailed Installation**: Use the [Installation Guide](installation/index.md) for step-by-step instructions
3. **Manual Setup**: Advanced users can follow [Manual Installation](installation/manual.md)

!!! success "Ready to Install"
    
    If all prerequisites are satisfied, you're ready to proceed with installation. Choose your preferred installation method and continue to the next section. 