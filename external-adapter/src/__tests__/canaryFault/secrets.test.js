// Node A6c: the fault switch's key signs what the adapter asks of the AI Node, and an RPC URL can
// carry a provider's key in its path. Neither reaches a log, /health, /version or the version
// block in any justification, at the most verbose log level, on any path through the switch.
// The values are made here, per run: no key-shaped literal sits in the tests.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { codeReview } = require('@verdikta/common');
const { canaryFaultConfigFromEnv, loadCanaryFaultConfig, canaryFaultBlock, describeCanaryFault, faultForRequest } = require('../../canaryFault');
const { collectVersionInfo } = require('../../utils/versionInfo');
const { runClaim } = require('../../codeReview/claimRun');
const { SharedRuns } = require('../../codeReview/sharedRuns');
const { createDeadline } = require('../../codeReview/time');
const H = require('../../../test/helpers/codeReviewFixtures');
const R = require('../../../test/helpers/codeReviewRun');
const { startCanaryChain, OPERATOR, JOB_ID, AGG_ID } = require('../../../test/helpers/canaryChain');

const EA = path.join(__dirname, '..', '..', '..');
const BCID = H.cid('Claim');
const KEY = crypto.randomBytes(32).toString('hex');
const RPC_SECRET = crypto.randomBytes(16).toString('hex');

let chain;
let said;

const rpcUrl = () => `${chain.url}/v2/${RPC_SECRET}`;
const envFor = (over = {}) => ({
  VERDIKTA_CANARY_FAULTS: `${BCID}=near-limit-juror`,
  VERDIKTA_CANARY_FAULT_KEY: KEY,
  VERDIKTA_CANARY_RPC_URL: rpcUrl(),
  NETWORK_CHAIN_ID: '84532',
  DEPLOYMENT_NETWORK: 'base_sepolia',
  OPERATOR_ADDR: OPERATOR,
  ...over
});

const recording = () => {
  const keep = (...args) => said.push(args);
  return { info: keep, warn: keep, error: keep, debug: keep };
};
const holds = (value) => JSON.stringify(value).includes(KEY) || JSON.stringify(value).includes(RPC_SECRET);

beforeEach(async () => {
  said = [];
  chain = await startCanaryChain();
});

afterEach(async () => {
  await chain.close();
  loadCanaryFaultConfig({});
});

describe('the switch\'s own logging', () => {
  it.each([
    ['applied', () => {}],
    ['refused: a request for 128', () => { chain.state.requestedClass = 128; }],
    ['refused: another chain', () => { chain.state.chainId = 8453; }],
    ['refused: the RPC answers an error', () => { chain.state.fail = { '*': 'rpcError' }; }],
    ['refused: the RPC answers HTTP 500', () => { chain.state.fail = { '*': 'http500' }; }],
    ['refused: the RPC answers something else', () => { chain.state.fail = { '*': 'garbage' }; }]
  ])('%s', async (_name, arrange) => {
    arrange();
    const config = canaryFaultConfigFromEnv(envFor());
    const fault = await faultForRequest({ bcid: BCID, aggId: AGG_ID, jobId: JOB_ID }, { config, logger: recording(), runTag: '[test]' });
    expect(fault).not.toBeNull();
    expect(said.length).toBeGreaterThan(0);
    expect(holds(said)).toBe(false);
    expect(holds(describeCanaryFault(config))).toBe(false);
    expect(holds(fault.refused)).toBe(false);
  });

  it('a directive holds a MAC, which is not the key and does not give it back', async () => {
    const config = canaryFaultConfigFromEnv(envFor());
    const fault = await faultForRequest({ bcid: BCID, aggId: AGG_ID, jobId: JOB_ID }, { config, logger: recording() });
    const directive = fault.directiveFor(1, { bcid: BCID, reportSha256: 'a'.repeat(64) });
    expect(directive.mac).not.toBe(KEY);
    expect(holds(directive)).toBe(false);
  });
});

describe('what /health, /version and every justification read', () => {
  it.each([
    ['armed', {}],
    ['refused on mainnet, with the key still set', { NETWORK_CHAIN_ID: '8453', DEPLOYMENT_NETWORK: 'base_mainnet' }],
    ['refused: a plan it cannot read', { VERDIKTA_CANARY_FAULTS: `${KEY}=near-limit-juror` }],
    ['refused: the key beside a bad RPC URL', { VERDIKTA_CANARY_RPC_URL: `ftp://${KEY}@${RPC_SECRET}` }],
    ['refused: a key with a space in it', { VERDIKTA_CANARY_FAULT_KEY: `${KEY} x` }]
  ])('%s', (_name, over) => {
    const config = loadCanaryFaultConfig(envFor(over));
    expect(holds(describeCanaryFault(config))).toBe(false);
    expect(holds(canaryFaultBlock(config))).toBe(false);
    expect(holds(collectVersionInfo())).toBe(false);
  });
});

