/**
 * @jest-environment node
 *
 * The non-streaming limit of @anthropic-ai/sdk 0.71.2 (nested under
 * @langchain/anthropic), against the real client. Nothing here mocks ChatAnthropic
 * or the SDK: the limit lives inside the SDK, so a mock could not show it. A stub on
 * 127.0.0.1 stands in for the provider, with a throwaway key. No request leaves this
 * machine, and it proves the client path only, not the real API.
 *
 * The SDK reports the timeout it will use in the X-Stainless-Timeout header (whole
 * seconds), which is how these tests see the client's own timeout from the outside.
 */
import http from 'http';
import type { AddressInfo, Socket } from 'net';
import { ChatAnthropic } from '@langchain/anthropic';
import { AnthropicProvider } from '../../../lib/llm/anthropic-provider';
import { LLMFactory } from '../../../lib/llm/llm-factory';
import { runCodeJury, runCodeJustifier } from '../../../lib/code-review/jury';

/** code-standard's juror output (owner decision Q52), and the last figure the SDK sends with no client timeout. */
const CLASS_OUTPUT_TOKENS = 32000;
const SDK_LIMIT = 21333;
/** What the SDK uses when the client has no timeout of its own. */
const SDK_DEFAULT_TIMEOUT_S = 600;

const SONNET = 'claude-sonnet-5-5';
const OUTCOMES = ['A', 'B'];
/** Room for a loaded test host, below the second or more that would mean a timer ran on. */
const SLACK_MS = 500;
const SCORES = JSON.stringify({ score: [400000, 600000], justification: 'stub reply' });

interface Seen {
  body: any;
  timeoutSeconds: number | null;
  /** When the connection closed with the response unfinished: the client gave up. */
  closedAt: number | null;
}

type Behaviour = (res: http.ServerResponse, index: number) => void;

const claudeReply = (text: string) => JSON.stringify({
  id: 'msg_stub',
  type: 'message',
  role: 'assistant',
  model: 'stub',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

const sendJson = (res: http.ServerResponse, status: number, body: string) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
};
const answerWith = (text: string, delayMs = 0): Behaviour => (res) => {
  setTimeout(() => sendJson(res, 200, claudeReply(text)), delayMs);
};
/** Takes the request and never answers. */
const hang: Behaviour = () => {};

let server: http.Server;
let behaviour: Behaviour;
let seen: Seen[] = [];
const sockets = new Set<Socket>();
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CLASS_PROVIDER',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_CLASS_PROVIDER',
  'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL',
  'XAI_API_KEY', 'XAI_BASE_URL', 'XAI_CLASS_PROVIDER', 'GROK_API_KEY', 'GROK_BASE_URL',
  'AI_GATEWAY', 'AI_WEB_ACCESS', 'JUSTIFIER_MODEL', 'VERDIKTA_TEST_MOCK_PROVIDER',
];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const header = req.headers['x-stainless-timeout'];
      const entry: Seen = { body: JSON.parse(raw), timeoutSeconds: header === undefined ? null : Number(header), closedAt: null };
      const index = seen.push(entry) - 1;
      res.on('close', () => {
        if (!res.writableFinished) entry.closedAt = Date.now();
      });
      behaviour(res, index);
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ANTHROPIC_API_KEY = 'stub-key';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  sockets.forEach(socket => socket.destroy());
  await new Promise(resolve => server.close(resolve));
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  seen = [];
  behaviour = answerWith(SCORES);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// An aborted call leaves LangChain's retry timers behind for up to two minutes. Each attempt
// fails on the aborted signal and sends nothing, which the last 'cancel' test checks, but they
// would hold the test process open. Never restored: this environment is the file's alone, and
// a chain can outlast afterAll.
const realSetTimeout = global.setTimeout;
global.setTimeout = ((...args: Parameters<typeof setTimeout>) => realSetTimeout(...args).unref()) as typeof setTimeout;

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The SDK truncates to whole seconds and a little time has passed: a few seconds below `seconds`, never above. */
const expectTimeLeft = (timeoutSeconds: number | null, seconds: number) => {
  expect(timeoutSeconds).toBeLessThanOrEqual(seconds);
  expect(timeoutSeconds).toBeGreaterThanOrEqual(seconds - 5);
};

const juror = (model = SONNET) => ({ provider: 'anthropic', model, weight: 1 });

