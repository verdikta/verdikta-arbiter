export const modelConfig = {
  openai: [
    { name: 'gpt-3.5-turbo', supportsImages: false, supportsAttachments: false },
    { name: 'gpt-4', supportsImages: false, supportsAttachments: false },
    { name: 'gpt-4o', supportsImages: true, supportsAttachments: true },
    { name: 'o3',supportsImages: true, supportsAttachments: true },
    { name: 'gpt-4.1',supportsImages: true, supportsAttachments: true },
    { name: 'gpt-4.1-mini',supportsImages: true, supportsAttachments: true },
  ],
  anthropic: [
    { name: 'claude-2.1', supportsImages: false, supportsAttachments: false },
    { name: 'claude-3-sonnet-20240229', supportsImages: true, supportsAttachments: true },
    { name: 'claude-3-5-sonnet-20241022', supportsImages: true, supportsAttachments: true },
    { name: 'claude-3-5-sonnet-20240620', supportsImages: true, supportsAttachments: true },
    { name: 'claude-3-5-haiku-20241022', supportsImages: true, supportsAttachments: true },
    { name: 'claude-3-7-sonnet-20250219', supportsImages: true, supportsAttachments: true },
    { name: 'claude-sonnet-4-20250514', supportsImages: true, supportsAttachments: true },
  ],
  ollama: [
    // Add ollama models here
  ],
};
