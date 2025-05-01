import '@anthropic-ai/sdk/shims/node';
import { LLMProvider } from './llm-provider-interface';
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from '@langchain/core/messages';
import { modelConfig } from '../../config/models';

const SUPPORTED_IMAGE_FORMATS = ['image/jpeg', 'image/png'];

export class AnthropicProvider implements LLMProvider {
  private apiKey: string;
  private readonly providerName = 'Anthropic';
  private models: Array<{ name: string; supportsImages: boolean; supportsAttachments: boolean }>;

  constructor(apiKey: string = process.env.ANTHROPIC_API_KEY || '') {
    this.apiKey = apiKey;
    if (!this.apiKey) {
      console.warn('ANTHROPIC_API_KEY is not set. Anthropic provider may not work correctly.');
    }
    this.models = modelConfig.anthropic;
  }

  async getModels(): Promise<Array<{ name: string; supportsImages: boolean; supportsAttachments: boolean }>> {
    return this.models.map(model => ({
      ...model,
      supportsAttachments: model.supportsImages
    }));
  }

  supportsImages(model: string): boolean {
    const modelInfo = this.models.find(m => m.name === model);
    return modelInfo ? modelInfo.supportsImages : false;
  }

  async generateResponse(prompt: string, model: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set');
    }
    const anthropic = new ChatAnthropic({
      anthropicApiKey: this.apiKey,
      modelName: model,
    });
    const response = await anthropic.invoke(prompt);
    if (typeof response.content !== 'string') {
      throw new Error('Unexpected response format from Anthropic');
    }
    return response.content;
  }

  async generateResponseWithImage(prompt: string, model: string, base64Image: string, mediaType: string = 'image/jpeg'): Promise<string> {
    if (!this.supportsImages(model)) {
      throw new Error(`[${this.providerName}] Model ${model} does not support image inputs.`);
    }
    if (!this.apiKey) {
      throw new Error(`[${this.providerName}] ANTHROPIC_API_KEY is not set`);
    }
    if (!SUPPORTED_IMAGE_FORMATS.includes(mediaType)) {
      throw new Error(`[${this.providerName}] Model ${model}: Unsupported image format: ${mediaType}. Only JPEG and PNG formats are supported.`);
    }

    const anthropic = new ChatAnthropic({
      anthropicApiKey: this.apiKey,
      modelName: model,
    });

    const dataUrl = `data:${mediaType};base64,${base64Image}`;

    const message = new HumanMessage({
      content: [
        { type: "text", text: prompt },
        {
          type: "image_url",
          image_url: { url: dataUrl }
        }
      ],
    });

    const response = await anthropic.invoke([message]);

    if (typeof response.content !== 'string') {
      throw new Error('Unexpected response format from Anthropic');
    }
    return response.content;
  }

  async initialize(): Promise<void> {
    // No asynchronous initialization needed
    return Promise.resolve();
  }

  async generateResponseWithAttachments(prompt: string, model: string, attachments: Array<{ type: string, content: string, mediaType: string }>): Promise<string> {
    if (!this.supportsAttachments(model)) {
      throw new Error(`[${this.providerName}] Model ${model} does not support attachments.`);
    }
    if (!this.apiKey) {
      throw new Error(`[${this.providerName}] ANTHROPIC_API_KEY is not set`);
    }

    for (const attachment of attachments) {
      if (attachment.type === 'image' && !SUPPORTED_IMAGE_FORMATS.includes(attachment.mediaType)) {
        throw new Error(`[${this.providerName}] Model ${model}: Unsupported image format: ${attachment.mediaType}. Only JPEG and PNG formats are supported.`);
      }
    }

    const anthropic = new ChatAnthropic({
      anthropicApiKey: this.apiKey,
      modelName: model,
    });

    const messageContent = [
      { type: "text", text: prompt },
      ...attachments.map(attachment => {
        if (attachment.type === "image") {
          return {
            type: "image_url",
            image_url: { url: `data:${attachment.mediaType};base64,${attachment.content}` }
          };
        } else {
          return { type: "text", text: attachment.content };
        }
      })
    ];

    const message = new HumanMessage({
      content: messageContent
    });

    const response = await anthropic.invoke([message]);

    if (typeof response.content !== 'string') {
      throw new Error('Unexpected response format from Anthropic');
    }
    return response.content;
  }

  supportsAttachments(model: string): boolean {
    const modelInfo = this.models.find(m => m.name === model);
    return modelInfo ? modelInfo.supportsAttachments : false;
  }
}
