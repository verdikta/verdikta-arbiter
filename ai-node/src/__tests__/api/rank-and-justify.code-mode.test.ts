/**
 * rank-and-justify in code mode (design §10.3, §10.5, §11; build plan A3, A5).
 *
 * Every provider is the deterministic mock provider (test-only flag), so these
 * tests drive the real route, the real factory and the real timers' logic under
 * jest's fake clock: a juror "taking 239 s" costs no wall time.
 */
import { codeReview } from '@verdikta/common';
import { POST } from '../../app/api/rank-and-justify/route';
import { prePromptConfig } from '../../config/prePromptConfig';
import { MOCK_PROVIDER_FLAG, MOCK_SCRIPT_ENV, mockProviderCalls, resetMockProvider } from '../../lib/llm/mock-provider';
import { JUSTIFIER_RESERVE_MS } from '../../lib/code-review/deadline';
import { codeModeBody, codeReviewField, jurorReply, validReport } from '../../../test-support/code-review-fixtures';

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((data, options) => ({
      status: options?.status || 200,
      json: async () => data,
    })),
  },
}));

const env = process.env as Record<string, string | undefined>;
const KEYS = [MOCK_PROVIDER_FLAG, MOCK_SCRIPT_ENV, 'JUSTIFIER_MODEL', 'AI_WEB_ACCESS'];
const saved: Record<string, string | undefined> = {};

const SONNET = 'claude-sonnet-5-5';
const DEEPSEEK = 'deepseek/deepseek-v4-pro-0813';
const JUSTIFIER = 'mock-justifier';
const HIGH = [0, 0, 0, 0, 1000000, 0];
const MEDIUM = [0, 0, 0, 1000000, 0, 0];

function script(entries: Record<string, unknown>) {
  env[MOCK_SCRIPT_ENV] = JSON.stringify({
    [JUSTIFIER]: { reply: 'The panel finds a HIGH reentrancy in Vault.withdraw.' },
    ...entries,
  });
}

function request(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

/** POST the body and run the fake clock forward until the route answers (or `limitMs` passes). */
async function post(body: unknown, limitMs = 900000): Promise<{ status: number; body: any; elapsedMs: number }> {
  const start = Date.now();
  let settled = false;
  const pending = POST(request(body)).then(async response => {
    settled = true;
    return { status: response.status, body: await response.json(), elapsedMs: Date.now() - start };
  });
  for (let waited = 0; !settled && waited < limitMs; waited += 1000) {
    await jest.advanceTimersByTimeAsync(1000);
  }
  return pending;
}

const calls = (model: string) => mockProviderCalls().filter(call => call.model === model);

beforeEach(() => {
  KEYS.forEach(key => { saved[key] = env[key]; });
  env[MOCK_PROVIDER_FLAG] = '1';
  env.JUSTIFIER_MODEL = `mock:${JUSTIFIER}`;
  delete env.AI_WEB_ACCESS;
  script({ [SONNET]: { scores: HIGH }, [DEEPSEEK]: { scores: MEDIUM } });
  resetMockProvider();
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  // process.env turns undefined into the string "undefined": delete instead
  KEYS.forEach(key => { if (saved[key] === undefined) delete env[key]; else env[key] = saved[key]; });
});

describe('code mode: the optional codeReview field', () => {
  test('a valid codeReview field runs code mode: six outcomes, both jurors, the weighted vector', async () => {
    const result = await post(codeModeBody());
    expect(result.status).toBe(200);
    expect(result.body.scores.map((s: any) => s.outcome)).toEqual([...codeReview.BUG_OUTCOMES]);
    expect(result.body.scores.map((s: any) => s.score)).toEqual([0, 0, 0, 500000, 500000, 0]);
    expect(result.body.justification).toBe('The panel finds a HIGH reentrancy in Vault.withdraw.');
    expect(result.body.model_results.map((m: any) => m.status)).toEqual(['success', 'success']);
    expect(result.body.codeReview).toMatchObject({ codeClass: 'code-standard', reportSha256: codeReviewField().reportSha256 });
    expect(calls(SONNET)[0].prompt).toContain('<<<BEGIN QUERY');
  }, 20000);

  test('the field is validated with common\'s validateCodeReviewRequest: a hash mismatch is a 400 before any model is called', async () => {
    const result = await post(codeModeBody({ codeReview: codeReviewField({ reportSha256: 'f'.repeat(64) }) }));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ errorCode: 'CODE_REVIEW_INVALID', retryable: false, scores: [], justification: '' });
    expect(result.body.issues.map((i: any) => i.code)).toContain('REQUEST_REPORT_HASH_MISMATCH');
    expect(mockProviderCalls()).toHaveLength(0);
  }, 20000);

  test('a schema violation (deadline above the 840 s job timeout) is refused', async () => {
    const result = await post(codeModeBody({ codeReview: codeReviewField({ deadlineMs: 900000 }) }));
    expect(result.status).toBe(400);
    expect(result.body.errorCode).toBe('CODE_REVIEW_INVALID');
    expect(mockProviderCalls()).toHaveLength(0);
  }, 20000);

  test('a disclosure line left in the prompt is refused: the keys never reach a model', async () => {
    const prompt = `${codeModeBody().prompt}\nverdikta-disclosure: 0x${'a'.repeat(64)} 0x${'b'.repeat(64)} Qm 0x${'c'.repeat(32)} 0x${'d'.repeat(64)}`;
    const result = await post(codeModeBody({ prompt }));
    expect(result.status).toBe(400);
    expect(result.body.errorCode).toBe('CODE_REVIEW_INVALID');
    expect(mockProviderCalls()).toHaveLength(0);
  }, 20000);

  test('codeReview: null is code mode, and invalid', async () => {
    const result = await post(codeModeBody({ codeReview: null as any }));
    expect(result.status).toBe(400);
    expect(result.body.errorCode).toBe('CODE_REVIEW_INVALID');
  }, 20000);

  test('without codeReview, text mode runs unchanged: its own pre-prompt, no deadline, no code-mode controls', async () => {
    script({ 'gpt-4o': { scores: [600000, 400000] } });
    const result = await post({ prompt: 'Is the sky blue?', outcomes: ['Yes', 'No'], models: [{ provider: 'OpenAI', model: 'gpt-4o', weight: 1 }] });
    expect(result.status).toBe(200);
    expect(result.body.codeReview).toBeUndefined();
    const [juror] = calls('gpt-4o');
    expect(juror.prompt.startsWith(prePromptConfig.getPrompt(['Yes', 'No']))).toBe(true);
    expect(juror.options).toEqual({ webAccess: undefined, maxTokens: undefined, effort: undefined, signal: false });
  }, 20000);
});

