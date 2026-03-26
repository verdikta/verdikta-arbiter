import { OpenRouterProvider } from '../../../lib/llm/openrouter-provider';

describe('OpenRouterProvider', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.OPENROUTER_API_KEY = 'or-test-key';
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
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok-from-openrouter' } }],
      }),
    });

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
});
