'use strict';

/**
 * The container-launch module (design §9.1). Every argv the runner hands to
 * Docker for a sandbox is built here, from validated values only: the image
 * reference (pinned by digest), the configured runtime, and the effective
 * numeric limits. Nothing else from a spec or a claim reaches these argv, so a
 * spec cannot add, drop or weaken a flag.
 *
 * A sandbox is one fresh container per check: `docker run --detach` with a
 * keepalive (`sleep`, our entrypoint, not the image's) under `--init`, then
 * each step through `docker exec` with an argv array. The keepalive's length
 * ends the container shortly after the deadline even if the runner dies, and
 * the labels let the GC find anything a crash left behind.
 */

const { IMAGE_REF, CLASS_HARD_LIMITS, OCI_PLATFORM } = require('./classLimits');
const { runText, isUnreachableText } = require('./docker');
const { HeadTail, Capped } = require('./capture');
const { ABSTAIN, Abstain, RequesterError, classifyExec } = require('./result');

/** The non-root user every sandbox process runs as. The env builder gives the repository to this uid. */
const SANDBOX_USER = '10001:10001';
const SANDBOX_HOSTNAME = 'sandbox';
/** Fixed environment (§9.3): never the host's. */
const SANDBOX_ENV = Object.freeze({ TZ: 'UTC', LANG: 'C.UTF-8', CI: 'true', PYTHONHASHSEED: '0' });
const RUNTIMES = Object.freeze(['runsc', 'runc']);
/** linux/amd64 is the class platform; linux/arm64 exists for runc development on Apple silicon. */
const PLATFORMS = Object.freeze([OCI_PLATFORM, 'linux/arm64']);

const LABEL = 'verdikta.code-runner';
const LABEL_INSTANCE = `${LABEL}.instance`;
const LABEL_RUN = `${LABEL}.run`;
const LABEL_EXPIRES = `${LABEL}.expires`;

const NAME = /^vcr-[0-9a-f]{16}-[0-9]{1,3}$/;
const RUN_ID = /^[0-9a-f]{16}$/;
const INSTANCE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** cgroup v2 and v1 files with the OOM-kill and fork-refusal counters. */
const COUNTER_FILES = Object.freeze([
  '/sys/fs/cgroup/memory.events',
  '/sys/fs/cgroup/pids.events',
  '/sys/fs/cgroup/memory/memory.oom_control',
  '/sys/fs/cgroup/pids/pids.events'
]);

/** docker exec could not start a process in the sandbox (as opposed to the process failing). */
const PROBE_START_FAILED = /OCI runtime exec failed|unable to start container process|resource temporarily unavailable|cannot fork|EAGAIN/i;

const LAUNCH_TIMEOUT_MS = 120000;
const CONTROL_TIMEOUT_MS = 15000;
const REMOVE_TIMEOUT_MS = 60000;
/** After a step that may have killed the sandbox, how long to wait for Docker to notice. */
const SETTLE_MS = 3000;

function positiveInt(v, max, what) {
  if (!Number.isInteger(v) || v < 1 || (max !== undefined && v > max)) {
    throw new TypeError(`${what} must be an integer from 1 to ${max === undefined ? 'any' : max}, got ${JSON.stringify(v)}`);
  }
  return v;
}

function checkName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError(`invalid sandbox name ${JSON.stringify(name)}`);
  return name;
}

function noNul(s) {
  return typeof s === 'string' && !s.includes('\0');
}

/**
 * The exact `docker create` argv of a sandbox (started with startArgs once
 * its mounts are checked).
 * @param {object} o
 * @param {string} o.name - vcr-<runId>-<n>
 * @param {string} o.image - name@sha256:<digest>
 * @param {'runsc'|'runc'} o.runtime - from the runner's config, never the spec
 * @param {string} [o.platform] - the OCI platform to run (the class's linux/amd64; linux/arm64 only in runc development)
 * @param {{cpus:number, memoryMb:number, pids:number}} o.limits - effective limits (within the class maxima)
 * @param {string} o.instance - the runner instance label (GC scope)
 * @param {string} o.runId
 * @param {number} o.expiresAt - epoch seconds after which the GC may remove it
 * @param {number} o.keepaliveSeconds - the container stops on its own after this
 */