describe('code mode: the class envelope', () => {
  test('outcomes other than the six claim outcomes are refused', async () => {
    const result = await post(codeModeBody({ outcomes: ['Yes', 'No'] }));
    expect(result.status).toBe(400);
    expect(result.body.errorCode).toBe('CODE_REVIEW_ENVELOPE');
    expect(mockProviderCalls()).toHaveLength(0);
  }, 20000);

  test('a model outside the class pool is refused before any model is called', async () => {
    const result = await post(codeModeBody({ models: [{ provider: 'OpenAI', model: 'gpt-4o', weight: 1 }] }));
    expect(result.status).toBe(400);
    expect(result.body.errorCode).toBe('CODE_REVIEW_ENVELOPE');
    expect(result.body.issues.map((i: any) => i.code)).toContain('ENVELOPE_MODEL_NOT_IN_POOL');
    expect(mockProviderCalls()).toHaveLength(0);
  }, 20000);

  test('iterations are capped by the envelope: ITERATIONS 2 is refused', async () => {
    const result = await post(codeModeBody({ iterations: 2 }));
    expect(result.status).toBe(400);
    expect(result.body.issues.map((i: any) => i.code)).toContain('ENVELOPE_ITERATIONS');
    expect(mockProviderCalls()).toHaveLength(0);
  }, 20000);

  test('NO_COUNTS above the envelope is refused', async () => {
    const result = await post(codeModeBody({ models: [{ provider: 'anthropic', model: SONNET, weight: 1, count: 2 }] }));
    expect(result.status).toBe(400);
    expect(result.body.issues.map((i: any) => i.code)).toContain('ENVELOPE_NO_COUNTS');
  }, 20000);

  test('a non-text attachment is refused: the pack is text', async () => {
    const result = await post(codeModeBody({ attachments: ['data:image/png;base64,iVBORw0KGgo='], attachmentNames: ['shot.png'] }));
    expect(result.status).toBe(400);
    expect(result.body.errorCode).toBe('CODE_REVIEW_ATTACHMENT');
    expect(mockProviderCalls()).toHaveLength(0);
  }, 20000);

  test('a text data: URI attachment is decoded into the pack', async () => {
    const text = '# report.md\nThe vault drains.';
    const result = await post(codeModeBody({
      attachments: [`data:text/markdown;base64,${Buffer.from(text).toString('base64')}`],
      attachmentNames: ['report.md'],
    }));
    expect(result.status).toBe(200);
    expect(calls(SONNET)[0].prompt).toContain(`\n${text}\n<<<END DATA`);
  }, 20000);

  test('each juror\'s maxTokens comes from the envelope: 8,000 on code-standard, 12,000 on code-premium', async () => {
    await post(codeModeBody());
    expect(calls(SONNET)[0].options.maxTokens).toBe(codeReview.CODE_CLASSES['code-standard'].envelope.jurorOutputTokens);
    expect(calls(DEEPSEEK)[0].options.maxTokens).toBe(8000);

    resetMockProvider();
    script({ 'claude-opus-5-5': { scores: HIGH }, 'gpt-6-astra': { scores: HIGH } });
    const premium = await post(codeModeBody({
      codeReview: codeReviewField({ codeClass: 'code-premium' }),
      models: [
        { provider: 'anthropic', model: 'claude-opus-5-5', weight: 0.5, count: 1 },
        { provider: 'openai', model: 'gpt-6-astra', weight: 0.5, count: 1 },
      ],
    }));
    expect(premium.status).toBe(200);
    expect(calls('claude-opus-5-5')[0].options.maxTokens).toBe(12000);
  }, 20000);
});

