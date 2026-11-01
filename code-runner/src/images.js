'use strict';

/**
 * The env image: pull, verify, cache, evict (design §9.1, §9.2 step 2, §12;
 * node A1b).
 *
 *   allowlist → lease → [cached and verified] | disk check → evict LRU → pull → verify
 *
 * - **By digest, from the allowlist only.** An image whose registry and
 *   repository are not on CODE_RUNNER_REGISTRY_ALLOWLIST abstains before any
 *   Docker call; the pull argv comes from registry.pullArgs(), which takes a
 *   digest reference and nothing else.
 * - **The size check comes first.** Before a pull, the data root must have
 *   room for the attested unpacked size plus the compressed layers being
 *   extracted (at most the class's 2 GB, and never more than the unpacked
 *   size), on top of what pulls in flight have reserved and the disk reserve.
 *   The sandboxes' scratch is memory (tmpfs, A1), not disk, so the image is
 *   all a run adds to the data root.
 * - **Verified before use.** After the pull, and for a cached image, the
 *   image the digest reference resolves to must list that digest and be of
 *   the platform that runs. The daemon has already checked the bytes against
 *   the digest; a registry that serves other bytes makes the pull fail.
 * - **LRU eviction** frees room for a pull, least recently used first, one
 *   image at a time until the pull fits. It only ever removes images whose
 *   every reference is on the allowlist, never a base image pinned in
 *   @verdikta/common, never one a run holds (a lease, from before its pull
 *   until its sandboxes are gone) or a pull is fetching, never one a
 *   container uses (and `docker image rm` is never forced, so the daemon
 *   refuses that too), never a dangling image.
 * - **Concurrent runs.** The decisions (presence, disk, eviction, starting a
 *   pull) are made under one lock, so two runs never count the same free
 *   bytes; a pull's bytes stay reserved until it ends. Two runs that need
 *   the same image share one pull.
 *
 * Every failure abstains (§12: registry or image-pull failure → error, no
 * commit): registry_not_allowed, pull_failed, image_mismatch, or
 * admission_refused when the disk has no room. Last use is kept in memory: a
 * restarted runner treats the images it finds as the least recently used.
 */

const fs = require('node:fs');
const { parseImageRef, allowedBy, pullArgs } = require('./registry');
const { runText, isUnreachableText } = require('./docker');
const { dockerInfo } = require('./daemon');
const { ABSTAIN, Abstain, RequesterError } = require('./result');
const { CLASS_HARD_LIMITS } = require('./classLimits');
const { BASE_IMAGE_PINS } = require('./common');

const MIB = 1024 * 1024;
const CONTROL_TIMEOUT_MS = 30000;
const REMOVE_TIMEOUT_MS = 120000;
const LISTING_BYTES = 16 * MIB;

/** One line per image. `index` reads a key the image may lack (Variant) without a template error. */
const INSPECT_FORMAT = '{{json .Id}}\t{{json .RepoTags}}\t{{json .RepoDigests}}\t{{json .Os}}\t{{json .Architecture}}\t{{json (index . "Variant")}}\t{{json .Size}}';

/** The base images pinned in @verdikta/common, by every digest they are known by: never evicted. */
const DEFAULT_PINNED_DIGESTS = Object.freeze(Object.values(BASE_IMAGE_PINS).flatMap((p) => [p.digest, p.indexDigest].filter(Boolean)));

const nullLog = { info() {}, warn() {}, error() {}, debug() {} };
const ABORTED = Symbol('aborted');

/** The run's window ended, or it was cancelled, while the cache worked for it. */
class Interrupted extends Error {}

function stopIfAborted(signal) {
  if (signal && signal.aborted) throw new Interrupted('interrupted');
}

/**
 * Bytes a pull may need on the data root: the unpacked image plus its
 * compressed layers while they are extracted (the containerd image store
 * keeps them), which the class caps at 2 GB.
 */
function needBytes(unpackedBytes) {
  return unpackedBytes + Math.min(unpackedBytes, CLASS_HARD_LIMITS.imageCompressedBytes);
}

/** linux/amd64, linux/arm64 (arm64's v8 variant is plain arm64), or os/arch/variant. */
function platformOf(info) {
  const { os, architecture, variant } = info;
  if (architecture === 'arm64' && (!variant || variant === 'v8')) return `${os}/arm64`;
  return variant ? `${os}/${architecture}/${variant}` : `${os}/${architecture}`;
}

