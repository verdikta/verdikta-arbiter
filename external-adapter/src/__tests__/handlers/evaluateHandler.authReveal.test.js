// Real HTTP middleware, handler, archive creation and commit store. Only the
// IPFS/AI network edges are mocked; no provider, chain or gateway calls.
const request = require('supertest');
jest.mock('../../services/aiClient');
const mockState = {};
jest.mock('@verdikta/common', () => {
  const actual = jest.requireActual('@verdikta/common');
  return { ...actual, createClient: cfg => {
    const client = actual.createClient({ ...cfg, logging: { level: 'error', console: false } });
    client.archiveService.getArchive = jest.fn();
    client.ipfsClient.uploadToIPFS = jest.fn();
    mockState.client = client;
    return client;
  }};
});
const handler = require('../../handlers/evaluateHandler');
const store = require('../../services/commitStore');
const { createApp } = require('../../app');
const app = createApp(handler);
let server;
beforeAll(async () => {
  server = require('http').createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
});
afterAll(async () => { if (server?.listening) await new Promise(resolve => server.close(resolve)); });
const HASH = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const PADDED = HASH.padStart(64, '0');
const DECIMAL = BigInt('0x' + HASH).toString();
const AGG = '0x' + 'ab'.repeat(32);
const LIVE = '1'.repeat(64);       // a second commitment (the store takes commitment-shaped keys only)
const TOKEN = 'e'.repeat(64);
const AI_TOKEN = 'a'.repeat(64);
const body = (overrides = {}) => ({ id: 'job-1', data: { cid: `2:${DECIMAL}`, aggId: AGG }, ...overrides });
let originalEnv, entry;
beforeEach(async () => {
  originalEnv = { ...process.env };
  process.env.EA_API_TOKEN = TOKEN;
  process.env.AI_NODE_API_TOKEN = AI_TOKEN;
  jest.clearAllMocks();
  mockState.client.ipfsClient.uploadToIPFS.mockResolvedValue('QmJustification');
  entry = {
    result: { scores: [{ outcome: 'No', score: 1000000 }], justification: 'saved result' },
    salt: '1234567890abcdef1234567890abcdef', created: new Date().toISOString(), expiresAt: Date.now() + 60000,
    scope: { jobId: 'job-1', aggId: AGG, operator: process.env.OPERATOR_ADDR.toLowerCase() },
  };
  await store.save(PADDED, entry);
});
afterEach(async () => { process.env = originalEnv; await store.del(PADDED); });

test.each([undefined, 'Bearer wrong', `Bearer ${AI_TOKEN}`, `Bearer ${TOKEN} extra`, TOKEN])(
  'unauthorized HTTP reveal does not upload or change state (%s)', async authorization => {
    let req = request(server).post('/evaluate').set('X-Forwarded-For', '127.0.0.1');
    if (authorization) req = req.set('Authorization', authorization);
    const res = await req.send(body());
    expect(res.status).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toHaveProperty('data');
    expect(await store.get(PADDED)).toEqual(entry);
    expect(mockState.client.ipfsClient.uploadToIPFS).not.toHaveBeenCalled();
    expect(mockState.client.archiveService.getArchive).not.toHaveBeenCalled();
  });
test('authentication runs before JSON parsing; missing configuration fails closed', async () => {
  const malformed = await request(server).post('/evaluate').set('Content-Type', 'application/json').send('{');
  expect(malformed.status).toBe(401);
  delete process.env.EA_API_TOKEN;
  expect((await request(server).post('/evaluate').set('Authorization', `Bearer ${TOKEN}`).send(body())).status).toBe(503);
  expect(mockState.client.ipfsClient.uploadToIPFS).not.toHaveBeenCalled();
});
test('authorized requests still enforce JSON syntax', async () => {
  const res = await request(server).post('/evaluate').set('Authorization', `Bearer ${TOKEN}`)
    .set('Content-Type', 'application/json').send('{');
  expect(res.status).toBe(400);
  expect(mockState.client.ipfsClient.uploadToIPFS).not.toHaveBeenCalled();
});
test('read-only version remains available to monitoring', async () => {
  expect((await request(server).get('/version')).status).toBe(200);
  expect(await store.get(PADDED)).toEqual(entry);
});
test.each([
  ['different job', { id: 'job-2' }, {}],
  ['different aggregation', { data: { cid: `2:${DECIMAL}`, aggId: '0x' + 'cd'.repeat(32) } }, {}],
  ['different operator', {}, { scope: { jobId: 'job-1', aggId: AGG, operator: '0x' + '00'.repeat(20) } }],
  ['expired', {}, { expiresAt: Date.now() - 1 }],
  ['legacy unscoped entry', {}, { scope: undefined }],
])('rejects %s without changing the commitment', async (_name, overrides, change) => {
  const saved = { ...entry, ...change };
  await store.save(PADDED, saved);
  const res = await handler(body(overrides));
  expect(res.statusCode).toBe(403);
  expect(mockState.client.ipfsClient.uploadToIPFS).not.toHaveBeenCalled();
  expect(await store.get(PADDED)).toEqual(saved);
});
test.each(['-1', '0xxyz', (1n << 256n).toString(), '0x' + 'f'.repeat(65), 'f'.repeat(65)])(
  'rejects malformed or out-of-range commitment %s', async hash => {
    expect((await handler(body({ data: { cid: `2:${hash}`, aggId: AGG } }))).statusCode).toBe(400);
    expect(mockState.client.ipfsClient.uploadToIPFS).not.toHaveBeenCalled();
  });
