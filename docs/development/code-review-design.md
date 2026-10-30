# Code-review evaluations on Verdikta arbiters — design

**Status:** proposal, 2026-10-16; revised 2026-10-19 after review (PR #96);
§15 records the decisions taken on 2026-10-19 and the pre-flight fee of
2026-10-20; §16 (2026-10-30) chooses the first application, stake-backed
security attestation
**Touches:** verdikta-arbiter (new `code-runner`, External Adapter, AI Node,
installer), verdikta-common (schemas, three ClassIDs with hard limits, image pins,
trusted builder keys), example-bounty-program (code bounty type, environment
build and attestation, PR submissions, pre-flight checks, PR convention), aggregator configuration
(one timeout; the fee ceiling for the premium class), and — for the first
application (§16) — a `StakeAttestation` contract and attestation site flows
(verdikta-applications).

---

## 1. Summary

Arbiters grade code today by reading it. A code bounty's submission is up to ten
text files, and the jury's "functionality" and "testing" scores are opinions:
nothing builds the code or runs a test. This design lets an arbiter **run** a
submission — apply it to the bounty's repository, build it, run the repository's
tests and the bounty's acceptance tests, lint and scan the change, exercise its
HTTP API — and grade from that evidence at a predictable cost.

Eight decisions carry the design:

1. **Grade a patch against a pinned commit, not a live PR.** The bounty pins
   `repo` + `baseCommit`; the submission archive carries `submission.patch`,
   built from the hunter's PR when they submit. Grading never fetches from
   GitHub, so every arbiter grades the same bytes.
2. **Build the environment once, when the bounty is created.** The bounty
   program builds a digest-pinned container image (repository at `baseCommit`,
   dependencies installed, baseline test results recorded) and validates the
   bounty's commands against it before the bounty is funded, then **signs an
   attestation** that binds image, commit, commands, baseline and acceptance
   assets together. Arbiters verify the attestation and pull the image; they
   never install dependencies or touch the network while grading.
3. **One new arbiter component, `code-runner`,** runs a fixed pipeline — apply →
   build → tests → lint/SAST → API checks → tests-only replay — in a fresh gVisor
   container with no network, under the class's hard limits, on its own disk,
   and returns a deterministic Verification Report whose facts carry an
   explicit **trust tier**: observed from outside the tested program, or
   reported from inside it.
4. **Deterministic gates settle failing submissions with no LLM call,** the way
   malformed bCID archives settle today: the patch doesn't apply, the build
   fails, a required test fails on any run of a fixed schedule, a test record is
   missing or forged, a previously passing test regresses.
5. **Jev makes the many small, typed judgements** — one per rubric criterion,
   per lint finding, per gaming signal — for a fraction of a cent, and sits on
   the jury as a low-weight "rubric juror". It is reached through OpenRouter, so
   operators need no new key.
6. **Frontier models do the deep review** — logic and edge cases the tests miss,
   security, test adequacy — with the report as evidence whose trust tier is
   explicit, every tool finding in view, and a bounded, deterministic context
   pack. In code mode every non-Jev juror must answer.
7. **Code bounties get three ClassIDs — `code-micro`, `code-standard`,
   `code-premium`** — each with an enforced envelope (model pool, panel size,
   counts, iterations, context and output budgets) and its own registered fee.
   One class cannot carry two price tiers: the selector takes any job priced at
   or below the request's ceiling and pays the job's registered fee. Only
   arbiters whose runner passes a conformance self-test register for any of them.
8. **One protocol change,** raising the aggregators' `responseTimeoutSeconds`
   from 300 s to 900 s, **and a cost plan instead of a funding change:** the
   hunter keeps paying, as today, and the design brings the price down — a micro
   class on open-weight code models (≈ $1 per submission), a standard class with
   one frontier juror (≈ $3.50), a pre-flight check for a small fee credited
   against the prepay (§6.4), and a deterministic context pack sized to the
   change (§8.7–8.8).

A ninth decision, taken on 2026-10-30 after two rounds of market research,
chooses the **first application** of this machinery: not code bounties but
**stake-backed security attestation** — a maker escrows awards by severity
against an exact artifact hash, hunters try to claim them with executed proofs
of concept, arbiters judge the claims, and the live public record of the stake
and its history is the product (§16). The pipeline is unchanged; the `bug` kind
of §6.5 becomes the lead.

## 2. Goals and non-goals

**Goals**

- Grade "reasonably sophisticated" PRs — hundreds to a few thousand changed lines
  in a Node or Python repository — on correctness, regressions, tests, lint, API
  behaviour and fit to the rubric.
- Every arbiter on a request reaches the same execution facts. Commit-reveal
  clusters the answers, so divergent evidence costs operators reputation.
- Untrusted code never gets near the node's keys.
- Lower LLM cost than an all-frontier panel, and no LLM cost at all for a
  submission that fails a gate.
- Buildable in phases by a small team, mostly on existing paths.

**Non-goals for v1**

- Private repositories; monorepos whose suite cannot finish inside the limits;
  browser/E2E suites; GPU work.
- Hidden tests. Acceptance tests are public in the bounty archive (§15).
- Reviewers with a shell during grading, in v1 (§14; a bounded form — a local
  read/grep tool, then a hosted shell for `code-premium` — arrives in Phase 3).
- Languages other than Node and Python in Phase 1. Solidity (Foundry) and Go follow.

## 3. Constraints from the current system

| Constraint | Fact (where) | Consequence |
|---|---|---|
| Time | Both aggregators have `responseTimeoutSeconds = 300` and K/M/N = 6/4/3 — six arbiters polled to commit, the first four commits revealed, three reveals aggregated (read from Base Sepolia `0xe8a3…80e4` and Base Mainnet `0xd8F3…142a` on 2026-10-16). The job's `maxTaskDuration` and bridge timeout are 300 s (`chainlink-node/basicJobSpec`); the AI Node's request timeout is 240 s. | Commit **and** reveal must finish inside 5 minutes today. That does not fit a build, a test run and a deep review. |
| Consensus | Six arbiters evaluate each request independently and are clustered on reveal. | Execution must be reproducible across machines: pinned environment, no network, flake handling, no host-specific data in the LLM input. |
| Security | The arbiter host holds the operator key, funded node keys, the Pinata JWT and the AI provider keys. | Untrusted code runs only inside gVisor (or on a separate machine), with no network and no credentials. |
| Sandbox speed | verdikta-agents measured gVisor without KVM at 2–6× slower than runc. A cold install + typecheck + test of this repository took ≈19–25 min against ≈6 min; warm test runs take seconds (`verdikta-agents/docs/agent_coding_sandbox_design.md`, D2). The Contabo hosts have no `/dev/kvm`. | Dependencies cannot be installed at grading time. Hence decision 2. |
| Bounty model | The rubric has ≤10 criteria, each with `must` / `weight` / `description`; outcomes are `[DONT_FUND, FUND]`; a submission is paid when FUND ≥ threshold (`BountyEscrow.sol` `_scoreVector`). Submissions are ≤10 files and archives are rejected. There is no repo, PR or commit field anywhere. The "Code Review" rubric template is judged by reading alone. | A code bounty spec and a patch-based submission are needed. Rubric semantics stay as they are. |
| Fees | The bounty program's default per-oracle fee is 0.00002 ETH (≈ $0.05); the hunter prepays 12× at submission; the aggregators cap the per-oracle fee at 0.0004 ETH (`maxOracleFee`, owner-settable). | Code panels cost operators 8–30× today's fee (§8.8). |
| Selection and payment | `ReputationKeeper.selectOracles` takes every active job in the class whose registered `fee <= maxFee`; the aggregator credits that **registered** fee, not the request's ceiling. Nothing in the EA or AI Node reads the classmap's `max_panel_size` / `max_no_counts` / `max_iterations` today. | A price tier needs its own class, and the arbiter must enforce the class envelope itself (§8.4). |
| Reputation | A round that times out applies the −20 timeliness penalty to every polled oracle that did not commit (`_applyTimeoutPenalties`); committing outside the first 4 of 6 also costs −20. | "Abstain" (error, no commit) is not neutral; refuse early rather than fail late (§10). |
| Precedent | The EA already settles a deterministically malformed bCID archive with a first-outcome verdict and no AI call (`external-adapter/src/utils/bcidValidation.js`, `buildMalformedSubmissionVerdict` in `evaluateHandler.js`). | Gate failures reuse that path. |

## 4. What best-in-class grading looks like

- **Execution is the reliable signal.** SWE-bench grades a patch by applying it to
  a pinned base commit inside a prebuilt per-repository Docker image and checking
  FAIL_TO_PASS (tests the change must turn green) and PASS_TO_PASS (tests that
  must stay green). Any regression fails the patch. Tasks are validated before
  use: the tests must fail without the reference fix and pass with it.
- **Editable or weak tests are the main reward-hacking surface.** Graders keep the
  evaluating tests out of the submitter's hands — the test patch overwrites the
  submitter's copy of those files — and treat deleted tests, new skips and
  special-cased inputs as red flags.
- **LLM-only review is noisy.** A January 2026 study of LLM vulnerability
  detectors found an 85% false-discovery rate for the best tool; Atlassian
  reported 28–43% of its reviewer's comments as wrong, depending on category.
  Production reviewers run deterministic linters and SAST first, then use the
  model to triage those findings and to reason about what tools cannot see:
  business logic, auth flows, races.
- **The scaffold matters as much as the model.** The same model grades
  differently with different context and prompts, so the context a jury sees has
  to be deliberate — and, for Verdikta, identical on every arbiter.

The design follows that order: execution facts gate and anchor; tools find
candidates; cheap typed judgements triage; frontier models reason; several models
must agree.

## 5. Architecture

```
Bounty creation (bounty program, once per bounty)
  creator: repo + base branch + commands + acceptance tests + rubric
  env builder: clone @ baseCommit, install deps, run suite at base
     ├─ validates: build passes, suite stable over 3 runs, acceptance tests fail at base, timings
     ├─ pushes env image  ghcr.io/verdikta/bounty-env@sha256:…
     └─ signs attestation.json (image, platform, size, commit, asset hashes, versions)
  primary archive: query + rubric + code_review.json + attestation.json
                   (+ acceptance.patch, api.hurl, baseline.json)

Submission (bounty program)
  hunter: PR URL (or a .patch) ─► bCID archive: submission.patch + submission.json

Evaluation (each selected arbiter; one deadline from EA receipt)
  Chainlink job ─► EA /evaluate
                    ├─ fetch primary + bCID archives                       (existing)
                    ├─ verify attestation + class envelope ─► invalid: requester error, no commit
                    ├─ POST code-runner /v1/runs ─► gVisor container, --network none, own disk
                    │     apply → build → tests (fixed repeat schedule) → lint/SAST → API checks
                    │     (+ tests-only replay)  →  integrity checks
                    │     ◄─ Verification Report (tiered evidence) + context pack
                    ├─ a gate or integrity check failed? ─► deterministic DONT_FUND  (no LLM)
                    └─ otherwise POST AI Node /api/rank-and-justify (code mode)
                          ├─ Jev: rubric checks, finding triage, gaming flags  (~1 s, <$0.01)
                          ├─ frontier jurors: deep review, scores              (parallel)
                          └─ justifier ─► justification + execution-evidence block
                    ─► commit / reveal                                         (existing)
```

### 5.1 Interface changes

| Where | Change |
|---|---|
| `@verdikta/common` | Manifest key `codeReview`; schemas for `code_review.json`, `attestation.json` and the Verification Report; the trusted-builder key set; the three code ClassIDs with their envelopes and **hard limits**; pinned base-image, gVisor and Semgrep-rule versions and the OCI platform; the conformance canary's expected report hash |
| `code-runner/` (new) | `POST /v1/runs` `{ primaryCid, bcid, spec, attestation, patch, acceptancePatch, hurl, baseline, deadline }` → `{ report, reportSha256, contextPack }`; `GET /health`. Own `dockerd` with a fixed-size data disk (§7.1) |
| External Adapter | When the primary manifest has `codeReview`: verify the attestation and class envelope; compute the single deadline (§9) and pass remaining time to the runner and the AI Node; call the runner (shared per primary CID + bCID); settle gate and integrity failures; otherwise pass the report and context pack to the AI Node as named text attachments plus a structured `codeReview` field; no sandbox re-run on retry |
| AI Node | `rank-and-justify` accepts optional `codeReview` (report, parsed rubric, `deadlineMs`): code-review pre-prompt with trust tiers, Jev stage through an OpenRouter `systemone` client (annotating, never filtering) plus a Jev claim check on the justification, every non-Jev juror required, deadline-derived timeouts with cancellation, web access off |
| Chainlink job spec | `maxTaskDuration` and bridge timeout 300 s → 840 s |
| Aggregators | `setResponseTimeout(900)`; `setMaxOracleFee` above 0.0004 ETH for the premium class (§8.8) |
| Bounty program | Code bounty form with micro/standard/premium templates bound to the three classes; builder Action, fallback workflow, validation report and **attestation signing**; `prUrl`/`.patch` submissions checked against a temporary index; **pre-flight check** (tiers 0–1b) and a local CLI before the hunter pays (§6.4); Jev rubric check at creation and submission pre-check (§6.4); PR bot comment and label for bounty submissions (§6.3); code variant of the evaluation query; hunter-diligence text (§6.4); pending-state UI to 15 min |
| `BountyEscrow` | `prepareSubmission` becomes payable (`preflightFeeWei` per bounty, recorded as `s.preflightPaid`); `startPreparedSubmission` requires `maxTotalFee − s.preflightPaid`; forfeited fees of still-`Prepared` submissions go to an immutable `preflightProvider` (§6.4) |
| `StakeAttestation` (new, verdikta-applications) | Escrow by severity award table bound to an artifact hash, with lineage; commit → fix window → reveal; hunter bond returned on VALID; maker dispute escalation; `recordByHash` and the listing feed (§16) |

## 6. Bounty and submission contract

### 6.1 Code bounty spec: `code_review.json` in the primary archive

The manifest gains one optional key, `"codeReview": "code_review.json"`, with its
schema in `@verdikta/common`.

```json
{
  "version": 1,
  "kind": "change",
  "repo": "https://github.com/acme/widgets",
  "baseCommit": "9c1e4f…",
  "env": { "image": "ghcr.io/verdikta/bounty-env@sha256:…", "from": "node22",
           "platform": "linux/amd64", "unpackedBytes": 1850000000 },
  "attestation": "attestation.json",
  "commands": {
    "framework": "vitest",
    "build":     "npx tsc --noEmit",
    "test":      "npx vitest run",
    "testFiles": "npx vitest run $FILES",
    "testIds":   "npx vitest run -t $TEST_IDS",
    "lint":      "npx eslint -f json -o $OUT/eslint.json $CHANGED_FILES"
  },
  "acceptance": { "patch": "acceptance.patch", "checks": "acceptance.hurl" },
  "api": { "start": "node dist/server.js", "ready": "http://127.0.0.1:3000/health", "checks": "api.hurl" },
  "baseline": "baseline.json",
  "paths": { "tests": ["test/**", "**/*.test.ts"], "protected": ["vitest.config.*", ".github/**"] },
  "gates": { "build": true, "acceptance": true, "noRegressions": true, "noDependencyChanges": true },
  "limits": { "cpus": 2, "memoryMb": 4096, "buildSeconds": 90, "testSeconds": 180, "runSeconds": 360,
              "maxPatchBytes": 2000000 }
}
```

- `kind` is `change` (a feature or fix PR) or `bug` (a bug report with a
  proof-of-concept test, §6.5).
- Commands run **only inside the sandbox**, exactly as written, and the runner
  appends its own reporter flags for the declared `framework` (JUnit to a path it
  chooses). The tested program can still see that path and the arguments — it
  runs in the same process as the reporter — which is why in-process results are
  **tier-B evidence** subject to the integrity checks in §7.5. `testIds` re-runs
  named tests for the fixed repeat schedule. The only formats the runner parses
  are JUnit XML for tests and JSON/SARIF for linters.
- `acceptance.checks` is optional but recommended: Hurl or CLI checks the runner
  executes from its **own** container against the built artifact. Those results
  are tier A — the submission cannot touch the process that observes them.
- `baseline.json` is the per-test status at `baseCommit` over three runs: the
  `stable` set (gates apply) and the `unstable` set (excluded from gates up
  front; nothing learned later can add to it).
- `limits` may only **lower** the class's hard maxima (§7.1); a spec above them is
  a requester error.
- `attestation.json` is the builder's signed statement (§6.2). Without a valid
  one the archive is the requester's broken package: errored path, no commit.
- The creator supplies all of it; the environment build (§6.2) validates it before
  the bounty can be funded. The rubric is unchanged. The bounty program's code
  template and evaluation query (`archiveGenerator.js`) gain a code variant that
  points the jury at the execution evidence and its trust tiers.

### 6.2 Environment image, built at bounty creation

The environment builder is a reusable GitHub Action published by Verdikta. A
creator whose repository has CI runs it there (the build job holds no secrets; a
separate job pushes the image); for everyone else the bounty program runs the same
Action in its own workflow. Either way the bounty program validates the result
before the bounty can be funded, by running steps 2–3 itself, and only then signs
the attestation (step 5). The Action:

1. Starts `FROM` a blessed base image (`node22`, `python312`; digests pinned in
   `@verdikta/common`, platform `linux/amd64`), clones `repo` at `baseCommit`
   and runs the creator's `setup` (`npm ci`, `uv sync --frozen`, …) with network
   access.
2. Runs `build` once and `test` **three times** at base with the same runner and
   gVisor release the arbiters use, without network. Tests that pass all three
   runs form the `stable` set; anything else is `unstable` and excluded from the
   gates before any submission exists. It records `baseline.json`, the timings
   and the image's unpacked size, and sets default limits to 3× the measured
   times plus the repeat-schedule reserve (§7.2). If that exceeds the 360 s
   `runSeconds` cap, the repository is too heavy for code review v1 and creation
   stops here — this is what keeps §9's budget honest.
3. Applies `acceptance.patch` and checks that the acceptance tests **fail** at
   base; if they pass, it warns the creator that they cannot tell a submission
   from no change. It runs `acceptance.checks` and the API `start`/`ready` pair
   the same way.
4. Pushes the image to a public registry (GHCR by default — public images cost
   nothing to store or pull; images over 2 GB compressed or 6 GB unpacked are
   rejected so arbiters can pull and store one inside their limits) and writes
   its digest, platform and unpacked size into `code_review.json`.
5. **Signs `attestation.json`:** image digest, platform, unpacked size, `repo`,
   `baseCommit`, SHA-256 of `code_review.json`, `baseline.json`,
   `acceptance.patch`, `acceptance.hurl` and `api.hurl`, and the runner, gVisor
   and rule-set versions used — signed with a key in `@verdikta/common`'s
   trusted-builder set. A digest pins bytes; the attestation certifies that
   validation happened on those bytes.

The creator sees this validation report before funding. Arbiters treat the image
like the rest of the bounty: defined by the creator, public, content-addressed —
and, through the attestation, verified before it is funded.

**How arbiters get it.** Arbiters learn nothing about a bounty in advance. The
image digest travels in `code_review.json` inside the primary archive, which the
EA fetches from IPFS at evaluation time exactly as it fetches the rubric today;
the runner then pulls the image by digest into its own Docker data disk (§7.1),
after checking the attested unpacked size against that disk's free space. The
first pull per operator per bounty costs 0–90 s (a 2 GB image at 50 MB/s is about
40 s; the §9 budget allows for it), and every later submission to that bounty
hits the cache. The work scales per bounty, not per submission or per arbiter:
one build of 5–25 CI minutes, 0.3–2 GB of registry storage with the base layers
shared, and on each arbiter a 40 GB fixed-size disk holding an LRU cache (6–20
images) whose evictions only cost a re-pull. If registry
availability becomes a concern, the image tarball can also be pinned to IPFS as a
fallback source; v1 does not need it.

### 6.3 Submission: the bCID archive

`POST /jobs/:id/submit` accepts a `prUrl` (or an uploaded `.patch`). The server:

- reads the PR's head SHA and builds `git diff --binary <baseCommit> <headSha>`;
- rejects early, with a message the hunter can act on: wrong repository; PR not
  based on `baseCommit` ("rebase onto 9c1e4f…"); patch larger than
  `maxPatchBytes`; patch that fails `git apply --cached --check` against a
  per-request temporary index (`GIT_INDEX_FILE` populated with
  `git read-tree <baseCommit>` from a bare mirror — plain `git apply --check`
  needs a worktree and rejects valid patches in a bare repository; nothing is
  executed and concurrent submissions never share an index);
- pins `submission.patch`, `submission.json` (`prUrl`, `headSha`, `patchSha256`,
  diff stats) and the usual narrative.

The PR may change after submission; the grade belongs to the pinned patch.
Arbiters never read `prUrl`.

**Paid and unpaid PRs on the same repository.** Verdikta's own repositories will
carry bounties too, so "PRs are not bounties" has to become a mechanism rather
than a blanket rule:

- A bounty on a repository is announced by a GitHub issue carrying the `bounty`
  label and the bounties.verdikta.org link; the bounty's `repo` + `baseCommit`
  point at that repository.
- A PR is **paid only if the site records it as a submission**. When a hunter
  submits, the bounty program's bot comments on the PR ("Submitted to bounty #N
  at commit `abc123`; graded on the pinned patch") and adds the
  `bounty-submission` label. A PR without that comment is an ordinary,
  unpaid contribution, whatever its description says.
- `CONTRIBUTING.md` / `AGENTS.md` wording: "Pull requests are unpaid
  contributions unless bounties.verdikta.org records them as a submission to a
  bounty; bounty-labelled issues say which work is paid and how to submit."

### 6.4 Before anyone pays: pre-flight, local CLI, and cheap checks

The hunter pays the evaluation prepay (§8.8), so the cheapest evaluation is the
one that never reaches the network. Submission becomes a two-step flow that maps
onto the escrow's existing STEP 1 / STEP 2: **pre-flight** (small fee, credited)
then **submission** (the class prepay). Everything here runs outside the
consensus path, so it needs no determinism and can change freely.

**The pre-flight tiers.**

| Tier | What runs | Time | Marginal cost to provide | What the hunter learns |
|---|---|---|---|---|
| **0 — static** (today's `POST /submit/dry-run`, extended) | PR based on `baseCommit`; patch applies against a temporary index; size and binary checks; dependency-file changes; protected paths touched; tests deleted or skipped; `submission.json` consistent | < 1 s | ≈ 0 | The `applies` and `noDependencyChanges` gates and the deterministic flags, exactly as the arbiters will compute them |
| **1 — sandbox** | The arbiters' `code-runner` pipeline on the same attested image, **minus the jury**: apply → build → full suite with the three-run schedule → integrity checks → lint/SAST → `acceptance.hurl` / `api.hurl` → tests-only replay → Verification Report | 1–6 min | ≈ $0.01–0.03 (2 vCPU × ≤ 6 min, image pull, IPFS fetch), plus a warm runner pool | A **gate forecast**: a run that passes every gate here passes them on-chain — same runner, image and rules, barring the nondeterminism the fixtures guard against. Plus the exact context pack the jurors will read |
| **1b — Jev readiness** | Jev's rubric questions on the report and diff: a level and confidence per weighted criterion, a probability per must-pass criterion, the special-casing and scope flags | ~2 s | ≈ $0.003 | A **readiness** signal, labelled advisory and weakly calibrated: "the gates will pass; the jury is not the gates" |

Tier 1 is the part worth paying for: it is the only way to learn, before paying,
that the prepay will not be lost to a deterministic gate. The result page shows
two things and never a predicted verdict — **gates: pass / fail** (certain) and
**readiness: low / medium / high** (advisory). A *preview grade* by a cheap LLM
juror is deliberately not offered in v1: it duplicates the real evaluation,
invites iterating against the jury, and a cheap model predicts the frontier
jurors poorly.

**The pre-flight fee.** Tier 0 is free and unlimited. Tier 1 carries a small
fee, for two reasons that have nothing to do with revenue: without it the
sandbox is free CI for anyone and a free "run until green" loop against the
public acceptance tests, and the runner pool costs money to keep warm. The local
CLI (below) already gives the same deterministic answer for free on the hunter's
own machine, so the fee withholds no information; it only stops people spending
the site's compute.

- **Amount:** `preflightFeeWei`, set by the creator per bounty in `CreateParams`
  (0 allowed, capped by a constant); the template default is **0.0001 ETH
  (≈ $0.24)** — about 10× marginal cost, enough that a 20-iteration loop costs
  $5, and a fifth of the micro prepay rather than half of it.
- **Credited, not added.** The fee counts toward the prepay when the hunter
  submits the **same** archive (`hunterCid`) the pre-flight ran on. A hunter who
  passes pre-flight and submits pays nothing extra; the fee only sticks with the
  hunter who was told "this fails" and walks away — the one the check saved
  $1–3.50.
- **Forfeit:** if the submission is still `Prepared` when the bounty closes or
  its deadline passes, the fee goes to `preflightProvider`, an immutable address
  set at escrow deployment for whoever runs the runner pool (the bounty site
  today).
- **Rate limits regardless:** one pre-flight in flight per wallet, and a per-bounty
  daily cap.

**How it maps onto `BountyEscrow`** (two edits to functions that already exist):

1. `prepareSubmission(bountyId, evaluationCid, hunterCid)` — STEP 1, today
   non-payable — becomes `payable` with `msg.value == b.preflightFeeWei`,
   recorded as `s.preflightPaid`. The site listens for the prepared event, runs
   tiers 0–1b for that `hunterCid` on its runner, and posts the gate forecast,
   readiness and context pack.
2. `startPreparedSubmission(bountyId, submissionId)` — STEP 2, payable today with
   `msg.value == maxTotalFee` — requires `msg.value == maxTotalFee −
   s.preflightPaid`. The credit falls out of the existing arithmetic; the
   evaluation wallet still receives the full prepay and the refund path is
   untouched.
3. `closeExpiredBounty` / the deadline path pays `s.preflightPaid` of any
   still-`Prepared` submission to `preflightProvider`.

An off-chain alternative (x402 USDC micropayments on the API endpoint) needs no
contract change but adds a second payment rail and cannot credit the fee against
an on-chain prepay; the on-chain form is preferred.

Net flow for a hunter on a micro bounty: iterate with the free CLI → pay ≈ $0.24
for the official pre-flight → see "gates pass, readiness medium" → pay ≈ $0.92
more to submit. A hunter whose patch fails a gate pays $0.24 and keeps $1.16.

**The rest of the toolkit:**

- **Local CLI.** `npx @verdikta/bounty-check <bounty-url> <patch|PR>` runs tiers
  0–1 on the hunter's machine against the public image. Zero cost to everyone,
  and the recommended way to iterate.
- **Jev at creation** (`noul` per criterion: "is this assessable from code and
  tests?", "does an acceptance test exercise it?"; `noul` on the query for
  contradictions). Warnings to the creator, no gating; ≈ $0.001 per bounty.
  Fewer unsatisfiable or ambiguous bounties means fewer wasted submissions.
- **Jev at submission** (`noul`: "does the narrative address this bounty?",
  `choice` per changed file: required / related / unrelated). Shown with the
  pre-flight result; nothing is blocked.
- **Hunter-diligence text** on the bounty page and in the CLI output: the
  creator defines the environment, acceptance tests and gates (§15.5); read the
  acceptance tests before working; run the CLI before paying; the pre-flight fee
  is credited only against the same archive; the prepay is spent even when the
  verdict is `DONT_FUND`; the grade belongs to the pinned patch, not to the PR
  as it later evolves.

### 6.5 Two bounty kinds, one pipeline

| | `change` (feature or fix) | `bug` (find a bug) |
|---|---|---|
| Hunter submits | A patch: source and tests | A report and a patch adding a PoC test, optionally with a fix |
| Must hold (gates) | Patch applies; build passes; acceptance tests pass; no baseline-passing test fails or disappears | PoC tests **fail at base** as test failures, not import/collection errors where the framework tells them apart; with a fix included, they pass |
| Jury judges | Rubric fit, correctness beyond the tests, test quality, scope, safety | Is the asserted behaviour really required (spec, docs, scope)? Severity? Is the PoC minimal and honest? |

`bug` is the lead kind of the first application (§16) and moves into Phase 1
together with the Foundry image; §16.6 adds three gates to its row. `change`
bounties use the same pipeline and remain supported.

## 7. The code runner

### 7.1 Placement and isolation

- `code-runner/` is a small Node service, like the EA, listening on `127.0.0.1` or
  a Unix socket with a shared token. It **holds no secrets**. It drives Docker
  with argv arrays, never a shell, and never executes submission content on the
  host — `git apply` included runs inside the container.
- Every run gets a **fresh container** from the env image:
  `--runtime=runsc` (gVisor), `--network none`, `--cap-drop ALL`,
  `--security-opt no-new-privileges`, a non-root user, `--pids-limit`,
  `--memory` equal to `--memory-swap`, `--cpus`, a capped scratch overlay
  (`--overlay2=root:dir=…,size=…`; the `self` medium fails on kernel 5.4), no bind
  mounts, no Docker socket. Nothing survives from one submission to the next
  except read-only image layers.
- **Own Docker daemon, own disk.** The runner drives a dedicated `dockerd` (its
  own socket and `data-root`) whose storage is a fixed-size loop-mounted ext4
  image — 40 GB by default, the verdikta-agents workspace-disk technique. Image
  pulls, layer extraction and container scratch can fill only that disk, never
  the root filesystem Chainlink and Postgres write to. Admission checks the
  attested unpacked size plus the scratch cap against the disk's free space
  before a pull begins; a 2 GB compressed limit alone bounds nothing, since 64 MiB
  of zeros compress to 65 KB.
- **Class maxima are the runner's law.** The runner carries the class's hard
  limits from `@verdikta/common` — v1: 2 CPUs, 4 GB memory, 4,096 pids, 90 s
  build, 360 s run, 2 GB compressed / 6 GB unpacked image, 2 MB patch, 50 MB
  patch expansion, `linux/amd64` only — and applies them whatever the spec says.
  A spec above them is rejected before any pull or work, as a requester error.
  The bounty site's validator is a convenience for creators, not the arbiter's
  defence: the request API accepts any CID.
- **Attestation before work.** The EA verifies `attestation.json` against the
  trusted-builder keys and checks that its hashes match the archive's
  `code_review.json`, `baseline.json`, `acceptance.patch`, `acceptance.hurl`,
  `api.hurl`, and the image digest and platform. Missing or invalid → the
  requester's package is broken (errored path, no commit), identically on every
  arbiter.
- Results are read out as capped byte streams (`docker exec … cat`, never
  `docker cp` to a host path). JUnit XML is parsed with entity expansion off. Logs
  are cut to a 32 KiB head/tail per step.
- **Two placement modes.** `local` (default) runs gVisor on the arbiter host, as
  the verdikta-agents P5 gate did beside a live mainnet arbiter. `remote` points
  `CODE_RUNNER_URL` at a separate small VPS, for operators who want untrusted code
  off the key machine altogether.

### 7.2 Pipeline for one evaluation

1. **Admit.** Take a slot; keep a memory reserve for Chainlink, Postgres, the AI
   Node and the largest Ollama model; refuse while an install or upgrade runs;
   refuse when the remaining time (§9) cannot cover the run. When several of the
   operator's jobs are selected for the same request, they share one run, keyed
   by **primary archive CID + submission bCID + runner version + rule-set
   version** — every evaluation input (spec, acceptance patch, baseline, Hurl
   files, image digest, submission) is content-addressed by those two CIDs, so two
   bounties that share an image and a spec but differ in acceptance bytes never
   coalesce. This mirrors `cidFetchCache.js` for IPFS downloads.
2. **Pull** the env image by digest from the allow-listed registry into the
   runner's own disk, after the size admission check. Images are cached and
   evicted least-recently-used.
3. **Apply** `submission.patch` (the `applies` gate). Before any submission code
   runs, compute the diff stats, the changed files split into tests and source,
   the dependency-change check, the flags (tests deleted, skip markers added,
   existing tests modified, protected paths touched) and the **context pack**
   (§8.3). Commit the result inside the container with a fixed author and date.
4. **Reset protected and acceptance paths to base, then apply
   `acceptance.patch`.** The evaluating tests and their runner configuration are
   always the creator's, as in SWE-bench.
5. **Build** (the `build` gate).
6. **Test.** Run the full suite with the runner's reporter flags, parse JUnit and
   compare with `baseline.json`: acceptance results, regressions (`PASS→FAIL` and
   `PASS→missing`), newly passing tests, the hunter's new tests. **Fixed repeat
   schedule:** every *required* test (acceptance tests and the baseline `stable`
   set) that fails is re-run exactly twice more by identity (`testIds`), with
   the time reserved inside `runSeconds` at creation. A required test that fails
   on **any** of its runs fails its gate; the report records the pattern
   (`fail,pass,pass` is an intermittent failure the submission introduced, and
   it is the submission's defect). Nothing observed during a submission's run
   can exempt a test; the only exclusions are the `unstable` set the builder
   fixed at base. A patch that fails first and passes on retry therefore cannot
   pass by retrying, and two arbiters with different time left reach the same
   verdict from the same observations.
7. **Integrity checks** on the test evidence (§7.5): identity completeness,
   framework-summary consistency, exit-code consistency, post-run checksums of
   protected paths and installed dependencies, static tamper flags. Any failure
   turns the gates that depend on in-process results into failures and is named
   in the report.
8. **Lint and SAST.** Run the repository's linter on the changed files, Semgrep
   with Verdikta's pinned offline rules (`--baseline-commit` = base, so only new
   findings), and a secret scan over added lines. All findings on added lines are
   kept, severity-ordered and bounded at 50; nothing downstream removes them.
9. **API and acceptance checks** (optional, tier A). Start the service in the
   background, poll `ready` for up to 60 s, run the creator's `api.hurl` and
   `acceptance.hurl` from the **runner's own client container** (`hurl --test
   --report-junit`), stop the service. The submission cannot touch the process
   that records these results.
10. **Tests-only replay** (optional, in a parallel container). Apply only the
    hunter's test files to base and run them with `testFiles`. A new test that
    fails without the change and passes with it tests the change; one that passes
    either way does not. Tier B, like all in-process results.
11. **Report** and tear down at or before the deadline the EA passed in. A
    host-side GC timer removes anything a crash left behind.

### 7.3 Determinism rules

- **Pinned:** env image digest, OCI platform (`linux/amd64`), runner version,
  gVisor release, base images and Semgrep rules, all versioned in
  `@verdikta/common`. The report records every input digest — primary CID, bCID,
  image digest, attestation hash, tool and rule versions — so a published report
  can be reproduced from its inputs.
- **Fixed environment:** `TZ=UTC`, `LANG=C.UTF-8`, `CI=true`,
  `PYTHONHASHSEED=0`, a fixed hostname, and CPU/memory limits taken from the
  spec (within the class maxima), never from the host.
- **Generous limits** (3× the base time measured on the same sandbox, plus the
  repeat-schedule reserve), because gVisor punishes wall-clock assertions: the
  EA's own `fetchDedupe` test failed its 600 ms bound under gVisor (1,031 ms).
- **Fixed policies, never time-dependent ones.** The repeat schedule, the
  integrity checks and the test-identity rules are the same on every host and at
  every point in the budget. Stripping durations from the report makes identical
  outcomes hash identically; it cannot make different outcomes identical, so the
  calibration set includes time- and randomness-dependent tests and the exit
  criterion is agreement on them across hosts.
- **Settle only on definitive failures:** a clean non-zero exit, a JUnit failure
  or error, a failed integrity check. A step that hits its wall-clock limit, the
  memory or process limit, or a dead sandbox makes the arbiter **abstain** — an
  error with no commit, the same rule that covers transient IPFS and AI failures
  today (and not a neutral outcome; see §10).
- **Identical LLM input:** the report the jury sees has no durations, host names,
  paths or per-run output directories, so every arbiter's jury reads the same
  bytes. The SHA-256 of the report's canonical JSON is logged and published in
  the justification.

### 7.4 Verification Report (abridged)

```json
{
  "schema": "verdikta.code-report/2",
  "inputs": { "primaryCid": "Qm…", "bcid": "Qm…", "envImage": "sha256:…", "platform": "linux/amd64",
              "attestationSha256": "…", "baseCommit": "9c1e4f…", "patchSha256": "…",
              "runner": "1.0.0", "gvisor": "20260928.0", "semgrepRules": "2026.10" },
  "gates": { "applies": "pass", "noDependencyChanges": "pass", "build": "pass",
             "acceptance": "fail", "noRegressions": "pass", "integrity": "pass" },
  "tests": {
    "tier": "B",
    "acceptance": { "total": 6, "passed": 5,
                    "failed": [ { "id": "acceptance/paging.test.ts > cursor wraps at end", "runs": ["fail","fail","fail"] } ] },
    "existing":   { "stable": 412, "regressed": [], "removed": [], "intermittent": [] },
    "added":      { "total": 9, "passWithChange": 9, "failWithoutChange": 7 },
    "integrity":  { "identityComplete": true, "summaryConsistent": true, "exitConsistent": true,
                    "protectedPathsUnchanged": true, "dependenciesUnchanged": true, "tamperFlags": [] }
  },
  "build": { "status": "pass", "tier": "A" },
  "checks": { "tier": "A", "acceptance": { "total": 4, "passed": 4 }, "api": { "total": 12, "passed": 12, "failed": [] } },
  "findings": [ { "tool": "semgrep", "rule": "js.sql-injection", "severity": "high", "file": "src/db.ts", "line": 88,
                  "message": "…", "triage": null } ],
  "flags": { "testsDeletedOrSkipped": [], "existingTestsModified": [], "protectedPathsTouched": [],
             "ciConfigChanged": false },
  "diff": { "files": 7, "added": 214, "removed": 31 }
}
```

`triage` is filled in later by the AI Node's Jev stage (§8.2) and is an
annotation only; the finding list the runner produced is what every juror sees.

### 7.5 Evidence trust tiers and integrity checks

gVisor separates the sandbox from the host. It does **not** separate the grader
from the program inside the sandbox: a test process imports the submitted code,
and that code sees the reporter's arguments and output path and runs as the same
user. A submission can write a passing JUnit file and `exit(0)` before an
acceptance assertion runs; resetting test files before the run does not stop
runtime modification of tests, reporters or installed dependencies. The report
therefore labels every fact with how it was observed, and the jury prompt and the
gates treat the tiers differently.

| Tier | Observed by | Facts | Treatment |
|---|---|---|---|
| **A** | The runner, from outside the tested process | Patch applies; diff facts and flags; dependency changes; build exit code; step exit codes and limit events; `acceptance.hurl` / `api.hurl` results from the runner's own client container; lint/SAST (tools run on the source, not by it); the attestation and image | Fact. Jurors may not contradict it. |
| **B** | A process that executed submitted code | JUnit results of the suite, acceptance tests and tests-only replay | Strong evidence, gated **only when every integrity check passes**; the diff can contradict it; a tamper finding overrides a passing result. |

Integrity checks on tier-B evidence (all deterministic, all run by the runner):

1. **Identity completeness** — the JUnit contains every expected identity
   (baseline `stable` set ∪ acceptance set) exactly once, with no skipped
   required records; extra records are allowed only for tests the patch added.
2. **Framework-summary consistency** — the framework's own stdout summary
   (counts of passed/failed/skipped) matches the JUnit.
3. **Exit-code consistency** — the test command exits 0 if and only if the JUnit
   reports no failures; an exit before the summary is a failure.
4. **Post-run checksums** — protected paths, acceptance files, the framework
   and reporter modules, and installed dependencies (`node_modules`,
   `site-packages`) hash the same after the run as in the image plus the
   accepted patch.
5. **Static tamper flags** — non-test code that references the report path or
   `$OUT`, calls `process.exit` / `os._exit` / `atexit` / signal handlers during
   import, patches the framework or reporter, or touches CI configuration.

Any failed check sets `gates.integrity = fail`: the acceptance and regression
gates that depended on in-process results fail with it, the report names the
check, and the submission settles `DONT_FUND` deterministically. A clean
submission is unaffected: none of these checks fires on ordinary code.

Creators are told, in the form and the template, that **black-box acceptance
checks are tier A** — Hurl against the running service, or CLI invocations whose
output the runner compares — and to prefer them where the bounty allows. For
in-process frameworks the residual risk is accepted and documented: a submission
that forges results *and* passes every integrity check *and* survives two
frontier reviews of its diff is the case the calibration set's adversarial
fixtures (§13) exist to measure.

### 7.6 What we borrow from verdikta-agents

The verdikta-agents coding sandbox (`packages/sandbox-kit`, on its `origin/main`)
already runs gVisor next to live arbiters. What carries over and what changes:

| verdikta-agents | For arbiter grading |
|---|---|
| gVisor as an extra Docker runtime, pinned by SHA-512, added with `systemctl reload docker`, never a restart | Same |
| Admission control: memory reserve that includes the largest local model, refusal during install/upgrade, no swap | Same |
| Capped scratch per sandbox, head/tail output capture, in-container timeout plus host backstop, plain "sandbox died" reasons | Same |
| No credential ever enters the sandbox; the trusted side streams code in and reads results out | Same; arbiters need no GitHub token at all |
| Host-side GC timer | Same, for sandboxes that live minutes rather than 14-day workspaces |
| Fixed-size loop-mounted ext4 image per workspace | The same technique, as the runner's whole Docker `data-root`: pulls and extraction are bounded by it |
| Open egress with a deny list | **No network** while grading |
| SSH forced-command gate running as root | A local service on a socket; no SSH, no root login |
| Root inside the container, default capabilities | Non-root and `--cap-drop ALL`, on top of gVisor |
| Bash written by a model | A fixed pipeline running only the creator's declared commands |

## 8. Grading

### 8.1 Deterministic gates (EA)

When an enabled gate fails, the EA builds a verdict with the full 1,000,000 on the
first outcome (`DONT_FUND`) and a justification naming the gate and its evidence —
for example the failing acceptance test and its assertion message. The verdict
takes the normal commit/reveal path; neither Jev nor a frontier model is called.

Gates: `applies`; `noDependencyChanges` (always on in v1, because nothing could
install the new dependencies; Phase 3 allows dependency changes through a
registry-only proxy); `build`; `acceptance` (every acceptance test passes on
every run of the fixed schedule, and `acceptance.hurl` passes); `noRegressions`
(no baseline-`stable` test fails on any run, vanishes or is skipped);
`integrity` (§7.5, always on). For `bug`: `applies`, `reproduces` and, if a fix
is included, `fixed`. A creator can switch `noRegressions` off, for instance for
a bounty that removes a feature; `applies`, `build` and `integrity` cannot be
switched off.

Must-pass criteria the creator writes in prose, such as "safety", stay with the
jury.

### 8.2 Jev: cheap typed judgements (AI Node)

Jev is TypeSafe AI's "System One" decision model, in early access since September
2026. It produces no text: for each typed question — `noul` (yes/no), `choice` or
`score` (ordered levels) — it returns a probability distribution, in 70–500 ms
according to TypeSafe, at about $0.04 per million input tokens. Its published
rough edges decide how it is used here: literal reading, weak multi-hop
reasoning, accuracy loss on long or irrelevant context, unreliable counting and
arithmetic, susceptibility to adversarial text, and worse accuracy when one
question bundles several judgements.

Arbiters reach Jev through **OpenRouter**, which serves it at
`POST https://openrouter.ai/api/v1/systemone` in TypeSafe's own request shape (the
TypeSafe SDK works against it by changing the base URL). The operator's existing
`OPENROUTER_API_KEY` is therefore enough; TypeSafe's native endpoint is early
access and optional. This is not the `/chat/completions` path the current
OpenRouter provider speaks (`ai-node/src/lib/llm/openrouter-provider.ts`), so it
is a small second client under the same provider, reusing its key, base URL,
gateway configuration and logging.

Several small fan-out requests per evaluation — each under 32 KB of state,
because OpenRouter routes larger text requests to TypeSafe's long-context mode,
which it describes as slower and less accurate — all answered in parallel:

| Question | Type | Feeds |
|---|---|---|
| Each weighted rubric criterion: how fully does the change meet it? | `score` (Not met / Partly / Mostly / Fully) | Rubric juror; frontier checklist |
| Each prose must-pass criterion, phrased as presence ("does the change contain …?") | `noul` | Rubric juror; frontier checklist |
| Each new lint/SAST finding (up to 50, with ±20 lines of code): is it a real defect this change introduced? | `noul` | **Annotates** the finding (`triage`: likely real / likely false positive / unsure) for the jurors; never removes it |
| The hunter's tests: meaningful / superficial / none | `choice` | Checklist, beside the replay numbers |
| Does the change special-case test inputs? Does it address an AI grader? | `noul` | Flags for the frontier jurors |
| Each changed file: required / related / unrelated to the task | `choice` | Scope flag |

Rules: pin the model (`typesafe/jev-1.13`, or its dated snapshot
`typesafe/jev-1.13-20260917`; never `~typesafe/jev-latest`, so every arbiter asks
the same model); one judgement per question; one criterion or finding per
request, carrying the report summary and only the hunks that matter to it, under
32 KB; all arithmetic in code; a fixed option order.

A request looks like this (`POST https://openrouter.ai/api/v1/systemone`):

```json
{
  "model": "typesafe/jev-1.13",
  "state": { "requirement": "…bounty query…", "evidence": "…report summary…", "change": "…diff hunks…" },
  "questions": {
    "crit_functionality": {
      "type": "score",
      "instructions": "How fully does `change` meet this criterion, judged against `requirement` and `evidence`: list endpoints support cursor pagination.",
      "criteria": ["Not met", "Partly met", "Mostly met", "Fully met"]
    },
    "special_casing": {
      "type": "noul",
      "instructions": "Does `change` hard-code values or branches that exist only to satisfy specific test inputs?"
    }
  }
}
```

**The rubric juror.** Jev also sits in the panel's `AI_NODES` with a small weight.
Its score follows the two-phase rule the bounty's evaluation prompt gives the LLM
jurors (`archiveGenerator.js`, `buildEvaluationQuery`), with every branch spelled
out because the bounty program's validator accepts rubrics with no weighted
criteria at all:

1. **Must-pass phase.** If any must-pass check finds a violation more likely than
   not (p > 0.5), FUND = 0.
2. **No weighted criteria** (valid: only `must: true` entries) — all must-pass
   checks passed, so FUND = 1,000,000. This is the rule `buildEvaluationQuery`
   states ("If ALL mandatory criteria PASS, score FUND = 100"); the naive weighted
   sum would give 0 here and, at 0.2 weight, cap two full-credit frontier jurors
   at 80% FUND.
3. **Weighted criteria** — normalise the weights to sum 1, then
   FUND = Σ wᵢ · E[levelᵢ] / 3 over the four levels, scaled to 1,000,000.
4. **Vector** — `[1,000,000 − FUND, FUND]`, rounded by largest remainder so the
   sum is exact.

TypeSafe says score levels are only weakly calibrated as magnitudes, so the
level-to-score mapping is tuned on the calibration set in Phase 2 (falling back
to thresholds if it must). Fixtures before Jev scores anything: all-mandatory
pass, all-mandatory fail, mixed rubric, and boundary probabilities (0.49/0.51).
Its justification is a deterministic table of its answers. Implementation: a
`systemone` client beside the OpenRouter provider (a native TypeSafe key is
optional, under the usual `AI_GATEWAY` rules) and one branch in `queryModel`
(`ai-node/src/app/api/rank-and-justify/route.ts`) that returns a decision vector
directly instead of parsing model text.

**If Jev fails** (timeout, 429, malformed answer), the frontier jurors proceed
with the checklist marked "unavailable — decide everything yourself", every
finding shown without triage, and Jev's weight **dropped, not redistributed**
(§8.5). Jev never decides a gate, never sees anything the frontier jurors don't,
and never removes anything from what they see.

**Claim check on the justification.** After the justifier writes the
justification, each sentence that asserts an execution fact ("all acceptance
tests pass", "no regressions", "the SQL-injection finding is a false positive")
is checked against the Verification Report with one `choice` question per claim
— `supports` / `contradicts` / `says_nothing`, TypeSafe's own citation-check
recipe. A claim the report contradicts is annotated in the uploaded
justification ("⚠ the report shows 1 acceptance failure") and, if the deadline
reserve allows, the justifier is re-run once with the contradiction pointed out.
Scores are never touched. Cost ≈ $0.002 per evaluation; the justification is the
only thing hunters and creators read, so a hallucinated "all tests pass" is the
most visible failure the system can have. This runs per arbiter on that arbiter's
own text, so it needs no cross-arbiter determinism.

**What Jev is deliberately not used for.** TypeSafe's cookbooks were reviewed
for further uses (re-ranking, RAG-passage filtering, confidence-gated routing,
cascades, guardrails, self-consistency). Two rules decide: Jev may not change
the bytes the frontier jurors see — TypeSafe's own re-ranking recipe notes that
repeated scoring can vary, and divergent inputs across arbiters would mean
divergent verdicts — and it may not add a decision the panel then depends on.
So: no Jev-ranked context pack (the pack is built by deterministic rules; a Jev
re-rank is re-visitable only after Phase 2 measures determinism and only if the
rule-built pack proves too large), no confidence-gated third juror (the panel
is fixed in the manifest for every arbiter), no cascade that skips a juror. The
guardrail recipe is already covered by the injection flag.

### 8.3 Frontier jury: deep review (AI Node)

The existing multi-model `rank-and-justify`, with a code-review pre-prompt. Input:

1. The bounty's evaluation query and rubric, unchanged.
2. The Verification Report with each fact's **trust tier** (§7.5): tier A is
   fact; tier B is strong evidence the diff can contradict; any integrity flag or
   tamper flag is shown first.
3. **Every** lint/SAST finding the runner kept (bounded at 50, severity-ordered),
   with Jev's `triage` as an annotation. Jev is one model at 0.2 weight; letting
   it remove findings would make it an evidence filter for the whole jury, and
   TypeSafe documents its susceptibility to adversarial state. High-severity
   findings are never suppressed by anything.
4. The Jev checklist. Low-confidence answers (confidence below 0.6, or a
   must-pass probability between 0.3 and 0.7; both tunable) are marked "decide
   this yourself".
5. The **context pack**, built by the runner, deterministic and budgeted (the
   class envelope sets it, §8.4; 80k tokens for standard), in priority order:
   the diff with function context
   (`git diff -W`), source before tests, lockfiles and generated files as stats
   only; the full post-change text of changed source files; call sites of changed
   top-level symbols (`git grep -w`, at most 10 each); a shallow file tree. Over
   budget, the lowest tiers are dropped and the pack says so.

The prompt asks each juror to:

- never contradict tier-A facts; weigh tier-B results against the diff, and
  treat a tamper finding as overriding a passing test result;
- look for defects the tests do not cover — edge cases, error handling,
  concurrency, security, API contracts — and count only defects tied to a
  file:line with a concrete input or line of reasoning;
- reconsider every tool finding, including those Jev marked unlikely;
- judge test adequacy and scope;
- score the rubric as today.

Web access is forced off in code mode; the PR URL would otherwise turn it on
under `AI_WEB_ACCESS=auto`.

Code mode takes its request deadline from the EA (§9) instead of the fixed
`REQUEST_TIMEOUT_MS` / `MODEL_TIMEOUT_MS`, cancels jurors at that deadline rather
than racing them, and runs frontier jurors at effort `high` (coding responds
strongly to effort).

In v1 the jurors see only the context pack. Phase 3 adds **juror exploration**
(§12, §14): a local `read_file` / `grep` tool served by the AI Node from the
runner's post-patch checkout, so a juror can pull in a caller or a config file
the pack dropped; and, for `code-premium`, an optional provider-hosted shell
where the juror runs its own probe tests. Whatever a juror finds this way is its
own observation — it goes into that juror's text and score, never into the
Verification Report, and it may differ between arbiters just as juror text does.

### 8.4 Three code-review classes: envelopes and templates

A ClassID is the pool of models an operator must serve; the **creator** picks the
panel — models, weights, iterations — from that pool in the manifest's `AI_NODES`.
The first draft proposed one broad class with price templates. That cannot work:
`ReputationKeeper.selectOracles` takes every active job in the class whose
registered `fee <= maxFee`, and the aggregator pays the **registered** fee. A
premium request with a 0.0007 ETH ceiling would select a job registered at the
standard fee and hand it the premium panel's bill; pricing every job for premium
would exclude it from cheaper requests. So each price tier is a **class**, each
with an **envelope** the arbiter enforces. The hunter pays (§8.8), so the tiers
are chosen to make small bounties cheap:

| | `code-micro` | `code-standard` | `code-premium` |
|---|---|---|---|
| Pool | `typesafe/jev-1.13`, `deepseek-v4-pro`, `kimi-k2.7-code`, `qwen3-coder`, `glm-5.3`, `mimo-v2.6-pro`, `gpt-oss-120b`, `claude-haiku-5-5`, `gpt-6-luna` | the micro pool plus `claude-sonnet-5-5`, `gpt-6-sol`, `gpt-5.6-terra`, `grok-4.7` | the standard pool plus `claude-opus-5-5`, `gpt-6-astra` |
| Panel | ≤ 3 models, `NO_COUNTS` 1, `ITERATIONS` 1 | same | same |
| Context pack / juror output | 40k / 6k tokens | 60k / 8k tokens | 120k / 12k tokens |
| Sandbox | class hard limits (§7.1) | same | same |
| Operator spend per evaluation | ≈ $0.06–0.09 | ≈ $0.25 | ≈ $1.40–2.00 |
| Registered fee (indicative) | 0.00004 ETH ≈ $0.10 | 0.00012 ETH ≈ $0.29 | 0.0007 ETH ≈ $1.70 (above today's ceiling, §8.8) |
| Hunter prepay (12×) | ≈ $1.16 | ≈ $3.50 | ≈ $20 |

The envelope is enforced on the arbiter, not only in the UI: today nothing in the
EA or AI Node reads the classmap's `max_panel_size`, `max_no_counts` or
`max_iterations`, so code mode adds that check — a manifest whose `AI_NODES`,
counts, iterations or requested budgets fall outside the class envelope is a
requester error (errored path, no commit) before any model is called. All three
classes carry the runner conformance requirement (§11); the pools add
`claude-opus-5-5`, `claude-sonnet-5-5` and the open-weight coders, which
classmap 1.6.0 does not list yet. The micro and standard pools lean on
open-weight code models served through OpenRouter; whether they grade as
accurately as the frontier pair is exactly what the calibration set measures per
class (§13), and a class whose accuracy falls short is withdrawn, not discounted.

Per-juror cost, OpenRouter list prices on 2026-10-19:

| Model in the pools | $/M in / out | 40k in / 6k out | 60k in / 8k out | Role |
|---|---|---|---|---|
| `gpt-6-astra` | 10 / 50 | — | $1.00 | Premium deep review |
| `claude-opus-5-5` | 4 / 20 | — | $0.40 | Premium deep review |
| `claude-sonnet-5-5`, `gpt-6-sol`, `gpt-5.6-terra` | 2 / 10–12 | $0.14 | ~$0.20 | Standard deep review |
| `grok-4.7` | 2 / 6 | $0.12 | $0.17 | Standard, third opinion |
| `kimi-k2.7-code` | 0.67 / 3.35 | $0.047 | $0.067 | Open-weight code review |
| `deepseek-v4-pro` | 0.42 / 0.84 | $0.022 | $0.032 | Open-weight code review |
| `mimo-v2.6-pro` | 0.43 / 0.87 | $0.022 | $0.033 | Open-weight code review |
| `qwen3-coder` | 0.30 / 1.00 | $0.018 | $0.026 | Open-weight code specialist |
| `glm-5.3` | 0.08 / 1.40 | $0.012 | $0.016 | Open-weight code review |
| `gpt-oss-120b` | 0.15 / 0.60 | $0.010 | $0.014 | Open-weight, third opinion |
| `claude-haiku-5-5`, `gpt-6-luna` | 0.1 / 0.5 | $0.007 | $0.010 | Justifier; cheap juror |
| `typesafe/jev-1.13` | 0.042 / free | <$0.01 | <$0.01 | Rubric juror, triage, claim check |

Templates in the bounty program's code-bounty form, each bound to its class:

| Template | Class | Panel | Operator spend per arbiter |
|---|---|---|---|
| Micro | `code-micro` | Jev 0.2, `deepseek-v4-pro` 0.4, `kimi-k2.7-code` 0.4 | ≈ $0.08 |
| Standard | `code-standard` | Jev 0.2, `claude-sonnet-5-5` 0.4, `deepseek-v4-pro` 0.4 | ≈ $0.25 |
| Premium | `code-premium` | Jev 0.2, `claude-opus-5-5` 0.4, `gpt-6-astra` 0.4 | ≈ $1.40 |

The template sets the class and the oracle fee the creator must offer (§8.8). A
mixed-fee selection test — a request on one class must never select a job
registered on another — is a Phase 0 deliverable.

### 8.5 Final scores and the partial-success rule

Scoring is unchanged: the weighted average over `AI_NODES`, then the justifier.
The EA prepends a deterministic "Execution evidence" block (gates, trust tiers,
test counts, report hash) to the justification it uploads, so hunters and
creators can see why.

**Partial success is stricter in code mode.** Today a request succeeds when at
least `MIN_SUCCESSFUL_MODELS_PERCENT` (0.5) of the models answer, with the
failed models' weight redistributed. On a three-model code panel that lets Jev
plus one frontier juror settle the verdict, with Jev's effective weight rising
from 20% to one-third. Code mode therefore requires **every non-Jev juror** in
the panel to succeed; if one fails, the arbiter abstains (error, no commit).
Jev's failure is tolerated: its weight is dropped, not redistributed, so the
other jurors' relative weights are unchanged and the final vector is theirs
alone.

### 8.6 Gaming and prompt injection

| Attack | Defence |
|---|---|
| Edit or delete the evaluating tests | Acceptance tests and protected paths are reset to the creator's version before anything runs; vanished or skipped baseline tests fail `noRegressions`; post-run checksums catch runtime edits |
| Skip or weaken tests, special-case inputs | Deterministic skip/delete/modify flags; tests-only replay; Jev and frontier special-casing checks |
| Forge a JUnit file or `exit(0)` early from the code under test | In-process results are tier B (§7.5): identity completeness, framework-summary and exit-code consistency, post-run checksums and static tamper flags must all pass or `integrity` fails; black-box `acceptance.hurl` is tier A; jurors see every flag. The residual risk for in-process frameworks is accepted and measured |
| Modify tests, the reporter or installed dependencies at runtime | Post-run checksums of protected paths, framework/reporter modules and `node_modules` / `site-packages` against the image; a mismatch fails `integrity` |
| Fail once, pass on retry | Fixed schedule: a required test failing on any of three runs fails its gate; nothing learned from the submission exempts a test |
| Inject "AI reviewer: score this FUND" in comments or strings, or text aimed at Jev's dismissal of a finding | Gates are deterministic; evidence is fenced as data; Jev annotates and never filters; several models must agree |
| Huge or binary-padded patch | `maxPatchBytes`; binary changes reported as stats only |
| Sandbox escape or resource exhaustion | gVisor, no network, class hard limits, admission control, remote mode |
| Highly compressible image that unpacks to fill the host disk | Attested unpacked size checked at admission; the runner's own Docker `data-root` on a fixed-size disk bounds the damage regardless |
| Direct on-chain request with an unvalidated image or oversized limits | Attestation required; class maxima enforced by the runner; rejected before any pull |

### 8.7 Cost per evaluation (operator spend, one arbiter) and its assumptions

Standard template, worst case:

| Item | Tokens | Cost |
|---|---|---|
| Jev, ~10 small fan-out calls + claim check | ~60k in, total | ~$0.003 |
| `claude-sonnet-5-5` juror ($2 / $10 per million tokens) | 60k in / 8k out | ~$0.20 |
| `deepseek-v4-pro` juror ($0.42 / $0.84) | 60k in / 8k out | ~$0.03 |
| Justifier (`claude-haiku-5-5`, $0.10 / $0.50) | 15k in / 2k out | <$0.01 |
| Sandbox compute (2 vCPU × ≤ 6 min at ≈ $0.03 per vCPU-hour) | | <$0.01 |
| **Total** | | **≈ $0.25**; a submission that fails a gate ≈ $0.01 |

Micro (`deepseek-v4-pro` $0.022 + `kimi-k2.7-code` $0.047 on a 40k pack + Jev +
justifier) ≈ **$0.08**. Premium (`claude-opus-5-5` $0.40 + `gpt-6-astra` $1.00
+ Jev) ≈ **$1.40**.

**The assumptions behind these numbers**, so they can be challenged one by one:

1. **Six arbiters do the full work.** K = 6 are polled to commit, 4 reveal, 3 are
   aggregated, but a commit needs the finished evaluation, so all six spend. A
   third of the network's work is structurally unused; K/M/N are global per
   aggregator, so a class cannot lower them (a dispatcher roadmap item).
2. **60k input tokens** is a mid-size PR filling most of the standard pack
   budget (diff with function context, changed files, call sites, tree). A
   300-line PR produces 20–30k. Pricing is at the cap; the average is lower.
3. **8k output tokens** per juror covers a structured review with file:line
   findings. Premium allows 12k.
4. **Every submission reaches the jury.** Gate failures cost ≈ $0.01 (sandbox
   only), so the average falls with the gate-failure rate; the pre-flight check
   (§6.4) pushes most sure-failures out before anyone pays.
5. **List prices on OpenRouter, 2026-10-19**, no caching (the two jurors are
   different providers; nothing repeats within an arbiter) and no batch pricing
   (batch latency does not fit a 15-minute round).
6. **Operators price at worst case plus ≈ 20%**, since the on-chain fee cannot
   depend on how the evaluation went.

The levers, in order of effect: the **class** (open-weight code models cost
5–15× less than the frontier pair), the **context pack** (40k instead of 60k cuts
input cost by a third), and the **gate-failure rate** (the credited pre-flight
means paid evaluations are the ones with a chance). For comparison, three `claude-opus-5-5`
jurors reading unfiltered 100k-token contexts would cost about $0.55 each.

### 8.8 Fee economics: who pays

Today the hunter funds the evaluation when they start a submission
(`BountyEscrow.startPreparedSubmission` is payable by the hunter; anyone may fund
once a creator window has expired). The prepay is
`maxOracleFee × (K + bonusMultiplier × clusterSize)`, 12× the per-oracle fee on
both aggregators (6 + 3 × 2), with the unused part refunded. With the bounty
program's default fee of 0.00002 ETH (`server/config.js`) and ETH at about $2,420
(Chainlink ETH/USD on Base, 2026-10-17) that is $0.048 per oracle and a $0.58
prepay — the roughly $0.50 a submission costs now. An arbiter therefore earns
about 5¢ per evaluation; the micro code panel costs it about 2× that, standard
about 5× and premium about 30×.

How the prepay is derived, so the figures can be checked: per-oracle fee =
worst-case operator spend (§8.7) × ≈ 1.2, rounded to a round number of wei;
prepay = fee × 12; dollars at $2,420/ETH. Worst case the whole prepay is spent
(six base fees plus the 3× bonus to each of the two clustered oracles); the
unused remainder is refunded.

| | Per-oracle fee | Hunter prepay (12×) | Under the ceiling? |
|---|---|---|---|
| Today's default (text bounties) | 0.00002 ETH ≈ $0.05 | 0.00024 ETH ≈ $0.58 | yes |
| `code-micro` (≈ $0.08) | 0.00004 ETH ≈ $0.10 | 0.00048 ETH ≈ $1.16 | yes |
| `code-standard` (≈ $0.25) | 0.00012 ETH ≈ $0.29 | 0.00144 ETH ≈ $3.50 | yes (ceiling 0.0004 ETH ≈ $0.97) |
| `code-premium` (≈ $1.40–2.00) | 0.0007 ETH ≈ $1.70 | 0.0084 ETH ≈ $20 | no — needs `setMaxOracleFee` (aggregator owner) |

The payment path pays each selected job its **registered** fee, so raising the
ceiling alone buys nothing: the `code-premium` class's jobs must themselves be
registered at the premium fee, and the ceiling must admit them. That is why the
tiers are classes (§8.4). Within a class, operators register at a fee that
covers their spend and arbiters priced above the bounty's `maxOracleFee` are
ineligible; the template sets `maxOracleFee` from the class.

**Who pays: the hunter, as today** (decision 7, §15). The earlier draft proposed
a creator-funded budget and, before that, a hunter deposit "returned when the
gates pass"; the deposit is not implementable (`BountyEscrow.finalizeSubmission`
sees only the score vector and a justification CID, and a gate failure and a
jury rejection both arrive as `[1,000,000, 0]`), and the creator-funded budget
would have meant escrow changes to funder and refund semantics. Keeping the
hunter as payer leaves `startPreparedSubmission`, `s.funder` and the refund path
untouched. The cost of that choice is carried by the cost plan instead:

- **Class choice by bounty size.** `code-micro` at ≈ $1.16 per submission is
  the default for bounties under a few hundred dollars; `code-standard` at
  ≈ $3.50 for mid-size work; `code-premium` for high-value audits once the
  ceiling is raised.
- **Almost nothing paid for sure failures.** The pre-flight check (§6.4) runs
  the whole deterministic pipeline before the prepay exists, for a creator-set
  fee defaulting to 0.0001 ETH (≈ $0.24) that is **credited against the prepay**
  when the hunter submits the same archive; the local CLI does the same for
  free. A hunter whose patch fails a gate loses ≈ $0.24 instead of the prepay.
- **Context pack sized to the change.** The pack budget is a cap; a small PR
  produces a small pack and the jurors' input cost falls with it.
- **Open-weight code models** in the micro and standard pools, through the
  OpenRouter gateway operators already run.
- **Protocol follow-ups** (dispatcher roadmap, not this design): per-class K/M/N
  so a micro class can poll fewer arbiters, and a lower bonus multiplier for
  cheap classes — together they would roughly halve the prepay again.

Operators' margin is thin by design in the micro class (≈ $0.10 fee against
≈ $0.08 worst-case spend); the calibration set decides whether the open-weight
pools grade well enough to run it at all (§8.4).

## 9. Time budget

| Stage | Budget |
|---|---|
| Fetch archives (EA) | 30 s |
| Image pull (first use per operator, cached afterwards) | 0–90 s |
| Apply → build → tests (incl. repeat schedule) → integrity → lint/SAST → API checks (replay in parallel) | ≤ 360 s (`limits.runSeconds`, enforced at creation and by the class maximum) |
| Jev | ~2 s |
| Frontier jury (parallel), then justifier | ≤ 240 s + 45 s |
| Commit transaction; reveal dispatch → reveal transaction | ~90 s |
| **Worst case** | **≈ 14 min, so `responseTimeoutSeconds` = 900 s** |

**One deadline, propagated.** Raising the outer timeouts is not enough: the AI
Node has its own 240 s whole-request timer (`REQUEST_TIMEOUT_MS`, covering
parsing, every juror and the justifier), the EA's AI client retries non-provider
errors, the AI Node's `Promise.race` returns a 408 without cancelling the work
underneath, and the example frontend stops polling after five minutes. A 240 s
juror followed by a 45 s justifier would be cut off today, and a retry of a
nearly finished evaluation would double the provider bill and miss the on-chain
deadline. Code mode therefore works from a single deadline:

- The EA sets `deadline = receipt + 780 s` (the 840 s bridge timeout minus a 60 s
  commit reserve) and passes the **remaining time** to the runner (`deadline` in
  `POST /v1/runs`) and to the AI Node (`deadlineMs` in the request).
- The runner refuses at admission if the run cannot finish before the deadline,
  and stops at it otherwise (abstain).
- The AI Node derives the code-mode request timeout and per-juror timeouts from
  `deadlineMs` instead of `REQUEST_TIMEOUT_MS` / `MODEL_TIMEOUT_MS`, reserves the
  justifier's 45 s, and **cancels** jurors with `AbortController` at the deadline
  instead of racing them. Iterations are capped by the class envelope so the
  advertised budget holds.
- The EA does not retry a code-mode AI call once less than the justifier reserve
  remains, and never re-runs the sandbox on a retry: the run is served from the
  shared-run cache by its key (§7.2).

Changes needed:

- `setResponseTimeout(900)` on both aggregators (an owner transaction). It only
  moves the point at which a stuck request may be force-finalized; ordinary
  requests are unaffected.
- `maxTaskDuration` and the bridge timeout in `chainlink-node/basicJobSpec` go to
  840 s. `upgrade-arbiter.sh` applies this when it regenerates job specs.
- The EA's `SERVER_TIMEOUT` rises to match; the deadline propagation above.
- The bounty program's pending state and the example frontend's polling
  (`RunQuery.js`, 60 × 5 s today) extend to 15 minutes.

Typical evaluations are expected to take 3–6 minutes. Before the network timeout
changes, a cold-image end-to-end canary on class 5555 must pass with a
near-limit juror followed by justification, a provider timeout with retry, a slow
justifier, a registry failure and a cancellation.

## 10. Failure semantics

| Situation | Result |
|---|---|
| Runner not installed or unhealthy, admission refused, deadline cannot be met | Error, no commit (transient) |
| Registry or image-pull failure | Error, no commit |
| Step timeout, OOM, process limit, sandbox died | Error, no commit (the arbiter abstains) |
| Patch doesn't apply, dependency change, build fails, a required test fails on any scheduled run, regression, **integrity check fails** | Deterministic `DONT_FUND`, committed |
| `submission.patch` missing or not a patch | Malformed-bCID settlement (existing rule) |
| `code_review.json` invalid; **attestation missing or invalid; spec above the class maxima; manifest outside the class envelope** | Error: the requester's package is broken (existing rule); no commit, before any pull or model call |
| Jev fails | Jurors proceed unaided; Jev's weight dropped, not redistributed (§8.5) |
| A non-Jev juror fails | Error, no commit — code mode requires every non-Jev juror (§8.5) |

**Abstaining is not neutral.** A round that times out applies the configured
timeliness penalty (−20 on mainnet) to every polled oracle that did not commit
(`_applyTimeoutPenalties`), and an oracle that commits but is not among the first
4 of 6 is also penalised −20. No fee is earned either way. Transient failures are
therefore an operator cost, which is why admission refuses early — before a pull,
before a model call — rather than failing late, and why the envelope keeps the
work inside the budget on ordinary hosts.

## 11. Operator impact

- An optional installer phase, "Code-review sandbox", installs gVisor (pinned,
  added with `systemctl reload docker`) and the runner service, warms the base
  images, and runs the **conformance self-test**: a fixed canary bounty and patch
  whose expected report hash is published in `@verdikta/common`. Registering for
  either code ClassID requires a pass. `arbiter-doctor.sh` gains
  `svc.code_runner`, `sandbox.runsc`, `sandbox.disk` and `sandbox.conformance`.
- Resources: +2 vCPU, +4 GB RAM and a 40 GB fixed-size disk image for the
  runner's own Docker `data-root` (image cache plus scratch), or a remote runner
  VPS.
- Keys: none new. Jev is reached through the operator's existing
  `OPENROUTER_API_KEY`; a native `TYPESAFE_API_KEY` is optional under the usual
  `AI_GATEWAY` rules.
- `start-arbiter.sh`, `stop-arbiter.sh`, `arbiter-status.sh` and `rotate-logs.sh`
  include the runner.

## 12. Rollout

| Phase | Delivers | Exit criteria |
|---|---|---|
| 0. Decisions | Timeout change approved and hunter-pays confirmed (§15); the three ClassIDs, envelopes and hard limits chosen; trusted-builder key custody (deferred: a single Verdikta key is the placeholder); OpenRouter `systemone` access verified from a canary; `code_review.json`, `attestation.json` and report schemas in `@verdikta/common` | Schemas merged **and** the adversarial fixtures of §13 written as failing tests: forged, missing or duplicate test reports, runtime test/reporter tampering, an unattested image and an over-limit direct request cannot yield trusted passing evidence or exceed operator limits; a mixed-fee selection test shows a request on one class cannot select a job registered on another |
| 1. Execution evidence | `code-runner` (local mode, own `dockerd` and disk); `node22` and `python312` images; builder Action with validation and attestation; PR-to-patch submissions with the PR bot comment and label; **pre-flight check (tiers 0–1), payable `prepareSubmission` with the credited fee, and the local CLI** (§6.4); gates and integrity checks; deadline propagation; report and context pack fed to the existing jury; `code-standard` and `code-micro` on class 5555 canaries on testnet; **`bug` kind with the `foundry` image, the `stake` block, and the `StakeAttestation` contract and record page on testnet (§16)** | Identical report hash on every canary **across hosts**, including the time- and randomness-dependent fixtures; ≥ 90% agreement on the calibration set's clear cases and no false FUND on its adversarial cases, **measured per class** (a class that falls short is withdrawn); a cold-cache end-to-end run with slow jurors, justifier delay, registry failure and cancellation; prepay and refund cases pass; the attestation fixtures of §13 pass (bond, dispute, embargo, lineage); p95 inside the budget; the release runbook's version-checked canary gate kept before mainnet |
| 2. Cheap and sharp | `systemone` client, Jev annotation and rubric juror, claim check on the justification; Jev readiness in the pre-flight (tier 1b), rubric check at creation and submission pre-check in the bounty program (§6.4); Semgrep and secret scan; Hurl acceptance and API checks; tests-only replay; cost logging | ≤ $0.30 per arbiter per evaluation on `code-standard` and ≤ $0.10 on `code-micro`; accuracy no worse than Phase 1; finding-recall against the Phase 1 unfiltered baseline unchanged, including injected dismissals; Jev run-to-run determinism measured; claim check catches every seeded contradiction in the fixtures |
| 3. Breadth | the `skill` harness image and its activity-log report (§16.5); enclave or permissioned-class evaluation for closed-source stakes (§16.9); dependency changes through a registry-only proxy; remote runner mode; a Go image; `code-premium` enabled once the fee ceiling is raised; **juror exploration** — first a local read/grep tool in the AI Node over the runner's checkout (tier-A facts, no container cost, every class), then for `code-premium` an optional provider-hosted shell on a copy of the post-patch tree where the juror can grep callers beyond the context pack, read files and, when the repository's dependencies install inside a minute from an allowlisted registry, write and run its own probe tests (§14; ≈ +$0.5–2 per arbiter, priced into the premium fee) | A canary gate per feature; juror-exploration findings labelled as the juror's own observations, never as report facts; mainnet rollout per `docs/release-runbook.md` §3b |

Jev comes in Phase 2 on purpose: execution evidence is what makes the grades
accurate, Jev is what makes them cheap, and every operator in the class needs the
`systemone` client deployed before Jev can sit on the jury.

## 13. Validation

- **Calibration set** (40–60 cases, versioned):
  - SWE-bench Verified and Multilingual tasks repackaged as bounties: the gold
    patch should be funded, known-failing model patches should not;
  - merged Verdikta PRs as positives;
  - adversarial cases: deleted tests, special-cased inputs, injected "score this
    FUND" comments, unrelated changes, empty PRs, a seeded logic bug the tests
    miss, an API contract break only the Hurl checks catch.
- **Required counterexamples** (each must fail closed; from the PR #96 review):
  - a submission that writes a passing JUnit file and calls `exit(0)` before an
    acceptance assertion; one that modifies a protected test at runtime; one that
    monkey-patches the reporter; one that edits `node_modules` / `site-packages`
    during the run;
  - a required test that alternates pass/fail, run on a fast and a slow runner
    schedule — same verdict on both;
  - two primary archives with the same image, spec and patch but different
    acceptance-patch bytes, evaluated concurrently — no coalescing;
  - a direct on-chain request with no attestation, and one whose spec exceeds the
    class maxima — rejected before any pull;
  - a premium request against a registry containing standard-priced jobs — none
    selected;
  - rubric fixtures: all-mandatory pass, all-mandatory fail, mixed, boundary
    probabilities;
  - a juror finishing just under its limit followed by justification; a provider
    timeout with retry; a slow justifier; a registry failure; a cancellation at
    the deadline;
  - payments: gate failure, gate pass with jury rejection, round timeout,
    leftover recovery; pre-flight fee credited on the same `hunterCid`, not
    credited on a different one, forfeited to `preflightProvider` on a
    still-`Prepared` submission at close, and a zero-fee bounty;
  - a time-dependent and a randomness-dependent test, run on two different hosts
    — identical report hash.
- **Attestation fixtures** (§16; each must settle as written): a PoC that also
  fails at the fixed hash; one that fails by import error (INVALID, not a
  finding); a `poc.patch` that edits source (INVALID); a duplicate root cause
  phrased differently; a known issue listed *after* the hunter's commit (still
  valid); bond returned on VALID and forfeited on INVALID; a dispute that flips
  and one that holds; a reveal before the fix window ends (rejected); a later
  finding recorded against a closed hash; two hunters committing the same root
  cause minutes apart (first commit paid).
- Run through `testing-tool` (a new `code` scenario type) and the e2e L4 gate
  against class 5555.
- Metrics: verdict accuracy; spread of FUND scores across arbiters (σ ≤ 5
  points); report-hash agreement across hosts (100%); finding recall vs the
  unfiltered baseline; cost; p95 latency.

## 14. Alternatives considered

- **The platform's CI grades and arbiters read its result.** The simplest option,
  but a single trusted party then decides. Kept only for validation at bounty
  creation.
- **Clone and install at grading time.** 19–25 minutes under gVisor, needs the
  network, and registry drift breaks agreement between arbiters.
- **Agentic reviewers with a shell in the sandbox.** Strongest on very large PRs,
  but slow, expensive and different on every arbiter. Returns in a bounded form as
  the Phase 3 juror-exploration item (§12): first a local read/grep tool over the
  runner's checkout, then, for `code-premium`, a provider-hosted shell.
- **Provider-hosted execution tools as the runner** (Anthropic code execution and
  Managed Agents, OpenAI hosted shell / code interpreter; assessed 2026-10-21).
  All three are a shell the *model* drives inside a provider-managed container,
  billed as container time plus every token the model spends issuing commands
  and reading output. Container time is cheap and comparable to native compute
  — Anthropic: 1,550 free hours a month then $0.05/h, or $0.08 per session-hour
  on Managed Agents; OpenAI: $0.03 (1 GB) to $0.48 (16 GB) per 20-minute session
  — so a scripted single-turn run costs ≈ $0.01–0.22 against ≈ $0.01–0.03
  native, and an agentic run (10–20 turns, context re-sent each turn) ≈ $0.3–2.5.
  The cost gap is the mandatory model tokens, and native is the only path where
  a gate failure costs nothing. Three structural problems rule them out as the
  source of gate facts:
  1. **No attested image.** Anthropic's code-execution container is Python 3.11
     with no network and no Node, so it cannot build a Node project at all;
     OpenAI's shell and Managed Agents can `npm ci` from an allowlisted registry,
     which is the install-at-grading-time path rejected above, on a toolchain
     the providers say may change and do not version. The one exception is
     Managed Agents, whose Ubuntu 24.04 sandbox lists `docker` ("limited
     availability") and allows `ghcr.io`, so a session could in principle
     `docker run` the attested image.
  2. **A model in the chain of custody.** Even with a fixed script, the model
     runs it and relays the result; the submission's stdout enters the model's
     context and can carry instructions aimed at it, and nothing inside the
     sandbox can sign the report because the model and the tested code can read
     any secret placed there. For gates that move funds this is weaker than a
     runner no model touches.
  3. **Determinism and time limits.** Two arbiters' models may run different
     commands or truncate differently; Anthropic caps each invocation (90 s per
     Python cell under programmatic tool calling), so a 3–6 minute suite must be
     split and shepherded.
  What they do offer is isolation at the provider rather than on the
  key-holding host — the benefit of `remote` mode without a second VPS. So: kept
  out of the gate path; adopted for **juror exploration** in `code-premium`
  (Phase 3, §12), where a juror's commands are allowed to differ per arbiter
  because juror text already varies and is clustered; a Managed-Agents
  **hosted-runner mode** for operators without a sandbox host is revisited when
  docker in cloud sandboxes leaves "limited availability", with the
  model-in-custody caveat written down; and a pure-Python micro path on
  Anthropic's container is possible but not worth a second execution path to
  keep in conformance. Not usable for the pre-flight (it must predict the gates
  on the attested image) or the environment builder (needs `docker build`).
- **Firecracker or Kata microVMs.** A stronger boundary, but the current hosts
  have no KVM.
- **Hosted sandboxes (E2B, Modal, Daytona).** A vendor account and bill for every
  operator; verdikta-agents rejected them for the same reasons.
- **Jev as the only judge.** The cheapest, but weak at multi-hop reasoning and
  open to injected text by TypeSafe's own notes. Kept as a low-weight juror and
  a triage layer.

## 15. Decisions (2026-10-19) and remaining risks

Each item records the options weighed, the decision, and what it changed in the
document.

1. **`responseTimeoutSeconds` 300 → 900 s on both aggregators — decided: raise
   globally.** The timeout is global per aggregator, so a stuck text round also
   waits 15 minutes before it can be force-finalised, and `BountyEscrow`'s
   `MAX_ACTIVE_EVALUATIONS` slots stay occupied that long. Normal rounds finish
   when reveals arrive and are unaffected. A separate aggregator for code
   classes, or a per-class timeout in the contract, would isolate the change but
   is a deployment or protocol change too large for v1. Per-class timeouts go on
   the dispatcher roadmap. Condition: the bounty program and example frontend
   depend on the window only through UI polling (§9).
2. **Jev — decided: pinned `typesafe/jev-1.13-20260917` via OpenRouter.**
   Alternatives were Clef (open weights, same request format, a different model
   with its own answers; self-hosting needs a GPU) and dropping Jev from v1
   (saves little money — Jev is under 1% of spend — and loses the annotation).
   Determinism, which TypeSafe does not document and its own re-ranking recipe
   says can vary, becomes a Phase 2 canary exit criterion; if it fails, Jev is
   demoted to annotator with no jury weight rather than removed. A review of
   TypeSafe's cookbooks added one arbiter-side use (the claim check on the
   justification, §8.2) and two bounty-program uses (rubric check at creation,
   submission pre-check, §6.4), and rejected re-ranking, confidence-gated
   routing and cascades because they would change what the jurors see (§8.2).
3. **Builder fallback workflow and registry — decided: Verdikta owns both for
   v1,** with the Action published so creators with CI self-build. GHCR public
   storage and public-repo Actions minutes are free; the fallback runs creators'
   `setup` on ephemeral hosted runners with no secrets in the build job and
   signing in a separate job, and builds are gated behind bounty creation so
   nobody burns minutes for free. Retention: an image lives until every
   submission to its bounty is finalised plus 30 days.
4. **Paid and unpaid PRs on Verdikta's repositories — decided: a mechanism, not
   a rule (§6.3).** Verdikta's own repositories will carry bounties, so "PRs are
   not bounties" cannot stay a blanket statement. A bounty is announced by a
   `bounty`-labelled issue with the site link; a PR is paid only if the site
   records it as a submission, which the bot marks on the PR with a comment and
   the `bounty-submission` label; `CONTRIBUTING.md` / `AGENTS.md` say so.
5. **Creator trust — decided: accept, with hunter-diligence text (§6.4).** The
   creator defines environment, tests and gates — the trust the rubric already
   carries, now pinned and attested so nothing changes after funding. A
   mandatory reference solution would prove solvability but makes the creator
   solve the task first; it may return later as an optional "verified solvable"
   badge. Hunters are told to read the acceptance tests and run the CLI before
   paying.
6. **Public acceptance tests — decided: accept.** Hidden tests encrypted to the
   arbiters would need key distribution and a protocol change. Creators who
   want hidden tests can run them off-chain inside the existing creator window
   and approve or decline there; arbiter evaluation stays the fallback. The
   special-casing flag, the tests-only replay and the diff review carry the
   overfitting risk.
7. **Who pays — decided: the hunter, as today; bring the cost down (§8.4,
   §8.7–8.8).** A creator-funded budget would have aligned payer and
   beneficiary but needed `BountyEscrow` changes to funder and refund
   semantics; the gate-pass deposit was not contract-observable. Instead: a
   `code-micro` class on open-weight code models (≈ $1.16 per submission), a
   cheaper `code-standard` with one frontier juror (≈ $3.50), a pre-flight check
   and a local CLI before the prepay exists, a context pack sized to the
   change, and the assumptions behind every figure written down in §8.7.
   **Pre-flight fee (2026-10-20):** tier 0 free; tier 1 (the sandbox gate
   forecast plus Jev readiness) for a creator-set fee defaulting to 0.0001 ETH,
   credited against the prepay for the same archive and forfeited to the
   runner-pool provider otherwise — abuse control and compute recovery, not
   revenue. Collected by making `prepareSubmission` payable and netting the
   credit in `startPreparedSubmission` (§6.4); a cheap-LLM preview grade was
   considered and left out.
   `code-premium` (≈ $20) waits for the fee ceiling to be raised to about
   0.001 ETH (Phase 3). Per-class K/M/N and a lower bonus multiplier for cheap
   classes go on the dispatcher roadmap; together they would roughly halve the
   prepay again.
8. **Trusted-builder keys — deferred.** Placeholder for planning: a single
   Verdikta-held Ed25519 key with its id in `@verdikta/common`, rotated by adding
   a key and keeping the old one valid for bounties it attested. Sigstore keyless
   signing and a multi-builder list are the alternatives to weigh when the
   decision is taken; it must land before Phase 1's canaries, because the
   runner refuses unattested bounties.
9. **In-process test evidence — decided: allow tier B with the integrity
   checks, and label the bounty.** Black-box observation protects against
   forged results, not against hard-coding to public expected outputs — the
   diff review carries that in both models — so making it mandatory would cost
   library-style bounties for a narrower gain than it looks. The form shows
   "evidence: in-process" or "evidence: black-box" and warns the creator; the
   adversarial fixtures measure the residue; `code-premium` will require tier A
   if Phase 1 data says the residue matters.
10. **First application (2026-10-30) — decided: stake-backed security
    attestation (§16).** Two research rounds (2026-10-27/28) found the
    code-bounty boards emptied by agent supply and the maintainer's own agent
    cheaper than a bounty below ≈ $50–$150; the durable demand is for a verdict
    the requester cannot credibly produce — adversarial independence. The `bug`
    kind becomes the lead, with an escrow-by-severity contract, a live stake
    record bound to the artifact hash, commit → fix window → reveal
    disclosure, a hunter bond returned on VALID, a maker dispute window,
    "scanned" labelling below a floor, and a seeded registry for skills and MCP
    servers. `change` bounties keep the same pipeline and remain supported, with
    `code-micro` still their default. Rejected: a historical "certified after a
    quiet week" badge (attests almost nothing and is contradicted permanently
    when wrong); "certification" wording; closed-source private rounds in v1.

