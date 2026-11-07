# Chainlink External Adapter for AI Dispute Resolution

This external adapter serves as a bridge between Chainlink nodes and an AI-based dispute resolution system. It processes evidence stored on IPFS and facilitates AI evaluation of disputes.

## Features

- IPFS integration for evidence handling
- AI Node interaction for dispute evaluation
- Robust error handling and retry mechanisms
- Comprehensive logging
- Full test coverage

## Project Structure

Manifest parsing, archive extraction, IPFS access, request validation, and
logging now live in the shared [`@verdikta/common`](https://www.npmjs.com/package/@verdikta/common)
package, so they no longer have local copies under `src/utils/`.

```
external-adapter/
├── package.json                # Project dependencies and scripts
├── README.md                   # Project documentation
├── TESTING.md                  # Testing documentation
├── jest.config.js              # Jest configuration
│
├── src/                        # Source code
│   ├── index.js               # Express entry point + config self-check
│   ├── config.js              # Configuration management
│   │
│   ├── handlers/              # Request handlers
│   │   └── evaluateHandler.js # Main evaluation handler (modes 0/1/2)
│   │
│   ├── services/              # Service clients
│   │   ├── aiClient.js        # AI Node interaction (/api/rank-and-justify)
│   │   └── commitStore.js     # Persists commit-reveal state between modes 1 & 2
│   │
│   └── __tests__/            # Test files (unit + integration + fixtures)
│
├── logs/                      # Log files
└── tmp/                      # Temporary files directory (extraction workspace)
```

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file in the root directory. Values map to `src/config.js`:

```env
# Server
PORT=8080
HOST=0.0.0.0
SERVER_TIMEOUT=840000          # HTTP server socket timeout (ms): the job's 840 s; code mode is refused below its deadline + 60 s

# AI Node
AI_NODE_URL=http://localhost:3000
AI_TIMEOUT=300000              # Request timeout when calling the AI Node (ms)

# IPFS (Pinata)
# Optional: gateways to try FIRST, in order, ahead of @verdikta/common's built-in
# public gateways (Pinata, ipfs.io, dweb.link). Comma-separated. Point this at a
# dedicated Pinata gateway to avoid public rate limits; leave it unset to use the
# library's default order. Listing only ipfs.io/dweb.link here makes fetches
# slower, not faster. Honoured by @verdikta/common >= 1.7; older releases ignore it.
# IPFS_GATEWAY=https://<subdomain>.mypinata.cloud
# IPFS_GATEWAY_TOKEN=<dedicated-gateway key; sent only to the gateways listed above>
# Shared IPFS fetches: one dispatcher request fans out to several of this node's
# jobs, so downloads of the same CID are shared while in flight and kept briefly
# for the next selected job. Defaults suit most nodes; TTL 0 keeps only the
# in-flight sharing. Counters are on GET /version (ipfsFetchCache).
# IPFS_FETCH_CACHE_TTL_MS=120000
# IPFS_FETCH_CACHE_MAX_ENTRIES=32
# IPFS_FETCH_CACHE_MAX_BYTES=67108864
IPFS_PINNING_SERVICE=https://api.pinata.cloud
IPFS_PINNING_KEY=eyJ...        # Pinata JWT (NOT the API key/secret). Required to upload justifications.

# On-chain
OPERATOR_ADDR=0x...            # ArbiterOperator address; used in the commit hash. Required.

# Logging
LOG_LEVEL=info                 # error | warn | info | debug

# Code review (stake attestation). Off unless enabled; see "Code-review mode" below.
# CODE_REVIEW_ENABLED=true
# CODE_RUNNER_URL=http://127.0.0.1:8090
# CODE_RUNNER_TOKEN=<the runner's bearer token>   # or CODE_RUNNER_TOKEN_FILE=<path>, not both
# CODE_REVIEW_TRUST=production                     # dev: test chains only, with CODE_REVIEW_DEV_KEYS
# CODE_REVIEW_DEV_KEYS=<base64 Ed25519 public key>[,<key>…]
# CODE_REVIEW_DEADLINE_MS=780000                  # the single deadline, from receipt (at most 780000: the job's 840 s less the commit)
# NETWORK_CHAIN_ID=84532                          # the chain served; dev trust needs 84532 or 31337
```

> `IPFS_PINNING_KEY` must be the Pinata **JWT** (three dot-separated segments,
> prefix `eyJ`). The adapter validates this at boot and logs a fatal-config
> warning if it looks wrong. Rotate it with `installer/util/update-pinata-key.sh`.

## API Documentation

### POST /evaluate

Called by the Chainlink node's `verdikta-ai` bridge. Fetches the evidence
archive(s) from IPFS, runs AI deliberation via the AI Node, and returns scores
plus a justification CID. The response is **synchronous** (the Chainlink job
waits for it).

#### Request Body

```json
{
  "id": "<externalJobID>",
  "data": {
    "cid": "<mode><CID(s)>[:addendum]",
    "aggId": "<aggregator request id, optional>"
  }
}
```

`cid` encodes an optional **mode** prefix used by the dispatcher's
commit-reveal aggregation:

| `cid` value | Mode | Behavior |
|---|---|---|
| `Qm...` (no prefix) | 0 | Standard: evaluate now, upload justification, return scores + CID |
| `1:Qm...` | 1 (commit) | Evaluate, store the result locally, return only a hash commitment |
| `2:<hash>` | 2 (reveal) | Look up the committed result, upload its justification, return scores + `CID:salt` |

Multiple comma-separated CIDs after the mode prefix trigger multi-CID
(multi-party) evaluation. An optional `:addendum` appends real-time text to the
prompt.

#### Response (mode 0 / mode 2)

```json
{
  "jobRunID": "<externalJobID>",
  "status": "success",
  "statusCode": 200,
  "data": {
    "aggregatedScore": [650000, 350000],
    "justificationCid": "bafybe..."
  }
}
```

Scores are integers that sum to 1,000,000. In mode 1 the `data.aggregatedScore`
array holds a single decimal hash commitment and `justificationCid` is empty.

### GET /health

Liveness, plus the code-review mode: `{ "status": "ok", "codeReview": { "enabled",
"ready", "runnerConfigured", "trust", "devKeyCount", "chainId", "network",
"problems" } }`. `trust` is `production`, `dev`, `dev-refused` or `refused`.
`GET /version` carries the same `codeReview` block. Neither shows the runner
URL or token. Both also carry `canaryFault`, the [fault switch](#the-canary-fault-switch)'s state.

## Code-review mode (stake attestation)

A request whose primary archive's manifest has `codeReview` is a claim
judgement for a stake-attestation listing
([design](../docs/development/stake-attestation-design.md)): `cids` =
`[listing, claim, up to 8 prior findings]`, and the addendum is the
contract's machine lines (`verdikta-disclosure: …`, and on a dispute
`verdikta-dispute: <statementCid>`, errata E1/E2). Before any runner or model
call the adapter runs these gates, all from `@verdikta/common`
(`src/codeReview/frontGates.js`):

| Stage | Checks | On failure |
|---|---|---|
| Operator | `CODE_REVIEW_ENABLED=true`; a runner (`CODE_RUNNER_URL` and a token of 32+ printable characters); the `@verdikta/common` release `package.json` pins actually installed, and the same one in the AI Node beside it (an install that replaced it with `latest` leaves code mode off); a usable trust mode | requester error |
| Request | 2 to 10 CIDs, none repeated | requester error |
| Listing (`cids[0]`) | manifest and the six outcomes; `code_review.json` (`validateCodeReviewSpec`, so a spec above the class maxima); the `code-standard` envelope whatever class the request came on (`validateClassEnvelope`); `attestation.json` (`validateAttestation`); `known_issues.json`; `baseline.json` | requester error |
| Composition | prior findings' `finding.json` and `report.md` (nothing else of them is read); the dispute line, read on its own whatever the disclosure line looks like, and its statement (at most 4 KB) | requester error |
| Claim (`cids[1]`) | the archive's structure (the submitted-work checks of `utils/bcidValidation.js`); then, in this order, `finding.json` a JSON object, `report.md` non-empty UTF-8 text, `poc.patch` a patch (a `diff --git` header or a unified-diff hunk); `fix.patch` optional and never gated | INVALID, naming the member |
| `disclosure` | the line parses strictly; the ciphertext fetched by CID hashes to `ciphertextSha256`; `verifyDisclosure` with the listing's `disclosureKey` (`BAD_DISCLOSURE_KEY` is the listing's: requester error) | INVALID |
| `inScope` | `validateFinding` against the spec | INVALID |
| `applies`, for size only | `poc.patch` within the listing's `maxPatchBytes` (the runner's own rule, decided here because a patch past the runner's request limit would never reach it) | INVALID |