test('requires aggregation identity and treats unknown hashes as unauthorized', async () => {
  expect((await handler(body({ data: { cid: `2:${DECIMAL}` } }))).statusCode).toBe(400);
  expect((await handler(body({ data: { cid: '2:123', aggId: AGG } }))).statusCode).toBe(403);
});
test('HTTP retries return exactly the original scores, CID and salt without deleting or reuploading', async () => {
  const first = await request(server).post('/evaluate').set('Authorization', `Bearer ${TOKEN}`).send(body());
  const second = await request(server).post('/evaluate').set('Authorization', `Bearer ${TOKEN}`)
    .send(body({ data: { cid: `2:0x${HASH}`, aggId: AGG.toUpperCase() } }));
  expect(first.status).toBe(200);
  expect(first.body.data.justificationCid).toBe(`QmJustification:${entry.salt}`);
  expect(second.body).toEqual(first.body);
  expect(mockState.client.ipfsClient.uploadToIPFS).toHaveBeenCalledTimes(1);
  expect(await store.get(PADDED)).toEqual({ ...entry, justificationCid: 'QmJustification' });
});
test('concurrent authorized reveals share one upload; wrong scope cannot join it', async () => {
  let uploaded, finish;
  const started = new Promise(resolve => { uploaded = resolve; });
  mockState.client.ipfsClient.uploadToIPFS.mockImplementation(() => {
    uploaded(); return new Promise(resolve => { finish = resolve; });
  });
  const first = handler(body());
  await started;
  const second = handler(body());
  const denied = await handler(body({ id: 'job-2' }));
  expect(denied.statusCode).toBe(403);
  finish('QmConcurrent');
  const [a, b] = await Promise.all([first, second]);
  expect(a.statusCode).toBe(200);
  expect(b).toEqual(a);
  expect(mockState.client.ipfsClient.uploadToIPFS).toHaveBeenCalledTimes(1);
});
test('upload failure retains state and permits retry', async () => {
  mockState.client.ipfsClient.uploadToIPFS.mockRejectedValueOnce(new Error('Transient upload failure'));
  expect((await handler(body())).statusCode).toBe(500);
  expect(await store.get(PADDED)).toEqual(entry);
  expect((await handler(body())).statusCode).toBe(200);
  expect(mockState.client.ipfsClient.uploadToIPFS).toHaveBeenCalledTimes(2);
});
test('handles all-digit bare hex commitments from the dispatcher as well as decimal commitments', async () => {
  const hash = '1234567890123456789012345678901234567890123456789012345678901234';
  const decimalInterpretation = BigInt(hash).toString(16).padStart(64, '0');
  try {
    await store.save(hash, { ...entry });
    const bare = await handler(body({ data: { cid: `2:${hash}`, aggId: AGG } }));
    const decimal = await handler(body({ data: { cid: `2:${BigInt('0x' + hash)}`, aggId: AGG } }));
    expect(bare.statusCode).toBe(200);
    expect(decimal).toEqual(bare);
    expect(mockState.client.ipfsClient.uploadToIPFS).toHaveBeenCalledTimes(1);
    // If both interpretations are live in the same scope, require explicit hex.
    await store.save(decimalInterpretation, { ...entry });
    expect((await handler(body({ data: { cid: `2:${hash}`, aggId: AGG } }))).statusCode).toBe(403);
    expect((await handler(body({ data: { cid: `2:0x${hash}`, aggId: AGG } }))).statusCode).toBe(200);
  } finally { await store.del(hash); await store.del(decimalInterpretation); }
});
test('cleanup expires retained results and leaves live commitments intact', async () => {
  await handler(body());
  const saved = await store.get(PADDED);
  await store.save(PADDED, { ...saved, expiresAt: Date.now() - 1 });
  await store.save(LIVE, { ...entry });
  await store.purgeStale();
  expect(await store.get(PADDED)).toBeUndefined();
  expect(await store.get(LIVE)).toEqual(entry);
  await store.del(LIVE);
});
