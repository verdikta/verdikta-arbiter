/**
 * Node A6c: the fault switch on the real route, the real factory and the real timers' logic
 * under jest's fake clock, every provider the deterministic mock. A hold costs no wall time.
 * The mock is the test's stand-in for a provider only: the switch itself runs on real canaries
 * with real providers, and has nothing to do with it.
 */
import crypto from 'crypto';
import { POST } from '../../app/api/rank-and-justify/route';
import { GET } from '../../app/api/health/route';
import { MOCK_PROVIDER_FLAG, MOCK_SCRIPT_ENV, mockProviderCalls, resetMockProvider } from '../../lib/llm/mock-provider';
import { CANARY_FAULT_KEY_ENV, directiveMac } from '../../lib/code-review/canary-fault';
import { codeModeBody, codeReviewField } from '../../../test-support/code-review-fixtures';

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((data, options) => ({ status: options?.status || 200, json: async () => data })),
  },
}));

const env = process.env as Record<string, string | undefined>;
const KEYS = [MOCK_PROVIDER_FLAG, MOCK_SCRIPT_ENV, 'JUSTIFIER_MODEL', 'AI_WEB_ACCESS', CANARY_FAULT_KEY_ENV];
const saved: Record<string, string | undefined> = {};
const KEY = 'k'.repeat(48);
const GEMINI = 'google/gemini-4-argon';
const LUNA = 'gpt-6-luna';
const JUSTIFIER = 'mock-justifier';
const HIGH = [0, 0, 0, 0, 1000000, 0];
const MEDIUM = [0, 0, 0, 1000000, 0, 0];
const DEADLINE = 600000;
/** What DEADLINE leaves the jury: the 480 s cap (deadline.ts, CODE_JURY_MAX_MS). */
const JURY_MS = 480000;

function script(entries: Record<string, unknown> = {}) {
  env[MOCK_SCRIPT_ENV] = JSON.stringify({
    [JUSTIFIER]: { reply: 'The panel finds a HIGH reentrancy in Vault.withdraw.' },
    [GEMINI]: { scores: HIGH },
    [LUNA]: { scores: MEDIUM },
    ...entries,
  });
}

function directive(action: string, key = KEY) {
  const field = codeReviewField({ deadlineMs: DEADLINE });
  return { action, mac: directiveMac(key, action, field.claim.bcid, field.reportSha256) };
}

const body = (canaryFault?: unknown) => ({
  ...codeModeBody({ codeReview: codeReviewField({ deadlineMs: DEADLINE }) }),
  ...(canaryFault === undefined ? {} : { canaryFault }),
});

async function post(sent: unknown, limitMs = 900000): Promise<{ status: number; body: any; elapsedMs: number }> {
  const start = Date.now();
  let settled = false;
  const pending = POST({ json: async () => sent } as unknown as Request).then(async response => {
    settled = true;
    return { status: response.status, body: await response.json(), elapsedMs: Date.now() - start };
  });
  for (let waited = 0; !settled && waited < limitMs; waited += 1000) await jest.advanceTimersByTimeAsync(1000);
  return pending;
}

const calls = (model: string) => mockProviderCalls().filter(call => call.model === model);
const bytesOf = (result: { body: any }) => ({
  scores: result.body.scores,
  justification: result.body.justification,
  promptSha256: result.body.codeReview.promptSha256,
  reportSha256: result.body.codeReview.reportSha256,
  prompts: mockProviderCalls().map(call => ({ model: call.model, prompt: call.prompt })),
});

beforeEach(() => {
  KEYS.forEach(key => { saved[key] = env[key]; });
  env[MOCK_PROVIDER_FLAG] = '1';
  env.JUSTIFIER_MODEL = `mock:${JUSTIFIER}`;
  delete env.AI_WEB_ACCESS;
  delete env[CANARY_FAULT_KEY_ENV];
  script();
  resetMockProvider();
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  KEYS.forEach(key => { if (saved[key] === undefined) delete env[key]; else env[key] = saved[key]; });
});

describe('off: no key on this node', () => {
  test('a well-signed directive from anyone does nothing: no hold, the normal answer, and it says off', async () => {
    const result = await post(body(directive('hold-juror-answer')));
    expect(result.status).toBe(200);
    expect(result.elapsedMs).toBeLessThan(5000);
    expect(result.body.codeReview.canaryFault).toEqual({ state: 'off', action: null });
  }, 20000);

  test('no directive: it says off too, and everything else is as before', async () => {
    const result = await post(body());
    expect(result.status).toBe(200);
    expect(result.body.codeReview.canaryFault).toEqual({ state: 'off', action: null });
  }, 20000);
});

