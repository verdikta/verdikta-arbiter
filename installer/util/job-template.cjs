#!/usr/bin/env node
'use strict';

/* Verdikta Arbiter - this release's job template on a live node, with the job ids kept
 *
 * A Chainlink job keeps the tasks it was created with: a template change in a checkout
 * reaches no running node. Until 2026-11 the upgrade answered a changed template by
 * deleting every job and creating new ones. New jobs have new ids, each id is a separate
 * registration on the ReputationKeeper, and so a template change cost a deregistration, a
 * re-registration and every job's reputation. This tool replaces each stale job with
 * PUT /v2/jobs/:id instead (Chainlink validates the spec before it deletes the old job).
 * The job keeps its externalJobID, which is what an OracleRequest's specId and the
 * keeper's registration name: nothing happens on chain and no stake moves.
 *
 * What a job must look like depends on the operator contract it listens on
 * (check-request-authorization.cjs, describe):
 *
 *   v1      the contract refuses an unapproved requester itself. The job is the template as
 *           it is: it asks the operator's isAuthorizedRequest before the bridge and before
 *           the transaction.
 *   legacy  a contract from before request authorization. It emits OracleRequest for
 *           anyone, so the job asks the ReputationKeeper isContractApproved(requester)
 *           at the same two places. The requester in the event is the address the LINK
 *           token saw (Operator overwrites the caller's own claim), so an unapproved
 *           sender's run stops before the adapter is called.
 *
 * Usage (from the install directory, or with --install-dir):
 *   job-template.cjs check [--wait SEC]   0 every job is this release's (or no Verdikta job)
 *                                         1 a job is stale; each is named, never its tasks
 *                                         2 could not measure
 *   job-template.cjs apply [--wait SEC] [--move-to-operator]
 *                                         0 replaced and verified (or nothing to do)
 *                                         1 failed, every job as it was or already replaced
 *                                         2 could not reach the node or tell the operator
 *                                         3 failed and a job could not be restored: the
 *                                           output names it and its saved spec
 *           --move-to-operator: also repoint jobs that listen on another contract than
 *           installer/.contracts names (the operator migration; never by default).
 *   job-template.cjs mode                 the operator's description, as JSON
 *   job-template.cjs gate FILE --keeper A put the legacy gate into a rendered job spec
 *
 * A job's tasks hold the adapter's bearer credential, so no task text is ever printed and
 * saved specs are 0600. Credentials for the node are read from ~/.chainlink-(network)/.api
 * (or VERDIKTA_CHAINLINK_API_FILE). VERDIKTA_CHAINLINK_URL overrides http://localhost:6688,
 * VERDIKTA_JOB_BACKUP_DIR where each old spec is saved, VERDIKTA_OPERATOR_MODE_JSON the
 * operator's description (the upgrade passes what it read before it stopped the node).
 * VERDIKTA_LEGACY_UNREGISTERED=1: a legacy operator's node that is registered with no
 * dispatcher, so that its aggregator's keeper is taken without a registration to show.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeOperator, UnusableLegacyOperator } = require('./check-request-authorization.cjs');

const BRIDGE = 'verdikta-ai';
const ARBITER_NAME = 'Verdikta AI Arbiter';
const isAddress = value => /^0x[0-9a-fA-F]{40}$/.test(value || '') && !/^0x0{40}$/.test(value);
const validToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(token);

class Refusal extends Error {}       // exit 2: nothing was tried
class NodeError extends Error {}     // the Chainlink node did not answer as needed

/* ── The template ───────────────────────────────────────────────────────────── */

/* The value of a TOML basic multi-line string ("""…"""), from the text between the
 * delimiters: the first newline is trimmed, a backslash at a line's end removes the newline
 * and the whitespace after it, and the escapes are decoded. The hosts run Python 3.8 (no
 * tomllib); job-template.test.cjs holds this to tomllib on the checked-in template. */
