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
| External Adapter `commitStore` runs in RAM-only mode and would lose commits across restarts | `ea.commit_store_mode` (WARN — latent risk, not active outage) |
| RPC keeps rejecting fulfill txs with "Invalid params" | `txm.invalid_params_recent` (FAIL when recent, INFO when only historical) |
| Chainlink emitting CRIT lines | `txm.crit_lines_recent` (FAIL when recent, INFO when only historical) |
| Chainlink RPC websocket out of sync | `txm.rpc_out_of_sync` (WARN when recent, INFO when only historical) |
| RPC pool at 0 live nodes — TxManager cannot broadcast, commits miss their round deadline (July 2026 outage) | `txm.no_live_rpc_nodes` (CRIT when recent, INFO when only historical) |
| Operator contract not deployed at configured address (e.g. wrong network) | `chain.operator_code` (FAIL) |
| Job spec `fromAddress` doesn't match `NODE_ADDRESS` | `cfg.job_from_addr` (CRIT) |
| Node key missing from chainlink keystore | `txm.key_registered` (CRIT) |
| `IPFS_PINNING_KEY` missing or not a JWT (Pinata uploads 401 INVALID_CREDENTIALS) | `ea.pinata_key_format` (FAIL) |
| Pinata 401 / upload failures in recent EA log | `ea.recent_pinata_errors` (FAIL / WARN) |
| `JUSTIFIER_MODEL` unset, malformed, or points at Ollama without a running Ollama daemon | `ai.justifier_model` (FAIL) |
| Container or service down | `svc.ai_node` / `svc.adapter` / `svc.chainlink` / `svc.postgres` |

The current build runs **30 checks** across six sections: `cfg.*`, `svc.*`,
`chain.*`, `txm.*`, `ea.*`, `ai.*`.

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
| `INFO` | Informational observation (e.g. on-chain nonce value, or stale log entries that have aged out of the alert window) | no |
| `WARN` | Something looks off but the arbiter probably still works | yes (exit 1) |
| `FAIL` | The arbiter likely cannot fulfill some requests | yes (exit 2) |
| `CRIT` | The arbiter cannot function at all | yes (exit 3) |

`--quiet` only prints `WARN`/`FAIL`/`CRIT` lines, which makes it suitable
for cron alerting: if the script produces output, something needs attention.

### Recency-aware log checks

The chainlink-log-derived checks (`txm.crit_lines_recent`,
`txm.invalid_params_recent`, `txm.rpc_out_of_sync`) classify findings by
recency. The doctor scans the last 20 000 lines of the chainlink container
log and splits matches into "recent" (within the last hour) vs. "stale":

- **Recent matches** → emit at the configured severity (FAIL for `crit_lines_recent`
  / `invalid_params_recent`, WARN for `rpc_out_of_sync`).
- **Only stale matches** → emit `INFO` with a "will scroll out of the rolling
  window over time" hint.
- **No matches at all** → `PASS`.

This stops historical incidents from producing FAIL noise long after they've
been resolved.

## Fix mode

`--fix` walks every `FAIL`/`CRIT` finding (WARN/INFO are skipped — they're not
considered "broken") and asks before each material command. The
auto-remediations it knows about are:

| Finding | Auto-fix command |
|---|---|
| `chain.node_balance_zero`, `chain.node_balance` (low) | `fund-chainlink-keys.sh --amount 0.01` |
| `chain.is_authorized` / `chain.authorized_senders_list` | `arbiter-operator/setAuthorizedSenders-dynamic.sh` |
| `txm.stuck_unconfirmed` / `txm.stuck_in_progress` / `txm.local_nonce_vs_chain` | stop chainlink → wipe stale `evm.txes` rows → start chainlink |

Anything else is left to the operator with a printable hint that points at
the right rotation tool (see below) or manual recovery command.

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

## Companion rotation tools

For findings the doctor flags as configuration drift rather than infrastructure
failure, two dedicated rotation tools ship alongside the doctor in the
install root:

