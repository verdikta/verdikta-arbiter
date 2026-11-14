// Node A6c, decision D9: the canary fault switch on the External Adapter. The review focus
// is that it can never be on outside class 5555, so there is one test per way it could be:
// each environment that must leave it off or refused, and each measurement that must refuse.
// The chain is a stand-in that counts calls, so "nothing was asked" is shown, not assumed.

const { ethers } = require('ethers');
const {
  CANARY_CLASS_ID, CANARY_CHAIN_ID, CANARY_AGGREGATOR, FAULTS, directiveMac,
  canaryFaultConfigFromEnv, describeCanaryFault, faultForRequest
} = require('../../canaryFault');
const { jobIdBytes32 } = require('../../canaryFault/measure');
const { JUSTIFIER_RESERVE_MS, JUROR_FLOOR_MS } = require('../../codeReview/time');
const {
  startCanaryChain, requestInput, AGGREGATOR, OPERATOR, JOB_ID, JOB_EXTERNAL_ID, JOB_BYTES32, AGG_ID
} = require('../../../test/helpers/canaryChain');

const CLAIM = `Qm${'C'.repeat(44)}`;
const OTHER_CLAIM = `Qm${'D'.repeat(44)}`;
const KEY = 'k'.repeat(48);
const silent = { info() {}, warn() {}, error() {}, debug() {} };

let chain;

const armedEnv = (over = {}) => ({
  VERDIKTA_CANARY_FAULTS: `${CLAIM}=near-limit-juror`,
  VERDIKTA_CANARY_FAULT_KEY: KEY,
  VERDIKTA_CANARY_RPC_URL: chain.url,
  NETWORK_CHAIN_ID: '84532',
  DEPLOYMENT_NETWORK: 'base_sepolia',
  OPERATOR_ADDR: OPERATOR,
  ...over
});

const ask = (env, request = {}) => faultForRequest(
  { bcid: CLAIM, aggId: AGG_ID, jobId: JOB_ID, ...request },
  { config: canaryFaultConfigFromEnv(env), logger: silent, runTag: '[test]' }
);

beforeEach(async () => { chain = await startCanaryChain(); });
afterEach(async () => { await chain.close(); });

describe('the constants are the code\'s, not the configuration\'s', () => {
  it('names class 5555 and the Base Sepolia aggregator', () => {
    expect(CANARY_CLASS_ID).toBe(5555);
    expect(CANARY_CHAIN_ID).toBe(84532);
    expect(CANARY_AGGREGATOR).toBe(AGGREGATOR);
    expect(Object.keys(FAULTS).sort()).toEqual(['cancellation', 'near-limit-juror', 'provider-timeout', 'slow-justifier']);
  });
});

describe('off by default', () => {
  it.each([
    ['nothing set', {}],
    ['a blank flag', { VERDIKTA_CANARY_FAULTS: '' }],
    ['a flag of spaces', { VERDIKTA_CANARY_FAULTS: '   ' }],
    ['the key and the RPC URL set, and no flag', { VERDIKTA_CANARY_FAULTS: undefined }]
  ])('%s: off, no chain read, no directive', async (_name, over) => {
    const env = over.VERDIKTA_CANARY_FAULTS === undefined && Object.keys(over).length ? armedEnv({ VERDIKTA_CANARY_FAULTS: undefined }) : { ...over };
    const config = canaryFaultConfigFromEnv(env);
    expect(config.state).toBe('off');
    expect(describeCanaryFault(config)).toMatchObject({ state: 'off', problems: [] });
    await expect(ask(env)).resolves.toBeNull();
    expect(chain.calls).toEqual([]);
  });

  it('another name for the flag does nothing: names are exact', async () => {
    const env = armedEnv({ VERDIKTA_CANARY_FAULTS: undefined, verdikta_canary_faults: `${CLAIM}=near-limit-juror`, NEXT_PUBLIC_VERDIKTA_CANARY_FAULTS: `${CLAIM}=near-limit-juror`, VERDIKTA_CANARY_FAULT: `${CLAIM}=near-limit-juror` });
    expect(canaryFaultConfigFromEnv(env).state).toBe('off');
    await expect(ask(env)).resolves.toBeNull();
    expect(chain.calls).toEqual([]);
  });
});

