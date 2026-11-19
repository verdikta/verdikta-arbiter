/** @jest-environment node */
// Exercise the real guards inside every paid/model route. No Next middleware
// is involved, and provider implementations are the only mocked boundary.
jest.mock('../../lib/llm/llm-factory', () => ({ LLMFactory: { getProvider: jest.fn() } }));
jest.mock('../../lib/llm/hyperbolic-provider', () => ({ HyperbolicProvider: jest.fn() }));
import { POST as rank } from '../../app/api/rank-and-justify/route';
import { GET as models, POST as generate } from '../../app/api/generate/route';
import { GET as probe } from '../../app/api/test-hyperbolic/route';
import { requireServiceAuth } from '../../lib/service-auth';
import { LLMFactory } from '../../lib/llm/llm-factory';
import { HyperbolicProvider } from '../../lib/llm/hyperbolic-provider';

const TOKEN = 'a'.repeat(64);
const routes = [['rank', rank], ['generate', generate], ['models', models], ['probe', probe]] as const;
let original: string | undefined;
beforeEach(() => {
  original = process.env.AI_NODE_API_TOKEN;
  process.env.AI_NODE_API_TOKEN = TOKEN;
  jest.clearAllMocks();
});
afterEach(() => {
  if (original === undefined) delete process.env.AI_NODE_API_TOKEN;
  else process.env.AI_NODE_API_TOKEN = original;
});
describe.each(routes)('%s authentication', (_name, handler) => {
  test.each([undefined, 'Bearer wrong', `Bearer ${'e'.repeat(64)}`, TOKEN, `Bearer ${TOKEN}, Bearer ${TOKEN}`])(
    'denies invalid credentials before parsing bodies or constructing a provider', async authorization => {
      const headers = new Headers({
        'X-Forwarded-For': '127.0.0.1',
        'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware',
        Cookie: `AI_NODE_API_TOKEN=${TOKEN}`,
      });
      if (authorization) headers.set('Authorization', authorization);
      const request = { headers, json: jest.fn(), formData: jest.fn() } as unknown as Request;
      const response = await handler(request);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(request.json).not.toHaveBeenCalled();
      expect(request.formData).not.toHaveBeenCalled();
      expect(LLMFactory.getProvider).not.toHaveBeenCalled();
      expect(HyperbolicProvider).not.toHaveBeenCalled();
    });
  test.each([undefined, '', 'short'])('fails closed when the server key is absent or invalid', async token => {
    if (token === undefined) delete process.env.AI_NODE_API_TOKEN;
    else process.env.AI_NODE_API_TOKEN = token;
    const response = await handler(new Request('http://localhost/', { headers: { Authorization: `Bearer ${TOKEN}` } }));
    expect(response.status).toBe(503);
    expect(LLMFactory.getProvider).not.toHaveBeenCalled();
    expect(HyperbolicProvider).not.toHaveBeenCalled();
  });
});
test('an authorized model listing reaches the provider', async () => {
  (LLMFactory.getProvider as jest.Mock).mockReturnValue({ getModels: jest.fn().mockResolvedValue([{ name: 'test' }]) });
  const response = await models(new Request('http://localhost/api/generate', { headers: { Authorization: `Bearer ${TOKEN}` } }));
  expect(response.status).toBe(200);
  expect((await response.json()).models.length).toBeGreaterThan(0);
  expect(LLMFactory.getProvider).toHaveBeenCalled();
});
test('authorized generation reaches the provider with its body', async () => {
  const generateResponse = jest.fn().mockResolvedValue('answer');
  (LLMFactory.getProvider as jest.Mock).mockReturnValue({ generateResponse, supportsAttachments: () => false, supportsImages: () => false });
  const form = new FormData();
  form.set('prompt', 'Question'); form.set('provider', 'OpenAI'); form.set('model', 'test');
  const response = await generate(new Request('http://localhost/api/generate', {
    method: 'POST', body: form, headers: { Authorization: `Bearer ${TOKEN}` },
  }));
  expect(response.status).toBe(200);
  expect(generateResponse).toHaveBeenCalledWith('Question', 'test');
});
test('authorized probe reaches the provider', async () => {
  (HyperbolicProvider as jest.Mock).mockImplementation(() => ({ initialize: jest.fn(), getModels: jest.fn().mockResolvedValue([]) }));
  const response = await probe(new Request('http://localhost/api/test-hyperbolic', { headers: { Authorization: `Bearer ${TOKEN}` } }));
  expect(response.status).toBe(200);
  expect(HyperbolicProvider).toHaveBeenCalledTimes(1);
});
test('authorized ranking reaches normal input validation', async () => {
  const response = await rank(new Request('http://localhost/api/rank-and-justify', {
    method: 'POST', body: JSON.stringify({}), headers: { Authorization: `Bearer ${TOKEN}` },
  }));
  expect(response.status).toBe(400);
  expect(await response.json()).not.toEqual({ error: 'Unauthorized' });
});
test('bearer scheme is case insensitive; token content is case sensitive', () => {
  expect(requireServiceAuth(new Request('http://localhost', { headers: { Authorization: `bearer ${TOKEN}` } }))).toBeNull();
  expect(requireServiceAuth(new Request('http://localhost', { headers: { Authorization: `Bearer ${TOKEN.toUpperCase()}` } }))?.status).toBe(401);
});
