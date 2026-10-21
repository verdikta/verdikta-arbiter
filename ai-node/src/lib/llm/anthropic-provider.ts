import { LLMProvider } from './llm-provider-interface';
import { ChatAnthropic } from "@langchain/anthropic";
import { modelConfig } from '../../config/models';
import {
  AnthropicChatParams,
  LEGACY_TEMPERATURE,
  MODERN_MAX_TOKENS,
  SAMPLING_FREE_PARAMS,
  acceptsSamplingParams,
  anthropicChatParams,
  extractTextContent,
  isSamplingParamRejection,
} from './anthropic-request-params';
import { attachmentRequestError } from './attachment-errors';
import { WebAccessOption, anthropicModelSupportsWebTools, shouldUseWebTools, webMaxUses, withWebAccessNote } from './web-access';
import { WebRetrieval, WebRetrievalListener, summarizeAnthropicWebBlocks, webToolsOff } from './web-retrieval';

type ChatInput = Parameters<ChatAnthropic['invoke']>[0];

const SUPPORTED_IMAGE_FORMATS = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Beta header for the web_fetch server tool (web_search needs none). */
export const ANTHROPIC_WEB_FETCH_BETA = 'web-fetch-2025-09-10';

/** Page text one web_fetch may add to the context: bounds what a long page costs the operator. */
export const WEB_FETCH_MAX_CONTENT_TOKENS = 25000;

