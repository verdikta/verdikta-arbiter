jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((data: any) => ({
      json: jest.fn().mockResolvedValue(data),
    })),
  },
}));

import { NextResponse } from 'next/server';
import { GET } from '../../app/api/health/route';

describe('GET /api/health', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AI_GATEWAY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_CLASS_PROVIDER;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('returns ok status with ai_gateway section', async () => {
    process.env.OPENROUTER_API_KEY = 'or-key';

    const response = await GET();
    const body = await response.json();

    expect(body.status).toBe('ok');
    expect(body.ai_gateway).toBeDefined();
    expect(body.ai_gateway.openrouterConfigured).toBe(true);
  });

  test('ai_gateway.routing includes all provider classes', async () => {
    process.env.OPENROUTER_API_KEY = 'or-key';

    const response = await GET();
    const body = await response.json();

    const classes = body.ai_gateway.routing.map((r: any) => r.class);
    expect(classes).toEqual(expect.arrayContaining(['openai', 'anthropic', 'xai', 'hyperbolic', 'ollama']));
  });

  test('ollama always shows native backend', async () => {
    process.env.OPENROUTER_API_KEY = 'or-key';

    const response = await GET();
    const body = await response.json();

    const ollama = body.ai_gateway.routing.find((r: any) => r.class === 'ollama');
    expect(ollama.backend).toBe('native');
  });

  test('non-ollama classes default to openrouter when key is set', async () => {
    process.env.OPENROUTER_API_KEY = 'or-key';

    const response = await GET();
    const body = await response.json();

    const openai = body.ai_gateway.routing.find((r: any) => r.class === 'openai');
    expect(openai.backend).toBe('openrouter');
  });

  test('reflects native override in routing', async () => {
    process.env.AI_GATEWAY = 'native';
    process.env.OPENAI_API_KEY = 'native-key';

    const response = await GET();
    const body = await response.json();

    const openai = body.ai_gateway.routing.find((r: any) => r.class === 'openai');
    expect(openai.backend).toBe('native');
  });

  test('shows openrouterConfigured false when key is missing', async () => {
    const response = await GET();
    const body = await response.json();

    expect(body.ai_gateway.openrouterConfigured).toBe(false);
  });
});
