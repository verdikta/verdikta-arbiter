/**
 * @fileoverview Commit-reveal state (mode 1 → mode 2), kept on disk so it survives an adapter restart.
 *
 * A v2 commit can only be opened with the salt and result chosen at commit time. If they are lost
 * between the commit and the reveal (an adapter restart, an upgrade, a crash), the promoted slot can
 * never be revealed, and the keeper scores that as a failed reveal (T_MISS_FAILED: a block, and a ban
 * on repeats). So every entry is written to disk before the commit is answered.
 *
 * Layout: one file per commitment, `<dir>/<64 hex>.json` (dir 0700, files 0600: before the reveal the
 * salt and result are secret). Each write goes to a unique temp file, is fsynced, renamed over the
 * record and the directory fsynced, so a crash leaves either the old record or the new one, never a
 * torn one. Leftover temp files are removed at load. No whole-store rewrite: a save touches one file.
 *
 * Location: COMMIT_STORE_DIR, else `<install>/commit-store`, the external adapter's sibling (like
 * health-chains/), outside the code an upgrade replaces.
 *
 * Records are loaded once (on first use, or `init()` at startup) and served from memory; one mutex
 * orders all writes, so concurrent requests cannot interleave a save and a delete. Entries carry
 * `expiresAt` (3 days from the commit, beyond the longest v2 round: a deadline of up to one day plus
 * the reveal window); `purgeStale()` deletes expired records from memory and disk.
 */
const { Mutex } = require('async-mutex');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const KEY_RE = /^[0-9a-f]{32,64}$/;       // a v2 commitment is 64 hex; v1 (dual mode) 32 hex
const DEFAULT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function defaultDir(env = process.env) {
  if (env.COMMIT_STORE_DIR && env.COMMIT_STORE_DIR.trim()) return path.resolve(env.COMMIT_STORE_DIR.trim());
  return path.resolve(__dirname, '..', '..', '..', 'commit-store');
}

function createCommitStore({ dir = defaultDir(), logger = console } = {}) {
  const mtx = new Mutex();
  let mem = null;                      // Map hash -> entry, once loaded

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }

  function load() {
    if (mem) return mem;
    ensureDir();
    const m = new Map();
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (name.endsWith('.tmp')) {                 // a write interrupted before its rename
        try { fs.unlinkSync(file); } catch { /* gone already */ }
        continue;
      }
      const match = /^([0-9a-f]{32,64})\.json$/.exec(name);
      if (!match) continue;
      try {
        const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (entry && typeof entry === 'object') m.set(match[1], entry);
      } catch {
        // cannot happen through this module (writes are atomic); keep the file for inspection. No
        // parser message: it could quote the record, and the salt is secret until the reveal
        logger.error(`commit store: unreadable record ${file} skipped`);
      }
    }
    mem = m;
    return mem;
  }

  async function writeRecord(hash, entry) {
    const file = path.join(dir, `${hash}.json`);
    const tmp = path.join(dir, `${hash}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    const fh = await fsp.open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(JSON.stringify(entry));
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await fsp.rename(tmp, file);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
    await syncDir();
  }

  async function syncDir() {
    let dh;
    try {
      dh = await fsp.open(dir, 'r');
      await dh.sync();
    } catch { /* some filesystems cannot fsync a directory; the rename is still atomic */ } finally {
      if (dh) await dh.close().catch(() => {});
    }
  }

  async function removeRecord(hash) {
    await fsp.unlink(path.join(dir, `${hash}.json`)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  }

  const checkKey = (hash) => {
    if (typeof hash !== 'string' || !KEY_RE.test(hash)) throw new Error(`commit store: bad key ${hash}`);
    return hash;
  };

  return {
    dir,
    /** load the records now (the adapter calls this at startup); returns how many there are */
    init: () => mtx.runExclusive(() => load().size),

    /** persist `entry` under `hash`; resolves only once it is durable on disk */
    save: (hash, entry) => mtx.runExclusive(async () => {
      checkKey(hash);
      const m = load();
      const copy = JSON.parse(JSON.stringify(entry));
      await writeRecord(hash, copy);
      m.set(hash, copy);
    }),

    get: (hash) => mtx.runExclusive(() => {
      if (typeof hash !== 'string' || !KEY_RE.test(hash)) return undefined;
      const e = load().get(hash);
      return e === undefined ? undefined : JSON.parse(JSON.stringify(e));
    }),

    del: (hash) => mtx.runExclusive(async () => {
      if (typeof hash !== 'string' || !KEY_RE.test(hash)) return;
      const m = load();
      await removeRecord(hash);
      m.delete(hash);
    }),

    /**
     * Commits still waiting for their reveal: no justification yet, made less than `withinMs` ago
     * (15 minutes by default: the class presets' rounds last 300 or 600 s; a request may ask up to an
     * hour). A commit that was not promoted is never revealed and also counts until the window ends. A reveal request that arrives
     * while the adapter is down fails its Chainlink run, and the job does not retry it, so a restart
     * or an upgrade waits until this is empty (scripts/pending-reveals.js). No salt or result leaves.
     */
    pending: ({ now = Date.now(), withinMs = 15 * 60 * 1000 } = {}) => mtx.runExclusive(() => {
      const out = [];
      for (const [hash, entry] of load()) {
        if (entry.justificationCid) continue;
        const created = Date.parse(entry.created);
        if (!Number.isFinite(created) || now - created >= withinMs) continue;
        out.push({ hash: hash.slice(0, 10), aggId: entry.aggId || entry.scope?.aggId || null, ageMs: now - created });
      }
      return out.sort((a, b) => a.ageMs - b.ageMs);
    }),

    /** delete expired entries (expiresAt, or created + maxAgeMs for entries without one) */
    purgeStale: (maxAgeMs = DEFAULT_MAX_AGE_MS) => mtx.runExclusive(async () => {
      const now = Date.now();
      const m = load();
      let removed = 0;
      for (const [hash, entry] of [...m]) {
        const expiry = entry.expiresAt ?? (Date.parse(entry.created) + maxAgeMs);
        if (!Number.isFinite(expiry) || now >= expiry) {
          await removeRecord(hash);
          m.delete(hash);
          removed++;
        }
      }
      return removed;
    }),
  };
}

const store = createCommitStore();
module.exports = store;
module.exports.createCommitStore = createCommitStore;
module.exports.defaultDir = defaultDir;
