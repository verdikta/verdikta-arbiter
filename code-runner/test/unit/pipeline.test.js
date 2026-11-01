'use strict';

// Acceptance: every step bounded; at the deadline the container is killed and
// the run abstains; the result taxonomy decides definitive vs abstain; a
// maintenance lock refuses runs. These drive the run engine against a fake
// Docker; test/docker/ runs the same paths against a real daemon.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { executeRun } = require('../../src/pipeline');
const { checkSpec } = require('../../src/classLimits');
const { fakeDocker, healthyDaemon, healthyInfo, runningState, never } = require('../helpers/fakeDocker');
const { testConfig } = require('../helpers/http');
const { spec, IMAGE } = require('../helpers/requests');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const noAdmission = async () => {};

function limits(over = {}) {
  const r = checkSpec(spec({ limits: { cpus: 1, memoryMb: 512, buildSeconds: 30, testSeconds: 60, runSeconds: 60, ...over } }));
  assert.ok(r.ok, JSON.stringify(r.issues));
  return r.limits;
}

function run({ docker, steps = [], deadlineMs = 600000, config = testConfig(), signal, admit, lim = limits(), active = new Set() } = {}) {
  const receivedAt = Date.now();
  return executeRun({
    docker, config, limits: lim, image: IMAGE, runId: '0123456789abcdef', steps,
    receivedAt, deadlineAt: receivedAt + deadlineMs, signal, active, log: silent, ...(admit ? { admit } : {})
  }).then((result) => ({ result, active }));
}

function removed(docker) {
  return docker.callsOf('rm').flatMap((c) => c.args.slice(3));
}

test('no steps: the sandbox starts and is torn down, the run is definitive', async () => {
  const docker = fakeDocker(healthyDaemon());
  const { result, active } = await run({ docker });
  assert.equal(result.outcome, 'definitive');
  assert.equal(result.abstain, null);
  assert.deepEqual(result.steps, []);
  const name = docker.callsOf('create')[0].args[docker.callsOf('create')[0].args.indexOf('--name') + 1];
  assert.match(name, /^vcr-0123456789abcdef-1$/);
  assert.ok(removed(docker).includes(name));
  assert.equal(active.size, 0);
});

test('a definitive step is recorded with its exit code, capped logs and gates', async () => {
  const docker = fakeDocker(healthyDaemon({
    step: () => ({ exitCode: 3, stdout: 'a'.repeat(100 * 1024), stderr: 'warn\n' })
  }));
  const steps = [async (ctx) => {
    const r = await ctx.exec(['forge', 'build'], { name: 'build', timeoutMs: 5000 });
    assert.equal(r.exitCode, 3);
    ctx.gate('build', r.exitCode === 0 ? 'pass' : 'fail', 'exit_code', `exit ${r.exitCode}`);
  }];
  const { result } = await run({ docker, steps });
  assert.equal(result.outcome, 'definitive');
  assert.equal(result.steps.length, 1);
  const s = result.steps[0];
  assert.equal(s.name, 'build');
  assert.equal(s.outcome, 'definitive');
  assert.equal(s.exitCode, 3);
  assert.equal(s.stdout.totalBytes, 100 * 1024);
  assert.equal(s.stdout.omittedBytes, 100 * 1024 - 64 * 1024);
  assert.equal(s.stderr.text, 'warn\n');
  assert.deepEqual(result.gates, { build: { status: 'fail', basis: 'exit_code', detail: 'exit 3' } });
  const exec = docker.callsOf('exec').find((c) => c.args.includes('forge'));
  assert.deepEqual(exec.args.slice(-2), ['forge', 'build']);
});

test('admission: the maintenance lock refuses before any Docker call', async () => {
  const config = testConfig();
  fs.mkdirSync(path.dirname(config.maintenanceFile), { recursive: true });
  fs.writeFileSync(config.maintenanceFile, '');
  const docker = fakeDocker(healthyDaemon());
  const { result } = await run({ docker, config });
  assert.equal(result.outcome, 'abstain');
  assert.equal(result.abstain.cause, 'admission_refused');
  assert.match(result.abstain.detail, /maintenance/);
  assert.equal(docker.calls.length, 0);
});

