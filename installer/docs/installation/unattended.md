# Unattended Installation and Upgrade

The installer and the upgrade script can run with no keyboard at all. Every
question they would ask is answered from a small **answers file** (or from
`VA_*` environment variables), which is what lets a deployment tool, a CI job,
or a [Verdikta agent](https://github.com/verdikta/verdikta-agents) install and
maintain arbiters over SSH.

Interactive runs are unchanged: without `--answers` / `--unattended` the
scripts prompt exactly as before.

## Quick start

```bash
git clone https://github.com/verdikta/verdikta-arbiter.git
cd verdikta-arbiter/installer

cp config/unattended.env.example ~/arbiter-answers.env
chmod 600 ~/arbiter-answers.env
$EDITOR ~/arbiter-answers.env          # at minimum: VA_PRIVATE_KEY + RPC endpoints

./bin/install.sh --answers ~/arbiter-answers.env
```

The answers are validated **before** anything is installed
(`installer/bin/validate-answers.sh`); a missing or malformed value stops the
run with the key name to fix. Delete the answers file when the run finishes —
it holds your private key and API keys.

Upgrades work the same way, and unset keys take the safe defaults (no job
regeneration, no funding):

```bash
cd verdikta-arbiter && git pull
./installer/bin/upgrade-arbiter.sh --answers ~/arbiter-answers.env
# or, with no file at all:
./installer/bin/upgrade-arbiter.sh --unattended --target-dir ~/verdikta-arbiter-node
```

## How it works

* `installer/lib/prompts.sh` provides `ask_yes_no`, `prompt_value` and
  `prompt_secret`. Interactively they behave like the `read` loops they
  replaced. When `VERDIKTA_UNATTENDED=1` is exported they never touch stdin:
  each question is answered from its `VA_*` key, else from the default the
  call site declares, else the run **fails fast** (exit code 65) naming the
  missing key. Nothing ever blocks waiting for a terminal.
* `--answers FILE` sources the file with every variable exported, so the
  answers reach all sub-scripts (`setup-environment.sh`, `configure-node.sh`,
  `register-oracle-dispatcher.sh`, …).
* `--unattended` does the same without a file: put the `VA_*` variables in
  the environment instead.
* A value the installer rejects (for example a private key that is not 64
  hex characters) does not loop forever — the second attempt to read the same
  key aborts the run with "rejected by validation".
* Piping answers into an interactive run (`printf 'y\n' | ./bin/install.sh`)
  still works, and exhausting stdin now aborts with a clear message instead of
  spinning on a yes/no loop.

## Answer keys

The complete, commented list is
[`installer/config/unattended.env.example`](https://github.com/verdikta/verdikta-arbiter/blob/main/installer/config/unattended.env.example).
The keys that matter most:

| Key | Meaning | Default |
|---|---|---|
| `VA_PRIVATE_KEY` | Deployment wallet private key (64 hex, `0x` tolerated). **Required.** | — |
| `VA_RPC_HTTP_URLS` + `VA_RPC_WS_URLS` | Semicolon-separated RPC lists (paired). **One of these or `VA_INFURA_API_KEY` is required.** | — |
| `VA_INFURA_API_KEY` | Infura key; endpoints are generated for the network | — |
| `VA_NETWORK` | `base_sepolia` or `base_mainnet` | `base_sepolia` |
| `VA_INSTALL_DIR` | Installation directory | `~/verdikta-arbiter-node` |
| `VA_OPENAI_API_KEY`, `VA_ANTHROPIC_API_KEY`, `VA_HYPERBOLIC_API_KEY`, `VA_XAI_API_KEY`, `VA_OPENROUTER_API_KEY` | Provider keys (blank = skip) | blank |
| `VA_PINATA_JWT` | Pinata JWT for IPFS uploads | blank |
| `VA_JUSTIFICATION_MODEL` | Menu number 1-10 | recommended for your keys |
| `VA_ARBITER_COUNT` | Jobs to create (1-10) | `1` |
| `VA_REGISTER_ORACLE` / `VA_AGGREGATOR_ADDRESS` / `VA_CLASS_IDS` | Dispatcher registration | `n` / — / `128` |
| `VA_INSTALL_CRON`, `VA_STATUS_PAGE_REPORTING` | Watchdog cron + status-page reporting | `y` / `y` |
| `VA_FUND_KEYS` / `VA_FUND_AMOUNT` | Fund the Chainlink keys at the end | `n` / recommended |
| `VA_START_SERVICES` | Start the arbiter when done | `y` |
| `VA_UPGRADE_BACKUP` | (upgrade) copy the install aside first | `y` |
| `VA_UPGRADE_REGENERATE_JOBS` | (upgrade) regenerate job specs + re-register on-chain | `n` |

Yes/no keys accept `y`/`n`, `yes`/`no`, `true`/`false`, `1`/`0`.

## Standalone tools

The operator tools copied into the install root accept the same flags:

```bash
~/verdikta-arbiter-node/register-oracle.sh --answers ~/arbiter-answers.env   # VA_AGGREGATOR_ADDRESS, VA_CLASS_IDS
~/verdikta-arbiter-node/update-rpc-endpoints.sh --unattended                 # VA_RPC_HTTP_URLS, VA_RPC_WS_URLS
~/verdikta-arbiter-node/arbiter-doctor.sh --fix --yes                        # already non-interactive
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | A step failed (see the log) |
| `65` | An unattended answer is missing or was rejected; nothing further was run |

## Running over SSH

The scripts install Node.js and Docker with `sudo` on Ubuntu/Debian, so the SSH
user must be `root` or have passwordless sudo. Long-running installs should be
detached so an SSH drop does not kill them:

```bash
nohup ./bin/install.sh --answers ~/arbiter-answers.env > ~/arbiter-install.log 2>&1 &
tail -f ~/arbiter-install.log
```