/** A request value in a detail, bounded. */
function short(v) {
  const text = JSON.stringify(v === undefined ? null : v);
  return text.length > 200 ? `${text.slice(0, 200)}… (cut)` : text;
}

function firstLine(text, fallback) {
  return (String(text || '').split('\n').find((l) => l.trim()) || fallback).trim().slice(0, 300);
}

function parseInspectLines(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length !== 7) continue;
    try {
      const [id, repoTags, repoDigests, os, architecture, variant, size] = f.map((x) => JSON.parse(x));
      if (typeof id !== 'string') continue;
      out.push({
        id,
        repoTags: Array.isArray(repoTags) ? repoTags.filter((r) => typeof r === 'string') : [],
        repoDigests: Array.isArray(repoDigests) ? repoDigests.filter((r) => typeof r === 'string') : [],
        os: String(os || ''),
        architecture: String(architecture || ''),
        variant: variant ? String(variant) : null,
        size: Number.isFinite(size) ? size : null
      });
    } catch (_) {
      // A line that is not ours: skipped.
    }
  }
  return out;
}

function parseLoose(ref) {
  try {
    return parseImageRef(ref, { digestRequired: false });
  } catch (_) {
    return null;
  }
}

/** A promise that resolves ABORTED when `signal` aborts. */
function aborted(signal) {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(ABORTED);
    else signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
  });
}

/** A FIFO lock whose waiters can give up (their place passes on). */
class Lock {
  constructor() {
    this.tail = Promise.resolve();
  }

  /** Resolves a release function, or rejects when `signal` aborts first. */
  acquire(signal) {
    let releaseMine;
    const mine = new Promise((r) => { releaseMine = r; });
    const prev = this.tail;
    this.tail = mine;
    return new Promise((resolve, reject) => {
      let gaveUp = false;
      const onAbort = () => { gaveUp = true; reject(new Error('gave up waiting for the image cache')); };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      prev.then(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (gaveUp) { releaseMine(); return; }
        let released = false;
        resolve(() => { if (!released) { released = true; releaseMine(); } });
      });
    });
  }
}

class ImageCache {
  /**
   * @param {object} o
   * @param {object} o.config - registryAllowlist, runtime, dataRoot, diskReserveMb, pullTimeoutMs
   * @param {object} o.docker
   * @param {object} [o.log]
   * @param {Function} [o.statfs] - fs.promises.statfs
   * @param {string[]} [o.pins] - digests never evicted (default: @verdikta/common's base images)
   * @param {Function} [o.now] - the LRU clock
   */
  constructor({ config, docker, log = nullLog, statfs = fs.promises.statfs, pins = DEFAULT_PINNED_DIGESTS, now = Date.now }) {
    this.config = config;
    this.docker = docker;
    this.log = log;
    this.statfs = statfs;
    this.pinned = new Set(pins);
    this.now = now;
    this.allowlist = config.registryAllowlist;
    /** canonical ref → leases held */
    this.inUse = new Map();
    /** canonical ref → { promise, bytes }: pulls in flight */
    this.pulls = new Map();
    /** canonical ref → last use (this.now()) */
    this.lastUsed = new Map();
    this.pendingBytes = 0;
    this.lock = new Lock();
    this.closing = new AbortController();
    this.dockerRootDir = null;
  }

