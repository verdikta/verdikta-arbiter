import { AnthropicProvider } from '../../../lib/llm/anthropic-provider';
import { ChatAnthropic } from "@langchain/anthropic";
import { modelConfig } from '../../../config/models';
import { resolveAnthropicModelId } from '../../../config/anthropic-models';

jest.mock("@langchain/anthropic", () => ({
  ChatAnthropic: jest.fn().mockImplementation(() => ({
    invoke: jest.fn(),
  })),
}));

jest.mock('../../../config/models', () => ({
  modelConfig: {
    anthropic: [
      { name: 'claude-2.1', supportsImages: false, supportsAttachments: false },
      { name: 'claude-3-sonnet-20240229', supportsImages: true, supportsAttachments: false },
      { name: 'claude-3-5-sonnet-20241022', supportsImages: true, supportsAttachments: true },
      { name: 'claude-sonnet-4.5', supportsImages: true, supportsAttachments: true },
    ],
  },
}));

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new AnthropicProvider('test-anthropic-api-key');
  });

  test('getModels returns expected models', async () => {
    const models = await provider.getModels();
    expect(models).toEqual(modelConfig.anthropic.map(m => ({
      ...m,
      supportsAttachments: m.supportsImages 
    })));
  });

  test('supportsImages returns correct values', () => {
    expect(provider.supportsImages('claude-2.1')).toBe(false);
    expect(provider.supportsImages('claude-3-sonnet-20240229')).toBe(true);
    expect(provider.supportsImages('non-existent-model')).toBe(false);
  });

  test('generateResponse returns expected response', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Mocked Anthropic response' });
    (ChatAnthropic as unknown as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke,
    }));

    const response = await provider.generateResponse('Test prompt', 'claude-2.1');

    expect(response).toBe('Mocked Anthropic response');
    expect(ChatAnthropic).toHaveBeenCalledWith({
      anthropicApiKey: 'test-anthropic-api-key',
      modelName: 'claude-2.1',
      temperature: 0.7,
      topP: undefined,
    });
    expect(mockInvoke).toHaveBeenCalledWith('Test prompt');
  });

  test('generateResponseWithImage returns expected response', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Mocked image response' });
    (ChatAnthropic as unknown as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke,
    }));

    const response = await provider.generateResponseWithImage(
      'Describe this image',
      'claude-3-sonnet-20240229',
      'base64EncodedImageString'
    );

    expect(response).toBe('Mocked image response');
    expect(ChatAnthropic).toHaveBeenCalledWith({
      anthropicApiKey: 'test-anthropic-api-key',
      modelName: 'claude-3-sonnet-20240229',
      temperature: 0.7,
      topP: undefined,
    });
    expect(mockInvoke).toHaveBeenCalledWith([{
      role: "user",
      content: [
        { type: "text", text: 'Describe this image' },
        {
          type: "image_url",
          image_url: { url: 'data:image/jpeg;base64,base64EncodedImageString' }
        }
      ]
    }]);
  });

  test('generateResponseWithImage throws error when model does not support images', async () => {
    await expect(provider.generateResponseWithImage(
      'Attempting image prompt',
      'claude-2.1',
      'base64EncodedImageString'
    )).rejects.toThrow('Model claude-2.1 does not support image inputs.');
  });

  test('generateResponseWithAttachments returns expected response', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Mocked attachments response' });
    (ChatAnthropic as unknown as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke,
    }));

    const attachments = [
      { 
        type: 'image', 
        content: 'base64EncodedImage1',
        mediaType: 'image/jpeg'
      },
      { 
        type: 'text', 
        content: 'Some text attachment',
        mediaType: 'text/plain'
      }
    ];

    const response = await provider.generateResponseWithAttachments(
      'Process these attachments',
      'claude-3-5-sonnet-20241022',
      attachments
    );

    expect(response).toBe('Mocked attachments response');
    expect(ChatAnthropic).toHaveBeenCalledWith({
      anthropicApiKey: 'test-anthropic-api-key',
      modelName: 'claude-3-5-sonnet-20241022',
      temperature: 0.7,
      topP: undefined,
    });
    expect(mockInvoke).toHaveBeenCalledWith([{
      role: "user",
      content: [
        { type: "text", text: 'Process these attachments' },
        {
          type: "image_url",
          image_url: { url: 'data:image/jpeg;base64,base64EncodedImage1' }
        },
        { type: "text", text: 'Some text attachment' }
      ]
    }]);
  });

  test('generateResponseWithAttachments throws error when model does not support attachments', async () => {
    await expect(provider.generateResponseWithAttachments(
      'Process these attachments',
      'claude-2.1',
      [{ type: 'image', content: 'base64EncodedImage', mediaType: 'image/jpeg' }]
    )).rejects.toThrow('Model claude-2.1 does not support attachments.');
  });

  test('generateResponseWithImage validates image format', async () => {
    await expect(provider.generateResponseWithImage(
      'Describe this image',
      'claude-3-sonnet-20240229',
      'base64EncodedImageString',
      'image/bmp'
    )).rejects.toThrow('Unsupported image format: image/bmp. Supported formats are: JPEG, PNG, WEBP, and GIF.');
  });

  test('generateResponseWithImage accepts valid image formats', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Mocked image response' });
    (ChatAnthropic as unknown as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke,
    }));

    // Test JPEG
    await provider.generateResponseWithImage(
      'Describe this image',
      'claude-3-sonnet-20240229',
      'base64EncodedImageString',
      'image/jpeg'
    );

    // Test PNG
    await provider.generateResponseWithImage(
      'Describe this image',
      'claude-3-sonnet-20240229',
      'base64EncodedImageString',
      'image/png'
    );

    expect(mockInvoke).toHaveBeenCalledTimes(2);
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
      'claude-3-5-sonnet-20241022',
      attachments
    )).rejects.toThrow('Unsupported image format: image/tiff. Supported formats are: JPEG, PNG, WEBP, and GIF.');
  });

  test('generateResponseWithAttachments accepts valid image formats', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Mocked attachments response' });
    (ChatAnthropic as unknown as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke,
    }));

    const attachments = [
      { 
        type: 'image', 
        content: 'base64EncodedImage1',
        mediaType: 'image/jpeg'
      },
      { 
        type: 'image', 
        content: 'base64EncodedImage2',
        mediaType: 'image/png'
      },
      { 
        type: 'text', 
        content: 'Some text attachment',
        mediaType: 'text/plain'
      }
    ];

    const response = await provider.generateResponseWithAttachments(
      'Process these attachments',
      'claude-3-5-sonnet-20241022',
      attachments
    );

    expect(response).toBe('Mocked attachments response');
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  test('generateResponse normalizes dotted model names to Anthropic API IDs', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Mocked Anthropic response' });
    (ChatAnthropic as unknown as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke,
    }));

    const response = await provider.generateResponse('Test prompt', 'claude-sonnet-4.5');

    expect(response).toBe('Mocked Anthropic response');
    expect(ChatAnthropic).toHaveBeenCalledWith({
      anthropicApiKey: 'test-anthropic-api-key',
      modelName: 'claude-sonnet-4-5',
      temperature: 0.7,
      topP: undefined,
    });
  });

  test('generateResponseWithImage normalizes dotted model names to Anthropic API IDs', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Mocked image response' });
    (ChatAnthropic as unknown as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke,
    }));

    await provider.generateResponseWithImage(
      'Describe this image',
      'claude-sonnet-4.5',
      'base64EncodedImageString'
    );

    expect(ChatAnthropic).toHaveBeenCalledWith({
      anthropicApiKey: 'test-anthropic-api-key',
      modelName: 'claude-sonnet-4-5',
      temperature: 0.7,
      topP: undefined,
    });
  });

  test('generateResponseWithAttachments normalizes dotted model names to Anthropic API IDs', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Mocked attachments response' });
    (ChatAnthropic as unknown as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke,
    }));

    await provider.generateResponseWithAttachments(
      'Process these attachments',
      'claude-sonnet-4.5',
      [{ type: 'text', content: 'Some text attachment', mediaType: 'text/plain' }]
    );

    expect(ChatAnthropic).toHaveBeenCalledWith({
      anthropicApiKey: 'test-anthropic-api-key',
      modelName: 'claude-sonnet-4-5',
      temperature: 0.7,
      topP: undefined,
    });
  });
});

