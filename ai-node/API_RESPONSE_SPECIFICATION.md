# Rank and Justify API - Response Specification

## Response Format by Scenario

### 1. All Models Succeed ✅

**HTTP Status:** `200 OK`

```json
{
  "scores": [
    { "outcome": "Yes", "score": 650000 },
    { "outcome": "No", "score": 350000 }
  ],
  "justification": "Combined analysis from all models explaining the scoring rationale..."
}
```

**Key Points:**
- Scores are weighted averages from all successful models
- Scores always sum to 1,000,000, except for a one-number question (exactly one outcome): its single
  score is from 0 to 1,000,000 and is not scaled
- Justification synthesizes reasoning from all models

---

### 2. Some Models Fail, and the Operator Allows a Partial Jury ⚠️

**Not the default.** Every juror must answer (scenario 3). This response exists only on
a node whose operator set `MIN_SUCCESSFUL_MODELS_PERCENT` below 1
([Configuration](#configuration)), and only while at least that share of the jurors
answered.

**HTTP Status:** `200 OK`

```json
{
  "scores": [
    { "outcome": "Yes", "score": 700000 },
    { "outcome": "No", "score": 300000 }
  ],
  "justification": "Combined analysis considering successful models and noting failures..."
}
```

**Key Points:**
- **Failed models are EXCLUDED from score calculation**
- Only successful models contribute to the aggregated scores
- Weights are renormalized across successful models
- The justification's result record says so: `JURORS (1 of 2 answered; the result is that
  one juror's scores)`, with a line for the juror that gave no score
- The request succeeds while at least the operator's share of the models succeed

**Example:** With 2 models (weights 0.6, 0.4) and `MIN_SUCCESSFUL_MODELS_PERCENT=0.5`:
- If only the 0.6-weighted model succeeds, its scores are returned directly (renormalized to 1.0)
- Failed model's scores are not included in calculation

---

### 3. A Juror Gave No Answer ❌

**HTTP Status:** `400 Bad Request`

```json
{
  "error": "Insufficient successful models: 1/2 (minimum required: 2). Failures: Anthropic-claude-sonnet-5 (Model Anthropic-claude-sonnet-5 timed out after 120000ms)",
  "scores": [],
  "justification": ""
}
```

**Every juror must answer, or the arbiter does not** (`src/utils/juryQuorum.ts`). A juror
that timed out, whose reply could not be read after the repair call, whose provider
refused the node's key or was at its usage limit, or whose model the provider does not
have, ends the request with this response, whatever the other jurors answered and
whatever its weight. The justifier is not called.

Until 2026-11 half the jurors were enough. A two-model jury was then answered by one
model whenever the other failed, and the arbiter committed that model's scores as the
jury's: 12 of 314 two-juror evaluations in a month of bounty records (20 October to
21 November 2026), and three of bounty 398's six. On that bounty's third submission two
arbiters each ran a different lone juror and rejected it for different reasons.

What the External Adapter does with this response:

- **Commit mode (mode 1, every aggregator request):** it returns an error and commits
  nothing. The round is settled by the arbiters that ran the whole jury. If too few of
  them commit, the round gets no result: once the aggregator's `responseTimeoutSeconds`
  has passed anyone can finalize it as timed out (`finalizeEvaluationTimeout`), which
  returns the prepay and costs the polled oracles reputation.
- **Mode 0:** its historical contract for a provider error, `200` with
  `aggregatedScore: [0]` and the `error` published as the justification.

A request whose jury names a model that no longer exists is such a request on every
arbiter, every time: it gets no result at all until its manifest is corrected. The
e2e scenario `incomplete-jury` is one (`e2e/README.md`).

**Key Points:**
- The request fails if fewer than the required number of models succeed: all of them,
  unless the operator set a lower share ([Configuration](#configuration))
- Error message includes:
  - Success/failure count
  - Minimum required successful models
  - **Detailed failure reasons for each failed model**
- Empty `scores` array
- Empty `justification` string

---

## Error Message Format

When models fail, error messages follow this pattern:

```
Insufficient successful models: {successful}/{total} (minimum required: {min}). Failures: {model1} ({reason1}); {model2} ({reason2})
```

**Example Failure Reasons:**
- Network/API errors: `"OpenAI-gpt-4 (Connection timeout after 30s)"`
- Parsing errors: `"Anthropic-claude-3 (Unable to parse response: I cannot provide scores...)"`
- Provider errors: `"Ollama-llama3 (Model not available)"`

---

## Provider text in a response

The External Adapter publishes `justification`, `model_results` and `warnings`
on IPFS, and in mode 0 the `error` of a 400. A provider's error message can
quote the operator's API key (one of bounty 398's records holds OpenAI's 401
with the key, masked by OpenAI, in three fields), a response body, a URL with a
key in its query, or a request id. So no provider message enters a response as
it came (`src/utils/redactProviderText.ts`):

| Field | What it holds for a failed model |
|---|---|
| `model_results[].error_message`, the `warnings[].message` built from it, each `{reason}` of the 400's `error` | The provider's message, redacted: `401 Incorrect API key provided: <redacted>. You can find your API key at https://platform.openai.com/<redacted>` |
| `model_results[].error_type`, `http_status`, `error_code` | As before. |
| `justification` (the `From model X:` line the justifier reads and the fallback returns, and `Error generating consolidated justification: ...` when the justifier itself fails) | The record's words for a juror with no score, from `error_type`, `http_status` and the duration: `Model timed out or failed: authentication error (HTTP 401)`, `... timed out after 120 s` (`jurorFailure`, `src/utils/resultRecord.ts`). |
| The `error` of a 500 | Redacted as a whole. |

Redaction is the installer doctor's `redact_log` (a URL keeps its scheme and
host; `key=`/`token=` values, quoted `...key:` values, `Bearer` values and JWTs
become `<redacted>`), then what a public record needs beyond a log: `sk-...` and
`xai-...` keys, a key a provider masked with asterisks, any long opaque token
(request and organization ids, hashes), and a limit of 500 characters per
message. The unredacted message is in the AI Node's own log and nowhere else.
In code mode the error body (`error`, `jurors[].message`) is redacted the same
way; the EA abstains on its status and `errorCode` and publishes none of it.

A provider that refuses the node's key is one fixed line in the log per
refusal, with nothing the provider said in it; the doctor's `ai.provider_auth`
reads it:

```
🔑 PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401
```

It is logged for what the route types as authentication or authorization (a
`status` of 401 / 403), and also for a refusal that typing cannot see: the
providers reached through fetch (xAI, Hyperbolic, OpenRouter) put the status in
the message only (`[OpenRouter] HTTP 401: ...User not found`, typed
`model_not_found`), and xAI answers a bad key with a 400. `http_status` in the
line is then the one the message states; `model_results[].http_status` and
`error_type` stay as typed. Text mode only.

The cron watchdog alerts on the doctor's condition (a provider that refused the
key and has not answered since) from a record of its own,
`logs/provider-auth.log`, because the main log has no times and prints prompts
and replies as they come:

