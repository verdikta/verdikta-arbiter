export const modelConfig = {
  openai: [
    { name: 'gpt-3.5-turbo', supportsImages: false, supportsAttachments: false },
    { name: 'gpt-4', supportsImages: false, supportsAttachments: false },
    { name: 'gpt-4o', supportsImages: true, supportsAttachments: true },
  ],
  anthropic: [
    { name: 'claude-2.1', supportsImages: false, supportsAttachments: false },
    { name: 'claude-3-sonnet-20240229', supportsImages: true, supportsAttachments: true },
    { name: 'claude-3-5-sonnet-20241022', supportsImages: true, supportsAttachments: true },
  ],
  ollama: [
    // Add ollama models here
  ],
};
