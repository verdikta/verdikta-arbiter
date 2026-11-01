'use strict';

/**
 * Entry point: `npm start`. Loads the config from the environment (refusing
 * to start on a bad one), installs the stop handlers, listens, removes
 * whatever an earlier process of this instance left behind and starts the GC
 * timer.
 *
 * No run is admitted until that startup sweep has succeeded (A1b): an
 * earlier process's sandboxes hold no ticket here, so until they are gone
 * their slots and memory would be counted as free. A sweep that fails is
 * retried every `sweepRetryMs` until one succeeds.
 */

const fs = require('node:fs');
const { loadConfig, ConfigError } = require('./config');
const { createDocker } = require('./docker');
const { createServer } = require('./server');
const { collectLeftovers } = require('./gc');
const { createLog } = require('./log');
const { RUNNER_VERSION } = require('./version');

/** A startup sweep that failed is tried again after this long. */
const SWEEP_RETRY_MS = 5000;

/**
 * Start the service.
 * @param {object} o
 * @param {object} o.config
 * @param {object} o.docker
 * @param {object} o.log
 * @param {Function} [o.onSignal] - (signal, handler) => void; process.once by default
 * @param {Function} [o.exit] - process.exit by default
 * @param {number} [o.sweepRetryMs] - how soon a failed startup sweep is tried again
 * @param {object} [o.server] - extra createServer options (tests)
 * @returns {Promise<{runner:object, address:object, stop:Function}>}
 */
async function startRunner({
  config, docker, log, onSignal = (sig, fn) => process.once(sig, fn), exit = (code) => process.exit(code),
  sweepRetryMs = SWEEP_RETRY_MS, server = {}
}) {
  const runner = createServer({ config, docker, log, ...server });
  // Closed from before the listener until the earlier process's sandboxes are gone.
  runner.capacity.hold('the runner is removing the sandboxes an earlier process of this instance left; no run is admitted until they are gone');
  let gcTimer = null;
  let stopping = null;
  const stop = (sig) => {
    if (!stopping) {
      stopping = (async () => {
        log.info('code-runner stopping', { signal: sig });
        if (gcTimer) clearInterval(gcTimer);
        await runner.close();
      })();
    }
    return stopping;
  };
  // Installed before anything can be admitted: a stop signal always goes
  // through close(), which cancels runs and removes their sandboxes.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    onSignal(sig, () => { stop(sig).then(() => exit(0), () => exit(1)); });
  }

  // The listener is the instance's lock: a second process with the same
  // config fails here (address or socket in use) before it can touch the
  // first one's containers.
  const address = await runner.listen();

  // Nothing of this instance survives a restart: a container from before is
  // a leftover. No run is admitted until a sweep has removed them all.
  const sweep = async () => {
    const swept = await collectLeftovers({ docker, instance: config.instance, active: runner.active });
    if (swept.error) {
      log.warn('startup GC could not remove the leftovers; runs stay refused until it can', { error: swept.error });
      return false;
    }
    if (swept.removed.length) {
      log.info('startup GC removed leftovers', { removed: swept.removed });
      // Confirmed only by a listing that finds none left (a removal's exit
      // code alone does not say every one is gone).
      const check = await collectLeftovers({ docker, instance: config.instance, active: runner.active });
      if (check.error || check.removed.length) {
        log.warn('leftovers were still there after the startup GC; runs stay refused until none is', { error: check.error, found: check.removed });
        return false;
      }
    }
    if (!stopping) runner.capacity.open();
    return true;
  };
  if (!(await sweep())) {
    (async () => {
      while (!stopping) {
        await new Promise((resolve) => { setTimeout(resolve, sweepRetryMs).unref(); });
        if (stopping || (await sweep())) return;
      }
    })();
  }

  if (!stopping && config.gcIntervalMs > 0) {
    gcTimer = setInterval(async () => {
      const r = await collectLeftovers({ docker, instance: config.instance, active: runner.active });
      if (r.error) log.warn('GC could not list containers', { error: r.error });
      else if (r.removed.length) log.info('GC removed leftovers', { removed: r.removed });
    }, config.gcIntervalMs);
    gcTimer.unref();
  }

  log.info('code-runner listening', {
    version: RUNNER_VERSION, runtime: config.runtime, platform: config.platform, instance: config.instance,
    slots: config.slots, registries: config.registryAllowlist.map((e) => e.entry), ...address
  });
  const dev = config.registryAllowlist.filter((e) => e.dev).map((e) => e.entry);
  if (dev.length) log.warn('the registry allowlist has dev entries (a local registry): not for a production arbiter', { dev });
  return { runner, address, stop };
}

async function main() {
  const log = createLog();
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  // The runner's own, empty DOCKER_CONFIG: the CLI reads no operator credentials.
  fs.mkdirSync(config.dockerConfigDir, { recursive: true, mode: 0o700 });
  const docker = createDocker({ bin: config.dockerBin, dockerHost: config.dockerHost, dockerConfigDir: config.dockerConfigDir });
  await startRunner({ config, docker, log });
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`code-runner failed to start: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}

module.exports = { startRunner };
