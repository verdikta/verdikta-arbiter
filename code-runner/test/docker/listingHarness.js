'use strict';

// What the listing check's Docker test files share (test/docker/listing-integrity.docker.test.js, node A2c;
// test/docker/listing-vyper.docker.test.js, node A2d): the image shapes, a listing check and a claim on one fixture, run as
// the runner runs them. Each file builds its own fixtures. Every container is removed.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { executeRun } = require('../../src/pipeline');
const { validateListingRequest, listingSteps, imageUnpackedBytes } = require('../../src/listing');
const { checkSpec } = require('../../src/classLimits');
const { claimSteps } = require('../../src/steps');
const { PLATFORM, silent, dockerTestConfig, dockerFor, leftovers, removeAll } = require('./helpers');
const { vaultBaseline, addFilesPatch, pocFile } = require('./forgeFixture');

const SVM = '/opt/verdikta/tools/share/svm';
const BASE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** A setup line writing `text` to `file` exactly, its bytes known to the test (its hash goes on a test's list). */
const writeFile = (file, text) => `printf '%s' '${Buffer.from(text).toString('base64')}' | base64 -d > ${file} && chmod 0755 ${file}`;

/** An ordinary Foundry project (forge init's shape): real forge-std, a unit, fuzz and invariant test, console logging. */
const COUNTER = Object.freeze({
  'src/Counter.sol': '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.13;\ncontract Counter {\n    uint256 public number;\n    function setNumber(uint256 n) public { number = n; }\n    function increment() public { number += 1; }\n}\n',
  'test/Counter.t.sol': [
    '// SPDX-License-Identifier: MIT',
    'pragma solidity ^0.8.13;',
    'import {Test, console} from "forge-std/Test.sol";',
    'import {Counter} from "../src/Counter.sol";',
    'contract CounterTest is Test {',
    '    Counter public counter;',
    '    function setUp() public { counter = new Counter(); counter.setNumber(0); targetContract(address(counter)); }',
    '    function test_Increment() public { counter.increment(); console.log("number", counter.number()); assertEq(counter.number(), 1); }',
    '    function testFuzz_SetNumber(uint256 x) public { counter.setNumber(x); assertEq(counter.number(), x); }',
    '    function invariant_ReadsBack() public view { assertEq(counter.number(), counter.number()); }',
    '}',
    ''
  ].join('\n'),
  'script/Counter.s.sol': '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.13;\nimport {Script} from "forge-std/Script.sol";\ncontract CounterScript is Script { function run() public {} }\n',
  'remappings.txt': 'forge-std/=lib/forge-std/src/\n',
  'foundry.lock': '{}\n',
  '.gitignore': 'out/\ncache/\nbroadcast/\n.env\n',
  '.gitmodules': '[submodule "lib/forge-std"]\n\tpath = lib/forge-std\n\turl = https://github.com/foundry-rs/forge-std\n',
  'foundry.toml': '[profile.default]\nsrc = "src"\nout = "out"\nlibs = ["lib"]\nsolc_version = "0.8.31"\noffline = true\n\n[invariant]\nruns = 4\ndepth = 4\n'
});
/** The image shape the attested builder makes (builder/src/dockerfile.js). */
const BUILDER_ENV = ['XDG_DATA_HOME=/opt/verdikta/tools/share', 'VERDIKTA_TOOLS=/opt/verdikta/tools', `PATH=${BASE_PATH}:/opt/verdikta/tools/bin`];
const AS_BUILDER = 'chown -R 10001:10001 /repo && git config --system --add safe.directory /repo';
/** What forge's own install leaves beside a release: these are no compilers (see the install test below). */
const INSTALL_MARKERS = (...versions) => [`: > ${SVM}/.global-version`, ...versions.map((v) => `: > ${SVM}/${v}/.lock`)].join(' && ');

const PATHS = { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.gitignore'] };
const COMMANDS = { framework: 'forge', build: 'forge build', test: 'forge test', testFiles: 'forge test --match-path $FILES', testIds: 'forge test --match-test $TEST_IDS' };

function body(fx, over = {}) {
  return {
    spec: {
      version: 1, kind: 'bug', repo: 'https://github.com/acme/vault', baseCommit: fx.baseCommit,
      env: { from: 'foundry' }, commands: { ...COMMANDS, ...(over.commands || {}) },
      paths: over.paths || PATHS, stake: { scope: { include: ['src/**'] } }, limits: { cpus: 1, memoryMb: 1024 }
    },
    image: fx.image,
    deadline: 900000
  };
}

async function check(t, b, { before = [], solcList = undefined } = {}) {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance).catch(() => {}));
  const v = validateListingRequest(b);
  assert.ok(v.ok, JSON.stringify(v.issues));
  const steps = listingSteps(v.request, v.limits, { imageSize: () => imageUnpackedBytes(docker, v.request.image), platform: PLATFORM, ...(solcList ? { solcList } : {}) });
  const receivedAt = Date.now();
  const result = await executeRun({
    docker, config, limits: v.limits, image: v.request.image, runId: crypto.randomBytes(8).toString('hex'),
    steps: [...before, ...steps], receivedAt, deadlineAt: receivedAt + v.request.deadlineMs, active: new Set(), log: silent
  });
  assert.deepEqual(await leftovers(docker, config.instance), [], 'the check removed its sandbox');
  return result;
}

