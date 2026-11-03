'use strict';

// Node A3a attempt 3 (R11-F1; owner decision Q31), through the run engine
// against the fake env image (test/helpers/fakeClaim.js): the runner runs
// forge itself. Every forge a claim or a listing check starts (the build,
// each PoC run, the fix check's suite, the listing's suite and probes, and
// `forge config` for the integrity reference) is one argv: the launcher's
// nonce line, then `/usr/bin/env -i`, forge's fixed environment, the forge
// the reference probed, and the parsed arguments, unchanged; no shell reads
// any of the maker's text. A command the grammar refuses is refused before
// any sandbox, with the same issue at claim time and at listing time.

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeRun } = require('../../src/pipeline');
const { checkSpec } = require('../../src/classLimits');
const { claimSteps } = require('../../src/steps');
const { checkClaim } = require('../../src/claim');
const { validateListingRequest, listingSteps, imageUnpackedBytes } = require('../../src/listing');
const { createServer } = require('../../src/server');
const { LAUNCHER_SCRIPT } = require('../../src/launcher');
const { FORGE_FUZZ_SEED } = require('../../src/common');
const { testConfig, request: httpRequest } = require('../helpers/http');
const { spec: baseSpec, IMAGE, attestationFor } = require('../helpers/requests');
const { BASE, POC_PATCH, FIX_PATCH, forgeConfig, initialTree, claimSandbox, junit, fakeSolcList } = require('../helpers/fakeClaim');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const PROBED_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** forge's whole environment, in order: the probed PATH, the sandbox's fixed variables, the pinned compiler (the fake config's), the fuzz seed. */
const FORGE_ENV = (path = PROBED_PATH) => [
  `PATH=${path}`, 'TZ=UTC', 'LANG=C.UTF-8', 'CI=true', 'PYTHONHASHSEED=0', 'HOME=/home/sandbox',
  'XDG_DATA_HOME=/opt/verdikta/tools/share', 'VERDIKTA_TOOLS=/opt/verdikta/tools', 'FOUNDRY_CONFIG=foundry.toml', 'FOUNDRY_SOLC=/opt/solc/solc', 'FOUNDRY_EXTERNAL_COMPILERS=[]', `FOUNDRY_FUZZ_SEED=${FORGE_FUZZ_SEED}`
];
const REPORTER = ['--junit', '--fuzz-seed', FORGE_FUZZ_SEED];

const COMMANDS = Object.freeze({
  framework: 'forge', build: 'forge build', test: 'forge test', testFiles: 'forge test --match-path $FILES', testIds: 'forge test --match-test $TEST_IDS'
});

function forgeSpec(over = {}) {
  return baseSpec({
    baseCommit: BASE,
    commands: { ...COMMANDS, ...(over.commands || {}) },
    paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**'] },
    limits: { cpus: 1, memoryMb: 512, buildSeconds: 30, testSeconds: 60, runSeconds: 300, maxPatchBytes: 2000000 }
  });
}

function claimRequest(over = {}) {
  return {
    listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    bcid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    spec: over.spec || forgeSpec(),
    attestation: {},
    pocPatch: Buffer.from(POC_PATCH),
    fixPatch: over.fixPatch || null,
    baseline: { version: 1, baseCommit: BASE, framework: 'forge', runs: 3, tests: [{ id: 'test/Vault.t.sol > VaultTest > test_deposit()', results: ['pass', 'pass', 'pass'] }], stable: ['test/Vault.t.sol > VaultTest > test_deposit()'], unstable: [] },
    finding: {
      version: 1, claimedClass: 'HIGH', rootCause: 'Vault.deposit credits one wei more than it receives.', affectedPaths: ['src/Vault.sol'],
      poc: { command: 'forge test --match-test test_drain', observable: 'test_drain fails with "vault drained"' }
    },
    report: '',
    knownIssues: [],
    priorFindings: [],
    eaGates: { disclosure: 'pass', inScope: 'pass' },
    deadlineMs: 700000
  };
}

async function runClaim(sb, request = claimRequest()) {
  const lim = checkSpec(request.spec);
  assert.ok(lim.ok, JSON.stringify(lim.issues));
  const receivedAt = Date.now();
  return executeRun({
    docker: sb.docker, config: testConfig(), limits: lim.limits, image: IMAGE, runId: '0123456789abcdef',
    steps: claimSteps(request, lim.limits), receivedAt, deadlineAt: receivedAt + 700000, active: new Set(), log: silent,
    admit: async () => {}, sandboxes: request.fixPatch ? 2 : 1
  });
}

const show = (r) => JSON.stringify({ outcome: r.outcome, abstain: r.abstain, issues: r.issues, gates: r.gates }, null, 1);

/** The whole docker exec argv of a decoded exec, from the container name on: the launcher, its nonce, the step's argv. */
function afterContainer(sb, d) {
  const call = sb.docker.callsOf('exec').find((c) => c.args.includes(d.nonce));
  return call.args.slice(call.args.indexOf(d.container) + 1);
}

/** Every forge exec is exactly the launcher, then env -i with forge's environment, the probed forge and `args`; nothing else runs. */
function assertForgeArgv(sb, d, args, { forge = '/usr/local/bin/forge', path = PROBED_PATH } = {}) {
  assert.deepEqual(d.launched, ['/usr/bin/env', '-i', ...FORGE_ENV(path), forge, ...args], `${d.kind}: ${JSON.stringify(d.launched)}`);
  const whole = afterContainer(sb, d);
  assert.deepEqual(whole, ['/bin/sh', '-c', LAUNCHER_SCRIPT, 'vcr-launch', d.nonce, ...d.launched], 'only the launcher, which execs the argv as given');
  assert.ok(!d.launched.some((a) => /^(?:\/bin\/)?(?:sh|bash|dash)$/.test(a) || a === '-c'), 'no shell between the launcher and forge');
  assert.deepEqual(d.env, {}, 'nothing of docker\'s --env: forge\'s environment is env -i\'s');
  assert.equal(d.workdir, '/work', 'forge runs in the work tree, where the reference probed its configuration');
  assert.equal(d.user, '10001:10001', 'as the sandbox user');
}

test('a claim: the build, each PoC run, the fix check\'s build and suite, and `forge config` are each one forge argv, with no shell', async () => {
  const sb = claimSandbox();
  const r = await runClaim(sb, claimRequest({ fixPatch: Buffer.from(FIX_PATCH) }));
  assert.equal(r.outcome, 'definitive', show(r));
  for (const g of ['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity']) assert.equal(r.gates[g].status, 'pass', `${g}: ${show(r)}`);
  const forge = sb.execs().filter((d) => d.forge);
  const poc = forge.filter((d) => d.box === 1 || d.box === null);
  const fix = forge.filter((d) => d.box === 2);
  // The PoC's sandbox: the listed image's configuration before any patch, the reference's, the build, then three runs each followed by a configuration read.
  assert.deepEqual(poc.map((d) => d.kind), ['forge-config', 'forge-config', 'vcr-build', 'vcr-poc', 'forge-config', 'vcr-poc', 'forge-config', 'vcr-poc', 'forge-config']);
  const [listed, ref, build, run1, , run2, , run3] = poc;
  // Owner decision Q37: the first read is the one without the pin, before any patch; every later forge run has it.
  assert.ok(!listed.launched.some((a) => a.startsWith('FOUNDRY_SOLC')), JSON.stringify(listed.launched));
  assert.deepEqual(listed.launched.slice(-2), ['config', '--json']);
  const execs = sb.execs();
  assert.ok(execs.indexOf(listed) < execs.findIndex((d) => d.kind === 'git' && d.sub[0] === 'apply'), 'before any patch');
  assertForgeArgv(sb, ref, ['config', '--json']);
  assertForgeArgv(sb, build, ['build']);
  assertForgeArgv(sb, run1, ['test', '--match-path=test/Exploit.t.sol', ...REPORTER]);
  for (const run of [run2, run3]) assertForgeArgv(sb, run, ['test', '--match-test=^(?:test_drain\\(\\))$', ...REPORTER]);
  // The fix check's sandbox: its own reference, the fixed build, the maker's suite once.
  // In its own read of the listing, before either patch, its pin; then the same steps.
  assert.deepEqual(fix.map((d) => d.kind), ['forge-config', 'forge-config', 'vcr-build', 'vcr-suite', 'forge-config']);
  assert.ok(!fix[0].launched.some((a) => a.startsWith('FOUNDRY_SOLC')), JSON.stringify(fix[0].launched));
  assertForgeArgv(sb, fix[1], ['config', '--json']);
  assertForgeArgv(sb, fix[2], ['build']);
  assertForgeArgv(sb, fix[3], ['test', ...REPORTER]);
  // forge's environment holds no variable but the fixed ones: no FOUNDRY_* but these four.
  for (const d of forge.filter((x) => x !== listed && x !== fix[0])) {
    assert.deepEqual(Object.keys(d.fixedEnv), ['PATH', 'TZ', 'LANG', 'CI', 'PYTHONHASHSEED', 'HOME', 'XDG_DATA_HOME', 'VERDIKTA_TOOLS', 'FOUNDRY_CONFIG', 'FOUNDRY_SOLC', 'FOUNDRY_EXTERNAL_COMPILERS', 'FOUNDRY_FUZZ_SEED']);
  }
  for (const d of [listed, fix[0]]) assert.deepEqual(Object.keys(d.fixedEnv), ['PATH', 'TZ', 'LANG', 'CI', 'PYTHONHASHSEED', 'HOME', 'XDG_DATA_HOME', 'VERDIKTA_TOOLS', 'FOUNDRY_CONFIG', 'FOUNDRY_FUZZ_SEED']);
});

test('the maker\'s allowlisted flags reach forge unchanged, each one argv element; a quoted value holding shell text stays one argument', async () => {
  const spec = forgeSpec({
    commands: {
      build: 'forge build --skip test',
      testFiles: 'forge test -vvv --mp $FILES --fuzz-runs 50 --isolate',
      testIds: 'forge test --match-test ${TEST_IDS} -vv --match-path $FILES',
      test: 'forge test --no-match-contract \'Fork; rm -rf /work && echo $(id) > /tmp/x\' --nmt testFork_ --isolate'
    }
  });
  const sb = claimSandbox();
  const r = await runClaim(sb, claimRequest({ spec, fixPatch: Buffer.from(FIX_PATCH) }));
  assert.equal(r.outcome, 'definitive', show(r));
  const forge = sb.execs().filter((d) => d.forge && d.kind !== 'forge-config');
  const by = (box, kind) => forge.filter((d) => (d.box || 1) === box && d.kind === kind);
  assertForgeArgv(sb, by(1, 'vcr-build')[0], ['build', '--skip=test']);
  const [run1, run2, run3] = by(1, 'vcr-poc');
  assertForgeArgv(sb, run1, ['test', '-vvv', '--match-path=test/Exploit.t.sol', '--fuzz-runs=50', '--isolate', ...REPORTER]);
  for (const run of [run2, run3]) assertForgeArgv(sb, run, ['test', '--match-test=^(?:test_drain\\(\\))$', '-vv', '--match-path=test/Exploit.t.sol', ...REPORTER]);
  assertForgeArgv(sb, by(2, 'vcr-build')[0], ['build', '--skip=test']);
  const [suite] = by(2, 'vcr-suite');
  assertForgeArgv(sb, suite, ['test', '--no-match-contract=Fork; rm -rf /work && echo $(id) > /tmp/x', '--no-match-test=testFork_', '--isolate', ...REPORTER]);
});

test('forge is the one the reference probed (its real path), with the image\'s PATH as probed; never a forge a command names', async () => {
  const path = '/opt/foundry/bin:/usr/local/bin:/usr/bin:/bin';
  const framework = (d, box) => ({ stdout: `vcr-forge /usr/local/bin/forge\nvcr-path ${path}\nvcr-real /opt/foundry/bin/forge-1.8.5\n${forgeConfig(box.tree)}` });
  const sb = claimSandbox({ scripts: { 'vcr-framework': framework } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'definitive', show(r));
  const forge = sb.execs().filter((d) => d.forge);
  assert.ok(forge.length >= 5);
  const [listed, ...pinned] = forge;
  assert.deepEqual(listed.launched, ['/usr/bin/env', '-i', ...FORGE_ENV(path).filter((e) => !/^FOUNDRY_(?:SOLC|EXTERNAL_COMPILERS)=/.test(e)), '/opt/foundry/bin/forge-1.8.5', 'config', '--json']);
  for (const d of pinned) assert.deepEqual(d.launched.slice(0, 15), ['/usr/bin/env', '-i', ...FORGE_ENV(path), '/opt/foundry/bin/forge-1.8.5']);
  // The later probes run the reference's real path too (R1-F3).
  const probes = sb.execs().filter((d) => d.kind === 'vcr-framework');
  assert.deepEqual(probes.slice(2).map((d) => d.argv[4]), ['/opt/foundry/bin/forge-1.8.5', '/opt/foundry/bin/forge-1.8.5', '/opt/foundry/bin/forge-1.8.5']);
});

test('a forge path the runner cannot pass to env as a program (one holding "=") is the image\'s error, before any maker command', async () => {
  const framework = (d, box) => ({ stdout: `vcr-forge /usr/local/bin/forge\nvcr-path /usr/bin\nvcr-real /opt/a=b/forge\n${forgeConfig(box.tree)}` });
  const sb = claimSandbox({ scripts: { 'vcr-framework': framework } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'requester_error', show(r));
  assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_FORGE_MISSING']);
  assert.match(r.issues[0].detail, /\/opt\/a=b\/forge/);
  assert.ok(!sb.execs().some((d) => d.forge), 'forge never ran');
});

// --------------------------------------------------------- refused commands

const REFUSED = Object.freeze([
  ['build', 'FOUNDRY_PROFILE=ci forge build', 'FOUNDRY_PROFILE=ci'],
  ['build', 'env -u FOUNDRY_CONFIG FOUNDRY_PROFILE=ci /usr/local/bin/forge build', 'env'],
  ['build', '/usr/local/bin/forge build', '/usr/local/bin/forge'],
  ['build', 'forge build --config-path foundry.toml', '--config-path'],
  ['build', 'forge build && dd if=/dev/zero of=/dev/null', '&&'],
  ['testFiles', 'forge test --match-path $FILES --compiler-version /work/toolchain/solc', '--compiler-version'],
  ['testFiles', '! forge test --match-path $FILES', '!'],
  ['testFiles', 'FILES=test/Vault.t.sol; forge test --match-path $FILES', 'FILES=test/Vault.t.sol;'],
  ['testIds', 'sh -c \'forge test --match-test "$0" "$@" || exit 1\' $TEST_IDS', 'sh'],
  ['testIds', 'forge test --match-test $TEST_IDS --root /work', '--root'],
  ['test', 'forge test --profile ci', '--profile'],
  ['test', 'touch /tmp/suite-ready && forge test', 'touch']
]);

test('a refused command is a requester error before any sandbox: the claim\'s run and POST /v1/runs (400) name the token', async (t) => {
  for (const [key, text, token] of REFUSED) {
    const sb = claimSandbox();
    const r = await runClaim(sb, claimRequest({ spec: forgeSpec({ commands: { [key]: text } }), fixPatch: key === 'test' ? Buffer.from(FIX_PATCH) : null }));
    assert.equal(r.outcome, 'requester_error', `${key}: ${text}: ${show(r)}`);
    assert.deepEqual(r.issues.map((i) => [i.code, i.path]), [['COMMAND_NOT_ALLOWED', `/spec/commands/${key}`]], text);
    assert.ok(r.issues[0].detail.includes(JSON.stringify(token)), `${text}: ${r.issues[0].detail}`);
    assert.deepEqual(sb.execs().map((d) => d.kind), [], 'nothing ran in the sandbox');
  }
  // Through the HTTP API: refused before admission or any pull.
  const sb = claimSandbox();
  const runner = createServer({ config: testConfig(), docker: sb.docker, log: silent, statfs: async () => ({ bavail: 1e12, bsize: 1 }), meminfo: async () => ({ availableMb: 1e6, error: null }) });
  const address = await runner.listen();
  t.after(() => runner.close());
  const spec = forgeSpec({ commands: { build: 'env FOUNDRY_PROFILE=ci forge build' } });
  const req = claimRequest({ spec });
  const body = {
    listingCid: req.listingCid, bcid: req.bcid, spec, attestation: attestationFor(spec), pocPatch: req.pocPatch.toString('base64'), fixPatch: null,
    baseline: req.baseline, finding: req.finding, report: '# x\n', knownIssues: [], priorFindings: [], eaGates: req.eaGates, deadline: 700000
  };
  const res = await httpRequest({ host: address.host, port: address.port }, { method: 'POST', path: '/v1/runs', body });
  assert.equal(res.status, 400, res.raw);
  assert.deepEqual(res.body.issues.map((i) => i.code), ['COMMAND_NOT_ALLOWED']);
  assert.match(res.body.issues[0].detail, /^commands\.build: "env" is not allowed/);
  assert.deepEqual(sb.docker.callsOf('pull'), []);
  assert.deepEqual(sb.docker.callsOf('create'), []);
});

/** code_review.json as a maker drafts it for a listing check. */
function draft(commands = {}) {
  return {
    spec: {
      version: 1, kind: 'bug', repo: 'https://github.com/acme/vault', baseCommit: BASE, env: { from: 'foundry' },
      commands: { ...COMMANDS, ...commands }, paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**'] },
      stake: { scope: { include: ['src/**'], exclude: [] } }
    },
    image: IMAGE,
    deadline: 900000
  };
}

test('the listing check refuses exactly what a claim refuses, with the same issue (one grammar): every command, accepted or not', () => {
  const texts = {
    build: ['forge build', 'forge build --skip test', 'forge build -vvv', 'forge build --skip tests', ...REFUSED.filter(([k]) => k === 'build').map(([, x]) => x)],
    testFiles: ['forge test --match-path $FILES -vv', 'forge test', 'forge test --match-path $FILES --nmt x', ...REFUSED.filter(([k]) => k === 'testFiles').map(([, x]) => x)],
    testIds: ['forge test --match-test $TEST_IDS --isolate', 'forge test --match-path $FILES', ...REFUSED.filter(([k]) => k === 'testIds').map(([, x]) => x)],
    test: ['forge test --nmc Fork -vvvv', 'forge test --match-path $FILES', ...REFUSED.filter(([k]) => k === 'test').map(([, x]) => x)]
  };
  let refusedBoth = 0;
  for (const [key, list] of Object.entries(texts)) {
    for (const text of list) {
      const listing = validateListingRequest(draft({ [key]: text }));
      const claim = checkClaim(claimRequest({ spec: forgeSpec({ commands: { [key]: text } }) }));
      const commandIssues = (issues) => issues.filter((i) => i.path.startsWith('/spec/commands/'));
      assert.deepEqual(commandIssues(listing.issues), commandIssues(claim), `${key}: ${text}`);
      if (claim.length) refusedBoth += 1;
    }
  }
  assert.ok(refusedBoth >= REFUSED.length + 5);
  // commands.test is the fix check's: a claim needs it only with fix.patch (a listing always runs the suite).
  const noTest = forgeSpec();
  delete noTest.commands.test;
  assert.deepEqual(checkClaim(claimRequest({ spec: noTest })), []);
  assert.deepEqual(checkClaim(claimRequest({ spec: noTest, fixPatch: Buffer.from(FIX_PATCH) })).map((i) => i.code), ['COMMAND_MISSING']);
  assert.deepEqual(validateListingRequest({ ...draft(), spec: { ...draft().spec, commands: noTest.commands } }).issues.map((i) => i.code), ['COMMAND_MISSING']);
});

test('POST /v1/listing-checks refuses a refused command with 400 before any sandbox, naming the token', async (t) => {
  const sb = claimSandbox({ handlers: { history: () => ({ stdout: '400000000\n' }) } });
  const runner = createServer({ config: testConfig(), docker: sb.docker, log: silent, statfs: async () => ({ bavail: 1e12, bsize: 1 }), meminfo: async () => ({ availableMb: 1e6, error: null }) });
  const address = await runner.listen();
  t.after(() => runner.close());
  for (const [key, text, token] of REFUSED) {
    const res = await httpRequest({ host: address.host, port: address.port }, { method: 'POST', path: '/v1/listing-checks', body: draft({ [key]: text }) });
    assert.equal(res.status, 400, `${text}: ${res.raw}`);
    assert.deepEqual(res.body.issues.map((i) => [i.code, i.path]), [['COMMAND_NOT_ALLOWED', `/spec/commands/${key}`]], text);
    assert.ok(res.body.issues[0].detail.includes(JSON.stringify(token)), res.body.issues[0].detail);
  }
  assert.deepEqual(sb.docker.callsOf('create'), []);
});

test('the listing check runs forge the same way: its build, its suite x3 and every harness probe are forge argvs, forge found first in each sandbox', async () => {
  let applied = null;
  const probeJunit = () => {
    const file = /\+\+\+ b\/(\S+)/.exec(applied)[1];
    if (/VerdiktaHarnessCompileError/.test(applied)) return { exitCode: 1, stdout: '', stderr: 'Error: Compiler run failed\n' };
    if (/VerdiktaHarnessSetUpError/.test(applied)) return { exitCode: 1, stdout: junit([{ suite: `${file}:VerdiktaHarnessSetUpError`, cases: [{ name: 'setUp()', failure: 'broken setUp' }] }]) };
    return { exitCode: 1, stdout: junit([{ suite: `${file}:VerdiktaHarnessFails`, cases: [{ name: 'test_verdiktaHarnessFails()', failure: 'a trivially failing test: 1 != 2' }] }]) };
  };
  const suite = junit([{ suite: 'test/Vault.t.sol:VaultTest', cases: [{ name: 'test_deposit()' }] }]);
  const sb = claimSandbox({
    handlers: { history: () => ({ stdout: '400000000\n' }) },
    git: {
      'apply --index': (d) => { applied = d.stdin.toString('utf8'); return { exitCode: 0 }; },
      'diff --raw': () => ({ stdout: Buffer.from(`:000000 100644 ${'0'.repeat(40)} ${'b'.repeat(40)} A\0${/\+\+\+ b\/(\S+)/.exec(applied)[1]}\0`, 'latin1') }),
      'diff --name-status': () => ({ stdout: `A\0${/\+\+\+ b\/(\S+)/.exec(applied)[1]}\0` }),
      'diff --numstat': () => ({ stdout: `3\t0\t${/\+\+\+ b\/(\S+)/.exec(applied)[1]}\0` }),
      'diff -U0': () => ({ stdout: applied })
    },
    scripts: {
      'vcr-build': () => (/VerdiktaHarnessCompileError/.test(applied || '') ? { exitCode: 1 } : { exitCode: 0 }),
      'vcr-suite': () => ({ exitCode: 0, stdout: suite }),
      'vcr-poc': () => probeJunit()
    }
  });
  const v = validateListingRequest(draft({ test: 'forge test -vv --nmc Fork' }));
  assert.ok(v.ok, JSON.stringify(v.issues));
  const receivedAt = Date.now();
  const r = await executeRun({
    docker: sb.docker, config: testConfig(), limits: v.limits, image: v.request.image, runId: '0123456789abcdef',
    steps: listingSteps(v.request, v.limits, { imageSize: () => imageUnpackedBytes(sb.docker, v.request.image), platform: 'linux/amd64', solcList: fakeSolcList() }),
    receivedAt, deadlineAt: receivedAt + 900000, active: new Set(), log: silent, admit: async () => {}
  });
  assert.equal(r.outcome, 'definitive', JSON.stringify({ outcome: r.outcome, abstain: r.abstain, issues: r.issues }));
  assert.equal(r.facts.listing.status, 'accepted', JSON.stringify(r.facts.listing.refusals));
  const execs = sb.execs();
  const forge = execs.filter((d) => d.forge);
  const suites = forge.filter((d) => d.kind === 'vcr-suite');
  assert.equal(suites.length, 3);
  for (const s of suites) assertForgeArgv(sb, s, ['test', '-vv', '--no-match-contract=Fork', ...REPORTER]);
  const builds = forge.filter((d) => d.kind === 'vcr-build');
  assert.ok(builds.length >= 3, 'the listing\'s build and the probes\' builds');
  for (const b of builds) assertForgeArgv(sb, b, ['build']);
  const runs = forge.filter((d) => d.kind === 'vcr-poc');
  assert.equal(runs.length, 5, 'three runs of the failing probe, one of each broken one');
  for (const p of runs.slice(0, 1)) assertForgeArgv(sb, p, ['test', '--match-path=test/VerdiktaHarness.t.sol', ...REPORTER]);
  // In every sandbox, the runner finds forge (vcr-framework) before it runs it.
  const containers = [...new Set(execs.map((d) => d.container))];
  for (const c of containers) {
    const mine = execs.filter((d) => d.container === c);
    const first = mine.findIndex((d) => d.forge);
    if (first < 0) continue;
    assert.ok(mine.slice(0, first).some((d) => d.kind === 'vcr-framework'), `${c}: forge found before it runs`);
  }
});

test('a listing check on an image with no forge on PATH, or one the runner cannot run, is the image\'s error, as at the integrity reference', async () => {
  const body = draft();
  const v = validateListingRequest(body);
  const run = async (framework) => {
    const sb = claimSandbox({ handlers: { history: () => ({ stdout: '400000000\n' }) }, scripts: { 'vcr-framework': framework } });
    const receivedAt = Date.now();
    const r = await executeRun({
      docker: sb.docker, config: testConfig(), limits: v.limits, image: v.request.image, runId: '0123456789abcdef',
      steps: listingSteps(v.request, v.limits, { imageSize: () => imageUnpackedBytes(sb.docker, v.request.image), platform: 'linux/amd64', solcList: fakeSolcList() }),
      receivedAt, deadlineAt: receivedAt + 900000, active: new Set(), log: silent, admit: async () => {}
    });
    return { r, sb };
  };
  const cases = [
    [() => ({ exitCode: 3, stdout: 'vcr-forge \nvcr-path /usr/bin\n' }), /no forge on its PATH/],
    [() => ({ stdout: 'vcr-forge /opt/a=b/forge\nvcr-path /usr/bin\nvcr-real /opt/a=b/forge\n' }), /forge the runner can run/]
  ];
  for (const [framework, re] of cases) {
    const { r, sb } = await run(framework);
    assert.equal(r.outcome, 'requester_error', JSON.stringify(r.abstain || r.facts.listing));
    assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_FORGE_MISSING']);
    assert.match(r.issues[0].detail, re);
    assert.ok(!sb.execs().some((d) => d.forge), 'forge never ran');
  }
  // An image PATH of several lines holds no answer the runner can trust, as at the integrity reference.
  const { discoverForge } = require('../../src/integrity');
  const ctx = (text, exitCode = 0) => ({ exec: async (argv, o) => { o.tee.write(Buffer.from(text)); return { exitCode, stderr: { text: '' } }; } });
  await assert.rejects(discoverForge(ctx('vcr-forge /f\nvcr-path /usr/bin\nsecond line of PATH\nvcr-real /f\n'), 'forge:find'), (e) => e.issues[0].code === 'IMAGE_FORGE_MISSING');
  assert.deepEqual(await discoverForge(ctx('vcr-forge /usr/local/bin/forge\nvcr-path /usr/bin\nvcr-real /opt/forge\n'), 'forge:find'), { forgePath: '/usr/local/bin/forge', realPath: '/opt/forge', path: '/usr/bin' });
});

test('a forge config failure in a claim is the requester\'s (FORGE_CONFIG_INVALID); the probe reads it through the same argv as the commands', async () => {
  const framework = () => ({ exitCode: 1, stdout: 'vcr-forge /usr/local/bin/forge\nvcr-path /usr/bin\n', stderr: 'Error: failed to parse foundry.toml' });
  const sb = claimSandbox({ scripts: { 'vcr-framework': framework } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'requester_error', show(r));
  assert.deepEqual(r.issues.map((i) => i.code), ['FORGE_CONFIG_INVALID']);
  // The read of the listing's own files, before any patch and without the pin, is where it shows.
  const [config] = sb.execs().filter((d) => d.kind === 'forge-config');
  assert.deepEqual(config.launched, ['/usr/bin/env', '-i', ...FORGE_ENV('/usr/bin').filter((e) => !/^FOUNDRY_(?:SOLC|EXTERNAL_COMPILERS)=/.test(e)), '/usr/local/bin/forge', 'config', '--json']);
  assert.ok(!sb.execs().some((d) => d.kind === 'vcr-build'));
  // The config text read is the one every maker command runs with: forgeConfig of the reference tree, hashed once.
  assert.ok(forgeConfig(initialTree()).length > 0);
});
