// Node A6c: the switch in the run. The real claimRun against doubles of the runner and the
// AI Node and a stand-in chain: what the AI Node is sent on each attempt, what stays the same
// with the switch on and off, and that a verdict's bytes do not depend on it.

const { codeReview } = require('@verdikta/common');
const { runClaim } = require('../../codeReview/claimRun');
const { SharedRuns } = require('../../codeReview/sharedRuns');
const { createDeadline } = require('../../codeReview/time');
const { canaryFaultConfigFromEnv, directiveMac } = require('../../canaryFault');
const H = require('../../../test/helpers/codeReviewFixtures');
const R = require('../../../test/helpers/codeReviewRun');
const { startCanaryChain, OPERATOR, JOB_ID, AGG_ID } = require('../../../test/helpers/canaryChain');

const TOKEN = 'r'.repeat(48);
const KEY = 'k'.repeat(48);
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const listingBuilt = H.makeListing({ builderKey: codeReview.createDevBuilderKey() });
const BCID = H.cid('Claim');

const contextFor = () => ({
  codeClass: 'code-standard',
  trust: 'dev',
  listing: {
    cid: H.cid('Listing'),
    outcomes: [...codeReview.BUG_OUTCOMES],
    query: 'the listing query',
    juryParameters: JSON.parse(JSON.stringify(codeReview.CODE_STANDARD_PANEL)),
    spec: listingBuilt.spec,
    attestation: listingBuilt.attestation,
    knownIssues: H.exampleKnownIssues(),
    baseline: H.exampleBaseline(listingBuilt.spec.baseCommit)
  },
  claim: { bcid: BCID, finding: H.FINDING, report: '# report', pocPatch: Buffer.from(H.POC_PATCH), fixPatch: null },
  priorFindings: [],
  dispute: null,
  addendumText: '',
  eaGates: { disclosure: 'pass', inScope: 'pass' },
  warnings: []
});

let runner;
let ai;
let chain;
let t;

const armed = (fault = 'near-limit-juror') => canaryFaultConfigFromEnv({
  VERDIKTA_CANARY_FAULTS: `${BCID}=${fault}`,
  VERDIKTA_CANARY_FAULT_KEY: KEY,
  VERDIKTA_CANARY_RPC_URL: chain.url,
  NETWORK_CHAIN_ID: '84532',
  DEPLOYMENT_NETWORK: 'base_sepolia',
  OPERATOR_ADDR: OPERATOR
});

const run = (canaryConfig, over = {}) => runClaim(contextFor(), {
  config: { runner: { url: runner.url, readToken: () => TOKEN }, aiNode: { url: ai.url } },
  logger: silent,
  runTag: '[test]',
  runs: new SharedRuns(),
  deadline: createDeadline({ receivedAt: 0, deadlineMs: 780000, now: () => t }),
  canaryRequest: { aggId: AGG_ID, jobId: JOB_ID },
  canaryConfig,
  ...over
});

beforeEach(async () => {
  t = 0;
  runner = await R.startRunner();
  ai = await R.startAiNode();
  chain = await startCanaryChain();
});

afterEach(async () => {
  await runner.close();
  await ai.close();
  await chain.close();
});

const stamp = (body, action) => R.juryAnswer(body, {
  codeReview: { ...R.juryAnswer(body).json.codeReview, canaryFault: { state: 'armed', action, justifierMs: 41000 } }
});

