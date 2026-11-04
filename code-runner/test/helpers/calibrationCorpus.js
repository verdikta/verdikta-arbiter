'use strict';

/**
 * A small corpus in a temporary folder, for the harness's unit tests: one listing and one
 * adversarial case with its control. Real files, read by the real loader, so that a test
 * breaks one thing at a time and sees what the loader says about it.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codeReview } = require('@verdikta/common');
const { gitObjects, rootedCommit } = require('../../calibration/lib/image');

const REPO = Object.freeze({
  'foundry.toml': '[profile.default]\nsolc = "0.8.31"\n',
  'src/Vault.sol': 'contract Vault {}\n',
  'test/Vault.t.sol': 'contract VaultTest { function test_ok() public {} }\n'
});

const GATES_PASS = Object.freeze({ applies: 'pass', testPathsOnly: 'pass', build: 'pass', reproduces: 'pass', integrity: 'pass', claimedObservable: 'pass' });
const TEST_ID = 'test/Claim.t.sol > Claim > test_claim()';
const ADVERSARIAL_LINE = '+        vm.store(address(v), bytes32(0), bytes32(0));';

function patch(lines) {
  return [
    'diff --git a/test/Claim.t.sol b/test/Claim.t.sol',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/test/Claim.t.sol',
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines,
    ''
  ].join('\n');
}

const POC_LINES = Object.freeze(['+contract Claim {', '+    function test_claim() public {', ADVERSARIAL_LINE, '+    }', '+}']);

function finding(over = {}) {
  return JSON.stringify({
    version: 1,
    title: 'Vault loses a balance',
    claimedClass: 'HIGH',
    rootCause: 'Vault.deposit loses a depositor\'s balance.',
    affectedPaths: ['src/Vault.sol'],
    poc: { command: 'forge test --match-test test_claim', observable: 'test_claim fails with "assertion failed: 0 != 5"' },
    fixIncluded: false,
    ...over
  }, null, 2);
}

const SOURCE = Object.freeze({ url: 'https://github.com/verdikta/verdikta-arbiter', licence: 'MIT', program: null });

/** What an all-gates-pass run looks like: the case reaches the jury, with one flag. */
function juryCase(over = {}) {
  return {
    format: 'verdikta.calibration-case/1',
    id: 'adversarial.store',
    subsets: ['adversarial'],
    title: 'A PoC that overwrites the target\'s storage',
    source: { ...SOURCE },
    listing: 'listings/vault',
    claim: { finding: 'finding.json', report: 'report.md', poc: 'poc.patch', fix: null },
    priorFindings: [],
    expected: {
      outcome: 'INVALID',
      class: null,
      reason: 'The failure is the store\'s, so only the honesty flag and the jury can tell. No gate fires.',
      runner: {
        result: 'definitive',
        gates: { ...GATES_PASS },
        settlement: { kind: 'jury' },
        honestyFlags: [{ rule: 'verdikta.honesty.storage-overwrite', file: 'test/Claim.t.sol', line: 3 }],
        tests: [{ id: TEST_ID, runs: ['fail', 'fail', 'fail'], kind: 'assertion', message: 'assertion failed: 0 != 5' }]
      }
    },
    control: {
      case: 'adversarial.store.control',
      removes: { 'poc.patch': [ADVERSARIAL_LINE] },
      adds: {},
      differsIn: ['settlement.kind', 'gates.reproduces', 'honestyFlags', 'tests.0.runs'],
      sameIn: ['gates.applies', 'gates.build']
    },
    ...over
  };
}

