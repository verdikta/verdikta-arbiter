'use strict';

// Acceptance: containers are driven with argv arrays only (no shell); the
// Docker endpoint comes from config (DOCKER_HOST); the runner holds no
// secrets (nothing from its environment but the allow-list reaches Docker);
// every command is bounded and its output read through a cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDocker, runText, isUnreachableText, dockerChildEnv } = require('../../src/docker');
const { HeadTail } = require('../../src/capture');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-docker.js');
fs.chmodSync(FAKE, 0o755);

const BASE_ENV = {
  PATH: process.env.PATH,
  HOME: '/home/arbiter',
  CODE_RUNNER_TOKEN: 'secret-token-value-that-must-not-leak-xxxxxxxx',
  OPENAI_API_KEY: 'sk-must-not-leak',
  DOCKER_HOST: 'unix:///from/the/ambient/env.sock',
  NODE_OPTIONS: '--require /tmp/evil.js',
  FOO: 'bar'
};

function docker(opts = {}) {
  return createDocker({ bin: FAKE, baseEnv: BASE_ENV, dockerConfigDir: '/opt/code-runner/.state/docker-config', ...opts });
}

test('argv reaches the binary verbatim, with no shell in between', async () => {
  const args = ['echo-env', 'a b', '$(touch /tmp/pwned)', ';', '|', '&&', '`id`', '*'];
  const r = await runText(docker(), args);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(JSON.parse(r.stdout).argv, args);
});

test('the child environment is an allow-list: no token, no keys, no NODE_OPTIONS', async () => {
  const r = await runText(docker({ dockerHost: 'unix:///run/verdikta-code-runner/docker.sock' }), ['echo-env']);
  const env = JSON.parse(r.stdout).env;
  assert.deepEqual(Object.keys(env).sort(), ['DOCKER_CONFIG', 'DOCKER_HOST', 'HOME', 'PATH']);
  assert.equal(env.DOCKER_HOST, 'unix:///run/verdikta-code-runner/docker.sock');
  assert.equal(env.DOCKER_CONFIG, '/opt/code-runner/.state/docker-config');
  assert.ok(!r.stdout.includes('must-not-leak'));
});

test('DOCKER_HOST is the configured one, never the ambient one', async () => {
  const r = await runText(docker({ dockerHost: null }), ['echo-env']);
  assert.equal(JSON.parse(r.stdout).env.DOCKER_HOST, undefined);
  assert.deepEqual(Object.keys(dockerChildEnv({ baseEnv: BASE_ENV, dockerHost: null, dockerConfigDir: '/x' })).sort(),
    ['DOCKER_CONFIG', 'HOME', 'PATH']);
  const tls = dockerChildEnv({ baseEnv: { ...BASE_ENV, DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/certs' }, dockerHost: 'tcp://10.0.0.2:2376', dockerConfigDir: '/x' });
  assert.equal(tls.DOCKER_TLS_VERIFY, '1');
  assert.equal(tls.DOCKER_CERT_PATH, '/certs');
});

test('a command past its timeout is killed', async () => {
  const started = Date.now();
  const r = await docker().run(['sleep', '20'], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
  assert.ok(Date.now() - started < 5000);
});

test('an abort signal kills the command', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort('deadline'), 200);
  const r = await docker().run(['sleep', '20'], { signal: ac.signal });
  assert.equal(r.aborted, true);
  assert.equal(r.timedOut, false);
});

test('output streams through a bounded sink, never into an unbounded buffer', async () => {
  const sink = new HeadTail();
  const r = await docker().run(['spew', String(3 * 1024 * 1024)], { stdout: sink });
  assert.equal(r.exitCode, 0);
  const snap = sink.snapshot();
  assert.equal(snap.totalBytes, 3 * 1024 * 1024);
  assert.equal(snap.head.length + snap.tail.length, 64 * 1024);
  assert.equal(snap.omittedBytes, 3 * 1024 * 1024 - 64 * 1024);
});

test('runText caps what it keeps', async () => {
  const r = await runText(docker(), ['spew', '200000'], { maxBytes: 1000 });
  assert.equal(r.stdout.length, 1000);
  assert.equal(r.stdoutOverLimit, true);
});

test('stdin bytes are handed to the command unchanged', async () => {
  const bytes = crypto.randomBytes(300000);
  const r = await runText(docker(), ['stdin'], { stdin: bytes });
  assert.equal(r.stdout, `${bytes.length} ${crypto.createHash('sha256').update(bytes).digest('hex')}`);
});

test('a missing docker binary is a spawn error, not an exit code', async () => {
  const r = await createDocker({ bin: '/nonexistent/docker', baseEnv: BASE_ENV, dockerConfigDir: '/x' }).run(['version']);
  assert.ok(r.spawnError);
  assert.equal(r.exitCode, null);
});

test('exit codes and stderr come back as they are', async () => {
  const r = await runText(docker(), ['fail', '3', 'boom']);
  assert.equal(r.exitCode, 3);
  assert.equal(r.stderr, 'boom');
});

test('unreachable-daemon messages are recognised', () => {
  assert.equal(isUnreachableText('Cannot connect to the Docker daemon at unix:///x.sock. Is the docker daemon running?'), true);
  assert.equal(isUnreachableText('error during connect: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/info": dial unix /var/run/docker.sock: connect: no such file or directory'), true);
  assert.equal(isUnreachableText('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock'), true);
  assert.equal(isUnreachableText('Error response from daemon: No such container: x'), false);
  assert.equal(isUnreachableText(''), false);
});
