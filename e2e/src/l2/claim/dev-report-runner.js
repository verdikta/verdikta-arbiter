'use strict';

/**
 * The real code runner, for a host off the class platform (Apple silicon with no amd64
 * emulation). Never used in CI: E2E_CLAIM_REQUIRE_CLASS_PLATFORM=1 refuses it.
 *
 * A report exists only on linux/amd64, because the schema's platform is a constant, so a
 * run on linux/arm64 answers reportUnavailable and the External Adapter abstains. That is
 * right for an arbiter, and it would stop a local run short of the jury. So this starts the
 * real service with one difference: the report is built through the runner's own
 * buildReport with the class platform named, the same call
 * code-runner/test/docker/report.docker.test.js makes on arm64. Everything else is what ran:
 * real forge, real gates, real pack. The scenario's `run.platform` line says this happened.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', '..', 'code-runner');
const { loadConfig, ConfigError } = require(path.join(ROOT, 'src/config'));
const { createDocker } = require(path.join(ROOT, 'src/docker'));
const { createLog } = require(path.join(ROOT, 'src/log'));
const { startRunner } = require(path.join(ROOT, 'src/index'));
const { buildReport } = require(path.join(ROOT, 'src/report'));

const CLASS_PLATFORM = 'linux/amd64';

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
  fs.mkdirSync(config.dockerConfigDir, { recursive: true, mode: 0o700 });
  const docker = createDocker({ bin: config.dockerBin, dockerHost: config.dockerHost, dockerConfigDir: config.dockerConfigDir });
  const finishClaim = (result, request) => {
    const built = buildReport(result, request, { gvisor: result.gvisor, platform: CLASS_PLATFORM });
    result.report = built.report;
    result.reportSha256 = built.sha256;
  };
  await startRunner({ config, docker, log, server: { finishClaim } });
}

main().catch((err) => {
  process.stderr.write(`dev-report-runner failed to start: ${err.stack || err.message}\n`);
  process.exit(1);
});
