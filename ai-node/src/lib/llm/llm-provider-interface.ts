/**
 * LLMProvider Interface
 * 
 * This interface defines the contract for Language Model (LLM) providers.
 * It specifies the methods that must be implemented by any class that
 * wants to serve as an LLM provider in the application.
 */
export interface LLMProvider {
  /**
   * Retrieves the list of available models from the LLM provider.
   * 
   * @returns A promise that resolves to an array of strings, where each string
   *          represents the name or identifier of an available model.
   */
  getModels(): Promise<Array<{ name: string; supportsImages: boolean; supportsAttachments: boolean }>>;

  /**
   * Generates a response using the specified model based on the given prompt.
   * 
   * @param prompt - The input text or question to be processed by the model.
   * @param model - The name or identifier of the specific model to use for generation.
   * @returns A promise that resolves to a string containing the generated response.
   */
  generateResponse(prompt: string, model: string): Promise<string>;

  generateResponseWithImage(prompt: string, model: string, base64Image: string): Promise<string>;

  generateResponseWithAttachments(prompt: string, model: string, attachments: Array<{ type: string, content: string }>, options?: { reasoning?: { effort?: 'low' | 'medium' | 'high' }, verbosity?: 'low' | 'medium' | 'high' }): Promise<string>;

  supportsImages(model: string): boolean;

  supportsAttachments(model: string): boolean;

  initialize(): Promise<void>;
}

