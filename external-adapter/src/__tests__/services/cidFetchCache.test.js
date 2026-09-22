// Unit tests for the per-CID fetch de-duplication / cache (#69). No network:
// fetchers are controllable promises and the clock is injected.

const {
  CidFetchCache,
  installCidFetchCache,
  cidFetchCacheOptionsFromEnv,
  runWithRequestContext,
  setRunTag,
  DEFAULTS
} = require('../../services/cidFetchCache');

const CID_A = 'QmAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CID_B = 'QmBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function clock(start = 1000000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('CidFetchCache', () => {
  it('shares one in-flight download between concurrent requests for the same CID', async () => {
    const c = clock();
    const cache = new CidFetchCache({ now: c.now });
    const d = deferred();
    const fetcher = jest.fn(() => d.promise);

    const waiters = [cache.fetch(CID_A, fetcher), cache.fetch(CID_A, fetcher), cache.fetch(` ${CID_A} `, fetcher)];
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(CID_A);
    expect(cache.stats().inFlight).toBe(1);

    const bytes = Buffer.from('archive');
    d.resolve(bytes);
    const results = await Promise.all(waiters);
    expect(results.every((b) => b === bytes)).toBe(true); // shared, read-only by contract
    expect(cache.stats()).toMatchObject({ misses: 1, inFlightReuses: 2, hits: 0, entries: 1, bytes: bytes.length, inFlight: 0 });
  });

  it('fetches distinct CIDs concurrently, not one after another', async () => {
    const cache = new CidFetchCache();
    const dA = deferred(), dB = deferred();
    const fetcher = jest.fn((cid) => (cid === CID_A ? dA.promise : dB.promise));
    const pA = cache.fetch(CID_A, fetcher);
    const pB = cache.fetch(CID_B, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    dB.resolve(Buffer.from('b'));
    dA.resolve(Buffer.from('a'));
    expect((await pA).toString()).toBe('a');
    expect((await pB).toString()).toBe('b');
  });

  it('three concurrent requests finish in about one fetch latency, not three', async () => {
    const cache = new CidFetchCache();
    const latencyMs = 150;
    const fetcher = jest.fn(async () => { await sleep(latencyMs); return Buffer.from('slow'); });
    const t0 = Date.now();
    await Promise.all([1, 2, 3].map(() => cache.fetch(CID_A, fetcher)));
    const elapsed = Date.now() - t0;
    process.stdout.write(`[timing] 3 concurrent fetches of one CID, ${latencyMs} ms fetcher: ${elapsed} ms wall, ${fetcher.mock.calls.length} download(s)\n`);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(latencyMs * 2);
  });

  it('reports a failed download to every waiter and caches nothing', async () => {
    const cache = new CidFetchCache();
    const d = deferred();
    const fetcher = jest.fn(() => d.promise);
    const w1 = cache.fetch(CID_A, fetcher);
    const w2 = cache.fetch(CID_A, fetcher);
    const boom = new Error('Failed to fetch from IPFS after 3 attempts');
    d.reject(boom);
    await expect(w1).rejects.toBe(boom);
    await expect(w2).rejects.toBe(boom);
    expect(cache.stats()).toMatchObject({ failures: 1, entries: 0, inFlight: 0 });

    // The next request fetches again.
    fetcher.mockResolvedValueOnce(Buffer.from('ok'));
    await cache.fetch(CID_A, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('serves a repeat request from cache until the TTL expires', async () => {
    const c = clock();
    const cache = new CidFetchCache({ ttlMs: 1000, now: c.now });
    const fetcher = jest.fn(async () => Buffer.from('bytes'));
    await cache.fetch(CID_A, fetcher);
    c.advance(999);
    expect((await cache.fetch(CID_A, fetcher)).toString()).toBe('bytes');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.stats().hits).toBe(1);

    c.advance(1); // exactly ttl since storedAt → expired
    await cache.fetch(CID_A, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.stats().evictions).toBe(1);
  });

  it('is bounded by entries and bytes, evicting the least recently used', async () => {
    const cache = new CidFetchCache({ maxEntries: 2, maxBytes: 10 });
    const fetcher = jest.fn(async (cid) => Buffer.from(cid.slice(0, 4)));
    await cache.fetch('c1', fetcher);
    await cache.fetch('c2', fetcher);
    await cache.fetch('c1', fetcher); // c1 becomes most recently used
    await cache.fetch('c3', fetcher); // entries=2 → evict LRU (c2)
    expect(cache.stats()).toMatchObject({ entries: 2, bytes: 4, evictions: 1 }); // c1 + c3, 2 bytes each
    await cache.fetch('c2', fetcher);   // refetch: c2 was evicted
    expect(fetcher).toHaveBeenCalledTimes(4);

    const big = new CidFetchCache({ maxEntries: 10, maxBytes: 10 });
    const bigFetcher = jest.fn(async () => Buffer.alloc(11));
    await big.fetch('huge', bigFetcher);
    await big.fetch('huge', bigFetcher);
    expect(bigFetcher).toHaveBeenCalledTimes(2); // larger than maxBytes: never cached, still deduped in flight
    expect(big.stats().entries).toBe(0);
  });

  it('forget() drops a CID so the next request downloads it again', async () => {
    const cache = new CidFetchCache();
    const fetcher = jest.fn(async () => Buffer.from('bad archive'));
    await cache.fetch(CID_A, fetcher);
    expect(cache.forget(CID_A)).toBe(true);
    expect(cache.forget(CID_A)).toBe(false);
    await cache.fetch(CID_A, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.stats().forgotten).toBe(1);
  });

  it('ttlMs=0 disables caching but keeps in-flight sharing', async () => {
    const cache = new CidFetchCache({ ttlMs: 0 });
    const d = deferred();
    const fetcher = jest.fn(() => d.promise);
    const waiters = [cache.fetch(CID_A, fetcher), cache.fetch(CID_A, fetcher)];
    d.resolve(Buffer.from('x'));
    await Promise.all(waiters);
    await cache.fetch(CID_A, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.stats().entries).toBe(0);
  });

  it('logs hits and in-flight reuse with the current job run tag', async () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const cache = new CidFetchCache({ logger });
    const d = deferred();
    const fetcher = jest.fn(() => d.promise);
    await runWithRequestContext({ runTag: '[EA job-1]' }, async () => {
      const first = cache.fetch(CID_A, fetcher);
      await runWithRequestContext({ runTag: '[EA job-2]' }, async () => {
        setRunTag('[EA job-2 agg=0xagg mode=1]');
        const second = cache.fetch(CID_A, fetcher);
        d.resolve(Buffer.from('bytes'));
        await Promise.all([first, second]);
        await cache.fetch(CID_A, fetcher);
      });
    });
    const lines = logger.info.mock.calls.map((c) => c[0]);
    expect(lines).toEqual([
      expect.stringMatching(/^\[EA job-2 agg=0xagg mode=1\] IPFS fetch reused in-flight cid=Qm.* \(started by \[EA job-1\], waiters=2\)$/),
      expect.stringMatching(/^\[EA job-2 agg=0xagg mode=1\] IPFS fetch cache hit cid=Qm.* size=5 age=\d+ms$/)
    ]);
  });

  it('reads limits from the environment, falling back to defaults for unset or invalid values', () => {
    expect(cidFetchCacheOptionsFromEnv({})).toEqual(DEFAULTS);
    expect(cidFetchCacheOptionsFromEnv({ IPFS_FETCH_CACHE_TTL_MS: '0', IPFS_FETCH_CACHE_MAX_ENTRIES: '4', IPFS_FETCH_CACHE_MAX_BYTES: '1024' }))
      .toEqual({ ttlMs: 0, maxEntries: 4, maxBytes: 1024 });
    expect(cidFetchCacheOptionsFromEnv({ IPFS_FETCH_CACHE_TTL_MS: '-1', IPFS_FETCH_CACHE_MAX_ENTRIES: 'many', IPFS_FETCH_CACHE_MAX_BYTES: '1.5' }))
      .toEqual(DEFAULTS);
  });

  it('installCidFetchCache wraps the client once and tolerates a client without fetchFromIPFS', async () => {
    const raw = jest.fn(async (cid) => Buffer.from(`bytes of ${cid}`));
    const client = { fetchFromIPFS: raw };
    const cache = installCidFetchCache(client, { ttlMs: 60000 });
    expect(installCidFetchCache(client)).toBe(cache);
    await Promise.all([client.fetchFromIPFS(CID_A), client.fetchFromIPFS(CID_A)]);
    await client.fetchFromIPFS(CID_A);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ misses: 1, inFlightReuses: 1, hits: 1 });

    const bare = { uploadToIPFS: jest.fn() };
    expect(installCidFetchCache(bare)).toBeInstanceOf(CidFetchCache);
    expect(bare.fetchFromIPFS).toBeUndefined();
  });
});
