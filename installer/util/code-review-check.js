#!/usr/bin/env node

/**
 * What the installer asks about the code-review sandbox (node A8; design §16). Shell does the
 * host work, and this answers the questions that need JSON or @verdikta/common:
 *
 *   images        --install-dir D               the pinned images to warm, one per line
 *   conformance   --install-dir D               is there a pass for this release? exit 0, or 1 with why
 *   record        --install-dir D --result F    hold a conformance result to common's hash; keep a pass or none
 *   gate          --install-dir D --classes "…" may this node register on these classes? exit 0, or 1 with why
 *   runner-health --install-dir D               the runner's /health as JSON; exit 1 when it does not answer
 *   jurors        --install-dir D               each juror of common's code-standard panels and its route, as JSON;
 *                                               exit 1 when one has none
 *   doctor        --install-dir D               the doctor's findings: SEV<TAB>id<TAB>message<TAB>hint
 *
 * The gate is a check against mistakes on an operator's own node. The pass file sits on that
 * operator's disk: the check against a dishonest one is that its reports must hash as the other
 * arbiters' do. It reads the bearer token from its file and never prints it or passes it in argv.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

/** ClassIDs when no @verdikta/common can be read: refuse rather than guess less. */
const KNOWN_CODE_CLASSES = [133, 134];
/** The canary class: text-mode until the operator turns code review on. */
const CANARY_CLASS = 5555;
/** What a pull of the largest image needs free: the class's 6 GB, its 1,792 MiB of scratch, the 1 GiB reserve. */
const PULL_ROOM_BYTES = (6000 + 1792 + 1024) * 1024 * 1024;
const DEFAULT_RUNNER_PORT = 8090;
const DEFAULT_ADAPTER_URL = 'http://127.0.0.1:8080';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const o = { command };
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined) usage(`bad argument ${rest[i]}`);
    o[rest[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = rest[i + 1];
  }
  if (!o.installDir) usage('--install-dir is required');
  return o;
}

function usage(problem) {
  process.stderr.write(`code-review-check: ${problem}\n`);
  process.exit(64);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_error) {
    return null;
  }
}