  /**
   * Make the env image ready for a run and hold it until `release()`.
   *
   * @param {object} o
   * @param {string} o.image - code_review.json's env.image
   * @param {string} o.attestedImage - attestation.json's env.image (must name the same image)
   * @param {string} o.platform - the platform that runs (the config's)
   * @param {number} o.unpackedBytes - the attested unpacked size
   * @param {number} o.windowMs - how long the run can wait for the image and still have runSeconds
   * @param {AbortSignal} [o.signal] - the caller went away
   * @returns {Promise<{ref:string, cache:'hit'|'pulled'|'shared', durationMs:number, release:Function}>}
   * @throws {Abstain|RequesterError}
   */
  async acquire({ image, attestedImage, platform, unpackedBytes, windowMs, signal }) {
    const t0 = Date.now();
    let ref;
    try {
      ref = parseImageRef(image);
    } catch (err) {
      throw new RequesterError([{ code: 'SCHEMA', path: '/spec/env/image', detail: err.message }]);
    }
    let attested = null;
    try {
      attested = parseImageRef(attestedImage).canonical;
    } catch (_) {
      attested = null;
    }
    // A size that is not a positive integer would never fit and evict everything: refused instead.
    if (!Number.isSafeInteger(unpackedBytes) || unpackedBytes < 1) {
      throw new RequesterError([{ code: 'SCHEMA', path: '/spec/env/unpackedBytes', detail: 'must be the attested unpacked size, a positive integer' }]);
    }
    if (attested !== ref.canonical) {
      throw new RequesterError([{ code: 'ATTESTATION_IMAGE_MISMATCH', path: '/attestation/env/image',
        detail: `the attestation names ${short(attestedImage)}, code_review.json ${short(image)}` }]);
    }
    if (!allowedBy(ref, this.allowlist)) {
      throw new Abstain(ABSTAIN.REGISTRY_NOT_ALLOWED,
        `${ref.repository} is not on the registry allowlist (${this.allowlist.map((e) => e.entry).join(', ')}): the runner pulls only from there`,
        { step: 'pull' });
    }
    const key = ref.canonical;
    this.take(key);
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      this.put(key);
    };

    const wait = new AbortController();
    const timer = setTimeout(() => wait.abort('window'), Math.max(0, windowMs));
    const onCancel = () => wait.abort('cancel');
    if (signal) {
      if (signal.aborted) wait.abort('cancel');
      else signal.addEventListener('abort', onCancel, { once: true });
    }
    const gaveUp = (what, verb = 'did not finish') => (wait.signal.reason === 'cancel'
      ? new Abstain(ABSTAIN.CANCELLED, `the run was cancelled while it waited for ${what}`, { step: 'pull' })
      : new Abstain(ABSTAIN.PULL_FAILED, `${what} ${verb} in the time the deadline leaves before the run (${Math.max(0, windowMs)} ms)`, { step: 'pull' }));

