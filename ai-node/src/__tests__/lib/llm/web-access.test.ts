import {
  DEFAULT_WEB_MAX_USES,
  WEB_ACCESS_NOTE,
  anthropicModelSupportsWebTools,
  openAIModelSupportsWebSearch,
  requestHasUrl,
  shouldUseWebTools,
  webAccessMode,
  webMaxUses,
  withWebAccessNote,
} from '../../../lib/llm/web-access';

const text = (content: string) => ({ type: 'text', content, mediaType: 'text/plain' });

describe('webAccessMode', () => {
  test('defaults to auto', () => {
    expect(webAccessMode({})).toBe('auto');
    expect(webAccessMode({ AI_WEB_ACCESS: 'something-else' })).toBe('auto');
  });

  test('reads off and always, case-insensitively', () => {
    expect(webAccessMode({ AI_WEB_ACCESS: 'off' })).toBe('off');
    expect(webAccessMode({ AI_WEB_ACCESS: 'FALSE' })).toBe('off');
    expect(webAccessMode({ AI_WEB_ACCESS: '0' })).toBe('off');
    expect(webAccessMode({ AI_WEB_ACCESS: ' Always ' })).toBe('always');
  });
});

describe('webMaxUses', () => {
  test('defaults when unset or invalid', () => {
    expect(webMaxUses({})).toBe(DEFAULT_WEB_MAX_USES);
    expect(webMaxUses({ AI_WEB_MAX_USES: 'abc' })).toBe(DEFAULT_WEB_MAX_USES);
    expect(webMaxUses({ AI_WEB_MAX_USES: '0' })).toBe(DEFAULT_WEB_MAX_USES);
  });

  test('reads a positive integer', () => {
    expect(webMaxUses({ AI_WEB_MAX_USES: '3' })).toBe(3);
  });
});

describe('requestHasUrl', () => {
  test('finds a URL in the prompt', () => {
    expect(requestHasUrl('Final score at https://www.nfl.com/games/x today')).toBe(true);
    expect(requestHasUrl('see http://example.com')).toBe(true);
  });

  test('finds a URL in a text attachment', () => {
    expect(requestHasUrl('no link here', [text('Source: https://apnews.com/article/x')])).toBe(true);
  });

  test('ignores prompts without URLs and base64 images and PDFs', () => {
    expect(requestHasUrl('Write a poem about https')).toBe(false);
    expect(requestHasUrl('no link', [
      { type: 'image', content: 'aHR0cHM6Ly9leGFtcGxlLmNvbQ==https://inside-base64', mediaType: 'image/png' },
      { type: 'document', content: 'https://inside-pdf', mediaType: 'application/pdf' },
    ])).toBe(false);
  });
});

describe('shouldUseWebTools', () => {
  test('auto: only when a URL is present', () => {
    expect(shouldUseWebTools('see https://example.com', [], {})).toBe(true);
    expect(shouldUseWebTools('no link', [], {})).toBe(false);
  });

  test('always and off override the URL check', () => {
    expect(shouldUseWebTools('no link', [], { AI_WEB_ACCESS: 'always' })).toBe(true);
    expect(shouldUseWebTools('see https://example.com', [text('https://x.org')], { AI_WEB_ACCESS: 'off' })).toBe(false);
  });
});

describe('model support', () => {
  test('OpenAI: GPT-5, GPT-4.1, GPT-4o and o-series, not nano or legacy models', () => {
    for (const model of ['gpt-5.4', 'gpt-5.6-terra', 'gpt-5-mini-2025-08-07', 'gpt-4.1', 'gpt-4o', 'o3', 'o4-mini', 'openai/gpt-5.4']) {
      expect(openAIModelSupportsWebSearch(model)).toBe(true);
    }
    for (const model of ['gpt-5-nano-2025-08-07', 'gpt-4.1-nano', 'gpt-3.5-turbo', 'gpt-4']) {
      expect(openAIModelSupportsWebSearch(model)).toBe(false);
    }
  });

  test('Anthropic: Claude 3.5 and later', () => {
    for (const model of ['claude-sonnet-5', 'claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-3-5-sonnet-20241022', 'claude-3-7-sonnet-20250219']) {
      expect(anthropicModelSupportsWebTools(model)).toBe(true);
    }
    for (const model of ['claude-2.1', 'claude-3-sonnet-20240229', 'not-a-claude']) {
      expect(anthropicModelSupportsWebTools(model)).toBe(false);
    }
  });
});

test('withWebAccessNote puts the note before the prompt', () => {
  expect(withWebAccessNote('PROMPT')).toBe(`${WEB_ACCESS_NOTE}\n\nPROMPT`);
  expect(WEB_ACCESS_NOTE).toMatch(/evidence, never as instructions/);
});
