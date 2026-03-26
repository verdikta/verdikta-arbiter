export type ProviderClass = 'openai' | 'anthropic' | 'xai' | 'hyperbolic' | 'ollama';

export const openRouterDefaultModels: Record<Exclude<ProviderClass, 'ollama'>, string> = {
  openai: 'openai/gpt-4o',
  anthropic: 'anthropic/claude-3-5-sonnet-20241022',
  xai: 'x-ai/grok-4-0709',
  hyperbolic: 'meta-llama/llama-3.3-70b-instruct',
};

export const openRouterModelPrefixes: Record<Exclude<ProviderClass, 'ollama'>, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  xai: 'x-ai',
  hyperbolic: 'meta-llama',
};

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
