import { OpenRouterProvider } from '../../../lib/llm/openrouter-provider';
import { resolveOpenRouterModelId } from '../../../config/openrouter-models';

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

  test('resolves xAI model names through mapping', async () => {
    mockFetchSuccess();

    const provider = new OpenRouterProvider(undefined, 'x-ai');
    await provider.generateResponse('hello', 'grok-4-1-fast-reasoning');

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.model).toBe('x-ai/grok-4.1-fast');
  });

  test('resolves Hyperbolic model names with slashes through mapping', async () => {
    mockFetchSuccess();

    const provider = new OpenRouterProvider(undefined, 'meta-llama');
    await provider.generateResponse('hello', 'deepseek-ai/DeepSeek-R1');

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.model).toBe('deepseek/deepseek-r1');
  });
});

describe('resolveOpenRouterModelId', () => {
  test('OpenAI softlinked names get simple prefix', () => {
    expect(resolveOpenRouterModelId('openai', 'gpt-5.2')).toBe('openai/gpt-5.2');
    expect(resolveOpenRouterModelId('openai', 'gpt-5-mini')).toBe('openai/gpt-5-mini');
    expect(resolveOpenRouterModelId('openai', 'gpt-5-nano')).toBe('openai/gpt-5-nano');
  });

  test('Anthropic softlinked names get simple prefix', () => {
    expect(resolveOpenRouterModelId('anthropic', 'claude-sonnet-4.5')).toBe('anthropic/claude-sonnet-4.5');
    expect(resolveOpenRouterModelId('anthropic', 'claude-haiku-4.5')).toBe('anthropic/claude-haiku-4.5');
    expect(resolveOpenRouterModelId('anthropic', 'claude-3.7-sonnet')).toBe('anthropic/claude-3.7-sonnet');
  });

  test('legacy OpenAI date-suffixed names map to softlinked OpenRouter IDs', () => {
    expect(resolveOpenRouterModelId('openai', 'gpt-5.2-2025-12-11')).toBe('openai/gpt-5.2');
    expect(resolveOpenRouterModelId('openai', 'gpt-5-2025-08-07')).toBe('openai/gpt-5');
    expect(resolveOpenRouterModelId('openai', 'gpt-5-mini-2025-08-07')).toBe('openai/gpt-5-mini');
    expect(resolveOpenRouterModelId('openai', 'gpt-5-nano-2025-08-07')).toBe('openai/gpt-5-nano');
    expect(resolveOpenRouterModelId('openai', 'gpt-5.1-2025-11-13')).toBe('openai/gpt-5.1');
    expect(resolveOpenRouterModelId('openai', 'gpt-5.1-codex-2025-11-13')).toBe('openai/gpt-5.1-codex');
    expect(resolveOpenRouterModelId('openai', 'gpt-5.1-codex-mini-2025-11-13')).toBe('openai/gpt-5.1-codex-mini');
  });

  test('legacy Anthropic hyphenated date-suffixed names map to OpenRouter dot-notation', () => {
    expect(resolveOpenRouterModelId('anthropic', 'claude-sonnet-4-5-20250929')).toBe('anthropic/claude-sonnet-4.5');
    expect(resolveOpenRouterModelId('anthropic', 'claude-haiku-4-5-20251001')).toBe('anthropic/claude-haiku-4.5');
    expect(resolveOpenRouterModelId('anthropic', 'claude-sonnet-4-20250514')).toBe('anthropic/claude-sonnet-4');
    expect(resolveOpenRouterModelId('anthropic', 'claude-3-7-sonnet-20250219')).toBe('anthropic/claude-3.7-sonnet');
    expect(resolveOpenRouterModelId('anthropic', 'claude-3-5-sonnet-20241022')).toBe('anthropic/claude-3.5-sonnet');
  });

  test('unknown date-suffixed model strips date as fallback', () => {
    expect(resolveOpenRouterModelId('openai', 'gpt-99-2030-01-01')).toBe('openai/gpt-99');
  });

  test('xAI reasoning models map to OpenRouter dot notation', () => {
    expect(resolveOpenRouterModelId('x-ai', 'grok-4-1-fast-reasoning')).toBe('x-ai/grok-4.1-fast');
    expect(resolveOpenRouterModelId('x-ai', 'grok-4-1-fast-non-reasoning')).toBe('x-ai/grok-4.1-fast');
  });

  test('xAI non-fast models map correctly', () => {
    expect(resolveOpenRouterModelId('x-ai', 'grok-4-fast-reasoning')).toBe('x-ai/grok-4-fast');
    expect(resolveOpenRouterModelId('x-ai', 'grok-4-fast-non-reasoning')).toBe('x-ai/grok-4-fast');
    expect(resolveOpenRouterModelId('x-ai', 'grok-4-0709')).toBe('x-ai/grok-4');
    expect(resolveOpenRouterModelId('x-ai', 'grok-code-fast-1')).toBe('x-ai/grok-code-fast-1');
  });

  test('Hyperbolic models with slashes use direct mapping', () => {
    expect(resolveOpenRouterModelId('meta-llama', 'deepseek-ai/DeepSeek-R1')).toBe('deepseek/deepseek-r1');
    expect(resolveOpenRouterModelId('meta-llama', 'Qwen/Qwen3-235B-A22B-Instruct-2507')).toBe('qwen/qwen3-235b-a22b');
    expect(resolveOpenRouterModelId('meta-llama', 'moonshotai/Kimi-K2-Instruct')).toBe('moonshotai/kimi-k2');
  });

  test('unknown model with slash falls back to lowercase', () => {
    expect(resolveOpenRouterModelId('meta-llama', 'SomeOrg/SomeModel')).toBe('someorg/somemodel');
  });

  test('model already containing full OpenRouter ID passes through', () => {
    expect(resolveOpenRouterModelId('openai', 'openai/gpt-4o')).toBe('openai/gpt-4o');
  });

  test('openrouter provider with empty prefix passes full model IDs through', () => {
    expect(resolveOpenRouterModelId('', 'deepseek/deepseek-v3.2')).toBe('deepseek/deepseek-v3.2');
    expect(resolveOpenRouterModelId('', 'xiaomi/mimo-v2-pro')).toBe('xiaomi/mimo-v2-pro');
    expect(resolveOpenRouterModelId('', 'xiaomi/mimo-v2-omni')).toBe('xiaomi/mimo-v2-omni');
  });
});
