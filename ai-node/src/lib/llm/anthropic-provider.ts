import { LLMProvider } from './llm-provider-interface';
import { ChatAnthropic } from "@langchain/anthropic";
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

    const response = await anthropic.invoke([{
      role: "user",
      content: [
        { type: "text", text: prompt },
        {
          type: "image_url",
          image_url: { url: dataUrl }
        }
      ]
    }]);

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

    // Check if this model supports native PDF processing
    const supportsNativePDF = this.supportsNativePDF(model);

    // Separate PDFs from other attachments
    const pdfAttachments = attachments.filter(att => att.mediaType === 'application/pdf');
    const otherAttachments = attachments.filter(att => att.mediaType !== 'application/pdf');

    // Use native PDF support for supported models
    if (supportsNativePDF && pdfAttachments.length > 0) {
      console.log(`[${this.providerName}] Using native PDF support for ${pdfAttachments.length} PDF(s)`);
      return this.generateResponseWithNativePDFSupport(prompt, model, pdfAttachments, otherAttachments);
    }

    // Fall back to original implementation for non-PDF or non-supporting models
    for (const attachment of otherAttachments) {
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
      ...otherAttachments.map(attachment => {
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

    const response = await anthropic.invoke([{
      role: "user",
      content: messageContent
    }]);

    if (typeof response.content !== 'string') {
      throw new Error('Unexpected response format from Anthropic');
    }
    return response.content;
  }

  supportsAttachments(model: string): boolean {
    const modelInfo = this.models.find(m => m.name === model);
    return modelInfo ? modelInfo.supportsAttachments : false;
  }

  /**
   * Check if the model supports native PDF processing
   */
  private supportsNativePDF(model: string): boolean {
    const pdfCapableModels = [
      'claude-sonnet-4-20250514', 'claude-4-opus',
      'claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-5-haiku',
      'claude-4-sonnet',
    ];
    return pdfCapableModels.some(supportedModel => model.includes(supportedModel));
  }

  /**
   * Generate response using Anthropic's native PDF support
   */
  private async generateResponseWithNativePDFSupport(
    prompt: string, 
    model: string, 
    pdfAttachments: Array<{ type: string, content: string, mediaType: string }>,
    otherAttachments: Array<{ type: string, content: string, mediaType: string }>
  ): Promise<string> {
    try {
      // Use Anthropic's direct client for native PDF support
      const { Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: this.apiKey });

      // Build message content with native PDF support
      const contentBlocks: any[] = [
        { type: "text", text: prompt }
      ];

      // Add PDF attachments using Anthropic's document structure
      for (const pdfAttachment of pdfAttachments) {
        // Validate PDF size (Anthropic limit: 32MB, 100 pages)
        const pdfSizeBytes = (pdfAttachment.content.length * 3) / 4; // Approximate base64 to bytes conversion
        if (pdfSizeBytes > 32 * 1024 * 1024) {
          throw new Error(`PDF file size (${Math.round(pdfSizeBytes / 1024 / 1024)}MB) exceeds Anthropic's 32MB limit`);
        }

        // Use Anthropic's document content block for PDFs
        contentBlocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: pdfAttachment.content
          }
        });
      }

      // Add other attachments (images, text, etc.)
      for (const attachment of otherAttachments) {
        if (attachment.type === "image") {
          if (!SUPPORTED_IMAGE_FORMATS.includes(attachment.mediaType)) {
            throw new Error(`Unsupported image format: ${attachment.mediaType}`);
          }
          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: attachment.mediaType,
              data: attachment.content
            }
          });
        } else {
          // Handle text content
          contentBlocks.push({ type: "text", text: attachment.content });
        }
      }

      // Make the API call with native PDF support
      const response = await client.messages.create({
        model: model,
        messages: [
          {
            role: "user",
            content: contentBlocks
          }
        ],
        max_tokens: 1000
      });

      const content = response.content[0];
      if (!content || content.type !== 'text') {
        throw new Error('No text content in Anthropic response');
      }

      console.log(`[${this.providerName}] Native PDF processing successful, response length: ${content.text.length}`);
      return content.text;

    } catch (error: any) {
      console.error(`[${this.providerName}] Native PDF processing failed:`, error.message);
      
      // Provide helpful error messages based on common issues
      if (error.message?.includes('32MB') || error.message?.includes('file size')) {
        throw new Error(`PDF too large for Anthropic (max 32MB). Consider splitting the document.`);
      } else if (error.message?.includes('pages') || error.message?.includes('100')) {
        throw new Error(`PDF has too many pages for Anthropic (max 100 pages).`);
      } else if (error.message?.includes('document') || error.message?.includes('media_type')) {
        throw new Error(`PDF processing error - ensure you have Anthropic PDF beta access enabled.`);
      } else if (error.message?.includes('model')) {
        throw new Error(`Model ${model} does not support PDF processing. Use Claude Opus 4, Sonnet 4, or newer models.`);
      } else {
        throw new Error(`Anthropic PDF processing failed: ${error.message}`);
      }
    }
  }
}
