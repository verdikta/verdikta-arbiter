// installer/util/job-template.cjs and the operator description it rests on
// (check-request-authorization.cjs, describe). No chain and no Chainlink node: the node here
// is a fake that parses each spec it is sent with Python's tomllib, a TOML reader this
// repository did not write, so "what the tool expects is what a node would hold" is checked
// against an independent decoder. The real 2.23.0 binary: job-timeouts.integration.sh.
// Run: node --test installer/tests/job-template.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const jt = require('../util/job-template.cjs');
const { describeOperator, UnusableLegacyOperator, jobIdWord } = require('../util/check-request-authorization.cjs');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '../../chainlink-node/basicJobSpec'), 'utf8');
const TOKEN = 'T0ken_'.repeat(8);
const OPERATOR = '0x1111111111111111111111111111111111111111';
const NEW_OPERATOR = '0x9999999999999999999999999999999999999999';
const KEEPER = '0x2222222222222222222222222222222222222222';
const AGGREGATOR = '0x3333333333333333333333333333333333333333';
const hasTomllib = spawnSync('python3', ['-c', 'import tomllib']).status === 0;
const tomllib = text => JSON.parse(execFileSync('python3', ['-c',
  'import tomllib,sys,json; print(json.dumps(tomllib.loads(sys.stdin.read())))'], { input: text, encoding: 'utf8' }));
const params = (mode, operator = OPERATOR) => ({ operator, chainId: 84532, token: TOKEN, mode, keeper: KEEPER });

/* ── The template ─────────────────────────────────────────────────────────── */

test('the DAG the tool expects is the DAG a TOML parser reads from the rendered template', { skip: !hasTomllib }, () => {
  const rendered = TEMPLATE.replaceAll('{CONTRACT_ADDRESS}', OPERATOR).replaceAll('<CHAIN_ID>', '84532').replaceAll('{EA_API_TOKEN}', TOKEN)
    .replaceAll('{JOB_NAME}', 'Verdikta AI Arbiter 1').replaceAll('{FROM_ADDRESS}', OPERATOR);
  const parsed = tomllib(rendered);
  const expected = jt.expectedJob(TEMPLATE, params('v1'));
  assert.equal(expected.dag, parsed.observationSource);
  assert.equal(expected.maxTaskDuration, parsed.maxTaskDuration);
});

test('the decoder follows TOML: first newline, line-ending backslash, escapes; an unknown escape is refused', { skip: !hasTomllib }, () => {
  for (const raw of ['\na \\\n   b\\"c\\\\d\\t\\u00e9\n', 'x\\\n\n\n  y', '\r\nline\\n', 'tab\\tend \\\n', '""\\"']) {
    assert.equal(jt.decodeBasicMultiline(raw), tomllib(`v = """${raw}"""`).v, JSON.stringify(raw));
  }
  assert.throws(() => jt.decodeBasicMultiline('bad \\q'), /escape/);
});

test('the legacy gate changes the three authorization lines and nothing else', () => {
  const v1 = jt.expectedJob(TEMPLATE, params('v1')).dag.split('\n');
  const legacy = jt.expectedJob(TEMPLATE, params('legacy')).dag.split('\n');
  assert.equal(v1.length - legacy.length, 0);
  const changed = v1.map((line, i) => [line, legacy[i]]).filter(([a, b]) => a !== b);
  assert.equal(changed.length, 4);
  assert.match(changed[0][1], /abi="isContractApproved\(address contractAddress\)"/);
  assert.equal(changed[1][1].trim(), 'data="{\\"contractAddress\\": $(decode_log.requester)}"]');
  for (const [, line] of changed.slice(2)) assert.match(line, new RegExp(`(?:re)?authorize_call \\[type="ethcall" contract="${KEEPER}" data="\\$\\(authorize_data\\)"`));
  // The job still sends its transaction to the operator, and still reads the gate's result.
  const dag = legacy.join('\n');
  assert.match(dag, new RegExp(`to="${OPERATOR}"`));
  assert.equal((dag.match(/abi="bool allowed"/g) || []).length, 2);
  assert.match(dag, /decode_log -> authorize_data -> authorize_call -> authorize_result -> authorize -> decode_cbor -> fetch/);
  assert.match(dag, /encode_tx -> reauthorize_call -> reauthorize_result -> reauthorize -> submit_tx/);
});