**Remaining risks** (no decision pending, tracked through the exit criteria):
open-weight pools may grade worse than the frontier pair — measured per class,
a short class is withdrawn (§8.4, §12); Jev determinism (§15.2); the residual
forgery risk on tier-B evidence (§7.5); registry availability (IPFS fallback,
§6.2); gVisor's wall-clock distortions on repositories with timing-sensitive
tests (§7.3).

## 16. First application: stake-backed security attestation (2026-10-30)

The design above was written for code bounties: a creator pays for a change,
hunters submit patches, arbiters grade them. Two research rounds (2026-10-27
and 2026-10-28: *Code bounty market and fee fit* and *Code bounty trends with
AI agents*, kept with their notes and raw evidence in the private
`verdikta-knowledge` repository, `initiatives/stake-attestation/research/`)
found that market closing while the design was under review, and the assessment of 2026-10-29/30 chose a different first
application for the same machinery. This section records that choice and what
it changes. §5–§10 stand: the sandbox, the gates, the context pack, the jury
and the fee plan are unchanged. What changes is who posts the request, what a
submission is, and what the verdict is for.

### 16.1 The market finding

- **Agents emptied the bounty boards; they did not lower the price.** Nominal
  awards held (Algora's median bounty went $50 → $100 on PRs twice the size;
  Superteam's development median has been $1,000 every year) while supply
  exploded (8–158 agent PRs per bounty) and the posters left: Algora's genuine
  closures went 1,019 → 1,543 → 243 over 2024/25/26 and the company became a
  recruiter; Polar removed issue funding; IssueHunt and Gitcoin are gone as
  public boards. Maintainers prompt their own agents (GitHub telemetry puts
  agent-started PRs above 40% of the total) and close the gate to outside code
  (tldraw, codex, Ladybird). In-house cost per merged change is about expected
  attempts × (tokens + review) ≈ $15–$120, review dominating; a bounty beats
  it only above ≈ $50–$150, and only where the maintainer's own agent cannot
  act.
- **Machine judging is the precondition for transacting agent work, not the
  demand.** Every venue that pays agents is flooded; the ones that survive judge
  by machine — hidden-test competitions, Sherlock's Audit Engine, Immunefi's
  triage agent, submission fees. That fixes the cost side. It does not supply a
  buyer.
- **The durable demand is for a verdict the requester cannot credibly produce
  themselves.** A protocol can audit its own code; it cannot credibly tell its
  users it did. Vendor security payouts kept rising through 2026 (HackerOne
  $81M → $89M, Google $11.8M → $17.1M) while open-source feature bounties
  collapsed, because self-audit carries no credibility and an attacker cannot be
  hired in-house. Flare's FAssets is the illustration: a dedicated review found
  no highs; a competition one month later with 151 researchers found nine
  high-severity fund-loss bugs.

Hence the first application: **a maker stakes money against an exact artifact,
hunters try to claim it with executed proofs of concept, arbiters judge the
claims, and the public record of that stake and its history is the product.**
It is the one use case whose demand grows as agents improve, and it is the
`bug` kind of §6.5 with an escrow and a record around it.

### 16.2 What the record is, and is not

A **stake record** is a live on-chain state bound to an artifact hash:

```
artifact   hash (repo@commit, contract source@address, or skill package), kind,
           declared value at risk (optional)
stake      award table by severity class (wei), bond, opened-at, funded-until
history    submissions judged (count), verdicts by outcome, valid findings
           (class, paid, disclosed-at), disputes and their outcomes,
           days since the last valid finding
lineage    predecessor hash (what this version fixed), successor hash (what fixed it)
later      findings recorded against this hash after the stake closed
```

It is a **warranty anyone can price**, not a certificate. "There are 4 ETH
escrowed against this hash, 94 days unclaimed, 37 submissions judged, 0 valid"
is a claim an attacker can test and a reader can check; "certified after a quiet
week" is neither. Three consequences:

1. **The badge is the live state.** Funds stay escrowed and the stake stays open
   on that hash while the badge is shown; closing the stake ends the badge and
   leaves the history. A single quiet week attests only that nobody who looked
   valued a finding below the award, and a historical badge contradicted later
   by an exploit is just as permanent as the exploit.
2. **The record states facts, never a security claim.** What was staked, for
   how long, what was judged, what was found, what was fixed, what was found
   later. The words "certified" and "certification" appear nowhere in the
   contract, the site or the badge: they imply a warranty from Verdikta and
   invite liability. The record is an *attestation of stake and judgement*.
3. **The reader interprets the amount.** The record shows the stake, the bond
   and, when declared, the stake as a share of value at risk. Tiers are not
   named gold or silver. The site labels a record **scanned** (below the
   program floor, §16.3), **staked**, **under-staked** (declared value at risk
   with the stake below a program-set share of it) or **invited** (allow-listed
   hunters only, §16.9).

### 16.3 What a stake proves

An unclaimed stake means one of five things: no finding exists at the staked
class; nobody competent looked; someone found one worth more than the award and
is holding it; the jury wrongly rejected a real finding; or the rules made a
real finding unclaimable. Which reading applies depends on the award against
two quantities: the cost of looking and the value of holding.

**The cost of looking is near zero for small artifacts.** Six hackbots filed
over 1,100 HackerOne reports in a year at about 50% validity; agentic tooling
turned curl's inbox from under 5% valid in 2025 into a record CVE rate in 2026,
every one of them low or medium. Two consequences. Any listing a feed announces
will be scanned, so small stakes do get attention — of the kind the maker could
buy for a dollar of inference. And "find any bug" will be claimed on any
nontrivial codebase, so the record is defined by **severity**: the maker stakes
an award table by class and names the lowest class that counts, and the badge
reads "no finding at or above *class* while staked". That converges on a
standard bounty table with escrow and neutral judgement — a product the market
already understands.

**The value of holding is the hold problem.** A $1,000 stake on a contract
securing $10M tells every hunter that any real finding is worth more unheld.
The maker may declare value at risk; the record shows the ratio and labels
under-staked records. Stakes whose top award is below `badgeFloorWei` (a
program constant, ≈ $100 at launch) carry no badge wording beyond "scanned".

| Top award | Who looks | What an unclaimed period attests | Record label |
|---|---|---|---|
| ≈ $10–$50 | Scanners, if a feed exists | Nothing a scanner reaches; the maker could run that | **scanned** |
| ≈ $100–$500 | Scanners plus agent passes over small artifacts (skills, MCP servers, small contracts) | No medium-or-worse issue an agent pass finds at that budget; a Medium averages $973 at Anthropic's HackerOne program | **staked** |
| ≈ $1k–$10k | Serious agent audits, some humans | No High found while staked; a High averages $3,334 in market programs | **staked**; dispute window applies |
| ≥ $50k | Human specialists | The only level credible for value-bearing code | **staked**; a guaranteed floor draws the effort |

Aerodrome is the precedent for the top row and for the whole shape: after two
private audits found nothing, a three-week $400k tiered pool on Sherlock's Audit
Engine ($100k guaranteed, $200k if a High surfaced, $400k if a Critical did),
and the clean result was the marketing. Hats Finance has sold the
pay-for-results form for years (budget by severity, retained when nothing is
found, only the first unique submission paid, 10–20% of payouts as its fee)
without displacing fixed-fee audits — a caution that the pricing pitch alone
does not sell, and the reason the live record and the autonomous-hunter supply
(§16.8) carry the proposition here.

### 16.4 A round

```
LIST      maker: artifact (repo@commit with an attested image, §6.2), scope paths, award table by
          class, lowest class counted, bond, fix window, dispute window, known issues (hashes),
          optional value at risk
BASELINE  site: pre-flight tier 1 (§6.4) + Semgrep/secret scan + one cheap agent pass; findings go
          to the maker privately; the maker fixes (new hash) or lists them as known issues; paid by
          the listing fee
OPEN      maker escrows the award table; the record goes live; the feed announces the hash
COMMIT    hunter: bond + class prepay + sha256(archive) on-chain (the timestamp); the archive,
          encrypted to the maker's key, goes through the site. Nothing is public yet
FIX       maker has fixWindowDays (default 14; 30 for contracts) to ship a fix as a successor hash;
          the hunter may not reveal before the window ends or the maker signals FIXED
REVEAL    hunter pins the archive (bCID); the evaluation runs against the committed hash:
          gates (§16.6), then jury; outcome in {INVALID, LOW, MEDIUM, HIGH, CRITICAL}
DISPUTE   disputeWindowHours (default 72): the maker may escalate a VALID by paying the escalation
          prepay; a larger panel re-evaluates and its outcome is final
SETTLE    VALID: awards[outcome] to the hunter, bond returned, finding published on IPFS, record
          updated. INVALID: bond to the maker; the record counts the submission; nothing published
CONTINUE  the stake rolls to the successor hash once the maker attests the fixed version; the
          record carries the lineage. CLOSE withdraws the escrow and ends the badge; history stays
```

Commit → private disclosure → reveal is ordinary coordinated disclosure with an
on-chain timestamp. The hunter's commit proves the finding predates the fix, so
"known issue" counts only if it was listed before the commit, and a maker who
never fixes is judged anyway when the window ends, with the valid unfixed
finding on their record. Arbiters first see the proof of concept at reveal, so
the evaluation of §7 runs unchanged and §15.6's rejection of key distribution
to arbiters stands.

### 16.5 Spec, submission and outcomes

`code_review.json` keeps `kind: "bug"` and gains a `stake` block, schema in
`@verdikta/common`:

```json
"stake": {
  "awards": { "LOW": "0", "MEDIUM": "0.1 ETH", "HIGH": "0.4 ETH", "CRITICAL": "2 ETH" },
  "lowestClassCounted": "MEDIUM",
  "bondWei": "…",
  "fixWindowDays": 14,
  "disputeWindowHours": 72,
  "scope": { "include": ["contracts/**"], "exclude": ["test/**", "script/**"] },
  "knownIssues": ["sha256:…"],
  "severityRubric": "immunefi-v2.3",
  "valueAtRiskUsd": 1250000
}
```

The **submission archive** (bCID) carries `finding.json` (claimed class, a
one-paragraph root-cause statement, affected paths, the PoC command and the
observable it asserts), `report.md`, and `poc.patch` — a patch that adds a
proof-of-concept test and touches nothing outside the bounty's test paths. A fix
is optional and, when present, is a second patch, `fix.patch`.

**Outcomes** are `[INVALID, LOW, MEDIUM, HIGH, CRITICAL]`. The jury's vector
sums to 1,000,000 as today; settlement reads the outcome with the largest mass,
pays `awards[outcome]` when the outcome is at or above `lowestClassCounted` and
the mass clears the program threshold, and records the vector either way. A
gate failure and a jury rejection both arrive as INVALID, which is exactly when
the bond is forfeited, so **the bond is contract-observable here** — unlike the
gate-pass deposit §8.8 rejected for `BountyEscrow`, where a gate failure and a
rejection were indistinguishable and the deposit's return condition was not.

**Artifact kinds.** `repo` — any repository at a commit on the `node22`,
`python312` or `foundry` image; `contract` — a `repo` plus a deployment address
and a verified-source check at listing; `skill` — a skills or MCP package (a
`SKILL.md` or server manifest with its scripts), graded on a harness image that
runs the package's entry points in the sandbox and records attempted network,
file and process activity as tier-A facts, against which the PoC asserts.
`repo` and `contract` are Phase 1; `skill` follows once the harness exists
(§16.10).

### 16.6 Gates and jury

Gates (deterministic, in the EA, settle as INVALID with no model call):

- `poc.patch` applies and touches only the bounty's test paths — a patch that
  edits source is a fix, and belongs in `fix.patch`;
- the PoC test **fails at the committed hash as an assertion failure**, not an
  import, compile or collection error, on every run of the fixed schedule
  (§7.3);
- with `fix.patch` applied, the PoC passes and no baseline-passing test
  regresses;
- the integrity checks of §7.5 (forged or missing reports, runtime tampering);
- the PoC command and the observable claimed in `finding.json` match what the
  runner recorded.

The jury (code mode, §8.3, with the Verification Report, the diff of
`poc.patch`, the in-scope source and the known-issues list in the context pack)
answers four questions: is the asserted behaviour really required by the spec,
documentation or scope; which class under the bounty's severity rubric; is it a
known issue or a duplicate of a finding already valid on this hash; is the PoC
minimal and honest (no environment manipulation, no out-of-scope assumption).
Jev (§8.2) asks each as a typed question first — `choice` on the class, `noul`
on "known issue", `noul` on "required behaviour" — and sits on the jury at low
weight; the frontier jurors decide. Severity is the subjective part and, in
practice, the only thing a dispute is about; the award table makes the stakes of
that judgement explicit.

Classes: `code-standard` (≈ $3.50 prepay) is the evaluation class for stakes up
to about $1k. Above that the listing requires `code-premium` once the fee
ceiling is raised (§8.8) and, until then, `code-standard` at the largest panel
its envelope allows. A dispute escalates one class up, or to the largest
standard panel in Phase 1.

### 16.7 Money

**Hunter.** Pays the class prepay per submission as today (decision 7, §15) and
posts a **bond**, returned on any VALID outcome and forfeited to the maker on
INVALID. The bond is the slop filter. A submission with probability *p* of
being wrongly paid is worth sending when *p* × award > bond, so the bond sets
the false-VALID rate the stake can tolerate: `bond ≥ p_tolerated × top award`.
At a 1% tolerance a $1k stake needs a $10 bond and a $10k stake a $100 bond;
market deposits sit in that range (HackenProof $5, which cut slop by about
80%; Code4rena 25 USDC; Sherlock $250). The record shows the bond so hunters
can price it. The pre-flight fee and local CLI (§6.4) apply unchanged: a PoC
that does not fail at base never reaches the network.

**Maker.** Pays a **listing fee** per 30 days of live stake to the attestation
provider (the site, in the role `preflightProvider` already plays), which funds
the baseline scan so no record reads "0 of 0"; the capital lock (tens of
dollars a year on a $10k stake at current yields); the awards actually claimed;
and the escalation prepay when disputing. Expected cost is the sum over classes
of P(finding) × award — pay per finding, against a fixed-fee audit that costs
the same whether the code is clean or not. A maker with five $1k findings has
bought a $5k audit with a public receipt; a maker with none has paid a listing
fee and a lock.

**Arbiters.** Earn the registered class fee per submission as today. Nothing in
the arbiter payment path changes.

**Verdikta.** The listing fee and its operated arbiters; no share of awards in
v1 (Hats takes 10–20% of payouts — an option, not a design choice here).
Revenue concentrates where stakes are large, which is Base protocols; skills
and MCP servers supply volume, the seeding story (§16.9) and the runtime hook.

### 16.8 Hunter supply

The supply the record needs is turned away elsewhere. HackerOne requires a
hacker-in-the-loop to validate before submission; Immunefi's terms ban
AI-generated and scanner reports; Cantina bans unvalidated AI output; GitHub
caps newcomers at four submissions and moved its top rates to an invite-only
tier; Sherlock's Audit Engine welcomes "AI auditors" but gates them by
application, KYC and NDA and pays only participants with at least two valid
findings and a 20% valid ratio. A venue that **welcomes autonomous hunters
outright**, judges in minutes, pays on-chain and prices slop with a bond rather
than a ban is a differentiator, and the likeliest source of attention at the
$100–$10k tiers.

What it costs them: a thorough agent pass over a small artifact is cents to a
dollar; over a 10k-line codebase, $5–$50 of agent time. XBOW reportedly spent
more on inference than it earned in 2025, so the feed must carry enough
positive-expected-value listings or the hunters leave. Hence the **listing
feed** (hash, image, scope, award table, bond, days open, submissions so far) as
a public API from day one, and the baseline scan, funded by the listing fee, as
the floor of attention every record gets.

### 16.9 Disclosure, privacy, lookup

- **What is public when.** On-chain at commit: the archive hash, the bond and
  the timestamp. At reveal: the bCID and the evaluation. At settle: the verdict
  and payout, and the finding body on IPFS only when VALID — an INVALID
  submission is never published, so slop does not pollute the record. The
  known-issues list is hashes; sealed bodies reach arbiters inside the
  evaluation request only for findings already judged VALID and fixed, so an
  operator never reads an unfixed finding.
- **Private posting.** Asked for as "post privately so nobody finds the bug
  before it is fixed". For public artifacts the need is **embargo**, which
  commit → fix window → reveal provides. For closed-source code every arbiter
  operator must read it, and a permissionless operator set cannot promise
  confidentiality without enclaves or a permissioned class: **out of v1**,
  revisited with the remote-runner work (§12, Phase 3). An **invited** round
  (allow-listed hunter addresses) is supported and labelled in the record as
  the weaker attestation it is.
- **Lookup.** `recordByHash(bytes32)` on the contract and an HTTP mirror; a
  one-line hook for agent runtimes (`npx @verdikta/attest-check <path|hash>`)
  resolves a skill or package to its record and applies the caller's own rule
  ("load only if staked above X with no valid unfixed finding"). ERC-8004's
  reputation registries were found gamed (Sybil reviewers, empty identities);
  a stake-backed record is a different kind of signal — escrowed money and
  judged history, not scores. The chicken-and-egg (runtimes will not check
  until artifacts are staked; makers will not stake until runtimes check) is
  broken by **seeding**: Verdikta funds stakes on the most-installed skills and
  MCP servers, discloses findings to their maintainers through the fix window,
  and publishes the records — what the Internet Bug Bounty did for third-party
  open source before it paused in March 2026. The need is live: Koi Security
  found 341 malicious skills among 2,857 on ClawHub on 1 February 2026 (335
  shipping a macOS stealer), later audits report four-figure counts, and
  ClawHub's answer was scanner integration (VirusTotal, ClawScan). OpenAI added
  MCP servers to its bug bounty in April 2026 at up to $6,500 (single source).

### 16.10 What this changes in the rest of the design

| Where | Change |
|---|---|
| §6.5 | `bug` is the lead kind. Its gates gain the test-paths-only, no-regression-with-fix and claimed-observable rules of §16.6; the Foundry image moves from Phase 3 to Phase 1 |
| §6.1, `@verdikta/common` | `stake` block in `code_review.json`; `finding.json` schema; the outcome set `[INVALID, LOW, MEDIUM, HIGH, CRITICAL]` and the severity-rubric id; artifact kinds; the `skill` harness image and its activity-log report (after Phase 1) |
| §8.2–8.3 | Jev's typed questions and the jury prompt for `bug`: required behaviour, class, known or duplicate, PoC honesty; the known-issues list in the context pack |
| §8.4 | `bug` listings evaluate on `code-standard`; stakes above ≈ $1k require `code-premium` once the ceiling is raised; disputes escalate one class |
| §12 | Phase 1 adds `bug`, the `foundry` image and the `StakeAttestation` contract and record page on testnet; Phase 3 drops `bug` and adds the `skill` harness and the closed-source question |
| §13 | The attestation fixtures listed there |
| verdikta-applications | New `StakeAttestation` contract: escrow by award table bound to an artifact hash with lineage; commit → fix window → reveal; bond; dispute escalation; `recordByHash`. Site flows: listing, baseline scan, encrypted disclosure relay, feed, record page and badge; `@verdikta/attest-check` |
| §15 | Decision 10 |

Nothing in §7 (runner), §9 (time budget) or §10 (failure semantics) changes: a
`bug` evaluation is a `change` evaluation whose patch is a test.

### 16.11 Risks and open questions

- **Judge accuracy on security findings.** No platform publishes it, Sherlock
  included. A false VALID pays the maker's stake to slop and ends the product; a
  false INVALID leaves a bug in and mints a false record. The bond bounds the
  first; the dispute window and the calibration set (§13) bound both; and
  because every verdict and dispute outcome is on-chain, Verdikta can publish
  precision and recall per class — the one metric no competitor publishes.
  Phase 1 exit: no false VALID on the adversarial fixtures, and the dispute-flip
  rate measured on canaries.
- **Hunter supply at the middle tiers** is assumed, not shown; the feed and the
  seeded stakes are how it is tested. If autonomous hunters do not come, the
  record degrades to "scanned" and the proposition is a baseline scan plus
  escrow — weaker, still honest.
- **Capital lock.** Makers may balk at open-ended escrow. A yield-bearing
  escrow (stake held in a vault, awards paid from principal) is the obvious
  mitigation and a contract question for verdikta-applications.
- **Operator exposure.** Operators read proofs of concept at reveal, after the
  fix window, and never see unfixed sealed findings. A maker who ships no fix
  inside the window exposes their users at reveal — by their own choice, and
  recorded.
- **Legal.** Safe-harbour terms for hunters (the artifact is tested offline in
  the sandbox; live systems are out of scope); "certification" is avoided
  throughout; the record is a statement of stake and judgement.
- **Demand backdrop.** DeFi TVL roughly halved between October 2025 and May
  2026 and public audit contests fell 83%; the stake form competes for a
  shrunken protocol budget, which is why the skills registry is the growth
  story and the protocols the revenue.

## Sources

- SWE-bench: Jimenez et al., *SWE-bench: Can Language Models Resolve Real-World
  GitHub Issues?* (arXiv:2310.06770); Toloka, "Fixing SWE-bench"
  (toloka.ai/blog/fixing-swe-bench-a-smarter-way-to-evaluate-coding-ai); reward
  hacking in evaluations (arXiv 2609.19101).
- AI code review accuracy: Kunal Ganglani, "AI Code Review Tools 2026 Compared"
  (kunalganglani.com/blog/ai-code-review-tools-2026-compared), which reports the
  January 2026 false-discovery study and Atlassian's figures.
- Jev: docs.typesafe.ai (`/api`, `/model-jaggedness/jev-1.13`,
  `/introduction/coding-agents`); en.wikipedia.org/wiki/Jev_(AI_model); pricing
  as listed on openrouter.ai/typesafe/jev-1.13 and aimlapi.com/models/typesafe-jev.
- Jev on OpenRouter: openrouter.ai/docs/guides/community/jev and
  …/typesafe-sdk; model prices from openrouter.ai/api/v1/models on 2026-10-17
  (frontier) and 2026-10-19 (open-weight code models).
- Jev use-case review: docs.typesafe.ai `/patterns`, `/cookbooks`,
  `/cookbooks/citation_check` (the claim-check recipe: `supports` /
  `contradicts` / `says_nothing`, auto-accept at 0.8), `/cookbooks/rerank_typesafe`
  (BM25 top-1 5% → 18% on 40 queries for $0.06; "repeated scoring can vary"),
  `/confidence`.
- Clef: InfoQ, "Clef decision models" (infoq.com/news/2026/10/clef-decision-models).
- Fees: `maxOracleFee`, `maxTotalFee`, `bonusMultiplier`, `clusterSize` read from
  the mainnet aggregator on 2026-10-17; ETH/USD from the Chainlink feed on Base
  (`0x7104…Bb70`); defaults in `example-bounty-program/server/config.js`.
- Selection and payment: `ReputationKeeper.selectOracles` (`fee <= maxFee`
  filter) and the aggregator's base-payment path (`ethOwed[payee] += fee`,
  registered fee) and `_applyTimeoutPenalties`, dispatcher `b6ef49c`.
