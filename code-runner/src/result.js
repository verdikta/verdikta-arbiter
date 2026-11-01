'use strict';

/**
 * The result taxonomy (design §9.3, §12).
 *
 * A run is DEFINITIVE when every step it ran ended in something the arbiters
 * may settle on: a clean exit code, a JUnit outcome, an integrity-check
 * result. Everything else makes the arbiter ABSTAIN: an error with no commit,
 * the same rule as a transient IPFS or AI failure. Abstaining is not neutral
 * (§12: the timeliness penalty), but settling INVALID on a host problem would
 * be worse, so the rule is one-sided: when in doubt, abstain.
 *
 * Gates and integrity results (nodes A2a, A3a) are recorded with makeGate()
 * and carry the definitive basis they were decided on.
 */

const OUTCOME = Object.freeze({
  DEFINITIVE: 'definitive',
  ABSTAIN: 'abstain',
  REQUESTER_ERROR: 'requester_error'
});

const ABSTAIN = Object.freeze({
  /** Admission said no: maintenance lock, deadline too short, runtime missing (A1b adds slots, memory, disk). */
  ADMISSION_REFUSED: 'admission_refused',
  /** The Docker daemon could not be reached. */
  DOCKER_UNREACHABLE: 'docker_unreachable',
  /** The daemon answered with an error the step did not cause. */
  DOCKER_ERROR: 'docker_error',
  /** The env image is not on the runner's disk (A1b adds pull failures). */
  IMAGE_UNAVAILABLE: 'image_unavailable',
  /** A step's own wall-clock limit, or the run's (runSeconds). */
  STEP_TIMEOUT: 'step_timeout',
  /** The deadline the EA passed in. */
  DEADLINE: 'deadline',
  /** The memory limit: the kernel's OOM flag or counter, or exit 137. */
  OOM: 'oom',
  /** The process limit (--pids-limit). */
  PIDS_LIMIT: 'pids_limit',
  /** The step's launcher never reported its start nonce: its command did not run. */
  STEP_NOT_STARTED: 'step_not_started',
  /** The sandbox died or vanished under the step. */
  SANDBOX_DIED: 'sandbox_died',
  /** The step's process died of a signal: not a clean exit. */
  KILLED_BY_SIGNAL: 'killed_by_signal',
  /** The caller went away (or the runner is shutting down). */
  CANCELLED: 'cancelled',
  /** A bug in the runner. */
  RUNNER_ERROR: 'runner_error'
});

const ABSTAIN_CAUSES = new Set(Object.values(ABSTAIN));

/** What a definitive gate was decided on (§9.3: settle only on these). */
const DEFINITIVE_BASIS = Object.freeze({
  EXIT_CODE: 'exit_code',
  JUNIT: 'junit',
  INTEGRITY: 'integrity'
});

const BASES = new Set(Object.values(DEFINITIVE_BASIS));

class Abstain extends Error {
  /**
   * @param {string} cause - one of ABSTAIN
   * @param {string} detail - plain words for operators
   * @param {{ step?: string }} [where]
   */
  constructor(cause, detail, { step = null } = {}) {
    if (!ABSTAIN_CAUSES.has(cause)) throw new TypeError(`unknown abstain cause: ${cause}`);
    super(`${cause}: ${detail}`);
    this.name = 'Abstain';
    this.cause = cause;
    this.detail = detail;
    this.step = step;
  }
}

/**
 * The requester's package is broken (§12): an error with no commit, the same
 * on every arbiter, raised before any claim code runs. `issues` have the
 * `{ code, path, detail }` shape of the 400 answer.
 */
class RequesterError extends Error {
  constructor(issues) {
    super(issues.map((i) => i.detail).join('; '));
    this.name = 'RequesterError';
    this.issues = issues;
  }
}

/**
 * A gate's result. Only a definitive basis is accepted: a gate can never be
 * decided on a timeout or a dead sandbox (those abstain instead).
 */
function makeGate(status, basis, detail = null) {
  if (status !== 'pass' && status !== 'fail') throw new TypeError(`gate status must be pass or fail, not ${status}`);
  if (!BASES.has(basis)) throw new TypeError(`gate basis must be one of ${[...BASES].join(', ')}, not ${basis}`);
  return { status, basis, detail: detail === undefined ? null : detail };
}

const SIGNALS = {
  1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE',
  9: 'SIGKILL', 10: 'SIGUSR1', 11: 'SIGSEGV', 12: 'SIGUSR2', 13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM',
  24: 'SIGXCPU', 25: 'SIGXFSZ', 31: 'SIGSYS'
};

function signalName(exitCode) {
  const n = exitCode - 128;
  return SIGNALS[n] || `signal ${n}`;
}

/** The first non-empty line of what Docker printed, as a diagnostic only. */
function diagnostic(obs) {
  for (const head of [obs.stderrHead || '', obs.stdoutHead || '']) {
    const line = head.split(/\r?\n/).find((l) => l.trim());
    if (line) return line.trim().slice(0, 200);
  }
  return 'nothing';
}

function increased(before, after, key) {
  if (!before || !after) return false;
  if (!Number.isFinite(before[key]) || !Number.isFinite(after[key])) return false;
  return after[key] > before[key];
}

