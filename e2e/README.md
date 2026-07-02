# Verdikta Arbiter — End-to-End Tests

Automated end-to-end tests for a Verdikta Arbiter node. Two tiers:

| Tier | What it exercises | Determinism | Status |
|---|---|---|---|
| **L2** | Off-chain arbiter pipeline: External Adapter `/evaluate` → AI Node → IPFS, incl. commit-reveal (modes 0/1/2) | `--mock`: deterministic & free · `--real`: real LLMs | ✅ implemented |
| **L4** | Live testnet acceptance: on-chain `requestAIEvaluationWithApproval` → aggregator → `getEvaluation` on Base Sepolia | real, nondeterministic | ✅ implemented |

Assertions are **structural invariants** (scores sum to 1,000,000, correct
length, valid & fetchable justification CID, commit/reveal format) plus, in
mock mode, a deterministic **winner** check.

## Install

```bash
cd e2e
npm install
cp .env.example .env   # then edit
```

## L2 — off-chain pipeline

L2 drives the **External Adapter**'s `/evaluate` endpoint with a pre-pinned
evidence CID and asserts on the response. The harness does **not** start the
External Adapter — start it yourself and point the harness at it with
`--adapter-url` (default `http://localhost:8080`).

### `--mock` (deterministic, free — the CI gate)

The harness starts a bundled **mock AI Node** that returns a fixed, valid score
distribution (winner = `mockAi.winnerIndex`, default 0).

**Turnkey (recommended):** `--boot-adapter` makes the harness also spawn the
External Adapter, wired to the mock automatically:

```bash
export IPFS_PINNING_KEY=<pinata-jwt>       # adapter needs this to upload justifications
node src/index.js l2 --mock --boot-adapter --junit results/l2.xml
```

`--boot-adapter` requires the External Adapter's deps to be installed
(`cd ../external-adapter && npm ci`). It sets `OPERATOR_ADDR` to a dummy address
unless you export a real one.

**Manual:** start the External Adapter yourself, pointed at the mock, then run
without `--boot-adapter`:

```bash
# terminal 1: adapter pointed at the mock (default mock port 8547)
cd ../external-adapter
AI_NODE_URL=http://localhost:8547 OPERATOR_ADDR=0x0000000000000000000000000000000000000001 \
  IPFS_PINNING_KEY=<pinata-jwt> npm start
# terminal 2:
cd ../e2e && npm run l2:mock
```

> The External Adapter still uploads the justification to IPFS (Pinata), so a
> valid `IPFS_PINNING_KEY` (JWT) and network access are required even in mock
> mode. The evidence CID is fetched from a public IPFS gateway.

### `--real` (real LLMs — nightly / manual)

Point the External Adapter at a real AI Node (`AI_NODE_URL=http://localhost:3000`)
with provider API keys configured, then:

```bash
node src/index.js l2 --real --assert-winner --report results/l2-real.json
```

In `--real` mode the winner is only asserted when a scenario declares
`expectedWinnerIndex` **and** `--assert-winner` is passed (model output is
nondeterministic); otherwise only structural invariants are checked.

## `smoke` — post-deploy check

Runs one scenario (mode 0) against the **live** running arbiter (real AI Node),
structural assertions only. Intended as a stronger post-install/upgrade check
than `arbiter-doctor`'s health ping:

```bash
node src/index.js smoke --adapter-url http://localhost:8080
```

## L4 — live testnet acceptance

Submits a real request on-chain (EOA-direct) to the **ReputationAggregator**,
polls `getEvaluation`, and fetches the justification from IPFS. Nondeterministic
(real oracle network + LLMs), so assertions are structural + optional winner.

```bash
export RPC_URL=https://sepolia.base.org
export E2E_WALLET_PRIVATE_KEY=0x...          # dedicated, funded Base Sepolia key (secret!)
# AGGREGATOR_ADDRESS defaults to config/e2e-config.json (l4.aggregatorAddress); override if needed
node src/index.js l4 --junit results/l4.xml
```

### L4 test wallet

Never reuse a personal or mainnet wallet for this. Generate a fresh, dedicated
one locally:

```bash
npm run generate-wallet
```

This prints a new random address + private key (using `ethers`, offline — no
network calls, nothing written to disk). Then:

