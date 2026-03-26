jest.mock('../../../lib/llm/openrouter-provider', () => ({
  OpenRouterProvider: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    getModels: jest.fn().mockResolvedValue([]),
    generateResponse: jest.fn(),
    generateResponseWithImage: jest.fn(),
    generateResponseWithAttachments: jest.fn(),
    supportsImages: jest.fn().mockReturnValue(true),
    supportsAttachments: jest.fn().mockReturnValue(true),
  })),
}));

jest.mock('../../../lib/llm/openai-provider', () => ({
  OpenAIProvider: jest.fn().mockImplementation(() => ({ initialize: jest.fn().mockResolvedValue(undefined) })),
}));

jest.mock('../../../lib/llm/anthropic-provider', () => ({
  AnthropicProvider: jest.fn().mockImplementation(() => ({ initialize: jest.fn().mockResolvedValue(undefined) })),
}));

jest.mock('../../../lib/llm/xai-provider', () => ({
  XAIProvider: jest.fn().mockImplementation(() => ({ initialize: jest.fn().mockResolvedValue(undefined) })),
}));

jest.mock('../../../lib/llm/hyperbolic-provider', () => ({
  HyperbolicProvider: jest.fn().mockImplementation(() => ({ initialize: jest.fn().mockResolvedValue(undefined) })),
}));

jest.mock('../../../lib/llm/ollama-provider', () => ({
  OllamaProvider: jest.fn().mockImplementation(() => ({ initialize: jest.fn().mockResolvedValue(undefined) })),
}));

import { LLMFactory } from '../../../lib/llm/llm-factory';
import { OpenRouterProvider } from '../../../lib/llm/openrouter-provider';
import { OpenAIProvider } from '../../../lib/llm/openai-provider';

describe('LLMFactory gateway routing', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AI_GATEWAY;
    delete process.env.OPENAI_CLASS_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AI_GATEWAY_LEGACY_NATIVE_FALLBACK;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('uses OpenRouter by default when OPENROUTER_API_KEY is present', async () => {
    process.env.OPENROUTER_API_KEY = 'or-key';

    await LLMFactory.getProvider('OpenAI');

    expect(OpenRouterProvider).toHaveBeenCalled();
    expect(OpenAIProvider).not.toHaveBeenCalled();
  });

  test('uses native when AI_GATEWAY=native is set', async () => {
    process.env.AI_GATEWAY = 'native';
    process.env.OPENAI_API_KEY = 'native-key';

    await LLMFactory.getProvider('OpenAI');

    expect(OpenAIProvider).toHaveBeenCalled();
    expect(OpenRouterProvider).not.toHaveBeenCalled();
  });

  test('per-class override beats global override in mixed mode', async () => {
    process.env.AI_GATEWAY = 'openrouter';
    process.env.OPENAI_CLASS_PROVIDER = 'native';

    await LLMFactory.getProvider('OpenAI');

    expect(OpenAIProvider).toHaveBeenCalled();
    expect(OpenRouterProvider).not.toHaveBeenCalled();
  });

  test('legacy native opt-in fallback is still supported', async () => {
    process.env.AI_GATEWAY_LEGACY_NATIVE_FALLBACK = 'true';
    process.env.OPENAI_API_KEY = 'native-key';

    await LLMFactory.getProvider('OpenAI');

    expect(OpenAIProvider).toHaveBeenCalled();
  });
});
