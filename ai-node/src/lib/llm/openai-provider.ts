/**
 * OpenAIProvider Module
 * 
 * This module implements the LLMProvider interface for the OpenAI language model service.
 * It provides functionality to interact with OpenAI models, including fetching available models
 * and generating responses to prompts.
 */

import 'openai/shims/node';
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
  async generateResponse(prompt: string, model: string): Promise<string> {
    const openai = new ChatOpenAI({
      openAIApiKey: this.apiKey,
      modelName: model,
    });
    const response = await openai.invoke(prompt);
    if (typeof response.content !== 'string') {
      throw new Error('Unexpected response format from OpenAI');
    }
    return response.content;
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

  async generateResponseWithAttachments(prompt: string, model: string, attachments: Array<{ type: string, content: string, mediaType: string }>): Promise<string> {
    const openai = new ChatOpenAI({
      openAIApiKey: this.apiKey,
      modelName: model,
      maxTokens: 1000,
    });

    // Validate image attachments
    for (const attachment of attachments) {
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
      ...attachments.map(attachment => {
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
}
