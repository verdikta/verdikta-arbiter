# Verdikta Arbiter Node - Automated Setup

This installer automates the process of setting up a complete Verdikta arbiter Chainlink node environment by copying components from the main `verdikta-arbiter` repository and configuring them.

## Components Installed/Configured

The installer copies and configures the following components into a target directory (default: `~/verdikta-arbiter-node`):

1.  **AI Node**: Copies the code from the `verdikta-arbiter/ai-node/` directory. This is the service that processes adjudication requests using LLMs.
2.  **External Adapter**: Copies the code from `verdikta-arbiter/external-adapter/`. This adapter connects the Chainlink node to the AI Node.
3.  **Docker and PostgreSQL**: Installs Docker (if not present) and sets up a PostgreSQL container for the Chainlink node database.
4.  **Chainlink Node**: Installs and configures the Chainlink node software itself (usually via Docker). Configuration files are copied from `verdikta-arbiter/chainlink-node/`.
5.  **Smart Contracts (Optional Deployment)**: Scripts are included to deploy required contracts (like the Operator) to a target network (e.g., Base Sepolia). Contract source might be from `verdikta-arbiter/chainlink-node/` or `installer/compatible-operator/`.
    - Includes deployment for a compatible operator contract suitable for various client contract versions.
6.  **Bridges and Jobs**: Configures the bridge connection to the External Adapter and sets up the core job specification (e.g., `verdikta_job_spec.toml` from `verdikta-arbiter/chainlink-node/`) within the Chainlink node.
7.  **Demo Client (Optional Setup)**: Copies the code from `verdikta-arbiter/demo-client/` and provides scripts to set it up for testing interactions with the arbiter.

## Prerequisites

- Ubuntu 20.04+ / macOS 11+ / Windows with WSL2
- Minimum 6GB RAM, 100GB storage
- Git
- Internet connection
- API keys for:
  - OpenAI (GPT-4 access recommended)
  - Anthropic (Claude access recommended)
  - Infura (or other Web3 provider for your target network, e.g., Base Sepolia)
  - IPFS Service (e.g., Pinata, Infura IPFS - for External Adapter)
- Testnet funds (e.g., Base Sepolia ETH and LINK) for the target network if deploying contracts.
- Wallet private key with testnet funds if deploying contracts.

## Quick Start

1.  Navigate to the installer directory within the main repository:
    ```bash
    cd /path/to/verdikta-arbiter/installer
    ```

2.  Make the install script executable (if needed):
```bash
chmod +x bin/install.sh
```

3.  Run the main installer script:
    ```bash
    bash bin/install.sh
    ```

4. Follow the interactive prompts to provide your API keys and configuration preferences.

## Complete Installation Process

The `install.sh` script orchestrates the following steps, often calling other scripts in `bin/`:

1.  **Check Prerequisites**: Verifies system requirements and dependencies (`util/check-prerequisites.sh`).
2.  **Setup Environment**: Prompts for configuration (API keys, installation path, etc.) and prepares environment files (`bin/setup-environment.sh`).
3.  **Install AI Node**: Copies `ai-node` files to the target directory and installs dependencies (`bin/install-ai-node.sh`).
4.  **Install External Adapter**: Copies `external-adapter` files to the target directory and installs dependencies (`bin/install-adapter.sh`).
5.  **Setup Docker and PostgreSQL**: Ensures Docker is running and sets up the PostgreSQL container (`bin/setup-docker.sh`).
6.  **Setup Chainlink Node**: Installs the Chainlink node (usually via Docker) and applies necessary configurations (`bin/setup-chainlink.sh`).
7.  **Deploy Smart Contracts (Optional)**: May prompt the user to deploy necessary contracts like the Operator contract (`bin/deploy-contracts.sh` or `bin/deploy-contracts-automated.sh`).
    - Automatically authorizes the Chainlink node with the deployed contract if applicable.
8.  **Configure Node Jobs and Bridges**: Sets up the bridge connection and the primary job specification within the Chainlink node (`bin/configure-node.sh`).
9.  **Setup Demo Client (Optional)**: Copies `demo-client` files and may run setup scripts (`bin/setup-client-contract.sh`).

After these steps, the installer:
- Verifies the installation where possible (`util/verify-installation.sh`).
- Creates management scripts (`start-arbiter.sh`, `stop-arbiter.sh`, `arbiter-status.sh`) in the target installation directory (e.g., `~/verdikta-arbiter-node/`).

## Manual Installation Steps

If you prefer to run the installation steps individually (execute from within the `installer/` directory):

1.  Check prerequisites:
    ```bash
    bash util/check-prerequisites.sh
    ```

2.  Set up the environment (will prompt for configuration):
    ```bash
    bash bin/setup-environment.sh
    ```
    *(Ensure the generated `.env` or config files in the installer directory are correct before proceeding)*

