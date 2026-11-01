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
- Scores always sum to 1,000,000
- Justification synthesizes reasoning from all models

---

### 2. Some Models Fail (≥50% Succeed) ⚠️

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
- Justification MAY include information about failed models (implementation dependent)
- Request succeeds if ≥50% of models succeed (configurable via `MIN_SUCCESSFUL_MODELS_PERCENT`)

**Example:** With 2 models (weights 0.6, 0.4):
- If only the 0.6-weighted model succeeds, its scores are returned directly (renormalized to 1.0)
- Failed model's scores are not included in calculation

---

### 3. Insufficient Models Succeed (<50%) ❌

**HTTP Status:** `400 Bad Request`

```json
{
  "error": "Insufficient successful models: 0/2 (minimum required: 1). Failures: OpenAI-gpt-4 (Network timeout); Anthropic-claude-3 (Unable to parse response: Invalid JSON format...)",
  "scores": [],
  "justification": ""
}
```

**Key Points:**
- Request fails if fewer than 50% of models succeed (configurable)
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

### Time, cancellation and juror settings

- Jurors run until `deadlineMs − 45 s` (the justifier reserve), at most 240 s;
  the justifier then gets 45 s, never past `deadlineMs`. `REQUEST_TIMEOUT_MS`,
  `MODEL_TIMEOUT_MS` and `JUSTIFICATION_TIMEOUT_MS` do not apply.
- Each call gets an `AbortSignal` that is aborted at its deadline and goes into
  the provider's HTTP request (Anthropic, OpenAI, OpenRouter, xAI; Hyperbolic
  and Ollama too, as justifiers: Ollama through its own `/api/chat`). The
  deadline covers the provider's setup as well, and the route answers at the
  deadline even if a provider ignores the signal.
- A body read that does not finish within `REQUEST_TIMEOUT_MS` is the text-mode
  408, in either mode.
- Every juror runs with web access off, `maxTokens` = the class envelope's
  juror output (8,000 on `code-standard`, 12,000 on `code-premium`) and effort
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
  "deadlineMs": 285000,
  "jurorTimeoutMs": 240000,
  "justifierReserveMs": 45000,
  "maxTokens": 8000,
  "effort": "high"
}
```

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
| 503 | `CODE_REVIEW_JUSTIFIER_TIMEOUT` | true | The justifier did not finish within its reserve; nothing partial is returned |
| 504 | `CODE_REVIEW_DEADLINE` | false | `deadlineMs` leaves under 10 s of jury time after the reserve, or the deadline passed before the justifier |
| 500 | `CODE_REVIEW_INTERNAL` | false | An unexpected error, or `JUSTIFIER_MODEL` is not set as `provider:model` |

The EA may retry a `retryable` error once while at least the justifier reserve
remains (node A4b); a 503 body never contains the provider-error wording the
EA's text-mode retry check stops on. Nothing is committed on any error.

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
  // Note: Some models may have failed, but enough succeeded
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
    // Partial or complete model failure
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

The minimum success threshold is configurable via environment variable:

```bash
MIN_SUCCESSFUL_MODELS_PERCENT=0.5  # Default: 50%
```

- `0.5` = At least 50% of models must succeed
- `0.67` = At least 67% of models must succeed  
- `1.0` = ALL models must succeed (no fallback tolerance)

