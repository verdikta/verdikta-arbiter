'use strict';

/**
 * The sandbox runtime actually used (design §9.3; node A3b): measured, never
 * copied from the pin. `docker info` names the runtime's binary but not its
 * release, so the runner asks that binary (`<path> --version`: `runsc version
 * release-YYYYMMDD.N`). Under gVisor anything but the release @verdikta/common
 * pins is refused at admission and fails /health, so every report under gVisor
 * names the pin because that is what ran, and a host on another release runs no
 * claim whose report could not match the others'. Under runc (local mode) the
 * runtime is `runc`, which common's validator warns about.
 *
 * The path must be absolute: a bare name resolves through the daemon's PATH,
 * and could be another binary on the runner's.
 */

const path = require('node:path');
const { GVISOR_RELEASE } = require('./common');
const { dockerInfo } = require('./daemon');

const RUNSC_VERSION = /^runsc version (release-[0-9]{8}\.[0-9]+)$/m;

/** The release in what `runsc --version` prints, or null. */
function parseRunscVersion(text) {
  const m = RUNSC_VERSION.exec(String(text || ''));
  return m ? m[1] : null;
}

/**
 * @param {object} o
 * @param {object} o.config - runtime
 * @param {object} o.docker - a client from createDocker(), with runtimeVersion()
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{gvisor:string|null, pinned:boolean, error:string|null}>} `gvisor`: `runc`, or the release measured
 */
async function measureRuntime({ config, docker, signal }) {
  if (config.runtime !== 'runsc') return { gvisor: 'runc', pinned: false, error: null };
  const failed = (error) => ({ gvisor: null, pinned: false, error });
  const info = await dockerInfo(docker, { signal });
  if (!info.reachable) return failed(`Docker did not answer: ${info.error}`);
  const runtime = info.runtimes.runsc;
  if (!runtime) return failed('the Docker daemon has no runsc runtime registered');
  if (typeof runtime.path !== 'string' || !path.isAbsolute(runtime.path)) {
    return failed(`the daemon names runsc by ${JSON.stringify(runtime.path)}, not an absolute path, so the runner cannot ask that binary its release`);
  }
  if (typeof docker.runtimeVersion !== 'function') return failed('this Docker client cannot run the runtime');
  const r = await docker.runtimeVersion(runtime.path);
  if (r.spawnError) return failed(`${runtime.path} --version could not run: ${r.spawnError}`);
  if (r.exitCode !== 0) return failed(`${runtime.path} --version exited ${r.exitCode}`);
  const gvisor = parseRunscVersion(r.stdout);
  if (!gvisor) return failed(`${runtime.path} --version did not name a release`);
  return { gvisor, pinned: gvisor === GVISOR_RELEASE, error: null };
}

/** Why this runtime may not run a claim (null: it may). Only gVisor is held to the pin: runc is local mode. */
function runtimeProblem(config, measured) {
  if (config.runtime !== 'runsc') return null;
  if (measured.error) return `the gVisor release could not be measured: ${measured.error}`;
  if (!measured.pinned) return `the daemon's runsc is ${measured.gvisor}; @verdikta/common pins ${GVISOR_RELEASE}, and a report from another release could not match the other arbiters'`;
  return null;
}

module.exports = { measureRuntime, runtimeProblem, parseRunscVersion };
