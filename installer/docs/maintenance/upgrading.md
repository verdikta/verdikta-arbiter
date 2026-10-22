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

## Closing the exposed ports

A read-only port review on 2026-10-21 found the Chainlink database (5432), the
Chainlink UI/API (6688), the AI Node (3000) and the External Adapter (8080)
reachable from the internet on the hosts it checked: the installer published them
on every interface, no firewall was active, the database was under constant
password guessing, and the AI Node and adapter have no authentication in front of
the operator's LLM keys. Installs made before this change are affected; new
installs publish nothing but the adapter (see below).

The upgrade checks this and offers the fix in place. **It is your choice and it
is opt-in when unattended**: interactive upgrades default to yes,
unattended upgrades (`--unattended`, `--answers`) default to **no** unless you
set `VA_UPGRADE_HARDEN_PORTS=y`, so an unattended upgrade never changes a node's
networking by itself.

```bash
# interactive: answer the prompt "Close these ports to the internet (needs sudo)?"
installer/bin/upgrade-arbiter.sh

# unattended, opting in (passwordless sudo needed):
VA_UPGRADE_HARDEN_PORTS=y installer/bin/upgrade-arbiter.sh --unattended
# ... or put VA_UPGRADE_HARDEN_PORTS="y" in the --answers file
```

What it does (`<install-dir>/arbiter-firewall.sh enable`):

