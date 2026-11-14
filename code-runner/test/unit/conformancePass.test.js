'use strict';

// The conformance pass, enforced in the runner (node A8, from a design review): with
// CODE_RUNNER_CONFORMANCE_FILE set, /health is 503 and every run is refused unless that file holds a
// pass for what is running. The threat is a mistaken or failed upgrade, and RUNNER_VERSION need not
// move with the code (it stayed 0.1.0 across every commit up to A9), so the pass names a hash of the
// installed source too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sourceSha256, expectedPass, passProblem } = require('../../src/conformance');
const { CONFORMANCE_CANARY, GVISOR_RELEASE, COMMON_VERSION } = require('../../src/common');
const { RUNNER_VERSION } = require('../../src/version');
const { Abstain, ABSTAIN } = require('../../src/result');
const { Capacity, admitRun } = require('../../src/admission');
const { health } = require('../../src/health');
const { fakeDocker, healthyDaemon } = require('../helpers/fakeDocker');
const { testConfig } = require('../helpers/http');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-pass-'));

function tree() {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'a');
  fs.writeFileSync(path.join(root, 'src', 'deep', 'b.json'), '{}');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lock":1}');
  return root;
}
const passFile = (body) => {
  const file = path.join(tmp(), 'conformance.json');
  if (body !== undefined) fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
};
const goodPass = () => ({ pass: true, ...expectedPass(), at: '2026-11-05T00:00:00Z' });

test('the source hash covers src/ and the lockfile, sorted, and nothing else', () => {
  const root = tree();
  const first = sourceSha256(root);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(sourceSha256(root), first, 'the same tree, the same hash');

  // What is outside it does not move it: an upgrade's logs, tests, an .env.
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test', 'x.js'), 'x');
  fs.writeFileSync(path.join(root, '.env'), 'A=1');
  assert.equal(sourceSha256(root), first);

  // A file's bytes, a new file, a renamed file, a nested file, the lockfile: each moves it.
  const moved = new Set([first]);
  const expectMoved = (what) => {
    const now = sourceSha256(root);
    assert.ok(!moved.has(now), what);
    moved.add(now);
  };
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'b');
  expectMoved('a changed byte');
  fs.writeFileSync(path.join(root, 'src', 'c.js'), '');
  expectMoved('a new empty file');
  fs.renameSync(path.join(root, 'src', 'c.js'), path.join(root, 'src', 'd.js'));
  expectMoved('a renamed file');
  fs.writeFileSync(path.join(root, 'src', 'deep', 'b.json'), '{"x":1}');
  expectMoved('a nested file');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lock":2}');
  expectMoved('the lockfile');
});

test('a file\'s name and bytes cannot be traded for another\'s', () => {
  const a = tree();
  const b = tree();
  fs.writeFileSync(path.join(a, 'src', 'x'), 'yz');
  fs.writeFileSync(path.join(b, 'src', 'xy'), 'z');
  assert.notEqual(sourceSha256(a), sourceSha256(b));
});

test('the pass names exactly what is running', () => {
  const e = expectedPass();
  assert.deepEqual(Object.keys(e).sort(), ['commonVersion', 'gvisor', 'reportSha256', 'runner', 'sourceSha256']);
  assert.equal(e.runner, RUNNER_VERSION);
  assert.equal(e.gvisor, GVISOR_RELEASE);
  assert.equal(e.commonVersion, COMMON_VERSION);
  assert.equal(e.reportSha256, CONFORMANCE_CANARY.reportSha256);
  assert.equal(e.sourceSha256, sourceSha256());
});

test('a good pass is no problem; missing, malformed or stale is, and each says what', () => {
  assert.equal(passProblem(passFile(goodPass())), null);
  assert.match(passProblem(passFile()), /no conformance pass/);
  assert.match(passProblem(passFile('{not json')), /no conformance pass/);
  assert.match(passProblem(passFile('[]')), /no conformance pass/);
  assert.match(passProblem(passFile('null')), /no conformance pass/);
  assert.match(passProblem(passFile({ ...goodPass(), pass: false })), /not a pass/);
  assert.match(passProblem(passFile({ ...goodPass(), pass: 'true' })), /not a pass/);
  for (const key of Object.keys(expectedPass())) {
    assert.match(passProblem(passFile({ ...goodPass(), [key]: 'something else' })), new RegExp(key), `stale ${key}`);
    const without = goodPass();
    delete without[key];
    assert.match(passProblem(passFile(without)), new RegExp(key), `missing ${key}`);
  }
});

