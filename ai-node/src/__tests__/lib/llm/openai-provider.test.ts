import { OpenAIProvider } from '../../../lib/llm/openai-provider';
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from '@langchain/core/messages';

import OpenAI from 'openai';

// Mock the OpenAI class directly without a separate MockOpenAI class
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue({
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content: 'Mocked response' } }]
        })
      }
    }
  })
}));

jest.mock("@langchain/openai");

import { modelConfig } from '../../../config/models';

jest.mock('../../../config/models', () => ({
  modelConfig: {
    openai: [
      { name: 'gpt-3.5-turbo', supportsImages: false },
      { name: 'gpt-4', supportsImages: false },
      { name: 'gpt-4o', supportsImages: true },
    ],
  },
}));

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new OpenAIProvider('test-api-key');
  });

  test('getModels returns expected models', async () => {
    const models = await provider.getModels();
    expect(models).toEqual(modelConfig.openai);
  });

  test('supportsImages returns correct values', () => {
    expect(provider.supportsImages('gpt-3.5-turbo')).toBe(false);
    expect(provider.supportsImages('gpt-4')).toBe(false);
    expect(provider.supportsImages('gpt-4o')).toBe(true);
    expect(provider.supportsImages('non-existent-model')).toBe(false);
  });

  test('generateResponse returns expected response', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Mocked response' });
    (ChatOpenAI as unknown as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke
    }));

    const response = await provider.generateResponse('Test prompt', 'gpt-3.5-turbo');
    
    expect(response).toBe('Mocked response');
    expect(ChatOpenAI).toHaveBeenCalledWith({
      openAIApiKey: 'test-api-key',
      modelName: 'gpt-3.5-turbo',
      maxTokens: 1000,
    });
    expect(mockInvoke).toHaveBeenCalledWith('Test prompt');
  });

  test('generateResponseWithImage returns expected response', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Mocked image response' });
    (ChatOpenAI as unknown as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke
    }));

    const response = await provider.generateResponseWithImage(
      'Describe this image',
      'gpt-4o',
      'base64EncodedImageString'
    );

    expect(response).toBe('Mocked image response');
    expect(ChatOpenAI).toHaveBeenCalledWith({
      openAIApiKey: 'test-api-key',
      modelName: 'gpt-4o',
      maxTokens: 1000,
    });
    expect(mockInvoke).toHaveBeenCalledWith([
      new HumanMessage({
        content: [
          { type: "text", text: 'Describe this image' },
          {
            type: "image_url",
            image_url: { url: 'data:image/jpeg;base64,base64EncodedImageString' }
          }
        ]
      })
    ]);
  });

  test('generateResponseWithAttachments returns expected response', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Mocked response with attachments' });
    (ChatOpenAI as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke
    }));

    const attachments = [
      { 
        type: 'text', 
        content: 'Additional text',
        mediaType: 'text/plain'
      },
      { 
        type: 'image', 
        content: 'base64EncodedImageString',
        mediaType: 'image/jpeg'
      }
    ];

    const response = await provider.generateResponseWithAttachments(
      'Test prompt with attachments',
      'gpt-4o',
      attachments
    );

    expect(response).toBe('Mocked response with attachments');
    expect(ChatOpenAI).toHaveBeenCalledWith({
      openAIApiKey: 'test-api-key',
      modelName: 'gpt-4o',
      maxTokens: 1000
    });
    expect(mockInvoke).toHaveBeenCalledWith([
      new HumanMessage({
        content: [
          { type: "text", text: 'Test prompt with attachments' },
          { type: "text", text: 'Additional text' },
          {
            type: "image_url",
            image_url: { 
              url: 'data:image/jpeg;base64,base64EncodedImageString',
              detail: "auto"
            }
          }
        ]
      })
    ]);
  });

  test('generateResponseWithImage validates image format', async () => {
    await expect(provider.generateResponseWithImage(
      'Describe this image',
      'gpt-4o',
      'base64EncodedImageString',
      'image/tiff' // unsupported format
    )).rejects.toThrow('Unsupported image format: image/tiff. Supported formats are: JPEG, PNG, GIF, and WEBP.');
  });

  test('generateResponseWithImage accepts all valid image formats', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Mocked image response' });
    (ChatOpenAI as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke
    }));

    const formats = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    
    for (const format of formats) {
      await provider.generateResponseWithImage(
        'Describe this image',
        'gpt-4o',
        'base64EncodedImageString',
        format
      );
    }

    expect(mockInvoke).toHaveBeenCalledTimes(4);
  });

  test('generateResponseWithImage validates file size', async () => {
    // Create a large base64 string (> 20MB after conversion)
    const largeBase64String = 'A'.repeat(30 * 1024 * 1024); // 30MB worth of base64 data

    await expect(provider.generateResponseWithImage(
      'Describe this image',
      'gpt-4o',
      largeBase64String,
      'image/jpeg'
    )).rejects.toThrow('Image file size must be under 20 MB.');
  });

  test('generateResponseWithAttachments validates image formats', async () => {
    const attachments = [
      { 
        type: 'image', 
        content: 'base64EncodedImage1',
        mediaType: 'image/tiff'
      }
    ];

    await expect(provider.generateResponseWithAttachments(
      'Process these attachments',
      'gpt-4o',
      attachments
    )).rejects.toThrow('Unsupported image format: image/tiff. Supported formats are: JPEG, PNG, GIF, and WEBP.');
  });

  test('generateResponseWithAttachments validates file size', async () => {
    const largeBase64String = 'A'.repeat(30 * 1024 * 1024); // 30MB worth of base64 data
    const attachments = [
      { 
        type: 'image', 
        content: largeBase64String,
        mediaType: 'image/jpeg'
      }
    ];

    await expect(provider.generateResponseWithAttachments(
      'Process these attachments',
      'gpt-4o',
      attachments
    )).rejects.toThrow('Image file size must be under 20 MB.');
  });

  test('generateResponseWithAttachments accepts all valid image formats', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Mocked response with attachments' });
    (ChatOpenAI as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke
    }));

    const attachments = [
      { 
        type: 'text', 
        content: 'Additional text',
        mediaType: 'text/plain'
      },
      { 
        type: 'image', 
        content: 'base64EncodedImageString',
        mediaType: 'image/jpeg'
      },
      { 
        type: 'image', 
        content: 'base64EncodedImageString',
        mediaType: 'image/png'
      },
      { 
        type: 'image', 
        content: 'base64EncodedImageString',
        mediaType: 'image/gif'
      },
      { 
        type: 'image', 
        content: 'base64EncodedImageString',
        mediaType: 'image/webp'
      }
    ];

    const response = await provider.generateResponseWithAttachments(
      'Test prompt with attachments',
      'gpt-4o',
      attachments
    );

    expect(response).toBe('Mocked response with attachments');
    expect(ChatOpenAI).toHaveBeenCalledWith({
      openAIApiKey: 'test-api-key',
      modelName: 'gpt-4o',
      maxTokens: 1000
    });
    expect(mockInvoke).toHaveBeenCalledWith([
      new HumanMessage({
        content: [
          { type: "text", text: 'Test prompt with attachments' },
          { type: "text", text: 'Additional text' },
          {
            type: "image_url",
            image_url: { 
              url: 'data:image/jpeg;base64,base64EncodedImageString',
              detail: "auto"
            }
          },
          {
            type: "image_url",
            image_url: { 
              url: 'data:image/png;base64,base64EncodedImageString',
              detail: "auto"
            }
          },
          {
            type: "image_url",
            image_url: { 
              url: 'data:image/gif;base64,base64EncodedImageString',
              detail: "auto"
            }
          },
          {
            type: "image_url",
            image_url: { 
              url: 'data:image/webp;base64,base64EncodedImageString',
              detail: "auto"
            }
          }
        ]
      })
    ]);
  });

  // New tests for reasoning model support with attachments
  test('generateResponse with reasoning model uses higher maxTokens and reasoning options', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Reasoning model response' });
    (ChatOpenAI as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke
    }));

    const response = await provider.generateResponse(
      'Analyze this complex problem',
      'gpt-5-mini',
      { reasoning: { effort: 'medium' }, verbosity: 'low' }
    );

    expect(response).toBe('Reasoning model response');
    expect(ChatOpenAI).toHaveBeenCalledWith({
      openAIApiKey: 'test-api-key',
      modelName: 'gpt-5-mini',
      maxTokens: 16000,
      reasoning: { effort: 'medium' },
      verbosity: 'low',
    });
    expect(mockInvoke).toHaveBeenCalledWith('Analyze this complex problem');
  });

  test('generateResponseWithAttachments with reasoning model uses higher maxTokens', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Reasoning model with attachments' });
    (ChatOpenAI as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke
    }));

    const attachments = [
      { 
        type: 'text', 
        content: 'Smart contract code to analyze',
        mediaType: 'text/plain'
      }
    ];

    const response = await provider.generateResponseWithAttachments(
      'Evaluate this smart contract for vulnerabilities',
      'gpt-5-mini-2025-08-07',
      attachments,
      { reasoning: { effort: 'medium' }, verbosity: 'low' }
    );

    expect(response).toBe('Reasoning model with attachments');
    expect(ChatOpenAI).toHaveBeenCalledWith({
      openAIApiKey: 'test-api-key',
      modelName: 'gpt-5-mini-2025-08-07',
      maxTokens: 16000,
      reasoning: { effort: 'medium' },
      verbosity: 'low',
    });
    expect(mockInvoke).toHaveBeenCalled();
  });

  test('generateResponseWithAttachments with non-reasoning model uses default maxTokens', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Standard model response' });
    (ChatOpenAI as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke
    }));

    const attachments = [
      { 
        type: 'text', 
        content: 'Some text content',
        mediaType: 'text/plain'
      }
    ];

    const response = await provider.generateResponseWithAttachments(
      'Process this text',
      'gpt-4o',
      attachments,
      { reasoning: { effort: 'medium' }, verbosity: 'low' }
    );

    expect(response).toBe('Standard model response');
    // Non-reasoning model should NOT use 16000 maxTokens or reasoning options
    expect(ChatOpenAI).toHaveBeenCalledWith({
      openAIApiKey: 'test-api-key',
      modelName: 'gpt-4o',
      maxTokens: 1000,
    });
  });

  test('generateResponseWithAttachments with o1 model uses reasoning options', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'O1 model response' });
    (ChatOpenAI as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke
    }));

    const attachments = [
      { 
        type: 'text', 
        content: 'Complex problem',
        mediaType: 'text/plain'
      }
    ];

    const response = await provider.generateResponseWithAttachments(
      'Solve this problem',
      'o1-preview',
      attachments,
      { reasoning: { effort: 'high' }, verbosity: 'medium' }
    );

    expect(response).toBe('O1 model response');
    expect(ChatOpenAI).toHaveBeenCalledWith({
      openAIApiKey: 'test-api-key',
      modelName: 'o1-preview',
      maxTokens: 16000,
      reasoning: { effort: 'high' },
      verbosity: 'medium',
    });
  });

  test('generateResponseWithAttachments without options works correctly', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Response without options' });
    (ChatOpenAI as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke
    }));

    const attachments = [
      { 
        type: 'text', 
        content: 'Some content',
        mediaType: 'text/plain'
      }
    ];

    const response = await provider.generateResponseWithAttachments(
      'Process this',
      'gpt-4o',
      attachments
      // No options parameter
    );

    expect(response).toBe('Response without options');
    expect(ChatOpenAI).toHaveBeenCalledWith({
      openAIApiKey: 'test-api-key',
      modelName: 'gpt-4o',
      maxTokens: 1000,
    });
  });
});
