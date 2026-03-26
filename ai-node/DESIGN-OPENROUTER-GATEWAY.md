# DESIGN — OpenRouter Gateway Routing

## Routing owner

Routing decisions are centralized in:
- `src/lib/llm/provider-config.ts`

Provider construction is in:
- `src/lib/llm/llm-factory.ts`

OpenRouter implementation is in:
- `src/lib/llm/openrouter-provider.ts`

## Precedence table

| Priority | Source | Example | Result |
|---|---|---|---|
| 1 | Per-class override | `OPENAI_CLASS_PROVIDER=native` | class uses native |
| 2 | Global override | `AI_GATEWAY=openrouter\|native` | all non-ollama classes follow mode |
| 3 | Legacy opt-in | `AI_GATEWAY_LEGACY_NATIVE_FALLBACK=true` + native key | class uses native |
| 4 | Default | none above | class uses OpenRouter |

Special case:
- `ollama` is always native/local.

Safety behavior:
- Presence of native keys alone does **not** auto-activate native mode.
- If `OPENROUTER_API_KEY` is missing and native key exists, class falls back to native with warning.

## Runtime observability

`/api/health` includes:
- `ai_gateway.mode`
- `ai_gateway.openrouterConfigured`
- per-class routing list with backend/model/reason

This allows operators to verify effective routing without inspecting source code.
