/**
 * @jest-environment node
 */
// The arbiter's own record of a text-mode result, with the numbers of bounty 398's records.

import { jurorFailure, justifierPrompt, resultRecord, withResultRecord } from '../../src/utils/resultRecord';

const OUTCOMES = ['DONT_FUND', 'FUND'];

describe('resultRecord', () => {
  test('two jurors that disagree: the result and each juror\'s own scores, by outcome name', () => {
    // Submission 1: GPT failed a mandatory criterion, Claude scored the work 86.5.
    const record = resultRecord(OUTCOMES, [567500, 432500], [
      { provider: 'openai', model: 'gpt-5.6-terra', weight: 0.5, scores: [1000000, 0] },
      { provider: 'anthropic', model: 'claude-sonnet-5', weight: 0.5, scores: [135000, 865000] },
    ]);
    expect(record).toBe(
      [
        "RESULT (computed by the arbiter from the jurors' scores)",
        '- DONT_FUND: 567,500 of 1,000,000 (56.75%)',
        '- FUND: 432,500 of 1,000,000 (43.25%)',
        'JURORS (2 of 2 answered; the result is their weighted average)',
        '- openai gpt-5.6-terra, weight 0.5: DONT_FUND 1,000,000; FUND 0',
        '- anthropic claude-sonnet-5, weight 0.5: DONT_FUND 135,000; FUND 865,000',
      ].join('\n'),
    );
  });

  test('a juror that timed out is listed as not counted, and the result as one juror\'s', () => {
    // Submission 3, first arbiter: Claude timed out at 120 s and GPT's verdict stood alone.
    const record = resultRecord(OUTCOMES, [1000000, 0], [
      { provider: 'openai', model: 'gpt-5.6-terra', weight: 0.5, scores: [1000000, 0] },
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        weight: 0.5,
        failure: jurorFailure({ status: 'timeout', duration_ms: 120027, error_type: 'timeout' }),
      },
    ]);
    expect(record.split('\n').slice(3)).toEqual([
      "JURORS (1 of 2 answered; the result is that one juror's scores)",
      '- openai gpt-5.6-terra, weight 0.5: DONT_FUND 1,000,000; FUND 0',
      '- anthropic claude-sonnet-5, weight 0.5: no score, not counted (timed out after 120 s)',
    ]);
  });

  test('a provider that refused the operator\'s key is named by kind, never by the provider\'s text', () => {
    // Submission 3, second arbiter: OpenAI answered 401 and quoted the key in its message.
    const failure = jurorFailure({ status: 'failed', duration_ms: 6939, error_type: 'authentication', http_status: 401 });
    expect(failure).toBe('authentication error (HTTP 401)');
    expect(jurorFailure({ status: 'failed', error_type: 'rate_limit', http_status: 429 })).toBe('rate limit error (HTTP 429)');
    expect(jurorFailure({ status: 'failed', error_type: 'unknown' })).toBe('provider error');
    expect(jurorFailure({ status: 'parsing_error', error_type: 'parsing_error' })).toBe('its reply could not be read as scores');
    // The route's "provider_error" (a 5xx) is not "provider error error".
    expect(jurorFailure({ status: 'failed', error_type: 'provider_error', http_status: 529 })).toBe('provider error (HTTP 529)');
    expect(jurorFailure({ status: 'failed', error_type: 'model_not_found' })).toBe('model not found error');
    // Only a number is a status: an error object's `status` is whatever the library set.
    expect(jurorFailure({ status: 'failed', error_type: 'authentication', http_status: '401 and a key' as unknown as number })).toBe('authentication error');
  });

  test('three jurors, one missing: the weighted average of those that answered', () => {
    const record = resultRecord(['A', 'B', 'C'], [500000, 300000, 200000], [
      { provider: 'OpenAI', model: 'gpt-5', weight: 0.4, scores: [600000, 300000, 100000] },
      { provider: 'Anthropic', model: 'claude-opus-5', weight: 0.4, scores: [400000, 300000, 300000] },
      { provider: 'xAI', model: 'grok-4', weight: 0.2, failure: 'provider error (HTTP 503)' },
    ]);
    expect(record).toContain('JURORS (2 of 3 answered; the result is the weighted average of those that answered)');
    expect(record).toContain('- xAI grok-4, weight 0.2: no score, not counted (provider error (HTTP 503))');
  });

  test('outcomes without names are numbered, and shares need no more decimals than they have', () => {
    const record = resultRecord(undefined, [333334, 333333, 333333], [
      { provider: 'OpenAI', model: 'gpt-5', weight: 1, scores: [333334, 333333, 333333] },
    ]);
    expect(record).toContain('- outcome 1: 333,334 of 1,000,000 (33.33%)');
    expect(resultRecord(OUTCOMES, [1000000, 0], [])).toContain('- DONT_FUND: 1,000,000 of 1,000,000 (100%)');
    expect(resultRecord(OUTCOMES, [1000000, 0], [])).toContain('- FUND: 0 of 1,000,000 (0%)');
  });

  test('the justifier is given the record and told to explain it, not to work a result out', () => {
    const record = resultRecord(OUTCOMES, [567500, 432500], [
      { provider: 'openai', model: 'gpt-5.6-terra', weight: 0.5, scores: [1000000, 0] },
      { provider: 'anthropic', model: 'claude-sonnet-5', weight: 0.5, scores: [135000, 865000] },
    ]);
    const prompt = justifierPrompt(record, ['From model gpt-5.6-terra:\nMANDATORY REQUIREMENT FAILED.', 'From model claude-sonnet-5:\nFINAL SCORES: DONT_FUND=13.5, FUND=86.5']);

    expect(prompt.startsWith(record)).toBe(true);
    expect(prompt).toContain('From model gpt-5.6-terra:\nMANDATORY REQUIREMENT FAILED.');
    expect(prompt).toContain('From model claude-sonnet-5:\nFINAL SCORES: DONT_FUND=13.5, FUND=86.5');
    expect(prompt).toContain("never present one juror's scores, or a figure of your own, as the result");
    expect(prompt).toContain('Do not recompute, rescale or round the result into other numbers.');
    // The old prompt: a bare vector with no outcome names.
    expect(prompt).not.toContain('[567500,432500]');
    // Not a scoring prompt: the test-only mock provider must answer it with text.
    expect(prompt).not.toMatch(/must contain exactly \d+ (integers|elements)/i);
  });

  test('the record is printed above the text written for it', () => {
    expect(withResultRecord('RECORD', 'The jurors disagreed.')).toBe('RECORD\n\nThe jurors disagreed.');
    expect(withResultRecord('RECORD', '')).toBe('RECORD');
  });
});