/** KEY=value lines, as data: nothing here is ever sourced. */
function readEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_error) {
    return out;
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

function paths(installDir) {
  const runner = path.join(installDir, 'code-runner');
  const state = path.join(installDir, 'code-runner-state');
  return {
    runner,
    state,
    pass: path.join(state, 'conformance.json'),
    last: path.join(state, 'conformance-last.json'),
    token: path.join(state, 'token'),
    runnerEnv: path.join(runner, '.env'),
    adapterEnv: path.join(installDir, 'external-adapter', '.env'),
    contracts: path.join(installDir, 'installer', '.contracts'),
    common: path.join(runner, 'node_modules', '@verdikta', 'common')
  };
}

/** The runner's own copy of common: what its reports are made with. Null when it cannot be read. */
function runnerCommon(p) {
  try {
    return { codeReview: require(p.common).codeReview, version: readJson(path.join(p.common, 'package.json')).version };
  } catch (_error) {
    return null;
  }
}

/** Common's code classes from any component that has it, always with the ones this node knows of. */
function codeClasses(installDir) {
  const ids = new Set(KNOWN_CODE_CLASSES);
  for (const component of ['code-runner', 'external-adapter', 'ai-node']) {
    try {
      const { codeReview } = require(path.join(installDir, component, 'node_modules', '@verdikta', 'common'));
      for (const id of codeReview.CODE_CLASS_IDS) ids.add(Number(id));
    } catch (_error) {
      // not installed here: the others, and the known ids, still count
    }
  }
  return ids;
}

/** The runner's own rule, from its own tree: one function decides for the runner, the gate and the doctor. */
function runnerRule(p) {
  try {
    return require(path.join(p.runner, 'src', 'conformance.js'));
  } catch (_error) {
    return null;
  }
}

/** Why there is no pass for what is installed now, or null when there is one. */
function conformanceProblem(p) {
  const rule = runnerRule(p);
  if (!rule) return `no conformance pass can be checked: the code runner in ${p.runner} cannot be read; run code-review-sandbox.sh enable`;
  return rule.passProblem(p.pass);
}

function cmdImages(o) {
  const p = paths(o.installDir);
  const common = runnerCommon(p);
  if (!common) usage(`the code runner's @verdikta/common cannot be read (${p.common})`);
  const { SEMGREP } = require(path.join(p.runner, 'src', 'semgrepPin.js'));
  for (const pin of Object.values(common.codeReview.BASE_IMAGE_PINS)) console.log(pin.reference);
  console.log(SEMGREP.reference);
}

function cmdConformance(o) {
  const problem = conformanceProblem(paths(o.installDir));
  if (problem) {
    process.stderr.write(`${problem}\n`);
    process.exit(1);
  }
}

/** Keep a pass only for the hash common publishes, written whole. The old one goes first, whatever happens next. */
function cmdRecord(o) {
  const p = paths(o.installDir);
  fs.rmSync(p.pass, { force: true });
  const rule = runnerRule(p);
  const result = readJson(o.result);
  const refuse = (why) => {
    process.stderr.write(`${why}\n`);
    process.exit(1);
  };
  if (!rule || !result) refuse(`the self-test left no result to compare (${o.result})`);
  // What ran, for whoever reads this next. A diagnostic: it decides nothing, and failing here changes nothing.
  try {
    fs.writeFileSync(p.last, `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`could not keep the result in ${p.last} (${error.code})\n`);
  }
  const want = rule.expectedPass();
  if (result.canonical !== true || result.reportSha256 !== want.reportSha256) {
    refuse(`the canary's report hash is ${result.reportSha256 || '(none)'}; @verdikta/common ${want.commonVersion} publishes ${want.reportSha256}. See ${p.last}`);
  }
  if (result.sourceSha256 !== want.sourceSha256) {
    refuse(`the self-test ran on other source (${result.sourceSha256}) than is installed (${want.sourceSha256})`);
  }
  const tmp = `${p.pass}.new.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ pass: true, ...want, at: new Date().toISOString() }, null, 2)}\n`);
  fs.renameSync(tmp, p.pass);
}

/**
 * The panels a code-class node must serve: every juror of @verdikta/common's code-standard
 * panels (the listing archive's and the dispute archive's; Q63, owner decision 2026-11-09).
 */
const CODE_PANELS = ['CODE_STANDARD_PANEL', 'CODE_STANDARD_DISPUTE_PANEL'];

/** The AI Node's provider classes by provider name (ai-node/src/lib/llm/provider-config.ts, CLASS_FROM_PROVIDER). */
const GATEWAY_CLASS = {
  openai: 'openai',
  anthropic: 'anthropic',
  xai: 'xai',
  grok: 'xai',
  hyperbolic: 'hyperbolic',
  'hyperbolic api': 'hyperbolic',
  ollama: 'ollama',
  'open-source': 'ollama',
  openrouter: 'openrouter'
};

/** Each class's native keys (provider-config.ts, hasNativeKey). The openrouter class has none: OpenRouter is its only route. */
const NATIVE_KEYS = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  xai: ['XAI_API_KEY', 'GROK_API_KEY'],
  hyperbolic: ['HYPERBOLIC_API_KEY']
};

function gatewayBackend(value) {
  const v = String(value === undefined ? '' : value).trim().toLowerCase();
  return v === 'openrouter' || v === 'native' ? v : null;
}

/**
 * The route the AI Gateway gives a provider, decided as resolveProviderConfig does (provider-config.ts)
 * over the AI Node's environment: Ollama local; the openrouter class OpenRouter; then
 * <CLASS>_CLASS_PROVIDER, AI_GATEWAY, a native key, an OpenRouter key, in that order. Null for a
 * provider the gateway has no class for. ai-node's code-jurors-doctor.test.ts holds the two to the
 * same answer, reason included.
 */
function gatewayRoute(provider, env) {
  const providerClass = GATEWAY_CLASS[String(provider).trim().toLowerCase()];
  if (!providerClass) return null;
  if (providerClass === 'ollama') return { providerClass, backend: 'native', reason: 'Ollama is local-only' };
  if (providerClass === 'openrouter') return { providerClass, backend: 'openrouter', reason: 'OpenRouter-only provider' };
  const name = `${providerClass.toUpperCase()}_CLASS_PROVIDER`;
  const classOverride = gatewayBackend(env[name]);
  if (classOverride) return { providerClass, backend: classOverride, reason: `${name} override` };
  const globalOverride = gatewayBackend(env.AI_GATEWAY);
  if (globalOverride) return { providerClass, backend: globalOverride, reason: 'AI_GATEWAY override' };
  if (NATIVE_KEYS[providerClass].some((key) => env[key])) return { providerClass, backend: 'native', reason: 'native-first: native key present' };
  if (env.OPENROUTER_API_KEY) return { providerClass, backend: 'openrouter', reason: 'no native key; routing via OpenRouter' };
  return { providerClass, backend: 'native', reason: 'no keys configured; defaulting to native' };
}

