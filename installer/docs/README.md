# Verdikta Validator Node - Automated Setup

This installer automates the process of setting up a complete Verdikta validator Chainlink node environment, including all necessary components and configurations.

## Components Installed

The installer sets up:

1. **AI Node** - Neural network service that processes validation requests
2. **External Adapter** - Connects the Chainlink node to the AI Node
3. **Docker and PostgreSQL** - For running the Chainlink node
4. **Chainlink Node** - The Oracle node that communicates with the blockchain
5. **Smart Contracts** - Required contracts on Base Sepolia testnet
   - Uses a compatible operator contract for Chainlink v0.4.1 clients
6. **Bridges and Jobs** - Configuration for the Chainlink node
7. **Client Contract** - For interacting with the Chainlink node

## Prerequisites

- Ubuntu 20.04+ / macOS 11+ / Windows with WSL2
- Minimum 6GB RAM, 100GB storage
- Git
- Internet connection
- API keys for:
  - OpenAI (GPT-4 access required)
  - Anthropic (Claude access required)
  - Infura (Web3 API access for Base Sepolia)
  - Pinata (IPFS access)
- Base Sepolia testnet ETH and LINK (for contract deployment)
- Wallet private key with Base Sepolia ETH (for contract deployment)

## Quick Start

1. Clone the repository (if you haven't already):
```bash
git clone https://github.com/verdikta/validator-setup.git
cd validator-setup
```

2. Make the install script executable:
```bash
chmod +x bin/install.sh
```

3. Run the installer:
```bash
./bin/install.sh
```

4. Follow the interactive prompts to provide your API keys and configuration preferences.

## Complete Installation Process

The installer performs the following steps:

1. **Check Prerequisites** - Verifies system requirements are met
2. **Setup Environment** - Prepares the environment and configuration files
3. **Install AI Node** - Sets up the neural network service
4. **Install External Adapter** - Installs the adapter linking Chainlink to the AI Node
5. **Setup Docker and PostgreSQL** - Installs Docker and configures PostgreSQL database
6. **Setup Chainlink Node** - Installs and configures the Chainlink node
7. **Deploy Smart Contracts** - Deploys the required contracts on Base Sepolia testnet
   - Deploys a compatible operator contract for Chainlink v0.4.1 clients
   - Automatically authorizes the Chainlink node with the contract
8. **Configure Node Jobs and Bridges** - Sets up the job specifications and bridges
9. **Setup Client Contract** - Configures the contract for interacting with the node

After these steps, the installer:
- Verifies the installation is correct
- Creates management scripts for starting and stopping your validator

## Manual Installation

If you prefer to run the installation steps individually:

1. Check prerequisites:
```bash
./util/check-prerequisites.sh
```

2. Set up the environment:
```bash
./bin/setup-environment.sh
```

3. Install AI Node:
```bash
./bin/install-ai-node.sh
```

4. Install External Adapter:
```bash
./bin/install-adapter.sh
```

5. Set up Docker and PostgreSQL:
```bash
./bin/setup-docker.sh
```

6. Configure Chainlink Node:
```bash
./bin/setup-chainlink.sh
```

7. Deploy Smart Contracts:
```bash
./bin/deploy-contracts.sh
```

8. Configure Node Jobs and Bridges:
```bash
./bin/configure-node.sh
```

9. Setup Client Contract:
```bash
./bin/setup-client-contract.sh
```

10. Verify your installation:
```bash
./util/verify-installation.sh
```

## Compatible Operator Contract

The installer uses a specialized compatible operator contract that ensures seamless integration with client contracts using Chainlink v0.4.1. This contract:

- Is fully compatible with the Chainlink External Adapter
- Includes automatic node authorization during deployment
- Eliminates compatibility issues between the operator and client contracts
- Supports the original client contract without modifications

## Managing Your Validator

After installation, you can use these scripts to manage your validator:

- Start all services:
```bash
./start-validator.sh
```

- Stop all services:
```bash
./stop-validator.sh
```

## Accessing Your Services

After installation, you can access your services at:

- AI Node: http://localhost:3000
- External Adapter: http://localhost:8080
- Chainlink Node: http://localhost:6688 (use the credentials created during setup)

## Backup and Restore

Create a backup of your installation:
```bash
./util/backup-restore.sh backup
```

Restore from a previous backup:
```bash
./util/backup-restore.sh restore <backup-file>
```

## Troubleshooting

For common issues and solutions, see the [Troubleshooting Guide](TROUBLESHOOTING.md).

## Security Recommendations

For production deployments, please review our [Security Best Practices](SECURITY.md).

## Directory Structure

```
installer/
├── bin/                     # Executable scripts
│   ├── install.sh           # Main installation script
│   ├── setup-environment.sh # Environment setup script
│   ├── install-ai-node.sh   # AI node installation script
│   ├── install-adapter.sh   # External adapter installation script
│   ├── setup-docker.sh      # Docker and PostgreSQL setup script
│   ├── setup-chainlink.sh   # Chainlink node setup script
│   ├── deploy-contracts.sh  # Smart contract deployment script
│   ├── configure-node.sh    # Job and bridge configuration script
│   └── setup-client-contract.sh # Client contract setup script
├── compatible-operator/     # Compatible operator contract files
│   ├── contracts/           # Smart contract source code
│   ├── migrations/          # Deployment scripts
│   ├── scripts/             # Helper scripts
│   └── deploy.sh            # Deployment script
├── config/                  # Configuration templates
│   ├── env-templates/       # Environment file templates
│   ├── docker/              # Docker configuration files
│   ├── chainlink/           # Chainlink configuration templates
│   └── contracts/           # Smart contract templates
├── util/                    # Utility scripts
│   ├── check-prerequisites.sh # Checks system requirements
│   ├── verify-installation.sh # Verifies successful installation
│   └── backup-restore.sh    # Backup and restore utilities
└── docs/                    # Documentation
    ├── README.md            # This file
    ├── TROUBLESHOOTING.md   # Troubleshooting guide
    └── SECURITY.md          # Security best practices
```

## Contributing

Contributions are welcome! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- The Chainlink team for their excellent oracle technology
- OpenAI and Anthropic for their AI models
- The broader Verdikta community 