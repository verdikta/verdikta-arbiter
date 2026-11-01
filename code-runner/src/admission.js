'use strict';

/**
 * Admission (design §9.2 step 1, §9.6, §11, §12): refuse early, before a pull
 * or a container, rather than fail late. A refusal is an abstain (error, no
 * commit), which costs the operator the timeliness penalty, so each check is
 * one the run could not survive.
 *
 * admitRun() (node A1) checks the maintenance lock, the deadline and the
 * daemon. Capacity (node A1b) adds, after those:
 *
 * - **Execution slots** (CODE_RUNNER_SLOTS, default 1): at most that many
 *   runs hold a slot at once, from admission until their sandboxes are gone.
 * - **The memory reserve**, as in verdikta-agents' sandbox-kit: a run is
 *   admitted only if the host's available memory (MemAvailable), less the
 *   memory limits of the runs already admitted (their whole limit, whatever
 *   they use yet) and this run's own limit, leaves the reserve: headroom for
 *   Chainlink, Postgres and the AI Node on top of what they use now, and
 *   the largest local (Ollama) model, which an evaluation may load at any
 *   moment. The installer (A8) sets the model's size; the defaults are in
 *   config.js.
 *
 * The disk check for the pull is the image cache's (images.js), because only
 * a pull needs it.
 */

const fs = require('node:fs');
const { ABSTAIN, Abstain } = require('./result');
const { dockerInfo } = require('./daemon');

const nullLog = { info() {}, warn() {}, error() {}, debug() {} };

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

/** MemAvailable from /proc/meminfo, in MiB (null when the line is missing). */
function parseMemAvailableMb(text) {
  const m = /^MemAvailable:\s+([0-9]+)\s+kB\s*$/m.exec(String(text || ''));
  return m ? Math.floor(Number(m[1]) / 1024) : null;
}

/** The host's available memory. On macOS there is no /proc/meminfo (Docker Desktop's VM is elsewhere anyway). */
async function readMeminfo(readFile = (p) => fs.promises.readFile(p, 'utf8')) {
  try {
    const mb = parseMemAvailableMb(await readFile('/proc/meminfo'));
    return mb === null ? { availableMb: null, error: '/proc/meminfo has no MemAvailable line' } : { availableMb: mb, error: null };
  } catch (err) {
    return { availableMb: null, error: err.code || err.message };
  }
}

/** The memory reserve in MiB, by part, and its total. */
function memoryReserve(config) {
  const { chainlink, postgres, aiNode, localModel } = config.memoryReserveMb;
  return { chainlink, postgres, aiNode, localModel, total: chainlink + postgres + aiNode + localModel };
}

class Capacity {
  /**
   * @param {object} o
   * @param {object} o.config - slots, memoryReserveMb, runtime (and admitRun's settings)
   * @param {Function} [o.meminfo] - async () => { availableMb, error }
   * @param {object} [o.log]
   */
  constructor({ config, meminfo = readMeminfo, log = nullLog }) {
    this.config = config;
    this.meminfo = meminfo;
    this.log = log;
    /** One per admitted run: { memoryMb, release }. */
    this.tickets = new Set();
    this.last = { availableMb: null, error: 'not measured yet' };
  }

  async measure() {
    try {
      const m = await this.meminfo();
      this.last = { availableMb: Number.isFinite(m.availableMb) ? m.availableMb : null, error: m.error || null };
    } catch (err) {
      this.last = { availableMb: null, error: err.code || err.message };
    }
    return this.last;
  }

  committedMb() {
    let n = 0;
    for (const t of this.tickets) n += t.memoryMb;
    return n;
  }

  /**
   * admitRun()'s checks, then a slot and the memory reserve. Resolves a
   * ticket whose release() frees the slot and the memory (idempotent).
   * @throws {Abstain}
   */
  async admit({ config = this.config, docker, limits, stopAt, now = Date.now(), signal, exists = fs.existsSync }) {
    await admitRun({ config, docker, limits, stopAt, now, signal, exists });
    const mem = await this.measure();
    // From here on nothing is awaited: the check and the taking of the slot are one step.
    const refuse = (detail) => new Abstain(ABSTAIN.ADMISSION_REFUSED, detail, { step: 'admission' });
    if (this.tickets.size >= config.slots) {
      throw refuse(config.slots === 1
        ? 'the execution slot is in use (CODE_RUNNER_SLOTS=1)'
        : `all ${config.slots} execution slots are in use (CODE_RUNNER_SLOTS)`);
    }
    const reserve = memoryReserve(config);
    const committed = this.committedMb();
    if (mem.availableMb === null) {
      if (config.runtime === 'runsc') {
        throw refuse(`the host's available memory could not be measured (${mem.error}), so the memory reserve cannot be kept`);
      }
      this.log.warn('the host\'s available memory could not be measured; admitting without the memory check (runc development)', { error: mem.error });
    } else if (mem.availableMb - committed - limits.memoryMb < reserve.total) {
      throw refuse(`the host has ${mem.availableMb} MiB available, ${committed} MiB held by runs in flight, and this run may use `
        + `${limits.memoryMb} MiB; ${reserve.total} MiB stays reserved (chainlink ${reserve.chainlink}, postgres ${reserve.postgres}, `
        + `aiNode ${reserve.aiNode}, localModel ${reserve.localModel})`);
    }
    const ticket = { memoryMb: limits.memoryMb, release: () => { this.tickets.delete(ticket); } };
    this.tickets.add(ticket);
    return ticket;
  }

  status() {
    const { total, ...parts } = memoryReserve(this.config);
    return {
      slots: { total: this.config.slots, inUse: this.tickets.size },
      memory: { availableMb: this.last.availableMb, committedMb: this.committedMb(), reserveMb: total, reserve: parts, error: this.last.error }
    };
  }
}

module.exports = { admitRun, maintenanceLocked, Capacity, readMeminfo, parseMemAvailableMb, memoryReserve };
