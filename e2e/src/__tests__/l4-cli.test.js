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
const { AGGREGATOR_ABI } = require('../l4/run-l4');
const { startLocalIpfs } = require('../l2/claim/local-ipfs');
const F = require('../l2/claim/fixtures');
const repo = require('../../../code-runner/test/docker/forgeFixture');
const { startStubChain } = require('../../test/helpers/stub-chain');

jest.setTimeout(120000);

const E2E = path.join(__dirname, '..', '..');
const INDEX = path.join(E2E, 'src', 'index.js');
const COMMON = '1.9.0-attest.1';
const RELEASE = 'abc1234def5678';
const IMAGE = `registry.example/vault@sha256:${'b'.repeat(64)}`;
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

const arbiter = { adapter: '0.1.0', aiNode: '0.1.0', verdiktaCommon: COMMON, release: `${RELEASE} 2026-11-03T00:00:00Z` };
const evidence = (settlement, listingCid, claimCid) => [
  'Execution evidence v1', `Settlement: ${settlement}`, `Report-SHA256: ${REPORT_HASH}`, `Listing: ${listingCid}`, `Claim: ${claimCid}`, 'End execution evidence'
].join('\n');

/** What the arbiters would have uploaded, on the local IPFS. */
async function justificationsFor(request, { reporting = arbiter } = {}) {
  const [listingCid, claimCid] = request.cids;
  const kind = claimKeyOf.get(claimCid);
  const scores = kind === 'valid' ? [0n, 0n, 0n, 100000n, 700000n, 200000n] : [1000000n, 0n, 0n, 0n, 0n, 0n];
  const body = {
    valid: { justification: `${evidence('jury', listingCid, claimCid)}\n\nThe panel.`, metadata: { verdict_source: 'code-review-jury' } },
    outOfScope: { justification: `Verdict: INVALID.\n\nGate: inScope`, metadata: { verdict_source: 'code-review-gate', gate: 'inScope', claim: claimCid } },
    editsSource: { justification: `${evidence('INVALID (testPathsOnly)', listingCid, claimCid)}\n\nGate: testPathsOnly`, metadata: { verdict_source: 'code-review-runner', gate: 'testPathsOnly' } }
  }[kind] || { justification: 'A text-mode justification.', metadata: {} };
  const json = { scores: [], arbiter: reporting, ...body };
  const cids = [];
  for (let i = 0; i < 3; i += 1) cids.push(await ipfs.put(Buffer.from(JSON.stringify({ ...json, nonce: i }))));
  return { scores: kind ? scores : [600000n, 400000n], justificationCid: cids.join(',') };
}

/**
 * Justifications must be pinned before the stub answers, and the stub's answer is
 * synchronous, so each is prepared ahead by the (cid list) it will be asked about.
 */
async function prepareAnswers(requests, options) {
  const answers = new Map();
  for (const cids of requests) answers.set(cids.join(','), await justificationsFor({ cids }, options));
  return (request) => {
    const found = answers.get(request.cids.join(','));
    if (!found) throw new Error(`the stub was asked about an unexpected request: ${request.cids.join(',')}`);
    return found;
  };
}

const claimRequests = () => [set.claims.valid, set.claims.outOfScope, set.claims.editsSource].map((c) => [set.listingCid, c.cid]);

async function startChain({ chainId, revertOnEstimate, requests = [], reporting } = {}) {
  chain = await startStubChain({
    abi: AGGREGATOR_ABI,
    chainId,
    revertOnEstimate,
    answer: await prepareAnswers([...claimRequests(), ...NIGHTLY_BEFORE.cids, ...requests], { reporting })
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
  set = await F.makeClaimSet({ image: IMAGE, baseCommit: BASE_COMMIT, repo, put: ipfs.put });
  claimKeyOf = new Map(Object.entries(set.claims).map(([key, c]) => [c.cid, key]));
  const claimSet = path.join(dir, 'claim-set.json');
  fs.writeFileSync(claimSet, JSON.stringify(F.claimSetFile(set)));
  // The committed scenarios, with their claim set in a file the test made.
  const committed = JSON.parse(fs.readFileSync(path.join(E2E, 'scenarios', 'scenarios.json'), 'utf8'));
  scenariosFile = path.join(dir, 'scenarios.json');
  fs.writeFileSync(scenariosFile, JSON.stringify(committed.map((s) => {
    if (s.suite === 'l4-claim') return { ...s, claimSet };
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
    expect(json.summary).toMatchObject({ passed: 3, failed: 0, total: 3 });
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
    expect(json.cases.flatMap((c) => c.checks.map((x) => x.name)).filter((n) => n.startsWith('claim.'))).toEqual([]);
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
