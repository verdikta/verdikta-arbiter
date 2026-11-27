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

## Operators deployed before request authorization

**An existing operator contract cannot acquire the admission check: it is not a
proxy.** Until 2026-11-26 that made one step of two things. The upgrade refused
any node on an old ("legacy") operator, so the adapter's file-read fix, the
service credentials and every later fix waited behind a new contract; and a
changed job template was answered by new jobs with new ids, so each job was
deregistered, registered again and lost its reputation. The first operator
outside the canaries who was asked to upgrade was handed a seven-step manual
migration. They are two steps now, and only the second touches the chain.

### 1. The upgrade takes the node as it is

`upgrade-arbiter.sh` reads which operator the node has before it stops anything
(`installer/util/job-template.cjs mode`; the rules are in
`check-request-authorization.cjs`, `describe`):

- **v1**: `requestAuthorizationVersion()` is 1 and a fabricated request is
  denied. The jobs are the template as it is.
- **legacy**: the version read *reverts* and the contract answers
  `isReputationKeeperListEmpty()`. An RPC that fails, rate-limits or answers
  something else is neither, and the upgrade stops with the node running.

A legacy operator still emits `OracleRequest` for any sender, so its jobs carry
the check: where the template asks the operator `isAuthorizedRequest(...)`, a
legacy node's job asks the ReputationKeeper `isContractApproved(requester)`, at
the same two places (before CBOR parsing and the bridge, and again before
`ethtx`), with the same `conditional`. Three task lines differ and nothing else
(`legacyGate`; `job-template.test.cjs` holds the diff). The requester in the event
is the address the LINK token saw: Operator overwrites the caller's own claim. An
unapproved sender's run therefore stops before the adapter is called, which is
what the admission check is for; what the contract adds on top is that no log is
emitted at all, that the callback must be the requester, and that the rule does
not depend on the node's own job.

Nothing on a legacy operator names its keeper (the list is usually empty), so it
is the `reputationKeeper()` of the aggregator in `installer/.contracts`, and it is
believed only if that keeper approves the aggregator **and holds a registration of
one of this node's jobs**. A stale `AGGREGATOR_ADDRESS` would otherwise make every
job refuse the live dispatcher. A legacy node with no such keeper is refused, with
the reason. The owner of a node that is registered with no dispatcher at all says
so with `VERDIKTA_LEGACY_UNREGISTERED=1` (the upgrade and `migrate-operator.sh`
both read it); the keeper must still approve the aggregator.

After the restart each live job is measured against the job this release wants
and a stale one is replaced with `PUT /v2/jobs/:id`, under its own
`externalJobID`: nothing happens on chain, and registration, stake and reputation
stay. This is not asked, because a job without the adapter's credential answers
nothing. The same step serves a v1 node whose template changed. New job ids
(`VA_UPGRADE_REGENERATE_JOBS=y`) are still there for whoever asks; the question
now defaults to no. A failure ends the upgrade with exit 3 and
`JOB UPDATE FAILED:` on the last line. Later:

```bash
node ~/verdikta-arbiter-node/job-template.cjs check   # 0 this release's, 1 stale (named), 2 could not measure
node ~/verdikta-arbiter-node/job-template.cjs apply   # replaces stale jobs under their ids; the old specs are kept, 0600
```

The doctor reports both: `job.template` (FAIL when a job is stale) and
`op.request_authorization` (WARN on a legacy operator, with the migration).

### 2. The contract migration, when the owner chooses

```bash
installer/bin/migrate-operator.sh --check     # reads the chain and the node; sends nothing
installer/bin/migrate-operator.sh             # the migration (unattended: VA_MIGRATE_OPERATOR=y)
```

One command, in the order that leaves no stake behind, and continued from where
it stopped when run again:

1. **Plan.** From the keeper's registry, not from `.contracts`: which of the
   node's jobs are registered, on which classes, at what fee, with how much stake
   and locked until when; the node keys the old contract authorizes; whether the
   key in `installer/.env` owns the contract and holds enough ETH and wVDKA once
   the refund is in. The new contract is built. Nothing is sent, and anything
   that would stop the migration later is named here.
2. **Deregister** every job id the keeper lists for the old contract.
3. **Wait** the aggregator's `responseTimeoutSeconds` plus a minute, so that a
   round the node was already selected for can finish. The adapter's commitment
   store is in memory, and a commitment is not carried across operators.
