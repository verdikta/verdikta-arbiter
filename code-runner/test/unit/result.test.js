'use strict';

// Acceptance: a result taxonomy: definitive (clean exit codes, JUnit outcomes,
// integrity failures) vs abstain (step wall-clock limit, OOM/137, pids limit,
// dead sandbox, Docker unreachable, refused admission). Design §9.3: settle
// only on definitive failures; anything ambiguous abstains.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyExec, ABSTAIN, OUTCOME, DEFINITIVE_BASIS, Abstain, makeGate } = require('../../src/result');

const RUNNING = { running: true, oomKilled: false, exitCode: 0, status: 'running' };
const ZERO = { oomKill: 0, pidsMax: 0 };

function obs(over = {}) {
  return {
    killedBy: null, spawnError: null, exitCode: 0, cliSignal: null, stderrHead: '', stdoutHead: '',
    state: RUNNING, inspectError: null, counters: { before: ZERO, after: ZERO }, runtime: 'runsc',
    ...over
  };
}

function cause(o) {
  const r = classifyExec(obs(o));
  assert.equal(r.kind, 'abstain', `expected abstain for ${JSON.stringify(o)}, got ${JSON.stringify(r)}`);
  assert.ok(r.detail && typeof r.detail === 'string');
  return r.cause;
}

test('the vocabulary', () => {
  assert.deepEqual({ ...OUTCOME }, { DEFINITIVE: 'definitive', ABSTAIN: 'abstain', REQUESTER_ERROR: 'requester_error' });
  assert.deepEqual({ ...DEFINITIVE_BASIS }, { EXIT_CODE: 'exit_code', JUNIT: 'junit', INTEGRITY: 'integrity' });
  for (const c of ['admission_refused', 'docker_unreachable', 'docker_error', 'image_unavailable', 'step_timeout',
    'deadline', 'oom', 'pids_limit', 'sandbox_died', 'killed_by_signal', 'cancelled', 'runner_error']) {
    assert.ok(Object.values(ABSTAIN).includes(c), c);
  }
});

test('clean exit codes are definitive', () => {
  for (const code of [0, 1, 2, 3, 100, 125, 126, 127, 128]) {
    const r = classifyExec(obs({ exitCode: code }));
    assert.deepEqual(r, { kind: 'definitive', basis: 'exit_code', exitCode: code }, String(code));
  }
});

test('a limit the runner enforced abstains with its own cause, whatever the exit code', () => {
  assert.equal(cause({ killedBy: 'step', exitCode: 137 }), ABSTAIN.STEP_TIMEOUT);
  assert.equal(cause({ killedBy: 'run', exitCode: null }), ABSTAIN.STEP_TIMEOUT);
  assert.equal(cause({ killedBy: 'deadline', exitCode: 0, state: { missing: true } }), ABSTAIN.DEADLINE);
  assert.equal(cause({ killedBy: 'cancel', exitCode: null }), ABSTAIN.CANCELLED);
});

test('OOM: the kernel flag, the cgroup counter, or 137', () => {
  assert.equal(cause({ exitCode: 137, state: { ...RUNNING, oomKilled: true } }), ABSTAIN.OOM);
  // A child was OOM-killed but the step exited 1 cleanly: still OOM.
  assert.equal(cause({ exitCode: 1, counters: { before: ZERO, after: { oomKill: 1, pidsMax: 0 } } }), ABSTAIN.OOM);
  assert.equal(cause({ exitCode: 0, state: { ...RUNNING, oomKilled: true } }), ABSTAIN.OOM);
  assert.equal(cause({ exitCode: 137, counters: { before: null, after: null } }), ABSTAIN.OOM);
  // The whole sandbox died of OOM (runsc).
  assert.equal(cause({ exitCode: 137, state: { running: false, oomKilled: true, exitCode: 137, status: 'exited' } }), ABSTAIN.OOM);
});