/** One juror: its route, the key that route needs, and whether the AI Node has it. Key values are never read out. */
function jurorRoute(juror, env) {
  const base = { provider: juror.provider, model: juror.model, panels: juror.panels };
  const route = gatewayRoute(juror.provider, env);
  if (!route) {
    return { ...base, providerClass: null, backend: null, reason: null, key: null, served: false,
      problem: `has a provider, '${juror.provider}', that the AI Node has no class for` };
  }
  const out = { ...base, ...route };
  if (route.providerClass === 'ollama') return { ...out, key: null, served: true, via: 'local Ollama', problem: null };
  if (route.backend === 'openrouter') {
    const served = !!env.OPENROUTER_API_KEY;
    let via = 'OpenRouter (its only route)';
    if (route.providerClass !== 'openrouter') via = route.reason.endsWith('override') ? `OpenRouter (${route.reason})` : 'OpenRouter (no native key)';
    const problem = route.providerClass === 'openrouter'
      ? 'needs OPENROUTER_API_KEY: OpenRouter is its only route'
      : `is sent to OpenRouter (${route.reason === 'no native key; routing via OpenRouter' ? 'no native key' : route.reason}) and OPENROUTER_API_KEY is not set`;
    return { ...out, key: 'OPENROUTER_API_KEY', served, via, problem: served ? null : problem };
  }
  const keys = NATIVE_KEYS[route.providerClass];
  const key = keys.find((k) => env[k]) || null;
  const problem = route.reason === 'no keys configured; defaulting to native'
    ? `has no route: neither ${keys.join(' nor ')} nor OPENROUTER_API_KEY is set`
    : `is kept on its native API (${route.reason}) and ${keys.join(' / ')} is not set`;
  return { ...out, key: key || keys[0], served: !!key, via: `native (${key || keys[0]})`, problem: key ? null : problem };
}

/**
 * Every juror of the AI Node's own common's code-standard panels, read at run time (so the check
 * follows a release with other panels), each with its route over ai-node/.env.local, which the AI
 * Node reads at start. Nothing is sent: no model is called, no key is tried.
 */
function codeJurors(installDir) {
  const aiNode = path.join(installDir, 'ai-node');
  const commonDir = path.join(aiNode, 'node_modules', '@verdikta', 'common');
  const envFile = path.join(aiNode, '.env.local');
  const result = { common: null, envFile, envFileExists: fs.existsSync(envFile), panels: [], jurors: [], problem: null };
  let codeReview;
  try {
    codeReview = require(commonDir).codeReview;
    result.common = (readJson(path.join(commonDir, 'package.json')) || {}).version || null;
  } catch (_error) {
    result.problem = `the AI Node's @verdikta/common cannot be read (${commonDir})`;
    return result;
  }
  const byJuror = new Map();
  for (const name of CODE_PANELS) {
    const nodes = codeReview && codeReview[name] && codeReview[name].AI_NODES;
    if (!Array.isArray(nodes)) continue;
    result.panels.push(name);
    for (const node of nodes) {
      const id = `${node.AI_PROVIDER}\u0000${node.AI_MODEL}`;
      if (!byJuror.has(id)) byJuror.set(id, { provider: node.AI_PROVIDER, model: node.AI_MODEL, panels: [] });
      byJuror.get(id).panels.push(name);
    }
  }
  if (result.panels.length === 0) {
    result.problem = `@verdikta/common ${result.common || '(unknown)'} in the AI Node has no code-standard panels`;
    return result;
  }
  const env = readEnvFile(envFile);
  result.jurors = [...byJuror.values()].map((juror) => jurorRoute(juror, env));
  return result;
}

function cmdJurors(o) {
  const result = codeJurors(o.installDir);
  console.log(JSON.stringify(result));
  if (result.problem || result.jurors.some((j) => !j.served)) process.exit(1);
}

