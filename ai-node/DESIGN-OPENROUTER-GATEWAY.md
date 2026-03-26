# DESIGN — AI Gateway Routing

## Overview

The AI gateway routes each provider class to either a **native provider** (direct API) or **OpenRouter** (unified proxy). Native keys are preferred when present — OpenRouter serves as a fallback for providers an operator doesn't have native keys for, enabling broader ClassID coverage at a small markup (~5%).

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
| 4 | Native key present | `OPENAI_API_KEY` set | class uses native |
| 5 | OpenRouter key present | `OPENROUTER_API_KEY` set | class uses OpenRouter |

Special case:
- `ollama` is always native/local.

Typical operator scenarios:
- **Has all native keys**: Every class routes natively. OpenRouter not needed.
- **Has some native keys + OpenRouter**: Native classes go direct; uncovered classes fall back to OpenRouter.
- **Has only OpenRouter**: All non-Ollama classes route through OpenRouter.

## Runtime observability

`/api/health` includes:
- `ai_gateway.mode`
- `ai_gateway.openrouterConfigured`
- per-class routing list with backend/model/reason

This allows operators to verify effective routing without inspecting source code.
