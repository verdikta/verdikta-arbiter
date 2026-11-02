'use strict';

/**
 * What the runner reads from @verdikta/common (pinned exactly, like the EA,
 * the AI Node and e2e): the pinned forge base image, the fuzz seed every forge
 * run uses, and the test-paths gate with its glob matcher, so the runner, the
 * site and the EA match paths the same way.
 *
 * Only these two modules are loaded (pins.js and scope.js have no
 * dependencies): the package's main entry brings the IPFS client and its
 * HTTP stack, which the runner has no use for. Node A3b moves the class hard
 * limits (classLimits.js) here too.
 */

const { BASE_IMAGE_PINS, FORGE_FUZZ_SEED } = require('@verdikta/common/src/codeReview/pins');
const { pocPatchPathsGate, matchesAny, normalizePath } = require('@verdikta/common/src/codeReview/scope');

module.exports = { BASE_IMAGE_PINS, FORGE_FUZZ_SEED, pocPatchPathsGate, matchesAny, normalizePath };
