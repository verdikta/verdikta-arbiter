/**
 * @jest-environment node
 *
 * describeFailure: a failed model call in words of our own, for the justification text.
 */
import { describeFailure } from '../../utils/describeFailure';

describe('describeFailure', () => {
  test.each([
    [{ errorType: 'authentication', httpStatus: 401 }, 'authentication error (HTTP 401)'],
    [{ errorType: 'authorization', httpStatus: 403 }, 'authorization error (HTTP 403)'],
    [{ errorType: 'rate_limit', httpStatus: 429 }, 'rate limit (HTTP 429)'],
    [{ errorType: 'model_not_found', httpStatus: 404 }, 'model not found (HTTP 404)'],
    [{ errorType: 'content_policy' }, 'content policy'],
    [{ errorType: 'token_limit', httpStatus: 400 }, 'token limit (HTTP 400)'],
    [{ errorType: 'invalid_image', httpStatus: 400 }, 'image rejected (HTTP 400)'],
    [{ errorType: 'provider_error', httpStatus: 529 }, 'provider error (HTTP 529)'],
    [{ errorType: 'network' }, 'network error'],
    [{ errorType: 'timeout' }, 'timeout'],
    [{ errorType: 'unknown', httpStatus: 400 }, 'unclassified error (HTTP 400)'],
    [{}, 'unclassified error'],
    [{ timedOut: true, durationMs: 120000 }, 'timed out after 120 s'],
    [{ timedOut: true, errorType: 'authentication', httpStatus: 401, durationMs: 119600 }, 'timed out after 120 s'],
    [{ timedOut: true }, 'timed out'],
  ])('%j', (facts, expected) => {
    expect(describeFailure(facts)).toBe(expected);
  });

  test('only what this node derived is in it: a type or status it does not know adds no text', () => {
    expect(describeFailure({ errorType: 'sk-not-a-type https://x.example/y', httpStatus: 401 })).toBe('unclassified error (HTTP 401)');
    expect(describeFailure({ errorType: 'toString' })).toBe('unclassified error');
    expect(describeFailure({ errorType: 'authentication', httpStatus: '401 and more' as unknown as number })).toBe('authentication error');
    expect(describeFailure({ errorType: 'authentication', httpStatus: 401.5 })).toBe('authentication error');
    expect(describeFailure({ timedOut: true, durationMs: Number.NaN })).toBe('timed out');
  });
});
