import { ProviderClass, getOpenRouterDefaultModel } from '../../config/openrouter-models';

export type GatewayBackend = 'openrouter' | 'native';

export interface ProviderResolution {
  providerClass: ProviderClass;
  backend: GatewayBackend;
  modelOverride?: string;
  reason: string;
}

const CLASS_FROM_PROVIDER: Record<string, ProviderClass> = {
  openai: 'openai',
  anthropic: 'anthropic',
  xai: 'xai',
  grok: 'xai',
  hyperbolic: 'hyperbolic',
  'hyperbolic api': 'hyperbolic',
  ollama: 'ollama',
  'open-source': 'ollama',
  openrouter: 'openrouter',
};

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

export function resolveProviderClass(provider: string): ProviderClass {
  const normalized = normalizeProvider(provider);
  const providerClass = CLASS_FROM_PROVIDER[normalized];

  if (!providerClass) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  return providerClass;
}

function hasNativeKey(providerClass: ProviderClass): boolean {
  switch (providerClass) {
    case 'openai':
      return !!process.env.OPENAI_API_KEY;
    case 'anthropic':
      return !!process.env.ANTHROPIC_API_KEY;
    case 'xai':
      return !!(process.env.XAI_API_KEY || process.env.GROK_API_KEY);
    case 'hyperbolic':
      return !!process.env.HYPERBOLIC_API_KEY;
    case 'ollama':
      return true;
    case 'openrouter':
      return !!process.env.OPENROUTER_API_KEY;
    default:
      return false;
  }
}

function readClassOverride(providerClass: ProviderClass): GatewayBackend | null {
  const value = process.env[`${providerClass.toUpperCase()}_CLASS_PROVIDER`]?.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value === 'openrouter' || value === 'native') {
    return value;
  }
  return null;
}

function readClassModelOverride(providerClass: ProviderClass): string | undefined {
  return process.env[`${providerClass.toUpperCase()}_CLASS_MODEL`]?.trim() || undefined;
}

function readGlobalGateway(): GatewayBackend | null {
  const value = process.env.AI_GATEWAY?.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value === 'openrouter' || value === 'native') {
    return value;
  }
  return null;
}

export function resolveProviderConfig(provider: string): ProviderResolution {
  const providerClass = resolveProviderClass(provider);

  if (providerClass === 'ollama') {
    return {
      providerClass,
      backend: 'native',
      reason: 'Ollama is local-only',
    };
  }

  if (providerClass === 'openrouter') {
    return {
      providerClass,
      backend: 'openrouter',
      reason: 'OpenRouter-only provider',
    };
  }

  const classOverride = readClassOverride(providerClass);
  if (classOverride) {
    return {
      providerClass,
      backend: classOverride,
      modelOverride: readClassModelOverride(providerClass),
      reason: `${providerClass.toUpperCase()}_CLASS_PROVIDER override`,
    };
  }

  const globalOverride = readGlobalGateway();
  if (globalOverride) {
    return {
      providerClass,
      backend: globalOverride,
      modelOverride: readClassModelOverride(providerClass),
      reason: 'AI_GATEWAY override',
    };
  }

  // Native-first default: always prefer a provider's own native key when one is
  // configured. OpenRouter is only used to fill gaps — i.e. when there is no
  // native key for the class, or when a native key has been administratively
  // routed away via <CLASS>_CLASS_PROVIDER (handled above; the installer's
  // key-validation step sets that override when a native key is failing).
  if (hasNativeKey(providerClass)) {
    return {
      providerClass,
      backend: 'native',
      modelOverride: readClassModelOverride(providerClass),
      reason: 'native-first: native key present',
    };
  }

  if (process.env.OPENROUTER_API_KEY) {
    return {
      providerClass,
      backend: 'openrouter',
      modelOverride: readClassModelOverride(providerClass) || getOpenRouterDefaultModel(providerClass) || undefined,
      reason: 'no native key; routing via OpenRouter',
    };
  }

  // No native key and no OpenRouter key. Return native so the provider raises a
  // clear "missing API key" error at initialization rather than failing opaquely.
  return {
    providerClass,
    backend: 'native',
    modelOverride: readClassModelOverride(providerClass),
    reason: 'no keys configured; defaulting to native',
  };
}
