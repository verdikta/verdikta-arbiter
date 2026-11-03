'use strict';

/**
 * The claim pipeline's steps (design §9.2 steps 3-9), as the run engine in
 * pipeline.js executes them. `claimSteps(request, limits)` returns
 * `async (ctx) => void` functions, run in order.
 *
 * - A2a (claim.js, forge.js): copy the checkout into the work tree, apply
 *   poc.patch inside the sandbox (applies, testPathsOnly), reset protected
 *   paths, commit, build, PoC x3 and the reproduces gate, for forge listings
 * - A3a (claim.js, integrity.js, observable.js, fix.js): the §9.5 integrity
 *   checks on the three runs, the integrity and claimedObservable gates, the
 *   fix check in a second sandbox run beside the PoC's (ctx.openSandbox)
 * - A3b (pack.js, report.js): the context pack, read before any claim code
 *   runs and assembled once; the Verification Report and its hash are built
 *   from the facts when the run is definitive (server.js)
 * - A3c: honesty flags (Semgrep) and fix-mode lint
 */

const { claimSteps } = require('./claim');

module.exports = { claimSteps };
