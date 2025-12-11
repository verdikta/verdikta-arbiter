/**
 * XAIProvider Module
 * 
 * This module implements the LLMProvider interface for xAI's Grok language model service.
 * It provides functionality to interact with Grok models, including fetching available models
 * and generating responses to prompts.
 * 
 * The xAI API is OpenAI-compatible, using the same endpoint format at https://api.x.ai/v1
 * 
 * API Documentation: https://docs.x.ai/docs
 */

import { LLMProvider } from './llm-provider-interface';
import { modelConfig } from '../../config/models';

const SUPPORTED_IMAGE_FORMATS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB in bytes

/**
 * XAIProvider class
 * 
 * This class implements the LLMProvider interface for xAI's Grok models.
 * It handles communication with the xAI API to retrieve models and generate responses.
 * Uses native fetch API for direct communication with xAI endpoints.
 */
export class XAIProvider implements LLMProvider {
  private apiKey: string;
  private readonly providerName = 'xAI';
  private readonly baseUrl: string;
  private models: Array<{ name: string; supportsImages: boolean; supportsAttachments: boolean }>;

  /**
   * Constructor for XAIProvider
   * 
   * Initializes the provider with API key and base URL from environment variables.
   */
  constructor() {
    // Load API key from environment (support both XAI_API_KEY and GROK_API_KEY for backwards compatibility)
    this.apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY || '';
    
    // Allow base URL override for testing, default to production endpoint
    this.baseUrl = process.env.XAI_BASE_URL || process.env.GROK_BASE_URL || 'https://api.x.ai/v1';
    
    // Load model configurations
    this.models = modelConfig.xai || [];
    
    if (!this.apiKey) {
      console.warn(`[${this.providerName}] Warning: XAI_API_KEY not set. Provider will not be functional.`);
    }
  }

