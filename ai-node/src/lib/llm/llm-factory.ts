import { LLMProvider } from './llm-provider-interface';
import { OllamaProvider } from './ollama-provider';
import { OpenAIProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { HyperbolicProvider } from './hyperbolic-provider';
import { XAIProvider } from './xai-provider';

export class LLMFactory {
  static async getProvider(provider: string): Promise<LLMProvider> {
    let llmProvider: LLMProvider;
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
    await llmProvider.initialize();
    return llmProvider;
  }
}