test('the legacy gate refuses a template whose authorization tasks moved, and a missing keeper', () => {
  assert.throws(() => jt.legacyGate(TEMPLATE, ''), /ReputationKeeper/);
  assert.throws(() => jt.legacyGate(TEMPLATE.replace('authorize_data [type="ethabiencode"', 'authorize_data [type="ethabiencode" x="1"'), KEEPER), /not where/);
  assert.throws(() => jt.legacyGate(TEMPLATE.replace('reauthorize_call [type="ethcall" contract=', 'reauthorize_call [type="ethcall" block="latest" contract='), KEEPER), /not where/);
});

test('a rendered job spec gated by the `gate` command is the job the tool expects', { skip: !hasTomllib }, () => {
  // configure-node.sh: its seds, then `gate`, then the credential.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-gate-'));
  try {
    const file = path.join(dir, 'job.toml');
    fs.writeFileSync(file, TEMPLATE.replaceAll('{JOB_NAME}', 'Verdikta AI Arbiter 1').replaceAll('{FROM_ADDRESS}', OPERATOR)
      .replaceAll('{CONTRACT_ADDRESS}', OPERATOR).replaceAll('<CHAIN_ID>', '84532'));
    const run = spawnSync('node', [path.join(__dirname, '../util/job-template.cjs'), 'gate', file, '--keeper', KEEPER], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const parsed = tomllib(fs.readFileSync(file, 'utf8').replaceAll('{EA_API_TOKEN}', TOKEN));
    assert.equal(parsed.observationSource, jt.expectedJob(TEMPLATE, params('legacy')).dag);
    assert.equal(parsed.contractAddress, OPERATOR);
    assert.equal(spawnSync('node', [path.join(__dirname, '../util/job-template.cjs'), 'gate', file, '--keeper', 'nope']).status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a job is not rendered without a valid credential, operator or mode, or with a placeholder left', () => {
  assert.throws(() => jt.expectedJob(TEMPLATE, { ...params('v1'), token: 'short' }), jt.Refusal);
  assert.throws(() => jt.expectedJob(TEMPLATE, { ...params('v1'), operator: 'x' }), /operator/);
  assert.throws(() => jt.expectedJob(TEMPLATE, { ...params('v1'), mode: 'open' }), /mode/);
  assert.throws(() => jt.expectedJob(TEMPLATE.replace('name="verdikta-ai"', 'name="{BRIDGE_NAME}"'), params('v1')), /placeholder/);
  assert.throws(() => jt.expectedJob(TEMPLATE.replace('{EA_API_TOKEN}', 'none'), params('v1')), /authentication/);
});

/* ── Which operator ───────────────────────────────────────────────────────── */

const word = value => BigInt(value).toString(16).padStart(64, '0');
const TRUE = `0x${word(1)}`, FALSE = `0x${word(0)}`;
const SELECTOR = { version: '0xcc515b9a', request: '0x9d9fca07', listEmpty: '0x1d2566a8', keeperOf: '0xcb09ef31', approved: '0x070d39d9', info: '0x95e1c539' };
const JOB = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
const revert = { error: { code: 3, message: 'execution reverted' } };
const oracleInfo = ({ active = 0, stake = 0, blocked = 0 } = {}) => `0x${[active, 0, 0, 0, 0, 0, stake, 0, blocked].map(word).join('')}`;

/* A chain as a fetch: `contracts` maps a lower-case address to { selector: answer | fn(data) }. */
function chain(contracts, { chainId = 84532, seen = [] } = {}) {
  return async (url, init) => {
    assert.equal(init.redirect, 'error');
    const request = JSON.parse(init.body);
    seen.push(request);
    let reply;
    if (request.method === 'eth_chainId') reply = { result: `0x${chainId.toString(16)}` };
    else if (request.method === 'eth_getCode') reply = { result: contracts[request.params[0].toLowerCase()] ? '0x6080' : '0x' };
    else {
      assert.equal(request.method, 'eth_call'); assert.equal(request.params[1], 'latest');
      const contract = contracts[request.params[0].to.toLowerCase()] || {};
      const data = request.params[0].data;
      const answer = contract[data.slice(0, 10)];
      const value = typeof answer === 'function' ? answer(data) : answer;
      reply = value === undefined ? revert : typeof value === 'string' ? { result: value } : value;
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, ...reply }) };
  };
}
const v1Operator = { [SELECTOR.version]: TRUE, [SELECTOR.request]: FALSE, [SELECTOR.listEmpty]: TRUE };
const legacyOperator = { [SELECTOR.listEmpty]: TRUE };
const keeper = (extra = {}) => ({
  [SELECTOR.approved]: data => data.slice(34).toLowerCase() === AGGREGATOR.slice(2) ? TRUE : FALSE,
  [SELECTOR.info]: data => data.endsWith(jobIdWord(JOB)) ? oracleInfo({ active: 1, stake: 100 }) : oracleInfo(),
  ...extra,
});
const aggregator = { [SELECTOR.keeperOf]: `0x${'0'.repeat(24)}${KEEPER.slice(2)}` };
const legacyChain = (overrides = {}) => ({ [OPERATOR]: legacyOperator, [KEEPER]: keeper(), [AGGREGATOR]: aggregator, ...overrides });
const describe = (contracts, extra = {}) => describeOperator({ operator: OPERATOR, chainId: 84532, rpcUrls: 'https://rpc.invalid/SECRET',
  aggregator: AGGREGATOR, jobIds: [JOB], fetchImpl: chain(contracts), ...extra });

test('describe: a v1 operator needs no keeper, aggregator or job', async () => {
  assert.deepEqual(await describe({ [OPERATOR]: v1Operator }, { aggregator: undefined, jobIds: [] }), { mode: 'v1' });
});

test('describe: a legacy operator is described with the keeper its registrations are on', async () => {
  assert.deepEqual(await describe(legacyChain()), { mode: 'legacy', keeper: KEEPER, aggregator: AGGREGATOR });
  // A hyphenated id, a paused job (stake only) and a blocked one are registrations too.
  const hyphenated = `${JOB.slice(0, 8)}-${JOB.slice(8, 12)}-${JOB.slice(12, 16)}-${JOB.slice(16, 20)}-${JOB.slice(20)}`;
  assert.equal((await describe(legacyChain(), { jobIds: ['0'.repeat(32), hyphenated] })).mode, 'legacy');
  for (const info of [oracleInfo({ stake: 100 }), oracleInfo({ blocked: 1 })]) {
    assert.equal((await describe(legacyChain({ [KEEPER]: keeper({ [SELECTOR.info]: info }) }))).mode, 'legacy');
  }
});

test('describe: a legacy operator without a believable keeper is refused, with the reason', async () => {
  const cases = [
    [legacyChain(), { aggregator: undefined }, /names no aggregator/],
    [legacyChain({ [AGGREGATOR]: {} }), {}, /names no ReputationKeeper/],
    [legacyChain({ [AGGREGATOR]: { [SELECTOR.keeperOf]: `0x${'0'.repeat(64)}` } }), {}, /names no ReputationKeeper/],
    // A retired aggregator: its keeper no longer approves it.
    [legacyChain({ [KEEPER]: keeper({ [SELECTOR.approved]: FALSE }) }), {}, /does not approve/],
    // A keeper this node is not registered on is not taken for the one whose requests it answers.
    [legacyChain({ [KEEPER]: keeper({ [SELECTOR.info]: oracleInfo() }) }), {}, /holds no registration/],
    [legacyChain(), { jobIds: [] }, /holds no registration/],
  ];
  for (const [contracts, extra, reason] of cases) {
    await assert.rejects(() => describe(contracts, extra), error => {
      assert.ok(error instanceof UnusableLegacyOperator, error.message); assert.match(error.message, reason); return true;
    });
  }
  // Told to skip the registration check (a node whose jobs are deregistered for the moment).
  assert.equal((await describe(legacyChain({ [KEEPER]: keeper({ [SELECTOR.info]: oracleInfo() }) }), { allowUnregistered: true })).mode, 'legacy');
  // The owner of a node registered nowhere says so; the keeper must still approve the aggregator.
  const context = { operator: OPERATOR, chainId: 84532, rpcUrls: 'https://rpc.invalid', aggregator: AGGREGATOR, jobIds: [JOB] };
  const unregistered = chain(legacyChain({ [KEEPER]: keeper({ [SELECTOR.info]: oracleInfo() }) }));
  await assert.rejects(() => jt.operatorMode(context, { fetchImpl: unregistered }), /VERDIKTA_LEGACY_UNREGISTERED=1/);
  process.env.VERDIKTA_LEGACY_UNREGISTERED = '1';
  try {
    assert.deepEqual(await jt.operatorMode(context, { fetchImpl: unregistered }), { mode: 'legacy', keeper: KEEPER, aggregator: AGGREGATOR });
    await assert.rejects(() => jt.operatorMode(context, { fetchImpl: chain(legacyChain({ [KEEPER]: keeper({ [SELECTOR.approved]: FALSE }) })) }), /does not approve/);
  } finally { delete process.env.VERDIKTA_LEGACY_UNREGISTERED; }
});

test('describe: an RPC that fails, rate-limits or lies is never read as a legacy operator', async () => {
  const rateLimited = { error: { code: -32005, message: 'rate limit exceeded SECRET' } };
  const cases = [
    { [OPERATOR]: { ...legacyOperator, [SELECTOR.version]: rateLimited } },          // the version read did not revert
    { [OPERATOR]: { [SELECTOR.version]: FALSE, [SELECTOR.listEmpty]: TRUE } },        // answers, with another version
    { [OPERATOR]: {} },                                                               // reverts everything: not an ArbiterOperator
    { [OPERATOR]: { [SELECTOR.listEmpty]: `0x${word(2)}` } },                         // not a boolean
    { [OPERATOR]: { [SELECTOR.version]: TRUE, [SELECTOR.request]: TRUE } },           // a permissive fallback
    {},                                                                               // no code
  ];
  for (const contracts of cases) {
    await assert.rejects(() => describe({ [KEEPER]: keeper(), [AGGREGATOR]: aggregator, ...contracts }), error => {
      assert.ok(!(error instanceof UnusableLegacyOperator)); assert.match(error.message, /Cannot tell which operator/);
      assert.doesNotMatch(error.message, /SECRET/); return true;
    });
  }
  await assert.rejects(() => describeOperator({ operator: OPERATOR, chainId: 84532, rpcUrls: 'https://rpc.invalid/SECRET',
    fetchImpl: async () => { throw new Error('https://rpc.invalid/SECRET'); } }), /Cannot tell which operator/);
  await assert.rejects(() => describeOperator({ operator: OPERATOR, chainId: 84532, rpcUrls: 'https://rpc.invalid',
    fetchImpl: chain(legacyChain(), { chainId: 8453 }) }), /Cannot tell which operator/);
  // A keeper read that fails on one endpoint is asked again on the next.
  let first = true;
  const flaky = async (url, init) => {
    if (url.includes('bad')) { if (JSON.parse(init.body).method === 'eth_call' && first) { first = false; } return { ok: false }; }
    return chain(legacyChain())(url, init);
  };
  assert.equal((await describeOperator({ operator: OPERATOR, chainId: 84532, rpcUrls: 'https://bad.invalid;https://good.invalid',
    aggregator: AGGREGATOR, jobIds: [JOB], fetchImpl: flaky })).mode, 'legacy');
});

/* ── The node ─────────────────────────────────────────────────────────────── */

/* A Chainlink node's job API, as far as the tool uses it. A spec it is sent is parsed with
 * tomllib, as the node parses it; `faults` makes one call misbehave. */
function fakeNode(jobs, faults = {}) {
  const state = { jobs: jobs.map(job => JSON.parse(JSON.stringify(job))), calls: [], nextId: 100 };
  const fromToml = (toml, id) => {
    const spec = tomllib(toml);
    assert.equal(spec.type, 'directrequest');
    return { id: String(id), type: 'jobs', attributes: {
      name: spec.name, type: spec.type, schemaVersion: spec.schemaVersion, externalJobID: spec.externalJobID,
      maxTaskDuration: spec.maxTaskDuration, gasLimit: null, forwardingAllowed: false,
      directRequestSpec: { contractAddress: spec.contractAddress, evmChainID: spec.evmChainID, minIncomingConfirmations: null,
        minContractPaymentLinkJuels: null, requesters: spec.requesters || null },
      pipelineSpec: { dotDagSource: spec.observationSource } } };
  };
  const respond = (status, body, cookie) => ({ status, text: async () => JSON.stringify(body),
    headers: { getSetCookie: () => (cookie ? [cookie] : []) } });
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname, method = init.method;
    state.calls.push(`${method} ${route}`);
    if (faults.down) throw new Error('connect ECONNREFUSED');
    if (route === '/sessions') return faults.login ? respond(faults.login, {}) : respond(200, {}, 'clsession=abc; Path=/; HttpOnly');
    assert.equal(init.headers.Cookie, 'clsession=abc', 'every call after the login carries the session');
    if (method === 'GET' && route === '/v2/jobs') return respond(200, { data: state.jobs });
    const body = JSON.parse(init.body);
    if (method === 'PUT') {
      const id = route.split('/').pop(), at = state.jobs.findIndex(job => job.id === id);
      const fault = faults.put && faults.put(state, id, body.toml);
      if (fault) return fault(respond);
      if (at < 0) return respond(404, {});
      state.jobs[at] = fromToml(body.toml, state.nextId++);
      return respond(200, { data: state.jobs[at] });
    }
    if (method === 'POST' && route === '/v2/jobs') {
      if (faults.post) return respond(faults.post, {});
      const job = fromToml(body.toml, state.nextId++); state.jobs.push(job);
      return respond(200, { data: job });
    }
    return respond(404, {});
  };
  return { state, fetchImpl, fromToml };
}

