/**
 * @fileoverview Hash chains for the v2 keeper's health calls (verdikta-dispatcher TODO items 6, 7, 16).
 *
 * Each arbiter job key has a chain: a secret seed s, v[n] = s, v[i-1] = keccak256(v[i]), and the
 * head v[0] registered with the keeper. Each answer reveals the next value: the preimage of the
 * keeper's current head. Exactly one step per answer, so the arbiter can answer or stay silent,
 * never choose its value (which is what makes the answers usable as beacon values).
 *
 * The chains live in one file per key, `<dir>/<key>.json` (dir 0700, file 0600), outside the code
 * an upgrade replaces: by default `<install>/health-chains`, the external adapter's sibling, and
 * HEALTH_CHAIN_DIR overrides it. The file holds the seeds, so it is a secret, and losing it leaves
 * the arbiter unable to answer: it stays frozen until it exits and registers again with a new head.
 * Back it up with the node's keys.
 *
 * A file holds a list of chains, newest last. A rotation appends a chain before its head is sent
 * (rotateChain answers from the old chain and installs the new head), and the older chains are
 * dropped once the keeper's head is on the newest one.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ethers = require('ethers');

const DEFAULT_LENGTH = 100000;    // at a few hundred calls a day, more than a year per chain
const WINDOW = 1000;              // checkpoint spacing: a value costs at most WINDOW hashes
const KEY_RE = /^0x[0-9a-f]{64}$/;

function defaultDir(env = process.env) {
  if (env.HEALTH_CHAIN_DIR && env.HEALTH_CHAIN_DIR.trim()) return path.resolve(env.HEALTH_CHAIN_DIR.trim());
  return path.resolve(__dirname, '..', '..', '..', 'health-chains');
}

function normKey(key) {
  const k = String(key || '').toLowerCase();
  if (!KEY_RE.test(k)) throw new Error(`not a bytes32 key: ${key}`);
  return k;
}

const hash = (bytes) => ethers.utils.arrayify(ethers.utils.keccak256(bytes));
const hex = (bytes) => ethers.utils.hexlify(bytes);

/** One chain: values by index, from checkpoints every WINDOW steps (built once, n hashes). */
class Chain {
  constructor(seed, length) {
    if (!Number.isInteger(length) || length < 2) throw new Error(`bad chain length ${length}`);
    this.length = length;
    this.seed = ethers.utils.arrayify(seed);
    if (this.seed.length !== 32) throw new Error('seed must be 32 bytes');
    // checkpoints[k] = v[length - k*WINDOW]
    this.checkpoints = [];
    let v = this.seed;
    for (let i = length; i >= 0; i--) {
      if ((length - i) % WINDOW === 0) this.checkpoints.push(v);
      if (i > 0) v = hash(v);
    }
    this.headBytes = v;                        // v[0]
    this.windows = new Map();                  // k -> Map(hex value -> index), built on demand
  }

  get head() { return hex(this.headBytes); }

  /** v[i], 0 <= i <= length, as a 0x-hex string */
  value(i) {
    if (!Number.isInteger(i) || i < 0 || i > this.length) throw new Error(`index ${i} outside the chain`);
    const k = Math.floor((this.length - i) / WINDOW);
    let v = this.checkpoints[k];
    for (let j = this.length - k * WINDOW; j > i; j--) v = hash(v);
    return hex(v);
  }

  _window(k) {
    let w = this.windows.get(k);
    if (!w) {
      w = new Map();
      const top = this.length - k * WINDOW;
      const bottom = Math.max(0, top - WINDOW + 1);
      let v = this.checkpoints[k];
      for (let i = top; i >= bottom; i--) {
        w.set(hex(v), i);
        if (i > bottom) v = hash(v);
      }
      if (this.windows.size > 4) this.windows.delete(this.windows.keys().next().value);
      this.windows.set(k, w);
    }
    return w;
  }

  /** index of `value` on this chain, or -1; searches from `hint` (the last index found) onward */
  indexOf(value, hint = 0) {
    const v = String(value).toLowerCase();
    if (v === this.head) return 0;
    const windows = this.checkpoints.length;
    const start = Math.floor((this.length - Math.min(Math.max(hint, 0), this.length)) / WINDOW);
    // the head only moves to higher indices (lower k): search from the hint's window down to k = 0,
    // then the rest
    const order = [];
    for (let k = start; k >= 0; k--) order.push(k);
    for (let k = start + 1; k < windows; k++) order.push(k);
    for (const k of order) {
      const i = this._window(k).get(v);
      if (i !== undefined) return i;
    }
    return -1;
  }
}

function filePath(dir, key) {
  return path.join(dir, `${normKey(key)}.json`);
}

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function newChainRecord(length) {
  const seed = hex(crypto.randomBytes(32));
  const chain = new Chain(seed, length);
  return { record: { seed, length, head: chain.head, created: new Date().toISOString() }, chain };
}

/**
 * Create the first chain for `key` and return its head (what registerArbiter takes). Refuses to
 * overwrite an existing file: its seeds may be what the keeper holds.
 */
function createChain(key, { dir = defaultDir(), length = DEFAULT_LENGTH } = {}) {
  const file = filePath(dir, key);
  if (fs.existsSync(file)) throw new Error(`a hash chain already exists for ${normKey(key)} (${file})`);
  const { record } = newChainRecord(length);
  writeAtomic(file, { version: 1, key: normKey(key), chains: [record] });
  return record.head;
}

/** The newest chain's head for `key`, or null when there is no file. */
function currentHead(key, { dir = defaultDir() } = {}) {
  const file = filePath(dir, key);
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return data.chains[data.chains.length - 1].head;
}

/** A key's chains, loaded once per process; the handler keeps them in memory. */
class KeyChains {
  constructor(key, { dir = defaultDir() } = {}) {
    this.key = normKey(key);
    this.file = filePath(dir, key);
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (data.version !== 1 || data.key !== this.key || !Array.isArray(data.chains) || data.chains.length === 0) {
      throw new Error(`malformed hash-chain file ${this.file}`);
    }
    this.records = data.chains;
    this.chains = data.chains.map((r) => new Chain(r.seed, r.length));
    this.chains.forEach((c, i) => {
      if (c.head !== String(this.records[i].head).toLowerCase()) throw new Error(`hash-chain file ${this.file}: chain ${i} does not match its head`);
    });
    this.hints = this.chains.map(() => 0);
  }

  _save() {
    writeAtomic(this.file, { version: 1, key: this.key, chains: this.records });
  }

  /** where `head` is: { chain, index } (newest chain first), or null */
  locate(head) {
    for (let c = this.chains.length - 1; c >= 0; c--) {
      const i = this.chains[c].indexOf(head, this.hints[c]);
      if (i >= 0) { this.hints[c] = i; return { chain: c, index: i }; }
    }
    return null;
  }

  /** append a new chain (persisted before its head is ever sent) and return its head */
  rotate(length) {
    const { record, chain } = newChainRecord(length || this.chains[this.chains.length - 1].length);
    this.records.push(record);
    this.chains.push(chain);
    this.hints.push(0);
    this._save();
    return record.head;
  }

  /** drop the chains before `c` (the keeper's head is on chain c, so they can never be needed) */
  dropBefore(c) {
    if (c <= 0) return;
    this.records = this.records.slice(c);
    this.chains = this.chains.slice(c);
    this.hints = this.hints.slice(c);
    this._save();
  }
}

module.exports = { Chain, KeyChains, createChain, currentHead, defaultDir, DEFAULT_LENGTH, WINDOW };
