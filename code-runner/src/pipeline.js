'use strict';

/**
 * The run engine (design §9.2 steps 1 and 10, §9.3, §11).
 *
 *   admit → launch the sandbox → steps, in order → tear down
 *
 * A step is an async function of a context (`ctx`) that runs commands in the
 * sandbox through ctx.exec / ctx.readFile and records gates with ctx.gate.
 * Node A1 ships the engine with no steps; A2a adds the patch gates, the build
 * and the PoC runs, A3a the integrity checks and the fix check (a second
 * sandbox from ctx.openSandbox), A3b the report.
 *
 * Every step is bounded three ways: its own limit (ctx.exec's timeoutMs),
 * the run's (runSeconds) and the deadline the EA passed in, less a reserve for
 * teardown and the response. Whichever comes first kills the sandbox and the
 * run abstains with that cause. Anything else that is not definitive (§9.3)
 * abstains too, and every sandbox is removed whatever happened.
 */

const { Sandbox } = require('./sandbox');
const { ABSTAIN, OUTCOME, Abstain, makeGate } = require('./result');
const { admitRun } = require('./admission');

/** Keepalive past the stop time, so a container outlives a dead runner only briefly. */
const KEEPALIVE_MARGIN_SECONDS = 30;
/** After a run-level kill, how long to let the step's exec report what it saw. */
const KILL_GRACE_MS = 1000;
/** The least time teardown is given before the run answers anyway. */
const TEARDOWN_MIN_MS = 2000;

const RUN_KILL_CAUSE = Object.freeze({
  run: [ABSTAIN.STEP_TIMEOUT, 'the run reached its wall-clock limit (runSeconds) and the sandbox was killed'],
  deadline: [ABSTAIN.DEADLINE, 'the deadline was reached and the sandbox was killed'],
  cancel: [ABSTAIN.CANCELLED, 'the run was cancelled and the sandbox was killed']
});

const nullLog = { info() {}, warn() {}, error() {}, debug() {} };

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute one run.
 *
 * @param {object} o
 * @param {object} o.docker - a client from createDocker()
 * @param {object} o.config - loaded config (runtime, instance, deadlineReserveMs, maintenanceFile)
 * @param {object} o.limits - effective limits from checkSpec()
 * @param {string} o.image - the env image, pinned by digest
 * @param {string} o.runId - 16 hex characters
 * @param {Function[]} [o.steps] - async (ctx) => void
 * @param {number} o.receivedAt - when the request arrived, epoch ms
 * @param {number} o.deadlineAt - the EA's deadline, epoch ms
 * @param {AbortSignal} [o.signal] - aborted when the caller goes away
 * @param {Set<string>} o.active - container names of live runs (the GC leaves these alone)
 * @param {Function} [o.admit] - admission (default admitRun)
 * @returns {Promise<object>} the run result; never rejects
 */
