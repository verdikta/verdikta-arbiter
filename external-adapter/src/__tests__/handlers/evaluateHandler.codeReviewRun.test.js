// Node A4b at the handler: a claim through the real front gates, the real run
// and the real commit/reveal tail. Only the edges are doubles: IPFS, and two
// real HTTP servers standing in for the code runner and the AI Node.
//
// Settlement vocabulary (design §12, owner decision Q35):
//  - abstain: errored/500, aggregatedScore [0], no commit, no upload, in every mode.
//  - deterministic INVALID or DUPLICATE: the full mass on one outcome through the
//    normal commit/reveal tail, no AI call, the Execution evidence block first.

const fs = require('fs');

jest.mock('../../services/aiClient');

const mockState = {};
jest.mock('@verdikta/common', () => {
  const actual = jest.requireActual('@verdikta/common');
  return {
    ...actual,
    createClient: (cfg) => {
      const client = actual.createClient({ ...cfg, logging: { level: 'error', console: false } });
      client.archiveService.getArchive = jest.fn();
      client.ipfsClient.uploadToIPFS = jest.fn();
      mockState.client = client;
      return client;
    }
  };
});

const { codeReview } = require('@verdikta/common');
const H = require('../../../test/helpers/codeReviewFixtures');
const R = require('../../../test/helpers/codeReviewRun');
const evaluateHandler = require('../../handlers/evaluateHandler');
const aiClient = require('../../services/aiClient');
const claimRun = require('../../codeReview/claimRun');
const commitStore = require('../../services/commitStore');
const { sharedRuns } = require('../../codeReview/sharedRuns');
const { EVIDENCE_HEADER } = require('../../codeReview/evidence');
const { loadCodeReviewConfig } = require('../../codeReview/config');

const BUILDER = codeReview.createDevBuilderKey();
const TOKEN = 'runner-token-0123456789abcdef0123456789abcdef';
const BASE_ENV = Object.freeze({
  CODE_REVIEW_ENABLED: 'true',
  CODE_RUNNER_TOKEN: TOKEN,
  CODE_REVIEW_TRUST: 'dev',
  CODE_REVIEW_DEV_KEYS: BUILDER.publicKey,
  NETWORK_CHAIN_ID: '84532'
});
const INVALID = [1000000, 0, 0, 0, 0, 0];
const DUPLICATE = [0, 1000000, 0, 0, 0, 0];
const HIGH = [0, 0, 0, 0, 1000000, 0];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lineOf = (text, key) => (text.split('\n').find((l) => l.startsWith(`${key}: `)) || '').slice(key.length + 2);

let archives;
let uploaded;
let logLines;
let runner;
let ai;
let saveSpy;
let fetchDelayMs;

function useConfig(change = {}) {
  loadCodeReviewConfig({ ...BASE_ENV, CODE_RUNNER_URL: runner.url, AI_NODE_URL: ai.url, ...change });
}

/** A claim request: a listing at cids[0], the claim at cids[1], prior findings, the E1 line. */
function scenario(options = {}) {
  const label = options.label || '';
  const listing = options.listingObject || H.makeListing({ builderKey: BUILDER, ...(options.listing || {}) });
  const claim = options.claimObject || H.makeClaim(options.claim || {});
  const disclosure = H.discloseClaim(claim.buffer, listing.disclosure.recipient, { ciphertextCid: H.cid(`Ciphertext${label}`) });
  const priorBuffers = options.priorBuffers || [];
  const cids = {
    listing: H.cid(`Listing${label}`),
    claim: H.cid(options.claimLabel || 'Claim'),
    priors: options.priorCids || priorBuffers.map((_, i) => H.cid(`Prior${'ABCDEFGH'[i]}`))
  };
  archives[cids.listing] = listing.buffer;
  archives[cids.claim] = claim.buffer;
  cids.priors.forEach((priorCid, i) => { archives[priorCid] = priorBuffers[i] || H.makePrior('ABCDEFGH'[i]).buffer; });
  archives[disclosure.fields.ciphertextCid] = disclosure.ciphertext;
  let addendum = disclosure.line;
  if (options.dispute !== undefined) {
    const statementCid = H.cid('Statement');
    archives[statementCid] = Buffer.from(options.dispute, 'utf8');
    addendum += `\n${codeReview.formatDisputeLine(statementCid)}`;
  }
  const list = [cids.listing, cids.claim, ...cids.priors];
  return { listing, cids, disclosure, cid: (mode) => `${mode === undefined ? '' : `${mode}:`}${list.join(',')}:${addendum}` };
}

const request = (cidString, id = 'job-1') => ({ id, data: { cid: cidString, aggId: '0xagg' } });
const hashOf = (commitment) => BigInt(commitment).toString(16).padStart(32, '0');

