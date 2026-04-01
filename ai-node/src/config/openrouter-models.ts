export type ProviderClass = 'openai' | 'anthropic' | 'xai' | 'hyperbolic' | 'ollama' | 'openrouter';

export const openRouterDefaultModels: Record<Exclude<ProviderClass, 'ollama'>, string> = {
  openai: 'openai/gpt-5.2',
  anthropic: 'anthropic/claude-sonnet-4.5',
  xai: 'x-ai/grok-4',
  hyperbolic: 'deepseek/deepseek-r1',
  openrouter: 'openai/gpt-5.2',
};

export const openRouterModelPrefixes: Record<Exclude<ProviderClass, 'ollama'>, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  xai: 'x-ai',
  hyperbolic: 'meta-llama',
  openrouter: '',
};

/**
 * Explicit mapping from "prefix/nativeModel" to the correct OpenRouter model ID.
 *
 * Covers three categories:
 *   1. Legacy date-suffixed OpenAI names (ClassIDs 128, 131) -> softlinked OpenRouter IDs
 *   2. Legacy Anthropic names with hyphens + dates -> OpenRouter dot-notation IDs
 *   3. xAI native names -> OpenRouter equivalents (different naming conventions)
 *   4. Hyperbolic org/model names -> OpenRouter equivalents
 */
const OPENROUTER_MODEL_MAP: Record<string, string> = {
  // --- OpenAI legacy date-suffixed (best-effort mapping) ---
  'openai/gpt-5-2025-08-07': 'openai/gpt-5',
  'openai/gpt-5-mini-2025-08-07': 'openai/gpt-5-mini',
  'openai/gpt-5-nano-2025-08-07': 'openai/gpt-5-nano',
  'openai/gpt-5.1-2025-11-13': 'openai/gpt-5.1',
  'openai/gpt-5.1-codex-2025-11-13': 'openai/gpt-5.1-codex',
  'openai/gpt-5.1-codex-mini-2025-11-13': 'openai/gpt-5.1-codex-mini',
  'openai/gpt-5.2-2025-12-11': 'openai/gpt-5.2',

  // --- Anthropic legacy date-suffixed + hyphen-notation ---
  'anthropic/claude-3-sonnet-20240229': 'anthropic/claude-3-sonnet',
  'anthropic/claude-3-5-sonnet-20241022': 'anthropic/claude-3.5-sonnet',
  'anthropic/claude-3-5-sonnet-20240620': 'anthropic/claude-3.5-sonnet-20240620',
  'anthropic/claude-3-5-haiku-20241022': 'anthropic/claude-3.5-haiku',
  'anthropic/claude-3-7-sonnet-20250219': 'anthropic/claude-3.7-sonnet',
  'anthropic/claude-sonnet-4-20250514': 'anthropic/claude-sonnet-4',
  'anthropic/claude-sonnet-4-5-20250929': 'anthropic/claude-sonnet-4.5',
  'anthropic/claude-haiku-4-5-20251001': 'anthropic/claude-haiku-4.5',

  // --- xAI: native API uses hyphens and -reasoning/-non-reasoning suffixes;
  //     OpenRouter uses dots and controls reasoning via a parameter instead. ---
  'x-ai/grok-4-1-fast-reasoning': 'x-ai/grok-4.1-fast',
  'x-ai/grok-4-1-fast-non-reasoning': 'x-ai/grok-4.1-fast',
  'x-ai/grok-4-fast-reasoning': 'x-ai/grok-4-fast',
  'x-ai/grok-4-fast-non-reasoning': 'x-ai/grok-4-fast',
  'x-ai/grok-4-0709': 'x-ai/grok-4',
  'x-ai/grok-code-fast-1': 'x-ai/grok-code-fast-1',

  // --- Hyperbolic: org/model native names -> OpenRouter equivalents ---
  'Qwen/Qwen3-235B-A22B-Instruct-2507': 'qwen/qwen3-235b-a22b',
  'deepseek-ai/DeepSeek-R1': 'deepseek/deepseek-r1',
  'moonshotai/Kimi-K2-Instruct': 'moonshotai/kimi-k2',
};

/**
 * Strips a trailing date suffix (e.g. "-2025-08-07") from a model name.
 * Used as a last-resort fallback for unmapped legacy model names.
 */
function stripDateSuffix(model: string): string {
  return model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

/**
 * Resolves a native model name to the correct OpenRouter model ID.
 *
 * Resolution order:
 *   1. Check explicit OPENROUTER_MODEL_MAP
 *   2. Strip date suffix and re-check the map
 *   3. Fall back to prefix/model (or prefix/stripped-model for date-suffixed names)
 */
export function resolveOpenRouterModelId(
  prefix: string,
  nativeModel: string,
): string {
  // Models whose native names already contain a slash (e.g. Hyperbolic
  // models like "Qwen/Qwen3-235B-A22B-Instruct-2507")
  if (nativeModel.includes('/')) {
    const withPrefix = `${prefix}/${nativeModel}`;
    if (OPENROUTER_MODEL_MAP[withPrefix]) {
      return OPENROUTER_MODEL_MAP[withPrefix];
    }
    if (OPENROUTER_MODEL_MAP[nativeModel]) {
      return OPENROUTER_MODEL_MAP[nativeModel];
    }
    return nativeModel.toLowerCase();
  }

  const candidate = `${prefix}/${nativeModel}`;

  // Exact match in the map
  if (OPENROUTER_MODEL_MAP[candidate]) {
    return OPENROUTER_MODEL_MAP[candidate];
  }

  // Try stripping a date suffix and checking again
  const stripped = stripDateSuffix(nativeModel);
  if (stripped !== nativeModel) {
    const strippedCandidate = `${prefix}/${stripped}`;
    if (OPENROUTER_MODEL_MAP[strippedCandidate]) {
      return OPENROUTER_MODEL_MAP[strippedCandidate];
    }
    // Date was stripped but no map entry — use the stripped version directly
    return strippedCandidate;
  }

  return candidate;
}

export function getOpenRouterDefaultModel(providerClass: ProviderClass): string | null {
  if (providerClass === 'ollama') {
    return null;
  }

  return openRouterDefaultModels[providerClass];
}

export function getOpenRouterModelPrefix(providerClass: ProviderClass): string | null {
  if (providerClass === 'ollama') {
    return null;
  }

  return openRouterModelPrefixes[providerClass];
}
