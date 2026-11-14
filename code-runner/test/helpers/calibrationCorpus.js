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

/** A valid fixture's class under the listing's rubric (A7e): the rubric, an impact of that class, and why. */
function rubricLabel(cls) {
  const impact = { LOW: 'fails-to-deliver-promised-returns', MEDIUM: 'griefing', HIGH: 'temporary-freezing-of-funds', CRITICAL: 'theft-of-funds' }[cls];
  return { rubric: 'immunefi-v2.3', impact, classReason: `The proof of concept shows a harm of the ${cls} class.` };
}

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
      ...rubricLabel('HIGH'),
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
  const { disclosureKey: _filled, ...stake } = spec.stake;
  return {
    ...spec,
    stake,
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

// ------------------------------------------------------------- A7c: a labelled case in the subset batch-2

const KNOWN_TITLE = 'Interest is short at a tier boundary';

function knownIssue(over = {}) {
  const entry = { title: KNOWN_TITLE, class: 'MEDIUM', paths: ['src/Staking.sol'], description: 'The rate at a boundary follows the old count. The maker accepts it.', ...over };
  return { id: codeReview.knownIssueId(entry), ...entry };
}

const PRIOR = Object.freeze({
  version: 1,
  title: 'A staker is paid the lower rate',
  claimedClass: 'HIGH',
  rootCause: 'The boundary follows the old count, so the staker stays in the lower tier.',
  affectedPaths: ['src/Staking.sol'],
  poc: { command: 'forge test --match-test test_rate', observable: 'test_rate fails with "the rate: 1 != 2"' },
  fixIncluded: false
});

/** What each kind's case.json needs on top of a public case. */
function batch2Label(kind, over = {}) {
  const base = { kind, basis: 'program', why: 'The program ruled on this in its own words.' };
  if (kind.startsWith('duplicate.')) base.duplicateOf = { url: 'https://github.com/example-contests/2031-01-project-judging/issues/3', recorded: 'Labelled a duplicate of it.' };
  if (kind === 'severity-boundary') base.boundary = { classes: ['MEDIUM', 'HIGH'], call: 'MEDIUM', moved: 'The judge moved it down from High.' };
  if (kind === 'known-issue.before') base.knownIssue = { title: KNOWN_TITLE, listed: 'before', how: 'In the list the commit saw.' };
  if (kind === 'known-issue.after') base.knownIssue = { title: KNOWN_TITLE, listed: 'after', how: 'Published after the commit, in no list it saw.', twin: 'batch-2.twin' };
  return { ...base, ...over };
}

function batch2Case(kind, over = {}) {
  const outcome = { 'clear-invalid': 'INVALID', duplicate: 'DUPLICATE', 'severity-boundary': 'VALID' }[kind.split('.')[0]] || (kind === 'known-issue.before' ? 'DUPLICATE' : 'VALID');
  const valid = outcome === 'VALID';
  const cls = valid ? 'MEDIUM' : null;
  const pack = kind.startsWith('duplicate.') ? { contains: [{ tier: 'priorFindings', text: PRIOR.title }] }
    : kind === 'known-issue.before' ? { contains: [{ tier: 'knownIssues', text: KNOWN_TITLE }] }
      : kind === 'known-issue.after' ? { absent: [KNOWN_TITLE] } : undefined;
  const base = publicCase();
  return {
    ...base,
    id: 'batch-2.one',
    subsets: ['batch-2', kind.split('.')[0]],
    source: publicSource({ program: { ...publicSource().program, class: kind.startsWith('duplicate.') ? 'HIGH' : cls } }),
    priorFindings: kind.startsWith('duplicate.') ? ['priors/1'] : [],
    label: batch2Label(kind),
    control: {
      case: 'batch-2.one.control',
      removes: { 'poc.patch': ['+        revert("interest is paid: 1 != 2");'] },
      adds: { 'poc.patch': ['+        require(true, "interest is paid: 1 != 2");'] },
      differsIn: ['settlement.kind', 'gates.reproduces', 'tests.0.runs'],
      sameIn: ['gates.applies', 'gates.build']
    },
    expected: {
      outcome,
      class: cls,
      ...(valid ? rubricLabel(cls) : {}),
      reason: 'Every gate passes, and the rest is the jury\'s.',
      runner: { ...base.expected.runner, ...(pack ? { pack } : {}) }
    },
    ...over
  };
}

function batch2Control(entry) {
  return {
    ...entry,
    id: `${entry.id}.control`,
    title: 'The same test with its assertion turned around',
    controlOf: entry.id,
    control: undefined,
    label: undefined,
    expected: {
      outcome: 'INVALID',
      class: null,
      reason: 'It passes on all three runs, so its case fails on what it says it does.',
      runner: {
        result: 'definitive',
        gates: { ...GATES_PASS, reproduces: 'fail', claimedObservable: 'not-run' },
        gateDetails: { reproduces: 'passed on run 1' },
        settlement: { kind: 'invalid', gate: 'reproduces', check: 'POC_DID_NOT_REPRODUCE' },
        honestyFlags: [],
        tests: [{ id: PUBLIC_TEST_ID, runs: ['pass', 'pass', 'pass'], kind: null, message: null }]
      }
    }
  };
}

/**
 * A corpus with one labelled case and its control, in Verdikta's own words. `kind` picks the label and what it needs; a twin, when
 * asked for, is the same claim on a second listing.
 * @param {string} kind
 * @param {object} [o]
 * @param {object} [o.entry] - overrides for case.json
 * @param {object} [o.finding] - overrides for finding.json
 * @param {object} [o.spec] - overrides for code_review.json
 * @param {object[]} [o.knownIssues] - known_issues.json; by default the entry when the case is listed before
 * @param {object} [o.prior] - overrides for the prior's finding.json
 * @param {string} [o.priorReport]
 * @param {object} [o.twin] - a twin case: { entry, knownIssues, report, spec, baseline }
 */
function writeBatch2Corpus(kind, { entry = {}, finding: findingOver = {}, spec = {}, knownIssues = null, prior = {}, priorReport = '# A prior\n\nThe staker stays in the lower tier.\n', twin = null } = {}) {
  const corpus = writePublicCorpus({ spec, finding: findingOver });
  const { root } = corpus;
  fs.rmSync(path.join(root, 'cases'), { recursive: true });
  const list = knownIssues !== null ? knownIssues : (kind === 'known-issue.before' ? [knownIssue()] : []);
  writeJson(path.join(root, 'listings/project/known_issues.json'), list);
  const dir = path.join(root, 'cases/batch-2/one');
  const main = batch2Case(kind, entry);
  const writeOne = (d, json, poc) => {
    writeJson(path.join(d, 'case.json'), json);
    writeJson(path.join(d, 'finding.json'), publicFinding(findingOver));
    writeJson(path.join(d, 'report.md'), '# Interest is short by a tier\n\nThe tier boundary uses the old count.\n');
    writeJson(path.join(d, 'poc.patch'), poc);
  };
  const flipped = PUBLIC_POC.replace('revert("interest is paid: 1 != 2");', 'require(true, "interest is paid: 1 != 2");');
  writeOne(dir, main, PUBLIC_POC);
  writeOne(`${dir}.control`, batch2Control(main), flipped);
  for (const rel of main.priorFindings || []) {
    for (const d of [dir, `${dir}.control`]) {
      writeJson(path.join(d, rel, 'finding.json'), { ...PRIOR, ...prior });
      writeJson(path.join(d, rel, 'report.md'), priorReport);
    }
  }
  if (twin) {
    const t = path.join(root, 'cases/batch-2/twin');
    const twinEntry = {
      ...batch2Case('known-issue.before'),
      id: 'batch-2.twin',
      listing: 'listings/project-listed',
      label: batch2Label('known-issue.before', { knownIssue: { title: KNOWN_TITLE, listed: 'before', how: 'In the list the commit saw.', twin: 'batch-2.one' } }),
      control: { ...batch2Case('known-issue.before').control, case: 'batch-2.twin.control' },
      ...twin.entry
    };
    writeOne(t, twinEntry, PUBLIC_POC);
    writeOne(`${t}.control`, batch2Control(twinEntry), flipped);
    if (twin.report) fs.writeFileSync(path.join(t, 'report.md'), twin.report);
    fs.cpSync(path.join(root, 'listings/project'), path.join(root, 'listings/project-listed'), { recursive: true });
    const listingFile = path.join(root, 'listings/project-listed/listing.json');
    writeJson(listingFile, { ...JSON.parse(fs.readFileSync(listingFile, 'utf8')), id: 'project-listed' });
    writeJson(path.join(root, 'listings/project-listed/known_issues.json'), twin.knownIssues || [knownIssue()]);
    if (twin.spec) {
      const specFile = path.join(root, 'listings/project-listed/code_review.json');
      writeJson(specFile, { ...JSON.parse(fs.readFileSync(specFile, 'utf8')), ...twin.spec });
    }
    if (twin.baseline) writeJson(path.join(root, 'listings/project-listed/baseline.json'), twin.baseline);
  }
  return { ...corpus, dir };
}

module.exports = {
  writeBatch2Corpus, batch2Case, batch2Label, knownIssue, KNOWN_TITLE, PRIOR,
  writePublicCorpus, publicCase, publicFinding, publicSource, publicSpec, rubricLabel, PUBLIC_POC, PUBLIC_MESSAGE, PUBLIC_TEST_ID, UPSTREAM, UPSTREAM_COMMIT, FINDING_URL
};
module.exports = { ...module.exports, writeCorpus, juryCase, controlCase, specFor, baselineFor, GATES_PASS, TEST_ID, ADVERSARIAL_LINE, finding, patch, POC_LINES };
