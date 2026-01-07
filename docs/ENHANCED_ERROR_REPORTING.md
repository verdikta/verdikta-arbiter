# Enhanced Error Reporting

## Overview

This document describes the enhanced error reporting system implemented in Verdikta Arbiter. The system provides structured, machine-readable error information while maintaining full backward compatibility with existing clients.

## Changes Summary

### AI Node (`rank-and-justify/route.ts`)
- ✅ Added TypeScript interfaces for structured error reporting
- ✅ Enhanced LLM provider error capture with detailed categorization
- ✅ Collected warnings during attachment processing
- ✅ Added metadata, model_results, and warnings to response

### External Adapter (`evaluateHandler.js`)
- ✅ Updated `createAndUploadJustification` to preserve enhanced fields
- ✅ Maintained backward compatibility with existing structure

## Backward Compatibility

**✅ 100% Backward Compatible**

All existing fields remain unchanged:
- `scores` - Array of score outcomes
- `justification` - Text justification
- `timestamp` - ISO timestamp

New fields are **optional** and **additive**:
- `metadata` - Evaluation metadata (optional)
- `model_results` - Model-level details (optional)
- `warnings` - Non-catastrophic warnings (optional)
- `error` - Catastrophic error message (optional, existing field now also used for partial info)

**Clients ignoring new fields will work exactly as before.**

---

## Enhanced `justification.json` Structure

### Success Case (All Models Succeeded)

```json
{
  "scores": [
    {"outcome": "Approve", "score": 750000},
    {"outcome": "Reject", "score": 200000},
    {"outcome": "Request More Info", "score": 50000}
  ],
  "justification": "After careful analysis of the evidence...",
  "timestamp": "2025-01-06T12:34:56.789Z",
  
  "metadata": {
    "models_requested": 3,
    "models_successful": 3,
    "models_failed": 0,
    "success_threshold_met": true,
    "total_duration_ms": 8450
  },
  
  "model_results": [
    {
      "provider": "OpenAI",
      "model": "gpt-5",
      "status": "success",
      "duration_ms": 3450
    },
    {
      "provider": "Anthropic",
      "model": "claude-sonnet-4",
      "status": "success",
      "duration_ms": 4200
    },
    {
      "provider": "xAI",
      "model": "grok-4",
      "status": "success",
      "duration_ms": 2800
    }
  ]
}
```

### Partial Success (Some Models Failed, But Evaluation Succeeded)

```json
{
  "scores": [
    {"outcome": "Approve", "score": 600000},
    {"outcome": "Reject", "score": 350000},
    {"outcome": "Request More Info", "score": 50000}
  ],
  "justification": "Based on analysis from available models...\n\nFrom model gpt-5:\n[justification]\n\nFrom model claude-sonnet-4:\nModel timed out or failed: Model timed out after 120000ms",
  "timestamp": "2025-01-06T12:45:30.123Z",
  
  "metadata": {
    "models_requested": 3,
    "models_successful": 2,
    "models_failed": 1,
    "success_threshold_met": true,
    "total_duration_ms": 125000
  },
  
  "model_results": [
    {
      "provider": "OpenAI",
      "model": "gpt-5",
      "status": "success",
      "duration_ms": 4200
    },
    {
      "provider": "Anthropic",
      "model": "claude-sonnet-4",
      "status": "timeout",
      "duration_ms": 120000,
      "error_type": "timeout",
      "error_message": "Model claude-sonnet-4 timed out after 120000ms"
    },
    {
      "provider": "xAI",
      "model": "grok-4",
      "status": "success",
      "duration_ms": 3100
    }
  ],
  
  "warnings": [
    {
      "type": "model_timeout",
      "message": "Model Anthropic-claude-sonnet-4 timed out: Model claude-sonnet-4 timed out after 120000ms",
      "severity": "warning",
      "model": "Anthropic-claude-sonnet-4",
      "details": {
        "error_type": "timeout",
        "duration_ms": 120000
      }
    }
  ]
}
```

### With Attachment Processing Warnings

