'use strict';

/**
 * Entry point: `npm start`. Loads the config from the environment (refusing
 * to start on a bad one), removes whatever an earlier process of this
 * instance left behind, starts the GC timer and listens.
 */

const fs = require('node:fs');
const { loadConfig, ConfigError } = require('./config');
const { createDocker } = require('./docker');
const { createServer } = require('./server');
const { collectLeftovers } = require('./gc');
const { createLog } = require('./log');
const { RUNNER_VERSION } = require('./version');

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
  const runner = createServer({ config, docker, log });

  // Nothing of this instance survives a restart: a container from before is a leftover.
  const swept = await collectLeftovers({ docker, instance: config.instance, active: new Set() });
  if (swept.error) log.warn('startup GC could not list containers', { error: swept.error });
  else if (swept.removed.length) log.info('startup GC removed leftovers', { removed: swept.removed });

  let gcTimer = null;
  if (config.gcIntervalMs > 0) {
    gcTimer = setInterval(async () => {
      const r = await collectLeftovers({ docker, instance: config.instance, active: runner.active });
      if (r.error) log.warn('GC could not list containers', { error: r.error });
      else if (r.removed.length) log.info('GC removed leftovers', { removed: r.removed });
    }, config.gcIntervalMs);
    gcTimer.unref();
  }

  const address = await runner.listen();
  log.info('code-runner listening', { version: RUNNER_VERSION, runtime: config.runtime, instance: config.instance, ...address });

  const shutdown = async (sig) => {
    log.info('code-runner stopping', { signal: sig });
    if (gcTimer) clearInterval(gcTimer);
    await runner.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`code-runner failed to start: ${err.stack || err.message}\n`);
  process.exit(1);
});
