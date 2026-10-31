'use strict';

// Acceptance: one Docker test per abstain cause (step wall-clock limit,
// OOM/137, pids limit, dead sandbox, Docker unreachable, refused admission),
// plus the deadline kill, a signal death, a missing image and cancellation.
// Each test also checks that the run left no container behind.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { executeRun } = require('../../src/pipeline');
const { createDocker, runText } = require('../../src/docker');
const {
  TEST_IMAGE, silent, dockerTestConfig, dockerFor, ensureTestImage, leftovers, removeAll, smallLimits
} = require('./helpers');

const noAdmission = async () => {};

async function setup(t, env) {
  const config = dockerTestConfig(env);
  config.deadlineReserveMs = 0;
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance).catch(() => {}));
  await ensureTestImage(docker);
  return { config, docker };
}

function run({ config, docker }, steps, over = {}) {
  const receivedAt = Date.now();
  return executeRun({
    docker, config, limits: smallLimits(over.limits), image: over.image || TEST_IMAGE, runId: '00000000000000b1', steps,
    receivedAt, deadlineAt: receivedAt + (over.deadlineMs || 120000), signal: over.signal, active: new Set(), log: silent,
    ...(over.admit ? { admit: over.admit } : {})
  });
}

async function expectAbstain(env, result, cause, step) {
  assert.equal(result.outcome, 'abstain', JSON.stringify(result.steps.map((s) => ({ ...s, stdout: undefined }))));
  assert.equal(result.abstain.cause, cause, JSON.stringify(result.abstain));
  if (step) assert.equal(result.abstain.step, step);
  assert.deepEqual(await leftovers(env.docker, env.config.instance), [], 'the run removed its container');
}

test('step wall-clock limit: killed, abstains', { timeout: 120000 }, async (t) => {
  const env = await setup(t);
  const started = Date.now();
  const r = await run(env, [async (ctx) => { await ctx.exec(['sleep', '60'], { name: 'poc', timeoutMs: 1500 }); }]);
  assert.ok(Date.now() - started < 30000);
  await expectAbstain(env, r, 'step_timeout', 'poc');
});

test('deadline: the container is killed at the deadline and the run abstains', { timeout: 120000 }, async (t) => {
  const env = await setup(t);
  // Time already spent before the steps (fetch, pull) can leave less than
  // runSeconds; admission is skipped here to model exactly that.
  const started = Date.now();
  let launchedAt = null;
  const r = await run(env, [async (ctx) => {
    launchedAt = Date.now();
    await ctx.exec(['sleep', '60'], { name: 'poc', timeoutMs: 60000 });
  }], { deadlineMs: 8000, admit: noAdmission });
  assert.ok(launchedAt, 'the step started');
  assert.ok(Date.now() - started < 8000 + 15000, `took ${Date.now() - started} ms`);
  await expectAbstain(env, r, 'deadline', 'poc');
});

test('OOM: a step past the memory limit abstains', { timeout: 120000 }, async (t) => {
  const env = await setup(t);
  const r = await run(env, [async (ctx) => {
    await ctx.exec(['dd', 'if=/dev/zero', 'of=/dev/null', 'bs=768M', 'count=1'], { name: 'hog', timeoutMs: 60000 });
  }], { limits: { memoryMb: 256 } });
  await expectAbstain(env, r, 'oom', 'hog');
});

test('pids limit: a fork storm past --pids-limit abstains', { timeout: 120000 }, async (t) => {
  const env = await setup(t);
  const r = await run(env, [async (ctx) => {
    await ctx.exec(['sh', '-c', 'i=0; while [ $i -lt 1500 ]; do sleep 30 & i=$((i+1)); done; wait'], { name: 'storm', timeoutMs: 60000 });
  }], { limits: { pids: 256 } });
  await expectAbstain(env, r, 'pids_limit', 'storm');
});

test('dead sandbox: the container dies under a running step', { timeout: 120000 }, async (t) => {
  const env = await setup(t);
  const r = await run(env, [async (ctx) => {
    setTimeout(() => { runText(env.docker, ['kill', ctx.sandboxName], { timeoutMs: 30000 }); }, 1500);
    await ctx.exec(['sleep', '60'], { name: 'poc', timeoutMs: 60000 });
  }]);
  await expectAbstain(env, r, 'sandbox_died', 'poc');
});

test('a process killed by a signal is not a clean exit', { timeout: 120000 }, async (t) => {
  const env = await setup(t);
  const r = await run(env, [async (ctx) => { await ctx.exec(['sh', '-c', 'kill -SEGV $$'], { name: 'crash', timeoutMs: 30000 }); }]);
  await expectAbstain(env, r, 'killed_by_signal', 'crash');
  assert.match(r.abstain.detail, /SIGSEGV/);
});

test('Docker unreachable: abstains before anything starts', { timeout: 60000 }, async (t) => {
  const env = await setup(t);
  const dead = createDocker({ dockerHost: 'unix:///nonexistent/verdikta-code-runner/docker.sock', dockerConfigDir: env.config.dockerConfigDir, baseEnv: process.env });
  const r = await run({ config: env.config, docker: dead }, [async (ctx) => { await ctx.exec(['true'], { name: 'never' }); }]);
  await expectAbstain(env, r, 'docker_unreachable');
});

test('refused admission: the maintenance lock, and a deadline shorter than runSeconds', { timeout: 60000 }, async (t) => {
  const env = await setup(t);
  fs.mkdirSync(path.dirname(env.config.maintenanceFile), { recursive: true });
  fs.writeFileSync(env.config.maintenanceFile, '');
  const locked = await run(env, [async (ctx) => { await ctx.exec(['true'], { name: 'never' }); }]);
  await expectAbstain(env, locked, 'admission_refused');
  assert.match(locked.abstain.detail, /maintenance/);
  fs.rmSync(env.config.maintenanceFile);
  const late = await run(env, [async (ctx) => { await ctx.exec(['true'], { name: 'never' }); }], { deadlineMs: 5000, limits: { runSeconds: 60 } });
  await expectAbstain(env, late, 'admission_refused');
  assert.match(late.abstain.detail, /deadline/);
});

test('an image that is not on the runner\'s disk is never pulled implicitly', { timeout: 60000 }, async (t) => {
  const env = await setup(t);
  const r = await run(env, [], { image: `ubuntu@sha256:${'0'.repeat(64)}` });
  await expectAbstain(env, r, 'image_unavailable', 'launch');
});

test('cancellation: the caller going away kills the container', { timeout: 120000 }, async (t) => {
  const env = await setup(t);
  const ac = new AbortController();
  const r = await run(env, [async (ctx) => {
    setTimeout(() => ac.abort(), 1500);
    await ctx.exec(['sleep', '60'], { name: 'poc', timeoutMs: 60000 });
  }], { signal: ac.signal });
  await expectAbstain(env, r, 'cancelled', 'poc');
});
