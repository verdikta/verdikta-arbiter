/**
 * The deterministic mock provider: test-only, refused in production builds.
 */
import { LLMFactory } from '../../../lib/llm/llm-factory';
import {
  MOCK_PROVIDER_FLAG,
  MOCK_SCRIPT_ENV,
  MockProvider,
  mockProviderCalls,
  mockProviderState,
  resetMockProvider,
} from '../../../lib/llm/mock-provider';

const env = process.env as Record<string, string | undefined>;
const saved = { flag: env[MOCK_PROVIDER_FLAG], script: env[MOCK_SCRIPT_ENV], nodeEnv: env.NODE_ENV };

afterEach(() => {
  env[MOCK_PROVIDER_FLAG] = saved.flag;
  env[MOCK_SCRIPT_ENV] = saved.script;
  env.NODE_ENV = saved.nodeEnv;
  resetMockProvider();
  jest.useRealTimers();
});

const SCORE_PROMPT = 'Your score array MUST contain exactly 6 integers, in this order.';

describe('mock provider (test-only)', () => {
  test('is off without the test-only flag: "mock" is an unknown provider', async () => {
    delete env[MOCK_PROVIDER_FLAG];
    expect(mockProviderState()).toBe('off');
    await expect(LLMFactory.getProvider('mock')).rejects.toThrow(/Unknown provider/);
  }, 5000);

  test('with the flag (outside production) every provider name resolves to the mock', async () => {
    env[MOCK_PROVIDER_FLAG] = '1';
    expect(mockProviderState()).toBe('on');
    for (const name of ['mock', 'anthropic', 'openrouter', 'OpenAI', 'xai']) {
      expect(await LLMFactory.getProvider(name)).toBeInstanceOf(MockProvider);
    }
  }, 5000);

  test('is refused in production builds even with the flag set', async () => {
    env[MOCK_PROVIDER_FLAG] = '1';
    env.NODE_ENV = 'production';
    expect(mockProviderState()).toBe('refused');
    await expect(LLMFactory.getProvider('anthropic')).rejects.toThrow(/refused in production/);
    await expect(LLMFactory.getProvider('mock')).rejects.toThrow(/refused in production/);
  }, 5000);

  test('is deterministic: the same model and prompt give the same reply', async () => {
    env[MOCK_PROVIDER_FLAG] = '1';
    const provider = new MockProvider('anthropic');
    const a = await provider.generateResponse(SCORE_PROMPT, 'claude-sonnet-5-5');
    const b = await provider.generateResponse(SCORE_PROMPT, 'claude-sonnet-5-5');
    expect(a).toBe(b);
    const parsed = JSON.parse(a);
    expect(parsed.score).toHaveLength(6);
    expect(parsed.score.reduce((s: number, v: number) => s + v, 0)).toBe(1000000);
  }, 5000);

  test('follows a script: scores, delay, error with status, raw reply and a per-call sequence', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    env[MOCK_PROVIDER_FLAG] = '1';
    env[MOCK_SCRIPT_ENV] = JSON.stringify({
      'juror-a': { scores: [0, 0, 0, 0, 1000000, 0], justification: 'scripted', delayMs: 2000 },
      'juror-b': { error: 'simulated overload', status: 529 },
      'juror-c': [{ reply: 'prose, no JSON' }, { reply: '{"score": [1, 0, 0, 0, 0, 0]}' }],
    });
    const provider = new MockProvider('anthropic');

    const pending = provider.generateResponse(SCORE_PROMPT, 'juror-a');
    let done = false;
    pending.then(() => { done = true; });
    await jest.advanceTimersByTimeAsync(1999);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(JSON.parse(await pending)).toEqual({ score: [0, 0, 0, 0, 1000000, 0], justification: 'scripted' });

    await expect(provider.generateResponse(SCORE_PROMPT, 'juror-b')).rejects.toMatchObject({ message: 'simulated overload', status: 529 });

    expect(await provider.generateResponse(SCORE_PROMPT, 'juror-c')).toBe('prose, no JSON');
    expect(await provider.generateResponse(SCORE_PROMPT, 'juror-c')).toBe('{"score": [1, 0, 0, 0, 0, 0]}');
  }, 10000);

  test('an abort rejects a hanging call at once and is recorded', async () => {
    env[MOCK_PROVIDER_FLAG] = '1';
    env[MOCK_SCRIPT_ENV] = JSON.stringify({ hangs: { hang: true } });
    const provider = new MockProvider('openrouter');
    const controller = new AbortController();
    const pending = provider.generateResponse(SCORE_PROMPT, 'hangs', { signal: controller.signal, maxTokens: 8000, effort: 'high', webAccess: false });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
    const [call] = mockProviderCalls();
    expect(call).toMatchObject({ provider: 'openrouter', model: 'hangs', outcome: 'aborted' });
    expect(call.options).toEqual({ webAccess: false, maxTokens: 8000, effort: 'high', signal: true });
  }, 5000);
});
