'use strict';

// Node A6a: the parts of the claim suite that need no Docker. The local IPFS
// against @verdikta/common's real client, the checks against what they must
// refuse (an abstention, a juror with web on, a missing juror), and a harness
// that cannot start, which must fail every scenario rather than skip it.

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const Hash = require('ipfs-only-hash');
const { createClient, codeReview } = require('@verdikta/common');
const Reporter = require('../reporter');
const { startLocalIpfs } = require('../l2/claim/local-ipfs');
const { startRecordingProxy } = require('../l2/claim/recording-proxy');
const C = require('../l2/claim/checks');
const { runClaimSuite } = require('../l2/claim/run-claim');
const { runL2 } = require('../l2/run-l2');

const allPass = (checks) => checks.length > 0 && checks.every((c) => c.ok);
const failed = (checks) => checks.filter((c) => !c.ok).map((c) => c.name);

describe('local IPFS: the EA\'s real client against the mock', () => {
  let ipfs;
  let client;
  const PIN_KEY = 'local-harness-key';

  beforeEach(async () => {
    ipfs = await startLocalIpfs({ pinKey: PIN_KEY });
    client = createClient({
      ipfs: { gateways: [ipfs.url], pinningService: ipfs.url, pinningKey: PIN_KEY, timeout: 5000, retryOptions: { retries: 0 }, uploadRetryOptions: { retries: 0 } },
      logging: { level: 'error', console: false, file: false }
    });
  });

  afterEach(async () => {
    client.ipfsClient.cleanup();
    await ipfs.close();
  });

  it('serves what was put, under its real CIDv0, byte for byte', async () => {
    const bytes = crypto.randomBytes(300000);
    const cid = await ipfs.put(bytes);
    expect(cid).toBe(await Hash.of(bytes));
    const got = await client.ipfsClient.fetchFromIPFS(cid);
    expect(Buffer.compare(got, bytes)).toBe(0);
    expect(ipfs.fetches).toEqual([cid]);
    expect(ipfs.misses).toEqual([]);
  });

  it('pins what the client uploads, as Pinata answers, and serves it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ipfs-'));
    const file = path.join(dir, 'justification.json');
    const bytes = Buffer.from(JSON.stringify({ scores: [], justification: 'é\r\n\u0000 binary-safe' }));
    fs.writeFileSync(file, bytes);
    const cid = await client.ipfsClient.uploadToIPFS(file);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(cid).toBe(await Hash.of(bytes));
    expect(ipfs.pins).toEqual([cid]);
    expect(Buffer.compare(await client.ipfsClient.fetchFromIPFS(cid), bytes)).toBe(0);
  });

  it('a pin without the key is refused, so a wiring mistake fails', async () => {
    const res = await axios.post(`${ipfs.url}/pinning/pinFileToIPFS`, 'x', { validateStatus: () => true });
    expect(res.status).toBe(401);
    const wrong = await axios.post(`${ipfs.url}/pinning/pinFileToIPFS`, 'x', { headers: { authorization: 'Bearer another' }, validateStatus: () => true });
    expect(wrong.status).toBe(401);
    expect(ipfs.pins).toEqual([]);
  });

  it('a CID it does not hold is a 404 and counted: no scenario passes through the public gateways', async () => {
    const res = await axios.get(`${ipfs.url}/ipfs/QmNotHere`, { validateStatus: () => true });
    expect(res.status).toBe(404);
    expect(ipfs.misses).toEqual(['QmNotHere']);
    expect(C.ipfsChecks(ipfs).every((c) => c.ok)).toBe(false);
  });
});

