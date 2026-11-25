/**
 * The work one request may make this arbiter do (utils/workBudget.js): the jury size, the
 * attachments, the archives, and how often a failed AI Node call is repeated.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

jest.mock('axios');
const axios = require('axios');
const mockPost = jest.fn();
axios.create.mockReturnValue({ post: mockPost });

const aiClient = require('../../services/aiClient');
const config = require('../../config');
const { extractEvidenceArchive } = require('../../utils/evidenceBoundary');
const { DEFAULT_WORK_BUDGET, workBudgetFromEnv, isWorkBudgetError } = require('../../utils/workBudget');

const model = (count = 1) => ({ provider: 'OpenAI', model: 'gpt-5.6-sol', weight: 1, count });
const httpError = (status, data = {}) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

describe('AI Node retries', () => {
  const saved = aiClient.retryOptions;
  beforeEach(() => {
    mockPost.mockReset();
    // the configured retry count, without the configured back-off waits
    aiClient.retryOptions = { ...config.retry, minTimeout: 1, maxTimeout: 1 };
  });
  afterAll(() => { aiClient.retryOptions = saved; });

  test('a failing AI Node is called 3 times in all, not 11', async () => {
    mockPost.mockRejectedValue(httpError(503));
    await expect(aiClient.evaluate({ prompt: 'p', models: [model()] })).rejects.toThrow();
    expect(mockPost).toHaveBeenCalledTimes(3);
  });

  test('a timed-out jury is not started again (408 from the AI Node)', async () => {
    mockPost.mockRejectedValue(httpError(408, { error: 'Request timeout: exceeded 240000ms limit', timeout: true }));
    await expect(aiClient.evaluate({ prompt: 'p', models: [model()] })).rejects.toThrow();
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  test('nor after the adapter\'s own socket timeout', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('timeout of 300000ms exceeded'), { code: 'ECONNABORTED' }));
    await expect(aiClient.evaluate({ prompt: 'p', models: [model()] })).rejects.toThrow();
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});

describe('jury and attachment budget', () => {
  let dir;
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue({ data: { scores: [{ outcome: 'DONT_FUND', score: 400000 }, { outcome: 'FUND', score: 600000 }], justification: 'ok' } });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-budget-'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: '1.0' }));
    fs.writeFileSync(path.join(dir, 'evidence.txt'), 'x'.repeat(4096));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const k of ['EA_MAX_MODEL_CALLS', 'EA_MAX_ATTACHMENT_BYTES']) delete process.env[k];
  });

  test('the defaults are the class map ceilings (panel 5 x NO_COUNTS 2 x ITERATIONS 3)', () => {
    expect(workBudgetFromEnv({})).toEqual(DEFAULT_WORK_BUDGET);
    expect(DEFAULT_WORK_BUDGET.maxModelCalls).toBe(30);
    expect(workBudgetFromEnv({ EA_MAX_MODEL_CALLS: '60', EA_MAX_ITERATIONS: 'x' }))
      .toMatchObject({ maxModelCalls: 60, maxIterations: 3 });
  });

  test('the largest jury the manifest schema allows (10 models x 5 counts x 5 iterations) is refused unsent', async () => {
    const query = { prompt: 'p', iterations: 5, models: Array.from({ length: 10 }, () => model(5)) };
    await expect(aiClient.evaluate(query, dir)).rejects.toMatchObject({ code: 'WORK_BUDGET', statusCode: 400 });
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('a class-sized jury (5 models x 2 counts x 3 iterations) is sent', async () => {
    const query = { prompt: 'p', iterations: 3, models: Array.from({ length: 5 }, () => model(2)) };
    await aiClient.evaluate(query, dir);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  test('ITERATIONS above the limit is refused even with one model', async () => {
    await expect(aiClient.evaluate({ prompt: 'p', iterations: 4, models: [model()] }, dir))
      .rejects.toMatchObject({ code: 'WORK_BUDGET' });
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('one file listed under many names counts every time it would be sent', async () => {
    const additional = Array.from({ length: DEFAULT_WORK_BUDGET.maxAttachments + 1 },
      (_, i) => ({ name: `copy${i}`, filename: 'evidence.txt', type: 'text/plain' }));
    await expect(aiClient.evaluate({ prompt: 'p', models: [model()], additional }, dir))
      .rejects.toMatchObject({ code: 'WORK_BUDGET' });
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('attachment bytes are summed before any is read', async () => {
    process.env.EA_MAX_ATTACHMENT_BYTES = String(3 * 4096);
    const additional = Array.from({ length: 4 }, (_, i) => ({ name: `c${i}`, filename: 'evidence.txt', type: 'text/plain' }));
    await expect(aiClient.evaluate({ prompt: 'p', models: [model()], additional }, dir))
      .rejects.toMatchObject({ code: 'WORK_BUDGET' });
    await aiClient.evaluate({ prompt: 'p', models: [model()], additional: additional.slice(0, 3) }, dir);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});

describe('archive limits', () => {
  let temp;
  const service = { extractArchive: jest.fn(async (_data, _name, destination) => {
    const out = path.join(destination, 'archive');
    fs.mkdirSync(out, { recursive: true });
    return out;
  }) };
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'work-budget-zip-'));
    service.extractArchive.mockClear();
  });
  afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

  function bomb(bytes) {
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from('{}'));
    zip.addFile('zeros.bin', Buffer.alloc(bytes));
    return zip.toBuffer();
  }

  /** The same archive with every declared uncompressed size rewritten to 1 (central directory and local headers). */
  function lyingSizes(buffer) {
    const out = Buffer.from(buffer);
    for (let i = 0; i + 4 <= out.length; i++) {
      const sig = out.readUInt32LE(i);
      if (sig === 0x02014b50) out.writeUInt32LE(1, i + 24); // central directory: uncompressed size
      if (sig === 0x04034b50) out.writeUInt32LE(1, i + 22); // local header: uncompressed size
    }
    return out;
  }

  test('a high-ratio archive is refused before extraction (8 MiB of zeros in a few KB)', async () => {
    const data = bomb(8 * 1024 * 1024);
    expect(data.length).toBeLessThan(64 * 1024);
    const budget = { ...DEFAULT_WORK_BUDGET, maxExtractedBytes: 1024 * 1024 };
    const error = await extractEvidenceArchive(service, data, 'archive.zip', temp, budget).catch(e => e);
    expect(isWorkBudgetError(error)).toBe(true);
    expect(service.extractArchive).not.toHaveBeenCalled();
  });

  test('declared sizes that lie do not get past the inflated-bytes count', async () => {
    const data = lyingSizes(bomb(8 * 1024 * 1024));
    const budget = { ...DEFAULT_WORK_BUDGET, maxExtractedBytes: 1024 * 1024 };
    const error = await extractEvidenceArchive(service, data, 'archive.zip', temp, budget).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(service.extractArchive).not.toHaveBeenCalled();
  });

  test('too many entries are refused', async () => {
    const zip = new AdmZip();
    for (let i = 0; i < 6; i++) zip.addFile(`f${i}.txt`, Buffer.from('x'));
    const budget = { ...DEFAULT_WORK_BUDGET, maxArchiveEntries: 5 };
    await expect(extractEvidenceArchive(service, zip.toBuffer(), 'archive.zip', temp, budget))
      .rejects.toMatchObject({ code: 'WORK_BUDGET' });
    expect(service.extractArchive).not.toHaveBeenCalled();
  });

  test('an ordinary archive is extracted', async () => {
    await expect(extractEvidenceArchive(service, bomb(1024), 'archive.zip', temp)).resolves.toBe(path.join(temp, 'archive'));
    expect(service.extractArchive).toHaveBeenCalledTimes(1);
  });
});