/** A server-tool turn can stop with pause_turn; it is resumed at most this many times. */
const MAX_PAUSE_CONTINUATIONS = 3;

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

  async generateResponse(prompt: string, model: string, options?: WebAccessOption): Promise<string> {
    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set');
    }
    if (options?.webAccess !== false && shouldUseWebTools(prompt) && anthropicModelSupportsWebTools(model)) {
      const answer = await this.tryWebTools(model, [{ type: 'text', text: withWebAccessNote(prompt) }], options?.onWebRetrieval);
      if (answer !== null) return answer;
    }
    return this.invokeText(model, prompt);
  }

  private createChat(model: string, params: AnthropicChatParams): ChatAnthropic {
    // Sampling parameters are chosen per model (anthropic-request-params.ts):
    // Claude ≤ 4.6 gets temperature 0.7 as always; Opus 4.7+ / Claude 5 reject
    // temperature, top_p and top_k with a 400, so they get none. LangChain only
    // sends a field when it is set, so nothing else has to be "disabled" here.
    return new ChatAnthropic({
      anthropicApiKey: this.apiKey,
      modelName: model,
      ...params,
    });
  }

  /**
   * Invoke a chat model and return its text. If the API still rejects a sampling
   * parameter (a model the version rule mis-classified, or one that changed its
   * rules), the call is retried once without any — so a parameter we do not need
   * can never take a jury member down.
   */
  private async invokeText(model: string, input: ChatInput): Promise<string> {
    const params = anthropicChatParams(model);
    try {
      const response = await this.createChat(model, params).invoke(input);
      return extractTextContent(response.content);
    } catch (error: any) {
      if (params.temperature === undefined || !isSamplingParamRejection(error)) {
        throw error;
      }
      console.warn(`[${this.providerName}] ${model} rejected a sampling parameter (${error.message}); retrying without sampling parameters`);
      const response = await this.createChat(model, { ...SAMPLING_FREE_PARAMS }).invoke(input);
      return extractTextContent(response.content);
    }
  }

  async generateResponseWithImage(prompt: string, model: string, base64Image: string, mediaType: string = 'image/jpeg'): Promise<string> {
    if (!this.supportsImages(model)) {
      throw new Error(`[${this.providerName}] Model ${model} does not support image inputs.`);
    }
    if (!this.apiKey) {
      throw new Error(`[${this.providerName}] ANTHROPIC_API_KEY is not set`);
    }
    if (!SUPPORTED_IMAGE_FORMATS.includes(mediaType)) {
      throw new Error(`[${this.providerName}] Model ${model}: Unsupported image format: ${mediaType}. Supported formats are: JPEG, PNG, WEBP, and GIF.`);
    }

    const dataUrl = `data:${mediaType};base64,${base64Image}`;

    return this.invokeText(model, [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        {
          type: "image_url",
          image_url: { url: dataUrl }
        }
      ]
    }]);
  }

  async initialize(): Promise<void> {
    // No asynchronous initialization needed
    return Promise.resolve();
  }

  async generateResponseWithAttachments(
    prompt: string, 
    model: string, 
    attachments: Array<{ type: string, content: string, mediaType: string }>,
    options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' } & WebAccessOption
  ): Promise<string> {
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

    // Links in the request are opened by Anthropic's web tools; same inputs as below.
    if (shouldUseWebTools(prompt, attachments) && anthropicModelSupportsWebTools(model)) {
      const blocks = this.nativeContentBlocks(model, withWebAccessNote(prompt), supportsNativePDF ? pdfAttachments : [], otherAttachments);
      const answer = await this.tryWebTools(model, blocks, options?.onWebRetrieval);
      if (answer !== null) return answer;
    }

    // Use native PDF support for supported models
    if (supportsNativePDF && pdfAttachments.length > 0) {
      console.log(`[${this.providerName}] Using native PDF support for ${pdfAttachments.length} PDF(s)`);
      return this.generateResponseWithNativePDFSupport(prompt, model, pdfAttachments, otherAttachments);
    }

    // Fall back to original implementation for non-PDF or non-supporting models
    for (const attachment of otherAttachments) {
      if (attachment.type === 'image' && !SUPPORTED_IMAGE_FORMATS.includes(attachment.mediaType)) {
        throw new Error(`[${this.providerName}] Model ${model}: Unsupported image format: ${attachment.mediaType}. Supported formats are: JPEG, PNG, WEBP, and GIF.`);
      }
    }

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

    return this.invokeText(model, [{
      role: "user",
      content: messageContent
    }]);
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
    const contentBlocks = this.nativeContentBlocks(model, prompt, pdfAttachments, otherAttachments);

    try {
      // Use Anthropic's direct client for native PDF support
      const { Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: this.apiKey });

      // Make the API call with native PDF support
      const response = await client.messages.create({
        model: model,
        messages: [
          {
            role: "user",
            content: contentBlocks
          }
        ],
        max_tokens: 1000,
        // Claude ≤ 4.6 accepts temperature (never together with top_p); Opus 4.7+ and
        // Claude 5 reject every sampling parameter, so they get none.
        ...(acceptsSamplingParams(model) ? { temperature: LEGACY_TEMPERATURE } : {})
      });

      // The answer is the first text block (a thinking block may precede it).
      const content = response.content.find(block => block.type === 'text');
      if (!content || content.type !== 'text') {
        throw new Error('No text content in Anthropic response');
      }

      console.log(`[${this.providerName}] Native PDF processing successful, response length: ${content.text.length}`);
      return content.text;

    } catch (error: any) {
      console.error(`[${this.providerName}] Native PDF request failed for ${model}:`, error.message);
      // Keep the provider's status and message; say which input it is about.
      throw attachmentRequestError(this.providerName, model, error, {
        hasPdf: true,
        hasImage: otherAttachments.some(att => att.type === 'image')
      });
    }
  }

  /**
   * Content blocks for the direct client: the prompt, PDFs as document blocks,
   * images as base64 image blocks, anything else as text.
   */
  private nativeContentBlocks(
    model: string,
    prompt: string,
    pdfAttachments: Array<{ type: string, content: string, mediaType: string }>,
    otherAttachments: Array<{ type: string, content: string, mediaType: string }>
  ): any[] {
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
          throw new Error(`[${this.providerName}] Model ${model}: Unsupported image format: ${attachment.mediaType}. Supported formats are: JPEG, PNG, WEBP, and GIF.`);
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

    return contentBlocks;
  }

  /**
   * The answer with Anthropic's web_fetch and web_search server tools enabled, or
   * null when that request fails: the juror then answers without web access (as
   * every request did before), and the warning says why. onWebRetrieval hears what
   * the tools did, or that they were off for this answer.
   */
  private async tryWebTools(model: string, content: any[], onWebRetrieval?: WebRetrievalListener): Promise<string | null> {
    let result: { text: string; retrieval: WebRetrieval };
    try {
      result = await this.generateWithWebTools(model, content);
    } catch (error: any) {
      console.warn(`[${this.providerName}] Web tools failed for ${model} (${error?.message}); answering without web access`);
      onWebRetrieval?.(webToolsOff(error?.message || 'web tools request failed'));
      return null;
    }
    onWebRetrieval?.(result.retrieval);
    return result.text;
  }

  private async generateWithWebTools(model: string, content: any[]): Promise<{ text: string; retrieval: WebRetrieval }> {
    const { Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: this.apiKey });
    const maxUses = webMaxUses();
    console.log(`[${this.providerName}] Web tools on for ${model} (web_fetch, web_search; max_uses ${maxUses})`);

    const messages: any[] = [{ role: 'user', content }];
    const blocks: any[] = []; // every turn's blocks, for the retrieval summary
    for (let turn = 0; turn <= MAX_PAUSE_CONTINUATIONS; turn++) {
      const response: any = await client.messages.create({
        model,
        messages,
        max_tokens: MODERN_MAX_TOKENS,
        tools: [
          { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: maxUses, max_content_tokens: WEB_FETCH_MAX_CONTENT_TOKENS },
          { type: 'web_search_20250305', name: 'web_search', max_uses: maxUses },
        ],
        ...(acceptsSamplingParams(model) ? { temperature: LEGACY_TEMPERATURE } : {})
      } as any, { headers: { 'anthropic-beta': ANTHROPIC_WEB_FETCH_BETA } });

      if (Array.isArray(response.content)) blocks.push(...response.content);
      // A long server-tool turn is handed back unfinished; sending it back resumes it.
      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }
      return { text: finalAnswerText(response.content), retrieval: summarizeAnthropicWebBlocks(blocks) };
    }
    throw new Error(`still paused after ${MAX_PAUSE_CONTINUATIONS} continuations`);
  }
}

/**
 * The text after the last tool block: the model's answer. Text before a fetch
 * ("I'll open that link") is narration, not part of the JSON answer.
 */
export function finalAnswerText(content: unknown): string {
  if (!Array.isArray(content)) return extractTextContent(content);
  let lastTool = -1;
  content.forEach((block: any, i: number) => {
    if (block && typeof block === 'object' && block.type !== 'text') lastTool = i;
  });
  const answer = content.slice(lastTool + 1);
  return extractTextContent(answer.length > 0 ? answer : content);
}