describe('what the AI Node is sent', () => {
  it('near-limit-juror: a directive beside the request, bound to this claim and report', async () => {
    ai.state.answer = (body) => stamp(body, 'hold-juror-answer');
    const result = await run(armed());
    const body = ai.state.calls[0];
    expect(body.canaryFault).toEqual({
      action: 'hold-juror-answer',
      mac: directiveMac(KEY, 'hold-juror-answer', BCID, body.codeReview.reportSha256)
    });
    expect(result.metadata.canary_fault).toMatchObject({ fault: 'near-limit-juror', attempts: 1, action: 'hold-juror-answer', jurorTimeoutMs: 240000, justifierMs: 41000 });
  });

  it('provider-timeout: attempt 1 with the directive, a retry with none, from the same run', async () => {
    const timeout = R.aiError(503, 'CODE_REVIEW_JUROR_TIMEOUT', true);
    timeout.json.canaryFault = { state: 'armed', action: 'late-juror' };
    ai.state.answer = (body, state) => (state.calls.length === 1 ? timeout : stamp(body, null));
    const result = await run(armed('provider-timeout'));
    expect(ai.state.calls).toHaveLength(2);
    expect(ai.state.calls[0].canaryFault.action).toBe('late-juror');
    expect(ai.state.calls[1].canaryFault).toBeUndefined();
    expect(runner.state.runs).toHaveLength(1);
    expect(result.metadata.canary_fault).toMatchObject({
      fault: 'provider-timeout', attempts: 2, action: null,
      earlierAttempts: [{ action: 'late-juror', errorCode: 'CODE_REVIEW_JUROR_TIMEOUT' }]
    });
    expect(result.scores).toEqual(R.juryScores());
  });

  it('an unrelated timeout on an AI Node that did not verify the directive: the verdict says no action caused it', async () => {
    const timeout = R.aiError(503, 'CODE_REVIEW_JUSTIFIER_TIMEOUT', true);
    timeout.json.canaryFault = { state: 'armed', action: null };
    ai.state.answer = (body, state) => (state.calls.length === 1 ? timeout : stamp(body, null));
    const result = await run(armed('provider-timeout'));
    expect(result.metadata.canary_fault.earlierAttempts).toEqual([{ action: null, errorCode: 'CODE_REVIEW_JUSTIFIER_TIMEOUT' }]);
  });

  it('an AI Node that says nothing on an error, and one that says something else: no action, and only a code', async () => {
    const odd = R.aiError(503, 'CODE_REVIEW_JUROR_TIMEOUT HUNTER-TEXT', true);
    odd.json.canaryFault = { state: 'armed', action: 'HUNTER-TEXT' };
    ai.state.answer = (body, state) => (state.calls.length === 1 ? odd : stamp(body, null));
    const result = await run(armed('provider-timeout'));
    expect(result.metadata.canary_fault.earlierAttempts).toEqual([{ action: null, errorCode: 'unknown' }]);
    expect(JSON.stringify(result.metadata)).not.toContain('HUNTER-TEXT');
  });

  it('cancellation: every attempt, then the arbiter abstains with no verdict', async () => {
    ai.state.answer = () => R.aiError(503, 'CODE_REVIEW_JUROR_TIMEOUT', true);
    await expect(run(armed('cancellation'))).rejects.toThrow(/CODE_REVIEW_AI_ABSTAIN/);
    expect(ai.state.calls.map((c) => c.canaryFault.action)).toEqual(['late-juror', 'late-juror']);
  });

  it('a request for 128 on the same armed node: no directive, a normal verdict that says why', async () => {
    chain.state.requestedClass = 128;
    const result = await run(armed());
    expect(ai.state.calls).toHaveLength(1);
    expect(ai.state.calls[0].canaryFault).toBeUndefined();
    expect(result.metadata.canary_fault.refused).toMatch(/REQUEST_CLASS/);
  });

  it('an unreachable RPC: no directive, a normal verdict', async () => {
    chain.state.fail = { '*': 'http500' };
    const result = await run(armed());
    expect(ai.state.calls[0].canaryFault).toBeUndefined();
    expect(result.scores).toEqual(R.juryScores());
  });

  it('the flag off: no directive, no chain read, and the verdict names no fault', async () => {
    const result = await run(canaryFaultConfigFromEnv({}));
    expect(ai.state.calls[0].canaryFault).toBeUndefined();
    expect(chain.calls).toEqual([]);
    expect(result.metadata.canary_fault).toBeUndefined();
  });

  it('a claim settled by the runner never reaches the switch: no chain read', async () => {
    runner.state.answer = (body) => R.definitive(body, { stop: 'build' });
    const result = await run(armed());
    expect(chain.calls).toEqual([]);
    expect(ai.state.calls).toHaveLength(0);
    expect(result.scores[0].score).toBe(1000000);
    expect(result.metadata.canary_fault).toBeUndefined();
  });
});

describe('it changes nothing that settles', () => {
  const strip = ({ deadlineMs, ...rest }) => rest; // eslint-disable-line no-unused-vars

  it('the request but for the directive, the verdict but for the metadata: the same bytes, armed or off', async () => {
    const off = await run(canaryFaultConfigFromEnv({}));
    const bodyOff = ai.state.calls[0];
    ai.state.calls.length = 0;
    const on = await run(armed());
    const bodyOn = ai.state.calls[0];

    const { canaryFault, ...sentOn } = bodyOn;
    expect(canaryFault).toBeDefined();
    expect({ ...sentOn, codeReview: strip(sentOn.codeReview) }).toEqual({ ...bodyOff, codeReview: strip(bodyOff.codeReview) });

    expect(on.scores).toEqual(off.scores);
    expect(on.justification).toBe(off.justification);
    expect(on.metadata.reportSha256).toBe(off.metadata.reportSha256);
    const { canary_fault: gone, ...metadataOn } = on.metadata;
    expect(gone).toBeDefined();
    expect(metadataOn).toEqual(off.metadata);
  });

  it('the runner is sent the same body, armed or off: it never meets the switch', async () => {
    await run(canaryFaultConfigFromEnv({}));
    await run(armed());
    expect(runner.state.runs[1]).toEqual(runner.state.runs[0]);
  });

  it('whatever an AI Node stamps cannot reach the verdict: only strings and whole numbers, from a fixed list, go in the metadata', async () => {
    ai.state.answer = (body) => R.juryAnswer(body, {
      codeReview: { ...R.juryAnswer(body).json.codeReview, canaryFault: { state: 'armed<script>', action: { nested: 'x' }, justifierMs: 'many', extra: 'HUNTER-TEXT' } }
    });
    const result = await run(armed());
    const shown = JSON.stringify(result.metadata);
    expect(shown).not.toContain('HUNTER-TEXT');
    expect(shown).not.toContain('<script>');
    expect(result.metadata.canary_fault.action).toBeNull();
    expect(result.metadata.canary_fault.justifierMs).toBeNull();
    expect(result.metadata.canary_fault_ai_node).toBe('unknown');
  });
});

