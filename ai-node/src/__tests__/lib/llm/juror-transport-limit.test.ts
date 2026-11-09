/**
 * @jest-environment node
 *
 * Node's fetch (undici) gives up on a reply whose headers have not arrived within 300 s
 * (`headersTimeout`) and on a body that stays silent for 300 s (`bodyTimeout`). A
 * non-streaming reasoning reply sends no headers until it is complete, so before the
 * jury cap went from 240 s to 480 s (design §11) a code-mode juror slower than 300 s
 * would have been cut there, the juror failed, and the arbiter abstained. Every provider
 * path the code pools name (OpenRouter, OpenAI, Anthropic, xAI) runs here through its
 * real client, as `runCodeJury` calls it, against a stub on 127.0.0.1 with a throwaway
 * key. No request leaves this machine.
 *
 * Time is scaled, since a 300 s wait per case would make the suite too slow. Every fetch
 * in this file is Node's own; a call that names no dispatcher of its own gets, in place
 * of Node's default, an undici Agent with the same two limits at DEFAULT_LIMIT_MS (1 s
 * instead of 300 s), so it is cut by undici's own timer as it would be at 300 s in
 * production. Set VERDIKTA_REAL_UNDICI_LIMIT=1 to scale nothing: Node's real default
 * dispatcher and its 300 s apply, the stub answers after 310 s, and the file takes about
 * six minutes (the cases run side by side).
 */
import fs from 'fs';
import http from 'http';
import type { AddressInfo, Socket } from 'net';
import { Agent } from 'undici';
import { runCodeJury, runCodeJustifier } from '../../../lib/code-review/jury';
import { CODE_JURY_MAX_MS, planCodeReviewTimes } from '../../../lib/code-review/deadline';
import { LLMFactory } from '../../../lib/llm/llm-factory';
import * as jurorTransport from '../../../lib/llm/juror-transport';

const REAL = process.env.VERDIKTA_REAL_UNDICI_LIMIT === '1';
/** The default dispatcher's two limits: 300 s in production, scaled here. */
const DEFAULT_LIMIT_MS = REAL ? 300000 : 1000;
/** How late the stub's slow replies come: past the default limit, with room for undici's coarse timers. */
const LATE_MS = REAL ? 310000 : 2500;
/** The juror window a slow reply must fit in (480 s on a far deadline). */
const WINDOW_MS = REAL ? 330000 : 5000;
/** Room for a loaded test host. */
const SLACK_MS = 600;

const OUTCOMES = ['A', 'B'];
const CLASS_OUTPUT_TOKENS = 32000;
const SCORES = JSON.stringify({ score: [400000, 600000], justification: 'stub reply' });

type Behaviour = 'now' | 'headers-late' | 'body-late' | 'hang';

/** One provider path, as a code pool names it. */
interface Path {
  provider: 'openrouter' | 'openai' | 'anthropic' | 'xai';
  model: string;
  /** A text-mode model on the same provider class. */
  textModel: string;
}

const PATHS: Path[] = [
  { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro-0813', textModel: 'deepseek/deepseek-v4-pro-0813' },
  { provider: 'openai', model: 'gpt-6-sol', textModel: 'gpt-5' },
  { provider: 'anthropic', model: 'claude-sonnet-5-5', textModel: 'claude-sonnet-5' },
  { provider: 'xai', model: 'grok-4.7', textModel: 'grok-4.7' },
];

interface Seen {
  caseId: string | null;
  path: string;
  receivedAt: number;
  /** When the client closed the connection before the response was finished: it gave up. */
  closedAt: number | null;
  /** When the client's socket for this request closed. */
  socketClosedAt: number | null;
}

/** Every request Node's fetch was asked to make, and whether the caller named a dispatcher. */
interface Fetched {
  caseId: string | null;
  dispatcher: unknown;
}

let server: http.Server;
let seen: Seen[] = [];
let fetched: Fetched[] = [];
const sockets = new Set<Socket>();
/** The requests each connection carried. */
const carried = new Map<Socket, Seen[]>();
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CLASS_PROVIDER',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_CLASS_PROVIDER',
  'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL',
  'XAI_API_KEY', 'XAI_BASE_URL', 'XAI_CLASS_PROVIDER', 'GROK_API_KEY', 'GROK_BASE_URL',
  'AI_GATEWAY', 'AI_WEB_ACCESS', 'JUSTIFIER_MODEL', 'VERDIKTA_TEST_MOCK_PROVIDER', 'MODEL_TIMEOUT_MS',
];

