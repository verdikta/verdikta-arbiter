import { LLMProvider } from './llm-provider-interface';

const SUPPORTED_IMAGE_FORMATS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_FILE_SIZE = 20 * 1024 * 1024;

export class OpenRouterProvider implements LLMProvider {
  private apiKey: string;
  private readonly providerName = 'OpenRouter';
  private readonly baseUrl: string;
  private models: Array<{ name: string; supportsImages: boolean; supportsAttachments: boolean }>;

  constructor(models?: Array<{ name: string; supportsImages: boolean; supportsAttachments: boolean }>) {
    this.apiKey = process.env.OPENROUTER_API_KEY || '';
    this.baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    this.models = models || [
      { name: 'openai/gpt-4o', supportsImages: true, supportsAttachments: true },
    ];
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      console.warn('[OpenRouter] OPENROUTER_API_KEY not set. Provider will fail on request.');
      return;
    }

    console.log('[OpenRouter] Provider ready');
  }

  async getModels(): Promise<Array<{ name: string; supportsImages: boolean; supportsAttachments: boolean }>> {
    return this.models;
  }

  supportsImages(model: string): boolean {
    const modelInfo = this.models.find(m => m.name === model);
    return modelInfo?.supportsImages ?? true;
  }

  supportsAttachments(model: string): boolean {
    const modelInfo = this.models.find(m => m.name === model);
    return modelInfo?.supportsAttachments ?? true;
  }

  async generateResponse(
    prompt: string,
    model: string,
    options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' }
  ): Promise<string> {
    return this.callChatCompletions(prompt, model, [], options);
  }

  async generateResponseWithImage(prompt: string, model: string, base64Image: string, mediaType: string = 'image/jpeg'): Promise<string> {
    if (!SUPPORTED_IMAGE_FORMATS.includes(mediaType)) {
      throw new Error(`[${this.providerName}] Unsupported image format: ${mediaType}`);
    }

    const approximateFileSize = base64Image.length * 0.75;
    if (approximateFileSize > MAX_FILE_SIZE) {
      throw new Error(`[${this.providerName}] Image file size must be under 20 MB.`);
    }

    return this.callChatCompletions(prompt, model, [
      {
        type: 'image_url',
        image_url: {
          url: `data:${mediaType};base64,${base64Image}`,
        },
      },
    ]);
  }

  async generateResponseWithAttachments(
    prompt: string,
    model: string,
    attachments: Array<{ type: string; content: string; mediaType: string }>,
    options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' }
  ): Promise<string> {
    const attachmentContent = attachments.map(attachment => {
      if (attachment.type === 'image') {
        if (!SUPPORTED_IMAGE_FORMATS.includes(attachment.mediaType)) {
          throw new Error(`[${this.providerName}] Unsupported image format: ${attachment.mediaType}`);
        }

        const approximateFileSize = attachment.content.length * 0.75;
        if (approximateFileSize > MAX_FILE_SIZE) {
          throw new Error(`[${this.providerName}] Image file size must be under 20 MB.`);
        }

        return {
          type: 'image_url',
          image_url: {
            url: `data:${attachment.mediaType};base64,${attachment.content}`,
            detail: 'auto',
          },
        };
      }

      return {
        type: 'text',
        text: attachment.content,
      };
    });

    return this.callChatCompletions(prompt, model, attachmentContent as any[], options);
  }

  private async callChatCompletions(
    prompt: string,
    model: string,
    contentBlocks: any[] = [],
    options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' }
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error('[OpenRouter] OPENROUTER_API_KEY not configured');
    }

    const payload: any = {
      model,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }, ...contentBlocks],
        },
      ],
      stream: false,
      max_tokens: this.isReasoningModel(model)
        ? parseInt(process.env.REASONING_MODEL_MAX_TOKENS || '16000')
        : 1000,
    };

    if (options?.reasoning) {
      payload.reasoning = options.reasoning;
    }
    if (options?.verbosity) {
      payload.verbosity = options.verbosity;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`[OpenRouter] HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('[OpenRouter] Invalid response payload: missing choices[0].message.content');
    }

    return content;
  }

  private isReasoningModel(model: string): boolean {
    const normalized = model.toLowerCase();
    return normalized.includes('o1') || normalized.includes('o3') || normalized.includes('gpt-5') || normalized.includes('reasoning');
  }
}
