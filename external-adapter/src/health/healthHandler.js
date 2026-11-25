/**
 * @fileoverview Answers for the v2 keeper's health calls, asked for by the Chainlink health job
 * (chainlink-node/healthJobSpec; verdikta-dispatcher TODO item 16, decided 2026-11-20).
 *
 * The job reads keeper.healthState(key) itself and calls this adapter, over the same bridge as
 * evaluations, only while a call is pending:
 *
 *   { "id": <externalJobID>, "data": { "healthKey": "0x<64 hex>", "head": "0x<64 hex>" } }
 *
 * The reply says whether to answer, and with what. The job always sends
 * rotateChain(key, preimage, newHead): with newHead == preimage that is exactly answerHealthCall,
 * and a different newHead installs the next chain. The job fixes the keeper address and the key, so
 * this adapter can only ever supply the two values.
 *
 *   { "data": { "answer": true,  "preimage": "0x…", "newHead": "0x…" } }
 *   { "data": { "answer": false, "reason": "in flight" } }
 *
 * The job runs every few seconds, so an answer whose transaction has not landed yet would be sent
 * again: a head answered less than IN_FLIGHT_MS ago is not answered twice (a second answer from the
 * same chain value would only revert). A rotation starts ROTATE_MARGIN values before a chain ends.
 *
 * Re-sync: when the keeper's head is on none of this key's chains (registered with head 0 from a
 * browser, or the chain file lost) or its chain is used up, the answer is a fresh chain's head as a
 * plain answer (`resync: true`). The keeper adopts it as the head and keeps the arbiter frozen until
 * it answers a call sent after that; its next answer sends that call and the one after answers it,
 * both ordinary answers from the new chain (verdikta-dispatcher MIGRATION.md, "Chain re-sync").
 *
 * Stale reads. The job reads the head over RPC, and a lagging read can show a head the keeper has
 * already moved past. Answering it is useless (the keeper reverts it: BadPreimage, or StaleAnswer for
 * a re-sync to one of its last 4 heads), and a head that looked unknown would re-sync and freeze the
 * node. So the old chains are kept for RETAIN_MS after a switch (chainStore `prune`), and a head behind
 * the last one answered (or one a landed re-sync replaced) is skipped for up to STALE_GRACE_MS. If it
 * is still there after that it is real (a reorg, or values handed out to someone else): a head at most
 * 2 values behind, or on an older chain, is answered as usual; one further behind on the same chain
 * re-syncs onto a fresh chain, since the values in between may be known to whoever asked for them.
 *
 * Handed-out values. Whoever holds the bridge token can ask with any head. A head beyond the highest
 * value this adapter handed out on its chain (`served`) is not one the keeper can hold unless the seed
 * file is a stale backup or the seed leaked: the adapter abandons that chain (never answers from it
 * again) and re-syncs onto a fresh one. (The token can still step the chain one value ahead of the keeper; doing that moves the
 * mark ahead, so the node's own reads then look stale and end in a re-sync after the grace period.)
 */

const fs = require('fs');
const path = require('path');
const { KeyChains, createChain, defaultDir, DEFAULT_LENGTH } = require('./chainStore');

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const IN_FLIGHT_MS = 20_000;
const ROTATE_MARGIN = 1000;
const RETAIN_MS = 24 * 60 * 60 * 1000;   // keep the previous chain this long after the keeper switches
const STALE_GRACE_MS = 25_000;           // skip a stale-looking head this long (job: every 10 s; deadline 60 s)
const STALE_SAME_CHAIN = 2;              // a stale head this close is answered after the grace period

/** bytes32 from the job: 0x-hex, or a decimal string (how a uint256 would come through) */
function parseBytes32(v) {
  const s = String(v ?? '').trim();
  if (HEX32.test(s)) return s.toLowerCase();
  if (/^[0-9]{1,78}$/.test(s)) {
    const n = BigInt(s);
    if (n < (1n << 256n)) return '0x' + n.toString(16).padStart(64, '0');
  }
  return null;
}

function errored(id, statusCode, error) {
  return { jobRunID: id || 'unknown', status: 'errored', statusCode, error };
}

/**
 * @param {{ dir?: string, logger?: object, now?: () => number, inFlightMs?: number, rotateMargin?: number,
 *   chainLength?: number, retainMs?: number, staleGraceMs?: number }} [options]
 *   chainLength: values in a chain made for a re-sync
 */
