# Upgrading

Upgrade your existing Verdikta Arbiter Node using the automated upgrade script:

```bash
cd verdikta-arbiter/installer
./bin/upgrade-arbiter.sh
```

This guide follows the real behavior of `installer/bin/upgrade-arbiter.sh` so you can safely upgrade code, configuration, and runtime components without reinstalling from scratch.

## What the upgrade script does

The upgrade process updates:

- AI Node code and dependencies
- External Adapter code and dependencies
- Chainlink node configuration files
- Operator contract project files
- Arbiter management scripts (`start-arbiter.sh`, `stop-arbiter.sh`, `arbiter-status.sh`)
- Registration helper scripts (`register-oracle.sh`, `unregister-oracle.sh`) when available

It also supports:

- Optional API key review/update (OpenAI, Anthropic, Hyperbolic, xAI, optional Infura fallback, Pinata JWT)
- Optional RPC endpoint list updates (HTTP + WS, semicolon-separated)
- Preflight RPC connectivity checks
- Optional backup creation before making changes
- Optional job spec regeneration if template changes are detected
- Optional Chainlink job/key reconfiguration
- Optional Chainlink config regeneration from template
- Optional Chainlink key funding/top-off

## Before you upgrade

Make sure:

- Your node was installed with the standard Verdikta scripts (the upgrade validates expected files in the target directory).
- You have enough free disk space (especially if creating a full backup).
- Docker is running (required for Chainlink container operations).
- Node.js is available (or loadable through NVM), since npm installs run during upgrade.

Recommended:

- Run during a maintenance window if you are serving live traffic.
- Keep a copy of critical files:
  - `~/verdikta-arbiter-node/installer/.env`
  - `~/verdikta-arbiter-node/installer/.api_keys`
  - `~/verdikta-arbiter-node/installer/.contracts`

## Run the upgrade

From the repository root:

```bash
cd installer
./bin/upgrade-arbiter.sh
```

The script will ask for a target install directory:

```bash
Enter the target installation directory [~/verdikta-arbiter-node]:
```

If valid, the script inspects current service state and then walks through interactive upgrade options.

## Interactive flow (prompt-by-prompt)

### 1) Optional API key review

Prompt:

```bash
Would you like to review and update your API keys? (y/N):
```

If you choose `y`, the script shows current key status and lets you update/add:

- OpenAI
- Anthropic
- Hyperbolic
- xAI
- Infura (optional fallback only)
- Pinata JWT

Keys are saved to both:

- `<install-dir>/installer/.api_keys`
- `installer/.api_keys` (in the source repo installer folder)

### 2) Optional RPC endpoint updates

Prompt:

```bash
Would you like to update your RPC endpoint lists? (y/N):
```

If you choose `y`, the script requests:

- HTTP RPC URLs (semicolon-separated)
- WS RPC URLs (semicolon-separated)

For example:

```bash
Enter HTTP RPC URLs (semicolon-separated): https://rpc-a...;https://rpc-b...
Enter WS RPC URLs (semicolon-separated): wss://rpc-a...;wss://rpc-b...
```

Then it asks you to choose the default HTTP RPC from your list for Hardhat use.

### 3) Preflight RPC connectivity check

The script validates each configured HTTP/WS endpoint.

- If all pass: upgrade continues.
- If some fail: you can still continue by confirming:

```bash
Continue upgrade anyway? (y/N):
```

### 4) Upgrade confirmation and service stop

You will see the components to be upgraded and confirm:

```bash
Do you want to proceed with the upgrade? (Y/n):
```

If arbiter services are running, they are stopped automatically before file replacement.

### 5) Backup decision

Prompt:

```bash
Would you like to create a backup before upgrading? (Recommended for production) (Y/n):
```

If accepted, a full directory backup is created with timestamp suffix:

`<install-dir>_backup_YYYYMMDD-HHMMSS`

## Job template and Chainlink behavior

### Job template change detection

Before component replacement, the script compares:

- repo template: `chainlink-node/basicJobSpec`
- installed template: `<install-dir>/chainlink-node/basicJobSpec`

If changed, it offers to regenerate jobs from the new template.

If you accept and an aggregator registration exists, it attempts:

1. Unregister oracle
2. Regenerate jobs (`configure-node.sh`)
3. Re-register oracle with new job IDs

### Optional job/key reconfiguration

If jobs were not already regenerated due to template changes, the script can still optionally re-run full job/key configuration.

Use this when you want to change arbiter count or refresh job/key setup.

## Chainlink config regeneration

The script checks current Chainlink config against the latest template (`config_template.toml`) while ignoring environment-specific lines (URLs, names, chain IDs) for comparison.

If differences are found, it can regenerate config from template after creating a config backup.

This helps pick up template-level improvements safely.

## Dependency updates and model synchronization

During upgrade, the script:

- runs `npm install` in AI Node and External Adapter
- updates `@verdikta/common` (with version handling via `VERDIKTA_COMMON_VERSION`)
- can auto-integrate ClassID model pool updates into AI Node config
- can check/download missing Ollama models (optional)

## Optional Chainlink key funding

At the end of upgrade, you can top off Chainlink keys:

```bash
Would you like to fund or top off your Chainlink keys now? (y/N):
```

Funding supports:

- recommended amount per key
- custom amount
- skip

## Restart behavior

After successful upgrade:

- If services were running before: script asks to restart them.
- If services were not running before: script asks whether to start now.

It waits for startup and performs basic port checks:

- AI Node: `3000`
- External Adapter: `8080`
- Chainlink UI/API: `6688`

## Rollback and failure recovery

If upgrade fails after the process starts, the script prints guidance and references any created backup directory.

To restore from backup manually:

```bash
rm -rf <install-dir>
cp -r <backup-dir> <install-dir>
```

Then start services again:

```bash
<install-dir>/start-arbiter.sh
```

## Post-upgrade verification

Run:

```bash
cd ~/verdikta-arbiter-node
./arbiter-status.sh
```

Then verify:

1. AI Node healthy on `http://localhost:3000`
2. External Adapter reachable on `http://localhost:8080`
3. Chainlink UI reachable on `http://localhost:6688`
4. Expected jobs and keys still present in Chainlink
5. `installer/.contracts` reflects your intended arbiter/job configuration

## Common upgrade tips

- Prefer creating a backup for production upgrades.
- Keep multiple RPC endpoints configured for resilience.
- If RPCs are changed, allow Chainlink config/job regeneration when prompted.
- If aggregator registration exists and jobs are regenerated, expect unregister/re-register flow.
- If you skip optional model downloads, you can pull Ollama models later.
