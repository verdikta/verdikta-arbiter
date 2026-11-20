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
 */

const { KeyChains, defaultDir } = require('./chainStore');

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const IN_FLIGHT_MS = 20_000;
const ROTATE_MARGIN = 1000;

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
 * @param {{ dir?: string, logger?: object, now?: () => number, inFlightMs?: number, rotateMargin?: number }} [options]
 */
function createHealthHandler(options = {}) {
  const dir = options.dir || defaultDir();
  const logger = options.logger || { info() {}, warn() {}, error() {} };
  const now = options.now || Date.now;
  const inFlightMs = options.inFlightMs ?? IN_FLIGHT_MS;
  const rotateMargin = options.rotateMargin ?? ROTATE_MARGIN;
  const keys = new Map();        // key -> KeyChains
  const sent = new Map();        // key -> { head, at }: the last head answered

  function chainsFor(key) {
    let kc = keys.get(key);
    if (!kc) { kc = new KeyChains(key, { dir }); keys.set(key, kc); }
    return kc;
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

    const at = kc.locate(head);
    if (!at) {
      logger.error(`${tag} the keeper's head ${head} is on none of this key's stored chains: the arbiter cannot answer (restore the chain file, or exit and register again)`);
      return errored(id, 409, 'Head not on a stored chain');
    }
    let c = at.chain;
    if (c > 0 && c === kc.chains.length - 1) { kc.dropBefore(c); c = 0; }   // a rotation has landed
    const chain = kc.chains[c];
    if (at.index >= chain.length) {
      logger.error(`${tag} the keeper's head is this chain's seed: nothing left to reveal`);
      return errored(id, 409, 'Chain exhausted');
    }
    const preimage = chain.value(at.index + 1);
    let newHead = preimage;
    if (c < kc.chains.length - 1) {
      newHead = kc.chains[kc.chains.length - 1].head;         // a rotation sent earlier has not landed
    } else if (at.index + 1 >= chain.length - rotateMargin) {
      newHead = kc.rotate();
      logger.info(`${tag} rotating to a new hash chain (head ${newHead})`);
    }
    sent.set(key, { head, at: now() });
    logger.info(`${tag} answering health call: value ${at.index + 1} of ${chain.length}${newHead !== preimage ? ', with rotation' : ''}`);
    return { jobRunID: id, statusCode: 200, status: 'success', data: { answer: true, preimage, newHead } };
  };
}

/** a bridge request for this handler, not an evaluation */
function isHealthRequest(body) {
  return !!(body && body.data && Object.prototype.hasOwnProperty.call(body.data, 'healthKey'));
}

module.exports = { createHealthHandler, isHealthRequest, parseBytes32, IN_FLIGHT_MS, ROTATE_MARGIN };
