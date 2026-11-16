'use strict';

/**
 * A proxy that records what crosses it, in front of the AI Node and the code runner:
 * what the EA really sent and really got back, in the requests' own JSON.
 */

const http = require('http');

const parse = (bytes) => {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (_) {
    return null;
  }
};

/**
 * @param {string} target - the service's base URL
 * @returns {Promise<{ url: string, calls: object[], post: (path: string) => object[], close: () => Promise<void> }>}
 */
async function startRecordingProxy(target) {
  const to = new URL(target);
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const upstream = http.request({
        // A fresh connection per call: a kept-alive one can be closed by the service between calls.
        host: to.hostname, port: to.port, method: req.method, path: req.url, agent: false, headers: { ...req.headers, host: to.host, connection: 'close' }
      }, (answer) => {
        const out = [];
        answer.on('data', (c) => out.push(c));
        answer.on('end', () => {
          const payload = Buffer.concat(out);
          calls.push({ method: req.method, path: req.url.split('?')[0], status: answer.statusCode, request: parse(body), response: parse(payload) });
          res.writeHead(answer.statusCode, answer.headers);
          res.end(payload);
        });
      });
      upstream.on('error', (err) => {
        calls.push({ method: req.method, path: req.url.split('?')[0], status: 502, request: parse(body), response: null, error: err.message });
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `the proxy could not reach ${target}: ${err.message}` }));
      });
      // The caller hung up (its deadline): so does the proxy, as a direct connection would.
      res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
      upstream.end(body);
    });
  });
  // A code-review call runs for minutes, with nothing on the socket.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    post: (path) => calls.filter((c) => c.method === 'POST' && c.path === path),
    close: () => new Promise((resolve) => {
      if (server.closeAllConnections) server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

module.exports = { startRecordingProxy };
