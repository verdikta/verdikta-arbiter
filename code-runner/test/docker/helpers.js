'use strict';

/**
 * Shared setup for the tests that need a real Docker daemon. The runtime under
 * test is CODE_RUNNER_RUNTIME (runc by default: macOS dev; CI runs the suite
 * once under runc and once under runsc). Every test uses its own instance
 * label, removes what it started, and checks that nothing is left.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createDocker, runText } = require('../../src/docker');
const { testConfig } = require('../helpers/http');
const { psArgs } = require('../../src/gc');

const RUNTIME = process.env.CODE_RUNNER_RUNTIME || 'runc';

/** ubuntu:24.04, the multi-arch index, pinned by digest. Test fixture only. */
const TEST_IMAGE = 'ubuntu@sha256:69cecf4bbf72d2d44a9eef1b71fb98c7fb973d78af11399deccef19beb008ad9';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function instanceId() {
  return `t${crypto.randomBytes(5).toString('hex')}`;
}

function dockerTestConfig(env = {}) {
  const config = testConfig({ CODE_RUNNER_RUNTIME: RUNTIME, CODE_RUNNER_INSTANCE: instanceId(), ...env });
  config.dockerHost = env.DOCKER_HOST !== undefined ? env.DOCKER_HOST : (process.env.DOCKER_HOST || null);
  return config;
}

function dockerFor(config) {
  fs.mkdirSync(config.dockerConfigDir, { recursive: true, mode: 0o700 });
  return createDocker({ dockerHost: config.dockerHost, dockerConfigDir: config.dockerConfigDir, baseEnv: process.env });
}

let pulled = false;
async function ensureTestImage(docker) {
  if (pulled) return;
  const have = await runText(docker, ['image', 'inspect', '--format', '{{.Id}}', TEST_IMAGE], { timeoutMs: 30000 });
  if (have.exitCode !== 0) {
    const pull = await runText(docker, ['pull', TEST_IMAGE], { timeoutMs: 300000 });
    assert.equal(pull.exitCode, 0, `docker pull ${TEST_IMAGE}: ${pull.stderr}`);
  }
  pulled = true;
}

async function leftovers(docker, instance) {
  const r = await runText(docker, psArgs(instance), { timeoutMs: 30000 });
  assert.equal(r.exitCode, 0, r.stderr);
  return r.stdout.split('\n').map((l) => l.split('\t')[0]).filter(Boolean);
}

async function removeAll(docker, instance) {
  const names = await leftovers(docker, instance);
  if (names.length) await runText(docker, ['rm', '--force', ...names], { timeoutMs: 60000 });
}

/** Waits until `fn()` is true, polling; returns its last value. */
async function eventually(fn, { timeoutMs = 15000, everyMs = 200 } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return last;
}

/** Limits small enough for the abstain tests; runArgs still checks them. */
function smallLimits(over = {}) {
  return {
    cpus: 1, memoryMb: 512, pids: 512, buildSeconds: 30, testSeconds: 60, runSeconds: 60,
    maxPatchBytes: 2000000, patchExpansionBytes: 50000000, platform: 'linux/amd64', ...over
  };
}

module.exports = {
  RUNTIME, TEST_IMAGE, silent, instanceId, dockerTestConfig, dockerFor, ensureTestImage, leftovers, removeAll, eventually, smallLimits
};