```json
{
  "scores": [
    {"outcome": "Approve", "score": 800000},
    {"outcome": "Reject", "score": 200000}
  ],
  "justification": "Analysis complete...",
  "timestamp": "2025-01-06T13:00:00.000Z",
  
  "metadata": {
    "models_requested": 2,
    "models_successful": 2,
    "models_failed": 0,
    "success_threshold_met": true,
    "total_duration_ms": 9200
  },
  
  "model_results": [
    {
      "provider": "OpenAI",
      "model": "gpt-5",
      "status": "success",
      "duration_ms": 4500
    },
    {
      "provider": "xAI",
      "model": "grok-4",
      "status": "success",
      "duration_ms": 3200
    }
  ],
  
  "warnings": [
    {
      "type": "attachment_unsupported",
      "message": "Model xAI-grok-4 does not support native PDF processing, using text extraction",
      "severity": "info",
      "model": "xAI-grok-4"
    }
  ]
}
```

### API Error from Provider

```json
{
  "scores": [
    {"outcome": "Approve", "score": 1000000}
  ],
  "justification": "Limited analysis due to model failures...",
  "timestamp": "2025-01-06T14:15:00.000Z",
  
  "metadata": {
    "models_requested": 3,
    "models_successful": 1,
    "models_failed": 2,
    "success_threshold_met": true,
    "total_duration_ms": 15300
  },
  
  "model_results": [
    {
      "provider": "OpenAI",
      "model": "gpt-5",
      "status": "success",
      "duration_ms": 4800
    },
    {
      "provider": "Anthropic",
      "model": "claude-sonnet-4",
      "status": "failed",
      "duration_ms": 120000,
      "error_type": "rate_limit",
      "error_message": "Rate limit exceeded. Please retry after 30 seconds.",
      "error_code": "rate_limit_exceeded",
      "http_status": 429
    },
    {
      "provider": "xAI",
      "model": "grok-4",
      "status": "failed",
      "duration_ms": 120000,
      "error_type": "authentication",
      "error_message": "Invalid API key for xAI",
      "http_status": 401
    }
  ],
  
  "warnings": [
    {
      "type": "model_failure",
      "message": "Model Anthropic-claude-sonnet-4 failed: Rate limit exceeded. Please retry after 30 seconds.",
      "severity": "warning",
      "model": "Anthropic-claude-sonnet-4",
      "details": {
        "error_type": "rate_limit",
        "duration_ms": 120000,
        "http_status": 429
      }
    },
    {
      "type": "model_failure",
      "message": "Model xAI-grok-4 failed: Invalid API key for xAI",
      "severity": "warning",
      "model": "xAI-grok-4",
      "details": {
        "error_type": "authentication",
        "duration_ms": 120000,
        "http_status": 401
      }
    }
  ]
}
```

### Parsing Error

```json
{
  "scores": [
    {"outcome": "Approve", "score": 700000},
    {"outcome": "Reject", "score": 300000}
  ],
  "justification": "Analysis complete with some issues...",
  "timestamp": "2025-01-06T15:00:00.000Z",
  
  "metadata": {
    "models_requested": 2,
    "models_successful": 1,
    "models_failed": 1,
    "success_threshold_met": true,
    "total_duration_ms": 7500
  },
  
  "model_results": [
    {
      "provider": "OpenAI",
      "model": "gpt-5",
      "status": "success",
      "duration_ms": 4200
    },
    {
      "provider": "Anthropic",
      "model": "claude-sonnet-4",
      "status": "parsing_error",
      "duration_ms": 3100,
      "error_type": "parsing_error",
      "error_message": "Unable to parse response: The model returned an unexpected format..."
    }
  ],
  
  "warnings": [
    {
      "type": "model_failure",
      "message": "Model Anthropic-claude-sonnet-4 failed: Unable to parse response: The model returned an unexpected format...",
      "severity": "warning",
      "model": "Anthropic-claude-sonnet-4",
      "details": {
        "error_type": "parsing_error",
        "duration_ms": 3100
      }
    }
  ]
}
```

### Catastrophic Failure (Insufficient Successful Models)

