# Hyperbolic Provider Setup Guide

## Quick Start

The Hyperbolic provider has been implemented and is ready for testing! Follow these steps to configure and test it.

---

## Step 1: Add Your API Key

### Option A: For Development/Testing

Add your Hyperbolic API key to the AI Node environment file:

```bash
# Navigate to the AI node directory
cd /root/verdikta-arbiter/ai-node

# Edit the .env.local file
nano .env.local

# Add this line at the end:
HYPERBOLIC_API_KEY=your_api_key_here
```

**Replace `your_api_key_here` with your actual Hyperbolic API key.**

### Option B: For Production Installation

If you're using the installer, it will prompt you for the Hyperbolic API key during the setup process (this will be implemented in a future update).

---

## Step 2: Verify Configuration

Check that the configuration is correct:

```bash
# From the ai-node directory
grep HYPERBOLIC .env.local
```

You should see:
```
HYPERBOLIC_API_KEY=your_actual_key
```

---

## Step 3: Test the Provider

### Method 1: Using the Test Endpoint (Recommended)

The easiest way to test the Hyperbolic provider is using the built-in test endpoint:

1. **Start the AI Node:**
   ```bash
   cd /root/verdikta-arbiter/ai-node
   npm run dev
   ```

2. **Run the test endpoint:**
   ```bash
   # In a new terminal
   curl http://localhost:3000/api/test-hyperbolic
   ```

   This will:
   - Initialize the Hyperbolic provider
   - List all available models
   - Test each model with a simple prompt
   - Show response times and success/failure status

3. **Review the results:**
   You should see a JSON response with test results for each model.

### Method 2: Full Integration Test

You can also test with a complete arbitration request:

1. **Start the AI Node:**
   ```bash
   cd /root/verdikta-arbiter/ai-node
   npm run dev
   ```

2. **Send a test arbitration request:**
   ```bash
   curl -X POST http://localhost:3000/api/rank-and-justify \
     -H "Content-Type: application/json" \
     -d '{
       "prompt": "What is 2+2? Answer in one sentence.",
       "models": [
         {
           "provider": "hyperbolic",
           "model": "Qwen/Qwen3-235B-A22B-Instruct-2507",
           "weight": 1.0,
           "count": 1
         }
       ],
       "outcomes": ["Correct", "Incorrect"]
     }'
   ```

3. **Expected Response:**
   You should receive a JSON response with scores and a justification from the Hyperbolic model.

---

## Available Models

The following Hyperbolic models are now available:

### 1. Qwen/Qwen3-235B-A22B-Instruct-2507
- **Type:** High-performance reasoning model
- **Parameters:** 235B
- **Best For:** Complex reasoning, detailed analysis
- **Supports Images:** No
- **Supports Attachments:** Yes

### 2. deepseek-ai/DeepSeek-R1
- **Type:** Deep reasoning model with chain-of-thought
- **Best For:** Step-by-step reasoning, logical analysis
- **Supports Images:** No
- **Supports Attachments:** Yes

### 3. moonshotai/Kimi-K2-Instruct
- **Type:** Long-context model
- **Context Length:** 200K+ tokens
- **Best For:** Long documents, extensive context analysis
- **Supports Images:** No
- **Supports Attachments:** Yes

---

## Integration with Arbiter Node

### Using Hyperbolic in Arbitration Requests

When submitting arbitration requests, specify `hyperbolic` as the provider:

```json
{
  "prompt": "Analyze this contract dispute...",
  "models": [
    {
      "provider": "hyperbolic",
      "model": "Qwen/Qwen3-235B-A22B-Instruct-2507",
      "weight": 0.5,
      "count": 1
    },
    {
      "provider": "openai",
      "model": "gpt-4",
      "weight": 0.5,
      "count": 1
    }
  ],
  "outcomes": ["Accept", "Reject", "Modify"],
  "iterations": 1
}
```

### Multi-Provider Strategies

You can combine Hyperbolic with other providers for cost-effective hybrid approaches:

**Strategy 1: Cost-Optimized**
- Use Hyperbolic for initial analysis (low cost)
- Use OpenAI/Anthropic for final decision (high quality)

**Strategy 2: Balanced**
- 50% Hyperbolic (Qwen3-235B)
- 50% OpenAI (GPT-4)

**Strategy 3: High Volume**
- 100% Hyperbolic for non-critical cases
- Reserve expensive models for critical disputes

---

## Troubleshooting

### Issue: "HYPERBOLIC_API_KEY not configured"

**Solution:** Ensure you've added the API key to `.env.local`:
```bash
cd /root/verdikta-arbiter/ai-node
grep HYPERBOLIC .env.local
```

If missing, add it:
```bash
echo "HYPERBOLIC_API_KEY=your_key_here" >> .env.local
```