const jury = (juryDeadlineAt: number, models = [SONNET]) => runCodeJury({
  jurors: models.map(model => juror(model)),
  prompt: 'the claim',
  outcomes: OUTCOMES,
  maxTokens: CLASS_OUTPUT_TOKENS,
  juryDeadlineAt,
});

/** A juror's call as askJuror makes it. */
const jurorCall = (signal: AbortSignal, deadlineAt?: number, maxTokens = CLASS_OUTPUT_TOKENS) => ({
  webAccess: false as const,
  signal,
  maxTokens,
  effort: 'high' as const,
  ...(deadlineAt !== undefined && { deadlineAt }),
});

describe('the SDK limit itself (control)', () => {
  // The client as the provider builds it, but with LangChain's retries off so the refusal
  // shows at once. With them on, the provider retries the refusal for one to two minutes.
  const chatAt = (maxTokens: number, clientOptions?: { timeout: number }) => new ChatAnthropic({
    anthropicApiKey: 'stub-key',
    modelName: SONNET,
    maxTokens,
    maxRetries: 0,
    invocationKwargs: { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
    ...(clientOptions && { clientOptions }),
  });

  test(`${SDK_LIMIT} is sent with no client timeout`, async () => {
    behaviour = answerWith('ok');
    await chatAt(SDK_LIMIT).invoke('hi');
    expect(seen).toHaveLength(1);
    expect(seen[0].body.max_tokens).toBe(SDK_LIMIT);
  });

  test.each([SDK_LIMIT + 1, CLASS_OUTPUT_TOKENS])('%i is refused before any request with no client timeout', async (maxTokens) => {
    await expect(chatAt(maxTokens).invoke('hi')).rejects.toThrow(/Streaming is required/);
    expect(seen).toHaveLength(0);
  });

  test(`${CLASS_OUTPUT_TOKENS} is sent when the client has a timeout of its own`, async () => {
    behaviour = answerWith('ok');
    await chatAt(CLASS_OUTPUT_TOKENS, { timeout: 90000 }).invoke('hi');
    expect(seen.map(s => s.body.max_tokens)).toEqual([CLASS_OUTPUT_TOKENS]);
    expect(seen[0].timeoutSeconds).toBe(90);
  });
});

describe('a Claude juror at the class output in code mode', () => {
  test.each([SONNET, 'claude-haiku-5-5', 'claude-opus-5-5'])('%s sends its request and answers', async (model) => {
    const outcome = await jury(Date.now() + 3000, [model]);

    expect(outcome.kind).toBe('ok');
    expect(outcome.results[0].vector).toEqual([400000, 600000]);
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toMatchObject({
      model,
      max_tokens: CLASS_OUTPUT_TOKENS,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
    expect(seen[0].body.stream).toBeFalsy();
  });

  test('its client timeout is the time left to the deadline', async () => {
    await jury(Date.now() + 90000);
    await jury(Date.now() + 37000);

    expect(seen).toHaveLength(2);
    expectTimeLeft(seen[0].timeoutSeconds, 90);
    expectTimeLeft(seen[1].timeoutSeconds, 37);
  });

  test('the repair call gets the time left when it starts, not the first call\'s', async () => {
    behaviour = (res, index) => {
      if (index === 0) answerWith('prose with no score object', 1200)(res, index);
      else answerWith('{"score": [250000, 750000]}')(res, index);
    };

    const outcome = await jury(Date.now() + 90000);

    expect(outcome.kind).toBe('ok');
    expect(outcome.results[0].vector).toEqual([250000, 750000]);
    expect(seen).toHaveLength(2);
    expect(seen[1].body.max_tokens).toBe(CLASS_OUTPUT_TOKENS);
    expectTimeLeft(seen[0].timeoutSeconds, 90);
    // The first reply took over a second, so whole seconds must have dropped.
    expect(seen[1].timeoutSeconds!).toBeLessThan(seen[0].timeoutSeconds!);
  });

  test('the sampling-parameter retry gets the time left when it starts too', async () => {
    behaviour = (res, index) => {
      if (index === 0) {
        setTimeout(() => sendJson(res, 400, JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: '`temperature` is deprecated for this model.' },
        })), 1200);
      } else {
        answerWith('the answer')(res, index);
      }
    };
    const provider = new AnthropicProvider('stub-key');

    const reply = await provider.generateResponse('the claim', 'claude-sonnet-4-6', jurorCall(new AbortController().signal, Date.now() + 90000));

    expect(reply).toBe('the answer');
    expect(seen).toHaveLength(2);
    expect(seen[0].body.temperature).toBe(0.7);
    expect(seen[1].body.temperature).toBeUndefined();
    expect(seen.map(s => s.body.max_tokens)).toEqual([CLASS_OUTPUT_TOKENS, CLASS_OUTPUT_TOKENS]);
    expectTimeLeft(seen[0].timeoutSeconds, 90);
    expect(seen[1].timeoutSeconds!).toBeLessThan(seen[0].timeoutSeconds!);
  });
});

