/**
 * @jest-environment node
 */
// What bounty 398's records could not tell a reader: which number settled the submission,
// what each juror scored, and that some results were one juror's alone.

import { POST } from '../../app/api/rank-and-justify/route';
import { LLMFactory } from '../../lib/llm/llm-factory';
import { withPartialJury } from '../../../test-support/jury-quorum';

jest.mock('../../lib/llm/llm-factory');
// Authentication is covered through the real handlers in service-auth.test.ts.
jest.mock('../../lib/service-auth', () => ({ requireServiceAuth: () => null }));

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((data, options) => ({
      status: options?.status || 200,
      json: jest.fn().mockResolvedValue(data),
    })),
  },
}));

jest.setTimeout(60_000);

const JURY = [
  { provider: 'openai', model: 'gpt-5.6-terra', weight: 0.5 },
  { provider: 'anthropic', model: 'claude-sonnet-5', weight: 0.5 },
];
const REQUEST = { prompt: 'Does the submission meet the rubric?', outcomes: ['DONT_FUND', 'FUND'], models: JURY };

const GATE_FAILED = JSON.stringify({ score: [1000000, 0], justification: 'MANDATORY REQUIREMENT FAILED. Scoring DONT_FUND=100, FUND=0.' });
const WORK_IS_GOOD = JSON.stringify({ score: [135000, 865000], justification: 'FINAL SCORES: DONT_FUND=13.5, FUND=86.5' });

function post(body: object) {
  return POST({ json: async () => body } as unknown as Request);
}