/** ai.code_jurors: can the AI Node serve every juror of the code-standard panels? A code-class node only. */
function doctorJurors(installDir) {
  const id = 'ai.code_jurors';
  const result = codeJurors(installDir);
  if (result.problem) {
    finding('WARN', id, `the code-standard jurors cannot be checked: ${result.problem}`, 'Run upgrade-arbiter.sh, which installs the AI Node and its common');
    return;
  }
  const release = `@verdikta/common ${result.common || '(unknown)'}`;
  const missing = result.jurors.filter((j) => !j.served);
  if (missing.length) {
    const env = result.envFileExists ? '' : ` (${path.join('ai-node', '.env.local')} is missing)`;
    finding('FAIL', id,
      `the AI Node cannot serve ${missing.length} of ${result.jurors.length} code-standard jurors (${release})${env}, so this node abstains on every claim: `
        + missing.map((j) => `${j.provider} ${j.model} ${j.problem}`).join('; '),
      'Put the key in installer/.api_keys and run upgrade-arbiter.sh, which writes it into ai-node/.env.local (or set it there and restart the AI Node). '
        + 'A juror with no native class (Gemini) needs an OpenRouter key that serves it');
    return;
  }
  finding('PASS', id, `every juror of the code-standard panels (${release}) has a route: `
    + result.jurors.map((j) => `${j.provider} ${j.model}: ${j.via}`).join('; '));
}

function codeReviewOn(p) {
  return String(readEnvFile(p.adapterEnv).CODE_REVIEW_ENABLED || '').trim().toLowerCase() === 'true';
}

function parseClasses(text) {
  return String(text).split(/[\s,]+/).filter(Boolean).map((c) => Number(c));
}

function cmdGate(o) {
  const p = paths(o.installDir);
  const code = codeClasses(o.installDir);
  const classes = parseClasses(o.classes);
  const tiers = [...new Set(classes.filter((c) => code.has(c)))];
  if (tiers.length > 1) {
    process.stderr.write(`Refused: classes ${tiers.join(' and ')} on the same jobs. A job registered on both is eligible for both price tiers. `
      + 'Register each code class on jobs of its own: VA_REGISTER_JOB_IDS names the jobs of one registration.\n');
    process.exit(1);
  }
  const canary = classes.includes(CANARY_CLASS) && codeReviewOn(p);
  if (tiers.length === 0 && !canary) return;
  const problem = conformanceProblem(p);
  if (problem) {
    const what = tiers.length ? `code class ${tiers[0]}` : `class ${CANARY_CLASS} with code review on`;
    process.stderr.write(`Refused: ${what} needs a conformance pass on this node (design §16). ${problem}\n`);
    process.exit(1);
  }
}

function runnerAddress(p) {
  const env = readEnvFile(p.runnerEnv);
  return { host: env.CODE_RUNNER_HOST || '127.0.0.1', port: Number(env.CODE_RUNNER_PORT) || DEFAULT_RUNNER_PORT };
}

function httpJson(options) {
  return new Promise((resolve) => {
    const req = http.request({ method: 'GET', timeout: 15000, ...options }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (_error) {
          body = null;
        }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (error) => resolve({ status: 0, body: null, error: error.code || error.message }));
    req.end();
  });
}

async function runnerHealth(p) {
  let token;
  try {
    token = fs.readFileSync(p.token, 'utf8').trim();
  } catch (error) {
    return { status: 0, body: null, error: `the token file cannot be read (${error.code})` };
  }
  return httpJson({ ...runnerAddress(p), path: '/health', headers: { authorization: `Bearer ${token}` } });
}

async function cmdRunnerHealth(o) {
  const res = await runnerHealth(paths(o.installDir));
  if (!res.body || (res.status !== 200 && res.status !== 503)) {
    process.stderr.write(`the code runner did not answer /health: ${res.error || `HTTP ${res.status}`}\n`);
    process.exit(1);
  }
  console.log(JSON.stringify(res.body));
}

function tool(file, args) {
  try {
    return { ok: true, out: execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }).trim() };
  } catch (_error) {
    return { ok: false, out: '' };
  }
}

const emitters = [];
function finding(sev, id, msg, hint = '') {
  emitters.push([sev, id, String(msg).replace(/[\t\n]+/g, ' '), String(hint).replace(/[\t\n]+/g, ' ')].join('\t'));
}

/**
 * The file the runner reads as its maintenance lock: code-runner/src/config.js's rule over
 * code-runner/.env (CODE_RUNNER_MAINTENANCE_FILE, else CODE_RUNNER_STATE_DIR/maintenance, else
 * code-runner/.state/maintenance; a blank value counts as unset).
 */
