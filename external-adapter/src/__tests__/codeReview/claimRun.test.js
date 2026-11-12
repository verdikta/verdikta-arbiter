// Node A4b: the run on a clock the test moves, for what real timers cannot hit
// exactly: the retry's boundary, the arithmetic and the runtime rule.

const fs = require('fs');
const path = require('path');
const { codeReview } = require('@verdikta/common');
const { runClaim } = require('../../codeReview/claimRun');
const { SharedRuns } = require('../../codeReview/sharedRuns');
const { createDeadline, JUSTIFIER_RESERVE_MS, JUROR_FLOOR_MS } = require('../../codeReview/time');
const H = require('../../../test/helpers/codeReviewFixtures');
const R = require('../../../test/helpers/codeReviewRun');

const TOKEN = 'runner-token-0123456789abcdef0123456789abcdef';
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const LIMIT = JUSTIFIER_RESERVE_MS + JUROR_FLOOR_MS;

function contextFor(over = {}) {
  const listing = H.makeListing({ builderKey: codeReview.createDevBuilderKey() });
  return {
    codeClass: 'code-standard',
    trust: 'dev',
    listing: {
      cid: H.cid('Listing'),
      outcomes: [...codeReview.BUG_OUTCOMES],
      query: 'the listing query',
      juryParameters: JSON.parse(JSON.stringify(codeReview.CODE_STANDARD_PANEL)),
      spec: listing.spec,
      attestation: listing.attestation,
      knownIssues: H.exampleKnownIssues(),
      baseline: H.exampleBaseline(listing.spec.baseCommit)
    },
    claim: {
      bcid: H.cid('Claim'),
      finding: H.FINDING,
      report: '# report',
      pocPatch: Buffer.from(H.POC_PATCH),
      fixPatch: null
    },
    priorFindings: [],
    dispute: null,
    addendumText: '',
    eaGates: { disclosure: 'pass', inScope: 'pass' },
    warnings: [],
    ...over
  };
}

let runner;
let ai;
let t;
let config;

const options = (over = {}) => ({
  config,
  logger: silent,
  runTag: '[test]',
  runs: new SharedRuns(),
  deadline: createDeadline({ receivedAt: 0, deadlineMs: 780000, now: () => t }),
  ...over
});

beforeEach(async () => {
  t = 0;
  runner = await R.startRunner();
  ai = await R.startAiNode();
  config = { runner: { url: runner.url, readToken: () => TOKEN }, aiNode: { url: ai.url } };
});

afterEach(async () => {
  await runner.close();
  await ai.close();
});

describe('the time told', () => {
  it('each call is told exactly what is left when it is sent', async () => {
    t = 1000;
    runner.state.answer = (body) => { t = 301000; return R.definitive(body); };
    await runClaim(contextFor(), options());
    expect(runner.state.runs[0].deadline).toBe(779000);
    expect(ai.state.calls[0].codeReview.deadlineMs).toBe(479000);
  });

  it('a clock stepping back cannot tell anyone more than the budget, which common\'s schema also caps', async () => {
    t = -100000;
    const result = await runClaim(contextFor(), options());
    expect(runner.state.runs[0].deadline).toBe(780000);
    expect(ai.state.calls[0].codeReview.deadlineMs).toBe(780000);
    expect(result.scores).toEqual(R.juryScores());
  });
});

describe('the juror floor, before every AI call', () => {
  it('the first call too: exactly reserve + floor left after the run is not enough; no model is called', async () => {
    runner.state.answer = (body) => { t = 780000 - LIMIT; return R.definitive(body); };
    await expect(runClaim(contextFor(), options())).rejects.toThrow(/CODE_REVIEW_DEADLINE/);
    expect(ai.state.calls).toHaveLength(0);
  });

  it('one millisecond more is', async () => {
    runner.state.answer = (body) => { t = 780000 - LIMIT - 1; return R.definitive(body); };
    await runClaim(contextFor(), options());
    expect(ai.state.calls).toHaveLength(1);
  });

  it('a gate verdict needs no jury: it settles with less than the floor left', async () => {
    runner.state.answer = (body) => { t = 779000; return R.definitive(body, { stop: 'build' }); };
    const result = await runClaim(contextFor(), options());
    expect(result.scores[0].score).toBe(1000000);
    expect(ai.state.calls).toHaveLength(0);
  });

  it('the retry: exactly reserve + floor left is no retry: abstain', async () => {
    ai.state.answer = () => { t = 780000 - LIMIT; return R.aiError(503, 'CODE_REVIEW_JUROR_TIMEOUT', true); };
    await expect(runClaim(contextFor(), options())).rejects.toThrow(/CODE_REVIEW_DEADLINE/);
    expect(ai.state.calls).toHaveLength(1);
  });

  it('the retry: one millisecond more is a retry, told what is left', async () => {
    ai.state.answer = (body, state) => {
      if (state.calls.length > 1) return R.juryAnswer(body);
      t = 780000 - LIMIT - 1;
      return R.aiError(503, 'CODE_REVIEW_JUROR_TIMEOUT', true);
    };
    await runClaim(contextFor(), options());
    expect(ai.state.calls).toHaveLength(2);
    expect(ai.state.calls[1].codeReview.deadlineMs).toBe(LIMIT + 1);
    expect(runner.state.runs).toHaveLength(1);
  });
});