- Review of PR #96 (2026-10-19): the forged-JUnit, bare-mirror `git apply`
  and all-mandatory-rubric counterexamples were reproduced locally before being
  folded in; gVisor's security model (gvisor.dev/docs/architecture_guide/security).
- Hosted execution tools (2026-10-21): platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool
  (1 CPU / 5 GiB / no network / Python 3.11; 1,550 free hours then $0.05/h),
  …/about-claude/pricing (Managed Agents $0.08 per session-hour),
  …/managed-agents/environments and …/cloud-sandboxes-reference (Ubuntu 24.04,
  ≤ 8 GB, Node 20–22, `docker` limited, `ghcr.io` among package-manager hosts);
  developers.openai.com/api/docs/guides/tools-shell (Debian 12, Node 22.16, no
  outbound network by default, `network_policy` allowlist),
  …/guides/tools-code-interpreter, …/pricing ($0.03–$1.92 per 20-minute session
  by memory tier).
- Claude pricing: Anthropic's model table as of 2026-10-06.
- Internal: `verdikta-agents/docs/agent_coding_sandbox_design.md` (D2, D3) and
  `docs/coding_sandbox_runbook.md` on `origin/main`;
  `verdikta-dispatcher/reputationBasedAggregator/contracts/ReputationAggregator.sol`;
  `verdikta-applications/example-bounty-program` (`server/utils/archiveGenerator.js`,
  `server/utils/validation.js`, `onchain/contracts/BountyEscrow.sol`).
