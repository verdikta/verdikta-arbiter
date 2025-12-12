import { XAIProvider } from '../../../lib/llm/xai-provider';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock the model config
jest.mock('../../../config/models', () => ({
  modelConfig: {
    xai: [
      { name: 'grok-4-1-fast-reasoning', supportsImages: true, supportsAttachments: true },
      { name: 'grok-4-1-fast-non-reasoning', supportsImages: true, supportsAttachments: true },
      { name: 'grok-4-fast-reasoning', supportsImages: true, supportsAttachments: true },
      { name: 'grok-4-fast-non-reasoning', supportsImages: true, supportsAttachments: true },
      { name: 'grok-4-0709', supportsImages: true, supportsAttachments: true },
      { name: 'grok-code-fast-1', supportsImages: true, supportsAttachments: true },
    ],
  },
}));

import { modelConfig } from '../../../config/models';

describe('XAIProvider', () => {
  let provider: XAIProvider;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    // Set up environment variables
    process.env = {
      ...originalEnv,
      XAI_API_KEY: 'test-api-key',
    };
    provider = new XAIProvider();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('initialization', () => {
    test('constructor sets API key from XAI_API_KEY', () => {
      process.env.XAI_API_KEY = 'xai-key';
      delete process.env.GROK_API_KEY;
      const p = new XAIProvider();
      expect(p).toBeDefined();
    });

    test('constructor sets API key from GROK_API_KEY as fallback', () => {
      delete process.env.XAI_API_KEY;
      process.env.GROK_API_KEY = 'grok-key';
      const p = new XAIProvider();
      expect(p).toBeDefined();
    });

    test('constructor warns when no API key is set', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      delete process.env.XAI_API_KEY;
      delete process.env.GROK_API_KEY;
      new XAIProvider();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('XAI_API_KEY not set')
      );
      consoleSpy.mockRestore();
    });

    test('initialize logs warning when API key is not set', async () => {
      delete process.env.XAI_API_KEY;
      delete process.env.GROK_API_KEY;
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const p = new XAIProvider();
      await p.initialize();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('XAI_API_KEY not set')
      );
      consoleSpy.mockRestore();
    });

    test('initialize succeeds with valid API key', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      await provider.initialize();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Provider initialized')
      );
      consoleSpy.mockRestore();
    });
  });

  describe('getModels', () => {
    test('returns expected models', async () => {
      const models = await provider.getModels();
      expect(models).toEqual(modelConfig.xai);
    });
  });

  describe('supportsImages', () => {
    test('returns true for Grok 4.1 and 4 models', () => {
      expect(provider.supportsImages('grok-4-1-fast-reasoning')).toBe(true);
      expect(provider.supportsImages('grok-4-1-fast-non-reasoning')).toBe(true);
      expect(provider.supportsImages('grok-4-fast-reasoning')).toBe(true);
      expect(provider.supportsImages('grok-4-fast-non-reasoning')).toBe(true);
      expect(provider.supportsImages('grok-4-0709')).toBe(true);
      expect(provider.supportsImages('grok-code-fast-1')).toBe(true);
    });

    test('returns false for unknown model', () => {
      expect(provider.supportsImages('non-existent-model')).toBe(false);
    });
  });

  describe('supportsAttachments', () => {
    test('returns true for models that support attachments', () => {
      expect(provider.supportsAttachments('grok-4-1-fast-reasoning')).toBe(true);
      expect(provider.supportsAttachments('grok-4-fast-reasoning')).toBe(true);
      expect(provider.supportsAttachments('grok-4-0709')).toBe(true);
      expect(provider.supportsAttachments('grok-code-fast-1')).toBe(true);
    });

    test('returns false for unknown model', () => {
      expect(provider.supportsAttachments('non-existent-model')).toBe(false);
    });
  });

  describe('generateResponse', () => {
    test('returns expected response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Mocked xAI response' }, finish_reason: 'stop' }],
          usage: { completion_tokens: 10, total_tokens: 20 }
        })
      });

      const response = await provider.generateResponse('Test prompt', 'grok-4-fast-reasoning');
      
      expect(response).toBe('Mocked xAI response');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.x.ai/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-api-key',
          },
          body: expect.stringContaining('grok-4-fast-reasoning')
        })
      );
    });

    test('throws error when API key is not configured', async () => {
      delete process.env.XAI_API_KEY;
      delete process.env.GROK_API_KEY;
      const p = new XAIProvider();

      await expect(p.generateResponse('Test', 'grok-4-fast-reasoning')).rejects.toThrow(
        'XAI_API_KEY not configured'
      );
    });

    test('throws error on HTTP error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized'
      });

      await expect(provider.generateResponse('Test', 'grok-4-fast-reasoning')).rejects.toThrow(
        'HTTP 401: Unauthorized'
      );
    });

    test('throws error on invalid response format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ invalid: 'response' })
      });

      await expect(provider.generateResponse('Test', 'grok-4-fast-reasoning')).rejects.toThrow(
        'Invalid response format'
      );
    });

    test('throws error when no content in response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '' }, finish_reason: 'stop' }],
          usage: { completion_tokens: 0, total_tokens: 10 }
        })
      });

      await expect(provider.generateResponse('Test', 'grok-4-fast-reasoning')).rejects.toThrow(
        'No content in response'
      );
    });
  });

  describe('generateResponseWithImage', () => {
    test('returns expected response for Grok 4 model with image', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Image description' } }]
        })
      });

      const response = await provider.generateResponseWithImage(
        'Describe this image',
        'grok-4-1-fast-reasoning',
        'base64EncodedImageString',
        'image/jpeg'
      );

      expect(response).toBe('Image description');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.x.ai/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('image_url')
        })
      );
    });

    test('throws error for unknown model', async () => {
      await expect(
        provider.generateResponseWithImage(
          'Describe this image',
          'unknown-model',
          'base64EncodedImageString'
        )
      ).rejects.toThrow('Model unknown-model does not support image inputs');
    });

    test('throws error for unsupported image format', async () => {
      await expect(
        provider.generateResponseWithImage(
          'Describe this image',
          'grok-4-1-fast-reasoning',
          'base64EncodedImageString',
          'image/tiff'
        )
      ).rejects.toThrow('Unsupported image format: image/tiff');
    });

    test('throws error for oversized image', async () => {
      const largeBase64String = 'A'.repeat(30 * 1024 * 1024); // 30MB

      await expect(
        provider.generateResponseWithImage(
          'Describe this image',
          'grok-4-1-fast-reasoning',
          largeBase64String,
          'image/jpeg'
        )
      ).rejects.toThrow('Image file size must be under 20 MB');
    });

    test('accepts all valid image formats', async () => {
      const formats = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

      for (const format of formats) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'Description' } }]
          })
        });

        await provider.generateResponseWithImage(
          'Describe this image',
          'grok-4-1-fast-reasoning',
          'base64EncodedImageString',
          format
        );
      }

      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });

  describe('generateResponseWithAttachments', () => {
    test('returns expected response with text attachments', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Response with attachments' } }]
        })
      });

      const attachments = [
        { type: 'text', content: 'Additional context', mediaType: 'text/plain' }
      ];

      const response = await provider.generateResponseWithAttachments(
        'Analyze this',
        'grok-4-fast-reasoning',
        attachments
      );

      expect(response).toBe('Response with attachments');
    });

    test('returns expected response with image attachments', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Image analysis' } }]
        })
      });

      const attachments = [
        { type: 'image', content: 'base64ImageData', mediaType: 'image/jpeg' }
      ];

      const response = await provider.generateResponseWithAttachments(
        'What is in this image?',
        'grok-4-1-fast-reasoning',
        attachments
      );

      expect(response).toBe('Image analysis');
    });

    test('throws error for unsupported model', async () => {
      const attachments = [
        { type: 'text', content: 'Some text', mediaType: 'text/plain' }
      ];

      await expect(
        provider.generateResponseWithAttachments(
          'Process this',
          'non-existent-model',
          attachments
        )
      ).rejects.toThrow('does not support attachments');
    });

    test('validates image format in attachments', async () => {
      const attachments = [
        { type: 'image', content: 'base64ImageData', mediaType: 'image/tiff' }
      ];

      await expect(
        provider.generateResponseWithAttachments(
          'Process this',
          'grok-4-1-fast-reasoning',
          attachments
        )
      ).rejects.toThrow('Unsupported image format: image/tiff');
    });

    test('validates image size in attachments', async () => {
      const largeBase64String = 'A'.repeat(30 * 1024 * 1024);
      const attachments = [
        { type: 'image', content: largeBase64String, mediaType: 'image/jpeg' }
      ];

      await expect(
        provider.generateResponseWithAttachments(
          'Process this',
          'grok-4-1-fast-reasoning',
          attachments
        )
      ).rejects.toThrow('Image file size must be under 20 MB');
    });

    test('handles mixed text and image attachments', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Mixed response' } }]
        })
      });

      const attachments = [
        { type: 'text', content: 'Context text', mediaType: 'text/plain' },
        { type: 'image', content: 'base64ImageData', mediaType: 'image/png' }
      ];

      const response = await provider.generateResponseWithAttachments(
        'Analyze with context',
        'grok-4-1-fast-reasoning',
        attachments
      );

      expect(response).toBe('Mixed response');
      
      // Verify the request body contains both text and image parts
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      const content = body.messages[0].content;
      
      expect(content).toHaveLength(3); // prompt + text attachment + image
      expect(content[0].type).toBe('text');
      expect(content[1].type).toBe('text');
      expect(content[2].type).toBe('image_url');
    });
  });

  describe('custom base URL', () => {
    test('uses custom base URL from environment', async () => {
      process.env.XAI_BASE_URL = 'https://custom.xai.api/v1';
      const customProvider = new XAIProvider();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Response' }, finish_reason: 'stop' }],
          usage: { completion_tokens: 5, total_tokens: 15 }
        })
      });

      await customProvider.generateResponse('Test', 'grok-4-fast-reasoning');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://custom.xai.api/v1/chat/completions',
        expect.any(Object)
      );
    });
  });
});
