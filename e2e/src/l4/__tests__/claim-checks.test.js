'use strict';

// Node A6b: what an L4 claim scenario asserts, against what it must refuse. The same
// functions run on the real pipeline's justifications in the L2 claim suite.

const { claimVerdictChecks, firstEvidenceBlock } = require('../claim-checks');

const allPass = (checks) => checks.length > 0 && checks.every((c) => c.ok);
const failed = (checks) => checks.filter((c) => !c.ok).map((c) => c.name);

const LISTING = `Qm${'L'.repeat(44)}`;
const CLAIM = `Qm${'C'.repeat(44)}`;
const HASH = 'a'.repeat(64);
const JURY_VECTOR = [0, 0, 0, 100000, 700000, 200000];
const INVALID_VECTOR = [1000000, 0, 0, 0, 0, 0];

function block({ settlement = 'jury', hash = HASH, listing = LISTING, claim = CLAIM } = {}) {
  return [
    'Execution evidence v1',
    `Settlement: ${settlement}`,
    `Report-SHA256: ${hash}`,
    `Listing: ${listing}`,
    `Claim: ${claim}`,
    'Integrity-Failed-Checks: none',
    'End execution evidence'
  ].join('\n');
}

const juror = (o = {}) => ({
  justification: `${block(o)}\n\nThe panel finds the over-credit a HIGH.`,
  metadata: { verdict_source: 'code-review-jury', reportSha256: HASH },
  ...o.over
});
const report = (json, cid = `Qm${'J'.repeat(44)}`) => ({ cid, json });
const args = (kind, reports, over = {}) => ({ kind, reports, scores: kind === 'valid' ? JURY_VECTOR : INVALID_VECTOR, cids: [LISTING, CLAIM], ...over });

const runnerGate = (o = {}) => ({
  justification: `${block({ settlement: 'INVALID (testPathsOnly)', ...o })}\n\nVerdict: INVALID (deterministic, not an AI judgement).\n\nGate: testPathsOnly\nCheck: PATCH_OUTSIDE_TEST_PATHS`,
  metadata: { verdict_source: 'code-review-runner', gate: 'testPathsOnly', claim: CLAIM, reportSha256: HASH }
});
const frontGate = (over = {}) => ({
  justification: `Verdict: INVALID (deterministic, not an AI judgement).\n\nThe claim ${CLAIM} failed a gate.\n\nGate: inScope\nCheck: X`,
  metadata: { verdict_source: 'code-review-gate', gate: 'inScope', claim: CLAIM },
  ...over
});

describe('firstEvidenceBlock', () => {
  it('reads the block only when it is first, and only the first', () => {
    const text = `${block()}\n\nJury text.\n${block({ settlement: 'INVALID (build)' })}`;
    expect(firstEvidenceBlock(text).Settlement).toBe('jury');
    expect(firstEvidenceBlock(`Preamble\n${block()}`)).toBeNull();
    expect(firstEvidenceBlock('Execution evidence v1\nSettlement: jury')).toBeNull();
    expect(firstEvidenceBlock(undefined)).toBeNull();
  });
});

