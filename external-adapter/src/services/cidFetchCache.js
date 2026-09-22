/**
 * @fileoverview Per-process de-duplication and short-lived cache of IPFS
 * fetches, keyed by CID.
 *
 * One dispatcher request fans out to every job of this operator that it
 * selected — a 10-job node sees three or more within milliseconds — and each
 * job's evaluation fetched the same archive CIDs on its own: six concurrent
 * downloads of two files, which the public Pinata gateway throttled (three
 * stalled to the 30 s client abort, so every job waited 42 s;
 * verdikta/verdikta-arbiter#69). A CID names immutable bytes, so one download
 * can serve everyone who asks for that CID while it is in flight, and the
 * bytes can be kept briefly for the job the dispatcher selects a few seconds
 * later.
 *
 * `installCidFetchCache` wraps `fetchFromIPFS` on the @verdikta/common client
 * instance, so archive fetches (`archiveService.getArchive`) and the manifest
 * parser's `ipfs/cid` additional / support / primary fetches all share it.
 * Buffers are shared between callers and must be treated as read-only.
 *
 * Failures are never cached: every waiter on a failed download gets the same
 * rejection a lone request would have got, and the next request fetches again.
 * The handler evicts CIDs it classified as malformed (`forget`), so a bad
 * archive is never kept either.
 */

const { AsyncLocalStorage } = require('async_hooks');

// Carries the job's run tag into fetches made by library code, which has no
// idea which job it is serving, so the dedupe / cache log lines are attributable.
const requestContext = new AsyncLocalStorage();

const DEFAULTS = Object.freeze({
  ttlMs: 120000,               // long enough for the jobs a dispatcher selects seconds apart
  maxEntries: 32,
  maxBytes: 64 * 1024 * 1024   // evidence archives are usually well under 10 MB
});

function runWithRequestContext(context, fn) {
  return requestContext.run({ ...context }, fn);
}

function setRunTag(runTag) {
  const store = requestContext.getStore();
  if (store) store.runTag = runTag;
}

function currentRunTag() {
  const store = requestContext.getStore();
  return (store && store.runTag) || '[EA]';
}

function nonNegativeInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Cache limits from the environment; unset or invalid values take the defaults. */
function cidFetchCacheOptionsFromEnv(env = process.env) {
  return {
    ttlMs: nonNegativeInt(env.IPFS_FETCH_CACHE_TTL_MS, DEFAULTS.ttlMs),
    maxEntries: nonNegativeInt(env.IPFS_FETCH_CACHE_MAX_ENTRIES, DEFAULTS.maxEntries),
    maxBytes: nonNegativeInt(env.IPFS_FETCH_CACHE_MAX_BYTES, DEFAULTS.maxBytes)
  };
}

class CidFetchCache {
  /**
   * @param {object} [options]
   * @param {number} [options.ttlMs] - 0 disables caching (in-flight sharing still applies)
   * @param {number} [options.maxEntries]
   * @param {number} [options.maxBytes] - total cached bytes; a single fetch larger than this is not cached
   * @param {object} [options.logger] - winston-style logger (info/warn); optional
   * @param {() => number} [options.now] - clock, injectable for tests
   */
  constructor({ ttlMs, maxEntries, maxBytes, logger, now } = {}) {
    this.ttlMs = nonNegativeInt(ttlMs, DEFAULTS.ttlMs);
    this.maxEntries = nonNegativeInt(maxEntries, DEFAULTS.maxEntries);
    this.maxBytes = nonNegativeInt(maxBytes, DEFAULTS.maxBytes);
    this.logger = logger || null;
    this.now = now || (() => Date.now());
    this.inFlight = new Map(); // cid -> { promise, waiters, runTag }
    this.entries = new Map();  // cid -> { buffer, storedAt }; insertion order doubles as LRU order
    this.bytes = 0;
    this.counters = { misses: 0, hits: 0, inFlightReuses: 0, failures: 0, evictions: 0, forgotten: 0 };
  }

  /**
   * Fetch `cid` through `fetcher(cid)` unless the same CID is cached or already
   * being fetched, in which case the cached bytes / the in-flight promise are
   * shared.
   * @param {string} cid
   * @param {(cid: string) => Promise<Buffer>} fetcher
   * @returns {Promise<Buffer>}
   */
  async fetch(cid, fetcher) {
    const key = String(cid).trim();
    const runTag = currentRunTag();

    const cached = this._lookup(key);
    if (cached) {
      this.counters.hits++;
      this._log('info', `${runTag} IPFS fetch cache hit cid=${key} size=${cached.buffer.length} age=${this.now() - cached.storedAt}ms`);
      return cached.buffer;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      pending.waiters++;
      this.counters.inFlightReuses++;
      this._log('info', `${runTag} IPFS fetch reused in-flight cid=${key} (started by ${pending.runTag}, waiters=${pending.waiters})`);
      return pending.promise;
    }

    this.counters.misses++;
    const entry = { runTag, waiters: 1, promise: null };
    entry.promise = (async () => {
      try {
        const buffer = await fetcher(key);
        this._store(key, buffer);
        return buffer;
      } catch (err) {
        this.counters.failures++;
        throw err;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, entry);
    return entry.promise;
  }

  /** Drop a cached CID (used for archives classified as malformed). */
  forget(cid) {
    const key = String(cid).trim();
    const entry = this.entries.get(key);
    if (!entry) return false;
    this._drop(key, entry);
    this.counters.forgotten++;
    return true;
  }

  stats() {
    this._evictExpired();
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      inFlight: this.inFlight.size,
      ttlMs: this.ttlMs,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      ...this.counters
    };
  }

  _lookup(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() - entry.storedAt >= this.ttlMs) {
      this._drop(key, entry);
      this.counters.evictions++;
      return null;
    }
    // Refresh LRU position.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  _store(key, buffer) {
    if (this.ttlMs <= 0 || this.maxEntries <= 0) return;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > this.maxBytes) return;
    const existing = this.entries.get(key);
    if (existing) this._drop(key, existing);
    this._evictExpired();
    while (this.entries.size >= this.maxEntries || this.bytes + buffer.length > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this._drop(oldestKey, this.entries.get(oldestKey));
      this.counters.evictions++;
    }
    this.entries.set(key, { buffer, storedAt: this.now() });
    this.bytes += buffer.length;
  }

  _evictExpired() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.storedAt >= this.ttlMs) {
        this._drop(key, entry);
        this.counters.evictions++;
      }
    }
  }

  _drop(key, entry) {
    this.entries.delete(key);
    this.bytes -= entry.buffer.length;
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](message);
  }
}

const installed = new WeakMap();

/**
 * Wrap `ipfsClient.fetchFromIPFS` with a shared cache. Idempotent per client
 * instance; a client without `fetchFromIPFS` (test doubles) is left untouched.
 * @returns {CidFetchCache}
 */
function installCidFetchCache(ipfsClient, options = {}) {
  if (installed.has(ipfsClient)) return installed.get(ipfsClient);
  const cache = new CidFetchCache(options);
  if (ipfsClient && typeof ipfsClient.fetchFromIPFS === 'function') {
    const raw = ipfsClient.fetchFromIPFS.bind(ipfsClient);
    ipfsClient.fetchFromIPFS = (cid) => cache.fetch(cid, raw);
    installed.set(ipfsClient, cache);
  }
  return cache;
}

module.exports = {
  CidFetchCache,
  installCidFetchCache,
  cidFetchCacheOptionsFromEnv,
  runWithRequestContext,
  setRunTag,
  currentRunTag,
  DEFAULTS
};
