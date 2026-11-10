/**
 * @jest-environment node
 *
 * The Q63 jurors on every route the AI Gateway can give them (owner decision, 2026-11-09;
 * design §10.4): evaluation `google/gemini-4-argon` + `gpt-6-luna`, dispute
 * `claude-opus-5-5` + `google/gemini-4-argon`. The gateway sends a model to its native API
 * when the operator has that key and to OpenRouter otherwise, so arbiters answering one
 * claim can reach one juror by different routes. If the routes sent different effort,
 * output limits or sampling settings, nothing would fail: the arbiters would just
 * disagree. The panels were measured with every non-Anthropic juror through OpenRouter
 * (reasoning effort high, max_tokens 32000, no sampling parameter) and Anthropic models
 * direct (adaptive thinking, output_config.effort high, 32000 output tokens).
 *
 * Each juror runs here as code mode runs it (runCodeJury), through its real client (the
 * openai SDK, LangChain's ChatAnthropic over @anthropic-ai/sdk, OpenRouter's fetch) against
 * a stub on 127.0.0.1 with throwaway keys. No request leaves this machine. The model ids are
 * written out, not read from @verdikta/common: the installed release still has the old
 * panels, and these arrive with 1.9.0-attest.4.
 */
import http from 'http';
import type { AddressInfo, Socket } from 'net';
import { runCodeJury } from '../../../lib/code-review/jury';
import { LLMFactory } from '../../../lib/llm/llm-factory';
import { OpenAIProvider } from '../../../lib/llm/openai-provider';
import { OpenRouterProvider } from '../../../lib/llm/openrouter-provider';
import { AnthropicProvider } from '../../../lib/llm/anthropic-provider';
import { gptMajorVersion, isGpt5FamilyModel } from '../../../lib/llm/openai-model-family';

/** code-standard's envelope: the juror output the handler passes as maxTokens (owner decision Q52). */
const CLASS_OUTPUT_TOKENS = 32000;
const OUTCOMES = ['A', 'B', 'C', 'D', 'E', 'F'];
const SCORES = [50000, 100000, 150000, 200000, 0, 500000];
const ANSWER = JSON.stringify({ score: SCORES, justification: 'the juror\'s reasons' });
const PROMPT = 'the claim, hash-fenced';
/** What no route may send: the panels were measured without any. */
const SAMPLING = ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'min_p', 'top_a', 'seed'];

type Route = 'native' | 'openrouter';
type ReplyForm = 'bare' | 'fenced';

interface Seen {
  /** openai, openrouter or anthropic: the base URL the request was sent to. */
  api: string;
  path: string;
  body: any;
  /** The client's own timeout, as the openai and Anthropic SDKs report it (whole seconds). */
  timeoutSeconds: number | null;
}

let server: http.Server;
let seen: Seen[] = [];
let replyForm: ReplyForm = 'bare';
const sockets = new Set<Socket>();
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CLASS_PROVIDER', 'ANTHROPIC_CLASS_MODEL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_CLASS_PROVIDER', 'OPENAI_CLASS_MODEL',
  'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL',
  'XAI_API_KEY', 'GROK_API_KEY', 'XAI_CLASS_PROVIDER',
  'AI_GATEWAY', 'AI_WEB_ACCESS', 'JUSTIFIER_MODEL', 'VERDIKTA_TEST_MOCK_PROVIDER', 'REASONING_MODEL_MAX_TOKENS', 'DEFAULT_MAX_TOKENS',
];
let stub = '';

const answerText = () => (replyForm === 'fenced' ? `\`\`\`json\n${ANSWER}\n\`\`\`` : ANSWER);

