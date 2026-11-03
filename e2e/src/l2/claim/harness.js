'use strict';

/**
 * The claim suite's harness: a local IPFS, a registry:2 holding a real Foundry env image,
 * and the real External Adapter, AI Node (mock provider) and code runner, wired together
 * with recording proxies between them. Any step that fails is the suite's failure: start
 * throws, and every scenario reports it (run-claim.js). Nothing here skips.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { codeReview } = require('@verdikta/common');
const { startLocalIpfs } = require('./local-ipfs');
const { startRecordingProxy } = require('./recording-proxy');
const { startAiNode, startCodeRunner, startAdapter } = require('./services');
const { startCanaryChain } = require('./canary-chain');
const F = require('./fixtures');

const CODE_RUNNER = path.join(__dirname, '..', '..', '..', '..', 'code-runner');
const PIN_KEY = 'local-harness-pin-key';
const OPERATOR = '0x0000000000000000000000000000000000000001';
const JUSTIFIER = Object.freeze({ provider: 'openai', model: 'mock-justifier' });
const HANGING_JUROR = Object.freeze({ provider: 'openai', model: 'gpt-6-luna' });

/** The panel's replies, weights 0.5 and 0.5, so only both together give the average the scenario asserts. */
const JUROR_SCORES = Object.freeze({
  'claude-sonnet-5-5': [0, 0, 0, 0, 800000, 200000],
  'deepseek/deepseek-v4-pro-0813': [0, 0, 0, 0, 600000, 400000],
  // On the dispute panel, in the second juror's place.
  'gpt-6-sol': [0, 0, 0, 0, 600000, 400000]
});
const JURY_AVERAGE = Object.freeze([0, 0, 0, 0, 700000, 300000]);
const MOCK_SCRIPT = Object.freeze({
  ...Object.fromEntries(Object.entries(JUROR_SCORES).map(([model, scores]) => [model, { scores, justification: `Mock juror ${model}: the deposit over-credits.` }])),
  [JUSTIFIER.model]: { reply: 'Mock justification: the panel finds the over-credit a HIGH.' },
  [HANGING_JUROR.model]: { hang: true }
});

function step(name, fn) {
  return fn().catch((err) => {
    throw new Error(`${name}: ${err.message}`);
  });
}

/** What the mock provider logged, read from its file: it runs in the AI Node's process. */
function readCallLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Publish the fixture image to the registry and remove it from the daemon, so the runner
 * has to pull it, by digest, from an allowlisted registry.
 */
async function publishImage({ docker, runText, registry, built }) {
  const tag = `${registry.host}/vault:e2e`;
  assert.equal((await runText(docker, ['tag', built.image, tag], { timeoutMs: 30000 })).exitCode, 0, 'docker tag');
  const pushed = await runText(docker, ['push', tag], { timeoutMs: 300000 });
  assert.equal(pushed.exitCode, 0, `docker push: ${pushed.stderr}`);
  const m = /digest: (sha256:[0-9a-f]{64})/.exec(pushed.stdout);
  assert.ok(m, `the push printed a digest: ${pushed.stdout}`);
  const ref = `${registry.host}/vault@${m[1]}`;
  await runText(docker, ['image', 'rm', '--force', tag, ref], { timeoutMs: 120000 });
  return ref;
}

/**
 * @returns {Promise<object>} the running harness; `close()` stops every process, container and image it made
 */
