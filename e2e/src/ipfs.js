'use strict';

const axios = require('axios');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one justification JSON from IPFS, trying each gateway in order (first
 * success wins — public gateways rate-limit GitHub runners, so the configured
 * order puts our own Pinata pin first).
 *
 * A justification is pinned seconds before the adapter or the aggregator hands
 * its CID back, and even Pinata's gateway can take a minute or two to serve a
 * fresh CID: the first class-5555 canary run saw Pinata time out and ipfs.io /
 * dweb.link answer 403 / 429 on a CID that was fetchable shortly after. So the
 * gateways are swept up to `retry.attempts` times, `retry.delayMs` apart.
 *
 * @param {string[]|string} gateways
 * @param {string} cid
 * @param {number} timeoutMs - per-request timeout
 * @param {{ attempts?: number, delayMs?: number }} [retry] - defaults to a single sweep
 * @returns {Promise<{ json: object|null, gateway: string|null, errors: string[], attempt: number }>}
 */
async function fetchJustificationJson(gateways, cid, timeoutMs, retry = {}) {
  const attempts = Math.max(1, Number(retry.attempts) || 1);
  const delayMs = Math.max(0, Number(retry.delayMs) || 0);
  const list = Array.isArray(gateways) ? gateways : [gateways];
  let errors = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    errors = [];
    for (const gateway of list) {
      const url = `${gateway.replace(/\/$/, '')}/ipfs/${cid}`;
      try {
        const { data } = await axios.get(url, { timeout: timeoutMs });
        const obj = typeof data === 'string' ? JSON.parse(data) : data;
        if (obj && (Array.isArray(obj.scores) || typeof obj.justification === 'string')) {
          return { json: obj, gateway, errors, attempt };
        }
        errors.push(`${gateway}: missing scores/justification`);
      } catch (err) {
        errors.push(`${gateway}: ${err.message}`);
      }
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  return { json: null, gateway: null, errors, attempt: attempts };
}

/** Retry options for justification fetches, from the merged e2e config. */
function justificationRetry(cfg) {
  const t = (cfg && cfg.timeouts) || {};
  return { attempts: t.ipfsFetchAttempts, delayMs: t.ipfsFetchRetryMs };
}

module.exports = { fetchJustificationJson, justificationRetry };