const external = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}`;
function liveJob(n, dag, { operator = OPERATOR, duration = '840s' } = {}) {
  return { id: String(n), type: 'jobs', attributes: { name: `Verdikta AI Arbiter ${n}`, type: 'directrequest', schemaVersion: 1,
    externalJobID: external(n), maxTaskDuration: duration, gasLimit: null, forwardingAllowed: false,
    directRequestSpec: { contractAddress: operator, evmChainID: '84532', minIncomingConfirmations: null, minContractPaymentLinkJuels: null, requesters: null },
    pipelineSpec: { dotDagSource: dag } } };
}
const V1 = jt.expectedJob(TEMPLATE, params('v1')).dag;
const LEGACY = jt.expectedJob(TEMPLATE, params('legacy')).dag;
// A job from before service authentication and request authorization: no header, no gate.
const OLD = V1.split('\n').filter(line => !/headers=|authorize_|^\s*abi="isAuthorizedRequest|^\s*data="\{\\"requestId/.test(line)).join('\n')
  .replace('decode_log -> authorize_data -> authorize_call -> authorize_result -> authorize -> decode_cbor', 'decode_log -> decode_cbor')
  .replace('encode_tx -> reauthorize_call -> reauthorize_result -> reauthorize -> submit_tx', 'encode_tx -> submit_tx');
const other = { id: '50', type: 'jobs', attributes: { name: 'someone else\'s cron', type: 'cron', externalJobID: external(5), pipelineSpec: { dotDagSource: 'a [type="http"]' } } };

function harness(jobs, { mode = { mode: 'legacy', keeper: KEEPER }, operator = OPERATOR, faults, token = TOKEN } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-template-'));
  const api = path.join(dir, '.api');
  fs.writeFileSync(api, 'operator@example.invalid\nnode-password\n');
  const node = fakeNode(jobs, faults);
  const lines = [];
  const options = { node: new jt.Node({ fetchImpl: node.fetchImpl, url: 'http://node.invalid:6688' }), templateText: TEMPLATE, wait: 0,
    context: { dir, operator, network: 'base_sepolia', chainId: 84532, rpcUrls: '', aggregator: AGGREGATOR, jobIds: [], token } };
  const env = { VERDIKTA_CHAINLINK_API_FILE: api, VERDIKTA_OPERATOR_MODE_JSON: mode ? JSON.stringify(mode) : '' };
  const withEnv = async fn => {
    const before = {};
    for (const [key, value] of Object.entries(env)) { before[key] = process.env[key]; if (value) process.env[key] = value; else delete process.env[key]; }
    try { return await fn(); } finally {
      for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  };
  return { dir, node, lines, options,
    check: extra => withEnv(() => jt.check({ ...options, ...extra }, line => lines.push(line))),
    apply: extra => withEnv(() => jt.apply({ ...options, ...extra }, line => lines.push(line))),
    out: () => lines.join('\n'), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const dags = h => h.node.state.jobs.filter(jt.isArbiterJob).map(job => job.attributes.pipelineSpec.dotDagSource);

test('a legacy operator\'s old jobs are replaced under their own ids by jobs that ask the keeper', { skip: !hasTomllib }, async () => {
  const h = harness([liveJob(1, OLD, { duration: '300s' }), other, liveJob(2, OLD)]);
  try {
    assert.equal(await h.check(), 1);
    assert.match(h.out(), /stale: Verdikta AI Arbiter 1 \(11111111-1111-1111-1111-111111111111\): its bridge task sends no service credential; maxTaskDuration is 300s, wanted 840s/);
    assert.match(h.out(), /2 of 2 job\(s\) are not this release's .*asks the ReputationKeeper 0x2222/);
    assert.equal(await h.apply(), 0);
    assert.deepEqual(dags(h), [LEGACY, LEGACY]);
    const arbiters = h.node.state.jobs.filter(jt.isArbiterJob);
    assert.deepEqual(arbiters.map(job => job.attributes.externalJobID), [external(1), external(2)]);
    assert.deepEqual(arbiters.map(job => job.attributes.name), ['Verdikta AI Arbiter 1', 'Verdikta AI Arbiter 2']);
    assert.deepEqual(arbiters.map(job => job.attributes.directRequestSpec.contractAddress), [OPERATOR, OPERATOR]);
    assert.deepEqual(arbiters.map(job => job.attributes.maxTaskDuration), ['840s', '840s']);
    // Someone else's job is not looked at.
    assert.deepEqual(h.node.state.jobs.find(job => job.id === '50'), other);
    assert.equal(h.node.state.calls.filter(call => call.startsWith('PUT')).length, 2);
    assert.equal(await h.check(), 0);
    assert.equal(await h.apply(), 0);
    assert.match(h.out(), /Nothing to replace: 2 Verdikta job\(s\)/);
    // The old specs are kept, private; the credential is in no line the tool printed.
    const saved = path.join(h.dir, 'chainlink-node', 'jobs', 'replaced');
    const files = fs.readdirSync(saved);
    assert.equal(files.length, 2);
    for (const file of files) {
      assert.equal(fs.statSync(path.join(saved, file)).mode & 0o777, 0o600);
      assert.equal(tomllib(fs.readFileSync(path.join(saved, file), 'utf8')).observationSource, OLD);
    }
    assert.doesNotMatch(h.out(), new RegExp(TOKEN));
    assert.doesNotMatch(h.out(), /ethabiencode|observationSource/);
  } finally { h.done(); }
});

test('a v1 operator\'s jobs are the template; an ungated or differently gated job is stale', { skip: !hasTomllib }, async () => {
  const noGate = V1.replace('decode_log -> authorize_data -> authorize_call -> authorize_result -> authorize -> decode_cbor', 'decode_log -> decode_cbor');
  const h = harness([liveJob(1, V1), liveJob(2, LEGACY), liveJob(3, noGate), liveJob(4, V1.replace(OPERATOR, OPERATOR.toUpperCase().replace('0X', '0x')))], { mode: { mode: 'v1' } });
  try {
    assert.equal(await h.check(), 1);
    const out = h.out();
    assert.doesNotMatch(out, /Arbiter 1 /);
    assert.match(out, /Arbiter 2 .*tasks differ from this release's template/);
    assert.match(out, /Arbiter 3 .*tasks differ/);
    assert.doesNotMatch(out, /Arbiter 4 /, 'an address in another case is the same address');
    assert.match(out, /2 of 4 job\(s\) are not this release's \(the operator contract checks each requester itself/);
    assert.equal(await h.apply(), 0);
    assert.deepEqual(dags(h).map(dag => jt.sameDag(dag, V1)), [true, true, true, true]);
    assert.equal(h.node.state.calls.filter(call => call.startsWith('PUT')).length, 2);
  } finally { h.done(); }
});

test('a rotated credential makes every job stale, and none of it is printed', { skip: !hasTomllib }, async () => {
  const h = harness([liveJob(1, LEGACY)], { token: 'N3w-credential_'.repeat(3) });
  try {
    assert.equal(await h.check(), 1);
    assert.equal(await h.apply(), 0);
    assert.match(dags(h)[0], /Bearer N3w-credential_/);
    assert.doesNotMatch(h.out(), /N3w-credential_|T0ken_/);
  } finally { h.done(); }
});

test('a job on another contract is moved only by the migration', { skip: !hasTomllib }, async () => {
  const h = harness([liveJob(1, LEGACY), liveJob(2, LEGACY)], { mode: { mode: 'v1' }, operator: NEW_OPERATOR });
  try {
    assert.equal(await h.check(), 1);
    assert.match(h.out(), new RegExp(`it listens on ${OPERATOR}, and installer/.contracts names ${NEW_OPERATOR}`));
    assert.equal(await h.apply(), 1);
    assert.match(h.out(), /Nothing was changed: a job is moved to another operator contract only by the operator migration/);
    assert.equal(h.node.state.calls.filter(call => call.startsWith('PUT')).length, 0);
    assert.equal(await h.apply({ moveToOperator: true }), 0);
    const arbiters = h.node.state.jobs.filter(jt.isArbiterJob);
    assert.deepEqual(arbiters.map(job => job.attributes.directRequestSpec.contractAddress), [NEW_OPERATOR, NEW_OPERATOR]);
    assert.deepEqual(arbiters.map(job => job.attributes.externalJobID), [external(1), external(2)]);
    const wanted = jt.expectedJob(TEMPLATE, params('v1', NEW_OPERATOR)).dag;
    assert.deepEqual(dags(h), [wanted, wanted]);
    assert.doesNotMatch(wanted, new RegExp(OPERATOR.slice(2)));
    assert.equal(await h.check(), 0);
  } finally { h.done(); }
});

test('a refused replacement leaves the job as it was and stops', { skip: !hasTomllib }, async () => {
  const h = harness([liveJob(1, OLD), liveJob(2, OLD)], { faults: { put: () => respond => respond(422, { errors: [{ detail: 'invalid' }] }) } });
  try {
    assert.equal(await h.apply(), 1);
    assert.match(h.out(), /Verdikta AI Arbiter 1 .*the node answered HTTP 422/);
    assert.match(h.out(), /unchanged on the node\. Nothing else was tried/);
    assert.deepEqual(dags(h), [OLD, OLD]);
    assert.equal(h.node.state.calls.filter(call => call.startsWith('PUT')).length, 1);
  } finally { h.done(); }
});

test('a job the node changed on the way is put back; one it lost is named with its saved spec', { skip: !hasTomllib }, async () => {
  // The node takes the spec and holds something else (here: without the bridge header).
  const mangle = (state, id, toml) => respond => {
    const at = state.jobs.findIndex(job => job.id === id);
    const job = fakeNode([]).fromToml(toml, 900);
    job.attributes.pipelineSpec.dotDagSource += '\n// changed';
    state.jobs[at] = job;
    return respond(200, { data: job });
  };
  let h = harness([liveJob(1, OLD)], { faults: { put: (state, id, toml) => (id === '1' ? mangle(state, id, toml) : null) } });
  try {
    assert.equal(await h.apply(), 1);
    assert.match(h.out(), /the tasks came back changed/);
    assert.match(h.out(), /the old job is back, under the same id/);
    assert.deepEqual(dags(h), [OLD]);
    assert.equal(h.node.state.jobs[0].attributes.externalJobID, external(1));
  } finally { h.done(); }
  // The node deletes the job and fails; the restore fails too.
  const lose = (state, id) => respond => { state.jobs = state.jobs.filter(job => job.id !== id); return respond(500, {}); };
  h = harness([liveJob(1, OLD)], { faults: { put: (state, id) => lose(state, id), post: 500 } });
  try {
    assert.equal(await h.apply(), 3);
    assert.match(h.out(), /COULD NOT RESTORE Verdikta AI Arbiter 1 \(11111111-1111-1111-1111-111111111111\)/);
    const named = /Its old spec is (\S+\.toml):/.exec(h.out());
    assert.ok(named && fs.existsSync(named[1]));
    assert.equal(tomllib(fs.readFileSync(named[1], 'utf8')).externalJobID, external(1));
  } finally { h.done(); }
  // Lost, and the restore works: POSTed back under the same external id.
  h = harness([liveJob(1, OLD)], { faults: { put: (state, id) => lose(state, id) } });
  try {
    assert.equal(await h.apply(), 1);
    assert.deepEqual(dags(h), [OLD]);
    assert.equal(h.node.state.jobs[0].attributes.externalJobID, external(1));
  } finally { h.done(); }
});

test('nothing is tried when the node, the login, the credential or the operator cannot be read', { skip: !hasTomllib }, async () => {
  for (const [options, reason] of [
    [{ faults: { down: true } }, /did not answer/],
    [{ faults: { login: 401 } }, /refused the login/],
    [{ token: '' }, /Service authentication is not configured/],
    [{ mode: { mode: 'legacy' } }, /does not describe an operator/],
    [{ mode: null }, /Cannot tell which operator|An HTTP RPC endpoint is required/],
  ]) {
    const h = harness([liveJob(1, OLD)], options);
    try {
      assert.equal(await h.check(), 2, String(reason));
      assert.equal(await h.apply(), 2, String(reason));
      assert.match(h.out(), reason);
      assert.match(h.out(), /Nothing was changed/);
      assert.equal(h.node.state.calls.filter(call => call.startsWith('PUT') || call === 'POST /v2/jobs').length, 0);
    } finally { h.done(); }
  }
  const empty = harness([other]);
  try {
    assert.equal(await empty.check(), 0);
    assert.match(empty.out(), /no Verdikta job yet/);
    assert.equal(await empty.apply(), 0);
  } finally { empty.done(); }
});

/* ── The install ──────────────────────────────────────────────────────────── */

test('the install\'s own files say which operator, chain, aggregator, jobs and credential', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-template-install-'));
  try {
    fs.mkdirSync(path.join(dir, 'installer')); fs.mkdirSync(path.join(dir, 'external-adapter'));
    fs.writeFileSync(path.join(dir, 'installer', '.contracts'), [`OPERATOR_ADDR="${OPERATOR}"`, 'JOB_ID_1="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"',
      `JOB_ID_1_NO_HYPHENS="${JOB}"`, `JOB_ID_2_NO_HYPHENS="${'f'.repeat(32)}"`, `JOB_ID_NO_HYPHENS="${JOB}"`, `AGGREGATOR_ADDRESS="${AGGREGATOR}"`, ''].join('\n'));
    fs.writeFileSync(path.join(dir, 'installer', '.env'), 'DEPLOYMENT_NETWORK="base_mainnet"\nBASE_MAINNET_RPC_HTTP_URLS="https://a.invalid;https://b.invalid"\nBASE_SEPOLIA_RPC_URL=https://no.invalid\n');
    fs.writeFileSync(path.join(dir, 'external-adapter', '.env'), `PORT=8080\nEA_API_TOKEN=${TOKEN}\n`);
    const context = jt.installContext(dir);
    assert.deepEqual({ ...context, dir: null }, { dir: null, operator: OPERATOR, network: 'base_mainnet', chainId: 8453,
      rpcUrls: 'https://a.invalid;https://b.invalid', aggregator: AGGREGATOR, jobIds: [JOB, 'f'.repeat(32)], token: TOKEN });
    fs.writeFileSync(path.join(dir, 'installer', '.contracts'), 'JOB_ID="x"\n');
    assert.throws(() => jt.installContext(dir), jt.Refusal);
    // `mode` prints the description alone on stdout, and a refusal on stderr with exit 2.
    const run = spawnSync('node', [path.join(__dirname, '../util/job-template.cjs'), 'mode', '--install-dir', dir], { encoding: 'utf8' });
    assert.equal(run.status, 2); assert.equal(run.stdout, ''); assert.match(run.stderr, /names no operator contract/);
    assert.equal(spawnSync('node', [path.join(__dirname, '../util/job-template.cjs'), 'frobnicate']).status, 64);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the upgrade copies the tool and what it requires to the install root', () => {
  const upgrade = fs.readFileSync(path.join(__dirname, '../bin/upgrade-arbiter.sh'), 'utf8');
  const loop = upgrade.slice(upgrade.indexOf('for _util in \\'), upgrade.indexOf('cp "$UTIL_DIR/$_util" "$TARGET_DIR/$_util"'));
  assert.match(loop, /^\s+job-template\.cjs \\$/m);
  assert.match(loop, /^\s+check-request-authorization\.cjs \\$/m);
  // …and it requires nothing else of this repository.
  const tool = fs.readFileSync(path.join(__dirname, '../util/job-template.cjs'), 'utf8');
  assert.deepEqual([...tool.matchAll(/require\('(\.[^']+)'\)/g)].map(match => match[1]), ['./check-request-authorization.cjs']);
});
