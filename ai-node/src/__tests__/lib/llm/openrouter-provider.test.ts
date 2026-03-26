import { OpenRouterProvider } from '../../../lib/llm/openrouter-provider';

function mockFetchSuccess(content: string = 'ok-from-openrouter') {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  });
}

describe('OpenRouterProvider', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    delete process.env.DEFAULT_MAX_TOKENS;
    delete process.env.REASONING_MODEL_MAX_TOKENS;
    delete process.env.MODEL_TIMEOUT_MS;
    // @ts-ignore
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('generateResponse sends OpenAI-compatible request', async () => {
    mockFetchSuccess();

    const provider = new OpenRouterProvider();
    const result = await provider.generateResponse('hello', 'openai/gpt-4o');

    expect(result).toBe('ok-from-openrouter');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain('openrouter.ai/api/v1/chat/completions');
    expect(init.headers.Authorization).toContain('Bearer or-test-key');
  });

  test('throws on non-ok response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    });

    const provider = new OpenRouterProvider();

    await expect(provider.generateResponse('hello', 'openai/gpt-4o')).rejects.toThrow('HTTP 401');
  });

  test('throws when OPENROUTER_API_KEY is not set', async () => {
    delete process.env.OPENROUTER_API_KEY;

    const provider = new OpenRouterProvider();

    await expect(provider.generateResponse('hello', 'openai/gpt-4o')).rejects.toThrow('OPENROUTER_API_KEY not configured');
  });

  test('uses default max_tokens of 4096 for non-reasoning models', async () => {
    mockFetchSuccess();

    const provider = new OpenRouterProvider();
    await provider.generateResponse('hello', 'openai/gpt-4o');

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.max_tokens).toBe(4096);
  });

  test('uses reasoning max_tokens for reasoning models', async () => {
    mockFetchSuccess();

    const provider = new OpenRouterProvider();
    await provider.generateResponse('hello', 'openai/gpt-5-turbo');

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.max_tokens).toBe(16000);
  });

  test('respects DEFAULT_MAX_TOKENS env var', async () => {
    process.env.DEFAULT_MAX_TOKENS = '8192';
    mockFetchSuccess();

    const provider = new OpenRouterProvider();
    await provider.generateResponse('hello', 'openai/gpt-4o');

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.max_tokens).toBe(8192);
  });

  test('normalizes model name with prefix when model lacks slash', async () => {
    mockFetchSuccess();

    const provider = new OpenRouterProvider(undefined, 'openai');
    await provider.generateResponse('hello', 'gpt-4o');

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.model).toBe('openai/gpt-4o');
  });

  test('does not double-prefix model name that already contains slash', async () => {
    mockFetchSuccess();

    const provider = new OpenRouterProvider(undefined, 'openai');
    await provider.generateResponse('hello', 'openai/gpt-4o');

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.model).toBe('openai/gpt-4o');
  });

  test('generateResponseWithImage includes image content block', async () => {
    mockFetchSuccess();

    const provider = new OpenRouterProvider();
    await provider.generateResponseWithImage('describe this', 'openai/gpt-4o', 'base64data', 'image/png');

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    const content = body.messages[0].content;
    expect(content).toHaveLength(2);
    expect(content[1].type).toBe('image_url');
    expect(content[1].image_url.url).toContain('data:image/png;base64,base64data');
  });

  test('generateResponseWithImage rejects unsupported image format', async () => {
    const provider = new OpenRouterProvider();

    await expect(
      provider.generateResponseWithImage('describe', 'openai/gpt-4o', 'data', 'image/bmp')
    ).rejects.toThrow('Unsupported image format');
  });

  test('generateResponseWithAttachments handles mixed image and text', async () => {
    mockFetchSuccess();

    const provider = new OpenRouterProvider();
    await provider.generateResponseWithAttachments('analyze', 'openai/gpt-4o', [
      { type: 'text', content: 'some text', mediaType: 'text/plain' },
      { type: 'image', content: 'imgdata', mediaType: 'image/jpeg' },
    ]);

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    const content = body.messages[0].content;
    expect(content).toHaveLength(3);
    expect(content[0].type).toBe('text');
    expect(content[1].type).toBe('text');
    expect(content[2].type).toBe('image_url');
  });

  test('request includes abort signal for timeout', async () => {
    mockFetchSuccess();

    const provider = new OpenRouterProvider();
    await provider.generateResponse('hello', 'openai/gpt-4o');

    const init = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(init.signal).toBeDefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('wraps AbortError as timeout error', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    (global.fetch as jest.Mock).mockRejectedValue(abortError);

    process.env.MODEL_TIMEOUT_MS = '100';
    const provider = new OpenRouterProvider();

    await expect(provider.generateResponse('hello', 'openai/gpt-4o')).rejects.toThrow('Request timed out');
  });
});
