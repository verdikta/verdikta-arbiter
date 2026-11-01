// GET /health and GET /version report the code-review mode, so an operator
// (and the doctor) can see dev trust is on, or refused, without reading env.

jest.mock('../handlers/evaluateHandler', () => {
  const handler = jest.fn(async (body) => ({ jobRunID: body.id, statusCode: 200, status: 'success', data: {} }));
  handler.fetchCache = { stats: () => ({ entries: 0 }) };
  return handler;
});

const supertest = require('supertest');
const { codeReview } = require('@verdikta/common');
const { createApp } = require('../app');
const { loadCodeReviewConfig } = require('../codeReview/config');

const DEV_KEY = codeReview.createDevBuilderKey();
const TOKEN = 'runner-token-0123456789abcdef0123456789abcdef';
const DEV_ENV = {
  CODE_REVIEW_ENABLED: 'true',
  CODE_RUNNER_URL: 'http://127.0.0.1:8090',
  CODE_RUNNER_TOKEN: TOKEN,
  CODE_REVIEW_TRUST: 'dev',
  CODE_REVIEW_DEV_KEYS: DEV_KEY.publicKey,
  NETWORK_CHAIN_ID: '84532'
};

afterAll(() => loadCodeReviewConfig({}));

describe('GET /health', () => {
  it('reports production trust and code review off by default', async () => {
    loadCodeReviewConfig({});
    const res = await supertest(createApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.codeReview).toMatchObject({ enabled: false, ready: false, trust: 'production' });
  });

  it('shows dev trust when CODE_REVIEW_TRUST=dev is active', async () => {
    loadCodeReviewConfig(DEV_ENV);
    const res = await supertest(createApp()).get('/health');
    expect(res.body.codeReview).toMatchObject({ enabled: true, ready: true, trust: 'dev', devKeyCount: 1, chainId: 84532 });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });

  it('shows dev trust refused on Base mainnet', async () => {
    loadCodeReviewConfig({ ...DEV_ENV, NETWORK_CHAIN_ID: '8453' });
    const res = await supertest(createApp()).get('/health');
    expect(res.body.codeReview).toMatchObject({ ready: false, trust: 'dev-refused', chainId: 8453 });
  });
});

describe('GET /version', () => {
  it('carries the same code-review block', async () => {
    loadCodeReviewConfig(DEV_ENV);
    const res = await supertest(createApp()).get('/version');
    expect(res.body.service).toBe('verdikta-external-adapter');
    expect(res.body.codeReview).toMatchObject({ trust: 'dev', ready: true });
  });
});

describe('POST /evaluate', () => {
  it('still routes to the handler', async () => {
    const res = await supertest(createApp()).post('/evaluate').send({ id: 'x', data: { cid: 'Qm' } });
    expect(res.status).toBe(200);
    expect(res.body.jobRunID).toBe('x');
  });
});
