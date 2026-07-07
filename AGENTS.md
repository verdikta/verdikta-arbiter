# AGENTS.md — Verdikta Arbiter Onboarding

> Fast-start guide for AI agents (and new engineers) working in this repository.
> Read this first. It reflects the **actual code** as of this writing, not
> aspirational marketing docs. Where older docs disagree with code, the code
> wins — see [Known doc caveats](#known-doc-caveats).

---

## 1. What this repo is

A **Verdikta Arbiter** is a self-hostable node that acts as a **decentralized,
AI-powered oracle for dispute resolution / evaluation** on the Base blockchain
(Base Sepolia testnet and Base Mainnet).

A smart-contract client (an "application") asks a question with a fixed set of
possible **outcomes** plus supporting **evidence**. A panel ("jury") of AI models
scores the outcomes, and the arbiter returns a numeric score vector plus a
written justification, recorded on-chain and on IPFS. Multiple independent
arbiters are aggregated by an on-chain **Dispatcher** so no single node decides.

This repo is **one arbiter node** (the operator-hosted software + the operator
smart contract). It is *not* the Dispatcher/aggregator contract, the
`@verdikta/common` library, or the client applications — those live elsewhere.

---

## 2. The five components

| Component | Dir | Tech | Role |
|---|---|---|---|
| **AI Node** | `ai-node/` | Next.js 14 + TypeScript | Runs the model panel, aggregates weighted scores, writes the justification. The "brains". |
| **External Adapter (EA)** | `external-adapter/` | Node.js + Express | Chainlink bridge. Fetches evidence from IPFS, calls the AI Node, handles commit-reveal, uploads justification to IPFS (Pinata). |
| **Chainlink Node** | `chainlink-node/` | Chainlink Core + Postgres (Docker) | Watches chain for oracle requests, runs the job pipeline, submits results on-chain. |
| **Arbiter Operator** | `arbiter-operator/` | Solidity 0.8.19 + Hardhat | `ArbiterOperator.sol` — a Chainlink Operator with multi-word responses + a ReputationKeeper allow-list. |
| **Installer** | `installer/` | Bash + Docker | Installs, upgrades, funds, registers, and diagnoses a node. |

Supporting dirs: `testing-tool/` (AI-Node-level scenario harness), `docs/`
(MkDocs operator docs), `installer/docs/` (operator guides), `testing-tool` and
`external-adapter/doc/` (specs).

---

## 3. End-to-end request lifecycle (the mental model)

```
Client contract ──► ReputationAggregator ──► selects oracles by class (ReputationKeeper)
  requestAIEvaluationWithApproval          └─► ArbiterOperator (per node)
                                                      │ emits OracleRequest log
                                                      ▼
                                              Chainlink Node (directrequest job)
                                                      │ "verdikta-ai" bridge
                                                      ▼
                                              External Adapter  POST /evaluate
                                                      │  (fetch IPFS archive)
                                                      ▼
                                              AI Node  POST /api/rank-and-justify
                                                      │  (query model panel)
                                                      ▼
                                    scores[] (sum 1,000,000) + justification
                                                      │  (EA uploads justification → IPFS CID)
                                                      ▼
              Chainlink job encodes (requestId, uint256[] scores, string cid)
                        └─► ArbiterOperator.fulfillOracleRequestV ──► callback
                        └─► ReputationAggregator aggregates commit-reveal responses
                        └─► client reads getEvaluation(requestId)
```

### How applications call the network (client contract API)

Clients never talk to an arbiter directly. They interact with the **ETH-funded
`ReputationAggregator`** (a.k.a. "Verdikta Aggregator"), which lives in a
separate repo/deployment. The two example apps
(`verdikta-applications/example-frontend`, `.../example-bounty-program`) both use:

```solidity
// submit (payable; ETH prepay, unused portion refunded as ethOwed credit)
function requestAIEvaluationWithApproval(
  string[]  cids,                    // one or more IPFS CIDs (evidence packages / bCIDs)
  string    addendumText,            // real-time text appended to the prompt
  uint256   alpha,                   // oracle-selection quality/timeliness blend (e.g. 500)
  uint256   maxOracleFee,            // per-oracle fee ceiling, in wei
  uint256   estimatedBaseCost,
  uint256   maxFeeBasedScalingFactor,
  uint64    requestedClass           // ClassID (default 128) → which oracle pool serves it
) external payable returns (bytes32 requestId);

// read back once fulfilled
function getEvaluation(bytes32 requestId)
  returns (uint256[] likelihoods, string justificationCID, bool exists);

// events
event RequestAIEvaluation(bytes32 indexed requestId, string[] cids);
event FulfillAIEvaluation(bytes32 indexed requestId, uint256[] likelihoods, string justificationCID);
```

`likelihoods` are the same 1,000,000-sum micro-probabilities the AI Node
produces; the rich JSON (scores + justification text) lives at `justificationCID`
on IPFS. The aggregator selects K oracles to commit, requires M commits then N
reveals (commit-reveal), and fulfills once enough reveals agree. Known aggregator
deployments used by the example apps: Base Sepolia
`0xe8a385E473EA710c5a88Cc72681a16a26fe380e4`, Base Mainnet
`0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a` (verify before relying on these —
they are network state, not tracked in this repo).

Key files to trace this:
- Job pipeline: `chainlink-node/basicJobSpec` (a `directrequest` template; `{...}` placeholders are filled at registration).
- EA entry + modes: `external-adapter/src/handlers/evaluateHandler.js`.
- EA → AI Node: `external-adapter/src/services/aiClient.js`.
- Deliberation: `ai-node/src/app/api/rank-and-justify/route.ts`.
- Fulfillment: `arbiter-operator/contracts/ArbiterOperator.sol` (`fulfillOracleRequestV`).

### Commit-reveal aggregation (important, non-obvious)

Because several arbiters answer the same request, the Dispatcher uses
**commit-reveal** so nodes can't copy each other. The EA encodes this in the
`data.cid` string via a **mode prefix**:

- **Mode 0** (`Qm...`): standard — evaluate now, upload justification, return `scores + cid`.
- **Mode 1** (`1:Qm...`): **commit** — evaluate, store `{result, salt}` locally (`commitStore`), return only a 128-bit hash commitment (as a decimal) in `aggregatedScore[0]`. No CID yet.
- **Mode 2** (`2:<hash>`): **reveal** — look up the stored result, upload its justification now, return `scores` + `justificationCid:salt`, then delete the commit.

The commit hash = low/high 128 bits of `sha256(abi.encode(OPERATOR_ADDRESS, scores[], salt))`. This is why the EA **requires `OPERATOR_ADDR`** in its env.

Multiple comma-separated CIDs after the prefix ⇒ multi-CID (multi-party)
evaluation; an optional trailing `:addendum` appends real-time text to the prompt.

---

## 4. Data contracts (get these right)

### Manifest / evidence archive
Evidence is a ZIP archive stored on IPFS containing a `manifest.json`. Parsing
is done by **`@verdikta/common`** (`manifestParser`), not local code. Full spec:
`external-adapter/doc/MANIFEST_SPECIFICATION.md`. Shape:

```json
{
  "version": "1.0",
  "primary": { "filename": "primary_query.json" },
  "juryParameters": {
    "NUMBER_OF_OUTCOMES": 2,
    "AI_NODES": [ { "AI_PROVIDER": "OpenAI", "AI_MODEL": "gpt-4o", "WEIGHT": 0.5, "NO_COUNTS": 1 } ],
    "ITERATIONS": 1
  },
  "additional": [ /* attachment file descriptors */ ],
  "bCIDs": { /* multi-party archive name → description */ },
  "addendum": "optional real-time data description"
}
```
`primary_query.json` holds `{ "query": "...", "outcomes": ["A","B"], "references": [] }`.

### AI Node `POST /api/rank-and-justify` (the core internal API)
Request:
```json
{
  "prompt": "…",
  "outcomes": ["Yes", "No"],
  "models": [ { "provider": "OpenAI", "model": "gpt-4o", "weight": 0.5, "count": 1 } ],
  "iterations": 1,
  "attachments": ["data:image/png;base64,…", "raw text …"]
}
```
Response (see `ai-node/API_RESPONSE_SPECIFICATION.md`):
```json
{
  "scores": [ { "outcome": "Yes", "score": 650000 }, { "outcome": "No", "score": 350000 } ],
  "justification": "…",
  "metadata": { "models_requested": 2, "models_successful": 2, "success_threshold_met": true },
  "model_results": [ … ],
  "warnings": [ … ]
}
```
Rules that matter:
- **Scores are integers summing to 1,000,000** (enforced in prompt + parsing).
- Models run **in parallel** with per-model + per-request timeouts.
- Partial failure is OK: request succeeds if ≥ `MIN_SUCCESSFUL_MODELS_PERCENT` (default 0.5) of models succeed; failed models are excluded from aggregation but their notes appear in justification. `< threshold` ⇒ HTTP 400. Whole-request timeout ⇒ HTTP 408.
- The final **justification** is generated by a separate `JUSTIFIER_MODEL` (env, `provider:model` form).

### Provider naming
Payloads use display names (`OpenAI`, `Anthropic`, `xAI`, `Hyperbolic`,
`Open-source`/`Ollama`, `openrouter`). `ai-node/src/lib/llm/llm-factory.ts` maps
these (case-insensitively, plus ClassID aliases like `Hyperbolic API`) to
providers. `ai-node/src/config/models.ts` lists known models per provider.

### AI Gateway (native vs OpenRouter)
Provider classes route to a native API key when present, else fall back to
OpenRouter. Overrides: `AI_GATEWAY=native|openrouter` and per-class
`<PROVIDER>_CLASS_PROVIDER`. Ollama is always local. See `ai-node/README.md`
("AI Gateway") and `ai-node/DESIGN-OPENROUTER-GATEWAY.md`.

---

## 5. AI Node API surface (actual)
- `POST /api/rank-and-justify` — core deliberation.
- `POST /api/generate` — single-model generation; `GET /api/generate` — list providers/models.
- `GET /api/health` — health check.
- `GET /api/test-hyperbolic` — Hyperbolic connectivity probe.

There is **no** `/api/arbitrate` or `/api/models` endpoint (older docs mention them).

---

## 6. Dev & ops workflows

### Local dev
```bash
cd ai-node && npm install && npm run dev      # http://localhost:3000
cd external-adapter && npm install && npm start   # http://localhost:8080  (needs AI_NODE_URL, OPERATOR_ADDR, IPFS_PINNING_KEY)
```
The **testing-tool** exercises the AI Node directly without any chain/EA:
```bash
cd testing-tool && npm install && npm start -- init && npm start -- test
```
It reads scenarios from `testing-tool/scenarios/scenarios.csv` and juries from
`testing-tool/config/juries/*.json`, calling `/api/rank-and-justify`. This is the
closest existing thing to an automated functional test of the AI layer.

### Tests
```bash
cd ai-node && npm test
cd external-adapter && npm test     # see external-adapter/TESTING.md (unit vs integration; integration hits IPFS/AI)
cd arbiter-operator && npx hardhat test
```

### Install / upgrade a full node (operator machine)
```bash
./installer/bin/install.sh            # 9-phase install; installs to ~/verdikta-arbiter-node by default
./installer/bin/upgrade-arbiter.sh    # in-place upgrade: backs up, copies new code, rebuilds, regenerates job specs
```
Install phases: prereqs → env setup → AI Node → EA → Docker/Postgres → Chainlink
→ deploy contracts → configure jobs/bridges → register oracle. Config lands in
`installer/.env`, `installer/.contracts`, `installer/.api_keys`.

### Runtime management (post-install, in the install dir)
`start-arbiter.sh`, `stop-arbiter.sh`, `arbiter-status.sh`, `arbiter-doctor.sh`
(health check + `--fix`), `register-oracle.sh` / `unregister-oracle.sh`,
`fund-chainlink-keys.sh`, `update-pinata-key.sh`, `update-justifier-model.sh`,
`chainlink-health-watchdog.sh` (cron alerting on 0-live-RPC / failing health
checks, optional `--self-heal`), `rotate-logs.sh` (app-log rotation).

---

## 7. Key env vars

**External Adapter** (`external-adapter/.env`): `PORT`, `AI_NODE_URL`
(default `http://localhost:3000`), `AI_TIMEOUT`, `OPERATOR_ADDR` (**required**),
`IPFS_PINNING_KEY` (Pinata **JWT**, **required** for reveals), `IPFS_GATEWAY`,
`IPFS_PINNING_SERVICE`, `LOG_LEVEL`.

**AI Node** (`ai-node/.env.local`): provider keys (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `XAI_API_KEY`, `HYPERBOLIC_API_KEY`, `OPENROUTER_API_KEY`),
`JUSTIFIER_MODEL` (`provider:model`), `MODEL_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS`,
`JUSTIFICATION_TIMEOUT_MS`, `MIN_SUCCESSFUL_MODELS_PERCENT`, `AI_GATEWAY`, `LOG_LEVEL`.

Ollama runs locally and is unaffected by gateway settings.

---

## 8. Conventions & gotchas

- **Shared logic lives in `@verdikta/common`** (IPFS, archive, manifest parse,
  validation, logging). Don't reimplement it locally; both EA and AI Node pin
  the **same version** and the installer verifies this.
- **ClassID**: a curated model-pool identifier (default 128). Model pool data
  ships via `@verdikta/common`; the installer integrates it into the AI Node
  (`npm run integrate-classid`, `src/scripts/display-classids.js`).
- **Two networks**: `base_sepolia` (testnet) and `base_mainnet`. Network-specific
  wrapped-VDKA and RPC config live in `installer/.env`. See `docs/deployments.md`.
- `set -e` is used in installer scripts — check exit codes carefully when editing.
- The Solidity version is pinned to **0.8.19** to match imported Chainlink
  contracts (see `arbiter-operator/README.md`); don't bump it casually.
- Repo hygiene: large stray logs (`docker.log`, `grepevm8453.log`) and
  `external-adapter/test-artifacts/*.zip` may be present untracked; ignore them.

---

## 9. Where to look for what

| Question | File(s) |
|---|---|
| How does deliberation/scoring work? | `ai-node/src/app/api/rank-and-justify/route.ts`, `ai-node/src/config/prePromptConfig.ts` |
| How are models routed to providers? | `ai-node/src/lib/llm/llm-factory.ts`, `provider-config.ts`, `config/models.ts` |
| Commit-reveal / IPFS upload | `external-adapter/src/handlers/evaluateHandler.js`, `services/commitStore.js` |
| On-chain fulfillment/access control | `arbiter-operator/contracts/ArbiterOperator.sol` |
| Chainlink job pipeline | `chainlink-node/basicJobSpec`, `installer/bin/register-oracle-dispatcher.sh` |
| Manifest format | `external-adapter/doc/MANIFEST_SPECIFICATION.md`, `external-adapter/doc/multi-cid-implementation.md` |
| AI response contract | `ai-node/API_RESPONSE_SPECIFICATION.md` |
| Install/upgrade | `installer/bin/install.sh`, `installer/bin/upgrade-arbiter.sh`, `installer/docs/` |
| Architecture overview | `docs/development/architecture.md` (note: some code snippets are illustrative) |

---

## 10. Known doc caveats

- The **client-facing API is on-chain**: `ReputationAggregator.requestAIEvaluationWithApproval` +
  `getEvaluation` (in the separate `verdikta-dispatcher` repo). The AI Node's
  `POST /api/rank-and-justify` is an **internal** endpoint the External Adapter
  calls; clients do not call it directly. There is no `POST /api/arbitrate`.
- **Payment is native ETH**, attached to the request (`msg.value`); there is no
  LINK for the consumer. Unused prepay becomes a withdrawable `ethOwed` credit.
  The `ReputationAggregatorLINK` contract is the retired legacy variant.
- Some snippets in `docs/development/architecture.md` are intentionally
  *simplified* from the real handlers (`ai-node/src/app/api/rank-and-justify/route.ts`,
  `external-adapter/src/handlers/evaluateHandler.js`) — trust the source files for
  exact behavior.
