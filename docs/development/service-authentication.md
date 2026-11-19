# Service authentication and reveal retries

The arbiter's model and evaluation APIs are private service APIs. A commitment
hash, aggregation ID, caller IP, cookie, or CORS policy grants no access.

| Caller → service | Credential | Protected endpoints |
| --- | --- | --- |
| Chainlink → External Adapter | `EA_API_TOKEN` in EA `.env` and each rendered bridge task | `POST /evaluate`, all modes |
| EA / operator UI / testing tool → AI Node | `AI_NODE_API_TOKEN` matching AI `.env.local` and EA `.env` | `POST /api/rank-and-justify`, `GET/POST /api/generate`, `GET /api/test-hyperbolic` |

Send `Authorization: Bearer <token>` for the target service. Tokens must be
32–128 URL-safe characters; the setup helper generates independent 32-byte
random secrets encoded as 64 hex characters. The EA refuses startup with
missing/invalid keys or identical keys for both roles. AI handlers return 503
when their key is missing/invalid. Wrong/missing caller credentials return 401
before JSON/multipart parsing, provider calls, IPFS work or commit lookup.
Checks run inside the AI handlers, not Next middleware. There is no development
bypass. `/api/health` on AI and `/version` on EA remain read-only monitoring APIs.

## Local setup

From the repository root, after preparing the existing provider/operator settings:

```bash
node installer/util/configure-service-auth.cjs configure .
```

This configures `ai-node/.env.local` and `external-adapter/.env` with mode 0600,
preserves other settings and existing valid tokens, and refuses mismatched,
duplicate or shared-role credentials. It never prints tokens or contacts running
services. Run it again safely; restart both services after changing credentials.
For an installed node, pass the installation directory instead of `.`.

Read the AI token through your private local editor and enter it into the UI's
Connect form, or put it in the testing tool's private `.env`. The UI clears the
input after connecting and stores the active token only in component memory;
Disconnect and reload clear it. Do not add `NEXT_PUBLIC_` to the variable or put
tokens in URLs, scenario files, commits, logs or screenshots.

`ai-node/start.sh` binds to `127.0.0.1`; an explicit exported `AI_NODE_HOST`
overrides it. Direct `npm run dev/start` users should also pass
`-- --hostname 127.0.0.1`. EA honors `HOST` with a standalone default of
`127.0.0.1`. The full installer defaults EA to `0.0.0.0` because Chainlink runs
in Docker, preserving an operator's existing explicit `HOST`. Limit port 8080
with host/container firewall rules to the Chainlink network, or bind a reachable
private interface. Keep port 3000 local. Across hosts, use authenticated TLS or
a protected tunnel: bearer credentials require a confidential transport.

## Installation and upgrade

Installation synchronizes the keys before starting the services.
`configure-node.sh` renders the EA key into each bridge task's explicit `headers`
attribute and protects rendered job files with mode 0600. This is supported by
the pinned [Chainlink 2.23.0 bridge task](https://github.com/smartcontractkit/chainlink/blob/v2.23.0/core/services/pipeline/task.bridge.go).
Do not assume Chainlink automatically sends its bridge `outgoingToken`.

Existing jobs need the new Authorization header. The first security upgrade
must regenerate jobs; if a changed template is not regenerated, the upgrade
aborts. The request-authorization fix also requires a new operator deployment;
see [migration guidance](request-authorization.md). For unattended upgrades, explicitly set
`VA_UPGRADE_REGENERATE_JOBS=y`. The existing regeneration workflow replaces job
IDs and handles oracle re-registration. An old duplicate job is never accepted
as a successfully authenticated replacement. Missing job templates also abort.
Custom jobs must be updated to the equivalent header and payload before use.

Drain in-flight requests before restarting or regenerating jobs. The commit
store remains in memory; restarting loses pending results. Old entries without
scope/expiry cannot be revealed under the new code. Do not copy source files and
restart production without updating service configuration and jobs together.

Rotate keys during a maintenance window: generate new independent random values,
replace the EA key and both copies of the AI key in private configuration,
regenerate Chainlink jobs, and restart both services. The helper preserves
configured keys and does not rotate them implicitly. Protect generated job
specifications, Chainlink's database/UI, environment backups and diagnostic logs
as credentials; do not run these scripts with shell tracing enabled.

Before mainnet, follow the class-5555 canary gate in the release runbook. Verify
from the Chainlink container that the authenticated bridge works; verify from
an unauthorized host that service ports are blocked or reject missing/wrong
credentials. Neither test has been performed against a live deployment as part
of this local fix.

## Reveal lifecycle

Mode 1 requires a stable `id` (the template sends `jobSpec.externalJobID`) and a
bytes32 `data.aggId`. The stored result is bound to that job, the normalized
aggregation ID and the configured operator, with a three-day server expiry.
Mode 2 requires the same scope and a valid 128-bit commitment. Each caller is
checked before it can read a result or join an in-flight upload. Unknown,
expired, old unscoped and mismatched commitments return 403 without uploading
or changing state. Invalid request syntax returns 400.

The first authorized reveal uploads and records the CID. Concurrent reveals
share the upload. Later retries return exactly the saved scores, CID and salt;
serving an HTTP response never deletes the commitment. Upload failures leave it
available for retry. An independent cleanup timer removes entries at expiry.

Service authentication establishes trust in the Chainlink caller; it does not
verify on-chain requester eligibility or provide durable storage. The
[operator and job authorization checks](request-authorization.md) separately
verify a live pending request and its requester before bridge execution. Durable
storage remains separate work. Each installation
must use unique credentials; the job identity scopes its configured network.
Anyone holding an installation's EA credential is a trusted service caller.

## Offline checks

```bash
(cd external-adapter && npm test -- --runInBand --silent --testPathIgnorePatterns=/integration/)
(cd ai-node && npm test -- --runInBand --silent)
node --test installer/tests/service-auth.test.cjs
```

Adapter HTTP tests require local socket permission; all IPFS/AI calls are mocked.
Installer tests use disposable directories and Python 3.11+ `tomllib` to validate
both TOML and embedded header encoding. They never reconfigure a real node.
