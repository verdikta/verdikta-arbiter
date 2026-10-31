'use strict';

// Acceptance: containers started with argv arrays only and the §9.1 flags; a
// unit test asserts the exact argv. Review focus: the spec cannot weaken flags.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runArgs, execArgs, removeArgs, SANDBOX_USER, SANDBOX_ENV, LABEL } = require('../../src/sandbox');
const { checkSpec } = require('../../src/classLimits');
const { spec, IMAGE } = require('../helpers/requests');

const BASE = {
  name: 'vcr-0123456789abcdef-1',
  image: IMAGE,
  runtime: 'runsc',
  limits: { cpus: 2, memoryMb: 4096, pids: 4096 },
  instance: 'default',
  runId: '0123456789abcdef',
  expiresAt: 1790000000,
  keepaliveSeconds: 800
};

test('docker run argv is exactly the §9.1 sandbox', () => {
  assert.deepEqual(runArgs(BASE), [
    'run', '--detach', '--pull', 'never',
    '--name', 'vcr-0123456789abcdef-1',
    '--label', 'verdikta.code-runner=1',
    '--label', 'verdikta.code-runner.instance=default',
    '--label', 'verdikta.code-runner.run=0123456789abcdef',
    '--label', 'verdikta.code-runner.expires=1790000000',
    '--runtime', 'runsc',
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', '10001:10001',
    '--pids-limit', '4096',
    '--memory', '4096m',
    '--memory-swap', '4096m',
    '--cpus', '2',
    '--hostname', 'sandbox',
    '--env', 'TZ=UTC',
    '--env', 'LANG=C.UTF-8',
    '--env', 'CI=true',
    '--env', 'PYTHONHASHSEED=0',
    '--log-driver', 'none',
    '--init',
    '--entrypoint', 'sleep',
    IMAGE,
    '800'
  ]);
  assert.equal(SANDBOX_USER, '10001:10001');
  assert.deepEqual({ ...SANDBOX_ENV }, { TZ: 'UTC', LANG: 'C.UTF-8', CI: 'true', PYTHONHASHSEED: '0' });
  assert.equal(LABEL, 'verdikta.code-runner');
});

test('runc is the only other runtime, and it changes nothing else', () => {
  const runsc = runArgs(BASE);
  const runc = runArgs({ ...BASE, runtime: 'runc' });
  assert.deepEqual(runc.filter((a, i) => a !== runsc[i]), ['runc']);
  assert.throws(() => runArgs({ ...BASE, runtime: 'kata' }), /runtime/);
  assert.throws(() => runArgs({ ...BASE, runtime: undefined }), /runtime/);
});

test('a spec can only lower numbers; the flag set never changes', () => {
  const low = checkSpec(spec({ limits: { cpus: 1, memoryMb: 512, runSeconds: 60, testSeconds: 30 } }));
  assert.equal(low.ok, true);
  const argv = runArgs({ ...BASE, limits: low.limits });
  const flags = (a) => a.filter((x) => x.startsWith('--'));
  assert.deepEqual(flags(argv), flags(runArgs(BASE)));
  assert.equal(argv[argv.indexOf('--cpus') + 1], '1');
  assert.equal(argv[argv.indexOf('--memory') + 1], '512m');
  assert.equal(argv[argv.indexOf('--memory-swap') + 1], '512m');
  // pids is the class value whatever the spec said.
  assert.equal(argv[argv.indexOf('--pids-limit') + 1], '4096');
});

test('no mount, no socket, no privilege, no host namespace, ever', () => {
  const argv = runArgs(BASE).join('\n');
  for (const forbidden of ['--volume', '-v', '--mount', '--privileged', '--cap-add', 'docker.sock', '--network=host',
    'host', '--pid', '--ipc', '--userns', '--device', '--security-opt=seccomp=unconfined', 'apparmor=unconfined', '--tmpfs']) {
    assert.ok(!argv.split('\n').includes(forbidden), forbidden);
  }
});

test('inputs that could smuggle a flag or a second argument are refused', () => {
  const bad = [
    { image: '--privileged' },
    { image: `${IMAGE} --network=host` },
    { image: 'ubuntu:24.04' },
    { name: '--rm' },
    { name: 'vcr-x y' },
    { instance: 'a=b' },
    { runId: '../x' },
    { limits: { cpus: '2 --privileged', memoryMb: 4096, pids: 4096 } },
    { limits: { cpus: 2, memoryMb: 4096.5, pids: 4096 } },
    { limits: { cpus: 2, memoryMb: 4096, pids: -1 } },
    { limits: { cpus: 3, memoryMb: 4096, pids: 4096 } },
    { limits: { cpus: 2, memoryMb: 8192, pids: 4096 } },
    { limits: { cpus: 2, memoryMb: 4096, pids: 5000 } },
    { keepaliveSeconds: 0 },
    { expiresAt: 'soon' }
  ];
  for (const over of bad) {
    assert.throws(() => runArgs({ ...BASE, ...over }), Error, JSON.stringify(over));
  }
});

test('docker exec argv: the sandbox user, the container, then the step argv untouched', () => {
  assert.deepEqual(execArgs({ name: BASE.name, argv: ['forge', 'build'] }),
    ['exec', '--user', '10001:10001', BASE.name, 'forge', 'build']);
  assert.deepEqual(execArgs({ name: BASE.name, argv: ['git', 'apply', '-'], stdin: true, env: { FILES: 'test/A.t.sol' }, workdir: '/work/repo' }),
    ['exec', '--interactive', '--user', '10001:10001', '--env', 'FILES=test/A.t.sol', '--workdir', '/work/repo', BASE.name, 'git', 'apply', '-']);
  // Arguments that look like flags or shell are data after the container name.
  assert.deepEqual(execArgs({ name: BASE.name, argv: ['--privileged', '$(rm -rf /)', ';', '|'] }).slice(4),
    ['--privileged', '$(rm -rf /)', ';', '|']);
  assert.throws(() => execArgs({ name: BASE.name, argv: [] }), /argv/);
  assert.throws(() => execArgs({ name: BASE.name, argv: 'forge build' }), /argv/);
  assert.throws(() => execArgs({ name: BASE.name, argv: ['a', 7] }), /argv/);
  assert.throws(() => execArgs({ name: BASE.name, argv: ['a\0b'] }), /argv/);
  assert.throws(() => execArgs({ name: BASE.name, argv: ['true'], env: { 'A=B': 'c' } }), /env/);
  assert.throws(() => execArgs({ name: BASE.name, argv: ['true'], workdir: 'relative' }), /workdir/);
});

test('teardown argv removes the container by name, forcefully', () => {
  assert.deepEqual(removeArgs([BASE.name]), ['rm', '--force', BASE.name]);
  assert.throws(() => removeArgs(['--all']), /name/);
});
