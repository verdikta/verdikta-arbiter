import { resolveProviderConfig } from '../../../lib/llm/provider-config';

describe('provider-config precedence', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AI_GATEWAY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_CLASS_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AI_GATEWAY_LEGACY_NATIVE_FALLBACK;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('defaults to openrouter when OPENROUTER_API_KEY is set', () => {
    process.env.OPENROUTER_API_KEY = 'or-key';

    const result = resolveProviderConfig('openai');

    expect(result.backend).toBe('openrouter');
    expect(result.reason).toContain('default openrouter');
  });

  test('native key present without AI_GATEWAY still routes to openrouter by default', () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.OPENAI_API_KEY = 'native-key';

    const result = resolveProviderConfig('OpenAI');

    expect(result.backend).toBe('openrouter');
  });

  test('AI_GATEWAY=native with native key routes to native', () => {
    process.env.AI_GATEWAY = 'native';
    process.env.OPENAI_API_KEY = 'native-key';

    const result = resolveProviderConfig('openai');

    expect(result.backend).toBe('native');
    expect(result.reason).toContain('AI_GATEWAY');
  });

  test('per-class override takes precedence over global', () => {
    process.env.AI_GATEWAY = 'openrouter';
    process.env.OPENAI_CLASS_PROVIDER = 'native';

    const result = resolveProviderConfig('openai');

    expect(result.backend).toBe('native');
    expect(result.reason).toContain('CLASS_PROVIDER');
  });

  test('ollama always resolves to native', () => {
    process.env.AI_GATEWAY = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'or-key';

    const result = resolveProviderConfig('ollama');

    expect(result.backend).toBe('native');
    expect(result.reason).toContain('local-only');
  });
});