function decodeBasicMultiline(raw) {
  let text = raw;
  if (text.startsWith('\r\n')) text = text.slice(2);
  else if (text.startsWith('\n')) text = text.slice(1);
  const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '\\') { out += c; continue; }
    const lineEnd = /^[ \t]*\r?\n[ \t\r\n]*/.exec(text.slice(i + 1));
    if (lineEnd) { i += lineEnd[0].length; continue; }
    const next = text[i + 1];
    if (next in simple) { out += simple[next]; i += 1; continue; }
    const digits = next === 'u' ? 4 : next === 'U' ? 8 : 0;
    const hex = text.slice(i + 2, i + 2 + digits);
    if (!digits || !new RegExp(`^[0-9a-fA-F]{${digits}}$`).test(hex)) throw new Error('The job template holds an escape TOML does not define.');
    out += String.fromCodePoint(parseInt(hex, 16));
    i += 1 + digits;
  }
  return out;
}

/* { maxTaskDuration, rawDag }: the raw text between observationSource's delimiters. */
function readTemplate(text) {
  const duration = /^maxTaskDuration\s*=\s*"([^"]*)"/m.exec(text);
  const open = /^observationSource\s*=\s*"""/m.exec(text);
  if (!duration || !open) throw new Error('The job template has no maxTaskDuration or no observationSource.');
  const start = open.index + open[0].length;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text.startsWith('"""', i)) { end = i; break; }
  }
  if (end < 0) throw new Error('The job template\'s observationSource is not closed.');
  return { maxTaskDuration: duration[1], rawDag: text.slice(start, end) };
}

/* The legacy gate, in a template or a rendered spec: the two reads ask the ReputationKeeper
 * whether the event's requester is an approved contract, where the template asks the
 * operator about the request. Each anchor must be found exactly as often as the template
 * has it, or the template changed and this must be looked at again. */