describe('recording proxy', () => {
  it('forwards a JSON call, records both sides, and passes on a hang-up', async () => {
    const seen = [];
    const target = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body: raw });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ answer: 42 }));
      });
    });
    await new Promise((r) => target.listen(0, '127.0.0.1', r));
    const proxy = await startRecordingProxy(`http://127.0.0.1:${target.address().port}`);
    try {
      const res = await axios.post(`${proxy.url}/v1/runs`, { question: 1 }, { headers: { authorization: 'Bearer t' } });
      expect(res.status).toBe(201);
      expect(res.data).toEqual({ answer: 42 });
      expect(seen[0]).toMatchObject({ url: '/v1/runs', auth: 'Bearer t' });
      expect(proxy.calls).toHaveLength(1);
      expect(proxy.calls[0]).toMatchObject({ method: 'POST', path: '/v1/runs', status: 201, request: { question: 1 }, response: { answer: 42 } });
      expect(proxy.post('/v1/runs')).toHaveLength(1);
      await axios.get(`${proxy.url}/health`);
      expect(proxy.post('/v1/runs')).toHaveLength(1);
    } finally {
      await proxy.close();
      await new Promise((r) => target.close(r));
    }
  });
});

const panel = codeReview.CODE_STANDARD_PANEL.AI_NODES.map((n) => ({ provider: n.AI_PROVIDER, model: n.AI_MODEL }));
const REPORT_SHA = 'a'.repeat(64);
const MARKER = 'REPORT-MARKER-1234';
const PACK_MARKER = 'PACK-MARKER-5678';

function jurorCall(p, over = {}) {
  return {
    provider: p.provider, model: p.model, prompt: `... ${REPORT_SHA} ... ${MARKER} ... ${PACK_MARKER} ...`,
    options: { webAccess: false, maxTokens: 8000, effort: 'high', signal: true },
    outcome: 'answered', signalAborted: false, startedAt: 1, endedAt: 2, ...over
  };
}
const justifierCall = (over = {}) => ({
  provider: 'openai', model: 'mock-justifier', prompt: 'justify', options: { webAccess: false, maxTokens: undefined, effort: undefined, signal: true },
  outcome: 'answered', signalAborted: false, startedAt: 2, endedAt: 3, ...over
});

describe('the provider layer checks: every juror, web off, the signal', () => {
  const expected = { panel, justifier: { provider: 'openai', model: 'mock-justifier' }, reportSha256: REPORT_SHA, markers: [MARKER, PACK_MARKER], maxTokens: 8000 };

  it('pass on what a real run records', () => {
    expect(failed(C.providerChecks([...panel.map((p) => jurorCall(p)), justifierCall()], expected))).toEqual([]);
  });

  it('a juror that never reached the provider layer fails', () => {
    expect(failed(C.providerChecks([jurorCall(panel[0]), justifierCall()], expected))).toEqual(expect.arrayContaining(['provider.everyJuror']));
  });

  it('a juror called with web access on fails', () => {
    const calls = [jurorCall(panel[0], { options: { webAccess: true, maxTokens: 8000, effort: 'high', signal: true } }), jurorCall(panel[1]), justifierCall()];
    expect(failed(C.providerChecks(calls, expected))).toEqual(expect.arrayContaining(['provider.webOff']));
  });

  it('a call with no abort signal fails: the deadline could not reach it', () => {
    const calls = [jurorCall(panel[0], { options: { webAccess: false, maxTokens: 8000, effort: 'high', signal: false } }), jurorCall(panel[1]), justifierCall()];
    expect(failed(C.providerChecks(calls, expected))).toEqual(expect.arrayContaining(['provider.signal']));
  });

  it('a juror that did not get the report or the pack fails', () => {
    expect(failed(C.providerChecks([jurorCall(panel[0], { prompt: `${REPORT_SHA} ${MARKER}` }), jurorCall(panel[1]), justifierCall()], expected)))
      .toEqual(expect.arrayContaining(['provider.reportAndPack']));
  });

  it('jurors who read different prompts fail: one prompt, the same bytes', () => {
    expect(failed(C.providerChecks([jurorCall(panel[0]), jurorCall(panel[1], { prompt: `x ${REPORT_SHA} ${MARKER} ${PACK_MARKER}` }), justifierCall()], expected)))
      .toEqual(expect.arrayContaining(['provider.onePrompt']));
  });

  it('no justifier call fails, and a lower effort fails', () => {
    expect(failed(C.providerChecks(panel.map((p) => jurorCall(p)), expected))).toEqual(expect.arrayContaining(['provider.justifier']));
    expect(failed(C.providerChecks([jurorCall(panel[0], { options: { webAccess: false, maxTokens: 8000, effort: 'low', signal: true } }), jurorCall(panel[1]), justifierCall()], expected)))
      .toEqual(expect.arrayContaining(['provider.envelope']));
  });
});

