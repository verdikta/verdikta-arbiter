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
SERVER_TIMEOUT=300000          # HTTP server socket timeout (ms)

# AI Node
AI_NODE_URL=http://localhost:3000
AI_TIMEOUT=300000              # Request timeout when calling the AI Node (ms)

# IPFS (Pinata)
IPFS_GATEWAY=https://ipfs.io
IPFS_PINNING_SERVICE=https://api.pinata.cloud
IPFS_PINNING_KEY=eyJ...        # Pinata JWT (NOT the API key/secret). Required to upload justifications.

# On-chain
OPERATOR_ADDR=0x...            # ArbiterOperator address; used in the commit hash. Required.

# Logging
LOG_LEVEL=info                 # error | warn | info | debug
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

For testing information, please refer to [TESTING.md](TESTING.md).