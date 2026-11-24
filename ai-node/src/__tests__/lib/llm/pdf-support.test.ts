import {
  claudeModelReadsPdf,
  nativePdfSupport,
  openAIModelReadsPdf,
  pdfFamilyOf,
} from '../../../lib/llm/pdf-support';

const ENV_KEYS = [
  'AI_GATEWAY',
  'OPENAI_API_KEY', 'OPENAI_CLASS_PROVIDER',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_CLASS_PROVIDER',
  'XAI_API_KEY', 'GROK_API_KEY', 'XAI_CLASS_PROVIDER',
  'HYPERBOLIC_API_KEY', 'OPENROUTER_API_KEY',
  'VERDIKTA_TEST_MOCK_PROVIDER',
];

describe('which jurors read a PDF as a PDF', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // A node with both native keys, as the bounty-398 arbiters had.
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe('the model rule, read from the version', () => {
    test.each([
      // The models the four old lists stopped before: every current jury.
      'claude-sonnet-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5',
      'claude-fable-5-2', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-sonnet-4.6',
      'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929',
      // What the old lists held.
      'claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20240620', 'claude-3-5-haiku-20241022', 'claude-3.5-sonnet',
      // OpenRouter's spelling of the same model.
      'anthropic/claude-sonnet-5',
    ])('Claude: %s reads PDFs', (model) => {
      expect(claudeModelReadsPdf(model)).toBe(true);
    });

    test.each(['claude-2.1', 'claude-3-sonnet-20240229', 'claude-3-opus-20240229', 'claude-instant-1.2', 'some-new-model', ''])(
      'Claude: %s does not (or cannot be read as a version), so it gets text',
      (model) => {
        expect(claudeModelReadsPdf(model)).toBe(false);
      },
    );

    test.each([
      'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.4-2026-03-05',
      'gpt-5.2-2025-12-11', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5.1-codex',
      'gpt-4o', 'gpt-4o-mini', 'gpt-4o-2024-08-06',
      'openai/gpt-6-luna', 'ft:gpt-4o-2024-08-06:acme::abc123',
    ])('OpenAI: %s reads PDFs', (model) => {
      expect(openAIModelReadsPdf(model)).toBe(true);
    });

    // These read PDFs on OpenAI's API. The request this node builds around a file part
    // (openai-provider.ts, completeWithNativeClient) is not one they take: max_tokens and a
    // reasoning object. Until it is, they get the text, not a rejected request per PDF.
    test.each(['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.5-preview', 'o1', 'o1-2024-12-17', 'o3', 'o3-pro', 'o4-mini'])(
      'OpenAI: %s is not sent a PDF file by this node, so it gets text',
      (model) => {
        expect(openAIModelReadsPdf(model)).toBe(false);
        expect(nativePdfSupport('openai', model)).toMatchObject({ native: false, family: null });
      },
    );

    test.each(['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1-mini', 'o1-preview', 'o3-mini', 'gpt-oss-120b', 'davinci-002', ''])(
      'OpenAI: %s does not, so it gets text',
      (model) => {
        expect(openAIModelReadsPdf(model)).toBe(false);
      },
    );

    test('no other class sends a PDF block, whatever the model', () => {
      expect(pdfFamilyOf('anthropic', 'claude-sonnet-5')).toBe('anthropic');
      expect(pdfFamilyOf('openai', 'gpt-5.6-terra')).toBe('openai');
      expect(pdfFamilyOf('xai', 'grok-4.6')).toBeNull();
      expect(pdfFamilyOf('hyperbolic', 'meta-llama/Llama-3.3-70B-Instruct')).toBeNull();
      expect(pdfFamilyOf('ollama', 'gemma4:e4b')).toBeNull();
      // Even a model that reads PDFs on its own API: this is OpenRouter's request.
      expect(pdfFamilyOf('openrouter', 'anthropic/claude-sonnet-5')).toBeNull();
    });
  });

  describe('on this node: the provider name in any case, and the gateway route', () => {
    test.each([
      ['openai', 'gpt-5.6-terra', 'openai'],
      ['OpenAI', 'gpt-5.6-terra', 'openai'],
      ['OPENAI', 'gpt-5.6-terra', 'openai'],
      ['anthropic', 'claude-sonnet-5', 'anthropic'],
      ['Anthropic', 'claude-sonnet-5', 'anthropic'],
      [' Anthropic ', 'claude-sonnet-5', 'anthropic'],
    ])('%s / %s is native (the old lists compared "OpenAI" / "Anthropic" exactly, and manifests send lower case)', (provider, model, family) => {
      expect(nativePdfSupport(provider, model)).toMatchObject({ native: true, family });
    });

    test('the bounty-398 jury, as its manifest names it, is native for both jurors', () => {
      expect(nativePdfSupport('openai', 'gpt-5.6-terra').native).toBe(true);
      expect(nativePdfSupport('anthropic', 'claude-sonnet-5').native).toBe(true);
    });

    test.each([
      ['xai', 'grok-4.6'],
      ['xAI', 'grok-4.20-0309-reasoning'],
      ['Grok', 'grok-4.6'],
      ['hyperbolic', 'deepseek-ai/DeepSeek-R1'],
      ['Hyperbolic API', 'moonshotai/Kimi-K2-Instruct'],
      ['ollama', 'llava:7b'],
      ['Open-source', 'qwen3.5:9b'],
      ['openrouter', 'google/gemini-4-argon'],
      ['openai', 'gpt-4'],
      ['anthropic', 'claude-2.1'],
    ])('%s / %s gets text', (provider, model) => {
      expect(nativePdfSupport(provider, model)).toMatchObject({ native: false, family: null });
    });

    test('a class routed to OpenRouter by its override gets text, the other class stays native', () => {
      process.env.ANTHROPIC_CLASS_PROVIDER = 'openrouter';
      process.env.OPENROUTER_API_KEY = 'test-key';

      const claude = nativePdfSupport('anthropic', 'claude-sonnet-5');
      expect(claude).toMatchObject({ native: false, family: null });
      expect(claude.reason).toBe('anthropic is routed through OpenRouter here, whose request carries no PDF block');
      expect(nativePdfSupport('openai', 'gpt-5.6-terra').native).toBe(true);
    });

    test('AI_GATEWAY=openrouter routes every class away: nobody is native', () => {
      process.env.AI_GATEWAY = 'openrouter';
      process.env.OPENROUTER_API_KEY = 'test-key';

      expect(nativePdfSupport('openai', 'gpt-5.6-terra').native).toBe(false);
      expect(nativePdfSupport('anthropic', 'claude-sonnet-5').native).toBe(false);
    });

    test('a class with no native key falls to OpenRouter, and so to text', () => {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OPENROUTER_API_KEY = 'test-key';

      expect(nativePdfSupport('anthropic', 'claude-sonnet-5').native).toBe(false);
      expect(nativePdfSupport('openai', 'gpt-5.6-terra').native).toBe(true);
    });

    test('a class forced native by its override is native even under AI_GATEWAY=openrouter', () => {
      process.env.AI_GATEWAY = 'openrouter';
      process.env.OPENROUTER_API_KEY = 'test-key';
      process.env.OPENAI_CLASS_PROVIDER = 'native';

      expect(nativePdfSupport('openai', 'gpt-5.6-terra').native).toBe(true);
      expect(nativePdfSupport('anthropic', 'claude-sonnet-5').native).toBe(false);
    });

    test('an unknown provider name gets text instead of throwing', () => {
      expect(nativePdfSupport('Mistral', 'mistral-large')).toEqual({
        native: false,
        family: null,
        reason: 'unknown provider Mistral',
      });
      expect(nativePdfSupport('', '')).toMatchObject({ native: false });
    });

    test('while the test-only mock provider answers every call, nobody is native', () => {
      process.env.VERDIKTA_TEST_MOCK_PROVIDER = '1';

      expect(nativePdfSupport('openai', 'gpt-5.6-terra')).toMatchObject({ native: false, family: null });
      expect(nativePdfSupport('anthropic', 'claude-sonnet-5').reason).toBe('the test-only mock provider reads the prompt only');
    });
  });
});
