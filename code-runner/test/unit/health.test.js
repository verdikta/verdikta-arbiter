'use strict';

// Acceptance: GET /health (version, runtime runsc|runc, Docker reachability,
// free data-root bytes).

const test = require('node:test');
const assert = require('node:assert/strict');
const { health, describeEndpoint } = require('../../src/health');
const { fakeDocker, healthyDaemon, healthyInfo } = require('../helpers/fakeDocker');
const { testConfig } = require('../helpers/http');

test('reports the runtime the daemon has registered, with its arguments', async () => {
  const config = testConfig({ CODE_RUNNER_RUNTIME: 'runsc' });
  const h = await health({ config, docker: fakeDocker(healthyDaemon()), statfs: async () => ({ bavail: 10, bsize: 1000 }) });
  assert.equal(h.ok, true);
  assert.equal(h.runtime, 'runsc');
  assert.equal(h.runtimeAvailable, true);
  assert.deepEqual(h.runtimeArgs, ['--platform=systrap']);
  assert.equal(h.dataRoot.freeBytes, 10000);
});

test('a configured runtime the daemon lacks makes the runner unhealthy', async () => {
  const config = testConfig({ CODE_RUNNER_RUNTIME: 'runsc' });
  const docker = fakeDocker(healthyDaemon({ info: () => ({ stdout: healthyInfo({ Runtimes: { runc: {} } }) }) }));
  const h = await health({ config, docker, statfs: async () => ({ bavail: 1, bsize: 1 }) });
  assert.equal(h.ok, false);
  assert.equal(h.runtimeAvailable, false);
  assert.ok(h.reasons.some((r) => /runsc/.test(r)));
});

test('CODE_RUNNER_DATA_ROOT overrides the daemon\'s path; an unreadable path reports null, not an error', async () => {
  const config = testConfig({ CODE_RUNNER_DATA_ROOT: '/srv/code-runner/docker' });
  const seen = [];
  const h = await health({ config, docker: fakeDocker(healthyDaemon()), statfs: async (p) => { seen.push(p); return { bavail: 2, bsize: 512 }; } });
  assert.deepEqual(seen, ['/srv/code-runner/docker']);
  assert.equal(h.dataRoot.path, '/srv/code-runner/docker');
  assert.equal(h.dataRoot.freeBytes, 1024);
  const mac = await health({ config: testConfig(), docker: fakeDocker(healthyDaemon()), statfs: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } });
  assert.equal(mac.dataRoot.freeBytes, null);
  assert.match(mac.dataRoot.error, /ENOENT/);
  assert.equal(mac.ok, true, 'the data root inside a Docker Desktop VM is not readable from macOS; that alone is not unhealthy');
});

test('the endpoint is described without credentials', () => {
  assert.equal(describeEndpoint(null), 'default');
  assert.equal(describeEndpoint('unix:///run/verdikta-code-runner/docker.sock'), 'unix:///run/verdikta-code-runner/docker.sock');
  assert.equal(describeEndpoint('tcp://user:pass@10.0.0.2:2376'), 'tcp://10.0.0.2:2376');
  assert.equal(describeEndpoint('ssh://arbiter@10.0.0.2'), 'ssh://10.0.0.2');
});
