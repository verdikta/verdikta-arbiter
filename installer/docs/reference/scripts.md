# Script Reference

This page documents all scripts available in the Verdikta Arbiter installer.

## Installation Scripts

### install.sh

**Location:** `installer/bin/install.sh`

Main orchestrator script that handles the complete installation process.

#### Usage

```bash
./bin/install.sh [OPTIONS]
```

#### Options

| Option | Short | Description |
|--------|-------|-------------|
| `--run-tests` | `-t` | Run unit tests during installation (skipped by default) |
| `--resume-registration` | `-r` | Skip installation steps and resume from oracle registration |
| `--help` | `-h` | Show help message |

#### Environment Variables

| Variable | Description |
|----------|-------------|
| `RUN_TESTS=true` | Alternative to `--run-tests` flag |

#### Examples

```bash
# Standard installation (tests skipped by default)
./bin/install.sh

# Installation with unit tests enabled
./bin/install.sh --run-tests
./bin/install.sh -t

# Resume from failed oracle registration
./bin/install.sh --resume-registration
./bin/install.sh -r

# Using environment variable
RUN_TESTS=true ./bin/install.sh
```

#### Installation Steps

The installer performs these steps in order:

1. **Prerequisites Check** - Verifies system requirements
2. **Environment Setup** - Configures directories and API keys
3. **AI Node Installation** - Sets up the AI arbitration service
4. **External Adapter Installation** - Configures blockchain-AI bridge
5. **Docker & PostgreSQL Setup** - Installs containers and database
6. **Chainlink Node Setup** - Configures oracle infrastructure
7. **Smart Contract Deployment** - Deploys contracts to blockchain
8. **Job Configuration** - Creates Chainlink jobs and bridges
9. **Oracle Registration** - Registers with dispatcher (optional)
10. **Key Funding** - Funds Chainlink keys (optional)

---

### setup-environment.sh

**Location:** `installer/bin/setup-environment.sh`

Configures installation directory, network selection, and API keys.

```bash
./bin/setup-environment.sh
```

---

### install-ai-node.sh

**Location:** `installer/bin/install-ai-node.sh`

Installs and configures the AI Node component.

#### Options

| Option | Short | Description |
|--------|-------|-------------|
| `--skip-tests` | `-s` | Skip unit tests |
| `--help` | `-h` | Show help message |

---

### install-adapter.sh

**Location:** `installer/bin/install-adapter.sh`

Installs and configures the External Adapter component.

#### Options

| Option | Short | Description |
|--------|-------|-------------|
| `--skip-tests` | `-s` | Skip unit tests |
| `--help` | `-h` | Show help message |

---

### setup-docker.sh

**Location:** `installer/bin/setup-docker.sh`

Sets up Docker containers and PostgreSQL database.

```bash
./bin/setup-docker.sh
```

---

### setup-chainlink.sh

**Location:** `installer/bin/setup-chainlink.sh`

Configures and starts the Chainlink node.

```bash
./bin/setup-chainlink.sh
```

---

### deploy-contracts.sh

**Location:** `installer/bin/deploy-contracts.sh`

Deploys smart contracts to the blockchain.

```bash
./bin/deploy-contracts.sh
```

---

### deploy-contracts-automated.sh

**Location:** `installer/bin/deploy-contracts-automated.sh`

Automated contract deployment with automatic key retrieval.

```bash
./bin/deploy-contracts-automated.sh
```

---

### configure-node.sh

**Location:** `installer/bin/configure-node.sh`

Creates Chainlink jobs and bridges for arbitration.

```bash
./bin/configure-node.sh
```

---

### register-oracle-dispatcher.sh

**Location:** `installer/bin/register-oracle-dispatcher.sh`

Registers oracle with the Verdikta dispatcher network.

```bash
./bin/register-oracle-dispatcher.sh
```

---

## Management Scripts

These scripts are copied to your installation directory during setup.

### start-arbiter.sh

Starts all Verdikta Arbiter services.

```bash
~/verdikta-arbiter-node/start-arbiter.sh
```

---

### stop-arbiter.sh

Stops all Verdikta Arbiter services.

```bash
~/verdikta-arbiter-node/stop-arbiter.sh
```

---

### arbiter-status.sh

Checks status of all services.

```bash
~/verdikta-arbiter-node/arbiter-status.sh
```

---

## Fund Management Scripts

### fund-chainlink-keys.sh

**Location:** `installer/bin/fund-chainlink-keys.sh`

Funds Chainlink keys with native tokens (ETH).

#### Options

| Option | Description |
|--------|-------------|
| `--amount <value>` | Amount to fund per key (e.g., `0.005`) |
| `--force` | Skip confirmation prompts |
| `--dry-run` | Preview funding without executing |
| `--help` | Show help message |

#### Examples

```bash
# Interactive funding
./fund-chainlink-keys.sh

# Fund with specific amount
./fund-chainlink-keys.sh --amount 0.005

# Automated funding (no prompts)
./fund-chainlink-keys.sh --amount 0.005 --force

# Preview funding
./fund-chainlink-keys.sh --dry-run
```

---

### recover-chainlink-funds.sh

**Location:** `installer/bin/recover-chainlink-funds.sh`

Recovers funds from Chainlink keys to your wallet.

#### Options

| Option | Description |
|--------|-------------|
| `--eth-only` | Recover only excess ETH |
| `--link-only` | Recover only accumulated LINK |
| `--both` | Recover both ETH and LINK |
| `--dry-run` | Preview recovery without executing |
| `--help` | Show help message |

#### Examples

```bash
# Interactive recovery
./recover-chainlink-funds.sh

# Recover excess ETH only
./recover-chainlink-funds.sh --eth-only

# Preview recovery
./recover-chainlink-funds.sh --dry-run --both
```

---

## Utility Scripts

Located in `installer/util/` directory.

### check-prerequisites.sh

Verifies system prerequisites are met.

```bash
./util/check-prerequisites.sh
```

---

### verify-installation.sh

Verifies the installation is complete and functional.

```bash
./util/verify-installation.sh
```

---

### register-oracle.sh

Standalone oracle registration script.

```bash
~/verdikta-arbiter-node/register-oracle.sh
```

---

### unregister-oracle.sh

Unregisters oracle from the dispatcher.

```bash
~/verdikta-arbiter-node/unregister-oracle.sh
```

---

### upgrade-arbiter.sh

Upgrades an existing installation to the latest version.

```bash
./bin/upgrade-arbiter.sh
```

---

## Key Management Scripts

### key-management.sh

**Location:** `installer/bin/key-management.sh`

Internal script for managing Chainlink keys. Used by other installation scripts.

Functions:
- `ensure_keys_exist` - Creates required keys
- `list_existing_keys` - Lists all Chainlink keys
- `get_key_address_for_job` - Gets key address for a specific job
- `update_contracts_with_keys` - Updates contract file with key information

---

## Chainlink Management

### start-chainlink.sh

**Location:** `installer/util/start-chainlink.sh`

Starts the Chainlink node container.

```bash
./util/start-chainlink.sh
```

---

### stop-chainlink.sh

**Location:** `installer/util/stop-chainlink.sh`

Stops the Chainlink node container.

```bash
./util/stop-chainlink.sh
```

---

### restart-chainlink.sh

**Location:** `installer/util/restart-chainlink.sh`

Restarts the Chainlink node container.

```bash
./util/restart-chainlink.sh
```

---

### chainlink-status.sh

**Location:** `installer/util/chainlink-status.sh`

Shows Chainlink node status and health.

```bash
./util/chainlink-status.sh
```

