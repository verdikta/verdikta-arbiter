'use strict';

/**
 * What the runner reads from @verdikta/common (pinned exactly, like the EA,
 * the AI Node and e2e): the pinned forge base image, the fuzz seed every forge
 * run uses, the test-paths gate with its glob matcher, so the runner, the
 * site and the EA match paths the same way, and the baseline rule and schema
 * the listing check writes baseline.json by (node A2b).
 *
 * Only these modules are loaded (pins.js and scope.js have no dependencies;
 * baseline.js needs only ajv): the package's main entry brings the IPFS
 * client and its HTTP stack, which the runner has no use for. Node A3b moves
 * the class hard limits (classLimits.js) here too.
 */

const { BASE_IMAGE_PINS, FORGE_FUZZ_SEED } = require('@verdikta/common/src/codeReview/pins');
const { pocPatchPathsGate, matchesAny, normalizePath } = require('@verdikta/common/src/codeReview/scope');
const { baselineSets, validateBaseline } = require('@verdikta/common/src/codeReview/baseline');
const { BASELINE_RUNS } = require('@verdikta/common/src/codeReview/constants');

module.exports = { BASE_IMAGE_PINS, FORGE_FUZZ_SEED, pocPatchPathsGate, matchesAny, normalizePath, baselineSets, validateBaseline, BASELINE_RUNS };
