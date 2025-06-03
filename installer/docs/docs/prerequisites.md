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

| Component | Minimum | Recommended | Notes |
|-----------|---------|-------------|-------|
| **CPU** | 2 cores | 4+ cores | Multi-core improves AI processing performance |
| **RAM** | 6 GB | 8+ GB | Additional RAM helps with concurrent request processing |
| **Storage** | 100 GB | 200+ GB | SSD recommended for better database performance |
| **Network** | Stable internet | High-speed broadband | Required for blockchain and IPFS operations |

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

Choose one of the following providers for Base Sepolia network access:

=== "Infura"

    - **Service**: Base Sepolia RPC endpoint
    - **Sign up**: [Infura](https://infura.io/)
    - **Free tier**: Available with rate limits

=== "Alchemy"

    - **Service**: Base Sepolia RPC endpoint  
    - **Sign up**: [Alchemy](https://alchemy.com/)
    - **Free tier**: Available with generous limits

=== "QuickNode"

    - **Service**: Base Sepolia RPC endpoint
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

### Testnet Funds

You'll need testnet tokens for contract deployment and operations:

#### Base Sepolia ETH

- **Purpose**: Gas fees for contract deployment and transactions
- **Amount needed**: ~0.1 ETH (covers deployment and initial operations)
- **Faucets**:
  - [Base Sepolia Faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet)
  - [Alchemy Faucet](https://sepoliafaucet.com/)

#### Base Sepolia LINK

- **Purpose**: Oracle payment token
- **Amount needed**: ~10 LINK tokens
- **Faucet**: [Chainlink Faucet](https://faucets.chain.link/)

!!! warning "Testnet Only"
    These are testnet tokens with no real value. Never use mainnet funds during testing.

## Pre-Installation Checklist

Before starting the installation, verify you have:

### :material-check-circle: System Preparation

- [ ] Supported operating system (Ubuntu 20.04+, macOS 11+, or WSL2)
- [ ] Minimum 6GB RAM and 100GB storage available
- [ ] Stable internet connection
- [ ] Administrative/sudo access for software installation

### :material-key: API Keys and Credentials

- [ ] OpenAI API key with GPT-4 access
- [ ] Anthropic API key for Claude access
- [ ] Web3 provider API key (Infura/Alchemy/QuickNode)
- [ ] IPFS service credentials (Pinata/Infura IPFS)

### :material-wallet: Blockchain Resources

- [ ] Wallet private key with testnet funds
- [ ] Base Sepolia ETH (~0.1 ETH minimum)
- [ ] Base Sepolia LINK tokens (~10 LINK minimum)

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