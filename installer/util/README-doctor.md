# Arbiter Doctor

`arbiter-doctor.sh` is a comprehensive diagnostic tool for Verdikta Arbiter
nodes. It surfaces, in roughly 30 seconds and zero configuration, every failure
mode we have observed in production — including the silent-outage class that
caused the April–May 2026 incident:

| Symptom we have observed | Check that catches it |
|---|---|
| Node EOA never funded (0 ETH balance) | `chain.node_balance_zero` (CRIT) |
| `setAuthorizedSenders` was never called | `chain.is_authorized`, `chain.authorized_senders_list` (CRIT) |
| Chainlink TXM has stuck unconfirmed transactions | `txm.stuck_unconfirmed` (FAIL) |
| Chainlink local nonce out of sync with chain | `txm.local_nonce_vs_chain` (FAIL) |
| External Adapter `commitStore` runs in RAM-only mode and loses commits across restarts | `ea.commit_store_mode` (FAIL) |
| RPC keeps rejecting fulfill txs with "Invalid params" | `txm.invalid_params_recent` (FAIL) |
| Chainlink emitting CRIT lines | `txm.crit_lines_recent` (FAIL) |
| Operator contract not deployed at configured address (e.g. wrong network) | `chain.operator_code` (FAIL) |
| Job spec `fromAddress` doesn't match `NODE_ADDRESS` | `cfg.job_from_addr` (CRIT) |
| Node key missing from chainlink keystore | `txm.key_registered` (CRIT) |
| Container or service down | `svc.ai_node` / `svc.adapter` / `svc.chainlink` / `svc.postgres` |

## Quick reference

```bash
# Run a diagnostic against the local install (default human output)
arbiter-doctor.sh

# Machine-readable (one JSON object per check)
arbiter-doctor.sh --json | jq .

# Only print problems (good for cron + alerting)
arbiter-doctor.sh --quiet

# Walk through findings and offer to remediate each one interactively.
# Every material command requires y/N confirmation; no fixes are applied
# automatically.
arbiter-doctor.sh --fix

# Bundle sanitized logs + state into a tarball you can share with support.
# Strips PRIVATE_KEY, API keys, IPFS pinning secrets, etc.
arbiter-doctor.sh --collect /tmp/arbiter-diag.tgz

# Run against a different install root than the autodetected one
arbiter-doctor.sh --install-dir /opt/some-other-arbiter
```

Exit codes: `0` healthy, `1` warnings only, `2` failures, `3` critical, `64`
argument misuse.

## Severity levels

| Severity | Meaning | Counts toward exit code? |
|---|---|---|
| `PASS` | Check passed | no |
| `INFO` | Informational observation (e.g. on-chain nonce value) | no |
| `WARN` | Something looks off but the arbiter probably still works | yes (exit 1) |
| `FAIL` | The arbiter likely cannot fulfill some requests | yes (exit 2) |
| `CRIT` | The arbiter cannot function at all | yes (exit 3) |

`--quiet` only prints `WARN`/`FAIL`/`CRIT` lines, which makes it suitable
for cron alerting: if the script produces output, something needs attention.

## Fix mode

`--fix` walks through every `FAIL`/`CRIT` finding and asks before each
material command. The auto-remediations it knows about are:

| Finding | Auto-fix command |
|---|---|
| `chain.node_balance_zero`, `chain.node_balance` (low) | `fund-chainlink-keys.sh --amount 0.01` |
| `chain.is_authorized` / `chain.authorized_senders_list` | `arbiter-operator/setAuthorizedSenders-dynamic.sh` |
| `ea.commit_store_mode` | patches `commitStore.js` `USE_FILE=true` and restarts EA |
| `txm.stuck_unconfirmed` / `txm.stuck_in_progress` / `txm.local_nonce_vs_chain` | stop chainlink → wipe stale `evm.txes` rows → start chainlink |

Anything else is left to the operator with a printable hint.

The fix mode refuses to run without an interactive TTY, so accidental
non-interactive invocations cannot apply destructive changes.

## Collect mode

`--collect` produces a sanitized tarball containing:

- `doctor-report.txt` — the doctor's findings, columnated for legibility
- `contracts.snapshot` — copy of `installer/.contracts` (addresses only, no secrets)
- `env.sanitized` — copy of `installer/.env` with `PRIVATE_KEY`, `*_API_KEY`, `*_SECRET*`, `IPFS_PINNING_KEY` redacted
- `logs/adapter.log.tail`, `logs/ai-node.log.tail`, `logs/chainlink.log.tail` — last 5000 lines of each component log
- `db/evm_txes.tsv`, `db/evm_tx_attempts.tsv`, `db/evm_key_states.tsv` — chainlink TXM state
- `onchain.txt` — block number, balance, nonce, operator code size

This is the right thing to share with support when reporting a problem;
nothing in the bundle is secret.

## Remote variant

`remote-doctor.sh` is the same script with `--fix` and `--collect` disabled
at the top, suitable for `scp`-ing to a foreign arbiter you want to inspect
without any risk of accidentally modifying its state:

```bash
scp arbiter-doctor-node:installer/util/remote-doctor.sh other-node:/tmp/
ssh other-node /tmp/remote-doctor.sh --quiet
```

## Integration with install / upgrade

`installer/bin/install.sh` and `installer/bin/upgrade-arbiter.sh` both copy
the doctor scripts into the install root and run a final `--quiet` pass at
the end of the install. A non-zero exit code there is logged but does not
abort the install (warnings would be too aggressive a default); operators
should treat any non-PASS output as a "fix me now" signal before declaring
the install done.

## Cron / monitoring usage

```cron
# Every 5 minutes: if the doctor prints anything (i.e. exit != 0), forward
# that to your alerting hook. Otherwise stay silent.
*/5 * * * * /root/verdikta-arbiter-node/arbiter-doctor.sh --quiet 2>&1 \
    | while read -r line; do echo "$line"; done \
    | curl -fsS --max-time 5 -X POST -H 'Content-Type: text/plain' \
        --data-binary @- https://alert.example.com/arbiter || true
```

## Extending the doctor

Add a new check by writing a function in the appropriate section
(`check_config`, `check_services`, `check_onchain`, `check_chainlink_txm`,
`check_external_adapter`, or `check_ai_node`) and ending each finding with
exactly one `emit` call:

```bash
emit PASS my.check_id "human description of pass state"
emit FAIL my.check_id "what's wrong"  "command the operator should run"
```

If the check has an automated remediation, add a `case "$id"` clause to
`run_fix_mode` that prompts and applies it.

Then `cp arbiter-doctor.sh remote-doctor.sh` and re-run the small patch
(see `installer/util/remote-doctor.sh` header) to keep the remote variant in
sync.
