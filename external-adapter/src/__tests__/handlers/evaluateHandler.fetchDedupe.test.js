// Handler-level tests for #69: one dispatcher request fans out to several of
// the node's jobs within milliseconds, and each used to download the same
// archive CIDs. Only the network edges are mocked — the raw IPFS fetch
// (ipfsClient.fetchFromIPFS, which the handler wraps with the cache), the IPFS
// upload and the AI Node; extraction, validation, triage and the commit store
// are the real thing.

const fs = require('fs');
const path = require('path');

jest.mock('../../services/aiClient');

const mockState = {};
jest.mock('@verdikta/common', () => {
  const actual = jest.requireActual('@verdikta/common');
  return {
    ...actual,
    createClient: (cfg) => {
      const client = actual.createClient({ ...cfg, logging: { level: 'error', console: false } });
      client.ipfsClient.fetchFromIPFS = jest.fn(); // the raw gateway fetch; the handler wraps it
      client.ipfsClient.uploadToIPFS = jest.fn();
      mockState.client = client;
      mockState.rawFetch = client.ipfsClient.fetchFromIPFS;
      return client;
    }
  };
});

const evaluateHandler = require('../../handlers/evaluateHandler');
const aiClient = require('../../services/aiClient');

const FIXTURES = path.join(__dirname, '..', 'integration', 'fixtures', 'bcid');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

const cid = (label) => 'Qm' + label.padEnd(44, 'a');
const PRIMARY = cid('BountyPrimary');
const CONFORMING = cid('Conforming');
const NOT_ZIP = cid('NotZip');
const ARCHIVES = { [PRIMARY]: 'bounty-primary.zip', [CONFORMING]: 'bcid-conforming.zip', [NOT_ZIP]: 'bcid-not-a-zip.zip' };

const AI_RESULT = {
  scores: [{ outcome: 'DONT_FUND', score: 250000 }, { outcome: 'FUND', score: 750000 }],
  justification: 'AI panel says fund it'
};

const request = (cidString, id) => ({ id, data: { cid: cidString, aggId: '0xagg' } });
const fetchesOf = (c) => mockState.rawFetch.mock.calls.filter(([x]) => x === c).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fetchLatencyMs;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  fetchLatencyMs = 0;
  // A fresh cache per test: forget everything the previous test fetched.
  for (const c of Object.keys(ARCHIVES)) evaluateHandler.fetchCache.forget(c);
  mockState.rawFetch.mockImplementation(async (c) => {
    if (fetchLatencyMs) await sleep(fetchLatencyMs);
    if (!ARCHIVES[c]) throw new Error(`Failed to fetch from IPFS after 3 attempts: ${c}`);
    return fixture(ARCHIVES[c]);
  });
  mockState.client.ipfsClient.uploadToIPFS.mockResolvedValue('QmJustification');
  aiClient.evaluate.mockResolvedValue(AI_RESULT);
});

afterEach(() => console.log.mockRestore());

describe('evaluateHandler — shared IPFS fetches across a dispatcher fan-out (#69)', () => {
  it('three jobs selected for the same request download each CID once and finish in about one fetch latency', async () => {
    fetchLatencyMs = 200;
    const before = evaluateHandler.fetchCache.stats();
    const t0 = Date.now();
    const results = await Promise.all(['job-1', 'job-2', 'job-3'].map((id) => evaluateHandler(request(`1:${PRIMARY},${CONFORMING}`, id))));
    const elapsed = Date.now() - t0;
    const after = evaluateHandler.fetchCache.stats();
    process.stdout.write(`[timing] 3 concurrent jobs × 2 CIDs, ${fetchLatencyMs} ms per download: ${elapsed} ms wall, ${mockState.rawFetch.mock.calls.length} download(s)\n`);

    for (const r of results) {
      expect(r.statusCode).toBe(200);
      expect(r.data.aggregatedScore).toHaveLength(1); // a commitment
    }
    expect(mockState.rawFetch).toHaveBeenCalledTimes(2);
    expect(fetchesOf(PRIMARY)).toBe(1);
    expect(fetchesOf(CONFORMING)).toBe(1);
    expect(after.inFlightReuses - before.inFlightReuses).toBe(4); // 2 extra jobs × 2 CIDs
    expect(elapsed).toBeLessThan(fetchLatencyMs * 3);
  });

  it('a job selected moments later is served from cache without a gateway request', async () => {
    await evaluateHandler(request(`1:${PRIMARY},${CONFORMING}`, 'job-1'));
    const before = evaluateHandler.fetchCache.stats();
    const later = await evaluateHandler(request(`1:${PRIMARY},${CONFORMING}`, 'job-4'));
    expect(later.statusCode).toBe(200);
    expect(mockState.rawFetch).toHaveBeenCalledTimes(2);
    expect(evaluateHandler.fetchCache.stats().hits - before.hits).toBe(2);
  });

  it('the single-CID path is shared too', async () => {
    const results = await Promise.all(['job-1', 'job-2'].map((id) => evaluateHandler(request(`1:${PRIMARY}`, id))));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(fetchesOf(PRIMARY)).toBe(1);
  });

  it('a failed download is reported to every waiting job and is not cached', async () => {
    const MISSING = cid('Missing');
    fetchLatencyMs = 200; // a real gateway failure takes seconds, so concurrent jobs share it
    const results = await Promise.all(['job-1', 'job-2'].map((id) => evaluateHandler(request(`1:${PRIMARY},${MISSING}`, id))));
    for (const r of results) {
      expect(r.statusCode).toBe(500);
      expect(r.status).toBe('errored');
      expect(r.error).toBe('Unable to fetch archive from IPFS.');
      expect(r.data.aggregatedScore).toEqual([0]); // no commitment
    }
    expect(fetchesOf(MISSING)).toBe(1); // the failure itself was shared
    expect(fetchesOf(PRIMARY)).toBe(1);

    const retry = await evaluateHandler(request(`1:${PRIMARY},${MISSING}`, 'job-3'));
    expect(retry.statusCode).toBe(500);
    expect(fetchesOf(MISSING)).toBe(2); // fetched again, nothing was cached
    expect(fetchesOf(PRIMARY)).toBe(1); // the good archive was
  });

  it('a malformed submitted-work archive is never kept, the requester package is', async () => {
    const first = await evaluateHandler(request(`1:${PRIMARY},${NOT_ZIP}`, 'job-1'));
    expect(first.statusCode).toBe(200);
    expect(aiClient.evaluate).not.toHaveBeenCalled(); // deterministic verdict, no AI call

    const second = await evaluateHandler(request(`1:${PRIMARY},${NOT_ZIP}`, 'job-2'));
    expect(second.statusCode).toBe(200);
    expect(fetchesOf(NOT_ZIP)).toBe(2);
    expect(fetchesOf(PRIMARY)).toBe(1);
    expect(evaluateHandler.fetchCache.stats().forgotten).toBeGreaterThanOrEqual(1);
  });
});