async function executeRun({
  docker, config, limits, image, runId, steps = [], receivedAt = Date.now(), deadlineAt,
  signal, active, log = nullLog, admit = admitRun
}) {
  const stopAt = deadlineAt - (config.deadlineReserveMs || 0);
  const result = {
    outcome: OUTCOME.DEFINITIVE,
    runId,
    runtime: config.runtime,
    limits,
    abstain: null,
    steps: [],
    gates: {}
  };
  const abstainWith = (err) => {
    result.outcome = OUTCOME.ABSTAIN;
    result.abstain = { cause: err.cause, step: err.step || null, detail: err.detail };
    return result;
  };
  const asAbstain = (err, step) => (err instanceof Abstain
    ? err
    : new Abstain(ABSTAIN.RUNNER_ERROR, `the runner failed: ${err && err.message ? err.message : String(err)}`, { step }));

  if (signal && signal.aborted) return abstainWith(new Abstain(ABSTAIN.CANCELLED, 'the run was cancelled before it started'));
  try {
    await admit({ config, docker, limits, stopAt, now: Date.now(), signal });
  } catch (err) {
    return abstainWith(asAbstain(err, 'admission'));
  }

  // Run-level kill switch: the deadline, the run budget, the caller.
  const run = new AbortController();
  const sandboxes = [];
  // The steps in flight (the fix check may run beside the PoC, §11), for
  // naming the step a run-level kill interrupted.
  const running = new Set();
  const current = () => (running.size ? [...running].join(', ') : null);
  const kill = (reason) => {
    if (run.signal.aborted) return;
    run.abort(reason);
    for (const sb of sandboxes) sb.kill();
  };
  const timers = [
    setTimeout(() => kill('deadline'), Math.max(0, stopAt - Date.now())),
    setTimeout(() => kill('run'), limits.runSeconds * 1000)
  ];
  const onCancel = () => kill('cancel');
  if (signal) signal.addEventListener('abort', onCancel, { once: true });
  const killed = new Promise((_, reject) => {
    run.signal.addEventListener('abort', () => {
      const [cause, detail] = RUN_KILL_CAUSE[run.signal.reason];
      reject(new Abstain(cause, detail, { step: current() }));
    }, { once: true });
  });
  killed.catch(() => {});

  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const keepaliveSeconds = Math.max(1, Math.ceil((stopAt - Date.now()) / 1000)) + KEEPALIVE_MARGIN_SECONDS;
  const expiresAt = nowSeconds() + keepaliveSeconds;

  function stopped(stepName) {
    if (!run.signal.aborted) return null;
    const [cause, detail] = RUN_KILL_CAUSE[run.signal.reason];
    return new Abstain(cause, detail, { step: stepName });
  }

  async function open() {
    const name = `vcr-${runId}-${sandboxes.length + 1}`;
    const sb = new Sandbox({ docker, name, runtime: config.runtime, log });
    // Registered before `docker run`, so the GC never races a launch and the
    // teardown removes a half-created container.
    active.add(name);
    sandboxes.push(sb);
    const late = stopped('launch');
    if (late) throw late;
    const label = sandboxes.length === 1 ? 'launch' : `launch:${name}`;
    running.add(label);
    try {
      await sb.launch({ image, limits, instance: config.instance, runId, expiresAt, keepaliveSeconds }, { signal: run.signal });
    } finally {
      running.delete(label);
    }
    return handle(sb);
  }

  function handle(sb) {
    return {
      name: sb.name,
      /**
       * Run argv in the sandbox. Resolves the step record of a definitive
       * exec; throws Abstain otherwise (the run then abstains).
       * @param {string[]} argv
       * @param {{name:string, timeoutMs?:number, stdin?:Buffer, env?:object, workdir?:string}} o
       */
      async exec(argv, { name, timeoutMs, stdin, env, workdir } = {}) {
        const stepName = name || argv[0];
        const late = stopped(stepName);
        if (late) throw late;
        running.add(stepName);
        const step = new AbortController();
        const forward = () => step.abort(run.signal.reason);
        run.signal.addEventListener('abort', forward, { once: true });
        const timer = Number.isFinite(timeoutMs) ? setTimeout(() => step.abort('step'), Math.max(0, timeoutMs)) : null;
        try {
          const { record, verdict } = await sb.exec(argv, { name: stepName, signal: step.signal, controlSignal: run.signal, stdin, env, workdir });
          result.steps.push(record);
          if (verdict.kind !== 'definitive') throw new Abstain(verdict.cause, verdict.detail, { step: stepName });
          return record;
        } finally {
          if (timer) clearTimeout(timer);
          run.signal.removeEventListener('abort', forward);
          running.delete(stepName);
        }
      },
      /**
       * Read a file inside the sandbox, at most maxBytes of it.
       * @returns {Promise<{bytes:Buffer, overLimit:boolean, exitCode:number|null}>}
       */
      async readFile(filePath, { maxBytes, name, timeoutMs } = {}) {
        const stepName = name || `read:${filePath}`;
        const late = stopped(stepName);
        if (late) throw late;
        running.add(stepName);
        const step = new AbortController();
        const forward = () => step.abort(run.signal.reason);
        run.signal.addEventListener('abort', forward, { once: true });
        const timer = Number.isFinite(timeoutMs) ? setTimeout(() => step.abort('step'), Math.max(0, timeoutMs)) : null;
        try {
          const r = await sb.readFile(filePath, { maxBytes, name: stepName, signal: step.signal, controlSignal: run.signal });
          result.steps.push(r.record);
          if (r.verdict.kind !== 'definitive') throw new Abstain(r.verdict.cause, r.verdict.detail, { step: stepName });
          return { bytes: r.bytes, overLimit: r.overLimit, exitCode: r.record.exitCode };
        } finally {
          if (timer) clearTimeout(timer);
          run.signal.removeEventListener('abort', forward);
          running.delete(stepName);
        }
      }
    };
  }

  const work = (async () => {
    const primary = await open();
    const ctx = {
      runId,
      limits,
      sandboxName: primary.name,
      exec: primary.exec,
      readFile: primary.readFile,
      /** Another sandbox with the same flags (the fix check, §9.2 step 8). */
      openSandbox: () => open(),
      /** Record a gate decided on a definitive basis (exit_code, junit, integrity). */
      gate(name, status, basis, detail) {
        result.gates[name] = makeGate(status, basis, detail);
      },
      /** Milliseconds until the run must stop. */
      remainingMs: () => Math.max(0, stopAt - Date.now()),
      /** When the request arrived (epoch ms). */
      receivedAt
    };
    for (const step of steps) {
      const late = stopped(null);
      if (late) throw late;
      await step(ctx);
    }
  })();
  work.catch(() => {});

  try {
    await Promise.race([work, killed]);
  } catch (err) {
    abstainWith(asAbstain(err, current()));
    if (run.signal.aborted) {
      // Give the killed exec a moment to report what it saw.
      await Promise.race([work.catch(() => {}), delay(KILL_GRACE_MS)]);
    }
  } finally {
    for (const t of timers) clearTimeout(t);
    if (signal) signal.removeEventListener('abort', onCancel);
    // Remove every sandbox. The answer waits for that until the deadline
    // (at least TEARDOWN_MIN_MS); a removal still hanging then carries on in
    // the background, and the GC retries whatever it could not remove.
    const removal = Promise.all(sandboxes.map(async (sb) => {
      let gone = false;
      try {
        gone = await sb.remove();
      } catch (_) {
        gone = false;
      }
      if (!gone) log.warn('sandbox not removed; the GC will retry', { runId, container: sb.name });
      active.delete(sb.name);
    }));
    let timer = null;
    const finished = await Promise.race([
      removal.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), Math.max(TEARDOWN_MIN_MS, deadlineAt - Date.now())); })
    ]);
    clearTimeout(timer);
    if (!finished) log.warn('teardown still running at the deadline; answering now', { runId });
  }
  return result;
}

module.exports = { executeRun, KEEPALIVE_MARGIN_SECONDS };
