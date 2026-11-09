'use strict';

// Node A6b: L4 as the workflow runs it, a process with flags and environment, against a
// stub chain and a local IPFS on loopback. No chain, no provider, no secret: the wallet
// key is made here and means nothing anywhere else.
//
// The stub counts every JSON-RPC call, so a refusal is shown by nothing having been asked
// at all, and what was sent is read back from the raw transaction's calldata.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');
const { codeReview } = require('@verdikta/common');
const { AGGREGATOR_ABI, verdictRound } = require('../l4/run-l4');
const { summarize } = require('../l4/metrics');
const { startLocalIpfs } = require('../l2/claim/local-ipfs');
const F = require('../l2/claim/fixtures');
const repo = require('../../../code-runner/test/docker/forgeFixture');
const { startStubChain } = require('../../test/helpers/stub-chain');

jest.setTimeout(120000);

const E2E = path.join(__dirname, '..', '..');
const INDEX = path.join(E2E, 'src', 'index.js');
const COMMON = '1.9.0-attest.3';
const RELEASE = 'abc1234def5678';
const IMAGE = `registry.example/vault@sha256:${'b'.repeat(64)}`;
const COLD_IMAGE = `registry.example/vault@sha256:${'e'.repeat(64)}`;
const BASE_COMMIT = 'a'.repeat(40);
const REPORT_HASH = 'c'.repeat(64);
const CLAIM_IDS = ['claim-l4-valid', 'claim-l4-front-gate', 'claim-l4-runner-gate'];
const ALL_CLAIMS = CLAIM_IDS.join(',');

/** Frozen from the base branch (2c0e94a): what the nightly resolved to before this node. */
const NIGHTLY_BEFORE = Object.freeze({
  classId: 128,
  ids: ['canonical-vuln', 'frontend-default'],
  cids: [[fs.readFileSync(path.join(E2E, 'archives', 'contract-vuln.cid'), 'utf8').trim()], ['QmSHXfBcrfFf4pnuRYCbHA8rjKkDh1wjqas3Rpk3a2uAWH']],
  alpha: 500n,
  maxOracleFee: 150000000000000n,
  estimatedBaseCost: 8000000000n,
  maxFeeScaling: 5n,
  value: 1800000000000000n
});

let dir;
let ipfs;
let chain;
let set;
let scenariosFile;
let claimKeyOf;

const arbiter = { adapter: '0.1.0', aiNode: '0.1.0', verdiktaCommon: COMMON, release: `${RELEASE} 2026-11-03T00:00:00Z`, canaryFault: { state: 'off' } };
const armedArbiter = { ...arbiter, canaryFault: { state: 'armed' } };
const JURY_VECTOR = [0n, 0n, 0n, 100000n, 700000n, 200000n];
const INVALID_VECTOR = [1000000n, 0n, 0n, 0n, 0n, 0n];
const evidence = (settlement, listingCid, claimCid, hash = REPORT_HASH) => [
  'Execution evidence v1', `Settlement: ${settlement}`, `Report-SHA256: ${hash}`, `Listing: ${listingCid}`, `Claim: ${claimCid}`, 'End execution evidence'
].join('\n');
const FAULT_RESULTS = [{ provider: 'p', model: 'm', status: 'success', duration_ms: 475500 }];

/** What each claim's scenario expects the arbiters to have uploaded. */
function bodyOf(key, listingCid, claimCid, aiNode) {
  const jury = (metadata = {}, over = {}) => ({
    justification: `${evidence('jury', listingCid, claimCid)}\n\nThe panel.`,
    metadata: { verdict_source: 'code-review-jury', canary_fault_ai_node: aiNode, ...metadata },
    ...over
  });
  const gate = () => ({ justification: 'Verdict: INVALID.\n\nGate: inScope', metadata: { verdict_source: 'code-review-gate', gate: 'inScope', claim: claimCid } });
  const runner = (name) => ({ justification: `${evidence(`INVALID (${name})`, listingCid, claimCid)}\n\nGate: ${name}`, metadata: { verdict_source: 'code-review-runner', gate: name } });
  return {
    valid: () => jury(),
    timeDependent: () => jury(),
    randomnessDependent: () => jury(),
    dispute: () => jury(),
    outOfScope: gate,
    registryControl: gate,
    editsSource: () => runner('testPathsOnly'),
    flaky: () => runner('reproduces'),
    coldCache: () => jury({ runner_image: { cache: 'pulled', durationMs: 21000 } }),
    faultNearLimit: () => jury({ canary_fault: { fault: 'near-limit-juror', attempts: 1, action: 'hold-juror-answer', jurorTimeoutMs: 480000, justifierMs: 3000 } }, { model_results: FAULT_RESULTS }),
    faultProviderTimeout: () => jury({ canary_fault: { fault: 'provider-timeout', attempts: 2, earlierAttempts: [{ action: 'late-juror', errorCode: 'CODE_REVIEW_JUROR_TIMEOUT', deadlineMs: 105000 }], action: null, jurorTimeoutMs: 480000, justifierMs: 3000 } }),
    faultSlowJustifier: () => jury({ canary_fault: { fault: 'slow-justifier', attempts: 1, action: 'hold-justifier-answer', jurorTimeoutMs: 480000, justifierMs: 40500 } })
  }[key];
}

const JURY_KEYS = new Set(['valid', 'timeDependent', 'randomnessDependent', 'dispute', 'coldCache', 'faultNearLimit', 'faultProviderTimeout', 'faultSlowJustifier']);
const ABSTAINING = new Set(['registryFailure', 'faultCancellation']);