describe('armed: a key on this node', () => {
  beforeEach(() => { env[CANARY_FAULT_KEY_ENV] = KEY; });

  test('no directive: no hold', async () => {
    const result = await post(body());
    expect(result.elapsedMs).toBeLessThan(5000);
    expect(result.body.codeReview.canaryFault).toEqual({ state: 'armed', action: null });
  }, 20000);

  test.each<[string, unknown]>([
    ['another key', directive('hold-juror-answer', `${KEY}x`)],
    ['no MAC', { action: 'hold-juror-answer' }],
    ['a directive for another claim', { action: 'hold-juror-answer', mac: directiveMac(KEY, 'hold-juror-answer', 'QmOther', codeReviewField().reportSha256) }],
    ['junk', 'hold-juror-answer'],
  ])('a direct POST with %s: no hold, the normal answer', async (_name, raw) => {
    const result = await post(body(raw));
    expect(result.status).toBe(200);
    expect(result.elapsedMs).toBeLessThan(5000);
    expect(result.body.codeReview.canaryFault).toEqual({ state: 'armed', action: null });
  }, 20000);

  test('hold-juror-answer: the first juror finishes just under its limit, the justifier follows with its whole reserve', async () => {
    script({ [GEMINI]: { scores: HIGH, delayMs: 20000 } });
    const result = await post(body(directive('hold-juror-answer')));
    expect(result.status).toBe(200);
    expect(result.body.codeReview.canaryFault).toMatchObject({ state: 'armed', action: 'hold-juror-answer' });
    const first = result.body.model_results.find((m: any) => m.model === GEMINI);
    expect(first.status).toBe('success');
    expect(first.duration_ms).toBeGreaterThanOrEqual(JURY_MS - 6000);
    expect(first.duration_ms).toBeLessThan(JURY_MS);
    const other = result.body.model_results.find((m: any) => m.model === LUNA);
    expect(other.duration_ms).toBeLessThan(5000);
    expect(calls(JUSTIFIER)).toHaveLength(1);
    expect(result.elapsedMs).toBeLessThan(600000);
  }, 20000);

  test('a juror that takes longer than the hold is not held further', async () => {
    script({ [GEMINI]: { scores: HIGH, delayMs: JURY_MS - 3000 } });
    const result = await post(body(directive('hold-juror-answer')));
    expect(result.status).toBe(200);
    const first = result.body.model_results.find((m: any) => m.model === GEMINI);
    expect(first.duration_ms).toBeLessThan(JURY_MS - 1500);
  }, 20000);

  test('late-juror: the real call is on the wire when the deadline aborts it, the retryable 503 of a real timeout', async () => {
    script({ [GEMINI]: { scores: HIGH, delayMs: 30000 } });
    const result = await post(body(directive('late-juror')));
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ errorCode: 'CODE_REVIEW_JUROR_TIMEOUT', retryable: true, scores: [], justification: '' });
    expect(result.body.canaryFault).toEqual({ state: 'armed', action: 'late-juror' });
    expect(result.elapsedMs).toBeLessThanOrEqual(JURY_MS + 1000);
    const [call] = calls(GEMINI);
    expect(call.outcome).toBe('aborted');
    expect(call.signalAborted).toBe(true);
    expect(call.startedAt).toBeGreaterThanOrEqual(JURY_MS - 4000);
    expect(calls(JUSTIFIER)).toHaveLength(0);
  }, 20000);

  test('late-juror against a provider faster than three seconds: still the deadline, so the timeout is forced', async () => {
    const result = await post(body(directive('late-juror')));
    expect(result.status).toBe(503);
    expect(result.body.errorCode).toBe('CODE_REVIEW_JUROR_TIMEOUT');
    expect(calls(JUSTIFIER)).toHaveLength(0);
  }, 20000);

  test('a timeout the switch did not cause says so: no action, whatever the state', async () => {
    script({ [GEMINI]: { hang: true } });
    const result = await post(body());
    expect(result.status).toBe(503);
    expect(result.body.errorCode).toBe('CODE_REVIEW_JUROR_TIMEOUT');
    expect(result.body.canaryFault).toEqual({ state: 'armed', action: null });
    const mismatched = await post(body(directive('late-juror', `${KEY}x`)));
    expect(mismatched.status).toBe(503);
    expect(mismatched.body.canaryFault).toEqual({ state: 'armed', action: null });
  }, 20000);

  test('then the retry, with no directive, gives the verdict', async () => {
    const first = await post(body(directive('late-juror')));
    expect(first.status).toBe(503);
    const second = await post(body());
    expect(second.status).toBe(200);
    expect(second.body.codeReview.canaryFault).toEqual({ state: 'armed', action: null });
  }, 20000);

  test('hold-justifier-answer: the real justification, just under its reserve', async () => {
    const result = await post(body(directive('hold-justifier-answer')));
    expect(result.status).toBe(200);
    expect(result.body.justification).toBe('The panel finds a HIGH reentrancy in Vault.withdraw.');
    const stamp = result.body.codeReview.canaryFault;
    expect(stamp.action).toBe('hold-justifier-answer');
    expect(stamp.justifierMs).toBeGreaterThanOrEqual(39000);
    expect(stamp.justifierMs).toBeLessThan(45000);
  }, 20000);

  test('the holds cannot pass a stage\'s deadline: a deadline that leaves little still answers by it', async () => {
    const field = codeReviewField({ deadlineMs: 57000 });
    const mac = directiveMac(KEY, 'hold-juror-answer', field.claim.bcid, field.reportSha256);
    const result = await post({ ...codeModeBody({ codeReview: field }), canaryFault: { action: 'hold-juror-answer', mac } });
    expect(result.status).toBe(200);
    expect(result.elapsedMs).toBeLessThanOrEqual(57000);
  }, 20000);
});

