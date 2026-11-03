'use strict';

/**
 * A local IPFS for the claim suite: what @verdikta/common's real client asks of a
 * gateway and of Pinata, on loopback, with no key that means anything.
 *
 *   GET  /ipfs/<cid>                 the bytes, or 404
 *   POST /pinning/pinFileToIPFS      multipart "file", Authorization: Bearer <pinKey>; answers { IpfsHash }
 *
 * CIDs are real CIDv0s of the bytes. The EA is pointed here with IPFS_GATEWAY and
 * IPFS_PINNING_SERVICE. The client falls through to the public gateways on a miss, so
 * misses are counted, and a scenario that had any fails: none can pass by reaching the
 * network.
 */

const http = require('http');
const Hash = require('ipfs-only-hash');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The first part's bytes of a multipart body, or null. Binary safe. */
function firstPart(body, contentType) {
  const m = /boundary="?([^";]+)"?/i.exec(contentType || '');
  if (!m) return null;
  const delimiter = Buffer.from(`--${m[1]}`);
  const open = body.indexOf(delimiter);
  if (open < 0) return null;
  const headersEnd = body.indexOf('\r\n\r\n', open);
  if (headersEnd < 0) return null;
  const start = headersEnd + 4;
  const close = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delimiter]), start);
  if (close < 0) return null;
  return body.subarray(start, close);
}

/**
 * @param {{ pinKey: string }} o
 * @returns {Promise<{ url: string, put: (b: Buffer) => Promise<string>, get: (cid: string) => Buffer|undefined,
 *   fetches: string[], misses: string[], pins: string[], close: () => Promise<void> }>}
 */
async function startLocalIpfs({ pinKey }) {
  const store = new Map();
  const fetches = [];
  const misses = [];
  const pins = [];

  const put = async (bytes) => {
    const cid = await Hash.of(bytes);
    store.set(cid, Buffer.from(bytes));
    return cid;
  };

  const server = http.createServer((req, res) => {
    const reply = (status, body, type = 'application/json') => {
      const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      res.writeHead(status, { 'content-type': type, 'content-length': payload.length });
      res.end(payload);
    };
    const handle = async () => {
      const url = new URL(req.url, 'http://local');
      const fetched = /^\/ipfs\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && fetched) {
        const bytes = store.get(fetched[1]);
        if (!bytes) {
          misses.push(fetched[1]);
          return reply(404, { error: 'not on this local IPFS' });
        }
        fetches.push(fetched[1]);
        return reply(200, bytes, 'application/octet-stream');
      }
      if (req.method === 'POST' && url.pathname === '/pinning/pinFileToIPFS') {
        if (req.headers.authorization !== `Bearer ${pinKey}`) return reply(401, { error: 'wrong or no pinning key' });
        const part = firstPart(await readBody(req), req.headers['content-type']);
        if (!part) return reply(400, { error: 'not a multipart upload' });
        const cid = await put(part);
        pins.push(cid);
        return reply(200, { IpfsHash: cid, PinSize: part.length, Timestamp: new Date().toISOString() });
      }
      return reply(404, { error: 'no such route' });
    };
    handle().catch((err) => reply(500, { error: err.message }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    put,
    get: (cid) => store.get(cid),
    fetches,
    misses,
    pins,
    close: () => new Promise((resolve) => {
      if (server.closeAllConnections) server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

module.exports = { startLocalIpfs };
