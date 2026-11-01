'use strict';

/**
 * An in-process stand-in for the client src/docker.js creates. It records
 * every argv and answers by subcommand (`args[0]`). A handler returns
 * `{ exitCode, stdout, stderr, spawnError }` (or a promise of it); a handler
 * that never settles models a command that runs until the caller aborts it or
 * its timeout passes, which is how the deadline and step-timeout paths are
 * driven without Docker.
 */

const ABORTED = Symbol('aborted');
const TIMED_OUT = Symbol('timedOut');

function never() {
  return new Promise(() => {});
}

function healthyInfo(overrides = {}) {
  return JSON.stringify({
    ServerVersion: '28.0.4',
    OSType: 'linux',
    Architecture: 'x86_64',
    DockerRootDir: '/var/lib/docker',
    Runtimes: { runc: { path: 'runc' }, runsc: { path: '/opt/gvisor/runsc', runtimeArgs: ['--platform=systrap'] } },
    ...overrides
  });
}

function runningState(overrides = {}) {
  return JSON.stringify({ Status: 'running', Running: true, OOMKilled: false, ExitCode: 0, ...overrides });
}

const COUNTERS_ZERO = [
  '==> /sys/fs/cgroup/memory.events <==',
  'low 0', 'high 0', 'max 0', 'oom 0', 'oom_kill 0', 'oom_group_kill 0',
  '',
  '==> /sys/fs/cgroup/pids.events <==',
  'max 0',
  ''
].join('\n');

function isCountersRead(args) {
  return args[0] === 'exec' && args.includes('/sys/fs/cgroup/pids.events');
}

/**
 * The launcher (src/launcher.js) is emulated: an exec whose handler does not
 * return `started: false` gets `vcr-start <nonce>` first on stdout, as the
 * real launcher prints it before it execs the step's argv.
 */
function nonceOf(args) {
  const i = args.indexOf('vcr-launch');
  return i >= 0 ? args[i + 1] : null;
}

function withStart(res, nonce) {
  if (!res || res.spawnError || res.started === false || !nonce) return res;
  return { ...res, stdout: `vcr-start ${nonce}\n${res.stdout || ''}` };
}

/**
 * `docker image inspect` lines (src/images.js's format) for references that
 * are present: every one is an image of `platform` carrying that reference.
 */
function imageInspect(args, { present = () => true, platform = 'linux/amd64' } = {}) {
  const keys = args.slice(args.indexOf('--format') + 2);
  const [os, architecture] = platform.split('/');
  const lines = [];
  const missing = [];
  for (const key of keys) {
    if (!present(key)) { missing.push(key); continue; }
    const digest = key.includes('@') ? [key] : [];
    lines.push([JSON.stringify(`sha256:${Buffer.from(key).toString('hex').slice(0, 64).padEnd(64, '0')}`), JSON.stringify([]), JSON.stringify(digest),
      JSON.stringify(os), JSON.stringify(architecture), 'null', '1000'].join('\t'));
  }
  const stdout = lines.length ? `${lines.join('\n')}\n` : '';
  if (missing.length) return { exitCode: 1, stdout, stderr: missing.map((k) => `Error response from daemon: No such image: ${k}`).join('\n') };
  return { stdout };
}

/**
 * Handlers for a healthy daemon. `step` answers step execs; `counters` the
 * runner's counters probe; `launcherCheck` its launch-time launcher check.
 * Images (A1b): every reference is present unless `imagePresent` says not;
 * `pull` answers pulls (success by default).
 */
function healthyDaemon({ step, counters, launcherCheck, inspect, create, start, mounts, rm, info, ps, version, imagePresent, pull, image } = {}) {
  return {
    image: image || ((args) => (args[1] === 'inspect' ? imageInspect(args, { present: imagePresent || (() => true) }) : { stdout: '' })),
    pull: pull || (() => ({ stdout: '' })),
    container: () => ({ stdout: '' }),
    info: info || (() => ({ stdout: healthyInfo() })),
    version: version || (() => ({ stdout: '28.0.4\n' })),
    create: create || (() => ({ stdout: 'c0ffee\n' })),
    start: start || ((args) => ({ stdout: `${args[1]}\n` })),
    inspect: (args, opts, calls) => {
      if (args.some((a) => a.includes('.Mounts'))) {
        if (!mounts) return { stdout: '{"mounts":[],"readOnly":true}\n' };
        const r = mounts(args, opts, calls);
        // A handler may give just the mount list; the root is then read-only.
        if (r && typeof r.stdout === 'string' && r.stdout.trim().startsWith('[')) return { ...r, stdout: `{"mounts":${r.stdout.trim()},"readOnly":true}` };
        return r;
      }
      return inspect ? inspect(args, opts, calls) : { stdout: runningState() };
    },
    rm: rm || (() => ({ stdout: '' })),
    ps: ps || (() => ({ stdout: '' })),
    exec: (args, opts, calls) => {
      let res;
      if (args.includes('vcr-launcher-check')) res = launcherCheck ? launcherCheck(args, opts, calls) : { exitCode: 0 };
      else if (isCountersRead(args)) res = counters ? counters(args, opts, calls) : { stdout: COUNTERS_ZERO };
      else res = step ? step(args, opts, calls) : { exitCode: 0 };
      return Promise.resolve(res).then((r) => withStart(r, nonceOf(args)));
    }
  };
}

function fakeDocker(handlers = {}) {
  const calls = [];
  async function run(args, opts = {}) {
    const call = { args: [...args], stdin: opts.stdin ? Buffer.from(opts.stdin) : null, timeoutMs: opts.timeoutMs };
    calls.push(call);
    const handler = handlers[args[0]] || handlers.default;
    const base = { exitCode: 0, signal: null, timedOut: false, aborted: false, spawnError: null, durationMs: 0 };
    if (!handler) return base;
    const contenders = [Promise.resolve().then(() => handler(args, opts, calls))];
    let timer = null;
    let onAbort = null;
    if (opts.signal) {
      if (opts.signal.aborted) return { ...base, exitCode: null, signal: 'SIGKILL', aborted: true };
      contenders.push(new Promise((resolve) => {
        onAbort = () => resolve(ABORTED);
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }));
    }
    if (opts.timeoutMs) {
      contenders.push(new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), opts.timeoutMs); }));
    }
    const outcome = await Promise.race(contenders);
    if (timer) clearTimeout(timer);
    if (onAbort) opts.signal.removeEventListener('abort', onAbort);
    if (outcome === ABORTED) return { ...base, exitCode: null, signal: 'SIGKILL', aborted: true };
    if (outcome === TIMED_OUT) return { ...base, exitCode: null, signal: 'SIGKILL', timedOut: true };
    const res = outcome || {};
    if (res.spawnError) return { ...base, exitCode: null, spawnError: res.spawnError };
    if (res.stdout && opts.stdout) opts.stdout.write(Buffer.from(res.stdout));
    if (res.stderr && opts.stderr) opts.stderr.write(Buffer.from(res.stderr));
    return { ...base, exitCode: res.exitCode === undefined ? 0 : res.exitCode, signal: res.signal || null };
  }
  return {
    run,
    calls,
    commands: () => calls.map((c) => c.args[0]),
    callsOf: (sub) => calls.filter((c) => c.args[0] === sub)
  };
}

module.exports = { fakeDocker, healthyDaemon, healthyInfo, runningState, never, COUNTERS_ZERO, isCountersRead, nonceOf, imageInspect };
