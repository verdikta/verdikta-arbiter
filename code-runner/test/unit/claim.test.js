'use strict';

// Node A2a acceptance, driven through the run engine against a fake env
// image (test/helpers/fakeClaim.js): the forge adapter's patch gates, the
// build, the PoC on the fixed schedule and the reproduces gate. The same
// paths run against real forge in test/docker/claim.docker.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeRun } = require('../../src/pipeline');
const { checkSpec } = require('../../src/classLimits');
const { claimSteps } = require('../../src/steps');
const { FORGE_FUZZ_SEED } = require('../../src/common');
const { testConfig } = require('../helpers/http');
const { spec: baseSpec, IMAGE } = require('../helpers/requests');
const { BASE, POC, POC_PATCH, junit, drainFails, claimSandbox } = require('../helpers/fakeClaim');
const { NEUTRAL_ATTRIBUTES, CHECKOUT_SCRIPT, SUBMODULE_INDEX_SCRIPT } = require('../../src/claim');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const noAdmission = async () => {};

const COMMANDS = {
  framework: 'forge',
  build: 'forge build',
  test: 'forge test',
  testFiles: 'forge test --match-path $FILES',
  testIds: 'forge test --match-test $TEST_IDS'
};

function forgeSpec(over = {}) {
  return baseSpec({
    baseCommit: BASE,
    commands: { ...COMMANDS, ...(over.commands || {}) },
    paths: over.paths || { tests: ['test/**'], protected: ['foundry.toml', 'lib/**'] },
    limits: { cpus: 1, memoryMb: 512, buildSeconds: 30, testSeconds: 60, runSeconds: 300, maxPatchBytes: 2000000, ...(over.limits || {}) },
    ...(over.env ? { env: over.env } : {})
  });
}

function claimRequest(over = {}) {
  return {
    listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    bcid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    spec: over.spec || forgeSpec(),
    attestation: {},
    pocPatch: over.pocPatch || Buffer.from(POC_PATCH),
    fixPatch: null,
    baseline: over.baseline || { version: 1, baseCommit: BASE, framework: 'forge', runs: 3, tests: [{ id: 'test/Vault.t.sol > VaultTest > test_deposit()', results: ['pass', 'pass', 'pass'] }], stable: ['test/Vault.t.sol > VaultTest > test_deposit()'], unstable: [] },
    finding: {},
    report: '',
    knownIssues: [],
    priorFindings: [],
    eaGates: { disclosure: 'pass', inScope: 'pass' },
    deadlineMs: 700000
  };
}

async function runClaim(sandbox, request = claimRequest(), { deadlineMs = 700000, extraSteps = [] } = {}) {
  const lim = checkSpec(request.spec);
  assert.ok(lim.ok, JSON.stringify(lim.issues));
  const steps = [...claimSteps(request, lim.limits), ...extraSteps];
  const receivedAt = Date.now();
  const result = await executeRun({
    docker: sandbox.docker, config: testConfig(), limits: lim.limits, image: IMAGE, runId: '0123456789abcdef', steps,
    receivedAt, deadlineAt: receivedAt + deadlineMs, active: new Set(), log: silent, admit: noAdmission
  });
  return result;
}

const kinds = (sb) => sb.execs().map((d) => (d.kind === 'git' ? `git ${d.sub[0]}` : d.kind));
const gitCalls = (sb, sub) => sb.execs().filter((d) => d.kind === 'git' && d.sub[0] === sub);
const pocRuns = (sb) => sb.execs().filter((d) => d.kind === 'vcr-poc');

// ---------------------------------------------------------------- happy path

test('a PoC that fails as an assertion on all three runs passes applies, testPathsOnly, build and reproduces', async () => {
  const sb = claimSandbox();
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'definitive', JSON.stringify(r.abstain || r.issues));
  for (const g of ['applies', 'testPathsOnly', 'build', 'reproduces']) assert.equal(r.gates[g].status, 'pass', `${g}: ${JSON.stringify(r.gates[g])}`);
  assert.equal(r.gates.applies.basis, 'exit_code');
  assert.equal(r.gates.build.basis, 'exit_code');
  assert.equal(r.gates.reproduces.basis, 'junit');
  assert.deepEqual(kinds(sb), [
    'vcr-procs', 'vcr-checkout', 'git rev-parse', 'git rev-parse', 'git read-tree', 'git submodule', 'git update-index', 'git status',
    'git apply', 'git apply', 'git diff', 'git diff', 'git diff',
    'git ls-tree', 'git checkout', 'git commit', 'git rev-parse',
    'vcr-build', 'vcr-cleanup',
    'vcr-poc', 'vcr-cleanup', 'git reset', 'vcr-poc', 'vcr-cleanup', 'git reset', 'vcr-poc', 'vcr-cleanup'
  ]);
  const poc = r.facts.poc;
  assert.equal(poc.testCount, 1);
  assert.deepEqual(poc.tests, [{ id: 'test/Exploit.t.sol > ExploitTest > test_drain()', runs: ['fail', 'fail', 'fail'], kind: 'assertion', message: 'vault drained' }]);
  assert.deepEqual(poc.runCounts, { fail: 3, pass: 0, error: 0, skip: 0, missing: 0, duplicate: 0, notRun: 0 });
  assert.equal(poc.tier, 'B');
  assert.deepEqual(r.facts.commit, { base: BASE, poc: POC });
  assert.deepEqual(r.facts.diff, { files: 1, added: 3, removed: 0, binaryFiles: 0 });
});