describe('refused by configuration: the flag is set, and nothing is read or sent', () => {
  it.each([
    ['base mainnet by chain id', { NETWORK_CHAIN_ID: '8453' }, /84532/],
    ['base mainnet by chain id, named Sepolia', { NETWORK_CHAIN_ID: '8453', DEPLOYMENT_NETWORK: 'base_sepolia' }, /84532/],
    ['base mainnet by name, chain id Sepolia', { DEPLOYMENT_NETWORK: 'base_mainnet' }, /mainnet/],
    ['no chain id: an unknown chain counts as mainnet', { NETWORK_CHAIN_ID: undefined }, /NETWORK_CHAIN_ID/],
    ['a blank chain id', { NETWORK_CHAIN_ID: ' ' }, /NETWORK_CHAIN_ID/],
    ['a local chain', { NETWORK_CHAIN_ID: '31337' }, /84532/],
    ['a chain id that is not one', { NETWORK_CHAIN_ID: '84532abc' }, /NETWORK_CHAIN_ID/],
    ['a hex chain id', { NETWORK_CHAIN_ID: '0x14a34' }, /NETWORK_CHAIN_ID/],
    ['no key', { VERDIKTA_CANARY_FAULT_KEY: undefined }, /KEY/],
    ['a short key', { VERDIKTA_CANARY_FAULT_KEY: 'short' }, /KEY/],
    ['a key with a space', { VERDIKTA_CANARY_FAULT_KEY: `${KEY} x` }, /KEY/],
    ['no RPC URL', { VERDIKTA_CANARY_RPC_URL: undefined }, /RPC/],
    ['an RPC URL that is not http(s)', { VERDIKTA_CANARY_RPC_URL: 'file:///etc/passwd' }, /RPC/],
    ['an RPC URL that is not a URL', { VERDIKTA_CANARY_RPC_URL: 'sepolia' }, /RPC/],
    ['no operator', { OPERATOR_ADDR: undefined }, /OPERATOR_ADDR/],
    ['an operator that is not an address', { OPERATOR_ADDR: '0x1234' }, /OPERATOR_ADDR/],
    ['a plan that is not a plan', { VERDIKTA_CANARY_FAULTS: 'on' }, /VERDIKTA_CANARY_FAULTS/],
    ['the flag set to true', { VERDIKTA_CANARY_FAULTS: 'true' }, /VERDIKTA_CANARY_FAULTS/],
    ['an unknown fault', { VERDIKTA_CANARY_FAULTS: `${CLAIM}=drop-the-score` }, /VERDIKTA_CANARY_FAULTS/],
    ['a wildcard claim', { VERDIKTA_CANARY_FAULTS: '*=near-limit-juror' }, /VERDIKTA_CANARY_FAULTS/],
    ['a claim that is not a CID', { VERDIKTA_CANARY_FAULTS: 'all=near-limit-juror' }, /VERDIKTA_CANARY_FAULTS/],
    ['a claim named twice', { VERDIKTA_CANARY_FAULTS: `${CLAIM}=near-limit-juror,${CLAIM}=slow-justifier` }, /VERDIKTA_CANARY_FAULTS/],
    ['one bad entry beside a good one', { VERDIKTA_CANARY_FAULTS: `${CLAIM}=near-limit-juror,nope` }, /VERDIKTA_CANARY_FAULTS/],
    ['a trailing comma', { VERDIKTA_CANARY_FAULTS: `${CLAIM}=near-limit-juror,` }, /VERDIKTA_CANARY_FAULTS/]
  ])('%s', async (_name, over, why) => {
    const env = armedEnv(over);
    Object.keys(env).forEach((k) => env[k] === undefined && delete env[k]);
    const config = canaryFaultConfigFromEnv(env);
    expect(config.state).toBe('refused');
    expect(describeCanaryFault(config).problems.join(' ')).toMatch(why);
    await expect(ask(env)).resolves.toBeNull();
    expect(chain.calls).toEqual([]);
  });

  it('a problem names no key and no URL', () => {
    const env = armedEnv({ NETWORK_CHAIN_ID: '8453' });
    const shown = JSON.stringify(describeCanaryFault(canaryFaultConfigFromEnv(env)));
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain(chain.url);
  });
});