describe('the run checks: no pass by abstaining', () => {
  const definitive = {
    outcome: 'definitive', runner: { platform: 'linux/amd64', runtime: 'runc' }, reportUnavailable: null,
    report: { inputs: { platform: 'linux/amd64' }, gates: { applies: 'pass', testPathsOnly: 'pass', build: 'pass', reproduces: 'pass', integrity: 'pass', claimedObservable: 'pass' } },
    reportSha256: REPORT_SHA, contextPack: { files: [{ name: '00-manifest.json', text: '{}' }] }
  };

  it('a definitive run with a report passes', () => {
    expect(allPass(C.runChecks(definitive, { classPlatform: true }))).toBe(true);
  });

  it('an abstaining run fails', () => {
    expect(failed(C.runChecks({ ...definitive, outcome: 'abstain', abstain: { cause: 'oom' }, report: null }, { classPlatform: true })))
      .toEqual(expect.arrayContaining(['run.definitive']));
  });

  it('a run with no report fails: that is what an arm64 host without the launcher gives', () => {
    expect(failed(C.runChecks({ ...definitive, report: null, reportSha256: null, reportUnavailable: 'a development setting' }, { classPlatform: true })))
      .toEqual(expect.arrayContaining(['run.report']));
  });

  it('on the class platform the run must have used it; off it the line says so', () => {
    expect(failed(C.runChecks({ ...definitive, runner: { platform: 'linux/arm64', runtime: 'runc' } }, { classPlatform: true })))
      .toEqual(expect.arrayContaining(['run.platform']));
    const local = C.runChecks({ ...definitive, runner: { platform: 'linux/arm64', runtime: 'runc' } }, { classPlatform: false });
    const line = local.find((c) => c.name === 'run.platform');
    expect(line.ok).toBe(true);
    expect(line.detail).toMatch(/linux\/arm64.*names linux\/amd64.*CI/);
  });
});

describe('the AI Node request checks', () => {
  const pack = { files: [{ name: '00-manifest.json', text: `{} ${PACK_MARKER}` }, { name: '02-report.txt', text: `# report.md\n${MARKER}` }] };
  const body = () => ({
    prompt: 'the query', outcomes: [...codeReview.BUG_OUTCOMES], models: [], attachments: pack.files.map((f) => f.text), attachmentNames: pack.files.map((f) => f.name),
    codeReview: { deadlineMs: 700000, reportSha256: REPORT_SHA, codeClass: 'code-standard' }
  });
  const answer = () => ({ codeReview: { deadlineMs: 700000, jurorTimeoutMs: 240000, justifierReserveMs: 45000, reportSha256: REPORT_SHA } });
  const accept = () => ({ ok: true, issues: [] });

  it('pass on what the EA sends', () => {
    expect(failed(C.aiRequestChecks({ request: body(), response: answer(), status: 200 }, { pack, reportSha256: REPORT_SHA, deadlineLimitMs: 780000, validate: accept }))).toEqual([]);
  });

  it('no codeReview field fails', () => {
    const request = { ...body() };
    delete request.codeReview;
    expect(failed(C.aiRequestChecks({ request, response: answer(), status: 200 }, { pack, reportSha256: REPORT_SHA, deadlineLimitMs: 780000, validate: accept })))
      .toEqual(expect.arrayContaining(['ai.codeReview']));
  });

  it('a deadline above the limit, or none, fails', () => {
    for (const deadlineMs of [780001, 0, undefined]) {
      const request = body();
      request.codeReview.deadlineMs = deadlineMs;
      expect(failed(C.aiRequestChecks({ request, response: answer(), status: 200 }, { pack, reportSha256: REPORT_SHA, deadlineLimitMs: 780000, validate: accept })))
        .toEqual(expect.arrayContaining(['ai.deadlineMs']));
    }
  });

  it('a pack that did not arrive fails', () => {
    const request = body();
    request.attachments = [];
    expect(failed(C.aiRequestChecks({ request, response: answer(), status: 200 }, { pack, reportSha256: REPORT_SHA, deadlineLimitMs: 780000, validate: accept })))
      .toEqual(expect.arrayContaining(['ai.pack']));
  });

  it('an answer that planned from another deadline fails', () => {
    const response = answer();
    response.codeReview.deadlineMs = 1;
    expect(failed(C.aiRequestChecks({ request: body(), response, status: 200 }, { pack, reportSha256: REPORT_SHA, deadlineLimitMs: 780000, validate: accept })))
      .toEqual(expect.arrayContaining(['ai.deadlinePlanned']));
  });
});

