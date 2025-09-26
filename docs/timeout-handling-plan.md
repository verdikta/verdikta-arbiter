# AI-Node Timeout Handling Implementation Plan

## Overview

This document outlines a comprehensive plan to implement robust timeout handling for the Verdikta Arbiter AI-Node system. The goal is to prevent system backups caused by slow or hanging LLM provider calls, especially from open-source Ollama models, while maintaining system reliability and allowing for graceful degradation.

## 🚨 URGENT PRIORITY UPDATE (2025-01-27)

**CRITICAL SYSTEM FAILURE IDENTIFIED**: Production testing revealed catastrophic timeout failures requiring immediate action:

### Critical Issues Found:
- **537-second Ollama model hang** (9+ minutes for single call)
- **100% request failure rate** during Ollama testing
- **Promise.all() cascade failures** blocking entire system
- **Commercial models degraded** (OpenAI 83% timeout rate)
- **No model-level timeout protection** allowing indefinite hangs

### Immediate Action Required:
1. **🔥 URGENT: Model-level timeouts** - Prevent individual model hangs (Priority 1)
2. **🔥 URGENT: Promise.allSettled()** - Prevent cascade failures (Priority 1) 
3. **⚡ HIGH: Request-level timeout** - Ultimate circuit breaker (Priority 2)

**Impact**: Without these fixes, Ollama models will continue causing system-wide failures.

## Current System Analysis

### Existing Timeout Points
- **External Adapter HTTP Client**: 300s (configurable via `AI_TIMEOUT`)
- **External Adapter Server**: 300s (configurable via `SERVER_TIMEOUT`)
- **External Adapter Retry**: 3 attempts with exponential backoff
- **AI-Node Text Extraction**: 60s (configurable)
- **AI-Node Route Level**: No timeout protection
- **LLM Provider Calls**: No timeout protection

### Key Problems Identified
1. **Promise.all() Blocking**: Single slow model blocks entire request
2. **No Request-Level Timeout**: AI-node route can hang indefinitely
3. **No Individual Model Timeout**: Each model call can run without limit
4. **Cascading Failures**: Slow models cause system-wide backups
5. **No Partial Results**: All-or-nothing approach causes complete failures

## Solution Architecture

### Multi-Level Timeout System

#### Level 1: Request-Level Timeout (AI-Node)
- **Purpose**: Prevent entire requests from hanging indefinitely
- **Default**: 240s (4 minutes)
- **Configuration**: `REQUEST_TIMEOUT_MS` environment variable
- **Behavior**: Return partial results if some models complete within timeout

#### Level 2: Model-Level Timeout (AI-Node)
- **Purpose**: Prevent individual model processing from hanging
- **Default**: 180s (3 minutes)
- **Configuration**: `MODEL_TIMEOUT_MS` environment variable
- **Behavior**: Mark model as failed, continue with other models

#### Level 3: Provider Call Timeout (AI-Node)
- **Purpose**: Timeout individual API calls to LLM providers
- **Default**: 120s (2 minutes)
- **Configuration**: `PROVIDER_CALL_TIMEOUT_MS` environment variable
- **Behavior**: Retry with exponential backoff, then fail model

#### Level 4: External Adapter Timeout (External Adapter)
- **Current**: 300s (maintained as ultimate circuit breaker)
- **Purpose**: Final fallback timeout for entire evaluation

### Graceful Degradation Strategy

#### Partial Results Mode
- **≥50% models successful**: Return results with warning
- **<50% models successful**: Return error with partial data
- **Configuration**: `MIN_SUCCESSFUL_MODELS_PERCENT` (default: 0.5)
- **Toggle**: `ALLOW_PARTIAL_RESULTS` (default: true)

#### Fallback Scoring
- Failed models replaced with neutral/average scores
- Weight redistribution among successful models
- Clear indication in justification about failed models

### Configuration System

```typescript
interface TimeoutConfig {
  // Request-level timeout (total time for entire request)
  requestTimeoutMs: number;          // Default: 240000 (4 minutes)
  
  // Model-level timeout (time for all calls to one model)
  modelTimeoutMs: number;            // Default: 180000 (3 minutes)
  
  // Individual provider call timeout
  providerCallTimeoutMs: number;     // Default: 120000 (2 minutes)
  
  // Minimum successful models required (percentage)
  minSuccessfulModelsPercent: number; // Default: 0.5 (50%)
  
  // Whether to return partial results
  allowPartialResults: boolean;      // Default: true
  
  // Timeout for justification generation
  justificationTimeoutMs: number;    // Default: 60000 (1 minute)
}
```

### Enhanced Response Format

