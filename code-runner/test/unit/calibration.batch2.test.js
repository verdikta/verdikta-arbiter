'use strict';

// A7c: the labels of the second batch. A clear invalid, a duplicate, a known issue and a severity boundary cannot be told apart by
// the runner, which sends all of them to the jury, so what these hold is that each case says where its label comes from, and that
// the case can be checked against that. The cases themselves run in CI, and test/calibration/batch-2.test.js restates each.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { codeReview } = require('@verdikta/common');
const { loadCorpus, selectCases, CorpusError, LABEL_KINDS } = require('../../calibration/lib/format');
const { listingView, caseRequest } = require('../../calibration/lib/harness');
const { claimTexts, programUrls, claimProblems, indexTexts, LIMITS } = require('../../calibration/lib/provenance');
const {
  writeBatch2Corpus, batch2Label, knownIssue, KNOWN_TITLE, PRIOR, publicSource
} = require('../helpers/calibrationCorpus');

const CALIBRATION = path.join(__dirname, '..', '..', 'calibration');
const FAMILIES = Object.freeze(['clear-invalid.intended-behaviour', 'clear-invalid.outside-scope', 'clear-invalid.excluded-precondition', 'duplicate.rephrased', 'duplicate.entry-point', 'duplicate.victim', 'known-issue.before', 'known-issue.after', 'severity-boundary']);

function problemsOf(kind, o = {}) {
  const corpus = writeBatch2Corpus(kind, o);
  try {
    return loadCorpus({ root: corpus.root, layout: true }) && [];
  } catch (err) {
    assert.ok(err instanceof CorpusError, err.stack);
    return err.problems;
  } finally {
    corpus.cleanup();
  }
}

function assertRefused(kind, o, pattern) {
  const problems = problemsOf(kind, o);
  assert.ok(problems.some((p) => pattern.test(p)), `expected a problem matching ${pattern}, got: ${JSON.stringify(problems, null, 1)}`);
}

const twinned = { twin: {} };
const IMAGE = Object.freeze({ image: `127.0.0.1:5000/verdikta/x@sha256:${'0'.repeat(64)}` });

test('each kind the node asks for loads, with what it needs and nothing more', () => {
  assert.deepEqual(Object.keys(LABEL_KINDS).sort(), [...FAMILIES].sort());
  for (const kind of FAMILIES) {
    assert.deepEqual(problemsOf(kind, kind === 'known-issue.after' ? twinned : {}), [], kind);
  }
});

test('a case in batch-2 has a label, of a known kind, and is in that kind\'s subset', () => {
  assertRefused('severity-boundary', { entry: { label: undefined } }, /a case in batch-2 needs a label/);
  assertRefused('severity-boundary', { entry: { label: batch2Label('severity-boundary', { kind: 'clear' }) } }, /label\.kind must be one of/);
  assertRefused('severity-boundary', { entry: { subsets: ['batch-2'] } }, /also in the subset severity-boundary/);
  assertRefused('severity-boundary', { entry: { label: batch2Label('severity-boundary', { extra: 1 }) } }, /label: unknown field extra/);
});

test('a label says whose call it is, and a duplicate or a class is the program\'s', () => {
  assertRefused('severity-boundary', { entry: { label: batch2Label('severity-boundary', { basis: 'mine' }) } }, /label\.basis must be program or listing/);
  assertRefused('duplicate.rephrased', { entry: { label: batch2Label('duplicate.rephrased', { basis: 'listing' }) } }, /label\.basis listing is not open/);
  assertRefused('severity-boundary', { entry: { label: batch2Label('severity-boundary', { basis: 'listing' }) } }, /label\.basis listing is not open/);
  assertRefused('clear-invalid.intended-behaviour', { entry: { label: batch2Label('clear-invalid.intended-behaviour', { basis: 'listing' }) } }, /label\.basis listing is not open/);
  assert.deepEqual(problemsOf('clear-invalid.outside-scope', { entry: { label: batch2Label('clear-invalid.outside-scope', { basis: 'listing' }) } }), []);
  assert.deepEqual(problemsOf('clear-invalid.excluded-precondition', { entry: { label: batch2Label('clear-invalid.excluded-precondition', { basis: 'listing' }) } }), []);
  assertRefused('clear-invalid.outside-scope', { entry: { label: batch2Label('clear-invalid.outside-scope', { why: ' ' }) } }, /label\.why must say/);
});