- adds iptables rules, IPv4 and IPv6, that **drop** 5432, 6688, 3000 and 8080 on
  the **public network interface only** (found with `ip route get`, never
  hard-coded). Chainlink to the database, Chainlink to the adapter (the bridge
  URL is the host's own address) and the adapter to the AI Node arrive on
  `docker0`, `br-*` or `lo`, not on the public interface, so they keep working.
  SSH is not touched;
- keeps them across reboots with a systemd oneshot unit,
  `verdikta-arbiter-firewall.service`, ordered after Docker (and after
  `verdikta-sandbox.service` where that exists). The unit contains plain
  `iptables` lines; nothing from your install directory runs as root;
- makes the AI Node listen on `127.0.0.1` from its next start (a marker file,
  `<install-dir>/.ai-node-loopback`, that `ai-node/start.sh` reads, so reboots
  and the start-at-boot unit honour it) and points the adapter's default
  `AI_NODE_URL` at `http://127.0.0.1:3000`. The upgrade restarts the arbiter
  anyway, so no extra restart is needed. If the adapter's `AI_NODE_URL` names
  any other address, the bind is left alone (a loopback-only AI Node would no
  longer answer it) and you are told;
- first checks where Chainlink calls the adapter: the `verdikta-ai` bridge URL,
  read from Chainlink's database, must name an address of this machine (the
  usual case: the host's own public IP, which is local delivery on a Docker
  bridge). If it names something else (a load balancer, a NAT'd floating IP) the
  call would leave through the public interface and the `8080` rule would cut
  Chainlink off, so `enable` refuses (`--ignore-bridge-check` overrides). After
  the upgrade has restarted the arbiter it probes the bridge from inside the
  `chainlink` container and tells you loudly, with the undo command, if that
  fails. Run it yourself with `arbiter-firewall.sh check-bridge --probe`.

**Reaching the Chainlink UI afterwards** (it is the operator's admin plane, so it
is no longer on the internet): open an SSH tunnel from your machine and browse
`http://localhost:6688`:

```bash
ssh -L 6688:127.0.0.1:6688 <user>@<arbiter-host>
```

Check or undo it any time:

```bash
~/verdikta-arbiter-node/arbiter-firewall.sh status            # exit 0 = closed; --quiet for scripts
sudo ~/verdikta-arbiter-node/arbiter-firewall.sh disable      # remove the rules, the unit and the AI Node marker
~/verdikta-arbiter-node/arbiter-firewall.sh enable --print-rules   # show the exact iptables commands, change nothing
```

`arbiter-doctor.sh` (`svc.public_ports`) and `arbiter-status.sh` report the
state. The doctor cannot test the host's *external* reachability from inside the
host, so it checks bind addresses and the rules and tells you to confirm from
another machine: `nc -z -w5 <public-ip> 5432` (and 6688, 3000, 8080) should
time out while `nc -z -w5 <public-ip> 22` connects.

Notes:

- A host with a second, private network interface (for example a DigitalOcean
  VPC `eth1`) keeps those ports open on it; add `--interface eth0 --interface
  eth1` to `enable` to close it too. A later plain `enable` (the upgrade offers
  one whenever `status` is not clean) keeps the interfaces of the installed
  unit; to shrink the set, `disable` first.
- If Docker publishes a port on a public address but has no `DOCKER-USER` chain
  (Docker on its nftables backend, or started after the unit ran), the rules
  cannot hold it: `enable` and `status` say so and exit 1 instead of reporting
  "closed". Start Docker and re-run `enable`, or close the port in your
  provider's firewall.
- The rules do not stop a machine **on the same host** from calling the ports,
  and the adapter and AI Node still have no authentication of their own.
  A provider firewall (allow SSH only) is the best additional layer where one
  is available.
- There is a short window after a reboot between Docker starting the containers
  and the unit adding the rules (seconds).

### Publishing the Chainlink UI on loopback (optional second layer)

Docker fixes published ports when a container is created, so older installs keep
`-p 6688:6688`. The upgrade offers, as a **separate question**
(`VA_UPGRADE_BIND_CHAINLINK_LOCAL`, default **no** both interactively and
unattended because it restarts Chainlink), to recreate the `chainlink` container
with `-p 127.0.0.1:6688:6688`. It is asked **after** the arbiter has been
restarted, because the recreate only works on a running container: that is what
lets it start the replacement and see it answer before the old container is
removed. The replacement is created first from the old container's settings
(image, `/chainlink` mount, restart policy, log options, network, command), the
old container is only then stopped (30 s grace), and the old one is restored if
the new one does not start or exits. Expect about a minute of Chainlink
downtime. It refuses and changes nothing when the container is stopped or has
settings it would drop. Run it yourself with
`<install-dir>/apply-chainlink-loopback.sh --apply`; `--check` reports, and
`--revert` publishes on all interfaces again.

### What this does not change

- **The database container is never recreated by an upgrade.** `cl-postgres`
  sits on an anonymous Docker data volume; recreating it without that volume
  would start Chainlink against an empty database. On existing installs the
  firewall is therefore the control for 5432. Fresh installs create it without
  a host port and Chainlink reaches it as `cl-postgres:5432` over
  `verdikta-network`. Never publish 5432 on `127.0.0.1` only while
  `secrets.toml` says `host.docker.internal:5432`: that name is the `docker0`
  gateway, not loopback, and Chainlink would lose its database.
- **The External Adapter (8080) keeps listening on all interfaces**: the
  Chainlink container calls it through the host's own address. An optional
  `HOST` variable in `external-adapter/.env` can bind one specific address; the
  wildcard values (`0.0.0.0`, `::`, empty or unset, which is what the installer
  has always written) keep today's behaviour exactly. The firewall is what
  protects 8080. There is no adapter authentication yet.
- A Postgres password that may already have been guessed is not rotated. Check
  `docker exec cl-postgres psql -U postgres -c '\du'` and
  `select client_addr, usename, state from pg_stat_activity`.

### New installs

`install.sh` creates `cl-postgres` without a host port, points `secrets.toml` at
`cl-postgres:5432`, publishes the Chainlink UI on `127.0.0.1`, binds the AI Node
to loopback (including the throwaway AI Node that install phases 3 and 4 start for
their tests) and offers `arbiter-firewall.sh enable` for the one port that must
stay reachable through the host's address, the adapter (`VA_INSTALL_FIREWALL`,
default `y`).

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