```json
{
  "scores": [],
  "justification": "",
  "timestamp": "2025-01-06T16:00:00.000Z",
  
  "error": "Insufficient successful models: 1/4 (minimum required: 2). Failures: OpenAI-gpt-5 (timeout); Anthropic-claude-sonnet-4 (rate_limit); xAI-grok-4 (authentication)",
  
  "metadata": {
    "models_requested": 4,
    "models_successful": 1,
    "models_failed": 3,
    "success_threshold_met": false,
    "total_duration_ms": 125000
  },
  
  "model_results": [
    {
      "provider": "OpenAI",
      "model": "gpt-5",
      "status": "timeout",
      "duration_ms": 120000,
      "error_type": "timeout",
      "error_message": "Model gpt-5 timed out after 120000ms"
    },
    {
      "provider": "Anthropic",
      "model": "claude-sonnet-4",
      "status": "failed",
      "duration_ms": 120000,
      "error_type": "rate_limit",
      "error_message": "Rate limit exceeded",
      "http_status": 429
    },
    {
      "provider": "xAI",
      "model": "grok-4",
      "status": "failed",
      "duration_ms": 120000,
      "error_type": "authentication",
      "error_message": "Invalid API key",
      "http_status": 401
    },
    {
      "provider": "OpenAI",
      "model": "gpt-4o",
      "status": "success",
      "duration_ms": 4500
    }
  ]
}
```

---

## Error Types Captured

### Model Status Types
- `success` - Model completed successfully
- `failed` - Model failed due to API/provider error
- `timeout` - Model exceeded timeout threshold
- `parsing_error` - Model response couldn't be parsed

### Error Type Categories
- `authentication` - Invalid API key, unauthorized
- `authorization` - Access denied, forbidden
- `rate_limit` - Rate limit exceeded, too many requests
- `model_not_found` - Model doesn't exist or not accessible
- `content_policy` - Content flagged by safety filters
- `token_limit` - Context length or token limit exceeded
- `provider_error` - Provider service error (5xx)
- `timeout` - Request timeout
- `network` - Network connectivity issues
- `parsing_error` - Unable to parse model response
- `unknown` - Uncategorized error

### Warning Types
- `model_timeout` - Model timed out (non-catastrophic)
- `model_failure` - Model failed (non-catastrophic)
- `attachment_unsupported` - Model doesn't support attachment type
- `attachment_skipped` - Attachment was skipped during processing
- `attachment_processing_error` - Error processing attachments

### Warning Severity Levels
- `info` - Informational (e.g., using text extraction instead of native PDF)
- `warning` - Non-critical issue (e.g., model timeout but evaluation succeeded)
- `error` - Error that didn't prevent completion (e.g., attachment processing failed)

---

## Client Integration Examples

### JavaScript/TypeScript Client

```typescript
interface JustificationContent {
  scores: Array<{outcome: string; score: number}>;
  justification: string;
  timestamp: string;
  // Enhanced fields (optional)
  metadata?: {
    models_requested: number;
    models_successful: number;
    models_failed: number;
    success_threshold_met: boolean;
    total_duration_ms?: number;
  };
  model_results?: Array<{
    provider: string;
    model: string;
    status: 'success' | 'failed' | 'timeout' | 'parsing_error';
    duration_ms: number;
    error_type?: string;
    error_message?: string;
    error_code?: string;
    http_status?: number;
  }>;
  warnings?: Array<{
    type: string;
    message: string;
    severity: 'info' | 'warning' | 'error';
    model?: string;
    details?: any;
  }>;
  error?: string;
}

async function fetchJustification(cid: string): Promise<JustificationContent> {
  const response = await fetch(`https://ipfs.io/ipfs/${cid}`);
  return await response.json();
}

// Usage example
const justification = await fetchJustification(resultCID);

// Backward compatible - existing code still works
console.log('Scores:', justification.scores);
console.log('Justification:', justification.justification);

// Enhanced - check for additional information
if (justification.metadata) {
  console.log(`Success rate: ${justification.metadata.models_successful}/${justification.metadata.models_requested}`);
}