1. **Fund the address** with a small amount of Base Sepolia ETH from a faucet —
   see [Base's faucet directory](https://docs.base.org/base-chain/network-information/network-faucets)
   (Coinbase Developer Platform, Alchemy, thirdweb, etc. all support Base
   Sepolia; most cap claims at ~0.01–0.5 ETH per 24h). Each L4 request costs up
   to `maxTotalFee` (~0.0012 ETH with the default fee config) plus gas, so
   0.02–0.05 ETH covers many runs.
2. **Store the private key only** as the `E2E_WALLET_PRIVATE_KEY` secret in the
   `e2e` GitHub Environment (Settings → Environments → e2e → Environment
   secrets). Never commit it, paste it in chat/PRs, or reuse it elsewhere.
3. Clear your terminal scrollback once it's saved.

To rotate the wallet later, just run `npm run generate-wallet` again, fund the
new address, and update the secret — the old key can be abandoned (it only
ever held test funds).

Requires: a funded testnet wallet (worst-case ~`maxTotalFee` per request + gas),
the aggregator deployed, and **at least one live registered arbiter** serving the
requested class (128). Fee params come from `config.l4.fees` (defaults match the
DemoClient: `maxOracleFee=15e13`, `estimatedBaseCost=8e9`, `maxFeeScaling=5`,
`alpha=500`).

## CI & secret handling

`.github/workflows/e2e.yml`:

- **`l2-mock`** — runs on PRs/pushes (same-repo) and manual dispatch; boots the
  adapter + mock AI and asserts the pipeline. Needs `IPFS_PINNING_KEY`.
- **`l4-testnet`** — runs nightly (schedule) and via manual dispatch; needs
  `RPC_URL` + `E2E_WALLET_PRIVATE_KEY` (and optional `AGGREGATOR_ADDRESS`),
  scoped to the `e2e` GitHub Environment.

Secret guidance:

- Store as **encrypted GitHub Actions secrets**; reference via `env:` (never echo).
- Secrets are **not** exposed to **fork** PRs — the secret-dependent jobs are
  gated to same-repo events and skip otherwise.
- Use a **GitHub Environment** (`e2e`) for the wallet key, optionally with
  required reviewers.
- Use **least-privilege, rotatable** keys: a pinning-only Pinata JWT and a
  dedicated **testnet** wallet with minimal funds — never a mainnet key.

## Canonical evidence archive (project-owned)

Rather than depend on third-party pinned CIDs, this repo ships a **canonical
archive source** under `archives/contract-vuln/` (a reentrancy contract review;
outcomes `[Vulnerabilities, Safe]`). Build/validate/pin it with:

```bash
# offline: build a deterministic zip, validate it via @verdikta/common, predict its CID
npm run build-archive -- --validate --predict-cid

# pin it to IPFS (Pinata) and record the CID for the tests to use
IPFS_PINNING_KEY=<pinata-jwt> npm run build-archive -- --pin
#   → writes archives/contract-vuln.cid (commit this file)
```

The `canonical-vuln` scenario references the archive via `cidFile:
archives/contract-vuln.cid`. Until the archive is pinned (i.e. that file
exists), the scenario is **skipped** in full-suite runs (and errors if requested
explicitly by id). Once pinned and the `.cid` is committed, it activates
automatically. The built `.zip` is reproducible from source and is gitignored;
the pinned `.cid` **is** committed.

> Because the archive is content-addressed and the build is deterministic,
> re-pinning the same source yields the same CID.

**Why this matters in practice:** the `verdikta-dispatcher/demoClient` default
archive (`QmSnynnZVufbeb9GVNLBjxBJ45FyHgjPYUHTvMK5VmQZcS`) has empty-string
`type`/`description` fields on its `additional[]` entry, which passed
validation under `@verdikta/common@1.3.x` but is **rejected** by `@1.6.0`'s
stricter Joi schema (`Joi.string()` disallows `""` even when the field is
optional). Since that archive isn't ours to fix and is pinned/immutable, it was
dropped from `scenarios.json` rather than papered over — exactly the kind of
external breakage a project-owned archive avoids. If external-CID scenarios are
reintroduced later, expect them to need periodic revalidation against the
`@verdikta/common` version actually in use.

## Scenarios

`scenarios/scenarios.json` — each entry needs `id` and either `cid` (literal) or
`cidFile` (path to a file containing the CID, e.g. from `--pin`):

```json
{
  "id": "canonical-vuln",
  "cidFile": "archives/contract-vuln.cid",   // resolved at load; or use "cid": "Qm…"
  "modes": ["0", "commit-reveal"],
  "minOutcomes": 2,             // structural check
  "expectedWinnerIndex": 0      // mock: always asserted; real: with --assert-winner
}
```

## Configuration

`config/e2e-config.json` holds defaults; `.env` and CLI flags override. Key
knobs: `adapterUrl`, `mockAi.{port,winnerIndex,winnerShare}`,
`ipfs.{gateway,checkJustificationFetch}`, `timeouts`, `tolerances.scoreSumSlack`.

## Reports

- `--report <file>` — JSON summary
- `--junit <file>` — JUnit XML (for CI)

Exit code is `0` when all cases pass, `1` otherwise.

## Roadmap / ideas

- Optionally boot the AI Node too (for turnkey `l2 --real` in CI).
- Pin a canonical, project-owned E2E evidence archive (instead of relying on the
  frontend/demoClient default CIDs) and reference it from `scenarios.json`.
- Additional scenarios (more outcomes, multi-CID, attachments) once canonical
  archives are pinned.
