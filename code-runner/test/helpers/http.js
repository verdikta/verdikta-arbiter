'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { loadConfig } = require('../../src/config');

const TOKEN = 'test-token-'.padEnd(48, 'x');

/** A loaded config on an ephemeral loopback port, rooted in a temp dir. */
function testConfig(env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-test-'));
  const config = loadConfig({ CODE_RUNNER_TOKEN: TOKEN, CODE_RUNNER_RUNTIME: 'runc', ...env }, { root });
  if (!env.CODE_RUNNER_SOCKET) config.listen = { host: '127.0.0.1', port: 0 };
  config.gcIntervalMs = 0;
  return config;
}

/**
 * One HTTP request. `target` is { host, port } or { socketPath }. Resolves
 * { status, headers, body (parsed JSON when possible), raw }.
 */
function request(target, { method = 'GET', path: urlPath = '/', headers = {}, body, token = TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (payload && !('content-type' in h)) h['content-type'] = 'application/json';
    if (payload) h['content-length'] = String(payload.length);
    const req = http.request({ ...target, method, path: urlPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { TOKEN, testConfig, request };