function runnerMaintenanceFile(p, env) {
  const set = (name) => (env[name] === undefined || String(env[name]).trim() === '' ? null : String(env[name]).trim());
  const stateDir = set('CODE_RUNNER_STATE_DIR') || path.join(p.runner, '.state');
  return set('CODE_RUNNER_MAINTENANCE_FILE') || path.join(stateDir, 'maintenance');
}

/**
 * The pid of the upgrade that runs this doctor, when the maintenance lock is that upgrade's own
 * (#126, node A8d). upgrade-arbiter.sh takes the lock with its pid (`code-review-sandbox.sh lock
 * --pid $$`, which writes <install>/code-runner-state/maintenance), exports the same pid as
 * CODE_REVIEW_LOCK_PARENT, and runs its post-upgrade doctor before its EXIT trap lets the lock go.
 * Null for anything else: no such variable; a runner that reads another file than the one the
 * upgrade locks (its own override), or a relative one; a lock that names no pid (an operator's)
 * or another pid; or a holder that is gone (a killed upgrade's).
 */
function ownUpgradeLock(p, env) {
  const parent = process.env.CODE_REVIEW_LOCK_PARENT || '';
  if (!/^[1-9][0-9]*$/.test(parent)) return null;
  const upgradeFile = path.join(p.state, 'maintenance');
  const runnerFile = runnerMaintenanceFile(p, env);
  let holder;
  try {
    if (!path.isAbsolute(runnerFile) || fs.realpathSync(runnerFile) !== fs.realpathSync(upgradeFile)) return null;
    // `<holder> <pid> <time>`, as code-review-sandbox.sh's lock_line writes it.
    holder = fs.readFileSync(upgradeFile, 'utf8').split('\n')[0].trim().split(/\s+/)[1];
  } catch (_error) {
    return null;
  }
  if (holder !== parent) return null;
  try {
    process.kill(Number(parent), 0);
  } catch (error) {
    if (error.code !== 'EPERM') return null;
  }
  return parent;
}

function doctorService(health, p, env) {
  const id = 'svc.code_runner';
  const hint = 'Check code-runner/logs/, then start-arbiter.sh';
  if (!health.body || (health.status !== 200 && health.status !== 503)) {
    finding('FAIL', id, `no answer from the runner's /health: ${health.error || `HTTP ${health.status}`}`, hint);
    return;
  }
  const b = health.body;
  if (env.DOCKER_HOST && b.docker && b.docker.endpoint !== env.DOCKER_HOST) {
    finding('FAIL', id, `the runner drives ${b.docker.endpoint}, not its own daemon ${env.DOCKER_HOST}`, 'Fix code-runner/.env; code-review-sandbox.sh enable rewrites it');
    return;
  }
  if (!b.ok) {
    const reasons = b.reasons || [];
    const own = b.maintenance === true ? ownUpgradeLock(p, env) : null;
    // The lock adds one reason to /health. When it is the only one, nothing but the lock of the
    // upgrade running this check refuses a claim, and that upgrade releases it when it exits.
    if (own && reasons.length === 1) {
      finding('INFO', id, `refusing claims only for this upgrade's own maintenance lock (pid ${own}), which the upgrade releases when it exits`);
      return;
    }
    let lock = '';
    if (own) lock = ` (the maintenance lock is this upgrade's own, pid ${own}, and goes when it exits; the rest stays)`;
    else if (b.maintenance) lock = ` (a lock no install or upgrade holds is stale: remove ${runnerMaintenanceFile(p, env)})`;
    finding('FAIL', id, `the runner would refuse a claim: ${reasons.join('; ') || 'no reason given'}${lock}`, hint);
    return;
  }
  finding('PASS', id, `answering on ${runnerAddress(p).host}:${runnerAddress(p).port} (runner ${b.version}, /health ok)`);
}