// Node A13: what a retried jury gets after a first attempt that ran to the AI Node's jury cap.
describe('the retry after a first attempt that runs to the jury cap (§11)', () => {
  // The AI Node's own plan (ai-node/src/lib/code-review/deadline.ts): the jury gets the smaller of
  // its cap and what deadlineMs leaves after the justifier's reserve. The cap is read from there.
  const aiNodeSource = fs.readFileSync(path.join(__dirname, '../../../../ai-node/src/lib/code-review/deadline.ts'), 'utf8');
  const CAP = Number(/CODE_JURY_MAX_MS = ([0-9]+)/.exec(aiNodeSource)[1]);
  const juryOf = (deadlineMs) => Math.min(CAP, deadlineMs - JUSTIFIER_RESERVE_MS);

  /** A run of `runnerMs` from receipt, then an AI Node whose first attempt times out at its own jury deadline. */
  function timeline(runnerMs) {
    const sentAt = [];
    runner.state.answer = (body) => { t = runnerMs; return R.definitive(body); };
    ai.state.answer = (body, state) => {
      sentAt.push(t);
      if (state.calls.length > 1) return R.juryAnswer(body);
      t += juryOf(body.codeReview.deadlineMs);
      return R.aiError(503, 'CODE_REVIEW_JUROR_TIMEOUT', true);
    };
    return sentAt;
  }

  /** Every call's jury and justifier end by the EA's deadline, receipt + 780 s. */
  const withinTheDeadline = (sentAt) => ai.state.calls.forEach((call, i) => {
    expect(sentAt[i] + call.codeReview.deadlineMs).toBeLessThanOrEqual(780000);
  });

  it('the cap is the AI Node\'s 480 s', () => {
    expect(CAP).toBe(480000);
  });

  it.each([
    [0, 300000, 255000],
    [30000, 270000, 225000],
    [60000, 240000, 195000],
    [120000, 180000, 135000],
    [194999, 105001, 60001]
  ])('a runner of %i ms: the first attempt gets the whole cap, the retry is told %i ms, a jury of %i ms (255 s less the runner)', async (runnerMs, told, jury) => {
    const sentAt = timeline(runnerMs);
    const result = await runClaim(contextFor(), options());
    expect(result.scores).toEqual(R.juryScores());
    expect(ai.state.calls).toHaveLength(2);
    expect(juryOf(ai.state.calls[0].codeReview.deadlineMs)).toBe(CAP);
    expect(ai.state.calls[1].codeReview.deadlineMs).toBe(told);
    expect(juryOf(told)).toBe(jury);
    expect(jury).toBe(780000 - CAP - JUSTIFIER_RESERVE_MS - runnerMs);
    expect(runner.state.runs).toHaveLength(1);
    withinTheDeadline(sentAt);
  });

  it.each([195000, 255000, 300000, 400000])('a runner of %i ms: the first attempt leaves reserve + floor or less, so there is no retry: abstain, no second call', async (runnerMs) => {
    const sentAt = timeline(runnerMs);
    await expect(runClaim(contextFor(), options())).rejects.toThrow(/CODE_REVIEW_DEADLINE/);
    expect(ai.state.calls).toHaveLength(1);
    expect(780000 - t).toBeLessThanOrEqual(LIMIT);
    withinTheDeadline(sentAt);
  });
});

