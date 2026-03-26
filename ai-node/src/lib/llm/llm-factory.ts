import { LLMProvider } from './llm-provider-interface';
import { OllamaProvider } from './ollama-provider';
import { OpenAIProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { HyperbolicProvider } from './hyperbolic-provider';
import { XAIProvider } from './xai-provider';
import { OpenRouterProvider } from './openrouter-provider';
import { resolveProviderConfig } from './provider-config';

export class LLMFactory {
  static async getProvider(provider: string, classOverride?: string): Promise<LLMProvider> {
    const providerKey = classOverride || provider;
    const resolution = resolveProviderConfig(providerKey);

    let llmProvider: LLMProvider;

    if (resolution.backend === 'openrouter' && resolution.providerClass !== 'ollama') {
      const mappedModel = resolution.modelOverride || 'openai/gpt-4o';
      llmProvider = new OpenRouterProvider([
        {
          name: mappedModel,
          supportsImages: true,
          supportsAttachments: true,
        },
      ]);
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

    await llmProvider.initialize();
    return llmProvider;
  }
}
