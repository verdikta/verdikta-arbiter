'use strict';

// Acceptance: GC of labelled leftovers. A container a crashed run left behind
// is removed; another instance's container and unlabelled containers are not.

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectLeftovers } = require('../../src/gc');
const { createArgs, startArgs } = require('../../src/sandbox');
const { runText } = require('../../src/docker');
const { RUNTIME, PLATFORM, TEST_IMAGE, dockerTestConfig, dockerFor, ensureTestImage, leftovers, removeAll, instanceId } = require('./helpers');

async function launch(docker, instance, runId) {
  const now = Math.floor(Date.now() / 1000);
  const name = `vcr-${runId}-1`;
  const created = await runText(docker, createArgs({
    name, image: TEST_IMAGE, runtime: RUNTIME, platform: PLATFORM, limits: { cpus: 1, memoryMb: 256, pids: 256 },
    instance, runId, expiresAt: now + 600, keepaliveSeconds: 600
  }), { timeoutMs: 120000 });
  if (created.exitCode !== 0) return created;
  return runText(docker, startArgs(name), { timeoutMs: 120000 });
}

test('GC removes a crashed run\'s container and nothing that is not its own', { timeout: 180000 }, async (t) => {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  const other = instanceId();
  const plain = `vcr-gc-plain-${instanceId()}`;
  t.after(async () => {
    await removeAll(docker, config.instance).catch(() => {});
    await removeAll(docker, other).catch(() => {});
    await runText(docker, ['rm', '--force', plain], { timeoutMs: 60000 });
  });
  await ensureTestImage(docker);

  const mine = await launch(docker, config.instance, 'c0c0c0c0c0c0c0c0');
  assert.equal(mine.exitCode, 0, mine.stderr);
  const theirs = await launch(docker, other, 'd0d0d0d0d0d0d0d0');
  assert.equal(theirs.exitCode, 0, theirs.stderr);
  const unlabelled = await runText(docker, ['run', '--detach', '--pull', 'never', '--platform', PLATFORM, '--name', plain, '--network', 'none', '--entrypoint', 'sleep', TEST_IMAGE, '600'], { timeoutMs: 120000 });
  assert.equal(unlabelled.exitCode, 0, unlabelled.stderr);

  // A live run's container is left alone.
  const kept = await collectLeftovers({ docker, instance: config.instance, active: new Set(['vcr-c0c0c0c0c0c0c0c0-1']), now: Math.floor(Date.now() / 1000) });
  assert.deepEqual(kept.removed, []);
  assert.deepEqual(await leftovers(docker, config.instance), ['vcr-c0c0c0c0c0c0c0c0-1']);

  // Once no run owns it, it goes.
  const swept = await collectLeftovers({ docker, instance: config.instance, active: new Set(), now: Math.floor(Date.now() / 1000) });
  assert.deepEqual(swept.removed, ['vcr-c0c0c0c0c0c0c0c0-1']);
  assert.deepEqual(await leftovers(docker, config.instance), []);
  assert.deepEqual(await leftovers(docker, other), ['vcr-d0d0d0d0d0d0d0d0-1']);
  const stillThere = await runText(docker, ['inspect', '--format', '{{.State.Running}}', plain], { timeoutMs: 30000 });
  assert.equal(stillThere.stdout.trim(), 'true');
});
