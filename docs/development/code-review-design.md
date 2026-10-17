# Code-review evaluations on Verdikta arbiters — design

**Status:** proposal, 2026-10-16
**Touches:** verdikta-arbiter (new `code-runner`, External Adapter, AI Node,
installer), verdikta-common (schemas, ClassID, image pins), example-bounty-program
(code bounty type, environment build, PR submissions), aggregator configuration
(one timeout).

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
   bounty's commands against it before the bounty is funded. Arbiters pull the
   image; they never install dependencies or touch the network while grading.
3. **One new arbiter component, `code-runner`,** runs a fixed pipeline — apply →
   build → tests → lint/SAST → API checks → tests-only replay — in a fresh gVisor
   container with no network, and returns a deterministic Verification Report.
4. **Deterministic gates settle failing submissions with no LLM call,** the way
   malformed bCID archives settle today: the patch doesn't apply, the build
   fails, an acceptance test fails, a previously passing test regresses.
5. **Jev makes the many small, typed judgements** — one per rubric criterion,
   per lint finding, per gaming signal — for a fraction of a cent, and sits on
   the jury as a low-weight "rubric juror". It is reached through OpenRouter, so
   operators need no new key.
6. **Frontier models do the deep review** — logic and edge cases the tests miss,
   security, test adequacy — with the report as ground truth and a bounded,
   deterministic context pack.
7. **Code bounties get their own ClassID.** Its pool is broad — Jev, a code
   specialist, `claude-sonnet-5-5` / `gpt-6-sol`, `claude-opus-5-5` /
   `gpt-6-astra` — the creator picks the panel from a standard or premium
   template, and only arbiters whose runner passes a conformance self-test
   register for it.
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
     ├─ validates: build passes, suite runs, acceptance tests fail at base, timings
     └─ pushes env image  ghcr.io/verdikta/bounty-env@sha256:…
  primary archive: query + rubric + code_review.json (+ acceptance.patch, api.hurl, baseline.json)

Submission (bounty program)
  hunter: PR URL (or a .patch) ─► bCID archive: submission.patch + submission.json

Evaluation (each selected arbiter)
  Chainlink job ─► EA /evaluate
                    ├─ fetch primary + bCID archives                       (existing)
                    ├─ POST code-runner /v1/runs ─► gVisor container, --network none
                    │     apply → build → tests → lint/SAST → API checks (+ tests-only replay)
                    │     ◄─ Verification Report + context pack
                    ├─ a gate failed? ─► deterministic DONT_FUND verdict      (no LLM)
                    └─ otherwise POST AI Node /api/rank-and-justify (code mode)
                          ├─ Jev: rubric checks, finding triage, gaming flags  (~1 s, <$0.01)
                          ├─ frontier jurors: deep review, scores              (parallel)
                          └─ justifier ─► justification + execution-evidence block
                    ─► commit / reveal                                         (existing)
