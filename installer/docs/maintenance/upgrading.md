# Upgrading

Upgrade your existing Verdikta Arbiter Node using the automated upgrade script:

```bash
cd verdikta-arbiter/installer
./bin/upgrade-arbiter.sh
```

Flags: `--target-dir DIR` skips the directory prompt; `--answers FILE` or
`--unattended` run without any prompts (see
[Unattended Install](../installation/unattended.md) — unset answers take the
safe defaults: backup yes, job regeneration no, funding no).

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

## AI Node production build

The AI Node runs as a production Next.js build (`next build` once, then
`next start`) rather than under `next dev`. It starts in seconds instead of
compiling on the first request, and uses about 100 MB of RAM instead of the
600 MB or more `next dev` holds.

- **Install and upgrade build it** after the last change to the AI Node's code
  and dependencies (`npm install`, the `@verdikta/common` update, the ClassID
  `models.ts` sync), while the node is stopped. The output is in `ai-node/.next`.
- **`ai-node/start.sh` rebuilds only when needed.** The build is stamped with a
  fingerprint of the sources, dependencies and Node version; if any changed
  since (for example after `update-classid-data.sh` or a hand edit), the next
  start rebuilds first. `start-arbiter.sh` waits for that build.
- **Runtime settings need only a restart.** `.env.local` (API keys,
  `JUSTIFIER_MODEL`, `LOG_LEVEL`, `AI_GATEWAY`) is read when the server starts,
  not compiled in, so `update-justifier-model.sh` and key changes do not rebuild.
- **If a build fails**, `start.sh` falls back to `next dev` so the arbiter keeps
  answering. `arbiter-status.sh` shows the mode, and `arbiter-doctor.sh` warns
  with `svc.ai_node_mode` until a build succeeds; the build output is in the
  newest `ai-node/logs/ai-node_*.log`. Every start retries the build. To retry by
  hand:

  ```bash
  ~/verdikta-arbiter-node/ai-node/stop.sh
  ~/verdikta-arbiter-node/ai-node/build.sh && ~/verdikta-arbiter-node/ai-node/start.sh
  ```

- **To run `next dev` on purpose**, create `ai-node/.use-next-dev` (kept across
  upgrades) or start with `AI_NODE_MODE=dev`, and restart the AI Node. Delete the
  file to go back; the next start rebuilds.

**Build time and memory.** `next build` peaks at about 1.2 GB of RAM and takes
roughly 20–40 s on fast cores, so expect a few minutes on a small shared-vCPU
VPS. With less than ~1.5 GB of free memory plus swap the kernel kills it (at
1 GB without swap it always fails); the doctor then reports `dev-fallback`.
Add swap before upgrading such a machine:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

During an upgrade the AI Node is down for the build on top of the usual
dependency installs; schedule upgrades of a mainnet node accordingly.

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

## Start at boot

Installs made before October 2026 do not survive a host reboot: the
`chainlink` and `cl-postgres` containers have Docker's default restart policy
(`no`) and the AI Node and External Adapter are plain background processes, so
a provider reboot leaves the node down until someone runs `start-arbiter.sh`
(the 2026-10-18 Contabo reboots cost one mainnet node 15 hours). The upgrade
checks this and offers to fix it in place (`VA_INSTALL_BOOT_SERVICE`, default
`y`; needs sudo, passwordless when unattended): `docker update --restart
unless-stopped` on both containers plus the systemd unit
`verdikta-arbiter.service`, which runs the install's `start-arbiter.sh` after
Docker and the network are up. Nothing else changes: `stop-arbiter.sh` still
stops the node and nothing restarts it until the next `start-arbiter.sh` or
boot. Turn it off with `<install-dir>/arbiter-boot-service.sh disable`, check
it with `arbiter-boot-service.sh status` or the `svc.boot_start` line of
`arbiter-doctor.sh`. See [Service Management](../management/index.md#start-at-boot).

While an upgrade has the node stopped, the watchdog reports `arbiter STOPPED
by operator (stop-arbiter.sh)` and does not self-heal; `start-arbiter.sh`
clears that state.

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

1. AI Node healthy on `http://localhost:3000`, with `Mode: production build (next start)`
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