function controlCase(over = {}) {
  return {
    format: 'verdikta.calibration-case/1',
    id: 'adversarial.store.control',
    subsets: ['adversarial'],
    title: 'The same PoC without the store',
    source: { ...SOURCE },
    listing: 'listings/vault',
    claim: { finding: 'finding.json', report: 'report.md', poc: 'poc.patch', fix: null },
    priorFindings: [],
    expected: {
      outcome: 'INVALID',
      class: null,
      reason: 'Without the store the test passes on all three runs, so reproduces fails on its own.',
      runner: {
        result: 'definitive',
        gates: { ...GATES_PASS, reproduces: 'fail', claimedObservable: 'not-run' },
        gateDetails: { reproduces: 'passed' },
        settlement: { kind: 'invalid', gate: 'reproduces', check: 'POC_DID_NOT_REPRODUCE' },
        honestyFlags: [],
        tests: [{ id: TEST_ID, runs: ['pass', 'pass', 'pass'], kind: null, message: null }]
      }
    },
    controlOf: 'adversarial.store',
    ...over
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function specFor(commit, over = {}) {
  return {
    version: 1,
    kind: 'bug',
    repo: 'https://github.com/verdikta/verdikta-arbiter',
    baseCommit: commit,
    artifact: { kind: 'contract', address: '0x1234567890abcdef1234567890ABCDEF12345678', chainId: 31337 },
    env: { from: 'foundry', platform: 'linux/amd64', unpackedBytes: 1000000000 },
    attestation: 'attestation.json',
    commands: { framework: 'forge', build: 'forge build', test: 'forge test', testFiles: 'forge test --match-path $FILES', testIds: 'forge test --match-test $TEST_IDS' },
    baseline: 'baseline.json',
    paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.gitignore'] },
    limits: { cpus: 1, memoryMb: 1024, buildSeconds: 90, testSeconds: 120, runSeconds: 360, maxPatchBytes: 2000000 },
    stake: {
      awards: { LOW: '0', MEDIUM: '0.1 ETH', HIGH: '0.4 ETH', CRITICAL: '2 ETH' },
      lowestClassCounted: 'MEDIUM',
      bondWei: '20000000000000000',
      fixWindowDays: 30,
      disputeWindowHours: 72,
      disclosureGraceHours: 48,
      revealWindowDays: 7,
      scope: { include: ['src/**'], exclude: ['test/**'] },
      knownIssues: 'known_issues.json',
      severityRubric: 'immunefi-v2.3',
      disclosureKey: codeReview.generateDisclosureKeyPair().recipient,
      valueAtRiskUsd: 1000
    },
    ...over
  };
}

function baselineFor(commit) {
  const id = 'test/Vault.t.sol > VaultTest > test_ok()';
  return { version: 1, baseCommit: commit, framework: 'forge', runs: 3, tests: [{ id, results: ['pass', 'pass', 'pass'] }], stable: [id], unstable: [] };
}

/**
 * @param {object} [o]
 * @param {object} [o.adversarial] - overrides for the case's case.json
 * @param {object} [o.control] - overrides for the control's case.json
 * @returns {{root:string, cleanup:Function, casePath:Function}}
 */
function writeCorpus({ adversarial = {}, control = {}, listing = {}, spec = {}, controlPoc = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-corpus-'));
  const files = Object.fromEntries(Object.entries(REPO).map(([k, v]) => [k, Buffer.from(v)]));
  const { commit } = gitObjects(files);
  for (const [rel, text] of Object.entries(REPO)) writeJson(path.join(root, 'repos/vault', rel), text);
  writeJson(path.join(root, 'listings/vault/listing.json'), {
    format: 'verdikta.calibration-listing/1', id: 'vault',
    repo: { kind: 'fixture', path: 'repos/vault' }, commit, source: { ...SOURCE }, solc: '0.8.31', ...listing
  });
  writeJson(path.join(root, 'listings/vault/code_review.json'), specFor(commit, spec));
  writeJson(path.join(root, 'listings/vault/baseline.json'), baselineFor(commit));
  writeJson(path.join(root, 'listings/vault/known_issues.json'), []);

  const casePath = (name) => path.join(root, 'cases/adversarial', name);
  const write = (name, json, poc) => {
    writeJson(path.join(casePath(name), 'case.json'), json);
    writeJson(path.join(casePath(name), 'finding.json'), `${finding()}\n`);
    writeJson(path.join(casePath(name), 'report.md'), '# A report\n');
    writeJson(path.join(casePath(name), 'poc.patch'), poc);
  };
  write('store', juryCase(adversarial), patch(POC_LINES));
  write('store.control', controlCase(control), controlPoc === null ? patch(POC_LINES.filter((l) => l !== ADVERSARIAL_LINE)) : controlPoc);
  return { root, commit, casePath, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// ------------------------------------------------------------- A7b: a public finding on a listing of kind `git`

const UPSTREAM = 'https://github.com/example-contests/2031-01-project';
const UPSTREAM_COMMIT = 'a'.repeat(40);
const FINDING_URL = 'https://github.com/example-contests/2031-01-project-judging/issues/7';
const PUBLIC_TEST_ID = 'test/Claim.t.sol > ClaimTest > test_interest_is_paid()';
const PUBLIC_MESSAGE = 'interest is paid: 1 != 2';

function publicSource(over = {}) {
  return {
    url: FINDING_URL,
    licence: 'Repository: none found. Source SPDX: MIT.',
    licenceUse: 'Fetched at run time at the pinned commit, never committed. The claim files here are Verdikta\'s own.',
    adaptedFrom: FINDING_URL,
    adaptedHow: 'A test of our own that asserts the safe property, from the finding\'s description.',
    report: 'https://raw.githubusercontent.com/example-contests/2031-01-project-judging/abc/README.md',
    program: { name: 'ExampleProgram', contest: '2031-01-project', verdict: 'Valid, published as H-1', class: 'HIGH' },
    ...over
  };
}

const PUBLIC_POC = Object.freeze([
  'diff --git a/test/Claim.t.sol b/test/Claim.t.sol',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/test/Claim.t.sol',
  '@@ -0,0 +1,5 @@',
  '+contract ClaimTest {',
  '+    function test_interest_is_paid() public {',
  '+        revert("interest is paid: 1 != 2");',
  '+    }',
  '+}',
  ''
].join('\n'));

function publicFinding(over = {}) {
  return {
    version: 1,
    title: 'Interest is short by a tier',
    claimedClass: 'HIGH',
    rootCause: 'The tier boundary uses the old count, so a staker is paid at the lower rate.',
    affectedPaths: ['src/Staking.sol'],
    poc: { command: 'forge test --match-test test_interest_is_paid', observable: `test_interest_is_paid fails with "${PUBLIC_MESSAGE}"` },
    fixIncluded: false,
    ...over
  };
}

function publicCase(over = {}) {
  return {
    format: 'verdikta.calibration-case/1',
    id: 'clear-valid.one',
    subsets: ['clear-valid'],
    title: 'Interest short by a tier',
    source: publicSource(),
    listing: 'listings/project',
    claim: { finding: 'finding.json', report: 'report.md', poc: 'poc.patch', fix: null },
    priorFindings: [],
    expected: {
      outcome: 'VALID',
      class: 'HIGH',
      reason: 'The program judged it High; the jury is A7d\'s. Here every gate passes.',
      runner: {
        result: 'definitive',
        gates: { ...GATES_PASS },
        settlement: { kind: 'jury' },
        honestyFlags: [],
        tests: [{ id: PUBLIC_TEST_ID, runs: ['fail', 'fail', 'fail'], kind: 'assertion', message: PUBLIC_MESSAGE }]
      }
    },
    ...over
  };
}

function publicSpec(commit, over = {}) {
  const spec = specFor(commit);
  return {
    ...spec,
    repo: UPSTREAM,
    artifact: { kind: 'repo' },
    commands: { ...spec.commands, setup: 'forge build' },
    ...over
  };
}

/**
 * A corpus with one public finding on a `git` listing. No network: nothing here fetches.
 * @param {object} [o]
 * @param {object} [o.listing] - overrides for listing.json
 * @param {object} [o.spec] - overrides for code_review.json
 * @param {object} [o.entry] - overrides for case.json
 * @param {object} [o.finding] - overrides for finding.json
 * @param {string} [o.report]
 * @param {string} [o.poc]
 * @param {boolean} [o.subdir] - the project sits in a subfolder of the upstream
 */
function writePublicCorpus({ listing = {}, spec = {}, entry = {}, finding: findingOver = {}, report = '# Interest is short by a tier\n\nThe tier boundary uses the old count.\n', poc = PUBLIC_POC, subdir = false, extra = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-public-corpus-'));
  const tree = 'b'.repeat(40);
  const commit = subdir ? rootedCommit(tree).id : UPSTREAM_COMMIT;
  writeJson(path.join(root, 'listings/project/listing.json'), {
    format: 'verdikta.calibration-listing/1', id: 'project',
    repo: { kind: 'git', url: UPSTREAM, commit: UPSTREAM_COMMIT, ...(subdir ? { subdir: 'project', tree } : {}) },
    commit,
    source: { url: UPSTREAM, licence: 'Repository: none found.', program: null },
    solc: '0.8.23',
    ...listing
  });
  writeJson(path.join(root, 'listings/project/code_review.json'), publicSpec(commit, spec));
  writeJson(path.join(root, 'listings/project/baseline.json'), baselineFor(commit));
  writeJson(path.join(root, 'listings/project/known_issues.json'), []);
  const dir = path.join(root, 'cases/clear-valid/one');
  writeJson(path.join(dir, 'case.json'), publicCase(entry));
  writeJson(path.join(dir, 'finding.json'), publicFinding(findingOver));
  writeJson(path.join(dir, 'report.md'), report);
  writeJson(path.join(dir, 'poc.patch'), poc);
  for (const [rel, text] of Object.entries(extra)) writeJson(path.join(root, rel), text);
  return { root, commit, dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

module.exports = {
  writePublicCorpus, publicCase, publicFinding, publicSource, publicSpec, PUBLIC_POC, PUBLIC_MESSAGE, PUBLIC_TEST_ID, UPSTREAM, UPSTREAM_COMMIT, FINDING_URL
};
module.exports = { ...module.exports, writeCorpus, juryCase, controlCase, specFor, baselineFor, GATES_PASS, TEST_ID, ADVERSARIAL_LINE, finding, patch, POC_LINES };