test('admission: a deadline shorter than runSeconds is refused before any Docker call', async () => {
  const docker = fakeDocker(healthyDaemon());
  const { result } = await run({ docker, deadlineMs: 30000, lim: limits({ runSeconds: 60 }) });
  assert.equal(result.abstain.cause, 'admission_refused');
  assert.match(result.abstain.detail, /deadline/);
  assert.equal(docker.calls.length, 0);
});

test('admission: Docker unreachable, or the runtime not registered', async () => {
  const unreachable = fakeDocker(healthyDaemon({ info: () => ({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon at unix:///x.sock.' }) }));
  assert.equal((await run({ docker: unreachable })).result.abstain.cause, 'docker_unreachable');
  const spawnFail = fakeDocker(healthyDaemon({ info: () => ({ spawnError: 'spawn docker ENOENT' }) }));
  assert.equal((await run({ docker: spawnFail })).result.abstain.cause, 'docker_unreachable');
  const noRuntime = fakeDocker(healthyDaemon({ info: () => ({ stdout: healthyInfo({ Runtimes: { runc: {} } }) }) }));
  const config = testConfig({ CODE_RUNNER_RUNTIME: 'runsc' });
  const r = (await run({ docker: noRuntime, config })).result;
  assert.equal(r.abstain.cause, 'admission_refused');
  assert.match(r.abstain.detail, /runsc/);
  assert.equal(noRuntime.callsOf('create').length, 0);
});

test('launch failures abstain and leave nothing behind', async () => {
  const cases = [
    [() => ({ exitCode: 125, stderr: 'docker: Error response from daemon: No such image: ghcr.io/x@sha256:aa' }), 'image_unavailable'],
    [() => ({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon at unix:///x.sock.' }), 'docker_unreachable'],
    [() => ({ exitCode: 125, stderr: 'docker: Error response from daemon: unknown or invalid runtime name: runsc' }), 'docker_error']
  ];
  for (const [launch, expected] of cases) {
    const docker = fakeDocker(healthyDaemon({ create: launch }));
    const { result, active } = await run({ docker });
    assert.equal(result.abstain.cause, expected);
    assert.equal(result.abstain.step, 'launch');
    assert.ok(removed(docker).includes('vcr-0123456789abcdef-1'), 'a half-created container is removed');
    assert.equal(active.size, 0);
  }
});

test('a step past its own wall-clock limit kills the container and abstains', async () => {
  const docker = fakeDocker(healthyDaemon({ step: never }));
  const started = Date.now();
  const steps = [async (ctx) => { await ctx.exec(['sleep', '1000'], { name: 'poc', timeoutMs: 100 }); }];
  const { result, active } = await run({ docker, steps });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.outcome, 'abstain');
  assert.equal(result.abstain.cause, 'step_timeout');
  assert.equal(result.abstain.step, 'poc');
  assert.equal(result.steps[0].outcome, 'abstain');
  assert.ok(removed(docker).includes('vcr-0123456789abcdef-1'));
  assert.equal(active.size, 0);
});

test('the run budget (runSeconds) bounds steps that set no limit of their own', async () => {
  const docker = fakeDocker(healthyDaemon({ step: never }));
  const lim = limits({ runSeconds: 1, testSeconds: 1 });
  const steps = [async (ctx) => { await ctx.exec(['sleep', '1000'], { name: 'suite' }); }];
  const { result } = await run({ docker, steps, lim, deadlineMs: 60000 });
  assert.equal(result.abstain.cause, 'step_timeout');
  assert.match(result.abstain.detail, /runSeconds/);
});

test('at the deadline the container is killed and the run abstains', async () => {
  const docker = fakeDocker(healthyDaemon({ step: never }));
  const config = testConfig();
  config.deadlineReserveMs = 0;
  const started = Date.now();
  const steps = [async (ctx) => { await ctx.exec(['sleep', '1000'], { name: 'poc', timeoutMs: 60000 }); }];
  const { result, active } = await run({ docker, steps, config, deadlineMs: 300, admit: noAdmission });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.abstain.cause, 'deadline');
  assert.ok(removed(docker).includes('vcr-0123456789abcdef-1'));
  assert.equal(active.size, 0);
});

test('the deadline also stops a step that is busy outside Docker', async () => {
  const docker = fakeDocker(healthyDaemon());
  const config = testConfig();
  config.deadlineReserveMs = 0;
  const steps = [async () => { await never(); }];
  const started = Date.now();
  const { result } = await run({ docker, steps, config, deadlineMs: 200, admit: noAdmission });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.abstain.cause, 'deadline');
  assert.ok(removed(docker).includes('vcr-0123456789abcdef-1'));
});

test('a step that starts after the deadline never reaches Docker', async () => {
  const docker = fakeDocker(healthyDaemon());
  const config = testConfig();
  config.deadlineReserveMs = 0;
  const steps = [
    async () => { await new Promise((r) => setTimeout(r, 300)); },
    async (ctx) => { await ctx.exec(['true'], { name: 'late' }); }
  ];
  const { result } = await run({ docker, steps, config, deadlineMs: 100, admit: noAdmission });
  assert.equal(result.abstain.cause, 'deadline');
  assert.equal(docker.callsOf('exec').filter((c) => c.args.includes('true')).length, 0);
});

test('the reserve keeps time for teardown and the response', async () => {
  const docker = fakeDocker(healthyDaemon({ step: never }));
  const config = testConfig();
  config.deadlineReserveMs = 400;
  const steps = [async (ctx) => { await ctx.exec(['sleep', '1000'], { name: 'poc', timeoutMs: 60000 }); }];
  const started = Date.now();
  const { result } = await run({ docker, steps, config, deadlineMs: 600, admit: noAdmission });
  const elapsed = Date.now() - started;
  assert.equal(result.abstain.cause, 'deadline');
  assert.ok(elapsed < 590, `stopped at ${elapsed} ms`);
});

test('cancellation (the caller went away) kills the container', async () => {
  const docker = fakeDocker(healthyDaemon({ step: never }));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const steps = [async (ctx) => { await ctx.exec(['sleep', '1000'], { name: 'poc' }); }];
  const { result, active } = await run({ docker, steps, signal: ac.signal });
  assert.equal(result.abstain.cause, 'cancelled');
  assert.ok(removed(docker).includes('vcr-0123456789abcdef-1'));
  assert.equal(active.size, 0);
});

test('a bug in a step abstains (runner_error) and still tears down', async () => {
  const docker = fakeDocker(healthyDaemon());
  const steps = [async () => { throw new TypeError('oops'); }];
  const { result } = await run({ docker, steps });
  assert.equal(result.abstain.cause, 'runner_error');
  assert.ok(removed(docker).includes('vcr-0123456789abcdef-1'));
});

test('after each step the sandbox is inspected: an OOM behind a clean exit abstains', async () => {
  let reads = 0;
  const docker = fakeDocker(healthyDaemon({
    step: () => ({ exitCode: 1, stderr: 'solc: Killed' }),
    counters: () => {
      reads += 1;
      const n = reads > 1 ? 1 : 0;
      return { stdout: `==> /sys/fs/cgroup/memory.events <==\noom_kill ${n}\n\n==> /sys/fs/cgroup/pids.events <==\nmax 0\n` };
    }
  }));
  const steps = [async (ctx) => { await ctx.exec(['forge', 'build'], { name: 'build' }); }];
  const { result } = await run({ docker, steps });
  assert.equal(result.abstain.cause, 'oom');
  assert.equal(result.abstain.step, 'build');
});

test('a sandbox that died during the step abstains', async () => {
  const docker = fakeDocker(healthyDaemon({
    step: () => ({ exitCode: 137 }),
    inspect: () => ({ stdout: runningState({ Running: false, Status: 'exited', ExitCode: 137 }) })
  }));
  const steps = [async (ctx) => { await ctx.exec(['forge', 'test'], { name: 'poc' }); }];
  const { result } = await run({ docker, steps });
  assert.equal(result.abstain.cause, 'sandbox_died');
});

test('readFile reads through a cap with cat inside the container', async () => {
  const docker = fakeDocker(healthyDaemon({ step: (args) => (args.includes('cat') ? { stdout: 'x'.repeat(5000) } : { exitCode: 0 }) }));
  let got;
  const steps = [async (ctx) => { got = await ctx.readFile('/tmp/junit.xml', { maxBytes: 1000 }); }];
  const { result } = await run({ docker, steps });
  assert.equal(result.outcome, 'definitive');
  assert.equal(got.overLimit, true);
  assert.equal(got.bytes.length, 1000);
  const cat = docker.callsOf('exec').find((c) => c.args.includes('cat'));
  assert.deepEqual(cat.args.slice(-3), ['cat', '--', '/tmp/junit.xml']);
  const relative = await run({ docker, steps: [async (ctx) => { await ctx.readFile('relative/path', { maxBytes: 10 }); }] });
  assert.equal(relative.result.abstain.cause, 'runner_error');
});

test('a second sandbox (the fix check) gets the same flags and is torn down too', async () => {
  const docker = fakeDocker(healthyDaemon());
  const steps = [async (ctx) => {
    const fix = await ctx.openSandbox('fix');
    await fix.exec(['true'], { name: 'fix-build' });
  }];
  const { result, active } = await run({ docker, steps });
  assert.equal(result.outcome, 'definitive');
  const launches = docker.callsOf('create');
  assert.equal(launches.length, 2);
  const flags = (a) => a.filter((x) => x.startsWith('--'));
  assert.deepEqual(flags(launches[1].args), flags(launches[0].args));
  const names = launches.map((c) => c.args[c.args.indexOf('--name') + 1]);
  assert.deepEqual(names, ['vcr-0123456789abcdef-1', 'vcr-0123456789abcdef-2']);
  for (const n of names) assert.ok(removed(docker).includes(n), n);
  assert.equal(active.size, 0);
});

test('the keepalive and the GC label outlive the deadline only by a margin', async () => {
  const docker = fakeDocker(healthyDaemon());
  const before = Math.floor(Date.now() / 1000);
  await run({ docker, deadlineMs: 600000 });
  const args = docker.callsOf('create')[0].args;
  const keepalive = Number(args[args.length - 1]);
  assert.ok(keepalive >= 600 && keepalive <= 660, `keepalive ${keepalive}`);
  const expires = Number(args.find((a) => a.startsWith('verdikta.code-runner.expires=')).split('=')[1]);
  assert.ok(expires >= before + 600 && expires <= before + 661, `expires ${expires - before}`);
});

test('claim content enters the sandbox on stdin, never through a host file', async () => {
  const docker = fakeDocker(healthyDaemon());
  const steps = [async (ctx) => { await ctx.exec(['git', 'apply', '-'], { name: 'apply', stdin: Buffer.from('diff --git a/x b/x\n') }); }];
  await run({ docker, steps });
  const apply = docker.callsOf('exec').find((c) => c.args.includes('apply'));
  assert.ok(apply.args.includes('--interactive'));
  assert.equal(apply.stdin.toString(), 'diff --git a/x b/x\n');
});

test('a removal that hangs does not hold the answer past the deadline', async () => {
  const docker = fakeDocker(healthyDaemon({
    step: never,
    rm: () => new Promise((resolve) => setTimeout(() => resolve({}), 3000))
  }));
  const config = testConfig();
  config.deadlineReserveMs = 0;
  const active = new Set();
  const started = Date.now();
  const steps = [async (ctx) => { await ctx.exec(['sleep', '1000'], { name: 'poc', timeoutMs: 60000 }); }];
  const { result } = await run({ docker, steps, config, deadlineMs: 500, admit: noAdmission, active });
  const elapsed = Date.now() - started;
  assert.equal(result.abstain.cause, 'deadline');
  assert.ok(elapsed < 1500, `answered after ${elapsed} ms`);
  // The removal carries on; the live-run set keeps the name until it is done.
  assert.ok(active.has('vcr-0123456789abcdef-1'));
});

test('a definitive run whose sandbox is still there at the deadline abstains', async () => {
  const docker = fakeDocker(healthyDaemon({ rm: () => new Promise((resolve) => setTimeout(() => resolve({}), 3000)) }));
  const config = testConfig();
  config.deadlineReserveMs = 900;
  const started = Date.now();
  const { result } = await run({ docker, config, deadlineMs: 1100, lim: limits({ runSeconds: 1, testSeconds: 1 }), admit: noAdmission });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1600, `answered after ${elapsed} ms, past the 1100 ms deadline`);
  assert.equal(result.outcome, 'abstain');
  assert.equal(result.abstain.cause, 'docker_error');
  assert.equal(result.abstain.step, 'teardown');
});

test('a definitive run whose sandbox cannot be removed abstains', async () => {
  const docker = fakeDocker(healthyDaemon({ rm: () => ({ exitCode: 1, stderr: 'Error response from daemon: removal of container vcr-0123456789abcdef-1 is already in progress' }) }));
  const { result } = await run({ docker });
  assert.equal(result.abstain.cause, 'docker_error');
  assert.equal(result.abstain.step, 'teardown');
});

test('an image that declares volumes is a requester error; it is removed with its volumes and never started', async () => {
  const docker = fakeDocker(healthyDaemon({ mounts: () => ({ stdout: '[{"Type":"volume","Destination":"/var/lib/data"}]' }) }));
  const { result, active } = await run({ docker });
  assert.equal(result.outcome, 'requester_error');
  assert.equal(result.issues[0].code, 'IMAGE_DECLARES_VOLUMES');
  assert.equal(docker.callsOf('start').length, 0);
  assert.deepEqual(docker.callsOf('rm')[0].args, ['rm', '--force', '--volumes', 'vcr-0123456789abcdef-1']);
  assert.equal(active.size, 0);
});

test('the platform is the class platform, passed to docker create', async () => {
  const docker = fakeDocker(healthyDaemon());
  const { result } = await run({ docker });
  const args = docker.callsOf('create')[0].args;
  assert.equal(args[args.indexOf('--platform') + 1], 'linux/amd64');
  assert.equal(result.platform, 'linux/amd64');
});

test('a run-level kill answers by the deadline even when the step never returns', async () => {
  const docker = fakeDocker(healthyDaemon());
  const config = testConfig();
  config.deadlineReserveMs = 0;
  const started = Date.now();
  const { result } = await run({
    docker, config, deadlineMs: 1100, lim: limits({ runSeconds: 1, testSeconds: 1 }), admit: noAdmission,
    steps: [async () => { await never(); }]
  });
  const elapsed = Date.now() - started;
  assert.equal(result.abstain.cause, 'step_timeout');
  assert.ok(elapsed < 1400, `answered after ${elapsed} ms, past the 1100 ms deadline`);
});


const SPAWN_FAILED = 'OCI runtime exec failed: exec failed: unable to start container process: error executing setns process: exit status 1; runc init error(s): nsexec-0[3524]: unable to spawn stage-1: Resource temporarily unavailable\r\n';
const COUNTERS_V2 = '==> /sys/fs/cgroup/memory.events <==\noom_kill 0\n==> /sys/fs/cgroup/pids.events <==\nmax 0\n';

function withProbes(step, after, extra = {}) {
  let probes = 0;
  return fakeDocker({
    ...healthyDaemon({
      step,
      // The probe at launch works; `after` answers the one after the step.
      counters: (...a) => { probes += 1; return probes === 1 ? { stdout: COUNTERS_V2 } : after(...a); }
    }),
    ...extra
  });
}

const buildStep = [async (ctx) => {
  const r = await ctx.exec(['forge', 'build'], { name: 'build' });
  ctx.gate('build', r.exitCode === 0 ? 'pass' : 'fail', 'exit_code');
}];

test('every exec goes through the launcher with a fresh nonce, and the start line is not the program\'s output', async () => {
  const docker = fakeDocker(healthyDaemon({ step: () => ({ exitCode: 0, stdout: 'built\n' }) }));
  let record;
  const { result } = await run({ docker, steps: [async (ctx) => {
    record = await ctx.exec(['forge', 'build'], { name: 'build' });
    await ctx.exec(['forge', 'build'], { name: 'again' });
  }] });
  assert.equal(result.outcome, 'definitive');
  assert.equal(record.stdout.text, 'built\n');
  assert.equal(record.started, true);
  const execs = docker.callsOf('exec').map((c) => c.args);
  for (const args of execs) {
    const i = args.indexOf('/bin/sh');
    assert.deepEqual(args.slice(i, i + 4), ['/bin/sh', '-c', 'printf "vcr-start %s\\n" "$1" && shift && exec "$@"', 'vcr-launch'], args.join(' '));
    assert.match(args[i + 4], /^[0-9a-f]{32}$/);
  }
  const nonces = execs.map((a) => a[a.indexOf('vcr-launch') + 1]);
  assert.equal(new Set(nonces).size, nonces.length, 'a new nonce for every exec');
  const steps = execs.filter((a) => a.includes('forge'));
  assert.deepEqual(steps[0].slice(-2), ['forge', 'build'], 'the step argv follows the nonce unchanged');
});

test('R4-F1 form 1: a spawn failure (exit 128, Docker on stdout) never decides a gate', async () => {
  const docker = withProbes(() => ({ started: false, exitCode: 128, stdout: SPAWN_FAILED }), () => ({ stdout: COUNTERS_V2 }));
  const { result } = await run({ docker, steps: buildStep });
  assert.equal(result.abstain.cause, 'step_not_started');
  assert.equal(result.abstain.step, 'build');
  assert.match(result.abstain.detail, /unable to spawn stage-1/);
  assert.deepEqual(result.gates, {});
  assert.equal(result.steps[0].started, false);
});

test('R4-F1 form 2: the runtime helper missing, with a 127, never decides a gate', async () => {
  const docker = withProbes(() => ({ started: false, exitCode: 127, stderr: 'OCI runtime exec failed: exec failed: unable to start container process: error starting setns process: fork/exec /proc/self/exe: no such file or directory: unknown\r\n' }), () => ({ stdout: COUNTERS_V2 }));
  const { result } = await run({ docker, steps: buildStep });
  assert.equal(result.abstain.cause, 'step_not_started');
  assert.deepEqual(result.gates, {});
});

test('R4-F1 form 3: a capped read whose bytes are Docker\'s diagnostic is never returned', async () => {
  const docker = withProbes((args) => (args.includes('cat') ? { started: false, exitCode: 128, stdout: SPAWN_FAILED } : { exitCode: 0 }), () => ({ stdout: COUNTERS_V2 }));
  let got = null;
  const { result } = await run({ docker, steps: [async (ctx) => {
    got = await ctx.readFile('/tmp/junit.xml', { maxBytes: 64 });
    ctx.gate('integrity', 'fail', 'integrity', 'never reached');
  }] });
  assert.equal(got, null);
  assert.equal(result.abstain.cause, 'step_not_started');
  assert.equal(result.abstain.step, 'read:/tmp/junit.xml');
  assert.deepEqual(result.gates, {});
});

test('Docker printing nothing unusual does not make a step count: the nonce must be there', async () => {
  const docker = withProbes(() => ({ started: false, exitCode: 1 }), () => ({ stdout: COUNTERS_V2 }));
  const { result } = await run({ docker, steps: buildStep });
  assert.equal(result.abstain.cause, 'step_not_started');
  assert.match(result.abstain.detail, /Docker said: nothing/);
  assert.deepEqual(result.gates, {});
});

test('with the nonce, a capped read is the file\'s bytes, the start line stripped', async () => {
  const docker = fakeDocker(healthyDaemon({ step: (args) => (args.includes('cat') ? { exitCode: 0, stdout: '<testsuites>' + 'x'.repeat(5000) } : { exitCode: 0 }) }));
  let got;
  const { result } = await run({ docker, steps: [async (ctx) => { got = await ctx.readFile('/tmp/junit.xml', { maxBytes: 12 }); }] });
  assert.equal(result.outcome, 'definitive');
  assert.equal(got.bytes.toString(), '<testsuites>');
  assert.equal(got.overLimit, true);
});

test('the image\'s own answer: the launcher started and exec found no program (127) is definitive', async () => {
  const docker = fakeDocker(healthyDaemon({ step: () => ({ exitCode: 127, stderr: 'vcr-launch: 1: exec: forge: not found\n' }) }));
  const { result } = await run({ docker, steps: buildStep });
  assert.equal(result.outcome, 'definitive');
  assert.deepEqual(result.gates.build, { status: 'fail', basis: 'exit_code', detail: null });
});

test('a probe that does not start after a step: pids_limit when the pid table is full, docker_error otherwise', async () => {
  const notStarted = () => ({ started: false, exitCode: 128, stdout: SPAWN_FAILED });
  const full = withProbes(() => ({ exitCode: 2, stderr: 'sh: 0: Cannot fork\n' }), notStarted, { stats: () => ({ stdout: '4095\n' }) });
  const r1 = (await run({ docker: full, steps: buildStep })).result;
  assert.equal(r1.abstain.cause, 'pids_limit');
  assert.match(r1.steps[0].probe, /did not start/);
  assert.deepEqual(full.callsOf('stats')[0].args, ['stats', '--no-stream', '--format', '{{.PIDs}}', 'vcr-0123456789abcdef-1']);
  const room = withProbes(() => ({ exitCode: 0 }), notStarted, { stats: () => ({ stdout: '12\n' }) });
  assert.equal((await run({ docker: room, steps: buildStep })).result.abstain.cause, 'docker_error');
});

test('a probe that started but did not finish cleanly is not a pass', async () => {
  const cases = [
    [() => ({ exitCode: 3, stdout: '==> /sys/fs/cgroup/memory.events <==\noom_kill 0\n' }), 'docker_error'],
    [() => ({ exitCode: 137 }), 'docker_error'],
    [() => ({ spawnError: 'spawn docker ENOENT' }), 'docker_unreachable']
  ];
  for (const [after, expected] of cases) {
    const docker = withProbes(() => ({ exitCode: 1 }), after);
    const { result } = await run({ docker, steps: buildStep });
    assert.equal(result.abstain.cause, expected);
    assert.equal(result.abstain.step, 'build');
  }
});

test('counter files that do not exist (gVisor, or the other cgroup version) are not a problem', async () => {
  for (const out of ['', COUNTERS_V2]) {
    const docker = withProbes(() => ({ exitCode: 1 }), () => ({ exitCode: 0, stdout: out }));
    const { result } = await run({ docker, steps: buildStep });
    assert.equal(result.outcome, 'definitive', JSON.stringify(result.abstain));
    assert.equal(result.gates.build.status, 'fail');
  }
});

test('at launch: an image whose launcher the sandbox user could replace is the requester\'s error', async () => {
  const docker = fakeDocker(healthyDaemon({ launcherCheck: () => ({ exitCode: 1 }) }));
  const { result } = await run({ docker });
  assert.equal(result.outcome, 'requester_error');
  assert.equal(result.issues[0].code, 'IMAGE_LAUNCHER_WRITABLE');
  const notStarted = fakeDocker(healthyDaemon({ launcherCheck: () => ({ started: false, exitCode: 126, stderr: 'OCI runtime exec failed: exec: "/bin/sh": stat /bin/sh: no such file or directory' }) }));
  const r2 = (await run({ docker: notStarted })).result;
  assert.equal(r2.abstain.cause, 'step_not_started');
  assert.equal(r2.abstain.step, 'launch');
});
