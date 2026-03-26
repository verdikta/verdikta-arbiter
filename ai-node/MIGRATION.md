# MIGRATION — OpenRouter Gateway Default

## What changed

The AI node now uses a gateway abstraction where provider classes (`OpenAI`, `Anthropic`, `xAI`, `Hyperbolic`) route through OpenRouter by default.

Ollama remains local-only and always uses native/local routing.

## Why

- One default integration path
- Easier operator setup
- Centralized model routing logic
- Keeps native providers available as explicit opt-in paths

## Backward compatibility

Existing installs with native provider keys continue to work.

Behavior is:
1. Per-class override (`<CLASS>_CLASS_PROVIDER`)
2. Global override (`AI_GATEWAY`)
3. Legacy native opt-in (`AI_GATEWAY_LEGACY_NATIVE_FALLBACK=true` + native key present)
4. Default: OpenRouter

If `OPENROUTER_API_KEY` is missing and a native key exists for that class, gateway logs a warning and falls back to native for that class.

## How to migrate

### Recommended (default)
Set:
- `OPENROUTER_API_KEY`

Optional:
- `AI_GATEWAY=openrouter`

### Keep native-only behavior explicitly
Set:
- `AI_GATEWAY=native`
- corresponding native keys (`OPENAI_API_KEY`, etc.)

### Mixed mode
Set global `AI_GATEWAY=openrouter` and override selected classes:
- `OPENAI_CLASS_PROVIDER=native`
- `ANTHROPIC_CLASS_PROVIDER=native`

## Justifier model
`JUSTIFIER_MODEL` format remains supported:
- `Provider:model-name`

Example:
- `OpenAI:gpt-5-nano-2025-08-07`
