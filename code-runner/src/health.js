'use strict';

/**
 * GET /health: what the EA and the doctor need to decide whether this runner
 * can take a claim. `ok` is false when a run would be refused anyway: Docker
 * unreachable, the configured runtime missing, the maintenance lock held, or
 * (under runsc) the host's memory not measurable. Busy slots are reported
 * (`capacity`), not a failure: they free up.
 */

const fs = require('node:fs');
const { RUNNER_VERSION } = require('./version');
const { CLASS_HARD_LIMITS } = require('./classLimits');
const { dockerInfo } = require('./daemon');
const { maintenanceLocked } = require('./admission');

/** DOCKER_HOST without any user or password it might carry. */
function describeEndpoint(dockerHost) {
  if (!dockerHost) return 'default';
  try {
    const u = new URL(dockerHost);
    if (u.protocol === 'unix:' || u.protocol === 'npipe:') return `${u.protocol}//${u.pathname}`;
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch (_) {
    return 'configured';
  }
}

async function freeBytes(dir, statfs) {
  if (!dir) return { freeBytes: null, error: 'unknown data root' };
  try {
    const s = await statfs(dir);
    return { freeBytes: Number(s.bavail) * Number(s.bsize), error: null };
  } catch (err) {
    return { freeBytes: null, error: err.code || err.message };
  }
}

/**
 * @param {object} o
 * @param {object} o.config
 * @param {object} o.docker
 * @param {Function} [o.statfs] - fs.promises.statfs
 */
async function health({ config, docker, statfs = fs.promises.statfs, exists = fs.existsSync, capacity = null, images = null }) {
  const info = await dockerInfo(docker);
  const runtime = info.runtimes[config.runtime] || null;
  const dataRootPath = config.dataRoot || info.dockerRootDir;
  const disk = info.reachable || config.dataRoot ? await freeBytes(dataRootPath, statfs) : { freeBytes: null, error: 'Docker unreachable' };
  const maintenance = maintenanceLocked(config.maintenanceFile, exists);
  const reasons = [];
  if (!info.reachable) reasons.push(`Docker unreachable: ${info.error}`);
  else if (!runtime) reasons.push(`the Docker daemon has no ${config.runtime} runtime registered`);
  if (maintenance) reasons.push('the maintenance lock is held');
  let capacityStatus;
  if (capacity) {
    await capacity.measure();
    capacityStatus = capacity.status();
    if (capacityStatus.held) reasons.push(capacityStatus.held);
    if (config.runtime === 'runsc' && capacityStatus.memory.availableMb === null) {
      reasons.push(`the host's available memory cannot be measured (${capacityStatus.memory.error})`);
    }
  }
  return {
    ok: reasons.length === 0,
    reasons,
    service: 'verdikta-code-runner',
    version: RUNNER_VERSION,
    node: process.version,
    runtime: config.runtime,
    platform: config.platform,
    runtimeAvailable: Boolean(runtime),
    runtimeArgs: runtime ? runtime.runtimeArgs : [],
    docker: {
      reachable: info.reachable,
      endpoint: describeEndpoint(config.dockerHost),
      serverVersion: info.serverVersion,
      osType: info.osType,
      architecture: info.architecture,
      error: info.error
    },
    dataRoot: { path: dataRootPath || null, freeBytes: disk.freeBytes, error: disk.error },
    maintenance,
    ...(capacity ? { capacity: capacityStatus } : {}),
    ...(images ? { images: { ...images.status(), diskReserveMb: config.diskReserveMb, pullTimeoutMs: config.pullTimeoutMs } } : {}),
    limits: CLASS_HARD_LIMITS
  };
}

module.exports = { health, describeEndpoint };
