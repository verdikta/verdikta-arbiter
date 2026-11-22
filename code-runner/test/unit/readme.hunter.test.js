'use strict';

// README, "A hunter's machine: what `check` needs". An outside hunter lost about three hours to admission
// refusals (verdikta-applications, tester bounty 400, 2026-11): the figures and the settings were in this README,
// in "Images and admission" and "Configuration", and not where a hunter starts the runner. The section gathers
// them, and every figure and name in it is read back from the code here, so that it fails when one moves.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { codeReview } = require('@verdikta/common');
const { Capacity, memoryReserve } = require('../../src/admission');
const { sandboxesFor } = require('../../src/claim');
const { loadConfig, DEFAULT_PORT } = require('../../src/config');
const { health } = require('../../src/health');
const { Abstain } = require('../../src/result');
const { fakeDocker, healthyDaemon } = require('../helpers/fakeDocker');
const { testConfig } = require('../helpers/http');

const README = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
const silent = { info() {}, warn() {}, error() {}, debug() {} };

function section() {
  const start = README.indexOf('\n### A hunter\'s machine: what `check` needs\n');
  assert.ok(start >= 0, 'the README has the section');
  const end = README.indexOf('\n### ', start + 5);
  return README.slice(start, end);
}
const flat = () => section().replace(/\s+/g, ' ');

const memoryMb = codeReview.CLASS_HARD_LIMITS.memoryMb;
const runSeconds = codeReview.CLASS_HARD_LIMITS.runSeconds;

async function refusal(capacity, sandboxes) {
  let err;
  try {
    await capacity.admit({ config: capacity.config, docker: fakeDocker(healthyDaemon()), limits: { memoryMb, runSeconds }, stopAt: Date.now() + 3600000, sandboxes });
  } catch (e) { err = e; }
  assert.ok(err instanceof Abstain, `expected a refusal, got ${err && err.stack}`);
  assert.equal(err.cause, 'admission_refused');
  return err.detail;
}

test('the section sits under "Run it", before the macOS and Linux notes', () => {
  const run = README.indexOf('\n## Run it\n');
  const here = README.indexOf('\n### A hunter\'s machine: what `check` needs\n');
  const mac = README.indexOf('\n### macOS (development): runc\n');
  assert.ok(run >= 0 && run < here && here < mac);
});

test('the figures are the class\'s limit, the default reserve and their sums; a fix.patch doubles the sandboxes', () => {
  const text = flat();
  const reserve = memoryReserve(testConfig()).total;
  assert.equal(sandboxesFor({ fixPatch: 'x' }), 2);
  assert.equal(sandboxesFor({}), 1);
  assert.ok(text.includes(`the class's limit, ${memoryMb} MiB (\`limits.memoryMb\``), 'the sandbox limit');
  assert.ok(text.includes(`so its run may use ${memoryMb * 2} MiB`), 'two sandboxes');
  assert.ok(text.includes(`the reserve: ${reserve} MiB by default`), 'the default reserve');
  assert.ok(text.includes(`So a claim needs ${memoryMb + reserve} MiB available, and one with a \`fix.patch\` ${memoryMb * 2 + reserve} MiB.`), 'what a run needs');
  assert.ok(text.includes(`can be set to 0, which leaves a claim needing ${memoryMb} MiB`), 'without the reserve');
  // every "N MiB" in the section is one of those
  const allowed = new Set([memoryMb, memoryMb * 2, reserve, memoryMb + reserve, memoryMb * 2 + reserve, 3033, 0, 512, 256]);
  for (const m of section().matchAll(/\b(\d+) MiB\b/g)) assert.ok(allowed.has(Number(m[1])), `${m[0]} is a figure the code gives`);
});

test('the refusal quoted is the runner\'s own, word for word, and a fix.patch makes it name both sandboxes', async () => {
  const capacity = new Capacity({ config: testConfig(), meminfo: async () => ({ availableMb: 3033, error: null }), log: silent });
  const detail = await refusal(capacity, 1);
  const quoted = /```text\n([^\n]+)\n```/.exec(section());
  assert.ok(quoted, 'the section quotes a refusal');
  assert.equal(quoted[1], detail);
  assert.match(await refusal(capacity, 2), new RegExp(`this run may use ${memoryMb * 2} MiB \\(2 sandboxes of ${memoryMb} MiB\\)`));
});