if (justification.model_results) {
  const failedModels = justification.model_results.filter(m => m.status !== 'success');
  failedModels.forEach(model => {
    console.warn(`Model ${model.provider}-${model.model} failed:`, model.error_message);
  });
}

if (justification.warnings) {
  justification.warnings.forEach(warning => {
    console.log(`[${warning.severity}] ${warning.message}`);
  });
}
```

### Solidity Contract Example

```solidity
// Your existing contract code works without changes
function processResult(string memory resultCID) external {
    // Fetch from IPFS and parse scores
    // Existing logic unchanged
}

// Optional: Add enhanced error checking
function getModelSuccessRate(string memory resultCID) external view returns (uint256, uint256) {
    // Parse metadata from IPFS result
    // Return (models_successful, models_requested)
}
```

---

## Testing Scenarios

### Test Case 1: Full Success
- **Setup**: 3 models, all succeed
- **Expected**: All model_results show `status: "success"`, no warnings
- **Verify**: `metadata.models_successful === 3`, `metadata.models_failed === 0`

### Test Case 2: Partial Success (Timeout)
- **Setup**: 4 models, 1 times out (50% threshold)
- **Expected**: 3 successes, 1 timeout, evaluation succeeds
- **Verify**: Warning for timeout, `metadata.success_threshold_met === true`

### Test Case 3: API Rate Limit
- **Setup**: Model hits rate limit
- **Expected**: `error_type: "rate_limit"`, `http_status: 429`
- **Verify**: Error message includes "rate limit"

### Test Case 4: Invalid API Key
- **Setup**: Model has invalid credentials
- **Expected**: `error_type: "authentication"`, `http_status: 401`
- **Verify**: Error message includes authentication details

### Test Case 5: PDF Attachment with Mixed Support
- **Setup**: 2 models, 1 supports native PDF, 1 doesn't
- **Expected**: Warning for unsupported model
- **Verify**: `warnings` includes `attachment_unsupported`

### Test Case 6: Catastrophic Failure
- **Setup**: 4 models, only 1 succeeds (below 50%)
- **Expected**: Error response, detailed failure info
- **Verify**: `error` field populated, `metadata.success_threshold_met === false`

---

## Migration Guide

### For Existing Clients

**No changes required!** Your existing code will continue to work.

### To Leverage Enhanced Features

**Step 1**: Update your types/interfaces to include optional new fields
**Step 2**: Add checks for `metadata`, `model_results`, and `warnings`
**Step 3**: Handle errors more granularly based on `error_type`
**Step 4**: Display warnings to users for transparency

**Example**:
```javascript
// Before (still works)
if (result.error) {
  console.error('Evaluation failed:', result.error);
}

// After (enhanced)
if (result.error) {
  console.error('Evaluation failed:', result.error);
  
  // Show which models failed and why
  if (result.model_results) {
    result.model_results
      .filter(m => m.status !== 'success')
      .forEach(m => {
        console.log(`  - ${m.provider}-${m.model}: ${m.error_message}`);
      });
  }
}
```

---

## Performance Impact

- **Request latency**: No change (new data collected during existing processing)
- **Response size**: ~0.5-2KB larger (negligible for IPFS)
- **IPFS upload**: ~50-100ms additional (one-time per evaluation)
- **Client parsing**: Minimal (optional fields ignored if not used)

---

## Future Enhancements

Potential future additions (not yet implemented):
- Retry information (how many retries before success/failure)
- Token usage statistics per model
- Cost tracking per model
- Model version information
- Detailed timing breakdown per processing stage

---

## Summary

The enhanced error reporting system provides:
- ✅ **Full backward compatibility** - existing clients work unchanged
- ✅ **Structured error data** - machine-readable for automation
- ✅ **Detailed failure information** - specific error types and messages
- ✅ **Non-catastrophic warnings** - visibility into partial failures
- ✅ **Model-level visibility** - know exactly which models succeeded/failed
- ✅ **Actionable information** - clients can make informed decisions

All while maintaining the existing API contract and requiring zero changes for current users.

