import { LLMProvider } from './llm-provider-interface';
import { OllamaProvider } from './ollama-provider';
import { OpenAIProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';

export class LLMFactory {
  static async getProvider(provider: string): Promise<LLMProvider> {
    let llmProvider: LLMProvider;
    switch (provider) {
      case 'OpenAI':
        llmProvider = new OpenAIProvider();
        break;
      case 'Anthropic':
        llmProvider = new AnthropicProvider();
        break;
      case 'Open-source':
        llmProvider = new OllamaProvider();
        break;
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
    await llmProvider.initialize();
    return llmProvider;
  }
}
