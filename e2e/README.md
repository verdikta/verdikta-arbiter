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

### The claim suite (`--suite claim`: local, no secret)

A claim through the real pipeline, on one machine, with nothing from outside it:

```bash
# once: npm ci in external-adapter/, ai-node/, code-runner/, testing-tool/ and e2e/
node src/index.js l2 --mock --boot-adapter --suite claim
node src/index.js l2 --mock --boot-adapter --scenario claim-valid,claim-gate-fail   # or by name
```

It starts, each with its own small environment:

| Service | How |
|---|---|
| Local IPFS | A mock gateway and Pinata-compatible pin service (`src/l2/claim/local-ipfs.js`), with real CIDv0s, wired in by `IPFS_GATEWAY` / `IPFS_PINNING_SERVICE` and a key that means nothing |
| `registry:2` | A throwaway one on the daemon's loopback, holding the code runner's Foundry fixture repository as an env image; the runner pulls it by digest, allowlisted by `CODE_RUNNER_REGISTRY_ALLOWLIST` |
| External Adapter | The real one, `CODE_REVIEW_ENABLED=true`, `CODE_REVIEW_TRUST=dev` with a key made for this run, chain 31337. The harness fails unless `/health` says `ready` and `dev` |
| AI Node | The real one under `next dev` (a production build refuses the mock provider), `VERDIKTA_TEST_MOCK_PROVIDER=1`, every call logged to `VERDIKTA_TEST_MOCK_CALL_LOG`. It holds the fault switch's key throughout, for `claim-fault-switch`: with no directive it does nothing, and the other scenarios run on that |
| Code runner | The real one under `runc`; gVisor is `code-runner.yml`'s to test |

Recording proxies sit between them, so a scenario asserts what really crossed.

| Scenario | Mode | Asserts |
|---|---|---|
| `claim-valid` | `0` | The real run is definitive with a report and every gate passed. The AI Node gets `codeReview`, `deadlineMs` at most 780 s and the pack as attachments. Each juror of the panel is called once with web off, a signal, the class's tokens and effort high, on one prompt holding the report and the pack; the justifier once. The scores are the jurors' weighted average. The justification is on the local IPFS, starting with the evidence block |
| | `commit-reveal` | Mode 1 then mode 2. The commitment is recomputed from what the reveal gives. A new jury call, no new sandbox |
| | `juror-deadline` | The EA's request replayed to the AI Node with a 57 s deadline and a hanging juror: the call is aborted by its signal at 12 s, with a retryable 503 |
| | `testing-tool` | The testing tool's [claim type](../testing-tool/README.md#claim-scenarios), through its CLI, on what the run recorded: the same request as the EA's but for the deadline and the tag, and the real AI Node takes it |
| `claim-gate-fail` | `front-gate` | Out of the listing's scope: all weight on INVALID, naming `inScope`, no runner call, no AI call |
| | `runner-gate` | A PoC that edits source: the real runner's `testPathsOnly`, all weight on INVALID, no AI call |
| | `commit-reveal` | The same verdict through mode 1 and mode 2 |
| `claim-text-unaffected` | `0`, `commit-reveal` | The text-mode archive on that same arbiter: no runner call, no `codeReview`, no juror with code mode's options |
| `claim-canary-fixtures` | `time-dependent`, `randomness-dependent`, `flaky` | A3b's PoCs under real forge, what the L4 scenarios read of them, so what G2 pins has been through the pipeline |
| | `dispute` | A dispute round: the dispute archive's panel is called, the statement reaches every juror, the machine lines reach none, the verdict names the statement |
| | `registry-failure` | A listing on a digest the registry does not hold, in mode 1: the real pull fails, `pull_failed`, errored, no commitment, no AI call |
| `claim-fault-switch` | `slow-justifier` | A second adapter, armed against a stand-in Base Sepolia RPC: a request for 5555 is held for real in the real AI Node, about 40 s |
| | `class-128` | The same claim, a request for 128: no directive, no hold, and the same justification and scores as the held run |
| | `unnamed-claim` | A claim the plan does not name: no chain read, no directive |
| | `refused-on-mainnet` | The same flag on a node configured for Base mainnet: `refused`, in `/health` and `/version`. Then the fault key must be in no service's log, at `LOG_LEVEL=debug`, and on no route |