function legacyGate(text, keeper) {
  if (!isAddress(keeper)) throw new Error('The legacy gate needs the ReputationKeeper\'s address.');
  // The data value runs to the `"]` that ends its line: its quotes are escaped twice (TOML, then DOT).
  const data = /(authorize_data\s*\[type="ethabiencode"\s*abi=")[^"]*("\s*data=")[^\n]*("\]\n)/g;
  const calls = /((?:re)?authorize_call\s*\[type="ethcall"\s+contract=")[^"]*(")/g;
  if ((text.match(data) || []).length !== 1 || (text.match(calls) || []).length !== 2) {
    throw new Error('The job template\'s authorization tasks are not where the legacy gate expects them.');
  }
  return text
    .replace(data, (_all, head, middle, tail) => `${head}isContractApproved(address contractAddress)${middle}{\\\\"contractAddress\\\\": $(decode_log.requester)}${tail}`)
    .replace(calls, (_all, head, tail) => `${head}${keeper}${tail}`);
}

/* The job this release wants on `operator`: its DAG as the node will hold it. */
function expectedJob(templateText, { operator, chainId, token, mode, keeper }) {
  if (!isAddress(operator)) throw new Error('A job needs its operator contract\'s address.');
  if (!/^[0-9]+$/.test(String(chainId))) throw new Error('A job needs its chain id.');
  if (!validToken(token)) throw new Refusal('Service authentication is not configured (EA_API_TOKEN in external-adapter/.env): run the upgrade, or installer/util/configure-service-auth.cjs configure <install dir>.');
  if (!['v1', 'legacy'].includes(mode)) throw new Error('Unknown operator mode.');
  let text = mode === 'legacy' ? legacyGate(templateText, keeper) : templateText;
  if (!text.includes('{EA_API_TOKEN}')) throw new Error('The job template is missing authentication.');
  text = text.replaceAll('{CONTRACT_ADDRESS}', operator).replaceAll('<CHAIN_ID>', String(chainId)).replaceAll('{EA_API_TOKEN}', token);
  const { maxTaskDuration, rawDag } = readTemplate(text);
  const dag = decodeBasicMultiline(rawDag);
  if (/\{[A-Z_]+\}|<[A-Z_]+>/.test(dag)) throw new Error('The job template holds a placeholder this tool does not fill.');
  return { dag, maxTaskDuration };
}

/* ── The install ────────────────────────────────────────────────────────────── */

function envValues(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function installContext(dir) {
  const contracts = envValues(path.join(dir, 'installer', '.contracts'));
  const env = envValues(path.join(dir, 'installer', '.env'));
  const operator = contracts.OPERATOR_ADDR || contracts.OPERATOR_ADDRESS;
  if (!isAddress(operator)) throw new Refusal(`${path.join(dir, 'installer', '.contracts')} names no operator contract (OPERATOR_ADDR). Give the install directory with --install-dir.`);
  const network = contracts.DEPLOYMENT_NETWORK || env.DEPLOYMENT_NETWORK;
  const chainId = { base_mainnet: 8453, base_sepolia: 84532 }[network];
  if (!chainId) throw new Refusal('installer/.env names no supported DEPLOYMENT_NETWORK.');
  const prefix = network === 'base_mainnet' ? 'BASE_MAINNET' : 'BASE_SEPOLIA';
  const rpcUrls = process.env.REQUEST_AUTH_RPC_URLS || env[`${prefix}_RPC_HTTP_URLS`] || env[`${prefix}_RPC_URL`] || '';
  const jobIds = Object.keys(contracts).filter(key => /^JOB_ID(_\d+)?_NO_HYPHENS$/.test(key)).map(key => contracts[key]).filter(Boolean);
  const token = envValues(path.join(dir, 'external-adapter', '.env')).EA_API_TOKEN;
  return { dir, operator, network, chainId, rpcUrls, aggregator: contracts.AGGREGATOR_ADDRESS, jobIds: [...new Set(jobIds)], token };
}

async function operatorMode(context, { jobIds = context.jobIds, fetchImpl } = {}) {
  const given = process.env.VERDIKTA_OPERATOR_MODE_JSON;
  if (given) {
    let mode;
    try { mode = JSON.parse(given); } catch { throw new Refusal('VERDIKTA_OPERATOR_MODE_JSON is not JSON.'); }
    if (mode.mode === 'v1' || (mode.mode === 'legacy' && isAddress(mode.keeper))) return mode;
    throw new Refusal('VERDIKTA_OPERATOR_MODE_JSON does not describe an operator.');
  }
  try {
    // A legacy node registered nowhere has no registration to show for its keeper; its owner
    // says so (the check exists for a node whose AGGREGATOR_ADDRESS is stale, which is registered).
    return await describeOperator({ operator: context.operator, chainId: context.chainId, rpcUrls: context.rpcUrls,
      aggregator: context.aggregator, jobIds, allowUnregistered: process.env.VERDIKTA_LEGACY_UNREGISTERED === '1',
      ...(fetchImpl ? { fetchImpl } : {}) });
  } catch (error) {
    throw new Refusal(error.message + (error instanceof UnusableLegacyOperator ? ' The jobs were left as they are.' : ''));
  }
}

const modeText = mode => mode.mode === 'v1'
  ? 'the operator contract checks each requester itself (request authorization v1)'
  : `the operator contract predates request authorization, so each job asks the ReputationKeeper ${mode.keeper} about the requester`;

/* ── The node ───────────────────────────────────────────────────────────────── */

class Node {
  constructor({ fetchImpl = fetch, url = process.env.VERDIKTA_CHAINLINK_URL || 'http://localhost:6688' } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.cookie = '';
  }
  async call(method, route, body, timeoutMs = 30000) {
    let response;
    try {
      response = await this.fetch(this.url + route, {
        method, signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new NodeError(`the node at ${this.url} did not answer ${method} ${route.split('?')[0]}`);
    }
    const cookies = typeof response.headers?.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    if (cookies.length) this.cookie = cookies.map(cookie => cookie.split(';')[0]).join('; ');
    let parsed = {};
    try { const raw = await response.text(); parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
    return { code: response.status, body: parsed };
  }
  async login(waitSeconds = 0, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    let file = process.env.VERDIKTA_CHAINLINK_API_FILE;
    if (!file) {
      const home = os.homedir();
      let found = [];
      try { found = fs.readdirSync(home).filter(name => name.startsWith('.chainlink-')).sort().map(name => path.join(home, name, '.api')).filter(candidate => fs.existsSync(candidate)); } catch { found = []; }
      if (!found.length) throw new NodeError('no Chainlink API credentials (~/.chainlink-*/.api)');
      file = found[0];
    }
    let parts;
    try { parts = fs.readFileSync(file, 'utf8').split(/\s+/).filter(Boolean); } catch { throw new NodeError('cannot read the Chainlink API credentials'); }
    if (parts.length < 2) throw new NodeError('the Chainlink API credentials file does not hold an email and a password');
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      let problem;
      try {
        const { code } = await this.call('POST', '/sessions', { email: parts[0], password: parts[1] });
        if (code < 300) return;
        if (code === 401 || code === 403) throw new Refusal(`the node refused the login (HTTP ${code})`);
        problem = new NodeError(`the node answered the login with HTTP ${code}`);
      } catch (error) {
        if (error instanceof Refusal) throw new NodeError(error.message);
        problem = error;
      }
      if (Date.now() >= deadline) throw problem;
      await sleep(Math.min(2000, Math.max(100, deadline - Date.now())));
    }
  }
  async jobs() {
    const { code, body } = await this.call('GET', '/v2/jobs?size=1000');
    if (code >= 300 || !Array.isArray(body.data)) throw new NodeError(`the node answered GET /v2/jobs with HTTP ${code}`);
    return body.data;
  }
}

/* ── Jobs ───────────────────────────────────────────────────────────────────── */

const UNITS = { ns: 1e-9, us: 1e-6, 'µs': 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600 };
function goSeconds(text) {
  if (typeof text !== 'string') return null;
  if (text === '0') return 0;
  if (!/^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/.test(text)) return null;
  let total = 0;
  for (const [, number, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) total += parseFloat(number) * UNITS[unit];
  return total;
}

const attributes = job => job.attributes || {};
const dagOf = job => (attributes(job).pipelineSpec || {}).dotDagSource || '';
const specOf = job => attributes(job).directRequestSpec || {};
const lowerAddresses = text => text.replace(/0x[0-9a-fA-F]{40}/g, address => address.toLowerCase());
const sameDag = (a, b) => lowerAddresses(a) === lowerAddresses(b);
const sameAddress = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

function isArbiterJob(job) {
  const a = attributes(job);
  if (a.type !== 'directrequest') return false;
  return new RegExp(`name\\s*=\\s*"${BRIDGE}"`).test(dagOf(job)) || String(a.name || '').includes(ARBITER_NAME);
}

/* Why a live job is not this release's, in words that hold none of its tasks. */
function staleReasons(job, expected, operator) {
  const a = attributes(job), dag = dagOf(job), reasons = [];
  if (!sameAddress(specOf(job).contractAddress, operator)) reasons.push(`it listens on ${specOf(job).contractAddress}, and installer/.contracts names ${operator}`);
  if (!sameDag(dag, expected.dag)) {
    if (!/headers\s*=\s*"\[\\"Authorization\\"/.test(dag)) reasons.push('its bridge task sends no service credential');
    else if (!/authorize_call\s*\[/.test(dag)) reasons.push('it has no authorization gate before the bridge');
    else reasons.push('its tasks differ from this release\'s template');
  }
  if (goSeconds(a.maxTaskDuration) !== goSeconds(expected.maxTaskDuration)) reasons.push(`maxTaskDuration is ${a.maxTaskDuration}, wanted ${expected.maxTaskDuration}`);
  return reasons;
}

const tomlString = text => JSON.stringify(String(text));
// The DAG as a TOML basic multi-line string: a first newline would be trimmed, so one is added.
const tomlMultiline = text => `"""\n${text.replace(/\\/g, '\\\\').replace(/"""/g, '""\\"')}"""`;

function tomlFor(job, { contractAddress, maxTaskDuration, dag }) {
  const a = attributes(job), spec = specOf(job);
  const chain = spec.evmChainID ?? a.evmChainID;
  const lines = [
    'type = "directrequest"',
    `schemaVersion = ${parseInt(a.schemaVersion || 1, 10)}`,
    `name = ${tomlString(a.name || '')}`,
    `externalJobID = ${tomlString(a.externalJobID)}`,
    `contractAddress = ${tomlString(contractAddress)}`,
    `maxTaskDuration = ${tomlString(maxTaskDuration)}`,
  ];
  if (chain !== undefined && chain !== null) lines.push(`evmChainID = ${tomlString(chain)}`);
  if (spec.minIncomingConfirmations !== undefined && spec.minIncomingConfirmations !== null) lines.push(`minIncomingConfirmations = ${parseInt(spec.minIncomingConfirmations, 10)}`);
  if (spec.minContractPaymentLinkJuels !== undefined && spec.minContractPaymentLinkJuels !== null) lines.push(`minContractPaymentLinkJuels = ${tomlString(spec.minContractPaymentLinkJuels)}`);
  if (Array.isArray(spec.requesters) && spec.requesters.length) lines.push(`requesters = [${spec.requesters.map(tomlString).join(', ')}]`);
  if (a.gasLimit !== undefined && a.gasLimit !== null) lines.push(`gasLimit = ${parseInt(a.gasLimit, 10)}`);
  if (a.forwardingAllowed) lines.push('forwardingAllowed = true');
  lines.push(`observationSource = ${tomlMultiline(dag)}`);
  return `${lines.join('\n')}\n`;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/* Every field a replace must keep, against what the node holds now. */
function fieldDifferences(sent, got) {
  const a = attributes(sent), b = attributes(got), problems = [];
  for (const key of ['name', 'type', 'schemaVersion', 'externalJobID', 'gasLimit', 'forwardingAllowed']) {
    if (!same(a[key], b[key])) problems.push(`${key} came back changed`);
  }
  for (const key of ['minIncomingConfirmations', 'minContractPaymentLinkJuels', 'requesters', 'evmChainID']) {
    if (!same(specOf(sent)[key], specOf(got)[key])) problems.push(`directRequestSpec.${key} came back changed`);
  }
  return problems;
}

/* Why the job the node answered with is not the replacement that was sent, or null. */
function whatDiffers(job, got, target) {
  const problems = fieldDifferences(job, got);
  if (!sameAddress(specOf(got).contractAddress, target.contractAddress)) problems.push('contractAddress came back changed');
  if (dagOf(got) !== target.dag) problems.push('the tasks came back changed');
  if (goSeconds(attributes(got).maxTaskDuration) !== goSeconds(target.maxTaskDuration)) problems.push(`maxTaskDuration came back as ${attributes(got).maxTaskDuration}`);
  return problems.join('; ') || null;
}

const isOriginal = (job, got) => !fieldDifferences(job, got) .length
  && sameAddress(specOf(got).contractAddress, specOf(job).contractAddress)
  && dagOf(got) === dagOf(job)
  && goSeconds(attributes(got).maxTaskDuration) === goSeconds(attributes(job).maxTaskDuration);

const byExternal = (jobs, external) => jobs.find(job => attributes(job).externalJobID === external);

/* The live jobs against this release: [{ job, expected, reasons }]. */
async function measure({ node, context, templateText, wait, fetchImpl }) {
  await node.login(wait);
  const jobs = (await node.jobs()).filter(isArbiterJob);
  if (!jobs.length) return { jobs: [], mode: null };
  const live = jobs.map(job => String(attributes(job).externalJobID || '').replace(/-/g, '')).filter(id => /^[0-9a-f]{32}$/i.test(id));
  const mode = await operatorMode(context, { jobIds: [...new Set([...context.jobIds, ...live])], fetchImpl });
  const rows = jobs.map(job => {
    const chain = specOf(job).evmChainID ?? attributes(job).evmChainID ?? context.chainId;
    const expected = expectedJob(templateText, { operator: context.operator, chainId: chain, token: context.token, mode: mode.mode, keeper: mode.keeper });
    return { job, expected, reasons: staleReasons(job, expected, context.operator) };
  });
  return { jobs: rows, mode };
}

async function check(options, log = console.log) {
  let measured;
  try { measured = await measure(options); } catch (error) {
    if (!(error instanceof Refusal) && !(error instanceof NodeError)) throw error;
    log(`Could not measure the jobs: ${error.message}`);
    return 2;
  }
  if (!measured.jobs.length) { log('This node has no Verdikta job yet: nothing to measure.'); return 0; }
  const stale = measured.jobs.filter(row => row.reasons.length);
  for (const { job, reasons } of stale) log(`  stale: ${attributes(job).name} (${attributes(job).externalJobID}): ${reasons.join('; ')}`);
  if (stale.length) {
    log(`${stale.length} of ${measured.jobs.length} job(s) are not this release's (${modeText(measured.mode)}).`);
    return 1;
  }
  log(`All ${measured.jobs.length} job(s) are this release's: ${modeText(measured.mode)}.`);
  return 0;
}

function saveSpec(dir, job, stamp) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${attributes(job).externalJobID}.${stamp}.toml`);
  // 0600: a job's tasks carry the adapter's bearer credential in the bridge header.
  fs.writeFileSync(file, tomlFor(job, { contractAddress: specOf(job).contractAddress, maxTaskDuration: attributes(job).maxTaskDuration, dag: dagOf(job) }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

async function apply(options, log = console.log) {
  const { node, context, moveToOperator = false } = options;
  let measured;
  try { measured = await measure(options); } catch (error) {
    if (!(error instanceof Refusal) && !(error instanceof NodeError)) throw error;
    log(`Nothing was changed: ${error.message}`);
    return 2;
  }
  const stale = measured.jobs.filter(row => row.reasons.length);
  if (!stale.length) { log(`Nothing to replace: ${measured.jobs.length} Verdikta job(s), all this release's.`); return 0; }
  const elsewhere = stale.filter(({ job }) => !sameAddress(specOf(job).contractAddress, context.operator));
  if (elsewhere.length && !moveToOperator) {
    for (const { job } of elsewhere) log(`  ${attributes(job).name} (${attributes(job).externalJobID}) listens on ${specOf(job).contractAddress}, and installer/.contracts names ${context.operator}.`);
    log('Nothing was changed: a job is moved to another operator contract only by the operator migration (--move-to-operator).');
    return 1;
  }
  const saved = process.env.VERDIKTA_JOB_BACKUP_DIR || path.join(context.dir, 'chainlink-node', 'jobs', 'replaced');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
  const specs = new Map();
  try { for (const { job } of stale) specs.set(job.id, saveSpec(saved, job, stamp)); } catch (error) {
    log(`Could not save the old specs under ${saved}: ${error.code || 'error'}. Nothing was changed.`);
    return 1;
  }
  log(`Replacing ${stale.length} job(s) under their own ids (${modeText(measured.mode)}).`);
  for (const { job, expected } of stale) {
    const a = attributes(job), name = a.name, external = a.externalJobID;
    const target = { contractAddress: context.operator, maxTaskDuration: expected.maxTaskDuration, dag: expected.dag };
    const oldToml = tomlFor(job, { contractAddress: specOf(job).contractAddress, maxTaskDuration: a.maxTaskDuration, dag: dagOf(job) });
    let problem = null, answered = null;
    try {
      const { code, body } = await node.call('PUT', `/v2/jobs/${job.id}`, { toml: tomlFor(job, target) }, 60000);
      if (code >= 300) problem = `the node answered HTTP ${code}`;
      else { answered = body.data || {}; problem = whatDiffers(job, answered, target); }
    } catch (error) {
      if (!(error instanceof NodeError)) throw error;
      problem = error.message;
    }
    if (problem === null) { log(`  ${name} (${external}): replaced, same id.`); continue; }
    log(`  ${name} (${external}): ${problem}.`);
    // Where is the job now? PUT validates before it deletes, so a refusal leaves it as it
    // was; after that it may be gone, or there under what the node made of it.
    try {
      const current = await node.jobs();
      let row = byExternal(current, external);
      if (!row && answered && answered.id) row = current.find(candidate => candidate.id === answered.id);
      if (row) {
        if (isOriginal(job, row)) { log(`  ${name}: unchanged on the node. Nothing else was tried.`); return 1; }
        if (whatDiffers(job, row, target) === null) { log(`  ${name}: replaced after all, same id.`); continue; }
      }
      const { code } = row
        ? await node.call('PUT', `/v2/jobs/${row.id}`, { toml: oldToml }, 60000)
        : await node.call('POST', '/v2/jobs', { toml: oldToml }, 60000);
      if (code >= 300) throw new NodeError(`the node answered HTTP ${code}`);
      const back = byExternal(await node.jobs(), external);
      if (!back || !isOriginal(job, back)) throw new NodeError('the node does not show it back as it was');
    } catch (error) {
      if (!(error instanceof NodeError)) throw error;
      log(`COULD NOT RESTORE ${name} (${external}): ${error.message}. Its old spec is ${specs.get(job.id)}: POST it to the node, or the on-chain registration of that job id goes unanswered. Directory: ${saved}`);
      return 3;
    }
    log(`  ${name}: the old job is back, under the same id. Nothing else was tried.`);
    return 1;
  }
  log(`Replaced ${stale.length} job(s). The old specs are under ${saved} (they hold the adapter's credential: 0600).`);
  return 0;
}

/* ── Command line ───────────────────────────────────────────────────────────── */

function parse(argv) {
  const options = { command: argv[0], wait: 0, positional: [] };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--wait') options.wait = Number(argv[++i]);
    else if (arg === '--install-dir') options.installDir = argv[++i];
    else if (arg === '--template') options.template = argv[++i];
    else if (arg === '--keeper') options.keeper = argv[++i];
    else if (arg === '--move-to-operator') options.moveToOperator = true;
    else if (arg.startsWith('--')) throw new Refusal(`Unknown option ${arg}`);
    else options.positional.push(arg);
  }
  if (!Number.isFinite(options.wait) || options.wait < 0) throw new Refusal('--wait needs a number of seconds');
  return options;
}

function findInstall(given) {
  const candidates = given ? [given] : [__dirname, path.resolve(__dirname, '..', '..')];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'installer', '.contracts'))) return path.resolve(candidate);
  }
  throw new Refusal('No installer/.contracts beside this tool: give the install directory with --install-dir.');
}

async function main(argv) {
  const usage = 'usage: job-template.cjs check [--wait SEC] | apply [--wait SEC] [--move-to-operator] | mode | gate FILE --keeper ADDRESS   [--install-dir DIR] [--template FILE]';
  let options;
  try { options = parse(argv); } catch (error) { console.error(error.message); console.error(usage); return 64; }
  try {
    if (options.command === 'gate' && options.positional.length === 1) {
      const file = options.positional[0];
      const gated = legacyGate(fs.readFileSync(file, 'utf8'), options.keeper);
      fs.writeFileSync(file, gated, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      return 0;
    }
    if (!['check', 'apply', 'mode'].includes(options.command) || options.positional.length) { console.error(usage); return 64; }
    const context = installContext(findInstall(options.installDir));
    if (options.command === 'mode') {
      console.log(JSON.stringify(await operatorMode(context)));
      return 0;
    }
    const templateFile = options.template || path.join(context.dir, 'chainlink-node', 'basicJobSpec');
    let templateText;
    try { templateText = fs.readFileSync(templateFile, 'utf8'); } catch { throw new Refusal(`No job template at ${templateFile}.`); }
    const run = { node: new Node(), context, templateText, wait: options.wait, moveToOperator: options.moveToOperator };
    return options.command === 'check' ? await check(run) : await apply(run);
  } catch (error) {
    // On stderr: `mode` is read by scripts, and its answer alone is on stdout.
    if (error instanceof Refusal || error instanceof NodeError) { console.error(`Nothing was changed: ${error.message}`); return 2; }
    console.error(error.message);
    return 2;
  }
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });

module.exports = { decodeBasicMultiline, readTemplate, legacyGate, expectedJob, installContext, operatorMode, Node, NodeError, Refusal,
  isArbiterJob, staleReasons, tomlFor, check, apply, goSeconds, sameDag };
