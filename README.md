# Verdikta Arbiter

## Overview

Verdikta is a novel blockchain platform (built on Base/ETH) designed for decentralized AI-adjudicated judgements. Client applications can query Verdikta arbiters (Chainlink nodes enhanced with AI capabilities) with query packages stored on IPFS. These arbiters, leveraging multiple AI agents from diverse sources, deliberate on the queries to provide fast, cost-effective, and unbiased judgements. These judgements can then trigger actions within smart contracts, such as executing payments from escrow.

This repository, `verdikta-arbiter`, consolidates all the necessary components to run a Verdikta arbiter node. It merges functionality from previous separate repositories (`ai-node-development`, `verdikta-external-adapter`, `verdiktaChainlinkNode`) into a unified structure. The terminology has also been updated from "validator" to "arbiter".

## Repository Structure

The repository is organized into the following main components:

```
verdikta-arbiter/
├── ai-node/                # AI Node component - Handles AI model interaction & deliberation
├── external-adapter/       # External Adapter - Bridges Chainlink node with the AI Node
├── chainlink-node/         # Chainlink Node configurations, contracts, and job specs
├── arbiter-operator/       # Operator contract for interacting with the Chainlink node
└── installer/              # Scripts for installing and managing the arbiter components
    ├── bin/                # Main installation and management scripts (install, start, stop, status)
    ├── config/             # Configuration templates
    ├── docs/               # Documentation
    ├── util/               # Utility scripts used by the installer
    └── README.md           # Installation guide
```

## Components

### 1. AI Node (`ai-node/`)

- **Purpose**: A Next.js web application that provides an interface for interacting with various Large Language Models (LLMs) including OpenAI (GPT), Anthropic (Claude), and locally run Ollama models.
- **Key Features**: Multi-LLM integration, multi-model deliberation, weighted voting, outcome ranking, justification generation, text/image attachment support.
- **Details**: See `ai-node/README.md` for setup, configuration, API details, and testing instructions.

### 2. External Adapter (`external-adapter/`)

- **Purpose**: Acts as a bridge between a standard Chainlink node and the custom AI Node. It fetches query/evidence data from IPFS, prepares it, sends it to the AI Node for evaluation, and formats the response for the Chainlink node.
- **Key Features**: IPFS integration (single and multi-CID), AI Node communication, error handling, logging. Supports Multi-CID feature for complex queries involving multiple data sources.
- **Details**: See `external-adapter/README.md` for basic setup and API. See `external-adapter/README-multi-cid.md` for details on the Multi-CID feature.

### 3. Chainlink Node (`chainlink-node/`)

- **Purpose**: Contains necessary configurations, job specifications (`.toml`), and example smart contracts (`.sol`) for setting up the Chainlink node component of the arbiter.
- **Key Files**:
    - `verdikta_job_spec.toml`: The primary job specification for the Chainlink node to interact with the external adapter.
    - `MyOperator.sol`: Example contract related to Chainlink node operation.
    - Scripts (`prestart.sh`, `startCL.sh`, `trackCL.sh`): Helper scripts for managing the Chainlink node process.

### 4. Arbiter Operator (`arbiter-operator/`)

- **Purpose**: Contains the Operator contract that serves as the blockchain interface for the Verdikta arbiter.
- **Key Features**: Compatible with Chainlink node, allows registration with aggregator contract for reputation management.
- **Scripts**: Includes scripts for deployment, authorization, and registration with aggregator contracts.

### 5. Installer (`installer/`)

- **Purpose**: Contains scripts to automate the setup and management of a Verdikta arbiter instance. It copies the necessary components (`ai-node`, `external-adapter`, `chainlink-node`) into a target directory (default: `~/verdikta-arbiter-node`) and provides management scripts.
- **Key Scripts**:
    - `installer/bin/install.sh`: Main installation script.
    - `installer/bin/register-oracle-dispatcher.sh`: Registers the operator with an aggregator contract (optional).
    - `~/verdikta-arbiter-node/start-arbiter.sh`: Starts all arbiter components.
    - `~/verdikta-arbiter-node/stop-arbiter.sh`: Stops all arbiter components.
    - `~/verdikta-arbiter-node/arbiter-status.sh`: Checks the status of components.
- **Note**: The documentation within `installer/docs/` provides more detail on the installation process.

## Getting Started (Installation)

### Prerequisites

Before running the installer, ensure you have:
- System requirements met (Ubuntu 20.04+ / macOS 11+ / WSL2, 6GB+ RAM, 100GB+ storage, Git).
- Necessary API keys:
    - OpenAI (GPT-4 access recommended)
    - Anthropic (Claude access recommended)
    - An IPFS Service (e.g., Pinata, Infura IPFS) for the External Adapter.
    - A Web3 provider endpoint (e.g., Infura, Alchemy) for your target blockchain network (e.g., Base Sepolia).
- For deploying contracts using the installer scripts:
    - A wallet private key with sufficient funds (e.g., Base Sepolia ETH).
    - Sufficient LINK tokens on the target network in the wallet associated with the Chainlink node (can be funded after node setup).

### Installation Steps

1.  **Clone the Repository**:
    ```bash
    git clone https://github.com/verdikta/verdikta-arbiter.git
    cd verdikta-arbiter
    ```

2.  **Run the Installer**:
    ```bash
    cd installer
    bash bin/install.sh
    ```
    This will create a `~/verdikta-arbiter-node` directory (or prompt for a different location) and set up the arbiter components by copying them from the repository source.

3.  **Configure Components**:
    The `install.sh` script will prompt you for necessary configuration values (like API keys, paths, node credentials) during the `setup-environment.sh` step. Review these carefully.
    If you need to adjust configuration *after* installation, edit the relevant files within your chosen installation directory (e.g., `~/verdikta-arbiter-node`):
    - **AI Node**: Edit `~/verdikta-arbiter-node/ai-node/.env.local` for API keys.
    - **External Adapter**: Edit `~/verdikta-arbiter-node/external-adapter/.env` for IPFS credentials, AI Node URL, etc.
    - **Chainlink Node**: Configuration is typically managed via environment variables set for the Docker container (often defined in a `.env` file used by Docker Compose within the installation directory) and through the Chainlink node's UI/API after startup.

4.  **Register with Aggregator (Optional)**:
    After installation, you can optionally register your oracle with an aggregator contract:
    ```bash
    cd ~/verdikta-arbiter-node/installer
    bash bin/register-oracle-dispatcher.sh
    ```
    You will need the address of a deployed aggregator contract for this step.

5.  **Manage the Arbiter**:
    Navigate to your installation directory (e.g., `~/verdikta-arbiter-node`) and use the management scripts:
    - Start: `~/verdikta-arbiter-node/start-arbiter.sh`
    - Stop: `~/verdikta-arbiter-node/stop-arbiter.sh`
    - Status: `~/verdikta-arbiter-node/arbiter-status.sh`

## Development & Testing

- Refer to the `README.md` files within each component directory (`ai-node`, `external-adapter`) for specific development and testing instructions.
- For end-to-end testing, you'll need to:
  1. Set up a Verdikta arbiter node using the installer
  2. Register it with an aggregator (optional)
  3. Fund the Chainlink node with ETH and LINK
  4. Use a compatible client contract to interact with the arbiter

## Contributing

Contributions are welcome. Please follow standard Git practices (fork, branch, pull request) and ensure code quality and adherence to existing patterns. Update relevant documentation and add tests for new features or fixes.

## License

TBD