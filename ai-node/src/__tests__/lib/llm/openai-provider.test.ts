import { OpenAIProvider, responsesOutputText } from '../../../lib/llm/openai-provider';
import { WEB_ACCESS_NOTE } from '../../../lib/llm/web-access';
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from '@langchain/core/messages';

import OpenAI from 'openai';

// Create a mock for the native OpenAI client
const mockOpenAICreate = jest.fn().mockResolvedValue({
  choices: [{ message: { content: 'Mocked native response' } }]
});

// Responses API (web search path)
const mockResponsesCreate = jest.fn();

// Mock the OpenAI class - needs to handle both regular imports and dynamic imports
jest.mock('openai', () => {
  const MockOpenAI = jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockOpenAICreate
      }
    },
    responses: {
      create: mockResponsesCreate
    }
  }));
  return {
    __esModule: true,
    default: MockOpenAI,
    OpenAI: MockOpenAI
  };
});

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
  test('generateResponse with GPT-5 model uses native client with reasoning_effort', async () => {
    // Reset mock for this test
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Reasoning model response' } }]
    });

    const response = await provider.generateResponse(
      'Analyze this complex problem',
      'gpt-5-mini',
      { reasoning: { effort: 'medium' }, verbosity: 'low' }
    );

    expect(response).toBe('Reasoning model response');
    // GPT-5 models use native OpenAI client with reasoning_effort (string) not reasoning (object)
    expect(mockOpenAICreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5-mini',
        max_completion_tokens: 16000,
        reasoning_effort: 'medium',
        verbosity: 'low',
      })
    );
  });

  test('generateResponseWithAttachments with GPT-5 model uses native client', async () => {
    // Reset mock for this test
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Reasoning model with attachments' } }]
    });

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
    // GPT-5 models use native OpenAI client with max_completion_tokens and reasoning_effort
    expect(mockOpenAICreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5-mini-2025-08-07',
        max_completion_tokens: 16000,
        reasoning_effort: 'medium',
      }),
      undefined // no PDF attached, so no PDF beta header
    );
  });

  test('generateResponseWithAttachments with GPT-5 and a PDF uses the native PDF path', async () => {
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Read the PDF' } }]
    });

    await provider.generateResponseWithAttachments(
      'Evaluate the contract',
      'gpt-5.6-sol',
      [{ type: 'document', content: 'JVBERi0xLjQK', mediaType: 'application/pdf' }]
    );

    const [body, requestOptions] = mockOpenAICreate.mock.calls[0];
    expect(body.messages[0].content[1]).toEqual({
      type: 'file',
      file: { file_data: 'data:application/pdf;base64,JVBERi0xLjQK', filename: 'document.pdf' }
    });
    expect(requestOptions).toEqual({ headers: { 'OpenAI-Beta': 'pdf-files-v1' } });
  });

  test('an image rejection on an image-only GPT-5 request is reported as an image error, not a PDF one', async () => {
    // Shaped like the openai SDK's BadRequestError: status field + "<status> <message>".
    const apiError = Object.assign(
      new Error('400 Invalid image: the image requires 30720 patches after processing, exceeding the limit of 30000.'),
      { status: 400, code: 'invalid_image' }
    );
    mockOpenAICreate.mockRejectedValueOnce(apiError);

    const attempt = provider.generateResponseWithAttachments(
      'Judge this submission',
      'gpt-5.6-sol',
      [{ type: 'image', content: 'iVBORw0KGgo=', mediaType: 'image/png' }],
      { reasoning: { effort: 'medium' }, verbosity: 'low' }
    );

    const error = await attempt.catch(e => e);
    expect(error.message).toBe(
      'OpenAI rejected an image attachment for gpt-5.6-sol (HTTP 400): ' +
      '400 Invalid image: the image requires 30720 patches after processing, exceeding the limit of 30000.'
    );
    expect(error.message).not.toMatch(/PDF/);
    expect(error.status).toBe(400);
    expect(error.code).toBe('invalid_image');
    expect(error.cause).toBe(apiError);
    // The request went out without the PDF beta header.
    expect(mockOpenAICreate.mock.calls[0][1]).toBeUndefined();
  });

  test('a non-attachment failure on the native path keeps its message and status', async () => {
    mockOpenAICreate.mockRejectedValueOnce(Object.assign(new Error('503 Service Unavailable'), { status: 503 }));

    await expect(provider.generateResponseWithAttachments(
      'Judge this submission',
      'gpt-5.6-sol',
      [{ type: 'text', content: 'the submitted text', mediaType: 'text/plain' }]
    )).rejects.toMatchObject({
      message: 'OpenAI request with attachments failed for gpt-5.6-sol (HTTP 503): 503 Service Unavailable',
      status: 503
    });
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
  describe('web search (links are opened by OpenAI, not by the arbiter)', () => {
    const LINK_PROMPT = 'Check the final score at https://www.nfl.com/games/jets-at-patriots-2026-reg-6';
    const REASONING = { reasoning: { effort: 'medium' as const }, verbosity: 'low' as const };
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      delete process.env.AI_WEB_ACCESS;
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockResponsesCreate.mockReset();
    });

    afterEach(() => {
      warnSpy.mockRestore();
      delete process.env.AI_WEB_ACCESS;
    });

    test('a GPT-5 prompt with a URL goes to the Responses API with web_search and the web note', async () => {
      mockResponsesCreate.mockResolvedValueOnce({ status: 'completed', output_text: '{"score":[0,1000000]}' });

      const response = await provider.generateResponse(LINK_PROMPT, 'gpt-5.4', REASONING);

      expect(response).toBe('{"score":[0,1000000]}');
      expect(mockOpenAICreate).not.toHaveBeenCalled();
      const body = mockResponsesCreate.mock.calls[0][0];
      expect(body).toMatchObject({
        model: 'gpt-5.4',
        tools: [{ type: 'web_search' }],
        max_tool_calls: 5,
        reasoning: { effort: 'medium' },
        text: { verbosity: 'low' },
      });
      expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: `${WEB_ACCESS_NOTE}\n\n${LINK_PROMPT}` }] }]);
    });

    test('a prompt without a URL keeps chat completions', async () => {
      const response = await provider.generateResponse('Write a haiku', 'gpt-5.4', REASONING);
      expect(response).toBe('Mocked native response');
      expect(mockResponsesCreate).not.toHaveBeenCalled();
    });

    test('AI_WEB_ACCESS=off keeps chat completions even with a URL', async () => {
      process.env.AI_WEB_ACCESS = 'off';
      await provider.generateResponse(LINK_PROMPT, 'gpt-5.4', REASONING);
      expect(mockResponsesCreate).not.toHaveBeenCalled();
      expect(mockOpenAICreate).toHaveBeenCalled();
    });

    test('webAccess: false (the justifier) keeps chat completions even with a URL', async () => {
      await provider.generateResponse(LINK_PROMPT, 'gpt-5.4', { ...REASONING, webAccess: false });
      expect(mockResponsesCreate).not.toHaveBeenCalled();
      expect(mockOpenAICreate).toHaveBeenCalled();
    });

    test('a failed web request falls back to chat completions with a warning', async () => {
      mockResponsesCreate.mockRejectedValueOnce(Object.assign(new Error('400 Unsupported parameter'), { status: 400 }));

      const response = await provider.generateResponse(LINK_PROMPT, 'gpt-5.4', REASONING);

      expect(response).toBe('Mocked native response');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Web search failed for gpt-5.4'));
    });

    test('a URL in a text attachment turns web search on and maps every attachment', async () => {
      mockResponsesCreate.mockResolvedValueOnce({ status: 'completed', output_text: 'ok' });
      const attachments = [
        { type: 'image', content: 'iVBORw0KGgo=', mediaType: 'image/png' },
        { type: 'text', content: 'Source: https://apnews.com/article/jets-patriots', mediaType: 'text/plain' },
      ];

      const response = await provider.generateResponseWithAttachments('Evaluate the claim', 'gpt-5.4', attachments, REASONING);

      expect(response).toBe('ok');
      expect(mockResponsesCreate.mock.calls[0][0].input[0].content).toEqual([
        { type: 'input_text', text: `${WEB_ACCESS_NOTE}\n\nEvaluate the claim` },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'auto' },
        { type: 'input_text', text: 'Source: https://apnews.com/article/jets-patriots' },
      ]);
    });

    test('a non-reasoning model gets no reasoning or verbosity fields', async () => {
      mockResponsesCreate.mockResolvedValueOnce({ status: 'completed', output_text: 'ok' });
      await provider.generateResponse(LINK_PROMPT, 'gpt-4o');
      const body = mockResponsesCreate.mock.calls[0][0];
      expect(body).not.toHaveProperty('reasoning');
      expect(body).not.toHaveProperty('text');
      expect(body.max_output_tokens).toBe(4000);
    });

    test('onWebRetrieval hears the web_search_call actions of the response', async () => {
      mockResponsesCreate.mockResolvedValueOnce({
        status: 'completed',
        output: [
          { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'jets patriots final score' } },
          { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://www.nfl.com/games/jets-at-patriots-2026-reg-6' } },
        ],
        output_text: '{"score":[0,1000000]}',
      });
      const onWebRetrieval = jest.fn();

      await provider.generateResponse(LINK_PROMPT, 'gpt-5.4', { ...REASONING, onWebRetrieval });

      expect(onWebRetrieval).toHaveBeenCalledTimes(1);
      expect(onWebRetrieval.mock.calls[0][0]).toMatchObject({
        web_tools: 'on',
        searches: 1,
        pages_opened: 1,
        pages: ['https://www.nfl.com/games/jets-at-patriots-2026-reg-6'],
        queries: ['jets patriots final score'],
        page_errors_reported: false,
      });
      // The listener is ours, not OpenAI's: it never reaches the request body.
      expect(mockResponsesCreate.mock.calls[0][0]).not.toHaveProperty('onWebRetrieval');
    });

    test('onWebRetrieval hears "off" with the reason when web search failed, and nothing without a URL', async () => {
      mockResponsesCreate.mockRejectedValueOnce(Object.assign(new Error('400 Unsupported parameter'), { status: 400 }));
      const onWebRetrieval = jest.fn();

      await provider.generateResponse(LINK_PROMPT, 'gpt-5.4', { ...REASONING, onWebRetrieval });
      expect(onWebRetrieval).toHaveBeenCalledWith(expect.objectContaining({ web_tools: 'off', error: '400 Unsupported parameter' }));

      onWebRetrieval.mockClear();
      await provider.generateResponse('Write a haiku', 'gpt-5.4', { ...REASONING, onWebRetrieval });
      expect(onWebRetrieval).not.toHaveBeenCalled();
      expect(mockOpenAICreate.mock.calls[mockOpenAICreate.mock.calls.length - 1][0]).not.toHaveProperty('onWebRetrieval');
    });

    test('responsesOutputText reads message items when output_text is absent', () => {
      expect(responsesOutputText({
        output: [
          { type: 'web_search_call', action: { type: 'open_page' } },
          { type: 'message', content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }] },
        ],
      })).toBe('ab');
      expect(responsesOutputText({ output: [] })).toBe('');
    });
  });
});
