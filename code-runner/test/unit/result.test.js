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
    killedBy: null, spawnError: null, started: true, exitCode: 0, cliSignal: null, stderrHead: '', stdoutHead: '',
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
  assert.deepEqual({ ...DEFINITIVE_BASIS }, { EXIT_CODE: 'exit_code', JUNIT: 'junit', INTEGRITY: 'integrity', INPUT: 'input' });
  for (const c of ['admission_refused', 'docker_unreachable', 'docker_error', 'image_unavailable', 'step_timeout',
    'deadline', 'oom', 'pids_limit', 'step_not_started', 'sandbox_died', 'killed_by_signal', 'cancelled', 'runner_error',
    'registry_not_allowed', 'pull_failed', 'image_mismatch']) {
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
  assert.equal(cause({ exitCode: null, cliSignal: 'SIGSEGV' }), ABSTAIN.DOCKER_ERROR);
});

// R4-F1, in its three forms, decided by the start nonce alone. Docker's text
// only goes into the detail.
const SPAWN_FAILED = 'OCI runtime exec failed: exec failed: unable to start container process: error executing setns process: exit status 1; runc init error(s): nsexec-0[3524]: unable to spawn stage-1: Resource temporarily unavailable\r\n';
const HELPER_MISSING = 'OCI runtime exec failed: exec failed: unable to start container process: error starting setns process: fork/exec /proc/self/exe: no such file or directory: unknown\r\n';

test('no start nonce, no result: the command did not run, whatever Docker printed', () => {
  // Form 1: a spawn failure, exit 128, on stdout or on stderr.
  const r1 = classifyExec(obs({ started: false, exitCode: 128, stdoutHead: SPAWN_FAILED }));
  assert.equal(r1.cause, ABSTAIN.STEP_NOT_STARTED);
  assert.match(r1.detail, /unable to spawn stage-1/, 'Docker\'s words are kept as the diagnostic');
  assert.equal(cause({ started: false, exitCode: 126, stderrHead: SPAWN_FAILED }), ABSTAIN.STEP_NOT_STARTED);
  // Form 2: the runtime's own helper missing, with the 127 a missing program would give.
  assert.equal(cause({ started: false, exitCode: 127, stderrHead: HELPER_MISSING }), ABSTAIN.STEP_NOT_STARTED);
  // Form 3: a capped read whose bytes are Docker's diagnostic.
  assert.equal(cause({ started: false, capped: true, exitCode: null, stdoutHead: SPAWN_FAILED }), ABSTAIN.STEP_NOT_STARTED);
  // And Docker printing nothing unusual at all: a clean 0 or 1 without the nonce.
  for (const exitCode of [0, 1, 2]) {
    const r = classifyExec(obs({ started: false, exitCode, stdoutHead: '', stderrHead: '' }));
    assert.equal(r.cause, ABSTAIN.STEP_NOT_STARTED, String(exitCode));
    assert.match(r.detail, /Docker said: nothing/);
  }
  assert.equal(cause({ started: undefined, exitCode: 0 }), ABSTAIN.STEP_NOT_STARTED, 'only an explicit true counts');
});

test('with the nonce, the exit code is the program\'s, whatever text surrounds it', () => {
  // The image's own answer: the launcher started, and exec found no program.
  assert.deepEqual(classifyExec(obs({ exitCode: 127, stderrHead: 'vcr-launch: 1: exec: forge: not found\n' })),
    { kind: 'definitive', basis: 'exit_code', exitCode: 127 });
  assert.equal(classifyExec(obs({ exitCode: 126, stderrHead: 'vcr-launch: 1: exec: /etc/passwd: Permission denied\n' })).kind, 'definitive');
  // Program output that looks like a Docker error is the program's.
  assert.deepEqual(classifyExec(obs({ exitCode: 1, stdoutHead: SPAWN_FAILED, stderrHead: 'Error response from daemon: no' })),
    { kind: 'definitive', basis: 'exit_code', exitCode: 1 });
  assert.equal(classifyExec(obs({ exitCode: 1, stderrHead: 'Cannot connect to the Docker daemon' })).kind, 'definitive');
});

test('a capped read with the nonce is definitive, and the sandbox checks still apply', () => {
  assert.deepEqual(classifyExec(obs({ capped: true, exitCode: null, stdoutHead: '<?xml version="1.0"?><testsuites>' })),
    { kind: 'definitive', basis: 'exit_code', exitCode: 0 });
  assert.equal(cause({ capped: true, exitCode: null, state: { running: false, oomKilled: false, exitCode: 137, status: 'exited' } }), ABSTAIN.SANDBOX_DIED);
  assert.equal(cause({ capped: true, exitCode: null, counters: { before: ZERO, after: { oomKill: 1, pidsMax: 0 } } }), ABSTAIN.OOM);
});

test('a full pid table or a dead sandbox outranks a missing nonce', () => {
  assert.equal(cause({ started: false, exitCode: 128, stdoutHead: SPAWN_FAILED, counters: { before: ZERO, after: null }, probe: 'pids_exhausted' }), ABSTAIN.PIDS_LIMIT);
  assert.equal(cause({ started: false, exitCode: 1, state: { running: false, oomKilled: true, exitCode: 137, status: 'exited' } }), ABSTAIN.OOM);
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
