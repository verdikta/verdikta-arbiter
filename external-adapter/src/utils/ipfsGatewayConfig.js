/**
 * @fileoverview Operator IPFS gateway settings passed to the @verdikta/common
 * client.
 *
 * `IPFS_GATEWAY` — comma- or whitespace-separated list of gateway origins the
 * operator wants tried FIRST, in order, ahead of the library's built-in public
 * gateways (Pinata, ipfs.io, dweb.link). A single URL is a list of one, so the
 * historical single-gateway form keeps working.
 *
 * `IPFS_GATEWAY_TOKEN` — optional Pinata dedicated-gateway key. The library
 * sends it (as the `x-pinata-gateway-token` header) only to the gateways
 * listed in `IPFS_GATEWAY`, never to its built-in public gateways.
 *
 * @verdikta/common ≤ 1.6.x ignores both keys: its fetch loop used a
 * hard-coded gateway order (ipfs.io, the retired cloudflare-ipfs.com, Pinata,
 * dweb.link) and never read `config.ipfs.gateway`. Passing them is therefore
 * forward-compatible — nothing changes until the library release that honours
 * them.
 */

// A gateway is an http(s) origin, optionally with a path prefix; the library
// appends `/ipfs/<cid>`. No query string or fragment.
const GATEWAY_URL = /^https?:\/\/[^\s?#]+$/i;

/**
 * Split an `IPFS_GATEWAY` value into normalized, de-duplicated gateway URLs.
 *
 * @param {string|undefined} value
 * @returns {{ gateways: string[], rejected: string[] }}
 */
function parseGatewayList(value) {
  const gateways = [];
  const rejected = [];
  for (const raw of String(value == null ? '' : value).split(/[\s,]+/)) {
    if (!raw) continue;
    const normalized = raw.replace(/\/+$/, '');
    if (!GATEWAY_URL.test(normalized)) {
      rejected.push(raw);
      continue;
    }
    if (!gateways.includes(normalized)) gateways.push(normalized);
  }
  return { gateways, rejected };
}

/**
 * Build the gateway-related part of the `ipfs` config for `createClient`.
 * Keys are only present when set, so an older library's config merge sees
 * nothing new and the client's defaults apply untouched.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {object} [options]
 * @param {string[]} [options.builtInGateways] - the library's own default list
 *   (`DEFAULT_IPFS_GATEWAYS`, exported from @verdikta/common ≥ 1.7), used only
 *   to warn when the operator list merely reorders gateways the library already
 *   tries — e.g. a stale `IPFS_GATEWAY=https://ipfs.io` copied from old docs
 *   would push a rate-limited public gateway ahead of Pinata.
 * @returns {{ ipfs: { gateways?: string[], gatewayToken?: string }, warnings: string[] }}
 */
function buildIpfsGatewayConfig(env = process.env, { builtInGateways = [] } = {}) {
  const { gateways, rejected } = parseGatewayList(env.IPFS_GATEWAY);
  const token = String(env.IPFS_GATEWAY_TOKEN || '').trim();
  const ipfs = {};
  const warnings = [];

  if (gateways.length > 0) ipfs.gateways = gateways;
  if (token) ipfs.gatewayToken = token;

  for (const entry of rejected) {
    warnings.push(`ignoring IPFS_GATEWAY entry "${entry}": not an http(s) URL`);
  }
  if (token && gateways.length === 0) {
    warnings.push('IPFS_GATEWAY_TOKEN is set but IPFS_GATEWAY lists no gateway; ' +
                  'the token is only sent to gateways listed in IPFS_GATEWAY');
  }
  const builtIn = Array.isArray(builtInGateways) ? builtInGateways : [];
  if (gateways.length > 0 && gateways.every((g) => builtIn.includes(g))) {
    warnings.push(`IPFS_GATEWAY only lists gateways the library already tries (${gateways.join(', ')}); ` +
                  'this changes their order only — unset it to keep the library default order ' +
                  `(${builtIn.join(', ')})`);
  }
  return { ipfs, warnings };
}

module.exports = { parseGatewayList, buildIpfsGatewayConfig };
