'use strict';

/**
 * What a claim settles as: the External Adapter's own settleReport (external-adapter/src/codeReview/settlement.js,
 * owner decision Q35), never a second copy of the rule. It needs @verdikta/common, and a harness run installs only
 * code-runner: when the adapter has no node_modules of its own, the runner's copy answers, through NODE_PATH. Both
 * pin one exact version (test/unit/calibration.format.test.js holds that).
 */

const Module = require('node:module');
const path = require('node:path');

const OURS = path.join(__dirname, '..', '..', 'node_modules');
const current = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
if (!current.includes(OURS)) {
  process.env.NODE_PATH = [...current, OURS].join(path.delimiter);
  Module._initPaths();
}

const { settleReport } = require('../../../external-adapter/src/codeReview/settlement');

module.exports = { settleReport };
