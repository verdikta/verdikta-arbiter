'use strict';

// Startup order: the stop handlers exist before the listener admits a run,
// and the listener (the instance lock) exists before the startup GC.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startRunner } = require('../../src/index');
const { fakeDocker, healthyDaemon } = require('../helpers/fakeDocker');
const { testConfig } = require('../helpers/http');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

test('a stop signal during a slow startup sweep still goes through close()', async () => {
  let releaseSweep;
  const sweepGate = new Promise((r) => { releaseSweep = r; });
  const order = [];
  const docker = fakeDocker({ ...healthyDaemon(), ps: async () => { order.push('gc'); await sweepGate; return { stdout: '' }; } });
  const handlers = {};
  const exits = [];
  const config = testConfig();
  const starting = startRunner({
    config, docker, log: silent,
    onSignal: (sig, fn) => { order.push(`handler:${sig}`); handlers[sig] = fn; },
    exit: (code) => exits.push(code)
  });
  while (!order.includes('gc')) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, ['handler:SIGTERM', 'handler:SIGINT', 'gc'], 'handlers first, then listen, then the sweep');
  handlers.SIGTERM();
  while (exits.length === 0) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(exits, [0]);
  releaseSweep();
  const { runner, address } = await starting;
  assert.ok(address.port > 0);
  assert.equal(runner.server.listening, false, 'closed by the stop');
});

test('a second process with the same listener fails before its sweep', async () => {
  const config = testConfig();
  const docker = fakeDocker(healthyDaemon());
  const first = await startRunner({ config, docker, log: silent, onSignal: () => {}, exit: () => {} });
  const second = testConfig();
  second.listen = { host: '127.0.0.1', port: first.address.port };
  second.instance = config.instance;
  const docker2 = fakeDocker(healthyDaemon());
  await assert.rejects(startRunner({ config: second, docker: docker2, log: silent, onSignal: () => {}, exit: () => {} }), /EADDRINUSE/);
  assert.equal(docker2.callsOf('ps').length, 0, 'the second process never listed, so never removed, the first one\'s containers');
  await first.stop('test');
});

test('R5-F1: no run is admitted until the startup sweep has removed an earlier process\'s sandboxes; a failed sweep keeps them refused until one succeeds', async (t) => {
  const net = require('node:net');
  const { request } = require('../helpers/http');
  const { runRequest } = require('../helpers/requests');
  let releaseList;
  const listed = new Promise((r) => { releaseList = r; });
  let removals = 0;
  const leftover = `vcr-aaaaaaaaaaaaaaaa-1\t${Math.floor(Date.now() / 1000) + 600}\n`;
  const h = healthyDaemon();
  const docker = fakeDocker({
    ...h,
    // The GC's listing (filtered by the instance label) answers only when the test lets it.
    ps: async (args) => (args.includes('--filter') ? (await listed, { stdout: removals >= 2 ? '' : leftover }) : { stdout: '' }),
    rm: (args, ...rest) => {
      if (!args.includes('vcr-aaaaaaaaaaaaaaaa-1')) return h.rm(args, ...rest);
      removals += 1;
      return removals === 1
        ? { exitCode: 1, stderr: 'Error response from daemon: removal of container vcr-aaaaaaaaaaaaaaaa-1 is already in progress' }
        : { stdout: '' };
    }
  });
  const config = testConfig();
  // A known port, so a request can reach the listener while startRunner is still sweeping.
  const port = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  config.listen = { host: '127.0.0.1', port };
  const at = { host: '127.0.0.1', port };
  const starting = startRunner({
    config, docker, log: silent, onSignal: () => {}, exit: () => {}, sweepRetryMs: 30,
    server: { meminfo: async () => ({ availableMb: 1e6, error: null }), statfs: async () => ({ bavail: 1e12, bsize: 1 }), stepsFor: () => [] }
  });
  // Whatever an assertion does, the sweep is let go and the runner stopped.
  t.after(async () => { releaseList(); (await starting).stop('test'); });
  while (docker.callsOf('ps').length === 0) await new Promise((r) => setTimeout(r, 5));
  // The sweep is running: the listener is up (it is the instance lock) and admits nothing.
  const during = await request(at, { method: 'POST', path: '/v1/runs', body: runRequest() });
  assert.equal(during.status, 503, during.raw);
  assert.equal(during.body.abstain.cause, 'admission_refused');
  assert.match(during.body.abstain.detail, /earlier process/);
  releaseList();
  const { runner } = await starting;
  // The first removal failed: still refused, and /health says why.
  const refused = await request(at, { method: 'POST', path: '/v1/runs', body: runRequest() });
  assert.equal(refused.status, 503, refused.raw);
  assert.match(refused.body.abstain.detail, /earlier process/);
  const health = await request(at, { path: '/health' });
  assert.equal(health.status, 503);
  assert.match(health.body.capacity.held, /earlier process/);
  assert.equal(docker.callsOf('create').length, 0, 'no sandbox while the leftover may still run');
  // The retry removes it, and runs are admitted again.
  const until = Date.now() + 5000;
  while (runner.capacity.held && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  assert.equal(runner.capacity.held, null);
  assert.equal(removals, 2);
  const ok = await request(at, { method: 'POST', path: '/v1/runs', body: runRequest() });
  assert.equal(ok.status, 200, ok.raw);
});