test('the command line that sets the reserve to 0 names the runner\'s settings, and a claim then fits in the class\'s limit', async () => {
  const line = /CODE_RUNNER_RESERVE_CHAINLINK_MB=0 CODE_RUNNER_RESERVE_POSTGRES_MB=0 CODE_RUNNER_RESERVE_AI_NODE_MB=0 npm start/.exec(section());
  assert.ok(line, 'the section shows the three settings');
  const env = Object.fromEntries([...line[0].matchAll(/(CODE_RUNNER_[A-Z_]+)=(\d+)/g)].map((m) => [m[1], m[2]]));
  const config = testConfig(env);
  assert.deepEqual(memoryReserve(config), { chainlink: 0, postgres: 0, aiNode: 0, localModel: 0, total: 0 });
  assert.match(flat(), /\(`CODE_RUNNER_RESERVE_LOCAL_MODEL_MB` is 0 already\.\)/);
  assert.equal(memoryReserve(testConfig()).localModel, 0);
  const exact = new Capacity({ config, meminfo: async () => ({ availableMb: memoryMb, error: null }), log: silent });
  const ticket = await exact.admit({ config, docker: fakeDocker(healthyDaemon()), limits: { memoryMb, runSeconds }, stopAt: Date.now() + 3600000 });
  ticket.release();
  const short = new Capacity({ config, meminfo: async () => ({ availableMb: memoryMb - 1, error: null }), log: silent });
  await refusal(short, 1);
});

test('the port, the token and the clean environment are the config\'s', () => {
  const text = flat();
  assert.ok(text.includes(`\`http://127.0.0.1:${DEFAULT_PORT}\` unless \`CODE_RUNNER_PORT\` moved the port`));
  assert.equal(loadConfig({ CODE_RUNNER_TOKEN: 't'.repeat(40) }, { root: '/x' }).listen.port, DEFAULT_PORT);
  const min = Number(/\((\d+) or more printable characters;/.exec(text)[1]);
  assert.throws(() => loadConfig({ CODE_RUNNER_TOKEN: 't'.repeat(min - 1) }, { root: '/x' }), /at least 32 characters/);
  assert.doesNotThrow(() => loadConfig({ CODE_RUNNER_TOKEN: 't'.repeat(min) }, { root: '/x' }));
  // a hunter's pinning token in the environment stops the runner from starting
  assert.throws(() => loadConfig({ CODE_RUNNER_TOKEN: 't'.repeat(40), VERDIKTA_PIN_TOKEN: 'x' }, { root: '/x' }), /holds no secrets/);
  assert.match(text, /the runner refuses to start beside one: give it its own environment with `env -i`/);
});

test('/health reports the memory it measured and stays ok on a host too small for a run; without a reading under runc a run is admitted', async () => {
  const config = testConfig();
  const small = new Capacity({ config, meminfo: async () => ({ availableMb: 3033, error: null }), log: silent });
  const h = await health({ config, docker: fakeDocker(healthyDaemon()), statfs: async () => ({ bavail: 10, bsize: 1000 }), capacity: small });
  assert.equal(h.ok, true, 'too little memory for a run is not unhealthy');
  assert.deepEqual(Object.keys(h.capacity.memory).filter((k) => ['availableMb', 'committedMb', 'reserveMb'].includes(k)).sort(), ['availableMb', 'committedMb', 'reserveMb']);
  assert.equal(h.capacity.memory.availableMb, 3033);
  await refusal(small, 1);
  const text = flat();
  assert.match(text, /it answers `ok: true` on a host with too little memory for a run/);
  assert.match(text, /A run fits when `availableMb - committedMb - memoryMb × sandboxes` is at least `reserveMb`\./);
  // macOS: no /proc/meminfo, so no reading; under runc the run is admitted
  const blind = new Capacity({ config, meminfo: async () => ({ availableMb: null, error: 'ENOENT' }), log: silent });
  const ticket = await blind.admit({ config, docker: fakeDocker(healthyDaemon()), limits: { memoryMb, runSeconds }, stopAt: Date.now() + 3600000 });
  ticket.release();
  assert.match(text, /under `runc` there the runner admits a run with a warning and no memory check/);
});
