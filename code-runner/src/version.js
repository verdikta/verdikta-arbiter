'use strict';

/**
 * The runner's version, from package.json. Reports record it (design §9.3:
 * the runner version is a pinned input), and the shared-run key the EA builds
 * includes it (BUILD_PLAN A7).
 */
const RUNNER_VERSION = require('../package.json').version;

module.exports = { RUNNER_VERSION };