beforeEach(async () => {
  jest.clearAllMocks();
  archives = {};
  uploaded = [];
  logLines = [];
  fetchDelayMs = 0;
  sharedRuns.clear();
  runner = await R.startRunner();
  ai = await R.startAiNode();
  useConfig();

  const { archiveService, ipfsClient, logger } = mockState.client;
  archiveService.getArchive.mockImplementation(async (c) => {
    if (fetchDelayMs) await sleep(fetchDelayMs);
    if (!archives[c]) throw new Error('Unable to fetch archive from IPFS.');
    return archives[c];
  });
  ipfsClient.uploadToIPFS.mockImplementation(async (filePath) => {
    uploaded.push(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    return `QmJustification${uploaded.length}`;
  });
  saveSpy = jest.spyOn(commitStore, 'save');

  const capture = (level) => (...args) => {
    logLines.push(`${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  };
  for (const level of ['info', 'warn', 'error', 'debug']) jest.spyOn(logger, level).mockImplementation(capture(level));
  for (const level of ['log', 'warn', 'error', 'info']) jest.spyOn(console, level).mockImplementation(capture(`console.${level}`));
});

afterEach(async () => {
  jest.restoreAllMocks();
  await runner.close();
  await ai.close();
});

afterAll(() => loadCodeReviewConfig({}));

/** Errored, no commit, nothing uploaded; the job fails, so no transaction follows. */
function expectAbstain(res, pattern) {
  expect(res.statusCode).toBe(500);
  expect(res.status).toBe('errored');
  expect(res.data.aggregatedScore).toEqual([0]);
  expect(res.data.justificationCid).toBeUndefined();
  if (pattern) expect(res.error).toMatch(pattern);
  expect(saveSpy).not.toHaveBeenCalled();
  expect(uploaded).toHaveLength(0);
}

/** Commit in mode 1, then reveal in mode 2. */
async function commitAndReveal(s, id = 'job-1') {
  const commit = await evaluateHandler(request(s.cid(1), id));
  expect(commit.statusCode).toBe(200);
  expect(commit.status).toBe('success');
  expect(commit.data.aggregatedScore).toHaveLength(1);
  const [commitment] = commit.data.aggregatedScore;
  expect(BigInt(commitment) > 0n).toBe(true);
  expect(commit.data.justificationCid).toBe('');
  const stored = await commitStore.get(hashOf(commitment));
  const reveal = await evaluateHandler(request(`2:${commitment}`, `${id}-reveal`));
  expect(reveal.statusCode).toBe(200);
  return { commitment, stored, reveal, justification: uploaded[uploaded.length - 1] };
}

async function expectDeterministic(shape, vector) {
  runner.state.answer = (body) => R.definitive(body, shape);
  const s = scenario();
  const out = await commitAndReveal(s);
  expect(out.reveal.data.aggregatedScore).toEqual(vector);
  expect(ai.state.calls).toHaveLength(0);
  expect(aiClient.evaluate).not.toHaveBeenCalled();
  expect(out.justification.justification.startsWith(EVIDENCE_HEADER)).toBe(true);
  return out;
}

describe('the fixtures this node answers for are in common\'s catalogue', () => {
  it.each([
    'concurrent-listings-different-baseline-bytes', 'registry-failure', 'cancellation-at-deadline', 'fix-patch-does-not-verify', 'provider-timeout-with-retry'
  ])('%s', (id) => {
    expect(codeReview.loadFixtures().cases.map((c) => c.id)).toContain(id);
  });
});

// ---------------------------------------------------------------------------
describe('acceptance 1: one deadline from receipt', () => {
  it('the runner and the AI Node are told what remains of 780 s from receipt, fetch time included', async () => {
    fetchDelayMs = 40; // four archives: listing, claim, then the ciphertext at the disclosure gate
    runner.state.answer = async (body) => { await sleep(150); return R.definitive(body); };
    const s = scenario();
    const before = Date.now();
    const res = await evaluateHandler(request(s.cid(1)));
    const elapsed = Date.now() - before;
    expect(res.statusCode).toBe(200);

    const told = runner.state.runs[0].deadline;
    expect(Number.isInteger(told)).toBe(true);
    expect(told).toBeLessThanOrEqual(780000 - 30);
    expect(told).toBeGreaterThanOrEqual(780000 - elapsed);

    const toAi = ai.state.calls[0].codeReview.deadlineMs;
    expect(Number.isInteger(toAi)).toBe(true);
    expect(toAi).toBeLessThanOrEqual(told - 140);
    expect(toAi).toBeGreaterThanOrEqual(780000 - elapsed);
  });

  it('CODE_REVIEW_DEADLINE_MS sets it', async () => {
    useConfig({ CODE_REVIEW_DEADLINE_MS: '600000' });
    const s = scenario();
    await evaluateHandler(request(s.cid(1)));
    expect(runner.state.runs[0].deadline).toBeLessThanOrEqual(600000);
    expect(runner.state.runs[0].deadline).toBeGreaterThan(590000);
  });

  it('a jury verdict ready past the deadline is not committed', async () => {
    useConfig({ CODE_REVIEW_DEADLINE_MS: '200' });
    jest.spyOn(claimRun, 'runClaim').mockImplementation(async () => {
      await sleep(300);
      return { scores: R.juryScores(), justification: 'late' };
    });
    const res = await evaluateHandler(request(scenario().cid(1)));
    expectAbstain(res, /CODE_REVIEW_DEADLINE/);
  });

  it('a runner verdict ready past the deadline is not committed', async () => {
    useConfig({ CODE_REVIEW_DEADLINE_MS: '200' });
    jest.spyOn(claimRun, 'runClaim').mockImplementation(async () => {
      await sleep(300);
      return { scores: codeReview.BUG_OUTCOMES.map((outcome, i) => ({ outcome, score: i === 0 ? 1000000 : 0 })), justification: 'late' };
    });
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_DEADLINE/);
  });

  it('a front-gate INVALID reached past the deadline is not committed either', async () => {
    useConfig({ CODE_REVIEW_DEADLINE_MS: '50' });
    fetchDelayMs = 100;
    const s = scenario({ claim: { finding: undefined } });
    expectAbstain(await evaluateHandler(request(s.cid(1))), /CODE_REVIEW_DEADLINE/);
    expect(runner.state.healthCalls).toBe(0);
  });

  it('with the deadline already spent the runner is not called', async () => {
    useConfig({ CODE_REVIEW_DEADLINE_MS: '1' });
    fetchDelayMs = 20;
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_DEADLINE/);
    expect(runner.state.runs).toHaveLength(0);
  });

  it('a mode-0 request keeps the same deadline: errored, no upload', async () => {
    useConfig({ CODE_REVIEW_DEADLINE_MS: '1' });
    fetchDelayMs = 20;
    expectAbstain(await evaluateHandler(request(scenario().cid(0))), /CODE_REVIEW_DEADLINE/);
  });
});

// ---------------------------------------------------------------------------
describe('acceptance 2: the shared run', () => {
  it('fixture: concurrent-listings-different-baseline-bytes: two listings never coalesce, each reads its own baseline', async () => {
    const disclosure = codeReview.generateDisclosureKeyPair();
    const stableOne = H.makeListing({ builderKey: BUILDER, disclosure });
    const stableTwo = H.makeListing({
      builderKey: BUILDER,
      disclosure,
      mutateBaseline: (baseline) => { baseline.timings.buildSeconds = 99.9; }
    });
    expect(stableTwo.spec.env.image).toBe(stableOne.spec.env.image);
    const claimObject = H.makeClaim();
    const a = scenario({ label: 'A', listingObject: stableOne, claimObject });
    const b = scenario({ label: 'B', listingObject: stableTwo, claimObject });

    // Answer only once both requests are at the runner: proof neither waited on the other's run.
    let release;
    const both = new Promise((resolve) => { release = resolve; });
    runner.state.answer = async (body, state) => {
      if (state.runs.length === 2) release();
      await Promise.race([both, sleep(3000)]);
      return R.definitive(body);
    };

    const [resA, resB] = await Promise.all([
      evaluateHandler(request(a.cid(1), 'job-a')),
      evaluateHandler(request(b.cid(1), 'job-b'))
    ]);
    expect(runner.state.runs).toHaveLength(2);
    const byListing = Object.fromEntries(runner.state.runs.map((r) => [r.listingCid, r]));
    expect(Object.keys(byListing).sort()).toEqual([a.cids.listing, b.cids.listing].sort());
    expect(byListing[a.cids.listing].baseline.timings.buildSeconds).toBe(14.2);
    expect(byListing[b.cids.listing].baseline.timings.buildSeconds).toBe(99.9);

    const storedA = await commitStore.get(hashOf(resA.data.aggregatedScore[0]));
    const storedB = await commitStore.get(hashOf(resB.data.aggregatedScore[0]));
    expect(storedA.result.metadata.reportSha256).not.toBe(storedB.result.metadata.reportSha256);
    expect(lineOf(storedA.result.justification, 'Listing')).toBe(a.cids.listing);
    expect(lineOf(storedB.result.justification, 'Listing')).toBe(b.cids.listing);
  });

  it('several of the operator\'s jobs on one claim: one runner call, a jury and a commitment each', async () => {
    runner.state.answer = async (body) => { await sleep(100); return R.definitive(body); };
    const s = scenario();
    const results = await Promise.all(['job-1', 'job-2', 'job-3'].map((id) => evaluateHandler(request(s.cid(1), id))));
    expect(runner.state.runs).toHaveLength(1);
    expect(ai.state.calls).toHaveLength(3);
    const commitments = results.map((r) => r.data.aggregatedScore[0]);
    expect(new Set(commitments).size).toBe(3);
    for (const commitment of commitments) {
      const stored = await commitStore.get(hashOf(commitment));
      expect(stored.result.scores.map((x) => x.score)).toEqual(HIGH);
    }
  });

  it('a job selected a little later is served from the run, without a sandbox', async () => {
    const s = scenario();
    await evaluateHandler(request(s.cid(1), 'job-1'));
    await evaluateHandler(request(s.cid(1), 'job-2'));
    expect(runner.state.runs).toHaveLength(1);
    expect(ai.state.calls).toHaveLength(2);
  });

  it('other prior findings are another run; the same list in the same order is the same run', async () => {
    const one = scenario({ priorCids: [H.cid('PriorA'), H.cid('PriorB')] });
    await evaluateHandler(request(one.cid(1), 'job-1'));
    expect(runner.state.runs).toHaveLength(1);
    await evaluateHandler(request(one.cid(1), 'job-2'));
    expect(runner.state.runs).toHaveLength(1);

    const reordered = scenario({ priorCids: [H.cid('PriorB'), H.cid('PriorA')] });
    await evaluateHandler(request(reordered.cid(1), 'job-3'));
    expect(runner.state.runs).toHaveLength(2);

    const fewer = scenario({ priorCids: [H.cid('PriorA')] });
    await evaluateHandler(request(fewer.cid(1), 'job-4'));
    expect(runner.state.runs).toHaveLength(3);
  });

  it('a new runner version is a new run', async () => {
    const s = scenario();
    await evaluateHandler(request(s.cid(1), 'job-1'));
    runner.state.health = () => ({ status: 200, json: { ok: true, reasons: [], version: '0.2.0' } });
    runner.state.answer = (body) => R.definitive(body, { runner: '0.2.0' });
    await evaluateHandler(request(s.cid(1), 'job-2'));
    expect(runner.state.runs).toHaveLength(2);
  });

  it('a failed run is not kept: the next job starts again', async () => {
    runner.state.answer = () => R.abstained('docker_error');
    const s = scenario();
    expectAbstain(await evaluateHandler(request(s.cid(1), 'job-1')), /CODE_REVIEW_RUNNER_ABSTAIN/);
    runner.state.answer = undefined;
    const res = await evaluateHandler(request(s.cid(1), 'job-2'));
    expect(res.statusCode).toBe(200);
    expect(runner.state.runs).toHaveLength(2);
  });

  it('jobs waiting on one run share its failure: one call, every job abstains', async () => {
    runner.state.answer = async () => { await sleep(50); return R.abstained('pull_failed'); };
    const s = scenario();
    const results = await Promise.all(['a', 'b'].map((id) => evaluateHandler(request(s.cid(1), id))));
    expect(runner.state.runs).toHaveLength(1);
    for (const res of results) expectAbstain(res, /CODE_REVIEW_RUNNER_ABSTAIN/);
  });

  it('the EA sends the listing and the claim as the runner\'s request defines them', async () => {
    const fixPatch = H.FIX_PATCH;
    const s = scenario({ claim: { fixPatch }, priorCids: [H.cid('PriorA')] });
    await evaluateHandler(request(s.cid(1)));
    const body = runner.state.runs[0];
    expect(Object.keys(body).sort()).toEqual([
      'attestation', 'baseline', 'bcid', 'codeClass', 'deadline', 'eaGates', 'finding', 'fixPatch', 'knownIssues', 'listingCid',
      'pocPatch', 'priorFindings', 'report', 'spec'
    ]);
    expect(body.listingCid).toBe(s.cids.listing);
    expect(body.bcid).toBe(s.cids.claim);
    expect(body.spec).toEqual(s.listing.spec);
    expect(body.attestation).toEqual(s.listing.attestation);
    expect(body.baseline).toEqual(H.exampleBaseline(s.listing.spec.baseCommit));
    expect(body.finding).toEqual(H.FINDING);
    expect(body.report).toContain(H.REPORT_MARKER);
    expect(body.knownIssues).toEqual(H.exampleKnownIssues());
    expect(body.priorFindings).toHaveLength(1);
    expect(Object.keys(body.priorFindings[0]).sort()).toEqual(['bcid', 'finding', 'report']);
    expect(body.priorFindings[0].bcid).toBe(H.cid('PriorA'));
    expect(body.eaGates).toEqual({ disclosure: 'pass', inScope: 'pass' });
    expect(body.codeClass).toBe('code-standard');
    expect(Buffer.from(body.pocPatch, 'base64').toString('utf8')).toBe(H.POC_PATCH);
    expect(Buffer.from(body.fixPatch, 'base64').toString('utf8')).toBe(fixPatch);
    expect(runner.state.auth.every((value) => value === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('the token can come from CODE_RUNNER_TOKEN_FILE, read at the call', async () => {
    const os = require('os');
    const path = require('path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ea-token-')), 'token');
    fs.writeFileSync(file, `${TOKEN}-file\n`);
    useConfig({ CODE_RUNNER_TOKEN: undefined, CODE_RUNNER_TOKEN_FILE: file });
    await evaluateHandler(request(scenario().cid(1)));
    expect(runner.state.auth.every((value) => value === `Bearer ${TOKEN}-file`)).toBe(true);
  });

  it.each([
    ['listingCid', { inputs: { listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' } }],
    ['bcid', { inputs: { bcid: 'QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A' } }],
    ['attestationSha256', { inputs: { attestationSha256: 'd'.repeat(64) } }],
    ['pocPatchSha256', { inputs: { pocPatchSha256: 'd'.repeat(64) } }],
    ['baseCommit', { inputs: { baseCommit: 'e'.repeat(40) } }],
    ['envImage', { inputs: { envImage: `sha256:${'e'.repeat(64)}` } }]
  ])('a report whose %s is not this claim\'s is never settled on, even when the gates failed', async (_field, shape) => {
    runner.state.answer = (body) => R.definitive(body, { ...shape, stop: 'build' });
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_RUN_MISMATCH/);
    expect(ai.state.calls).toHaveLength(0);
  });

  it('a report that claims a fix patch the claim does not carry is refused', async () => {
    runner.state.answer = (body) => R.definitive(body, { inputs: { fixPatchSha256: 'd'.repeat(64) }, fix: R.GOOD_FIX, diff: { poc: { files: 1, added: 1, removed: 0 }, fix: { files: 1, added: 1, removed: 0 } } });
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_RUN_MISMATCH/);
  });
});

// ---------------------------------------------------------------------------
describe('acceptance 3: runner abstain or an unreachable or unhealthy runner → error, no commit', () => {
  it.each(['pull_failed', 'registry_not_allowed'])('fixture: registry-failure (%s): errored, no commit, no AI call', async (cause) => {
    runner.state.answer = () => R.abstained(cause);
    const res = await evaluateHandler(request(scenario().cid(1)));
    expectAbstain(res, new RegExp(`CODE_REVIEW_RUNNER_ABSTAIN.*${cause}`));
    expect(ai.state.calls).toHaveLength(0);
  });

  it.each([
    'admission_refused', 'docker_unreachable', 'docker_error', 'image_unavailable', 'image_mismatch', 'step_timeout', 'deadline',
    'oom', 'pids_limit', 'step_not_started', 'sandbox_died', 'killed_by_signal', 'cancelled', 'runner_error'
  ])('runner abstain %s: errored, no commit, no AI call', async (cause) => {
    runner.state.answer = () => R.abstained(cause, 'build');
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), new RegExp(cause));
    expect(ai.state.calls).toHaveLength(0);
  });

  it('the runner\'s free-text detail stays out of the error', async () => {
    runner.state.answer = () => R.abstained('docker_error');
    const res = await evaluateHandler(request(scenario().cid(1)));
    expect(res.error).not.toContain('HUNTER-TEXT-IN-DETAIL');
    expect(logLines.join('\n')).not.toContain('HUNTER-TEXT-IN-DETAIL');
  });

  it('an unreachable runner', async () => {
    await runner.close();
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_RUNNER_UNREACHABLE/);
    expect(ai.state.calls).toHaveLength(0);
  });

  it('a runner that goes away during the run', async () => {
    runner.state.answer = () => { setImmediate(() => runner.close()); return R.HANG; };
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_RUNNER_UNREACHABLE/);
  });

  it.each([
    ['503', { status: 503, json: { ok: false, reasons: ['the maintenance lock is held'], version: R.RUNNER_VERSION } }],
    ['200 with ok false', { status: 200, json: { ok: false, reasons: [], version: R.RUNNER_VERSION } }],
    ['no version', { status: 200, json: { ok: true, reasons: [] } }],
    ['a version that is not one', { status: 200, json: { ok: true, reasons: [], version: 'x y' } }],
    ['401', { status: 401, json: { error: 'unauthorized' } }],
    ['not JSON', { status: 200, raw: 'oops' }]
  ])('an unhealthy runner (%s): no run started', async (_label, health) => {
    runner.state.health = () => health;
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_RUNNER_UNHEALTHY/);
    expect(runner.state.runs).toHaveLength(0);
    expect(ai.state.calls).toHaveLength(0);
  });

  it.each([
    ['413, a body over the limit', { status: 413, json: { error: 'payload_too_large' } }],
    ['401', { status: 401, json: { error: 'unauthorized' } }],
    ['500', { status: 500, json: { outcome: 'abstain', abstain: { cause: 'runner_error', step: null, detail: 'internal error' } } }],
    ['503 that says definitive', { status: 503, json: { outcome: 'definitive' } }],
    ['200 that says abstain', { status: 200, json: { outcome: 'abstain', abstain: { cause: 'oom' } } }],
    ['200 that is not JSON', { status: 200, raw: '{"outcome":"definitive","report":' }],
    ['200 with an empty object', { status: 200, json: {} }]
  ])('an answer that is no fact (%s) abstains', async (_label, answer) => {
    runner.state.answer = () => answer;
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_RUNNER/);
    expect(ai.state.calls).toHaveLength(0);
  });

  it('a 400 requester_error is the requester\'s: errored, no commit, the codes named', async () => {
    runner.state.answer = () => ({ status: 400, json: { outcome: 'requester_error', issues: [{ code: 'BASELINE_INVALID', path: '/baseline', detail: 'HUNTER-TEXT-IN-DETAIL' }] } });
    const res = await evaluateHandler(request(scenario().cid(1)));
    expectAbstain(res, /CODE_REVIEW_RUNNER_REFUSED.*BASELINE_INVALID/);
    expect(res.error).not.toContain('HUNTER-TEXT-IN-DETAIL');
  });

  it('a definitive run with reportUnavailable (linux/arm64) abstains, whatever its gates say', async () => {
    runner.state.answer = (body) => {
      const answer = R.definitive(body, { stop: 'build' });
      answer.json.report = null;
      answer.json.reportSha256 = null;
      answer.json.reportUnavailable = 'the report\'s platform is linux/amd64; this run used linux/arm64 (a development setting)';
      answer.json.gates = { applies: { status: 'pass' }, testPathsOnly: { status: 'pass' }, build: { status: 'fail', basis: 'exit_code', detail: null } };
      return answer;
    };
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_REPORT_UNAVAILABLE/);
    expect(ai.state.calls).toHaveLength(0);
  });

  it('a definitive run with no report and no reason abstains', async () => {
    runner.state.answer = (body) => {
      const answer = R.definitive(body);
      answer.json.report = null;
      return answer;
    };
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_REPORT/);
  });

  it('a report common\'s validator refuses is never settled on: a failed gate in it counts for nothing', async () => {
    runner.state.answer = (body) => R.definitive(body, { gates: { build: 'fail' } }, { unchecked: true });
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_REPORT_INVALID/);
    expect(ai.state.calls).toHaveLength(0);
  });

  it('a report whose hash is not its own is refused', async () => {
    runner.state.answer = (body) => {
      const answer = R.definitive(body, { stop: 'build' });
      answer.json.reportSha256 = 'f'.repeat(64);
      return answer;
    };
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_REPORT_HASH/);
  });

  it('a report from another runner version than the key names is refused', async () => {
    runner.state.answer = (body) => R.definitive(body, { runner: '9.9.9', stop: 'build' });
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_RUN_MISMATCH/);
  });

  it('a report under other rules than the EA pins is refused', async () => {
    runner.state.answer = (body) => R.definitive(body, { inputs: { semgrepRules: '1999.01' }, stop: 'build' });
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_RUN_MISMATCH/);
  });
});

describe('acceptance 3: deterministic verdicts, no AI call', () => {
  it.each(['applies', 'testPathsOnly', 'build'])('gate %s failed: INVALID through commit and reveal', async (gate) => {
    const out = await expectDeterministic({ stop: gate }, INVALID);
    expect(out.stored.result.metadata).toMatchObject({ verdict_source: 'code-review-runner', gate });
    expect(out.justification.justification).toContain(`Gate: ${gate}`);
    expect(lineOf(out.justification.justification, 'Settlement')).toBe(`INVALID (${gate})`);
  });

  it('claimedObservable failed: INVALID', async () => {
    const out = await expectDeterministic({ claimedObservable: 'fail' }, INVALID);
    expect(out.justification.justification).toContain('Gate: claimedObservable');
  });

  it('reproduces failed on its own: INVALID, the runs counted', async () => {
    const out = await expectDeterministic({ runs: [['fail', 'pass', 'fail']] }, INVALID);
    expect(out.justification.justification).toContain('Gate: reproduces');
    expect(out.justification.justification).toContain('#1 fail,pass,fail');
  });

  it('reproduces failed on its own beside a failed check: still INVALID', async () => {
    const out = await expectDeterministic({ runs: [['pass', 'fail', 'fail']], integrity: { frameworkUnchanged: false } }, INVALID);
    expect(lineOf(out.justification.justification, 'Settlement')).toBe('INVALID (reproduces)');
  });

  it('the patch added no test: INVALID', async () => {
    const out = await expectDeterministic({ tests: [] }, INVALID);
    expect(lineOf(out.justification.justification, 'Settlement')).toBe('INVALID (reproduces)');
  });

  it.each(codeReview.INTEGRITY_CHECKS)('Q35: %s failed, reproduces failed only through it: all weight on DUPLICATE', async (check) => {
    const out = await expectDeterministic({ integrity: { [check]: false } }, DUPLICATE);
    expect(lineOf(out.justification.justification, 'Settlement')).toBe('DUPLICATE (integrity)');
    expect(lineOf(out.justification.justification, 'Integrity-Failed-Checks')).toBe(check);
    expect(out.stored.result.metadata).toMatchObject({ verdict_source: 'code-review-integrity', failedChecks: [check] });
  });

  it('Q35: the schedule stopped by integrity after a failing run: DUPLICATE', async () => {
    await expectDeterministic({ runs: [['fail', 'not-run', 'not-run']], integrity: { dependenciesUnchanged: false } }, DUPLICATE);
  });

  it('Q35: a tamper flag: INVALID', async () => {
    const out = await expectDeterministic({ tamperFlags: [{ kind: 'reporter-patched', file: 'test/E.t.sol', line: 2 }] }, INVALID);
    expect(lineOf(out.justification.justification, 'Tamper-Flags')).toBe('reporter-patched=1');
  });

  it('Q35: a tamper flag beside another failed check: still INVALID', async () => {
    const out = await expectDeterministic({
      tamperFlags: [{ kind: 'exit-handler-registered', file: 'test/E.t.sol', line: 2 }],
      integrity: { summaryConsistent: false }
    }, INVALID);
    expect(lineOf(out.justification.justification, 'Integrity-Failed-Checks')).toBe('summaryConsistent');
    expect(lineOf(out.justification.justification, 'Settlement')).toBe('INVALID (integrity)');
  });

  it('the same report gives the same justification on every job; `detail` and `facts` reach none of it', async () => {
    runner.state.answer = (body) => R.definitive(body, { integrity: { frameworkUnchanged: false } });
    const s = scenario();
    const one = await commitAndReveal(s, 'job-1');
    const two = await commitAndReveal(s, 'job-2');
    expect(two.justification.justification).toBe(one.justification.justification);
    expect(one.justification.justification).not.toContain('RUN-SPECIFIC-DETAIL');
  });

  it('a deterministic verdict in mode 0 uploads straight away, with the block', async () => {
    runner.state.answer = (body) => R.definitive(body, { stop: 'build' });
    const res = await evaluateHandler(request(scenario().cid(0)));
    expect(res.statusCode).toBe(200);
    expect(res.data.aggregatedScore).toEqual(INVALID);
    expect(uploaded[0].justification.startsWith(EVIDENCE_HEADER)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('acceptance 4: the AI Node handoff', () => {
  it('sends the pack as named attachments, in order, with nothing beside it, and the codeReview field', async () => {
    const s = scenario({ priorCids: [H.cid('PriorA'), H.cid('PriorB')] });
    await evaluateHandler(request(s.cid(1)));
    expect(ai.state.calls).toHaveLength(1);
    const body = ai.state.calls[0];
    const pack = R.packFor(runner.state.runs[0]);

    expect(body.attachments).toEqual(pack.files.map((f) => f.text));
    expect(body.attachmentNames).toEqual(pack.files.map((f) => f.name));
    expect(body.outcomes).toEqual([...codeReview.BUG_OUTCOMES]);
    expect(body.prompt).toBe(codeReview.buildClaimQuery(s.listing.spec));
    expect(body.models).toEqual(codeReview.CODE_STANDARD_PANEL.AI_NODES.map((n) => ({ provider: n.AI_PROVIDER, model: n.AI_MODEL, weight: n.WEIGHT, count: n.NO_COUNTS })));
    expect(body.iterations).toBe(codeReview.CODE_STANDARD_PANEL.ITERATIONS);

    const checked = codeReview.validateCodeReviewRequest(body.codeReview);
    expect(checked.issues).toEqual([]);
    expect(body.codeReview.priorFindings).toEqual([H.cid('PriorA'), H.cid('PriorB')]);
    expect(body.codeReview.knownIssues).toEqual(H.exampleKnownIssues().map((k) => k.id));
    expect(body.codeReview.claim).toEqual({ bcid: s.cids.claim, finding: H.FINDING });
    expect(body.codeReview.dispute).toBeNull();
    expect(body.codeReview.codeClass).toBe('code-standard');
  });

  it('prior findings reach the jury only inside the pack: the field holds their ids, not their text', async () => {
    const s = scenario({ priorCids: [H.cid('PriorA')] });
    await evaluateHandler(request(s.cid(1)));
    const body = ai.state.calls[0];
    expect(JSON.stringify(body.codeReview)).not.toContain('Prior finding A');
    expect(JSON.stringify(body.codeReview)).not.toContain('An earlier valid finding');
    expect(body.attachments.join('\n')).toContain('Prior finding A');
    expect(body.prompt).not.toContain('Prior finding A');
  });

  it('the disclosure keys reach nothing the AI Node reads', async () => {
    const s = scenario();
    await evaluateHandler(request(s.cid(1)));
    const text = JSON.stringify(ai.state.calls[0]);
    expect(text).not.toMatch(/verdikta-(disclosure|dispute)/);
    for (const key of [s.disclosure.fields.contentKey, s.disclosure.fields.ephemeralKey]) {
      const hex = typeof key === 'string' ? key.replace(/^0x/, '') : Buffer.from(key).toString('hex');
      expect(hex).toMatch(/^[0-9a-f]+$/);
      expect(text).not.toContain(hex);
    }
  });

  it('on a dispute the maker\'s statement travels in the field, with its CID', async () => {
    const s = scenario({ dispute: 'The PoC asserts documented behaviour.' });
    await evaluateHandler(request(s.cid(1)));
    expect(ai.state.calls[0].codeReview.dispute).toEqual({ statementCid: H.cid('Statement'), statement: 'The PoC asserts documented behaviour.' });
  });

  it('a request the schema refuses never reaches a model (an empty dispute statement): errored, no commit', async () => {
    const s = scenario({ dispute: '' });
    expectAbstain(await evaluateHandler(request(s.cid(1))), /CODE_REVIEW_AI_REQUEST/);
    expect(ai.state.calls).toHaveLength(0);
  });

  it('a pack that is not usable abstains rather than judging without it', async () => {
    for (const [mutate, label] of [
      [(pack) => null, 'null'],
      [(pack) => ({ ...pack, files: [] }), 'empty'],
      [(pack) => ({ ...pack, files: [{ name: '', tier: 'poc', text: 'x' }] }), 'unnamed'],
      [(pack) => ({ ...pack, files: [{ name: 'a', tier: 'poc', text: 7 }] }), 'not text'],
      [(pack) => ({ ...pack, files: [{ name: 'a', tier: 'poc', text: 'data:text/plain;base64,aGk=' }] }), 'a data URI'],
      [(pack) => ({ ...pack, codeClass: 'code-premium' }), 'another class'],
      [(pack) => ({ ...pack, usedTokens: pack.budgetTokens + 1 }), 'over budget']
    ]) {
      sharedRuns.clear();
      runner.state.answer = (body) => {
        const answer = R.definitive(body);
        answer.json.contextPack = mutate(answer.json.contextPack);
        return answer;
      };
      const res = await evaluateHandler(request(scenario().cid(1)));
      expect([label, res.statusCode]).toEqual([label, 500]);
      expectAbstain(res, /CODE_REVIEW_PACK/);
    }
    expect(ai.state.calls).toHaveLength(0);
  });

  it('a gate verdict needs no pack', async () => {
    runner.state.answer = (body) => {
      const answer = R.definitive(body, { stop: 'applies' });
      answer.json.contextPack = null;
      return answer;
    };
    const res = await evaluateHandler(request(scenario().cid(1)));
    expect(res.statusCode).toBe(200);
  });

  it('fixture: fix-patch-does-not-verify: the report records it, the jury judges, the outcome is unaffected', async () => {
    const fix = { ...R.GOOD_FIX, pocPasses: false, regressions: ['test/Vault.t.sol > VaultTest > test_deposit()'], regressionCount: 1 };
    runner.state.answer = (body) => R.definitive(body, { fix });
    const s = scenario({ claim: { fixPatch: H.FIX_PATCH } });
    const out = await commitAndReveal(s);
    expect(out.reveal.data.aggregatedScore).toEqual(HIGH);
    expect(ai.state.calls).toHaveLength(1);
    expect(ai.state.calls[0].codeReview.report.fix).toMatchObject({ pocPasses: false, regressionCount: 1 });
    expect(lineOf(out.justification.justification, 'Fix')).toBe('present=true applies=pass builds=pass pocPasses=false regressions=1 tier=B');
  });

  it.each([
    ['does not apply', { ...R.NO_FIX, present: true, applies: 'fail' }],
    ['does not build', { ...R.NO_FIX, present: true, applies: 'pass', builds: 'fail' }],
    ['carries a tamper flag', { ...R.GOOD_FIX, integrity: { ...R.CLEAN, tamperFlags: [{ kind: 'framework-patched', file: 'test/E.t.sol', line: 1 }] } }],
    ['fails a check', { ...R.GOOD_FIX, integrity: { ...R.CLEAN, frameworkUnchanged: false, tamperFlags: [] } }]
  ])('a fix patch that %s changes no verdict: the jury judges', async (_label, fix) => {
    runner.state.answer = (body) => R.definitive(body, { fix });
    const s = scenario({ claim: { fixPatch: H.FIX_PATCH } });
    const res = await evaluateHandler(request(s.cid(1)));
    expect(res.statusCode).toBe(200);
    expect(ai.state.calls).toHaveLength(1);
  });

  it('a lone surrogate in finding.json goes to the AI Node in a form it can read; the jury still judges', async () => {
    const finding = JSON.stringify({ ...H.FINDING }).replace('Reentrancy', 'Reentrancy \\ud83d');
    expect(() => codeReview.canonicalJson(JSON.parse(finding))).toThrow();
    const res = await evaluateHandler(request(scenario({ claim: { finding } }).cid(1)));
    expect(res.statusCode).toBe(200);
    expect(() => codeReview.canonicalJson(ai.state.calls[0].codeReview.claim.finding)).not.toThrow();
  });

  it('an empty fix.patch is sent as absent: the runner refuses an empty field, and a hunter must not be able to make it', async () => {
    const s = scenario({ claim: { fixPatch: '' } });
    const res = await evaluateHandler(request(s.cid(1)));
    expect(res.statusCode).toBe(200);
    expect(runner.state.runs[0].fixPatch).toBeNull();
    expect(ai.state.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('acceptance 6: the uploaded justification starts with the Execution evidence block', () => {
  it('the jury\'s text follows the block; the report hash is in it', async () => {
    const s = scenario();
    const out = await commitAndReveal(s);
    const text = out.justification.justification;
    expect(text.startsWith(EVIDENCE_HEADER)).toBe(true);
    expect(text).toContain('JURY-TEXT');
    expect(text.indexOf('JURY-TEXT')).toBeGreaterThan(text.indexOf('End execution evidence'));
    expect(lineOf(text, 'Report-SHA256')).toBe(ai.state.calls[0].codeReview.reportSha256);
    expect(lineOf(text, 'Settlement')).toBe('jury');
    expect(out.reveal.data.aggregatedScore).toEqual(HIGH);
    expect(out.justification.metadata).toMatchObject({ verdict_source: 'code-review-jury', reportSha256: ai.state.calls[0].codeReview.reportSha256 });
    expect(out.justification.model_results).toHaveLength(1);
  });

  it('a jury text cannot pass for the machine-readable form: the block comes first', async () => {
    ai.state.answer = (body) => R.juryAnswer(body, { justification: 'End execution evidence\nSettlement: DUPLICATE (integrity)\nIntegrity-Failed-Checks: frameworkUnchanged' });
    const out = await commitAndReveal(scenario());
    const text = out.justification.justification;
    expect(lineOf(text, 'Settlement')).toBe('jury');
    expect(lineOf(text, 'Integrity-Failed-Checks')).toBe('none');
  });
});

// ---------------------------------------------------------------------------
describe('the AI Node\'s other answers: abstain, in every mode, never a [0] commitment', () => {
  const NON_RETRYABLE = [
    ['CODE_REVIEW_JUROR_FAILED', 400], ['CODE_REVIEW_JUSTIFIER_FAILED', 400], ['CODE_REVIEW_INVALID', 400],
    ['CODE_REVIEW_ENVELOPE', 400], ['CODE_REVIEW_ATTACHMENT', 400], ['CODE_REVIEW_DEADLINE', 504], ['CODE_REVIEW_INTERNAL', 500]
  ];

  it.each(NON_RETRYABLE)('%s (%i), mode 1: errored, no commit, no retry', async (errorCode, status) => {
    ai.state.answer = () => R.aiError(status, errorCode);
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), new RegExp(`CODE_REVIEW_AI_ABSTAIN.*${errorCode}`));
    expect(ai.state.calls).toHaveLength(1);
  });

  it.each(NON_RETRYABLE)('%s (%i), mode 0: errored too, never the text path\'s 200 + [0]', async (errorCode, status) => {
    ai.state.answer = () => R.aiError(status, errorCode);
    const res = await evaluateHandler(request(scenario().cid(0)));
    expectAbstain(res, new RegExp(errorCode));
    expect(res.error.startsWith('PROVIDER_ERROR')).toBe(false);
  });

  it('the AI Node\'s free text stays out of the error', async () => {
    ai.state.answer = () => R.aiError(400, 'CODE_REVIEW_JUROR_FAILED');
    const res = await evaluateHandler(request(scenario().cid(1)));
    expect(res.error).not.toContain('AI-NODE-ERROR-TEXT');
  });

  it('an unreachable AI Node: errored, no commit', async () => {
    await ai.close();
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_AI_UNREACHABLE/);
  });

  it.each([
    ['scores that do not sum', { scores: codeReview.BUG_OUTCOMES.map((outcome) => ({ outcome, score: 1 })) }],
    ['no scores', { scores: [] }],
    ['a fractional score', { scores: codeReview.BUG_OUTCOMES.map((outcome, i) => ({ outcome, score: i === 0 ? 999999.5 : (i === 1 ? 0.5 : 0) })) }],
    ['a verdict for another report', { codeReview: { reportSha256: '0'.repeat(64) } }],
    ['no report hash at all', { codeReview: undefined }],
    ['an empty justification', { justification: '' }],
    ['a justification that is not text', { justification: { text: 'x' } }]
  ])('a 200 with %s is never committed', async (_label, over) => {
    ai.state.answer = (body) => R.juryAnswer(body, over);
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_(RUN_RESULT|AI_ANSWER)/);
  });
});

// ---------------------------------------------------------------------------
describe('acceptance 5: the retry', () => {
  it('fixture: provider-timeout-with-retry: one retry, the sandbox not re-run, a smaller deadline', async () => {
    ai.state.answer = async (body, state) => {
      await sleep(30);
      return state.calls.length === 1 ? R.aiError(503, 'CODE_REVIEW_JUROR_TIMEOUT', true) : R.juryAnswer(body);
    };
    const out = await commitAndReveal(scenario());
    expect(out.reveal.data.aggregatedScore).toEqual(HIGH);
    expect(ai.state.calls).toHaveLength(2);
    expect(runner.state.runs).toHaveLength(1);
    expect(runner.state.healthCalls).toBe(1);
    const [first, second] = ai.state.calls;
    expect(second.codeReview.deadlineMs).toBeLessThanOrEqual(first.codeReview.deadlineMs - 25);
    expect(second.codeReview.report).toEqual(first.codeReview.report);
    expect(second.attachments).toEqual(first.attachments);
  });

  it('CODE_REVIEW_JUSTIFIER_TIMEOUT is retryable too', async () => {
    ai.state.answer = (body, state) => (state.calls.length === 1 ? R.aiError(503, 'CODE_REVIEW_JUSTIFIER_TIMEOUT', true) : R.juryAnswer(body));
    expect((await evaluateHandler(request(scenario().cid(1)))).statusCode).toBe(200);
    expect(ai.state.calls).toHaveLength(2);
  });

  it('one retry only: a second timeout abstains', async () => {
    ai.state.answer = () => R.aiError(503, 'CODE_REVIEW_JUROR_TIMEOUT', true);
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_AI_ABSTAIN.*CODE_REVIEW_JUROR_TIMEOUT/);
    expect(ai.state.calls).toHaveLength(2);
    expect(runner.state.runs).toHaveLength(1);
  });

  it('the retry does not depend on the kept run: with it evicted, still no sandbox', async () => {
    ai.state.answer = (body, state) => {
      if (state.calls.length === 1) {
        sharedRuns.clear();
        return R.aiError(503, 'CODE_REVIEW_JUROR_TIMEOUT', true);
      }
      return R.juryAnswer(body);
    };
    expect((await evaluateHandler(request(scenario().cid(1)))).statusCode).toBe(200);
    expect(runner.state.runs).toHaveLength(1);
  });

  it.each([
    ['503 without retryable', { status: 503, json: { errorCode: 'CODE_REVIEW_JUROR_TIMEOUT', retryable: false, scores: [] } }],
    ['500 with retryable', { status: 500, json: { errorCode: 'CODE_REVIEW_INTERNAL', retryable: true, scores: [] } }],
    ['503 with no body', { status: 503, raw: '' }]
  ])('%s is not the retryable status: no retry', async (_label, answer) => {
    ai.state.answer = () => answer;
    expectAbstain(await evaluateHandler(request(scenario().cid(1))), /CODE_REVIEW_AI_ABSTAIN/);
    expect(ai.state.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('fixture: cancellation-at-deadline', () => {
  it('the runner is still working at the deadline: the run is cancelled, errored, nothing is committed late', async () => {
    useConfig({ CODE_REVIEW_DEADLINE_MS: '2000' });
    runner.state.answer = () => R.HANG;
    const s = scenario();
    const before = Date.now();
    const res = await evaluateHandler(request(s.cid(1)));
    expect(Date.now() - before).toBeLessThan(2000 + 5000);
    expectAbstain(res, /CODE_REVIEW_DEADLINE/);
    expect(ai.state.calls).toHaveLength(0);
    for (let i = 0; i < 40 && runner.state.cancelled === 0; i += 1) await sleep(25);
    expect(runner.state.cancelled).toBe(1);
  });

  it('the AI Node is still working at the deadline: the call is cancelled, errored, nothing is committed late', async () => {
    // The real 780 s, with only setTimeout moved by hand: the juror floor keeps any shorter deadline from calling at all.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'hrtime', 'performance', 'Date'] });
    let res;
    try {
      ai.state.answer = () => R.HANG;
      const pending = evaluateHandler(request(scenario().cid(1)));
      for (let i = 0; i < 100000 && ai.state.calls.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
      expect(ai.state.calls).toHaveLength(1);
      jest.advanceTimersByTime(780000);
      res = await pending;
    } finally {
      jest.useRealTimers();
    }
    expectAbstain(res, /CODE_REVIEW_DEADLINE/);
    for (let i = 0; i < 40 && ai.state.cancelled === 0; i += 1) await sleep(25);
    expect(ai.state.cancelled).toBe(1);
  });

  it('a hung /health is bounded by the deadline too', async () => {
    useConfig({ CODE_REVIEW_DEADLINE_MS: '800' });
    runner.state.health = () => R.HANG;
    const before = Date.now();
    expectAbstain(await evaluateHandler(request(scenario().cid(1))));
    expect(Date.now() - before).toBeLessThan(800 + 5000);
    expect(runner.state.runs).toHaveLength(0);
  });

  it('a job waiting on another job\'s run keeps its own deadline, and does not cancel the run', async () => {
    runner.state.answer = async (body) => { await sleep(1200); return R.definitive(body); };
    const s = scenario();
    const first = evaluateHandler(request(s.cid(1), 'job-1'));
    for (let i = 0; i < 200 && runner.state.runs.length === 0; i += 1) await sleep(5);
    expect(runner.state.runs).toHaveLength(1);
    // the second job's deadline passes while the first job's run is still going
    useConfig({ CODE_REVIEW_DEADLINE_MS: '300' });
    const second = await evaluateHandler(request(s.cid(1), 'job-2'));
    useConfig();
    expect(second.statusCode).toBe(500);
    expect(second.error).toMatch(/CODE_REVIEW_DEADLINE/);
    expect(runner.state.cancelled).toBe(0);
    const res = await first;
    expect(res.statusCode).toBe(200);
    expect(runner.state.runs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('logs and errors carry codes and hashes, never claim contents or secrets', () => {
  it('through a jury verdict, a retry and an abstention', async () => {
    const s = scenario({ claim: { fixPatch: H.FIX_PATCH } });
    ai.state.answer = (body, state) => (state.calls.length === 1 ? R.aiError(503, 'CODE_REVIEW_JUROR_TIMEOUT', true) : R.juryAnswer(body));
    await commitAndReveal(s);
    runner.state.answer = () => R.abstained('oom', 'build');
    sharedRuns.clear();
    await evaluateHandler(request(s.cid(1), 'job-3'));

    const logs = logLines.join('\n');
    expect(logs).not.toContain(H.REPORT_MARKER);
    expect(logs).not.toContain(H.PATCH_MARKER);
    expect(logs).not.toContain(TOKEN);
    expect(logs).not.toContain('AI-NODE-ERROR-TEXT');
    expect(logs).not.toMatch(/verdikta-disclosure: /);
    expect(logs).toMatch(/report[= ]/i);
  });
});
