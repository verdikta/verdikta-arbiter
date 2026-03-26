# MIGRATION — AI Gateway

## What changed

The AI node now includes a gateway abstraction that can route provider classes (`OpenAI`, `Anthropic`, `xAI`, `Hyperbolic`) through either native provider APIs or OpenRouter.

Ollama remains local-only and always uses native/local routing.

## Why

- Native keys remain the primary and most cost-effective path
- OpenRouter fills gaps for providers an operator doesn't have native keys for
- Enables broader ClassID coverage without accounts at every provider
- Centralized model routing logic with clear precedence rules

## Backward compatibility

Existing installs with native provider keys continue to work with no changes needed. Native keys are automatically detected and used.

## How to configure

### Most operators (have native keys)
Keep your existing keys — they will be used automatically:
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `HYPERBOLIC_API_KEY`

Optionally add OpenRouter to cover any providers you don't have native keys for:
- `OPENROUTER_API_KEY`

### New operators (limited native keys)
Enter whichever native keys you have, then add OpenRouter to fill gaps:
- `OPENAI_API_KEY=...` (if you have one)
- `OPENROUTER_API_KEY=...` (covers the rest; ~5% fee on top of token costs)

### Override controls
Force all classes through a specific backend:
- `AI_GATEWAY=native` — only use native keys (no OpenRouter)
- `AI_GATEWAY=openrouter` — route everything through OpenRouter

Per-class overrides take precedence:
- `OPENAI_CLASS_PROVIDER=native`
- `ANTHROPIC_CLASS_PROVIDER=openrouter`

### Legacy compatibility
- `AI_GATEWAY_LEGACY_NATIVE_FALLBACK=true` — opt-in for legacy behavior

## Routing precedence

1. Per-class override (`<CLASS>_CLASS_PROVIDER`)
2. Global override (`AI_GATEWAY`)
3. Legacy opt-in (`AI_GATEWAY_LEGACY_NATIVE_FALLBACK=true` + native key)
4. Native key present → uses native provider
5. `OPENROUTER_API_KEY` present → routes through OpenRouter

## Justifier model
`JUSTIFIER_MODEL` format remains supported:
- `Provider:model-name`

Example:
- `OpenAI:gpt-5-nano-2025-08-07`