describe('armed: what a node with the flag does on a claim the flag does not name', () => {
  it('nothing at all: no chain read, so a real claim on an armed canary is not even looked up', async () => {
    const env = armedEnv();
    expect(canaryFaultConfigFromEnv(env).state).toBe('armed');
    await expect(ask(env, { bcid: OTHER_CLAIM })).resolves.toBeNull();
    expect(chain.calls).toEqual([]);
  });
});

describe('a request for 5555, measured: the two cases the design decided', () => {
  it('a node serving 5555 and 128: a request for 5555 gets the fault', async () => {
    chain.state.classes = [128, 5555];
    chain.state.requestedClass = 5555;
    const fault = await ask(armedEnv());
    expect(fault).toMatchObject({ fault: 'near-limit-juror', refused: null });
    expect(fault.directiveFor(1, { bcid: CLAIM, reportSha256: 'a'.repeat(64) })).not.toBeNull();
  });

  it('the same node: a request for 128 is untouched', async () => {
    chain.state.classes = [128, 5555];
    chain.state.requestedClass = 128;
    const fault = await ask(armedEnv());
    expect(fault.refused).toMatch(/REQUEST_CLASS/);
    expect(fault.directiveFor(1, { bcid: CLAIM, reportSha256: 'a'.repeat(64) })).toBeNull();
  });

  it('a provider-timeout refused for 128 shortens nothing either', async () => {
    chain.state.classes = [128, 5555];
    chain.state.requestedClass = 128;
    const fault = await ask(armedEnv({ VERDIKTA_CANARY_FAULTS: `${CLAIM}=provider-timeout` }));
    expect(fault.refused).toMatch(/REQUEST_CLASS/);
    expect(fault.deadlineFor(1)).toBeNull();
  });
});