/**
 * Classify one `docker exec` of a step.
 *
 * Whether the step's command ran is decided by the start nonce (launcher.js),
 * never by the wording of Docker's errors: no nonce, no result. Docker's
 * output only goes into the detail of an abstain.
 *
 * @param {object} obs
 * @param {null|'step'|'run'|'deadline'|'cancel'} obs.killedBy - the runner ended it, and why
 * @param {string|null} obs.spawnError - the docker CLI could not be started
 * @param {boolean} obs.started - the launcher's `vcr-start <nonce>` line came first on stdout
 * @param {boolean} [obs.capped] - the runner stopped this read at its byte cap (no exit code)
 * @param {number|null} obs.exitCode - the CLI's exit code: the program's own once it started
 * @param {string|null} obs.cliSignal - the CLI died of a signal the runner did not send
 * @param {string} [obs.stdoutHead] - for the detail only
 * @param {string} [obs.stderrHead] - for the detail only
 * @param {null|{missing:true}|{running:boolean,oomKilled:boolean,exitCode:number,status:string}} obs.state
 *   the container after the step (`null` when inspect failed)
 * @param {null|'unreachable'|'error'} obs.inspectError
 * @param {{before:object|null, after:object|null}} obs.counters - cgroup oom_kill / pids max counters
 * @param {null|'pids_exhausted'|'unreachable'|'failed'} [obs.probe] - what went wrong with the counters probe
 * @param {'runsc'|'runc'} obs.runtime
 * @returns {{kind:'definitive', basis:'exit_code', exitCode:number} | {kind:'abstain', cause:string, detail:string}}
 */
function classifyExec(obs) {
  const abstain = (cause, detail) => ({ kind: 'abstain', cause, detail });

  switch (obs.killedBy) {
    case 'step': return abstain(ABSTAIN.STEP_TIMEOUT, 'the step reached its wall-clock limit and the sandbox was killed');
    case 'run': return abstain(ABSTAIN.STEP_TIMEOUT, 'the run reached its wall-clock limit (runSeconds) and the sandbox was killed');
    case 'deadline': return abstain(ABSTAIN.DEADLINE, 'the deadline was reached and the sandbox was killed');
    case 'cancel': return abstain(ABSTAIN.CANCELLED, 'the run was cancelled and the sandbox was killed');
    default: break;
  }
  if (obs.spawnError) return abstain(ABSTAIN.DOCKER_UNREACHABLE, `the docker CLI could not be started: ${obs.spawnError}`);
  if (obs.inspectError === 'unreachable') return abstain(ABSTAIN.DOCKER_UNREACHABLE, 'the Docker daemon stopped answering');
  if (obs.inspectError) return abstain(ABSTAIN.DOCKER_ERROR, 'the sandbox could not be inspected after the step');

  const state = obs.state;
  if (!state) return abstain(ABSTAIN.DOCKER_ERROR, 'the sandbox state is unknown after the step');
  if (state.missing) return abstain(ABSTAIN.SANDBOX_DIED, 'the sandbox vanished during the step');
  if (state.oomKilled) return abstain(ABSTAIN.OOM, 'the sandbox hit its memory limit (OOM kill)');

  const before = obs.counters && obs.counters.before;
  const after = obs.counters && obs.counters.after;
  if (increased(before, after, 'oomKill')) return abstain(ABSTAIN.OOM, 'a process in the sandbox was OOM-killed during the step');
  if (increased(before, after, 'pidsMax')) return abstain(ABSTAIN.PIDS_LIMIT, 'the sandbox hit its process limit during the step');
  if (obs.probe === 'pids_exhausted') return abstain(ABSTAIN.PIDS_LIMIT, 'the sandbox\'s process table is full: nothing more can start in it');
  if (obs.probe === 'unreachable') return abstain(ABSTAIN.DOCKER_UNREACHABLE, 'the Docker daemon stopped answering while the sandbox was probed');
  if (obs.probe === 'failed') return abstain(ABSTAIN.DOCKER_ERROR, 'the sandbox could not be probed after the step, so its limits were not checked');

  if (!state.running) {
    // gVisor takes the whole sandbox down at the process limit and exits 2
    // (verdikta-agents P0 evidence); the keepalive never exits 2 by itself.
    if (obs.runtime === 'runsc' && state.exitCode === 2) {
      return abstain(ABSTAIN.PIDS_LIMIT, 'the sandbox crashed, most likely at its process limit');
    }
    return abstain(ABSTAIN.SANDBOX_DIED, `the sandbox died during the step (exit ${state.exitCode})`);
  }

  if (obs.started !== true) {
    return abstain(ABSTAIN.STEP_NOT_STARTED,
      `the step's launcher never reported its start nonce, so its command did not run (Docker said: ${diagnostic(obs)})`);
  }

  // Started: what follows is the program's own.
  if (obs.capped) return { kind: 'definitive', basis: DEFINITIVE_BASIS.EXIT_CODE, exitCode: 0 };
  if (obs.cliSignal) return abstain(ABSTAIN.DOCKER_ERROR, `the docker CLI died of ${obs.cliSignal}`);
  const code = obs.exitCode;
  if (!Number.isInteger(code)) return abstain(ABSTAIN.DOCKER_ERROR, 'the step ended without an exit code');
  if (code === 137) return abstain(ABSTAIN.OOM, 'the step was killed with SIGKILL (exit 137), as the OOM killer does');
  if (code > 128) return abstain(ABSTAIN.KILLED_BY_SIGNAL, `the step died of ${signalName(code)} (exit ${code})`);
  return { kind: 'definitive', basis: DEFINITIVE_BASIS.EXIT_CODE, exitCode: code };
}

module.exports = { OUTCOME, ABSTAIN, DEFINITIVE_BASIS, Abstain, RequesterError, makeGate, classifyExec, signalName };