```typescript
interface TimeoutAwareResponse {
  scores: ScoreOutcome[];
  justification: string;
  
  // New timeout-related fields
  executionSummary: {
    totalDuration: number;
    timedOut: boolean;
    timeoutLevel?: 'request' | 'model' | 'provider';
    
    modelResults: {
      [modelKey: string]: {
        status: 'success' | 'timeout' | 'error';
        duration: number;
        error?: string;
      }
    };
    
    partialResults: boolean;
    successfulModelsCount: number;
    totalModelsCount: number;
  };
}
```

## Implementation Phases

### 🚨 URGENT PHASE: Critical System Fixes ⏳
**Status**: In Progress  
**Priority**: CRITICAL  
**Estimated Effort**: 2-3 hours

#### Tasks
- [ ] **URGENT**: Implement model-level timeout wrapper (120s per model)
- [ ] **URGENT**: Replace Promise.all() with Promise.allSettled() for graceful degradation
- [ ] **URGENT**: Add request-level timeout wrapper (240s total)
- [ ] **HIGH**: Enhanced error handling for Ollama connection issues
- [ ] **MEDIUM**: Circuit breaker pattern for repeatedly failing models

#### Files to Modify
- `ai-node/src/app/api/rank-and-justify/route.ts` (primary)
- `ai-node/src/lib/llm/ollama-provider.ts` (connection handling)

#### Critical Success Criteria
- No individual model can hang system for >2 minutes
- System continues processing when individual models fail
- Total request time never exceeds 4 minutes
- Ollama failures don't cascade to other models

### Phase 0: Justification Timeout (Quick Win) ✅
**Status**: Completed  
**Priority**: High  
**Estimated Effort**: 2 hours

#### Tasks
- [x] Implement 45-second timeout wrapper around justification generation (optimized allocation)
- [x] Add intelligent fallback to individual model responses on timeout
- [x] Add timeout configuration via `JUSTIFICATION_TIMEOUT_MS` environment variable
- [x] Update timing logs to include timeout information
- [x] Preserve scores and return partial results when justification times out
- [x] Prepare model timeout constants for future implementation

#### Files Modified
- `ai-node/src/app/api/rank-and-justify/route.ts`

### Phase 1: Promise.allSettled + Request Timeout ⏳
**Status**: Not Started  
**Priority**: High  
**Estimated Effort**: 2-3 days

#### Tasks
- [ ] Replace `Promise.all()` with `Promise.allSettled()` in parallel model processing
- [ ] Implement request-level timeout wrapper using `Promise.race()`
- [ ] Add partial result logic and weight redistribution
- [ ] Update response format to include execution summary
- [ ] Add basic timeout configuration via environment variables

#### Files to Modify
- `ai-node/src/app/api/rank-and-justify/route.ts`
- `ai-node/src/config/timeout-config.ts` (new)

### Phase 2: Model-Level Timeouts ⏳
**Status**: Not Started  
**Priority**: High  
**Estimated Effort**: 2-3 days

#### Tasks
- [ ] Wrap `processModelForIteration()` calls with timeout
- [ ] Implement model-specific timeout tracking and logging
- [ ] Add timeout error handling and fallback scoring
- [ ] Update timing logs to include timeout information

#### Files to Modify
- `ai-node/src/app/api/rank-and-justify/route.ts`
- `ai-node/src/utils/timeout-utils.ts` (new)

### Phase 3: Provider-Level Timeouts ⏳
**Status**: Not Started  
**Priority**: Medium  
**Estimated Effort**: 3-4 days

#### Tasks
- [ ] Add timeout wrappers to all LLM provider calls
- [ ] Implement provider-specific retry logic with timeouts
- [ ] Add circuit breaker pattern for repeatedly failing providers
- [ ] Update provider interfaces to support timeout configuration

#### Files to Modify
- `ai-node/src/lib/llm/openai-provider.ts`
- `ai-node/src/lib/llm/anthropic-provider.ts`
- `ai-node/src/lib/llm/ollama-provider.ts`
- `ai-node/src/lib/llm/llm-provider-interface.ts`

### Phase 4: Enhanced Error Handling ⏳
**Status**: Not Started  
**Priority**: Medium  
**Estimated Effort**: 2 days

#### Tasks
- [ ] Distinguish between timeout errors and other failures
- [ ] Add detailed timeout reporting in responses
- [ ] Implement timeout-aware retry strategies
- [ ] Update external adapter error handling for timeout scenarios

#### Files to Modify
- `ai-node/src/app/api/rank-and-justify/route.ts`
- `external-adapter/src/services/aiClient.js`
- `external-adapter/src/handlers/evaluateHandler.js`

## Environment Variables