test('a kind fixes the outcome: the one the design settles it as', () => {
  const asOutcome = (outcome, cls) => ({ outcome, class: cls, reason: 'The jury decides.', runner: { result: 'definitive', gates: { applies: 'pass', testPathsOnly: 'pass', build: 'pass', reproduces: 'pass', integrity: 'pass', claimedObservable: 'pass' }, settlement: { kind: 'jury' }, honestyFlags: [], tests: [{ id: 'test/Claim.t.sol > ClaimTest > test_interest_is_paid()', runs: ['fail', 'fail', 'fail'], kind: 'assertion', message: 'interest is paid: 1 != 2' }] } });
  assertRefused('clear-invalid.intended-behaviour', { entry: { expected: asOutcome('VALID', 'HIGH') } }, /clear-invalid\.intended-behaviour case's outcome is INVALID/);
  assertRefused('duplicate.victim', { entry: { expected: asOutcome('INVALID', null) } }, /duplicate\.victim case's outcome is DUPLICATE/);
  assertRefused('severity-boundary', { entry: { expected: asOutcome('INVALID', null) } }, /severity-boundary case's outcome is VALID/);
});

test('every case reaches the jury, and says so: no gate decides any of them', () => {
  assertRefused('clear-invalid.intended-behaviour', { entry: { expected: {
    outcome: 'INVALID', class: null, reason: 'The jury.',
    runner: { result: 'definitive', gates: { applies: 'pass', testPathsOnly: 'pass', build: 'pass', reproduces: 'fail', integrity: 'pass', claimedObservable: 'not-run' }, gateDetails: { reproduces: 'passed' }, settlement: { kind: 'invalid', gate: 'reproduces', check: 'POC_DID_NOT_REPRODUCE' }, honestyFlags: [], tests: [{ id: 'test/Claim.t.sol > ClaimTest > test_interest_is_paid()', runs: ['pass', 'pass', 'pass'], kind: null, message: null }] }
  } } }, /a batch-2 case reaches the jury/);
  const silent = writeBatch2Corpus('clear-invalid.outside-scope');
  try {
    const file = path.join(silent.dir, 'case.json');
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    entry.expected.reason = 'Every gate passes.';
    fs.writeFileSync(file, JSON.stringify(entry));
    assert.throws(() => loadCorpus({ root: silent.root }), /expected\.reason must say plainly what is left to the jury/);
  } finally {
    silent.cleanup();
  }
});

test('a duplicate names what it duplicates and how the program recorded that, and puts it in front of the jury', () => {
  assertRefused('duplicate.entry-point', { entry: { label: batch2Label('duplicate.entry-point', { duplicateOf: undefined }) } }, /needs label\.duplicateOf/);
  assertRefused('duplicate.entry-point', { entry: { label: batch2Label('duplicate.entry-point', { duplicateOf: { url: 'http://x', recorded: 'yes' } }) } }, /duplicateOf\.url/);
  assertRefused('duplicate.entry-point', { entry: { label: batch2Label('duplicate.entry-point', { duplicateOf: { url: 'https://x.org/1', recorded: '' } }) } }, /duplicateOf\.recorded/);
  assertRefused('duplicate.entry-point', { entry: { priorFindings: [] } }, /needs the finding it duplicates among its prior findings/);
  assertRefused('duplicate.entry-point', { prior: { title: 'Another title' } }, /must hold the prior finding's title in the tier priorFindings/);
  assertRefused('severity-boundary', { entry: { label: batch2Label('severity-boundary', { duplicateOf: { url: 'https://x.org/1', recorded: 'yes' } }) } }, /label\.duplicateOf does not go with severity-boundary/);
});

test('a boundary names two adjacent classes, the program\'s call and who made it, and the claim is on one side', () => {
  const boundary = (b) => ({ entry: { label: batch2Label('severity-boundary', { boundary: { classes: ['MEDIUM', 'HIGH'], call: 'MEDIUM', moved: 'The judge.', ...b } }) } });
  assertRefused('severity-boundary', { entry: { label: batch2Label('severity-boundary', { boundary: undefined }) } }, /needs label\.boundary/);
  assertRefused('severity-boundary', boundary({ classes: ['LOW', 'HIGH'] }), /two adjacent classes/);
  assertRefused('severity-boundary', boundary({ classes: ['HIGH', 'MEDIUM'] }), /two adjacent classes/);
  assertRefused('severity-boundary', boundary({ classes: ['HIGH'] }), /two adjacent classes/);
  assertRefused('severity-boundary', boundary({ call: 'LOW' }), /call must be one of the two classes/);
  assertRefused('severity-boundary', boundary({ call: 'HIGH' }), /expected\.class MEDIUM is not the program's call, HIGH/);
  assertRefused('severity-boundary', boundary({ moved: '' }), /boundary\.moved/);
  assertRefused('severity-boundary', { finding: { claimedClass: 'CRITICAL' } }, /on neither side of the boundary/);
  assert.deepEqual(problemsOf('severity-boundary', { finding: { claimedClass: 'MEDIUM' } }), [], 'the lower side');
  assert.deepEqual(problemsOf('severity-boundary', { finding: { claimedClass: 'HIGH' } }), [], 'the upper side, what the hunter submitted');
});

test('the class of a valid case is the program\'s; a duplicate keeps the class of the family; a rejected claim has none', () => {
  assertRefused('severity-boundary', { entry: { source: publicSource({ program: { ...publicSource().program, class: 'HIGH' } }) } }, /expected\.class MEDIUM is not the program's class, HIGH/);
  assertRefused('clear-invalid.intended-behaviour', { entry: { source: publicSource() } }, /source\.program\.class is null on a claim the program rejected/);
  assertRefused('known-issue.before', { entry: { source: publicSource() } }, /source\.program\.class is null on a claim the program rejected/);
  assertRefused('duplicate.entry-point', { entry: { source: publicSource({ program: { ...publicSource().program, class: null } }) } }, /a duplicate is a finding the program judged valid/);
  assert.deepEqual(problemsOf('known-issue.before', { entry: { source: publicSource(), label: batch2Label('known-issue.before', { basis: 'listing' }) } }), [], 'the program judged it valid; the list is what is built here');
});

test('a known issue listed before the commit is in the list the commit saw, and in front of the jury', () => {
  assertRefused('known-issue.before', { knownIssues: [] }, /holds no entry titled/);
  assertRefused('known-issue.before', { knownIssues: [knownIssue({ title: 'Another' })] }, /holds no entry titled/);
  assertRefused('known-issue.before', { entry: { label: batch2Label('known-issue.before', { knownIssue: { title: KNOWN_TITLE, listed: 'after', how: 'Later.' } }) } }, /listed must be before/);
  assertRefused('known-issue.before', { entry: { label: batch2Label('known-issue.before', { knownIssue: { title: KNOWN_TITLE, listed: 'before', how: '' } }) } }, /knownIssue\.how/);
  const noPack = batch2Label('known-issue.before');
  const corpus = writeBatch2Corpus('known-issue.before', { entry: { label: noPack } });
  try {
    const file = path.join(corpus.dir, 'case.json');
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete entry.expected.runner.pack;
    fs.writeFileSync(file, JSON.stringify(entry));
    assert.throws(() => loadCorpus({ root: corpus.root }), /must hold the entry's title in the tier knownIssues/);
  } finally {
    corpus.cleanup();
  }
});

test('a known issue listed after the commit is not in that list, cannot be, and has a twin that shows the difference', () => {
  assertRefused('known-issue.after', { ...twinned, knownIssues: [knownIssue()] }, /cannot be in the list the commit saw/);
  assertRefused('known-issue.after', { entry: { label: batch2Label('known-issue.after', { knownIssue: { title: KNOWN_TITLE, listed: 'after', how: 'Later.' } }) } }, /names its twin/);
  assertRefused('known-issue.after', {}, /twin: batch-2\.twin does not exist/);
  assert.deepEqual(problemsOf('known-issue.after', twinned), []);
});

test('the twins are one claim on two listings that differ only in known_issues.json', () => {
  assertRefused('known-issue.after', { twin: { report: '# Something else\n' } }, /twin: report\.md differs/);
  assertRefused('known-issue.after', { twin: { entry: { label: batch2Label('known-issue.before', { knownIssue: { title: KNOWN_TITLE, listed: 'before', how: 'Yes.', twin: 'batch-2.other' } }) } } }, /must name this case as its twin/);
  const corpus = writeBatch2Corpus('known-issue.after', { twin: { spec: { limits: { cpus: 1, memoryMb: 1024, buildSeconds: 80, testSeconds: 120, runSeconds: 360, maxPatchBytes: 2000000 } } } });
  try {
    assert.throws(() => loadCorpus({ root: corpus.root }), /the two listings hold different specs/);
  } finally {
    corpus.cleanup();
  }
});

test('the list has no date to forge: it is fixed at listing, a later list is another archive, and the claim names the one it committed to', () => {
  // A known issue holds no date: common's schema refuses one, so "listed before" is only ever which archive the claim names.
  const dated = { ...knownIssue(), listedAt: '2024-01-01' };
  assert.equal(codeReview.validateKnownIssues([dated]).ok, false, 'common refuses a date on an entry');
  assertRefused('known-issue.before', { knownIssues: [dated] }, /known_issues\.json is invalid/);

  const corpus = writeBatch2Corpus('known-issue.after', twinned);
  try {
    const { byId } = loadCorpus({ root: corpus.root, layout: true });
    const after = byId.get('batch-2.one');
    const before = byId.get('batch-2.twin');
    const image = IMAGE;
    const atCommit = listingView(after.listing, image);
    const later = listingView(before.listing, image);
    assert.notEqual(atCommit.cid, later.cid, 'another list is another listing archive, so another CID');

    const judged = caseRequest(after, atCommit).body;
    assert.equal(judged.listingCid, atCommit.cid);
    assert.deepEqual(judged.knownIssues, [], 'the request carries the list of the archive it names');
    assert.deepEqual(caseRequest(before, later).body.knownIssues.map((k) => k.title), [KNOWN_TITLE]);
    for (const field of ['pocPatch', 'finding', 'report']) {
      assert.deepEqual(caseRequest(after, atCommit).body[field], caseRequest(before, later).body[field], `the same claim: ${field}`);
    }
  } finally {
    corpus.cleanup();
  }
});

test('the text beside a claim does not carry the label either: a prior finding, or the known issues', () => {
  assertRefused('duplicate.rephrased', { priorReport: '# A prior\n\nExampleProgram judged this one.\n' }, /priors|1\/report\.md names the source \(ExampleProgram\)/);
  assertRefused('duplicate.rephrased', { prior: { rootCause: 'As the contest 2031-01-project found, the staker stays in the lower tier.' } }, /finding\.json names the source \(2031-01-project\)/);
  assertRefused('severity-boundary', { knownIssues: [knownIssue({ description: 'Accepted before the contest 2031-01-project began.' })] }, /known_issues\.json names the source/);
});

test('the harness tells the runner the External Adapter\'s gates passed, so a finding out of scope is refused here', () => {
  assertRefused('clear-invalid.outside-scope', { finding: { affectedPaths: ['test/Mock.sol'] } }, /would fail the inScope gate.*test\/Mock\.sol/);
  assertRefused('clear-invalid.outside-scope', { finding: { affectedPaths: ['lib/dep/Thing.sol'] } }, /would fail the inScope gate/);
});

test('a control has no label, and fails reproduces on its own', () => {
  const corpus = writeBatch2Corpus('severity-boundary');
  try {
    const file = path.join(`${corpus.dir}.control`, 'case.json');
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...entry, label: batch2Label('severity-boundary') }));
    assert.throws(() => loadCorpus({ root: corpus.root }), /a control has no label/);
    fs.writeFileSync(file, JSON.stringify(entry));
    fs.rmSync(`${corpus.dir}.control`, { recursive: true });
    assert.throws(() => loadCorpus({ root: corpus.root }), /batch-2\.one\.control does not exist/);
  } finally {
    corpus.cleanup();
  }
});

test('a case in batch-2 needs a control', () => {
  assertRefused('severity-boundary', { entry: { control: undefined } }, /a batch-2 case needs a control/);
});

test('a label goes with batch-2 alone', () => {
  assertRefused('severity-boundary', { entry: { subsets: ['clear-valid'] } }, /label goes with the subset batch-2/);
});

test('the provenance check reads what batch-2 adds: the prior findings, the known issues, and the pages of findings no report holds', () => {
  const corpus = writeBatch2Corpus('duplicate.rephrased', { knownIssues: [knownIssue()] });
  try {
    const { byId } = loadCorpus({ root: corpus.root, layout: true });
    const entry = byId.get('batch-2.one');
    const files = claimTexts(entry).map((f) => f.file);
    assert.deepEqual(files, ['report.md', 'finding.json', 'poc.patch', '1/report.md', '1/finding.json', 'known_issues.json']);

    const urls = programUrls(entry);
    assert.deepEqual(urls, [entry.source.report, entry.source.url, entry.label.duplicateOf.url]);
    assert.deepEqual(programUrls({ source: { report: 'https://r', url: 'https://u' } }), ['https://r'], 'a clear-valid case stays measured against its report');

    const words = PRIOR.rootCause.split(/\s+/);
    const sources = { report: indexTexts([`${KNOWN_TITLE}. ${knownIssue().description} More words to make a longer run of tokens than the limit that this file holds to`]), repo: indexTexts([]) };
    const measured = [];
    const problems = claimProblems(entry, sources, { measured });
    assert.ok(measured.some((m) => m.file === 'known_issues.json' && m.report > LIMITS.prose), JSON.stringify(measured));
    assert.ok(problems.some((p) => /known_issues\.json shares a run/.test(p)), JSON.stringify(problems));
    const copiedPrior = { report: indexTexts([`${words.join(' ')} ${'and this goes on for some time in the words of whoever wrote it'}`]), repo: indexTexts([]) };
    assert.deepEqual(claimProblems({ ...entry, listing: { ...entry.listing, knownIssues: [] } }, copiedPrior), [], 'a run under the limit passes');
  } finally {
    corpus.cleanup();
  }
});

// The real subset. Red until the cases are in.

test('the real batch-2: 15 to 20 cases, every kind the node names, at most five on one repository', () => {
  const corpus = loadCorpus({ root: CALIBRATION, layout: true });
  const chosen = selectCases(corpus, { subset: 'batch-2' }).filter((c) => c.controlOf === undefined);
  assert.ok(chosen.length >= 15 && chosen.length <= 20, `${chosen.length} cases`);

  const kinds = new Set(chosen.map((c) => c.label.kind));
  assert.deepEqual([...kinds].sort(), [...FAMILIES].sort(), 'every kind present');

  const perRepo = new Map();
  for (const c of chosen) perRepo.set(c.listing.repo.url, (perRepo.get(c.listing.repo.url) || 0) + 1);
  for (const [url, n] of perRepo) assert.ok(n <= 5, `${url} has ${n} cases`);

  for (const c of chosen) {
    assert.equal(c.expected.runner.settlement.kind, 'jury', c.id);
    assert.ok(corpus.byId.get(`${c.id}.control`), `${c.id} has its control`);
  }
});

test('the real set: with A7a and A7b it holds 40 to 60 claims', () => {
  const { cases } = loadCorpus({ root: CALIBRATION, layout: true });
  const claims = cases.filter((c) => c.controlOf === undefined);
  assert.ok(claims.length >= 40 && claims.length <= 60, `${claims.length} claims`);
});

test('the real twins: a known issue listed after, and the same claim where it is listed before', () => {
  const { cases, byId } = loadCorpus({ root: CALIBRATION, layout: true });
  const after = cases.filter((c) => c.label && c.label.kind === 'known-issue.after');
  assert.ok(after.length >= 1);
  for (const c of after) {
    const twin = byId.get(c.label.knownIssue.twin);
    assert.equal(twin.label.kind, 'known-issue.before');
    assert.notEqual(listingView(c.listing, IMAGE).cid, listingView(twin.listing, IMAGE).cid);
  }
});
