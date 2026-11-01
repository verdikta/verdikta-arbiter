'use strict';

/**
 * The claim pipeline's steps (design §9.2 steps 3-9), as the run engine in
 * pipeline.js executes them. Node A1 ships none: a run admits, starts the
 * sandbox from the env image and tears it down. The later nodes fill this in:
 *
 * - A2a: apply poc.patch inside the sandbox (applies, testPathsOnly), reset
 *   protected paths, build, PoC x3 and the reproduces gate
 * - A3a: integrity checks, claimedObservable, the fix check in a second
 *   sandbox (ctx.openSandbox)
 * - A3c: honesty flags (Semgrep) and fix-mode lint
 * - A3b: the Verification Report, its hash and the context pack
 *
 * @param {object} request - the validated POST /v1/runs request
 * @param {object} limits - the effective limits
 * @returns {Function[]} async (ctx) => void
 */
function claimSteps(request, limits) { // eslint-disable-line no-unused-vars
  return [];
}

module.exports = { claimSteps };