function createArgs({ name, image, runtime, platform = OCI_PLATFORM, limits, instance, runId, expiresAt, keepaliveSeconds }) {
  checkName(name);
  if (typeof image !== 'string' || !IMAGE_REF.test(image)) throw new TypeError(`image must be pinned by digest, got ${JSON.stringify(image)}`);
  if (!RUNTIMES.includes(runtime)) throw new TypeError(`runtime must be one of ${RUNTIMES.join(', ')}, got ${JSON.stringify(runtime)}`);
  if (typeof instance !== 'string' || !INSTANCE.test(instance)) throw new TypeError(`invalid instance ${JSON.stringify(instance)}`);
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new TypeError(`invalid run id ${JSON.stringify(runId)}`);
  if (!limits || typeof limits !== 'object') throw new TypeError('limits are required');
  const cpus = positiveInt(limits.cpus, CLASS_HARD_LIMITS.cpus, 'cpus');
  const memoryMb = positiveInt(limits.memoryMb, CLASS_HARD_LIMITS.memoryMb, 'memoryMb');
  const pids = positiveInt(limits.pids, CLASS_HARD_LIMITS.pids, 'pids');
  if (!PLATFORMS.includes(platform)) throw new TypeError(`platform must be one of ${PLATFORMS.join(', ')}, got ${JSON.stringify(platform)}`);
  positiveInt(expiresAt, undefined, 'expiresAt');
  positiveInt(keepaliveSeconds, undefined, 'keepaliveSeconds');

  const env = Object.entries(SANDBOX_ENV).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  return [
    'create', '--pull', 'never',
    '--platform', platform,
    '--name', name,
    '--label', `${LABEL}=1`,
    '--label', `${LABEL_INSTANCE}=${instance}`,
    '--label', `${LABEL_RUN}=${runId}`,
    '--label', `${LABEL_EXPIRES}=${expiresAt}`,
    '--runtime', runtime,
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', SANDBOX_USER,
    '--pids-limit', String(pids),
    '--memory', `${memoryMb}m`,
    '--memory-swap', `${memoryMb}m`,
    '--cpus', String(cpus),
    '--hostname', SANDBOX_HOSTNAME,
    ...env,
    '--log-driver', 'none',
    '--init',
    '--entrypoint', 'sleep',
    image,
    String(keepaliveSeconds)
  ];
}

/**
 * The exact `docker exec` argv of a step. The step's argv follows the
 * container name, where Docker treats it as the command and its arguments,
 * never as options; inside the sandbox it is executed as given, with no shell
 * unless the step itself names one.
 */
function execArgs({ name, argv, stdin = false, env = {}, workdir = null }) {
  checkName(name);
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(noNul)) {
    throw new TypeError('argv must be a non-empty array of strings without NUL');
  }
  const envFlags = [];
  for (const [k, v] of Object.entries(env || {})) {
    if (!ENV_KEY.test(k) || !noNul(v)) throw new TypeError(`invalid env entry ${JSON.stringify(k)}`);
    envFlags.push('--env', `${k}=${v}`);
  }
  if (workdir !== null && (!noNul(workdir) || !workdir.startsWith('/'))) {
    throw new TypeError(`workdir must be an absolute path, got ${JSON.stringify(workdir)}`);
  }
  return [
    'exec',
    ...(stdin ? ['--interactive'] : []),
    '--user', SANDBOX_USER,
    ...envFlags,
    ...(workdir ? ['--workdir', workdir] : []),
    name,
    ...argv
  ];
}

function startArgs(name) {
  return ['start', checkName(name)];
}

/** Removes the containers and their anonymous volumes, if any were made. */
function removeArgs(names) {
  if (!Array.isArray(names) || names.length === 0) throw new TypeError('names are required');
  return ['rm', '--force', '--volumes', ...names.map(checkName)];
}

/** Parse `head -n 20 <COUNTER_FILES>` output into { oomKill, pidsMax }. */
function parseCounters(text) {
  const out = { oomKill: null, pidsMax: null };
  let file = null;
  for (const line of String(text || '').split('\n')) {
    const header = /^==> (.+) <==$/.exec(line);
    if (header) { file = header[1]; continue; }
    const kv = /^(\S+)\s+(\d+)$/.exec(line.trim());
    if (!kv || !file) continue;
    const n = Number(kv[2]);
    if (kv[1] === 'oom_kill' && /memory/.test(file)) out.oomKill = (out.oomKill || 0) + n;
    if (kv[1] === 'max' && /pids/.test(file)) out.pidsMax = (out.pidsMax || 0) + n;
  }
  return out.oomKill === null && out.pidsMax === null ? null : out;
}

function parseState(text) {
  const s = JSON.parse(text);
  return { running: Boolean(s.Running), oomKilled: Boolean(s.OOMKilled), exitCode: Number(s.ExitCode), status: String(s.Status || '') };
}