test('pids limit: the cgroup counter, or a runsc sandbox crash (exit 2)', () => {
  assert.equal(cause({ exitCode: 2, counters: { before: ZERO, after: { oomKill: 0, pidsMax: 3 } } }), ABSTAIN.PIDS_LIMIT);
  assert.equal(cause({ exitCode: 0, counters: { before: { oomKill: 0, pidsMax: 1 }, after: { oomKill: 0, pidsMax: 2 } } }), ABSTAIN.PIDS_LIMIT);
  assert.equal(cause({ exitCode: 1, state: { running: false, oomKilled: false, exitCode: 2, status: 'exited' } }), ABSTAIN.PIDS_LIMIT);
  // The probe after the step could not even start: the pid table is full.
  assert.equal(cause({ exitCode: 2, counters: { before: ZERO, after: null }, probe: 'pids_exhausted' }), ABSTAIN.PIDS_LIMIT);
  assert.equal(cause({ exitCode: 0, counters: { before: ZERO, after: null }, probe: 'failed' }), ABSTAIN.DOCKER_ERROR);
  // Earlier events that were already accounted for do not count again.
  const r = classifyExec(obs({ exitCode: 0, counters: { before: { oomKill: 0, pidsMax: 5 }, after: { oomKill: 0, pidsMax: 5 } } }));
  assert.equal(r.kind, 'definitive');
});

test('a dead or vanished sandbox abstains', () => {
  assert.equal(cause({ exitCode: 137, state: { running: false, oomKilled: false, exitCode: 137, status: 'exited' } }), ABSTAIN.SANDBOX_DIED);
  assert.equal(cause({ exitCode: 1, state: { missing: true } }), ABSTAIN.SANDBOX_DIED);
  assert.equal(cause({ exitCode: 0, state: { running: false, oomKilled: false, exitCode: 0, status: 'exited' } }), ABSTAIN.SANDBOX_DIED);
  // exit 2 means the pids limit only under gVisor.
  assert.equal(cause({ runtime: 'runc', exitCode: 1, state: { running: false, oomKilled: false, exitCode: 2, status: 'exited' } }), ABSTAIN.SANDBOX_DIED);
});

test('Docker trouble abstains', () => {
  assert.equal(cause({ spawnError: 'spawn docker ENOENT', exitCode: null }), ABSTAIN.DOCKER_UNREACHABLE);
  assert.equal(cause({ exitCode: 1, state: null, inspectError: 'unreachable' }), ABSTAIN.DOCKER_UNREACHABLE);
  assert.equal(cause({ exitCode: 1, state: null, inspectError: 'error' }), ABSTAIN.DOCKER_ERROR);
  assert.equal(cause({ exitCode: 1, stderrHead: 'Cannot connect to the Docker daemon at unix:///x. Is the docker daemon running?' }), ABSTAIN.DOCKER_UNREACHABLE);
  assert.equal(cause({ exitCode: 1, stderrHead: 'Error response from daemon: container is paused' }), ABSTAIN.DOCKER_ERROR);
  assert.equal(cause({ exitCode: null, cliSignal: 'SIGSEGV' }), ABSTAIN.DOCKER_ERROR);
});

test('a step whose process never started is not a definitive exit, unless the image simply lacks the program', () => {
  const spawn = 'OCI runtime exec failed: exec failed: unable to start container process: error executing setns process: exit status 1; runc init error(s): nsexec-0[3524]: unable to spawn stage-1: Resource temporarily unavailable\r\n';
  assert.equal(cause({ exitCode: 128, stdoutHead: spawn, program: 'forge' }), ABSTAIN.DOCKER_ERROR);
  assert.equal(cause({ exitCode: 126, stderrHead: spawn, program: 'forge' }), ABSTAIN.DOCKER_ERROR);
  assert.equal(cause({ exitCode: 1, stderrHead: 'Error response from daemon: OCI runtime exec failed: unable to start container process: unknown' }), ABSTAIN.DOCKER_ERROR);
  assert.equal(cause({ exitCode: 1, stdoutHead: 'Error response from daemon: container abc is restarting' }), ABSTAIN.DOCKER_ERROR);

  // Deterministic: the diagnostic names the step's own program.
  const definitive = (head, program, exitCode) => assert.deepEqual(
    classifyExec(obs({ exitCode, stderrHead: head, program })), { kind: 'definitive', basis: 'exit_code', exitCode }, head);
  definitive('OCI runtime exec failed: exec failed: unable to start container process: exec: "forge": executable file not found in $PATH: unknown\r\n', 'forge', 127);
  definitive('OCI runtime exec failed: exec failed: unable to start container process: exec: "/opt/bin/x": stat /opt/bin/x: no such file or directory: unknown', '/opt/bin/x', 127);
  definitive('OCI runtime exec failed: exec failed: unable to start container process: exec: "/etc/passwd": permission denied: unknown', '/etc/passwd', 126);
  // gVisor's wording, with the PATH list before the reason.
  definitive('OCI runtime exec failed: executing processes for container: executing command "no-such-binary" in sandbox: error finding executable "no-such-binary" in PATH [/usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin]: no such file or directory: unknown\n', 'no-such-binary', 127);

  // The runtime's own helper missing, or another program named: infrastructure, not the image's answer.
  const infra = [
    ['OCI runtime exec failed: exec failed: unable to start container process: error starting setns process: fork/exec /proc/self/exe: no such file or directory: unknown', 'forge', 127],
    ['OCI runtime exec failed: exec failed: unable to start container process: open /dev/pts/ptmx: permission denied: unknown', 'forge', 126],
    ['OCI runtime exec failed: exec failed: unable to start container process: exec: "sh": executable file not found in $PATH: unknown', 'forge', 127],
    ['OCI runtime exec failed: exec failed: unable to start container process: exec: "forge": executable file not found in $PATH: unknown', undefined, 127],
    ['OCI runtime exec failed: exec failed: unable to start container process: exec: "forge": executable file not found in $PATH: unknown', 'forge', 1]
  ];
  for (const [head, program, exitCode] of infra) {
    assert.equal(cause({ exitCode, stderrHead: head, program }), ABSTAIN.DOCKER_ERROR, head);
  }
  // Program output that merely mentions it later is the program's business.
  assert.equal(classifyExec(obs({ exitCode: 1, stdoutHead: 'building...\nOCI runtime exec failed? no\n', program: 'forge' })).kind, 'definitive');
});