4. **Deploy** this checkout's ArbiterOperator and authorize on it the node keys
   the old contract authorized.
5. **Repoint** `OPERATOR_ADDR` in the install's `installer/.contracts`, the
   checkout's (if it is this node's) and `external-adapter/.env`, each backed up,
   and restart the arbiter.
6. **Move the jobs**: each is replaced under its own id by this release's job on
   the new contract (`job-template.cjs apply --move-to-operator`). The job ids do
   not change.
7. **Register** the same job ids on the same classes at the same fee, one
   registration per group of jobs registered alike. The registration adds the
   keeper to the new operator; it never approves an aggregator on the keeper
   owner's behalf.
8. **Verify**: the version, owner and node keys of the new contract, the keeper's
   registry for both contracts, and a simulated request from an unapproved
   address, which must revert.

What it costs: gas for one deployment and two transactions per job; the stake goes
out and comes back in. **A registration is on (operator contract, job id), so each
job starts again with a new job's reputation.** On mainnet that is the real cost,
and why this is the owner's decision and not part of an upgrade. The node answers
nothing from step 2 to step 7.

Use the class-5555 Base Sepolia canaries before mainnet. Class 5555 is the release
gate's own pool: an operator outside it does not register on it.

What the registration script does on a legacy operator: it verifies the keeper
approves the aggregator and registers, without touching the operator's keeper
list. A legacy node can so change its job count or classes before it migrates.
Through Hardhat's provider a contract's revert is a `ProviderError` with code 3,
not ethers' `CALL_EXCEPTION`; `contractRefused` reads both, and only a revert,
never an RPC failure, is read as "legacy" (measured against a mainnet operator).

`configure-node.sh` reads the same description before it changes keys, bridges or
jobs, and gives a legacy operator's jobs the keeper gate. These read-only probes
identify compatible deployments; they do not attest arbitrary or malicious
bytecode. Use the reviewed build and verify the deployed source.

## Validation and boundaries

```bash
cd arbiter-operator
npm install
npm test                 # explicit in-memory Hardhat network; no live deployment
cd ..
node --test installer/tests/*.test.cjs     # the operator's description, the in-place job update, the migration's plan
bash installer/tests/migrate-operator.test.sh && bash installer/tests/upgrade-job-template-trap.test.sh
```

The contract tests use the pinned package's real LINK ERC-677 implementation.
The job harness parses the actual TOML/DOT strings and calls the local contract,
with mock bridge/transaction effects. It is a model: its first version decoded
the gate's result with ethers and passed a job that failed every run on Chainlink
(`abi="(bool allowed)"` yields the key `allowed)` there). The job is measured on the
real 2.23.0 binary, against this checkout's operator, by
`installer/tests/job-timeouts.integration.sh` (CI: `installer.yml`), which also runs a legacy
operator (the fixture `contracts/test/LegacyArbiterOperator.sol`): its node before the upgrade,
the in-place update, an unapproved requester stopped before the bridge, and the migration's move
of the jobs to this checkout's operator. Python 3.11+ is required for TOML parsing.
Its error propagation follows Chainlink 2.23.0's
[conditional](https://github.com/smartcontractkit/chainlink/blob/v2.23.0/core/services/pipeline/task.conditional.go),
[ethcall](https://github.com/smartcontractkit/chainlink/blob/v2.23.0/core/services/pipeline/task.eth_call.go),
and [bridge](https://github.com/smartcontractkit/chainlink/blob/v2.23.0/core/services/pipeline/task.bridge.go)
implementations. A running Chainlink integration/canary remains a release gate.

An RPC outage now prevents paid work: the two reads go to the node's RPC pool, the job
asks for no retry, and a read that fails ends that run (Chainlink marks the error as
retryable, so a `retries=` on the two tasks is possible; it has not been measured on the
binary). A node with no RPC saw no request and sent no answer before either. Revocation after work begins cannot undo
calls already made; revocation between the final read and mining may still cost
transaction gas, but the contract denies fulfillment. Approved aggregators can
still submit expensive valid requests: workload budgets, cancellation of model
calls and application-level abuse controls remain separate work. EA credentials
are still privileged; a compromised trusted service can call its APIs directly.