Every verdict is also held to the L4 scenarios' own checks (`l4.claim.*`, `src/l4/claim-checks.js`), and the archives come from the builder L4's are pinned with, so what L4 reads is what the External Adapter writes.

**It fails, it never skips.** A harness that cannot start (no Docker, no `npm ci`, an AI Node that dies, a registry that will not come up, `/health` not ready) is a failed case for every scenario and mode, naming why, and exit 1. A case with no checks fails. A CID the local IPFS does not hold fails the scenario, so none can pass by reaching the public gateways.

A full `l2` run leaves these out (they need Docker, it needs Pinata), and the nightly L4 never runs them. CI's `l2-claim` job runs them on every PR, forks included, with no secret. Measured there: about 6 minutes in all, of which the fault switch's real hold is 40 s.

#### On Apple silicon

A Verification Report exists only on `linux/amd64`: the schema's platform is a constant, so a run on `linux/arm64` answers `reportUnavailable` and the EA abstains. An abstention never passes: `claim-valid` passes only if the jury was reached. So on an arm64 host with no amd64 emulation the harness starts the runner through `src/l2/claim/dev-report-runner.js`, which builds the report through the runner's own `buildReport` with the class platform named, as `code-runner/test/docker/report.docker.test.js` does there. The `run.platform` check says so in its line.

| | Local arm64 | CI (`linux/amd64`) |
|---|---|---|
| Real forge, gates, integrity checks, pack | Yes, on the image's arm64 variant | Yes, on the class platform |
| Pull by digest from `registry:2` | Yes | Yes |
| EA gates, settlement, commit/reveal, AI Node, provider layer | Yes | Yes |
| The runner's real report path | No: the launcher names the platform | Yes |
| `src/index.js` as the runner's entry point | No: the launcher | Yes |
| `linux/amd64` forge, so the report's hash a production arbiter would give | No | Yes |
| gVisor | No | No (`code-runner.yml`) |

`E2E_CLAIM_REQUIRE_CLASS_PLATFORM=1`, which CI sets, makes the harness fail on anything but `linux/amd64`, so the launcher can never stand in for it there.

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
requested class. Fee params come from `config.l4.fees` (defaults match the
DemoClient: `maxOracleFee=15e13`, `estimatedBaseCost=8e9`, `maxFeeScaling=5`,
`alpha=500`).
The request's gas limit is the node's estimate plus 30 %; `config.l4.gasLimit`
is only the fallback when estimation fails. Oracle selection walks the whole
keeper registry, so a fixed limit silently stops working as identities
register (3,000,000 ran out at 30 identities on Base Sepolia).

### Class selection and the testnet canary gate

The requested class comes from `--class-id`, then `L4_CLASS_ID`, then
`config.l4.classId` (128). Class **5555** is reserved for release testing: the
arbiters that register it on Base Sepolia are ones we control, so a request
against 5555 exercises exactly the build that was just deployed there.

Every revealing arbiter's justification carries a self-reported `arbiter`
block (`adapter`, `aiNode`, `verdiktaCommon`, `release`). L4 prints it per
arbiter (`arbiter.versions`) and, when asked, gates on it:

```bash
# after upgrading the class-5555 arbiters, before touching mainnet:
node src/index.js l4 --class-id 5555 --expect-common 1.7.0 --expect-release <commit> --junit results/l4.xml
```

`--expect-common` fails the run unless **every** revealing arbiter reports that
`@verdikta/common` version; `--expect-release` does the same for the release
commit stamped by the installer (prefix match, so a short SHA works). Without
them the versions are reported only. `npm run audit-oracles -- <aggId>` shows
which identities were selected, committed and revealed, with the same version
block per oracle. The release procedure that uses this is
[`docs/release-runbook.md`](../docs/release-runbook.md) ("Testnet canary gate").

