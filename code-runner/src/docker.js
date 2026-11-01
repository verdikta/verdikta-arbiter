'use strict';

/**
 * The one place the runner starts a process: the docker CLI, with an argv
 * array and `shell: false` (design §9.1: "drives Docker with argv arrays,
 * never a shell"). Claim content never becomes a host command; it reaches the
 * sandbox as stdin of `docker exec`.
 *
 * The child environment is an allow-list. Nothing else the runner's process
 * holds (its bearer token, anything an operator exported) reaches Docker or a
 * container. DOCKER_CONFIG points at the runner's own empty directory, so the
 * CLI never reads the operator's registry credentials either.
 */

const { spawn } = require('node:child_process');
const { Capped } = require('./capture');

const PASS_THROUGH = ['PATH', 'HOME', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'];

/** Control commands (inspect, info, ps, rm) never need more than this. */
const CONTROL_OUTPUT_BYTES = 1024 * 1024;

const UNREACHABLE = /Cannot connect to the Docker daemon|error during connect|permission denied while trying to connect to the Docker daemon|dial unix .*: connect:/i;

function isUnreachableText(text) {
  return UNREACHABLE.test(text || '');
}

function dockerChildEnv({ baseEnv = process.env, dockerHost = null, dockerConfigDir }) {
  const env = {};
  for (const key of PASS_THROUGH) {
    if (typeof baseEnv[key] === 'string' && baseEnv[key] !== '') env[key] = baseEnv[key];
  }
  if (dockerHost) env.DOCKER_HOST = dockerHost;
  else {
    delete env.DOCKER_TLS_VERIFY;
    delete env.DOCKER_CERT_PATH;
  }
  if (dockerConfigDir) env.DOCKER_CONFIG = dockerConfigDir;
  return env;
}

/**
 * @param {object} opts
 * @param {string} [opts.bin] - the docker CLI
 * @param {string|null} [opts.dockerHost] - DOCKER_HOST from the config (null: the CLI default)
 * @param {string} [opts.dockerConfigDir] - the runner's own DOCKER_CONFIG
 * @param {object} [opts.baseEnv] - where PATH and HOME come from
 */
function createDocker({ bin = 'docker', dockerHost = null, dockerConfigDir, baseEnv = process.env, spawnImpl = spawn } = {}) {
  const env = dockerChildEnv({ baseEnv, dockerHost, dockerConfigDir });

  /**
   * Run `docker <args>`. Never throws.
   *
   * @param {string[]} args
   * @param {object} [o]
   * @param {number} [o.timeoutMs] - kill the CLI after this long
   * @param {AbortSignal} [o.signal] - kill the CLI when aborted
   * @param {Buffer} [o.stdin] - bytes for its stdin (else stdin is closed)
   * @param {{write(Buffer):boolean}} [o.stdout] - sink; a false return stops the CLI
   * @param {{write(Buffer):boolean}} [o.stderr] - sink
   * @returns {Promise<{exitCode:number|null, signal:string|null, timedOut:boolean, aborted:boolean, spawnError:string|null, durationMs:number}>}
   */
  function run(args, { timeoutMs, signal, stdin, stdout, stderr } = {}) {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      return Promise.reject(new TypeError('docker args must be an array of strings'));
    }
    const started = Date.now();
    return new Promise((resolve) => {
      let child;
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let timer = null;
      const finish = (res) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve({ timedOut, aborted, durationMs: Date.now() - started, ...res });
      };
      const kill = () => {
        try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      };
      const onAbort = () => { aborted = true; kill(); };

      if (signal && signal.aborted) {
        aborted = true;
        finish({ exitCode: null, signal: null, spawnError: null });
        return;
      }
      try {
        child = spawnImpl(bin, args, {
          env,
          shell: false,
          windowsHide: true,
          stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe']
        });
      } catch (err) {
        finish({ exitCode: null, signal: null, spawnError: err.message });
        return;
      }
      child.on('error', (err) => finish({ exitCode: null, signal: null, spawnError: err.message }));
      child.on('close', (code, sig) => finish({ exitCode: code, signal: sig, spawnError: null }));
      const pipe = (stream, sink) => {
        stream.on('data', (chunk) => {
          if (sink && sink.write(chunk) === false) kill();
        });
      };
      pipe(child.stdout, stdout);
      pipe(child.stderr, stderr);
      if (stdin) {
        child.stdin.on('error', () => { /* the command stopped reading */ });
        child.stdin.end(stdin);
      }
      if (timeoutMs !== undefined && timeoutMs !== null) {
        timer = setTimeout(() => { timedOut = true; kill(); }, Math.max(0, timeoutMs));
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  return { run, env: Object.freeze({ ...env }) };
}

/**
 * Run a control command and return its output as text, capped.
 * @returns {Promise<object>} run()'s result plus stdout, stderr (strings) and
 *   stdoutOverLimit.
 */
async function runText(docker, args, { maxBytes = CONTROL_OUTPUT_BYTES, ...opts } = {}) {
  const out = new Capped(maxBytes);
  const err = new Capped(64 * 1024);
  // Keep reading past the cap: only the bytes kept are bounded, and stopping
  // the CLI here would turn a long answer into a failure.
  const sink = (c) => ({ write: (chunk) => { c.write(chunk); return true; } });
  const res = await docker.run(args, { ...opts, stdout: sink(out), stderr: sink(err) });
  return {
    ...res,
    stdout: out.bytes().toString('utf8'),
    stderr: err.bytes().toString('utf8'),
    stdoutOverLimit: out.overLimit
  };
}

module.exports = { createDocker, runText, dockerChildEnv, isUnreachableText, CONTROL_OUTPUT_BYTES };