```
2026-11-23T20:35:41.078Z PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401
2026-11-23T21:02:10.412Z PROVIDER_AUTH_OK: provider=OpenAI
```

One line per refusal, and one for the first answer after a refusal. Provider
and model are written without spaces; `http_status` is `unknown` when there is
none. `start.sh` removes the file (`src/lib/llm/provider-auth.ts`,
`installer/util/chainlink-health-watchdog.sh`).

---

## Image Attachments

Before any model is called, every image attachment is fitted to the providers'
limits (`src/lib/attachments/normalizeImages.ts`). Images that already fit are
sent unchanged and the response is exactly as above. When an image is changed or
dropped, the prompt gets one line per image and the response carries a warning:

```json
"warnings": [
  { "type": "image_normalized", "severity": "info",
    "message": "submission/medium_article.png was split into 5 parts, top to bottom; neighbouring parts overlap slightly." },
  { "type": "attachment_omitted", "severity": "warning",
    "message": "Attachment submission/broken.png could not be processed and was omitted: Input buffer has corrupt header." }
]
```

The request as a whole is also kept within the jury's request-wide limits (with
Claude in the jury: 100 images and documents, 20 MB). Tall images are cut into
fewer parts, then images are sent as JPEG or scaled down, and as a last resort
the last images are omitted; each image affected gets a line and a warning, e.g.
`"scroll.png was split into 10 parts, ... To keep the whole request within the models' size limit, the parts were scaled down to 675 px wide and sent as JPEG."`