describe('the verdict checks', () => {
  it('all weight on INVALID, with the gate named, and nothing else', () => {
    const scores = [1000000, 0, 0, 0, 0, 0];
    expect(allPass(C.invalidScoreChecks(scores))).toBe(true);
    expect(allPass(C.invalidScoreChecks([0, 1000000, 0, 0, 0, 0]))).toBe(false);
    expect(allPass(C.invalidScoreChecks([999999, 1, 0, 0, 0, 0]))).toBe(false);
    expect(allPass(C.invalidScoreChecks(null))).toBe(false);
  });

  it('the jury\'s weighted average, so both jurors counted', () => {
    expect(allPass(C.scoreChecks([0, 0, 0, 0, 700000, 300000], [0, 0, 0, 0, 700000, 300000]))).toBe(true);
    expect(allPass(C.scoreChecks([0, 0, 0, 0, 800000, 200000], [0, 0, 0, 0, 700000, 300000]))).toBe(false);
  });

  it('no AI call between two counts: any call fails', () => {
    expect(allPass(C.noAiChecks({ aiCalls: 3, providerCalls: 6 }, { aiCalls: 3, providerCalls: 6 }))).toBe(true);
    expect(allPass(C.noAiChecks({ aiCalls: 3, providerCalls: 6 }, { aiCalls: 4, providerCalls: 6 }))).toBe(false);
    expect(allPass(C.noAiChecks({ aiCalls: 3, providerCalls: 6 }, { aiCalls: 3, providerCalls: 7 }))).toBe(false);
  });
});

describe('the commitment: recomputed, not only well-formed', () => {
  const operator = '0x0000000000000000000000000000000000000001';
  const scores = [0, 0, 0, 0, 700000, 300000];
  const salt = 'ab'.repeat(10);
  const commitment = () => {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256[]', 'uint256'], [operator, scores, BigInt(`0x${salt}`)]);
    return BigInt(`0x${ethers.sha256(encoded).slice(2, 34)}`).toString();
  };

  it('the reveal\'s scores and salt hash to what was committed', () => {
    expect(allPass(C.commitmentChecks(commitment(), scores, `QmCid:${salt}`, operator))).toBe(true);
  });

  it('another score vector or another salt does not', () => {
    expect(allPass(C.commitmentChecks(commitment(), [0, 0, 0, 0, 700001, 299999], `QmCid:${salt}`, operator))).toBe(false);
    expect(allPass(C.commitmentChecks(commitment(), scores, `QmCid:${'cd'.repeat(10)}`, operator))).toBe(false);
  });
});

