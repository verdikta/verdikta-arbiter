/**
 * OpenAIProvider Module
 * 
 * This module implements the LLMProvider interface for the OpenAI language model service.
 * It provides functionality to interact with OpenAI models, including fetching available models
 * and generating responses to prompts.
 */


import { LLMProvider } from './llm-provider-interface';
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from '@langchain/core/messages';
import { modelConfig } from '../../config/models';
import { AttachmentContext, attachmentRequestError } from './attachment-errors';
import { WebAccessOption, openAIModelSupportsWebSearch, shouldUseWebTools, webMaxUses, withWebAccessNote } from './web-access';
import { WebRetrieval, summarizeOpenAIWebSearch, webToolsOff } from './web-retrieval';

const SUPPORTED_IMAGE_FORMATS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB in bytes

/**
 * OpenAIProvider class
 * 
 * This class implements the LLMProvider interface for OpenAI.
 * It handles communication with the OpenAI API to retrieve models and generate responses.
 */
export class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private readonly providerName = 'OpenAI';
  private models: Array<{ name: string; supportsImages: boolean; supportsAttachments: boolean }>;

  /**
   * Constructor for OpenAIProvider
   * 
   * @param apiKey - The API key for authenticating with OpenAI. Defaults to the OPENAI_API_KEY environment variable.
   */
  constructor(apiKey: string = process.env.OPENAI_API_KEY || '') {
    this.apiKey = apiKey;
    this.models = modelConfig.openai;
  }

  async initialize(): Promise<void> {
    // No asynchronous initialization needed
    return Promise.resolve();
  }

  /**
   * Retrieves the list of available models from OpenAI.
   * 
   * @returns A promise that resolves to an array of strings, where each string
   *          represents the name of an available model.
   * @note This is a simplified implementation. In a production environment,
   *       you should fetch the actual list of models from OpenAI's API.
   */
  async getModels(): Promise<Array<{ name: string; supportsImages: boolean; supportsAttachments: boolean }>> {
    return this.models;
  }

  supportsImages(model: string): boolean {
    const modelInfo = this.models.find(m => m.name === model);
    return modelInfo ? modelInfo.supportsImages : false;
  }

  supportsAttachments(model: string): boolean {
    const modelInfo = this.models.find(m => m.name === model);
    return modelInfo ? modelInfo.supportsAttachments : false;
  }

  /**
   * Generates a response using the specified OpenAI model based on the given prompt.
   * 
   * @param prompt - The input text or question to be processed by the model.
   * @param model - The name or identifier of the specific OpenAI model to use for generation.
   * @returns A promise that resolves to a string containing the generated response.
   * @throws Will throw an error if the model invocation fails or if the response is not a string.
   */
  async generateResponse(
    prompt: string, 
    model: string, 
    options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' } & WebAccessOption
  ): Promise<string> {
    // Links in the prompt are opened by OpenAI's web_search tool (Responses API).
    if (options?.webAccess !== false && shouldUseWebTools(prompt) && openAIModelSupportsWebSearch(model)) {
      const answer = await this.tryWebSearch(model, [{ type: 'input_text', text: withWebAccessNote(prompt) }], options);
      if (answer !== null) return answer;
    }

    // Check if this is a reasoning model (o1, o3, gpt-4.1, gpt-5, nano, etc.)
    const isReasoningModel = model.toLowerCase().includes('o1') || 
                            model.toLowerCase().includes('o3') || 
                            model.toLowerCase().includes('gpt-5') ||
                            model.toLowerCase().includes('gpt-4.1') ||
                            model.toLowerCase().includes('nano');
    
    // GPT-5 models require max_completion_tokens instead of max_tokens
    // Use native OpenAI client for these models
    const isGpt5Model = model.toLowerCase().includes('gpt-5');
    
    if (isGpt5Model) {
      return this.generateResponseWithNativeClient(prompt, model, options);
    }
    
    const openai = new ChatOpenAI({
      openAIApiKey: this.apiKey,
      modelName: model,
      // Reasoning models need much higher token limits as they use tokens for internal reasoning
      // Configurable via environment variable, defaults to 16000 for reasoning models, 1000 for others
      maxTokens: isReasoningModel 
        ? parseInt(process.env.REASONING_MODEL_MAX_TOKENS || '16000')
        : 1000,
      // Apply reasoning effort and verbosity if provided
      ...(options?.reasoning && { reasoning: options.reasoning }),
      ...(options?.verbosity && { verbosity: options.verbosity }),
    });
    const response = await openai.invoke(prompt);
    
    // Debug: Log the full response structure to understand what we're getting
    console.log(`[${this.providerName}] Full response:`, {
      content: response.content,
      contentType: typeof response.content,
      additionalKwargs: response.additional_kwargs,
      allKeys: Object.keys(response)
    });
    
    // Handle different response formats
    let textContent = '';
    
    if (typeof response.content === 'string') {
      textContent = response.content;
    } else if (Array.isArray(response.content)) {
      // Handle array content (newer OpenAI models may return structured content)
      textContent = response.content
        .map((item: any) => {
          if (typeof item === 'string') return item;
          if (item.type === 'text') return item.text;
          return JSON.stringify(item);
        })
        .join('');
    } else if (response.additional_kwargs && 'reasoning_content' in response.additional_kwargs) {
      // Check for reasoning content in additional_kwargs
      const kwargs = response.additional_kwargs as { reasoning_content?: string };
      textContent = kwargs.reasoning_content || '';
    }
    
    console.log(`[${this.providerName}] Extracted text content:`, {
      length: textContent.length,
      preview: textContent.substring(0, 200)
    });
    
    if (!textContent) {
      throw new Error(`No content in OpenAI response. Full response: ${JSON.stringify(response)}`);
    }
    
    return textContent;
  }

  /**
   * Generate response using native OpenAI client for GPT-5 models
   * GPT-5 models require max_completion_tokens instead of max_tokens
   * GPT-5 models use reasoning_effort (string) not reasoning (object)
   */
  private async generateResponseWithNativeClient(
    prompt: string,
    model: string,
    options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' }
  ): Promise<string> {
    try {
      const { OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: this.apiKey });

      const maxCompletionTokens = parseInt(process.env.REASONING_MODEL_MAX_TOKENS || '16000');
      
      // GPT-5 models use reasoning_effort as a direct string value, not an object
      const reasoningEffort = options?.reasoning?.effort || 'medium';
      
      console.log(`[${this.providerName}] Using native client for GPT-5 model ${model} with max_completion_tokens: ${maxCompletionTokens}, reasoning_effort: ${reasoningEffort}`);

      const response = await client.chat.completions.create({
        model: model,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        max_completion_tokens: maxCompletionTokens,
        // GPT-5 uses reasoning_effort (string) instead of reasoning (object)
        reasoning_effort: reasoningEffort,
        ...(options?.verbosity && { verbosity: options.verbosity }),
      } as any);  // Cast to any since OpenAI SDK types may not include reasoning_effort yet

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No content in OpenAI response');
      }

      console.log(`[${this.providerName}] Native client response length: ${content.length}`);
      return content;

    } catch (error: any) {
      console.error(`[${this.providerName}] Native client error for model ${model}:`, error.message);
      throw error;
    }
  }

  async generateResponseWithImage(prompt: string, model: string, base64Image: string, mediaType: string = 'image/jpeg'): Promise<string> {
    if (!this.supportsImages(model)) {
      throw new Error(`[${this.providerName}] Model ${model} does not support image inputs.`);
    }
    if (!SUPPORTED_IMAGE_FORMATS.includes(mediaType)) {
      throw new Error(`[${this.providerName}] Model ${model}: Unsupported image format: ${mediaType}. Supported formats are: JPEG, PNG, GIF, and WEBP.`);
    }

    const approximateFileSize = base64Image.length * 0.75;
    if (approximateFileSize > MAX_FILE_SIZE) {
      throw new Error(`[${this.providerName}] Model ${model}: Image file size must be under 20 MB.`);
    }

    const openai = new ChatOpenAI({
      openAIApiKey: this.apiKey,
      modelName: model,
      maxTokens: 1000,
    });

    const response = await openai.invoke([
      new HumanMessage({
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: { url: `data:${mediaType};base64,${base64Image}` }
          }
        ]
      })
    ]);

    if (typeof response.content !== 'string') {
      throw new Error('Unexpected response format from OpenAI');
    }
    return response.content;
  }

  async generateResponseWithAttachments(
    prompt: string, 
    model: string, 
    attachments: Array<{ type: string, content: string, mediaType: string }>,
    options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' } & WebAccessOption
  ): Promise<string> {
    // Check if this model supports native PDF processing
    const supportsNativePDF = ['gpt-4o', 'gpt-4o-mini', 'o1', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-5', 'gpt-5-mini'].some(supportedModel => 
      model.toLowerCase().includes(supportedModel.toLowerCase())
    );

    // Separate PDFs from other attachments
    const pdfAttachments = attachments.filter(att => att.mediaType === 'application/pdf');
    const otherAttachments = attachments.filter(att => att.mediaType !== 'application/pdf');

    // Links in the request are opened by OpenAI's web_search tool; same inputs as below.
    if (shouldUseWebTools(prompt, attachments) && openAIModelSupportsWebSearch(model)) {
      const input = this.responsesInputContent(model, withWebAccessNote(prompt), supportsNativePDF ? pdfAttachments : [], otherAttachments);
      const answer = await this.tryWebSearch(model, input, options);
      if (answer !== null) return answer;
    }

    // GPT-5 models require native client for max_completion_tokens support
    const isGpt5Model = model.toLowerCase().includes('gpt-5');

    // The native PDF path only when a PDF is actually attached
    if (supportsNativePDF && pdfAttachments.length > 0) {
      console.log(`[${this.providerName}] Using native PDF support for ${model} (${pdfAttachments.length} PDF(s))`);
      return this.generateResponseWithNativePDFSupport(prompt, model, pdfAttachments, otherAttachments, options);
    }

    // GPT-5 still needs the native client for images and text, without the PDF handling
    if (isGpt5Model) {
      console.log(`[${this.providerName}] Using native client for GPT-5 model ${model} (${otherAttachments.length} attachment(s), no PDF)`);
      return this.generateResponseWithNativeAttachments(prompt, model, otherAttachments, options);
    }

    // Check if this is a reasoning model
    const isReasoningModel = model.toLowerCase().includes('o1') || 
                            model.toLowerCase().includes('o3') || 
                            model.toLowerCase().includes('gpt-5') ||
                            model.toLowerCase().includes('gpt-4.1') ||
                            model.toLowerCase().includes('nano');

    // Fall back to original implementation for non-PDF or non-supporting models
    const openai = new ChatOpenAI({
      openAIApiKey: this.apiKey,
      modelName: model,
      // Reasoning models need much higher token limits
      maxTokens: isReasoningModel 
        ? parseInt(process.env.REASONING_MODEL_MAX_TOKENS || '16000')
        : 1000,
      // Apply reasoning effort and verbosity ONLY for reasoning models
      ...(isReasoningModel && options?.reasoning && { reasoning: options.reasoning }),
      ...(isReasoningModel && options?.verbosity && { verbosity: options.verbosity }),
    });

    // Validate image attachments
    for (const attachment of otherAttachments) {
      if (attachment.type === 'image') {
        if (!this.supportsImages(model)) {
          throw new Error(`[${this.providerName}] Model ${model} does not support image inputs.`);
        }
        if (!SUPPORTED_IMAGE_FORMATS.includes(attachment.mediaType)) {
          throw new Error(`[${this.providerName}] Model ${model}: Unsupported image format: ${attachment.mediaType}. Supported formats are: JPEG, PNG, GIF, and WEBP.`);
        }
        const approximateFileSize = attachment.content.length * 0.75;
        if (approximateFileSize > MAX_FILE_SIZE) {
          throw new Error(`[${this.providerName}] Model ${model}: Image file size must be under 20 MB.`);
        }
      }
    }

    const messageContent = [
      { type: "text", text: prompt },
      ...otherAttachments.map(attachment => {
        if (attachment.type === "image") {
          return {
            type: "image_url",
            image_url: {
              url: `data:${attachment.mediaType};base64,${attachment.content}`,
              detail: "auto"  // Let OpenAI decide the appropriate detail level
            }
          };
        } else {
          return { type: "text", text: attachment.content };
        }
      })
    ];

    const response = await openai.invoke([
      new HumanMessage({
        content: messageContent
      })
    ]);

    if (typeof response.content !== 'string') {
      throw new Error('Unexpected response format from OpenAI');
    }
    return response.content;
  }
  /**
   * Generate response for a GPT-5 request with images / text but no PDF.
   * GPT-5 needs the native client for max_completion_tokens; nothing here is PDF-specific.
   */
  private async generateResponseWithNativeAttachments(
    prompt: string,
    model: string,
    attachments: Array<{ type: string, content: string, mediaType: string }>,
    options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' }
  ): Promise<string> {
    const messageContent: any[] = [
      { type: "text", text: prompt },
      ...this.nativeAttachmentBlocks(model, attachments)
    ];
    return this.completeWithNativeClient(model, messageContent, options, {
      hasPdf: false,
      hasImage: attachments.some(att => att.type === 'image')
    });
  }

  /**
   * Generate response using OpenAI's native PDF support
   */
  private async generateResponseWithNativePDFSupport(
    prompt: string, 
    model: string, 
    pdfAttachments: Array<{ type: string, content: string, mediaType: string }>,
    otherAttachments: Array<{ type: string, content: string, mediaType: string }>,
    options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' }
  ): Promise<string> {
    // Build message content with native PDF support
    const messageContent: any[] = [
      { type: "text", text: prompt }
    ];

    // Add PDF attachments using base64 method (as per OpenAI docs)
    for (const pdfAttachment of pdfAttachments) {
      // Validate PDF size (OpenAI limit: 32MB, 100 pages)
      const pdfSizeBytes = (pdfAttachment.content.length * 3) / 4; // Approximate base64 to bytes conversion
      if (pdfSizeBytes > 32 * 1024 * 1024) {
        throw new Error(`PDF file size (${Math.round(pdfSizeBytes / 1024 / 1024)}MB) exceeds OpenAI's 32MB limit`);
      }

      // Use the correct file content block for PDFs
      messageContent.push({
        type: "file",
        file: {
          file_data: `data:application/pdf;base64,${pdfAttachment.content}`,
          filename: "document.pdf"
        }
      });
    }

    // Add other attachments (images, etc.)
    messageContent.push(...this.nativeAttachmentBlocks(model, otherAttachments));

    return this.completeWithNativeClient(model, messageContent, options, {
      hasPdf: true,
      hasImage: otherAttachments.some(att => att.type === 'image')
    }, { 'OpenAI-Beta': 'pdf-files-v1' });
  }

  /**
   * Image and text content blocks for the native client
   */
  private nativeAttachmentBlocks(
    model: string,
    attachments: Array<{ type: string, content: string, mediaType: string }>
  ): any[] {
    return attachments.map(attachment => {
      if (attachment.type === "image") {
        if (!SUPPORTED_IMAGE_FORMATS.includes(attachment.mediaType)) {
          throw new Error(`[${this.providerName}] Model ${model}: Unsupported image format: ${attachment.mediaType}. Supported formats are: JPEG, PNG, GIF, and WEBP.`);
        }
        return {
          type: "image_url",
          image_url: {
            url: `data:${attachment.mediaType};base64,${attachment.content}`,
            detail: "auto"
          }
        };
      }
      // Handle text content
      return { type: "text", text: attachment.content };
    });
  }

  /**
   * Send a request with attachments through the native OpenAI client. A failure keeps
   * the provider's status and message and says which input it is about.
   */
  private async completeWithNativeClient(
    model: string,
    messageContent: any[],
    options: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' } | undefined,
    context: AttachmentContext,
    headers?: Record<string, string>
  ): Promise<string> {
    // Check if this is a reasoning model
    const isReasoningModel = model.toLowerCase().includes('o1') || 
                            model.toLowerCase().includes('o3') || 
                            model.toLowerCase().includes('gpt-5') ||
                            model.toLowerCase().includes('gpt-4.1') ||
                            model.toLowerCase().includes('nano');
    
    // GPT-5 models require max_completion_tokens instead of max_tokens
    const isGpt5Model = model.toLowerCase().includes('gpt-5');
    const maxTokensValue = isReasoningModel 
      ? parseInt(process.env.REASONING_MODEL_MAX_TOKENS || '16000')
      : 1000;

    // GPT-5 models use reasoning_effort (string), other reasoning models use reasoning (object)
    const reasoningEffort = options?.reasoning?.effort || 'medium';

    try {
      // Use OpenAI's direct client
      const { OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: this.apiKey });

      const response = await client.chat.completions.create({
        model: model,
        messages: [
          {
            role: "user",
            content: messageContent
          }
        ],
        // GPT-5 models require max_completion_tokens, others use max_tokens
        ...(isGpt5Model 
          ? { max_completion_tokens: maxTokensValue }
          : { max_tokens: maxTokensValue }),
        // GPT-5 uses reasoning_effort (string), other reasoning models use reasoning (object)
        ...(isGpt5Model && { reasoning_effort: reasoningEffort }),
        ...(isReasoningModel && !isGpt5Model && options?.reasoning && { reasoning: options.reasoning }),
        ...(isReasoningModel && options?.verbosity && { verbosity: options.verbosity }),
      } as any, headers ? { headers } : undefined);

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No content in OpenAI response');
      }

      console.log(`[${this.providerName}] Native client response length: ${content.length} (PDF: ${context.hasPdf}, images: ${context.hasImage})`);
      return content;

    } catch (error: any) {
      console.error(`[${this.providerName}] Native request with attachments failed for ${model}:`, error.message);
      throw attachmentRequestError(this.providerName, model, error, context);
    }
  }

  /**
   * Responses API input content: the prompt, PDFs as input_file, images as
   * input_image, anything else as input_text.
   */
  private responsesInputContent(
    model: string,
    prompt: string,
    pdfAttachments: Array<{ type: string, content: string, mediaType: string }>,
    otherAttachments: Array<{ type: string, content: string, mediaType: string }>
  ): any[] {
    const content: any[] = [{ type: 'input_text', text: prompt }];
    for (const pdfAttachment of pdfAttachments) {
      const pdfSizeBytes = (pdfAttachment.content.length * 3) / 4;
      if (pdfSizeBytes > 32 * 1024 * 1024) {
        throw new Error(`PDF file size (${Math.round(pdfSizeBytes / 1024 / 1024)}MB) exceeds OpenAI's 32MB limit`);
      }
      content.push({
        type: 'input_file',
        filename: 'document.pdf',
        file_data: `data:application/pdf;base64,${pdfAttachment.content}`
      });
    }
    for (const attachment of otherAttachments) {
      if (attachment.type === 'image') {
        if (!SUPPORTED_IMAGE_FORMATS.includes(attachment.mediaType)) {
          throw new Error(`[${this.providerName}] Model ${model}: Unsupported image format: ${attachment.mediaType}. Supported formats are: JPEG, PNG, GIF, and WEBP.`);
        }
        content.push({ type: 'input_image', image_url: `data:${attachment.mediaType};base64,${attachment.content}`, detail: 'auto' });
      } else {
        content.push({ type: 'input_text', text: attachment.content });
      }
    }
    return content;
  }

  /**
   * The answer with OpenAI's web_search tool enabled, or null when that request
   * fails: the juror then answers without web access (as every request did
   * before), and the warning says why. options.onWebRetrieval hears what the
   * tool did, or that it was off for this answer.
   */
  private async tryWebSearch(
    model: string,
    content: any[],
    options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' } & WebAccessOption
  ): Promise<string | null> {
    let result: { text: string; retrieval: WebRetrieval };
    try {
      result = await this.generateWithWebSearch(model, content, options);
    } catch (error: any) {
      console.warn(`[${this.providerName}] Web search failed for ${model} (${error?.message}); answering without web access`);
      options?.onWebRetrieval?.(webToolsOff(error?.message || 'web search request failed'));
      return null;
    }
    options?.onWebRetrieval?.(result.retrieval);
    return result.text;
  }

  private async generateWithWebSearch(
    model: string,
    content: any[],
    options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' }
  ): Promise<{ text: string; retrieval: WebRetrieval }> {
    const { OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: this.apiKey });
    const id = model.toLowerCase().split('/').pop() || '';
    // Only the GPT-5 and o-series models take a reasoning effort on the Responses API.
    const takesReasoning = /^(gpt-5|o3|o4)/.test(id);
    const maxUses = webMaxUses();
    console.log(`[${this.providerName}] Web search on for ${model} (Responses API; max_tool_calls ${maxUses})`);

    const response: any = await client.responses.create({
      model,
      input: [{ role: 'user', content }],
      tools: [{ type: 'web_search' }],
      max_tool_calls: maxUses,
      max_output_tokens: takesReasoning ? parseInt(process.env.REASONING_MODEL_MAX_TOKENS || '16000') : 4000,
      ...(takesReasoning && { reasoning: { effort: options?.reasoning?.effort || 'medium' } }),
      ...(takesReasoning && id.startsWith('gpt-5') && options?.verbosity && { text: { verbosity: options.verbosity } }),
    } as any);

    const text = responsesOutputText(response);
    if (!text) {
      throw new Error(`no text in the response (status ${response?.status})`);
    }
    return { text, retrieval: summarizeOpenAIWebSearch(response) };
  }
}

/** The answer text of a Responses API result (the SDK's output_text, or the message items). */
export function responsesOutputText(response: any): string {
  if (typeof response?.output_text === 'string' && response.output_text) return response.output_text;
  return (response?.output || [])
    .filter((item: any) => item?.type === 'message')
    .flatMap((item: any) => item.content || [])
    .filter((part: any) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part: any) => part.text)
    .join('');
}