    try {
      let pull = null;
      let cache = 'hit';
      let unlock;
      try {
        unlock = await this.lock.acquire(wait.signal);
      } catch (_) {
        throw wait.signal.reason === 'cancel'
          ? gaveUp('the image cache')
          : new Abstain(ABSTAIN.ADMISSION_REFUSED, 'the image cache was busy for all the time the deadline leaves before the run', { step: 'pull' });
      }
      // Everything under the lock follows the run's window and cancellation
      // too: each Docker call is cut off and nothing further starts, so a run
      // never holds the lock (or its slot) past its time.
      try {
        const inFlight = this.pulls.get(key);
        if (inFlight) {
          pull = inFlight;
          cache = 'shared';
        } else {
          const present = await this.inspect(key, wait.signal);
          const problem = present ? this.mismatch(present, key, platform) : null;
          if (present && problem && problem.kind === 'digest') throw new Abstain(ABSTAIN.IMAGE_MISMATCH, problem.detail, { step: 'pull' });
          if (!present || problem) {
            const need = needBytes(unpackedBytes);
            await this.admitDisk(need, unpackedBytes, wait.signal);
            stopIfAborted(wait.signal);
            pull = this.startPull(key, platform, need);
            cache = 'pulled';
          }
        }
      } catch (err) {
        if (err instanceof Interrupted) throw gaveUp(`the image ${key}`, 'was not ready');
        throw err;
      } finally {
        unlock();
      }

      if (pull) {
        const outcome = await Promise.race([pull.promise, aborted(wait.signal)]);
        if (outcome === ABORTED) throw gaveUp(`the pull of ${key}`);
        if (outcome.error) throw outcome.error;
        let after;
        try {
          after = await this.inspect(key, wait.signal);
        } catch (err) {
          if (err instanceof Interrupted) throw gaveUp(`the image ${key}`, 'was not ready');
          throw err;
        }
        if (!after) {
          throw new Abstain(ABSTAIN.PULL_FAILED, `the pull of ${key} reported success, but the image is not on the disk under that reference`, { step: 'pull' });
        }
        const problem = this.mismatch(after, key, platform);
        if (problem) throw new Abstain(ABSTAIN.IMAGE_MISMATCH, problem.detail, { step: 'pull' });
      }
      this.lastUsed.set(key, this.now());
      return { ref: key, cache, durationMs: Date.now() - t0, release };
    } catch (err) {
      release();
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onCancel);
    }
  }

  take(key) {
    this.inUse.set(key, (this.inUse.get(key) || 0) + 1);
  }

  put(key) {
    const n = (this.inUse.get(key) || 0) - 1;
    if (n > 0) this.inUse.set(key, n);
    else this.inUse.delete(key);
  }

  /** Why the image a reference resolves to is not the one asked for, or null. */
  mismatch(info, key, platform) {
    const digests = info.repoDigests.map(parseLoose).filter((p) => p && p.canonical).map((p) => p.canonical);
    if (!digests.includes(key)) {
      const listed = digests.length ? digests.join(', ') : 'none';
      return { kind: 'digest', detail: `${key} resolves to an image that does not carry that digest (its digests: ${listed})` };
    }
    const actual = platformOf(info);
    if (actual !== platform) {
      return { kind: 'platform', detail: `the image ${key} is ${actual}; the runner runs ${platform}` };
    }
    return null;
  }

  /**
   * The image a reference resolves to, or null when there is none. Throws
   * Abstain when the daemon cannot say, Interrupted when `signal` aborts.
   */
  async inspect(key, signal) {
    const r = await runText(this.docker, ['image', 'inspect', '--format', INSPECT_FORMAT, key], { timeoutMs: CONTROL_TIMEOUT_MS, signal });
    stopIfAborted(signal);
    if (r.spawnError) throw new Abstain(ABSTAIN.DOCKER_UNREACHABLE, `the docker CLI could not be started: ${r.spawnError}`, { step: 'pull' });
    if (r.exitCode === 0) {
      const [info] = parseInspectLines(r.stdout);
      if (!info) throw new Abstain(ABSTAIN.DOCKER_ERROR, `docker image inspect returned something unreadable for ${key}`, { step: 'pull' });
      return info;
    }
    if (isUnreachableText(r.stderr)) throw new Abstain(ABSTAIN.DOCKER_UNREACHABLE, 'the Docker daemon could not be reached', { step: 'pull' });
    if (/No such image/i.test(r.stderr)) return null;
    throw new Abstain(ABSTAIN.DOCKER_ERROR, `docker image inspect failed: ${firstLine(r.stderr, `exit ${r.exitCode}`)}`, { step: 'pull' });
  }

  /**
   * Free bytes on the data root (null, with the reason, when they cannot be
   * measured), and `pending`: the bytes pulls in flight held just before
   * the measurement. A pull that finishes while statfs runs releases its
   * reservation outside the lock, and its last writes may or may not be in
   * the sample; paired with the reservation taken before it, its bytes are
   * counted at least once, never zero times. (Pulls start only under the
   * lock, which the caller holds, so nothing is added meanwhile.)
   */
  async freeBytes(signal) {
    let dir = this.config.dataRoot;
    if (!dir) {
      if (!this.dockerRootDir) {
        const info = await dockerInfo(this.docker, { timeoutMs: CONTROL_TIMEOUT_MS, signal });
        stopIfAborted(signal);
        if (!info.reachable) return { bytes: null, path: null, error: info.error };
        this.dockerRootDir = info.dockerRootDir;
      }
      dir = this.dockerRootDir;
    }
    if (!dir) return { bytes: null, path: null, error: 'the daemon reports no data root' };
    const pending = this.pendingBytes;
    try {
      const s = await this.statfs(dir);
      return { bytes: Number(s.bavail) * Number(s.bsize), pending, path: dir, error: null };
    } catch (err) {
      return { bytes: null, pending, path: dir, error: err.code || err.message };
    }
  }

  /**
   * Make room for a pull of `need` bytes, evicting least recently used
   * images while it does not fit. Throws Abstain (admission_refused) when it
   * cannot, Interrupted when `signal` aborts (no further step starts).
   * Called under the lock.
   */
  async admitDisk(need, unpackedBytes, signal) {
    const reserve = this.config.diskReserveMb * MIB;
    let free = await this.freeBytes(signal);
    stopIfAborted(signal);
    if (free.bytes === null) {
      if (this.config.runtime === 'runsc') {
        throw new Abstain(ABSTAIN.ADMISSION_REFUSED,
          `the free space on the data root (${free.path || 'unknown'}) could not be measured (${free.error}); a pull needs ${need} bytes`, { step: 'pull' });
      }
      this.log.warn('the free space on the data root could not be measured; pulling without the disk check (runc development)', { path: free.path, error: free.error });
      return;
    }
    const fits = () => free.bytes - free.pending - reserve >= need;
    if (fits()) return;
    for (const candidate of await this.candidates(signal)) {
      stopIfAborted(signal);
      // A run may have taken a lease on it since the list was made (leases
      // are taken before the lock): checked again right before the removal.
      if (candidate.keys.some((k) => this.inUse.has(k) || this.pulls.has(k))) continue;
      const evicted = await this.evict(candidate, signal);
      stopIfAborted(signal);
      if (!evicted) continue;
      free = await this.freeBytes(signal);
      stopIfAborted(signal);
      if (free.bytes === null) break;
      if (fits()) return;
    }
    // A reservation is an upper bound, so a sample taken while a pull was
    // ending can only understate the room: one fresh look before refusing.
    if (free.bytes !== null) {
      free = await this.freeBytes(signal);
      stopIfAborted(signal);
      if (free.bytes !== null && fits()) return;
    }
    if (free.bytes === null) {
      throw new Abstain(ABSTAIN.ADMISSION_REFUSED,
        `the free space on the data root (${free.path || 'unknown'}) could no longer be measured while making room (${free.error}); a pull needs ${need} bytes`, { step: 'pull' });
    }
    throw new Abstain(ABSTAIN.ADMISSION_REFUSED,
      `the data root has ${free.bytes} bytes free, ${free.pending} held by pulls in flight and ${reserve} kept free `
      + `(CODE_RUNNER_DISK_RESERVE_MB); the image needs ${need} (${unpackedBytes} unpacked plus its compressed layers), `
      + 'and nothing more can be evicted', { step: 'pull' });
  }

  /** Images the cache may evict, least recently used first. */
  async candidates(signal) {
    const ls = await runText(this.docker, ['image', 'ls', '--quiet', '--no-trunc'], { timeoutMs: CONTROL_TIMEOUT_MS, maxBytes: LISTING_BYTES, signal });
    stopIfAborted(signal);
    if (ls.exitCode !== 0 || ls.stdoutOverLimit) {
      this.log.warn('could not list images for eviction', { error: firstLine(ls.stderr || ls.spawnError, `exit ${ls.exitCode}`) });
      return [];
    }
    const ids = [...new Set(ls.stdout.split('\n').map((l) => l.trim()).filter(Boolean))];
    if (ids.length === 0) return [];
    const usedByContainers = await this.containerImages(signal);
    if (usedByContainers === null) return [];
    const insp = await runText(this.docker, ['image', 'inspect', '--format', INSPECT_FORMAT, ...ids], { timeoutMs: CONTROL_TIMEOUT_MS, maxBytes: LISTING_BYTES, signal });
    stopIfAborted(signal);
    if (insp.stdoutOverLimit || (insp.exitCode !== 0 && !/No such image/i.test(insp.stderr))) {
      this.log.warn('could not inspect images for eviction', { error: firstLine(insp.stderr, `exit ${insp.exitCode}`) });
      return [];
    }
    const out = [];
    for (const info of parseInspectLines(insp.stdout)) {
      const refs = [...new Set([...info.repoTags, ...info.repoDigests])];
      // Dangling: not the runner's to judge.
      if (refs.length === 0) continue;
      const parsed = refs.map(parseLoose);
      // Every reference on the allowlist: an image the runner could have pulled, and nobody else's.
      if (parsed.some((p) => !p || !allowedBy(p, this.allowlist))) continue;
      if (this.pinned.has(info.id) || parsed.some((p) => p.digest && this.pinned.has(p.digest))) continue;
      if (usedByContainers.has(info.id)) continue;
      const keys = parsed.filter((p) => p.canonical).map((p) => p.canonical);
      if (keys.some((k) => this.inUse.has(k) || this.pulls.has(k))) continue;
      const last = Math.max(0, ...keys.map((k) => this.lastUsed.get(k) || 0));
      // Tags first, the digest references last: the last removal deletes the image.
      out.push({ id: info.id, refs: [...info.repoTags, ...info.repoDigests.filter((r) => !info.repoTags.includes(r))], keys, last });
    }
    out.sort((a, b) => (a.last - b.last) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  /** Image IDs any container uses (null when they cannot be listed: then nothing is evicted). */
  async containerImages(signal) {
    const ps = await runText(this.docker, ['ps', '--all', '--quiet', '--no-trunc'], { timeoutMs: CONTROL_TIMEOUT_MS, maxBytes: LISTING_BYTES, signal });
    stopIfAborted(signal);
    if (ps.exitCode !== 0 || ps.stdoutOverLimit) {
      this.log.warn('could not list containers for eviction', { error: firstLine(ps.stderr || ps.spawnError, `exit ${ps.exitCode}`) });
      return null;
    }
    const ids = [...new Set(ps.stdout.split('\n').map((l) => l.trim()).filter(Boolean))];
    if (ids.length === 0) return new Set();
    const ci = await runText(this.docker, ['container', 'inspect', '--format', '{{json .Image}}', ...ids], { timeoutMs: CONTROL_TIMEOUT_MS, maxBytes: LISTING_BYTES, signal });
    stopIfAborted(signal);
    if (ci.stdoutOverLimit || (ci.exitCode !== 0 && !/No such (container|object)/i.test(ci.stderr))) {
      this.log.warn('could not inspect containers for eviction', { error: firstLine(ci.stderr, `exit ${ci.exitCode}`) });
      return null;
    }
    const used = new Set();
    for (const line of ci.stdout.split('\n')) {
      if (!line.trim()) continue;
      try {
        used.add(JSON.parse(line));
      } catch (_) {
        return null;
      }
    }
    return used;
  }

  /** Remove one image (never forced). True once no image has its ID. */
  async evict(candidate, signal) {
    const rm = await runText(this.docker, ['image', 'rm', ...candidate.refs], { timeoutMs: REMOVE_TIMEOUT_MS, signal });
    stopIfAborted(signal);
    const still = await runText(this.docker, ['image', 'inspect', '--format', '{{json .Id}}', candidate.id], { timeoutMs: CONTROL_TIMEOUT_MS, signal });
    stopIfAborted(signal);
    const gone = still.exitCode !== 0 && /No such image/i.test(still.stderr);
    if (gone) this.log.info('evicted an image (least recently used)', { id: candidate.id, refs: candidate.refs });
    else this.log.warn('could not evict an image', { id: candidate.id, error: firstLine(rm.stderr, `exit ${rm.exitCode}`) });
    return gone;
  }

  /** Start a pull (called under the lock); its bytes stay reserved until it ends. */
  startPull(key, platform, need) {
    this.pendingBytes += need;
    const entry = { bytes: need, promise: null };
    entry.promise = (async () => {
      try {
        const r = await runText(this.docker, pullArgs(key, platform), { timeoutMs: this.config.pullTimeoutMs, signal: this.closing.signal });
        return { error: this.pullFailure(r, key) };
      } catch (err) {
        return { error: new Abstain(ABSTAIN.RUNNER_ERROR, `the pull of ${key} failed in the runner: ${err.message}`, { step: 'pull' }) };
      } finally {
        this.pendingBytes -= need;
        if (this.pulls.get(key) === entry) this.pulls.delete(key);
      }
    })();
    this.pulls.set(key, entry);
    return entry;
  }

  pullFailure(r, key) {
    const fail = (cause, detail) => new Abstain(cause, detail, { step: 'pull' });
    if (r.spawnError) return fail(ABSTAIN.DOCKER_UNREACHABLE, `the docker CLI could not be started: ${r.spawnError}`);
    if (r.aborted) return fail(ABSTAIN.CANCELLED, `the pull of ${key} was stopped: the runner is shutting down`);
    if (r.timedOut) return fail(ABSTAIN.PULL_FAILED, `the pull of ${key} did not finish within ${this.config.pullTimeoutMs / 1000} s (CODE_RUNNER_PULL_TIMEOUT_SECONDS)`);
    if (r.exitCode === 0) return null;
    if (isUnreachableText(r.stderr)) return fail(ABSTAIN.DOCKER_UNREACHABLE, 'the Docker daemon could not be reached');
    return fail(ABSTAIN.PULL_FAILED, `the pull of ${key} failed: ${firstLine(r.stderr, `exit ${r.exitCode}`)}`);
  }

  status() {
    return {
      allowlist: this.allowlist.map(({ entry, dev }) => ({ entry, dev })),
      inUse: this.inUse.size,
      pullsInFlight: this.pulls.size,
      pendingBytes: this.pendingBytes
    };
  }

  /** Stop the pulls in flight (the runner is shutting down). */
  close() {
    this.closing.abort();
  }
}

module.exports = { ImageCache, needBytes, platformOf, DEFAULT_PINNED_DIGESTS, INSPECT_FORMAT };