function doctorRunsc(health, env) {
  const id = 'sandbox.runsc';
  const b = health.body;
  if (!b) {
    finding('FAIL', id, 'unknown: the runner did not answer', 'See svc.code_runner');
    return;
  }
  if (b.runtime !== 'runsc') finding('FAIL', id, `the runner runs ${b.runtime}, not gVisor`, 'Fix code-runner/.env; code-review-sandbox.sh enable rewrites it');
  else if (!b.runtimeAvailable) finding('FAIL', id, "the runner's daemon has no runsc runtime", 'code-review-sandbox.sh enable');
  else if (!b.gvisor || b.gvisor !== b.gvisorPinned) finding('FAIL', id, `gVisor is ${b.gvisor || 'unmeasured'}; @verdikta/common pins ${b.gvisorPinned}`, 'code-review-sandbox.sh enable');
  else {
    const overlay = (b.runtimeArgs || []).find((a) => a.startsWith('--overlay2='));
    const onDisk = overlay && env.CODE_RUNNER_DATA_ROOT && overlay.includes(`dir=${env.CODE_RUNNER_DATA_ROOT}/`);
    if (!onDisk) finding('FAIL', id, `the scratch overlay is not on the fixed disk (${overlay || 'no --overlay2'}): a claim could fill the root filesystem`, 'code-review-sandbox.sh enable');
    else finding('PASS', id, `gVisor ${b.gvisor}, as @verdikta/common pins`);
  }
}

function doctorDisk(health, env) {
  const id = 'sandbox.disk';
  const hint = 'code-review-sandbox.sh enable; to rebuild the disk: code-review-sandbox.sh disable --purge, then enable';
  const mount = env.CODE_RUNNER_DATA_ROOT;
  if (!mount) {
    finding('FAIL', id, 'code-runner/.env names no CODE_RUNNER_DATA_ROOT', hint);
    return;
  }
  if (!tool('mountpoint', ['-q', mount]).ok) {
    finding('FAIL', id, `${mount} is not mounted`, hint);
    return;
  }
  const fstype = tool('findmnt', ['-no', 'FSTYPE', mount]).out;
  const source = tool('findmnt', ['-no', 'SOURCE', mount]).out;
  if (fstype !== 'ext4' || !source.startsWith('/dev/loop')) {
    finding('FAIL', id, `${mount} is ${fstype || 'unknown'} on ${source || 'unknown'}, not ext4 on a loop device`, hint);
    return;
  }
  const rootDir = tool('docker', ['--host', env.DOCKER_HOST || '', 'info', '--format', '{{.DockerRootDir}}']).out;
  if (!rootDir.startsWith(`${mount}/`)) {
    finding('FAIL', id, `the runner's daemon stores under ${rootDir || 'unknown'}, not ${mount}`, hint);
    return;
  }
  const image = `${mount}.img`;
  const stat = fs.existsSync(image) ? fs.statSync(image) : null;
  if (stat && stat.blocks * 512 < stat.size) {
    finding('WARN', id, `${image} is sparse: ${Math.round((stat.blocks * 512) / 1024 ** 3)} GB of ${Math.round(stat.size / 1024 ** 3)} GB allocated, so its writes can spend the root filesystem`, `sudo fallocate -l ${stat.size} ${image}`);
    return;
  }
  const free = health.body && health.body.dataRoot ? health.body.dataRoot.freeBytes : null;
  const size = `${Math.round(Number(tool('findmnt', ['-bno', 'SIZE', mount]).out) / 1024 ** 3)} GB`;
  if (typeof free === 'number' && free < PULL_ROOM_BYTES) {
    finding('WARN', id, `${(free / 1024 ** 3).toFixed(1)} GB free of ${size} on ${mount}: the largest env image needs ${(PULL_ROOM_BYTES / 1024 ** 3).toFixed(1)} GB, and only unpinned images can be evicted for it`, hint);
    return;
  }
  finding('PASS', id, `ext4 on ${source}, ${size} at ${mount}${typeof free === 'number' ? `, ${(free / 1024 ** 3).toFixed(1)} GB free` : ''}`);
}

function doctorConformance(health, p) {
  const id = 'sandbox.conformance';
  const hint = 'Claims abstain and registering on a code class is refused until it passes. Nothing else on this node is affected';
  const problem = conformanceProblem(p);
  if (problem) {
    finding('FAIL', id, problem, hint);
    return;
  }
  if (health.body) {
    const block = health.body.conformance;
    if (!block || block.required !== true) {
      finding('FAIL', id, 'the runner is not asked to check its pass: CODE_RUNNER_CONFORMANCE_FILE is missing from code-runner/.env', 'code-review-sandbox.sh enable rewrites it');
      return;
    }
    // It holds the source it started with, which can differ from what is on disk.
    if (block.problem) {
      finding('FAIL', id, `the running runner says: ${block.problem}`, 'Restart it, or: code-review-sandbox.sh self-test');
      return;
    }
  }
  finding('PASS', id, 'a pass for this runner, its source, gVisor and @verdikta/common release');
}