describe('POST /api/rank-and-justify: the result on record', () => {
  let openai: { generateResponse: jest.Mock; supportsAttachments: jest.Mock };
  let anthropic: { generateResponse: jest.Mock; supportsAttachments: jest.Mock };
  let justifier: { generateResponse: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    openai = { generateResponse: jest.fn().mockResolvedValue(GATE_FAILED), supportsAttachments: jest.fn().mockReturnValue(true) };
    anthropic = { generateResponse: jest.fn().mockResolvedValue(WORK_IS_GOOD), supportsAttachments: jest.fn().mockReturnValue(true) };
    // The justifier bounty 398 got: it restated one juror's score as the result.
    justifier = { generateResponse: jest.fn().mockResolvedValue('FUND = 865,000 on a 1,000,000-sum scale.') };
    (LLMFactory.getProvider as jest.Mock).mockImplementation(async (provider: string) =>
      provider === 'openai' ? openai : provider === 'anthropic' ? anthropic : justifier,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('jurors that disagree: the record states the result whatever the justifier writes', async () => {
    const body = await (await post(REQUEST)).json();

    expect(body.scores).toEqual([
      { outcome: 'DONT_FUND', score: 567500 },
      { outcome: 'FUND', score: 432500 },
    ]);
    const record = [
      "RESULT (computed by the arbiter from the jurors' scores)",
      '- DONT_FUND: 567,500 of 1,000,000 (56.75%)',
      '- FUND: 432,500 of 1,000,000 (43.25%)',
      'JURORS (2 of 2 answered; the result is their weighted average)',
      '- openai gpt-5.6-terra, weight 0.5: DONT_FUND 1,000,000; FUND 0',
      '- anthropic claude-sonnet-5, weight 0.5: DONT_FUND 135,000; FUND 865,000',
    ].join('\n');
    expect(body.justification).toBe(`${record}\n\nFUND = 865,000 on a 1,000,000-sum scale.`);

    // The justifier was given that record, not a bare vector.
    const [prompt, , options] = justifier.generateResponse.mock.calls[0];
    expect(prompt.startsWith(record)).toBe(true);
    expect(prompt).toContain('From model claude-sonnet-5:\nFINAL SCORES: DONT_FUND=13.5, FUND=86.5');
    expect(prompt).not.toContain('Using the aggregated decision vector');
    expect(options).toMatchObject({ webAccess: false });

    // The same numbers, for a program: each juror's weight and own scores.
    expect(body.model_results).toEqual([
      expect.objectContaining({ provider: 'openai', model: 'gpt-5.6-terra', status: 'success', weight: 0.5, scores: [1000000, 0] }),
      expect.objectContaining({ provider: 'anthropic', model: 'claude-sonnet-5', status: 'success', weight: 0.5, scores: [135000, 865000] }),
    ]);
  });

  test('a juror its provider refused, a partial jury allowed: the record says the result is the other juror\'s alone', async () => {
    openai.generateResponse.mockRejectedValue(
      Object.assign(new Error('401 Incorrect API key provided: sk-ut1et***Zd9U. You can find your API key at https://platform.openai.com/account/api-keys.'), {
        status: 401,
        code: 'invalid_api_key',
      }),
    );
    anthropic.generateResponse.mockResolvedValue(GATE_FAILED);
    justifier.generateResponse.mockResolvedValue('The one juror that answered failed the submission.');

    // By default this request is a 400 (rank-and-justify.quorum.test.ts).
    const body = await (await withPartialJury(() => post(REQUEST))).json();

    expect(body.metadata).toMatchObject({ models_requested: 2, models_successful: 1, models_failed: 1 });
    const lines = body.justification.split('\n');
    expect(lines.slice(0, 6)).toEqual([
      "RESULT (computed by the arbiter from the jurors' scores)",
      '- DONT_FUND: 1,000,000 of 1,000,000 (100%)',
      '- FUND: 0 of 1,000,000 (0%)',
      "JURORS (1 of 2 answered; the result is that one juror's scores)",
      '- openai gpt-5.6-terra, weight 0.5: no score, not counted (authentication error (HTTP 401))',
      '- anthropic claude-sonnet-5, weight 0.5: DONT_FUND 1,000,000; FUND 0',
    ]);
    // The record never quotes the provider; model_results keeps its message for the operator.
    expect(lines.slice(0, 6).join('\n')).not.toMatch(/sk-|api-keys/);
    const failed = body.model_results.find((result: { provider: string }) => result.provider === 'openai');
    expect(failed).toMatchObject({ status: 'failed', weight: 0.5, error_type: 'authentication', http_status: 401 });
    expect(failed.scores).toBeUndefined();

    // The line the doctor's ai.provider_auth reads: who was refused, and nothing the provider said.
    const authLines = (console.error as jest.Mock).mock.calls.map(call => String(call[0])).filter(line => line.includes('PROVIDER_AUTH_FAILED'));
    expect(authLines).toEqual(['🔑 PROVIDER_AUTH_FAILED: provider=openai model=gpt-5.6-terra role=juror http_status=401']);
  });

  test('a justifier its provider refused is logged for the doctor too', async () => {
    justifier.generateResponse.mockRejectedValue(Object.assign(new Error('401 Incorrect API key provided: sk-ut1et***Zd9U'), { status: 401 }));
    await (await post(REQUEST)).json();
    const authLines = (console.error as jest.Mock).mock.calls.map(call => String(call[0])).filter(line => line.includes('PROVIDER_AUTH_FAILED'));
    expect(authLines).toHaveLength(1);
    expect(authLines[0]).toMatch(/^🔑 PROVIDER_AUTH_FAILED: provider=\S+ model=\S+ role=justifier http_status=401$/);
  });

  test('a juror that fails for another reason is not an authentication failure', async () => {
    openai.generateResponse.mockRejectedValue(Object.assign(new Error('503 upstream connect error'), { status: 503 }));
    await (await post(REQUEST)).json();
    expect((console.error as jest.Mock).mock.calls.map(call => String(call[0])).some(line => line.includes('PROVIDER_AUTH_FAILED'))).toBe(false);
  });

  test('a justifier that fails leaves the record above the jurors\' own texts', async () => {
    justifier.generateResponse.mockRejectedValue(new Error('401 Incorrect API key provided'));

    const body = await (await post(REQUEST)).json();

    expect(body.justification.startsWith("RESULT (computed by the arbiter from the jurors' scores)\n- DONT_FUND: 567,500")).toBe(true);
    // What failed, in the record's words (jurorFailure): the provider's message, which can
    // quote the key, is in the log and not in the published text.
    expect(body.justification).toContain('\n\nError generating consolidated justification: provider error\n\n');
    expect(body.justification).not.toContain('Incorrect API key');
    expect(body.justification).toContain('From model claude-sonnet-5:\nFINAL SCORES: DONT_FUND=13.5, FUND=86.5');
  });
});
