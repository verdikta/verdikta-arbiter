/**
 * Code mode's provider calls (design §10.3, §10.4, §11): every panel and pool
 * model id resolves in the factory, and each provider honours the code-mode
 * controls (abort signal, the envelope's output tokens, effort high, no web).
 * Transports are mocked; nothing leaves the process.
 */
import { codeReview } from '@verdikta/common';
import { ChatAnthropic } from '@langchain/anthropic';
import { LLMFactory } from '../../../lib/llm/llm-factory';
import { AnthropicProvider } from '../../../lib/llm/anthropic-provider';
import { OpenAIProvider } from '../../../lib/llm/openai-provider';
import { OpenRouterProvider } from '../../../lib/llm/openrouter-provider';
import { XAIProvider } from '../../../lib/llm/xai-provider';
import { HyperbolicProvider } from '../../../lib/llm/hyperbolic-provider';

jest.mock('@langchain/anthropic', () => ({
  ChatAnthropic: jest.fn().mockImplementation(() => ({
    invoke: jest.fn().mockResolvedValue({ content: '{"score":[1000000,0,0,0,0,0],"justification":"ok"}' }),
  })),
}));

const mockCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })),
  default: jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })),
}));

const MockedChatAnthropic = ChatAnthropic as unknown as jest.Mock;
const env = process.env as Record<string, string | undefined>;
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'AI_GATEWAY', 'AI_WEB_ACCESS'];
const saved: Record<string, string | undefined> = {};

const chatReply = (content: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
  text: async () => content,
});

function codeOptions(signal: AbortSignal = new AbortController().signal) {
  return { webAccess: false, signal, maxTokens: 8000, effort: 'high' as const };
}

beforeEach(() => {
  KEYS.forEach(key => { saved[key] = env[key]; });
  env.ANTHROPIC_API_KEY = 'test-anthropic';
  env.OPENAI_API_KEY = 'test-openai';
  env.XAI_API_KEY = 'test-xai';
  env.OPENROUTER_API_KEY = 'test-openrouter';
  delete env.AI_GATEWAY;
  delete env.AI_WEB_ACCESS;
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({ choices: [{ message: { content: '{"score":[1000000,0,0,0,0,0],"justification":"ok"}' } }] });
  global.fetch = jest.fn().mockResolvedValue(chatReply('{"score":[1000000,0,0,0,0,0],"justification":"ok"}')) as any;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  // process.env turns undefined into the string "undefined": delete instead
  KEYS.forEach(key => { if (saved[key] === undefined) delete env[key]; else env[key] = saved[key]; });
  jest.restoreAllMocks();
});

const EXPECTED_CLASS: Record<string, any> = {
  anthropic: AnthropicProvider,
  openai: OpenAIProvider,
  xai: XAIProvider,
  openrouter: OpenRouterProvider,
};

/** The model id the transport was asked for, after one call through the provider. */
function sentModel(provider: string): string {
  if (provider === 'anthropic') return MockedChatAnthropic.mock.calls[0][0].modelName;
  if (provider === 'openai') return mockCreate.mock.calls[0][0].model;
  return JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).model;
}

const panelEntries = [codeReview.CODE_STANDARD_PANEL, codeReview.CODE_STANDARD_DISPUTE_PANEL]
  .flatMap(panel => panel.AI_NODES.map(node => ({ provider: node.AI_PROVIDER, model: node.AI_MODEL })));
const poolEntries = codeReview.CODE_CLASSES['code-premium'].models.map(entry => ({ ...entry }));

describe('every panel model id resolves in llm-factory (mocked providers)', () => {
  test.each(panelEntries)('panel juror $provider $model', async ({ provider, model }) => {
    const llm = await LLMFactory.getProvider(provider);
    expect(llm).toBeInstanceOf(EXPECTED_CLASS[provider]);
    await (llm as any).generateResponse('Score array MUST contain exactly 6 integers', model, codeOptions());
    expect(sentModel(provider)).toBe(model);
  }, 10000);

  test.each(poolEntries)('pool model $provider $model', async ({ provider, model }) => {
    const llm = await LLMFactory.getProvider(provider);
    expect(llm).toBeInstanceOf(EXPECTED_CLASS[provider]);
    await (llm as any).generateResponse('prompt', model, codeOptions());
    expect(sentModel(provider)).toBe(model);
  }, 10000);

  test('without native keys the Claude 5.5 ids reach OpenRouter under its dot names', async () => {
    delete env.ANTHROPIC_API_KEY;
    const llm = await LLMFactory.getProvider('anthropic');
    expect(llm).toBeInstanceOf(OpenRouterProvider);
    for (const [native, routed] of [
      ['claude-sonnet-5-5', 'anthropic/claude-sonnet-5.5'],
      ['claude-haiku-5-5', 'anthropic/claude-haiku-5.5'],
      ['claude-opus-5-5', 'anthropic/claude-opus-5.5'],
    ]) {
      (global.fetch as jest.Mock).mockClear();
      await (llm as any).generateResponse('prompt', native, codeOptions());
      expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).model).toBe(routed);
    }
  }, 10000);
});