describe('the cancel still ends the request', () => {
  test('the AbortController ends a request whose client timeout is far off', async () => {
    behaviour = hang;
    const controller = new AbortController();
    const provider = new AnthropicProvider('stub-key');
    const startedAt = Date.now();
    const call = provider.generateResponse('the claim', SONNET, jurorCall(controller.signal, startedAt + 90000));
    call.catch(() => {});
    while (seen.length === 0 && Date.now() - startedAt < 2000) await pause(10);

    const abortedAt = Date.now();
    controller.abort();

    await expect(call).rejects.toThrow();
    expect(Date.now() - abortedAt).toBeLessThan(SLACK_MS);
    while (seen[0]?.closedAt === null && Date.now() - abortedAt < 1000) await pause(10);
    expect(seen).toHaveLength(1);
    expectTimeLeft(seen[0].timeoutSeconds, 90);
    expect(seen[0].closedAt).not.toBeNull();
    expect(seen[0].closedAt! - abortedAt).toBeLessThan(SLACK_MS);
  });

  test('at the jury deadline a hung juror is a timeout, whichever timer fires first, and each request closes', async () => {
    behaviour = hang;
    const deadline = Date.now() + 400;

    const outcome = await jury(deadline, [SONNET, 'claude-haiku-5-5', 'claude-opus-5-5']);

    expect(Date.now() - deadline).toBeLessThan(SLACK_MS);
    expect(outcome.kind).toBe('timeout');
    expect(outcome.results.map(r => r.status)).toEqual(['timeout', 'timeout', 'timeout']);
    await pause(100);
    expect(seen).toHaveLength(3);
    for (const request of seen) {
      expect(request.closedAt).not.toBeNull();
      expect(request.closedAt! - deadline).toBeLessThan(SLACK_MS);
    }
  });

  test('a LangChain retry keeps the client\'s first timeout, and the deadline still ends it on time', async () => {
    // LangChain retries with the same client, so the second attempt's own timer would run
    // about a second past the deadline. The cancel at the deadline is what ends it.
    behaviour = (res, index) => {
      if (index === 0) sendJson(res, 500, JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'stub' } }));
    };
    const deadline = Date.now() + 2600;

    const outcome = await jury(deadline);

    expect(outcome.kind).toBe('timeout');
    expect(Date.now() - deadline).toBeLessThan(SLACK_MS);
    await pause(100);
    expect(seen).toHaveLength(2);
    expect(seen[1].timeoutSeconds).toBe(seen[0].timeoutSeconds);
    expect(seen[1].closedAt).not.toBeNull();
    expect(seen[1].closedAt! - deadline).toBeLessThan(SLACK_MS);
  });

  test('a client timeout that fires before the cancel sends nothing after the cancel', async () => {
    behaviour = hang;
    const controller = new AbortController();
    const provider = new AnthropicProvider('stub-key');
    const startedAt = Date.now();
    const call = provider.generateResponse('the claim', SONNET, jurorCall(controller.signal, startedAt + 100));
    call.catch(() => {});

    await pause(500);
    // The client gave up on its own timer, and the call is still waiting for LangChain's backoff.
    expect(seen).toHaveLength(1);
    expect(seen[0].closedAt).not.toBeNull();
    controller.abort();
    await expect(call).rejects.toThrow();

    // LangChain's first backoff is one to two seconds from the client's timeout.
    await pause(1800);
    expect(seen).toHaveLength(1);
  });
});

