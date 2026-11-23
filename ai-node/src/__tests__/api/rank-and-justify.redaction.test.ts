/**
 * @jest-environment node
 *
 * No provider text reaches a response unredacted.
 *
 * The External Adapter publishes the response's justification, model_results and
 * warnings on IPFS, and in mode 0 the error of an HTTP 400. One of bounty 398's
 * public records holds OpenAI's 401, with the operator's (masked) key and a
 * provider URL, in all three fields. These tests replay that message through the
 * real route, on the 200 path, with a failing justifier, across iterations, and on
 * the 400 path, and look for any part of it in the whole returned body and in
 * everything sent on to another model.
 *
 * What an operator needs is still there: error_type, http_status and error_code as
 * they were, the unredacted message in the node's log, and one PROVIDER_AUTH_FAILED
 * line per refusal, also for a provider that reports its status in its message only.
 * Scores are what they were, and so is the result record above the justification
 * (utils/resultRecord.ts), whose words for a failed juror the fallback lines now share.
 *
 * Every fake secret is built when the test runs, so none is a literal in this file.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { POST } from '../../app/api/rank-and-justify/route';
import { LLMFactory } from '../../lib/llm/llm-factory';

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

const rep = (text: string, times: number) => text.repeat(times);
const SK = ['s', 'k', '-'].join('');
// OpenAI's 401 as bounty 398's record has it: the key masked by OpenAI, then a URL.
const BOUNTY_398 = `401 Incorrect API key provided: ${SK}ut1et***...***Zd9U. You can find your API key at https://platform.openai.com/account/api-keys.`;
const REDACTED_398 = '401 Incorrect API key provided: <redacted>. You can find your API key at https://platform.openai.com/<redacted>';
// What nothing guarantees a provider masks: a whole key, a key in a query, a request id.
const ANTHROPIC_KEY = `${SK}ant-api03-${rep('Ij5-', 12)}${rep('Kl6_', 11)}AA`;
const QUERY_KEY = rep('f00d', 8);
const REQUEST_ID = `req_${rep('01Cs', 6)}`;
const XAI_MASKED = 'xa***Xy';

const openAiRefusal = () => Object.assign(new Error(BOUNTY_398), { status: 401, code: 'invalid_api_key' });
const xaiRefusal = () => new Error(`[xAI] HTTP 400: {"code":"Client specified an invalid argument","error":"Incorrect API key provided: ${XAI_MASKED}. You can obtain an API key from https://console.x.ai/team/default/api-keys."}`);
const justifierRefusal = () => Object.assign(
  new Error(`401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key ${ANTHROPIC_KEY}"},"request_id":"${REQUEST_ID}"} (POST https://api.anthropic.com/v1/messages?key=${QUERY_KEY})`),
  { status: 401 },
);

// The route reads JUSTIFIER_MODEL when it is loaded, as this does.
const [JUSTIFIER_PROVIDER, JUSTIFIER_MODEL] = process.env.JUSTIFIER_MODEL?.split(':') || ['JustifierProvider', 'default-model'];

const GOOD_REPLY = JSON.stringify({ score: [700000, 300000], justification: 'The evidence supports Yes.' });

type Provider = { generateResponse: jest.Mock; supportsAttachments: () => boolean };
const answering = (reply: string = GOOD_REPLY): Provider => ({ generateResponse: jest.fn().mockResolvedValue(reply), supportsAttachments: () => false });
const failing = (error: () => Error): Provider => ({ generateResponse: jest.fn().mockImplementation(async () => { throw error(); }), supportsAttachments: () => false });
// A justifier that repeats all it was given: whatever reached its prompt reaches the record.
const echoing = (): Provider => ({ generateResponse: jest.fn(async (prompt: string) => `What the jurors said:\n${prompt}`), supportsAttachments: () => false });

function providers(byName: Record<string, Provider>, justifier: Provider) {
  (LLMFactory.getProvider as jest.Mock).mockImplementation(async (name: string) => byName[name] ?? justifier);
}

const request = (body: unknown): Request => ({ headers: new Headers(), json: async () => body }) as unknown as Request;

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const response = await POST(request(body));
  return { status: response.status, body: await response.json() };
}

// The arbiter's own record of a result that is the one answering juror's (resultRecord.ts).
const RECORD_ONE_JUROR = [
  "RESULT (computed by the arbiter from the jurors' scores)",
  '- Yes: 700,000 of 1,000,000 (70%)',
  '- No: 300,000 of 1,000,000 (30%)',
  "JURORS (1 of 2 answered; the result is that one juror's scores)",
  '- OpenAI gpt-4o, weight 0.5: no score, not counted (authentication error (HTTP 401))',
  '- Anthropic claude-sonnet-5, weight 0.5: Yes 700,000; No 300,000',
].join('\n');

const TWO_MODELS = {
  prompt: 'Was the work delivered as specified?',
  outcomes: ['Yes', 'No'],
  iterations: 1,
  models: [
    { provider: 'OpenAI', model: 'gpt-4o', weight: 0.5 },
    { provider: 'Anthropic', model: 'claude-sonnet-5', weight: 0.5 },
  ],
};

/** No part of any secret these tests use, and no URL beyond its scheme and host, anywhere in `value`. */
function expectNothingOfTheProviders(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const part of [
    SK, 'ut1et', 'Zd9U', 'api-keys', 'platform.openai.com/account', '***',
    'Ij5-', 'Kl6_', 'api03', QUERY_KEY.slice(0, 8), '01Cs01Cs', XAI_MASKED, 'team/default', 'v1/messages',
  ]) {
    expect(text).not.toContain(part);
  }
  for (const url of text.match(/\b(?:https?|wss?):\/\/[^\s"\\)]*/gi) ?? []) {
    expect(url).toMatch(/^[a-z]+:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/<redacted>)?\.?$/);
  }
}