describe('code mode: web access off, effort high', () => {
  test('every juror gets webAccess false and effort high, even with AI_WEB_ACCESS=always and a URL in the pack', async () => {
    env.AI_WEB_ACCESS = 'always';
    const result = await post(codeModeBody({ attachments: ['See https://github.com/acme/vault/blob/main/contracts/Vault.sol#L88'] }));
    expect(result.status).toBe(200);
    for (const model of [SONNET, DEEPSEEK]) {
      expect(calls(model)[0].options).toMatchObject({ webAccess: false, effort: 'high', signal: true });
    }
    expect(calls(JUSTIFIER)[0].options.webAccess).toBe(false);
  }, 20000);
});

describe('code mode: every juror is required (no Jev in the MVP)', () => {
  test('one juror\'s provider error fails the request with the non-retryable 400, and the other juror is cancelled', async () => {
    script({ [SONNET]: { error: 'simulated overload', status: 529, delayMs: 2000 }, [DEEPSEEK]: { hang: true } });
    const result = await post(codeModeBody());
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ errorCode: 'CODE_REVIEW_JUROR_FAILED', retryable: false, scores: [], justification: '' });
    expect(result.elapsedMs).toBeLessThan(10000);
    expect(calls(DEEPSEEK)[0].outcome).toBe('aborted');
    expect(calls(JUSTIFIER)).toHaveLength(0);
  }, 20000);

  test('a vector with a negative component is not an answer: repair, then failure', async () => {
    script({ [SONNET]: { scores: [-500000, 1500000, 0, 0, 0, 0] }, [DEEPSEEK]: { scores: MEDIUM } });
    const result = await post(codeModeBody());
    expect(result.status).toBe(400);
    expect(result.body.errorCode).toBe('CODE_REVIEW_JUROR_FAILED');
    expect(calls(SONNET)).toHaveLength(2);
  }, 20000);

  test('a juror whose reply cannot be parsed, even after the repair call, fails the request', async () => {
    script({ [SONNET]: { reply: 'I cannot decide.' }, [DEEPSEEK]: { scores: MEDIUM } });
    const result = await post(codeModeBody());
    expect(result.status).toBe(400);
    expect(result.body.errorCode).toBe('CODE_REVIEW_JUROR_FAILED');
    expect(calls(SONNET)).toHaveLength(2); // the reply and one repair call
  }, 20000);

  test('a reply repaired once counts as the juror\'s answer; the repair call has the same signal, no web, the envelope tokens', async () => {
    script({ [SONNET]: [{ reply: 'FINAL SCORES: HIGH=100' }, { reply: '{"score": [0, 0, 0, 0, 100, 0]}' }], [DEEPSEEK]: { scores: HIGH } });
    const result = await post(codeModeBody());
    expect(result.status).toBe(200);
    expect(result.body.scores.map((s: any) => s.score)).toEqual(HIGH);
    const repair = calls(SONNET)[1];
    expect(repair.options).toEqual({ webAccess: false, maxTokens: 8000, effort: 'low', signal: true });
    expect(repair.prompt).toContain('<<<BEGIN DATA');
    expect(repair.prompt).not.toContain('=== END OF REPLY ===');
  }, 20000);

  test('a repair call still running at the deadline is cancelled like the juror', async () => {
    script({ [SONNET]: [{ reply: 'prose only' }, { hang: true }], [DEEPSEEK]: { scores: HIGH } });
    const result = await post(codeModeBody({ codeReview: codeReviewField({ deadlineMs: 100000 }) }));
    expect(result.status).toBe(503);
    expect(calls(SONNET)[1]).toMatchObject({ outcome: 'aborted', signalAborted: true });
  }, 20000);

  test('a juror timeout is the distinct retryable 503, and every juror call is aborted', async () => {
    script({ [SONNET]: { hang: true }, [DEEPSEEK]: { scores: MEDIUM } });
    const result = await post(codeModeBody({ codeReview: codeReviewField({ deadlineMs: 100000 }) }));
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ errorCode: 'CODE_REVIEW_JUROR_TIMEOUT', retryable: true, scores: [], justification: '' });
    expect(result.elapsedMs).toBe(100000 - JUSTIFIER_RESERVE_MS);
    expect(calls(SONNET)[0].outcome).toBe('aborted');
    expect(calls(SONNET)[0].signalAborted).toBe(true);
    expect(calls(JUSTIFIER)).toHaveLength(0);
  }, 20000);

  test('the timeout body is not mistaken for a provider error by the EA\'s retry check', async () => {
    script({ [SONNET]: { hang: true }, [DEEPSEEK]: { hang: true } });
    const result = await post(codeModeBody({ codeReview: codeReviewField({ deadlineMs: 100000 }) }));
    const text = JSON.stringify(result.body).toLowerCase();
    // external-adapter/src/services/aiClient.js stops retrying on this pattern
    expect(text.includes('provider') && /invalid|not found|unknown/.test(text)).toBe(false);
  }, 20000);
});

