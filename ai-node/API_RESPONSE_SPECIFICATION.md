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