// ------------------------------------------------------------------ applies

test('applies: git apply runs inside the sandbox against the listed commit, the patch on stdin', async () => {
  const sb = claimSandbox();
  await runClaim(sb);
  const applies = gitCalls(sb, 'apply');
  assert.equal(applies.length, 2);
  for (const a of applies) {
    assert.deepEqual(a.stdin, Buffer.from(POC_PATCH), 'the patch reaches git as stdin of docker exec');
    assert.ok(a.sub.includes('--whitespace=nowarn'));
    assert.equal(a.env.GIT_DIR, '/work/.git');
    assert.equal(a.env.GIT_WORK_TREE, '/work');
    assert.equal(a.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(a.env.GIT_CONFIG_GLOBAL, '/dev/null');
  }
  assert.ok(applies[0].sub.includes('--numstat'), 'parsed by git first, nothing written');
  assert.ok(applies[1].sub.includes('--index'), 'then applied to the index and the work tree');
  // Every git call is a docker exec into the sandbox: the host never runs git.
  for (const c of sb.docker.calls) assert.notEqual(c.args[0], 'git');
  assert.deepEqual(gitCalls(sb, 'rev-parse')[0].sub, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
  const verify = gitCalls(sb, 'rev-parse')[1];
  assert.deepEqual(verify.sub, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
  // Clean means the tracked files (and submodules' commits and tracked files) are the commit's.
  assert.deepEqual(gitCalls(sb, 'status')[0].sub, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=untracked']);
  // The fixed configuration on every git call: no hooks, no fsmonitor, whitespace never refuses a patch.
  for (const call of sb.execs().filter((d) => d.kind === 'git')) {
    for (const c of ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'apply.whitespace=nowarn', 'core.autocrlf=false']) {
      assert.ok(call.argv.includes(c), `${call.sub[0]} runs with ${c}`);
    }
    assert.equal(call.env.LC_ALL, 'C');
  }
});

test('applies: a patch above maxPatchBytes fails before git sees it', async () => {
  const sb = claimSandbox();
  const r = await runClaim(sb, claimRequest({ spec: forgeSpec({ limits: { maxPatchBytes: 100 } }) }));
  assert.equal(r.outcome, 'definitive');
  assert.equal(r.gates.applies.status, 'fail');
  assert.equal(r.gates.applies.basis, 'input');
  assert.match(r.gates.applies.detail, /maxPatchBytes/);
  assert.equal(gitCalls(sb, 'apply').length, 0);
  for (const g of ['testPathsOnly', 'build', 'reproduces']) assert.equal(r.gates[g], undefined, `${g} is not run`);
  assert.equal(pocRuns(sb).length, 0);
});

test('applies: a patch that expands past 50 MB (a binary literal bomb) fails before git sees it', async () => {
  const bomb = Buffer.from([
    'diff --git a/test/b.bin b/test/b.bin', 'new file mode 100644', 'index 0000000..1111111', 'GIT binary patch',
    'literal 60000000', 'zcmeIuF#!Mo0K%a4Pi+Q3h&OqVfB^#r3>YwAz<>b*1`HT5V8DO@0|pEjFkrxd', '', 'literal 0', 'HcmV?d00001', '', ''
  ].join('\n'));
  const sb = claimSandbox();
  const r = await runClaim(sb, claimRequest({ pocPatch: bomb }));
  assert.equal(r.gates.applies.status, 'fail');
  assert.match(r.gates.applies.detail, /expand to at least 60000000 bytes.*50000000/);
  assert.equal(gitCalls(sb, 'apply').length, 0);
});

test('applies: a patch git cannot apply to the listed commit fails with git\'s reason; nothing later runs', async () => {
  const sb = claimSandbox({ git: { 'apply --index': () => ({ exitCode: 1, stderr: 'error: patch failed: test/Vault.t.sol:3\nerror: test/Vault.t.sol: patch does not apply\n' }) } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'definitive');
  assert.equal(r.gates.applies.status, 'fail');
  assert.equal(r.gates.applies.basis, 'exit_code');
  assert.match(r.gates.applies.detail, new RegExp(`does not apply to the listed commit ${BASE}.*patch failed: test/Vault.t.sol:3`));
  assert.equal(r.gates.testPathsOnly, undefined);
  assert.ok(!kinds(sb).includes('vcr-build'));
});

test('applies: a patch git cannot read, and one that changes a file twice, fail', async () => {
  const garbage = claimSandbox({ git: { 'apply --numstat': () => ({ exitCode: 128, stderr: 'error: No valid patches in input (allow with "--allow-empty")\n' }) } });
  const r1 = await runClaim(garbage);
  assert.equal(r1.gates.applies.status, 'fail');
  assert.match(r1.gates.applies.detail, /could not read poc\.patch.*No valid patches/);
  const twice = claimSandbox({ git: { 'apply --numstat': () => ({ stdout: '1\t0\ttest/A.t.sol\0' + '1\t0\ttest/A.t.sol\0' }) } });
  const r2 = await runClaim(twice);
  assert.equal(r2.gates.applies.status, 'fail');
  assert.match(r2.gates.applies.detail, /changes test\/A\.t\.sol more than once/);
  assert.equal(gitCalls(twice, 'apply').length, 1, 'refused before git materialises it');
});

test('applies: binary changes count as stats only', async () => {
  const sb = claimSandbox({
    git: {
      'diff --name-status': () => ({ stdout: 'A\0test/Exploit.t.sol\0A\0test/fixture.bin\0' }),
      'diff --numstat': () => ({ stdout: '3\t0\ttest/Exploit.t.sol\0-\t-\ttest/fixture.bin\0' })
    }
  });
  const r = await runClaim(sb);
  assert.equal(r.gates.applies.status, 'pass');
  assert.deepEqual(r.facts.diff, { files: 2, added: 3, removed: 0, binaryFiles: 1 });
});

// ------------------------------------------------------------ testPathsOnly

test('poc-patch-edits-source: a patch that touches src/ fails testPathsOnly, decided inside the sandbox before any claim code runs', async () => {
  const sb = claimSandbox({ git: { 'diff --name-status': () => ({ stdout: 'M\0src/Vault.sol\0A\0test/Exploit.t.sol\0' }) } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'definitive');
  assert.equal(r.gates.applies.status, 'pass');
  assert.equal(r.gates.testPathsOnly.status, 'fail');
  assert.equal(r.gates.testPathsOnly.basis, 'exit_code');
  assert.match(r.gates.testPathsOnly.detail, /src\/Vault\.sol.*outside paths\.tests/);
  // git computed the touched paths in the sandbox; nothing ran after the gate.
  const order = kinds(sb);
  assert.ok(order.includes('git diff'));
  for (const k of ['vcr-build', 'vcr-poc', 'git commit']) assert.ok(!order.includes(k), `${k} must not run`);
  assert.equal(r.gates.build, undefined);
  assert.equal(r.gates.reproduces, undefined);
  assert.deepEqual(r.facts.testPaths.outside, ['src/Vault.sol']);
});

test('testPathsOnly: a protected path inside paths.tests, a rename out of src/, and a path a report cannot carry all fail', async () => {
  const cases = [
    [{ tests: ['test/**', 'foundry.toml'], protected: ['foundry.toml'] }, 'M\0foundry.toml\0A\0test/Exploit.t.sol\0', /foundry\.toml.*paths\.protected/],
    [undefined, 'D\0src/Vault.sol\0A\0test/Vault.sol\0', /src\/Vault\.sol.*outside paths\.tests/],
    [undefined, 'A\0test/a b.t.sol\0', /test\/a b\.t\.sol.*cannot be named in a report/]
  ];
  for (const [paths, ns, re] of cases) {
    const sb = claimSandbox({ git: { 'diff --name-status': () => ({ stdout: ns }) } });
    const r = await runClaim(sb, claimRequest({ spec: forgeSpec(paths ? { paths } : {}) }));
    assert.equal(r.gates.testPathsOnly.status, 'fail', ns);
    assert.match(r.gates.testPathsOnly.detail, re);
    assert.ok(!kinds(sb).includes('vcr-build'));
  }
});

test('testPathsOnly flags: existing tests modified, skip markers added, framework and reporter references', async () => {
  const diff = [
    'diff --git a/test/Exploit.t.sol b/test/Exploit.t.sol', 'new file mode 100644', 'index 0000000..95fbe20', '--- /dev/null', '+++ b/test/Exploit.t.sol',
    '@@ -0,0 +1,4 @@', '+contract ExploitTest {', '+  /// forge-config: default.fuzz.runs = 1', '+  function test_drain() public { vm.skip(true); }', '+}',
    'diff --git a/test/Vault.t.sol b/test/Vault.t.sol', 'index 2057cae..1567b22 100644', '--- a/test/Vault.t.sol', '+++ b/test/Vault.t.sol',
    '@@ -4 +4 @@', '-  function test_deposit() public {}', '+  function test_deposit() public { vm.ffi(c); }', ''
  ].join('\n');
  const sb = claimSandbox({
    diff,
    git: {
      'diff --name-status': () => ({ stdout: 'A\0test/Exploit.t.sol\0M\0test/Vault.t.sol\0' }),
      'diff --numstat': () => ({ stdout: '4\t0\ttest/Exploit.t.sol\0' + '1\t1\ttest/Vault.t.sol\0' })
    }
  });
  const r = await runClaim(sb);
  assert.equal(r.gates.testPathsOnly.status, 'pass');
  assert.deepEqual(r.facts.flags, {
    existingTestsModified: ['test/Vault.t.sol'],
    skipMarkersAdded: ['test/Exploit.t.sol'],
    protectedPathsTouched: [],
    frameworkReferences: [
      { file: 'test/Exploit.t.sol', line: 2, rule: 'forge-inline-config' },
      { file: 'test/Vault.t.sol', line: 4, rule: 'ffi' }
    ]
  });
});

test('protected paths are reset to the listed commit, then the result is committed with a fixed author and date', async () => {
  const sb = claimSandbox({ git: { 'ls-tree': () => ({ stdout: 'foundry.toml\0lib/forge-std\0lib/oz/Token.sol\0src/Vault.sol\0' }) } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'definitive');
  const [lsTree] = gitCalls(sb, 'ls-tree');
  assert.deepEqual(lsTree.sub, ['ls-tree', '-r', '-z', '--full-tree', '--name-only', '--end-of-options', BASE]);
  const [checkout] = gitCalls(sb, 'checkout');
  assert.deepEqual(checkout.sub, ['checkout', BASE, '--pathspec-from-file=-', '--pathspec-file-nul']);
  assert.equal(checkout.env.GIT_LITERAL_PATHSPECS, '1');
  assert.deepEqual(checkout.stdin.toString('utf8').split('\0'), ['foundry.toml', 'lib/forge-std', 'lib/oz/Token.sol']);
  assert.equal(r.facts.protectedReset, 3);
  const [commit] = gitCalls(sb, 'commit');
  assert.deepEqual(commit.sub, ['commit', '--quiet', '--no-verify', '--no-gpg-sign', '--allow-empty', '--cleanup=whitespace', '--message', 'poc.patch']);
  assert.equal(commit.env.GIT_AUTHOR_NAME, 'Verdikta code runner');
  assert.equal(commit.env.GIT_AUTHOR_EMAIL, 'code-runner@verdikta.invalid');
  assert.equal(commit.env.GIT_COMMITTER_NAME, commit.env.GIT_AUTHOR_NAME);
  assert.equal(commit.env.GIT_COMMITTER_EMAIL, commit.env.GIT_AUTHOR_EMAIL);
  assert.equal(commit.env.GIT_AUTHOR_DATE, '1767225600 +0000');
  assert.equal(commit.env.GIT_COMMITTER_DATE, '1767225600 +0000');
  const order = kinds(sb);
  assert.ok(order.indexOf('git checkout') < order.indexOf('git commit'));
  assert.ok(order.indexOf('git commit') < order.indexOf('vcr-build'));
});

test('no protected path at the listed commit: nothing to reset, the checkout is skipped', async () => {
  const sb = claimSandbox({ git: { 'ls-tree': () => ({ stdout: 'src/Vault.sol\0test/Vault.t.sol\0' }) } });
  const r = await runClaim(sb);
  assert.equal(gitCalls(sb, 'checkout').length, 0);
  assert.equal(r.facts.protectedReset, 0);
});

// -------------------------------------------------------------------- build

test('build: the build command\'s exit code decides the gate (tier A); a failed build stops before the PoC', async () => {
  const sb = claimSandbox({ scripts: { 'vcr-build': () => ({ exitCode: 1, stderr: 'Error: Compiler run failed:\n' }) } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'definitive');
  assert.deepEqual(r.gates.build, { status: 'fail', basis: 'exit_code', detail: 'the build command exited 1' });
  assert.equal(pocRuns(sb).length, 0);
  const [build] = sb.execs().filter((d) => d.kind === 'vcr-build');
  assert.deepEqual(build.argv, ['/bin/sh', '-c', 'set -f; forge build', 'vcr-build']);
  assert.equal(build.env.FOUNDRY_FUZZ_SEED, FORGE_FUZZ_SEED);
});

test('build: gates come only from definitive results; an OOM-killed build abstains with no build gate', async () => {
  for (const kill of [{ exitCode: 137 }, { exitCode: 1, oom: true }]) {
    let oomed = false;
    const sb = claimSandbox({ scripts: { 'vcr-build': () => { oomed = Boolean(kill.oom); return { exitCode: kill.exitCode }; } } });
    // The kernel's OOM flag on the container (A1's inspection after the step).
    const inspect = sb.docker.run;
    sb.docker.run = async (args, opts) => {
      if (oomed && args[0] === 'inspect' && args.includes('{{json .State}}')) {
        if (opts.stdout) opts.stdout.write(Buffer.from(JSON.stringify({ Status: 'running', Running: true, OOMKilled: true, ExitCode: 0 })));
        return { exitCode: 0, signal: null, timedOut: false, aborted: false, spawnError: null, durationMs: 0 };
      }
      return inspect(args, opts);
    };
    const r = await runClaim(sb);
    assert.equal(r.outcome, 'abstain', JSON.stringify(kill));
    assert.equal(r.abstain.cause, 'oom');
    assert.equal(r.abstain.step, 'build');
    assert.equal(r.gates.build, undefined, 'no gate from an abstaining step');
    assert.equal(r.gates.reproduces, undefined);
  }
});

// ---------------------------------------------------- PoC runs and reproduces

test('PoC runs: testFiles on the hunter\'s files, then testIds twice, each with --junit and the fixed --fuzz-seed', async () => {
  const sb = claimSandbox({
    git: {
      'diff --name-status': () => ({ stdout: 'A\0test/Exploit.t.sol\0A\0test/data.json\0A\0test/sub/More.t.sol\0' }),
      'diff --numstat': () => ({ stdout: '3\t0\ttest/Exploit.t.sol\0' + '1\t0\ttest/data.json\0' + '2\t0\ttest/sub/More.t.sol\0' })
    }
  });
  await runClaim(sb);
  const runs = pocRuns(sb);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs[0].argv, ['/bin/sh', '-c', 'set -f; forge test --match-path $FILES "$@"', 'vcr-poc', '--junit', '--fuzz-seed', FORGE_FUZZ_SEED]);
  assert.equal(runs[0].env.FILES, '{test/Exploit.t.sol,test/sub/More.t.sol}', 'the Solidity files the patch added or changed');
  for (const run of runs.slice(1)) {
    assert.deepEqual(run.argv, ['/bin/sh', '-c', 'set -f; forge test --match-test $TEST_IDS "$@"', 'vcr-poc', '--junit', '--fuzz-seed', FORGE_FUZZ_SEED]);
    assert.equal(run.env.TEST_IDS, '^(?:test_drain\\(\\))$');
  }
  for (const run of runs) assert.equal(run.env.FOUNDRY_FUZZ_SEED, FORGE_FUZZ_SEED);
});

test('reproduces: any pass on any run fails the gate, and the detail names the test and the run', async () => {
  const passing = junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()' }] }]);
  const sb = claimSandbox({ poc: [drainFails(), passing, drainFails()] });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'definitive');
  assert.equal(r.gates.reproduces.status, 'fail');
  assert.equal(r.gates.reproduces.basis, 'junit');
  assert.equal(r.gates.reproduces.detail, 'test/Exploit.t.sol > ExploitTest > test_drain() passed on run 2');
  assert.deepEqual(r.facts.poc.tests[0].runs, ['fail', 'pass', 'fail']);
  assert.equal(pocRuns(sb).length, 3, 'the schedule is fixed: all three runs, whatever run 1 showed');
});

test('reproduces: an error on any run fails it (a refused cheatcode, an EVM error, an <error> record)', async () => {
  for (const [message, re] of [
    ['vm.ffi: FFI is disabled; add the `--ffi` flag to allow tests to call external commands', /errored on run 3 \(vm\.ffi: FFI is disabled/],
    ['EvmError: OutOfGas', /errored on run 3 \(EvmError: OutOfGas\)/]
  ]) {
    const sb = claimSandbox({ poc: [drainFails(), drainFails(), drainFails(message)] });
    const r = await runClaim(sb);
    assert.equal(r.gates.reproduces.status, 'fail', message);
    assert.match(r.gates.reproduces.detail, re);
    assert.deepEqual(r.facts.poc.tests[0].runs, ['fail', 'fail', 'error']);
  }
});

test('poc-fails-by-import-error: a PoC that errors before any assertion fails reproduces (no JUnit, setUp, constructor, a missing artifact)', async () => {
  const setUp = junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'setUp()', failure: 'setup broke' }] }]);
  const ctor = junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'constructor()', failure: 'ctor broke' }] }]);
  const artifact = drainFails('vm.getCode: no matching artifact found');
  const cases = [
    // forge exits 1 and prints no JUnit when the PoC does not compile (an import that does not resolve).
    [[() => ({ exitCode: 1, stdout: '', stderr: 'Error: Compiler run failed:\nError (6275): Source "src/Missing.sol" not found\n' })], /no JUnit on run 1/],
    [[setUp, setUp, setUp], /setUp\(\) failed in test\/Exploit\.t\.sol:ExploitTest on run 1: setup broke/],
    [[ctor, ctor, ctor], /constructor\(\) failed in test\/Exploit\.t\.sol:ExploitTest on run 1: ctor broke/],
    [[artifact, artifact, artifact], /errored on run 1 \(vm\.getCode: no matching artifact found\)/]
  ];
  for (const [poc, re] of cases) {
    const sb = claimSandbox({ poc });
    const r = await runClaim(sb);
    assert.equal(r.outcome, 'definitive');
    assert.equal(r.gates.build.status, 'pass');
    assert.equal(r.gates.reproduces.status, 'fail');
    assert.match(r.gates.reproduces.detail, re);
  }
});