describe('refused by measurement: the claim is judged normally, with no directive', () => {
  const R = (code) => new RegExp(code);
  const transfer = new ethers.utils.Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [OPERATOR, 1]);
  const logOtherAddress = () => [{ address: OPERATOR, topics: ['0x00', AGG_ID], data: '0x', blockNumber: '0x10', blockHash: `0x${'1'.repeat(64)}`, transactionHash: chain.txHash, transactionIndex: '0x0', logIndex: '0x0', removed: false }];
  const oneLog = () => ({ address: AGGREGATOR, topics: ['0x00', AGG_ID], data: '0x', blockNumber: '0x10', blockHash: `0x${'1'.repeat(64)}`, transactionHash: chain.txHash, transactionIndex: '0x0', logIndex: '0x0', removed: false });

  it.each([
    ['class 128', () => { chain.state.requestedClass = 128; }, 'REQUEST_CLASS'],
    ['class 0', () => { chain.state.requestedClass = 0; }, 'REQUEST_CLASS'],
    ['class 133, the code class itself', () => { chain.state.requestedClass = 133; }, 'REQUEST_CLASS'],
    ['class 55550', () => { chain.state.requestedClass = 55550; }, 'REQUEST_CLASS'],
    ['an identity in 128 alone', () => { chain.state.classes = [128]; }, 'IDENTITY'],
    ['an identity the keeper does not know', () => { chain.state.classes = []; }, 'IDENTITY'],
    ['the RPC is Base mainnet, whatever the config says', () => { chain.state.chainId = 8453; }, 'CHAIN'],
    ['the RPC is another chain', () => { chain.state.chainId = 1; }, 'CHAIN'],
    ['no such request on the chain', () => { chain.state.logs = []; }, 'REQUEST_NOT_FOUND'],
    ['two logs for one id', () => { chain.state.logs = [oneLog(), oneLog()]; }, 'REQUEST_NOT_FOUND'],
    ['a log from another contract', () => { chain.state.logs = logOtherAddress(); }, 'REQUEST_NOT_FOUND'],
    ['the transaction is gone', () => { chain.state.tx = null; }, 'REQUEST_TX'],
    ['a request sent through a contract: its class cannot be read', () => { chain.state.tx = { hash: chain.txHash, to: OPERATOR, input: requestInput(5555) }; }, 'REQUEST_NOT_DIRECT'],
    ['a contract creation', () => { chain.state.tx = { hash: chain.txHash, to: null, input: requestInput(5555) }; }, 'REQUEST_NOT_DIRECT'],
    ['another function on the aggregator', () => { chain.state.tx = { hash: chain.txHash, to: AGGREGATOR, input: transfer }; }, 'REQUEST_CALLDATA'],
    ['calldata cut short', () => { chain.state.tx = { hash: chain.txHash, to: AGGREGATOR, input: requestInput(5555).slice(0, 80) }; }, 'REQUEST_CALLDATA'],
    ['no calldata', () => { chain.state.tx = { hash: chain.txHash, to: AGGREGATOR, input: '0x' }; }, 'REQUEST_CALLDATA'],
    ['a keeper address that does not parse', () => { chain.state.keeperResult = '0x1234'; }, 'RPC_FAILED'],
    ['eth_chainId fails', () => { chain.state.fail = { eth_chainId: 'rpcError' }; }, 'RPC_FAILED'],
    ['eth_chainId answers HTTP 500', () => { chain.state.fail = { eth_chainId: 'http500' }; }, 'RPC_FAILED'],
    ['eth_chainId answers something else', () => { chain.state.fail = { eth_chainId: 'garbage' }; }, 'RPC_FAILED'],
    ['eth_getLogs fails', () => { chain.state.fail = { eth_getLogs: 'rpcError' }; }, 'RPC_FAILED'],
    ['eth_getTransactionByHash fails', () => { chain.state.fail = { eth_getTransactionByHash: 'rpcError' }; }, 'RPC_FAILED'],
    ['the keeper read fails', () => { chain.state.fail = { eth_call: 'rpcError' }; }, 'RPC_FAILED']
  ])('%s', async (_name, arrange, code) => {
    arrange();
    const fault = await ask(armedEnv());
    expect(fault.fault).toBe('near-limit-juror');
    expect(fault.refused).toMatch(R(code));
    expect(fault.directiveFor(1, { bcid: CLAIM, reportSha256: 'a'.repeat(64) })).toBeNull();
  });

  it.each([
    ['no aggId', { aggId: '' }, 'AGG_ID'],
    ['undefined aggId', { aggId: undefined }, 'AGG_ID'],
    ['a short aggId', { aggId: '0xabc' }, 'AGG_ID'],
    ['an aggId that is not hex', { aggId: `0x${'z'.repeat(64)}` }, 'AGG_ID'],
    ['no job id', { jobId: undefined }, 'JOB_ID'],
    ['a job id that is not one', { jobId: 'e2e-1234' }, 'JOB_ID'],
    ['0x and nothing', { jobId: '0x' }, 'JOB_ID'],
    ['0x and 31 digits', { jobId: JOB_ID.slice(0, -1) }, 'JOB_ID'],
    ['0x and 33 digits', { jobId: `${JOB_ID}0` }, 'JOB_ID'],
    ['0x and a bytes32: the key, not the job id', { jobId: JOB_BYTES32 }, 'JOB_ID'],
    ['0x and the UUID with dashes', { jobId: `0x${JOB_EXTERNAL_ID}` }, 'JOB_ID'],
    ['0x and something that is not hex', { jobId: `0x${'g'.repeat(32)}` }, 'JOB_ID'],
    ['0x twice', { jobId: `0x${JOB_ID}`.slice(0, 34) }, 'JOB_ID']
  ])('%s, before any read', async (_name, request, code) => {
    const fault = await ask(armedEnv(), request);
    expect(fault.refused).toMatch(R(code));
    expect(chain.calls).toEqual([]);
  });

  it('an RPC that never answers: refused within its budget, and the claim goes on', async () => {
    chain.state.fail = { '*': 'hang' };
    const started = Date.now();
    const fault = await ask(armedEnv());
    expect(fault.refused).toMatch(/RPC_FAILED/);
    expect(Date.now() - started).toBeLessThan(20000);
  }, 30000);

  it('an aggId in capitals or without 0x reads the same request', async () => {
    const fault = await ask(armedEnv(), { aggId: AGG_ID.slice(2).toUpperCase() });
    expect(fault.refused).toBeNull();
  });
});