A requester error is the errored path (HTTP 500, `aggregatedScore: [0]`) with
no commit, in mode 1 too. An INVALID is the full 1,000,000 on `INVALID`
through the normal commit/reveal tail, with a justification naming the gate.
IPFS or disk failures stay transient (errored, no commit). A claim that
passes every gate goes to the code-review run (`src/codeReview/claimRun.js`);
whatever comes out is committed only if it scores exactly the six outcomes with
integers summing to 1,000,000, and only by the deadline.

### The run

**One deadline** (design §11). `deadline = receipt + CODE_REVIEW_DEADLINE_MS`
(780 s: the job's 840 s less 60 s for the commit), and it counts the fetches. Each
call is told what remains when it is sent: `deadline` to the runner, `deadlineMs`
to the AI Node. Each call is cancelled at the deadline, and the wait for any
archive fetch ends at it. A verdict reached past it, front-gate verdicts included, is
an error with no commit. On an arbiter serving code review the bound also covers a
text-mode request's fetches, since the mode is only known once they are done; the IPFS
client gives up on each fetch long before. `SERVER_TIMEOUT`
defaults to the job's 840 s; below the deadline + 60 s, code mode is refused with
the reason in `/health`.

**One sandbox** (§9.2). Jobs of this operator share one runner call per listing
CID + bCID + runner version (from `GET /health`) + rule version + code class + a
hash of the prior findings. Failures are not kept. Definitive answers are kept for
15 minutes, frozen. Each job then checks that the report's inputs are its own claim's.
The jury is per job.

**Settling** reads only the fields of `verdikta.claim-report/1`, after common's
`validateClaimReport` and `reportSha256` (`src/codeReview/settlement.js`):

| The report or the answer | Result |
|---|---|
| Runner unreachable or unhealthy, `outcome: abstain`, a report common refuses or that is not this claim's, `reportUnavailable` (`linux/arm64`), a production-trust listing run under another runtime than the pinned gVisor, anything else | Abstain: errored, no commit |
| `400 requester_error` | Requester error: errored, no commit |
| A tamper flag, even beside another failed check | INVALID (gate `integrity`) |
| `applies`, `testPathsOnly`, `build` or `claimedObservable` failed | INVALID |
| `reproduces` failed on its own: no test added, or any `pass`, `error`, `skip`, `missing` or `duplicate` run | INVALID |
| `reproduces` failed only through another failed integrity check | All weight on DUPLICATE: bond back, no award (owner decision Q35) |
| Every gate passed | The jury |

`fix.*` never changes the outcome.

**What a claim's own patch can cause.** A PoC or a patch past the memory, process or
time limits, or one that kills forge through ffi, makes the runner abstain, and the
arbiter cannot tell that from a host's problem, so it abstains too: no commit (owner
decisions Q12, Q28). Erratum E6 decides the money, and nothing on-chain or on IPFS says
why: the error's cause and step reach the Chainlink job and the operator's log, and a
hunter's local `check` runs the same pipeline. The runner's 16 MiB request limit is not
such a route. `poc.patch` over `maxPatchBytes` settles INVALID here, the runner's own
`applies` rule; `fix.patch` over it is ignored; `report.md` goes only as far as the whole
pack could hold; a prior finding's `report.md`, which the runner does not read, goes cut.
What is left of the limit is the listing's: a listing alone over it abstains.