### AI-Node Configuration
```bash
# Timeout settings (optimized for 300s total budget - prioritizes model processing)
REQUEST_TIMEOUT_MS=240000              # 4 minutes (80% of total budget)
MODEL_TIMEOUT_MS=120000                # 2 minutes per model (READY FOR IMPLEMENTATION)
PROVIDER_CALL_TIMEOUT_MS=90000         # 90 seconds per provider call
JUSTIFICATION_TIMEOUT_MS=45000         # 45 seconds (IMPLEMENTED - with individual model fallback)

# Partial results configuration
MIN_SUCCESSFUL_MODELS_PERCENT=0.5      # 50%
ALLOW_PARTIAL_RESULTS=true

# Feature flags
ENABLE_REQUEST_TIMEOUT=true
ENABLE_MODEL_TIMEOUT=true
ENABLE_PROVIDER_TIMEOUT=true
```

### External Adapter Configuration (Existing)
```bash
AI_TIMEOUT=300000                      # 5 minutes (maintained)
SERVER_TIMEOUT=300000                  # 5 minutes (maintained)
```

## Testing Strategy

### Test Scenarios
1. **Single Slow Model**: One Ollama model hangs, others complete normally
2. **Multiple Slow Models**: Multiple models timeout, test partial results
3. **All Models Timeout**: Complete timeout scenario
4. **Mixed Success/Timeout**: Some models succeed, others timeout
5. **Network Issues**: Simulate network connectivity problems
6. **Provider Rate Limiting**: Test timeout behavior under rate limits
7. **Concurrent Requests**: Multiple requests with timeout scenarios

### Test Implementation
- [ ] Unit tests for timeout utilities
- [ ] Integration tests for timeout scenarios
- [ ] Performance tests under load with timeouts
- [ ] End-to-end tests with external adapter

## Monitoring and Alerting

### Metrics to Track
- Request timeout rate (target: <10%)
- Model timeout rate by provider (target: <20%)
- Average response times by model/provider
- Partial result frequency
- Queue backup incidents
- Timeout recovery success rate

### Alerting Thresholds
- **Critical**: >15% request timeout rate
- **Warning**: >25% model timeout rate for any provider
- **Warning**: >10 concurrent hanging requests
- **Info**: Partial results >5% of requests

## Backward Compatibility

- All timeout features configurable and can be disabled
- Default behavior maintains current functionality when all models succeed
- Error response format remains compatible with existing external adapter
- Graceful fallback to current behavior if timeout features disabled

## Rollout Plan

### Development Phase
- [ ] Implement with feature flags for safe testing
- [ ] Comprehensive unit and integration testing
- [ ] Performance benchmarking

### Staging Phase
- [ ] Deploy with conservative timeout settings
- [ ] Monitor system behavior under realistic load
- [ ] Validate timeout scenarios work as expected

### Production Phase
- [ ] Gradual rollout with monitoring
- [ ] Real-world performance validation
- [ ] Timeout optimization based on actual usage patterns

## Risk Assessment

### High Risk
- **Breaking Changes**: Ensure backward compatibility maintained
- **Performance Impact**: Monitor for any performance degradation
- **Complex Edge Cases**: Thoroughly test timeout interaction scenarios

### Medium Risk
- **Configuration Complexity**: Provide clear documentation and defaults
- **Monitoring Overhead**: Ensure metrics collection doesn't impact performance

### Low Risk
- **User Experience**: Improved reliability should enhance user experience
- **System Stability**: Timeout handling should improve overall stability

## Success Criteria

### Primary Goals
- [ ] No system backups due to hanging model calls
- [ ] <10% request timeout rate under normal load
- [ ] Partial results available when some models succeed
- [ ] Clear timeout reporting and error handling

### Secondary Goals
- [ ] Improved system observability and monitoring
- [ ] Configurable timeout behavior for different deployment scenarios
- [ ] Robust handling of provider-specific timeout patterns

## Status Tracking

| Phase | Status | Start Date | Target Date | Completion Date | Notes |
|-------|--------|------------|-------------|-----------------|-------|
| URGENT | In Progress | 2025-01-27 | 2025-01-27 | - | **CRITICAL: System failure fixes** |
| Phase 0 | Completed | 2025-01-27 | 2025-01-27 | 2025-01-27 | Justification Timeout (Quick Win) |
| Phase 1 | Superseded | - | - | - | Merged into URGENT Phase |
| Phase 2 | Superseded | - | - | - | Merged into URGENT Phase |
| Phase 3 | Not Started | - | - | - | Provider-Level Timeouts |
| Phase 4 | Not Started | - | - | - | Enhanced Error Handling |

## Document History

| Date | Version | Changes | Author |
|------|---------|---------|--------|
| 2025-01-27 | 1.0 | Initial plan creation | AI Assistant |
| 2025-01-27 | 1.1 | Added justification timeout implementation | AI Assistant |
| 2025-01-27 | 2.0 | **URGENT**: Added critical system failure analysis and priority fixes | AI Assistant |

---

*This document will be updated as implementation progresses and requirements evolve.*