/** What the arbiters would have uploaded, on the local IPFS. `change` lets a test say otherwise, per claim. */
async function justificationsFor(request, { reporting = arbiter, aiNode = 'off', change = {} } = {}) {
  const [listingCid, claimCid] = request.cids;
  const key = claimKeyOf.get(claimCid);
  const disputed = /verdikta-dispute: /.test(request.addendum || '');
  const changed = change[key] && change[key]({ disputed });
  if (ABSTAINING.has(key) && !(changed && changed.answer)) return changed && changed.abstain ? changed.abstain : { abstain: true };
  if (changed && changed.abstain) return changed.abstain;
  const vector = (changed && changed.vector) || (JURY_KEYS.has(key) ? JURY_VECTOR : INVALID_VECTOR);
  const build = key ? bodyOf(key, listingCid, claimCid, aiNode) : null;
  const body = build ? build() : { justification: 'A text-mode justification.', metadata: {} };
  if (disputed) body.metadata.dispute_statement = set.claims.dispute.statementCid;
  const json = { arbiter: reporting, ...body, ...(changed && changed.json) };
  const upload = async (nonce, over = {}) => ipfs.put(Buffer.from(JSON.stringify({
    ...json,
    scores: (over.vector || vector).map((score, i) => ({ outcome: String(i), score: Number(score) })),
    nonce,
    ...(over.justification ? { justification: over.justification } : {})
  })));
  const cids = [];
  for (let i = 0; i < 2; i += 1) cids.push(await upload(i));
  // The third recorded reveal is not in the aggregator's list: the cluster is two of three.
  const third = (changed && changed.third) || {};
  const thirdVector = third.revealVector || third.vector || vector;
  const thirdCid = await upload(2, third);
  return {
    scores: vector,
    justificationCid: cids.join(','),
    reveals: [...cids.map((cid) => ({ cid, scores: vector })), { cid: thirdCid, scores: thirdVector }],
    ...(changed && changed.node)
  };
}

/**
 * Justifications must be pinned before the stub answers, and the stub's answer is
 * synchronous, so each is prepared ahead by the request it will be asked about.
 */
const requestKey = (request) => `${request.cids.join(',')}|${/verdikta-dispute: /.test(request.addendum || '')}`;
async function prepareAnswers(requests, options) {
  const answers = new Map();
  for (const request of requests) {
    const normal = Array.isArray(request) ? { cids: request, addendum: '' } : request;
    answers.set(requestKey(normal), await justificationsFor(normal, options));
  }
  return (request) => {
    const found = answers.get(requestKey(request));
    if (!found) throw new Error(`the stub was asked about an unexpected request: ${request.cids.join(',')}`);
    return found;
  };
}

const claimRequests = () => [set.claims.valid, set.claims.outOfScope, set.claims.editsSource].map((c) => [set.listingCid, c.cid]);
const everyRequest = () => [
  ...Object.values(set.claims).map((c) => ({ cids: [c.listingCid || set.listingCid, c.cid], addendum: c.addendum })),
  { cids: [set.claims.dispute.disputeListingCid, set.claims.dispute.cid], addendum: set.claims.dispute.disputeAddendum }
];

async function startChain({ chainId, revertOnEstimate, estimatesBeforeRevert, requests = [], reporting, aiNode, change } = {}) {
  chain = await startStubChain({
    abi: AGGREGATOR_ABI,
    chainId,
    revertOnEstimate,
    estimatesBeforeRevert,
    answer: await prepareAnswers([...everyRequest(), ...NIGHTLY_BEFORE.cids, ...requests], { reporting, aiNode, change })
  });
  return chain;
}

/** node src/index.js l4 …, with the environment the workflow's step gives it and nothing inherited. */
function l4(args, env = {}, { cwd = dir } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [INDEX, 'l4', ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        RPC_URL: chain ? chain.url : 'http://127.0.0.1:9',
        AGGREGATOR_ADDRESS: chain ? chain.aggregator : undefined,
        E2E_WALLET_PRIVATE_KEY: ethers.Wallet.createRandom().privateKey,
        IPFS_GATEWAY: ipfs.url,
        ...env
      }
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

const versions = ['--expect-common', COMMON, '--expect-release', RELEASE];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-l4-cli-'));
  ipfs = await startLocalIpfs({ pinKey: 'local-test-key' });
  set = await F.makeClaimSet({ image: IMAGE, baseCommit: BASE_COMMIT, coldImage: COLD_IMAGE, repo, put: ipfs.put });
  claimKeyOf = new Map(Object.entries(set.claims).map(([key, c]) => [c.cid, key]));
  const claimSet = path.join(dir, 'claim-set.json');
  fs.writeFileSync(claimSet, JSON.stringify(F.claimSetFile(set)));
  // The committed scenarios, with their claim set in a file the test made.
  const committed = JSON.parse(fs.readFileSync(path.join(E2E, 'scenarios', 'scenarios.json'), 'utf8'));
  scenariosFile = path.join(dir, 'scenarios.json');
  fs.writeFileSync(scenariosFile, JSON.stringify(committed.map((s) => {
    if (s.suite === 'l4-claim') return { ...s, claimSet, ...(s.watchSeconds ? { watchSeconds: 1 } : {}) };
    if (s.cidFile) return { ...s, cidFile: path.join(E2E, s.cidFile) };
    return s;
  })));
  chain = null;
});