With `DROP_UNPROCESSABLE_IMAGES=false`, an image that cannot be decoded, or would
have to be omitted to meet a request-wide limit, fails the request with HTTP 400
and `"error": "Image attachment <name> could not be processed: <reason>"`.
A provider that still rejects an image is reported with `error_type: "invalid_image"`.

Optional request fields: `attachmentNames` (file names, index-aligned with
`attachments`, used in those lines) and `requestTag` (an id for log lines).

---

## Document Attachments

A juror sees only the blocks it is sent, so every document it does not see as it
was delivered gets a line in the same "Notes on the attachments" section of the
prompt (`documentNotes`, `src/utils/attachment-processor.ts`). A request whose
documents are all shown whole has no such line.

| What happened | The line in the prompt | In the response |
| --- | --- | --- |
| The arbiter could not read the file (a PDF with no text layer, a damaged or protected document) | `Attachment <name> (PDF, 16.3 MB) was delivered with this request, but the arbiter could not read it, so its content is not shown to you. The file is not missing from the request.` | a warning, below |
| A PDF was read through text extraction | `Attachment <name> is a PDF. Only its text is shown to you (12,898 characters); pictures and page images inside the PDF are not shown.` | none |
| Text was cut at a limit (50,000 characters of plain text, 100,000 of extracted text) | `Attachment <name> is long: only the first 50,000 of its 51,234 characters are shown to you.` | none |

```json
"warnings": [
  { "type": "attachment_skipped", "severity": "warning",
    "message": "Attachment 9: PDF processing failed: ...",
    "details": { "attachment": "submission/R4.pdf", "media_type": "application/pdf" } }
]
```

`message` keeps the technical cause for the operator; the number in it counts the
attachments as they were sent to the models (the parts of a split image count
one each), so `details.attachment` names the file. The prompt line gives no
cause: a juror cannot act on one, and before these lines existed a dropped PDF was
reported by both jurors of a bounty as a file the submitter had not included.

PDF text is read with `pdf-parse` alone; a host needs no `pdftotext`. These lines
are each juror's own: a juror that is sent a PDF itself (next section) sees its
pages and gets no line about it, in the same request in which another juror,
sent the text, does.

---

## PDF Attachments (`model_results[].pdf_inputs`)

A PDF reaches each juror in the best form that juror can read
(`src/lib/attachments/pdfRouting.ts`). A juror whose provider, model and route
read PDFs natively (`src/lib/llm/pdf-support.ts`: OpenAI and Anthropic on their
own keys; Claude 3.5 and later, GPT-5 and later, GPT-4o) is sent the file itself: the model gets each page's
text and an image of the page, so it sees pictures, charts and scans. Any other
juror is sent the text extracted from the PDF and the "Only its text is shown to
you" line above. Every other document (DOCX, DOC, RTF, ...) is its extracted
text for every juror.