| Tool | What it does |
|---|---|
| `update-pinata-key.sh` | Rotates the Pinata JWT used by the External Adapter for IPFS uploads. Validates the JWT format (must be 3 dot-separated segments starting with `eyJ`), runs a live `GET /data/testAuthentication` round-trip against Pinata, writes `IPFS_PINNING_KEY` to `external-adapter/.env`, and restarts the EA with port-8080 verification. `--dry-run`, `--no-verify`, `--no-restart`, `--jwt TOKEN` supported. |
| `update-justifier-model.sh` | Rotates the AI Node's `JUSTIFIER_MODEL` env var (the model that produces the final consolidated justification). Validates the provider class, detects the Ollama-without-Ollama foot-gun, previews the OpenRouter-mapped model id, writes `JUSTIFIER_MODEL` to `ai-node/.env.local`, and restarts the AI Node. `--dry-run`, `--no-restart`, `--model "Provider:model-name"` supported. |

The doctor's remediation hints point at these tools whenever they're the right fix.

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
the doctor scripts (plus `update-pinata-key.sh` and `update-justifier-model.sh`)
into the install root, and run a final `--quiet` health check **after** the
service start/restart step at the end of the run. Key points:

- **Conditional**: the post-install/upgrade check only runs if services were
  actually (re)started during the same invocation. If the operator declined
  the restart prompt, the check is skipped with a "run the doctor manually
  later" hint — otherwise every `svc.*` check would FAIL purely because
  nothing was running yet.
- **Advisory**: a non-zero exit code is reported in red but does **not** abort
  the install. WARN/FAIL/CRIT lines surface immediately so the operator knows
  what to address before declaring the install done.
- **Settling time**: an extra 10–15s sleep precedes the doctor pass so the
  AI Node (Next.js dev server, takes 30+s to compile + bind on cold start)
  has a chance to be ready.

## Cron / monitoring usage

For fast paging on the specific "0 live RPC nodes / cannot broadcast" failure
mode (the July 2026 silent outage), use the dedicated watchdog, which ships
alongside the doctor in the install root and runs in ~2 seconds:

```bash
# Install a */2-minute cron entry; alerts via syslog and, if configured,
# WATCHDOG_ALERT_WEBHOOK / WATCHDOG_ALERT_COMMAND (installer/.env).
~/verdikta-arbiter-node/chainlink-health-watchdog.sh --install-cron 2

# Optional stopgap: restart the chainlink container on the 0-live condition
# (always alerts first; never restarts silently, max once per 30 min).
~/verdikta-arbiter-node/chainlink-health-watchdog.sh --install-cron 2 --self-heal
```

The full doctor is heavier (~30s) and better suited to a coarser interval:

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
exactly one `emit` call. The `emit` signature is:

```
emit SEVERITY ID MESSAGE [HINT]
```

- `SEVERITY` ∈ `PASS` / `INFO` / `WARN` / `FAIL` / `CRIT`
- `ID` is a dotted name (e.g. `chain.node_balance_zero`)
- `MESSAGE` is shown for every severity; keep it concise and concrete
- `HINT` is shown only for `WARN`/`FAIL`/`CRIT` and should be an actionable
  command the operator can run

```bash
emit PASS my.check_id "human description of pass state"
emit FAIL my.check_id "what's wrong"  "command the operator should run"
```

If the check has an automated remediation, add a `case "$id"` clause to
`run_fix_mode` that prompts and applies it (only `FAIL`/`CRIT` findings are
walked; `WARN` findings show their hint but don't trigger fix-mode prompts).

For log-derived checks where stale matches shouldn't false-positive forever,
use the `_classify_chainlink_pattern` helper inside `check_chainlink_txm`
(or write a similar helper) to bucket matches by recency before emitting.

Then `cp arbiter-doctor.sh remote-doctor.sh` and re-run the small patch
(see `installer/util/remote-doctor.sh` header) to keep the remote variant in
sync.
