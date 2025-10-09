import { LLMProvider } from './llm-provider-interface';
import { modelConfig } from '../../config/models';

/**
 * HyperbolicProvider
 * 
 * Provides integration with Hyperbolic's serverless AI inference platform.
 * Uses native fetch API for direct communication with Hyperbolic endpoints.
 * 
 * API Documentation: https://docs.hyperbolic.xyz/docs/getting-started
 */
export class HyperbolicProvider implements LLMProvider {
  private apiKey: string;
  private readonly providerName = 'Hyperbolic';
  private readonly baseUrl: string;
  private models: Array<{ name: string; supportsImages: boolean; supportsAttachments: boolean }>;

  constructor() {
    // Load API key from environment
    this.apiKey = process.env.HYPERBOLIC_API_KEY || '';
    
    // Allow base URL override for testing, default to production endpoint
    this.baseUrl = process.env.HYPERBOLIC_BASE_URL || 'https://api.hyperbolic.xyz/v1';
    
    // Load model configurations
    this.models = modelConfig.hyperbolic || [];
    
    if (!this.apiKey) {
      console.warn(`[${this.providerName}] Warning: HYPERBOLIC_API_KEY not set. Provider will not be functional.`);
    }
  }

  /**
   * Initialize the provider and validate configuration
   */
  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error(`[${this.providerName}] HYPERBOLIC_API_KEY environment variable is required`);
    }
    
    console.log(`[${this.providerName}] Provider initialized with base URL: ${this.baseUrl}`);
    console.log(`[${this.providerName}] Available models: ${this.models.length}`);
  }

  /**
   * Get list of available models from configuration
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
   * Generates a response from the Hyperbolic model based on the provided prompt.
   * 
   * Uses native fetch API to communicate directly with Hyperbolic's API.
   *
   * @param prompt - The input text or question to be processed by the model.
   * @param model - The name or identifier of the specific Hyperbolic model to use.
   * @param options - Optional configuration (reserved for future use)
   * @returns A promise that resolves to a string containing the generated response.
   * @throws Will throw an error if the model invocation fails or if the response is not valid.
   */
  async generateResponse(
    prompt: string, 
    model: string,
    options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' }
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error(`[${this.providerName}] HYPERBOLIC_API_KEY not configured`);
    }

    const url = `${this.baseUrl}/chat/completions`;
    
    // Model-specific parameters based on Hyperbolic examples
    let temperature = 0.7;
    let top_p = 0.9;
    let max_tokens = 1000;
    
    if (model.includes('DeepSeek-R1')) {
      temperature = 0.1;
      top_p = 0.9;
      max_tokens = 1000;
    } else if (model.includes('Kimi-K2')) {
      temperature = 0.1;
      top_p = 0.9;
      max_tokens = 1000;
    } else if (model.includes('Qwen')) {
      temperature = 0.7;
      top_p = 0.8;
      max_tokens = 1000;
    }

    try {
      // Debug logging
      console.log(`[${this.providerName}] Making request to ${url}`);
      console.log(`[${this.providerName}] Model: ${model}`);
      console.log(`[${this.providerName}] API Key (first 20 chars): ${this.apiKey.substring(0, 20)}...`);
      
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
          top_p,
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
      
      return content;
    } catch (error: any) {
      console.error(`[${this.providerName}] Error calling model ${model}:`, error.message);
      throw error;
    }
  }

  /**
   * Generates a response with image input.
   * 
   * Note: Currently, the initial Hyperbolic models (Qwen3, DeepSeek-R1, Kimi-K2)
   * do not support vision capabilities. This method is implemented for future
   * compatibility when vision models are added.
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
      throw new Error(`[${this.providerName}] HYPERBOLIC_API_KEY not configured`);
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
      throw new Error(`[${this.providerName}] HYPERBOLIC_API_KEY not configured`);
    }

    const url = `${this.baseUrl}/chat/completions`;

    // Build content array with text prompt and attachments
    const contentParts: any[] = [
      { type: 'text', text: prompt }
    ];

    // Process attachments
    for (const attachment of attachments) {
      if (attachment.type === 'image') {
        // Add image attachment
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${attachment.mediaType};base64,${attachment.content}`
          }
        });
      } else if (attachment.type === 'text') {
        // Add text attachment to prompt
        contentParts.push({
          type: 'text',
          text: `\n\nAttachment:\n${attachment.content}`
        });
      }
    }

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
      console.error(`[${this.providerName}] Error calling model ${model} with attachments:`, error.message);
      throw error;
    }
  }
}