### Issue: "Unknown provider: hyperbolic"

**Solution:** Restart the AI Node to pick up the new provider:
```bash
cd /root/verdikta-arbiter/ai-node
npm run dev
```

### Issue: Model not responding / timeout

**Possible Causes:**
1. Invalid API key
2. Network connectivity issues
3. Hyperbolic service temporarily unavailable

**Debug Steps:**
```bash
# Check if API key is set
printenv | grep HYPERBOLIC

# Test API connectivity
curl -X POST "https://api.hyperbolic.xyz/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "Qwen/Qwen3-235B-A22B-Instruct-2507",
    "messages": [{"role": "user", "content": "test"}],
    "max_tokens": 10
  }'
```

### Issue: Response quality concerns

**Tips:**
- Try different models (Qwen3 vs DeepSeek vs Kimi)
- Adjust prompt clarity and specificity
- Compare with OpenAI/Anthropic responses
- Consider model strengths (reasoning vs long-context)

---

## Cost Comparison

| Provider | Model | Estimated Cost* | Use Case |
|----------|-------|----------------|----------|
| Hyperbolic | Qwen3-235B | ~$2-5 per 1M tokens | High-volume, cost-sensitive |
| Hyperbolic | DeepSeek-R1 | ~$2-5 per 1M tokens | Reasoning-intensive |
| Hyperbolic | Kimi-K2 | ~$2-5 per 1M tokens | Long-context analysis |
| OpenAI | GPT-4 | ~$10-30 per 1M tokens | Critical decisions |
| Anthropic | Claude Sonnet | ~$15-25 per 1M tokens | Complex reasoning |

*Approximate pricing. Check Hyperbolic documentation for current rates.

**Cost Savings Example:**
- 1000 arbitration requests
- Average 5000 tokens per request
- Total: 5M tokens

| Scenario | Provider Mix | Estimated Cost |
|----------|--------------|----------------|
| All OpenAI | 100% GPT-4 | $50-150 |
| Hybrid | 50% Hyperbolic + 50% OpenAI | $25-75 |
| Cost-Optimized | 100% Hyperbolic | $10-25 |

**Savings: 50-80% vs. pure OpenAI deployment**

---

## Advanced Configuration

### Custom Base URL (for testing)

If you need to use a different Hyperbolic endpoint:

```bash
# In .env.local
HYPERBOLIC_BASE_URL=https://custom-endpoint.hyperbolic.xyz/v1
```

### Timeout Configuration

Adjust timeout for long-running requests:

```bash
# In .env.local
HYPERBOLIC_TIMEOUT_MS=180000  # 3 minutes
```

### Model-Specific Parameters

Different models may have different optimal parameters. Edit `ai-node/src/lib/llm/hyperbolic-provider.ts` to adjust:

```typescript
// For Qwen3-235B: Higher temperature for creative tasks
temperature: 0.7,

// For DeepSeek-R1: Lower temperature for reasoning
temperature: 0.1,

// For Kimi-K2: Adjust for long context
max_tokens: 2000,
```

---

## Next Steps

### Immediate Testing
1. ✅ Add API key to `.env.local`
2. ✅ Test with simple prompt
3. ✅ Test with each model
4. ✅ Compare quality vs other providers

### Integration Testing
1. Test in full arbitration flow
2. Test with attachments
3. Test with multi-model jury
4. Benchmark performance and cost

### Production Deployment
1. Update installer to prompt for Hyperbolic key
2. Add monitoring and logging
3. Set up cost tracking
4. Document best practices

---

## Resources

- **Hyperbolic Documentation:** https://docs.hyperbolic.xyz/docs/getting-started
- **Hyperbolic Dashboard:** https://app.hyperbolic.xyz
- **API Status:** https://status.hyperbolic.xyz
- **Verdikta Arbiter Docs:** `/root/verdikta-arbiter/installer/docs/`

---

## Support

**For Hyperbolic Issues:**
- Check Hyperbolic documentation
- Contact Hyperbolic support

**For Integration Issues:**
- Check AI Node logs: `/root/verdikta-arbiter/ai-node/logs/`
- Review design document: `/root/verdikta-arbiter/docs/hyperbolic-provider-implementation.md`
- Check configuration: `.env.local`

---

## Implementation Status

✅ **Completed:**
- [x] HyperbolicProvider class implementation
- [x] Factory integration
- [x] Model configuration (3 models)
- [x] Basic error handling
- [x] Documentation

📋 **Pending:**
- [ ] Unit tests
- [ ] Integration tests
- [ ] Installer integration
- [ ] Performance benchmarking
- [ ] Production monitoring

---

**Last Updated:** October 1, 2025  
**Version:** 1.0 - Initial Implementation