**The jury** (`src/codeReview/aiRequest.js`, `buildCodeReviewAiRequest`, a pure
function). The context pack's files, in order, are the only attachments; the field
names known issues and prior findings by id. `validateCodeReviewRequest` runs before
each send. On the AI Node's 503 with `retryable: true` there is one retry, from the
same run, without touching the runner. Every AI call needs more than the justifier's
45 s + a 60 s juror floor left. Every other error abstains, in every mode.

**The justification** starts with the Execution evidence block
(`src/codeReview/evidence.js`), a pure function of the report's fields. No test id,
message, path or run `detail` reaches it: only enums, counts, CIDs and hashes. The
first block in the upload's `justification` is the machine-readable form; jury text
follows it and can say anything, so read only the first one:

```
Execution evidence v1
Settlement: DUPLICATE (integrity)        (or: jury, or: INVALID (<gate>))
Report-SHA256: <64 hex>
…
Integrity-Failed-Checks: frameworkUnchanged,dependenciesUnchanged        (or: none; names and order from common's INTEGRITY_CHECKS)
…
End execution evidence
```

The upload's `metadata` says the same: `verdict_source` (`code-review-gate`,
`code-review-runner`, `code-review-integrity` or `code-review-jury`), `reportSha256`,
and for an integrity failure `failedChecks`. A jury verdict's also has `runner_image` (how this round had the env
image: `{ cache: hit|pulled|shared, durationMs }` from the runner, `{ cache: reused, durationMs: 0 }` when
it was served a run an earlier round started, or null) and, on a dispute, `dispute_statement`. Those differ between arbiters or rounds, and no settlement reads them. The text states what the checks found,
not who or what caused it.

**Trust.** `production` (the default) verifies attestations against
`@verdikta/common`'s trusted-builder set only. `CODE_REVIEW_TRUST=dev` also
accepts attestations signed for dev trust by the keys in
`CODE_REVIEW_DEV_KEYS`, logs a warning on every request and shows `dev` in
`/health`. It is refused, and code mode with it, unless `NETWORK_CHAIN_ID` is
84532 (Base Sepolia) or 31337 (a local node) and `DEPLOYMENT_NETWORK` does not
name mainnet: an unknown chain counts as mainnet.