/** The case a request belongs to: a marker the prompt carries, `[stub:<behaviour>:<id>]`. */
const MARKER = /\[stub:(now|headers-late|body-late|hang):([a-z0-9-]+)\]/;
const markerIn = (text: string): { behaviour: Behaviour; caseId: string } | null => {
  const match = MARKER.exec(text);
  return match ? { behaviour: match[1] as Behaviour, caseId: match[2] } : null;
};
const prompt = (behaviour: Behaviour, caseId: string) => `the claim [stub:${behaviour}:${caseId}]`;

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
const chatReply = (text: string) => JSON.stringify({
  id: 'chatcmpl-stub',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

function answer(req: http.IncomingMessage, res: http.ServerResponse, behaviour: Behaviour) {
  if (behaviour === 'hang') return;
  const body = (req.url || '').endsWith('/messages') ? claudeReply(SCORES) : chatReply(SCORES);
  const headers = { 'content-type': 'application/json' };
  if (behaviour === 'now') {
    res.writeHead(200, headers);
    res.end(body);
  } else if (behaviour === 'headers-late') {
    // A non-streaming reasoning reply: nothing at all until it is complete.
    setTimeout(() => {
      res.writeHead(200, headers);
      res.end(body);
    }, LATE_MS);
  } else {
    // Headers at once, then a body that stays silent until it is complete.
    res.writeHead(200, headers);
    res.flushHeaders();
    setTimeout(() => res.end(body), LATE_MS);
  }
}

// An aborted call leaves LangChain's retry timers behind; they send nothing, but would hold
// the test process open. Never restored: this environment is the file's alone.
const realSetTimeout = global.setTimeout;
global.setTimeout = ((...args: Parameters<typeof setTimeout>) => realSetTimeout(...args).unref()) as typeof setTimeout;

// Node's fetch, with the scaled default dispatcher in place of Node's own for a call that
// names none (as Node does: `init.dispatcher ?? getGlobalDispatcher()`). Every call is logged.
const nodeFetch = global.fetch;
const scaledDefault = REAL ? null : new Agent({ headersTimeout: DEFAULT_LIMIT_MS, bodyTimeout: DEFAULT_LIMIT_MS });
/** Off where the scaled limit would end a call before the deadline being tested does. */
let scaling = true;
global.fetch = ((input: any, init?: any) => {
  const dispatcher = init?.dispatcher;
  fetched.push({ caseId: typeof init?.body === 'string' ? markerIn(init.body)?.caseId ?? null : null, dispatcher });
  if (!scaledDefault || !scaling) return nodeFetch(input, init);
  return nodeFetch(input, { ...init, dispatcher: dispatcher ?? scaledDefault });
}) as typeof fetch;

const pause = (ms: number) => new Promise(resolve => realSetTimeout(resolve, ms));
const requestsOf = (caseId: string) => seen.filter(s => s.caseId === caseId);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const marker = markerIn(raw);
      const entry: Seen = { caseId: marker?.caseId ?? null, path: req.url || '', receivedAt: Date.now(), closedAt: null, socketClosedAt: null };
      seen.push(entry);
      res.on('close', () => {
        if (!res.writableFinished) entry.closedAt = Date.now();
      });
      carried.get(req.socket)?.push(entry);
      answer(req, res, marker?.behaviour ?? 'now');
    });
  });
  // The stub never closes an idle connection first: a closed socket is the client's doing.
  server.keepAliveTimeout = 60000;
  server.on('connection', socket => {
    sockets.add(socket);
    carried.set(socket, []);
    socket.on('close', () => {
      sockets.delete(socket);
      const closedAt = Date.now();
      carried.get(socket)?.forEach(entry => { entry.socketClosedAt = closedAt; });
      carried.delete(socket);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const stub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ANTHROPIC_API_KEY = 'stub-key';
  process.env.ANTHROPIC_BASE_URL = stub;
  process.env.OPENAI_API_KEY = 'stub-key';
  process.env.OPENAI_BASE_URL = stub;
  process.env.OPENROUTER_API_KEY = 'stub-key';
  process.env.OPENROUTER_BASE_URL = stub;
  process.env.XAI_API_KEY = 'stub-key';
  process.env.XAI_BASE_URL = stub;
});

afterAll(async () => {
  sockets.forEach(socket => socket.destroy());
  await new Promise(resolve => server.close(resolve));
  await scaledDefault?.destroy();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** One juror on one path, as askJuror calls it, with `windowMs` until the jury deadline. */
const jury = (path: Path, behaviour: Behaviour, caseId: string, windowMs: number) => runCodeJury({
  jurors: [{ provider: path.provider, model: path.model, weight: 1 }],
  prompt: prompt(behaviour, caseId),
  outcomes: OUTCOMES,
  maxTokens: CLASS_OUTPUT_TOKENS,
  juryDeadlineAt: Date.now() + windowMs,
});

describe(`a reply slower than the default limit (${DEFAULT_LIMIT_MS} ms here, 300 s in production)`, () => {
  const LATE: Behaviour[] = ['headers-late', 'body-late'];
  const cases = PATHS.flatMap(path => LATE.map(behaviour => ({ path, behaviour, caseId: `${path.provider}-${behaviour}` })));
  const outcomes = new Map<string, { kind: string; status: string; error?: string; elapsedMs: number }>();
  const controls = new Map<Behaviour, { error: any; elapsedMs: number }>();

  /** The default limit itself, on a plain fetch: what every juror call met before. */
  const plainFetch = async (behaviour: Behaviour) => {
    const startedAt = Date.now();
    try {
      const response = await fetch(`${process.env.OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: prompt(behaviour, `control-${behaviour}`) }),
      });
      await response.text();
      return { error: null, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      return { error, elapsedMs: Date.now() - startedAt };
    }
  };

  // Every case at once, so a real-time run waits for the limit once.
  beforeAll(async () => {
    seen = [];
    fetched = [];
    const quiet = [jest.spyOn(console, 'log'), jest.spyOn(console, 'warn'), jest.spyOn(console, 'error')];
    quiet.forEach(spy => spy.mockImplementation(() => {}));
    try {
      await Promise.all([
        ...cases.map(async ({ path, behaviour, caseId }) => {
          const startedAt = Date.now();
          const outcome = await jury(path, behaviour, caseId, WINDOW_MS);
          const result = outcome.results[0];
          outcomes.set(caseId, { kind: outcome.kind, status: result.status, error: result.error_message, elapsedMs: Date.now() - startedAt });
        }),
        ...LATE.map(async behaviour => { controls.set(behaviour, await plainFetch(behaviour)); }),
      ]);
    } finally {
      quiet.forEach(spy => spy.mockRestore());
    }
  }, REAL ? 420000 : 30000);

  // Node's fetch runs in Node's realm, not the test's: its TypeError is not this file's, and an
  // undici error raised in the test's realm reaches it as an Error that only names the class.
  const causeOf = (error: any) => `${error?.cause?.code ?? ''} ${error?.cause?.name ?? ''} ${error?.cause?.message ?? ''}`;

  test('control: a plain fetch with no dispatcher of its own is cut by undici\'s headersTimeout', () => {
    const control = controls.get('headers-late')!;
    expect(control.error?.name).toBe('TypeError');
    expect(control.error?.message).toBe('fetch failed');
    expect(causeOf(control.error)).toMatch(/UND_ERR_HEADERS_TIMEOUT|HeadersTimeoutError/);
    expect(control.elapsedMs).toBeGreaterThanOrEqual(DEFAULT_LIMIT_MS - 50);
    expect(control.elapsedMs).toBeLessThan(LATE_MS);
  });

  test('control: and a body silent for longer than the limit by its bodyTimeout', () => {
    const control = controls.get('body-late')!;
    // Node's body stream reports the cut as "terminated"; the undici error behind it does not
    // cross realms here, so its timing is what shows it: at the limit, before the body came.
    expect(control.error?.name).toBe('TypeError');
    expect(control.error?.message).toBe('terminated');
    expect(control.elapsedMs).toBeGreaterThanOrEqual(DEFAULT_LIMIT_MS - 50);
    expect(control.elapsedMs).toBeLessThan(LATE_MS);
  });

  test.each(cases.map(c => [c.caseId, c] as const))('%s: the juror holds the call and answers', (caseId) => {
    const outcome = outcomes.get(caseId)!;
    expect(outcome).toMatchObject({ kind: 'ok', status: 'success' });
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(LATE_MS - 50);
    expect(outcome.elapsedMs).toBeLessThan(WINDOW_MS);
    // One request: no client retried a call it had given up on, so nothing was paid twice.
    expect(requestsOf(caseId)).toHaveLength(1);
    expect(requestsOf(caseId)[0].closedAt).toBeNull();
  });
});

describe('the juror\'s AbortController still ends the call at the jury deadline', () => {
  const HANG_WINDOW_MS = 1500;
  const outcomes = new Map<string, { kind: string; status: string; endedAt: number; deadline: number }>();

  // Node's own default for a call that names no dispatcher: before the fix, the cut at the
  // scaled limit would have come before this deadline.
  beforeAll(async () => {
    scaling = false;
    seen = [];
    const quiet = [jest.spyOn(console, 'log'), jest.spyOn(console, 'warn'), jest.spyOn(console, 'error')];
    quiet.forEach(spy => spy.mockImplementation(() => {}));
    try {
      await Promise.all(PATHS.map(async path => {
        const caseId = `${path.provider}-hang`;
        const deadline = Date.now() + HANG_WINDOW_MS;
        const outcome = await jury(path, 'hang', caseId, HANG_WINDOW_MS);
        outcomes.set(caseId, { kind: outcome.kind, status: outcome.results[0].status, endedAt: Date.now(), deadline });
      }));
      await pause(SLACK_MS);
    } finally {
      quiet.forEach(spy => spy.mockRestore());
    }
  }, 20000);

  afterAll(() => { scaling = true; });

  test.each(PATHS.map(p => [p.provider] as const))('%s: a hung juror is a timeout at the deadline, and its request is closed there', (provider) => {
    const caseId = `${provider}-hang`;
    const outcome = outcomes.get(caseId)!;
    expect(outcome).toMatchObject({ kind: 'timeout', status: 'timeout' });
    expect(outcome.endedAt - outcome.deadline).toBeLessThan(SLACK_MS);
    const requests = requestsOf(caseId);
    expect(requests).toHaveLength(1);
    expect(requests[0].closedAt).not.toBeNull();
    expect(requests[0].closedAt! - outcome.deadline).toBeLessThan(SLACK_MS);
  });
});

describe('the dispatcher of a juror\'s call', () => {
  test('is undici of the major this Node bundles, which its fetch is written against', () => {
    const pinned: string = JSON.parse(fs.readFileSync(require.resolve('undici/package.json'), 'utf8')).version;
    expect(pinned.split('.')[0]).toBe(String(process.versions.undici).split('.')[0]);
  });

  test('its limits sit above the window, the grace past the deadline', () => {
    const now = 1_000_000;
    expect(jurorTransport.JUROR_TRANSPORT_GRACE_MS).toBeGreaterThan(0);
    expect(jurorTransport.jurorTransportTimeoutMs(now + CODE_JURY_MAX_MS, now)).toBe(CODE_JURY_MAX_MS + jurorTransport.JUROR_TRANSPORT_GRACE_MS);
    expect(jurorTransport.jurorTransportTimeoutMs(now - 5000, now)).toBe(jurorTransport.JUROR_TRANSPORT_GRACE_MS);
  });

  test('a call with no deadline gets none', () => {
    expect(jurorTransport.jurorTransportFor(undefined)).toBeNull();
    expect(jurorTransport.jurorTransportFor({})).toBeNull();
    const init = { method: 'POST' };
    expect(jurorTransport.withDispatcher(init, null)).toBe(init);
  });

  test.each(PATHS.map(p => [p.provider, p] as const))('%s: on the full 480 s window each juror call names its own, with limits above the window', async (_provider, path) => {
    fetched = [];
    const times = planCodeReviewTimes(780000, Date.now())!;
    expect(times.jurorTimeoutMs).toBe(480000);
    const caseId = `${path.provider}-window`;

    const outcome = await runCodeJury({
      jurors: [{ provider: path.provider, model: path.model, weight: 1 }],
      prompt: prompt('now', caseId),
      outcomes: OUTCOMES,
      maxTokens: CLASS_OUTPUT_TOKENS,
      juryDeadlineAt: times.juryDeadlineAt,
    });

    expect(outcome.kind).toBe('ok');
    const calls = fetched.filter(f => f.caseId === caseId);
    expect(calls).toHaveLength(1);
    const dispatcher = calls[0].dispatcher as jurorTransport.JurorAgent;
    expect(dispatcher).toBeInstanceOf(jurorTransport.JurorAgent);
    expect(dispatcher.limitMs).toBeGreaterThan(times.jurorTimeoutMs);
    expect(dispatcher.limitMs).toBeLessThanOrEqual(times.jurorTimeoutMs + jurorTransport.JUROR_TRANSPORT_GRACE_MS);
    // Destroyed with the call: nothing can be sent on it afterwards.
    expect(dispatcher.destroyed).toBe(true);
  });

  test('two juror calls never share one', async () => {
    fetched = [];
    const outcome = await runCodeJury({
      jurors: PATHS.slice(0, 2).map(path => ({ provider: path.provider, model: path.model, weight: 1 })),
      prompt: prompt('now', 'pair'),
      outcomes: OUTCOMES,
      maxTokens: CLASS_OUTPUT_TOKENS,
      juryDeadlineAt: Date.now() + 5000,
    });
    expect(outcome.kind).toBe('ok');
    const dispatchers = fetched.filter(f => f.caseId === 'pair').map(f => f.dispatcher);
    expect(dispatchers).toHaveLength(2);
    expect(dispatchers[0]).toBeInstanceOf(jurorTransport.JurorAgent);
    expect(dispatchers[1]).toBeInstanceOf(jurorTransport.JurorAgent);
    expect(dispatchers[0]).not.toBe(dispatchers[1]);
  });
});

describe('nothing a juror\'s call sets up outlives it', () => {
  test.each(PATHS.map(p => [p.provider, p] as const))('%s: once the juror has answered, its connection is closed', async (_provider, path) => {
    seen = [];
    const caseId = `${path.provider}-done`;
    const outcome = await jury(path, 'now', caseId, 5000);
    expect(outcome.kind).toBe('ok');
    const [request] = requestsOf(caseId);
    // A dispatcher shared with other calls would keep the socket for reuse (undici: 4 s idle).
    for (let waited = 0; request.socketClosedAt === null && waited < 1000; waited += 20) await pause(20);
    expect(request.socketClosedAt).not.toBeNull();
  });
});

describe('text mode and the justifier keep Node\'s default dispatcher', () => {
  beforeEach(() => {
    seen = [];
    fetched = [];
  });

  test.each(PATHS.map(p => [p.provider, p] as const))('%s: a text-mode call names no dispatcher', async (_provider, path) => {
    const caseId = `${path.provider}-text`;
    const provider = await LLMFactory.getProvider(path.provider) as any;
    await provider.generateResponse(prompt('now', caseId), path.textModel);
    const calls = fetched.filter(f => f.caseId === caseId);
    expect(calls).toHaveLength(1);
    expect(calls[0].dispatcher).toBeUndefined();
  });

  test.each(PATHS.map(p => [p.provider, p] as const))('%s: a justifier call (a signal, no deadline) names no dispatcher', async (_provider, path) => {
    const caseId = `${path.provider}-justifier`;
    process.env.JUSTIFIER_MODEL = `${path.provider}:${path.model}`;
    try {
      const outcome = await runCodeJustifier(prompt('now', caseId), 30000);
      expect(outcome.kind).toBe('ok');
    } finally {
      delete process.env.JUSTIFIER_MODEL;
    }
    const calls = fetched.filter(f => f.caseId === caseId);
    expect(calls).toHaveLength(1);
    expect(calls[0].dispatcher).toBeUndefined();
  });

  // Scaled time only: at the real limit this would be another five minutes per path.
  (REAL ? test.skip : test).each([PATHS[0], PATHS[3]].map(p => [p.provider, p] as const))('%s: a slow text-mode reply still meets the default limit, as before', async (_provider, path) => {
    const caseId = `${path.provider}-text-late`;
    const provider = await LLMFactory.getProvider(path.provider) as any;
    await expect(provider.generateResponse(prompt('headers-late', caseId), path.textModel)).rejects.toThrow(/fetch failed/);
    expect(fetched.filter(f => f.caseId === caseId).map(f => f.dispatcher)).toEqual([undefined]);
  }, 10000);
});
