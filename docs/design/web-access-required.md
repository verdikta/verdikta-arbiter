# Design note: "web access required", an opt-in rule for jurors who retrieved nothing

Status: **proposal, not implemented.** The owner decides. The telemetry it builds on
(`model_results[].web_retrieval`) ships in the same PR and changes no score.

## 1. The problem

Since #95, OpenAI and Claude jurors open links through their providers' server-side web
tools. The 2026-10-21 question-wager canary showed that the two providers read different
sites. Both read stockanalysis.com and investing.com. Only GPT reads wsj.com, marketwatch.com
and api.nasdaq.com. Only Claude reads finance.yahoo.com and google.com/finance.

Today a juror that could not read anything fails closed only because the prompt tells it to.
The node never checks whether a juror read anything. The node's own web note tells it the
opposite of what a wager needs: "If a link cannot be opened, say so in your justification
and judge without it." In the canary, every juror that read nothing said so and voted
NOT_READ or NO_WINNER, but that is the prompt holding, not the node.

What the node can now see (measured on the canary, `tmp/arbiter-retrieval-evidence-2026-10-21`):

- **Claude**: every blocked page is a fetch error with Anthropic's code (`url_not_allowed` on
  wsj, marketwatch, api.nasdaq and reuters; `url_not_accessible` on cnbc). All 10 runs with
  zero pages opened scored NOT_READ or failed to parse.
- **GPT**: OpenAI marks every page it opens `completed`, including Yahoo (429), CNBC
  (robots.txt) and Reuters, which GPT then said it could not read. So the node can see that
  GPT tried, not whether it succeeded.

## 2. Principles

- **Opt-in per job.** An application that does not set the flag sees no change. There is no
  node-wide policy. `AI_WEB_ACCESS` stays the operator's switch for whether tools are offered.
- **Universal.** Any application can use it: bounties, mutual wagers, anything else whose
  answer must come from the web.
- **A juror who read nothing votes the safe outcome. It is not dropped.**

## 3. Proposal

### 3.1 Manifest

Two new `juryParameters` fields, read from the primary manifest only:

```json
"juryParameters": {
  "NUMBER_OF_OUTCOMES": 2,
  "AI_NODES": [ … ],
  "ITERATIONS": 1,
  "WEB_ACCESS": "required",
  "WEB_SAFE_OUTCOME": 0
}
```

