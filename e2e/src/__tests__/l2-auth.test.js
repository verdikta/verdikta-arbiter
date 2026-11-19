'use strict';
jest.mock('axios');
jest.mock('../l2/mock-ai-node');
jest.mock('../l2/boot-adapter');
const axios = require('axios');
const { runL2, callEvaluate } = require('../l2/run-l2');
const { startMockAiNode } = require('../l2/mock-ai-node');
const { bootAdapter } = require('../l2/boot-adapter');
const TOKEN = 'e'.repeat(64);
let env;
beforeEach(() => {
  env = { ...process.env }; delete process.env.EA_API_TOKEN; delete process.env.AI_NODE_API_TOKEN;
  jest.clearAllMocks();
  axios.get.mockResolvedValue({ status: 404 });
  axios.post.mockImplementation(async (_url, { data }) => ({ data: { data: data.cid.startsWith('1:')
    ? { aggregatedScore: ['12345'], justificationCid: '' }
    : { aggregatedScore: [1000000, 0], justificationCid: 'Qm' + 'a'.repeat(44) + ':12345678901234567890' } } }));
  startMockAiNode.mockResolvedValue({ url: 'http://127.0.0.1:8547', close: jest.fn() });
  bootAdapter.mockResolvedValue({ close: jest.fn() });
});
afterEach(() => { process.env = env; });
const cfg = { adapterUrl: 'http://127.0.0.1:8080', aiNodeUrl: 'http://127.0.0.1:3000',
  mockAi: {}, timeouts: { evaluateMs: 100 }, tolerances: { scoreSumTarget: 1000000, scoreSumSlack: 0 },
  ipfs: { checkJustificationFetch: false } };
const scenario = { id: 'sample', cid: 'Qm' + 'a'.repeat(44), modes: ['1'] };
test('existing adapters require a configured credential before any network request', async () => {
  await expect(callEvaluate(cfg.adapterUrl, scenario.cid)).rejects.toThrow('EA_API_TOKEN');
  expect(axios.post).not.toHaveBeenCalled();
});
test('commit and reveal share identity and authentication, with no redirects or secrets in reports', async () => {
  process.env.EA_API_TOKEN = TOKEN;
  const reporter = { addCase: jest.fn() };
  await runL2(cfg, [scenario], { mock: false, reporter });
  expect(axios.post).toHaveBeenCalledTimes(2);
  const commit = axios.post.mock.calls[0], reveal = axios.post.mock.calls[1];
  expect(reveal[1].id).toBe(commit[1].id);
  expect(reveal[1].data.aggId).toBe(commit[1].data.aggId);
  expect(commit[1].data.aggId).toMatch(/^0x[0-9a-f]{64}$/);
  expect(reveal[2]).toMatchObject({ maxRedirects: 0, headers: { Authorization: `Bearer ${TOKEN}` } });
  expect(JSON.stringify(reporter.addCase.mock.calls)).not.toContain(TOKEN);
});
test('a disposable mock run passes independent ephemeral keys to its child adapter', async () => {
  await runL2(cfg, [scenario], { mock: true, bootAdapter: true, reporter: { addCase: jest.fn() } });
  const { token, aiToken } = bootAdapter.mock.calls[0][0];
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(aiToken).toMatch(/^[0-9a-f]{64}$/);
  expect(token).not.toBe(aiToken);
  expect(axios.post.mock.calls[0][2].headers.Authorization).toBe(`Bearer ${token}`);
  expect(process.env.EA_API_TOKEN).toBeUndefined();
});
