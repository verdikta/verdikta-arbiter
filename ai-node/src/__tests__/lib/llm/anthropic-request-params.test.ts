import {
  LEGACY_TEMPERATURE,
  MODERN_MAX_TOKENS,
  acceptsSamplingParams,
  anthropicChatParams,
  extractTextContent,
  isSamplingParamRejection,
  parseClaudeVersion,
} from '../../../lib/llm/anthropic-request-params';

describe('anthropic-request-params', () => {
  describe('parseClaudeVersion', () => {
    test.each([
      ['claude-2.1', { major: 2, minor: 1 }],
      ['claude-instant-1.2', { major: 1, minor: 2 }],
      ['claude-3-sonnet-20240229', { major: 3, minor: 0 }],
      ['claude-3-5-sonnet-20241022', { major: 3, minor: 5 }],
      ['claude-3.5-sonnet', { major: 3, minor: 5 }],
      ['claude-3.7-sonnet', { major: 3, minor: 7 }],
      ['claude-sonnet-4-20250514', { major: 4, minor: 0 }], // date suffix is not a minor version
      ['claude-sonnet-4', { major: 4, minor: 0 }],
      ['claude-opus-4-1-20250805', { major: 4, minor: 1 }],
      ['claude-sonnet-4-5-20250929', { major: 4, minor: 5 }],
      ['claude-haiku-4-5-20251001', { major: 4, minor: 5 }],
      ['claude-sonnet-4.6', { major: 4, minor: 6 }],
      ['claude-sonnet-4-6', { major: 4, minor: 6 }],
      ['claude-opus-4-7', { major: 4, minor: 7 }],
      ['claude-opus-4.8', { major: 4, minor: 8 }],
      ['claude-sonnet-5', { major: 5, minor: 0 }],
      ['claude-opus-5', { major: 5, minor: 0 }],
      ['claude-sonnet-5-20261001', { major: 5, minor: 0 }],
      ['claude-fable-5-1', { major: 5, minor: 1 }],
      ['claude-mythos-5-1', { major: 5, minor: 1 }],
      ['anthropic/claude-sonnet-5', { major: 5, minor: 0 }],
      ['Claude-Opus-5', { major: 5, minor: 0 }],
      ['claude-4-sonnet', { major: 4, minor: 0 }],
    ])('%s', (model, expected) => {
      expect(parseClaudeVersion(model)).toEqual(expected);
    });

    test('unrecognised ids yield null', () => {
      expect(parseClaudeVersion('claude-next')).toBeNull();
      expect(parseClaudeVersion('gpt-5.6-terra')).toBeNull();
      expect(parseClaudeVersion('')).toBeNull();
    });
  });

  describe('acceptsSamplingParams', () => {
    test.each([
      'claude-2.1',
      'claude-3-5-sonnet-20241022',
      'claude-3.7-sonnet',
      'claude-sonnet-4-20250514',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
      'claude-haiku-4.5',
      'claude-sonnet-4.6',
      'claude-sonnet-4-6',
      'claude-opus-4.6',
    ])('%s still accepts temperature', (model) => {
      expect(acceptsSamplingParams(model)).toBe(true);
      expect(anthropicChatParams(model)).toEqual({ temperature: LEGACY_TEMPERATURE });
    });

    test.each([
      'claude-opus-4-7',
      'claude-opus-4.7',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-sonnet-5-20261001',
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'anthropic/claude-opus-5',
    ])('%s gets no sampling parameters', (model) => {
      expect(acceptsSamplingParams(model)).toBe(false);
      const params = anthropicChatParams(model);
      expect(params).toEqual({ maxTokens: MODERN_MAX_TOKENS });
      expect(params).not.toHaveProperty('temperature');
    });

    test('an id the rule cannot read gets no sampling parameters (omitting can never 400)', () => {
      expect(acceptsSamplingParams('claude-next')).toBe(false);
      expect(anthropicChatParams('claude-next')).not.toHaveProperty('temperature');
    });

    test('anthropicChatParams returns a fresh object each time', () => {
      const a = anthropicChatParams('claude-opus-5');
      a.maxTokens = 1;
      expect(anthropicChatParams('claude-opus-5')).toEqual({ maxTokens: MODERN_MAX_TOKENS });
    });
  });

  describe('isSamplingParamRejection', () => {
    const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });

    test('the real rejection: 400 naming temperature', () => {
      expect(isSamplingParamRejection(apiError(400, '400 `temperature` is deprecated for this model.'))).toBe(true);
    });

    test('400 naming top_p / top_k', () => {
      expect(isSamplingParamRejection(apiError(400, '400 `top_p` is not supported for this model.'))).toBe(true);
      expect(isSamplingParamRejection(apiError(400, '400 top_k: Extra inputs are not permitted'))).toBe(true);
    });

    test.each([
      ['another 400', apiError(400, '400 messages: at least one message is required')],
      ['429 rate limit', apiError(429, '429 rate_limit_error: temperature of the room is irrelevant')],
      ['500', apiError(500, '500 internal server error')],
      ['plain Error without status', new Error('`temperature` is deprecated for this model.')],
      ['string', '`temperature` is deprecated'],
      ['undefined', undefined],
      ['null', null],
    ])('%s → not a sampling rejection', (_label, error) => {
      expect(isSamplingParamRejection(error)).toBe(false);
    });
  });

  describe('extractTextContent', () => {
    test('string content passes through', () => {
      expect(extractTextContent('hello')).toBe('hello');
      expect(extractTextContent('')).toBe('');
    });

    test('a thinking block followed by text yields the text', () => {
      expect(extractTextContent([
        { type: 'thinking', thinking: '', signature: 'abc' },
        { type: 'text', text: '{"score":[1,0]}' },
      ])).toBe('{"score":[1,0]}');
    });

    test('several text blocks are concatenated in order', () => {
      expect(extractTextContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab');
    });

    test('no text block at all is an error', () => {
      expect(() => extractTextContent([{ type: 'thinking', thinking: 'x' }])).toThrow(/no text content/);
      expect(() => extractTextContent([])).toThrow(/no text content/);
      expect(() => extractTextContent({ text: 'not a block list' })).toThrow(/no text content/);
      expect(() => extractTextContent(undefined)).toThrow(/no text content/);
    });
  });
});