test('R1-F1: a PoC test whose body never ran (no reason, or forge\'s (gas: 0)) errors on reproduces', async () => {
  const noReason = junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()', failure: '' }] }]).replace('<failure message=""/>', '<failure/>');
  const table = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Test run">\n<testsuite name="test/Exploit.t.sol:ExploitTest">'
    + '<testcase name="table_poc(uint256)"><failure message="x"/><system-out>[FAIL: x] table_poc(uint256) (gas: 0)</system-out></testcase></testsuite>\n</testsuites>\n';
  for (const [poc, re] of [[noReason, /test_drain\(\) errored on run 1$/], [table, /table_poc\(uint256\) errored on run 1 \(x\)/]]) {
    const sb = claimSandbox({ poc: [poc, poc, poc] });
    const r = await runClaim(sb);
    assert.equal(r.gates.reproduces.status, 'fail');
    assert.match(r.gates.reproduces.detail, re);
    assert.equal(r.facts.poc.tests[0].kind, 'error');
  }
});

test('reproduces: a JUnit a test forged on stdout (two documents) is unreadable, an error, never a result', async () => {
  const forged = drainFails() + drainFails();
  const sb = claimSandbox({ poc: [drainFails(), forged, drainFails()] });
  const r = await runClaim(sb);
  assert.equal(r.gates.reproduces.status, 'fail');
  assert.match(r.gates.reproduces.detail, /unreadable JUnit on run 2/);
  assert.equal(r.facts.poc.runs[1].junit, 'invalid');
  assert.deepEqual(r.facts.poc.tests[0].runs, ['fail', 'error', 'fail']);
});

