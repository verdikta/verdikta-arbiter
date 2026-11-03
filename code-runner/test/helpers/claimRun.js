'use strict';

/**
 * A claim through the run engine against the fake env image
 * (test/helpers/fakeClaim.js), with the request every report and pack test
 * starts from.
 */

const assert = require('node:assert/strict');
const { executeRun } = require('../../src/pipeline');
const { checkSpec } = require('../../src/classLimits');
const { claimSteps } = require('../../src/steps');
const { testConfig } = require('./http');
const { spec: baseSpec, IMAGE } = require('./requests');
const { BASE, POC_PATCH } = require('./fakeClaim');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const DRAIN = 'test/Exploit.t.sol > ExploitTest > test_drain()';
const DEPOSIT = 'test/Vault.t.sol > VaultTest > test_deposit()';

function forgeSpec(over = {}) {
  return baseSpec({
    baseCommit: BASE,
    commands: {
      framework: 'forge', build: 'forge build', test: 'forge test',
      testFiles: 'forge test --match-path $FILES', testIds: 'forge test --match-test $TEST_IDS', ...(over.commands || {})
    },
    paths: over.paths || { tests: ['test/**'], protected: ['foundry.toml', 'lib/**'] },
    limits: { cpus: 1, memoryMb: 512, buildSeconds: 30, testSeconds: 60, runSeconds: 300, maxPatchBytes: 2000000 },
    ...(over.stake ? { stake: over.stake } : {})
  });
}

/** finding.json naming test_drain and quoting its failure. */
function finding(over = {}) {
  return {
    version: 1,
    claimedClass: 'HIGH',
    rootCause: 'Vault.deposit credits one wei more than it receives, so balances overstate deposits.',
    affectedPaths: ['src/Vault.sol'],
    poc: { command: 'forge test --match-test test_drain', observable: 'test_drain fails at the committed hash with "vault drained"' },
    ...over
  };
}

function claimRequest(over = {}) {
  return {
    listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    bcid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    spec: forgeSpec(),
    attestation: { version: 1, env: { image: IMAGE } },
    pocPatch: Buffer.from(POC_PATCH),
    fixPatch: null,
    baseline: {
      version: 1, baseCommit: BASE, framework: 'forge', runs: 3,
      tests: [{ id: DEPOSIT, results: ['pass', 'pass', 'pass'] }], stable: [DEPOSIT], unstable: []
    },
    finding: finding(),
    report: '# Reentrancy in deposit\n',
    knownIssues: [],
    priorFindings: [],
    eaGates: { disclosure: 'pass', inScope: 'pass' },
    deadlineMs: 700000,
    ...over
  };
}

async function runClaim(sb, request = claimRequest(), { config = testConfig() } = {}) {
  const lim = checkSpec(request.spec);
  assert.ok(lim.ok, JSON.stringify(lim.issues));
  const receivedAt = Date.now();
  return executeRun({
    docker: sb.docker, config, limits: lim.limits, image: IMAGE, runId: '0123456789abcdef',
    steps: claimSteps(request, lim.limits), receivedAt, deadlineAt: receivedAt + 700000, active: new Set(), log: silent,
    admit: async () => {}, sandboxes: request.fixPatch ? 2 : 1
  });
}

module.exports = { silent, DRAIN, DEPOSIT, IMAGE, forgeSpec, finding, claimRequest, runClaim };
