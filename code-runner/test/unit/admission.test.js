'use strict';

// Acceptance (A1b): admission adds an execution-slot count and a memory
// reserve (Chainlink, Postgres, AI Node, largest local model), on top of A1's
// maintenance lock, deadline and daemon checks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Capacity, parseMemAvailableMb, memoryReserve } = require('../../src/admission');
const { Abstain } = require('../../src/result');
const { fakeDocker, healthyDaemon } = require('../helpers/fakeDocker');
const { testConfig } = require('../helpers/http');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function config(env = {}) {
  return testConfig({
    CODE_RUNNER_SLOTS: '2',
    CODE_RUNNER_RESERVE_CHAINLINK_MB: '1000',
    CODE_RUNNER_RESERVE_POSTGRES_MB: '500',
    CODE_RUNNER_RESERVE_AI_NODE_MB: '700',
    CODE_RUNNER_RESERVE_LOCAL_MODEL_MB: '0',
    ...env
  });
}

function admit(capacity, { memoryMb = 1024, runSeconds = 60, stopIn = 600000, docker = fakeDocker(healthyDaemon()) } = {}) {
  return capacity.admit({ config: capacity.config, docker, limits: { memoryMb, runSeconds }, stopAt: Date.now() + stopIn });
}

async function refused(promise, re) {
  let err;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err instanceof Abstain, `expected a refusal, got ${err && err.stack}`);
  assert.equal(err.cause, 'admission_refused');
  assert.equal(err.step, 'admission');
  if (re) assert.match(err.detail, re);
  return err;
}

test('slots: a run past the execution-slot count is refused; a released slot is free again', async () => {
  const capacity = new Capacity({ config: config(), meminfo: async () => ({ availableMb: 1e6, error: null }), log: silent });
  const a = await admit(capacity);
  const b = await admit(capacity);
  await refused(admit(capacity), /all 2 execution slots are in use/);
  assert.deepEqual(capacity.status().slots, { total: 2, inUse: 2 });
  a.release();
  a.release(); // idempotent: never frees a second slot
  assert.deepEqual(capacity.status().slots, { total: 2, inUse: 1 });
  const c = await admit(capacity);
  b.release();
  c.release();
  assert.equal(capacity.status().slots.inUse, 0);
});

test('memory: a run is refused when it would cut into the reserve for Chainlink, Postgres, the AI Node and the largest local model', async () => {
  // Reserve 1000 + 500 + 700 + 0 = 2200 MiB; 8000 MiB available.
  const capacity = new Capacity({ config: config(), meminfo: async () => ({ availableMb: 8000, error: null }), log: silent });
  const first = await admit(capacity, { memoryMb: 4096 });
  // The first run's whole limit counts as taken, whatever it uses yet: 8000 - 4096 - 4096 < 2200.
  const err = await refused(admit(capacity, { memoryMb: 4096 }), /8000 MiB available/);
  assert.match(err.detail, /4096 MiB held by runs in flight/);
  assert.match(err.detail, /chainlink 1000, postgres 500, aiNode 700, localModel 0/);
  const small = await admit(capacity, { memoryMb: 1024 });
  first.release();
  small.release();
  assert.deepEqual(capacity.status().memory, {
    availableMb: 8000, committedMb: 0, reserveMb: 2200,
    reserve: { chainlink: 1000, postgres: 500, aiNode: 700, localModel: 0 }, error: null
  });
});

test('memory: the largest local model is part of the reserve', async () => {
  const meminfo = async () => ({ availableMb: 8000, error: null });
  const without = new Capacity({ config: config(), meminfo, log: silent });
  (await admit(without, { memoryMb: 4096 })).release();
  const withModel = new Capacity({ config: config({ CODE_RUNNER_RESERVE_LOCAL_MODEL_MB: '4700' }), meminfo, log: silent });
  await refused(admit(withModel, { memoryMb: 4096 }), /localModel 4700/);
  assert.equal(memoryReserve(withModel.config).total, 6900);
});

test('memory that cannot be measured refuses under runsc and is allowed, with a warning, under runc (macOS development)', async () => {
  const unknown = async () => ({ availableMb: null, error: 'ENOENT' });
  const runsc = new Capacity({ config: config({ CODE_RUNNER_RUNTIME: 'runsc' }), meminfo: unknown, log: silent });
  await refused(admit(runsc), /could not be measured/);
  const warned = [];
  const runc = new Capacity({ config: config(), meminfo: unknown, log: { ...silent, warn: (m) => warned.push(m) } });
  (await admit(runc)).release();
  assert.ok(warned.some((m) => /memory/.test(m)));
});

test('A1\'s checks still come first: the maintenance lock and the deadline refuse before a slot is taken', async () => {
  const c = config();
  const capacity = new Capacity({ config: c, meminfo: async () => ({ availableMb: 1e6, error: null }), log: silent });
  await refused(admit(capacity, { runSeconds: 360, stopIn: 1000 }), /deadline/);
  fs.mkdirSync(path.dirname(c.maintenanceFile), { recursive: true });
  fs.writeFileSync(c.maintenanceFile, '');
  await refused(admit(capacity), /maintenance/);
  assert.equal(capacity.status().slots.inUse, 0);
});

test('/proc/meminfo: MemAvailable in kB becomes MiB', () => {
  assert.equal(parseMemAvailableMb('MemTotal:       16384000 kB\nMemFree:  100 kB\nMemAvailable:    8388608 kB\n'), 8192);
  assert.equal(parseMemAvailableMb('MemTotal: 1 kB\n'), null);
  assert.equal(parseMemAvailableMb(''), null);
});
