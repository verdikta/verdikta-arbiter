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

const { codeReview } = require('@verdikta/common');
const { settleReport } = require('../../../external-adapter/src/codeReview/settlement');

/**
 * As the External Adapter reads a report: settleReport's rule holds only on one common's validator accepted, so a
 * report that fails it is the runner's bug, and the harness stops rather than reading it as a verdict.
 */
function settleValidated(report) {
  const checked = codeReview.validateClaimReport(report);
  if (!checked.ok) {
    throw new Error(`the runner's report does not validate: ${checked.issues.slice(0, 5).map((i) => `${i.code} at ${i.path}`).join(', ')}`);
  }
  return settleReport(report);
}

module.exports = { settleReport, settleValidated };