describe('resolveAnthropicModelId', () => {
  test('maps dotted names to real Anthropic API IDs', () => {
    expect(resolveAnthropicModelId('claude-sonnet-4.5')).toBe('claude-sonnet-4-5');
    expect(resolveAnthropicModelId('claude-haiku-4.5')).toBe('claude-haiku-4-5');
    expect(resolveAnthropicModelId('claude-sonnet-4.6')).toBe('claude-sonnet-4-6');
    expect(resolveAnthropicModelId('claude-opus-4.6')).toBe('claude-opus-4-6');
  });

  test('converts unmapped family-dotted names to dash form', () => {
    expect(resolveAnthropicModelId('claude-opus-4.7')).toBe('claude-opus-4-7');
    expect(resolveAnthropicModelId('claude-sonnet-5.1')).toBe('claude-sonnet-5-1');
  });

  test('passes dash-form IDs through unchanged', () => {
    expect(resolveAnthropicModelId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5-20250929');
    expect(resolveAnthropicModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
    expect(resolveAnthropicModelId('claude-opus-4-6')).toBe('claude-opus-4-6');
    expect(resolveAnthropicModelId('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet-20241022');
  });

  test('preserves claude-2.1, whose dot is part of the literal API ID', () => {
    expect(resolveAnthropicModelId('claude-2.1')).toBe('claude-2.1');
  });

  test('does not remap retired version-first dotted names', () => {
    // These models were retired by Anthropic; they are no longer listed in
    // modelConfig and must not be silently converted to some other model.
    expect(resolveAnthropicModelId('claude-3.5-sonnet')).toBe('claude-3.5-sonnet');
    expect(resolveAnthropicModelId('claude-3.5-haiku')).toBe('claude-3.5-haiku');
    expect(resolveAnthropicModelId('claude-3.7-sonnet')).toBe('claude-3.7-sonnet');
  });
});