**Logs.** Code mode logs CIDs, hashes and check codes. It never logs archive
contents or the addendum's machine lines (an addendum carrying one is logged as
`<withheld: N bytes …>`, and an error message quoting one is cut before it), so
an operator's logs never hold a copy of a claim or its keys. The operator
switch and the CID count are checked from the listing's manifest alone, before
any claim archive is extracted.

### The canary fault switch

For the canary conditions of design §11 on class 5555, on real canaries with real providers
(decision D9; `src/canaryFault/`). It is unrelated to the AI Node's mock provider, which is
test-only. It can delay or fail a request, and nothing else.

**Off by default.** Off unless `VERDIKTA_CANARY_FAULTS` is set, in `src/canaryFault/config.js`,
the one place the environment is read. No install or upgrade path sets it; the operator's step is
in [`docs/release-runbook.md`](../docs/release-runbook.md) §3b.

| Variable | |
|---|---|
| `VERDIKTA_CANARY_FAULTS` | `<claim CID>=<fault>,…`. Exact claims: there is no wildcard, and nothing in a request can ask for a fault. Faults: `near-limit-juror`, `provider-timeout`, `slow-justifier`, `cancellation` |
| `VERDIKTA_CANARY_FAULT_KEY` | 32 or more printable characters, the same as the AI Node's. It signs what the adapter asks of the AI Node |
| `VERDIKTA_CANARY_RPC_URL` | A Base Sepolia RPC, to measure each request |
| `NETWORK_CHAIN_ID`, `DEPLOYMENT_NETWORK` | Must say Base Sepolia: 84532, and not naming mainnet. An unknown chain counts as mainnet |

With a flag set and anything wrong, the state is `refused`, the reasons are in `problems`, and it
acts on nothing. A bad entry refuses the whole plan.

**What it acts on.** All of this, for each request:

1. The flag names this claim's CID. A real claim's never is, so on an armed canary a real claim
   makes no chain read and sees no fault.
2. The chain says so, through that RPC: `eth_chainId` is 84532; the one `RequestAIEvaluation(aggId)`
   log of the Base Sepolia aggregator (a constant in the code, not config) leads to a transaction
   sent straight to that aggregator, whose decoded `requestedClass` is 5555; and the keeper that
   aggregator names lists 5555 for this `OPERATOR_ADDR` and job. The bridge gives the adapter the
   `aggId` and the job's id. Chainlink 2.23.0 sends that id as `0x` and the external job id's 32 hex
   digits (`0x38f19572c51041baa5f2dea284614590`, not the UUID with dashes its API shows), and the
   keeper's key for the job is those 32 digits as UTF-8, as
   `arbiter-operator/scripts/register-oracle-cl.js` registered it. The UUID with dashes and the bare
   32 digits read the same; any other id is refused as `JOB_ID_UNREADABLE`.

A node may serve 5555 and 128 at once, as the canaries do: a request for 128 on it is refused here.
A request sent through a contract has no calldata to read, so it is refused too, and that includes
every real claim through `StakeAttestation`. Any failed read, unreadable answer or timeout (15 s in
all) means no fault, and the claim is judged normally, with `metadata.canary_fault.refused` naming
why on the verdict.

**What it does.** It asks only once the run has settled for the jury, so the runner, the report and
the gates never meet it; the modules that decide a verdict do not import it. It then adds a
directive beside the AI Node request, never in it: `canaryFault: { action, mac }`, an HMAC over the
action, the claim and the report.

| Fault | Which attempts | What the AI Node does ([contract](../ai-node/API_RESPONSE_SPECIFICATION.md#the-canary-fault-switch)) |
|---|---|---|
| `near-limit-juror` | Every | Holds the first juror's real answer until 5 s before the jury deadline |
| `provider-timeout` | The first | Starts the first juror's real call 3 s before the jury deadline, so the deadline aborts it on the wire: a real 503, a real retry from the same run |
| `slow-justifier` | Every | Holds the real justification until 5 s before its reserve ends |
| `cancellation` | Every | As `provider-timeout`, on both attempts: the arbiter abstains, no commit |

**Visible.** `/health` and `/version` carry `canaryFault: { state, namedClaims, applied, refused,
lastRefusal, problems }`, never the key, the URL or the CIDs. Every justification's `arbiter`
block carries `canaryFault: { state }`, and a jury verdict's `metadata` carries
`canary_fault_ai_node` and, for a named claim, `canary_fault`: the fault, the attempts, each earlier
attempt's verified action and error code, and the last attempt's action. No settlement reads any of it. An
armed node says so at boot, and L4 fails a claim run unless the state is what the run named.

For testing information, please refer to [TESTING.md](TESTING.md).