  /**
   * Initialize the provider and validate configuration
   */
  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error(`[${this.providerName}] XAI_API_KEY environment variable is required`);
    }
    
    console.log(`[${this.providerName}] Provider initialized with base URL: ${this.baseUrl}`);
    console.log(`[${this.providerName}] Available models: ${this.models.length}`);
  }

  /**
   * Retrieves the list of available models from configuration.
   * 
   * @returns A promise that resolves to an array of model configurations.
   */
  async getModels(): Promise<Array<{ name: string; supportsImages: boolean; supportsAttachments: boolean }>> {
    return this.models;
  }

  /**
   * Check if a specific model supports image inputs
   */
  supportsImages(model: string): boolean {
    const modelInfo = this.models.find(m => m.name === model);
    return modelInfo?.supportsImages ?? false;
  }

  /**
   * Check if a specific model supports attachments
   */
  supportsAttachments(model: string): boolean {
    const modelInfo = this.models.find(m => m.name === model);
    return modelInfo?.supportsAttachments ?? false;
  }

  /**
   * Check if the model is a reasoning model that needs higher token limits
   */
  private isReasoningModel(model: string): boolean {
    const lowerModel = model.toLowerCase();
    return lowerModel.includes('reasoning') || 
           lowerModel.includes('grok-4') ||
           lowerModel.includes('grok-3');
  }

  /**
   * Generates a response using the specified Grok model based on the given prompt.
   * 
   * @param prompt - The input text or question to be processed by the model.
   * @param model - The name or identifier of the specific Grok model to use for generation.
   * @param options - Optional configuration for reasoning effort and verbosity.
   * @returns A promise that resolves to a string containing the generated response.
   * @throws Will throw an error if the model invocation fails or if the response is not valid.
   */
  async generateResponse(
    prompt: string, 
    model: string,
    options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' }
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error(`[${this.providerName}] XAI_API_KEY not configured`);
    }

    const url = `${this.baseUrl}/chat/completions`;
    
    // Model-specific parameters
    const isReasoning = this.isReasoningModel(model);
    const max_tokens = isReasoning 
      ? parseInt(process.env.REASONING_MODEL_MAX_TOKENS || '16000')
      : 1000;
    const temperature = 0.7;

    try {
      console.log(`[${this.providerName}] Making request to ${url}`);
      console.log(`[${this.providerName}] Model: ${model}`);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: model,
          messages: [{
            role: 'user',
            content: prompt
          }],
          max_tokens,
          temperature,
          stream: false
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`[${this.providerName}] HTTP ${response.status}: ${errorText}`);
      }

      const json = await response.json();
      
      if (!json.choices || !json.choices[0] || !json.choices[0].message) {
        throw new Error(`[${this.providerName}] Invalid response format from model ${model}`);
      }

      const content = json.choices[0].message.content;
      
      if (!content) {
        throw new Error(`[${this.providerName}] No content in response from model ${model}`);
      }

      console.log(`[${this.providerName}] Response received, length: ${content.length}`);
      return content;
    } catch (error: any) {
      console.error(`[${this.providerName}] Error calling model ${model}:`, error.message);
      throw error;
    }
  }

  /**
   * Generates a response with image input.
   * 
   * Only vision-capable models (e.g., grok-2-vision-1212) support this method.
   *
   * @param prompt - The input text prompt
   * @param model - The model identifier
   * @param base64Image - Base64-encoded image data
   * @param mediaType - MIME type of the image (e.g., 'image/jpeg', 'image/png')
   * @returns A promise that resolves to the model's response
   */
  async generateResponseWithImage(
    prompt: string, 
    model: string, 
    base64Image: string, 
    mediaType: string = 'image/jpeg'
  ): Promise<string> {
    if (!this.supportsImages(model)) {
      throw new Error(`[${this.providerName}] Model ${model} does not support image inputs.`);
    }

    if (!this.apiKey) {
      throw new Error(`[${this.providerName}] XAI_API_KEY not configured`);
    }

    if (!SUPPORTED_IMAGE_FORMATS.includes(mediaType)) {
      throw new Error(`[${this.providerName}] Model ${model}: Unsupported image format: ${mediaType}. Supported formats are: JPEG, PNG, GIF, and WEBP.`);
    }

    const approximateFileSize = base64Image.length * 0.75;
    if (approximateFileSize > MAX_FILE_SIZE) {
      throw new Error(`[${this.providerName}] Model ${model}: Image file size must be under 20 MB.`);
    }

    const url = `${this.baseUrl}/chat/completions`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mediaType};base64,${base64Image}`
                }
              }
            ]
          }],
          max_tokens: 1000,
          stream: false
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`[${this.providerName}] HTTP ${response.status}: ${errorText}`);
      }

      const json = await response.json();
      const content = json.choices[0]?.message?.content;

      if (!content) {
        throw new Error(`[${this.providerName}] No content in response from model ${model}`);
      }

      return content;
    } catch (error: any) {
      console.error(`[${this.providerName}] Error calling model ${model} with image:`, error.message);
      throw error;
    }
  }

  /**
   * Generates a response with multiple attachments (images, documents, etc.).
   * 
   * Handles mixed content types for multimodal model interactions.
   *
   * @param prompt - The input text prompt
   * @param model - The model identifier
   * @param attachments - Array of attachments with type, content, and mediaType
   * @param options - Optional configuration for reasoning effort and verbosity
   * @returns A promise that resolves to the model's response
   */
  async generateResponseWithAttachments(
    prompt: string,
    model: string,
    attachments: Array<{ type: string; content: string; mediaType: string }>,
    options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' }
  ): Promise<string> {
    if (!this.supportsAttachments(model)) {
      throw new Error(`[${this.providerName}] Model ${model} does not support attachments.`);
    }

    if (!this.apiKey) {
      throw new Error(`[${this.providerName}] XAI_API_KEY not configured`);
    }

    const url = `${this.baseUrl}/chat/completions`;

    // Build content array with text prompt and attachments
    const contentParts: any[] = [
      { type: 'text', text: prompt }
    ];

    // Process attachments
    for (const attachment of attachments) {
      if (attachment.type === 'image') {
        // Validate image support
        if (!this.supportsImages(model)) {
          throw new Error(`[${this.providerName}] Model ${model} does not support image inputs.`);
        }
        
        // Validate image format
        if (!SUPPORTED_IMAGE_FORMATS.includes(attachment.mediaType)) {
          throw new Error(`[${this.providerName}] Model ${model}: Unsupported image format: ${attachment.mediaType}. Supported formats are: JPEG, PNG, GIF, and WEBP.`);
        }

        // Validate file size
        const approximateFileSize = attachment.content.length * 0.75;
        if (approximateFileSize > MAX_FILE_SIZE) {
          throw new Error(`[${this.providerName}] Model ${model}: Image file size must be under 20 MB.`);
        }

        // Add image attachment
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${attachment.mediaType};base64,${attachment.content}`,
            detail: 'auto'
          }
        });
      } else if (attachment.type === 'text') {
        // Add text attachment to prompt
        contentParts.push({
          type: 'text',
          text: attachment.content
        });
      }
    }

    // Model-specific parameters
    const isReasoning = this.isReasoningModel(model);
    const max_tokens = isReasoning 
      ? parseInt(process.env.REASONING_MODEL_MAX_TOKENS || '16000')
      : 1000;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: model,
          messages: [{
            role: 'user',
            content: contentParts
          }],
          max_tokens,
          stream: false
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`[${this.providerName}] HTTP ${response.status}: ${errorText}`);
      }

      const json = await response.json();
      const content = json.choices[0]?.message?.content;

      if (!content) {
        throw new Error(`[${this.providerName}] No content in response from model ${model}`);
      }

      console.log(`[${this.providerName}] Response with attachments received, length: ${content.length}`);
      return content;
    } catch (error: any) {
      console.error(`[${this.providerName}] Error calling model ${model} with attachments:`, error.message);
      throw error;
    }
  }
}