async function startClaimHarness() {
  const closers = [];
  const close = async () => {
    for (const c of closers.reverse()) {
      try {
        await c();
      } catch (err) {
        console.warn(`[claim] cleanup: ${err.message}`);
      }
    }
  };
  const logDir = process.env.E2E_CLAIM_LOG_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-claim-'));
  fs.mkdirSync(logDir, { recursive: true });
  console.log(`[claim] service logs in ${logDir}`);

  try {
    // The fixtures under code-runner/test/docker read the runtime when they load.
    process.env.CODE_RUNNER_RUNTIME = 'runc';
    const { runText } = require(path.join(CODE_RUNNER, 'src/docker'));
    const H = await step('loading the code runner\'s Docker fixtures (npm ci in code-runner/?)', async () => require(path.join(CODE_RUNNER, 'test/docker/helpers')));
    const runnerRepo = require(path.join(CODE_RUNNER, 'test/docker/forgeFixture'));
    const { buildFixture } = runnerRepo;
    const { CANARY_IMAGE_OPTIONS } = require(path.join(CODE_RUNNER, 'test/docker/determinismPocs'));
    const { startRegistry } = require(path.join(CODE_RUNNER, 'test/docker/registry'));

    const platform = H.PLATFORM;
    const classPlatform = platform === codeReview.CLASS_HARD_LIMITS.platform;
    if (!classPlatform && process.env.E2E_CLAIM_REQUIRE_CLASS_PLATFORM === '1') {
      throw new Error(`this host runs ${platform}, and E2E_CLAIM_REQUIRE_CLASS_PLATFORM=1 refuses the local report substitution`);
    }
    const instance = `e2e${crypto.randomBytes(4).toString('hex')}`;
    const docker = H.dockerFor(H.dockerTestConfig());
    await step('reaching Docker', async () => {
      const info = await runText(docker, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 30000 });
      if (info.exitCode !== 0) throw new Error(info.stderr.trim() || `docker info exited ${info.exitCode}`);
    });

    const ipfs = await step('starting the local IPFS', () => startLocalIpfs({ pinKey: PIN_KEY }));
    closers.push(() => ipfs.close());

    const registry = await step('starting registry:2', () => startRegistry(docker, instance));
    closers.push(() => registry.remove());
    const built = await step('building the Foundry fixture image', () => buildFixture(docker, { ...CANARY_IMAGE_OPTIONS, instance }));
    closers.push(() => built.remove());
    const image = await step('pushing the image to the registry', () => publishImage({ docker, runText, registry, built }));
    closers.push(() => runText(docker, ['image', 'rm', '--force', image], { timeoutMs: 120000 }));
    // Off the daemon, so the runner has to pull it, by digest, from the registry alone.
    await step('removing the fixture image from the daemon', () => built.remove());
    console.log(`[claim] env image ${image} (${platform})`);

    // The archives: the same builder L4's claim set comes from.
    const set = await F.makeClaimSet({ repo: runnerRepo, put: ipfs.put, image, baseCommit: built.baseCommit });
    const { listing, listingCid } = set;
    const textCid = await ipfs.put(F.textArchive());

    // The services.
    const callLog = path.join(logDir, 'provider-calls.jsonl');
    const justifierModel = `${JUSTIFIER.provider}:${JUSTIFIER.model}`;
    // The AI Node holds the fault switch's key throughout: with no directive from an armed adapter it does nothing, and that is asserted.
    const canaryFaultKey = crypto.randomBytes(32).toString('hex');
    const aiNode = await step('starting the AI Node', () => startAiNode({ logDir, callLog, script: MOCK_SCRIPT, justifierModel, canaryFaultKey }));
    closers.push(() => aiNode.close());
    const aiProxy = await step('starting the AI Node\'s proxy', () => startRecordingProxy(aiNode.url));
    closers.push(() => aiProxy.close());

    const runnerToken = crypto.randomBytes(32).toString('hex');
    const stateDir = fs.mkdtempSync(path.join(logDir, 'runner-state-'));
    const runner = await step('starting the code runner', () => startCodeRunner({
      logDir, stateDir, token: runnerToken, platform, allowlist: registry.host, classPlatform, instance
    }));
    closers.push(() => runner.close());
    const runnerProxy = await step('starting the code runner\'s proxy', () => startRecordingProxy(runner.url));
    closers.push(() => runnerProxy.close());

    const adapter = await step('starting the External Adapter', () => startAdapter({
      logDir,
      aiNodeUrl: aiProxy.url,
      runnerUrl: runnerProxy.url,
      runnerToken,
      ipfsUrl: ipfs.url,
      pinKey: PIN_KEY,
      devKey: listing.builderPublicKey,
      operator: OPERATOR
    }));
    closers.push(() => adapter.close());

    const providerCalls = () => readCallLog(callLog);
    const secondAdapter = (name, env, options = {}) => startAdapter({
      logDir, aiNodeUrl: aiProxy.url, runnerUrl: runnerProxy.url, runnerToken, ipfsUrl: ipfs.url, pinKey: PIN_KEY, devKey: listing.builderPublicKey, operator: OPERATOR, name, env, ...options
    });
    const faultEnv = (rpcUrl) => ({
      VERDIKTA_CANARY_FAULTS: F.faultPlan(set),
      VERDIKTA_CANARY_FAULT_KEY: canaryFaultKey,
      VERDIKTA_CANARY_RPC_URL: rpcUrl,
      NETWORK_CHAIN_ID: '84532',
      DEPLOYMENT_NETWORK: 'base_sepolia'
    });
    let armed = null;
    return {
      classPlatform,
      platform,
      operator: OPERATOR,
      justifier: JUSTIFIER,
      hangingJuror: HANGING_JUROR,
      juryAverage: [...JURY_AVERAGE],
      panel: codeReview.CODE_STANDARD_PANEL.AI_NODES.map((n) => ({ provider: n.AI_PROVIDER, model: n.AI_MODEL })),
      ipfs,
      registry,
      image,
      ai: aiProxy,
      aiDirect: aiNode.url,
      runner: runnerProxy,
      claims: { listingCid, listing: listing.buffer, ...set.claims, textCid },
      /** A second adapter on the same services, with the fault switch armed against a stand-in Base Sepolia RPC. Started on first use. */
      armedAdapter: async () => {
        if (!armed) {
          const chain = await startCanaryChain();
          closers.push(() => chain.close());
          const adapter = await secondAdapter('external-adapter-armed', faultEnv(chain.url));
          closers.push(() => adapter.close());
          armed = { chain, url: adapter.url, health: adapter.health };
        }
        return armed;
      },
      /** An adapter with the same flag set, on Base mainnet. It is only asked what it says of itself. */
      mainnetAdapter: async () => {
        const adapter = await secondAdapter('external-adapter-mainnet', { ...faultEnv('http://127.0.0.1:9'), NETWORK_CHAIN_ID: '8453', DEPLOYMENT_NETWORK: 'base_mainnet' }, { mustServe: false });
        closers.push(() => adapter.close());
        return adapter;
      },
      evaluateAt: async (url, cid, { aggId, jobId, timeoutMs = 300000 }) => {
        const { data } = await axios.post(`${url}/evaluate`, { id: jobId, data: { cid, aggId } }, { timeout: timeoutMs });
        return data;
      },
      providerCalls,
      counts: () => ({
        aiCalls: aiProxy.post('/api/rank-and-justify').length,
        providerCalls: providerCalls().length,
        runnerCalls: runnerProxy.post('/v1/runs').length
      }),
      evaluate: async (cid, { aggId = crypto.randomBytes(8).toString('hex'), timeoutMs = 700000, anyStatus = false } = {}) => {
        const { data } = await axios.post(`${adapter.url}/evaluate`, { id: `e2e-${crypto.randomBytes(4).toString('hex')}`, data: { cid, aggId } }, { timeout: timeoutMs, ...(anyStatus ? { validateStatus: () => true } : {}) });
        return data;
      },
      serviceTails: () => {
        const brief = (c) => ({ path: c.path, status: c.status, error: c.error, outcome: c.response && c.response.outcome, abstain: c.response && c.response.abstain, errorCode: c.response && c.response.errorCode, steps: c.response && c.response.steps && c.response.steps.filter((s) => s.exitCode !== 0).slice(-3) });
        return {
          adapter: adapter.tail(),
          runner: runner.tail(),
          aiNode: aiNode.tail(),
          'recent runner calls': JSON.stringify(runnerProxy.post('/v1/runs').slice(-3).map(brief), null, 1),
          'recent AI Node calls': JSON.stringify(aiProxy.post('/api/rank-and-justify').slice(-3).map(brief), null, 1)
        };
      },
      close
    };
  } catch (err) {
    await close();
    throw err;
  }
}

module.exports = { startClaimHarness, JUSTIFIER, HANGING_JUROR };
