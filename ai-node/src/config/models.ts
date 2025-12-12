export const modelConfig = {
  openai: [
    { name: 'gpt-3.5-turbo', supportsImages: false, supportsAttachments: false },
    { name: 'gpt-4', supportsImages: true, supportsAttachments: true },
    { name: 'gpt-4o', supportsImages: true, supportsAttachments: true },
    { name: 'o3', supportsImages: true, supportsAttachments: true },
    { name: 'gpt-4.1', supportsImages: true, supportsAttachments: true },
    { name: 'gpt-4.1-mini', supportsImages: true, supportsAttachments: true },
    { name: 'gpt-5', supportsImages: true, supportsAttachments: true },
    { name: 'gpt-5-mini', supportsImages: true, supportsAttachments: true },
    { name: 'gpt-5-2025-08-07', supportsImages: true, supportsAttachments: true },
    { name: 'gpt-5-mini-2025-08-07', supportsImages: true, supportsAttachments: true },
    { name: 'gpt-5-nano-2025-08-07', supportsImages: true, supportsAttachments: true },
    { name: 'gpt-5.2-2025-12-11', supportsImages: true, supportsAttachments: true },
  ],
  anthropic: [
    { name: 'claude-2.1', supportsImages: false, supportsAttachments: false },
    { name: 'claude-3-sonnet-20240229', supportsImages: true, supportsAttachments: true },
    { name: 'claude-3-5-sonnet-20241022', supportsImages: true, supportsAttachments: true },
    { name: 'claude-3-5-sonnet-20240620', supportsImages: true, supportsAttachments: true },
    { name: 'claude-3-5-haiku-20241022', supportsImages: true, supportsAttachments: true },
    { name: 'claude-3-7-sonnet-20250219', supportsImages: true, supportsAttachments: true },
    { name: 'claude-sonnet-4-20250514', supportsImages: true, supportsAttachments: true },
    { name: 'claude-sonnet-4', supportsImages: true, supportsAttachments: true },
  ],
  ollama: [
    { name: 'llama3.1:8b', supportsImages: false, supportsAttachments: true },
    { name: 'llava:7b', supportsImages: true, supportsAttachments: true },
    { name: 'deepseek-r1:8b', supportsImages: false, supportsAttachments: true },
    { name: 'qwen3:8b', supportsImages: false, supportsAttachments: true },
    { name: 'gemma3n:e4b', supportsImages: false, supportsAttachments: true },
    { name: 'qwen3:4b', supportsImages: false, supportsAttachments: true },
    { name: 'qwen3:1.7b', supportsImages: false, supportsAttachments: true },
    { name: 'gemma3n:e2b', supportsImages: false, supportsAttachments: true },
  ],
  hyperbolic: [
    { name: 'Qwen/Qwen3-235B-A22B-Instruct-2507', supportsImages: true, supportsAttachments: true },
    { name: 'deepseek-ai/DeepSeek-R1', supportsImages: true, supportsAttachments: true },
    { name: 'moonshotai/Kimi-K2-Instruct', supportsImages: true, supportsAttachments: true },
  ],
  xai: [
    // Grok 4.1 models (2M context, multimodal - text + image input/output)
    { name: 'grok-4-1-fast-reasoning', supportsImages: true, supportsAttachments: true },
    { name: 'grok-4-1-fast-non-reasoning', supportsImages: true, supportsAttachments: true },
    // Grok 4 models (2M context for fast variants, 256K for base)
    { name: 'grok-4-fast-reasoning', supportsImages: true, supportsAttachments: true },
    { name: 'grok-4-fast-non-reasoning', supportsImages: true, supportsAttachments: true },
    { name: 'grok-4-0709', supportsImages: true, supportsAttachments: true },
    // Code-specialized model (256K context)
    { name: 'grok-code-fast-1', supportsImages: true, supportsAttachments: true },
  ],
};