- `WEB_ACCESS`: `"required"`, or absent (today's behaviour). Any other value makes the
  manifest invalid. A typo must not silently turn the rule off.
- `WEB_SAFE_OUTCOME`: 0-based index into the outcomes. Required when `WEB_ACCESS` is
  `"required"`, rejected otherwise. It is the outcome that pays nobody, or refunds:
  `DONT_FUND` (0) for a bounty, including each bounty of a mutual wager. `NO_WINNER` would be
  the choice for a single wager escrow (verdikta-applications#107).

The external adapter (EA) passes both to the AI node as one new optional request field,
for example `"webAccess": { "required": true, "safeOutcome": 0 }`.

### 3.2 An arbiter without web access declines the job

With the flag, the AI node checks every juror before calling any model. A juror can run
with web tools only when:

- `AI_WEB_ACCESS` is not `off`,
- its provider class resolves to the native backend (`resolveProviderConfig`; the
  OpenRouter gateway has no web tools),
- the provider is OpenAI or Anthropic, and the model takes the tools
  (`openAIModelSupportsWebSearch`, `anthropicModelSupportsWebTools`).

If any juror fails the check, the node answers with a distinct error (for example HTTP 422,
`"error_type": "web_access_unavailable"`) and calls no model. With the flag the tools are
also on when the query has no link (`always` for this request), since `auto` enables them
only when a URL is present.

There is no "decline" in the protocol today, only a failed job. In commit mode, any EA error
returns `status: "errored"` (HTTP 500), the Chainlink bridge task fails, and no commit is
made (`evaluateHandler.js` catch block; `chainlink-node/basicJobSpec`). The EA must
recognise `web_access_unavailable` and fail at once: `aiClient` retries every error except
HTTP 400 and provider errors.

What a decline costs, with the aggregator's contract defaults (verdikta-dispatcher
`ReputationAggregator.sol`, `setConfig` can change them): K = 6 arbiters are polled,
the first M = 4 commits go to reveal, the first N = 3 reveals are clustered, and the round
times out after 300 s.

- The declining arbiter keeps the base fee, which is paid on dispatch. At settlement it gets
  timeliness −20 and no quality change, the same as any arbiter that does not respond. The
  keeper locks an arbiter below −300, so an operator who keeps declining is eventually
  locked out of that class. That is arguably right, since the class promised capabilities
  it does not have. It is better avoided by marking which classes need web access (3.7).
- The round still completes if 4 of the 6 commit. If 3 or more decline, it fails at the
  timeout and the requester is refunded. The application has to handle that like any failed
  evaluation.

### 3.3 A juror with zero successful retrievals votes the safe outcome

After each juror call, the node reads `web_retrieval`. With zero successful retrievals, the
juror's score vector becomes 1,000,000 on `WEB_SAFE_OUTCOME`. It keeps its weight, and its
own text stays in the justification, with a node line saying that its vote was replaced and
why. `model_results[]` gets `vote_replaced: "no_retrieval"` and the response gets a warning.
With `count` > 1, each call is checked on its own before the calls are averaged.

**Why replace and not drop.** Dropping a juror renormalises the weights over the others, so
one juror can pay alone. With the v4 panel (gpt-5.6-terra 0.5 + claude-sonnet-5 0.5) and the
80 % FUND threshold the canary used:

| Claude blocked, GPT says FUND 100 % | aggregate FUND | pays? |
|---|---|---|
| Claude dropped (today's rule for failures) | 100 % | yes, on GPT alone |
| Claude replaced by DONT_FUND | 50 % | no |

With replacement, a payout needs enough weight from jurors that each retrieved something.
The safe outcome is safe for the escrow, not neutral between the parties: in a single
bounty it favours the creator, who keeps the money. That is the same direction the rubrics
already fail in.

**What counts as a successful retrieval.** It differs by provider, because the providers
report different things:

| | counts | catches | cannot catch |
|---|---|---|---|
| Anthropic | a `web_fetch` that returned content, or a `web_search` that returned results | blocked domains (`url_not_allowed`), unreachable pages, tool failures, a juror that never tried | see 3.5 |
| OpenAI | any `web_search_call` that completed (search or open_page) | tool failures, a juror that never tried | a page the site refused: OpenAI reports it as `completed` |
| other providers | nothing (no web tools) | declined up front by 3.2 | |

Counting searches is an owner decision (section 5). Claude sometimes runs a meaningless search
(the capture has one for "placeholder"), which would count. Counting only pages would reject a
juror that legitimately found the value in search results without opening a page.

### 3.4 Interaction with today's parse-failure drop

Today a juror whose reply cannot be parsed is a `parsing_error`. It is excluded from the
aggregate, and the request still succeeds if at least `MIN_SUCCESSFUL_MODELS_PERCENT` (50 %)
of jurors answered. Failed and timed-out jurors are excluded the same way. So with two
jurors, one can decide alone, which is the hole 3.3 closes. #101 adds one repair call before
a reply counts as unparseable. It cut parse failures from 4/32 to 0/32 on the v4 smoke cases,
but it does not remove them.

Proposed order for a job with the flag:

1. The juror answers. If it retrieved nothing, its vote is the safe outcome. No parse or
   repair is needed, and its text is kept as the justification.
2. Otherwise, parse. If that fails, make #101's single repair call.
3. If the repair also fails, or the juror failed or timed out, its vote also becomes the safe
   outcome instead of being dropped. A missing vote must not let the other juror pay alone.
4. If no juror produced a vote at all (every provider down), keep today's error, with no
   commit. Committing an all-safe verdict for an outage would settle a job that nobody
   judged.

Without the flag, nothing changes: drops and the 50 % rule stay as they are.

### 3.5 What "successful retrieval" can and cannot prove

It proves only that the provider's fetcher returned something, or that a search returned
results. It catches "read nothing". It does not catch "read the wrong thing":

- **A page that has no answer.** nasdaq.com's history page returns a JavaScript shell without
  the table. Claude opened it in every run and scored NOT_READ 95 %. Google Finance, fetched
  on 10/21, had no labelled 10/20 close.
- **The wrong page, an old copy, or a misread.** These are the prompt's job: dated values,
  a second source, and no deciding from memory.
- **A page the claimant controls.** Anyone can publish a page that fetches fine. The rule
  says nothing about authority.
- **An irrelevant search.** The "placeholder" search counts if searches count.
- **For GPT, a refused page.** OpenAI reports it `completed`. A possible signal is GPT's
  `usage.input_tokens`, which rose by 400 to 6,000 tokens when a page had content and not when
  it was refused. It depends on prompt size and tool rounds, so it is not proposed.

So the rule is a floor under the prompt, not a replacement for it. The prompt-level rules in
the templates (verdikta-applications#110) stay the main defence.

### 3.6 Aggregator and commit-reveal

- **Commit-reveal is unchanged.** The replacement happens inside the AI node, before the EA
  hashes `(operator, scores, salt)` for the commit. The reveal is the committed vector, as
  today. Nothing on chain knows about the rule.
- **The aggregate still comes from the closest pair.** The contract averages the closest pair
  (P = 2, squared Euclidean distance) among the first 3 reveals (`AggregatorLib.findBestCluster`).
  The replacement moves an arbiter's vector a long way. With the v4 panel, if GPT votes FUND,
  the arbiter's vector is `[0, 1000000]` when Claude also votes FUND and `[500000, 500000]`
  when Claude's vote is replaced.
- **Deterministic blocks are consistent.** `url_not_allowed` is a domain policy at Anthropic,
  so every arbiter's Claude gets it, every arbiter replaces the vote the same way, and the
  vectors stay close.
- **Transient failures split arbiters.** A 429 or a `url_not_accessible` on one arbiter only
  makes that arbiter the outlier. It then gets quality −60 if it is among the first 3 reveals
  and outside the pair. Arbiters already diverge when models disagree, but the replacement
  makes the swing larger.
- **This is fail-safe at the aggregate.** For the result to pay, two of the three revealed
  vectors must agree on paying.
- **Mitigations, if this matters in practice.** Use the same `AI_WEB_MAX_USES` everywhere, or
  give a juror one retry when every fetch failed with a transient code
  (`url_not_accessible`, `too_many_requests`). This is not proposed until the telemetry shows
  how often it happens.
- **The justification shows the replacement.** The EA copies `model_results` to IPFS, so
  `web_retrieval` and `vote_replaced` are public. Anyone can see which juror's vote was
  replaced and why.

### 3.7 verdikta-common and the EA

- **verdikta-common rejects unknown keys today.** The manifest schema
  (`src/utils/validator.js`, Joi) has no `.unknown()` on `juryParameters`, and
  `"juryParameters.FOO" is not allowed` fails the manifest. So:
  - **Schema change:** add `WEB_ACCESS: Joi.string().valid('required')` and
    `WEB_SAFE_OUTCOME: Joi.number().integer().min(0)`. Add a custom rule: it is required with
    `WEB_ACCESS`, forbidden without it, and below the number of outcomes.
  - `manifestParser.parse` returns both in the parsed result, so the EA can put them in the
    AI-node request. Today only `models` and `iterations` reach the AI node.
  - Update `MANIFEST_SPECIFICATION.md`. It does not mention the ranges, the weight-sum rule,
    or that unknown keys are rejected.
- **Old arbiters fail closed.** An arbiter on today's verdikta-common fails such a manifest in
  validation, so it never commits; it does not judge without the rule. That is the safe
  failure, but it costs those arbiters timeliness −20 per job, and if 3 of 6 are old the round
  fails. An application must not set the flag until the class it uses runs the new version.
  Putting the flag somewhere the schema ignores unknown keys (the request object allows them)
  would be worse: old arbiters would judge without the rule.
- **How an application knows.** One option is a capability marker in the ClassID data
  (verdikta-common `classmap`), for example `"webAccess": true` on classes whose arbiters all
  run web-capable jurors and the new version. Applications that need the flag request only
  those classes, and operators without web access do not register for them. The class
  registry is the closest thing the network has to a capability list. `classmap.v1.json` also
  sets `additionalProperties: false`, so the marker is a schema change there too.
- **Multi-CID jobs.** Only the primary manifest's `juryParameters` count. A bCID
  (submitted-work) archive's are already ignored, so a submitter cannot turn the rule off.

## 4. Rollout

1. verdikta-common: parse and validate the two fields; publish.
2. Arbiter: EA passes them through; AI node implements 3.2–3.4 behind them. Unit tests, plus
   a canary replay with the flag on the v4 smoke cases: expect Claude's vote replaced on
   wsj/marketwatch-only questions, and no change where both jurors read.
3. Class-5555 testnet canaries first (AGENTS.md release gate), then the mainnet classes.
4. Applications set the flag only on a class whose arbiters all run the new version (3.7).
   Mutual-wager v4 (verdikta-applications#110) would be the first user, with `WEB_SAFE_OUTCOME: 0`.

## 5. Decisions for the owner

1. Field names and values (`WEB_ACCESS: "required"`, `WEB_SAFE_OUTCOME`), and whether the
   safe outcome is given as an index or a name.
2. Whether a search with results counts as a retrieval, or only an opened page.
3. Whether a missing vote (parse failure after repair, failure, timeout) is the safe outcome
   under the flag (proposed), or stays dropped.
4. All jurors missing: an error with no commit (proposed), or an all-safe verdict.
5. How an application learns that a class's arbiters honour the flag (3.7).