afterEach(async () => {
  if (chain) await chain.close();
  await ipfs.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('L4 refuses a claim scenario on anything but the canary class: every flag combination', () => {
  const dispatchBlank = { L4_CLASS_ID: '', L4_SCENARIO: '', L4_EXPECT_COMMON: '', L4_EXPECT_RELEASE: '' };
  const named = ['--scenario', 'claim-l4-valid'];

  it.each([
    ['--scenario and no --class-id', named, {}],
    ['--scenario and blank dispatch inputs', named, dispatchBlank],
    ['L4_SCENARIO with a blank class input', [], { ...dispatchBlank, L4_SCENARIO: 'claim-l4-valid' }],
    ['--class-id 128', [...named, '--class-id', '128'], {}],
    ['--class-id 128 with the versions named', [...named, '--class-id', '128', ...versions], {}],
    ['L4_CLASS_ID=128', named, { L4_CLASS_ID: '128' }],
    ['L4_CLASS_ID=128 by dispatch, versions named', [], { L4_SCENARIO: 'claim-l4-valid', L4_CLASS_ID: '128', L4_EXPECT_COMMON: COMMON, L4_EXPECT_RELEASE: RELEASE }],
    ['--class-id 128 over L4_CLASS_ID=5555', [...named, '--class-id', '128', ...versions], { L4_CLASS_ID: '5555' }],
    ['a blank --class-id', [...named, '--class-id', ''], {}],
    ['the versions named and no class', [...named, ...versions], {}],
    ['class 133', [...named, '--class-id', '133', ...versions], {}],
    ['class 0', [...named, '--class-id', '0', ...versions], {}],
    ['--assert-winner and no class', [...named, '--assert-winner'], {}],
    ['all three claim scenarios', ['--scenario', ALL_CLAIMS], {}],
    ['a text scenario beside a claim', ['--scenario', 'canonical-vuln,claim-l4-valid', ...versions], {}],
    ['a claim beside a text scenario, class 128', ['--scenario', 'claim-l4-runner-gate,frontend-default', '--class-id', '128', ...versions], {}]
  ])('%s: exit 1 and no RPC call at all', async (_name, args, env) => {
    await startChain();
    const r = await l4([...args, '--scenarios', scenariosFile], env);
    expect(r.out).toMatch(/run only on the canary class 5555/);
    expect(r.code).toBe(1);
    expect(chain.calls).toEqual([]);
    expect(chain.sent).toEqual([]);
  });

  it('the committed scenarios refuse on the class first, whether or not their claim set is pinned', async () => {
    await startChain();
    const r = await l4(['--scenario', 'claim-l4-valid']);
    expect(r.out).toMatch(/run only on the canary class 5555/);
    expect(r.code).toBe(1);
    expect(chain.calls).toEqual([]);
  });

  it('a hand-written scenario with a disclosure line, in another scenarios file, counts as a claim', async () => {
    await startChain();
    const file = path.join(dir, 'mine.json');
    fs.writeFileSync(file, JSON.stringify([{ id: 'mine', cids: [set.listingCid, set.claims.valid.cid], addendum: set.claims.valid.addendum, modes: ['commit-reveal'] }]));
    const r = await l4(['--scenario', 'mine', '--scenarios', file, ...versions]);
    expect(r.out).toMatch(/mine.*5555/s);
    expect(r.code).toBe(1);
    expect(chain.calls).toEqual([]);
    // Unnamed, in a full run of that file, it is refused all the same.
    const full = await l4(['--scenarios', file]);
    expect(full.code).toBe(1);
    expect(chain.calls).toEqual([]);
  });

  it('L4 still refuses the L2 claim scenarios by name', async () => {
    await startChain();
    const r = await l4(['--scenario', 'claim-valid', '--class-id', '5555', ...versions, '--scenarios', scenariosFile]);
    expect(r.out).toMatch(/claim-valid.*L2/s);
    expect(r.code).toBe(1);
    expect(chain.calls).toEqual([]);
  });

  it('it refuses without a wallet or an RPC URL too: the class comes first, and it asks for neither', async () => {
    const r = await l4(['--scenario', 'claim-l4-valid', '--scenarios', scenariosFile], { RPC_URL: '', E2E_WALLET_PRIVATE_KEY: '' });
    expect(r.out).toMatch(/run only on the canary class 5555/);
    expect(r.code).toBe(1);
  });
});

describe('with the canary class, the other refusals', () => {
  const canary = () => ['--scenario', 'claim-l4-valid', '--class-id', '5555', '--scenarios', scenariosFile];

  it.each([
    ['neither version', [], /--expect-common.*--expect-release/s],
    ['no --expect-release', ['--expect-common', COMMON], /--expect-release/],
    ['no --expect-common', ['--expect-release', RELEASE], /--expect-common/]
  ])('%s: exit 1, no RPC call', async (_name, extra, message) => {
    await startChain();
    const r = await l4([...canary(), ...extra]);
    expect(r.out).toMatch(message);
    expect(r.code).toBe(1);
    expect(chain.calls).toEqual([]);
  });

  it('another chain: the id is measured, and nothing is read or sent after it', async () => {
    await startChain({ chainId: 8453 });
    const r = await l4([...canary(), ...versions]);
    expect(r.out).toMatch(/84532/);
    expect(r.code).toBe(1);
    expect(chain.sent).toEqual([]);
    expect(chain.calls).not.toContain('eth_sendRawTransaction');
    expect(chain.calls).not.toContain('eth_getBalance');
  });

  it('selection would revert: estimateGas fails, so nothing is sent', async () => {
    await startChain({ revertOnEstimate: true });
    const r = await l4([...canary(), ...versions]);
    expect(r.out).toMatch(/estimat/i);
    expect(r.code).toBe(1);
    expect(chain.sent).toEqual([]);
  });

  it('no claim set at the path the scenario names: exit 1, no RPC call, and how to build it', async () => {
    await startChain();
    const file = path.join(dir, 'unpinned.json');
    const committed = JSON.parse(fs.readFileSync(scenariosFile, 'utf8'));
    fs.writeFileSync(file, JSON.stringify(committed.map((s) => (s.suite === 'l4-claim' ? { ...s, claimSet: path.join(dir, 'not-pinned-yet.json') } : s))));
    const r = await l4(['--scenario', 'claim-l4-valid', '--class-id', '5555', ...versions, '--scenarios', file]);
    expect(r.out).toMatch(/build-l4-claims/);
    expect(r.code).toBe(1);
    expect(chain.calls).toEqual([]);
  });
});

describe('--class-id 5555 --expect-common --expect-release runs the claim scenarios', () => {
  it('sends each on class 5555, as [listing, claim] with the disclosure line, and passes', async () => {
    await startChain();
    const report = path.join(dir, 'l4.json');
    const r = await l4(['--scenario', ALL_CLAIMS, '--class-id', '5555', ...versions, '--scenarios', scenariosFile, '--report', report]);
    expect(r.out).not.toMatch(/FAIL/);
    expect(r.code).toBe(0);
    expect(chain.sent.map((tx) => tx.requestedClass)).toEqual([5555, 5555, 5555]);
    expect(chain.sent.map((tx) => tx.cids)).toEqual(claimRequests());
    expect(chain.sent.map((tx) => tx.addendum)).toEqual([set.claims.valid.addendum, set.claims.outOfScope.addendum, set.claims.editsSource.addendum]);
    for (const tx of chain.sent) expect(codeReview.parseAddendum(tx.addendum).ok).toBe(true);
    expect(chain.sent.every((tx) => tx.to.toLowerCase() === chain.aggregator)).toBe(true);
    const json = JSON.parse(fs.readFileSync(report, 'utf8'));
    expect(json.summary).toMatchObject({ passed: 4, failed: 0, total: 4 });
    const names = json.cases.flatMap((c) => c.checks.map((x) => x.name));
    expect(names).toEqual(expect.arrayContaining(['arbiter.verdiktaCommon===expected', 'arbiter.release===expected', 'claim.verdictSource', 'claim.reportHashAgrees']));
  });

  it('the dispatch form: the same run from the L4_* variables alone', async () => {
    await startChain();
    const r = await l4(['--scenarios', scenariosFile], { L4_CLASS_ID: '5555', L4_SCENARIO: ALL_CLAIMS, L4_EXPECT_COMMON: COMMON, L4_EXPECT_RELEASE: RELEASE });
    expect(r.code).toBe(0);
    expect(chain.sent.map((tx) => tx.requestedClass)).toEqual([5555, 5555, 5555]);
  });

  it('prints the aggregator\'s response timeout on a claim run: G2 reads 900, and a lower one does not fail', async () => {
    await startChain();
    const r = await l4(['--scenario', 'claim-l4-front-gate', '--class-id', '5555', ...versions, '--scenarios', scenariosFile]);
    expect(r.out).toMatch(/responseTimeoutSeconds=300/);
    expect(r.code).toBe(0);
  });

  it('fails when an arbiter reports another build', async () => {
    await startChain({ reporting: { ...arbiter, release: 'ffff000 2026-11-03T00:00:00Z' } });
    const r = await l4(['--scenario', 'claim-l4-valid', '--class-id', '5555', ...versions, '--scenarios', scenariosFile]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/arbiter\.release===expected/);
    await chain.close();
    await startChain({ reporting: { ...arbiter, verdiktaCommon: '1.8.0' } });
    const other = await l4(['--scenario', 'claim-l4-valid', '--class-id', '5555', ...versions, '--scenarios', scenariosFile]);
    expect(other.code).toBe(1);
    expect(other.out).toMatch(/arbiter\.verdiktaCommon===expected/);
  });

  it('fails when the arbiters did not do what the scenario is for', async () => {
    // The valid claim's scenario, answered as if its gate had failed.
    claimKeyOf.set(set.claims.valid.cid, 'outOfScope');
    await startChain();
    const r = await l4(['--scenario', 'claim-l4-valid', '--class-id', '5555', ...versions, '--scenarios', scenariosFile]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/claim\.verdictSource/);
  });
});

describe('the nightly is unchanged', () => {
  const schedule = { L4_CLASS_ID: '', L4_EXPECT_COMMON: '', L4_EXPECT_RELEASE: '', L4_SCENARIO: '' };
  const nightly = ['--junit', 'results/l4.xml', '--report', 'results/l4.json'];

  const assertNightly = () => {
    expect(chain.sent.map((tx) => tx.requestedClass)).toEqual(NIGHTLY_BEFORE.ids.map(() => NIGHTLY_BEFORE.classId));
    expect(chain.sent.map((tx) => tx.cids)).toEqual(NIGHTLY_BEFORE.cids);
    expect(chain.sent.map((tx) => tx.addendum)).toEqual(['', '']);
    for (const tx of chain.sent) {
      expect(tx.alpha).toBe(NIGHTLY_BEFORE.alpha);
      expect(tx.maxOracleFee).toBe(NIGHTLY_BEFORE.maxOracleFee);
      expect(tx.estimatedBaseCost).toBe(NIGHTLY_BEFORE.estimatedBaseCost);
      expect(tx.maxFeeScaling).toBe(NIGHTLY_BEFORE.maxFeeScaling);
      expect(tx.value).toBe(NIGHTLY_BEFORE.value);
    }
    // Nothing new is asked of the chain, and no version is required of it.
    expect(chain.reads).not.toContain('responseTimeoutSeconds');
  };

  it('the committed scenarios on the schedule\'s blank inputs: class 128, the same two scenarios, the same calldata', async () => {
    await startChain();
    const r = await l4(nightly, schedule, { cwd: dir });
    expect(r.code).toBe(0);
    assertNightly();
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'results', 'l4.json'), 'utf8'));
    expect(json.cases.map((c) => c.id)).toEqual(NIGHTLY_BEFORE.ids);
    expect(json.cases.flatMap((c) => c.checks.map((x) => x.name)).filter((n) => n.startsWith('claim.') || n.startsWith('metric.'))).toEqual([]);
    expect(chain.calls).not.toContain('eth_getLogs');
    expect(chain.reads).not.toContain('getAggregationStatus');
  });

  it('the same once a claim set exists: a pinned claim set does not reach the nightly', async () => {
    await startChain();
    const r = await l4([...nightly, '--scenarios', scenariosFile], schedule);
    expect(r.code).toBe(0);
    assertNightly();
  });

  it('a failed gas estimate still falls back to the configured limit, as before', async () => {
    await startChain({ revertOnEstimate: true });
    const r = await l4(nightly, schedule);
    expect(r.code).toBe(0);
    assertNightly();
    expect(r.out).toMatch(/using configured gasLimit=4000000/);
  });

  it('the canary gate\'s dispatch (class 5555, no scenario) runs the same two on 5555, with no claim among them', async () => {
    await startChain();
    const r = await l4(nightly, { ...schedule, L4_CLASS_ID: '5555' });
    expect(r.code).toBe(0);
    expect(chain.sent.map((tx) => tx.requestedClass)).toEqual([5555, 5555]);
    expect(chain.sent.map((tx) => tx.cids)).toEqual(NIGHTLY_BEFORE.cids);
  });

  it('the workflow still runs the nightly with no class and no scenario on its command line', () => {
    const yml = fs.readFileSync(path.join(E2E, '..', '.github', 'workflows', 'e2e.yml'), 'utf8');
    expect(yml).toContain("- cron: '0 7 * * *'");
    expect(yml).toContain('L4_CLASS_ID: ${{ inputs.class_id }}');
    expect(yml).toContain('L4_SCENARIO: ${{ inputs.scenario }}');
    expect(yml).toContain('node src/index.js l4 --junit results/l4.xml --report results/l4.json\n');
    const config = JSON.parse(fs.readFileSync(path.join(E2E, 'config', 'e2e-config.json'), 'utf8'));
    expect(config.l4).toEqual({
      network: 'base_sepolia',
      rpcUrl: 'https://sepolia.base.org',
      aggregatorAddress: '0xe8a385E473EA710c5a88Cc72681a16a26fe380e4',
      classId: 128,
      fees: { alpha: 500, maxOracleFee: '150000000000000', estimatedBaseCost: '8000000000', maxFeeScaling: 5 },
      pollIntervalMs: 20000,
      timeoutMs: 900000,
      gasLimit: 4000000
    });
  });
});