function within(ms, signal) {
  return { timeoutMs: ms, signal };
}

/** Why a run-level or step-level abort happened, as an Abstain cause. */
const KILL_CAUSE = Object.freeze({
  step: ABSTAIN.STEP_TIMEOUT,
  run: ABSTAIN.STEP_TIMEOUT,
  deadline: ABSTAIN.DEADLINE,
  cancel: ABSTAIN.CANCELLED
});

/** step | run | deadline | cancel: an abort with any other reason is a cancellation. */
function killReason(signal) {
  const r = signal.reason;
  return typeof r === 'string' && Object.prototype.hasOwnProperty.call(KILL_CAUSE, r) ? r : 'cancel';
}

class Sandbox {
  /**
   * @param {object} o
   * @param {object} o.docker - a client from createDocker()
   * @param {string} o.name
   * @param {'runsc'|'runc'} o.runtime
   */
  constructor({ docker, name, runtime, log }) {
    this.docker = docker;
    this.name = checkName(name);
    this.runtime = runtime;
    this.log = log;
    this.counters = null;
    this.killing = null;
    this.launched = false;
    this.pidsLimit = null;
  }

  /**
   * Start the container. Throws Abstain (step `launch`) when it cannot.
   * @param {object} spec - createArgs() input minus name and runtime
   * @param {{signal?:AbortSignal}} [o]
   */
  async launch(spec, { signal } = {}) {
    const fail = (r) => {
      if (r.aborted && signal) return new Abstain(KILL_CAUSE[killReason(signal)], 'stopped while the sandbox was starting', { step: 'launch' });
      return new Abstain(...launchFailure(r), { step: 'launch' });
    };
    const created = await runText(this.docker, createArgs({ ...spec, name: this.name, runtime: this.runtime }), within(LAUNCH_TIMEOUT_MS, signal));
    if (created.exitCode !== 0) throw fail(created);
    // No mount of any kind, including the anonymous volumes an image's
    // VOLUME lines would give it: those would sit outside the capped scratch
    // layer. Checked before anything runs in the container.
    const mounts = await runText(this.docker, ['inspect', '--type', 'container', '--format', '{{json .Mounts}}', this.name], within(CONTROL_TIMEOUT_MS, signal));
    if (mounts.exitCode !== 0) throw fail(mounts);
    let list;
    try {
      list = JSON.parse(mounts.stdout);
    } catch (_) {
      throw new Abstain(ABSTAIN.DOCKER_ERROR, 'the sandbox\'s mounts could not be read', { step: 'launch' });
    }
    if (Array.isArray(list) && list.length > 0) {
      const where = list.map((m) => (m && m.Destination) || '?').join(', ');
      throw new RequesterError([{ code: 'IMAGE_DECLARES_VOLUMES', path: '/spec/env/image', detail: `the env image declares volumes (${where}); an env image may not` }]);
    }
    const started = await runText(this.docker, startArgs(this.name), within(LAUNCH_TIMEOUT_MS, signal));
    if (started.exitCode !== 0) throw fail(started);
    this.launched = true;
    this.pidsLimit = spec.limits.pids;
    this.counters = await this.readCounters({ signal });
    return this;
  }