describe('code mode: deadline and cancellation (§11)', () => {
  test('the juror timeout is deadlineMs less the 45 s justifier reserve', async () => {
    script({ [SONNET]: { scores: HIGH, delayMs: 54000 }, [DEEPSEEK]: { scores: HIGH } });
    const result = await post(codeModeBody({ codeReview: codeReviewField({ deadlineMs: 100000 }) }));
    expect(result.status).toBe(200);
    expect(result.body.codeReview).toMatchObject({ deadlineMs: 100000, jurorTimeoutMs: 55000, justifierReserveMs: 45000 });
  }, 20000);

  test('a juror one second past the derived timeout is cancelled at it', async () => {
    script({ [SONNET]: { scores: HIGH, delayMs: 56000 }, [DEEPSEEK]: { scores: HIGH } });
    const result = await post(codeModeBody({ codeReview: codeReviewField({ deadlineMs: 100000 }) }));
    expect(result.status).toBe(503);
    expect(result.elapsedMs).toBe(55000);
  }, 20000);

  test('the juror timeout is capped at the 240 s jury budget on a far deadline', async () => {
    script({ [SONNET]: { hang: true }, [DEEPSEEK]: { scores: HIGH } });
    const result = await post(codeModeBody({ codeReview: codeReviewField({ deadlineMs: 840000 }) }));
    expect(result.status).toBe(503);
    expect(result.elapsedMs).toBe(240000);
  }, 20000);

  test('a deadline with no room for the jury after the justifier reserve is refused at once, no model called', async () => {
    const result = await post(codeModeBody({ codeReview: codeReviewField({ deadlineMs: 50000 }) }));
    expect(result.status).toBe(504);
    expect(result.body).toMatchObject({ errorCode: 'CODE_REVIEW_DEADLINE', retryable: false });
    expect(mockProviderCalls()).toHaveLength(0);
  }, 20000);

  test('jurors are cancelled with AbortController at the deadline: the provider\'s signal fires', async () => {
    script({ [SONNET]: { hang: true }, [DEEPSEEK]: { hang: true } });
    await post(codeModeBody({ codeReview: codeReviewField({ deadlineMs: 120000 }) }));
    for (const model of [SONNET, DEEPSEEK]) {
      expect(calls(model)[0]).toMatchObject({ outcome: 'aborted', signalAborted: true });
      expect(calls(model)[0].endedAt! - calls(model)[0].startedAt).toBeLessThanOrEqual(75000);
    }
  }, 20000);
});