3.  Install AI Node:
    ```bash
    bash bin/install-ai-node.sh
    ```

4.  Install External Adapter:
    ```bash
    bash bin/install-adapter.sh
    ```

5.  Set up Docker and PostgreSQL:
    ```bash
    bash bin/setup-docker.sh
    ```

6.  Configure Chainlink Node:
    ```bash
    bash bin/setup-chainlink.sh
    ```

7.  Deploy Smart Contracts (choose one if needed):
    ```bash
    bash bin/deploy-contracts.sh # Interactive deployment
    # OR
    bash bin/deploy-contracts-automated.sh # Less interactive, uses env variables
    ```

8.  Configure Node Jobs and Bridges:
    ```bash
    bash bin/configure-node.sh
    ```

9.  Setup Demo Client (choose one if needed):
    ```bash
    bash bin/setup-client-contract.sh # Sets up client within the main install dir
    # OR
    bash bin/setup-client-contract-standalone.sh # Sets up client in a separate location
    ```

10. Verify your installation (optional):
```bash
./util/verify-installation.sh
```

## Compatible Operator Contract

The installer includes scripts (`deploy-contracts.sh`, `deploy-contracts-automated.sh`) to deploy a compatible operator contract. This contract:

- Is designed to work seamlessly with the Verdikta External Adapter.
- Aims to support various client contract versions (e.g., those expecting Chainlink v0.4.1 interfaces).

## Managing Your Arbiter

After installation, navigate to your chosen installation directory (e.g., `~/verdikta-arbiter-node/`) and use these scripts:

- Start all services:
  ```bash
  ./start-arbiter.sh
  ```

- Stop all services:
  ```bash
  ./stop-arbiter.sh
  ```

- Check service status:
  ```bash
  ./arbiter-status.sh
  ```

## Accessing Your Services

After installation, you can access your services at:

- AI Node: http://localhost:3000
- External Adapter: http://localhost:8080
- Chainlink Node: http://localhost:6688 (use the credentials created during setup)

## Backup and Restore

*Note: These utility scripts still need verification*

Create a backup of your installation (run from `installer/` directory):
```bash
./util/backup-restore.sh backup
```

Restore from a previous backup (run from `installer/` directory):
```bash
./util/backup-restore.sh restore <backup-file>
```

## Troubleshooting

*Note: This guide might need updates.*

For common issues and solutions, see the [Troubleshooting Guide](TROUBLESHOOTING.md).

## Security Recommendations

*Note: This guide might need updates.*

For production deployments, please review our [Security Best Practices](SECURITY.md).

## Installer Directory Structure (within verdikta-arbiter)

```
installer/
├── bin/                     # Executable scripts called by install.sh or manually
│   ├── install.sh           # Main installation script
│   ├── setup-environment.sh # Environment setup script
│   ├── install-ai-node.sh   # AI node installation script
│   ├── install-adapter.sh   # External adapter installation script
│   ├── setup-docker.sh      # Docker and PostgreSQL setup script
│   ├── setup-chainlink.sh   # Chainlink node setup script
│   ├── deploy-contracts.sh  # Interactive contract deployment script
│   ├── deploy-contracts-automated.sh # Automated contract deployment script
│   ├── configure-node.sh    # Job and bridge configuration script
│   ├── setup-client-contract.sh # Demo client setup script
│   └── setup-client-contract-standalone.sh # Standalone demo client setup
├── compatible-operator/     # Compatible operator contract files (may be used by deploy scripts)
│   ├── contracts/           # Smart contract source code
│   ├── migrations/          # Truffle deployment scripts
│   ├── scripts/             # Helper scripts
│   └── deploy.sh            # Deployment script (likely called by bin/deploy*)
├── config/                  # Configuration templates used during setup
│   ├── env-templates/       # Environment file templates (.env)
│   ├── docker/              # Docker-compose templates
│   ├── chainlink/           # Chainlink config, job spec templates
│   └── contracts/           # Contract-related config templates
├── util/                    # Utility scripts (check prerequisites, verify, backup)
│   ├── check-prerequisites.sh # Checks system requirements
│   ├── verify-installation.sh # Verifies successful installation (may need update)
│   └── backup-restore.sh    # Backup and restore utilities (may need update)
└── docs/                    # Documentation for the installer
    ├── README.md            # This file
    ├── TROUBLESHOOTING.md   # Troubleshooting guide (may need update)
    └── SECURITY.md          # Security best practices (may need update)
```

## Contributing

Contributions are welcome! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## License

(Inherits license from the main `verdikta-arbiter` repository - TBD)

## Acknowledgments

- The Chainlink team for their excellent oracle technology
- OpenAI and Anthropic for their AI models
- The broader Verdikta community
- The Verdikta community 