/**
 * @jest-environment node
 *
 * Every juror answers, or the arbiter does not (utils/juryQuorum.ts).
 *
 * Until 2026-11 half the jury was enough, so a two-model jury was answered by one model
 * when the other failed, and the arbiter committed that model's scores as the jury's. Each
 * way a juror failed in a month of bounty records (20 October to 21 November 2026, 12 of
 * 314 two-juror evaluations) is replayed here through the real route: a provider that
 * refused the operator's key, a provider at its usage limit, a juror that did not answer in
 * time, a reply that could not be read. Each is now the 400 on which the External Adapter
 * commits nothing, and the justifier is never asked to explain half a jury.
 *
 * MIN_SUCCESSFUL_MODELS_PERCENT stays the operator's override; the tests of what a
 * response says about a failed juror run with it (test-support/jury-quorum.ts).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { POST } from '../../app/api/rank-and-justify/route';
import { LLMFactory } from '../../lib/llm/llm-factory';
import { DEFAULT_MIN_SUCCESSFUL_MODELS_PERCENT, minSuccessfulModelsPercent, requiredJurors } from '../../utils/juryQuorum';
import { allowPartialJury } from '../../../test-support/jury-quorum';

jest.mock('../../lib/llm/llm-factory');
// Authentication is covered through the real handlers in service-auth.test.ts.
jest.mock('../../lib/service-auth', () => ({ requireServiceAuth: () => null }));
jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((data, options) => ({
      status: options?.status || 200,
      json: async () => data,
    })),
  },
}));

jest.setTimeout(60_000);

const FUND = JSON.stringify({ score: [135000, 865000], justification: 'The work meets the rubric.' });
const DONT_FUND = JSON.stringify({ score: [1000000, 0], justification: 'A mandatory requirement failed.' });
const PROSE = 'I am unable to provide a score in the requested format.';

type Provider = { generateResponse: jest.Mock; supportsAttachments: () => boolean };
const answering = (reply: string): Provider => ({ generateResponse: jest.fn().mockResolvedValue(reply), supportsAttachments: () => false });
const failing = (error: () => Error): Provider => ({ generateResponse: jest.fn().mockImplementation(async () => { throw error(); }), supportsAttachments: () => false });
const hanging = (): Provider => ({ generateResponse: jest.fn(() => new Promise(() => {})), supportsAttachments: () => false });

const refusedKey = () => Object.assign(new Error('401 Incorrect API key provided'), { status: 401, code: 'invalid_api_key' });
// Anthropic's answer to an account at its usage limit, as six records of 30 October have it.
const usageLimit = () => Object.assign(new Error('400 You have reached your specified API usage limits'), { status: 400 });

const GPT = { provider: 'OpenAI', model: 'gpt-5.6-terra', weight: 0.5 };
const CLAUDE = { provider: 'Anthropic', model: 'claude-sonnet-5', weight: 0.5 };
const REQUEST = { prompt: 'Does the submission meet the rubric?', outcomes: ['DONT_FUND', 'FUND'], iterations: 1, models: [GPT, CLAUDE] };

let justifier: Provider;
function providers(byName: Record<string, Provider>) {
  justifier = answering('The justifier explains the result.');
  (LLMFactory.getProvider as jest.Mock).mockImplementation(async (name: string) => byName[name] ?? justifier);
}

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const response = await POST({ headers: new Headers(), json: async () => body } as unknown as Request);
  return { status: response.status, body: await response.json() };
}

let cwd: string;
let logged: { warn: jest.SpyInstance; error: jest.SpyInstance };
const lines = (spy: jest.SpyInstance): string[] => spy.mock.calls.map(args => String(args[0]));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.MIN_SUCCESSFUL_MODELS_PERCENT;
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-'));
  jest.spyOn(process, 'cwd').mockReturnValue(cwd);   // logs/ goes there
  jest.spyOn(console, 'log').mockImplementation(() => {});
  logged = {
    warn: jest.spyOn(console, 'warn').mockImplementation(() => {}),
    error: jest.spyOn(console, 'error').mockImplementation(() => {}),
  };
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  delete process.env.MIN_SUCCESSFUL_MODELS_PERCENT;
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('the share of jurors that must answer', () => {
  test('every juror, unless the operator says otherwise', () => {
    expect(DEFAULT_MIN_SUCCESSFUL_MODELS_PERCENT).toBe(1);
    expect(minSuccessfulModelsPercent(undefined)).toBe(1);
    expect(minSuccessfulModelsPercent('')).toBe(1);
    expect(minSuccessfulModelsPercent('  ')).toBe(1);
  });

  test('the operator\'s share is used as it is set', () => {
    expect(minSuccessfulModelsPercent('0.5')).toBe(0.5);
    expect(minSuccessfulModelsPercent('0.67')).toBe(0.67);
    expect(minSuccessfulModelsPercent('1')).toBe(1);
  });

  test.each(['half', '50%', 'NaN', 'Infinity'])('"%s" is not a share: every juror, and the log says so', (raw) => {
    expect(minSuccessfulModelsPercent(raw)).toBe(1);
    expect(lines(logged.warn)).toEqual(['⚠️ MIN_SUCCESSFUL_MODELS_PERCENT is not a number; every juror is required']);
  });

  test('a number outside the range is held to it', () => {
    expect(minSuccessfulModelsPercent('50')).toBe(1);
    expect(minSuccessfulModelsPercent('0')).toBe(0);
    expect(minSuccessfulModelsPercent('-1')).toBe(0);
  });

  test.each([
    [1, 1, 1], [2, 1, 2], [3, 1, 3], [5, 1, 5],
    [2, 0.5, 1], [3, 0.5, 2], [4, 0.5, 2], [5, 0.5, 3],
    [3, 0.67, 3], [3, 0.66, 2],
    // Never none: a share of 0 let a jury of no answers through.
    [1, 0, 1], [4, 0, 1],
  ])('of %i jurors at a share of %d, %i must answer', (jurors, share, required) => {
    expect(requiredJurors(jurors, share)).toBe(required);
  });
});

describe('by default, a jury that is not whole gives no answer', () => {
  test('a provider refused the key (bounty 398, submission 3): 400, no scores, and the justifier is never asked', async () => {
    providers({ OpenAI: failing(refusedKey), Anthropic: answering(FUND) });

    const { status, body } = await post(REQUEST);

    expect(status).toBe(400);
    expect(body).toEqual({
      error: 'Insufficient successful models: 1/2 (minimum required: 2). Failures: OpenAI-gpt-5.6-terra (401 Incorrect API key provided)',
      scores: [],
      justification: '',
    });
    expect(justifier.generateResponse).not.toHaveBeenCalled();
    expect(lines(logged.error)).toContain('❌ INSUFFICIENT_MODELS: Only 1/2 models succeeded (minimum: 2)');
  });

  test('the refusal is still on record for the doctor and the watchdog', async () => {
    providers({ OpenAI: failing(refusedKey), Anthropic: answering(FUND) });

    await post(REQUEST);

    expect(lines(logged.error).filter(line => line.includes('PROVIDER_AUTH_FAILED')))
      .toEqual(['🔑 PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-5.6-terra role=juror http_status=401']);
    expect(fs.readFileSync(path.join(cwd, 'logs', 'provider-auth.log'), 'utf8'))
      .toMatch(/^\S+ PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-5\.6-terra role=juror http_status=401\n$/);
  });

  test('a provider at its usage limit (HTTP 400)', async () => {
    providers({ OpenAI: answering(DONT_FUND), Anthropic: failing(usageLimit) });

    const { status, body } = await post(REQUEST);

    expect(status).toBe(400);
    expect(body.error).toBe('Insufficient successful models: 1/2 (minimum required: 2). Failures: Anthropic-claude-sonnet-5 (400 You have reached your specified API usage limits)');
    expect(body.scores).toEqual([]);
    expect(justifier.generateResponse).not.toHaveBeenCalled();
  });

  test('a juror that does not answer in time (bounty 398, submissions 1 and 2)', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    providers({ OpenAI: answering(DONT_FUND), Anthropic: hanging() });

    const pending = post(REQUEST);
    await jest.advanceTimersByTimeAsync(121000);
    const { status, body } = await pending;

    expect(status).toBe(400);
    expect(body.error).toBe('Insufficient successful models: 1/2 (minimum required: 2). Failures: Anthropic-claude-sonnet-5 (Model Anthropic-claude-sonnet-5 timed out after 120000ms)');
    expect(body.scores).toEqual([]);
    expect(justifier.generateResponse).not.toHaveBeenCalled();
  });

  test('a reply that cannot be read, after the repair call too', async () => {
    const claude = answering(PROSE);
    providers({ OpenAI: answering(DONT_FUND), Anthropic: claude });

    const { status, body } = await post(REQUEST);

    expect(status).toBe(400);
    expect(body.error).toBe(`Insufficient successful models: 1/2 (minimum required: 2). Failures: Anthropic-claude-sonnet-5 (Unable to parse response: ${PROSE})`);
    // The reply and one repair call, as before: the rule changes what a failure costs, not when a juror has failed.
    expect(claude.generateResponse).toHaveBeenCalledTimes(2);
    expect(justifier.generateResponse).not.toHaveBeenCalled();
  });

  test('three jurors, one of them failed: the two that answered are not the jury either', async () => {
    providers({ OpenAI: answering(DONT_FUND), Anthropic: answering(FUND), xAI: failing(refusedKey) });

    const { status, body } = await post({
      ...REQUEST,
      models: [{ ...GPT, weight: 0.4 }, { ...CLAUDE, weight: 0.4 }, { provider: 'xAI', model: 'grok-4', weight: 0.2 }],
    });

    expect(status).toBe(400);
    expect(body.error).toBe('Insufficient successful models: 2/3 (minimum required: 3). Failures: xAI-grok-4 (401 Incorrect API key provided)');
  });

  test('a juror that fails in a later iteration ends the request as well', async () => {
    const claude: Provider = {
      generateResponse: jest.fn().mockResolvedValueOnce(FUND).mockImplementation(async () => { throw usageLimit(); }),
      supportsAttachments: () => false,
    };
    providers({ OpenAI: answering(DONT_FUND), Anthropic: claude });

    const { status, body } = await post({ ...REQUEST, iterations: 2 });

    expect(status).toBe(400);
    expect(body.error).toContain('Insufficient successful models: 1/2 (minimum required: 2).');
    expect(justifier.generateResponse).not.toHaveBeenCalled();
  });

  test('every juror failed: the same 400, with each reason', async () => {
    providers({ OpenAI: failing(refusedKey), Anthropic: failing(usageLimit) });

    const { status, body } = await post(REQUEST);

    expect(status).toBe(400);
    expect(body.error).toBe('Insufficient successful models: 0/2 (minimum required: 2). Failures: '
      + 'OpenAI-gpt-5.6-terra (401 Incorrect API key provided); '
      + 'Anthropic-claude-sonnet-5 (400 You have reached your specified API usage limits)');
  });

  test('a whole jury answers as it always did', async () => {
    providers({ OpenAI: answering(DONT_FUND), Anthropic: answering(FUND) });

    const { status, body } = await post(REQUEST);

    expect(status).toBe(200);
    expect(body.scores).toEqual([{ outcome: 'DONT_FUND', score: 567500 }, { outcome: 'FUND', score: 432500 }]);
    expect(body.metadata).toMatchObject({ models_requested: 2, models_successful: 2, models_failed: 0, success_threshold_met: true });
    expect(body.justification).toContain('JURORS (2 of 2 answered; the result is their weighted average)');
    expect(body.warnings).toBeUndefined();
    expect(justifier.generateResponse).toHaveBeenCalledTimes(1);
  });

  test('a jury of one model is whole when that model answers', async () => {
    providers({ Anthropic: answering(FUND) });

    const { status, body } = await post({ ...REQUEST, models: [{ ...CLAUDE, weight: 1 }] });

    expect(status).toBe(200);
    expect(body.scores).toEqual([{ outcome: 'DONT_FUND', score: 135000 }, { outcome: 'FUND', score: 865000 }]);
  });
});

describe('MIN_SUCCESSFUL_MODELS_PERCENT=0.5, the rule before this one', () => {
  allowPartialJury();

  test('one of two jurors is enough, and the record says whose result it is', async () => {
    providers({ OpenAI: failing(refusedKey), Anthropic: answering(FUND) });

    const { status, body } = await post(REQUEST);

    expect(status).toBe(200);
    expect(body.scores).toEqual([{ outcome: 'DONT_FUND', score: 135000 }, { outcome: 'FUND', score: 865000 }]);
    expect(body.metadata).toMatchObject({ models_requested: 2, models_successful: 1, models_failed: 1 });
    expect(body.justification).toContain("JURORS (1 of 2 answered; the result is that one juror's scores)");
    expect(body.warnings).toHaveLength(1);
    expect(justifier.generateResponse).toHaveBeenCalledTimes(1);
  });

  test('none of two is not', async () => {
    providers({ OpenAI: failing(refusedKey), Anthropic: failing(usageLimit) });

    const { status, body } = await post(REQUEST);

    expect(status).toBe(400);
    expect(body.error).toContain('Insufficient successful models: 0/2 (minimum required: 1).');
  });
});

describe('MIN_SUCCESSFUL_MODELS_PERCENT set to something else', () => {
  test('not a number: every juror is required', async () => {
    process.env.MIN_SUCCESSFUL_MODELS_PERCENT = 'half';
    providers({ OpenAI: failing(refusedKey), Anthropic: answering(FUND) });

    const { status, body } = await post(REQUEST);

    expect(status).toBe(400);
    expect(body.error).toContain('Insufficient successful models: 1/2 (minimum required: 2).');
  });

  test('0: one juror is still required, where a jury of no answers used to go on', async () => {
    process.env.MIN_SUCCESSFUL_MODELS_PERCENT = '0';
    providers({ OpenAI: failing(refusedKey), Anthropic: failing(usageLimit) });

    const { status, body } = await post(REQUEST);

    expect(status).toBe(400);
    expect(body.error).toContain('Insufficient successful models: 0/2 (minimum required: 1).');
    expect(justifier.generateResponse).not.toHaveBeenCalled();
  });
});
