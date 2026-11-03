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
URL or token.

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

`fix.*` never changes the outcome. A padded claim that takes the request over the
runner's 16 MiB limit abstains, on every arbiter.

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
and for an integrity failure `failedChecks`. The text states what the checks found,
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

For testing information, please refer to [TESTING.md](TESTING.md).