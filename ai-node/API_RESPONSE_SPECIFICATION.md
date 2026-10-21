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