// Node A13: the retry the EA sends after a timed-out first attempt, with the deadline it then
// tells (external-adapter/src/codeReview/claimRun.js: what is left of 780 s from its receipt).
// The juror delays are the evaluation panel's measured answers, Gemini 4 Argon's p95 (211 s) and
// slowest (262 s), and GPT-6 Luna's slowest (145 s); the mock stands in for both.
describe('armed: the retry after a timed-out first attempt', () => {
  const EA_DEADLINE = 780000;
  const RUNNER_MS = 30000;
  const at = (deadlineMs: number, canaryFault?: unknown) => ({
    ...codeModeBody({ codeReview: codeReviewField({ deadlineMs }) }),
    ...(canaryFault === undefined ? {} : { canaryFault }),
  });
  const slowPanel = (firstMs: number) => script({ [GEMINI]: { scores: HIGH, delayMs: firstMs }, [LUNA]: { scores: MEDIUM, delayMs: 145000 } });

  beforeEach(() => { env[CANARY_FAULT_KEY_ENV] = KEY; });

  test('provider-timeout\'s first attempt, told 105 s: every juror call cancelled at its 60 s jury deadline, the first on the wire, the retryable 503', async () => {
    script({ [GEMINI]: { scores: HIGH, delayMs: 30000 }, [LUNA]: { scores: MEDIUM, delayMs: 121000 } });
    const t0 = Date.now();
    const first = await post(at(105000, directive('late-juror')));
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ errorCode: 'CODE_REVIEW_JUROR_TIMEOUT', retryable: true, canaryFault: { state: 'armed', action: 'late-juror' } });
    expect(first.body.error).toMatch(/within the 60000 ms/);
    expect(first.elapsedMs).toBeLessThanOrEqual(61000);
    const [late] = calls(GEMINI);
    expect(late.outcome).toBe('aborted');
    expect(late.startedAt - t0).toBeGreaterThanOrEqual(56000);
    expect(calls(LUNA)[0].outcome).toBe('aborted');
    expect(calls(JUSTIFIER)).toHaveLength(0);
  }, 30000);

  test('then the retry, told what is left after a 30 s runner and that minute, has the whole 480 s: the slowest measured answer, 262 s, gives the verdict', async () => {
    const first = await post(at(105000, directive('late-juror')));
    expect(first.status).toBe(503);
    slowPanel(262000);
    const retry = await post(at(EA_DEADLINE - RUNNER_MS - first.elapsedMs));
    expect(retry.status).toBe(200);
    expect(retry.body.codeReview.jurorTimeoutMs).toBe(JURY_MS);
    expect(retry.body.codeReview.canaryFault).toEqual({ state: 'armed', action: null });
    expect(retry.body.model_results.find((m: any) => m.model === GEMINI).duration_ms).toBeGreaterThanOrEqual(262000);
  }, 30000);

  test.each<[number, number, number]>([
    [30000, 262000, 225000],
    [60000, 211000, 195000],
  ])('after a first attempt at the cap, a runner of %i ms leaves the retry 255 s less the runner: a %i ms answer misses its %i ms', async (runnerMs, answerMs, retryJuryMs) => {
    const first = await post(at(EA_DEADLINE - runnerMs, directive('late-juror')));
    expect(first.status).toBe(503);
    expect(first.body.error).toMatch(new RegExp(`within the ${JURY_MS} ms`));
    expect(first.elapsedMs).toBeGreaterThanOrEqual(JURY_MS);
    slowPanel(answerMs);
    const retry = await post(at(EA_DEADLINE - runnerMs - JURY_MS));
    expect(retry.status).toBe(503);
    expect(retry.body.errorCode).toBe('CODE_REVIEW_JUROR_TIMEOUT');
    expect(retry.body.error).toMatch(new RegExp(`within the ${retryJuryMs} ms`));
    expect(retry.body.canaryFault).toEqual({ state: 'armed', action: null });
  }, 30000);
});