describe('catalogue fixtures (common data/code-review-fixtures.v1.json)', () => {
  test('juror-just-under-limit-then-justification: the slowest juror answers just inside its timeout and the request still completes inside the §11 budget', async () => {
    const deadlineMs = 240000 + JUSTIFIER_RESERVE_MS; // the §11 jury + justifier budget
    script({
      [SONNET]: { scores: HIGH, delayMs: 239000 },
      [DEEPSEEK]: { scores: HIGH, delayMs: 1000 },
      [JUSTIFIER]: { reply: 'Both jurors find a HIGH reentrancy.', delayMs: 44000 },
    });
    const result = await post(codeModeBody({ codeReview: codeReviewField({ deadlineMs }) }));
    expect(result.status).toBe(200);
    expect(result.body.justification).toBe('Both jurors find a HIGH reentrancy.');
    expect(result.body.scores.map((s: any) => s.score)).toEqual(HIGH);
    expect(result.elapsedMs).toBeLessThanOrEqual(deadlineMs);
    expect(calls(JUSTIFIER)[0].outcome).toBe('answered');
  }, 20000);

  test('slow-justifier: a justifier that approaches its 45 s reserve still fits the budget', async () => {
    script({
      [SONNET]: { scores: HIGH, delayMs: 30000 },
      [DEEPSEEK]: { scores: HIGH },
      [JUSTIFIER]: { reply: 'A careful justification.', delayMs: JUSTIFIER_RESERVE_MS - 1000 },
    });
    const result = await post(codeModeBody({ codeReview: codeReviewField({ deadlineMs: 300000 }) }));
    expect(result.status).toBe(200);
    expect(result.body.justification).toBe('A careful justification.');
    expect(result.elapsedMs).toBeLessThanOrEqual(30000 + JUSTIFIER_RESERVE_MS);
  }, 20000);

  test('slow-justifier: a justifier past its reserve is cancelled and the arbiter abstains, never with a partial justification', async () => {
    script({
      [SONNET]: { scores: HIGH, justification: 'Juror text that must not be published alone.' },
      [DEEPSEEK]: { scores: HIGH },
      [JUSTIFIER]: { hang: true },
    });
    const result = await post(codeModeBody({ codeReview: codeReviewField({ deadlineMs: 300000 }) }));
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ errorCode: 'CODE_REVIEW_JUSTIFIER_TIMEOUT', scores: [], justification: '' });
    expect(JSON.stringify(result.body)).not.toContain('must not be published');
    expect(result.elapsedMs).toBeLessThanOrEqual(JUSTIFIER_RESERVE_MS + 1000);
    expect(calls(JUSTIFIER)[0]).toMatchObject({ outcome: 'aborted', signalAborted: true });
  }, 20000);

  test('slow-justifier: after a juror at its limit, a justifier slower than its reserve is cancelled before the deadline', async () => {
    const deadlineMs = 240000 + JUSTIFIER_RESERVE_MS;
    script({
      [SONNET]: { scores: HIGH, delayMs: 239000 },
      [DEEPSEEK]: { scores: HIGH },
      [JUSTIFIER]: { reply: 'Too late.', delayMs: 46000 },
    });
    const result = await post(codeModeBody({ codeReview: codeReviewField({ deadlineMs }) }));
    expect(result.status).toBe(503);
    expect(result.body.justification).toBe('');
    expect(result.elapsedMs).toBeLessThanOrEqual(deadlineMs);
  }, 20000);

  test('slow-justifier: a justifier error abstains rather than publishing the jurors\' answers', async () => {
    script({ [SONNET]: { scores: HIGH }, [DEEPSEEK]: { scores: HIGH }, [JUSTIFIER]: { error: 'justifier overloaded', status: 529 } });
    const result = await post(codeModeBody());
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ errorCode: 'CODE_REVIEW_JUSTIFIER_FAILED', retryable: false, justification: '' });
  }, 20000);
});

describe('code mode: the report the jury reads', () => {
  test('every juror reads the same bytes: the claim pre-prompt with the canonical report', async () => {
    const report = validReport();
    await post(codeModeBody({ codeReview: codeReviewField({ report, reportSha256: codeReview.reportSha256(report) }) }));
    const [a] = calls(SONNET);
    const [b] = calls(DEEPSEEK);
    expect(a.prompt).toBe(b.prompt);
    expect(a.prompt).toContain(codeReview.canonicalReportJson(report));
    expect(jurorReply(HIGH)).toContain('score');
  }, 20000);
});
