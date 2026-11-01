// Handler-level tests for the code-review (stake attestation) front gates:
// everything the External Adapter decides before any runner call or model
// call (design §9.1, §10.1, §10.4, §12, §13.3 + errata E1/E2, §14, §16).
//
// Only the network edges are mocked: IPFS fetch (archiveService.getArchive),
// IPFS upload, the AI Node (aiClient) and the A4b seam (codeReview/claimRun).
// Extraction, the bCID triage, @verdikta/common's code-review helpers, the
// commit store and the commitment hash are the real thing.
//
// Settlement vocabulary:
//  - requester error: errored/500, aggregatedScore [0], no commit (mode 1 too),
//    no upload, no AI call, no runner call.
//  - deterministic INVALID: full mass on INVALID through the normal
//    commit/reveal tail, a justification naming the gate, no AI/runner call.

const fs = require('fs');

jest.mock('../../services/aiClient');
jest.mock('../../codeReview/claimRun');

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
const evaluateHandler = require('../../handlers/evaluateHandler');
const aiClient = require('../../services/aiClient');
const claimRun = require('../../codeReview/claimRun');
const commitStore = require('../../services/commitStore');
const { loadCodeReviewConfig } = require('../../codeReview/config');

const CATALOGUE = Object.fromEntries(codeReview.loadFixtures().cases.map((c) => [c.id, c]));
const BUILDER = codeReview.createDevBuilderKey();
const READY_ENV = Object.freeze({
  CODE_REVIEW_ENABLED: 'true',
  CODE_RUNNER_URL: 'http://127.0.0.1:8090',
  CODE_RUNNER_TOKEN: 'runner-token-0123456789abcdef0123456789abcdef',
  CODE_REVIEW_TRUST: 'dev',
  CODE_REVIEW_DEV_KEYS: BUILDER.publicKey,
  NETWORK_CHAIN_ID: '84532'
});
const INVALID_VECTOR = [1000000, 0, 0, 0, 0, 0];
const PRIOR_LABELS = 'ABCDEFGHJK';

let archives;   // CID → bytes served by the mocked IPFS fetch
let uploaded;   // justification JSON captured at upload time
let logLines;   // every log line and console line written during a test

/**
 * One code-review request: a listing at cids[0], a claim at cids[1], `priors`
 * prior findings, and the E1 disclosure line (optionally an E2 dispute line).
 */
function scenario(options = {}) {
  const listing = H.makeListing({ builderKey: BUILDER, ...(options.listing || {}) });
  const claim = H.makeClaim(options.claim || {});
  const claimBytes = options.claimBytes || claim.buffer;
  const disclosure = H.discloseClaim(claimBytes, listing.disclosure.recipient, options.disclose || {});
  const cids = {
    listing: H.cid('Listing'),
    claim: H.cid('Claim'),
    priors: Array.from({ length: options.priors || 0 }, (_, i) => H.cid(`Prior${PRIOR_LABELS[i] || 'Z' + i}`))
  };
  archives[cids.listing] = listing.buffer;
  archives[cids.claim] = claimBytes;
  cids.priors.forEach((priorCid, i) => {
    archives[priorCid] = (options.priorArchives && options.priorArchives[i]) || H.makePrior(PRIOR_LABELS[i]).buffer;
  });
  if (!options.ciphertextUnreachable) archives[disclosure.fields.ciphertextCid] = disclosure.ciphertext;

  let addendum = options.addendum !== undefined ? options.addendum : disclosure.line;
  let statementCid = null;
  if (options.dispute) {
    statementCid = H.cid('Statement');
    archives[statementCid] = Buffer.from(options.dispute.statement, 'utf8');
    addendum += `\n${options.dispute.line || codeReview.formatDisputeLine(statementCid)}`;
  }
  const list = [cids.listing, cids.claim, ...cids.priors];
  return {
    listing, claim, claimBytes, disclosure, cids, statementCid, addendum,
    cid: (mode) => `${mode === undefined ? '' : `${mode}:`}${list.join(',')}${addendum === null ? '' : `:${addendum}`}`
  };
}

const request = (cidString, id = 'job-1') => ({ id, data: { cid: cidString, aggId: '0xagg' } });