async function doctorTrust() {
  const id = 'sandbox.trust';
  const hint = 'The installer writes CODE_REVIEW_TRUST=production: check external-adapter/.env, then restart the adapter';
  const url = new URL(process.env.CODE_RUNNER_ADAPTER_URL || DEFAULT_ADAPTER_URL);
  const res = await httpJson({ host: url.hostname, port: url.port, path: '/health' });
  const block = res.body && res.body.codeReview;
  if (!block) {
    finding('FAIL', id, `the adapter's /health shows no code-review state (${res.error || `HTTP ${res.status}`})`, 'See svc.adapter');
    return;
  }
  if (block.trust !== 'production') {
    finding('FAIL', id, `the adapter's trust is ${block.trust}: attestations are not held to @verdikta/common's builder keys alone`, hint);
    return;
  }
  if (!block.enabled) {
    finding('WARN', id, 'production trust, but code review is off in the adapter', 'code-review-sandbox.sh enable turns it on');
    return;
  }
  if (!block.ready) {
    finding('FAIL', id, `code review is on and not ready: ${(block.problems || []).join('; ')}`, hint);
    return;
  }
  finding('PASS', id, 'production trust, code review ready');
}

function doctorRegistry(health) {
  const id = 'sandbox.registry';
  if (!health.body) {
    finding('FAIL', id, 'unknown: the runner did not answer', 'See svc.code_runner');
    return;
  }
  const entries = (health.body.images && health.body.images.allowlist) || [];
  const dev = entries.filter((e) => e.dev).map((e) => e.entry);
  if (dev.length) finding('FAIL', id, `the image allowlist holds a development entry on this production arbiter: ${dev.join(', ')}`, 'Remove it from CODE_RUNNER_REGISTRY_ALLOWLIST in code-runner/.env');
  else finding('PASS', id, `images only from ${entries.map((e) => e.entry).join(', ') || '(unknown)'}`);
}

async function cmdDoctor(o) {
  const p = paths(o.installDir);
  if (!fs.existsSync(p.runnerEnv)) {
    const registered = parseClasses(readEnvFile(p.contracts).CLASSES_ID || '');
    const code = codeClasses(o.installDir);
    const tier = registered.find((c) => code.has(c));
    if (tier !== undefined) finding('FAIL', 'svc.code_runner', `this node is registered on code class ${tier} and has no code-review sandbox`, 'code-review-sandbox.sh enable');
    else if (codeReviewOn(p)) finding('FAIL', 'svc.code_runner', 'CODE_REVIEW_ENABLED is true in the adapter and this node has no code-review sandbox', 'code-review-sandbox.sh enable');
    else finding('INFO', 'sandbox.skipped', 'the code-review sandbox is not installed (optional)');
    // A text-only node serves no code panel: no juror check, and no noise.
    if (tier !== undefined || codeReviewOn(p)) doctorJurors(o.installDir);
    const image = `${process.env.VERDIKTA_SANDBOX_PREFIX || ''}/var/lib/verdikta-code-runner.img`;
    const left = [image, `${image}.partial`].filter((f) => fs.existsSync(f));
    if (left.length) finding('WARN', 'sandbox.disk', `a disk image stays at ${left.join(', ')} with no sandbox using it`, 'code-review-sandbox.sh disable --purge frees it');
  } else {
    const env = readEnvFile(p.runnerEnv);
    const health = await runnerHealth(p);
    doctorService(health, p, env);
    doctorRunsc(health, env);
    doctorDisk(health, env);
    doctorConformance(health, p);
    await doctorTrust();
    doctorRegistry(health);
    doctorJurors(o.installDir);
  }
  if (emitters.length) console.log(emitters.join('\n'));
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const commands = { images: cmdImages, conformance: cmdConformance, record: cmdRecord, gate: cmdGate, 'runner-health': cmdRunnerHealth, jurors: cmdJurors, doctor: cmdDoctor };
  if (!commands[o.command]) usage(`unknown command ${o.command}`);
  await commands[o.command](o);
}

main().catch((error) => {
  process.stderr.write(`code-review-check: ${error.message}\n`);
  process.exit(1);
});
