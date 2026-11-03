'use strict';

// Node A3b, R4: the runtime in the report is measured, never copied from the
// pin. `runsc --version` of the binary the daemon names; anything but common's
// pin refuses the run. CI runs the same release (it ran another until this node).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codeReview } = require('@verdikta/common');
const { measureRuntime, parseRunscVersion } = require('../../src/runtime');
const { createDocker } = require('../../src/docker');
const { executeRun } = require('../../src/pipeline');
const { health } = require('../../src/health');
const { fakeDocker, healthyDaemon, healthyInfo } = require('../helpers/fakeDocker');
const { testConfig } = require('../helpers/http');

const PINNED = codeReview.GVISOR_RELEASE;
const runsc = () => testConfig({ CODE_RUNNER_RUNTIME: 'runsc' });
const LIMITS = { cpus: 1, memoryMb: 256, pids: 256, buildSeconds: 30, testSeconds: 30, runSeconds: 60, maxPatchBytes: 1, patchExpansionBytes: 1, platform: 'linux/amd64' };
const silent = { info() {}, warn() {}, error() {}, debug() {} };

function withVersion(output, { exitCode = 0, spawnError = null, runtimes } = {}) {
  const docker = fakeDocker(healthyDaemon(runtimes ? { info: () => ({ stdout: healthyInfo({ Runtimes: runtimes }) }) } : {}));
  const asked = [];
  docker.runtimeVersion = async (p) => {
    asked.push(p);
    return { exitCode, stdout: output, stderr: '', spawnError };
  };
  docker.asked = asked;
  return docker;
}

test('parseRunscVersion reads the release from what runsc --version prints, and nothing else', () => {
  assert.equal(parseRunscVersion('runsc version release-20260928.0\nspec: 1.2.1\n'), 'release-20260928.0');
  for (const bad of ['', 'runsc version 0.0.0', 'release-20260928.0', 'runsc version release-2026.0\n', 'something runsc version release-20260928.0\n']) {
    assert.equal(parseRunscVersion(bad), null, bad);
  }
});

test('under runsc the release comes from the binary the daemon names', async () => {
  const docker = withVersion(`runsc version ${PINNED}\nspec: 1.2.1\n`);
  const m = await measureRuntime({ config: runsc(), docker });
  assert.deepEqual(m, { gvisor: PINNED, pinned: true, error: null });
  assert.deepEqual(docker.asked, ['/opt/gvisor/runsc']);
});

test('under runc the runtime is runc, and nothing is run', async () => {
  const docker = withVersion('never');
  const m = await measureRuntime({ config: testConfig({ CODE_RUNNER_RUNTIME: 'runc' }), docker });
  assert.deepEqual(m, { gvisor: 'runc', pinned: false, error: null });
  assert.deepEqual(docker.asked, []);
});

test('a release other than common\'s pin is what is measured, and it is not pinned', async () => {
  const m = await measureRuntime({ config: runsc(), docker: withVersion('runsc version release-20260928.0\n') });
  assert.equal(m.gvisor, 'release-20260928.0');
  assert.equal(m.pinned, false);
});

test('what cannot be measured is an error: a relative path, a failed binary, unreadable output, no runtime', async () => {
  const cases = [
    withVersion('x', { runtimes: { runsc: { path: 'runsc' } } }),
    withVersion('', { exitCode: 1 }),
    withVersion('', { spawnError: 'ENOENT' }),
    withVersion('not a version\n'),
    withVersion('x', { runtimes: { runc: { path: 'runc' } } })
  ];
  for (const docker of cases) {
    const m = await measureRuntime({ config: runsc(), docker });
    assert.equal(m.gvisor, null);
    assert.equal(m.pinned, false);
    assert.ok(m.error);
  }
  assert.deepEqual(cases[0].asked, [], 'a relative path could resolve to another binary than the daemon\'s');
});

async function runUnder(docker) {
  const receivedAt = Date.now();
  return executeRun({
    docker, config: runsc(), limits: LIMITS, image: 'x@sha256:' + 'a'.repeat(64), runId: '0123456789abcdef',
    steps: [], receivedAt, deadlineAt: receivedAt + 300000, active: new Set(), log: silent, admit: async () => {}
  });
}

test('R4: a run under runsc on anything but the pinned release abstains at admission, before any sandbox', async () => {
  const docker = withVersion('runsc version release-20260928.0\n');
  const r = await runUnder(docker);
  assert.equal(r.outcome, 'abstain');
  assert.equal(r.abstain.cause, 'admission_refused');
  assert.match(r.abstain.detail, new RegExp(`release-20260928\\.0.*${PINNED.replace('.', '\\.')}`));
  assert.equal(docker.callsOf('create').length, 0);
});

test('R4: a run under runsc whose release cannot be measured abstains too', async () => {
  const r = await runUnder(withVersion('', { exitCode: 127 }));
  assert.equal(r.outcome, 'abstain');
  assert.equal(r.abstain.cause, 'admission_refused');
});

test('R4: on the pinned release the run goes on and its result names what was measured', async () => {
  const r = await runUnder(withVersion(`runsc version ${PINNED}\n`));
  assert.equal(r.outcome, 'definitive', JSON.stringify(r.abstain));
  assert.equal(r.gvisor, PINNED);
});

test('/health is not ok on another release, and says which', async () => {
  const h = await health({ config: runsc(), docker: withVersion('runsc version release-20260928.0\n'), statfs: async () => ({ bavail: 1, bsize: 1 }), exists: () => false });
  assert.equal(h.ok, false);
  assert.ok(h.reasons.some((x) => x.includes('release-20260928.0') && x.includes(PINNED)), JSON.stringify(h.reasons));
  assert.equal(h.gvisor, 'release-20260928.0');
  assert.equal(h.gvisorPinned, PINNED);
  const good = await health({ config: runsc(), docker: withVersion(`runsc version ${PINNED}\n`), statfs: async () => ({ bavail: 1, bsize: 1 }), exists: () => false });
  assert.equal(good.ok, true, JSON.stringify(good.reasons));
});

test('docker.runtimeVersion runs the binary with --version, no shell and an empty environment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-runsc-'));
  const bin = path.join(dir, 'runsc');
  fs.writeFileSync(bin, '#!/bin/sh\nprintf "runsc version release-20260921.0 %s %s\\n" "$1" "${SECRET_THING:-noenv}"\n', { mode: 0o755 });
  process.env.SECRET_THING = 'leak';
  try {
    const r = await createDocker({ dockerConfigDir: dir }).runtimeVersion(bin);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, 'runsc version release-20260921.0 --version noenv\n');
  } finally {
    delete process.env.SECRET_THING;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CI installs the gVisor release common pins, so the Docker suite\'s reports carry it', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'code-runner.yml'), 'utf8');
  const m = /GVISOR_VERSION: '([0-9]{8}\.[0-9]+)'/.exec(workflow);
  assert.ok(m, 'the workflow names its release');
  assert.equal(`release-${m[1]}`, PINNED);
});

test('the README and its example name the pinned release', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');
  assert.ok(readme.includes(PINNED.replace('release-', '')), 'the runtime entry in the README');
  assert.ok(!readme.includes('20260928'), 'and not the release CI used to run');
});