const NAME = 'test_deposit_credits_exactly';
const DRAIN = pocFile('ExploitTest', [
  `    function ${NAME}() public { Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
]);
const FINDING = (name = NAME) => ({
  version: 1, claimedClass: 'HIGH', rootCause: 'A deposit credits one wei more than it receives, so balances overstate deposits.',
  affectedPaths: ['src/Vault.sol'], poc: { command: `forge test --match-test ${name}`, observable: `${name} fails at the committed hash` }
});

function claimOf(fx, { pocPatch = addFilesPatch({ 'test/Exploit.t.sol': DRAIN }), baseline = vaultBaseline(fx.baseCommit), limits, commands = {}, finding = FINDING(), paths = PATHS } = {}) {
  return {
    listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    bcid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    spec: {
      version: 1, kind: 'bug', repo: 'https://github.com/acme/vault', baseCommit: fx.baseCommit,
      env: { image: fx.image, from: 'foundry', platform: 'linux/amd64', unpackedBytes: 2000000000 },
      attestation: 'attestation.json', commands: { ...COMMANDS, ...commands }, paths,
      limits: limits || { cpus: 1, memoryMb: 1024, buildSeconds: 90, testSeconds: 120, runSeconds: 360, maxPatchBytes: 2000000 }
    },
    attestation: {}, pocPatch, fixPatch: null, baseline, finding, report: '', knownIssues: [], priorFindings: [],
    eaGates: { disclosure: 'pass', inScope: 'pass' }, deadlineMs: 800000
  };
}

async function claim(t, fx, { before = [], ...over } = {}) {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance).catch(() => {}));
  const request = claimOf(fx, over);
  const lim = checkSpec(request.spec);
  assert.ok(lim.ok, JSON.stringify(lim.issues));
  const receivedAt = Date.now();
  const result = await executeRun({
    docker, config, limits: lim.limits, image: fx.image, runId: crypto.randomBytes(8).toString('hex'),
    steps: [...before, ...claimSteps(request, lim.limits)], receivedAt, deadlineAt: receivedAt + request.deadlineMs, active: new Set(), log: silent, sandboxes: 1
  });
  assert.deepEqual(await leftovers(docker, config.instance), [], 'the run removed its sandbox');
  return result;
}

const show = (r) => JSON.stringify({
  outcome: r.outcome, abstain: r.abstain, issues: r.issues, gates: r.gates,
  listing: r.facts && r.facts.listing ? { ...r.facts.listing, baseline: undefined } : undefined,
  step: r.abstain ? (r.steps || []).find((s) => s.name === r.abstain.step) : undefined
}, null, 1);
const stepNames = (r) => (r.steps || []).map((s) => s.name);

module.exports = {
  SVM, BASE_PATH, writeFile, COUNTER, BUILDER_ENV, AS_BUILDER, INSTALL_MARKERS, PATHS, COMMANDS, body, check, NAME, DRAIN, FINDING, claimOf, claim, show, stepNames
};