| For one juror | What it is sent | The line in its prompt |
| --- | --- | --- |
| It reads PDFs and the request stays inside the provider's limits | The file | none |
| Its provider, model or route is sent text (xAI, Hyperbolic, any class routed through OpenRouter, an older model, and GPT-4.1 and the o-series, whose file request this node does not build yet) | The extracted text | `Attachment <name> is a PDF. Only its text is shown to you (12,898 characters); pictures and page images inside the PDF are not shown.` |
| The file would put its request over a limit: 100 PDF pages per request for both providers, counted with the images for Claude; 20 MB for a whole Claude request, 32 MB of files for OpenAI | The extracted text | the same line, then `The file itself was not sent: its 240 pages would put this request over the 100 PDF pages a request to this model may hold.` |
| Its provider answered 400 / 413 / 422 to the request with the file | The extracted text, in a second request | the same line, then `The file itself was sent to this model first and was not accepted.` |
| The PDF has no text layer and it reads PDFs | The file | none |
| The PDF has no text layer and it does not | Nothing of it | the "could not read it" line above |
| Its provider says the model takes no attachments at all | Nothing | `Attachments <names> were delivered with this request, but this model is sent no attachments, so their content is not shown to you. The files are not missing from the request.` |
| Its provider's request carries a prompt and images only (Ollama) | The images; no document, and no document's text | `Attachments <names> were delivered with this request, but this model is sent images only, so their content is not shown to you. The files are not missing from the request.` |

A request with a PDF reports, per juror, how each PDF was given to it:

```json
"model_results": [
  { "provider": "openai", "model": "gpt-5.6-terra", "status": "success",
    "pdf_inputs": [ { "attachment": "submission/recording.pdf", "form": "native", "pages": 19 } ] },
  { "provider": "xai", "model": "grok-4.6", "status": "success",
    "pdf_inputs": [ { "attachment": "submission/recording.pdf", "form": "text", "pages": 19, "reason": "model" } ] }
]
```

- `attachment` is the file as the notes and warnings name it: its
  `attachmentNames` entry, or its number.
- `form`: `native` (the file), `text` (its extracted text only), `not_shown`
  (nothing of it).
- `reason`, when not `native`: `model`, `page_limit`, `size_limit`, `rejected`,
  `no_attachments`, `images_only`, as in the table. After a rejection, `rejected`
  is only on the PDFs that were in the refused request as files; one that was
  already text for a limit keeps `page_limit` / `size_limit`.
- `pages` is absent when the parser could not count them, or when no juror of
  the request reads PDFs (the file is then not opened for a count).

A juror that is simply sent text (`reason: "model"`) adds no warning, as before.
A juror that reads PDFs but got the text does:

```json
"warnings": [
  { "type": "pdf_text_only", "severity": "warning", "model": "anthropic-claude-sonnet-5",
    "message": "Attachment submission/recording.pdf was sent to anthropic-claude-sonnet-5 as extracted text only (rejected: HTTP 400: The PDF specified is password protected.); pictures and page images inside the PDF were not shown to it.",
    "details": { "attachment": "submission/recording.pdf", "reason": "rejected", "pages": 19 } }
]
```