describe('the other providers on the pool have no such limit at the class output', () => {
  // Their real clients against the same stub: the openai SDK for OpenAI, plain fetch for
  // the other two. Neither path has a client-side check on the token count.
  beforeAll(() => {
    const stub = process.env.ANTHROPIC_BASE_URL;
    process.env.OPENAI_API_KEY = 'stub-key';
    process.env.OPENAI_BASE_URL = stub;
    process.env.OPENROUTER_API_KEY = 'stub-key';
    process.env.OPENROUTER_BASE_URL = stub;
    process.env.XAI_API_KEY = 'stub-key';
    process.env.XAI_BASE_URL = stub;
  });

  test.each([
    ['openai', 'gpt-6-sol', 'max_completion_tokens'],
    ['openrouter', 'deepseek/deepseek-v4-pro-0813', 'max_tokens'],
    ['xai', 'grok-4.7', 'max_tokens'],
  ])('%s %s sends its request', async (provider, model, field) => {
    behaviour = (res) => sendJson(res, 200, JSON.stringify({
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: SCORES }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));

    const outcome = await runCodeJury({
      jurors: [{ provider, model, weight: 1 }],
      prompt: 'the claim',
      outcomes: OUTCOMES,
      maxTokens: CLASS_OUTPUT_TOKENS,
      juryDeadlineAt: Date.now() + 3000,
    });

    expect(outcome.kind).toBe('ok');
    expect(seen).toHaveLength(1);
    expect(seen[0].body[field]).toBe(CLASS_OUTPUT_TOKENS);
    expect(seen[0].body.stream).toBeFalsy();
  });
});

describe('nothing changes outside a juror\'s code-mode call', () => {
  const TEXT_MODE_MODERN = {
    model: 'claude-sonnet-5',
    max_tokens: 8192,
    messages: [{ role: 'user', content: 'a text-mode prompt' }],
    stream: false,
    thinking: { type: 'disabled' },
  };

  test('the factory hands out a new provider for each call, so no client or timeout is shared', async () => {
    const first = await LLMFactory.getProvider('anthropic');
    const second = await LLMFactory.getProvider('anthropic');

    expect(first).toBeInstanceOf(AnthropicProvider);
    expect(second).toBeInstanceOf(AnthropicProvider);
    expect(first).not.toBe(second);
  });

  test('a text-mode call sends the same request, under the SDK\'s default timeout', async () => {
    behaviour = answerWith('ok');

    await new AnthropicProvider('stub-key').generateResponse('a text-mode prompt', 'claude-sonnet-5');

    expect(seen).toHaveLength(1);
    expect(seen[0].body).toEqual(TEXT_MODE_MODERN);
    expect(seen[0].timeoutSeconds).toBe(SDK_DEFAULT_TIMEOUT_S);
  });

  test('a text-mode call on a legacy model keeps its temperature and the default timeout', async () => {
    behaviour = answerWith('ok');

    await new AnthropicProvider('stub-key').generateResponse('a text-mode prompt', 'claude-sonnet-4-6');

    expect(seen).toHaveLength(1);
    expect(seen[0].body.temperature).toBe(0.7);
    expect(seen[0].timeoutSeconds).toBe(SDK_DEFAULT_TIMEOUT_S);
  });

  test('a text-mode call right after a juror\'s call on the same provider keeps nothing of it', async () => {
    const provider = new AnthropicProvider('stub-key');
    await provider.generateResponse('the claim', SONNET, jurorCall(new AbortController().signal, Date.now() + 90000));
    expectTimeLeft(seen[0].timeoutSeconds, 90);

    behaviour = answerWith('ok');
    await provider.generateResponse('a text-mode prompt', 'claude-sonnet-5');

    expect(seen).toHaveLength(2);
    expect(seen[1].body).toEqual(TEXT_MODE_MODERN);
    expect(seen[1].timeoutSeconds).toBe(SDK_DEFAULT_TIMEOUT_S);
  });

  test('the justifier stays at its default ceiling and timeout', async () => {
    process.env.JUSTIFIER_MODEL = `anthropic:${SONNET}`;
    behaviour = answerWith('the justification');
    try {
      const outcome = await runCodeJustifier('the justifier prompt', 30000);

      expect(outcome).toEqual({ kind: 'ok', text: 'the justification' });
      expect(seen).toHaveLength(1);
      expect(seen[0].body.max_tokens).toBe(8192);
      expect(seen[0].timeoutSeconds).toBe(SDK_DEFAULT_TIMEOUT_S);
    } finally {
      delete process.env.JUSTIFIER_MODEL;
    }
  });

  test('without a deadline a call above the limit is still refused: the limit is lifted only where a deadline stands behind it', async () => {
    const controller = new AbortController();
    const call = new AnthropicProvider('stub-key').generateResponse('the claim', SONNET, jurorCall(controller.signal));
    call.catch(() => {});

    await pause(200);
    expect(seen).toHaveLength(0);
    controller.abort();
    await expect(call).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
});
