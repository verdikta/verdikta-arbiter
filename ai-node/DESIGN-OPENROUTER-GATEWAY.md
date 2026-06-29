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
| 1 | Per-class override | `OPENAI_CLASS_PROVIDER=openrouter` | class follows override (auto-managed by the installer's key-validation step for failing native keys) |
| 2 | Global override | `AI_GATEWAY=openrouter\|native` | all non-ollama classes follow mode |
| 3 | Native key present | `OPENAI_API_KEY` set | class uses native (native-first default) |
| 4 | OpenRouter key present | `OPENROUTER_API_KEY` set | class uses OpenRouter (only when no native key) |

Native-first is the default: a class with a configured native key always routes natively unless a higher-priority override says otherwise. OpenRouter is purely a gap-filler for classes without a working native key.

Special cases:
- `ollama` is always native/local.
- `AI_GATEWAY_LEGACY_NATIVE_FALLBACK` is **deprecated and a no-op** — native-first is now the default, so the flag has no effect.

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