test('reproduces: a missing record, a duplicate record and a skip fail it', async () => {
  const none = junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [] }]);
  const dup = junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()', failure: 'a' }, { name: 'test_drain()', failure: 'a' }] }]);
  const skip = junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()', skipped: true }] }]);
  for (const [run2, word, result] of [[none, 'missing', 'missing'], [dup, 'duplicated', 'duplicate'], [skip, 'skipped', 'skip']]) {
    const sb = claimSandbox({ poc: [drainFails(), run2, drainFails()] });
    const r = await runClaim(sb);
    assert.equal(r.gates.reproduces.status, 'fail', word);
    assert.equal(r.gates.reproduces.detail, `test/Exploit.t.sol > ExploitTest > test_drain() ${word} on run 2`);
    assert.equal(r.facts.poc.tests[0].runs[1], result);
  }
});

test('reproduces: the tests the patch added are the ones not in baseline.json; every one must fail', async () => {
  const both = junit([{
    suite: 'test/Vault.t.sol:VaultTest',
    cases: [{ name: 'test_deposit()' }, { name: 'test_new()', failure: 'x' }]
  }]);
  const sb = claimSandbox({
    poc: [both, both, both],
    git: {
      'diff --name-status': () => ({ stdout: 'M\0test/Vault.t.sol\0' }),
      'diff --numstat': () => ({ stdout: '1\t0\ttest/Vault.t.sol\0' })
    }
  });
  const r = await runClaim(sb);
  assert.equal(r.gates.reproduces.status, 'pass', r.gates.reproduces.detail);
  assert.deepEqual(r.facts.poc.tests.map((t) => t.id), ['test/Vault.t.sol > VaultTest > test_new()']);

  const twoAdded = junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_a()', failure: 'x' }, { name: 'test_b()' }] }]);
  const sb2 = claimSandbox({ poc: [twoAdded, twoAdded, twoAdded] });
  const r2 = await runClaim(sb2);
  assert.equal(r2.gates.reproduces.status, 'fail');
  assert.equal(r2.gates.reproduces.detail, 'test/Exploit.t.sol > ExploitTest > test_b() passed on run 1');
  assert.equal(pocRuns(sb2)[1].env.TEST_IDS, '^(?:test_a\\(\\)|test_b\\(\\))$');
});