describe('the facts L4 reads off a verdict', () => {
  it('the AI Node\'s own state, on every jury verdict', async () => {
    ai.state.answer = (body) => R.juryAnswer(body, { codeReview: { ...R.juryAnswer(body).json.codeReview, canaryFault: { state: 'off', action: null, justifierMs: 1 } } });
    const result = await run(canaryFaultConfigFromEnv({}));
    expect(result.metadata.canary_fault_ai_node).toBe('off');
  });

  it('how the image was had: the runner\'s fact, on a jury verdict', async () => {
    runner.state.answer = (body) => {
      const out = R.definitive(body);
      out.json.image = { ref: body.spec.env.image, cache: 'pulled', durationMs: 21000 };
      return out;
    };
    const result = await run(canaryFaultConfigFromEnv({}));
    expect(result.metadata.runner_image).toEqual({ cache: 'pulled', durationMs: 21000 });
  });

  describe('a kept run serves later rounds, and they pulled nothing', () => {
    const pulling = (body) => {
      const out = R.definitive(body);
      out.json.image = { ref: body.spec.env.image, cache: 'pulled', durationMs: 21000 };
      return out;
    };
    const runs = () => new SharedRuns();
    const OTHER_ROUND = `0x${'b7'.repeat(32)}`;

    it('the round that started it has the runner\'s fact; another round within the 15 minutes says reused', async () => {
      runner.state.answer = pulling;
      const shared = runs();
      const first = await run(canaryFaultConfigFromEnv({}), { runs: shared });
      const second = await run(canaryFaultConfigFromEnv({}), { runs: shared, canaryRequest: { aggId: OTHER_ROUND, jobId: JOB_ID } });
      expect(runner.state.runs).toHaveLength(1);
      expect(first.metadata.runner_image).toEqual({ cache: 'pulled', durationMs: 21000 });
      expect(second.metadata.runner_image).toEqual({ cache: 'reused', durationMs: 0 });
      expect(second.scores).toEqual(first.scores);
      expect(second.justification).toBe(first.justification);
    });

    it('the jobs of one round share its fact, in flight or kept', async () => {
      runner.state.answer = pulling;
      const shared = runs();
      const [a, b] = await Promise.all([run(canaryFaultConfigFromEnv({}), { runs: shared }), run(canaryFaultConfigFromEnv({}), { runs: shared })]);
      const c = await run(canaryFaultConfigFromEnv({}), { runs: shared });
      expect(runner.state.runs).toHaveLength(1);
      for (const result of [a, b, c]) expect(result.metadata.runner_image).toEqual({ cache: 'pulled', durationMs: 21000 });
    });

    it('with no round id there is no telling: no fact', async () => {
      runner.state.answer = pulling;
      const result = await run(canaryFaultConfigFromEnv({}), { canaryRequest: { aggId: '', jobId: JOB_ID } });
      expect(result.metadata.runner_image).toBeNull();
    });
  });

  it.each([
    ['an unknown cache word', { cache: 'HUNTER-TEXT', durationMs: 1 }],
    ['a time that is not a number', { cache: 'hit', durationMs: 'soon' }],
    ['no image', null]
  ])('%s: no fact, rather than a guess', async (_name, image) => {
    runner.state.answer = (body) => {
      const out = R.definitive(body);
      out.json.image = image;
      return out;
    };
    const result = await run(canaryFaultConfigFromEnv({}));
    expect(result.metadata.runner_image).toBeNull();
  });

  it('a dispute names its statement', async () => {
    const statementCid = H.cid('Statement');
    const context = { ...contextFor(), dispute: { statementCid, statement: 'The maker disputes this.' } };
    const result = await runClaim(context, {
      config: { runner: { url: runner.url, readToken: () => TOKEN }, aiNode: { url: ai.url } },
      logger: silent,
      runs: new SharedRuns(),
      deadline: createDeadline({ receivedAt: 0, deadlineMs: 780000, now: () => t }),
      canaryConfig: canaryFaultConfigFromEnv({})
    });
    expect(result.metadata.dispute_statement).toBe(statementCid);
  });

  it('no dispute, no such field', async () => {
    const result = await run(canaryFaultConfigFromEnv({}));
    expect(result.metadata.dispute_statement).toBeUndefined();
  });
});