test('a capped read counts only if what was read is the program\'s output', () => {
  const spawn = 'OCI runtime exec failed: exec failed: unable to start container process: error executing setns process: exit status 1; runc init error(s): nsexec-0[3524]: unable to spawn stage-1: Resource temporarily unavailable\r\n';
  assert.deepEqual(classifyExec(obs({ capped: true, exitCode: null, stdoutHead: '<?xml version="1.0"?><testsuites>', program: 'cat' })),
    { kind: 'definitive', basis: 'exit_code', exitCode: 0 });
  assert.equal(cause({ capped: true, exitCode: null, stdoutHead: spawn, program: 'cat' }), ABSTAIN.DOCKER_ERROR);
  assert.equal(cause({ capped: true, exitCode: 128, stderrHead: spawn, program: 'cat' }), ABSTAIN.DOCKER_ERROR);
  assert.equal(cause({ capped: true, exitCode: null, stdoutHead: 'Error response from daemon: container x is paused', program: 'cat' }), ABSTAIN.DOCKER_ERROR);
  // A capped read of a sandbox that died or ran out of memory still abstains.
  assert.equal(cause({ capped: true, exitCode: null, state: { running: false, oomKilled: false, exitCode: 137, status: 'exited' }, program: 'cat' }), ABSTAIN.SANDBOX_DIED);
});

test('a process killed by a signal is not a clean exit', () => {
  const r = classifyExec(obs({ exitCode: 139 }));
  assert.equal(r.cause, ABSTAIN.KILLED_BY_SIGNAL);
  assert.match(r.detail, /SIGSEGV/);
  assert.equal(cause({ exitCode: 143 }), ABSTAIN.KILLED_BY_SIGNAL);
  assert.equal(cause({ exitCode: 134 }), ABSTAIN.KILLED_BY_SIGNAL);
});

test('Abstain carries its cause and step', () => {
  const a = new Abstain(ABSTAIN.OOM, 'the step ran out of memory', { step: 'build' });
  assert.ok(a instanceof Error);
  assert.equal(a.cause, 'oom');
  assert.equal(a.step, 'build');
  assert.throws(() => new Abstain('made_up', 'x'), /cause/);
});

test('gates record their definitive basis', () => {
  assert.deepEqual(makeGate('fail', DEFINITIVE_BASIS.JUNIT, 'test passed on run 2'),
    { status: 'fail', basis: 'junit', detail: 'test passed on run 2' });
  assert.deepEqual(makeGate('pass', 'exit_code'), { status: 'pass', basis: 'exit_code', detail: null });
  assert.deepEqual(makeGate('fail', 'integrity', 'summary mismatch').basis, 'integrity');
  assert.throws(() => makeGate('maybe', 'exit_code'), /status/);
  assert.throws(() => makeGate('fail', 'timeout'), /basis/);
});