test('reproduces: a patch whose run shows no added test fails; runs 2 and 3 are not run', async () => {
  const empty = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Test run" tests="0" skipped="0" failures="0" errors="0" timestamp="x" time="0">\n</testsuites>\n';
  const sb = claimSandbox({ poc: [() => ({ exitCode: 0, stdout: empty })] });
  const r = await runClaim(sb);
  assert.equal(r.gates.reproduces.status, 'fail');
  assert.equal(r.gates.reproduces.detail, 'no test the patch added ran on run 1');
  assert.equal(pocRuns(sb).length, 1);
  assert.deepEqual(r.facts.poc.runCounts, { fail: 0, pass: 0, error: 0, skip: 0, missing: 0, duplicate: 0, notRun: 0 });
});

test('reproduces: a patch with no Solidity file under paths.tests has no PoC to run', async () => {
  const sb = claimSandbox({
    git: {
      'diff --name-status': () => ({ stdout: 'A\0test/data.json\0' }),
      'diff --numstat': () => ({ stdout: '1\t0\ttest/data.json\0' })
    }
  });
  const r = await runClaim(sb);
  assert.equal(r.gates.reproduces.status, 'fail');
  assert.match(r.gates.reproduces.detail, /adds or changes no Solidity file/);
  assert.equal(pocRuns(sb).length, 0);
});