beforeEach(() => {
  jest.clearAllMocks();
  archives = {};
  uploaded = [];
  logLines = [];
  loadCodeReviewConfig(READY_ENV);

  const { archiveService, ipfsClient, logger } = mockState.client;
  archiveService.getArchive.mockImplementation(async (c) => {
    if (!archives[c]) throw new Error('Unable to fetch archive from IPFS.');
    return archives[c];
  });
  ipfsClient.uploadToIPFS.mockImplementation(async (filePath) => {
    uploaded.push(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    return `QmJustification${uploaded.length}`;
  });
  aiClient.evaluate.mockResolvedValue({
    scores: [{ outcome: 'DONT_FUND', score: 250000 }, { outcome: 'FUND', score: 750000 }],
    justification: 'AI panel'
  });
  claimRun.runClaim.mockResolvedValue({
    scores: codeReview.BUG_OUTCOMES.map((outcome, i) => ({ outcome, score: i === 4 ? 1000000 : 0 })),
    justification: 'A4b result'
  });

  const capture = (level) => (...args) => {
    logLines.push(`${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  };
  for (const level of ['info', 'warn', 'error', 'debug']) {
    jest.spyOn(logger, level).mockImplementation(capture(level));
  }
  for (const level of ['log', 'warn', 'error', 'info']) {
    jest.spyOn(console, level).mockImplementation(capture(`console.${level}`));
  }
});

afterEach(() => {
  jest.restoreAllMocks();
});

function expectRequesterError(res, pattern) {
  expect(res.statusCode).toBe(500);
  expect(res.status).toBe('errored');
  expect(res.data.aggregatedScore).toEqual([0]);
  expect(res.data.justificationCid).toBeUndefined();
  if (pattern) expect(res.error).toMatch(pattern);
  expect(aiClient.evaluate).not.toHaveBeenCalled();
  expect(claimRun.runClaim).not.toHaveBeenCalled();
  expect(uploaded).toHaveLength(0);
}

/** Mode 1 commits a real commitment to the INVALID vector; mode 2 reveals it with the gate named. */
async function expectInvalidCommit(s, { gate, check }) {
  const commit = await evaluateHandler(request(s.cid(1)));
  expect(commit.statusCode).toBe(200);
  expect(commit.status).toBe('success');
  const [commitment] = commit.data.aggregatedScore;
  expect(commit.data.aggregatedScore).toHaveLength(1);
  expect(commitment).toMatch(/^[0-9]+$/);
  expect(BigInt(commitment) > 0n).toBe(true);
  expect(aiClient.evaluate).not.toHaveBeenCalled();
  expect(claimRun.runClaim).not.toHaveBeenCalled();
  expect(uploaded).toHaveLength(0);

  const hashHex = BigInt(commitment).toString(16).padStart(32, '0');
  const stored = await commitStore.get(hashHex);
  expect(stored.result.scores.map((x) => x.outcome)).toEqual([...codeReview.BUG_OUTCOMES]);
  expect(stored.result.scores.map((x) => x.score)).toEqual(INVALID_VECTOR);
  expect(stored.result.metadata).toMatchObject({ verdict_source: 'code-review-gate', gate });
  if (check) expect(stored.result.metadata.check).toBe(check);

  const reveal = await evaluateHandler(request(`2:${commitment}`, 'job-2'));
  expect(reveal.statusCode).toBe(200);
  expect(reveal.data.aggregatedScore).toEqual(INVALID_VECTOR);
  expect(uploaded).toHaveLength(1);
  expect(uploaded[0].justification).toContain('Verdict: INVALID');
  expect(uploaded[0].justification).toContain(`Gate: ${gate}`);
  if (check) expect(uploaded[0].justification).toContain(check);
  return uploaded[0];
}

describe('code review: request layout and operator switch', () => {
  it('cids[0] is the listing, cids[1] the claim, cids[2..] prior findings (finding.json and report.md only)', async () => {
    const s = scenario({ priors: 2 });
    const res = await evaluateHandler(request(s.cid(1)));
    expect(res.statusCode).toBe(200);
    expect(claimRun.runClaim).toHaveBeenCalledTimes(1);
    expect(aiClient.evaluate).not.toHaveBeenCalled();

    const [context] = claimRun.runClaim.mock.calls[0];
    expect(context.listing.cid).toBe(s.cids.listing);
    expect(context.listing.spec).toEqual(s.listing.spec);
    expect(context.claim.bcid).toBe(s.cids.claim);
    expect(context.claim.finding).toEqual(H.FINDING);
    expect(context.claim.report).toContain(H.REPORT_MARKER);
    expect(Buffer.from(context.claim.pocPatch).toString('utf8')).toBe(H.POC_PATCH);
    expect(context.claim.fixPatch).toBeNull();
    expect(context.claim.archiveSha256).toBe(s.disclosure.fields.archiveSha256);
    expect(context.priorFindings.map((p) => p.bcid)).toEqual(s.cids.priors);
    for (const prior of context.priorFindings) {
      expect(Object.keys(prior).sort()).toEqual(['bcid', 'finding', 'report']);
    }
    expect(context.priorFindings[0].finding.title).toBe('Prior finding A');
    expect(context.priorFindings[1].report).toContain('Prior B');
    expect(context.codeClass).toBe('code-standard');
    expect(context.eaGates).toEqual({ disclosure: 'pass', inScope: 'pass' });
  });

  it('with no prior findings the context carries an empty list', async () => {
    const s = scenario();
    await evaluateHandler(request(s.cid(1)));
    expect(claimRun.runClaim.mock.calls[0][0].priorFindings).toEqual([]);
  });

  it('a gate-passing claim commits only what the run seam returns (a real commitment)', async () => {
    const s = scenario();
    const res = await evaluateHandler(request(s.cid(1)));
    const [commitment] = res.data.aggregatedScore;
    expect(BigInt(commitment) > 0n).toBe(true);
    const stored = await commitStore.get(BigInt(commitment).toString(16).padStart(32, '0'));
    expect(stored.result.justification).toBe('A4b result');
  });

  it('when the run seam fails (no runner in this build) the arbiter abstains: errored, no commit', async () => {
    claimRun.runClaim.mockImplementation(jest.requireActual('../../codeReview/claimRun').runClaim);
    const s = scenario();
    const res = await evaluateHandler(request(s.cid(1)));
    expect(res.statusCode).toBe(500);
    expect(res.status).toBe('errored');
    expect(res.data.aggregatedScore).toEqual([0]);
    expect(res.error).toMatch(/CODE_REVIEW_RUN_UNAVAILABLE/);
    expect(uploaded).toHaveLength(0);
  });

  it.each([
    ['CODE_REVIEW_ENABLED unset', { CODE_REVIEW_ENABLED: undefined }],
    ['CODE_REVIEW_ENABLED=false', { CODE_REVIEW_ENABLED: 'false' }],
    ['no runner configured', { CODE_RUNNER_URL: undefined }],
    ['no runner token', { CODE_RUNNER_TOKEN: undefined }]
  ])('code mode is refused as a requester error when %s (mode 1: errored/500, no commit)', async (_label, change) => {
    loadCodeReviewConfig({ ...READY_ENV, ...change });
    const s = scenario();
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /CODE_REVIEW_DISABLED/);
  });

  it('a single CID whose manifest has codeReview is a requester error (no claim to judge)', async () => {
    const listing = H.makeListing({ builderKey: BUILDER });
    archives[H.cid('Listing')] = listing.buffer;
    expectRequesterError(await evaluateHandler(request(`1:${H.cid('Listing')}`)), /CODE_REVIEW_CIDS/);
  });

  it('a single code-review CID with code review disabled is refused as disabled first', async () => {
    loadCodeReviewConfig({});
    archives[H.cid('Listing')] = H.makeListing({ builderKey: BUILDER }).buffer;
    expectRequesterError(await evaluateHandler(request(`1:${H.cid('Listing')}`)), /CODE_REVIEW_DISABLED/);
  });

  it('more than 8 prior findings (erratum E2: at most 10 CIDs) is a requester error', async () => {
    const s = scenario({ priors: 9 });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /CODE_REVIEW_CIDS/);
  });

  it('a CID repeated in the request is a requester error', async () => {
    const s = scenario({ priors: 1 });
    const repeated = `1:${s.cids.listing},${s.cids.claim},${s.cids.claim}:${s.addendum}`;
    expectRequesterError(await evaluateHandler(request(repeated)), /CODE_REVIEW_CIDS/);
  });

  it('a prior finding without report.md is a requester error (the request is the contract\'s, not the hunter\'s)', async () => {
    const broken = H.makeClaim({ report: undefined });
    const s = scenario({ priors: 1, priorArchives: [broken.buffer] });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /CODE_REVIEW_PRIOR_FINDING/);
  });

  it('a prior finding whose finding.json is not valid is a requester error', async () => {
    const broken = H.makeClaim({ finding: '{"version": 1' });
    const s = scenario({ priors: 1, priorArchives: [broken.buffer] });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /CODE_REVIEW_PRIOR_FINDING/);
  });

  it('a malformed prior archive (not a ZIP) is a requester error, not INVALID against the hunter', async () => {
    const s = scenario({ priors: 1, priorArchives: [Buffer.from('not a zip at all')] });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /CODE_REVIEW_PRIOR_FINDING/);
  });

  it('a prior finding that cannot be fetched is transient: errored, no commit', async () => {
    const s = scenario({ priors: 1 });
    delete archives[s.cids.priors[0]];
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /Unable to fetch archive/);
  });
});

describe('code review: class source (assumption A8)', () => {
  it('every codeReview manifest is judged under the code-standard envelope', async () => {
    const spy = jest.spyOn(codeReview, 'validateClassEnvelope');
    const s = scenario();
    await evaluateHandler(request(s.cid(1)));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe('code-standard');
  });

  it('a premium panel cannot widen it: requester error', async () => {
    const premium = {
      NUMBER_OF_OUTCOMES: 6,
      ITERATIONS: 1,
      AI_NODES: [
        { AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-opus-5-5', NO_COUNTS: 1, WEIGHT: 0.5 },
        { AI_PROVIDER: 'openai', AI_MODEL: 'gpt-6-astra', NO_COUNTS: 1, WEIGHT: 0.5 }
      ]
    };
    const s = scenario({ listing: { juryParameters: premium } });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /ENVELOPE_MODEL_NOT_IN_POOL/);
  });

  it.each([
    ['four jurors', (p) => { p.AI_NODES = [...p.AI_NODES, { AI_PROVIDER: 'openai', AI_MODEL: 'gpt-6-sol', NO_COUNTS: 1, WEIGHT: 0.1 }, { AI_PROVIDER: 'xai', AI_MODEL: 'grok-4.7', NO_COUNTS: 1, WEIGHT: 0.1 }]; p.AI_NODES[0].WEIGHT = 0.4; p.AI_NODES[1].WEIGHT = 0.4; }, /ENVELOPE_PANEL_SIZE/],
    ['NO_COUNTS 2', (p) => { p.AI_NODES[0].NO_COUNTS = 2; }, /ENVELOPE_NO_COUNTS/],
    ['ITERATIONS 2', (p) => { p.ITERATIONS = 2; }, /ENVELOPE_ITERATIONS/]
  ])('a manifest outside the envelope (%s) is a requester error before any model call', async (_label, edit, pattern) => {
    const panel = JSON.parse(JSON.stringify(codeReview.CODE_STANDARD_PANEL));
    edit(panel);
    const s = scenario({ listing: { juryParameters: panel } });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), pattern);
  });

  it('the dispute panel is inside the envelope', async () => {
    const s = scenario({ listing: { juryParameters: JSON.parse(JSON.stringify(codeReview.CODE_STANDARD_DISPUTE_PANEL)) } });
    const res = await evaluateHandler(request(s.cid(1)));
    expect(res.statusCode).toBe(200);
    expect(claimRun.runClaim).toHaveBeenCalledTimes(1);
  });

  it('outcomes other than the six claim outcomes are a requester error', async () => {
    const s = scenario({ listing: { outcomes: ['INVALID', 'VALID'], juryParameters: { ...JSON.parse(JSON.stringify(codeReview.CODE_STANDARD_PANEL)), NUMBER_OF_OUTCOMES: 2 } } });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /CODE_REVIEW_LISTING/);
  });
});

describe('code review: listing checks before any pull or model call (requester errors)', () => {
  it(`${'direct-request-no-attestation'}: a listing without attestation.json is rejected, no commit`, async () => {
    expect(CATALOGUE['direct-request-no-attestation']).toMatchObject({ layer: 'ea', settles: 'rejected' });
    const s = scenario({ listing: { attestation: 'none' } });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /ATTESTATION_MISSING/);
  });

  it('direct-request-no-attestation (does not verify): a code_review.json changed after signing is rejected', async () => {
    const s = scenario({ listing: { attestation: 'tampered' } });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /ATTESTATION_HASH_MISMATCH/);
  });

  it('direct-request-no-attestation (untrusted key): an attestation signed by a key outside the trust set is rejected', async () => {
    const s = scenario({ listing: { builderKey: codeReview.createDevBuilderKey() } });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /ATTESTATION_UNTRUSTED_KEY/);
  });

  it(`${'direct-request-spec-over-class-maxima'}: 4 CPUs and 600 s of run time are rejected before any pull`, async () => {
    expect(CATALOGUE['direct-request-spec-over-class-maxima']).toMatchObject({ layer: 'ea', settles: 'rejected' });
    const s = scenario({ listing: { mutateSpec: (spec) => { spec.limits.cpus = 4; spec.limits.runSeconds = 600; } } });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /LIMIT_ABOVE_CLASS_MAX/);
  });

  it('direct-request-spec-over-class-maxima: an image above the class maximum is rejected', async () => {
    const s = scenario({ listing: { mutateSpec: (spec) => { spec.env.unpackedBytes = 7000000000; } } });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /IMAGE_ABOVE_CLASS_MAX/);
  });

  it('a code_review.json that is not JSON is a requester error', async () => {
    const s = scenario({ listing: { attestation: 'none', files: { 'code_review.json': '{ not json' } } });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /CODE_REVIEW_SPEC/);
  });

  it('a code_review.json that fails the schema is a requester error', async () => {
    const s = scenario({ listing: { mutateSpec: (spec) => { spec.kind = 'fix'; } } });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /CODE_REVIEW_SPEC/);
  });

  it('a manifest naming a code_review.json the archive does not hold is a requester error', async () => {
    const s = scenario({ listing: { files: { 'code_review.json': undefined } } });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /CODE_REVIEW_LISTING/);
  });

  it('a manifest naming a file outside the archive is a requester error (no path traversal)', async () => {
    const s = scenario({ listing: { manifest: { codeReview: '../../../../etc/hosts' } } });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /CODE_REVIEW_LISTING/);
  });

  it('an invalid known_issues.json is a requester error even when attested', async () => {
    const s = scenario({ listing: { files: { 'known_issues.json': '[{"id":"sha256:00","title":"x"}]' } } });
    // the attestation binds the original bytes, so this also fails the hash check first
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /ATTESTATION_HASH_MISMATCH|CODE_REVIEW_KNOWN_ISSUES/);
  });

  it('a requester error wins over a malformed claim: errored, no commit (never INVALID against the hunter)', async () => {
    const s = scenario({ listing: { attestation: 'none' }, claimBytes: Buffer.from('not a zip') });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /ATTESTATION_MISSING/);
  });

  it('mode 0 uses the same errored shape', async () => {
    const s = scenario({ listing: { attestation: 'none' } });
    expectRequesterError(await evaluateHandler(request(s.cid())), /ATTESTATION_MISSING/);
  });
});

describe('code review: trust mode', () => {
  it('production trust is the default: a dev-signed attestation is refused', async () => {
    loadCodeReviewConfig({ ...READY_ENV, CODE_REVIEW_TRUST: undefined, CODE_REVIEW_DEV_KEYS: undefined, NETWORK_CHAIN_ID: undefined });
    const s = scenario();
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /ATTESTATION_(TRUST_MODE_MISMATCH|UNTRUSTED_KEY)/);
  });

  it('production trust verifies a production statement against the package set only (no caller keys)', async () => {
    loadCodeReviewConfig({ ...READY_ENV, CODE_REVIEW_TRUST: undefined });
    const spy = jest.spyOn(codeReview, 'validateAttestation');
    const s = scenario({ listing: { trust: 'production' } });
    // PRODUCTION_BUILDER_KEYS is empty until the production key ships (C6)
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /ATTESTATION_UNTRUSTED_KEY/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1].trust).toBeUndefined();
  });

  it('dev trust accepts the caller-supplied dev key and still verifies a production statement with production trust', async () => {
    const spy = jest.spyOn(codeReview, 'validateAttestation');
    const s = scenario({ listing: { trust: 'production' } });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /ATTESTATION_UNTRUSTED_KEY/);
    expect(spy.mock.calls[0][1].trust).toBeUndefined();
  });

  it('CODE_REVIEW_TRUST=dev warns on every request', async () => {
    const s = scenario();
    await evaluateHandler(request(s.cid(1), 'a'));
    await evaluateHandler(request(s.cid(1), 'b'));
    const warnings = logLines.filter((line) => line.startsWith('warn') && line.includes('CODE_REVIEW_TRUST=dev'));
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings.some((line) => line.includes('[EA a'))).toBe(true);
    expect(warnings.some((line) => line.includes('[EA b'))).toBe(true);
  });

  it('dev trust is refused on Base mainnet: code mode is off (requester error, no commit)', async () => {
    loadCodeReviewConfig({ ...READY_ENV, NETWORK_CHAIN_ID: '8453' });
    const s = scenario();
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /CODE_REVIEW_DISABLED/);
  });

  it('production trust logs no dev-trust warning', async () => {
    loadCodeReviewConfig({ ...READY_ENV, CODE_REVIEW_TRUST: undefined, CODE_REVIEW_DEV_KEYS: undefined });
    const s = scenario();
    await evaluateHandler(request(s.cid(1)));
    expect(logLines.some((line) => line.includes('CODE_REVIEW_TRUST=dev'))).toBe(false);
  });
});

describe('code review: claim-archive member check (deterministic INVALID naming the member)', () => {
  it.each([
    ['finding.json missing', { finding: undefined }, 'finding.json'],
    ['finding.json not JSON', { finding: '{"version": 1,' }, 'finding.json'],
    ['finding.json not an object', { finding: '[1, 2]' }, 'finding.json'],
    ['report.md missing', { report: undefined }, 'report.md'],
    ['report.md empty', { report: '' }, 'report.md'],
    ['report.md not UTF-8', { report: Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]) }, 'report.md'],
    ['poc.patch missing', { pocPatch: undefined }, 'poc.patch'],
    ['poc.patch not a patch', { pocPatch: 'just some words, no diff headers\n' }, 'poc.patch'],
    ['poc.patch empty', { pocPatch: '' }, 'poc.patch']
  ])('%s → INVALID', async (_label, claim, member) => {
    const s = scenario({ claim });
    const justification = await expectInvalidCommit(s, { gate: 'claim-archive' });
    expect(justification.justification).toContain(member);
    expect(justification.metadata.member).toBe(member);
  });

  it('fix.patch is optional; when present it is passed on, not gated', async () => {
    const s = scenario({ claim: { fixPatch: H.FIX_PATCH } });
    await evaluateHandler(request(s.cid(1)));
    const [context] = claimRun.runClaim.mock.calls[0];
    expect(Buffer.from(context.claim.fixPatch).toString('utf8')).toBe(H.FIX_PATCH);
  });

  it('a fix.patch that is not a patch does not change the outcome (decision 14): still handed on', async () => {
    const s = scenario({ claim: { fixPatch: 'not a patch' } });
    await evaluateHandler(request(s.cid(1)));
    expect(claimRun.runClaim).toHaveBeenCalledTimes(1);
  });

  it('a claim archive that is not a ZIP settles INVALID through the malformed-archive path', async () => {
    const s = scenario({ claimBytes: Buffer.from('# just markdown, no ZIP structure\n') });
    await expectInvalidCommit(s, { gate: 'claim-archive', check: 'archive-not-a-zip' });
  });

  it('a claim archive without a manifest primary settles INVALID', async () => {
    const s = scenario({ claim: { files: { 'manifest.json': { version: '1.0', files: ['report.md'] } } } });
    await expectInvalidCommit(s, { gate: 'claim-archive', check: 'manifest-primary-missing' });
  });

  it('two arbiters settle a malformed claim on the same vector', async () => {
    const s = scenario({ claim: { pocPatch: undefined } });
    const a = await evaluateHandler(request(s.cid(1), 'a'));
    const b = await evaluateHandler(request(s.cid(1), 'b'));
    const hex = (r) => BigInt(r.data.aggregatedScore[0]).toString(16).padStart(32, '0');
    const [sa, sb] = await Promise.all([commitStore.get(hex(a)), commitStore.get(hex(b))]);
    expect(sa.result.scores).toEqual(sb.result.scores);
    expect(sa.result.justification).toEqual(sb.result.justification);
  });
});

describe('code review: disclosure gate (§10.1, §14, erratum E1)', () => {
  it(`${'reveal-plaintext-hash-mismatch'}: a revealed archive that does not hash to the commitment → INVALID`, async () => {
    expect(CATALOGUE['reveal-plaintext-hash-mismatch']).toMatchObject({ layer: 'ea', settles: 'INVALID' });
    const s = scenario({ disclose: { archiveSha256: '0x' + 'ab'.repeat(32) } });
    await expectInvalidCommit(s, { gate: 'disclosure', check: 'PLAINTEXT_HASH_MISMATCH' });
  });

  it(`${'reveal-reencryption-mismatch'}: re-encryption that does not reproduce the pinned ciphertext → INVALID`, async () => {
    expect(CATALOGUE['reveal-reencryption-mismatch']).toMatchObject({ layer: 'ea', settles: 'INVALID' });
    const s = scenario({ disclose: { tamperCiphertext: true } });
    await expectInvalidCommit(s, { gate: 'disclosure', check: 'REENCRYPTION_MISMATCH' });
  });

  it('a pinned ciphertext that does not hash to ciphertextSha256 → INVALID', async () => {
    const s = scenario();
    archives[s.disclosure.fields.ciphertextCid] = Buffer.concat([s.disclosure.ciphertext, Buffer.from([0])]);
    await expectInvalidCommit(s, { gate: 'disclosure', check: 'CIPHERTEXT_HASH_MISMATCH' });
  });

  it('the disclosure key comes from the listing archive at cids[0]', async () => {
    const spy = jest.spyOn(codeReview, 'verifyDisclosure');
    const s = scenario();
    await evaluateHandler(request(s.cid(1)));
    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0][0];
    expect(args.disclosureKey).toBe(s.listing.spec.stake.disclosureKey);
    expect(args.ciphertextCid).toBeUndefined(); // the gate gets bytes, the CID was used to fetch them
    expect(Buffer.from(args.plaintext).equals(s.claimBytes)).toBe(true);
    expect(Buffer.from(args.ciphertext).equals(s.disclosure.ciphertext)).toBe(true);
  });

  it.each([
    ['no addendum at all', null, 'LINE_PREFIX'],
    ['an empty addendum', '', 'LINE_PREFIX'],
    ['a line with four fields', 'verdikta-disclosure: 0x' + 'a'.repeat(64) + ' 0x' + 'b'.repeat(64) + ' ' + H.cid('Ciphertext') + ' 0x' + 'c'.repeat(32), 'LINE_TOKEN_COUNT'],
    ['uppercase hex', null, 'LINE_FIELD'],
    ['a trailing newline', null, 'LINE_PREFIX'],
    ['three lines', null, 'LINE_COUNT']
  ])('a disclosure line that does not parse strictly (%s) → INVALID', async (label, addendum, code) => {
    let s = scenario();
    let line = addendum;
    if (label === 'uppercase hex') line = s.disclosure.line.replace(s.disclosure.fields.archiveSha256, s.disclosure.fields.archiveSha256.toUpperCase().replace('0X', '0x'));
    if (label === 'a trailing newline') line = `${s.disclosure.line}\n`;
    if (label === 'three lines') line = `${s.disclosure.line}\nverdikta-dispute: ${H.cid('Statement')}\nmore`;
    s = { ...s, addendum: line, cid: (mode) => `${mode}:${s.cids.listing},${s.cids.claim}${line === null ? '' : `:${line}`}` };
    await expectInvalidCommit(s, { gate: 'disclosure', check: code });
  });

  it('a ciphertext that cannot be fetched is transient: errored, no commit (never INVALID)', async () => {
    const s = scenario({ ciphertextUnreachable: true });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /Unable to fetch archive/);
  });

  it('the static claim gates run before the ciphertext fetch: a malformed claim settles INVALID even when the ciphertext is unreachable', async () => {
    const s = scenario({ claim: { finding: undefined }, ciphertextUnreachable: true });
    await expectInvalidCommit(s, { gate: 'claim-archive' });
  });

  it('BAD_DISCLOSURE_KEY is the listing\'s fault: requester error, no commit (not INVALID against the hunter)', async () => {
    jest.spyOn(codeReview, 'verifyDisclosure').mockReturnValue({ ok: false, gate: 'disclosure', code: 'BAD_DISCLOSURE_KEY', reason: 'the listing key is not a usable X25519 key' });
    const s = scenario();
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /BAD_DISCLOSURE_KEY/);
  });

  it('MALFORMED_INPUT is the claim\'s: INVALID', async () => {
    jest.spyOn(codeReview, 'verifyDisclosure').mockReturnValue({ ok: false, gate: 'disclosure', code: 'MALFORMED_INPUT', reason: 'contentKey is not 16 bytes' });
    const s = scenario();
    await expectInvalidCommit(s, { gate: 'disclosure', check: 'MALFORMED_INPUT' });
  });
});

describe('code review: inScope gate (§10.1)', () => {
  it(`${'inscope-gate-path-outside-scope'}: a finding naming a path outside the stake's scope → INVALID before any pull`, async () => {
    expect(CATALOGUE['inscope-gate-path-outside-scope']).toMatchObject({ layer: 'ea', settles: 'INVALID' });
    const s = scenario({ claim: { finding: { ...H.FINDING, affectedPaths: ['contracts/Vault.sol', 'script/Deploy.s.sol'] } } });
    const j = await expectInvalidCommit(s, { gate: 'inScope', check: 'PATH_OUT_OF_SCOPE' });
    expect(j.justification).toContain('script/Deploy.s.sol');
  });

  it('a finding.json that fails its schema → INVALID (inScope)', async () => {
    const s = scenario({ claim: { finding: { ...H.FINDING, claimedClass: 'SEVERE' } } });
    await expectInvalidCommit(s, { gate: 'inScope' });
  });

  it('the disclosure gate is decided before inScope', async () => {
    const s = scenario({
      claim: { finding: { ...H.FINDING, affectedPaths: ['script/Deploy.s.sol'] } },
      disclose: { tamperCiphertext: true }
    });
    await expectInvalidCommit(s, { gate: 'disclosure', check: 'REENCRYPTION_MISMATCH' });
  });
});

describe('code review: machine lines, the dispute statement, logs', () => {
  it('the machine lines never reach the run seam: the addendum text is empty and no key is in the context', async () => {
    const s = scenario();
    await evaluateHandler(request(s.cid(1)));
    const [context] = claimRun.runClaim.mock.calls[0];
    expect(context.addendumText).toBe('');
    const text = JSON.stringify(context);
    expect(text).not.toContain(s.disclosure.fields.contentKey.slice(2));
    expect(text).not.toContain(s.disclosure.fields.ephemeralKey.slice(2));
    expect(text).not.toContain('verdikta-disclosure');
    expect(context.disclosure).toEqual({
      archiveSha256: s.disclosure.fields.archiveSha256,
      ciphertextSha256: s.disclosure.fields.ciphertextSha256,
      ciphertextCid: s.disclosure.fields.ciphertextCid
    });
  });

  it('a dispute statement is fetched by its CID and handed on as the maker\'s argument', async () => {
    const statement = 'The PoC asserts behaviour the vault never promised: withdraw is documented as non-reentrant-safe.';
    const s = scenario({ dispute: { statement } });
    const res = await evaluateHandler(request(s.cid(1)));
    expect(res.statusCode).toBe(200);
    const [context] = claimRun.runClaim.mock.calls[0];
    expect(context.dispute).toEqual({ statementCid: s.statementCid, statement });
    expect(context.addendumText).toBe('');
    expect(JSON.stringify(context)).not.toContain('verdikta-dispute');
  });

  it('a dispute statement of exactly 4 KB is accepted', async () => {
    const s = scenario({ dispute: { statement: 'x'.repeat(4096) } });
    await evaluateHandler(request(s.cid(1)));
    expect(claimRun.runClaim.mock.calls[0][0].dispute.statement).toHaveLength(4096);
  });

  it('a dispute statement over 4 KB is a requester error (the disputing maker\'s)', async () => {
    const s = scenario({ dispute: { statement: 'x'.repeat(4097) } });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /CODE_REVIEW_DISPUTE/);
  });

  it('a dispute statement that is not UTF-8 is a requester error', async () => {
    const s = scenario({ dispute: { statement: 'ok' } });
    archives[s.statementCid] = Buffer.from([0x61, 0xff, 0x62]);
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /CODE_REVIEW_DISPUTE/);
  });

  it('a malformed dispute line is a requester error, not INVALID against the hunter', async () => {
    const s = scenario({ dispute: { statement: 'ok', line: 'verdikta-dispute: not-a-cid!' } });
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /CODE_REVIEW_DISPUTE/);
  });

  it('a dispute statement that cannot be fetched is transient: errored, no commit', async () => {
    const s = scenario({ dispute: { statement: 'ok' } });
    delete archives[s.statementCid];
    expectRequesterError(await evaluateHandler(request(s.cid(1))), /Unable to fetch archive/);
  });

  const secretsOf = (s) => [
    s.disclosure.fields.contentKey.slice(2),
    s.disclosure.fields.ephemeralKey.slice(2),
    H.REPORT_MARKER,
    H.PATCH_MARKER,
    H.FINDING.rootCause,
    H.FINDING.poc.observable
  ];

  it('logs carry the bCID and hashes, never archive contents or keys (gates pass)', async () => {
    const s = scenario({ dispute: { statement: 'MAKER-STATEMENT-BODY-55aa' } });
    await evaluateHandler(request(s.cid(1)));
    const all = logLines.join('\n');
    for (const secret of [...secretsOf(s), 'MAKER-STATEMENT-BODY-55aa']) expect(all).not.toContain(secret);
    expect(all).toContain(s.cids.claim);
    expect(all).toContain(s.disclosure.fields.archiveSha256.slice(2));
  });

  it.each([
    ['a member check failure', { claim: { finding: '{"broken": ' } }],
    ['a disclosure failure', { disclose: { tamperCiphertext: true } }],
    ['an inScope failure', { claim: { finding: { ...H.FINDING, affectedPaths: ['script/X.s.sol'] } } }]
  ])('logs carry no archive contents or keys on %s', async (_label, options) => {
    const s = scenario(options);
    const res = await evaluateHandler(request(s.cid(1)));
    expect(res.statusCode).toBe(200);
    const all = logLines.join('\n');
    for (const secret of secretsOf(s)) expect(all).not.toContain(secret);
    expect(all).not.toContain('script/X.s.sol');
  });

  it('the handler no longer logs the machine lines of an addendum ("Found addendum string")', async () => {
    const s = scenario();
    await evaluateHandler(request(s.cid(1)));
    const found = logLines.filter((line) => line.includes('Found addendum'));
    expect(found.length).toBeGreaterThan(0);
    for (const line of found) expect(line).not.toContain('verdikta-disclosure');
  });
});