/** Each API's own reply shape, with the reasoning each returns beside the answer. */
function reply(api: string): string {
  if (api === 'anthropic') {
    // Adaptive thinking: a thinking block first, then the answer.
    return JSON.stringify({
      id: 'msg_stub', type: 'message', role: 'assistant', model: 'stub',
      content: [
        { type: 'thinking', thinking: 'weighing the gates and the report', signature: 'c2ln' },
        { type: 'text', text: answerText() },
      ],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }
  const message: any = { role: 'assistant', content: answerText() };
  // OpenRouter returns a reasoning model's thinking beside the content, never in it.
  if (api === 'openrouter') {
    message.reasoning = 'weighing the gates and the report';
    message.reasoning_details = [{ type: 'reasoning.text', text: 'weighing the gates and the report' }];
  }
  return JSON.stringify({
    id: 'chatcmpl-stub', object: 'chat.completion', model: 'stub',
    choices: [{ index: 0, message, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const url = req.url || '';
      const api = url.split('/')[1];
      const header = req.headers['x-stainless-timeout'];
      seen.push({ api, path: url, body: JSON.parse(raw), timeoutSeconds: header === undefined ? null : Number(header) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(reply(api));
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  stub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterAll(async () => {
  sockets.forEach(socket => socket.destroy());
  await new Promise(resolve => server.close(resolve));
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** Every key, so each class goes to its native API (the gateway's native-first default). */
function nativeKeys() {
  process.env.OPENAI_API_KEY = 'stub-key';
  process.env.OPENAI_BASE_URL = `${stub}/openai`;
  process.env.ANTHROPIC_API_KEY = 'stub-key';
  process.env.ANTHROPIC_BASE_URL = `${stub}/anthropic`;
  process.env.OPENROUTER_API_KEY = 'stub-key';
  process.env.OPENROUTER_BASE_URL = `${stub}/openrouter`;
}

beforeEach(() => {
  seen = [];
  replyForm = 'bare';
  for (const key of ENV_KEYS) delete process.env[key];
  nativeKeys();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Send `provider`'s class to OpenRouter, as the gateway does when the operator has no native key. */
function routeTo(route: Route, provider: string) {
  if (route === 'native') return;
  if (provider === 'openai') delete process.env.OPENAI_API_KEY;
  if (provider === 'anthropic') delete process.env.ANTHROPIC_API_KEY;
}

/** One juror, as askJuror calls it: the envelope's output, effort high, a deadline, web off. */
async function judge(provider: string, model: string) {
  const outcome = await runCodeJury({
    jurors: [{ provider, model, weight: 1 }],
    prompt: PROMPT,
    outcomes: OUTCOMES,
    maxTokens: CLASS_OUTPUT_TOKENS,
    juryDeadlineAt: Date.now() + 20000,
  });
  expect(seen).toHaveLength(1);
  return { outcome, request: seen[0] };
}

/** What a route sends, in one shape: the effort, the output limit and any sampling parameter. */
function settings(request: Seen) {
  const body = request.body;
  const sampling = SAMPLING.filter(name => body[name] !== undefined);
  if (request.api === 'openai') {
    return { maxOutputTokens: body.max_completion_tokens, effort: body.reasoning_effort, sampling, thinking: 'model' };
  }
  if (request.api === 'anthropic') {
    return { maxOutputTokens: body.max_tokens, effort: body.output_config?.effort, sampling, thinking: body.thinking?.type };
  }
  // OpenRouter's unified reasoning parameter: on OpenAI and Gemini models it is the model's own
  // reasoning effort, and on Claude 4.6 and later it is output_config.effort with adaptive thinking.
  return { maxOutputTokens: body.max_tokens, effort: body.reasoning?.effort, sampling, thinking: body.model.startsWith('anthropic/') ? 'adaptive' : 'model' };
}

const OPENROUTER_BODY = (model: string) => ({
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
  stream: false,
  max_tokens: CLASS_OUTPUT_TOKENS,
  reasoning: { effort: 'high' },
});

describe('gpt-6-luna (openai)', () => {
  test('natively: max_completion_tokens 32000, reasoning_effort high, nothing else', async () => {
    const { outcome, request } = await judge('openai', 'gpt-6-luna');
    expect(outcome.kind).toBe('ok');
    expect(request.api).toBe('openai');
    expect(request.path).toBe('/openai/chat/completions');
    expect(request.body).toEqual({
      model: 'gpt-6-luna',
      messages: [{ role: 'user', content: PROMPT }],
      max_completion_tokens: CLASS_OUTPUT_TOKENS,
      reasoning_effort: 'high',
    });
  });

  test('through the OpenRouter fallback: openai/gpt-6-luna, max_tokens 32000, reasoning.effort high, nothing else', async () => {
    routeTo('openrouter', 'openai');
    const { outcome, request } = await judge('openai', 'gpt-6-luna');
    expect(outcome.kind).toBe('ok');
    expect(request.path).toBe('/openrouter/chat/completions');
    expect(request.body).toEqual(OPENROUTER_BODY('openai/gpt-6-luna'));
  });

  test('an operator\'s OPENAI_CLASS_PROVIDER=openrouter sends the same request as the fallback', async () => {
    process.env.OPENAI_CLASS_PROVIDER = 'openrouter';
    const { request } = await judge('openai', 'gpt-6-luna');
    expect(request.path).toBe('/openrouter/chat/completions');
    expect(request.body).toEqual(OPENROUTER_BODY('openai/gpt-6-luna'));
  });
});

describe('google/gemini-4-argon (openrouter, its only route)', () => {
  test('max_tokens 32000, reasoning.effort high, nothing else', async () => {
    const { outcome, request } = await judge('openrouter', 'google/gemini-4-argon');
    expect(outcome.kind).toBe('ok');
    expect(request.path).toBe('/openrouter/chat/completions');
    expect(request.body).toEqual(OPENROUTER_BODY('google/gemini-4-argon'));
  });

  test('AI_GATEWAY=native changes nothing: the openrouter class has no native API', async () => {
    process.env.AI_GATEWAY = 'native';
    const { request } = await judge('openrouter', 'google/gemini-4-argon');
    expect(request.path).toBe('/openrouter/chat/completions');
    expect(request.body).toEqual(OPENROUTER_BODY('google/gemini-4-argon'));
  });

  test('without OPENROUTER_API_KEY it has no route: the juror fails and nothing is sent', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const outcome = await runCodeJury({
      jurors: [{ provider: 'openrouter', model: 'google/gemini-4-argon', weight: 1 }],
      prompt: PROMPT,
      outcomes: OUTCOMES,
      maxTokens: CLASS_OUTPUT_TOKENS,
      juryDeadlineAt: Date.now() + 20000,
    });
    expect(outcome.kind).toBe('failed');
    expect(outcome.results[0].error_message).toMatch(/OPENROUTER_API_KEY not configured/);
    expect(seen).toHaveLength(0);
  });
});

describe('claude-opus-5-5 (anthropic)', () => {
  test('natively: adaptive thinking, effort high, 32000 output tokens, the client\'s own timeout, nothing else', async () => {
    const { outcome, request } = await judge('anthropic', 'claude-opus-5-5');
    expect(outcome.kind).toBe('ok');
    expect(request.path).toBe('/anthropic/v1/messages');
    expect(request.body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: CLASS_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: PROMPT }],
      stream: false,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
    // The SDK refuses 32000 tokens without one (anthropic-sdk-limit.test.ts): the time left.
    expect(request.timeoutSeconds).toBeLessThanOrEqual(20);
    expect(request.timeoutSeconds).toBeGreaterThanOrEqual(15);
  });

  test('through the OpenRouter fallback: anthropic/claude-opus-5.5, max_tokens 32000, reasoning.effort high, nothing else', async () => {
    routeTo('openrouter', 'anthropic');
    const { outcome, request } = await judge('anthropic', 'claude-opus-5-5');
    expect(outcome.kind).toBe('ok');
    expect(request.path).toBe('/openrouter/chat/completions');
    expect(request.body).toEqual(OPENROUTER_BODY('anthropic/claude-opus-5.5'));
  });
});

const JURORS: Array<[string, string, Route[]]> = [
  ['openai', 'gpt-6-luna', ['native', 'openrouter']],
  ['openrouter', 'google/gemini-4-argon', ['openrouter']],
  ['anthropic', 'claude-opus-5-5', ['native', 'openrouter']],
];

describe('every route of a juror sends the same settings, and its reply gives the same scores', () => {
  test.each(JURORS)('%s %s', async (provider, model, routes) => {
    const results: Array<{ route: Route; form: ReplyForm; settings: ReturnType<typeof settings>; vector?: number[]; justification?: string }> = [];
    for (const route of routes) {
      for (const form of ['bare', 'fenced'] as ReplyForm[]) {
        for (const key of ENV_KEYS) delete process.env[key];
        nativeKeys();
        routeTo(route, provider);
        seen = [];
        replyForm = form;
        const { outcome, request } = await judge(provider, model);
        expect(outcome.kind).toBe('ok');
        results.push({ route, form, settings: settings(request), vector: outcome.results[0].vector, justification: outcome.results[0].justification });
      }
    }
    for (const result of results) {
      expect(result.settings).toEqual({ maxOutputTokens: CLASS_OUTPUT_TOKENS, effort: 'high', sampling: [], thinking: results[0].settings.thinking });
      expect(result.vector).toEqual(SCORES);
      expect(result.justification).toBe('the juror\'s reasons');
    }
  });
});

describe('the gateway\'s OpenRouter id for each new juror', () => {
  test.each([
    ['openai', 'gpt-6-luna', 'openai/gpt-6-luna'],
    ['anthropic', 'claude-opus-5-5', 'anthropic/claude-opus-5.5'],
    ['openrouter', 'google/gemini-4-argon', 'google/gemini-4-argon'],
  ])('%s %s goes to OpenRouter as %s', async (provider, model, routed) => {
    process.env.AI_GATEWAY = 'openrouter';
    const llm = await LLMFactory.getProvider(provider);
    expect(llm).toBeInstanceOf(OpenRouterProvider);
    await (llm as any).generateResponse(PROMPT, model, { webAccess: false, maxTokens: CLASS_OUTPUT_TOKENS, effort: 'high', signal: new AbortController().signal });
    expect(seen.map(s => s.body.model)).toEqual([routed]);
  });

  test('with their native keys the factory hands openai and anthropic to their own providers', async () => {
    expect(await LLMFactory.getProvider('openai')).toBeInstanceOf(OpenAIProvider);
    expect(await LLMFactory.getProvider('anthropic')).toBeInstanceOf(AnthropicProvider);
    expect(await LLMFactory.getProvider('openrouter')).toBeInstanceOf(OpenRouterProvider);
  });
});

describe('GPT-6 ids are read as reasoning models, as GPT-5 ids are', () => {
  test('the family rule', () => {
    for (const id of ['gpt-6-luna', 'openai/gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'GPT-6-Luna', 'ft:gpt-6-luna:org', 'gpt-5', 'gpt-5.1-codex', 'gpt-5-mini-2025-08-07', 'gpt-5.6-terra', 'openai/gpt-5.2']) {
      expect([id, isGpt5FamilyModel(id)]).toEqual([id, true]);
    }
    for (const id of ['gpt-4o', 'gpt-4.1-mini', 'gpt-3.5-turbo', 'gpt-oss-120b', 'openai/gpt-oss-120b', 'o3', 'claude-opus-5-5', 'google/gemini-4-argon', '']) {
      expect([id, isGpt5FamilyModel(id)]).toEqual([id, false]);
    }
    expect(gptMajorVersion('gpt-6-luna')).toBe(6);
    expect(gptMajorVersion('gpt-4o')).toBeNull();
  });

  test('in text mode OpenRouter gives openai/gpt-6-luna a reasoning model\'s output, as it does GPT-5', async () => {
    // Text mode passes no envelope: the default ceiling is chosen by the model id.
    for (const model of ['openai/gpt-5.2', 'openai/gpt-6-luna', 'openai/gpt-6-sol']) {
      await new OpenRouterProvider(undefined, '').generateResponse(PROMPT, model);
    }
    expect(seen.map(s => [s.body.model, s.body.max_tokens])).toEqual([
      ['openai/gpt-5.2', 16000],
      ['openai/gpt-6-luna', 16000],
      ['openai/gpt-6-sol', 16000],
    ]);
  });
});
