# Stake-backed security attestation on Verdikta arbiters — design

**Status:** proposal, 2026-10-16, as "code-review evaluations"; revised 2026-10-19
after review (PR #96); 2026-10-30 chose stake-backed security attestation as the
application to build and, in the same revision series, **restructured the document
around it**. Code bounties, the original framing, are out of scope and summarised
in Appendix A; the full code-bounty design is in this file's history at `df0e2de`.
**Touches:** verdikta-arbiter (new `code-runner`, External Adapter, AI Node,
installer), verdikta-common (schemas, two ClassIDs with hard limits, image pins,
trusted builder keys, the outcome set), verdikta-applications (a new
`StakeAttestation` contract and the attestation site: listing, baseline scan,
feed, record page and badge, the hunter tool, `@verdikta/attest-check`), and
aggregator configuration (one timeout; the fee ceiling for the premium class).

---

## 1. Summary

A **maker** puts money on the line against one exact version of their code: a
smart contract, an open-source repository, later an agent skill or MCP server.
They publish an award table by severity, escrow it, and name the lowest severity
that counts. Anyone — autonomous security agents included — may try to claim it
by committing a **sealed proof of concept**: a test that fails on the staked
version. The maker gets a fix window; then the proof is revealed and several
independent Verdikta arbiters each run it in a sandbox and judge it. A valid
finding is paid from escrow and published; an invalid one costs the hunter a
bond. Every step is on-chain. **The product is the live record**: how much is at
stake, for how long, how many claims were judged, what was found, what was
fixed, what was found later. It is not a certificate.

Nine decisions carry the design:

1. **The record is a live warranty bound to an artifact hash, not a badge
   earned by a quiet period.** Funds stay escrowed on that hash while the badge
   shows; closing the stake ends the badge and leaves the history (§4).
2. **A claim is an executed proof, graded from evidence.** The hunter's archive
   carries `poc.patch`, a patch that adds a failing test and touches nothing
   outside the test paths. Arbiters apply it to the pinned commit inside a
   prebuilt image and observe the failure themselves (§8.5, §9).
3. **Build the environment once, at listing, and attest it.** The attestation
   site builds a digest-pinned container image (repository at the staked commit,
   dependencies installed, baseline test results recorded over three runs) and
   signs an attestation binding image, commit, commands and baseline. Arbiters
   verify it and pull the image; they never install dependencies or touch the
   network while judging (§8.2).
4. **One new arbiter component, `code-runner`,** runs a fixed pipeline — apply →
   build → PoC on a fixed repeat schedule → integrity checks → optional fix check
   → lint/SAST — in a fresh gVisor container with no network, under the class's
   hard limits, on its own disk, and returns a deterministic Verification Report
   whose facts carry an explicit **trust tier** (§9).
5. **Deterministic gates settle INVALID with no LLM call:** the reveal does not
   match the commitment, the patch edits source, the PoC does not fail at the
   staked hash as an assertion failure, an affected path is out of scope, a test
   record is forged or missing (§10.1).
6. **Jev makes the typed judgements, frontier models decide severity.** Jev
   (TypeSafe's decision model, via OpenRouter, no new key) answers the class,
   known-or-duplicate and required-behaviour questions as probabilities and sits
   on the jury at low weight; two frontier jurors answer the same four questions
   in depth. In code mode every non-Jev juror must answer (§10.2–10.5).
7. **Commit → fix window → reveal, verifiable.** The hunter commits the archive
   hash and the CID of the archive encrypted to the maker's disclosure key; the
   maker decrypts and fixes; at reveal the keys are published and every arbiter
   re-derives both commitments. A hunter bond is returned on any valid or
   duplicate outcome and forfeited on INVALID; the maker may dispute once to a
   stronger panel (§7.1, §14).
8. **Two ClassIDs, `code-standard` and `code-premium`,** each with an enforced
   envelope (model pool, panel size, counts, iterations, context and output
   budgets) and its own registered fee. One class cannot carry two price tiers:
   the selector takes any job priced at or below the request's ceiling and pays
   the job's registered fee. Only arbiters whose runner passes a conformance
   self-test register for either (§10.4).
9. **One protocol change,** raising the aggregators' `responseTimeoutSeconds`
   from 300 s to 900 s, **and a cost plan:** the hunter pays the class prepay and
   the bond; the maker pays a listing fee, the awards and the escalation prepay
   when disputing; Verdikta takes no share of awards in v1 (§10.7–10.8).

## 2. Why this application: the market finding

Two research rounds (2026-10-27 and 2026-10-28: *Code bounty market and fee
fit* and *Code bounty trends with AI agents*, kept with their notes and raw
evidence in the private `verdikta-knowledge` repository,
`initiatives/stake-attestation/research/`) examined the code-bounty market the
original design was written for and found it closing:

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

Hence this application: **a maker stakes money against an exact artifact,
hunters try to claim it with executed proofs of concept, arbiters judge the
claims, and the public record of that stake and its history is the product.**
It is the one use case whose demand grows as agents improve. The same
machinery — the sandbox, the gates, the context pack, the jury, the fee plan —
was designed for code bounties and is reused unchanged; what differs is who
posts the request, what a submission is, and what the verdict is for.

## 3. Goals and non-goals

**Goals**

- Judge a security claim against a Node, Python or Foundry repository — a
  proof-of-concept test that fails at the staked commit — on validity, scope,
  novelty and severity, from execution evidence every arbiter reproduces.
- Every arbiter on a request reaches the same execution facts. Commit-reveal
  clusters the answers, so divergent evidence costs operators reputation.
- Untrusted code never gets near the node's keys.
- Operators never read an unfixed finding: arbiters first see a proof of
  concept at reveal, after the maker's fix window.
- Lower LLM cost than an all-frontier panel, and no LLM cost at all for a claim
  that fails a gate.
- A record a reader can price and a runtime can check from code.
- Buildable in phases by a small team, mostly on existing paths.

**Non-goals for v1**

- Closed-source artifacts. Every arbiter operator must read the code; a
  permissionless operator set cannot promise confidentiality without enclaves
  or a permissioned class (Phase 3, §14).
- Live-system testing. Proofs run against a copy of the code in the sandbox,
  never against a deployment.
- Agent skills and MCP servers as artifacts. Their harness image (§8.8) follows
  Phase 1.
- Monorepos whose suite cannot finish inside the limits; browser/E2E suites;
  GPU work; Go (an image follows in Phase 3).
- Reviewers with a shell during judging (§19; a bounded form — a local
  read/grep tool, then a hosted shell for `code-premium` — arrives in Phase 3).
- Code bounties: paying for a change rather than for a finding. Appendix A
  records what was designed and what re-adding it would take.

## 4. The record

### 4.1 What it is, and is not

A **stake record** is a live on-chain state bound to an artifact hash:

```
artifact   hash (repo@commit, contract source@address, or skill package), kind,
           declared value at risk (optional)
stake      award table by severity class (wei), bond, opened-at, funded-until,
           escrow remaining
history    claims judged (count), verdicts by outcome, valid findings
           (class, paid, disclosed-at), duplicates, disputes and their outcomes,
           unrevealed commits, days since the last valid finding
lineage    predecessor hash (what this version fixed), successor hash (what fixed it)
later      findings recorded against this hash after the stake closed
```

It is a **warranty anyone can price**, not a certificate. "There are 4 ETH
escrowed against this hash, 94 days unclaimed, 37 claims judged, 0 valid"
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
   program floor, §4.2), **staked**, **under-staked** (declared value at risk
   with the stake below a program-set share of it) or **invited** (allow-listed
   hunters only, §14).

### 4.2 What a stake proves

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
(§15) carry the proposition here.

## 5. Constraints from the current system

| Constraint | Fact (where) | Consequence |
|---|---|---|
| Time | Both aggregators have `responseTimeoutSeconds = 300` and K/M/N = 6/4/3 — six arbiters polled to commit, the first four commits revealed, three reveals aggregated (read from Base Sepolia `0xe8a3…80e4` and Base Mainnet `0xd8F3…142a` on 2026-10-16). The job's `maxTaskDuration` and bridge timeout are 300 s (`chainlink-node/basicJobSpec`); the AI Node's request timeout is 240 s. | Commit **and** reveal must finish inside 5 minutes today. That does not fit a build, a test run and a deep review. |
| Consensus | Six arbiters evaluate each request independently and are clustered on reveal. | Execution must be reproducible across machines: pinned environment, no network, flake handling, no host-specific data in the LLM input. |
| Security | The arbiter host holds the operator key, funded node keys, the Pinata JWT and the AI provider keys. | Untrusted code runs only inside gVisor (or on a separate machine), with no network and no credentials. |
| Sandbox speed | verdikta-agents measured gVisor without KVM at 2–6× slower than runc. A cold install + typecheck + test of this repository took ≈19–25 min against ≈6 min; warm test runs take seconds (`verdikta-agents/docs/agent_coding_sandbox_design.md`, D2). The Contabo hosts have no `/dev/kvm`. | Dependencies cannot be installed at judging time. Hence decision 3. |
| Evaluation model | A request carries IPFS CIDs, an addendum string and a class; the jury returns a vector over the manifest's outcomes summing to 1,000,000; the requesting contract reads it in its callback (`BountyEscrow._scoreVector` pays when FUND ≥ threshold over `[DONT_FUND, FUND]`). Submissions today are ≤10 text files; archives are rejected. There is no repo, commit or patch field anywhere. | A listing spec, a patch-based claim archive, a six-outcome vector and a new requesting contract are needed. The aggregator and the jury protocol are unchanged. |
| Fees | The bounty program's default per-oracle fee is 0.00002 ETH (≈ $0.05); the requester prepays 12× at request time; the aggregators cap the per-oracle fee at 0.0004 ETH (`maxOracleFee`, owner-settable). | Code panels cost operators 5–30× today's fee (§10.8). |
| Selection and payment | `ReputationKeeper.selectOracles` takes every active job in the class whose registered `fee <= maxFee`; the aggregator credits that **registered** fee, not the request's ceiling. Nothing in the EA or AI Node reads the classmap's `max_panel_size` / `max_no_counts` / `max_iterations` today. | A price tier needs its own class, and the arbiter must enforce the class envelope itself (§10.4). |
| Reputation | A round that times out applies the −20 timeliness penalty to every polled oracle that did not commit (`_applyTimeoutPenalties`); committing outside the first 4 of 6 also costs −20. | "Abstain" (error, no commit) is not neutral; refuse early rather than fail late (§12). |
| Precedent | The EA already settles a deterministically malformed bCID archive with a first-outcome verdict and no AI call (`external-adapter/src/utils/bcidValidation.js`, `buildMalformedSubmissionVerdict` in `evaluateHandler.js`). | Gate failures reuse that path; INVALID is the first outcome for that reason. |

## 6. What best-in-class judging looks like

- **Execution is the reliable signal.** SWE-bench grades a patch by applying it to
  a pinned base commit inside a prebuilt per-repository Docker image and checking
  FAIL_TO_PASS and PASS_TO_PASS; tasks are validated before use. Immunefi,
  Sherlock and Code4rena all require a runnable proof of concept for fund-loss
  claims and reject reports without one. A claim here *is* a FAIL_TO_PASS test:
  it must fail at the staked commit, and, when a fix is attached, pass after it.
- **Editable or weak tests are the main reward-hacking surface.** Graders keep the
  evaluating tests out of the submitter's hands. Here the submitter writes the
  test, so the constraints are on what it may touch (test paths only, protected
  paths reset) and on how its result is observed (§9.5).
- **LLM-only review is noisy.** A January 2026 study of LLM vulnerability
  detectors found an 85% false-discovery rate for the best tool; Atlassian
  reported 28–43% of its reviewer's comments as wrong, depending on category.
  Production reviewers run deterministic linters and SAST first, then use the
  model to triage those findings and to reason about what tools cannot see:
  business logic, auth flows, races. For security claims the execution fact
  ("this test fails at this commit") does the heavy lifting; the jury's job is
  the part no tool decides — is the asserted behaviour really required, and how
  bad is it.
- **Severity is where programs disagree.** Immunefi's classification system
  (v2.3) and Code4rena's judging rules exist because every dispute is about
  class, not validity. The award table makes the stakes of that judgement
  explicit, and the dispute path (§7.1) is built for it.
- **The scaffold matters as much as the model.** The same model judges
  differently with different context and prompts, so the context a jury sees has
  to be deliberate — and, for Verdikta, identical on every arbiter.

The design follows that order: execution facts gate and anchor; tools find
candidates; cheap typed judgements triage; frontier models reason; several models
must agree.

## 7. Architecture

```
Listing (attestation site, once per staked version)
  maker: repo@commit (+ address for a contract), scope paths, award table, lowest class
         counted, bond, windows, known issues, disclosure key, optional value at risk
  env builder: clone @ commit, install deps, run suite 3× at the commit
     ├─ validates: build passes, suite stable, test paths exist, PoC harness reports
     │             an assertion failure distinctly from a collection error
     ├─ pushes env image  ghcr.io/verdikta/stake-env@sha256:…
     └─ signs attestation.json (image, platform, size, commit, asset hashes, versions)
  baseline scan: Semgrep + secret scan + one cheap agent pass → maker, privately
  listing archive (IPFS): query (6 outcomes) + manifest + code_review.json +
                          attestation.json + baseline.json + known_issues.json
  StakeAttestation.list(...) → fund(...) escrows the awards → record goes live, feed announces

Claim (hunter tool)
  check:  local run of the arbiters' pipeline minus the jury (free)
  commit: encrypt archive to the maker's disclosure key, pin ciphertext,
          StakeAttestation.commit(sha256(archive), ciphertextCid) + bond + prepay
  maker:  decrypts, checks hash, fixes (roll forward) or waits, or releases
  reveal: pin plaintext (bCID), StakeAttestation.reveal(bcid, keys) → evaluation request

Evaluation (each selected arbiter; one deadline from EA receipt)
  Chainlink job ─► EA /evaluate   cids = [listing, claim, prior valid claims…], addendum = keys
                    ├─ fetch archives                                            (existing)
                    ├─ verify attestation + class envelope ─► invalid: requester error, no commit
                    ├─ disclosure check: sha256(plaintext) = commit; re-encrypt = pinned ciphertext
                    │     ─► mismatch: deterministic INVALID (bond forfeits)
                    ├─ POST code-runner /v1/runs ─► gVisor container, --network none, own disk
                    │     apply poc.patch (test paths only) → build → PoC ×3 at the hash
                    │     → integrity checks → [fix.patch: build, PoC, full suite] → lint/SAST
                    │     ◄─ Verification Report (tiered evidence) + context pack
                    ├─ a gate or integrity check failed? ─► deterministic INVALID  (no LLM)
                    └─ otherwise POST AI Node /api/rank-and-justify (code mode)
                          ├─ Jev: class, known/duplicate, required behaviour, honesty (~1 s)
                          ├─ frontier jurors: the four questions, severity        (parallel)
                          └─ justifier ─► justification + execution-evidence block
                    ─► commit / reveal                                            (existing)
  StakeAttestation callback: vector → outcome → dispute window → settle → record
```

### 7.1 A round, in time

The default listing (`fixWindowDays` 14; 30 for contracts; `disputeWindowHours`
72; `disclosureGraceHours` 48; `revealWindowDays` 7):

| When | Who | What happens |
|---|---|---|
| Listing | Maker | Names the artifact, scope, award table, lowest class counted, bond, windows, disclosure key, optional value at risk. The site builds and attests the image and runs the baseline scan (§8.2–8.3); findings go to the maker privately. The maker fixes (new version, relist), lists them as known issues (§8.4), or accepts the risk. |
| Open | Maker | Escrows the award table (at least the top award) and pays the listing fee for the first 30 days. The record goes live; the feed announces the hash. |
| Day 0 | Hunter | Commits on-chain: bond, class prepay, `sha256(archive)`, CID of the archive encrypted to the maker's disclosure key. The timestamp is fixed. Nothing readable is public. |
| Days 0–2 | Maker | Fetches the ciphertext, decrypts, checks the hash against the commitment. A copy that does not decrypt or does not match is flagged on-chain as a **bad disclosure** inside `disclosureGraceHours` — a claim, not a verdict, shown on the record (§14). |
| Days 0–14 (30) | Maker | Reads the report and runs the proof: it is a test that fails on their version. Ships a fix as a successor version and **rolls the stake forward** (ends the window for every pending claim), or **releases** the claim (waives the window: "I believe this is invalid, reveal now"), or does nothing. |
| Window end, FIXED or RELEASE | Hunter | Reveals: pins the plaintext archive (bCID) and puts the content key and ephemeral key in the reveal transaction. The contract submits the evaluation request. Arbiters verify both commitments, run the proof against the **committed** hash — never the fixed one — and judge. Verdict in 3–6 minutes, 15 at worst (§11). |
| + 72 h | Maker | May **dispute** a valid verdict once, paying the escalation prepay and attaching a statement. A stronger panel re-judges; its outcome is final. |
| Settle | Contract | Valid: `awards[class]` to the hunter (when the class is at or above the lowest counted), bond returned, finding published on IPFS, record updated. Duplicate: bond returned, no award, nothing published. Invalid: bond to the maker; the record counts the claim; nothing published. |
| + `revealWindowDays` | Anyone | A commit still unrevealed this long after its window ended is expired: bond to the maker, prepay back to the hunter, recorded as unrevealed. |
| Continue | Maker | The stake rolls to the successor hash with its own attested image; the record carries the lineage. **Close** withdraws the escrow after pending claims settle and ends the badge; the history stays. |

Three properties make the sequence hang together. The fix never reduces what
the hunter is paid, because judgement is against the committed hash. The
on-chain timestamp means a maker cannot fix the bug and then call it a known
issue: known issues count only if listed before the commit (§8.4). A maker who
never fixes is judged anyway when the window ends, and the valid unfixed finding
goes on their record.

The order — fix window first, judgement second — is chosen for one reason:
arbiter operators are a permissionless set. Judging at claim time would put a
live, unfixed exploit against deployed code in front of every operator. Judging
after the window means operators never see an unfixed finding; the hunter's
proof is what the maker was given, provably (§14). The price is that the hunter
tells the maker about the bug before anyone has confirmed it exists; the bond
and the record of bad-disclosure flags and false releases keep both sides
honest. The alternative, judge first and then open a fix window before
publishing, was rejected for the operator exposure (§19).

### 7.2 Interface changes

| Where | Change |
|---|---|
| `@verdikta/common` | Manifest key `codeReview`; schemas for `code_review.json` (with the `stake` block), `finding.json`, `known_issues.json`, `attestation.json` and the Verification Report; the trusted-builder key set; the two code ClassIDs with their envelopes and **hard limits**; pinned base-image (`node22`, `python312`, `foundry`), gVisor and Semgrep-rule versions and the OCI platform; the outcome set `[INVALID, DUPLICATE, LOW, MEDIUM, HIGH, CRITICAL]` and the settlement rule (§8.7); the severity-rubric id; the conformance canary's expected report hash |
| `code-runner/` (new) | `POST /v1/runs` `{ listingCid, bcid, spec, attestation, pocPatch, fixPatch, baseline, deadline }` → `{ report, reportSha256, contextPack }`; `GET /health`. Own `dockerd` with a fixed-size data disk (§9.1) |
| External Adapter | When the primary manifest has `codeReview`: verify the attestation and class envelope; run the **disclosure check** from the keys in the addendum (§14); compute the single deadline (§11) and pass remaining time to the runner and the AI Node; call the runner (shared per listing CID + bCID); settle gate and integrity failures as INVALID; otherwise pass the report, the context pack and the prior-finding summaries to the AI Node as named text attachments plus a structured `codeReview` field; strip the key line from the addendum before anything reaches a model; no sandbox re-run on retry |
| AI Node | `rank-and-justify` accepts optional `codeReview` (report, parsed claim, known issues, prior findings, `deadlineMs`): the claim pre-prompt with trust tiers and the four questions, Jev stage through an OpenRouter `systemone` client (annotating, never filtering) plus a Jev claim check on the justification, every non-Jev juror required, deadline-derived timeouts with cancellation, web access off |
| Chainlink job spec | `maxTaskDuration` and bridge timeout 300 s → 840 s |
| Aggregators | `setResponseTimeout(900)`; `setMaxOracleFee` above 0.0004 ETH for the premium class (§10.8) |
| `StakeAttestation` (new, verdikta-applications) | Escrow by award table bound to an artifact hash, with lineage; commit (archive hash + ciphertext CID) → fix window → reveal (bCID + keys); bond; bad-disclosure flag; release; dispute escalation; six-outcome settlement; `recordByHash`; the listing feed as events (§13) |
| Attestation site (verdikta-applications) | Listing flow with the disclosure key and the award table; builder Action, fallback workflow, validation report and **attestation signing**; baseline scan; record page and badge; feed API; the maker's decrypt-and-check step; the dispute form; `@verdikta/attest-check` for runtimes (§14) |
| Hunter tool (verdikta-applications) | `check` (the arbiters' pipeline minus the jury, locally), `commit` (encrypt to the disclosure key, pin the ciphertext, keep the keys beside the archive, send the transaction), `reveal`; optional paid pre-flight on the site's runner (§8.6) |

## 8. Listing and claim: the data contract

### 8.1 The listing spec: `code_review.json`

The listing archive's manifest gains one optional key,
`"codeReview": "code_review.json"`, with its schema in `@verdikta/common`. The
query names the six outcomes; the jury parameters name the class panel.

```json
{
  "version": 1,
  "kind": "bug",
  "artifact": { "kind": "contract", "address": "0x5f2A…", "chainId": 8453 },
  "repo": "https://github.com/acme/vault",
  "baseCommit": "7f3a9c…",
  "env": { "image": "ghcr.io/verdikta/stake-env@sha256:…", "from": "foundry",
           "platform": "linux/amd64", "unpackedBytes": 1400000000 },
  "attestation": "attestation.json",
  "commands": {
    "framework": "forge",
    "build":     "forge build",
    "test":      "forge test",
    "testFiles": "forge test --match-path $FILES",
    "testIds":   "forge test --match-test $TEST_IDS",
    "lint":      "forge fmt --check"
  },
  "baseline": "baseline.json",
  "paths": { "tests": ["test/**"], "protected": ["foundry.toml", "lib/**", ".github/**"] },
  "limits": { "cpus": 2, "memoryMb": 4096, "buildSeconds": 90, "testSeconds": 180,
              "runSeconds": 360, "maxPatchBytes": 2000000 },
  "stake": {
    "awards": { "LOW": "0", "MEDIUM": "0.1 ETH", "HIGH": "0.4 ETH", "CRITICAL": "2 ETH" },
    "lowestClassCounted": "MEDIUM",
    "bondWei": "20000000000000000",
    "fixWindowDays": 30,
    "disputeWindowHours": 72,
    "disclosureGraceHours": 48,
    "revealWindowDays": 7,
    "scope": { "include": ["src/**"], "exclude": ["test/**", "script/**"] },
    "knownIssues": "known_issues.json",
    "severityRubric": "immunefi-v2.3",
    "disclosureKey": "age1…",
    "valueAtRiskUsd": 1250000
  }
}
```

- `kind` is `bug`: the submission is a proof of concept, not a change. The field
  exists so the schema can carry another kind later; v1 accepts no other value.
- `artifact.kind` is `repo` (default when absent), `contract` or `skill`
  (§8.8). A `contract` listing carries the deployment and is checked at listing
  against verified source.
- Commands run **only inside the sandbox**, exactly as written, and the runner
  appends its own reporter flags for the declared `framework` (JUnit to a path it
  chooses). The tested program can still see that path and the arguments — it
  runs in the same process as the reporter — which is why in-process results are
  **tier-B evidence** subject to the integrity checks in §9.5. `testFiles` runs
  the hunter's PoC files; `testIds` re-runs named tests for the fixed repeat
  schedule. The only formats the runner parses are JUnit XML for tests and
  JSON/SARIF for linters.
- `baseline.json` is the per-test status at `baseCommit` over three runs: the
  `stable` set and the `unstable` set (excluded from the fix check up front;
  nothing learned later can add to it).
- `paths.tests` is where a PoC may add files; `paths.protected` is reset to the
  listed version before anything runs. A patch that touches anything else is
  INVALID (§10.1).
- `limits` may only **lower** the class's hard maxima (§9.1); a spec above them is
  a requester error.
- `attestation.json` is the builder's signed statement (§8.2). Without a valid
  one the archive is the requester's broken package: errored path, no commit.
- `stake.awards` are wei strings or `"<decimal> ETH"`, non-decreasing with
  severity; every class at or above `lowestClassCounted` must pay more than
  zero. `bondWei` is the hunter's bond (§10.8). `scope` restricts the paths a
  finding may name. `knownIssues` names the public list (§8.4). `disclosureKey`
  is the maker's dedicated encryption key (§14). `valueAtRiskUsd` is a
  declaration the record shows beside the stake.
- The maker supplies all of it; the environment build (§8.2) validates it before
  escrow can open.

### 8.2 Environment image, built at listing

The environment builder is a reusable GitHub Action published by Verdikta. A
maker whose repository has CI runs it there (the build job holds no secrets; a
separate job pushes the image); for everyone else the attestation site runs the
same Action in its own workflow. Either way the site validates the result before
escrow can open, by running steps 2–3 itself, and only then signs the
attestation (step 5). The Action:

1. Starts `FROM` a blessed base image (`node22`, `python312`, `foundry`; digests
   pinned in `@verdikta/common`, platform `linux/amd64`), clones `repo` at
   `baseCommit` and runs the maker's `setup` (`npm ci`, `uv sync --frozen`,
   `forge install`, …) with network access. For a `contract` listing it also
   checks the deployed bytecode's verified source against the repository's
   compiled artifacts at that commit; a mismatch stops the listing.
2. Runs `build` once and `test` **three times** at the commit with the same
   runner and gVisor release the arbiters use, without network. Tests that pass
   all three runs form the `stable` set; anything else is `unstable`. It
   records `baseline.json`, the timings and the image's unpacked size, and sets
   default limits to 3× the measured times plus the repeat-schedule reserve
   (§9.2). If that exceeds the 360 s `runSeconds` cap, the repository is too
   heavy for v1 and the listing stops here — this is what keeps §11's budget
   honest.
3. Proves the PoC harness: adds a trivially failing test and a trivially broken
   test under `paths.tests`, runs them through `testFiles`, and checks that the
   JUnit output distinguishes the **assertion failure** from the
   **collection or compile error**. A framework that cannot tell them apart
   cannot host claims (§10.1 depends on the distinction).
4. Pushes the image to a public registry (GHCR by default — public images cost
   nothing to store or pull; images over 2 GB compressed or 6 GB unpacked are
   rejected so arbiters can pull and store one inside their limits) and writes
   its digest, platform and unpacked size into `code_review.json`.
5. **Signs `attestation.json`:** image digest, platform, unpacked size, `repo`,
   `baseCommit`, SHA-256 of `code_review.json`, `baseline.json` and
   `known_issues.json`, and the runner, gVisor and rule-set versions used —
   signed with a key in `@verdikta/common`'s trusted-builder set. A digest pins
   bytes; the attestation states that validation happened on those bytes.

The maker sees this validation report before funding. Arbiters treat the image
like the rest of the listing: defined by the maker, public, content-addressed —
and, through the attestation, verified before escrow opened.

**How arbiters get it.** Arbiters learn nothing about a listing in advance. The
image digest travels in `code_review.json` inside the listing archive, which the
EA fetches from IPFS at evaluation time exactly as it fetches a rubric today;
the runner then pulls the image by digest into its own Docker data disk (§9.1),
after checking the attested unpacked size against that disk's free space. The
first pull per operator per listing costs 0–90 s (a 2 GB image at 50 MB/s is
about 40 s; the §11 budget allows for it), and every later claim against that
listing hits the cache. The work scales per staked version, not per claim or
per arbiter: one build of 5–25 CI minutes, 0.3–2 GB of registry storage with
the base layers shared, and on each arbiter a 40 GB fixed-size disk holding an
LRU cache (6–20 images) whose evictions only cost a re-pull. If registry
availability becomes a concern, the image tarball can also be pinned to IPFS as
a fallback source; v1 does not need it. Retention: an image lives until every
claim against its listing is settled plus 30 days.

### 8.3 Baseline scan

Between listing and open, the attestation site scans the staked version. It is
two things in one step, and it runs on the maker's code, never on a hunter's
claim:

- **A listing check.** Steps 2–3 of the build above: the code builds, the suite
  runs and is stable, the scope and test paths exist, the harness reports
  assertion failures distinctly. Without this, hunters' proofs could not be
  executed later.
- **A cheap first pass for bugs.** Semgrep with Verdikta's pinned rules and a
  secret scan over the in-scope paths, then one inexpensive agent pass: a single
  model from the `code-standard` pool reads the in-scope source with the scope
  and the severity rubric and lists candidate findings at or above the lowest
  counted class, each with a sketch of how it would be demonstrated. Findings go
  to the maker **privately**, from the site, which produced them.

The reason for the bug pass is economic. Finding the obvious bugs costs under a
dollar of inference. If escrow opened without it, the first scanner to see the
listing feed would claim the maker's stake for bugs the maker could have found
for a dollar. Clearing those out first means the stake money goes to findings
that take real work. It also gives every record a floor of attention: a record
showing zero claims and zero findings means an automated pass found nothing,
not that nobody looked — no record reads "0 of 0".

What the maker does with the scan: fix (a new version, listed in turn, with the
first as its predecessor), list as known issues (§8.4, public), or accept the
risk — anything neither fixed nor listed is claimable, and a hunter who proves
it is owed the award. The scan is **not a judgement and pays nobody**: nothing
from it enters the record, the jury or the known-issues list unless the maker
puts it there. It is funded by the listing fee (§10.8). The hunter-side
question "is my claim well put together" is a different thing, answered by the
free local check and the deterministic gates (§8.6, §10.1).

### 8.4 Known issues

`known_issues.json` is **public** and fixed at listing. Each entry is a
finding-shaped record the jury can compare a claim against:

```json
[ { "id": "sha256:…", "title": "Rounding favours the vault on withdraw",
    "class": "LOW", "paths": ["src/Vault.sol"],
    "description": "…one paragraph: what the behaviour is and why it is accepted…" } ]
```

A claim whose root cause matches an entry settles **DUPLICATE** (§8.7): bond
returned, no award. Hunters read the list before spending a prepay; readers see
what the maker has accepted. Public is the only workable form: the jury must
read the body to apply it, and a hash alone would make honest hunters forfeit
money on bugs they could not have known were excluded. Anything the maker will
not publish must be fixed before open or kept out by scope.

Known issues cannot be added after open. A maker who learns of an issue later
has two honest moves — fix it and roll forward, or leave it claimable — and both
are what the record is for. The ids are stored on-chain at listing so the
"listed before the commit" rule is checkable; the bodies travel in the listing
archive, which every arbiter already fetches.

### 8.5 The claim archive

The hunter's archive (the bCID of the evaluation) follows the existing
submitted-work contract — a manifest with a primary JSON whose `query` is the
report text — and carries:

- `finding.json`: the claimed class, a one-paragraph root-cause statement, the
  affected paths (all inside `stake.scope`), the PoC command and the observable
  it asserts. Schema in `@verdikta/common`.
- `report.md`: the narrative the jury and, when valid, the public read.
- `poc.patch`: a patch that **adds a proof-of-concept test** and touches nothing
  outside `paths.tests`. A patch that edits source is a fix and belongs in
  `fix.patch`.
- `fix.patch` (optional): a proposed fix. It is checked and reported (§9.2); it
  does not change the outcome (§20, decision 14).

The archive's bytes are fixed at commit: the on-chain commitment is
`sha256(archive)` plus the CID of the archive encrypted to the maker's
disclosure key. The content key and ephemeral key that unlock the maker's copy
are not in the archive; they travel in the reveal transaction (§14). The hunter
tool builds, encrypts, pins and keeps all of this.

### 8.6 Before anyone pays: local check, pre-flight, fee

The hunter pays the class prepay and posts the bond at commit (§10.8), so the
cheapest evaluation is the one that never reaches the network. Everything here
runs outside the consensus path, needs no determinism and can change freely.

**Local check, free and recommended.** `check` in the hunter tool runs the
arbiters' `code-runner` pipeline minus the jury on the hunter's machine against
the public image: `poc.patch` applies and touches only test paths; the PoC fails
at the staked hash as an assertion failure on three runs; the integrity checks
pass; with `fix.patch`, the PoC passes and nothing regresses; `finding.json`
validates and its paths are in scope. Same runner, image and rules as the
arbiters, so a run that passes every gate here passes them on-chain, barring
the nondeterminism the fixtures guard against (§18). For a security claim this
is the right place to iterate: nothing leaves the hunter's machine.

**Pre-flight on the site, optional, paid.** The same tiers on the site's warm
runner pool, for hunters without Docker:

| Tier | What runs | Time | Marginal cost | What the hunter learns |
|---|---|---|---|---|
| **0 — static** | Patch applies against a temporary index (`GIT_INDEX_FILE` from `git read-tree <baseCommit>` on a bare mirror; plain `git apply --check` needs a worktree); test-paths-only; size and binary checks; `finding.json` schema and scope | < 1 s | ≈ 0 | The `applies`, `testPathsOnly` and `inScope` gates exactly as the arbiters compute them |
| **1 — sandbox** | The full runner pipeline on the attested image, minus the jury | 1–6 min | ≈ $0.01–0.03 plus a warm pool | A **gate forecast** and the exact context pack the jurors will read |
| **1b — Jev readiness** | Jev's typed questions on the report and diff: class distribution, known-or-duplicate probability, required-behaviour probability | ~2 s | ≈ $0.003 | A **readiness** signal, labelled advisory: "the gates will pass; the jury is not the gates" |

Tier 1 carries a small fee for two reasons that have nothing to do with revenue:
without it the sandbox is free CI for anyone, and the pool costs money to keep
warm. The local check gives the same deterministic answer for free, so the fee
withholds no information. `preflightFeeWei` is a program constant (0.0001 ETH
≈ $0.24 proposed, about 10× marginal cost); it is **credited against the
prepay** when the hunter commits the same archive hash, and forfeited to the
attestation provider otherwise. One pre-flight in flight per wallet; a per-listing
daily cap. The site's runner sees the plaintext claim, so a hunter who uses it
trusts the attestation provider with an unfixed finding — the same party that
ran the baseline scan — and the tool says so. A cheap-LLM preview verdict is
deliberately not offered: it duplicates the real evaluation, invites iterating
against the jury, and a cheap model predicts the frontier jurors poorly.

**Jev at listing** (`noul` on the query, scope and known issues for
contradictions — a scope that excludes every source path, an award table that
pays nothing at the counted class) warns the maker; nothing is gated.
**Hunter-diligence text** in the tool and on the record page: read the scope,
the known issues and the rubric before working; run `check` before committing;
the prepay is spent whatever the verdict; the bond is forfeited on INVALID and
returned on DUPLICATE; the award is for the committed hash, not for the fixed
version.

### 8.7 Outcomes and settlement

**Outcomes** are `[INVALID, DUPLICATE, LOW, MEDIUM, HIGH, CRITICAL]`, in that
order. INVALID is first so the existing malformed-archive settlement (full mass
on the first outcome) means what it should. The jury's vector sums to
1,000,000 as today. The contract settles it with a **threshold `T`** (a program
constant; 500,001 — a strict majority — proposed, so an exact tie between two
classes settles to the lower one and a 50/50 split on validity is not valid)
and the following rule, chosen
because jurors disagree about adjacent classes far more often than about
validity, and a plain argmax would pay nothing on a 40/35/25 split between
three classes that all say "valid":

1. **Valid** when the mass on `LOW..CRITICAL` together is at least `T`.
2. If valid, the **class** is the highest `c` such that the mass on `c` and
   every class above it is at least `T` — the median class when `T` is a
   majority. The award is `awards[class]` when `class ≥ lowestClassCounted`,
   else nothing; the bond is returned; the finding is published either way.
3. If not valid, the outcome is **DUPLICATE** when its mass is at least
   INVALID's, else **INVALID**. DUPLICATE: bond returned, no award, nothing
   published, counted on the record. INVALID: bond to the maker, nothing
   published, counted.

The vector is recorded whatever the outcome. A gate failure arrives as the full
mass on INVALID, which is exactly when the bond is forfeited, so **the bond is
contract-observable**: the contract never has to tell a gate failure from a
jury rejection, because both forfeit.

**Duplicates settle in commit order.** A claim's reveal is accepted only when
every earlier commit on the same hash is settled or expired, and the evaluation
request for a claim carries the prior **valid** claims on that hash (§13.3), so
the jury can see what has already been found. Two hunters committing the same
root cause minutes apart therefore settle as: the first VALID and paid, the
second DUPLICATE with its bond back. A known issue listed before the commit is
DUPLICATE in the same way. Since fix windows of near-simultaneous commits end
minutes apart, the ordering costs little time.

### 8.8 Artifact kinds

`repo` — any repository at a commit on the `node22`, `python312` or `foundry`
image. `contract` — a `repo` plus a deployment address and chain id, with a
verified-source check at listing (§8.2); the record page links the deployment.
`skill` — a skills or MCP package (a `SKILL.md` or server manifest with its
scripts), judged on a harness image that runs the package's entry points in the
sandbox and records attempted network, file and process activity as tier-A
facts, against which the PoC asserts. `repo` and `contract` are Phase 1;
`skill` follows once the harness exists (§17).

## 9. The code runner

### 9.1 Placement and isolation

- `code-runner/` is a small Node service, like the EA, listening on `127.0.0.1` or
  a Unix socket with a shared token. It **holds no secrets**. It drives Docker
  with argv arrays, never a shell, and never executes claim content on the
  host — `git apply` included runs inside the container.
- Every run gets a **fresh container** from the env image:
  `--runtime=runsc` (gVisor), `--network none`, `--cap-drop ALL`,
  `--security-opt no-new-privileges`, a non-root user, `--pids-limit`,
  `--memory` equal to `--memory-swap`, `--cpus`, a capped scratch overlay
  (`--overlay2=root:dir=…,size=…`; the `self` medium fails on kernel 5.4), no bind
  mounts, no Docker socket. Nothing survives from one claim to the next
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
  The site's validator is a convenience for makers, not the arbiter's defence:
  the request API accepts any CID.
- **Attestation before work.** The EA verifies `attestation.json` against the
  trusted-builder keys and checks that its hashes match the archive's
  `code_review.json`, `baseline.json` and `known_issues.json`, and the image
  digest and platform. Missing or invalid → the requester's package is broken
  (errored path, no commit), identically on every arbiter.
- Results are read out as capped byte streams (`docker exec … cat`, never
  `docker cp` to a host path). JUnit XML is parsed with entity expansion off. Logs
  are cut to a 32 KiB head/tail per step.
- **Two placement modes.** `local` (default) runs gVisor on the arbiter host, as
  the verdikta-agents P5 gate did beside a live mainnet arbiter. `remote` points
  `CODE_RUNNER_URL` at a separate small VPS, for operators who want untrusted code
  off the key machine altogether.

### 9.2 Pipeline for one claim

1. **Admit.** Take a slot; keep a memory reserve for Chainlink, Postgres, the AI
   Node and the largest Ollama model; refuse while an install or upgrade runs;
   refuse when the remaining time (§11) cannot cover the run. When several of the
   operator's jobs are selected for the same request, they share one run, keyed
   by **listing CID + claim bCID + runner version + rule-set version** — every
   execution input (spec, baseline, image digest, patches) is content-addressed
   by those two CIDs; the prior-finding archives in the request feed the jury,
   not the run, and are not part of the key. This mirrors `cidFetchCache.js`
   for IPFS downloads.
2. **Pull** the env image by digest from the allow-listed registry into the
   runner's own disk, after the size admission check. Images are cached and
   evicted least-recently-used.
3. **Apply `poc.patch`** (the `applies` gate). Before any claim code runs,
   compute the diff stats and the touched paths; every touched path must be
   inside `paths.tests` and none inside `paths.protected` (the `testPathsOnly`
   gate); record the flags (existing tests modified, skip markers added,
   framework or reporter modules referenced) and build the **context pack**
   (§10.3). Commit the result inside the container with a fixed author and date.
4. **Reset protected paths** to the listed version, as in SWE-bench: the
   framework configuration, lockfiles and CI files are always the maker's.
5. **Build** (the `build` gate). A PoC that breaks the build is not a
   demonstration of anything.
6. **Run the PoC** with `testFiles` on the hunter's files and the runner's
   reporter flags; parse JUnit. The **`reproduces` gate**: every test the patch
   added fails **as an assertion failure** — not an error, import, compile or
   collection failure — on all three runs of the **fixed repeat schedule**
   (`testIds` for the re-runs, time reserved inside `runSeconds` at listing).
   A PoC test that passes on any run or errors on any run fails the gate: a
   flaky exploit is not a demonstrated one, and a hunter whose bug is timing-
   or randomness-dependent writes the loop into the test. Nothing observed
   during the run can exempt a test, so two arbiters with different time left
   reach the same verdict from the same observations.
7. **Integrity checks** on the PoC run (§9.5): identity completeness,
   framework-summary consistency, exit-code consistency, post-run checksums of
   protected paths and installed dependencies, static tamper and honesty flags.
   Any failure turns the gates that depend on in-process results into failures
   and is named in the report.
8. **Fix check** (only when `fix.patch` is present; informational). In a second
   container: apply `fix.patch` (it may touch source; it may not touch
   `paths.tests` or protected paths), build, run the PoC (expected to pass), run
   the full suite and compare with `baseline.json` (regressions against the
   `stable` set), then the integrity checks. The report records
   `fix: { applies, builds, pocPasses, regressions }`; the outcome does not
   depend on it (§20, decision 14).
9. **Lint and SAST.** Semgrep with Verdikta's pinned offline rules over the
   PoC test files for **environment manipulation** — overwriting the target's
   storage or code (`vm.store`, `vm.etch`), stubbing or mocking the module under
   test, patching globals, network or filesystem reach outside the repository,
   clock manipulation beyond what the framework provides — recorded as
   **honesty flags**, tier-A facts about what the test does, for the jury's
   fourth question; and, when `fix.patch` is present, the repository's linter
   and Semgrep (`--baseline-commit` = the listed commit) over the fixed files.
   All findings are kept, severity-ordered and bounded at 50; nothing downstream
   removes them.
10. **Report** and tear down at or before the deadline the EA passed in. A
    host-side GC timer removes anything a crash left behind.

### 9.3 Determinism rules

- **Pinned:** env image digest, OCI platform (`linux/amd64`), runner version,
  gVisor release, base images and Semgrep rules, all versioned in
  `@verdikta/common`. The report records every input digest — listing CID, bCID,
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
  calibration set includes time- and randomness-dependent PoCs and the exit
  criterion is agreement on them across hosts.
- **Settle only on definitive failures:** a clean non-zero exit, a JUnit
  outcome, a failed integrity check. A step that hits its wall-clock limit, the
  memory or process limit, or a dead sandbox makes the arbiter **abstain** — an
  error with no commit, the same rule that covers transient IPFS and AI failures
  today (and not a neutral outcome; see §12).
- **Identical LLM input:** the report the jury sees has no durations, host names,
  paths or per-run output directories, so every arbiter's jury reads the same
  bytes. The SHA-256 of the report's canonical JSON is logged and published in
  the justification.

### 9.4 Verification Report (abridged)

```json
{
  "schema": "verdikta.claim-report/1",
  "inputs": { "listingCid": "Qm…", "bcid": "Qm…", "envImage": "sha256:…", "platform": "linux/amd64",
              "attestationSha256": "…", "baseCommit": "7f3a9c…", "pocPatchSha256": "…",
              "fixPatchSha256": "…", "runner": "1.0.0", "gvisor": "20260928.0", "semgrepRules": "2026.10" },
  "gates": { "disclosure": "pass", "applies": "pass", "testPathsOnly": "pass", "inScope": "pass",
             "build": "pass", "reproduces": "pass", "integrity": "pass", "claimedObservable": "pass" },
  "poc": {
    "tier": "B",
    "tests": [ { "id": "test/Exploit.t.sol > test_withdraw_reentrancy_drains_vault",
                 "runs": ["fail","fail","fail"], "kind": "assertion",
                 "message": "assertion failed: vault balance 0 after single withdraw" } ],
    "integrity": { "identityComplete": true, "summaryConsistent": true, "exitConsistent": true,
                   "protectedPathsUnchanged": true, "dependenciesUnchanged": true, "tamperFlags": [] },
    "honestyFlags": []
  },
  "fix": { "present": true, "applies": "pass", "builds": "pass", "pocPasses": true,
           "regressions": [], "tier": "B" },
  "build": { "status": "pass", "tier": "A" },
  "findings": [ { "tool": "semgrep", "rule": "solidity.reentrancy-no-eth", "severity": "high",
                  "file": "src/Vault.sol", "line": 88, "message": "…", "triage": null } ],
  "flags": { "existingTestsModified": [], "skipMarkersAdded": [], "protectedPathsTouched": [] },
  "diff": { "poc": { "files": 1, "added": 64, "removed": 0 }, "fix": { "files": 1, "added": 6, "removed": 2 } }
}
```

`triage` is filled in later by the AI Node's Jev stage (§10.2) and is an
annotation only; the finding list the runner produced is what every juror sees.

### 9.5 Evidence trust tiers and integrity checks

gVisor separates the sandbox from the host. It does **not** separate the grader
from the program inside the sandbox: the PoC test imports the code under test,
and that code — or the test itself — sees the reporter's arguments and output
path and runs as the same user. A test can write a "failing" JUnit record
without ever exercising the code, or `exit(1)` from import. The report
therefore labels every fact with how it was observed, and the jury prompt and
the gates treat the tiers differently.

| Tier | Observed by | Facts | Treatment |
|---|---|---|---|
| **A** | The runner or the EA, from outside the tested process | The disclosure check; patch applies; touched paths; diff facts and flags; build exit code; step exit codes and limit events; lint/SAST and honesty flags (tools run on the source, not by it); the attestation and image | Fact. Jurors may not contradict it. |
| **B** | A process that executed claim code | JUnit results of the PoC run and the fix check | Strong evidence, gated **only when every integrity check passes**; the diff can contradict it; a tamper finding overrides it. |

Integrity checks on tier-B evidence (all deterministic, all run by the runner):

1. **Identity completeness** — the JUnit contains every test the patch added
   exactly once, with no skipped records; for the fix check, every baseline
   `stable` identity as well.
2. **Framework-summary consistency** — the framework's own stdout summary
   (counts of passed/failed/skipped) matches the JUnit.
3. **Exit-code consistency** — the test command exits non-zero if and only if
   the JUnit reports a failure; an exit before the summary is an error, not a
   failure, and fails `reproduces`.
4. **Post-run checksums** — protected paths, the framework and reporter
   modules, and installed dependencies (`node_modules`, `site-packages`, `lib/`)
   hash the same after the run as in the image plus the accepted patch.
5. **Static tamper flags** — test code that references the report path or
   `$OUT`, calls `process.exit` / `os._exit` / `atexit` / signal handlers
   during import, patches the framework or reporter, or writes outside the
   repository.

Any failed check sets `gates.integrity = fail`: `reproduces` fails with it, the
report names the check, and the claim settles INVALID deterministically. A
clean claim is unaffected: none of these checks fires on ordinary test code.

Honesty flags (§9.2, step 9) are the softer cousin: they do not fail a gate,
because a legitimate exploit test sometimes needs an unusual fixture, but they
are tier-A facts the jury must weigh under its fourth question, and the
adversarial fixtures (§18) measure how often a manipulated PoC gets past both.

### 9.6 What we borrow from verdikta-agents

The verdikta-agents coding sandbox (`packages/sandbox-kit`, on its `origin/main`)
already runs gVisor next to live arbiters. What carries over and what changes:

| verdikta-agents | For arbiter judging |
|---|---|
| gVisor as an extra Docker runtime, pinned by SHA-512, added with `systemctl reload docker`, never a restart | Same |
| Admission control: memory reserve that includes the largest local model, refusal during install/upgrade, no swap | Same |
| Capped scratch per sandbox, head/tail output capture, in-container timeout plus host backstop, plain "sandbox died" reasons | Same |
| No credential ever enters the sandbox; the trusted side streams code in and reads results out | Same; arbiters need no GitHub token at all |
| Host-side GC timer | Same, for sandboxes that live minutes rather than 14-day workspaces |
| Fixed-size loop-mounted ext4 image per workspace | The same technique, as the runner's whole Docker `data-root`: pulls and extraction are bounded by it |
| Open egress with a deny list | **No network** while judging |
| SSH forced-command gate running as root | A local service on a socket; no SSH, no root login |
| Root inside the container, default capabilities | Non-root and `--cap-drop ALL`, on top of gVisor |
| Bash written by a model | A fixed pipeline running only the maker's declared commands |

## 10. Judging

### 10.1 Deterministic gates (EA)

When a gate fails, the EA builds a verdict with the full 1,000,000 on the first
outcome (INVALID) and a justification naming the gate and its evidence — for
example the PoC test that passed on run two, or the path outside `paths.tests`.
The verdict takes the normal commit/reveal path; neither Jev nor a frontier
model is called, and the bond is forfeited at settlement. None of these gates
can be switched off by the listing.

| Gate | Where | Fails when |
|---|---|---|
| `disclosure` | EA, before any pull | the revealed archive does not hash to the committed `sha256(archive)`, or re-encrypting it with the revealed keys to the listing's `disclosureKey` does not reproduce the pinned ciphertext byte for byte (§14) |
| `inScope` | EA, static | `finding.json` is invalid, or an affected path is outside `stake.scope` |
| `applies` | runner | `poc.patch` does not apply to the listed commit |
| `testPathsOnly` | runner | the patch touches a path outside `paths.tests` or inside `paths.protected` — source edits belong in `fix.patch` |
| `build` | runner | the build fails after the patch |
| `reproduces` | runner | any PoC test passes, or errors (import, compile, collection), on any run of the fixed schedule |
| `integrity` | runner | any check of §9.5 fails on the PoC run |
| `claimedObservable` | runner | the tests `finding.json` names are not the ones that failed, or the asserted observable does not appear in the recorded failure |

What the gates do not decide is left to the jury: whether the failing test
asserts behaviour the code was ever required to have, how severe the
consequence is, whether it is already known, and whether the fixture is honest.

### 10.2 Jev: cheap typed judgements (AI Node)

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
| Under the listing's severity rubric, which class is this finding? | `choice` (LOW / MEDIUM / HIGH / CRITICAL) | Rubric juror; frontier checklist |
| Is the behaviour the PoC asserts required by the specification, documentation or scope? | `noul` | Rubric juror; frontier checklist |
| Each known issue, each prior valid finding on this hash (one per request): is this the same root cause? | `noul` | Rubric juror; frontier checklist |
| Does the PoC manipulate the environment, mock the code under test, or rely on an out-of-scope assumption? | `noul` | Honesty flag for the frontier jurors |
| Each new lint/SAST finding on `fix.patch` (up to 50, with ±20 lines of code): is it a real defect the fix introduced? | `noul` | **Annotates** the finding (`triage`) for the jurors; never removes it |

Rules: pin the model (`typesafe/jev-1.13`, or its dated snapshot
`typesafe/jev-1.13-20260917`; never `~typesafe/jev-latest`, so every arbiter asks
the same model); one judgement per question; one known issue or finding per
request, carrying the report summary and only the hunks that matter to it, under
32 KB; all arithmetic in code; a fixed option order.

A request looks like this (`POST https://openrouter.ai/api/v1/systemone`):

```json
{
  "model": "typesafe/jev-1.13",
  "state": { "scope": "…listing scope and rubric…", "evidence": "…report summary…",
             "claim": "…finding.json and report…", "poc": "…poc.patch hunks…" },
  "questions": {
    "class": {
      "type": "choice",
      "instructions": "Under the Immunefi v2.3 classification for smart contracts, which severity does the demonstrated consequence in `evidence` and `claim` fall in?",
      "options": ["LOW", "MEDIUM", "HIGH", "CRITICAL"]
    },
    "env_manipulation": {
      "type": "noul",
      "instructions": "Does `poc` overwrite the target's storage or code, mock the module under test, or assume a precondition that `scope` excludes?"
    }
  }
}
```

**The rubric juror.** Jev also sits in the panel's `AI_NODES` with a small
weight, and its answers are turned into a six-outcome vector by a fixed rule,
spelled out because the mapping decides what a 0.2 weight means:

1. `p_dup` = the largest "same root cause" probability over the known issues and
   prior findings; mass on DUPLICATE = `p_dup`.
2. `p_valid` = `p_required × (1 − p_manipulation)`; mass on INVALID =
   `(1 − p_dup) × (1 − p_valid)`.
3. The remaining mass, `(1 − p_dup) × p_valid`, is spread over LOW..CRITICAL by
   the class distribution.
4. Rounded by largest remainder so the sum is exact.

TypeSafe says its distributions are only weakly calibrated as magnitudes, so the
mapping is tuned on the calibration set in Phase 2 (falling back to thresholds
if it must). Fixtures before Jev scores anything: clear-valid, clear-invalid,
known-issue, duplicate-of-prior, boundary probabilities (0.49/0.51) on each
question. Its justification is a deterministic table of its answers.
Implementation: a `systemone` client beside the OpenRouter provider (a native
TypeSafe key is optional, under the usual `AI_GATEWAY` rules) and one branch in
`queryModel` (`ai-node/src/app/api/rank-and-justify/route.ts`) that returns a
decision vector directly instead of parsing model text.

**If Jev fails** (timeout, 429, malformed answer), the frontier jurors proceed
with the checklist marked "unavailable — decide everything yourself", every
finding shown without triage, and Jev's weight **dropped, not redistributed**
(§10.5). Jev never decides a gate, never sees anything the frontier jurors
don't, and never removes anything from what they see.

**Claim check on the justification.** After the justifier writes the
justification, each sentence that asserts an execution fact ("the PoC fails on
all three runs", "no regression with the fix", "the Semgrep finding is a false
positive") is checked against the Verification Report with one `choice` question
per claim — `supports` / `contradicts` / `says_nothing`, TypeSafe's own
citation-check recipe. A claim the report contradicts is annotated in the
uploaded justification ("⚠ the report shows the fix did not pass the PoC") and,
if the deadline reserve allows, the justifier is re-run once with the
contradiction pointed out. Scores are never touched. Cost ≈ $0.002 per
evaluation; the justification is what makers, hunters and the public read, so a
hallucinated "reproduced" is the most visible failure the system can have.
This runs per arbiter on that arbiter's own text, so it needs no cross-arbiter
determinism.

**What Jev is deliberately not used for.** TypeSafe's cookbooks were reviewed
for further uses (re-ranking, RAG-passage filtering, confidence-gated routing,
cascades, guardrails, self-consistency). Two rules decide: Jev may not change
the bytes the frontier jurors see — TypeSafe's own re-ranking recipe notes that
repeated scoring can vary, and divergent inputs across arbiters would mean
divergent verdicts — and it may not add a decision the panel then depends on.
So: no Jev-ranked context pack (the pack is built by deterministic rules), no
confidence-gated third juror (the panel is fixed in the manifest for every
arbiter), no cascade that skips a juror.

### 10.3 Frontier jury: the four questions (AI Node)

The existing multi-model `rank-and-justify`, with a claim pre-prompt. Input:

1. The listing's query — the artifact, the scope, the award table and the
   severity rubric's class definitions for this artifact kind — unchanged from
   the archive.
2. The Verification Report with each fact's **trust tier** (§9.5): tier A is
   fact; tier B is strong evidence the diff can contradict; any integrity or
   honesty flag is shown first.
3. **Every** lint/SAST finding the runner kept, with Jev's `triage` as an
   annotation. Jev is one model at 0.2 weight; letting it remove findings would
   make it an evidence filter for the whole jury, and TypeSafe documents its
   susceptibility to adversarial state.
4. The Jev checklist. Low-confidence answers (confidence below 0.6, or a
   probability between 0.3 and 0.7; both tunable) are marked "decide this
   yourself".
5. The **context pack**, built by the runner, deterministic and budgeted (the
   class envelope sets it, §10.4; 60k tokens for standard), in priority order:
   `poc.patch` with function context (`git diff -W`) and the full text of the
   PoC files; `finding.json` and `report.md`; the full post-listing text of the
   in-scope source files the finding names; call sites of the symbols the PoC
   exercises (`git grep -w`, at most 10 each); `known_issues.json`; the
   `finding.json` summaries of prior valid claims on this hash (§13.3); the fix
   diff when present; a shallow file tree. Over budget, the lowest tiers are
   dropped and the pack says so.
6. On a dispute, the maker's statement (bounded, §13.2), fenced as the maker's
   argument.

The prompt asks each juror four questions, and to put its answer in the
six-outcome vector:

- **Required?** Is the behaviour the PoC asserts something the code is required
  to have — by its specification, documentation, interface contract, or the
  listing's scope? A test that fails because it asserts an intended behaviour
  is not a finding.
- **How severe?** Under the listing's rubric, what is the demonstrated
  consequence: funds at risk, how much, for whom, with what preconditions? Count
  only what the PoC demonstrates or what follows from it by a concrete line of
  reasoning tied to a file and line.
- **Known or duplicate?** Is the root cause a listed known issue, or the same as
  a finding already valid on this hash? Rewording, a different entry point or a
  different victim does not make a new root cause.
- **Honest?** Is the PoC minimal and faithful: no overwritten storage, no mocked
  target, no precondition the scope excludes, no fixture that creates the bug it
  then finds? Weigh the honesty flags; a flag is a fact, its meaning is the
  juror's call.

and to never contradict tier-A facts, to weigh tier-B results against the diff,
and to treat a tamper finding as overriding a recorded failure.

Web access is forced off in code mode; the repository URL would otherwise turn
it on under `AI_WEB_ACCESS=auto`. Code mode takes its request deadline from the
EA (§11) instead of the fixed `REQUEST_TIMEOUT_MS` / `MODEL_TIMEOUT_MS`, cancels
jurors at that deadline rather than racing them, and runs frontier jurors at
effort `high`.

In v1 the jurors see only the context pack. Phase 3 adds **juror exploration**
(§17, §19): a local `read_file` / `grep` tool served by the AI Node from the
runner's checkout, so a juror can pull in a caller or a config file the pack
dropped; and, for `code-premium`, an optional provider-hosted shell where the
juror runs its own probe tests. Whatever a juror finds this way is its own
observation — it goes into that juror's text and vector, never into the
Verification Report, and it may differ between arbiters just as juror text does.

### 10.4 Two evaluation classes: envelopes

A ClassID is the pool of models an operator must serve; the listing picks the
panel — models, weights, iterations — from that pool in the manifest's
`AI_NODES`. Each price tier is a **class**, each with an **envelope** the arbiter
enforces, because `ReputationKeeper.selectOracles` takes every active job in the
class whose registered `fee <= maxFee` and the aggregator pays the **registered**
fee: a premium request with a 0.0007 ETH ceiling would otherwise select a job
registered at the standard fee and hand it the premium panel's bill.

| | `code-standard` | `code-premium` |
|---|---|---|
| Pool | `typesafe/jev-1.13`, `deepseek-v4-pro`, `kimi-k2.7-code`, `qwen3-coder`, `glm-5.3`, `mimo-v2.6-pro`, `gpt-oss-120b`, `claude-haiku-5-5`, `gpt-6-luna`, `claude-sonnet-5-5`, `gpt-6-sol`, `gpt-5.6-terra`, `grok-4.7` | the standard pool plus `claude-opus-5-5`, `gpt-6-astra` |
| Panel | ≤ 3 models, `NO_COUNTS` 1, `ITERATIONS` 1 | same |
| Context pack / juror output | 60k / 8k tokens | 120k / 12k tokens |
| Sandbox | class hard limits (§9.1) | same |
| Serves | listings whose top award is up to ≈ $1k; disputes on them | listings above ≈ $1k; disputes escalated from standard |
| Operator spend per evaluation | ≈ $0.25 (dispute panel ≈ $0.45) | ≈ $1.40–2.00 |
| Registered fee (indicative) | 0.00012 ETH ≈ $0.29 | 0.0007 ETH ≈ $1.70 (above today's ceiling, §10.8) |
| Hunter prepay (12×) | ≈ $3.50 | ≈ $20 |

The envelope is enforced on the arbiter, not only in the UI: today nothing in the
EA or AI Node reads the classmap's `max_panel_size`, `max_no_counts` or
`max_iterations`, so code mode adds that check — a manifest whose `AI_NODES`,
counts, iterations or requested budgets fall outside the class envelope is a
requester error (errored path, no commit) before any model is called. Both
classes carry the runner conformance requirement (§16); the pools add
`claude-opus-5-5`, `claude-sonnet-5-5` and the open-weight coders, which
classmap 1.6.0 does not list yet. Whether the open-weight models judge security
claims as accurately as the frontier pair is exactly what the calibration set
measures per class (§18), and a class whose accuracy falls short is withdrawn,
not discounted.

Per-juror cost, OpenRouter list prices on 2026-10-19:

| Model in the pools | $/M in / out | 60k in / 8k out | 120k in / 12k out | Role |
|---|---|---|---|---|
| `gpt-6-astra` | 10 / 50 | — | $1.80 | Premium deep review |
| `claude-opus-5-5` | 4 / 20 | — | $0.72 | Premium deep review |
| `claude-sonnet-5-5`, `gpt-6-sol`, `gpt-5.6-terra` | 2 / 10–12 | ~$0.20 | ~$0.38 | Standard deep review; dispute panel |
| `grok-4.7` | 2 / 6 | $0.17 | $0.31 | Standard, third opinion |
| `kimi-k2.7-code` | 0.67 / 3.35 | $0.067 | $0.12 | Open-weight code review |
| `deepseek-v4-pro` | 0.42 / 0.84 | $0.032 | $0.06 | Open-weight code review |
| `mimo-v2.6-pro` | 0.43 / 0.87 | $0.033 | $0.06 | Open-weight code review |
| `qwen3-coder` | 0.30 / 1.00 | $0.026 | $0.05 | Open-weight code specialist |
| `glm-5.3` | 0.08 / 1.40 | $0.016 | $0.03 | Open-weight code review |
| `gpt-oss-120b` | 0.15 / 0.60 | $0.014 | $0.03 | Open-weight, third opinion |
| `claude-haiku-5-5`, `gpt-6-luna` | 0.1 / 0.5 | $0.010 | $0.02 | Justifier; cheap juror |
| `typesafe/jev-1.13` | 0.042 / free | <$0.01 | <$0.01 | Rubric juror, triage, claim check |

Panels the site offers, each bound to its class. A listing pins two archives at
listing time — the evaluation archive and the dispute archive — whose only
difference is the panel:

| Panel | Class | Models | Operator spend per arbiter |
|---|---|---|---|
| Standard | `code-standard` | Jev 0.2, `claude-sonnet-5-5` 0.4, `deepseek-v4-pro` 0.4 | ≈ $0.25 |
| Standard dispute | `code-standard` | Jev 0.2, `claude-sonnet-5-5` 0.4, `gpt-6-sol` 0.4, effort `high` | ≈ $0.45 |
| Premium | `code-premium` | Jev 0.2, `claude-opus-5-5` 0.4, `gpt-6-astra` 0.4 | ≈ $1.40 |
| Premium dispute | `code-premium` | Jev 0.2, `claude-opus-5-5` 0.4, `gpt-6-astra` 0.4, `ITERATIONS` 2 where the envelope allows, else effort `max` | ≈ $2.00 |

A dispute escalates one class — standard to premium — once the fee ceiling
admits premium jobs; until then, and for listings already on premium, it runs
the class's dispute panel. The panel sets the oracle fee the maker must offer
(§10.8). A mixed-fee selection test — a request on one class must never select a
job registered on another — is a Phase 0 deliverable.

### 10.5 Final vector and the partial-success rule

Scoring is unchanged: the weighted average over `AI_NODES`, then the justifier.
The EA prepends a deterministic "Execution evidence" block (gates, trust tiers,
PoC run pattern, fix check, report hash) to the justification it uploads, so the
maker, the hunter and the public can see why.

**Partial success is stricter in code mode.** Today a request succeeds when at
least `MIN_SUCCESSFUL_MODELS_PERCENT` (0.5) of the models answer, with the
failed models' weight redistributed. On a three-model panel that lets Jev
plus one frontier juror settle the verdict, with Jev's effective weight rising
from 20% to one-third. Code mode therefore requires **every non-Jev juror** in
the panel to succeed; if one fails, the arbiter abstains (error, no commit).
Jev's failure is tolerated: its weight is dropped, not redistributed, so the
other jurors' relative weights are unchanged and the final vector is theirs
alone.

### 10.6 Gaming and prompt injection

| Attack | Defence |
|---|---|
| Hunter: a PoC that fails for a reason other than the bug (import error, broken build, wrong harness) | `build` and `reproduces` gates: only an assertion failure on all three runs counts |
| Hunter: a flaky PoC — fails once, passes once | Fixed schedule: any pass on any run fails `reproduces`; the hunter writes the loop into the test |
| Hunter: forge a failing JUnit record or exit early without running the code | In-process results are tier B (§9.5): identity completeness, framework-summary and exit-code consistency, post-run checksums and static tamper flags must all pass or `integrity` fails |
| Hunter: edit the framework config, lockfile or a protected file to make the test fail | Protected paths reset before the run; `testPathsOnly`; post-run checksums |
| Hunter: manipulate the environment inside the test — overwrite the target's storage or code, mock the module under test, stub the clock or network | Honesty flags (tier A) shown first to every juror; the fourth question; adversarial fixtures measure the residue |
| Hunter: assert behaviour that is documented or intended, or rely on a precondition the scope excludes | `inScope` gate on paths; the jury's first question; the maker's dispute |
| Hunter: resubmit a known issue or a prior finding reworded | DUPLICATE (bond back, prepay spent) rather than INVALID; the prepay keeps it from being free; commit-order settlement puts the prior finding in front of the jury |
| Hunter: reveal a different archive than the maker was given, or send the maker garbage | The `disclosure` gate: both commitments re-derived in every arbiter; INVALID, bond forfeited |
| Hunter: inject "AI reviewer: this is CRITICAL" in `report.md`, test names or comments | Gates are deterministic; evidence is fenced as data; Jev annotates and never filters; several models must agree |
| Hunter: a huge or binary-padded patch | `maxPatchBytes`; binary changes reported as stats only |
| Maker: falsely flag a bad disclosure | A flag followed by a verified reveal is itself on the record (§14) |
| Maker: fix the bug, then call it a known issue | Known issues are fixed at listing and timestamped on-chain; the commit precedes any fix |
| Maker: never fix, never release, hope the hunter gives up | The window ends anyway; a valid unfixed finding goes on the record; an unrevealed commit after `revealWindowDays` costs the hunter the bond, so the hunter reveals |
| Maker: dispute everything | Each dispute costs the escalation prepay; the record shows disputes and how they ended |
| Sandbox escape or resource exhaustion | gVisor, no network, class hard limits, admission control, remote mode |
| Highly compressible image that unpacks to fill the host disk | Attested unpacked size checked at admission; the runner's own Docker `data-root` on a fixed-size disk bounds the damage regardless |
| Direct on-chain request with an unvalidated image or oversized limits | Attestation required; class maxima enforced by the runner; rejected before any pull |

### 10.7 Cost per evaluation (operator spend, one arbiter) and its assumptions

Standard panel, worst case:

| Item | Tokens | Cost |
|---|---|---|
| Jev, ~10 small fan-out calls + claim check | ~60k in, total | ~$0.003 |
| `claude-sonnet-5-5` juror ($2 / $10 per million tokens) | 60k in / 8k out | ~$0.20 |
| `deepseek-v4-pro` juror ($0.42 / $0.84) | 60k in / 8k out | ~$0.03 |
| Justifier (`claude-haiku-5-5`, $0.10 / $0.50) | 15k in / 2k out | <$0.01 |
| Sandbox compute (2 vCPU × ≤ 6 min at ≈ $0.03 per vCPU-hour; two containers with a fix) | | <$0.01 |
| **Total** | | **≈ $0.25**; a claim that fails a gate ≈ $0.01 |

The standard dispute panel (`gpt-6-sol` in place of `deepseek-v4-pro`) ≈
**$0.45**. Premium (`claude-opus-5-5` $0.72 + `gpt-6-astra` $1.80 on a 120k pack
+ Jev) is bounded at ≈ **$2.60** and expected around $1.40–2.00 on packs that
rarely fill the budget.

**The assumptions behind these numbers**, so they can be challenged one by one:

1. **Six arbiters do the full work.** K = 6 are polled to commit, 4 reveal, 3 are
   aggregated, but a commit needs the finished evaluation, so all six spend. A
   third of the network's work is structurally unused; K/M/N are global per
   aggregator, so a class cannot lower them (a dispatcher roadmap item).
2. **60k input tokens** is a claim whose named source files fill most of the
   standard pack budget. A PoC against one contract file produces 15–25k.
   Pricing is at the cap; the average is lower.
3. **8k output tokens** per juror covers the four answers with file:line
   reasoning. Premium allows 12k.
4. **Every claim reaches the jury.** Gate failures cost ≈ $0.01 (sandbox
   only), so the average falls with the gate-failure rate; the local check
   (§8.6) pushes most sure-failures out before anyone pays.
5. **List prices on OpenRouter, 2026-10-19**, no caching (the two jurors are
   different providers; nothing repeats within an arbiter) and no batch pricing
   (batch latency does not fit a 15-minute round).
6. **Operators price at worst case plus ≈ 20%**, since the on-chain fee cannot
   depend on how the evaluation went.

### 10.8 Money: who pays

**The prepay, as today.** A request's requester prepays
`maxOracleFee × (K + bonusMultiplier × clusterSize)`, 12× the per-oracle fee on
both aggregators (6 + 3 × 2), with the unused part refunded as an `ethOwed`
credit the requesting contract passes back. With the text-bounty default fee of
0.00002 ETH and ETH at about $2,420 (Chainlink ETH/USD on Base, 2026-10-17) that
is $0.048 per oracle and a $0.58 prepay. An arbiter therefore earns about 5¢
per text evaluation; the standard claim panel costs it about 5× that and
premium about 30×. Per-oracle fee = worst-case operator spend (§10.7) × ≈ 1.2,
rounded; prepay = fee × 12; dollars at $2,420/ETH.

| | Per-oracle fee | Prepay (12×) | Under the ceiling? |
|---|---|---|---|
| Today's default (text bounties) | 0.00002 ETH ≈ $0.05 | 0.00024 ETH ≈ $0.58 | yes |
| `code-standard` (≈ $0.25; dispute ≈ $0.45) | 0.00012 ETH ≈ $0.29 (dispute 0.0002 ETH ≈ $0.48) | 0.00144 ETH ≈ $3.50 (dispute ≈ $5.80) | yes (ceiling 0.0004 ETH ≈ $0.97) |
| `code-premium` (≈ $1.40–2.60) | 0.0007 ETH ≈ $1.70 | 0.0084 ETH ≈ $20 | no — needs `setMaxOracleFee` (aggregator owner) |

The payment path pays each selected job its **registered** fee, so raising the
ceiling alone buys nothing: the `code-premium` class's jobs must themselves be
registered at the premium fee, and the ceiling must admit them. That is why the
tiers are classes (§10.4). Within a class, operators register at a fee that
covers their spend; arbiters priced above the listing's `maxOracleFee` are
ineligible; the panel sets `maxOracleFee`.

**Hunter.** Pays the class prepay per claim at commit, spent whatever the
verdict, and posts a **bond**, returned on any valid or DUPLICATE outcome and
forfeited to the maker on INVALID. The bond is the slop filter. A claim with
probability *p* of being wrongly paid is worth sending when *p* × award > bond,
so the bond sets the false-valid rate the stake can tolerate:
`bond ≥ p_tolerated × top award`. At a 1% tolerance a $1k stake needs a $10 bond
and a $10k stake a $100 bond; market deposits sit in that range (HackenProof $5,
which cut slop by about 80%; Code4rena 25 USDC; Sherlock $250). The record shows
the bond so hunters can price it. The bond and the prepay sit locked from commit
through the fix window, the evaluation and the dispute window — up to 14 or 30
days plus 72 hours before any payout — on top of the agent time spent. That is
short by disclosure norms, but it is a real cost, so the feed shows it per
listing and the window defaults stay modest. The pre-flight fee (§8.6), when
used, is credited against the prepay at commit.

**Maker.** Pays a **listing fee** per 30 days of live stake to the attestation
provider (the site), which funds the baseline scan so no record reads "0 of 0";
the capital lock (tens of dollars a year on a $10k stake at current yields);
the awards actually claimed; and the escalation prepay when disputing. Expected
cost is the sum over classes of P(finding) × award — pay per finding, against a
fixed-fee audit that costs the same whether the code is clean or not. A maker
with five $1k findings has bought a $5k audit with a public receipt; a maker
with none has paid a listing fee and a lock.

**Arbiters.** Earn the registered class fee per claim as today. Nothing in the
arbiter payment path changes.

**Verdikta.** The listing fee and its operated arbiters; no share of awards in
v1 (Hats takes 10–20% of payouts — an option, not a design choice here).
Revenue concentrates where stakes are large, which is Base protocols; skills
and MCP servers supply volume, the seeding story (§14) and the runtime hook.

**Protocol follow-ups** (dispatcher roadmap, not this design): per-class K/M/N
so a cheaper class can poll fewer arbiters, and a lower bonus multiplier for
cheap classes — together they would roughly halve the prepay.

## 11. Time budget

| Stage | Budget |
|---|---|
| Fetch archives (EA) | 30 s |
| Disclosure check (hash + re-encrypt, EA) | ≤ 10 s |
| Image pull (first use per operator, cached afterwards) | 0–90 s |
| Apply → build → PoC ×3 → integrity → [fix check in parallel] → lint/SAST | ≤ 360 s (`limits.runSeconds`, enforced at listing and by the class maximum) |
| Jev | ~2 s |
| Frontier jury (parallel), then justifier | ≤ 240 s + 45 s |
| Commit transaction; reveal dispatch → reveal transaction | ~90 s |
| **Worst case** | **≈ 14 min, so `responseTimeoutSeconds` = 900 s** |

**One deadline, propagated.** Raising the outer timeouts is not enough: the AI
Node has its own 240 s whole-request timer (`REQUEST_TIMEOUT_MS`, covering
parsing, every juror and the justifier), the EA's AI client retries non-provider
errors, the AI Node's `Promise.race` returns a 408 without cancelling the work
underneath. A 240 s juror followed by a 45 s justifier would be cut off today,
and a retry of a nearly finished evaluation would double the provider bill and
miss the on-chain deadline. Code mode therefore works from a single deadline:

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
  shared-run cache by its key (§9.2).

Changes needed:

- `setResponseTimeout(900)` on both aggregators (an owner transaction). It only
  moves the point at which a stuck request may be force-finalized; ordinary
  requests are unaffected.
- `maxTaskDuration` and the bridge timeout in `chainlink-node/basicJobSpec` go to
  840 s. `upgrade-arbiter.sh` applies this when it regenerates job specs.
- The EA's `SERVER_TIMEOUT` rises to match; the deadline propagation above.
- The record page and the hunter tool poll a pending evaluation for up to
  15 minutes.

Typical evaluations are expected to take 3–6 minutes. Before the network timeout
changes, a cold-image end-to-end canary on class 5555 must pass with a
near-limit juror followed by justification, a provider timeout with retry, a slow
justifier, a registry failure and a cancellation.

## 12. Failure semantics

| Situation | Result |
|---|---|
| Runner not installed or unhealthy, admission refused, deadline cannot be met | Error, no commit (transient) |
| Registry or image-pull failure | Error, no commit |
| Step timeout, OOM, process limit, sandbox died | Error, no commit (the arbiter abstains) |
| Disclosure mismatch; patch doesn't apply or edits source; build fails; PoC passes or errors on any run; **integrity check fails**; path out of scope; claimed observable not recorded | Deterministic INVALID, committed; the bond forfeits at settlement |
| `poc.patch` or `finding.json` missing, or not a patch / not valid JSON | Malformed-archive settlement (existing rule): INVALID |
| `fix.patch` fails to apply, build or pass | Recorded in the report; the outcome is unaffected (§20, decision 14) |
| `code_review.json` invalid; **attestation missing or invalid; spec above the class maxima; manifest outside the class envelope** | Error: the requester's package is broken (existing rule); no commit, before any pull or model call |
| Jev fails | Jurors proceed unaided; Jev's weight dropped, not redistributed (§10.5) |
| A non-Jev juror fails | Error, no commit — code mode requires every non-Jev juror (§10.5) |
| The round times out at the aggregator | No verdict; the contract lets the hunter re-trigger the evaluation with a fresh prepay inside the reveal window, or expires the claim with the bond returned (the failure was not the hunter's) |

**Abstaining is not neutral.** A round that times out applies the configured
timeliness penalty (−20 on mainnet) to every polled oracle that did not commit
(`_applyTimeoutPenalties`), and an oracle that commits but is not among the first
4 of 6 is also penalised −20. No fee is earned either way. Transient failures are
therefore an operator cost, which is why admission refuses early — before a pull,
before a model call — rather than failing late, and why the envelope keeps the
work inside the budget on ordinary hosts.

## 13. The `StakeAttestation` contract

A new contract in verdikta-applications, a requester of the aggregator like
`BountyEscrow`, holding the escrow, the claims and the record. This section is
its specification at the level the Phase 1 implementation and its Hardhat
fixtures (§18) are written from; storage layout and gas are the
implementation's business.

### 13.1 Entities and state

**Listing** — one staked version of one artifact.

```
listingId, maker, artifactHash (keccak256 of kind, repo, baseCommit [, chainId, address]),
listingCid, disputeCid (the two archives, §10.4), disclosureKey,
awards[LOW..CRITICAL] (wei), lowestClassCounted, bondWei, fixWindow, disputeWindow,
disclosureGrace, revealWindow, knownIssueIds[] (hashes, fixed at listing),
allowlist (empty = open; else "invited"), valueAtRiskUsd (declared or 0),
escrowWei, owedWei, fundedUntil (listing fee), predecessor, successor,
state ∈ { Listed, Open, Depleted, Rolled, Closed }
```

- **Listed** after `list`; **Open** once `fund` brings `escrowWei` to at least
  `awards[CRITICAL]` and the listing fee is paid. **Depleted** when a payout
  leaves `escrowWei` below the top award: no new commits until topped up;
  pending claims keep settling and any shortfall accrues to `owedWei`, which
  the maker must clear before the listing reopens or closes cleanly — the
  record shows it. **Rolled** after `rollForward` names a successor: no new
  commits on this hash; pending claims settle against it. **Closed** after
  `close`: escrow withdrawn once every pending claim is settled or expired; the
  badge ends; the history and `recordByHash` stay.
- `fundedUntil` is extended by `renew`; a listing whose fee lapses stays Open
  for pending claims but is labelled lapsed on the record and leaves the feed.

**Claim** — one hunter's commit against a listing.

```
claimId, listingId, hunter, archiveHash (sha256 of the plaintext archive), ciphertextCid,
committedAt, bondWei, prepayWei, preflightCredit, flaggedBadDisclosure, released,
bcid, contentKey, ephemeralKey, revealedAt, requestId, vector[6], outcome, class,
paidWei, state ∈ { Committed, Revealable, Revealed, Judged, Disputed, Settled, Expired }
```

- **Committed** → **Revealable** when the fix window ends, the maker releases
  the claim, or the listing rolls forward. **Revealed** when the hunter reveals
  and the evaluation request is submitted. **Judged** when the callback arrives:
  the dispute window starts. **Disputed** when the maker escalates; the second
  callback is final. **Settled** when funds move. **Expired** when a Revealable
  claim is not revealed within `revealWindow`.
- Reveals are accepted in **commit order** per listing (§8.7): `reveal` requires
  every earlier claim on the same listing to be Settled or Expired.

### 13.2 Functions and who pays

| Function | Caller | Pays | Effect |
|---|---|---|---|
| `list(params, listingCid, disputeCid, knownIssueIds)` | maker | gas | Creates the listing from the attested archives; the site has validated them (§8.2) but the contract trusts only what it stores |
| `fund(listingId)` | maker | awards escrow (≥ top award) + listing fee | Opens the listing; emits `Opened` for the feed |
| `renew(listingId)` | maker | listing fee | Extends `fundedUntil` by 30 days |
| `commit(listingId, archiveHash, ciphertextCid)` | hunter (on the allowlist, if any) | `bondWei` + class prepay − pre-flight credit | Creates the claim; emits `Committed` (hash, ciphertext CID, timestamp) |
| `flagBadDisclosure(claimId)` | maker, within `disclosureGrace` | gas | Sets the flag; shown on the record (§14) |
| `release(claimId)` | maker | gas | Waives the fix window for this claim: Revealable now; recorded as "released" |
| `rollForward(listingId, successorListingId)` | maker | gas (the successor is listed and funded on its own) | Marks every Committed claim Revealable; moves the badge to the successor; links the lineage |
| `reveal(claimId, bcid, contentKey, ephemeralKey)` | hunter, once Revealable and earlier claims are settled | gas | Stores the reveal; submits the evaluation request (§13.3) from the claim's prepay; emits `Revealed` |
| `fulfill(requestId, vector)` | aggregator callback | — | Stores the vector; computes outcome and class (§8.7); starts the dispute window; emits `Judged` |
| `dispute(claimId, statement)` | maker, within `disputeWindow`, once, on a valid outcome | escalation prepay (the dispute panel's `maxTotalFee`) | Submits the dispute request with `disputeCid` and the statement as addendum; the second `fulfill` replaces the first and is final |
| `settle(claimId)` | anyone, after the dispute window or the final callback | gas | Moves funds per §8.7; publishes nothing itself (the finding body is the revealed bCID, already public); emits `Settled` |
| `expire(claimId)` | anyone, `revealWindow` after Revealable | gas | Bond to the maker, prepay back to the hunter, recorded as unrevealed |
| `retrigger(claimId)` | hunter, after an aggregator timeout | a fresh prepay | Re-submits the evaluation (§12) |
| `close(listingId)` | maker, when no claim is pending | gas | Withdraws escrow; ends the badge |
| `lateClaim(listingId, …)` | hunter, on a Rolled or Closed listing | bond + prepay | A claim with no award: judged and recorded as "found later"; bond returned unless INVALID |
| `recordByHash(bytes32)` | anyone (view) | — | The record summary (§13.4) |

Settlement under §8.7, in funds: valid at or above the counted class →
`min(awards[class], escrowWei)` to the hunter, the remainder of the award to
`owedWei` if the escrow fell short, bond back; valid below the counted class or
DUPLICATE → bond back, no award; INVALID → bond to the maker. The unused part of
the prepay comes back to the hunter through the aggregator's `ethOwed` credit,
as `BountyEscrow` does today. A disputed verdict that flips to INVALID
forfeits the bond to the maker, which covers the escalation prepay; one that
holds costs the maker the prepay and is recorded as a failed dispute.

### 13.3 Request composition

The contract composes the evaluation request from state it vouches for, so no
off-chain party has to be trusted for what the jury sees:

- `cids` = `[listingCid, claim.bcid, …bcids of prior valid claims on this
  listing]` (most recent 20; the dispute request uses `disputeCid` first). The
  EA treats position 0 as the listing archive, position 1 as the claim under
  judgement and the rest as **prior findings**, from which only `finding.json`
  and `report.md` enter the context pack. Known issues need no CID: they are in
  the listing archive, and their ids were fixed on-chain at listing.
- `addendumText` = one machine-readable line, `verdikta-disclosure: <contentKey>
  <ephemeralKey>`, which the EA consumes for the disclosure gate and strips
  before any model sees the prompt; on a dispute, the maker's statement follows
  it (bounded at 4 KB), fenced as the maker's argument.
- `requestedClass` and `maxOracleFee` from the listing's class and panel;
  `alpha` and the scaling factors as the site's defaults.

### 13.4 Record and lookup

`recordByHash(bytes32)` returns the record of §4.1 for an artifact hash: the
listing's state and labels, the award table, the bond, `escrowWei`, `fundedUntil`,
the declared value at risk, the counts (claims, by outcome, disputes and their
results, unrevealed), the valid findings (class, paid, revealed-at, bCID), the
lineage and any late findings. Every state change emits an event, and the
**listing feed** is those events: `Listed`, `Opened`, `Committed`, `Flagged`,
`Released`, `Revealed`, `Judged`, `Disputed`, `Settled`, `Expired`,
`RolledForward`, `Renewed`, `Closed`, `LateClaim`. The site mirrors the record
over HTTP and serves the badge from it; `@verdikta/attest-check` (§14) resolves a
package or hash to the record and applies the caller's rule.

Two contract questions are open (§20): a **yield-bearing escrow** (stake held in
a vault, awards paid from principal) to soften the capital lock, and the launch
values of `badgeFloorWei` and the under-staked ratio.

## 14. Disclosure, privacy and the hunter tool

- **What is public when.** On-chain at commit: the archive hash, the CID of
  the encrypted archive, the bond and the timestamp. At reveal: the bCID, the
  encryption keys and the evaluation. At settle: the verdict and payout. The
  finding body is the revealed archive, so it is public from reveal on for
  every outcome — but the site **publishes** (indexes, shows on the record,
  announces) only valid findings; an INVALID or DUPLICATE claim is a count on
  the record and nothing more, so slop does not pollute it. Arbiters first read
  a proof of concept at reveal, after the fix window, so an operator never
  reads an unfixed finding; a maker who shipped no fix inside the window
  exposes their users at reveal, by their own choice, and the record says so.
- **Verifiable disclosure.** The maker's copy and the revealed archive are the
  same bytes by construction, not on anyone's word. At listing the maker
  registers a **disclosure key** in the `stake` block: a dedicated public key
  for an age-style hybrid scheme (X25519 key wrap plus authenticated symmetric
  encryption; libsodium's `box` is equivalent), never the wallet key, which
  wallets do not expose for decryption. At commit the hunter's tool draws a
  fresh content key and ephemeral key, encrypts the archive to the disclosure
  key, pins the **ciphertext** to IPFS (encrypted bytes are safe in public)
  and records two commitments on-chain: `sha256(archive)` and the ciphertext
  CID. The keys stay with the hunter's tool, stored beside the archive. The
  maker fetches the ciphertext, decrypts it and compares the hash to the
  commitment; a copy that does not decrypt or does not match is flagged
  on-chain as a **bad disclosure** within `disclosureGraceHours` (48 proposed)
  — a claim, not a verdict, free to raise, and shown on the record. At reveal
  the hunter pins the plaintext archive (bCID) and puts the content key and
  ephemeral key in the reveal transaction, from where the contract passes them
  to the arbiters in the request's addendum (§13.3); nothing is secret any
  more. The `disclosure` gate (§10.1) then verifies both commitments in every
  arbiter: the plaintext hashes to `sha256(archive)`, and re-running the
  encryption with the revealed keys and the listed disclosure key reproduces
  the pinned ciphertext byte for byte — the schemes named are deterministic
  once the randomness is supplied. Either failure settles INVALID and forfeits
  the bond through the malformed-archive path. Consequences: a hunter cannot
  disclose one thing and reveal another; a maker cannot falsely claim a bad
  disclosure, because a flag followed by a verified reveal is itself on the
  record; arbiters need no key, and the maker's private key is used by nobody
  but the maker. The residual responsibilities sit where they belong: a maker
  who registers a key they cannot use still owes the award on a finding
  verifiably encrypted to it; a hunter who loses the keys cannot reveal and
  forfeits the bond, so the tool keeps them with the archive. A successor
  listing may carry a new disclosure key; claims already committed keep the key
  they were encrypted to (§20, decision 16).
- **The hunter tool** is the hunter's side of all of this, a CLI and library:
  `check` (§8.6), `commit` (build the archive, hash it, encrypt, pin the
  ciphertext, keep the keys, send the transaction with bond and prepay),
  `status`, `reveal` (pin the plaintext, send the keys), and `claim` for the
  payout. Autonomous hunters drive it as a library; the same steps are what an
  agent skill for this product wraps.
- **Private posting.** Asked for as "post privately so nobody finds the bug
  before it is fixed". For public artifacts the need is **embargo**, which
  commit → fix window → reveal provides. For closed-source code every arbiter
  operator must read it, and a permissionless operator set cannot promise
  confidentiality without enclaves or a permissioned class: **out of v1**,
  revisited with the remote-runner work (§17, Phase 3). An **invited** listing
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

## 15. Hunter supply and the feed

The supply the record needs is turned away elsewhere. HackerOne requires a
hacker-in-the-loop to validate before submission; Immunefi's terms ban
AI-generated and scanner reports; Cantina bans unvalidated AI output; GitHub
caps newcomers at four submissions and moved its top rates to an invite-only
tier; Sherlock's Audit Engine welcomes "AI auditors" but gates them by
application, KYC and NDA and pays only participants with at least two valid
findings and a 20% valid ratio. A venue that **welcomes autonomous hunters
outright**, judges in minutes once the window ends, pays on-chain and prices
slop with a bond rather than a ban is a differentiator, and the likeliest
source of attention at the $100–$10k tiers.

What it costs them: a thorough agent pass over a small artifact is cents to a
dollar; over a 10k-line codebase, $5–$50 of agent time; then the prepay and the
bond locked through the window. XBOW reportedly spent more on inference than it
earned in 2025, so the feed must carry enough positive-expected-value listings
or the hunters leave. Hence the **listing feed** (hash, image, scope, award
table, bond, windows, days open, claims so far, escrow remaining) as a public
API from day one — the contract's events, mirrored over HTTP — and the baseline
scan, funded by the listing fee, as the floor of attention every record gets.

## 16. Operator impact

- An optional installer phase, "Code-review sandbox", installs gVisor (pinned,
  added with `systemctl reload docker`) and the runner service, warms the base
  images, and runs the **conformance self-test**: a fixed canary listing and
  claim whose expected report hash is published in `@verdikta/common`.
  Registering for either code ClassID requires a pass. `arbiter-doctor.sh` gains
  `svc.code_runner`, `sandbox.runsc`, `sandbox.disk` and `sandbox.conformance`.
- Resources: +2 vCPU, +4 GB RAM and a 40 GB fixed-size disk image for the
  runner's own Docker `data-root` (image cache plus scratch), or a remote runner
  VPS.
- Keys: none new. Jev is reached through the operator's existing
  `OPENROUTER_API_KEY`; a native `TYPESAFE_API_KEY` is optional under the usual
  `AI_GATEWAY` rules. Arbiters hold no disclosure keys (§14).
- `start-arbiter.sh`, `stop-arbiter.sh`, `arbiter-status.sh` and `rotate-logs.sh`
  include the runner.
- Operators read proofs of concept only at reveal, after the maker's fix
  window; the EA logs the claim's bCID and report hash, never the archive
  contents, so an operator's logs do not become a second copy of a finding.

## 17. Rollout

| Phase | Delivers | Exit criteria |
|---|---|---|
| 0. Decisions and schemas | Timeout change approved and hunter-pays confirmed (§20); the two ClassIDs, envelopes and hard limits chosen; trusted-builder key custody (deferred: a single Verdikta key is the placeholder); OpenRouter `systemone` access verified from a canary; `code_review.json` with the `stake` block, `finding.json`, `known_issues.json`, `attestation.json` and the report schema in `@verdikta/common`; the outcome set and settlement rule as a shared helper; the `StakeAttestation` spec (§13) agreed | Schemas merged **and** the fixtures of §18 written as failing tests: forged, missing or duplicate test reports, runtime tampering, an unattested image and an over-limit direct request cannot yield trusted evidence or exceed operator limits; a mixed-fee selection test shows a request on one class cannot select a job registered on another; the settlement rule's cases (median class, below-threshold split, duplicate vs invalid) as unit tests |
| 1. Execution evidence and the record | `code-runner` (local mode, own `dockerd` and disk); `node22`, `python312` and `foundry` images; builder Action with validation, the harness proof and attestation; the baseline scan; the hunter tool (`check`, `commit`, `reveal`); the `disclosure` gate and the claim gates of §10.1; deadline propagation; report and context pack fed to the existing jury with the four questions; `StakeAttestation` on testnet with the record page, badge and feed; `code-standard` on class 5555 canaries | Identical report hash on every canary **across hosts**, including the time- and randomness-dependent fixtures; on the calibration set (§18) no false valid on the adversarial claims and ≥ 90% agreement on the clear cases, **measured per class** (a class that falls short is withdrawn); a cold-cache end-to-end round with slow jurors, justifier delay, registry failure and cancellation; every contract fixture of §18 passes (bond, dispute, release, embargo, lineage, duplicate order, expiry, depletion); p95 inside the budget; the release runbook's version-checked canary gate kept before mainnet |
| 2. Cheap and sharp | `systemone` client, Jev typed questions and rubric juror, claim check on the justification; Jev readiness in the pre-flight (tier 1b) and Jev at listing (§8.6); Semgrep honesty rules and secret scan tuned on the fixtures; cost logging; **published accuracy**: precision and recall per class from on-chain verdicts and dispute outcomes | ≤ $0.30 per arbiter per evaluation on `code-standard`; accuracy no worse than Phase 1; Jev run-to-run determinism measured; claim check catches every seeded contradiction in the fixtures; the accuracy page live |
| 3. Breadth | the `skill` harness image and its activity-log report (§8.8); enclave or permissioned-class evaluation for closed-source stakes (§14); remote runner mode; a Go image; `code-premium` enabled once the fee ceiling is raised; yield-bearing escrow if Phase 1 shows the capital lock deters makers; **juror exploration** — first a local read/grep tool in the AI Node over the runner's checkout (tier-A facts, no container cost), then for `code-premium` an optional provider-hosted shell on a copy of the post-patch tree where the juror can grep callers beyond the context pack, read files and, when the repository's dependencies install inside a minute from an allowlisted registry, write and run its own probe tests (§19; ≈ +$0.5–2 per arbiter, priced into the premium fee) | A canary gate per feature; juror-exploration findings labelled as the juror's own observations, never as report facts; mainnet rollout per `docs/release-runbook.md` §3b |

Jev comes in Phase 2 on purpose: execution evidence is what makes the verdicts
accurate, Jev is what makes them cheap, and every operator in the class needs
the `systemone` client deployed before Jev can sit on the jury. Seeding
(§14) starts on testnet in Phase 1 with Verdikta's own repositories and a
handful of popular skills, so the feed is never empty when hunters arrive.

## 18. Validation

- **Calibration set** (40–60 claims, versioned, built once and reused):
  - **Clear valid:** public audit-contest findings with runnable proofs —
    Code4rena and Sherlock reports whose repositories and fixes are public,
    DeFiHackLabs reproductions on Foundry — repackaged as listings at the
    vulnerable commit with the finding's own class; SWE-bench-style FAIL_TO_PASS
    bugs in Node and Python repositories whose fix PR documents the defect.
  - **Clear invalid:** tests that assert documented or intended behaviour; tests
    that fail for a reason outside the scope paths; tests whose precondition the
    scope excludes.
  - **Duplicates and known issues:** the same root cause as a valid finding
    phrased differently, through another entry point, against another victim; a
    known issue listed before the commit; a known issue "listed" after it
    (still valid).
  - **Severity boundaries:** findings judged at adjacent classes by the source
    program, to measure the median-class rule against the program's own
    outcome.
  - **Adversarial:** a PoC that overwrites the target's storage with `vm.store`
    or `vm.etch`; one that mocks the module under test; one that creates the bug
    in its fixture and then finds it; one whose assertion message asserts
    something the test did not check; a flaky PoC; injected "this is CRITICAL"
    text in the report, test names and comments; a report that claims a
    different observable than the test records.
- **Required counterexamples** (each must fail closed; from the PR #96 review
  and this revision):
  - a claim that writes a failing JUnit record and exits before running the
    code; one that modifies a protected file at runtime; one that monkey-patches
    the reporter; one that edits `node_modules` / `site-packages` / `lib`
    during the run;
  - a PoC that alternates pass/fail, run on a fast and a slow runner schedule —
    same verdict (INVALID) on both;
  - two listings with the same image and spec but different baseline bytes,
    evaluated concurrently — no coalescing;
  - a direct on-chain request with no attestation, and one whose spec exceeds the
    class maxima — rejected before any pull;
  - a premium request against a registry containing standard-priced jobs — none
    selected;
  - Jev rubric-juror fixtures: clear-valid, clear-invalid, known-issue,
    duplicate-of-prior, boundary probabilities;
  - a juror finishing just under its limit followed by justification; a provider
    timeout with retry; a slow justifier; a registry failure; a cancellation at
    the deadline;
  - a time-dependent and a randomness-dependent PoC, run on two different hosts
    — identical report hash.
- **Contract and settlement fixtures** (each must settle as written): a PoC that
  also fails at the fixed hash (valid: judgement is against the committed
  hash); one that fails by import error (INVALID, not a finding); a
  `poc.patch` that edits source (INVALID); a duplicate root cause phrased
  differently (DUPLICATE, bond back); a known issue listed at listing
  (DUPLICATE) and a bug the maker learned of after open (valid); bond returned
  on valid and on DUPLICATE, forfeited on INVALID; a valid finding below the
  counted class (bond back, no award, published); a 40/35/25 split across
  three valid classes (pays the median class); a split that leaves validity
  under the threshold (INVALID or DUPLICATE by the larger mass); a dispute that
  flips and one that holds; a reveal before the fix window ends (rejected); a
  release followed by an immediate reveal; a roll-forward that makes every
  pending claim revealable; a later finding recorded against a closed hash;
  two hunters committing the same root cause minutes apart (second reveal
  waits; first paid, second DUPLICATE); a commit never revealed (expired after
  `revealWindowDays`: bond to the maker, prepay back); a payout that depletes
  the escrow (listing Depleted, shortfall in `owedWei`, commits refused); a
  reveal whose plaintext does not hash to the commitment, and one whose
  re-encryption with the revealed keys does not reproduce the pinned
  ciphertext (both INVALID, bond forfeited); a bad-disclosure flag followed by
  a reveal that verifies (claim proceeds, the flag on the record); a listing
  whose disclosure key the maker cannot use (award still owed); an aggregator
  timeout followed by a re-trigger.
- Run through `testing-tool` (a new `claim` scenario type) and the e2e L4 gate
  against class 5555.
- Metrics: verdict accuracy and the **false-valid rate** on the adversarial
  claims (the number a maker cares about); class agreement with the source
  program on the severity boundaries; dispute-flip rate on canaries; spread of
  the valid mass across arbiters (σ ≤ 5 points); report-hash agreement across
  hosts (100%); cost; p95 latency.

## 19. Alternatives considered

- **Judge first, then a fix window before publishing.** Tells the maker sooner
  whether the claim is real, at the cost of putting an unfixed exploit against
  deployed code in front of every arbiter operator at claim time. Rejected for
  the operator exposure; the bond, the release signal and the record of
  bad-disclosure flags carry the honesty the early verdict would have provided.
- **A historical badge — "certified after a quiet week".** Attests almost
  nothing and is contradicted permanently when wrong; "certification" wording
  invites liability. Rejected (§4.1).
- **Arbiters hold decryption keys so claims can be judged sealed.** Needs key
  distribution to a permissionless operator set and a protocol change, and puts
  an unfixed exploit in every operator's hands. Rejected; the plaintext is
  deferred until after the window instead (§14).
- **Hash-only known issues, bodies sealed.** The jury cannot apply what it
  cannot read, so honest hunters would forfeit bonds on excluded bugs. Rejected
  for public known issues fixed at listing (§8.4).
- **Plain argmax settlement over the outcomes.** Pays nothing on a 40/35/25
  split between three classes that all say valid, which is the common
  disagreement. Rejected for the median-class rule (§8.7).
- **A fix that fails invalidates the claim.** Punishes the helpful hunter and
  teaches hunters to omit fixes. Rejected; the fix check is informational
  (§9.2).
- **A share of awards as Verdikta's revenue** (Hats Finance takes 10–20%).
  An option, not a v1 decision; the listing fee funds the baseline scan and
  leaves the award table the maker's.
- **The platform's CI judges and arbiters read its result.** The simplest option,
  but a single trusted party then decides. Kept only for validation at listing.
- **Clone and install at judging time.** 19–25 minutes under gVisor, needs the
  network, and registry drift breaks agreement between arbiters.
- **Agentic reviewers with a shell in the sandbox.** Strongest on large
  codebases, but slow, expensive and different on every arbiter. Returns in a
  bounded form as the Phase 3 juror-exploration item (§17): first a local
  read/grep tool over the runner's checkout, then, for `code-premium`, a
  provider-hosted shell.
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
     which is the install-at-judging-time path rejected above, on a toolchain
     the providers say may change and do not version. The one exception is
     Managed Agents, whose Ubuntu 24.04 sandbox lists `docker` ("limited
     availability") and allows `ghcr.io`, so a session could in principle
     `docker run` the attested image.
  2. **A model in the chain of custody.** Even with a fixed script, the model
     runs it and relays the result; the claim's stdout enters the model's
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
  (Phase 3, §17), where a juror's commands are allowed to differ per arbiter
  because juror text already varies and is clustered; a Managed-Agents
  **hosted-runner mode** for operators without a sandbox host is revisited when
  docker in cloud sandboxes leaves "limited availability", with the
  model-in-custody caveat written down. Not usable for the local check (it must
  predict the gates on the attested image) or the environment builder (needs
  `docker build`).
- **Firecracker or Kata microVMs.** A stronger boundary, but the current hosts
  have no KVM.
- **Hosted sandboxes (E2B, Modal, Daytona).** A vendor account and bill for every
  operator; verdikta-agents rejected them for the same reasons.
- **Jev as the only judge.** The cheapest, but weak at multi-hop reasoning and
  open to injected text by TypeSafe's own notes. Kept as a low-weight juror and
  a triage layer.
- **Code bounties as the first application.** The original framing; Appendix A.

## 20. Decisions and remaining risks

Each item records the options weighed, the decision, and what it changed in the
document. Decisions 1–8 were taken on 2026-10-19/20 and 2026-10-30 under the
earlier structure; 9–16 are this revision's and are **proposed for the owner's
confirmation** where marked.

1. **`responseTimeoutSeconds` 300 → 900 s on both aggregators — decided: raise
   globally.** The timeout is global per aggregator, so a stuck text round also
   waits 15 minutes before it can be force-finalised, and `BountyEscrow`'s
   `MAX_ACTIVE_EVALUATIONS` slots stay occupied that long. Normal rounds finish
   when reveals arrive and are unaffected. A separate aggregator for code
   classes, or a per-class timeout in the contract, would isolate the change but
   is a deployment or protocol change too large for v1. Per-class timeouts go on
   the dispatcher roadmap (§11).
2. **Jev — decided: pinned `typesafe/jev-1.13-20260917` via OpenRouter.**
   Alternatives were Clef (open weights, same request format, a different model
   with its own answers; self-hosting needs a GPU) and dropping Jev from v1
   (saves little money — Jev is under 1% of spend — and loses the annotation).
   Determinism, which TypeSafe does not document and its own re-ranking recipe
   says can vary, becomes a Phase 2 canary exit criterion; if it fails, Jev is
   demoted to annotator with no jury weight rather than removed. A review of
   TypeSafe's cookbooks added the claim check on the justification (§10.2) and
   the listing and pre-flight checks (§8.6), and rejected re-ranking,
   confidence-gated routing and cascades because they would change what the
   jurors see.
3. **Builder fallback workflow and registry — decided: Verdikta owns both for
   v1,** with the Action published so makers with CI self-build. GHCR public
   storage and public-repo Actions minutes are free; the fallback runs makers'
   `setup` on ephemeral hosted runners with no secrets in the build job and
   signing in a separate job, and builds are gated behind listing so nobody
   burns minutes for free. Retention: an image lives until every claim against
   its listing is settled plus 30 days.
4. **Who pays the evaluation — decided: the hunter, as today, with the cost
   brought down (§10.4, §10.7–10.8).** A maker-funded evaluation budget would
   have aligned payer and beneficiary but needs escrow semantics for refunds
   and invites free claims; the hunter's prepay plus a bond is the slop filter
   the market already uses. A credited pre-flight fee (0.0001 ETH, tier 1)
   stops the site's runner being free CI; the local check is free. A
   cheap-LLM preview grade was considered and left out. `code-premium`
   (≈ $20 prepay) waits for the fee ceiling to be raised to about 0.001 ETH
   (Phase 3). Per-class K/M/N and a lower bonus multiplier for cheap classes
   go on the dispatcher roadmap.
5. **Trusted-builder keys — deferred.** Placeholder for planning: a single
   Verdikta-held Ed25519 key with its id in `@verdikta/common`, rotated by adding
   a key and keeping the old one valid for listings it attested. Sigstore keyless
   signing and a multi-builder list are the alternatives to weigh when the
   decision is taken; it must land before Phase 1's canaries, because the
   runner refuses unattested listings.
6. **In-process test evidence — decided: allow tier B with the integrity
   checks.** Black-box observation protects against forged results, not against
   a dishonest fixture, so the honesty flags and the jury's fourth question
   carry that in both models; the adversarial fixtures measure the residue;
   `code-premium` will require stricter rules if Phase 1 data says the residue
   matters.
7. **First application (2026-10-30) — decided: stake-backed security
   attestation.** Two research rounds (2026-10-27/28) found the code-bounty
   boards emptied by agent supply and the maintainer's own agent cheaper than a
   bounty below ≈ $50–$150; the durable demand is for a verdict the requester
   cannot credibly produce — adversarial independence (§2). Rejected: a
   historical "certified after a quiet week" badge; "certification" wording;
   closed-source private rounds in v1.
8. **Verifiable disclosure (2026-10-30) — decided.** The owner asked how the
   unencrypted reveal is proven to match the encrypted copy: commit both
   `sha256(plaintext)` and the ciphertext CID, reveal the encryption keys, every
   arbiter recomputes; arbiters never hold keys (§14).
9. **Scope: this design is the stake-attestation design (2026-10-30, owner) —
   decided.** Code bounties, the original framing, are out of scope: the `change`
   kind, PR-URL submissions and the PR bot, the `BountyEscrow` pre-flight
   mapping, the rubric juror, the `code-micro` class and the SWE-bench
   calibration set leave the document (Appendix A records them). `kind` stays in
   the schema with `bug` as its only value, so another kind can return without a
   format change.
10. **A DUPLICATE outcome, settled in commit order — proposed.** With five
    outcomes a known issue or a duplicate could only settle INVALID, which
    forfeits an honest second hunter's bond; the product summary promises
    hunters that the bond prices mistakes, and a duplicate is not one.
    Alternatives: keep INVALID (rejected, above); refund the bond off-chain on
    the site's judgement (a trusted party deciding money; rejected). Adopted:
    `[INVALID, DUPLICATE, LOW, MEDIUM, HIGH, CRITICAL]`, DUPLICATE returns the
    bond, pays nothing, publishes nothing, spends the prepay; reveals are
    accepted in commit order so the prior finding is in front of the jury
    (§8.7, §13.3).
11. **Settlement by median class under a threshold — proposed.** Plain argmax
    with a 50% threshold pays nothing when three valid classes split 40/35/25;
    the median-class rule (highest class whose mass at-or-above reaches the
    threshold) pays the class a majority agrees is at least met, and validity is
    the valid mass against the same threshold (§8.7). The alternative, argmax
    with no threshold, lets a 34% plurality decide a CRITICAL payout.
12. **Known issues public and fixed at listing — proposed.** Hash-only or
    sealed bodies cannot be applied by the jury (§8.4, §19). Additions after
    open are not supported: fix and roll forward, or leave it claimable.
13. **RELEASE signal and roll-forward as FIXED — proposed.** A maker who
    believes a claim is bogus had no honest way to shorten the window; `release`
    waives it for one claim and is recorded. A roll-forward ends the window for
    every pending claim on the predecessor (§7.1, §13.2).
14. **`fix.patch` is informational — proposed.** The earlier revision's gates
    (16.6 at `df0e2de`) made "with the fix, the PoC passes and nothing regresses" a gate, so a valid
    finding with a flawed fix would have been INVALID with the bond forfeited.
    The fix is now checked and reported, never gating; the maker sees whether
    it verified (§9.2).
15. **Unrevealed commits expire — proposed.** `revealWindowDays` (7) after a
    claim becomes revealable, anyone may expire it: bond to the maker, prepay
    back, recorded as unrevealed. A hunter who never reveals has still handed
    the maker a verified finding; the bond is the price of walking away.
16. **Disclosure-key rotation and loss — proposed.** A successor listing may
    register a new key; claims already committed keep the key they were
    encrypted to, since the ciphertext is pinned. A maker who cannot use their
    registered key still owes the award on a finding verifiably encrypted to it.

**Remaining risks** (no decision pending, tracked through the exit criteria):

- **Judge accuracy on security findings.** No platform publishes it, Sherlock
  included. A false valid pays the maker's stake to slop and ends the product; a
  false INVALID leaves a bug in and mints a false record. The bond bounds the
  first; the dispute window and the calibration set (§18) bound both; and
  because every verdict and dispute outcome is on-chain, Verdikta publishes
  precision and recall per class — the one metric no competitor publishes
  (Phase 2). Phase 1 exit: no false valid on the adversarial claims, and the
  dispute-flip rate measured on canaries.
- **Hunter supply at the middle tiers** is assumed, not shown; the feed and the
  seeded stakes are how it is tested. If autonomous hunters do not come, the
  record degrades to "scanned" and the proposition is a baseline scan plus
  escrow — weaker, still honest.
- **Capital lock.** Makers may balk at open-ended escrow. A yield-bearing
  escrow (stake held in a vault, awards paid from principal) is the obvious
  mitigation and a Phase 3 contract question.
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
- **Open-weight jurors** may judge security claims worse than the frontier pair
  — measured per class, a short class is withdrawn (§10.4, §17); **Jev
  determinism** (decision 2); the **residual forgery risk** on tier-B evidence
  and dishonest fixtures (§9.5); **registry availability** (IPFS fallback,
  §8.2); gVisor's **wall-clock distortions** on timing-sensitive PoCs (§9.3).

**Open questions:** the yield-bearing escrow's vault design and who bears vault
risk; Verdikta's take (listing fee only in v1; a share of awards is an option);
the launch values of `badgeFloorWei` (≈ $100 proposed) and the under-staked
ratio; the listing fee amount; closed-source stakes (enclave or permissioned
class, Phase 3); builder-key custody (decision 5); whether late claims on
closed hashes see any use.

## Appendix A. Code bounties (not in scope)

This document began as a design for grading **code bounties**: a creator pays
for a change, hunters submit patches from pull requests, arbiters build and
test the patch and grade it against a rubric. That design was complete and
reviewed (PR #96 through `df0e2de`) when the market research of §2 found the
code-bounty market closing, and the owner chose stake-backed attestation as the
application to build. Everything the two share — the attested environment, the
runner, the trust tiers, Jev, the frontier jury, the classes, the fee plan, the
deadline, the failure semantics — is in this document in stake-attestation
terms. What was specific to code bounties is recorded here and nowhere else in
the document:

- **The `change` kind.** A submission was `submission.patch` (source and
  tests), built from the hunter's PR at submit time with `git diff --binary
  <baseCommit> <headSha>` and checked against a per-request temporary index.
  Gates: applies, no dependency changes, build, **acceptance** (the creator's
  `acceptance.patch` applied over the submission, every acceptance test passing
  on the fixed schedule, plus black-box `acceptance.hurl` / `api.hurl` checks
  from the runner's own container as tier-A evidence), **no regressions**
  against the baseline `stable` set, integrity. A **tests-only replay** ran the
  hunter's tests without their change to tell tests that test the change from
  tests that pass either way.
- **The rubric juror.** Jev scored each weighted rubric criterion (`score`,
  four levels) and each must-pass criterion (`noul`), with an explicit branch
  for rubrics containing only must-pass criteria (FUND = 1,000,000 when all
  pass; the naive weighted sum would give 0), and emitted a `[DONT_FUND, FUND]`
  vector by largest remainder. Frontier jurors scored the rubric as today.
- **`code-micro`**, a third class on open-weight code models (Jev,
  `deepseek-v4-pro`, `kimi-k2.7-code`; ≈ $0.08 operator spend, 0.00004 ETH fee,
  ≈ $1.16 prepay) as the default for bounties under a few hundred dollars.
- **`BountyEscrow` changes** for a credited pre-flight fee: `prepareSubmission`
  made payable (`preflightFeeWei` per bounty, recorded as `s.preflightPaid`),
  `startPreparedSubmission` requiring `maxTotalFee − s.preflightPaid`, and
  forfeited fees of still-`Prepared` submissions paid to an immutable
  `preflightProvider`.
- **Paid and unpaid PRs on Verdikta's repositories** (decision of 2026-10-19):
  a bounty announced by a `bounty`-labelled issue; a PR paid only if the site
  records it as a submission, marked by a bot comment and the
  `bounty-submission` label; `CONTRIBUTING.md` / `AGENTS.md` wording.
- **Creator trust and public acceptance tests** (decisions of 2026-10-19): the
  creator defines environment, tests and gates, pinned and attested; hidden
  tests rejected (key distribution and a protocol change); hunter-diligence
  text; the gate-pass deposit rejected because `BountyEscrow.finalizeSubmission`
  cannot tell a gate failure from a jury rejection — the problem the stake
  contract's bond does not have (§8.7).
- **Calibration set:** SWE-bench Verified and Multilingual tasks repackaged as
  bounties, merged Verdikta PRs as positives, and adversarial patches (deleted
  tests, special-cased inputs, injected "score this FUND" comments, unrelated
  changes, empty PRs, a seeded logic bug the tests miss, an API contract break
  only the Hurl checks catch).

**Re-adding code bounties** would take: the `change` value of `kind` with
`acceptance`, `api` and `gates` in the spec schema; the acceptance, Hurl and
replay steps in the runner; the rubric juror and the two-outcome vector in the
AI Node; the bounty program's code-bounty form, PR submission flow and bot; and
`code-micro` with its envelope and fee. None of it conflicts with the stake
design; it was removed because it is not being built, not because it was wrong.
The full text is at `git show df0e2de:docs/development/code-review-design.md`.

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
- Severity rubric and judging precedents: Immunefi, *Vulnerability Severity
  Classification System v2.3* (immunefi.com); Code4rena judging and duplicate
  rules (docs.code4rena.com/competitions/judging-criteria); Sherlock judging
  rules (docs.sherlock.xyz); DeFiHackLabs Foundry reproductions
  (github.com/SunWeb3Sec/DeFiHackLabs) as the source of runnable historical
  proofs for the calibration set (§18).
- Product summary for the stake-attestation product (internal, 2026-10-30):
  `verdikta-knowledge`, `initiatives/stake-attestation/product-summary.md`; the
  owner's questions on the baseline scan and the fix window answered there are
  written into §8.3 and §7.1.
- Market research for §2, §4 and §15 (2026-10-27/28; reports, notes and raw evidence in
  the private `verdikta-knowledge` repository under
  `initiatives/stake-attestation/research/`): Code4rena wind-down
  (code4rena.com); curl bounty end and 2026 report volume (daniel.haxx.se,
  2026-01-26, 2026-05-26, 2026-10-14); hackbots
  (hackerone.com/blog/2025-hpsr-researcher-signals;
  hackerone.com/blog/welcome-hackbots-how-ai-shaping-future-vulnerability-discovery;
  xbow.com/blog/series-b; the inference-exceeds-earnings claim is third-party,
  utkusen.substack.com); GitHub payout cuts and submission caps (techtimes.com,
  2026-07-27); Sherlock Audit Engine
  (docs.sherlock.xyz/audit-engine/about-audit-engine, …/faq) and Aerodrome's
  tiered pool
  (cryptobriefing.com/aerodrome-finance-400k-audit-contest-sherlock); Flare
  FAssets (immunefi.com, as recorded in the notes); Code4rena's V12 known-issue
  rule (docs.code4rena.com/competitions/submission-guidelines); Anthropic's
  HackerOne program averages (hackerone.com/anthropic via gigazine.net,
  2026-05-08); HackenProof's $5 fee effect (podcast interview, as recorded in
  the notes; no written source); Internet Bug Bounty pause (hackerone.com/ibb,
  2026-03-27); ERC-8004 registry statistics
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