describe('code-mode controls reach each provider', () => {
  test('Anthropic: abort signal, the envelope\'s max tokens, effort high with adaptive thinking, no sampling parameters', async () => {
    const controller = new AbortController();
    const provider = new AnthropicProvider('test-anthropic');
    await provider.generateResponse('prompt with https://example.com', 'claude-sonnet-5-5', codeOptions(controller.signal));
    const fields = MockedChatAnthropic.mock.calls[0][0];
    expect(fields.maxTokens).toBe(8000);
    expect(fields.temperature).toBeUndefined();
    expect(fields.invocationKwargs).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    const invoke = MockedChatAnthropic.mock.results[0].value.invoke as jest.Mock;
    expect(invoke).toHaveBeenCalledWith('prompt with https://example.com', { signal: controller.signal });
  }, 5000);

  test('Anthropic: aborting the signal rejects the pending call', async () => {
    MockedChatAnthropic.mockImplementationOnce(() => ({
      invoke: jest.fn((_input: unknown, options: { signal: AbortSignal }) => new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('AbortError: request aborted')));
      })),
    }));
    const controller = new AbortController();
    const pending = new AnthropicProvider('test-anthropic').generateResponse('p', 'claude-sonnet-5-5', codeOptions(controller.signal));
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  }, 5000);

  test('Anthropic text mode is unchanged: no signal, no effort, the model\'s own parameters', async () => {
    const provider = new AnthropicProvider('test-anthropic');
    await provider.generateResponse('prompt', 'claude-sonnet-5', { webAccess: false });
    expect(MockedChatAnthropic.mock.calls[0][0]).toEqual({ anthropicApiKey: 'test-anthropic', modelName: 'claude-sonnet-5', maxTokens: 8192 });
    const invoke = MockedChatAnthropic.mock.results[0].value.invoke as jest.Mock;
    expect(invoke.mock.calls[0]).toEqual(['prompt']);
  }, 5000);

  test('OpenAI: native client with max_completion_tokens from the envelope, reasoning_effort high and the signal', async () => {
    const controller = new AbortController();
    await new OpenAIProvider('test-openai').generateResponse('prompt', 'gpt-6-sol', codeOptions(controller.signal));
    const [body, requestOptions] = mockCreate.mock.calls[0];
    expect(body).toMatchObject({ model: 'gpt-6-sol', max_completion_tokens: 8000, reasoning_effort: 'high' });
    expect(requestOptions).toEqual({ signal: controller.signal });
  }, 5000);

  test('OpenRouter: max_tokens from the envelope, reasoning effort high, and the caller\'s signal governs the request', async () => {
    const controller = new AbortController();
    await new OpenRouterProvider(undefined, '').generateResponse('prompt', 'deepseek/deepseek-v4-pro-0813', codeOptions(controller.signal));
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBe(8000);
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(init.signal).toBe(controller.signal);
  }, 5000);

  test('OpenRouter: an aborted call is reported as aborted, not as the 120 s text-mode timeout', async () => {
    (global.fetch as jest.Mock).mockImplementationOnce((_url: string, init: { signal: AbortSignal }) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
    }));
    const controller = new AbortController();
    const pending = new OpenRouterProvider(undefined, '').generateResponse('p', 'deepseek/deepseek-v4-pro-0813', codeOptions(controller.signal));
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
    await expect(pending).rejects.not.toThrow(/timed out after/);
  }, 5000);

  test('OpenAI: a code-mode justifier on a non-reasoning model sends the signal but no reasoning_effort', async () => {
    const controller = new AbortController();
    await new OpenAIProvider('test-openai').generateResponse('prompt', 'gpt-4o', { webAccess: false, signal: controller.signal });
    const [body, requestOptions] = mockCreate.mock.calls[0];
    expect(body.reasoning_effort).toBeUndefined();
    expect(requestOptions).toEqual({ signal: controller.signal });
  }, 5000);

  test('OpenAI text mode is unchanged: gpt-5 keeps reasoning_effort medium and one argument to create', async () => {
    await new OpenAIProvider('test-openai').generateResponse('prompt', 'gpt-5', { webAccess: false });
    expect(mockCreate.mock.calls[0]).toHaveLength(1);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ reasoning_effort: 'medium', max_completion_tokens: 16000 });
  }, 5000);

  test('Hyperbolic (a possible justifier): the caller\'s signal reaches fetch', async () => {
    env.HYPERBOLIC_API_KEY = 'test-hyperbolic';
    const controller = new AbortController();
    await new HyperbolicProvider().generateResponse('prompt', 'deepseek-ai/DeepSeek-R1', { signal: controller.signal });
    expect((global.fetch as jest.Mock).mock.calls[0][1].signal).toBe(controller.signal);
    delete env.HYPERBOLIC_API_KEY;
  }, 5000);

  test('xAI: max_tokens from the envelope and the caller\'s signal', async () => {
    const controller = new AbortController();
    await new XAIProvider().generateResponse('prompt', 'grok-4.7', codeOptions(controller.signal));
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body).max_tokens).toBe(8000);
    expect(init.signal).toBe(controller.signal);
  }, 5000);
});
