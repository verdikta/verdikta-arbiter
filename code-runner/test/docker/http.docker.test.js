'use strict';

// End to end over HTTP with a real daemon: /health reports the runtime and
// Docker; POST /v1/runs starts and removes a sandbox; a caller that hangs up
// mid-run gets its container killed.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../../src/server');
const { request, TOKEN } = require('../helpers/http');
const { runRequest, spec } = require('../helpers/requests');
const { RUNTIME, TEST_IMAGE, silent, dockerTestConfig, dockerFor, ensureTestImage, leftovers, removeAll, eventually } = require('./helpers');

async function start(t, stepsFor) {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance).catch(() => {}));
  await ensureTestImage(docker);
  const runner = createServer({ config, docker, log: silent, stepsFor });
  const address = await runner.listen();
  t.after(() => runner.close());
  return { config, docker, target: { host: address.host, port: address.port } };
}

function body(over = {}) {
  return runRequest({ spec: spec({ env: { image: TEST_IMAGE, from: 'foundry', platform: 'linux/amd64', unpackedBytes: 100000000 }, limits: { cpus: 1, memoryMb: 512, runSeconds: 120, testSeconds: 60 } }), ...over });
}

test('GET /health against the real daemon', { timeout: 60000 }, async (t) => {
  const { target } = await start(t);
  const res = await request(target, { path: '/health' });
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.docker.reachable, true);
  assert.equal(res.body.runtime, RUNTIME);
  assert.equal(res.body.runtimeAvailable, true);
  assert.ok(res.body.docker.serverVersion);
  assert.ok(res.body.dataRoot.path);
  if (process.platform === 'linux') assert.ok(res.body.dataRoot.freeBytes > 0, JSON.stringify(res.body.dataRoot));
});

test('POST /v1/runs starts a sandbox from the spec\'s image and removes it', { timeout: 180000 }, async (t) => {
  const seen = {};
  const { docker, config, target } = await start(t, () => [async (ctx) => {
    seen.uid = (await ctx.exec(['id', '-u'], { name: 'whoami', timeoutMs: 30000 })).stdout.text.trim();
  }]);
  const res = await request(target, { method: 'POST', path: '/v1/runs', body: body() });
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.outcome, 'definitive');
  assert.equal(res.body.steps[0].name, 'whoami');
  assert.equal(seen.uid, '10001');
  assert.deepEqual(await leftovers(docker, config.instance), []);
});

test('a caller that hangs up mid-run gets its container killed', { timeout: 180000 }, async (t) => {
  let started = false;
  const { docker, config, target } = await start(t, () => [async (ctx) => {
    started = true;
    await ctx.exec(['sleep', '120'], { name: 'poc', timeoutMs: 120000 });
  }]);
  const payload = Buffer.from(JSON.stringify(body()));
  const req = http.request({ ...target, method: 'POST', path: '/v1/runs', headers: {
    authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': payload.length
  } });
  req.on('error', () => {});
  req.end(payload);
  assert.ok(await eventually(async () => started && (await leftovers(docker, config.instance)).length === 1, { timeoutMs: 60000 }), 'the run started');
  req.destroy();
  assert.ok(await eventually(async () => (await leftovers(docker, config.instance)).length === 0, { timeoutMs: 30000 }), 'the container was removed');
});