// Node A22: the AI Node's justifier has whatever the deadline it was told leaves, so
// CODE_REVIEW_JUSTIFIER_TIMEOUT now comes only at that deadline (ai-node/src/lib/code-review/deadline.ts,
// justifierBudgetMs). It stays a retryable 503; what stops a second AI call is juryWorthCalling.
describe('a justifier timeout at the deadline (§11)', () => {
  /** The AI Node's jury window for a told deadline: unchanged by A22. */
  const juryWindow = (told) => Math.min(480000, told - JUSTIFIER_RESERVE_MS);

  /**
   * A run of `runnerMs`, then an AI Node whose jury answers after `juryMs` and whose justifier is
   * cut off `earlyMs` before the deadline the attempt was told (0: at it, as the AI Node does now).
   * The clock moves only inside the stubs: the answer comes back at that cut-off.
   */
  function justifierTimeout(runnerMs, juryMs, earlyMs = 0) {
    const seen = {};
    runner.state.answer = (body) => { t = runnerMs; return R.definitive(body); };
    ai.state.answer = (body, state) => {
      if (state.calls.length > 1) return R.juryAnswer(body);
      seen.sentAt = t;
      seen.juryEndsAt = t + juryMs;
      t = seen.sentAt + body.codeReview.deadlineMs - earlyMs;
      return R.aiError(503, 'CODE_REVIEW_JUSTIFIER_TIMEOUT', true);
    };
    return seen;
  }

  it.each([
    [0, 100000],
    [30000, 250000],
    [60000, 480000],
    [194999, 60000],
    [300000, 20000]
  ])('a runner of %i ms, a jury done after %i ms, the justifier cut off at the deadline: no second AI call, the deadline\'s abstention', async (runnerMs, juryMs) => {
    const seen = justifierTimeout(runnerMs, juryMs);
    await expect(runClaim(contextFor(), options())).rejects.toThrow(/CODE_REVIEW_DEADLINE/);
    expect(ai.state.calls).toHaveLength(1);
    const told = ai.state.calls[0].codeReview.deadlineMs;
    expect(told).toBe(780000 - runnerMs);
    // The jury ended inside its window, and the justifier then had at least its reserve.
    expect(juryMs).toBeLessThanOrEqual(juryWindow(told));
    expect(780000 - seen.juryEndsAt).toBeGreaterThanOrEqual(JUSTIFIER_RESERVE_MS);
    expect(t).toBe(780000);
    expect(runner.state.runs).toHaveLength(1);
  });

  it.each([1, 1000, LIMIT])('an AI Node whose clock ends the justifier %i ms before the EA\'s deadline: still no second AI call', async (earlyMs) => {
    justifierTimeout(30000, 100000, earlyMs);
    await expect(runClaim(contextFor(), options())).rejects.toThrow(/CODE_REVIEW_DEADLINE/);
    expect(ai.state.calls).toHaveLength(1);
  });

  it('the EA\'s rule itself is unchanged: a justifier cut off at a fixed 45 s after an early jury, as before A22, left minutes and was retried', async () => {
    runner.state.answer = (body) => { t = 30000; return R.definitive(body); };
    ai.state.answer = (body, state) => {
      if (state.calls.length > 1) return R.juryAnswer(body);
      t += 250000 + JUSTIFIER_RESERVE_MS;
      return R.aiError(503, 'CODE_REVIEW_JUSTIFIER_TIMEOUT', true);
    };
    const result = await runClaim(contextFor(), options());
    expect(result.scores).toEqual(R.juryScores());
    expect(ai.state.calls).toHaveLength(2);
    expect(ai.state.calls[1].codeReview.deadlineMs).toBe(780000 - 30000 - 250000 - JUSTIFIER_RESERVE_MS);
  });
});

describe('the runtime', () => {
  const runc = (body) => R.definitive(body, { inputs: { gvisor: 'runc' } });

  it('a production-trust listing judged under another runtime than the pinned gVisor abstains', async () => {
    runner.state.answer = runc;
    await expect(runClaim(contextFor({ trust: 'production' }), options())).rejects.toThrow(/CODE_REVIEW_RUNTIME_NOT_PINNED/);
    expect(ai.state.calls).toHaveLength(0);
  });

  it('even when a gate failed: no verdict is settled on it', async () => {
    runner.state.answer = (body) => R.definitive(body, { inputs: { gvisor: 'runc' }, stop: 'build' });
    await expect(runClaim(contextFor({ trust: 'production' }), options())).rejects.toThrow(/CODE_REVIEW_RUNTIME_NOT_PINNED/);
  });

  it('dev trust (a test chain, local mode) may run under runc', async () => {
    runner.state.answer = runc;
    const result = await runClaim(contextFor({ trust: 'dev' }), options());
    expect(result.scores).toEqual(R.juryScores());
  });

  it('a production-trust listing under the pinned gVisor is judged', async () => {
    const result = await runClaim(contextFor({ trust: 'production' }), options());
    expect(result.scores).toEqual(R.juryScores());
  });
});

describe('the shape of a result', () => {
  it('jury: the scores, the block and the jury\'s text, and only the fields the upload reads', async () => {
    const result = await runClaim(contextFor(), options());
    expect(Object.keys(result).sort()).toEqual(['justification', 'metadata', 'model_results', 'scores', 'warnings'].sort());
    expect(result.metadata.verdict_source).toBe('code-review-jury');
  });

  it('a job reading a shared run leaves it as it was', async () => {
    const runs = new SharedRuns();
    const context = contextFor();
    const one = await runClaim(context, options({ runs }));
    const two = await runClaim(context, options({ runs }));
    expect(runner.state.runs).toHaveLength(1);
    expect(two).toEqual(one);
  });

  it('a kept run under one key is never settled on for other bytes under the same CIDs: the job abstains', async () => {
    const runs = new SharedRuns();
    await runClaim(contextFor(), options({ runs }));
    // same CIDs, another attestation: a gateway that served other bytes
    await expect(runClaim(contextFor(), options({ runs }))).rejects.toThrow(/CODE_REVIEW_RUN_MISMATCH.*attestationSha256/);
    expect(runner.state.runs).toHaveLength(1);
  });
});
