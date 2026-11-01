'use strict';

/**
 * Entry point: `npm start`. Loads the config from the environment (refusing
 * to start on a bad one), installs the stop handlers, listens, removes
 * whatever an earlier process of this instance left behind and starts the GC
 * timer.
 */

const fs = require('node:fs');
const { loadConfig, ConfigError } = require('./config');
const { createDocker } = require('./docker');
const { createServer } = require('./server');
const { collectLeftovers } = require('./gc');
const { createLog } = require('./log');
const { RUNNER_VERSION } = require('./version');

/**
 * Start the service.
 * @param {object} o
 * @param {object} o.config
 * @param {object} o.docker
 * @param {object} o.log
 * @param {Function} [o.onSignal] - (signal, handler) => void; process.once by default
 * @param {Function} [o.exit] - process.exit by default
 * @returns {Promise<{runner:object, address:object, stop:Function}>}
 */
async function startRunner({ config, docker, log, onSignal = (sig, fn) => process.once(sig, fn), exit = (code) => process.exit(code) }) {
  const runner = createServer({ config, docker, log });
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
  // a leftover. Runs admitted in the meantime are in runner.active.
  const swept = await collectLeftovers({ docker, instance: config.instance, active: runner.active });
  if (swept.error) log.warn('startup GC could not list containers', { error: swept.error });
  else if (swept.removed.length) log.info('startup GC removed leftovers', { removed: swept.removed });

  if (!stopping && config.gcIntervalMs > 0) {
    gcTimer = setInterval(async () => {
      const r = await collectLeftovers({ docker, instance: config.instance, active: runner.active });
      if (r.error) log.warn('GC could not list containers', { error: r.error });
      else if (r.removed.length) log.info('GC removed leftovers', { removed: r.removed });
    }, config.gcIntervalMs);
    gcTimer.unref();
  }

  log.info('code-runner listening', { version: RUNNER_VERSION, runtime: config.runtime, platform: config.platform, instance: config.instance, ...address });
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
