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
