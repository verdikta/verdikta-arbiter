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
    options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' }
  ): Promise<string> {
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
      responseType: response.response_type,
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
    } else if (response.additional_kwargs?.reasoning_content) {
      // Check for reasoning content in additional_kwargs
      textContent = response.additional_kwargs.reasoning_content;
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
    options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' }
  ): Promise<string> {
    // Check if this model supports native PDF processing
    const supportsNativePDF = ['gpt-4o', 'gpt-4o-mini', 'o1', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-5', 'gpt-5-mini'].some(supportedModel => 
      model.toLowerCase().includes(supportedModel.toLowerCase())
    );

    // Separate PDFs from other attachments
    const pdfAttachments = attachments.filter(att => att.mediaType === 'application/pdf');
    const otherAttachments = attachments.filter(att => att.mediaType !== 'application/pdf');

    // GPT-5 models require native client for max_completion_tokens support
    const isGpt5Model = model.toLowerCase().includes('gpt-5');
    
    // Use native client for GPT-5 models or models with native PDF support
    if (isGpt5Model || (supportsNativePDF && pdfAttachments.length > 0)) {
      console.log(`[${this.providerName}] Using native client for ${model} (GPT-5: ${isGpt5Model}, Native PDF: ${supportsNativePDF && pdfAttachments.length > 0})`);
      return this.generateResponseWithNativePDFSupport(prompt, model, pdfAttachments, otherAttachments, options);
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
   * Generate response using OpenAI's native PDF support
   */
  private async generateResponseWithNativePDFSupport(
    prompt: string, 
    model: string, 
    pdfAttachments: Array<{ type: string, content: string, mediaType: string }>,
    otherAttachments: Array<{ type: string, content: string, mediaType: string }>,
    options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' }
  ): Promise<string> {
    try {
      // Use OpenAI's direct client for native PDF support
      const { OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: this.apiKey });

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
      for (const attachment of otherAttachments) {
        if (attachment.type === "image") {
          if (!SUPPORTED_IMAGE_FORMATS.includes(attachment.mediaType)) {
            throw new Error(`Unsupported image format: ${attachment.mediaType}`);
          }
          messageContent.push({
            type: "image_url",
            image_url: {
              url: `data:${attachment.mediaType};base64,${attachment.content}`,
              detail: "auto"
            }
          });
        } else {
          // Handle text content
          messageContent.push({ type: "text", text: attachment.content });
        }
      }

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

      // Make the API call with native PDF support
      // Use max_completion_tokens for GPT-5 models, max_tokens for others
      // GPT-5 models use reasoning_effort (string), other reasoning models use reasoning (object)
      const reasoningEffort = options?.reasoning?.effort || 'medium';
      
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
      } as any, {
        headers: {
          'OpenAI-Beta': 'pdf-files-v1'
        }
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No content in OpenAI response');
      }

      console.log(`[${this.providerName}] Native PDF processing successful, response length: ${content.length}`);
      return content;

    } catch (error: any) {
      console.error(`[${this.providerName}] Native PDF processing failed:`, error.message);
      
      // Provide helpful error messages based on common issues
      if (error.message?.includes('32MB') || error.message?.includes('file size')) {
        throw new Error(`PDF too large for OpenAI (max 32MB). Consider splitting the document.`);
      } else if (error.message?.includes('pages') || error.message?.includes('100')) {
        throw new Error(`PDF has too many pages for OpenAI (max 100 pages).`);
      } else if (error.message?.includes('Invalid MIME type') || error.message?.includes('Only image types')) {
        throw new Error(`PDF processing error - ensure you have OpenAI PDF beta access enabled.`);
      } else if (error.message?.includes('Missing required parameter') || error.message?.includes('filename')) {
        throw new Error(`PDF processing error - missing required filename parameter.`);
      } else if (error.message?.includes('model')) {
        throw new Error(`Model ${model} does not support PDF processing. Use gpt-4o, gpt-4o-mini, or o1.`);
      } else {
        throw new Error(`OpenAI PDF processing failed: ${error.message}`);
      }
    }
  }
}