let cwd: string;
let logged: { log: jest.SpyInstance; warn: jest.SpyInstance; error: jest.SpyInstance };

const lines = (spy: jest.SpyInstance): string[] => spy.mock.calls.map(args => String(args[0]));
const authLines = () => lines(logged.error).filter(line => line.includes('PROVIDER_AUTH_FAILED'));
const authLogFile = () => path.join(cwd, 'logs', 'provider-auth.log');
/** The watchdog's record, without the times. */
const authRecord = () => (fs.existsSync(authLogFile()) ? fs.readFileSync(authLogFile(), 'utf8') : '')
  .split('\n').filter(Boolean).map(line => line.replace(/^\S+ /, ''));

beforeEach(() => {
  jest.clearAllMocks();
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'redaction-'));
  jest.spyOn(process, 'cwd').mockReturnValue(cwd);   // logs/ goes there
  logged = {
    log: jest.spyOn(console, 'log').mockImplementation(() => {}),
    warn: jest.spyOn(console, 'warn').mockImplementation(() => {}),
    error: jest.spyOn(console, 'error').mockImplementation(() => {}),
  };
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('HTTP 200: one juror\'s provider refused the key (bounty 398)', () => {
  test('no part of the provider\'s message is in the body; the fields an operator needs are', async () => {
    const openai = failing(openAiRefusal);
    const anthropic = answering();
    const justifier = echoing();
    providers({ OpenAI: openai, Anthropic: anthropic }, justifier);

    const { status, body } = await post(TWO_MODELS);

    expect(status).toBe(200);
    expectNothingOfTheProviders(body);

    // Scoring is what it was: the juror that answered, alone.
    expect(body.scores).toEqual([{ outcome: 'Yes', score: 700000 }, { outcome: 'No', score: 300000 }]);
    expect(body.metadata).toMatchObject({ models_requested: 2, models_successful: 1, models_failed: 1, success_threshold_met: true });

    // model_results: type, status and code as they were; the message redacted.
    const failed = body.model_results.find((r: any) => r.model === 'gpt-4o');
    expect(failed).toEqual({
      provider: 'OpenAI',
      model: 'gpt-4o',
      status: 'failed',
      duration_ms: expect.any(Number),
      weight: 0.5,
      error_type: 'authentication',
      error_message: REDACTED_398,
      error_code: 'invalid_api_key',
      http_status: 401,
    });
    expect(body.model_results.find((r: any) => r.model === 'claude-sonnet-5')).toMatchObject({ status: 'success', scores: [700000, 300000] });

    // warnings: built from the redacted message.
    expect(body.warnings).toEqual([{
      type: 'model_failure',
      message: `Model OpenAI-gpt-4o failed: ${REDACTED_398}`,
      severity: 'warning',
      model: 'OpenAI-gpt-4o',
      details: { error_type: 'authentication', duration_ms: expect.any(Number), http_status: 401 },
    }]);

    // The justifier was told what failed in the record's words, twice: in the record and
    // in the failed juror's own line, which used to carry the provider's message.
    const justifierPrompt = justifier.generateResponse.mock.calls[0][0];
    expect(justifierPrompt).toContain('- OpenAI gpt-4o, weight 0.5: no score, not counted (authentication error (HTTP 401))');
    expect(justifierPrompt).toContain('From model gpt-4o:\nModel timed out or failed: authentication error (HTTP 401)');
    expect(justifierPrompt).toContain('From model claude-sonnet-5:\nThe evidence supports Yes.');
    expectNothingOfTheProviders(justifierPrompt);
    expect(body.justification.startsWith(RECORD_ONE_JUROR)).toBe(true);
    expect(body.justification).toContain('Model timed out or failed: authentication error (HTTP 401)');
  });

  test('the unredacted message is in the node\'s log, with one PROVIDER_AUTH_FAILED line', async () => {
    providers({ OpenAI: failing(openAiRefusal), Anthropic: answering() }, echoing());

    const { status } = await post(TWO_MODELS);

    expect(status).toBe(200);
    expect(lines(logged.warn)).toContain(`❌ MODEL_FAILED: OpenAI-gpt-4o failed: ${BOUNTY_398}`);
    expect(authLines()).toEqual(['🔑 PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401']);
    // The watchdog's record: a time, then the refusal.
    const written = fs.readFileSync(authLogFile(), 'utf8');
    expect(written).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401\n$/);
  });

  test('the provider answers again (the key was replaced): the watchdog\'s record says so, once', async () => {
    providers({ OpenAI: failing(openAiRefusal), Anthropic: answering() }, echoing());
    await post(TWO_MODELS);
    providers({ OpenAI: answering(), Anthropic: answering() }, echoing());
    await post(TWO_MODELS);
    await post(TWO_MODELS);

    expect(authRecord()).toEqual([
      'PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401',
      'PROVIDER_AUTH_OK: provider=OpenAI',
    ]);
  });

  test('a justifier whose provider refuses its key too: the fallback justification has no provider text', async () => {
    providers({ OpenAI: failing(openAiRefusal), Anthropic: answering() }, failing(justifierRefusal));

    const { status, body } = await post(TWO_MODELS);

    expect(status).toBe(200);
    expectNothingOfTheProviders(body);
    expect(body.justification).toBe(
      `${RECORD_ONE_JUROR}\n\n`
      + 'Error generating consolidated justification: authentication error (HTTP 401)\n\n'
      + 'Individual model responses:\n\n'
      + 'From model gpt-4o:\nModel timed out or failed: authentication error (HTTP 401)\n\n'
      + 'From model claude-sonnet-5:\nThe evidence supports Yes.',
    );
    expect(body.scores).toEqual([{ outcome: 'Yes', score: 700000 }, { outcome: 'No', score: 300000 }]);
    // The log has the justifier's message whole, and a line for each refusal.
    expect(lines(logged.error).some(line => line.includes('JUSTIFIER_ERROR') && line.includes(ANTHROPIC_KEY) && line.includes(REQUEST_ID))).toBe(true);
    expect(authLines()).toEqual([
      '🔑 PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401',
      `🔑 PROVIDER_AUTH_FAILED: provider=${JUSTIFIER_PROVIDER} model=${JUSTIFIER_MODEL} role=justifier http_status=401`,
    ]);
  });

  test('two iterations: the next round\'s prompt to the other models has no provider text either', async () => {
    const anthropic = answering();
    providers({ OpenAI: failing(openAiRefusal), Anthropic: anthropic }, echoing());

    const { status, body } = await post({ ...TWO_MODELS, iterations: 2 });

    expect(status).toBe(200);
    expectNothingOfTheProviders(body);
    expect(anthropic.generateResponse).toHaveBeenCalledTimes(2);
    const secondRound = anthropic.generateResponse.mock.calls[1][0];
    expect(secondRound).toContain('From OpenAI - gpt-4o:');
    expect(secondRound).toContain('Justification: Model timed out or failed: authentication error (HTTP 401)');
    expectNothingOfTheProviders(secondRound);
    // One line per refusal: one for each round.
    expect(authLines()).toHaveLength(2);
  });

  test('a provider that reports through its message only (every fetch provider): type and status stay as they were, and the refusal is still logged', async () => {
    // OpenRouter, which is every class's fallback, answers a revoked key like this. The
    // error has no status property and says "not found": typed model_not_found, as before.
    // Without the message being read, no PROVIDER_AUTH_FAILED line would say the key is refused.
    const openRouter401 = '[OpenRouter] HTTP 401: {"error":{"message":"User not found.","code":401}}';
    providers({ OpenAI: failing(() => new Error(openRouter401)), Anthropic: answering() }, echoing());

    const { status, body } = await post(TWO_MODELS);

    expect(status).toBe(200);
    const failed = body.model_results.find((r: any) => r.model === 'gpt-4o');
    expect(failed).toMatchObject({ status: 'failed', error_type: 'model_not_found', error_message: openRouter401 });
    expect(failed.http_status).toBeUndefined();
    expect(body.justification).toContain('From model gpt-4o:\nModel timed out or failed: model not found error');
    expect(authLines()).toEqual(['🔑 PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401']);
    expect(authRecord()).toContain('PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401');
  });

  test('a 403: logged as the route types it (authorization), as before', async () => {
    const forbidden = () => Object.assign(new Error('403 Your API key does not have permission to use the specified resource'), { status: 403 });
    providers({ OpenAI: failing(forbidden), Anthropic: answering() }, echoing());

    const { status, body } = await post(TWO_MODELS);

    expect(status).toBe(200);
    expect(body.model_results.find((r: any) => r.model === 'gpt-4o')).toMatchObject({ error_type: 'authorization', http_status: 403 });
    expect(authLines()).toEqual(['🔑 PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=403']);
  });

  test('a failure that is no refusal: described in our words, no PROVIDER_AUTH_FAILED line', async () => {
    const overloaded = () => Object.assign(new Error(`529 Overloaded (request ${REQUEST_ID})`), { status: 529 });
    providers({ OpenAI: failing(overloaded), Anthropic: answering() }, echoing());

    const { status, body } = await post(TWO_MODELS);

    expect(status).toBe(200);
    expectNothingOfTheProviders(body);
    const failed = body.model_results.find((r: any) => r.model === 'gpt-4o');
    expect(failed).toMatchObject({ error_type: 'provider_error', http_status: 529, error_message: '529 Overloaded (request <redacted>)' });
    expect(body.justification).toContain('From model gpt-4o:\nModel timed out or failed: provider error (HTTP 529)');
    expect(authLines()).toEqual([]);
    expect(authRecord().filter(line => line.startsWith('PROVIDER_AUTH_FAILED'))).toEqual([]);
  });

  test('a model that does not answer in time: our own message, kept whole ("xAI-grok-4" is not a key)', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const hanging: Provider = { generateResponse: jest.fn(() => new Promise(() => {})), supportsAttachments: () => false };
    providers({ xAI: hanging, Anthropic: answering() }, echoing());

    const pending = post({ ...TWO_MODELS, models: [{ provider: 'xAI', model: 'grok-4', weight: 0.5 }, TWO_MODELS.models[1]] });
    await jest.advanceTimersByTimeAsync(121000);
    const { status, body } = await pending;

    expect(status).toBe(200);
    const timedOut = body.model_results.find((r: any) => r.model === 'grok-4');
    expect(timedOut).toMatchObject({ status: 'timeout', error_type: 'timeout', error_message: 'Model xAI-grok-4 timed out after 120000ms' });
    expect(body.warnings[0]).toMatchObject({ type: 'model_timeout', message: 'Model xAI-grok-4 timed out: Model xAI-grok-4 timed out after 120000ms' });
    expect(body.justification).toContain('From model grok-4:\nModel timed out or failed: timed out after 120 s');
    expect(authLines()).toEqual([]);
  });
});

