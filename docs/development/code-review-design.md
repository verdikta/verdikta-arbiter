# Code-review evaluations on Verdikta arbiters — design

**Status:** proposal, 2026-10-16; revised 2026-10-19 after review (PR #96)
**Touches:** verdikta-arbiter (new `code-runner`, External Adapter, AI Node,
installer), verdikta-common (schemas, two ClassIDs with hard limits, image pins,
trusted builder keys), example-bounty-program (code bounty type, environment
build and attestation, PR submissions, funding policy), aggregator configuration
(one timeout; the fee ceiling for the premium class).

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
   pack. In code mode every frontier juror must answer.
7. **Code bounties get two ClassIDs, `code-standard` and `code-premium`,** each
   with an enforced envelope (model pool, panel size, counts, iterations, context
   and output budgets) and its own registered fee. One class cannot carry two
   price tiers: the selector takes any job priced at or below the request's
   ceiling and pays the job's registered fee. Only arbiters whose runner passes a
   conformance self-test register for either.
8. **One protocol change,** raising the aggregators' `responseTimeoutSeconds`
   from 300 s to 900 s, **and one economic one:** code panels cost operators
   8–30× today's ~5¢ per-oracle fee, so code bounties need higher oracle fees and,
   this design recommends, creator-funded evaluation (§8.8).

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
- Reviewers with a shell during grading (§14).
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
| `@verdikta/common` | Manifest key `codeReview`; schemas for `code_review.json`, `attestation.json` and the Verification Report; the trusted-builder key set; the two code ClassIDs with their envelopes and **hard limits**; pinned base-image, gVisor and Semgrep-rule versions and the OCI platform; the conformance canary's expected report hash |
| `code-runner/` (new) | `POST /v1/runs` `{ primaryCid, bcid, spec, attestation, patch, acceptancePatch, hurl, baseline, deadline }` → `{ report, reportSha256, contextPack }`; `GET /health`. Own `dockerd` with a fixed-size data disk (§7.1) |
| External Adapter | When the primary manifest has `codeReview`: verify the attestation and class envelope; compute the single deadline (§9) and pass remaining time to the runner and the AI Node; call the runner (shared per primary CID + bCID); settle gate and integrity failures; otherwise pass the report and context pack to the AI Node as named text attachments plus a structured `codeReview` field; no sandbox re-run on retry |
| AI Node | `rank-and-justify` accepts optional `codeReview` (report, parsed rubric, `deadlineMs`): code-review pre-prompt with trust tiers, Jev stage through an OpenRouter `systemone` client (annotating, never filtering), all frontier jurors required, deadline-derived timeouts with cancellation, web access off |
| Chainlink job spec | `maxTaskDuration` and bridge timeout 300 s → 840 s |
| Aggregators | `setResponseTimeout(900)`; `setMaxOracleFee` above 0.0004 ETH for the premium class (§8.8) |
| Bounty program | Code bounty form with standard/premium templates bound to the two classes; builder Action, fallback workflow, validation report and **attestation signing**; `prUrl`/`.patch` submissions checked against a temporary index; code variant of the evaluation query; creator-funded evaluation budget and funding policy (§8.8); pending-state UI to 15 min |

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
  proof-of-concept test, §6.4).
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

### 6.4 Two bounty kinds, one pipeline

| | `change` (feature or fix) | `bug` (find a bug) |
|---|---|---|
| Hunter submits | A patch: source and tests | A report and a patch adding a PoC test, optionally with a fix |
| Must hold (gates) | Patch applies; build passes; acceptance tests pass; no baseline-passing test fails or disappears | PoC tests **fail at base** as test failures, not import/collection errors where the framework tells them apart; with a fix included, they pass |
| Jury judges | Rubric fit, correctness beyond the tests, test quality, scope, safety | Is the asserted behaviour really required (spec, docs, scope)? Severity? Is the PoC minimal and honest? |

`bug` arrives in Phase 3 together with the Foundry image, where it matters most:
smart-contract bug bounties.

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

### 8.4 Two code-review classes: envelopes and templates

A ClassID is the pool of models an operator must serve; the **creator** picks the
panel — models, weights, iterations — from that pool in the manifest's `AI_NODES`.
The first draft proposed one broad class with two price templates. That cannot
work: `ReputationKeeper.selectOracles` takes every active job in the class whose
registered `fee <= maxFee`, and the aggregator pays the **registered** fee. A
premium request with a 0.0007 ETH ceiling would select a job registered at the
standard 0.0002 ETH and hand it the premium panel's ~$1.40 bill; pricing every
job for premium would exclude it from standard requests. So there are **two
classes**, each with an **envelope** the arbiter enforces:

| | `code-standard` | `code-premium` |
|---|---|---|
| Pool | `typesafe/jev-1.13`, `qwen3-coder`, `claude-haiku-5-5`, `gpt-6-luna`, `grok-4.7`, `claude-sonnet-5-5`, `gpt-6-sol`, `gpt-5.6-terra` | the standard pool plus `claude-opus-5-5`, `gpt-6-astra` |
| Panel | ≤ 3 models, `NO_COUNTS` 1, `ITERATIONS` 1 | ≤ 3 models, `NO_COUNTS` 1, `ITERATIONS` 1 |
| Context pack / juror output | 80k / 8k tokens | 120k / 12k tokens |
| Sandbox | class hard limits (§7.1) | same |
| Operator spend per evaluation | ≈ $0.40 | ≈ $1.40–2.00 |
| Registered fee (indicative) | 0.0002 ETH | 0.0007 ETH (above today's ceiling, §8.8) |

The envelope is enforced on the arbiter, not only in the UI: today nothing in the
EA or AI Node reads the classmap's `max_panel_size`, `max_no_counts` or
`max_iterations`, so code mode adds that check — a manifest whose `AI_NODES`,
counts, iterations or requested budgets fall outside the class envelope is a
requester error (errored path, no commit) before any model is called. Both
classes carry the runner conformance requirement (§11) and add `claude-opus-5-5`
and `claude-sonnet-5-5`, which classmap 1.6.0 does not list yet.

Per-juror cost on a 60k-in / 8k-out context pack:

| Model in the pools | $/M in / out | Per juror, 60k in / 8k out | Role |
|---|---|---|---|
| `claude-opus-5-5` | 4 / 20 | $0.40 | Premium deep review |
| `gpt-6-astra` | 10 / 50 | $1.00 | Premium deep review |
| `claude-sonnet-5-5`, `gpt-6-sol`, `gpt-5.6-terra` | 2 / 10–12 | ~$0.20 | Standard deep review |
| `grok-4.7` | 2 / 6 | $0.17 | Standard deep review, third opinion |
| `qwen3-coder` | 0.3 / 1 | $0.03 | Code specialist, cheap third juror |
| `claude-haiku-5-5`, `gpt-6-luna` | 0.1 / 0.5 | $0.01 | Justifier; cheap juror |
| `typesafe/jev-1.13` | 0.042 / free | <$0.01 | Rubric juror, triage |

(OpenRouter list prices, 2026-10-17.)

Templates in the bounty program's code-bounty form, each bound to its class:

| Template | Class | Panel | Operator spend per arbiter |
|---|---|---|---|
| Standard | `code-standard` | Jev 0.2, `claude-sonnet-5-5` 0.4, `gpt-6-sol` 0.4 | ≈ $0.40 |
| Premium | `code-premium` | Jev 0.2, `claude-opus-5-5` 0.4, `gpt-6-astra` 0.4 | ≈ $1.40 |

The template sets the class and the oracle fee the creator must offer (§8.8). A
mixed-fee selection test — a premium request must never select a standard-priced
job — is a Phase 0 deliverable.

### 8.5 Final scores and the partial-success rule

Scoring is unchanged: the weighted average over `AI_NODES`, then the justifier.
The EA prepends a deterministic "Execution evidence" block (gates, trust tiers,
test counts, report hash) to the justification it uploads, so hunters and
creators can see why.

**Partial success is stricter in code mode.** Today a request succeeds when at
least `MIN_SUCCESSFUL_MODELS_PERCENT` (0.5) of the models answer, with the
failed models' weight redistributed. On a three-model code panel that lets Jev
plus one frontier juror settle the verdict, with Jev's effective weight rising
from 20% to one-third. Code mode therefore requires **every frontier juror** in
the panel to succeed; if one fails, the arbiter abstains (error, no commit).
Jev's failure is tolerated: its weight is dropped, not redistributed, so the
frontier jurors' relative weights are unchanged and the final vector is theirs
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

### 8.7 Cost per evaluation (operator spend, one arbiter)

Standard template:

| Item | Tokens | Cost |
|---|---|---|
| Jev, ~10 small fan-out calls | ~60k in, total | ~$0.003 |
| `claude-sonnet-5-5` juror ($2 / $10 per million tokens) | 60k in / 8k out | ~$0.20 |
| `gpt-6-sol` juror ($2 / $10) | 60k in / 8k out | ~$0.20 |
| Justifier (`claude-haiku-5-5`, $0.10 / $0.50) | 15k in / 2k out | <$0.01 |
| **Total** | | **≈ $0.40**; a submission that fails a gate ≈ $0 |

Premium (`claude-opus-5-5` $0.40 + `gpt-6-astra` $1.00 + Jev) ≈ **$1.40**.
Sandbox compute is about 2 vCPU for 1–5 minutes.

All six selected arbiters evaluate (a commit needs the result), so one request
costs operators about $2.50 (standard) or $8.50 (premium) in provider fees in
total. That is the spend oracle fees have to cover; it is **not** what the hunter
pays today (§8.8). The context pack is the main dial: 40k instead of 60k input
tokens cuts a third. For comparison, three `claude-opus-5-5` jurors reading
unfiltered 100k-token contexts would cost about $0.55 each.

### 8.8 Fee economics: who pays

Today the hunter funds the evaluation when they start a submission
(`BountyEscrow.startPreparedSubmission` is payable by the hunter; anyone may fund
once a creator window has expired). The prepay is
`maxOracleFee × (K + bonusMultiplier × clusterSize)`, 12× the per-oracle fee on
both aggregators (6 + 3 × 2), with the unused part refunded. With the bounty
program's default fee of 0.00002 ETH (`server/config.js`) and ETH at about $2,420
(Chainlink ETH/USD on Base, 2026-10-17) that is $0.048 per oracle and a $0.58
prepay — the roughly $0.50 a submission costs now. An arbiter therefore earns
about 5¢ per evaluation; the standard code panel costs it about 8× that and the
premium panel about 30×.

| | Per-oracle fee | Hunter prepay (12×) | Under the ceiling? |
|---|---|---|---|
| Today's default | 0.00002 ETH ≈ $0.05 | 0.00024 ETH ≈ $0.58 | yes |
| `code-standard` (≈ $0.40 + compute) | ≈ 0.0002 ETH ≈ $0.48 | 0.0024 ETH ≈ $5.80 | yes (ceiling 0.0004 ETH ≈ $0.97) |
| `code-premium` (≈ $1.40–2.00 + compute) | ≈ 0.0007 ETH ≈ $1.70 | 0.0084 ETH ≈ $20 | no — needs `setMaxOracleFee` (aggregator owner) |

The payment path pays each selected job its **registered** fee, so raising the
ceiling alone buys nothing: the `code-premium` class's jobs must themselves be
registered at the premium fee, and the ceiling must admit them. That is why the
tiers are classes (§8.4). Within a class, operators register at a fee that
covers their spend and arbiters priced above the bounty's `maxOracleFee` are
ineligible; the template sets `maxOracleFee` from the class.

**Who pays** is a bounty-program decision, and it has to be one the contract can
act on. A $6 prepay is a fair spam deterrent on a $500 bounty and a barrier on a
$50 one. The first draft proposed a hunter deposit "returned when the gates
pass"; that is not implementable: `BountyEscrow.finalizeSubmission` sees only
the score vector and a justification CID, and a gate failure and a jury
rejection both arrive as `[1,000,000, 0]`. The contract cannot tell them apart
without a protocol change (an authenticated gate-status signal), which this
design does not propose. Recommendation for code bounties:

- the **creator funds an evaluation budget at creation** (`createBounty` takes
  `evaluationBudget` = N × the class prepay; the creator chooses the panel and
  gains from the grading);
- a **per-hunter cap** on funded submissions and the existing creator window
  control spam;
- an optional **flat, non-refundable hunter fee** set by the creator — a plain
  payment the contract can observe — instead of a conditional deposit.

Funding mechanics to specify, because today `startPreparedSubmission` records
`msg.sender` as `s.funder` and refunds leftover prepay to that address: who the
funder is when the escrow pays from the creator's budget, reservation and release
of the budget per in-flight submission, and recovery of unused prepay on
timeout. Test cases: gate failure, gate pass with jury rejection, round timeout,
concurrent starts against one budget, and leftover recovery.

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
| A frontier juror fails | Error, no commit — code mode requires every frontier juror (§8.5) |

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
| 0. Decisions | Timeout change and funding policy approved; the two ClassIDs, envelopes and hard limits chosen; trusted-builder key governance; OpenRouter `systemone` access verified from a canary; `code_review.json`, `attestation.json` and report schemas in `@verdikta/common` | Schemas merged **and** the adversarial fixtures of §13 written as failing tests: forged, missing or duplicate test reports, runtime test/reporter tampering, an unattested image and an over-limit direct request cannot yield trusted passing evidence or exceed operator limits; a mixed-fee selection test shows a premium request cannot select a standard-priced job |
| 1. Execution evidence | `code-runner` (local mode, own `dockerd` and disk); `node22` and `python312` images; builder Action with validation and attestation; PR-to-patch submissions; gates and integrity checks; deadline propagation; report and context pack fed to the existing jury; class 5555 canaries on testnet | Identical report hash on every canary **across hosts**, including the time- and randomness-dependent fixtures; ≥ 90% agreement on the calibration set's clear cases and no false FUND on its adversarial cases; a cold-cache end-to-end run with slow jurors, justifier delay, registry failure and cancellation; funding and refund cases pass; p95 inside the budget; the release runbook's version-checked canary gate kept before mainnet |
| 2. Cheap and sharp | `systemone` client, Jev annotation and rubric juror; Semgrep and secret scan; Hurl acceptance and API checks; tests-only replay; cost logging | ≤ $0.50 per arbiter per evaluation on `code-standard`; accuracy no worse than Phase 1; finding-recall against the Phase 1 unfiltered baseline unchanged, including injected dismissals; Jev run-to-run determinism measured |
| 3. Breadth | `bug` bounties with a Foundry image; dependency changes through a registry-only proxy; remote runner mode; a Go image; `code-premium` enabled once the fee ceiling is raised | A canary gate per feature; mainnet rollout per `docs/release-runbook.md` §3b |

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
  - funding: gate failure, gate pass with jury rejection, round timeout,
    concurrent starts against one budget, leftover recovery;
  - a time-dependent and a randomness-dependent test, run on two different hosts
    — identical report hash.
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
  but slow, expensive and different on every arbiter. A read-only browse of the
  checked-out tree could come later.
- **Firecracker or Kata microVMs.** A stronger boundary, but the current hosts
  have no KVM.
- **Hosted sandboxes (E2B, Modal, Daytona).** A vendor account and bill for every
  operator; verdikta-agents rejected them for the same reasons.
- **Jev as the only judge.** The cheapest, but weak at multi-hop reasoning and
  open to injected text by TypeSafe's own notes. Kept as a low-weight juror and
  a triage layer.

## 15. Open decisions and risks

1. **Raise `responseTimeoutSeconds` from 300 to 900 s on both aggregators?** First
   check that the bounty program and the example frontends don't assume five
   minutes.
2. **Jev continuity and behaviour.** Access is solved by OpenRouter. The
   remaining risks are model retirement (pin the dated snapshot; move the class
   deliberately when TypeSafe retires 1.13), run-to-run determinism, which
   TypeSafe does not document and Phase 2 measures since every arbiter sends the
   same request, and the 32 KB state rule. Cloudflare's open-weight Clef accepts
   the same request format and is the fallback, but a class pins one model, not a
   mix.
3. **Who owns the builder Action's fallback workflow and the
   `ghcr.io/verdikta/bounty-env` registry** (retention, size limits), given that
   creators with CI build their own images.
4. **Bounty-program wording.** It currently says GitHub PRs are not bounties,
   meaning Verdikta's own repositories. Code bounties will take PR links through
   bounties.verdikta.org, so the wording must tell the two apart.
5. **Creator trust.** The creator defines the environment, tests and gates — the
   same trust the rubric already carries.
6. **Public acceptance tests invite overfitting.** Mitigated by the
   special-casing checks; hidden tests would need encryption to the arbiters and
   are out of scope.
7. **Funding policy for code bounties (§8.8).** Creator-funded evaluation budget
   with a per-hunter cap and an optional flat hunter fee (recommended), or
   hunter-paid as today; the funder/refund mechanics in `BountyEscrow`; and
   whether to raise the aggregators' `maxOracleFee` ceiling (0.0004 ETH) so the
   `code-premium` class can exist.
8. **Trusted-builder keys.** Who holds the attestation signing keys listed in
   `@verdikta/common`, and how they rotate. Anyone can run the builder Action;
   only a listed key's signature makes a bounty gradable.
9. **In-process test evidence is tier B (§7.5).** The design accepts that a
   submission which forges results, passes every integrity check and survives two
   diff reviews is a residual risk, and asks creators for black-box acceptance
   checks where possible. The alternative — requiring black-box acceptance for
   every code bounty — is stronger and narrows what can be bountied. Decide
   before Phase 1.

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
  …/typesafe-sdk; model prices from openrouter.ai/api/v1/models on 2026-10-17.
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
- Claude pricing: Anthropic's model table as of 2026-10-06.
- Internal: `verdikta-agents/docs/agent_coding_sandbox_design.md` (D2, D3) and
  `docs/coding_sandbox_runbook.md` on `origin/main`;
  `verdikta-dispatcher/reputationBasedAggregator/contracts/ReputationAggregator.sol`;
  `verdikta-applications/example-bounty-program` (`server/utils/archiveGenerator.js`,
  `server/utils/validation.js`, `onchain/contracts/BountyEscrow.sol`).
