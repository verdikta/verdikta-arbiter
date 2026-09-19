import { AnthropicProvider } from '../../../lib/llm/anthropic-provider';
import { ChatAnthropic } from "@langchain/anthropic";
import { modelConfig } from '../../../config/models';
import { MODERN_MAX_TOKENS } from '../../../lib/llm/anthropic-request-params';

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
      { name: 'claude-sonnet-4-6', supportsImages: true, supportsAttachments: true },
      { name: 'claude-sonnet-5', supportsImages: true, supportsAttachments: true },
      { name: 'claude-opus-5', supportsImages: true, supportsAttachments: true },
    ],
  },
}));

const MockedChatAnthropic = ChatAnthropic as unknown as jest.Mock;

/** The constructor fields of the n-th ChatAnthropic instance created in the test. */
const constructorArgs = (n = 0) => MockedChatAnthropic.mock.calls[n][0];

/** A 400 shaped like @anthropic-ai/sdk's BadRequestError (status field + "<status> <message>"). */
const samplingRejection = () =>
  Object.assign(new Error('400 `temperature` is deprecated for this model.'), { status: 400 });

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    provider = new AnthropicProvider('test-anthropic-api-key');
  });

  afterEach(() => {
    warnSpy.mockRestore();
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
    MockedChatAnthropic.mockImplementation(() => ({
      invoke: mockInvoke,
    }));

    const response = await provider.generateResponse('Test prompt', 'claude-2.1');

    expect(response).toBe('Mocked Anthropic response');
    expect(ChatAnthropic).toHaveBeenCalledWith({
      anthropicApiKey: 'test-anthropic-api-key',
      modelName: 'claude-2.1',
      temperature: 0.7,
    });
    expect(mockInvoke).toHaveBeenCalledWith('Test prompt');
  });

  describe('sampling parameters per model (the Claude 5 "temperature is deprecated" incident)', () => {
    test.each(['claude-2.1', 'claude-3-5-sonnet-20241022', 'claude-sonnet-4-6'])(
      '%s is still called with temperature 0.7 and nothing else',
      async (model) => {
        MockedChatAnthropic.mockImplementation(() => ({
          invoke: jest.fn().mockResolvedValue({ content: 'ok' }),
        }));

        await provider.generateResponse('Test prompt', model);

        expect(constructorArgs()).toEqual({
          anthropicApiKey: 'test-anthropic-api-key',
          modelName: model,
          temperature: 0.7,
        });
        expect(constructorArgs()).not.toHaveProperty('topP');
        expect(constructorArgs()).not.toHaveProperty('topK');
      }
    );

    test.each(['claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-7', 'claude-sonnet-5-20261001'])(
      '%s is called without temperature / top_p / top_k and with a Claude-4-sized max_tokens',
      async (model) => {
        MockedChatAnthropic.mockImplementation(() => ({
          invoke: jest.fn().mockResolvedValue({ content: 'ok' }),
        }));

        await provider.generateResponse('Test prompt', model);

        expect(constructorArgs()).toEqual({
          anthropicApiKey: 'test-anthropic-api-key',
          modelName: model,
          maxTokens: MODERN_MAX_TOKENS,
        });
        expect(constructorArgs()).not.toHaveProperty('temperature');
        expect(constructorArgs()).not.toHaveProperty('topP');
        expect(constructorArgs()).not.toHaveProperty('topK');
        expect(MockedChatAnthropic).toHaveBeenCalledTimes(1); // no retry needed
      }
    );

    test('attachments path also drops the sampling parameters for Claude 5', async () => {
      const mockInvoke = jest.fn().mockResolvedValue({ content: 'ok' });
      MockedChatAnthropic.mockImplementation(() => ({ invoke: mockInvoke }));

      await provider.generateResponseWithAttachments('Judge this', 'claude-sonnet-5', [
        { type: 'text', content: 'the submitted work', mediaType: 'text/plain' },
      ]);

      expect(constructorArgs()).toEqual({
        anthropicApiKey: 'test-anthropic-api-key',
        modelName: 'claude-sonnet-5',
        maxTokens: MODERN_MAX_TOKENS,
      });
      expect(mockInvoke).toHaveBeenCalledWith([{
        role: 'user',
        content: [
          { type: 'text', text: 'Judge this' },
          { type: 'text', text: 'the submitted work' },
        ],
      }]);
    });

    test('image path also drops the sampling parameters for Claude 5', async () => {
      MockedChatAnthropic.mockImplementation(() => ({
        invoke: jest.fn().mockResolvedValue({ content: 'ok' }),
      }));

      await provider.generateResponseWithImage('Describe', 'claude-opus-5', 'base64', 'image/png');

      expect(constructorArgs()).not.toHaveProperty('temperature');
      expect(constructorArgs()).toMatchObject({ modelName: 'claude-opus-5', maxTokens: MODERN_MAX_TOKENS });
    });

    test('a 400 that names temperature on a model classified as legacy is retried once without sampling parameters', async () => {
      const firstInvoke = jest.fn().mockRejectedValue(samplingRejection());
      const secondInvoke = jest.fn().mockResolvedValue({ content: 'answer without temperature' });
      MockedChatAnthropic
        .mockImplementationOnce(() => ({ invoke: firstInvoke }))
        .mockImplementationOnce(() => ({ invoke: secondInvoke }));

      const response = await provider.generateResponse('Test prompt', 'claude-sonnet-4-6');

      expect(response).toBe('answer without temperature');
      expect(MockedChatAnthropic).toHaveBeenCalledTimes(2);
      expect(constructorArgs(0)).toMatchObject({ temperature: 0.7 });
      expect(constructorArgs(1)).toEqual({
        anthropicApiKey: 'test-anthropic-api-key',
        modelName: 'claude-sonnet-4-6',
        maxTokens: MODERN_MAX_TOKENS,
      });
      expect(constructorArgs(1)).not.toHaveProperty('temperature');
      expect(firstInvoke).toHaveBeenCalledWith('Test prompt');
      expect(secondInvoke).toHaveBeenCalledWith('Test prompt');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/claude-sonnet-4-6 rejected a sampling parameter/));
    });

    test('the retry is not attempted when no sampling parameter was sent', async () => {
      const invoke = jest.fn().mockRejectedValue(samplingRejection());
      MockedChatAnthropic.mockImplementation(() => ({ invoke }));

      await expect(provider.generateResponse('Test prompt', 'claude-sonnet-5'))
        .rejects.toThrow('`temperature` is deprecated for this model.');
      expect(MockedChatAnthropic).toHaveBeenCalledTimes(1);
    });

    test.each([
      ['another 400', Object.assign(new Error('400 messages: at least one message is required'), { status: 400 })],
      ['a 429', Object.assign(new Error('429 rate limited'), { status: 429 })],
      ['a plain error', new Error('socket hang up')],
    ])('%s propagates unchanged with no retry', async (_label, error) => {
      const invoke = jest.fn().mockRejectedValue(error);
      MockedChatAnthropic.mockImplementation(() => ({ invoke }));

      await expect(provider.generateResponse('Test prompt', 'claude-sonnet-4-6')).rejects.toBe(error);
      expect(MockedChatAnthropic).toHaveBeenCalledTimes(1);
    });

    test('a block-list reply (thinking block, then text) yields the text', async () => {
      MockedChatAnthropic.mockImplementation(() => ({
        invoke: jest.fn().mockResolvedValue({
          content: [
            { type: 'thinking', thinking: '', signature: 'sig' },
            { type: 'text', text: '{"score":[600000,400000],"justification":"…"}' },
          ],
        }),
      }));

      await expect(provider.generateResponse('Test prompt', 'claude-opus-5'))
        .resolves.toBe('{"score":[600000,400000],"justification":"…"}');
    });

    test('a reply with no text block is still an error', async () => {
      MockedChatAnthropic.mockImplementation(() => ({
        invoke: jest.fn().mockResolvedValue({ content: [{ type: 'thinking', thinking: 'x' }] }),
      }));

      await expect(provider.generateResponse('Test prompt', 'claude-opus-5'))
        .rejects.toThrow('Unexpected response format from Anthropic');
    });
  });

  test('generateResponseWithImage returns expected response', async () => {
    const mockInvoke = jest.fn().mockResolvedValue({ content: 'Mocked image response' });
    MockedChatAnthropic.mockImplementation(() => ({
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
    MockedChatAnthropic.mockImplementation(() => ({
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
    MockedChatAnthropic.mockImplementation(() => ({
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
    MockedChatAnthropic.mockImplementation(() => ({
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
});
