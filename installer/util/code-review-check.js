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
  return {
    runner,
    state: path.join(runner, '.state'),
    pass: path.join(runner, '.state', 'conformance.json'),
    last: path.join(runner, '.state', 'conformance-last.json'),
    token: path.join(runner, '.state', 'token'),
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

/** Why there is no pass for what is installed now, or null when there is one. */
function conformanceProblem(p) {
  const common = runnerCommon(p);
  if (!common) return `the code runner's @verdikta/common cannot be read (${p.common}); run code-review-sandbox.sh enable`;
  const recorded = readJson(p.pass);
  if (!recorded) return 'no conformance pass is recorded; run code-review-sandbox.sh self-test';
  const runner = (readJson(path.join(p.runner, 'package.json')) || {}).version;
  const want = common.codeReview.CONFORMANCE_CANARY.reportSha256;
  if (recorded.pass !== true) return 'the recorded conformance result is not a pass; run code-review-sandbox.sh self-test';
  if (recorded.reportSha256 !== want) return `the recorded conformance hash is not the one @verdikta/common ${common.version} publishes; run code-review-sandbox.sh self-test`;
  if (recorded.runner !== runner) return `the recorded conformance pass is for runner ${recorded.runner}, and runner ${runner} is installed; run code-review-sandbox.sh self-test`;
  if (recorded.gvisor !== common.codeReview.GVISOR_RELEASE) return `the recorded conformance pass is for gVisor ${recorded.gvisor}, and @verdikta/common pins ${common.codeReview.GVISOR_RELEASE}; run code-review-sandbox.sh self-test`;
  if (recorded.commonVersion !== common.version) return `the recorded conformance pass is for @verdikta/common ${recorded.commonVersion}, and ${common.version} is installed; run code-review-sandbox.sh self-test`;
  return null;
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

/** Keep a pass only for the hash common publishes; what ran stays in conformance-last.json either way. */
function cmdRecord(o) {
  const p = paths(o.installDir);
  const common = runnerCommon(p);
  const result = readJson(o.result);
  fs.rmSync(p.pass, { force: true });
  if (!common || !result) {
    process.stderr.write(`the self-test left no result to compare (${o.result})\n`);
    process.exit(1);
  }
  fs.writeFileSync(p.last, `${JSON.stringify(result, null, 2)}\n`);
  const want = common.codeReview.CONFORMANCE_CANARY.reportSha256;
  if (result.canonical !== true || result.reportSha256 !== want) {
    process.stderr.write(`the canary's report hash is ${result.reportSha256 || '(none)'}; @verdikta/common ${common.version} publishes ${want}. Kept in ${p.last}\n`);
    process.exit(1);
  }
  fs.writeFileSync(p.pass, `${JSON.stringify({
    pass: true,
    reportSha256: result.reportSha256,
    runner: result.runner,
    gvisor: result.gvisor,
    commonVersion: common.version,
    at: new Date().toISOString()
  }, null, 2)}\n`);
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
    const lock = b.maintenance ? ` (a lock no install or upgrade holds is stale: remove ${path.join(p.state, 'maintenance')})` : '';
    finding('FAIL', id, `the runner would refuse a claim: ${(b.reasons || []).join('; ') || 'no reason given'}${lock}`, hint);
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
  const free = health.body && health.body.dataRoot ? health.body.dataRoot.freeBytes : null;
  const size = `${Math.round(Number(tool('findmnt', ['-bno', 'SIZE', mount]).out) / 1024 ** 3)} GB`;
  if (typeof free === 'number' && free < PULL_ROOM_BYTES) {
    finding('WARN', id, `${(free / 1024 ** 3).toFixed(1)} GB free of ${size} on ${mount}: the largest env image needs ${(PULL_ROOM_BYTES / 1024 ** 3).toFixed(1)} GB, and only unpinned images can be evicted for it`, hint);
    return;
  }
  finding('PASS', id, `ext4 on ${source}, ${size} at ${mount}${typeof free === 'number' ? `, ${(free / 1024 ** 3).toFixed(1)} GB free` : ''}`);
}

function doctorConformance(p) {
  const problem = conformanceProblem(p);
  if (problem) finding('FAIL', 'sandbox.conformance', problem, 'Registering on a code class is refused until it passes');
  else finding('PASS', 'sandbox.conformance', 'a pass for this runner, gVisor and @verdikta/common release');
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
    finding('WARN', id, 'production trust, but code review is off in the adapter', 'It turns on with a conformance pass: code-review-sandbox.sh self-test');
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
    const image = `${process.env.VERDIKTA_SANDBOX_PREFIX || ''}/var/lib/verdikta-code-runner.img`;
    if (fs.existsSync(image)) finding('WARN', 'sandbox.disk', `a disk image stays at ${image} with no sandbox using it`, 'code-review-sandbox.sh disable --purge frees it');
  } else {
    const env = readEnvFile(p.runnerEnv);
    const health = await runnerHealth(p);
    doctorService(health, p, env);
    doctorRunsc(health, env);
    doctorDisk(health, env);
    doctorConformance(p);
    await doctorTrust();
    doctorRegistry(health);
  }
  if (emitters.length) console.log(emitters.join('\n'));
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const commands = { images: cmdImages, conformance: cmdConformance, record: cmdRecord, gate: cmdGate, 'runner-health': cmdRunnerHealth, doctor: cmdDoctor };
  if (!commands[o.command]) usage(`unknown command ${o.command}`);
  await commands[o.command](o);
}

main().catch((error) => {
  process.stderr.write(`code-review-check: ${error.message}\n`);
  process.exit(1);
});