describe('a harness that cannot start fails every scenario, and never skips one', () => {
  const scenarios = [
    { id: 'claim-valid', suite: 'claim', claim: 'valid', modes: ['0', 'commit-reveal', 'juror-deadline'] },
    { id: 'claim-gate-fail', suite: 'claim', claim: 'gate-fail', modes: ['front-gate', 'runner-gate', 'commit-reveal'] }
  ];
  let log;
  beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => log.mockRestore());

  it('a start that throws: one failed case per scenario and mode, naming why', async () => {
    const reporter = new Reporter();
    await runClaimSuite({}, scenarios, {
      mock: true, bootAdapter: true, reporter,
      startHarness: async () => { throw new Error('no docker here'); }
    });
    expect(reporter.cases).toHaveLength(6);
    expect(reporter.failed).toBe(6);
    expect(reporter.passed).toBe(0);
    for (const c of reporter.cases) expect(c.error).toMatch(/harness did not start.*no docker here/);
  });

  it('--real and no --boot-adapter fail too, rather than run something else', async () => {
    const real = new Reporter();
    await runClaimSuite({}, scenarios, { mock: false, bootAdapter: true, reporter: real, startHarness: async () => { throw new Error('must not be called'); } });
    expect(real.failed).toBe(6);
    expect(real.cases[0].error).toMatch(/mock provider/);
    const noBoot = new Reporter();
    await runClaimSuite({}, scenarios, { mock: true, bootAdapter: false, reporter: noBoot, startHarness: async () => { throw new Error('must not be called'); } });
    expect(noBoot.failed).toBe(6);
    expect(noBoot.cases[0].error).toMatch(/--boot-adapter/);
  });

  it('a scenario handler that throws is that case\'s failure, the suite goes on, and the harness closes', async () => {
    const reporter = new Reporter();
    let closed = false;
    const harness = {
      claims: { valid: { requestCid: 'QmListing,QmClaim:line' } },
      ai: { post: () => [] },
      evaluate: async () => { throw Object.assign(new Error('Request failed with status code 500'), { response: { status: 500, data: { statusCode: 500, error: 'CODE_REVIEW_REPORT_UNAVAILABLE' } } }); },
      counts: () => ({ aiCalls: 0, providerCalls: 0, runnerCalls: 0 }),
      close: async () => { closed = true; }
    };
    await runClaimSuite({}, [scenarios[0]], { mock: true, bootAdapter: true, reporter, startHarness: async () => harness });
    expect(reporter.failed).toBe(3);
    expect(reporter.cases[0].error).toMatch(/CODE_REVIEW_REPORT_UNAVAILABLE/);
    expect(closed).toBe(true);
  });

  it('runL2 keeps plain and claim scenarios apart: a claim-only run boots no mock AI Node', async () => {
    const reporter = new Reporter();
    await runL2({ mockAi: { port: 1 } }, [scenarios[0]], {
      mock: true, bootAdapter: true, reporter,
      startClaimHarness: async () => { throw new Error('stop here'); }
    });
    expect(reporter.failed).toBe(3);
  });

  it('the real CLI, with no docker to find: exit 1, each scenario FAIL, no secret asked for', () => {
    const e2e = path.join(__dirname, '..', '..');
    const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'no-docker-'));
    const env = { PATH: emptyPath, HOME: process.env.HOME, E2E_CLAIM_LOG_DIR: path.join(emptyPath, 'logs') };
    const run = spawnSync(process.execPath, ['src/index.js', 'l2', '--mock', '--boot-adapter', '--scenario', 'claim-valid,claim-gate-fail'], { cwd: e2e, env, encoding: 'utf8', timeout: 120000 });
    fs.rmSync(emptyPath, { recursive: true, force: true });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/FAIL\s+claim-valid/);
    expect(run.stdout).toMatch(/FAIL\s+claim-gate-fail/);
    expect(run.stdout + run.stderr).not.toMatch(/skip/i);
    expect(run.stdout + run.stderr).not.toMatch(/IPFS_PINNING_KEY/);
  }, 130000);
});