describe('the whole run, with a logger that keeps everything', () => {
  it('names neither in a log or a verdict, and sends the AI Node a MAC and no key', async () => {
    const runner = await R.startRunner();
    const ai = await R.startAiNode();
    try {
      const built = H.makeListing({ builderKey: codeReview.createDevBuilderKey() });
      const result = await runClaim({
        codeClass: 'code-standard',
        trust: 'dev',
        listing: {
          cid: H.cid('Listing'),
          outcomes: [...codeReview.BUG_OUTCOMES],
          query: 'the listing query',
          juryParameters: JSON.parse(JSON.stringify(codeReview.CODE_STANDARD_PANEL)),
          spec: built.spec,
          attestation: built.attestation,
          knownIssues: H.exampleKnownIssues(),
          baseline: H.exampleBaseline(built.spec.baseCommit)
        },
        claim: { bcid: BCID, finding: H.FINDING, report: '# report', pocPatch: Buffer.from(H.POC_PATCH), fixPatch: null },
        priorFindings: [],
        dispute: null,
        addendumText: '',
        eaGates: { disclosure: 'pass', inScope: 'pass' },
        warnings: []
      }, {
        config: { runner: { url: runner.url, readToken: () => 'r'.repeat(48) }, aiNode: { url: ai.url } },
        logger: recording(),
        runTag: '[test]',
        runs: new SharedRuns(),
        deadline: createDeadline({ receivedAt: Date.now(), deadlineMs: 780000 }),
        canaryRequest: { aggId: AGG_ID, jobId: JOB_ID },
        canaryConfig: canaryFaultConfigFromEnv(envFor())
      });
      expect(ai.state.calls[0].canaryFault).toBeDefined();
      expect(said.length).toBeGreaterThan(0);
      expect(holds(said)).toBe(false);
      expect(holds(result)).toBe(false);
      expect(holds(ai.state.calls)).toBe(false);
      expect(holds(runner.state.runs)).toBe(false);
    } finally {
      await runner.close();
      await ai.close();
    }
  });
});

describe('from the sources', () => {
  it('the key is used in one place: to sign', () => {
    const uses = ['index.js', 'measure.js'].flatMap((name) => fs.readFileSync(path.join(EA, 'src', 'canaryFault', name), 'utf8').split('\n').filter((line) => /\.key\b/.test(line)));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(/directiveMac\(config\.key,/);
  });

  it('a failed read keeps its own message: what the caller sees is a code', () => {
    const measure = fs.readFileSync(path.join(EA, 'src', 'canaryFault', 'measure.js'), 'utf8');
    expect(measure).toMatch(/catch \(_error\) \{\s*return 'RPC_FAILED';/);
    expect(measure).not.toMatch(/console\.|logger\./);
  });
});

describe('a real process at LOG_LEVEL=debug', () => {
  const freePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  const get = (port, route) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });

  it.each([
    ['armed', {}, 'armed'],
    ['refused on mainnet', { NETWORK_CHAIN_ID: '8453', DEPLOYMENT_NETWORK: 'base_mainnet' }, 'refused']
  ])('%s: its boot log and its routes hold neither', async (_name, over, state) => {
    const port = await freePort();
    const child = spawn(process.execPath, ['src/index.js'], {
      cwd: EA,
      env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'debug', ...envFor(over) }
    });
    let log = '';
    child.stdout.on('data', (c) => { log += c; });
    child.stderr.on('data', (c) => { log += c; });
    try {
      let health = null;
      for (let i = 0; i < 100 && !health; i += 1) {
        try {
          health = await get(port, '/health');
        } catch (_error) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      const version = await get(port, '/version');
      expect(JSON.parse(health).canaryFault.state).toBe(state);
      expect(log.length).toBeGreaterThan(0);
      for (const text of [log, health, version]) {
        expect(text).not.toContain(KEY);
        expect(text).not.toContain(RPC_SECRET);
      }
    } finally {
      child.kill('SIGKILL');
    }
  }, 30000);
});