// The canary run of issue #126 refused every request with JOB_ID_UNREADABLE: the bridge sends the
// job id as Chainlink 2.23.0 renders it, 0x and 32 hex digits, and the switch read only the UUID.
describe('the job id as the bridge sends it, and the key it was registered under', () => {
  it('Chainlink 2.23.0\'s form, 0x and the 32 digits, is the key registration wrote', () => {
    expect(JOB_ID).toMatch(/^0x[0-9a-f]{32}$/);
    expect(jobIdBytes32(JOB_ID)).toBe(JOB_BYTES32);
    // register-oracle-cl.js's toBytes32 of JOB_ID_<n>_NO_HYPHENS: the 32 characters as UTF-8, no padding.
    expect(JOB_BYTES32).toBe('0x3338663139353732633531303431626161356632646561323834363134353930');
  });

  it.each([
    ['0x, as Chainlink sends it', JOB_ID],
    ['0X and capitals', `0X${JOB_ID.slice(2).toUpperCase()}`],
    ['surrounding space', ` ${JOB_ID}\n`],
    ['the UUID with dashes', JOB_EXTERNAL_ID],
    ['the 32 digits alone, as installer/.contracts holds them', JOB_EXTERNAL_ID.replace(/-/g, '')]
  ])('%s: the same key', (_name, jobId) => {
    expect(jobIdBytes32(jobId)).toBe(JOB_BYTES32);
  });

  it('a request with the job id as Chainlink sends it is measured, and acted on', async () => {
    const fault = await ask(armedEnv(), { jobId: JOB_ID });
    expect(fault.refused).toBeNull();
    expect(chain.calls).toContain('eth_call');
    expect(fault.directiveFor(1, { bcid: CLAIM, reportSha256: 'a'.repeat(64) })).toMatchObject({ action: 'hold-juror-answer' });
  });

  it('another job of the same operator, registered on no class: the keeper lists nothing for it', async () => {
    const fault = await ask(armedEnv(), { jobId: '0x39515f75ac2947beb7f2eeae4d8eaf3e' });
    expect(fault.refused).toMatch(/IDENTITY_NOT_IN_CLASS/);
  });
});

