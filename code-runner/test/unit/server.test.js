'use strict';

// Acceptance: a Node service on 127.0.0.1 or a Unix socket with a shared
// bearer token; refuses other binds unless configured.
// Acceptance: GET /health (version, runtime, Docker reachability, free
// data-root bytes); POST /v1/runs validates the full request.
// Acceptance: class hard limits are applied whatever the spec says; a spec
// above them is a requester error before any work.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../../src/server');
const { RUNNER_VERSION } = require('../../src/version');
const { fakeDocker, healthyDaemon } = require('../helpers/fakeDocker');
const { testConfig, request, TOKEN } = require('../helpers/http');
const { runRequest, spec } = require('../helpers/requests');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const statfs = async () => ({ bavail: 1000, bsize: 4096 });

async function start({ docker = fakeDocker(healthyDaemon()), config = testConfig(), stepsFor } = {}) {
  const runner = createServer({ config, docker, log: silent, statfs, stepsFor });
  const address = await runner.listen();
  const target = address.socketPath ? { socketPath: address.socketPath } : { host: address.host, port: address.port };
  return { runner, target, docker, config };
}

test('every route needs the bearer token; nothing reaches Docker without it', async (t) => {
  const { runner, target, docker } = await start();
  t.after(() => runner.close());
  const routes = [['GET', '/health'], ['POST', '/v1/runs'], ['GET', '/nope']];
  const badTokens = [null, 'wrong-token'.padEnd(48, 'y'), TOKEN.slice(0, -1)];
  for (const [method, urlPath] of routes) {
    for (const token of badTokens) {
      const res = await request(target, { method, path: urlPath, token, body: method === 'POST' ? runRequest() : undefined });
      assert.equal(res.status, 401, `${method} ${urlPath} token=${token}`);
      assert.equal(res.headers['www-authenticate'], 'Bearer');
    }
    // A scheme other than Bearer is refused too.
    const basic = await request(target, { method, path: urlPath, token: null, headers: { authorization: `Basic ${TOKEN}` } });
    assert.equal(basic.status, 401);
  }
  assert.equal(docker.calls.length, 0);
});

