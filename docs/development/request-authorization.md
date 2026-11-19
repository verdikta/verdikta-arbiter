# Request authorization before paid work

The operator and Chainlink job now enforce requester eligibility before the
External Adapter can fetch IPFS evidence, invoke models or pin results.
Service bearer tokens remain required; they authenticate the service caller,
while these checks authorize the on-chain requester.

## Admission and execution

Both `operatorRequest` and `oracleRequest` go through the same admission hook.
The configured ERC-677 LINK token overwrites the caller-supplied sender and
payment before the hook runs. Admission requires:

- A contract requester approved by at least one operator-configured
  ReputationKeeper. An empty keeper list denies all requests.
- Callback address equal to that authenticated requester, and data version 2,
  matching Verdikta's multiword protocol.

Each keeper lookup receives at most 50,000 gas and must return exactly one
canonical ABI boolean. Reverts, exhausted gas, empty/oversized output and invalid
booleans grant no access. A failing keeper does not override another keeper's
valid approval. Keeper management remains owner-only.

Denied requests revert before creating a commitment or emitting `OracleRequest`;
they cannot start a Chainlink job. Zero-LINK requests remain supported because
the ETH-funded dispatcher intentionally uses them. A token fee is not an
authorization mechanism for this protocol.

`isAuthorizedRequest(requestId,payment,requester,callbackFunctionId,expiration)`
checks an exact, pending version-2 commitment and current keeper approval. The job performs an `eth_call` at `latest`, decodes the boolean, and
uses a `conditional` before CBOR parsing and the bridge. It repeats that check
after evaluation, immediately before `ethtx`. False results and RPC/decode errors
stop downstream work. Unknown, cancelled, fulfilled or revoked requests
fail this check. The event source is the configured operator/job, not adapter
input supplied by an application.

The event's `expiration` remains part of the commitment hash. It is Chainlink's
five-minute cancellation/refund threshold, not a fulfillment deadline. A
still-pending approved request remains eligible after it, allowing code-review
work to use its 780-second budget within the 840-second job timeout. A cancelled
request is denied because cancellation removes its commitment.

Every fulfillment entry point, including the inherited methods, checks current
keeper approval again before consuming the commitment or releasing escrow.
Cancellation and refunds continue to work after revocation. The legacy ERC-165
marker is unchanged; `requestAuthorizationVersion()` separately reports `1`.

## Deployment migration

**Existing operator contracts cannot acquire this fix through a software
upgrade. They are not proxies. A new operator deployment and regenerated jobs
are required.** No live deployment is part of the local remediation.

Use the class-5555 Base Sepolia canary process before mainnet. Plan a maintenance
window or a separate installation; preserve the old contract address and job
IDs until their registrations and pending requests are resolved.

1. Stop new selection of the old jobs through the existing unregister workflow,
   and allow pending commit/reveal requests to finish before stopping services.
   The adapter's commitment store is still in memory. Follow the keeper's
   deregistration/stake timing rules; do not merely overwrite old job IDs.
2. Build and deploy the hardened operator using this checkout's pinned
   dependencies and compiler. Verify the payment token/network addresses before
   deployment. Configure its authorized Chainlink transaction senders.
3. Have the keeper owner confirm the chosen aggregator is approved. Add that
   aggregator's trusted keeper to the new operator. The updated registration
   script verifies version 1 and keeper approval, adds a missing keeper if run
   by the operator owner, and confirms effective authorization before approving
   stake or registering jobs. It performs this check even when jobs are already
   registered. It never approves an aggregator on the keeper owner's behalf.
4. Update `OPERATOR_ADDR` consistently in the installer's `.contracts`, the
   installation's `installer/.contracts`, and the EA's `.env`. Confirm the
   selected RPCs and network in both installer environments. Do not carry
   pending commitments across operator addresses.
5. Upgrade the service code/configuration and regenerate every Chainlink job
   from `chainlink-node/basicJobSpec`, including its Authorization header and
   both authorization gates. For unattended upgrades set
   `VA_UPGRADE_REGENERATE_JOBS=y`. Register the resulting new job IDs on the
   new operator/keeper; ensure no old duplicate job remains active.
6. Verify `isRequesterApproved(aggregator)` is true; perform a real testnet
   commit/reveal evaluation, then a controlled unapproved request. The latter
   must emit no `OracleRequest` and create no paid work. Confirm the installed
   jobs contain both gates and that revocation/RPC failures halt execution.

`upgrade-arbiter.sh` checks the configured operator's version, deployed code,
selected chain and denial of a nonexistent request **before stopping services**.
`configure-node.sh` checks before changing keys, bridges or jobs. Failures abort;
RPC error details/credentialed URLs are not printed by this check. Any changed
job template must be regenerated. These read-only probes identify compatible
deployments; they do not attest arbitrary or malicious bytecode. Use the
reviewed build and verify the deployed source.

## Validation and boundaries

```bash
cd arbiter-operator
npm install
npm test                 # explicit in-memory Hardhat network; no live deployment
cd ..
node --test installer/tests/service-auth.test.cjs installer/tests/request-authorization.test.cjs
```

The contract tests use the pinned package's real LINK ERC-677 implementation.
The job harness parses the actual TOML/DOT strings and calls the local contract,
with mock bridge/transaction effects. It is a model: its first version decoded
the gate's result with ethers and passed a job that failed every run on Chainlink
(`abi="(bool allowed)"` yields the key `allowed)` there). The job is measured on the
real 2.23.0 binary, against this checkout's operator, by
`installer/tests/job-timeouts.integration.sh` (CI: `installer.yml`). Python 3.11+ is required for TOML parsing.
Its error propagation follows Chainlink 2.23.0's
[conditional](https://github.com/smartcontractkit/chainlink/blob/v2.23.0/core/services/pipeline/task.conditional.go),
[ethcall](https://github.com/smartcontractkit/chainlink/blob/v2.23.0/core/services/pipeline/task.eth_call.go),
and [bridge](https://github.com/smartcontractkit/chainlink/blob/v2.23.0/core/services/pipeline/task.bridge.go)
implementations. A running Chainlink integration/canary remains a release gate.

An RPC outage now prevents paid work. Revocation after work begins cannot undo
calls already made; revocation between the final read and mining may still cost
transaction gas, but the contract denies fulfillment. Approved aggregators can
still submit expensive valid requests: workload budgets, cancellation of model
calls and application-level abuse controls remain separate work. EA credentials
are still privileged; a compromised trusted service can call its APIs directly.