### Claim scenarios (class 5555 only)

One real request each on the canaries, with `[listing, claim]` as `cids` and the disclosure line as the addendum: the request `StakeAttestation.reveal` will compose (design §13.3), sent from the e2e wallet. The arbiters cannot tell the difference. The contract, its bond and its own `commit` and `reveal` are not in this path.

| Scenario | What the claim is | Asserts of every recorded reveal |
|---|---|---|
| `claim-l4-valid` | A valid claim on the fixture vault | The jury was reached (`verdict_source`, `Settlement: jury`), on this listing and claim, with one report hash. With `--assert-winner`, also that it settles valid. Real jurors decide that, so it is not asserted otherwise |
| `claim-l4-front-gate` | Out of the listing's scope | All weight on `INVALID`, the EA's `inScope` gate named. No runner and no model, so it tells code mode from the sandbox |
| `claim-l4-runner-gate` | A PoC that edits source | All weight on `INVALID`, the runner's `testPathsOnly`, one report hash. The image was pulled and the sandbox ran, with no model |
| `claim-l4-time-dependent` | A PoC that reads the clock (A3b's fixture) | The jury was reached, with one report hash across hosts |
| `claim-l4-randomness-dependent` | A PoC with unseeded randomness and a per-run directory (A3b's fixture) | The jury was reached, with one report hash across hosts |
| `claim-l4-flaky` | A PoC that alternates (A3b's fixture) | All weight on `INVALID` at `reproduces` on every host, one report hash, no model |
| `claim-l4-registry-failure` | A validated listing whose image was removed from the registry after it was signed | Nobody commits for `watchSeconds`. Then its controls settle (below) |
| `claim-l4-near-limit-juror` | The fault switch holds the first juror's real answer | The jury was reached, a juror within 15 s of its limit, on one report hash |
| `claim-l4-provider-timeout` | The fault switch times the first juror out, once | Two attempts: the first a `CODE_REVIEW_JUROR_TIMEOUT` on the action the AI Node verified, the second with no fault. A verdict from one run |
| `claim-l4-slow-justifier` | The fault switch holds the real justification | The jury was reached, the justifier within 15 s of its 45 s |
| `claim-l4-cancellation` | The fault switch times the first juror out on both attempts | Nobody commits for `watchSeconds`. Then its control settles (below) |
| `claim-l4-cold-cache` | A valid claim on an image the canaries have not pulled | The jury was reached, each arbiter's `runner_image` is `pulled` or `shared` and at least one pulled, in at most 90 s (§11). An image already there fails, and so does a repeat within 15 minutes, which an arbiter serves from its kept run (`reused`) |
| `claim-l4-dispute` | A claim round, then the dispute round `StakeAttestation.dispute` composes: the listing's dispute archive (the same members, common's dispute panel), the claim, the disclosure line and the statement by CID | Each round as a valid claim, the second naming the statement. The outcome before and after goes in the report. A flip is the contract's `Overturned`: real jurors decide it, so it is measured, not asserted. If the first outcome is not valid the contract would refuse a dispute: no second round and no sample |

```bash
node src/index.js l4 --scenario claim-l4-valid,claim-l4-front-gate,claim-l4-runner-gate \
  --class-id 5555 --expect-common <version> --expect-release <commit> --junit results/l4.xml
```

**Every recorded reveal, not the cluster.** `getEvaluation` names only the clustered arbiters (P = 2 of N = 3), the pair chosen for being closest, so a claim scenario reads each reveal from its transaction instead (`src/l4/reveals.js`): `NewOracleResponseRecorded` gives the transaction, and `fulfillOracleRequestV`'s calldata the vector and `cid:salt`. `claim.revealsComplete` holds them to the aggregator's own `responseCount`, so a lagging log index can't hide an arbiter, and `claim.revealMatchesUpload` holds each upload to what its arbiter revealed. The fourth arbiter asked to reveal, after the round finished, leaves no event, and is not compared.

**`claim.reportHashAgrees` is strict.** A test's message steady on one host and different on another (limit P1, PR #137) gives two hashes, and this fails. No settlement reads `message`, so the verdict is not at stake, but §18's 100% is. If the evidence blocks agree on everything else, the failure says the difference is outside the block, so read the hosts' reports before calling it a defect.

**An abstention has controls.** An abstaining arbiter uploads nothing, so no commit cannot say why. After the watch, L4 sends claims that must settle, each ruling out another reason: for a registry failure, an out-of-scope claim on the same listing (the arbiters are there and take it) and the runner gate on the main listing (the runner is up; its image may be cached, so this does not say the registry is, and it need not: a registry that is down fails the pull just as an absent digest does, and §12 counts them as one failure); for a cancellation, a valid claim to the jury (the runner and the providers are up), which spends the providers' keys once more. They are `control.<kind>.*` in the report. The cause itself is only in each operator's log (`CODE_REVIEW_RUNNER_ABSTAIN … pull_failed`, `CODE_REVIEW_AI_ABSTAIN`), and `applied` in the adapter's `/health` counts what the switch did. L4 does not finalize the round, since that applies the −20 timeliness penalty to each polled oracle (§12). It prints the `cast send` that would, and the prepay stays held until someone runs it.

**The class is refused, never defaulted.** The bridge does not tell the External Adapter the requested class, so nothing on an arbiter stops a claim on class 128, and it would spend real money on real arbiters. So L4 refuses, with exit 1 and before it reads the wallet or calls an RPC, unless the class resolves to exactly 5555:

| Run | Result |
|---|---|
| `--scenario claim-l4-valid`, no `--class-id` (config's 128) | Refused |
| `--class-id 128`, or `L4_CLASS_ID=128`, or a blank `class_id` dispatch input | Refused |
| A text scenario beside a claim, on any other class | Refused: nothing is sent |
| Any scenario in any file carrying a `verdikta-disclosure:` or `verdikta-dispute:` addendum, on any other class | Refused: it is a claim |
| The nightly, or any run that names no scenario | Holds no claim scenario, on any class |

Class 5555 alone is not enough: the run also refuses without both `--expect-common` and `--expect-release`, on any chain but Base Sepolia (the RPC's chain id, measured), and when `estimateGas` fails, since that means selection would revert. A text scenario keeps its fallback gas limit. A claim run also prints the aggregator's `responseTimeoutSeconds`. It does not fail on the value: §11 wants a canary to pass before the timeout moves to 900 as well as after.

**The fault switch, as a run names it.** `--expect-fault-switch off|armed` (`L4_EXPECT_FAULT_SWITCH`, the `expect_fault_switch` dispatch input), default `off`. Every recorded reveal's `arbiter.canaryFault.state`, and on a jury verdict its AI Node's state, must be what the run named, so a claim run with the default fails while any canary is left armed. A fault scenario refuses without `armed`, before anything is sent. On an armed run a claim the plan does not name must show no fault. The switch itself: [`external-adapter/README.md`](../external-adapter/README.md#the-canary-fault-switch). Arming and disarming the canaries: [`docs/release-runbook.md`](../docs/release-runbook.md) §3b.

**Metrics.** A claim run ends with a `claim-l4-metrics` case. It reports and never fails on a metric. The gate is over many runs' `--report` files (the workflow's `l4-report` artifact):

```bash
node scripts/l4-metrics.js results/*.json   # exit 0 only with enough samples, inside every limit
```

| Metric | One sample | Needs | Below that it says |
|---|---|---|---|
| p95 end-to-end latency, against §11's 900 s | A round whose uploads say the jury decided it, with no fault injected, from before the transaction to the poll that saw the result: at most one poll (20 s) late, never early. A round that started and never finished counts as slower than any budget | 20 rounds: nearest-rank p95 of fewer is the maximum | `no p95: n of the 20`, and the slowest |
| σ of the valid mass in points (1 point = 10,000; §18: at most 5) | Sample standard deviation over one jury round's recorded reveals, from the vectors in their transactions. A gate verdict has none | 3 reveals for a number, which is rough, and 5 such rounds for the gate | `no σ` |
| Dispute flips | A dispute round whose first verdict was valid | Always `k of n`; a rate from 10 | No percentage |

A round with a fault injected counts for σ (the switch cannot move a score) and not for latency (the delay is the point of it). Samples come from what the uploads say happened, not from what the scenario expected: a valid claim answered by a gate fails its checks and is no jury sample, and mixed or missing evidence counts for nothing. A request that never started is no sample; one that started leaves one, whatever fails after. An arbiter keeps a run for 15 minutes, and a later round of the same claim is served it, with no pull and no sandbox in its time (`runner_image.cache: reused`): that is no latency sample, so space repeats of a scenario by 15 minutes, or mix scenarios.

**Preparing them (once, an owner's step).** The scenarios read `archives/l4-claim/claim-set.json`. None is committed until then, and naming a scenario without one is an error. The canaries run in production trust, so three listings are signed with the production builder key: the fixture image, a fresh digest for the cold-cache scenario, and an image that is removed from the registry once it is signed, for the registry-failure scenario. The key signs only in its own service, and what it signs must be true when it is signed (design §8.2): the runner validated the listing under gVisor, at a commit anyone can read. So `scripts/prepare-l4-listings.js` builds each statement from a measurement, the runner's own listing check run by `e2e.yml` on the pushed images. It writes what to sign and takes the signatures back. Nothing in a statement is written by hand.

**The fixture repository is a branch of this repository**, `claude/stake-attestation-l4-fixture`: one commit, `43679c1856fbafe0dfe8d24c6e3c883511695002`, the conformance canary's tree committed as the image build commits it (`node scripts/prepare-l4-listings.js fixture-repo --out <dir>` writes it again, to the same hash). Every statement names `https://github.com/verdikta/verdikta-arbiter` and that commit, and `images`, `specs`, `check` and `prepare` each read the branch with `git ls-remote` and refuse another commit. **Never delete or move that branch.** The signed statements point at it for as long as the key is trusted.

You need a `linux/amd64` host with Docker (a host that can't run amd64 images stops with `exec format error`), `gh` signed in with a GitHub token that has `write:packages` (and `delete:packages` for step 9), and a Pinata JWT.

1. Set up from `claude/stake-attestation`, not a PR branch: the check runs there, and `prepare` refuses a run from anywhere else.

   ```bash
   git clone --branch claude/stake-attestation https://github.com/verdikta/verdikta-arbiter.git
   cd verdikta-arbiter
   (cd code-runner && npm ci) && (cd e2e && npm ci)
   cd e2e
   docker login ghcr.io -u <github-user>
   ```

2. Build and push the three images of the fixture commit. This refuses if the branch holds another commit than this checkout's fixture, or an image's repository is at another commit. The fixture has what A3b's PoCs need (`ffi`, `./state`).

   ```bash
   node scripts/prepare-l4-listings.js images --repository ghcr.io/verdikta/stake-attestation-l4-fixture --out ~/l4-images.json
   ```

   It prints each image's digest, tag and size, and keeps them in `~/l4-images.json`. That size is this host's daemon's figure, a note: daemons differ (one measured 620,331,192 bytes where CI's runner measured 641,318,912 for the same digest), so the size a spec states is the runner's, measured in step 4. In the package's GitHub settings, set the visibility to Public, because the check and the canaries pull with no credentials. Then check that each of the three pulls with no login:

   ```bash
   docker logout ghcr.io
   docker pull --platform linux/amd64 <each image it printed>
   ```

3. Write the specs and the check's requests. Each listing gets its own disclosure key, whose private half is never written. A spec states no size yet: the class maximum stands in until the runner measures. This refuses an image outside `ghcr.io/verdikta`, which a default arbiter won't pull, two listings on one digest, and a spec an arbiter would refuse.

   ```bash
   node scripts/prepare-l4-listings.js specs --images ~/l4-images.json --out ~/l4-signing
   ```

4. Run the runner's listing check in CI with the `gh workflow run e2e.yml … -f l4_listing_requests=…` command `specs` printed, then find the run and wait for it. The job "L4 listing check (runsc)" starts the runner at this branch's `RUNNER_VERSION`, under gVisor at the release `@verdikta/common` pins, and checks each image: that it is built on the Foundry base `@verdikta/common` pins (the base's layers are its first), its size, the build, the suite three times, the harness proof. It runs the check twice: the first pass measures each image's size, and the second checks each spec at that size, exactly as it will be signed. Every listing must be accepted and the run must succeed. It needs no secret.

   ```bash
   gh run list -R verdikta/verdikta-arbiter --workflow e2e.yml --event workflow_dispatch --branch claude/stake-attestation --limit 1
   gh run watch <run id> -R verdikta/verdikta-arbiter
   ```

5. Write what to sign, from that run. `prepare` writes each `code_review.json` as the run's second pass checked it: your spec, at the size the runner measured, byte for byte. It checks that the run is `e2e.yml`, dispatched on `claude/stake-attestation`, and a success; that it checked exactly the requests in `~/l4-signing`, with this checkout's runner, `@verdikta/common` and gVisor and this checkout's code (the runner's source hash, this script, its fixtures and lockfile, and `e2e.yml`; if the branch moved since the run, check out the run's commit); and that the runner accepted each listing at the image and size its spec names, on the pinned base. Each statement's baseline is the one the runner measured, its `env.base` the base the run found, and its `tools` the runner and the gVisor that ran. It prints the size of each message, which must fit the signing service's 4,096 bytes.

   ```bash
   node scripts/prepare-l4-listings.js prepare --dir ~/l4-signing --run <run id>
   ```

6. Sign. Open AWS CloudShell, use Actions, Upload file, and pick `~/l4-signing/sign-in-cloudshell.sh`. It holds the bytes to sign and no key name. Then:

   ```bash
   export BUILDER_KEY=<the key id or ARN>
   bash sign-in-cloudshell.sh
   ```

   For each listing it runs `aws kms sign --key-id "$BUILDER_KEY" --message-type RAW --signing-algorithm ED25519_SHA_512 --message fileb://<bytes> --query Signature --output text`. It writes and prints `signatures.json`, which isn't secret. Save that file as `~/l4-signing/signatures.json` on the first host.

7. Put the signatures in. This holds every listing to production trust against `@verdikta/common`'s builder set and writes all three archives or none. Each listing should say `verifies in production trust`.

   ```bash
   node scripts/prepare-l4-listings.js attach --dir ~/l4-signing
   ```

8. Check, then pin. Every `--listing-file` is held to production trust again, so a dev-signed archive is refused here. It prints the fault plan for the switch (`docs/release-runbook.md`, 3b), so keep that too.

   ```bash
   A="--listing-file $HOME/l4-signing/listing.zip --registry-failure-listing-file $HOME/l4-signing/registry-failure.zip --cold-listing-file $HOME/l4-signing/cold-cache.zip"
   node scripts/build-l4-claims.js $A --dry-run
   IPFS_PINNING_KEY=<pinata-jwt> node scripts/build-l4-claims.js $A --pin
   ```

9. Make the registry-failure image unreachable. In the package's settings, delete the version tagged `l4-gone-…` (its tag and digest are under `registry-failure` in `~/l4-images.json`). Then check that its digest no longer pulls:

   ```bash
   docker pull --platform linux/amd64 <the registry-failure image>   # must fail: manifest unknown
   ```

   The order is on purpose. Its statement was true when it was signed, because the runner checked that image; the scenario then tests a validated listing whose image the registry no longer serves. Every canary's pull fails (`pull_failed`) and nobody commits, as for a registry that is down.

10. Commit `e2e/archives/l4-claim/claim-set.json` on `claude/stake-attestation`. Its disclosure keys are a throwaway fixture's, whose private halves were never written, and the same lines go on-chain in the clear.

If a step fails: `attach` writes nothing when any signature is wrong, so sign again and re-run it. If the check refuses a listing, `measurement.json` in the run's `l4-listing-measurement` artifact holds what the runner answered. If `specs` has to run again, use a new directory and run the check again, because each run makes new disclosure keys and `prepare` takes only the run that checked those specs.

**What a signature here means.** Each statement is true when signed: the runner at this release checked that image, at that commit of this repository's fixture branch, under the pinned gVisor, and measured the baseline it carries. `tools.semgrepRules` is the rule set the release pins: Semgrep runs on a claim's PoC, not in a listing check, and the measurement says so (`ran: false`). A signature has no end date: these listings verify on any arbiter while the key is trusted, and removing the key fails every listing it attested. So they name Verdikta's own fixture and chain 31337, and no real contract, and whoever sends a request against one pays for it. A cold image is cold once: a second run on the same digest fails `claim.imageCold`, so it needs a new digest and a new signature, or the eviction in the runbook.

**Dev trust, off the canaries' production path.** `node scripts/build-l4-claims.js --image <repo@sha256:…> --base-commit <hash> [--cold-image <repo@sha256:…>] --dry-run|--pin` signs the listings with a dev builder key it makes and drops, as the L2 suite does, and prints the public half. That needs `CODE_REVIEW_TRUST=dev`, `CODE_REVIEW_DEV_KEYS=<that key>` and `NETWORK_CHAIN_ID=84532` on every arbiter it is sent to, and nothing from it passes production trust.

## CI & secret handling

`.github/workflows/e2e.yml`:

- **`l2-mock`** — runs on PRs/pushes (same-repo) and manual dispatch; boots the
  adapter + mock AI and asserts the pipeline. Needs `IPFS_PINNING_KEY`.
- **`l2-claim`** — the [claim suite](#the-claim-suite---suite-claim-local-no-secret)
  and the testing tool's and harness's unit tests, on every PR, forks included;
  needs no secret.
- **`l4-testnet`** — runs nightly (schedule, class 128) and via manual dispatch;
  needs `RPC_URL` + `E2E_WALLET_PRIVATE_KEY` (and optional `AGGREGATOR_ADDRESS`),
  scoped to the `e2e` GitHub Environment. Dispatch inputs: `class_id`
  (default `5555`), `expect_common`, `expect_release`, `expect_fault_switch`,
  `scenario` (the only way to run a `manualOnly` scenario, see
  [Scenarios](#scenarios), or a [claim scenario](#claim-scenarios-class-5555-only)):

  ```bash
  gh workflow run e2e.yml --ref main -f run_l4=true -f class_id=5555 \
    -f expect_common=1.7.0 -f expect_release=<commit>
  ```

  The wallet must be funded first: the run prints `[l4] wallet=<addr> balance=…`,
  and an `insufficient funds` error within a second of submitting means it
  is empty (each request costs `maxTotalFee` ≈ 0.0018 ETH plus gas).

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

`scenarios/scenarios.json` — each entry needs `id` and exactly one of `cid`
(literal), `cidFile` (path to a file containing the CID, e.g. from `--pin`) or
`cids` (an array, for a multi-CID request):

```json
{
  "id": "canonical-vuln",
  "cidFile": "archives/contract-vuln.cid",   // resolved at load; or use "cid": "Qm…"
  "modes": ["0", "commit-reveal"],
  "minOutcomes": 2,             // structural check
  "expectedWinnerIndex": 0      // mock: always asserted; real: with --assert-winner
}
```

Optional fields:

- `cids` — several archives in one request, the way a bounty sends
  `[evaluation package, hunter archive]`. L4 passes the array as the request's
  `cids`; L2 sends the adapter's comma-joined form (`Qm1,Qm2`).
- `addendum` — the request's `addendumText` (default `""`). L2 appends it as
  `:<addendum>`, which is how the adapter receives it from the job.
- `manualOnly: true` — the scenario never runs in a full-suite run, so the
  nightly L4 (which runs every committed scenario on class 128) and the L2 job
  skip it. It runs only when named for L4 (`--scenario <id>` or the `scenario`
  dispatch input / `L4_SCENARIO`); naming it for L2 is an error. Use it for
  scenarios whose archive names a paid jury.
- `suite` — `claim` for the [L2 claim suite](#the-claim-suite---suite-claim-local-no-secret),
  `l4-claim` for the [L4 claim scenarios](#claim-scenarios-class-5555-only). Neither
  is ever in a full-suite run, and each runs only on its own tier.

`bounty-171-replay` is manual-only: it replays mainnet bounty 171 (issue #81),
whose 2560×12268 px screenshot failed every jury model before the image
normalization in #82, and its package names a paid jury (gpt-5.6-sol +
claude-sonnet-5). Run it against the class-5555 canaries after an AI Node
change:

```bash
gh workflow run e2e.yml --ref main -f run_l4=true -f class_id=5555 \
  -f scenario=bounty-171-replay -f expect_release=<commit>
```

`link-canary` is manual-only too: it checks that jurors open links (the AI
Node's web tools, `AI_WEB_ACCESS`). The URL is only in the submission file, the
page's `Answer:` line names the winning outcome (COBALT, index 2) and its
`Canary code` (`976AB00F4F56`) exists only on that page, so a juror that did not
open the link cannot quote it. Run it after an AI Node change:

```bash
gh workflow run e2e.yml --ref main -f run_l4=true -f class_id=5555 \
  -f scenario=link-canary -f expect_release=<commit>
```

then confirm the winner is COBALT and the justification quotes the code. OpenAI's
fetcher cannot read IPFS gateways (Pinata timed out, ipfs.io and dweb.link
answered 403 on 2026-10-16), so the page is served from raw.githubusercontent.com.

## Configuration

`config/e2e-config.json` holds defaults; `.env` and CLI flags override. Key
knobs: `adapterUrl`, `mockAi.{port,winnerIndex,winnerShare}`,
`ipfs.{gateway,checkJustificationFetch}`, `timeouts`, `tolerances.scoreSumSlack`.

## Reports

- `--report <file>` — JSON summary
- `--junit <file>` — JUnit XML (for CI)

Exit code is `0` when all cases pass, `1` otherwise.

## Auditing the oracles behind a request

`getEvaluation`'s `justificationCID` is a **comma-separated list** — one
justification per revealed oracle — and the aggregator emits `OracleSelected` /
`CommitReceived` / `NewOracleResponseRecorded` events identifying the operators.
The audit tool combines both to show exactly who served a request and how:

```bash
npm run audit-oracles -- 0x<aggId> [0x<aggId>…] [--lookback 20000]
# commits/reveals/fulfilment are printed as t+Ns after the request block
```

Per aggId it reports: fulfillment status, aggregated scores, selected/committed/
revealed slots with operator addresses, and each oracle's justification —
scores, per-model failures, and the arbiter's **self-reported version** (the
External Adapter embeds `{ arbiter: { adapter, aiNode, verdiktaCommon,
release } }` in every justification it uploads; the same info is served at
`GET /version` and stamped in `$INSTALL_DIR/VERSION` by install/upgrade).
Arbiters running pre-versioning builds show `(not reported)` — sampling live
traffic with this tool is how you inventory which fleet nodes need upgrading.

## Roadmap / ideas

- Optionally boot the AI Node too (for turnkey `l2 --real` in CI).
- Pin a canonical, project-owned E2E evidence archive (instead of relying on the
  frontend/demoClient default CIDs) and reference it from `scenarios.json`.
- Additional scenarios (more outcomes, attachments) once canonical archives
  are pinned; a project-owned multi-CID scenario for the nightly (the only one
  today, `bounty-171-replay`, is manual-only).
