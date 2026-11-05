/**
 * @fileoverview One runner call per claim across the operator's jobs (design
 * §9.2 step 1, build plan A7). This mirrors services/cidFetchCache.js for IPFS
 * downloads: a dispatcher request selects several of one operator's jobs within
 * milliseconds, and each would otherwise take a slot and run the same sandbox.
 *
 * The key is listing CID + bCID + runner and rule versions + the code class + a
 * hash of the prior findings: every execution input is content-addressed by the
 * two CIDs, the versions say what ran it, and the class and the prior findings
 * shape the context pack it returns. It is a hash of a JSON array, so no value
 * can read as two fields. Different listing CIDs never share, whatever their
 * spec or image.
 *
 * A definitive answer is kept briefly for the job selected a little later;
 * a failure reaches everyone waiting on it and is not kept. What is kept is frozen.
 */

const crypto = require('crypto');

const DEFAULTS = Object.freeze({
  ttlMs: 900000, // the aggregator's response window: a re-trigger later runs again
  maxEntries: 16
});

const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Over what each prior finding says, in request order: the pack lists their
 * summaries in that order. The same CID with other bytes is another hash.
 */
function priorFindingsHash(priorFindings) {
  return sha256Hex(JSON.stringify(priorFindings.map(({ bcid, finding, report }) => [bcid, finding, report])));
}

/** @returns {string} the run's key, 64 hex */
function runKey({ listingCid, bcid, runnerVersion, rulesVersion, codeClass, priorFindings }) {
  return sha256Hex(JSON.stringify([listingCid, bcid, runnerVersion, rulesVersion, codeClass, priorFindingsHash(priorFindings)]));
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

class SharedRuns {
  /**
   * @param {object} [options]
   * @param {number} [options.ttlMs]
   * @param {number} [options.maxEntries] - kept results; a run in flight never counts against it
   * @param {() => number} [options.now]
   */
  constructor({ ttlMs = DEFAULTS.ttlMs, maxEntries = DEFAULTS.maxEntries, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.inFlight = new Map(); // key → promise
    this.kept = new Map();     // key → { value, storedAt }; insertion order is LRU order
  }

  /**
   * The run for `key`: one already in flight, one kept, or a new one from `start`.
   * @param {string} key
   * @param {() => Promise<object>} start
   * @returns {Promise<object>}
   */
  run(key, start) {
    const kept = this.kept.get(key);
    if (kept) {
      this.kept.delete(key);
      if (this.now() - kept.storedAt < this.ttlMs) {
        this.kept.set(key, kept); // most recently used
        return Promise.resolve(kept.value);
      }
    }
    const flying = this.inFlight.get(key);
    if (flying) return flying;

    // Entered before `start` runs, so a start that throws at once still clears it.
    const promise = Promise.resolve().then(start).then((answer) => {
      const value = deepFreeze(answer);
      this.keep(key, value);
      return value;
    }).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    promise.catch(() => {}); // everyone waiting gets the rejection; no one waiting is not an unhandled one
    return promise;
  }

  keep(key, value) {
    this.kept.set(key, { value, storedAt: this.now() });
    while (this.kept.size > this.maxEntries) this.kept.delete(this.kept.keys().next().value);
  }

  clear() {
    this.kept.clear();
  }

  stats() {
    return { entries: this.kept.size, inFlight: this.inFlight.size };
  }
}

/** The process's shared runs: every job of this operator goes through one adapter. */
const sharedRuns = new SharedRuns();

module.exports = { runKey, priorFindingsHash, SharedRuns, sharedRuns, DEFAULTS };
