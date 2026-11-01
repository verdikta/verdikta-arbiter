'use strict';

/**
 * Admission (design §9.2 step 1, §11, §12): refuse early, before a pull or a
 * container, rather than fail late. A refusal is an abstain (error, no
 * commit), which costs the operator the timeliness penalty, so each check is
 * one the run could not survive.
 *
 * A1 checks the maintenance lock, the deadline and the daemon. Node A1b adds
 * the execution slots, the memory reserve and the disk admission for the pull
 * as further checks in the same function.
 */

const fs = require('node:fs');
const { ABSTAIN, Abstain } = require('./result');
const { dockerInfo } = require('./daemon');

/** True while an install or upgrade holds the lock (the installer creates the file, A8). */
function maintenanceLocked(file, exists = fs.existsSync) {
  return Boolean(file) && exists(file);
}

/**
 * @param {object} o
 * @param {object} o.config
 * @param {object} o.docker
 * @param {object} o.limits - effective limits
 * @param {number} o.stopAt - when the run must have stopped (deadline minus the reserve), epoch ms
 * @param {number} [o.now]
 * @param {AbortSignal} [o.signal]
 * @throws {Abstain}
 */
async function admitRun({ config, docker, limits, stopAt, now = Date.now(), signal, exists = fs.existsSync }) {
  const refuse = (detail) => new Abstain(ABSTAIN.ADMISSION_REFUSED, detail, { step: 'admission' });
  if (maintenanceLocked(config.maintenanceFile, exists)) {
    throw refuse(`the maintenance lock ${config.maintenanceFile} is held (an install or upgrade is running)`);
  }
  const needMs = limits.runSeconds * 1000;
  const haveMs = stopAt - now;
  if (haveMs < needMs) {
    throw refuse(`the deadline leaves ${Math.max(0, haveMs)} ms; the run may need ${needMs} ms (runSeconds)`);
  }
  const info = await dockerInfo(docker, { timeoutMs: Math.min(10000, haveMs), signal });
  if (!info.reachable) throw new Abstain(ABSTAIN.DOCKER_UNREACHABLE, info.error, { step: 'admission' });
  if (!Object.prototype.hasOwnProperty.call(info.runtimes, config.runtime)) {
    throw refuse(`the Docker daemon has no ${config.runtime} runtime registered`);
  }
}

module.exports = { admitRun, maintenanceLocked };
