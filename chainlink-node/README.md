# Chainlink Node

Configuration templates, job specifications, and helper scripts for running a Chainlink node as part of the Verdikta Arbiter system.

## Contents

| File | Purpose |
|---|---|
| `config_template.toml` | Chainlink node configuration template with placeholder tokens |
| `basicJobSpec` | Parameterized TOML job specification for arbiter jobs |
| `MyOperator.sol` | Reference Chainlink Operator contract |
| `MyQuery.sol` | Reference query contract for testing |
| `startCL.sh` | Starts the Chainlink node process |
| `prestart.sh` | Pre-start validation and setup |
| `trackCL.sh` | Monitors Chainlink node status |

## Limits

`basicJobSpec` allows a job 840 s (`maxTaskDuration` and the bridge's `timeout`), for a code-review evaluation; `config_template.toml` raises `[JobPipeline] MaxRunDuration` to 15 m, above Chainlink 2.23.0's default of 10 m. A running job keeps the values it was created with: see `installer/util/apply-job-timeouts.sh` and `installer/docs/maintenance/upgrading.md`.

## Usage

These files are consumed by the installer scripts in `../installer/bin/`. In a typical deployment the installer handles configuration, job creation, and node lifecycle automatically.

For manual operation see the [installation documentation](../installer/docs/README.md).

## Networks

The Chainlink node connects to Base Sepolia (testnet) or Base Mainnet depending on deployment configuration. Network-specific settings are populated from environment variables at install time.
