'use strict';

// Nodes A6b, A6c: what an L4 claim scenario asserts, against what it must refuse. The same
// functions run on the real pipeline's justifications in the L2 claim suite.

const { claimVerdictChecks, revealChecks, abstainChecks, firstEvidenceBlock } = require('../claim-checks');

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

const OFF = Object.freeze({ canaryFault: Object.freeze({ state: 'off' }) });
const juror = (o = {}) => ({
  justification: `${block(o)}\n\nThe panel finds the over-credit a HIGH.`,
  arbiter: OFF,
  metadata: { verdict_source: 'code-review-jury', reportSha256: HASH, canary_fault_ai_node: 'off', ...o.metadata },
  ...o.over
});
const report = (json, cid = `Qm${'J'.repeat(44)}`) => ({ cid, json });
const args = (kind, reports, over = {}) => ({ kind, reports, scores: kind === 'valid' ? JURY_VECTOR : INVALID_VECTOR, cids: [LISTING, CLAIM], ...over });

const runnerGate = (o = {}) => ({
  justification: `${block({ settlement: 'INVALID (testPathsOnly)', ...o })}\n\nVerdict: INVALID (deterministic, not an AI judgement).\n\nGate: testPathsOnly\nCheck: PATCH_OUTSIDE_TEST_PATHS`,
  arbiter: OFF,
  metadata: { verdict_source: 'code-review-runner', gate: 'testPathsOnly', claim: CLAIM, reportSha256: HASH }
});
const frontGate = (over = {}) => ({
  justification: `Verdict: INVALID (deterministic, not an AI judgement).\n\nThe claim ${CLAIM} failed a gate.\n\nGate: inScope\nCheck: X`,
  arbiter: OFF,
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
    ['a text-mode justification', [report({ justification: 'Plain text.', arbiter: OFF, metadata: {} })], 'claim.verdictSource'],
    ['a report hash that differs between arbiters', [report(juror()), report(juror({ hash: 'b'.repeat(64) }))], 'claim.reportHashAgrees'],
    ['evidence for another claim', [report(juror({ claim: `Qm${'X'.repeat(44)}` }))], 'claim.evidenceNamesThisClaim'],
    ['evidence for another listing', [report(juror({ listing: `Qm${'X'.repeat(44)}` }))], 'claim.evidenceNamesThisClaim'],
    ['a settlement line that is not the jury', [report(juror({ settlement: 'DUPLICATE (integrity)' }))], 'claim.settlement'],
    ['evidence that is not first', [report({ justification: `The panel says.\n${block()}`, arbiter: OFF, metadata: { verdict_source: 'code-review-jury', canary_fault_ai_node: 'off' } })], 'claim.evidenceFirst']
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

describe('the determinism fixtures', () => {
  it.each(['time-dependent', 'randomness-dependent'])('%s reaches the jury on one report hash', (kind) => {
    expect(allPass(claimVerdictChecks(args(kind, [report(juror()), report(juror()), report(juror())], { scores: JURY_VECTOR })))).toBe(true);
    expect(failed(claimVerdictChecks(args(kind, [report(juror()), report(juror({ hash: 'b'.repeat(64) }))], { scores: JURY_VECTOR })))).toContain('claim.reportHashAgrees');
  });

  const flaky = (o = {}) => ({
    justification: `${block({ settlement: 'INVALID (reproduces)', ...o })}\n\nVerdict: INVALID (deterministic, not an AI judgement).\n\nGate: reproduces`,
    arbiter: OFF,
    metadata: { verdict_source: 'code-review-runner', gate: 'reproduces', claim: CLAIM, reportSha256: HASH }
  });

  it('flaky settles all weight on INVALID at reproduces, on one report hash', () => {
    expect(allPass(claimVerdictChecks(args('flaky', [report(flaky()), report(flaky()), report(flaky())], { scores: INVALID_VECTOR })))).toBe(true);
  });

  it.each([
    ['a report hash that differs', [report(flaky()), report(flaky({ hash: 'b'.repeat(64) }))], 'claim.reportHashAgrees'],
    ['a jury verdict', [report(juror())], 'claim.verdictSource'],
    ['another gate', [report(runnerGate())], 'claim.gate']
  ])('flaky fails on %s', (_name, reports, name) => {
    expect(failed(claimVerdictChecks(args('flaky', reports, { scores: INVALID_VECTOR })))).toContain(name);
  });
});

describe('claim.reportHashAgrees says what it can about a difference (limit P1, #137)', () => {
  const detail = (reports) => claimVerdictChecks(args('valid', reports)).find((c) => c.name === 'claim.reportHashAgrees').detail;

  it('fails, and when the blocks agree on everything else says the difference is outside the block', () => {
    const text = detail([report(juror()), report(juror({ hash: 'b'.repeat(64) }))]);
    expect(text).toMatch(/2 report hash/);
    expect(text).toMatch(/outside the block/);
    expect(text).toMatch(/P1/);
  });

  it('does not say so when another field of the block differs too', () => {
    const text = detail([report(juror()), report(juror({ hash: 'b'.repeat(64), settlement: 'INVALID (build)' }))]);
    expect(text).not.toMatch(/outside the block/);
  });
});

describe('the fault switch, as the run named it', () => {
  const faultOf = (fields) => ({ metadata: { canary_fault: fields } });
  const armed = { ea: 'armed', aiNode: 'armed' };
  const armedJuror = (fields) => juror({ over: { arbiter: { canaryFault: { state: 'armed' } } }, metadata: { canary_fault_ai_node: 'armed', ...(fields && faultOf(fields).metadata) } });
  const withResults = (json, ms) => ({ ...json, model_results: [{ provider: 'p', model: 'm', status: 'success', duration_ms: ms }] });

  it('off by default: every arbiter must say off', () => {
    expect(allPass(claimVerdictChecks(args('valid', [report(juror())])))).toBe(true);
  });

  it.each([
    ['one arbiter armed', [report(juror()), report(juror({ over: { arbiter: { canaryFault: { state: 'armed' } } } }))], 'claim.faultSwitch'],
    ['one refused: its flag is still set', [report(juror({ over: { arbiter: { canaryFault: { state: 'refused' } } } }))], 'claim.faultSwitch'],
    ['no state at all: a build that does not report it', [report(juror({ over: { arbiter: {} } }))], 'claim.faultSwitch'],
    ['no arbiter block', [report({ ...juror(), arbiter: undefined })], 'claim.faultSwitch'],
    ['an AI Node with its key still set', [report(juror({ metadata: { canary_fault_ai_node: 'armed' } }))], 'claim.aiNodeFaultSwitch'],
    ['an AI Node that does not say', [report(juror({ metadata: { canary_fault_ai_node: undefined } }))], 'claim.aiNodeFaultSwitch']
  ])('fails on %s', (_name, reports, name) => {
    expect(failed(claimVerdictChecks(args('valid', reports)))).toContain(name);
  });

  it('a gate verdict has no AI Node to ask: the EA alone says', () => {
    const checks = claimVerdictChecks(args('runner-gate', [report(runnerGate())]));
    expect(allPass(checks)).toBe(true);
    expect(checks.map((c) => c.name)).not.toContain('claim.aiNodeFaultSwitch');
  });

  it('armed, a claim the plan does not name: it says armed and no fault touched it', () => {
    expect(allPass(claimVerdictChecks(args('valid', [report(armedJuror())], { faultSwitch: armed })))).toBe(true);
    const touched = armedJuror({ fault: 'near-limit-juror', attempts: 1, action: 'hold-juror-answer' });
    expect(failed(claimVerdictChecks(args('valid', [report(touched)], { faultSwitch: armed })))).toContain('claim.noFault');
  });

  describe('near-limit-juror', () => {
    const held = { fault: 'near-limit-juror', attempts: 1, action: 'hold-juror-answer', jurorTimeoutMs: 240000, justifierMs: 3000 };
    const good = () => report(withResults(armedJuror(held), 235000));

    it('passes when every arbiter held a juror just under its limit and the jury still answered', () => {
      expect(allPass(claimVerdictChecks(args('near-limit-juror', [good(), good(), good()], { faultSwitch: armed, scores: JURY_VECTOR })))).toBe(true);
    });

    it.each([
      ['no fault at all', () => report(withResults(armedJuror(), 235000))],
      ['the switch refused it', () => report(withResults(armedJuror({ fault: 'near-limit-juror', refused: 'REQUEST_CLASS 128' }), 235000))],
      ['the AI Node did not hold', () => report(withResults(armedJuror({ ...held, action: null }), 235000))],
      ['another fault', () => report(withResults(armedJuror({ ...held, fault: 'slow-justifier' }), 235000))],
      ['no juror near the limit', () => report(withResults(armedJuror(held), 60000))],
      ['no model results', () => report(armedJuror(held))]
    ])('fails on %s', (_name, build) => {
      expect(failed(claimVerdictChecks(args('near-limit-juror', [good(), build()], { faultSwitch: armed, scores: JURY_VECTOR })))).toContain('claim.faultApplied');
    });
  });

  describe('provider-timeout', () => {
    const retried = { fault: 'provider-timeout', attempts: 2, action: null, jurorTimeoutMs: 240000, justifierMs: 3000 };

    it('passes on a second attempt with no directive', () => {
      expect(allPass(claimVerdictChecks(args('provider-timeout', [report(armedJuror(retried))], { faultSwitch: armed, scores: JURY_VECTOR })))).toBe(true);
    });

    it('fails when there was no retry', () => {
      expect(failed(claimVerdictChecks(args('provider-timeout', [report(armedJuror({ ...retried, attempts: 1 }))], { faultSwitch: armed, scores: JURY_VECTOR })))).toContain('claim.faultApplied');
    });
  });

  describe('slow-justifier', () => {
    const slow = { fault: 'slow-justifier', attempts: 1, action: 'hold-justifier-answer', jurorTimeoutMs: 240000, justifierMs: 40500 };

    it('passes when the justifier ran near its reserve', () => {
      expect(allPass(claimVerdictChecks(args('slow-justifier', [report(armedJuror(slow))], { faultSwitch: armed, scores: JURY_VECTOR })))).toBe(true);
    });

    it('fails on a fast justifier', () => {
      expect(failed(claimVerdictChecks(args('slow-justifier', [report(armedJuror({ ...slow, justifierMs: 3000 }))], { faultSwitch: armed, scores: JURY_VECTOR })))).toContain('claim.faultApplied');
    });
  });
});

describe('the cold cache', () => {
  const cold = (image) => juror({ metadata: { runner_image: image } });

  it('passes when every arbiter pulled the image, or shared a pull under way, inside the 90 s of §11', () => {
    const reports = [report(cold({ cache: 'pulled', durationMs: 21000 })), report(cold({ cache: 'shared', durationMs: 20000 })), report(cold({ cache: 'pulled', durationMs: 89000 }))];
    expect(allPass(claimVerdictChecks(args('cold-cache', reports, { scores: JURY_VECTOR })))).toBe(true);
  });

  it.each([
    ['an arbiter that already had it', [report(cold({ cache: 'pulled', durationMs: 1 })), report(cold({ cache: 'hit', durationMs: 1 }))], 'claim.imageCold'],
    ['nobody pulled: every arbiter shared', [report(cold({ cache: 'shared', durationMs: 1 }))], 'claim.imageCold'],
    ['no fact', [report(juror())], 'claim.imageCold'],
    ['a pull over the budget', [report(cold({ cache: 'pulled', durationMs: 90001 }))], 'claim.pullWithinBudget']
  ])('fails on %s', (_name, reports, name) => {
    expect(failed(claimVerdictChecks(args('cold-cache', reports, { scores: JURY_VECTOR })))).toContain(name);
  });
});

describe('a dispute round', () => {
  const STATEMENT = `Qm${'S'.repeat(44)}`;
  const disputed = (cid = STATEMENT) => juror({ metadata: { dispute_statement: cid } });

  it('passes when every arbiter names the statement', () => {
    expect(allPass(claimVerdictChecks(args('dispute', [report(disputed()), report(disputed())], { scores: JURY_VECTOR, statementCid: STATEMENT })))).toBe(true);
  });

  it.each([
    ['another statement', [report(disputed(`Qm${'X'.repeat(44)}`))]],
    ['none', [report(juror())]]
  ])('fails on %s', (_name, reports) => {
    expect(failed(claimVerdictChecks(args('dispute', reports, { scores: JURY_VECTOR, statementCid: STATEMENT })))).toContain('claim.disputeStatement');
  });
});

describe('every recorded reveal, read from the chain', () => {
  const A = `Qm${'A'.repeat(44)}`;
  const B = `Qm${'B'.repeat(44)}`;
  const C = `Qm${'C'.repeat(44)}`;
  const json = (vector) => ({ scores: vector.map((score, i) => ({ outcome: String(i), score })) });
  const reveal = (cid, scores = JURY_VECTOR) => ({ cid, scores, slot: 0, operator: '0x1' });

  it('passes when the cluster is among them and each vector is what the arbiter uploaded', () => {
    const reveals = [reveal(A), reveal(B), reveal(C)];
    const reports = reveals.map((r) => ({ cid: r.cid, json: json(JURY_VECTOR) }));
    expect(allPass(revealChecks({ reveals, error: null, reports, combinedCids: [A, B] }))).toBe(true);
  });

  it.each([
    ['a read that failed', { reveals: [], error: 'the RPC refused', reports: [], combinedCids: [A] }, 'claim.revealsRead'],
    ['no reveal', { reveals: [], error: null, reports: [], combinedCids: [A] }, 'claim.revealsRead'],
    ['a clustered CID that no reveal carries', { reveals: [reveal(A)], error: null, reports: [{ cid: A, json: json(JURY_VECTOR) }], combinedCids: [A, B] }, 'claim.clusterInReveals'],
    ['an upload that is not what the chain got', { reveals: [reveal(A)], error: null, reports: [{ cid: A, json: json(INVALID_VECTOR) }], combinedCids: [A] }, 'claim.revealMatchesUpload'],
    ['an upload with no scores', { reveals: [reveal(A)], error: null, reports: [{ cid: A, json: {} }], combinedCids: [A] }, 'claim.revealMatchesUpload']
  ])('fails on %s', (_name, input, name) => {
    expect(failed(revealChecks(input))).toContain(name);
  });
});

describe('an abstention', () => {
  it('passes only when nobody committed and no verdict came', () => {
    expect(allPass(abstainChecks({ status: 'timeout', commitReceived: 0 }))).toBe(true);
    expect(allPass(abstainChecks({ status: 'failed', commitReceived: 0 }))).toBe(true);
  });

  it.each([
    ['a commit', { status: 'timeout', commitReceived: 1 }, 'claim.noCommit'],
    ['a status it could not read', { status: 'timeout', commitReceived: null }, 'claim.noCommit'],
    ['a verdict', { status: 'fulfilled', commitReceived: 0 }, 'claim.noVerdict']
  ])('fails on %s', (_name, input, name) => {
    expect(failed(abstainChecks(input))).toContain(name);
  });
});