test('the file is read on each check: a new pass counts with no restart, and a removed one fails closed', () => {
  const file = passFile();
  assert.ok(passProblem(file));
  fs.writeFileSync(file, JSON.stringify(goodPass()));
  assert.equal(passProblem(file), null);
  fs.rmSync(file);
  assert.ok(passProblem(file));
  fs.mkdirSync(file);
  assert.ok(passProblem(file), 'a directory where the file should be');
});

test('config: optional, and absolute when set', () => {
  assert.equal(testConfig().conformanceFile, null);
  assert.equal(testConfig({ CODE_RUNNER_CONFORMANCE_FILE: '/a/b.json' }).conformanceFile, '/a/b.json');
  assert.throws(() => testConfig({ CODE_RUNNER_CONFORMANCE_FILE: 'b.json' }), /CODE_RUNNER_CONFORMANCE_FILE/);
});

const statfs = async () => ({ bavail: 1e12, bsize: 1 });

test('/health: unset, no check; set, 503 with the reason until a pass stands', async () => {
  const off = await health({ config: testConfig({ CODE_RUNNER_RUNTIME: 'runc' }), docker: fakeDocker(healthyDaemon()), statfs });
  assert.equal(off.ok, true);
  assert.deepEqual(off.conformance, { required: false, problem: null, sourceSha256: sourceSha256() });

  const file = passFile();
  const config = testConfig({ CODE_RUNNER_RUNTIME: 'runc', CODE_RUNNER_CONFORMANCE_FILE: file });
  const none = await health({ config, docker: fakeDocker(healthyDaemon()), statfs });
  assert.equal(none.ok, false);
  assert.equal(none.conformance.required, true);
  assert.match(none.conformance.problem, /no conformance pass/);
  assert.ok(none.reasons.some((r) => /no conformance pass/.test(r)));

  fs.writeFileSync(file, JSON.stringify(goodPass()));
  const good = await health({ config, docker: fakeDocker(healthyDaemon()), statfs });
  assert.equal(good.ok, true);
  assert.equal(good.conformance.problem, null);

  fs.rmSync(file);
  assert.equal((await health({ config, docker: fakeDocker(healthyDaemon()), statfs })).ok, false, 'removed: fails closed');
});

const admitting = (config) => admitRun({ config, docker: fakeDocker(healthyDaemon()), limits: { memoryMb: 1024, runSeconds: 60 }, stopAt: Date.now() + 600000 });

test('admission: unset admits; set, a run is refused with its own code until a pass stands', async () => {
  await admitting(testConfig({ CODE_RUNNER_RUNTIME: 'runc' }));

  const file = passFile();
  const config = testConfig({ CODE_RUNNER_RUNTIME: 'runc', CODE_RUNNER_CONFORMANCE_FILE: file });
  let err;
  try { await admitting(config); } catch (e) { err = e; }
  assert.ok(err instanceof Abstain, `expected a refusal, got ${err && err.stack}`);
  assert.equal(err.cause, ABSTAIN.NO_CONFORMANCE_PASS);
  assert.equal(err.cause, 'no_conformance_pass');
  assert.equal(err.step, 'admission');
  assert.match(err.detail, /no conformance pass/);

  fs.writeFileSync(file, JSON.stringify(goodPass()));
  await admitting(config);

  fs.writeFileSync(file, JSON.stringify({ ...goodPass(), sourceSha256: 'a'.repeat(64) }));
  await assert.rejects(admitting(config), (e) => e.cause === 'no_conformance_pass' && /sourceSha256/.test(e.detail));
});

test('a refused run takes no slot', async () => {
  const config = testConfig({ CODE_RUNNER_RUNTIME: 'runc', CODE_RUNNER_CONFORMANCE_FILE: passFile() });
  const capacity = new Capacity({ config, meminfo: async () => ({ availableMb: 1e6, error: null }), log: silent });
  await assert.rejects(capacity.admit({ config, docker: fakeDocker(healthyDaemon()), limits: { memoryMb: 1024, runSeconds: 60 }, stopAt: Date.now() + 600000 }), (e) => e.cause === 'no_conformance_pass');
  assert.equal(capacity.status().slots.inUse, 0);
});

test('the self-test\'s own runner and the site\'s never set it: the check is the installer\'s to ask for', () => {
  const session = fs.readFileSync(path.join(__dirname, '..', '..', 'calibration', 'lib', 'session.js'), 'utf8');
  assert.ok(!/CODE_RUNNER_CONFORMANCE_FILE/.test(session));
  assert.ok(/loadConfig\(\{/.test(session), 'its config is built from a list, not from the environment');
  const e2e = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'e2e', 'src', 'l2', 'claim', 'services.js'), 'utf8');
  assert.ok(!/CODE_RUNNER_CONFORMANCE_FILE/.test(e2e), 'startCodeRunner throws on a 503, so it never asks for the check');
});