test('GET /health reports version, runtime, Docker reachability and free data-root bytes', async (t) => {
  const { runner, target } = await start();
  t.after(() => runner.close());
  const res = await request(target, { path: '/health' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.service, 'verdikta-code-runner');
  assert.equal(res.body.version, RUNNER_VERSION);
  assert.equal(res.body.runtime, 'runc');
  assert.equal(res.body.runtimeAvailable, true);
  assert.equal(res.body.docker.reachable, true);
  assert.equal(res.body.docker.serverVersion, '28.0.4');
  assert.equal(res.body.dataRoot.path, '/var/lib/docker');
  assert.equal(res.body.dataRoot.freeBytes, 4096000);
  assert.equal(res.body.maintenance, false);
  assert.equal(res.body.limits.cpus, 2);
});

test('GET /health is 503 when Docker is unreachable', async (t) => {
  const docker = fakeDocker(healthyDaemon({
    info: () => ({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon at unix:///nope.sock. Is the docker daemon running?' })
  }));
  const { runner, target } = await start({ docker });
  t.after(() => runner.close());
  const res = await request(target, { path: '/health' });
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.docker.reachable, false);
  assert.equal(res.body.dataRoot.freeBytes, null);
});

test('POST /v1/runs accepts the full request and answers with a definitive result', async (t) => {
  const { runner, target, docker } = await start();
  t.after(() => runner.close());
  const res = await request(target, { method: 'POST', path: '/v1/runs', body: runRequest() });
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.outcome, 'definitive');
  assert.match(res.body.runId, /^[0-9a-f]{16}$/);
  assert.equal(res.body.runner.version, RUNNER_VERSION);
  assert.equal(res.body.runner.runtime, 'runc');
  assert.equal(res.body.abstain, null);
  assert.deepEqual(res.body.steps, []);
  assert.equal(res.body.report, null);
  assert.equal(res.body.reportSha256, null);
  assert.equal(res.body.contextPack, null);
  assert.deepEqual(res.body.limits, {
    cpus: 2, memoryMb: 4096, pids: 4096, buildSeconds: 90, testSeconds: 180, runSeconds: 360,
    maxPatchBytes: 2000000, patchExpansionBytes: 50000000, platform: 'linux/amd64'
  });
  // The sandbox was started and torn down.
  assert.ok(docker.callsOf('run').length === 1);
  assert.ok(docker.callsOf('rm').length >= 1);
});

test('POST /v1/runs: every field is required and typed', async (t) => {
  const { runner, target, docker } = await start();
  t.after(() => runner.close());
  const fields = ['listingCid', 'bcid', 'spec', 'attestation', 'pocPatch', 'baseline', 'finding', 'report',
    'knownIssues', 'priorFindings', 'eaGates', 'deadline'];
  for (const field of fields) {
    const body = runRequest();
    delete body[field];
    const res = await request(target, { method: 'POST', path: '/v1/runs', body });
    assert.equal(res.status, 400, field);
    assert.equal(res.body.outcome, 'requester_error');
    assert.ok(res.body.issues.some((i) => i.path === `/${field}`), `${field}: ${JSON.stringify(res.body.issues)}`);
  }
  const wrong = {
    listingCid: 'not-a-cid', bcid: 42, spec: [], attestation: 'x', pocPatch: '***', fixPatch: 7, baseline: null,
    finding: [], report: {}, knownIssues: {}, priorFindings: new Array(9).fill({}), eaGates: { disclosure: 'maybe' },
    deadline: 0
  };
  for (const [field, value] of Object.entries(wrong)) {
    const res = await request(target, { method: 'POST', path: '/v1/runs', body: runRequest({ [field]: value }) });
    assert.equal(res.status, 400, field);
    assert.ok(res.body.issues.some((i) => i.path.startsWith(`/${field}`)), `${field}: ${JSON.stringify(res.body.issues)}`);
  }
  const extra = await request(target, { method: 'POST', path: '/v1/runs', body: runRequest({ runtime: 'runc' }) });
  assert.equal(extra.status, 400);
  assert.ok(extra.body.issues.some((i) => i.code === 'UNKNOWN_FIELD' && i.path === '/runtime'));
  // fixPatch may be absent or null; a base64 patch is fine too.
  const noFix = runRequest();
  delete noFix.fixPatch;
  assert.equal((await request(target, { method: 'POST', path: '/v1/runs', body: noFix })).status, 200);
  const withFix = runRequest({ fixPatch: Buffer.from('diff --git a/src/A.sol b/src/A.sol\n').toString('base64') });
  assert.equal((await request(target, { method: 'POST', path: '/v1/runs', body: withFix })).status, 200);
  assert.equal(docker.callsOf('run').length, 2);
});

test('a spec above the class hard limits is a requester error before any work', async (t) => {
  const { runner, target, docker } = await start();
  t.after(() => runner.close());
  const cases = [
    [{ limits: { cpus: 64 } }, '/spec/limits/cpus', 'LIMIT_ABOVE_CLASS_MAX'],
    [{ limits: { memoryMb: 65536 } }, '/spec/limits/memoryMb', 'LIMIT_ABOVE_CLASS_MAX'],
    [{ limits: { runSeconds: 3600 } }, '/spec/limits/runSeconds', 'LIMIT_ABOVE_CLASS_MAX'],
    [{ limits: { pids: 100000 } }, '/spec/limits/pids', 'UNKNOWN_FIELD'],
    [{ env: { ...spec().env, unpackedBytes: 7000000000 } }, '/spec/env/unpackedBytes', 'IMAGE_ABOVE_CLASS_MAX'],
    [{ env: { ...spec().env, platform: 'linux/arm64' } }, '/spec/env/platform', 'PLATFORM_NOT_ALLOWED']
  ];
  for (const [over, issuePath, code] of cases) {
    const res = await request(target, { method: 'POST', path: '/v1/runs', body: runRequest({ spec: spec(over) }) });
    assert.equal(res.status, 400, issuePath);
    assert.equal(res.body.outcome, 'requester_error');
    assert.ok(res.body.issues.some((i) => i.path === issuePath && i.code === code), `${issuePath}: ${JSON.stringify(res.body.issues)}`);
  }
  assert.equal(docker.calls.length, 0, 'no Docker call before the limits pass');
});

test('the body is capped, must be JSON, and must parse', async (t) => {
  const config = testConfig();
  config.maxBodyBytes = 4096;
  const { runner, target, docker } = await start({ config });
  t.after(() => runner.close());
  const big = await request(target, { method: 'POST', path: '/v1/runs', body: runRequest({ report: 'x'.repeat(8192) }) });
  assert.equal(big.status, 413);
  const text = await request(target, { method: 'POST', path: '/v1/runs', body: 'hello', headers: { 'content-type': 'text/plain' } });
  assert.equal(text.status, 415);
  const broken = await request(target, { method: 'POST', path: '/v1/runs', body: '{"listingCid":' });
  assert.equal(broken.status, 400);
  assert.equal(broken.body.outcome, 'requester_error');
  assert.equal(docker.calls.length, 0);
});

test('unknown routes are 404 and wrong methods 405 (after auth)', async (t) => {
  const { runner, target } = await start();
  t.after(() => runner.close());
  assert.equal((await request(target, { path: '/v1/nope' })).status, 404);
  assert.equal((await request(target, { method: 'POST', path: '/health', body: {} })).status, 405);
  assert.equal((await request(target, { method: 'GET', path: '/v1/runs' })).status, 405);
});

test('listens on a Unix socket readable only by its owner', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-sock-'));
  const socketPath = path.join(dir, 'runner.sock');
  const config = testConfig({ CODE_RUNNER_SOCKET: socketPath });
  const { runner, target } = await start({ config });
  t.after(() => runner.close());
  assert.equal(target.socketPath, socketPath);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  const res = await request(target, { path: '/health' });
  assert.equal(res.status, 200);
  assert.equal((await request(target, { path: '/health', token: null })).status, 401);
});