describe('it changes nothing that settles', () => {
  test.each(['hold-juror-answer', 'hold-justifier-answer'])('%s: scores, justification, prompt hash and every provider prompt are the same bytes', async (action) => {
    env[CANARY_FAULT_KEY_ENV] = KEY;
    const plain = bytesOf(await post(body()));
    resetMockProvider();
    const held = bytesOf(await post(body(directive(action))));
    expect(held).toEqual(plain);
  }, 20000);

  test('a retry after late-juror gives the same bytes as no fault at all', async () => {
    env[CANARY_FAULT_KEY_ENV] = KEY;
    const plain = bytesOf(await post(body()));
    await post(body(directive('late-juror')));
    resetMockProvider();
    const retried = bytesOf(await post(body()));
    expect(retried).toEqual(plain);
  }, 20000);

  test('the directive reaches no prompt', async () => {
    env[CANARY_FAULT_KEY_ENV] = KEY;
    const sent = directive('hold-juror-answer');
    await post(body(sent));
    for (const call of mockProviderCalls()) {
      expect(call.prompt).not.toContain(sent.mac);
      expect(call.prompt).not.toContain('canary');
    }
  }, 20000);
});

describe('the key reaches no log, prompt, response or health route', () => {
  // Made here, per run: no key-shaped literal sits in the tests.
  const SECRET = crypto.randomBytes(32).toString('hex');
  const spoken = () => JSON.stringify([console.log, console.warn, console.error].flatMap(spy => (spy as unknown as jest.Mock).mock.calls));
  const signed = (action: string) => directive(action, SECRET);

  beforeEach(() => { env[CANARY_FAULT_KEY_ENV] = SECRET; });

  test.each<[string, () => unknown, number]>([
    ['no directive', () => undefined, 200],
    ['a directive under another key', () => directive('hold-juror-answer', KEY), 200],
    ['hold-juror-answer', () => signed('hold-juror-answer'), 200],
    ['hold-justifier-answer', () => signed('hold-justifier-answer'), 200],
    ['late-juror, which ends in the 503', () => signed('late-juror'), 503],
  ])('%s', async (_name, sent, status) => {
    const result = await post(body(sent()));
    expect(result.status).toBe(status);
    expect(spoken().length).toBeGreaterThan(2);
    expect(spoken()).not.toContain(SECRET);
    expect(JSON.stringify(result.body)).not.toContain(SECRET);
    for (const call of mockProviderCalls()) expect(JSON.stringify(call)).not.toContain(SECRET);
  }, 20000);

  test('a response says what ran, and carries neither the key nor the MAC', async () => {
    const sent = signed('hold-justifier-answer');
    const result = await post(body(sent));
    expect(Object.keys(result.body.codeReview.canaryFault).sort()).toEqual(['action', 'justifierMs', 'state']);
    expect(JSON.stringify(result.body)).not.toContain(sent.mac);
  }, 20000);

  test.each<[string, string]>([
    ['a usable key', 'armed'],
    ['a key with a space in it', 'refused'],
  ])('GET /api/health with %s: the state alone', async (name, state) => {
    env[CANARY_FAULT_KEY_ENV] = name === 'a usable key' ? SECRET : `${SECRET} x`;
    const health = await (await GET()).json();
    expect(health.canary_fault).toEqual({ state });
    expect(JSON.stringify(health)).not.toContain(SECRET);
    expect(spoken()).not.toContain(SECRET);
  });
});

describe('the text-mode route', () => {
  test('a text-mode request carrying a directive is a text-mode request: no hold, no code mode', async () => {
    env[CANARY_FAULT_KEY_ENV] = KEY;
    const { codeReview: _ignored, ...text } = codeModeBody();
    const result = await post({ ...text, outcomes: ['Yes', 'No'], models: [{ provider: 'mock', model: GEMINI, weight: 1, count: 1 }], canaryFault: directive('hold-juror-answer') });
    expect(result.elapsedMs).toBeLessThan(60000);
    expect(result.body.codeReview).toBeUndefined();
  }, 20000);
});

describe('GET /api/health', () => {
  test.each<[string | undefined, string]>([[undefined, 'off'], [KEY, 'armed'], ['short', 'refused']])('key %s: %s, and never the key', async (key, state) => {
    if (key === undefined) delete env[CANARY_FAULT_KEY_ENV];
    else env[CANARY_FAULT_KEY_ENV] = key;
    const response = await GET();
    const health = await response.json();
    expect(health.canary_fault).toEqual({ state });
    expect(JSON.stringify(health)).not.toContain(KEY);
  });
});