test('reproduces: the schedule never depends on time left (a near deadline and a far one run the same execs)', async () => {
  const passing = junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()' }] }]);
  const shapes = [];
  for (const deadlineMs of [310000, 900000]) {
    const sb = claimSandbox({ poc: [passing, drainFails(), drainFails()] });
    const r = await runClaim(sb, claimRequest(), { deadlineMs });
    shapes.push({ execs: sb.execs().map((d) => [d.kind, d.sub && d.sub[0]]), gates: r.gates, poc: r.facts.poc });
  }
  assert.deepEqual(shapes[0], shapes[1]);
});

test('reproduces: a PoC run that hits its time limit abstains; the gate is not decided on it', async () => {
  const { never } = require('../helpers/fakeDocker');
  const sb = claimSandbox({ poc: [drainFails(), () => never(), drainFails()] });
  const r = await runClaim(sb, claimRequest({ spec: forgeSpec({ limits: { testSeconds: 1 } }) }));
  assert.equal(r.outcome, 'abstain');
  assert.equal(r.abstain.cause, 'step_timeout');
  assert.equal(r.abstain.step, 'poc:2');
  assert.equal(r.gates.reproduces, undefined);
});

// ---------------------------------------------- leftover processes, between runs

test('claim processes that outlive a step are killed before the next one; the work tree is reset to the PoC commit between runs', async () => {
  let n = 0;
  const sb = claimSandbox({ scripts: { 'vcr-cleanup': () => { n += 1; return { stdout: `killed ${n === 2 ? 3 : 0}\n` }; } } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'definitive');
  const cleanups = sb.execs().filter((d) => d.kind === 'vcr-cleanup');
  assert.equal(cleanups.length, 4, 'after the build and after each PoC run');
  for (const c of cleanups) assert.deepEqual(c.argv.slice(4), ['1', '7'], 'the processes found before any claim code ran are kept');
  assert.deepEqual(r.facts.leftoverProcesses, [{ after: 'build', killed: 0 }, { after: 'poc:1', killed: 3 }, { after: 'poc:2', killed: 0 }, { after: 'poc:3', killed: 0 }]);
  for (const reset of gitCalls(sb, 'reset')) assert.deepEqual(reset.sub, ['reset', '--quiet', '--hard', POC]);
});

test('a sandbox whose leftover processes cannot be stopped abstains', async () => {
  const sb = claimSandbox({ scripts: { 'vcr-cleanup': () => ({ exitCode: 3, stdout: 'killed 4096\n' }) } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'abstain');
  assert.equal(r.abstain.cause, 'docker_error');
  assert.match(r.abstain.detail, /could not be stopped/);
});

// ---------------------------------------- the requester's package, before any claim code

test('the requester\'s package: an unsupported framework or env, a command the adapter needs, a broken checkout', async () => {
  const cases = [
    [claimRequest({ spec: forgeSpec({ commands: { framework: 'vitest' } }) }), 'FRAMEWORK_UNSUPPORTED'],
    [claimRequest({ spec: forgeSpec({ env: { image: IMAGE, from: 'node22', platform: 'linux/amd64', unpackedBytes: 1 } }) }), 'ENV_UNSUPPORTED'],
    [claimRequest({ spec: forgeSpec({ commands: { testIds: undefined } }) }), 'COMMAND_MISSING'],
    [claimRequest({ spec: forgeSpec({ commands: { testFiles: 'forge test' } }) }), 'COMMAND_PLACEHOLDER'],
    [claimRequest({ spec: forgeSpec({ commands: { build: 'forge build\u0000' } }) }), 'COMMAND_INVALID'],
    [claimRequest({ baseline: { tests: 'nope' } }), 'BASELINE_INVALID']
  ];
  for (const [request, code] of cases) {
    const sb = claimSandbox();
    const r = await runClaim(sb, request);
    assert.equal(r.outcome, 'requester_error', code);
    assert.deepEqual(r.issues.map((i) => i.code), [code]);
    assert.deepEqual(sb.execs().map((d) => d.kind), [], 'no claim step ran');
  }
});

test('the requester\'s package: the env image\'s checkout is missing, not a repository, unreadable, at another commit, or dirty', async () => {
  const cases = [
    [{ scripts: { 'vcr-checkout': () => ({ exitCode: 10 }) } }, 'IMAGE_CHECKOUT_MISSING'],
    [{ scripts: { 'vcr-checkout': () => ({ exitCode: 11 }) } }, 'IMAGE_CHECKOUT_NOT_GIT'],
    [{ scripts: { 'vcr-checkout': () => ({ exitCode: 12, stderr: 'cp: cannot open \'/repo/secret\' for reading: Permission denied\n' }) } }, 'IMAGE_CHECKOUT_UNREADABLE'],
    [{ git: { 'rev-parse': (d) => ({ stdout: d.sub.includes('--git-common-dir') ? '/work/.git\n/work/.git\n' : `${'1'.repeat(40)}\n` }) } }, 'IMAGE_CHECKOUT_MISMATCH'],
    [{ git: { status: () => ({ stdout: ' M foundry.toml\0' }) } }, 'IMAGE_CHECKOUT_DIRTY'],
    [{ scripts: { 'vcr-checkout': () => ({ exitCode: 13 }) } }, 'IMAGE_CHECKOUT_GIT_REDIRECT'],
    [{ git: { 'rev-parse': (d) => ({ stdout: d.sub.includes('--git-common-dir') ? '/work/.git\n/work/.git-common\n' : `${BASE}\n` }) } }, 'IMAGE_CHECKOUT_GIT_REDIRECT'],
    [{ scripts: { 'vcr-checkout': () => ({ exitCode: 14 }) } }, 'IMAGE_CHECKOUT_NOT_GIT'],
    [{ git: { 'read-tree': () => ({ exitCode: 128, stderr: 'fatal: failed to unpack tree object HEAD\n' }) } }, 'IMAGE_CHECKOUT_NOT_GIT'],
    [{ git: { submodule: () => ({ exitCode: 1, stderr: 'fatal: run_command returned non-zero status for lib/x\n' }) } }, 'IMAGE_CHECKOUT_GIT_REDIRECT']
  ];
  for (const [over, code] of cases) {
    const sb = claimSandbox(over);
    const r = await runClaim(sb);
    assert.equal(r.outcome, 'requester_error', code);
    assert.deepEqual(r.issues.map((i) => i.code), [code]);
    assert.equal(gitCalls(sb, 'apply').length, 0, 'the patch is never applied');
    assert.equal(pocRuns(sb).length, 0);
  }
});

test('the checkout is copied into the empty /work before any step, as the sandbox user', async () => {
  const sb = claimSandbox();
  await runClaim(sb);
  const [procs, checkout] = sb.execs();
  assert.equal(procs.kind, 'vcr-procs');
  assert.equal(checkout.kind, 'vcr-checkout');
  assert.deepEqual(checkout.argv.slice(4), ['/repo', NEUTRAL_ATTRIBUTES]);
});

test('R1-F3: the repository\'s attribute drivers are switched off before git touches the patch: no filter, textconv, conversion or ident', async () => {
  assert.equal(NEUTRAL_ATTRIBUTES, '* !filter !diff !merge !text !eol !ident !working-tree-encoding');
  // Written to .git/info/attributes (the source above the repository's own .gitattributes) by the copy step,
  // which refuses a git directory that keeps its metadata elsewhere.
  for (const f of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates', 'info/grafts']) assert.ok(CHECKOUT_SCRIPT.includes(f), f);
  assert.match(CHECKOUT_SCRIPT, /printf "%s\\n" "\$2" > \/work\/\.git\/info\/attributes/);
  assert.match(CHECKOUT_SCRIPT, /rm -f \/work\/\.git\/info\/attributes/);
  const sb = claimSandbox();
  await runClaim(sb);
  const order = sb.execs().map((d) => (d.kind === 'git' ? `git ${d.sub[0]}` : d.kind));
  assert.ok(order.indexOf('vcr-checkout') < order.indexOf('git apply'));
});

test('R1-F4: the copied index is rebuilt from HEAD (repository and submodules) before the clean check, so no flag can hide a change', async () => {
  const sb = claimSandbox();
  await runClaim(sb);
  const order = sb.execs().map((d) => (d.kind === 'git' ? `git ${d.sub[0]}` : d.kind));
  assert.deepEqual(order.slice(2, 8), ['git rev-parse', 'git rev-parse', 'git read-tree', 'git submodule', 'git update-index', 'git status']);
  assert.deepEqual(gitCalls(sb, 'read-tree')[0].sub, ['read-tree', 'HEAD']);
  assert.deepEqual(gitCalls(sb, 'submodule')[0].sub, ['submodule', 'foreach', '--quiet', '--recursive', SUBMODULE_INDEX_SCRIPT]);
  // Each submodule's repository gets the superproject's rules: self-contained, attributes neutralised, index rebuilt.
  for (const part of ['--git-common-dir', 'commondir objects/info/alternates', 'find "$gd" -type l', `'${NEUTRAL_ATTRIBUTES}' > "$gd/info/attributes"`, 'git read-tree HEAD']) {
    assert.ok(SUBMODULE_INDEX_SCRIPT.includes(part), part);
  }
  assert.ok(SUBMODULE_INDEX_SCRIPT.indexOf('info/attributes') < SUBMODULE_INDEX_SCRIPT.indexOf('read-tree'), 'neutralised before the index is refreshed');
  for (const c of ['core.ignoreStat=false', 'core.sparseCheckout=false', 'index.sparse=false']) {
    assert.ok(gitCalls(sb, 'status')[0].argv.includes(c), c);
  }
});

test('facts: the patch\'s size, hash and expansion are recorded', async () => {
  const sb = claimSandbox();
  const r = await runClaim(sb);
  const crypto = require('node:crypto');
  assert.deepEqual(r.facts.patch, {
    bytes: Buffer.byteLength(POC_PATCH),
    sha256: crypto.createHash('sha256').update(POC_PATCH).digest('hex'),
    expansionBytes: r.facts.patch.expansionBytes,
    binaryHunks: 0
  });
  assert.ok(r.facts.patch.expansionBytes > 0);
});