describe('code review: requests without codeReview behave as before', () => {
  it('a text-mode multi-CID request never touches the code-review pipeline', async () => {
    const BOUNTY = H.zip({
      'manifest.json': { version: '1.0', primary: { filename: 'primary_query.json' }, juryParameters: { NUMBER_OF_OUTCOMES: 2, AI_NODES: [{ AI_PROVIDER: 'OpenAI', AI_MODEL: 'gpt-4o', NO_COUNTS: 1, WEIGHT: 1.0 }], ITERATIONS: 1 }, bCIDs: { submittedWork: 'The work submitted by a hunter.' } },
      'primary_query.json': { query: 'Does the submission meet the bounty?', outcomes: ['DONT_FUND', 'FUND'] }
    });
    const SUB = H.zip({
      'manifest.json': { version: '1.0', name: 'submittedWork', primary: { filename: 'primary_query.json' } },
      'primary_query.json': { query: 'Submitted work: a short note.' }
    });
    archives[H.cid('Bounty')] = BOUNTY;
    archives[H.cid('Sub')] = SUB;
    const res = await evaluateHandler(request(`${H.cid('Bounty')},${H.cid('Sub')}`));
    expect(res.statusCode).toBe(200);
    expect(res.data.aggregatedScore).toEqual([250000, 750000]);
    expect(aiClient.evaluate).toHaveBeenCalledTimes(1);
    expect(claimRun.runClaim).not.toHaveBeenCalled();
  });

  it('with code review disabled a text request is unaffected', async () => {
    loadCodeReviewConfig({});
    const BOUNTY = H.zip({
      'manifest.json': { version: '1.0', primary: { filename: 'primary_query.json' }, juryParameters: { NUMBER_OF_OUTCOMES: 2, AI_NODES: [{ AI_PROVIDER: 'OpenAI', AI_MODEL: 'gpt-4o', NO_COUNTS: 1, WEIGHT: 1.0 }], ITERATIONS: 1 } },
      'primary_query.json': { query: 'Is the sky blue on a clear day?', outcomes: ['NO', 'YES'] }
    });
    archives[H.cid('Single')] = BOUNTY;
    const res = await evaluateHandler(request(H.cid('Single')));
    expect(res.statusCode).toBe(200);
    expect(aiClient.evaluate).toHaveBeenCalledTimes(1);
  });

  it('a text-mode addendum without machine lines is still logged as before', async () => {
    loadCodeReviewConfig({});
    const BOUNTY = H.zip({
      'manifest.json': { version: '1.0', primary: { filename: 'primary_query.json' }, juryParameters: { NUMBER_OF_OUTCOMES: 2, AI_NODES: [{ AI_PROVIDER: 'OpenAI', AI_MODEL: 'gpt-4o', NO_COUNTS: 1, WEIGHT: 1.0 }], ITERATIONS: 1 }, addendum: 'Current price' },
      'primary_query.json': { query: 'Is the price above 100 today?', outcomes: ['NO', 'YES'] }
    });
    archives[H.cid('Single')] = BOUNTY;
    await evaluateHandler(request(`${H.cid('Single')}:price=101`));
    expect(logLines.some((line) => line.includes('Found addendum string: price=101'))).toBe(true);
    expect(aiClient.evaluate.mock.calls[0][0].prompt).toContain('Current price: price=101');
  });

  it('a text-mode addendum that carries a machine line is not logged', async () => {
    loadCodeReviewConfig({});
    const BOUNTY = H.zip({
      'manifest.json': { version: '1.0', primary: { filename: 'primary_query.json' }, juryParameters: { NUMBER_OF_OUTCOMES: 2, AI_NODES: [{ AI_PROVIDER: 'OpenAI', AI_MODEL: 'gpt-4o', NO_COUNTS: 1, WEIGHT: 1.0 }], ITERATIONS: 1 } },
      'primary_query.json': { query: 'Is the sky blue on a clear day?', outcomes: ['NO', 'YES'] }
    });
    archives[H.cid('Single')] = BOUNTY;
    const line = `verdikta-disclosure: 0x${'a'.repeat(64)} 0x${'b'.repeat(64)} ${H.cid('Ciphertext')} 0x${'c'.repeat(32)} 0x${'d'.repeat(64)}`;
    await evaluateHandler(request(`${H.cid('Single')}:${line}`));
    expect(logLines.join('\n')).not.toContain('c'.repeat(32));
  });
});
