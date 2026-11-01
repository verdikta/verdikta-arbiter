'use strict';

// Acceptance: a Node service on 127.0.0.1 or a Unix socket with a shared
// bearer token; refuses other binds unless configured; holds no secrets.
// Acceptance: the Docker endpoint comes from config (DOCKER_HOST).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadConfig, ConfigError, isLoopbackHost, secretLookingEnv } = require('../../src/config');

const TOKEN = 't'.repeat(40);
const ROOT = '/opt/verdikta/code-runner';

function load(env, opts = {}) {
  return loadConfig({ CODE_RUNNER_TOKEN: TOKEN, ...env }, { root: ROOT, ...opts });
}

function problems(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err && err.stack}`);
    return err.problems.join('\n');
  }
  assert.fail('expected a ConfigError');
}

test('defaults: 127.0.0.1:8090, runtime runsc, Docker default endpoint', () => {
  const c = load({});
  assert.deepEqual(c.listen, { host: '127.0.0.1', port: 8090 });
  assert.equal(c.runtime, 'runsc');
  assert.equal(c.dockerHost, null);
  assert.equal(c.token, TOKEN);
  assert.equal(c.instance, 'default');
  assert.equal(c.maintenanceFile, path.join(ROOT, '.state', 'maintenance'));
  assert.equal(c.dockerConfigDir, path.join(ROOT, '.state', 'docker-config'));
});

test('loopback hosts are accepted', () => {
  for (const host of ['127.0.0.1', '127.0.0.53', '::1']) {
    assert.equal(load({ CODE_RUNNER_HOST: host }).listen.host, host);
  }
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
});

test('any other bind is refused unless CODE_RUNNER_ALLOW_REMOTE_BIND=true', () => {
  for (const host of ['0.0.0.0', '::', '10.0.0.5', '192.168.1.2', 'localhost', 'example.com', '127.0.0.256', '']) {
    assert.equal(isLoopbackHost(host), false, host);
    if (host === '') continue;
    assert.match(problems(() => load({ CODE_RUNNER_HOST: host })), /not a loopback address/);
  }
  const c = load({ CODE_RUNNER_HOST: '10.0.0.5', CODE_RUNNER_ALLOW_REMOTE_BIND: 'true' });
  assert.deepEqual(c.listen, { host: '10.0.0.5', port: 8090 });
  // Only the exact value "true" opens it.
  assert.match(problems(() => load({ CODE_RUNNER_HOST: '0.0.0.0', CODE_RUNNER_ALLOW_REMOTE_BIND: '1' })), /loopback/);
});

test('a Unix socket replaces the TCP listener and must be an absolute path', () => {
  const c = load({ CODE_RUNNER_SOCKET: '/run/verdikta-code-runner/runner.sock' });
  assert.deepEqual(c.listen, { socket: '/run/verdikta-code-runner/runner.sock' });
  assert.match(problems(() => load({ CODE_RUNNER_SOCKET: 'runner.sock' })), /absolute path/);
  assert.match(problems(() => load({ CODE_RUNNER_SOCKET: '/run/x.sock', CODE_RUNNER_HOST: '127.0.0.1' })), /either/);
});

test('the port must be a TCP port number', () => {
  assert.equal(load({ CODE_RUNNER_PORT: '9000' }).listen.port, 9000);
  for (const port of ['0', '70000', 'abc', '80.5']) {
    assert.match(problems(() => load({ CODE_RUNNER_PORT: port })), /CODE_RUNNER_PORT/);
  }
});

test('a shared bearer token is required, at least 32 printable characters', () => {
  assert.match(problems(() => loadConfig({}, { root: ROOT })), /CODE_RUNNER_TOKEN/);
  assert.match(problems(() => load({ CODE_RUNNER_TOKEN: 'short' })), /at least 32/);
  assert.match(problems(() => load({ CODE_RUNNER_TOKEN: `${'x'.repeat(32)} y` })), /printable/);
});

test('the token can come from a file instead, but not from both', () => {
  const files = { '/etc/verdikta/runner.token': `${TOKEN}\n` };
  const readFile = (p) => {
    if (!(p in files)) throw new Error('ENOENT');
    return files[p];
  };
  const c = loadConfig({ CODE_RUNNER_TOKEN_FILE: '/etc/verdikta/runner.token' }, { root: ROOT, readFile });
  assert.equal(c.token, TOKEN);
  assert.match(
    problems(() => loadConfig({ CODE_RUNNER_TOKEN: TOKEN, CODE_RUNNER_TOKEN_FILE: '/etc/verdikta/runner.token' }, { root: ROOT, readFile })),
    /not both/
  );
  assert.match(problems(() => loadConfig({ CODE_RUNNER_TOKEN_FILE: '/nope' }, { root: ROOT, readFile })), /cannot read/);
});

test('the runtime is runsc or runc and nothing else', () => {
  assert.equal(load({ CODE_RUNNER_RUNTIME: 'runc' }).runtime, 'runc');
  for (const rt of ['kata', 'runsc --debug', 'io.containerd.runc.v2']) {
    assert.match(problems(() => load({ CODE_RUNNER_RUNTIME: rt })), /CODE_RUNNER_RUNTIME/);
  }
});

test('the Docker endpoint is DOCKER_HOST from the config', () => {
  assert.equal(load({ DOCKER_HOST: 'unix:///run/verdikta-code-runner/docker.sock' }).dockerHost,
    'unix:///run/verdikta-code-runner/docker.sock');
});

test('holds no secrets: refuses to start when its environment carries a credential', () => {
  const env = { OPENAI_API_KEY: 'sk-x', IPFS_PINNING_KEY: 'eyJ.x.y', PRIVATE_KEY: '0xabc', GITHUB_TOKEN: 'ghp', PATH: '/bin' };
  assert.deepEqual(secretLookingEnv({ ...env, CODE_RUNNER_TOKEN: TOKEN }).sort(),
    ['GITHUB_TOKEN', 'IPFS_PINNING_KEY', 'OPENAI_API_KEY', 'PRIVATE_KEY']);
  const msg = problems(() => load(env));
  assert.match(msg, /OPENAI_API_KEY/);
  assert.match(msg, /holds no secrets/);
  // Names only: a value never appears in the message.
  assert.doesNotMatch(msg, /sk-x|eyJ|0xabc|ghp/);
  // Empty values and the runner's own token are fine.
  assert.doesNotThrow(() => load({ OPENAI_API_KEY: '' }));
});

test('the instance label is a short slug', () => {
  assert.equal(load({ CODE_RUNNER_INSTANCE: 'canary-1' }).instance, 'canary-1');
  assert.match(problems(() => load({ CODE_RUNNER_INSTANCE: 'Bad Name' })), /CODE_RUNNER_INSTANCE/);
});

test('the platform is linux/amd64; linux/arm64 only for runc development', () => {
  assert.equal(load({}).platform, 'linux/amd64');
  assert.equal(load({ CODE_RUNNER_RUNTIME: 'runc', CODE_RUNNER_PLATFORM: 'linux/arm64' }).platform, 'linux/arm64');
  assert.match(problems(() => load({ CODE_RUNNER_PLATFORM: 'linux/arm64' })), /runc/);
  assert.match(problems(() => load({ CODE_RUNNER_RUNTIME: 'runc', CODE_RUNNER_PLATFORM: 'linux/386' })), /CODE_RUNNER_PLATFORM/);
});