describe('the plan: what each fault asks of each attempt', () => {
  const report = 'b'.repeat(64);
  const directive = async (name, attempt) => {
    const fault = await ask(armedEnv({ VERDIKTA_CANARY_FAULTS: `${CLAIM}=${name}` }));
    expect(fault.refused).toBeNull();
    return fault.directiveFor(attempt, { bcid: CLAIM, reportSha256: report });
  };

  it.each([
    ['near-limit-juror', 'hold-juror-answer', 'hold-juror-answer'],
    ['provider-timeout', 'late-juror', null],
    ['slow-justifier', 'hold-justifier-answer', 'hold-justifier-answer'],
    ['cancellation', 'late-juror', 'late-juror']
  ])('%s: attempt 1 %s, attempt 2 %s', async (name, first, second) => {
    const one = await directive(name, 1);
    expect(one.action).toBe(first);
    expect(one.mac).toBe(directiveMac(KEY, first, CLAIM, report));
    const two = await directive(name, 2);
    if (second === null) expect(two).toBeNull();
    else expect(two.action).toBe(second);
  });

  it.each([
    ['near-limit-juror', null],
    ['provider-timeout', JUSTIFIER_RESERVE_MS + JUROR_FLOOR_MS],
    ['slow-justifier', null],
    ['cancellation', null]
  ])('%s: attempt 1 is told at most %s ms (null: what is left), every later attempt what is left', async (name, first) => {
    const fault = await ask(armedEnv({ VERDIKTA_CANARY_FAULTS: `${CLAIM}=${name}` }));
    expect(fault.deadlineFor(1)).toBe(first);
    expect(fault.deadlineFor(2)).toBeNull();
  });

  it('provider-timeout\'s first attempt has the least jury the adapter ever calls: the justifier\'s reserve and the 60 s juror floor, 105 s', () => {
    expect(FAULTS['provider-timeout'].firstAttemptDeadlineMs).toBe(105000);
    expect(FAULTS['provider-timeout'].firstAttemptDeadlineMs).toBe(JUSTIFIER_RESERVE_MS + JUROR_FLOOR_MS);
    for (const [name, fault] of Object.entries(FAULTS)) {
      if (name !== 'provider-timeout') expect(fault.firstAttemptDeadlineMs).toBeNull();
    }
  });

  it('a directive holds an action and a MAC and nothing else: no key, no value', async () => {
    const one = await directive('near-limit-juror', 1);
    expect(Object.keys(one).sort()).toEqual(['action', 'mac']);
    expect(JSON.stringify(one)).not.toContain(KEY);
  });

  it('the MAC is bound to the action, the claim and the report', () => {
    const base = directiveMac(KEY, 'late-juror', CLAIM, report);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(directiveMac(KEY, 'hold-juror-answer', CLAIM, report)).not.toBe(base);
    expect(directiveMac(KEY, 'late-juror', OTHER_CLAIM, report)).not.toBe(base);
    expect(directiveMac(KEY, 'late-juror', CLAIM, 'c'.repeat(64))).not.toBe(base);
    expect(directiveMac(`${KEY}x`, 'late-juror', CLAIM, report)).not.toBe(base);
  });

  it('the shared vector: the AI Node\'s test holds the same value (ai-node/src/__tests__/lib/code-review/canary-fault.test.ts)', () => {
    expect(directiveMac('k'.repeat(32), 'late-juror', 'QmVector', 'd'.repeat(64)))
      .toBe('fc348eff335597039bd6199da408b303e74090ef9a140030648314dd1b893b41');
  });
});

describe('what /health says', () => {
  it('armed: how many claims are named, and what the requests did', async () => {
    const config = canaryFaultConfigFromEnv(armedEnv());
    expect(describeCanaryFault(config)).toMatchObject({ state: 'armed', namedClaims: 1, applied: 0, refused: 0, lastRefusal: null });
    await faultForRequest({ bcid: CLAIM, aggId: AGG_ID, jobId: JOB_ID }, { config, logger: silent, runTag: '' });
    expect(describeCanaryFault(config)).toMatchObject({ applied: 1, refused: 0 });
    chain.state.requestedClass = 128;
    await faultForRequest({ bcid: CLAIM, aggId: AGG_ID, jobId: JOB_ID }, { config, logger: silent, runTag: '' });
    expect(describeCanaryFault(config)).toMatchObject({ applied: 1, refused: 1 });
    expect(describeCanaryFault(config).lastRefusal).toMatch(/REQUEST_CLASS/);
  });
});
