import { LLMProvider } from './llm-provider-interface';
import { OllamaProvider } from './ollama-provider';
import { OpenAIProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { HyperbolicProvider } from './hyperbolic-provider';
import { XAIProvider } from './xai-provider';
import { OpenRouterProvider } from './openrouter-provider';
import { resolveProviderConfig } from './provider-config';
import { getOpenRouterModelPrefix } from '../../config/openrouter-models';
import { MOCK_REFUSED_MESSAGE, MockProvider, mockProviderState } from './mock-provider';

export class LLMFactory {
  /**
   * `options.signal` (code mode) is handed to the provider's initialization, so
   * setup work such as Ollama's model discovery is aborted with the call.
   */
  static async getProvider(provider: string, options?: { signal?: AbortSignal }): Promise<LLMProvider> {
    // The test-only mock (mock-provider.ts): off unless VERDIKTA_TEST_MOCK_PROVIDER=1,
    // never in a production build. While on, every provider name resolves to it.
    const mock = mockProviderState();
    if (mock === 'refused') {
      throw new Error(MOCK_REFUSED_MESSAGE);
    }
    if (mock === 'on') {
      const mockProvider = new MockProvider(provider);
      await mockProvider.initialize();
      console.log(`[LLMFactory] Class=${provider} → backend=mock (test-only)`);
      return mockProvider;
    }

    const resolution = resolveProviderConfig(provider);

    let llmProvider: LLMProvider;

    if (resolution.backend === 'openrouter' && resolution.providerClass !== 'ollama') {
      const mappedModel = resolution.modelOverride || 'openai/gpt-4o';
      const prefix = getOpenRouterModelPrefix(resolution.providerClass) || '';
      llmProvider = new OpenRouterProvider(
        [
          {
            name: mappedModel,
            supportsImages: true,
            supportsAttachments: true,
          },
        ],
        prefix,
      );
      console.log(`[LLMFactory] Class=${provider} → backend=openrouter model=${mappedModel}`);
    } else {
      switch (provider) {
        case 'OpenAI':
        case 'openai':
          llmProvider = new OpenAIProvider();
          break;
        case 'Anthropic':
        case 'anthropic':
          llmProvider = new AnthropicProvider();
          break;
        case 'Open-source':
        case 'ollama':
        case 'Ollama':
          llmProvider = new OllamaProvider();
          break;
        case 'Hyperbolic':
        case 'hyperbolic':
        case 'Hyperbolic API':  // ClassID data uses "Hyperbolic API" as provider name
          llmProvider = new HyperbolicProvider();
          break;
        case 'xAI':
        case 'xai':
        case 'XAI':
        case 'Grok':
        case 'grok':
          llmProvider = new XAIProvider();
          break;
        default:
          throw new Error(`Unknown provider: ${provider}`);
      }
      console.log(`[LLMFactory] Class=${provider} → backend=native`);
    }

    await (options?.signal
      ? (llmProvider.initialize as (signal?: AbortSignal) => Promise<void>).call(llmProvider, options.signal)
      : llmProvider.initialize());
    return llmProvider;
  }
}
