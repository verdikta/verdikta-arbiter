/**
 * OllamaProvider Module
 * 
 * This module implements the LLMProvider interface for the Ollama language model service.
 * It provides functionality to interact with Ollama models, including fetching available models
 * and generating responses to prompts.
 */

import { LLMProvider } from './llm-provider-interface';
import { ChatOllama } from "@langchain/ollama";

const SUPPORTED_IMAGE_FORMATS = ['image/jpeg', 'image/png']; // Most Ollama vision models support these formats
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB limit for consistency

/**
 * OllamaProvider class
 * 
 * This class implements the LLMProvider interface for Ollama.
 * It handles communication with the Ollama API to retrieve models and generate responses.
 */
export class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private readonly providerName = 'Ollama';
  private models: Array<{ name: string; supportsImages: boolean; supportsAttachments: boolean }> = [];
  private modelsInitialized: Promise<void>;

  /**
   * Constructor for OllamaProvider
   * 
   * @param baseUrl - The base URL for the Ollama API. Defaults to 'http://localhost:11434'.
   */
  constructor(baseUrl: string = 'http://localhost:11434') {
    this.baseUrl = baseUrl;
    this.modelsInitialized = this.initializeModels();
  }

  async initialize(): Promise<void> {
    await this.modelsInitialized;
  }

  private async initializeModels() {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      console.log('Ollama - Fetching models response:', response.status);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      if (!data.models || !Array.isArray(data.models)) {
        throw new Error('Invalid data format: "models" array is missing.');
      }

      this.models = data.models.map((model: any) => {
        const supportsImages = model.details?.families?.some((family: string) => 
          ['clip', 'llava'].includes(family.toLowerCase())
        );
        console.log(`Ollama - Model ${model.name} details:`, {
          families: model.details?.families,
          supportsImages
        });
        return {
          name: model.name,
          supportsImages,
          supportsAttachments: supportsImages // For Ollama, attachment support is equivalent to image support
        };
      });
    } catch (error) {
      console.error('Error fetching Ollama models:', error);
      this.models = [];
    }
  }

  /**
   * Retrieves the list of available models from the Ollama API.
   * 
   * @returns A promise that resolves to an array of strings, where each string
   *          represents the name of an available model.
   * @throws Will throw an error if the API request fails.
   */
  async getModels(): Promise<Array<{ name: string; supportsImages: boolean; supportsAttachments: boolean }>> {
    await this.modelsInitialized;
    return this.models;
  }

  supportsImages(model: string): boolean {
    return this.models.some(m => m.name === model && m.supportsImages);
  }

  /**
   * Generates a response using the specified Ollama model based on the given prompt.
   * 
   * @param prompt - The input text or question to be processed by the model.
   * @param model - The name or identifier of the specific Ollama model to use for generation.
   * @returns A promise that resolves to a string containing the generated response.
   * @throws Will throw an error if the model invocation fails.
   */
  async generateResponse(prompt: string, model: string): Promise<string> {
    try {
      const ollama = new ChatOllama({
        baseUrl: this.baseUrl,
        model: model,
      });
      const response = await ollama.invoke(prompt);
      return response.content as string;
    } catch (error: any) {
      console.error('Error in OllamaProvider.generateResponse:', error);
      throw new Error(`Failed to generate response: ${error.message}`);
    }
  }

  async generateResponseWithImage(prompt: string, model: string, base64Image: string, mediaType: string = 'image/jpeg'): Promise<string> {
    // Do all validations first, before any API calls
    const supportsImages = await this.supportsImages(model);
    if (!supportsImages) {
      throw new Error(`[${this.providerName}] Model ${model} does not support image inputs.`);
    }

    if (!SUPPORTED_IMAGE_FORMATS.includes(mediaType)) {
      throw new Error(`[${this.providerName}] Unsupported image format: ${mediaType}. Only JPEG and PNG formats are supported.`);
    }

    // Check file size
    const approximateFileSize = base64Image.length * 0.75;
    if (approximateFileSize > MAX_FILE_SIZE) {
      throw new Error(`[${this.providerName}] Image file size must be under 20 MB.`);
    }

    console.log('Preparing request payload');
    try {
      const payload = {
        model: model,
        prompt: prompt,
        images: [base64Image]
      };
      
      console.log('Ollama - Request payload structure:', {
        model: payload.model,
        promptLength: payload.prompt.length,
        imageDataLength: payload.images[0].length
      });

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });

      console.log('Ollama - Response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Ollama - Error response:', errorText);
        throw new Error(`Ollama API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Unable to read response stream');
      }

      let fullResponse = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = new TextDecoder().decode(value);
        const lines = chunk.split('\n').filter(line => line.trim() !== '');
        
        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            if (data.response) {
              fullResponse += data.response;
            }
          } catch (parseError) {
            console.error('Error parsing JSON chunk:', parseError);
          }
        }
      }

      return fullResponse.trim();
    } catch (error) {
      console.error('Error in OllamaProvider.generateResponseWithImage:', error);
      throw error; // Re-throw the original error instead of wrapping it
    }
  }

  async generateResponseWithAttachments(prompt: string, model: string, attachments: Array<{ type: string, content: string, mediaType: string }>): Promise<string> {
    const imageAttachments = attachments.filter(att => att.type === 'image');
    if (imageAttachments.length > 1) {
      throw new Error(`[${this.providerName}] Model ${model} only supports a single image input`);
    }

    if (imageAttachments.length === 1) {
      const imageAttachment = imageAttachments[0];
      return this.generateResponseWithImage(prompt, model, imageAttachment.content, imageAttachment.mediaType);
    }

    // If no images, fall back to text-only response
    return this.generateResponse(prompt, model);
  }

  supportsAttachments(model: string): boolean {
    return this.models.some(m => m.name === model && m.supportsImages);
  }
}
