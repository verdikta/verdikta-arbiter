'use strict';

/**
 * Garbage collection of labelled leftovers (design §9.2 step 10). The runner
 * removes its sandboxes itself; this catches what a crash, a kill -9 or a
 * daemon hiccup during teardown left behind. It touches only containers that
 * carry this instance's label and a runner-shaped name, and never one a live
 * run owns (unless it is past its expiry, which a live run never is).
 */

const { runText } = require('./docker');
const { LABEL_INSTANCE, LABEL_EXPIRES, NAME, removeArgs } = require('./sandbox');

const INSTANCE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function psArgs(instance) {
  if (typeof instance !== 'string' || !INSTANCE.test(instance)) throw new TypeError(`invalid instance ${JSON.stringify(instance)}`);
  return [
    'ps', '--all', '--no-trunc',
    '--filter', `label=${LABEL_INSTANCE}=${instance}`,
    '--format', `{{.Names}}\t{{.Label "${LABEL_EXPIRES}"}}`
  ];
}

/**
 * @param {object} o
 * @param {object} o.docker
 * @param {string} o.instance
 * @param {Set<string>} o.active - names of live runs' containers
 * @param {number} [o.now] - epoch seconds
 * @returns {Promise<{removed:string[], error:string|null}>}
 */
async function collectLeftovers({ docker, instance, active = new Set(), now = Math.floor(Date.now() / 1000) }) {
  const ps = await runText(docker, psArgs(instance), { timeoutMs: 30000 });
  if (ps.spawnError || ps.exitCode !== 0) {
    return { removed: [], error: (ps.spawnError || ps.stderr || `docker ps exited ${ps.exitCode}`).split('\n')[0] };
  }
  const doomed = [];
  for (const line of ps.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, expires] = line.split('\t');
    if (!NAME.test(name)) continue;
    const expiry = Number(expires);
    const expired = Number.isFinite(expiry) && expires !== '' && expiry <= now;
    if (!active.has(name) || expired) doomed.push(name);
  }
  if (doomed.length === 0) return { removed: [], error: null };
  const rm = await runText(docker, removeArgs(doomed), { timeoutMs: 120000 });
  if (rm.exitCode !== 0) {
    // Gone already is fine; any other error means a container may still be there.
    const errors = String(rm.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const other = errors.filter((l) => !/No such container/i.test(l));
    if (errors.length === 0 || other.length > 0 || rm.spawnError || rm.timedOut) {
      return { removed: [], error: (other[0] || rm.spawnError || `docker rm exited ${rm.exitCode}`).slice(0, 300) };
    }
  }
  return { removed: doomed, error: null };
}

module.exports = { collectLeftovers, psArgs };
