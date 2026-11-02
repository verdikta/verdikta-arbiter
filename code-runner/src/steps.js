'use strict';

/**
 * The claim pipeline's steps (design §9.2 steps 3-9), as the run engine in
 * pipeline.js executes them. `claimSteps(request, limits)` returns
 * `async (ctx) => void` functions, run in order.
 *
 * - A2a (claim.js, forge.js): copy the checkout into the work tree, apply
 *   poc.patch inside the sandbox (applies, testPathsOnly), reset protected
 *   paths, commit, build, PoC x3 and the reproduces gate, for forge listings
 * - A3a: integrity checks, claimedObservable, the fix check in a second
 *   sandbox (ctx.openSandbox)
 * - A3c: honesty flags (Semgrep) and fix-mode lint
 * - A3b: the Verification Report, its hash and the context pack
 */

const { claimSteps } = require('./claim');

module.exports = { claimSteps };