describe('node A6c: the canary scenarios, through the CLI', () => {
  const run = (ids, extra = []) => l4(['--scenario', ids, '--class-id', '5555', ...versions, '--scenarios', scenariosFile, ...extra]);
  const armed = ['--expect-fault-switch', 'armed'];
  const reportOf = async (ids, extra = []) => {
    const file = path.join(dir, 'report.json');
    const r = await run(ids, [...extra, '--report', file]);
    return { ...r, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
  };
  const startArmed = (o = {}) => startChain({ reporting: armedArbiter, aiNode: 'armed', ...o });

  describe('every recorded reveal, not the cluster', () => {
    it('reads the reveal transactions: the arbiter outside the cluster is compared too', async () => {
      await startChain();
      const r = await run('claim-l4-valid');
      expect(r.out).not.toMatch(/FAIL/);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/3 recorded reveal/);
      expect(chain.calls).toEqual(expect.arrayContaining(['eth_getLogs', 'eth_getTransactionByHash']));
    });

    it('fails when the third arbiter has another report hash, though the cluster agrees', async () => {
      await startChain({ change: { valid: () => ({ third: { justification: `${evidence('jury', set.listingCid, set.claims.valid.cid, 'd'.repeat(64))}\n\nThe panel.` } }) } });
      const r = await run('claim-l4-valid');
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/claim\.reportHashAgrees.*2 report hash/);
      expect(r.out).toMatch(/P1/);
    });

    it('fails when the logs leave out a reveal outside the cluster: the aggregator\'s count says there are three', async () => {
      await startChain({ change: { valid: () => ({ node: { hiddenLogs: 1 } }) } });
      const { code, out, json } = await reportOf('claim-l4-valid');
      expect(code).toBe(1);
      expect(out).toMatch(/claim\.revealsComplete.*recorded 3 response/);
      expect(json.cases[0].metrics.rounds[0].validMass).toEqual([]);
      expect(chain.reads).toContain('getAggregationStatus');
    }, 60000);

    it('fails when a node behind the chain shows an open round with two responses and logs to match: a count from an open round is no count', async () => {
      await startChain({ change: { valid: () => ({ node: { hiddenLogs: 1, staleStatus: true } }) } });
      const { code, out, json } = await reportOf('claim-l4-valid');
      expect(code).toBe(1);
      expect(out).toMatch(/claim\.revealsComplete.*no complete round was read/);
      expect(json.cases[0].metrics.rounds[0].validMass).toEqual([]);
    }, 60000);

    it('a node that catches up within the retries is fine: the read waits for a complete round', async () => {
      await startChain({ change: { valid: () => ({ node: { staleStatus: 1 } }) } });
      const { code, out, json } = await reportOf('claim-l4-valid');
      expect(out).not.toMatch(/FAIL/);
      expect(code).toBe(0);
      expect(json.cases[0].metrics.rounds[0].validMass).toEqual([100, 100, 100]);
    }, 60000);

    it('duplicate slots fail the check and give no σ: three logs of two arbiters are not three arbiters', async () => {
      await startChain({ change: { valid: () => ({ node: { sameSlots: true } }) } });
      const { code, out, json } = await reportOf('claim-l4-valid');
      expect(code).toBe(1);
      expect(out).toMatch(/claim\.revealsComplete.*in 1 slot/);
      expect(json.cases[0].metrics.rounds[0].validMass).toEqual([]);
      expect(summarize(json.cases[0].metrics.rounds).sigma.usable).toBe(0);
    }, 60000);

    it('fails when an upload is not what the arbiter revealed on-chain', async () => {
      await startChain({ change: { outOfScope: () => ({ third: { revealVector: [0n, 1000000n, 0n, 0n, 0n, 0n] } }) } });
      const r = await run('claim-l4-front-gate');
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/claim\.revealMatchesUpload/);
    });
  });

  describe('the determinism PoCs', () => {
    it('time, randomness and flaky each pass on what their scenario says', async () => {
      await startChain();
      const r = await run('claim-l4-time-dependent,claim-l4-randomness-dependent,claim-l4-flaky');
      expect(r.out).not.toMatch(/FAIL/);
      expect(r.code).toBe(0);
      expect(chain.sent.map((tx) => tx.cids[1])).toEqual([set.claims.timeDependent.cid, set.claims.randomnessDependent.cid, set.claims.flaky.cid]);
    });
  });

  describe('an abstention: nobody commits, and the control shows the arbiters are there', () => {
    it('registry failure: the listing\'s digest, then what must settle: out of scope on that listing, and a runner gate', async () => {
      await startChain();
      const { code, out, json } = await reportOf('claim-l4-registry-failure');
      expect(out).not.toMatch(/FAIL/);
      expect(code).toBe(0);
      expect(chain.sent.map((tx) => tx.cids)).toEqual([
        [set.claims.registryFailure.listingCid, set.claims.registryFailure.cid],
        [set.claims.registryControl.listingCid, set.claims.registryControl.cid],
        [set.listingCid, set.claims.editsSource.cid]
      ]);
      const names = json.cases[0].checks.map((c) => c.name);
      expect(names).toEqual(expect.arrayContaining(['claim.noCommit', 'claim.noVerdict', 'control.front-gate.claim.gate', 'control.runner-gate.claim.gate']));
      expect(names).not.toContain('evaluation.fulfilled');
    });

    it('says how to finalize, and does not: a finalize applies penalties, an owner\'s call', async () => {
      await startChain();
      const r = await run('claim-l4-registry-failure');
      expect(r.out).toMatch(/finalizeEvaluationTimeout/);
      expect(chain.reads).not.toContain('finalizeEvaluationTimeout');
      expect(chain.sent).toHaveLength(3);
    });

    it('fails when an arbiter committed', async () => {
      await startChain({ change: { registryFailure: () => ({ abstain: { abstain: true, commitReceived: 2 } }) } });
      const r = await run('claim-l4-registry-failure');
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/claim\.noCommit/);
    });

    it('fails when the control on that listing did not settle: canaries that are down also commit nothing', async () => {
      await startChain({ change: { registryControl: () => ({ abstain: { abstain: true } }) } });
      const r = await reportOf('claim-l4-registry-failure', []);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/control\.front-gate\.evaluation\.fulfilled/);
    }, 60000);

    it('fails when the runner gate did not settle: a runner that is down also commits nothing', async () => {
      await startChain({ change: { editsSource: () => ({ abstain: { abstain: true } }) } });
      const r = await reportOf('claim-l4-registry-failure', []);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/control\.runner-gate\.evaluation\.fulfilled/);
    }, 60000);

    it('a control that cannot start fails its scenario', async () => {
      await startChain({ estimatesBeforeRevert: 1 });
      const r = await reportOf('claim-l4-registry-failure', []);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/control\.front-gate\.started/);
    }, 60000);

    it('fails when a verdict came', async () => {
      await startChain({ change: { registryFailure: () => ({ answer: true }) } });
      const r = await run('claim-l4-registry-failure');
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/claim\.no(Verdict|Commit)/);
    });

    it('cancellation: armed, nobody commits, and a valid claim then reaches the jury: providers and the runner were up', async () => {
      await startArmed();
      const r = await run('claim-l4-cancellation', armed);
      expect(r.out).not.toMatch(/FAIL/);
      expect(r.code).toBe(0);
      expect(chain.sent.map((tx) => tx.cids[1])).toEqual([set.claims.faultCancellation.cid, set.claims.valid.cid]);
    });

    it('cancellation fails when the jury was not there to reach', async () => {
      await startArmed({ change: { valid: () => ({ abstain: { abstain: true } }) } });
      const r = await run('claim-l4-cancellation', armed);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/control\.valid\.evaluation\.fulfilled/);
    }, 60000);
  });

  describe('the fault switch, as the run names it', () => {
    it.each(['claim-l4-near-limit-juror', 'claim-l4-provider-timeout', 'claim-l4-slow-justifier', 'claim-l4-cancellation'])('%s refuses without --expect-fault-switch armed: exit 1, no RPC call', async (id) => {
      await startChain();
      const r = await run(id);
      expect(r.out).toMatch(/--expect-fault-switch armed/);
      expect(r.code).toBe(1);
      expect(chain.calls).toEqual([]);
    });

    it('a mistyped state: exit 1, no RPC call', async () => {
      await startChain();
      const r = await run('claim-l4-valid', ['--expect-fault-switch', 'on']);
      expect(r.code).toBe(1);
      expect(chain.calls).toEqual([]);
    });

    it('still refuses on any other class first', async () => {
      await startChain();
      const r = await l4(['--scenario', 'claim-l4-near-limit-juror', '--class-id', '128', ...versions, ...armed, '--scenarios', scenariosFile]);
      expect(r.out).toMatch(/run only on the canary class 5555/);
      expect(r.code).toBe(1);
      expect(chain.calls).toEqual([]);
    });

    it('near-limit, timeout with retry, slow justifier: each passes on what the verdict says happened', async () => {
      await startArmed();
      const r = await run('claim-l4-near-limit-juror,claim-l4-provider-timeout,claim-l4-slow-justifier', armed);
      expect(r.out).not.toMatch(/FAIL/);
      expect(r.code).toBe(0);
    });

    it('a fault the switch refused fails its scenario, naming why', async () => {
      await startArmed({ change: { faultNearLimit: () => ({ json: { metadata: { verdict_source: 'code-review-jury', canary_fault_ai_node: 'armed', canary_fault: { fault: 'near-limit-juror', refused: 'REQUEST_CLASS 128' } } } }) } });
      const r = await run('claim-l4-near-limit-juror', armed);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/claim\.faultApplied.*REQUEST_CLASS/);
    });

    it('the dispatch form: L4_EXPECT_FAULT_SWITCH', async () => {
      await startArmed();
      const r = await l4(['--scenarios', scenariosFile], { L4_CLASS_ID: '5555', L4_SCENARIO: 'claim-l4-slow-justifier', L4_EXPECT_COMMON: COMMON, L4_EXPECT_RELEASE: RELEASE, L4_EXPECT_FAULT_SWITCH: 'armed' });
      expect(r.code).toBe(0);
    });

    it('the default: a claim fails while any arbiter is armed, so a canary cannot be left that way', async () => {
      await startChain({ reporting: armedArbiter });
      const r = await run('claim-l4-valid');
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/claim\.faultSwitch/);
    });

    it('the default: a claim fails while an AI Node keeps its key', async () => {
      await startChain({ aiNode: 'armed' });
      const r = await run('claim-l4-valid');
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/claim\.aiNodeFaultSwitch/);
    });

    it('armed, a claim the plan does not name stays untouched', async () => {
      await startArmed();
      const r = await run('claim-l4-valid,claim-l4-near-limit-juror', armed);
      expect(r.out).not.toMatch(/FAIL/);
      expect(r.code).toBe(0);
    });
  });

  describe('the cold cache', () => {
    it('reports the pull from the runner\'s own fact', async () => {
      await startChain();
      const { code, out, json } = await reportOf('claim-l4-cold-cache');
      expect(out).not.toMatch(/FAIL/);
      expect(code).toBe(0);
      expect(chain.sent[0].cids).toEqual([set.claims.coldCache.listingCid, set.claims.coldCache.cid]);
      expect(json.cases[0].metrics.rounds[0].image).toEqual([{ cache: 'pulled', durationMs: 21000 }, { cache: 'pulled', durationMs: 21000 }, { cache: 'pulled', durationMs: 21000 }]);
    });

    it('fails on a repeat within 15 minutes, which only an arbiter\'s kept run answered, and that round is no latency sample', async () => {
      await startChain({ change: { coldCache: () => ({ json: { metadata: { verdict_source: 'code-review-jury', canary_fault_ai_node: 'off', runner_image: { cache: 'reused', durationMs: 0 } } } }) } });
      const { code, out, json } = await reportOf('claim-l4-cold-cache');
      expect(code).toBe(1);
      expect(out).toMatch(/claim\.imageCold.*reused/);
      expect(json.cases[0].metrics.rounds[0].runReused).toBe(true);
      expect(summarize(json.cases[0].metrics.rounds).latency.n).toBe(0);
    });

    it('fails on an image already there', async () => {
      await startChain({ change: { coldCache: () => ({ json: { metadata: { verdict_source: 'code-review-jury', canary_fault_ai_node: 'off', runner_image: { cache: 'hit', durationMs: 1 } } } }) } });
      const r = await run('claim-l4-cold-cache');
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/claim\.imageCold/);
    });
  });

  describe('a dispute', () => {
    it('two rounds, as the contract composes them, and a flip is a fact it records', async () => {
      await startChain({ change: { dispute: ({ disputed }) => (disputed ? { vector: INVALID_VECTOR } : {}) } });
      const { code, out, json } = await reportOf('claim-l4-dispute');
      expect(out).not.toMatch(/FAIL/);
      expect(code).toBe(0);
      expect(chain.sent).toHaveLength(2);
      expect(chain.sent[0].addendum).toBe(set.claims.dispute.addendum);
      expect(chain.sent[1].addendum).toBe(set.claims.dispute.disputeAddendum);
      expect(chain.sent[0].cids).toEqual([set.listingCid, set.claims.dispute.cid]);
      expect(chain.sent[1].cids).toEqual([set.claims.dispute.disputeListingCid, set.claims.dispute.cid]);
      expect(chain.sent.map((tx) => tx.requestedClass)).toEqual([5555, 5555]);
      expect(json.cases[0].metrics.dispute).toMatchObject({ countable: true, flipped: true, before: 'HIGH', after: 'INVALID' });
    });

    it('a verdict that holds is a fact too', async () => {
      await startChain();
      const { code, json } = await reportOf('claim-l4-dispute');
      expect(code).toBe(0);
      expect(json.cases[0].metrics.dispute).toMatchObject({ countable: true, flipped: false });
    });

    it('a first verdict the contract would not let a maker dispute: no second round, no sample, and the run says so', async () => {
      await startChain({ change: { dispute: () => ({ vector: INVALID_VECTOR }) } });
      const { code, out, json } = await reportOf('claim-l4-dispute');
      expect(chain.sent).toHaveLength(1);
      expect(json.cases[0].metrics.dispute).toMatchObject({ countable: false });
      expect(out).toMatch(/not a valid outcome/);
      expect(code).toBe(0);
    });

    it('fails when the second round names no statement, and that round is no sample of a flip', async () => {
      await startChain({ change: { dispute: ({ disputed }) => (disputed ? { json: { metadata: { verdict_source: 'code-review-jury', canary_fault_ai_node: 'off' } } } : {}) } });
      const { code, out, json } = await reportOf('claim-l4-dispute');
      expect(code).toBe(1);
      expect(out).toMatch(/claim\.disputeStatement/);
      expect(json.cases[0].metrics.dispute.countable).toBe(false);
    });

    it('a vector settlement cannot read fails the round, and the measurements stay', async () => {
      await startChain({ change: { dispute: ({ disputed }) => (disputed ? { vector: [1n, 2n, 3n, 4n, 5n, 6n] } : {}) } });
      const { code, out, json } = await reportOf('claim-l4-dispute');
      expect(code).toBe(1);
      expect(out).toMatch(/dispute\.secondSettles/);
      expect(json.cases[0].metrics.rounds).toHaveLength(2);
      expect(json.cases[0].metrics.dispute).toBeUndefined();
    });
  });

  describe('the metrics', () => {
    it('a claim run reports them: no p95 from a few rounds, and σ per round from the reveals', async () => {
      await startChain();
      const { code, out, json } = await reportOf('claim-l4-valid,claim-l4-front-gate');
      expect(code).toBe(0);
      expect(out).toMatch(/metric\.latencyP95.*no p95: 1 of the 20/);
      const metrics = json.cases.find((c) => c.id === 'claim-l4-metrics');
      expect(metrics.checks.map((c) => c.name)).toEqual(['metric.latencyP95', 'metric.validMassSigma', 'metric.disputeFlips']);
      const [valid, gate] = json.cases;
      expect(valid.metrics.rounds[0]).toMatchObject({ kind: 'valid', verdict: 'jury', fault: false, validMass: [100, 100, 100] });
      expect(valid.metrics.rounds[0].latencyMs).toBeGreaterThan(0);
      expect(gate.metrics.rounds[0]).toMatchObject({ kind: 'front-gate', verdict: 'gate' });
    });

    it('the gate reads the reports a run wrote', async () => {
      await startChain();
      const { json } = await reportOf('claim-l4-valid');
      expect(json.cases[0].metrics).toBeDefined();
      const gated = require('child_process').spawnSync(process.execPath, [path.join(E2E, 'scripts', 'l4-metrics.js'), path.join(dir, 'report.json')], { encoding: 'utf8' });
      expect(gated.status).toBe(1);
      expect(gated.stdout).toMatch(/no p95: 1 of the 20/);
    });

    it('a jury round with no verdict is a sample against the budget, not a missing one', async () => {
      await startChain({ change: { valid: () => ({ abstain: { abstain: true } }) } });
      const provider = new ethers.JsonRpcProvider(chain.url);
      const wallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
      const aggregator = new ethers.Contract(chain.aggregator, AGGREGATOR_ABI, wallet);
      const config = JSON.parse(fs.readFileSync(path.join(E2E, 'config', 'e2e-config.json'), 'utf8'));
      const l4Config = { ...config.l4, classId: 5555, pollIntervalMs: 1 };
      const ctx = { cfg: {}, provider, aggregator, l4: l4Config, expect: {}, opts: {}, faultSwitch: { ea: 'off', aiNode: 'off' } };
      const request = { cids: [set.listingCid, set.claims.valid.cid], addendum: set.claims.valid.addendum };
      const { round, vector, checks } = await verdictRound(ctx, { id: 'x', minOutcomes: 6 }, request, { kind: 'valid', timeoutMs: 1 });
      provider.destroy();
      expect(vector).toBeNull();
      expect(round).toMatchObject({ kind: 'valid', verdict: 'jury', unfinished: true, validMass: [] });
      expect(checks.find((c) => c.name === 'evaluation.fulfilled').ok).toBe(false);
      expect(summarize([round]).latency).toMatchObject({ n: 1, unfinished: 1, maxMs: Infinity });
    });

    it('a request whose read fails after it was mined is still a round: it counts against the budget', async () => {
      await startChain();
      chain.failReads.add('getEvaluation');
      const provider = new ethers.JsonRpcProvider(chain.url);
      const wallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
      const aggregator = new ethers.Contract(chain.aggregator, AGGREGATOR_ABI, wallet);
      const config = JSON.parse(fs.readFileSync(path.join(E2E, 'config', 'e2e-config.json'), 'utf8'));
      const ctx = { cfg: {}, provider, aggregator, l4: { ...config.l4, classId: 5555, pollIntervalMs: 1 }, expect: {}, opts: {}, faultSwitch: { ea: 'off', aiNode: 'off' } };
      const request = { cids: [set.listingCid, set.claims.valid.cid], addendum: set.claims.valid.addendum };
      const { round, checks } = await verdictRound(ctx, { id: 'x', minOutcomes: 6 }, request, { kind: 'valid', timeoutMs: 200 });
      provider.destroy();
      expect(round).toMatchObject({ verdict: 'jury', unfinished: true });
      expect(checks.find((c) => c.name === 'evaluation.fulfilled').detail).toMatch(/last read/);
    });

    it('a dispute whose second request cannot start keeps the first round\'s measurement', async () => {
      await startChain({ estimatesBeforeRevert: 1 });
      const { code, out, json } = await reportOf('claim-l4-dispute');
      expect(code).toBe(1);
      expect(out).toMatch(/dispute\.started/);
      expect(chain.sent).toHaveLength(1);
      expect(json.cases[0].metrics.rounds).toHaveLength(1);
      expect(json.cases[0].metrics.rounds[0]).toMatchObject({ verdict: 'jury' });
      expect(json.cases[0].metrics.dispute).toBeUndefined();
    });

    it('a request that never started is no sample', async () => {
      await startChain({ revertOnEstimate: true });
      const { code, json } = await reportOf('claim-l4-valid');
      expect(code).toBe(1);
      expect(json.cases[0].metrics).toBeUndefined();
    });

    it('a valid claim answered by a gate fails, and is no jury sample: twenty of them cannot pass the gate', async () => {
      claimKeyOf.set(set.claims.valid.cid, 'outOfScope');
      await startChain();
      const { code, json } = await reportOf('claim-l4-valid');
      expect(code).toBe(1);
      expect(json.cases[0].metrics.rounds[0]).toMatchObject({ kind: 'valid', verdict: 'gate', fault: false });
      expect(summarize(Array.from({ length: 20 }, () => json.cases[0].metrics.rounds[0])).latency.n).toBe(0);
    });

    it('a text-only run has none', async () => {
      await startChain();
      const file = path.join(dir, 'report.json');
      const r = await l4(['--report', file, '--scenarios', scenariosFile], { L4_CLASS_ID: '' });
      expect(r.code).toBe(0);
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(json.cases.map((c) => c.id)).toEqual(NIGHTLY_BEFORE.ids);
      expect(json.cases.every((c) => c.metrics === undefined)).toBe(true);
    });
  });
});

describe('the switch\'s constants agree across the repository', () => {
  it('the aggregator the EA measures against is the one L4 sends to on Base Sepolia', () => {
    const { CANARY_AGGREGATOR, CANARY_CLASS_ID, CANARY_CHAIN_ID } = require('../../../external-adapter/src/canaryFault/constants');
    const config = JSON.parse(fs.readFileSync(path.join(E2E, 'config', 'e2e-config.json'), 'utf8'));
    const helpers = require('../l4/helpers');
    expect(CANARY_AGGREGATOR).toBe(config.l4.aggregatorAddress);
    expect(CANARY_CLASS_ID).toBe(helpers.CANARY_CLASS_ID);
    expect(CANARY_CHAIN_ID).toBe(helpers.CANARY_CHAIN_ID);
  });
});
