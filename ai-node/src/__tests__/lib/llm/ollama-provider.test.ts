import { OllamaProvider } from '../../../lib/llm/ollama-provider';
import { ChatOllama } from "@langchain/ollama";

// Add TextEncoder to the global scope for tests
global.TextEncoder = require('util').TextEncoder;
global.TextDecoder = require('util').TextDecoder;

describe('OllamaProvider', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new OllamaProvider('http://localhost:11434');
    
    // Mock the log function
    provider.log = jest.fn();
    
    // Update mock to match local setup
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        models: [
          { name: 'llava', details: { families: ['llava', 'clip'] } },
          { name: 'phi3', details: { families: ['phi3'] } },
          { name: 'llama3.2', details: { families: ['llama'] } },
          { name: 'llama3.1', details: { families: ['llama'] } }
        ]
      })
    });
  });

  describe('Image Format Validation', () => {
    test('rejects unsupported image formats', async () => {
      await provider.initialize();
      jest.spyOn(provider, 'supportsImages').mockResolvedValue(true);

      await expect(provider.generateResponseWithImage(
        'Describe this image',
        'llava',
        'base64EncodedImageString',
        'image/webp'
      )).rejects.toThrow('[Ollama] Unsupported image format: image/webp. Only JPEG and PNG formats are supported.');
    });

    test('accepts supported image formats', async () => {
      await provider.initialize();
      jest.spyOn(provider, 'supportsImages').mockResolvedValue(true);
      
      // Mock successful response for this test
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: jest.fn().mockResolvedValue({ done: true })
          })
        }
      });

      // Should not throw for supported formats
      await expect(provider.generateResponseWithImage(
        'Describe this image',
        'llava',
        'base64EncodedImageString',
        'image/jpeg'
      )).resolves.not.toThrow();

      await expect(provider.generateResponseWithImage(
        'Describe this image',
        'llava',
        'base64EncodedImageString',
        'image/png'
      )).resolves.not.toThrow();
    });
  });

  describe('File Size Validation', () => {
    test('rejects oversized images', async () => {
      await provider.initialize();
      jest.spyOn(provider, 'supportsImages').mockResolvedValue(true);
      
      const largeBase64String = 'A'.repeat(30 * 1024 * 1024);

      await expect(provider.generateResponseWithImage(
        'Describe this image',
        'llava',
        largeBase64String,
        'image/jpeg'
      )).rejects.toThrow('[Ollama] Image file size must be under 20 MB.');
    });
  });

  describe('Model Support Validation', () => {
    test('rejects unsupported models', async () => {
      await provider.initialize();

      await expect(provider.generateResponseWithImage(
        'Describe this image',
        'llama3.2',
        'base64EncodedImageString',
        'image/jpeg'
      )).rejects.toThrow('[Ollama] Model llama3.2 does not support image inputs.');
    });
  });

  describe('Attachment Handling', () => {
    test('rejects multiple images', async () => {
      await provider.initialize();
      
      const attachments = [
        { type: 'image', content: 'base64Image1', mediaType: 'image/jpeg' },
        { type: 'image', content: 'base64Image2', mediaType: 'image/png' }
      ];

      await expect(provider.generateResponseWithAttachments(
        'Process these images',
        'llava',
        attachments
      )).rejects.toThrow('[Ollama] Model llava only supports a single image input');
    });

    test('validates image format in attachments', async () => {
      await provider.initialize();
      
      const attachments = [
        { type: 'image', content: 'base64Image', mediaType: 'image/webp' }
      ];

      await expect(provider.generateResponseWithAttachments(
        'Process this image',
        'llava',
        attachments
      )).rejects.toThrow('[Ollama] Unsupported image format: image/webp. Only JPEG and PNG formats are supported.');
    });
  });
});