describe('HTTP 400: too few jurors answered', () => {
  test('the error string the External Adapter can publish has no part of the providers\' messages', async () => {
    providers({ OpenAI: failing(openAiRefusal), xAI: failing(xaiRefusal) }, echoing());

    const { status, body } = await post({
      ...TWO_MODELS,
      models: [{ provider: 'OpenAI', model: 'gpt-4o', weight: 0.5 }, { provider: 'xAI', model: 'grok-4', weight: 0.5 }],
    });

    expect(status).toBe(400);
    expectNothingOfTheProviders(body);
    expect(body).toEqual({
      error: 'Insufficient successful models: 0/2 (minimum required: 1). Failures: '
        + `OpenAI-gpt-4o (${REDACTED_398}); `
        + 'xAI-grok-4 ([xAI] HTTP 400: {"code":"Client specified an invalid argument","error":"Incorrect API key provided: <redacted>. '
        + 'You can obtain an API key from https://console.x.ai/<redacted>"})',
      scores: [],
      justification: '',
    });
    // The log has both messages whole, and one line for each refusal (xAI's comes with a 400).
    const warned = lines(logged.warn).join('\n');
    expect(warned).toContain(BOUNTY_398);
    expect(warned).toContain(XAI_MASKED);
    expect(authLines()).toEqual([
      '🔑 PROVIDER_AUTH_FAILED: provider=OpenAI model=gpt-4o role=juror http_status=401',
      '🔑 PROVIDER_AUTH_FAILED: provider=xAI model=grok-4 role=juror http_status=400',
    ]);
  });

  test('the only juror refused, with a whole key in its message', async () => {
    const whole = () => Object.assign(new Error(`401 invalid x-api-key: ${ANTHROPIC_KEY} (${REQUEST_ID})`), { status: 401 });
    providers({ Anthropic: failing(whole) }, echoing());

    const { status, body } = await post({ prompt: 'One model.', models: [{ provider: 'Anthropic', model: 'claude-sonnet-5', weight: 1 }] });

    expect(status).toBe(400);
    expectNothingOfTheProviders(body);
    expect(body.error).toBe('Insufficient successful models: 0/1 (minimum required: 1). Failures: Anthropic-claude-sonnet-5 (401 invalid x-api-key: <redacted> (<redacted>))');
  });

  test('a provider that echoes a megabyte: every failure reason is held to its limit', async () => {
    const huge = () => Object.assign(new Error(`400 invalid image: data:image/png;base64,${rep('QmFzZTY0', 150000)} key=${QUERY_KEY}`), { status: 400 });
    providers({ OpenAI: failing(huge), Anthropic: failing(huge) }, echoing());

    const started = Date.now();
    const { status, body } = await post(TWO_MODELS);

    expect(status).toBe(400);
    expect(Date.now() - started).toBeLessThan(5000);
    expectNothingOfTheProviders(body);
    expect(body.error.length).toBeLessThan(1300);
    expect(body.error).toContain('OpenAI-gpt-4o (400 invalid image: … [truncated])');
  });
});

describe('HTTP 500', () => {
  test('an error this route did not expect is redacted as well', async () => {
    const broken = { headers: new Headers(), json: async () => { throw new Error(`upstream said: Bearer ${rep('beef', 16)} at https://h.example/p?key=${QUERY_KEY}`); } } as unknown as Request;

    const response = await POST(broken);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'upstream said: Bearer <redacted> at https://h.example/<redacted>', scores: [], justification: '' });
  });
});