  /**
   * Run one step. Returns `{ record, verdict }`; never throws for anything
   * the step or the sandbox did.
   *
   * @param {string[]} argv
   * @param {object} o
   * @param {string} o.name - the step's name in the result
   * @param {AbortSignal} o.signal - aborted with reason step|run|deadline|cancel to kill the sandbox
   * @param {AbortSignal} [o.controlSignal] - bounds the follow-up inspection
   * @param {Buffer} [o.stdin]
   * @param {object} [o.env]
   * @param {string} [o.workdir]
   * @param {{write(Buffer):boolean}} [o.stdoutSink] - instead of the 32 KiB head/tail log
   */
  async exec(argv, { name, signal, controlSignal, stdin, env, workdir, stdoutSink } = {}) {
    const args = execArgs({ name: this.name, argv, stdin: Boolean(stdin), env, workdir });
    const stdout = new HeadTail();
    const stderr = new HeadTail();
    const onAbort = () => { this.kill(); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const started = Date.now();
    let r;
    try {
      r = await this.docker.run(args, {
        signal,
        stdin,
        stdout: stdoutSink ? { write: (c) => stdout.write(c) && stdoutSink.write(c) } : stdout,
        stderr
      });
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    const durationMs = Date.now() - started;
    const killedBy = signal && signal.aborted ? killReason(signal) : null;
    const obs = {
      killedBy,
      spawnError: r.spawnError,
      exitCode: r.exitCode,
      cliSignal: r.signal && !r.aborted && !r.timedOut ? r.signal : null,
      stderrHead: stderr.snapshot().head.subarray(0, 4096).toString('utf8'),
      state: null,
      inspectError: null,
      counters: { before: this.counters, after: null },
      probe: null,
      probeDetail: null,
      runtime: this.runtime
    };
    if (!killedBy && stdoutSink && stdoutSink.overLimit) {
      // The runner stopped the read at its cap (that is the fact recorded);
      // the sandbox must still be sound for it to count.
      obs.exitCode = 0;
      obs.cliSignal = null;
    }
    if (!killedBy && !r.spawnError) await this.observe(obs, obs.exitCode, controlSignal);
    const verdict = classifyExec(obs);
    const record = {
      name,
      outcome: verdict.kind,
      exitCode: Number.isInteger(r.exitCode) ? r.exitCode : null,
      durationMs,
      stdout: stdout.toJSON(),
      stderr: stderr.toJSON(),
      ...(verdict.kind === 'abstain' ? { cause: verdict.cause, detail: verdict.detail } : {}),
      ...(obs.probeDetail ? { probe: obs.probeDetail } : {})
    };
    return { record, verdict };
  }

  /** Fill in the sandbox's state and counters after a step. */
  async observe(obs, exitCode, signal) {
    let { state, inspectError } = await this.inspect({ signal });
    // A sandbox that dies mid-command can make `docker exec` return before
    // Docker marks the container exited (verdikta-agents sandbox-kit); give
    // it a moment when the exit code says something may have gone wrong.
    if (state && state.running && !state.oomKilled && (exitCode === null || exitCode > 128)) {
      const until = Date.now() + SETTLE_MS;
      while (Date.now() < until && state && state.running && !(signal && signal.aborted)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        ({ state, inspectError } = await this.inspect({ signal }));
      }
    }
    obs.state = state;
    obs.inspectError = inspectError;
    if (state && state.running) {
      const read = await this.probeCounters({ signal });
      obs.counters.after = read.counters;
      if (read.counters) this.counters = read.counters;
      if (read.outcome === 'start_failed') {
        // Not even the probe could start in the sandbox. Processes a step
        // left behind can hold the whole pid table (runc's exec forks into
        // the container's cgroup), so ask Docker how many there are.
        const pids = await this.pidsInUse({ signal });
        obs.probe = pids !== null && pids >= this.pidsLimit - 1 ? 'pids_exhausted' : 'failed';
      } else if (read.outcome === 'unreachable' || read.outcome === 'failed') {
        obs.probe = read.outcome;
      }
      if (obs.probe) obs.probeDetail = read.error;
    }
  }

  async inspect({ signal } = {}) {
    const r = await runText(this.docker, ['inspect', '--type', 'container', '--format', '{{json .State}}', this.name], within(CONTROL_TIMEOUT_MS, signal));
    if (r.spawnError || isUnreachableText(r.stderr)) return { state: null, inspectError: 'unreachable' };
    if (r.exitCode !== 0) {
      if (/No such (object|container)/i.test(r.stderr)) return { state: { missing: true }, inspectError: null };
      return { state: null, inspectError: 'error' };
    }
    try {
      return { state: parseState(r.stdout), inspectError: null };
    } catch (_) {
      return { state: null, inspectError: 'error' };
    }
  }

  /**
   * Read the cgroup counters from inside the sandbox.
   * `outcome`: `ok` (counters read, or the files are simply absent, as under
   * gVisor), `start_failed` (the probe process could not start in the
   * sandbox), `unreachable` (the daemon did not answer) or `failed`
   * (anything else: the check did not happen, so the step cannot count).
   */
  async probeCounters({ signal } = {}) {
    const r = await runText(this.docker, execArgs({ name: this.name, argv: ['head', '-n', '20', ...COUNTER_FILES] }), within(CONTROL_TIMEOUT_MS, signal));
    // The CLI can print its own failure on stdout (seen on GitHub's runners:
    // "OCI runtime exec failed: ... unable to spawn stage-1: Resource
    // temporarily unavailable", exit 128), so look at both streams.
    const said = `${r.stdout}\n${r.stderr}`;
    const firstLine = (re) => (said.split(/\r?\n/).find((l) => re.test(l)) || said.trim().split(/\r?\n/)[0] || '').slice(0, 300);
    if (r.spawnError) return { outcome: 'unreachable', counters: null, error: r.spawnError };
    if (r.timedOut || r.aborted) return { outcome: 'failed', counters: null, error: 'the counters probe did not finish' };
    if (isUnreachableText(said)) return { outcome: 'unreachable', counters: null, error: firstLine(/Docker daemon|connect/i) };
    const counters = parseCounters(r.stdout);
    if (counters) return { outcome: 'ok', counters, error: null };
    if (PROBE_START_FAILED.test(said)) return { outcome: 'start_failed', counters: null, error: firstLine(PROBE_START_FAILED) };
    // `head` ran and found none of the files: nothing to count with (gVisor).
    const complaints = r.stderr.split(/\r?\n/).filter((l) => l.trim());
    if (r.exitCode === 0 || (complaints.length > 0 && complaints.every((l) => /No such file or directory/.test(l)))) {
      return { outcome: 'ok', counters: null, error: null };
    }
    return { outcome: 'failed', counters: null, error: firstLine(/./) };
  }

  async readCounters({ signal } = {}) {
    const read = await this.probeCounters({ signal });
    if (read.outcome === 'ok') return read.counters;
    throw new Abstain(read.outcome === 'unreachable' ? ABSTAIN.DOCKER_UNREACHABLE : ABSTAIN.DOCKER_ERROR,
      `the sandbox could not be probed after it started: ${read.error}`, { step: 'launch' });
  }

  /** The number of tasks in the sandbox, as Docker counts them (`docker stats`). */
  async pidsInUse({ signal } = {}) {
    const r = await runText(this.docker, ['stats', '--no-stream', '--format', '{{.PIDs}}', this.name], within(CONTROL_TIMEOUT_MS, signal));
    const n = Number(String(r.stdout).trim());
    return r.exitCode === 0 && Number.isInteger(n) ? n : null;
  }

  /**
   * Read a file inside the sandbox with `cat`, keeping at most `maxBytes`
   * (the read stops there). Returns the step record, the verdict and
   * `{ bytes, overLimit }`.
   */
  async readFile(filePath, { maxBytes, signal, controlSignal, name } = {}) {
    if (!noNul(filePath) || !filePath.startsWith('/')) throw new TypeError(`path must be absolute, got ${JSON.stringify(filePath)}`);
    if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a non-negative integer');
    const sink = new Capped(maxBytes);
    const { record, verdict } = await this.exec(['cat', '--', filePath], { name: name || `read:${filePath}`, signal, controlSignal, stdoutSink: sink });
    record.stdout = { text: '', totalBytes: sink.totalBytes, omittedBytes: 0 };
    return { record, verdict, bytes: sink.bytes(), overLimit: sink.overLimit };
  }

  /** Start removing the container now (idempotent). */
  kill() {
    if (!this.killing) {
      this.killing = runText(this.docker, removeArgs([this.name]), { timeoutMs: REMOVE_TIMEOUT_MS }).catch(() => null);
    }
    return this.killing;
  }

  /** Remove the container (and any anonymous volume) and wait. Resolves true when it is gone. */
  async remove() {
    if (this.killing) await this.killing;
    const r = await runText(this.docker, removeArgs([this.name]), { timeoutMs: REMOVE_TIMEOUT_MS });
    return r.exitCode === 0 || /No such container/i.test(r.stderr);
  }
}

function launchFailure(r) {
  const text = r.stderr || '';
  const first = text.split('\n').find((l) => l.trim()) || '';
  if (r.spawnError) return [ABSTAIN.DOCKER_UNREACHABLE, `the docker CLI could not be started: ${r.spawnError}`];
  if (isUnreachableText(text)) return [ABSTAIN.DOCKER_UNREACHABLE, 'the Docker daemon could not be reached'];
  if (r.timedOut) return [ABSTAIN.DOCKER_ERROR, 'docker run did not return in time'];
  if (/No such image|manifest unknown|pull access denied/i.test(text)) {
    return [ABSTAIN.IMAGE_UNAVAILABLE, 'the env image is not on the runner\'s disk (the runner never pulls implicitly)'];
  }
  return [ABSTAIN.DOCKER_ERROR, `the sandbox did not start: ${first.slice(0, 300)}`];
}

module.exports = {
  SANDBOX_USER,
  SANDBOX_HOSTNAME,
  SANDBOX_ENV,
  RUNTIMES,
  PLATFORMS,
  LABEL,
  LABEL_INSTANCE,
  LABEL_RUN,
  LABEL_EXPIRES,
  NAME,
  COUNTER_FILES,
  createArgs,
  startArgs,
  execArgs,
  removeArgs,
  parseCounters,
  Sandbox
};