describe('a valid claim', () => {
  it('passes when every revealing arbiter reached the jury on this claim, with one report', () => {
    expect(allPass(claimVerdictChecks(args('valid', [report(juror()), report(juror()), report(juror())])))).toBe(true);
  });

  it.each([
    ['a justification that could not be fetched', [report(juror()), report(null)], 'claim.fetched'],
    ['no reveal at all', [], 'claim.fetched'],
    ['a verdict the gates reached', [report(frontGate())], 'claim.verdictSource'],
    ['a text-mode justification', [report({ justification: 'Plain text.', metadata: {} })], 'claim.verdictSource'],
    ['a report hash that differs between arbiters', [report(juror()), report(juror({ hash: 'b'.repeat(64) }))], 'claim.reportHashAgrees'],
    ['evidence for another claim', [report(juror({ claim: `Qm${'X'.repeat(44)}` }))], 'claim.evidenceNamesThisClaim'],
    ['evidence for another listing', [report(juror({ listing: `Qm${'X'.repeat(44)}` }))], 'claim.evidenceNamesThisClaim'],
    ['a settlement line that is not the jury', [report(juror({ settlement: 'DUPLICATE (integrity)' }))], 'claim.settlement'],
    ['evidence that is not first', [report({ justification: `The panel says.\n${block()}`, metadata: { verdict_source: 'code-review-jury' } })], 'claim.evidenceFirst']
  ])('fails on %s', (_name, reports, name) => {
    expect(failed(claimVerdictChecks(args('valid', reports)))).toContain(name);
  });

  it('fails on anything but six outcomes', () => {
    expect(failed(claimVerdictChecks(args('valid', [report(juror())], { scores: [500000, 500000] })))).toContain('claim.sixOutcomes');
  });

  it('asks what the jury decided only under --assert-winner: L4 stays structural otherwise', () => {
    const rejected = args('valid', [report(juror())], { scores: [900000, 0, 0, 0, 100000, 0] });
    expect(allPass(claimVerdictChecks(rejected))).toBe(true);
    expect(failed(claimVerdictChecks({ ...rejected, assertWinner: true }))).toContain('claim.settlesValid');
    expect(allPass(claimVerdictChecks({ ...args('valid', [report(juror())]), assertWinner: true }))).toBe(true);
  });

  it('takes the scores as the chain gives them: bigints that lose up to five units', () => {
    const scores = [0n, 0n, 0n, 99999n, 699999n, 199999n];
    expect(allPass(claimVerdictChecks({ ...args('valid', [report(juror())], { scores }), assertWinner: true }))).toBe(true);
  });
});

describe('a claim that fails a gate', () => {
  it('passes with all weight on INVALID and the gate named, for the runner\'s gate', () => {
    expect(allPass(claimVerdictChecks(args('runner-gate', [report(runnerGate()), report(runnerGate())])))).toBe(true);
  });

  it('passes for the EA\'s gate, which has no run and so no evidence block', () => {
    expect(allPass(claimVerdictChecks(args('front-gate', [report(frontGate()), report(frontGate())])))).toBe(true);
  });

  it.each([
    ['runner-gate', 'a vector with weight elsewhere', { scores: [999999, 1, 0, 0, 0, 0] }, [report(runnerGate())], 'scores.allOnInvalid'],
    ['runner-gate', 'a jury verdict', {}, [report(juror())], 'claim.verdictSource'],
    ['runner-gate', 'another gate', {}, [report({ ...runnerGate(), metadata: { verdict_source: 'code-review-runner', gate: 'build' } })], 'claim.gate'],
    ['runner-gate', 'a report hash that differs', {}, [report(runnerGate()), report(runnerGate({ hash: 'b'.repeat(64) }))], 'claim.reportHashAgrees'],
    ['runner-gate', 'a settlement line for another gate', {}, [report(runnerGate({ settlement: 'INVALID (build)' }))], 'claim.settlement'],
    ['front-gate', 'the runner\'s verdict: the EA should have stopped it', {}, [report(runnerGate())], 'claim.verdictSource'],
    ['front-gate', 'another gate', {}, [report(frontGate({ metadata: { verdict_source: 'code-review-gate', gate: 'disclosure', claim: CLAIM } }))], 'claim.gate'],
    ['front-gate', 'a gate verdict on another claim', {}, [report(frontGate({ metadata: { verdict_source: 'code-review-gate', gate: 'inScope', claim: `Qm${'X'.repeat(44)}` } }))], 'claim.gateNamesThisClaim'],
    ['front-gate', 'a justification not fetched', {}, [report(null)], 'claim.fetched']
  ])('%s fails on %s', (kind, _name, over, reports, name) => {
    expect(failed(claimVerdictChecks(args(kind, reports, over)))).toContain(name);
  });
});

describe('it never passes on what did not happen', () => {
  it('an unknown kind is an error, not an empty pass', () => {
    expect(() => claimVerdictChecks(args('nonsense', [report(juror())]))).toThrow(/nonsense/);
  });
});