```

### 5.1 Interface changes

| Where | Change |
|---|---|
| `@verdikta/common` | Manifest key `codeReview`; schemas for `code_review.json` and the Verification Report; pinned base-image, gVisor and Semgrep-rule versions; the new ClassID and its models; the conformance canary's expected report hash |
| `code-runner/` (new) | `POST /v1/runs` `{ spec, patch, acceptancePatch, hurl, baseline, deadline }` → `{ report, reportSha256, contextPack }`; `GET /health` |
| External Adapter | When the primary manifest has `codeReview`: call the runner, settle gate failures, otherwise pass the report and context pack to the AI Node as named text attachments plus a structured `codeReview` field |
| AI Node | `rank-and-justify` accepts optional `codeReview` (report, parsed rubric): code-review pre-prompt, Jev stage through an OpenRouter `systemone` client, web access off, code-mode timeouts |
| Chainlink job spec | `maxTaskDuration` and bridge timeout 300 s → 840 s |
| Aggregators | `setResponseTimeout(900)`; `setMaxOracleFee` above 0.0004 ETH if premium panels are wanted (§8.8) |
| Bounty program | Code bounty form with standard/premium templates that set `maxOracleFee`; builder Action and fallback workflow with the validation report; `prUrl`/`.patch` submissions; code variant of the evaluation query; creator-funded evaluation budget (§8.8) |

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
  "env": { "image": "ghcr.io/verdikta/bounty-env@sha256:…", "from": "node22" },
  "commands": {
    "build":     "npx tsc --noEmit",
    "test":      "npx vitest run --reporter=junit --outputFile=$OUT/junit.xml",
    "testFiles": "npx vitest run --reporter=junit --outputFile=$OUT/junit.xml $FILES",
    "lint":      "npx eslint -f json -o $OUT/eslint.json $CHANGED_FILES"
  },
  "acceptance": { "patch": "acceptance.patch" },
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
- Commands run **only inside the sandbox**, exactly as written. The runner sets
  `$OUT`, `$FILES` and `$CHANGED_FILES`. The only formats it parses are JUnit XML
  for tests and JSON/SARIF for linters.
- `baseline.json` is the per-test status at `baseCommit`, recorded by the
  environment build.
- The creator supplies all of it; the environment build (§6.2) validates it before
  the bounty can be funded. The rubric is unchanged. The bounty program's code
  template and evaluation query (`archiveGenerator.js`) gain a code variant that
  points the jury at the execution evidence.

### 6.2 Environment image, built at bounty creation

The environment builder is a reusable GitHub Action published by Verdikta. A
creator whose repository has CI runs it there (the build job holds no secrets; a
separate job pushes the image); for everyone else the bounty program runs the same
Action in its own workflow. Either way the bounty program validates the result
before the bounty can be funded, by running steps 2–3 itself. The Action:

1. Starts `FROM` a blessed base image (`node22`, `python312`; digests pinned in
   `@verdikta/common`), clones `repo` at `baseCommit` and runs the creator's
   `setup` (`npm ci`, `uv sync --frozen`, …) with network access.
2. Runs `build` and `test` at base with the same runner and gVisor release the
   arbiters use, without network. It records `baseline.json` and the timings, and
   sets default limits to 3× the measured times. If that exceeds the 360 s
   `runSeconds` cap, the repository is too heavy for code review v1 and creation
   stops here — this is what keeps §9's budget honest.
3. Applies `acceptance.patch` and checks that the acceptance tests **fail** at
   base; if they pass, it warns the creator that they cannot tell a submission
   from no change. It also checks that the API `start`/`ready` pair boots.
4. Pushes the image to a public registry (GHCR by default — public images cost
   nothing to store or pull; images over 2 GB compressed are rejected so arbiters
   can pull one inside the budget) and writes its digest into `code_review.json`.

The creator sees this validation report before funding. Arbiters treat the image
like the rest of the bounty: defined by the creator, public, content-addressed.

**How arbiters get it.** Arbiters learn nothing about a bounty in advance. The
image digest travels in `code_review.json` inside the primary archive, which the
EA fetches from IPFS at evaluation time exactly as it fetches the rubric today;
the runner then pulls the image by digest. The first pull per operator per bounty
costs 0–90 s (a 2 GB image at 50 MB/s is about 40 s; the §9 budget allows for
it), and every later submission to that bounty hits the cache. The work scales
per bounty, not per submission or per arbiter: one build of 5–25 CI minutes,
0.3–2 GB of registry storage with the base layers shared, and on each arbiter a
30 GB LRU cache (15–30 images) whose evictions only cost a re-pull. If registry
availability becomes a concern, the image tarball can also be pinned to IPFS as a
fallback source; v1 does not need it.

### 6.3 Submission: the bCID archive

`POST /jobs/:id/submit` accepts a `prUrl` (or an uploaded `.patch`). The server:

- reads the PR's head SHA and builds `git diff --binary <baseCommit> <headSha>`;
- rejects early, with a message the hunter can act on: wrong repository; PR not
  based on `baseCommit` ("rebase onto 9c1e4f…"); patch larger than
  `maxPatchBytes`; patch that fails `git apply --check` against a bare mirror
  (which executes nothing);
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
   refuse when the deadline cannot be met. When several of the operator's jobs are
   selected for the same request, they share one run, keyed by env digest, patch
   hash and spec hash — as `cidFetchCache.js` already does for IPFS downloads.
2. **Pull** the env image by digest from the allow-listed registry. Images are
   cached and evicted least-recently-used under a disk cap.
3. **Apply** `submission.patch` (the `applies` gate). Before any submission code
   runs, compute the diff stats, the changed files split into tests and source,
   the dependency-change check, the flags (tests deleted, skip markers added,
   existing tests modified, protected paths touched) and the **context pack**
   (§8.3). Commit the result inside the container with a fixed author and date.
4. **Reset protected and acceptance paths to base, then apply
   `acceptance.patch`.** The evaluating tests and their runner configuration are
   always the creator's, as in SWE-bench.
5. **Build** (the `build` gate).
6. **Test.** Run the full suite, parse JUnit and compare with `baseline.json`:
   acceptance results, regressions (`PASS→FAIL` and `PASS→missing`), newly
   passing tests, the hunter's new tests. Failing tests are re-run once if time
   allows; a test that flips is marked flaky and kept out of every gate.
7. **Lint and SAST.** Run the repository's linter on the changed files, Semgrep
   with Verdikta's pinned offline rules (`--baseline-commit` = base, so only new
   findings), and a secret scan over added lines. Only findings on added lines
   are kept.
8. **API checks** (optional). Start the service in the background, poll `ready`
   for up to 60 s, run the creator's Hurl file (`hurl --test --report-junit`),
   stop the service.
9. **Tests-only replay** (optional, in a parallel container). Apply only the
   hunter's test files to base and run them with `testFiles`. A new test that
   fails without the change and passes with it tests the change; one that passes
   either way does not.
10. **Report** and tear down. A host-side GC timer removes anything a crash left
    behind.

### 7.3 Determinism rules

- **Pinned:** env image digest, runner version, gVisor release, base images and
  Semgrep rules, all versioned in `@verdikta/common`.
- **Fixed environment:** `TZ=UTC`, `LANG=C.UTF-8`, `CI=true`,
  `PYTHONHASHSEED=0`, a fixed hostname, and CPU/memory limits taken from the
  spec, never from the host.
- **Generous limits** (3× the base time measured on the same sandbox), because
  gVisor punishes wall-clock assertions: the EA's own `fetchDedupe` test failed
  its 600 ms bound under gVisor (1,031 ms).
- **Settle only on definitive failures:** a clean non-zero exit, a JUnit failure
  or error. A step that hits its wall-clock limit, the memory or process limit, or
  a dead sandbox makes the arbiter **abstain** — an error with no commit, the same
  rule that covers transient IPFS and AI failures today.
- **Identical LLM input:** the report the jury sees has no durations, host names,
  paths or per-run output directories, so every arbiter's jury reads the same
  bytes. The SHA-256 of the report's canonical JSON is logged and published in
  the justification.

### 7.4 Verification Report (abridged)

```json
{
  "schema": "verdikta.code-report/1",
  "envImage": "sha256:…", "baseCommit": "9c1e4f…", "patchSha256": "…",
  "gates": { "applies": "pass", "noDependencyChanges": "pass", "build": "pass",
             "acceptance": "fail", "noRegressions": "pass" },
  "tests": {
    "acceptance": { "total": 6, "passed": 5, "failed": ["acceptance/paging.test.ts > cursor wraps at end"] },
    "existing":   { "baselinePassing": 412, "regressed": [], "removed": [] },
    "added":      { "total": 9, "passWithChange": 9, "failWithoutChange": 7 },
    "flaky": []
  },
  "build": { "status": "pass" },
  "findings": [ { "tool": "semgrep", "rule": "js.sql-injection", "file": "src/db.ts", "line": 88, "message": "…" } ],
  "api": { "total": 12, "passed": 12, "failed": [] },
  "flags": { "testsDeletedOrSkipped": [], "existingTestsModified": [], "protectedPathsTouched": [],
             "ciConfigChanged": false },
  "diff": { "files": 7, "added": 214, "removed": 31 }
}
```

### 7.5 What we borrow from verdikta-agents

The verdikta-agents coding sandbox (`packages/sandbox-kit`, on its `origin/main`)
already runs gVisor next to live arbiters. What carries over and what changes:

| verdikta-agents | For arbiter grading |
|---|---|
| gVisor as an extra Docker runtime, pinned by SHA-512, added with `systemctl reload docker`, never a restart | Same |
| Admission control: memory reserve that includes the largest local model, refusal during install/upgrade, no swap | Same |
| Capped scratch per sandbox, head/tail output capture, in-container timeout plus host backstop, plain "sandbox died" reasons | Same |
| No credential ever enters the sandbox; the trusted side streams code in and reads results out | Same; arbiters need no GitHub token at all |
| Host-side GC timer | Same, for sandboxes that live minutes rather than 14-day workspaces |
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
registry-only proxy); `build`; `acceptance`; `noRegressions`,
which also counts baseline tests that vanished. For `bug`: `applies`,
`reproduces` and, if a fix is included, `fixed`. A creator can switch a gate off,
for instance `noRegressions` for a bounty that removes a feature.

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
| Each new lint/SAST finding (up to 30, with ±20 lines of code): is it a real defect this change introduced? | `noul` | Drops likely false positives before the frontier sees them |
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

**The rubric juror.** Jev also sits in the class's `AI_NODES` with a small weight.
Its FUND score is Σ wᵢ · E[levelᵢ] / 3 over the weighted criteria, set to 0 when
any must-pass check finds a violation more likely than not — the same two-phase
rule the bounty's evaluation prompt gives the LLM jurors
(`archiveGenerator.js`, `buildEvaluationQuery`). TypeSafe says score levels are
only weakly calibrated as magnitudes, so the level-to-score mapping is tuned on
the calibration set in Phase 2 (falling back to thresholds if it must). Its
justification is a deterministic table of its answers. Implementation: a
`systemone` client beside the OpenRouter provider (a native TypeSafe key is
optional, under the usual `AI_GATEWAY` rules) and one branch in `queryModel`
(`ai-node/src/app/api/rank-and-justify/route.ts`) that returns a decision vector
directly instead of parsing model text.

Jev never decides a gate and never sees anything the frontier jurors don't.

### 8.3 Frontier jury: deep review (AI Node)

The existing multi-model `rank-and-justify`, with a code-review pre-prompt. Input:

1. The bounty's evaluation query and rubric, unchanged.
2. The Verification Report, labelled as ground truth.
3. The Jev checklist. Low-confidence answers (confidence below 0.6, or a
   must-pass probability between 0.3 and 0.7; both tunable) are marked "decide
   this yourself", and only the lint/SAST findings Jev did not dismiss are shown.
4. The **context pack**, built by the runner, deterministic and budgeted (80k
   tokens by default), in priority order: the diff with function context
   (`git diff -W`), source before tests, lockfiles and generated files as stats
   only; the full post-change text of changed source files; call sites of changed
   top-level symbols (`git grep -w`, at most 10 each); a shallow file tree. Over
   budget, the lowest tiers are dropped and the pack says so.

The prompt asks each juror to:

- never contradict the execution facts;
- look for defects the tests do not cover — edge cases, error handling,
  concurrency, security, API contracts — and count only defects tied to a
  file:line with a concrete input or line of reasoning;
- judge test adequacy and scope;
- score the rubric as today.

Web access is forced off in code mode; the PR URL would otherwise turn it on
under `AI_WEB_ACCESS=auto`.

Code mode raises `MODEL_TIMEOUT_MS` to 240 s and runs frontier jurors at effort
`high` (coding responds strongly to effort).

### 8.4 The code-review class: pool and templates

A ClassID is the pool of models an operator must serve; the **creator** picks the
panel — models, weights, iterations — from that pool in the manifest's `AI_NODES`.
So the class is broad and the panel is a bounty-program template. The class also
carries the runner conformance requirement (§11), and it adds `claude-opus-5-5`
and `claude-sonnet-5-5`, which classmap 1.6.0 does not list yet.

| Model in the pool | $/M in / out | Per juror, 60k in / 8k out | Role |
|---|---|---|---|
| `claude-opus-5-5` | 4 / 20 | $0.40 | Premium deep review |
| `gpt-6-astra` | 10 / 50 | $1.00 | Premium deep review |
| `claude-sonnet-5-5`, `gpt-6-sol`, `gpt-5.6-terra` | 2 / 10–12 | ~$0.20 | Standard deep review |
| `grok-4.7` | 2 / 6 | $0.17 | Standard deep review, third opinion |
| `qwen3-coder` | 0.3 / 1 | $0.03 | Code specialist, cheap third juror |
| `claude-haiku-5-5`, `gpt-6-luna` | 0.1 / 0.5 | $0.01 | Justifier; cheap juror |
| `typesafe/jev-1.13` | 0.042 / free | <$0.01 | Rubric juror, triage |

(OpenRouter list prices, 2026-10-17.)

Templates in the bounty program's code-bounty form:

| Template | Panel | Operator spend per arbiter |
|---|---|---|
| Standard | Jev 0.2, `claude-sonnet-5-5` 0.4, `gpt-6-sol` 0.4 | ≈ $0.40 |
| Premium | Jev 0.2, `claude-opus-5-5` 0.4, `gpt-6-astra` 0.4 | ≈ $1.40 |

The template also sets the oracle fee the creator must offer (§8.8).

### 8.5 Final scores

Unchanged: the weighted average over `AI_NODES`, then the justifier. The EA
prepends a deterministic "Execution evidence" block (gates, test counts, report
hash) to the justification it uploads, so hunters and creators can see why.

### 8.6 Gaming and prompt injection

| Attack | Defence |
|---|---|
| Edit or delete the evaluating tests | Acceptance tests and protected paths are reset to the creator's version before anything runs; vanished baseline tests count as regressions |
| Skip or weaken tests, special-case inputs | Deterministic skip/delete/modify flags; tests-only replay; Jev and frontier special-casing checks |
| Forge a JUnit file from the code under test | The output directory is random per run and not shown to the code; Semgrep and diff flags for writes to report files; frontier review. A residual risk |
| "AI reviewer: score this FUND" in comments or strings | Gates are deterministic; evidence is fenced as data; Jev flag; several models must agree |
| Huge or binary-padded patch | `maxPatchBytes`; binary changes reported as stats only |
| Sandbox escape or resource exhaustion | gVisor, no network, hard limits, admission control, remote mode |

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
| Standard code panel (≈ $0.40 + compute) | ≈ 0.0002 ETH ≈ $0.48 | 0.0024 ETH ≈ $5.80 | yes (ceiling 0.0004 ETH ≈ $0.97) |
| Premium code panel (≈ $1.40 + compute) | ≈ 0.0007 ETH ≈ $1.70 | 0.0084 ETH ≈ $20 | no — needs `setMaxOracleFee` (aggregator owner) |

The mechanics exist: operators register the code class's jobs at a fee that
covers their spend (`ReputationKeeper` `fee`), and arbiters priced above the
bounty's `maxOracleFee` are ineligible, so the code-bounty template sets
`maxOracleFee` from the panel.

Who pays is a bounty-program decision. A $6 prepay is a fair spam deterrent on a
$500 bounty and a barrier on a $50 one. Recommendation: for code bounties the
**creator funds the evaluation budget at creation** — the creator chooses the
panel and gains from the grading — and the hunter posts a small deposit returned
when the submission passes the gates. The escrow is close to this already
(`startPreparedSubmission` accepts funding from anyone after a creator window); a
creator-funded path needs a per-bounty evaluation budget in `createBounty` and a
cap on funded submissions per hunter.

## 9. Time budget

| Stage | Budget |
|---|---|
| Fetch archives (EA) | 30 s |
| Image pull (first use per operator, cached afterwards) | 0–90 s |
| Apply → build → tests → lint/SAST → API checks (replay in parallel) | ≤ 360 s (`limits.runSeconds`, enforced at creation) |
| Jev | ~2 s |
| Frontier jury (parallel), then justifier | ≤ 240 s + 45 s |
| Commit transaction; reveal dispatch → reveal transaction | ~90 s |
| **Worst case** | **≈ 14 min, so `responseTimeoutSeconds` = 900 s** |

Changes needed:

- `setResponseTimeout(900)` on both aggregators (an owner transaction). It only
  moves the point at which a stuck request may be force-finalized; ordinary
  requests are unaffected.
- `maxTaskDuration` and the bridge timeout in `chainlink-node/basicJobSpec` go to
  840 s. `upgrade-arbiter.sh` applies this when it regenerates job specs.
- The EA's `SERVER_TIMEOUT` rises to match; code-mode AI timeouts as in §8.3.

Typical evaluations are expected to take 3–6 minutes.

## 10. Failure semantics

| Situation | Result |
|---|---|
| Runner not installed or unhealthy, admission refused, deadline cannot be met | Error, no commit (transient) |
| Registry or image-pull failure | Error, no commit |
| Step timeout, OOM, process limit, sandbox died | Error, no commit (the arbiter abstains) |
| Patch doesn't apply, dependency change, build fails, acceptance fails, regression | Deterministic `DONT_FUND`, committed |
| `submission.patch` missing or not a patch | Malformed-bCID settlement (existing rule) |
| `code_review.json` invalid | Error: the requester's package is broken (existing rule) |
| Jev or a frontier model fails | Existing partial-failure rules (`MIN_SUCCESSFUL_MODELS_PERCENT`) |

## 11. Operator impact

- An optional installer phase, "Code-review sandbox", installs gVisor (pinned,
  added with `systemctl reload docker`) and the runner service, warms the base
  images, and runs the **conformance self-test**: a fixed canary bounty and patch
  whose expected report hash is published in `@verdikta/common`. Registering for
  the code ClassID requires a pass. `arbiter-doctor.sh` gains `svc.code_runner`,
  `sandbox.runsc` and `sandbox.conformance`.
- Resources: +2 vCPU, +4 GB RAM and +30 GB disk for the image cache, or a remote
  runner VPS.
- Keys: none new. Jev is reached through the operator's existing
  `OPENROUTER_API_KEY`; a native `TYPESAFE_API_KEY` is optional under the usual
  `AI_GATEWAY` rules.
- `start-arbiter.sh`, `stop-arbiter.sh`, `arbiter-status.sh` and `rotate-logs.sh`
  include the runner.

## 12. Rollout

| Phase | Delivers | Exit criteria |
|---|---|---|
| 0. Decisions | Timeout change and fee model approved; ClassID and pool chosen; OpenRouter `systemone` access verified from a canary; `code_review.json` and report schemas in `@verdikta/common` | Schemas merged |
| 1. Execution evidence | `code-runner` (local mode); `node22` and `python312` images; environment builder with creation-time validation; PR-to-patch submissions; gates; report and context pack fed to the existing jury; class 5555 canaries on testnet | Identical report hash on every canary; ≥ 90% agreement on the calibration set's clear cases and no false FUND on its adversarial cases; p95 inside the budget |
| 2. Cheap and sharp | `systemone` client, Jev triage and rubric juror; Semgrep and secret scan; Hurl API checks; tests-only replay; cost logging | ≤ $0.50 per arbiter per evaluation on the standard template; accuracy no worse than Phase 1 |
| 3. Breadth | `bug` bounties with a Foundry image; dependency changes through a registry-only proxy; remote runner mode; a Go image | A canary gate per feature; mainnet rollout per `docs/release-runbook.md` §3b |

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
- Run through `testing-tool` (a new `code` scenario type) and the e2e L4 gate
  against class 5555.
- Metrics: verdict accuracy; spread of FUND scores across arbiters (σ ≤ 5
  points); report-hash agreement (100%); cost; p95 latency.

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
7. **Fee model for code bounties (§8.8).** Creator-funded evaluation budget, or
   hunter-paid as today; and whether to raise the aggregators' `maxOracleFee`
   ceiling (0.0004 ETH) so premium panels are possible.

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
- Claude pricing: Anthropic's model table as of 2026-10-06.
- Internal: `verdikta-agents/docs/agent_coding_sandbox_design.md` (D2, D3) and
  `docs/coding_sandbox_runbook.md` on `origin/main`;
  `verdikta-dispatcher/reputationBasedAggregator/contracts/ReputationAggregator.sol`;
  `verdikta-applications/example-bounty-program` (`server/utils/archiveGenerator.js`,
  `server/utils/validation.js`, `onchain/contracts/BountyEscrow.sol`).