test('listen() itself refuses a non-loopback bind the config did not allow', async () => {
  const config = testConfig();
  config.listen = { host: '0.0.0.0', port: 0 };
  const runner = createServer({ config, docker: fakeDocker(healthyDaemon()), log: silent, statfs });
  await assert.rejects(runner.listen(), /loopback/);
  config.allowRemoteBind = true;
  const allowed = createServer({ config, docker: fakeDocker(healthyDaemon()), log: silent, statfs });
  await allowed.listen();
  await allowed.close();
});

test('the maintenance lock refuses runs (503, abstain: admission_refused) and shows in /health', async (t) => {
  const config = testConfig();
  fs.mkdirSync(path.dirname(config.maintenanceFile), { recursive: true });
  fs.writeFileSync(config.maintenanceFile, 'upgrade\n');
  const { runner, target, docker } = await start({ config });
  t.after(() => runner.close());
  const res = await request(target, { method: 'POST', path: '/v1/runs', body: runRequest() });
  assert.equal(res.status, 503);
  assert.equal(res.body.outcome, 'abstain');
  assert.equal(res.body.abstain.cause, 'admission_refused');
  assert.match(res.body.abstain.detail, /maintenance/);
  assert.equal(docker.callsOf('run').length, 0);
  const health = await request(target, { path: '/health' });
  assert.equal(health.body.maintenance, true);
  assert.equal(health.status, 503);
});

test('a deadline the run cannot meet is refused at admission', async (t) => {
  const { runner, target, docker } = await start();
  t.after(() => runner.close());
  // runSeconds 360 cannot fit in 100 s.
  const res = await request(target, { method: 'POST', path: '/v1/runs', body: runRequest({ deadline: 100000 }) });
  assert.equal(res.status, 503);
  assert.equal(res.body.abstain.cause, 'admission_refused');
  assert.match(res.body.abstain.detail, /deadline/);
  assert.equal(docker.callsOf('run').length, 0);
});