function createHealthHandler(options = {}) {
  const dir = options.dir || defaultDir();
  const logger = options.logger || { info() {}, warn() {}, error() {} };
  const now = options.now || Date.now;
  const inFlightMs = options.inFlightMs ?? IN_FLIGHT_MS;
  const rotateMargin = options.rotateMargin ?? ROTATE_MARGIN;
  const chainLength = options.chainLength ?? DEFAULT_LENGTH;
  const retainMs = options.retainMs ?? RETAIN_MS;
  const staleGraceMs = options.staleGraceMs ?? STALE_GRACE_MS;
  const keys = new Map();        // key -> KeyChains
  const sent = new Map();        // key -> { head, at }: the last head answered
  const stale = new Map();       // key -> { head, since }: a stale-looking head being waited out

  /** true while `head` has looked stale for less than the grace period */
  function waitStale(key, head) {
    const s = stale.get(key);
    if (!s || s.head !== head) { stale.set(key, { head, since: now() }); return true; }
    return now() - s.since < staleGraceMs;
  }
  const skip = (id, reason) => ({ jobRunID: id, statusCode: 200, status: 'success', data: { answer: false, reason } });

  function chainsFor(key) {
    let kc = keys.get(key);
    if (!kc) {
      // no file at all (lost, or never made for this key): start one for a re-sync
      if (!fs.existsSync(path.join(dir, `${key}.json`))) createChain(key, { dir, length: chainLength, resync: true });
      kc = new KeyChains(key, { dir });
      keys.set(key, kc);
    }
    return kc;
  }

  function resync(id, key, head, kc, tag, why, from) {
    const fresh = kc.resyncHead(chainLength, from);
    sent.set(key, { head, at: now() });
    logger.warn(`${tag} ${why}: re-syncing onto a fresh hash chain (head ${fresh}); the arbiter is frozen until its next answers land`);
    return { jobRunID: id, statusCode: 200, status: 'success', data: { answer: true, preimage: fresh, newHead: fresh, resync: true } };
  }

  return async function healthHandler(request) {
    const id = request?.id;
    const data = request?.data || {};
    const key = parseBytes32(data.healthKey);
    const head = parseBytes32(data.head);
    if (!key || !head) return errored(id, 400, 'healthKey and head must be bytes32');
    const tag = `[health ${key.slice(0, 10)}…]`;

    let kc;
    try {
      kc = chainsFor(key);
    } catch (e) {
      logger.error(`${tag} no usable hash chain: ${e.message}`);
      return errored(id, 404, 'No hash chain for this key');
    }

    const last = sent.get(key);
    if (last && last.head === head && now() - last.at < inFlightMs) {
      return { jobRunID: id, statusCode: 200, status: 'success', data: { answer: false, reason: 'in flight' } };
    }

    if (kc.prune(now(), retainMs)) logger.info(`${tag} dropped the hash chains before the current one`);
    const at = kc.locate(head);
    if (!at) {
      if (kc.resyncedFrom(head) >= 0) {
        if (waitStale(key, head)) return skip(id, 'stale head (replaced by a re-sync)');
        logger.warn(`${tag} the keeper's head is still ${head}, which a landed re-sync replaced (a reorg?)`);
      }
      return resync(id, key, head, kc, tag, `the keeper's head ${head} is on none of this key's chains`, head);
    }
    const c = at.chain;
    const served = kc.records[c].served;
    if (Number.isInteger(served) && at.index > served) {
      logger.error(`${tag} the keeper's head is value ${at.index} of a chain this adapter has handed out only to ${served}: the chain file is older than the chain (restored from a backup?) or its seed leaked`);
      kc.abandon(c, at.index);                               // its values may be known: never answer from it
      return resync(id, key, head, kc, tag, 'the head is beyond every value handed out');
    }
    if (kc.records[c].abandoned) {
      const mark = kc.markPos();
      const replaced = (mark && mark.chain > c) || kc.records.slice(c + 1).some((r) => Number.isFinite(r.landedAt));
      if (replaced && waitStale(key, head)) {
        return skip(id, 'stale head (on an abandoned chain a re-sync replaced)');
      }
      return resync(id, key, head, kc, tag, 'the head is on an abandoned chain');
    }
    const mark = kc.markPos();
    if (mark && (c < mark.chain || (c === mark.chain && at.index < mark.index))) {
      if (waitStale(key, head)) return skip(id, 'stale head (behind the last one answered)');
      if (c === mark.chain && mark.index - at.index > STALE_SAME_CHAIN) {
        logger.error(`${tag} the keeper's head stays ${mark.index - at.index} values behind the last one answered: values were handed out that the keeper never took (another caller with the bridge token?)`);
        return resync(id, key, head, kc, tag, 'the head is far behind the last one answered');
      }
      logger.warn(`${tag} the keeper's head stays behind the last one answered; answering it (a reorg?)`);
    }
    stale.delete(key);
    kc.landed(c, now());
    const chain = kc.chains[c];
    if (at.index >= chain.length) return resync(id, key, head, kc, tag, "the keeper's head is this chain's seed (used up)");
    const preimage = chain.value(at.index + 1);
    let newHead = preimage;
    if (c < kc.chains.length - 1) {
      newHead = kc.chains[kc.chains.length - 1].head;         // a rotation sent earlier has not landed
    } else if (at.index + 1 >= chain.length - rotateMargin) {
      newHead = kc.rotate();
      logger.info(`${tag} rotating to a new hash chain (head ${newHead})`);
    }
    kc.answered(at);                                          // persisted before the answer leaves
    sent.set(key, { head, at: now() });
    logger.info(`${tag} answering health call: value ${at.index + 1} of ${chain.length}${newHead !== preimage ? ', with rotation' : ''}`);
    return { jobRunID: id, statusCode: 200, status: 'success', data: { answer: true, preimage, newHead } };
  };
}

/** a bridge request for this handler, not an evaluation */
function isHealthRequest(body) {
  return !!(body && body.data && Object.prototype.hasOwnProperty.call(body.data, 'healthKey'));
}

module.exports = { createHealthHandler, isHealthRequest, parseBytes32, IN_FLIGHT_MS, ROTATE_MARGIN, RETAIN_MS, STALE_GRACE_MS };