`pdf_text_only` is `warning` when the reason is `rejected` (the message carries
the provider's status and text) and `info` for `page_limit` and `size_limit`.
`attachment_skipped` for a
PDF with no text layer is one warning, as above, when no juror was sent the
file; when some were, it is one per juror that was not, with that juror as
`model`. `attachments_not_sent` (`warning`, with `model`) is a juror whose model
is sent no attachments, or images only.

Web tools (`AI_WEB_ACCESS=auto`) are turned on by a link in the prompt or in a
text attachment. A link inside a PDF counts for a juror that is sent the file
too: the arbiter looks for it in the text it extracted, which is not sent to
that juror. A link that appears only in a picture is found by neither.

Each juror also gets one log line:
`📎 PDF_INPUT: openai-gpt-5.6-terra submission/recording.pdf native (19 pages) | openai reads PDFs natively | [{…}]`,
and `📎 PDF_FALLBACK` when a provider turned the file down.

Sending the file costs input tokens that the text did not: Anthropic documents
1,500 to 3,000 text tokens plus up to 1,568 image tokens per page. Text-mode
timeouts (`MODEL_TIMEOUT_MS`, default 120 s) are unchanged.

---

## The Result Record (start of `justification`, `model_results[].scores`)

`justification` begins with a block the arbiter computes itself
(`src/utils/resultRecord.ts`), followed by a blank line and the justifier's text:

```
RESULT (computed by the arbiter from the jurors' scores)
- DONT_FUND: 567,500 of 1,000,000 (56.75%)
- FUND: 432,500 of 1,000,000 (43.25%)
JURORS (2 of 2 answered; the result is their weighted average)
- openai gpt-5.6-terra, weight 0.5: DONT_FUND 1,000,000; FUND 0
- anthropic claude-sonnet-5, weight 0.5: DONT_FUND 135,000; FUND 865,000
```

A juror that gave no score is listed as `no score, not counted (timed out after
120 s)`, `(authentication error (HTTP 401))`, `(its reply could not be read as
scores)`, and the heading then reads `1 of 2 answered; the result is that one
juror's scores`. The block never quotes a provider's message. The numbers are the
response's own `scores`; the justifier is given the block and asked to explain
it, not to work a result out, and the block stands whatever the justifier writes
(also when it times out or fails and the jurors' own texts are returned).

The same numbers are in `model_results[]` for a program: `weight` on every entry,
and `scores` (the juror's own integers, in outcome order) on every `success`.

---

## Web Retrieval (`model_results[].web_retrieval`)

Every juror that answered (`success` or `parsing_error`) carries what its web
tools did, read from the provider's own response
(`src/lib/llm/web-retrieval.ts`). It is telemetry only: no score depends on it.
The EA copies `model_results` into the justification on IPFS, so it is public.

```json
"web_retrieval": {
  "web_tools": "on",
  "searches": 0,
  "pages_opened": 0,
  "fetch_errors": [
    { "url": "https://www.wsj.com/market-data/quotes/MSFT/historical-prices", "code": "url_not_allowed" }
  ],
  "search_errors": [],
  "pages": [],
  "queries": [],
  "page_errors_reported": true
}
```

- `web_tools`: `on` when the answer came from a request with the provider's web
  tools; `off` when the tools were not used (no link in the request,
  `AI_WEB_ACCESS=off`, a provider or model without web tools). When the
  web-tools request failed and the juror answered without web access, it is
  `off` with an `error`.
- `pages_opened` / `pages`: Anthropic counts pages whose content came back.
  OpenAI marks every page it opens `completed`, also when the model then says
  the site refused it, so for OpenAI this counts pages the model asked for and
  `page_errors_reported` is `false`.
- `fetch_errors`: Anthropic's codes, e.g. `url_not_allowed` (what Claude quotes
  as "You don't have permission to access this domain"), `url_not_accessible`,
  `url_not_in_prior_context`; `no_result` for a tool call the response ended
  before answering. OpenAI reports a call's status other than `completed`.
- With `count` > 1 the calls are added up. Lists are capped at 20 entries.

Each juror also gets one log line:
`🌐 WEB_RETRIEVAL: Anthropic-claude-sonnet-5 on, 0 pages opened, 0 searches, fetch errors: www.wsj.com url_not_allowed | {…}`.
A request that fails with 400 has no `model_results`; the log line is still written.

---

## Code mode (`codeReview`)

A request with a `codeReview` key is a claim evaluation against a stake listing
(design `docs/development/stake-attestation-design.md` §10.3, §10.5, §11). A
request without one is handled exactly as everything above describes. Code is
in `src/lib/code-review/`.

### Request

| Field | In code mode |
| --- | --- |
| `codeReview` | Validated with `@verdikta/common`'s `codeReview.validateCodeReviewRequest` (schema `code_review_request.v1.json`, the report hash, the claim's bCID). `null` or anything else invalid is a 400 |
| `prompt` | The listing's query (`codeReview.buildClaimQuery`). It must not carry the addendum's `verdikta-disclosure:` or `verdikta-dispute:` line: the EA strips both before the jury, and a request that still has one is refused |
| `outcomes` | Exactly `INVALID, DUPLICATE, LOW, MEDIUM, HIGH, CRITICAL` (`validateBugOutcomes`) |
| `models`, `iterations` | Checked with `codeReview.validateClassEnvelope` against `codeReview.codeClass`: pool models only, at most 3, `count` (NO_COUNTS) 1, `iterations` 1 |
| `attachments`, `attachmentNames` | The context pack and `report.md`, as text: a plain string, or a `data:` URI with a text media type (`text/*`, `application/json`, …). Any other attachment is refused |

### What the jury reads

One prompt, the same bytes for every juror (`claim-prompt.ts`): the claim
pre-prompt (trust tiers, the four questions, the six outcomes), then the
listing's query, the integrity and honesty flags, every lint/SAST finding, the
report as `canonicalReportJson`, `finding.json`, the known-issue and prior
finding ids, the pack, and on a dispute the maker's statement. Everything a
hunter, a maker or the code could have written is quoted in a block whose
BEGIN and END lines carry a hash of its own content, so quoted text cannot end
its block. The prompt's SHA-256 is in the response (`codeReview.promptSha256`).

When the listing names documents (`stake.documents`, owner decision Q61 (a)),
the pack carries them as their own tier, after the in-scope source (the code
runner's README, "The documents tier"). The pre-prompt lists them among the
pack's contents as the maker's statement of what the code is meant to do, for
question 1, not evidence of what it does.

The four questions state the two rules of `@verdikta/common`'s claim query,
version 2 (owner decisions Q66 (a), Q73 #5):

- A class rests on what the PoC demonstrates, or on what follows from it by a
  concrete line of reasoning that the claim itself sets out, tied to a file and
  line (question 2).
- A claim whose root cause is a listed known issue is DUPLICATE, even when the
  entry calls the behaviour intended or accepted (question 3). It is not INVALID
  as behaviour the code is not required to have (question 1).

### Time, cancellation and juror settings

- Jurors run until `deadlineMs − 45 s` (the justifier reserve), at most 480 s.
  The justifier then has at least 45 s and whatever the deadline leaves: all the
  time left before `deadlineMs` when it starts, never past it, so after a jury
  that finished early it has minutes. A justifier timeout therefore comes only at
  the deadline. `REQUEST_TIMEOUT_MS`, `MODEL_TIMEOUT_MS` and
  `JUSTIFICATION_TIMEOUT_MS` do not apply.
- Each call gets an `AbortSignal` that is aborted at its deadline and goes into
  the provider's HTTP request (Anthropic, OpenAI, OpenRouter, xAI; Hyperbolic
  and Ollama too, as justifiers: Ollama through its own `/api/chat`). The
  deadline covers the provider's setup as well, and the route answers at the
  deadline even if a provider ignores the signal. A Claude juror's client also gets
  the time left as its own timeout, because the Anthropic SDK refuses a non-streaming
  request above 21,333 max tokens without one (`anthropicClientOptions`). The signal
  is still what cancels the call.
- A juror's HTTP call holds for its whole window. Node's fetch (undici) gives up
  after 300 s without response headers, or after 300 s of silence in a body, and a
  non-streaming reasoning reply sends no headers until it is complete. So each
  juror call (and its repair call) has an undici dispatcher of its own, whose two
  limits are the time left to the jury deadline plus 15 s, and which is destroyed
  when the call settles (`juror-transport.ts`): OpenRouter and xAI pass it to
  `fetch`, the OpenAI and Anthropic clients as `fetchOptions.dispatcher`, and the
  OpenAI client also gets that figure as its own timeout in place of its 600 s
  default. The justifier and text mode keep Node's default dispatcher.
- A body read that does not finish within `REQUEST_TIMEOUT_MS` is the text-mode
  408, in either mode.
- Every juror runs with web access off, `maxTokens` = the class envelope's
  juror output (32,000 on `code-standard`, 12,000 on `code-premium`) and effort
  `high` (Claude 5: `output_config.effort` with adaptive thinking; OpenAI:
  `reasoning_effort`; OpenRouter: `reasoning.effort`; xAI: none, Grok 4 takes
  no `reasoning_effort`). A juror's answer is its reply only when the reply is
  exactly one JSON object (bare or in one ```json fence) with one non-negative
  integer per outcome summing to 1,000,000; anything else (prose, or a score
  object the juror merely quotes) gets one repair call with the same signal,
  which reads the reply as quoted data.
- Every juror is required (no Jev in the MVP): the first juror that fails ends
  the request and the others are cancelled.

### Responses

Success (200) has the text-mode shape (`scores` for the six outcomes, the
justification, `metadata`, `model_results`). The scores are the jurors'
weighted average rounded by largest remainder (ties to the lower index), so
they sum to exactly 1,000,000: flooring each one could lose more than the five
units settlement allows for the aggregator's own rounding. Plus:

```json
"codeReview": {
  "codeClass": "code-standard",
  "reportSha256": "…",
  "promptSha256": "…",
  "deadlineMs": 525000,
  "jurorTimeoutMs": 480000,
  "justifierReserveMs": 45000,
  "justifierMs": 61000,
  "maxTokens": 32000,
  "effort": "high"
}
```

`justifierReserveMs` is the reserve the jury's window leaves the justifier, not its
limit; `justifierMs` is how long the justifier ran, on every 200.

Every error has `{ "error", "errorCode", "retryable", "scores": [], "justification": "" }`,
plus `issues` (validation) or `jurors` (`{ juror: "<provider>:<model>", status,
duration_ms, message?, http_status? }`, status `success`, `failed`,
`parsing_error`, `timeout` or `cancelled`):

| Status | `errorCode` | `retryable` | When |
| --- | --- | --- | --- |
| 400 | `CODE_REVIEW_INVALID` | false | The `codeReview` field or the prompt is invalid |
| 400 | `CODE_REVIEW_ENVELOPE` | false | Outcomes, panel, NO_COUNTS or iterations outside the class envelope |
| 400 | `CODE_REVIEW_ATTACHMENT` | false | An attachment is not text |
| 400 | `CODE_REVIEW_JUROR_FAILED` | false | A juror's provider error, or a reply with no usable scores after the repair call |
| 400 | `CODE_REVIEW_JUSTIFIER_FAILED` | false | The justifier failed; the arbiter abstains rather than publish the jurors' text |
| **503** | **`CODE_REVIEW_JUROR_TIMEOUT`** | **true** | A juror did not answer by the jury deadline; every juror call was cancelled |
| 503 | `CODE_REVIEW_JUSTIFIER_TIMEOUT` | true | The justifier, which has at least 45 s and whatever the deadline leaves, did not finish by the deadline; the message (and its log line) names the ms it ran and its budget; nothing partial is returned |
| 504 | `CODE_REVIEW_DEADLINE` | false | `deadlineMs` leaves under 10 s of jury time after the reserve, or the deadline passed before the justifier |
| 500 | `CODE_REVIEW_INTERNAL` | false | An unexpected error, or `JUSTIFIER_MODEL` is not set as `provider:model` |

A 200's `codeReview` also holds `canaryFault`: [below](#the-canary-fault-switch).

The EA may retry a `retryable` error once while at least the justifier reserve
remains (node A4b); a 503 body never contains the provider-error wording the
EA's text-mode retry check stops on. A justifier timeout comes at the deadline,
so it leaves no time for a retry. Nothing is committed on any error.

### Test-only mock provider

`VERDIKTA_TEST_MOCK_PROVIDER=1` routes every provider name to a deterministic
mock (`src/lib/llm/mock-provider.ts`) for tests and the local pipeline; its
replies come from `VERDIKTA_TEST_MOCK_SCRIPT` (JSON by model id: `scores`,
`reply`, `delayMs`, `hang`, `error`, `status`, or an array per call). A
production build (`next build`) refuses it: while the flag is set there, every
provider call fails with an error naming the flag.

---

## Integration Guidelines for External Adapter

### Success Case (Status 200)
```javascript
if (response.status === 200) {
  const { scores, justification } = response.data;
  // Process scores array - always sums to 1,000,000
  // Every juror answered, unless the operator allows a partial jury:
  // metadata.models_failed and the result record say which case this is
}
```

### Failure Case (Status 400)
```javascript
if (response.status === 400) {
  const { error, scores, justification } = response.data;
  // Parse error message for diagnostic information
  // scores and justification will be empty
  // Log error details for debugging
}
```

### Recommended Error Handling
```javascript
try {
  const response = await fetch('/api/rank-and-justify', options);
  
  if (response.status === 200) {
    // Success - use scores and justification
    return response.data;
  } else if (response.status === 400) {
    // A juror gave no answer (or, with a partial jury allowed, too few did)
    // Check error.includes('Insufficient successful models')
    // Parse failure reasons from error message
    throw new Error(`AI models failed: ${response.data.error}`);
  } else {
    // Other error (500, 408, etc.)
    throw new Error(`Request failed: ${response.status}`);
  }
} catch (err) {
  // Handle network errors, timeouts, etc.
}
```

---

## Configuration

By default every juror must answer. An operator can lower the share of the jurors
that must answer with an environment variable (`ai-node/.env.local`, read at each
request):

```bash
MIN_SUCCESSFUL_MODELS_PERCENT=1  # Default: every juror
```

- unset, or `1` = ALL models must succeed. A juror that fails ends the request (scenario 3)
- `0.67` = At least 67% of models must succeed (3 of 3, 3 of 4)
- `0.5` = At least 50% of models must succeed, the rule before 2026-11: a two-model jury
  is answered by one model (scenario 2)

The number of jurors required is the share times the jury's size, rounded up, and
never less than one. A value that is not a number leaves the default; a number above 1
means every juror, and 0 or less means one juror.

Lowering it changes what this arbiter commits, not what the network settles: an answer
from part of a jury can differ from the answers of arbiters that ran all of it, and the
aggregator clusters the reveals. No installer step sets this variable.

### The canary fault switch

For the canary conditions of design §11, on real canaries with real providers (decision D9;
`src/lib/code-review/canary-fault.ts`). It is unrelated to the mock provider, which is test-only.
This process has no chain access, so it cannot measure a class. The External Adapter does
(`external-adapter/README.md`, "The canary fault switch") and mints a directive for one attempt.

A code-mode request may carry, beside `codeReview`:

```json
"canaryFault": { "action": "hold-juror-answer", "mac": "<64 hex>" }
```

`mac` is HMAC-SHA256 with the key `VERDIKTA_CANARY_FAULT_KEY` over
`verdikta-canary-fault/1\n<action>\n<claim.bcid>\n<reportSha256>`. It is acted on only if it
verifies with this node's key. With no key the field is ignored, so a direct POST to this port can
do nothing on any node. A directive that does not verify, or a field beside the two, is ignored
too, and the request is judged normally. A text-mode request never reads it. Read at each request
under a computed name, so `next build` cannot inline the key. No install or upgrade path sets it.

| Action | What happens |
|---|---|
| `hold-juror-answer` | The first juror's real answer is held until 5 s before the jury deadline, then the justifier follows |
| `late-juror` | The first juror's real call starts 3 s before the jury deadline, so it is on the wire when the deadline aborts it, and an answer that came back anyway is held to the abort: the 503 `CODE_REVIEW_JUROR_TIMEOUT` |
| `hold-justifier-answer` | The real justification is held until 5 s before the 45 s mark from the justifier's start, or 5 s before the deadline if that is sooner, though the justifier itself may run to the deadline |

That is all it can do. A hold gets the abort signal and returns nothing, so it never sees a score,
a justification or the prompt, and the prompt is built without the directive. A hold runs inside the
raced work, like a provider call, so a stage's deadline ends it whatever it does.

A 200 says what happened in `codeReview.canaryFault`: `{ "state", "action" }`, with `justifierMs`
(the same figure as `codeReview.justifierMs`) when an action ran. An error from the jury on (`CODE_REVIEW_JUROR_*`, `CODE_REVIEW_JUSTIFIER_*`, a
deadline passed before the justifier) carries the same `canaryFault: { state, action }` at its top
level, so a retry's verdict can say what caused the timeout before it. `state` is `off` (no key), `armed` (a usable key) or `refused` (a key of fewer
than 32 printable characters, or with a space: it never acts). `action` is what verified, or null.
`GET /api/health` carries `canary_fault: { state }`, and never the key.