- Market research for §16 (2026-10-27/28; reports, notes and raw evidence in
  the private `verdikta-knowledge` repository under
  `initiatives/stake-attestation/research/`): Code4rena wind-down (code4rena.com); curl bounty end and
  2026 report volume (daniel.haxx.se, 2026-01-26, 2026-05-26, 2026-10-14);
  hackbots (hackerone.com/blog/2025-hpsr-researcher-signals;
  hackerone.com/blog/welcome-hackbots-how-ai-shaping-future-vulnerability-discovery;
  xbow.com/blog/series-b; the inference-exceeds-earnings claim is third-party,
  utkusen.substack.com); GitHub payout cuts and submission caps (techtimes.com,
  2026-07-27); Sherlock Audit Engine (docs.sherlock.xyz/audit-engine/about-audit-engine,
  …/faq) and Aerodrome's tiered pool (cryptobriefing.com/aerodrome-finance-400k-audit-contest-sherlock);
  Flare FAssets (immunefi.com, as recorded in the notes); Code4rena's V12
  known-issue rule (docs.code4rena.com/competitions/submission-guidelines);
  Anthropic's HackerOne program averages (hackerone.com/anthropic via
  gigazine.net, 2026-05-08); HackenProof's $5 fee effect (podcast interview, as
  recorded in the notes; no written source); Internet Bug Bounty pause
  (hackerone.com/ibb, 2026-03-27); ERC-8004 registry statistics
  (datawallet.com/crypto/erc-8004-explained, secondary); ERC-8183 evaluator
  role (futurehumanism.co/articles/three-laws-agent-commerce-erc-8183-ribbita);
  OpenAI MCP bounty (niteagent.com, single source); platform AI rules census
  (github.com/munimtechnologies/audit-contest-ai-rules, AI-produced, not peer
  reviewed).
- Hats Finance pay-for-results model (2026-10-30): governance.cartesi.io
  (proposal/313), gov.pooltogether.com (…/3041, 10% fee),
  forum.dappradar.com (…/1228, budget retained if nothing found),
  ionprotocol.io/2024/01/17 ($40k pool), medium.com/@metromxyz (20% fee); the
  "sole pay-for-results platform" claim (cointelegraph.com) is promotional.
- ClawHub malicious skills (2026-10-30): thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html
  (Koi Security, 341 of 2,857, 1 Feb 2026); unit42.paloaltonetworks.com/openclaw-ai-supply-chain-risk/
  (Feb–May 2026 persistence); antiy.net ClawHavoc analysis; the 1,103-of-14,706
  figure is from a single secondary guide (insiderllm.com).
