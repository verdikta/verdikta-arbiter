'use strict';

// Node A3a acceptance through the run engine against the fake env image
// (test/helpers/fakeClaim.js): the five §9.5 integrity checks on the PoC's
// three runs, each catalogue fixture by name, claimedObservable, and the
// evidence tiers. The same fixtures run against real forge, in their forge
// forms, in test/docker/integrity.docker.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeRun } = require('../../src/pipeline');
const { checkSpec } = require('../../src/classLimits');
const { claimSteps } = require('../../src/steps');
const { createServer } = require('../../src/server');
const { testConfig, request: httpRequest } = require('../helpers/http');
const { spec: baseSpec, IMAGE, attestationFor } = require('../helpers/requests');
const { BASE, POC_PATCH, POC_DIFF, junit, drainFails, claimSandbox, fakeSolcList } = require('../helpers/fakeClaim');
const { settlementFacts } = require('../helpers/settlementFacts');
const { assembleReport } = require('../../src/report');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const DRAIN = 'test/Exploit.t.sol > ExploitTest > test_drain()';

function forgeSpec(over = {}) {
  return baseSpec({
    baseCommit: BASE,
    commands: {
      framework: 'forge', build: 'forge build', test: 'forge test',
      testFiles: 'forge test --match-path $FILES', testIds: 'forge test --match-test $TEST_IDS', ...(over.commands || {})
    },
    paths: over.paths || { tests: ['test/**'], protected: ['foundry.toml', 'lib/**'] },
    limits: { cpus: 1, memoryMb: 512, buildSeconds: 30, testSeconds: 60, runSeconds: 300, maxPatchBytes: 2000000 }
  });
}

/** finding.json naming test_drain and quoting its failure. */
function finding(poc = {}) {
  return {
    version: 1, claimedClass: 'HIGH', rootCause: 'Vault.deposit credits one wei more than it receives, so balances overstate deposits.',
    affectedPaths: ['src/Vault.sol'],
    poc: { command: 'forge test --match-test test_drain', observable: 'test_drain fails at the committed hash with "vault drained"', ...poc }
  };
}

function claimRequest(over = {}) {
  return {
    listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    bcid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    spec: over.spec || forgeSpec(),
    attestation: {},
    pocPatch: over.pocPatch || Buffer.from(POC_PATCH),
    fixPatch: over.fixPatch || null,
    baseline: { version: 1, baseCommit: BASE, framework: 'forge', runs: 3, tests: [{ id: 'test/Vault.t.sol > VaultTest > test_deposit()', results: ['pass', 'pass', 'pass'] }], stable: ['test/Vault.t.sol > VaultTest > test_deposit()'], unstable: [] },
    finding: over.finding || finding(),
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

const show = (r) => JSON.stringify({ outcome: r.outcome, abstain: r.abstain, issues: r.issues, gates: r.gates, integrity: r.facts && r.facts.poc && r.facts.poc.integrity }, null, 1);
const set = (box, p, content) => box.tree.set(p, { type: 'f', mode: '644', content });
const hasFailureText = (text) => /<(?:failure|error)\b/.test(String(text));
const label = (d) => (d.kind === 'git' ? `git ${d.sub[0]}` : d.kind);
const CLEAN = Object.freeze({
  identityComplete: true, summaryConsistent: true, exitConsistent: true,
  protectedPathsUnchanged: true, frameworkUnchanged: true, dependenciesUnchanged: true, tamperFlags: []
});

/** A run whose PoC passes everything but `checks`, whose failure the integrity gate names. */
function assertIntegrityFails(r, checks, re) {
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.integrity.status, 'fail', show(r));
  assert.equal(r.gates.integrity.basis, 'integrity');
  for (const c of checks) assert.match(r.gates.integrity.detail, new RegExp(`\\b${c}\\b`), `${c} is named: ${r.gates.integrity.detail}`);
  if (re) assert.match(r.gates.integrity.detail, re);
  // Any failed check fails reproduces with it (§9.5), and claimedObservable is not decided.
  assert.equal(r.gates.reproduces.status, 'fail');
  assert.equal(r.gates.claimedObservable, undefined, 'claimedObservable is decided only on a PoC that reproduced');
  const failed = Object.entries(r.facts.poc.integrity).filter(([k, v]) => k !== 'tamperFlags' && v === false).map(([k]) => k);
  for (const c of checks.filter((x) => x !== 'tamperFlags')) assert.ok(failed.includes(c), `${c} is false: ${JSON.stringify(r.facts.poc.integrity)}`);
}

// --------------------------------------------------------------- a clean claim

test('an ordinary claim passes every integrity check: forge\'s out/, cache/ and $HOME cache writes and the runner\'s own resets raise nothing', async () => {
  const sb = claimSandbox();
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'definitive', show(r));
  for (const g of ['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable']) assert.equal(r.gates[g].status, 'pass', `${g}: ${show(r)}`);
  assert.equal(r.gates.integrity.basis, 'integrity');
  assert.equal(r.gates.claimedObservable.basis, 'junit');
  assert.deepEqual(r.facts.poc.integrity, CLEAN);
  // The reference before any maker command (the image plus the accepted patch), then one snapshot after every run;
  // after each of the runner's resets only its repository is read again.
  const order = sb.execs().map(label);
  const from = order.indexOf('git rev-parse', order.indexOf('git commit'));
  assert.deepEqual(order.slice(from + 1), [
    // The context pack (A3b): from git's objects, before any maker command.
    'git diff', 'git cat-file', 'git cat-file', 'git ls-tree',
    'vcr-framework', 'forge-config', 'vcr-external-roots', 'vcr-manifest', 'vcr-build', 'vcr-cleanup', 'vcr-manifest',
    // After a run: the files are measured first, then forge runs for its configuration (R1-F3).
    'vcr-poc', 'vcr-cleanup', 'vcr-manifest', 'vcr-framework', 'forge-config',
    'git reset', 'vcr-manifest', 'vcr-poc', 'vcr-cleanup', 'vcr-manifest', 'vcr-framework', 'forge-config',
    'git reset', 'vcr-manifest', 'vcr-poc', 'vcr-cleanup', 'vcr-manifest', 'vcr-framework', 'forge-config'
  ]);
  const manifests = sb.execs().filter((d) => d.kind === 'vcr-manifest');
  // Every snapshot is hermetic (nothing of the image's environment reaches find or sha256sum).
  for (const m of manifests) assert.deepEqual(m.launched.slice(0, 2), ['/usr/bin/env', '-i']);
  assert.deepEqual(manifests[0].argv.slice(4, 6), ['/work', '/home/sandbox']);
  assert.deepEqual(manifests[3].argv.slice(4), ['/work/.git', '-xdev'], 'after a reset: the runner\'s repository only');
  // The framework probe's discovery reads the image's PATH, forge from the reference's own path afterwards; forge's
  // configuration is read as the maker's commands run forge (attempt 3: the same argv, environment and directory).
  const probes = sb.execs().filter((d) => d.kind === 'vcr-framework');
  assert.equal(probes[0].launched[0], '/bin/sh');
  assert.deepEqual(probes.slice(2).map((p) => p.argv[4]), ['/usr/local/bin/forge', '/usr/local/bin/forge', '/usr/local/bin/forge'], 'before any patch and at the reference: discovery; then forge\'s own path');
  const [build] = sb.execs().filter((d) => d.kind === 'vcr-build');
  const [listed, ...configs] = sb.execs().filter((d) => d.kind === 'forge-config');
  for (const config of configs) assert.deepEqual(config.launched, [...build.launched.slice(0, -1), 'config', '--json']);
  // The one read without the pin, on the listing's own files.
  assert.deepEqual(listed.launched, [...build.launched.filter((a) => !/^FOUNDRY_(?:SOLC|EXTERNAL_COMPILERS)=/.test(a)).slice(0, -1), 'config', '--json']);
});

test('every fact carries its tier: A for what the runner observed from outside, B for results from a process that ran claim code', async () => {
  const sb = claimSandbox();
  const r = await runClaim(sb, claimRequest({ fixPatch: Buffer.from(require('../helpers/fakeClaim').FIX_PATCH) }));
  assert.equal(r.outcome, 'definitive', show(r));
  const want = {
    checkout: 'A', compiler: 'A', patch: 'A', commit: 'A', diff: 'A', testPaths: 'A', flags: 'A', protectedReset: 'A', leftoverProcesses: 'A',
    poc: 'B', integrity: 'A', fix: 'B'
  };
  assert.deepEqual(Object.keys(r.facts).sort(), Object.keys(want).sort());
  for (const [name, tier] of Object.entries(want)) assert.equal(r.facts[name].tier, tier, name);
  // Nested facts of the fix check carry their own tier.
  assert.equal(r.facts.fix.patch.tier, 'A');
  assert.equal(r.facts.fix.diff.tier, 'A');
  assert.equal(r.facts.fix.checkout.tier, 'A');
  // Gates name the basis they were decided on; the basis maps to a tier (exit_code and input A, junit B, integrity A).
  for (const [g, v] of Object.entries(r.gates)) assert.ok(['exit_code', 'input', 'junit', 'integrity'].includes(v.basis), g);
});

// ------------------------------------------------------- the catalogue fixtures

test('junit-forged-early-exit: the test command exits before forge\'s summary with a JUnit that reports the PoC failing: exit-code and summary consistency fail', async () => {
  // The forged record carries no forge suite summary and the command exits 0 although it reports a failure.
  const forged = junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()', failure: 'vault drained' }] }], { summary: false });
  const run = () => ({ exitCode: 0, stdout: forged });
  const sb = claimSandbox({ poc: [run, run, run] });
  const r = await runClaim(sb);
  assertIntegrityFails(r, ['summaryConsistent', 'exitConsistent'], /run 1: test\/Exploit\.t\.sol:ExploitTest has no forge suite summary/);
  assert.match(r.gates.integrity.detail, /run 1: the test command exited 0, but the JUnit records 1 failure/);
  assert.equal(r.gates.reproduces.basis, 'integrity', 'the JUnit alone would have passed it: the integrity checks decided');
  assert.match(r.gates.reproduces.detail, /not trusted/);
  // The forged records are kept as what was observed, but they are not trusted evidence.
  assert.deepEqual(r.facts.poc.tests[0].runs, ['fail', 'fail', 'fail']);
  assert.equal(r.facts.poc.integrity.identityComplete, true);
});

test('protected-file-modified-at-runtime: the framework configuration\'s bytes differ after a run: post-run checksums fail', async () => {
  const sb = claimSandbox({
    poc: [(d, run, box) => { set(box, '/work/foundry.toml', '[profile.default]\nffi = true\n'); return { exitCode: 1, stdout: drainFails() }; }, drainFails(), drainFails()]
  });
  const r = await runClaim(sb);
  assertIntegrityFails(r, ['protectedPathsUnchanged', 'frameworkUnchanged'], /protectedPathsUnchanged \(run 1: foundry\.toml changed/);
  // forge's resolved configuration changed with it.
  assert.match(r.gates.integrity.detail, /frameworkUnchanged \(run 1: foundry\.toml changed; run 1: forge's resolved configuration changed/);
  // The runner's reset put the tracked file back before run 2: only run 1 saw it changed.
  assert.doesNotMatch(r.gates.integrity.detail, /run 2/);
  assert.equal(r.facts.poc.integrity.dependenciesUnchanged, true);
  assert.deepEqual(r.facts.integrity.poc.changed.protected, ['foundry.toml']);
});

test('reporter-monkeypatched: test code patches forge-std\'s assertion module: the static tamper flag and the post-run checksum of the reporter module fire', async () => {
  const diff = [
    'diff --git a/test/Exploit.t.sol b/test/Exploit.t.sol', 'new file mode 100644', 'index 0000000..95fbe20', '--- /dev/null', '+++ b/test/Exploit.t.sol',
    '@@ -0,0 +1,4 @@',
    '+contract ExploitTest {',
    '+  /// forge-config: default.fs_permissions = [{ access = "read-write", path = "./" }]',
    '+  function test_drain() public { vm.writeFile("lib/forge-std/src/Test.sol", "// patched"); revert("vault drained"); }',
    '+}', ''
  ].join('\n');
  const patch = (d, run, box) => { set(box, '/work/lib/forge-std/src/Test.sol', '// patched'); return { exitCode: 1, stdout: drainFails() }; };
  const sb = claimSandbox({ diff, poc: [patch, drainFails(), drainFails()] });
  const r = await runClaim(sb);
  assertIntegrityFails(r, ['frameworkUnchanged', 'dependenciesUnchanged', 'protectedPathsUnchanged', 'tamperFlags'], /reporter-patched at test\/Exploit\.t\.sol:3/);
  assert.deepEqual(r.facts.poc.integrity.tamperFlags, [
    { kind: 'framework-patched', file: 'test/Exploit.t.sol', line: 2 },
    { kind: 'reporter-patched', file: 'test/Exploit.t.sol', line: 3 }
  ]);
  assert.match(r.gates.integrity.detail, /frameworkUnchanged \(run 1: lib\/forge-std\/src\/Test\.sol changed/);
});

test('reporter-monkeypatched: the static flag alone fails integrity even when nothing was left changed', async () => {
  const diff = POC_DIFF.replace('+// end', '+// vm.writeFile("lib/forge-std/src/StdAssertions.sol", "")');
  const sb = claimSandbox({ diff });
  const r = await runClaim(sb);
  assertIntegrityFails(r, ['tamperFlags']);
  assert.deepEqual(r.facts.poc.integrity, { ...CLEAN, tamperFlags: [{ kind: 'reporter-patched', file: 'test/Exploit.t.sol', line: 3 }] });
});

test('dependencies-edited-during-run: an installed dependency (node_modules, an untracked lib/ file) differs after a run: the dependency checksums fail', async () => {
  const OZ = '/work/node_modules/@openzeppelin/contracts/token/ERC20/ERC20.sol';
  const LIB = '/work/lib/solady/src/tokens/ERC20.sol';
  for (const [file, rel, run] of [[OZ, 'node_modules/@openzeppelin/contracts/token/ERC20/ERC20.sol', 2], [LIB, 'lib/solady/src/tokens/ERC20.sol', 3]]) {
    const edit = (d, k, box) => { if (k === run) set(box, file, '// drained'); return { exitCode: 1, stdout: drainFails() }; };
    const sb = claimSandbox({ onBox: (box) => set(box, file, 'contract ERC20 {}\n'), poc: [edit, edit, edit] });
    const r = await runClaim(sb);
    assertIntegrityFails(r, ['dependenciesUnchanged'], new RegExp(`dependenciesUnchanged \\(run ${run}: ${rel.replace(/[./@]/g, '\\$&')} changed`));
    assert.equal(r.facts.poc.integrity.frameworkUnchanged, true, rel);
  }
  // A new file in a dependency directory counts too (an injected contract a later run would compile).
  const add = (d, k, box) => { if (k === 1) set(box, '/work/lib/evil/src/Evil.sol', 'contract Evil {}'); return { exitCode: 1, stdout: drainFails() }; };
  const r2 = await runClaim(claimSandbox({ poc: [add, add, add] }));
  assertIntegrityFails(r2, ['dependenciesUnchanged'], /run 1: lib\/evil\/src\/Evil\.sol added/);
});

test('test-report-missing-identity: a test the patch added has no record (or a skipped one) on a run: identity completeness fails', async () => {
  const none = junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [] }]);
  const skip = junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()', skipped: true }] }]);
  for (const [run2, word] of [[none, 'has no record'], [skip, 'is skipped']]) {
    const sb = claimSandbox({ poc: [drainFails(), run2, drainFails()] });
    const r = await runClaim(sb);
    assert.equal(r.gates.integrity.status, 'fail', show(r));
    assert.match(r.gates.integrity.detail, new RegExp(`identityComplete \\(run 2: ${DRAIN.replace(/[()]/g, '\\$&')} ${word}`));
    assert.equal(r.facts.poc.integrity.identityComplete, false);
    // A missing record is not a demonstrated failure: reproduces fails on it too.
    assert.equal(r.gates.reproduces.status, 'fail');
    assert.equal(r.gates.claimedObservable, undefined);
  }
});

test('test-report-duplicate-identity: one identity twice with different results: identity completeness fails and neither record is trusted', async () => {
  const dup = junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()', failure: 'vault drained' }, { name: 'test_drain()' }] }]);
  const sb = claimSandbox({ poc: [dup, drainFails(), drainFails()] });
  const r = await runClaim(sb);
  assert.equal(r.gates.integrity.status, 'fail', show(r));
  assert.match(r.gates.integrity.detail, /identityComplete \(run 1: test\/Exploit\.t\.sol > ExploitTest > test_drain\(\) has 2 records/);
  assert.equal(r.facts.poc.integrity.identityComplete, false);
  assert.equal(r.facts.poc.tests[0].runs[0], 'duplicate', 'neither record counts as the run\'s result');
  assert.equal(r.gates.reproduces.status, 'fail');
});

test('claimed-observable-mismatch: finding.json names a test other than the ones that failed, or an observable absent from the failure: claimedObservable fails', async () => {
  const cases = [
    [{ command: 'forge test --match-test test_deposit', observable: 'test_deposit fails with "vault drained"' }, /names test_deposit, which is not a test the patch added that failed/],
    [{ command: 'forge test --match-path test/Exploit.t.sol', observable: 'the vault is drained in one call: "vault emptied"' }, /names none of the tests the patch added \(test_drain\)/],
    [{ observable: 'test_drain fails with "vault emptied"' }, /"vault emptied" is not in the recorded failure of test_drain on every run/],
    [{ observable: 'test_drain shows that the vault over-credits deposits' }, /quotes no failure text, and the recorded failure of test_drain \("vault drained"\) is not in it/]
  ];
  for (const [poc, re] of cases) {
    const sb = claimSandbox();
    const r = await runClaim(sb, claimRequest({ finding: finding(poc) }));
    assert.equal(r.outcome, 'definitive', show(r));
    assert.equal(r.gates.reproduces.status, 'pass');
    assert.equal(r.gates.integrity.status, 'pass');
    assert.equal(r.gates.claimedObservable.status, 'fail', JSON.stringify(poc));
    assert.equal(r.gates.claimedObservable.basis, 'junit');
    assert.match(r.gates.claimedObservable.detail, re);
  }
  // The observable must hold on every run: a message that differs on run 3 does not carry a quote it lacks.
  const r3 = await runClaim(claimSandbox({ poc: [drainFails(), drainFails(), drainFails('vault drained twice')] }), claimRequest({ finding: finding({ observable: 'test_drain fails with "drained twice"' }) }));
  assert.equal(r3.gates.claimedObservable.status, 'fail', show(r3));
});

test('claimedObservable passes when the named tests failed and the observable is in the recorded failure (quoted, or the whole message unquoted)', async () => {
  for (const poc of [
    {},
    { command: 'forge test --mt "^test_drain$"', observable: 'ExploitTest.test_drain() reverts with "vault drained" at the committed hash' },
    { observable: 'test_drain: vault drained' }
  ]) {
    const r = await runClaim(claimSandbox(), claimRequest({ finding: finding(poc) }));
    assert.equal(r.gates.claimedObservable.status, 'pass', `${JSON.stringify(poc)}: ${show(r)}`);
    assert.match(r.gates.claimedObservable.detail, /test_drain/);
  }
});

test('claimedObservable through the HTTP API: POST /v1/runs with finding.json answers the gate', async (t) => {
  const meminfo = async () => ({ availableMb: 1e6, error: null });
  const statfs = async () => ({ bavail: 1e12, bsize: 1 });
  const body = (f) => {
    const s = forgeSpec();
    return {
      listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', bcid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      spec: s, attestation: attestationFor(s), pocPatch: Buffer.from(POC_PATCH).toString('base64'), fixPatch: null,
      baseline: claimRequest().baseline, finding: f, report: '# x\n', knownIssues: [], priorFindings: [], eaGates: { disclosure: 'pass', inScope: 'pass' }, deadline: 700000
    };
  };
  for (const [f, status, re] of [
    [finding(), 'pass', /test_drain/],
    [finding({ command: 'forge test --match-test test_deposit', observable: 'test_deposit fails with "vault drained"' }), 'fail', /test_deposit, which is not a test the patch added/]
  ]) {
    const sb = claimSandbox();
    const runner = createServer({ config: testConfig(), docker: sb.docker, log: silent, statfs, meminfo });
    const address = await runner.listen();
    t.after(() => runner.close());
    const res = await httpRequest({ host: address.host, port: address.port }, { method: 'POST', path: '/v1/runs', body: body(f) });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.outcome, 'definitive');
    assert.equal(res.body.gates.claimedObservable.status, status, JSON.stringify(res.body.gates));
    assert.match(res.body.gates.claimedObservable.detail, re);
    assert.equal(res.body.gates.integrity.status, 'pass');
    assert.deepEqual(res.body.facts.poc.integrity, CLEAN);
  }
});

// -------------------------------------------- forge-specific tamper routes, measured

test('the runner\'s repository is watched: a hook, a filter in .git/config or a forged index written during a run fails protectedPathsUnchanged', async () => {
  for (const [p, content] of [['/work/.git/hooks/post-checkout', '#!/bin/sh\n'], ['/work/.git/config', '[filter "x"]\n\tsmudge = sh test/x.sh\n'], ['/work/.git/index', 'forged']]) {
    const w = (d, k, box) => { if (k === 1) set(box, p, content); return { exitCode: 1, stdout: drainFails() }; };
    const r = await runClaim(claimSandbox({ poc: [w, w, w] }));
    assertIntegrityFails(r, ['protectedPathsUnchanged'], new RegExp(`run 1: ${p.slice('/work/'.length).replace(/[./]/g, '\\$&')} (changed|added)`));
  }
});

test('$HOME is watched (forge\'s global config, git\'s): a ~/.foundry/foundry.toml written during a run fails frameworkUnchanged; forge\'s own ~/.foundry/cache does not', async () => {
  const w = (d, k, box) => { if (k === 2) set(box, '/home/sandbox/.foundry/foundry.toml', '[profile.default]\nffi = true\n'); set(box, '/home/sandbox/.foundry/cache/signatures', `{"run":${k}}`); return { exitCode: 1, stdout: drainFails() }; };
  const r = await runClaim(claimSandbox({ poc: [w, w, w] }));
  assertIntegrityFails(r, ['frameworkUnchanged'], /run 2: ~\/\.foundry\/foundry\.toml added/);
  assert.equal(r.facts.poc.integrity.protectedPathsUnchanged, true);
});

test('the forge executable: `command -v forge` resolving to another program after a run fails frameworkUnchanged', async () => {
  let probes = 0;
  const { forgeConfig, initialTree } = require('../helpers/fakeClaim');
  const framework = () => {
    probes += 1;
    const where = probes >= 3 ? '/work/node_modules/.bin/forge' : '/usr/local/bin/forge';
    return { stdout: `vcr-forge ${where}\nvcr-path /work/node_modules/.bin:/usr/local/bin:/usr/bin:/bin\n${forgeConfig(initialTree())}` };
  };
  const r = await runClaim(claimSandbox({ scripts: { 'vcr-framework': framework } }));
  assertIntegrityFails(r, ['frameworkUnchanged'], /run 2: forge resolves to \/work\/node_modules\/\.bin\/forge, not \/usr\/local\/bin\/forge/);
});

test('artifacts: out/ and forge\'s compile cache may change during run 1 (forge compiles what the build left out), never after: one forged for runs 2-3 fails frameworkUnchanged', async () => {
  // Run 1 rewrites an artifact and adds one, as forge does after `forge build --skip test`: not a change.
  const compile = (d, k, box) => {
    if (k === 1) { set(box, '/work/out/Vault.sol/Vault.json', '{"bytecode":"0x6080","id":2}'); set(box, '/work/out/Exploit.t.sol/Helper.json', '{}'); }
    return { exitCode: 1, stdout: drainFails() };
  };
  const ok = await runClaim(claimSandbox({ poc: [compile, compile, compile] }));
  assert.equal(ok.gates.integrity.status, 'pass', show(ok));
  // An artifact changed by run 2 is what run 3 would execute without recompiling.
  const forge = (d, k, box) => { if (k === 2) set(box, '/work/out/Vault.sol/Vault.json', '{"bytecode":"0xfe"}'); return { exitCode: 1, stdout: drainFails() }; };
  const r = await runClaim(claimSandbox({ poc: [forge, forge, forge] }));
  assertIntegrityFails(r, ['frameworkUnchanged'], /run 2: out\/Vault\.sol\/Vault\.json changed/);
  // The compile cache pointing a source at another artifact file is the same route.
  const point = (d, k, box) => { if (k === 2) set(box, '/work/cache/solidity-files-cache.json', '{"files":{"src/Vault.sol":{"artifacts":"../test/x.json"}}}'); set(box, '/work/cache/test-failures', `run ${k}`); return { exitCode: 1, stdout: drainFails() }; };
  const r2 = await runClaim(claimSandbox({ poc: [point, point, point] }));
  assertIntegrityFails(r2, ['frameworkUnchanged'], /run 2: cache\/solidity-files-cache\.json changed/);
});

test('a snapshot that cannot be read before any claim code is the requester\'s package; after a run it is a definitive integrity failure', async () => {
  // Before any claim code: forge missing, `forge config` failing, a work tree too large to watch.
  const { forgeConfig, initialTree } = require('../helpers/fakeClaim');
  const cases = [
    [{ 'vcr-framework': () => ({ exitCode: 3, stdout: 'vcr-forge \nvcr-path /usr/bin\n' }) }, 'IMAGE_FORGE_MISSING'],
    [{ 'vcr-framework': () => ({ exitCode: 1, stdout: 'vcr-forge /usr/local/bin/forge\nvcr-path /usr/bin\n', stderr: 'Error: failed to parse foundry.toml' }) }, 'FORGE_CONFIG_INVALID'],
    [{ 'vcr-manifest': () => ({ stdout: Buffer.alloc(require('../../src/integrity').MANIFEST_MAX_BYTES + 1, 0x61) }) }, 'IMAGE_WATCH_TOO_LARGE']
  ];
  for (const [scripts, code] of cases) {
    const r = await runClaim(claimSandbox({ scripts }));
    assert.equal(r.outcome, 'requester_error', `${code}: ${show(r)}`);
    assert.deepEqual(r.issues.map((i) => i.code), [code]);
  }
  // After a run: the listing overflows, or forge's configuration no longer loads.
  let n = 0;
  const flood = (d, box) => { n += 1; if (n === 3) return { stdout: Buffer.alloc(require('../../src/integrity').MANIFEST_MAX_BYTES + 1, 0x61) }; return { stdout: require('../helpers/fakeClaim').manifestOf(box.tree, d.argv.slice(4)) }; };
  const r1 = await runClaim(claimSandbox({ scripts: { 'vcr-manifest': flood } }));
  assertIntegrityFails(r1, ['protectedPathsUnchanged', 'frameworkUnchanged', 'dependenciesUnchanged'], /run 1: the watched paths exceed/);
  let p = 0;
  const broken = (d, box) => { p += 1; return p <= 2 ? { stdout: `vcr-forge /usr/local/bin/forge\nvcr-path /usr/bin\n${forgeConfig(initialTree())}` } : { exitCode: 1, stdout: 'vcr-forge /usr/local/bin/forge\nvcr-path /usr/bin\n' }; };
  const r2 = await runClaim(claimSandbox({ scripts: { 'vcr-framework': broken } }));
  assertIntegrityFails(r2, ['frameworkUnchanged'], /run 1: forge config exited 1/);
});

test('integrity is decided on every PoC that ran, also when reproduces fails on the JUnit (a pass on run 2); claimedObservable then is not', async () => {
  const passing = junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()' }] }]);
  const r = await runClaim(claimSandbox({ poc: [drainFails(), passing, drainFails()] }));
  assert.equal(r.gates.reproduces.status, 'fail');
  assert.equal(r.gates.reproduces.basis, 'junit');
  assert.equal(r.gates.reproduces.detail, `${DRAIN} passed on run 2`);
  assert.equal(r.gates.integrity.status, 'pass', show(r));
  assert.equal(r.gates.claimedObservable, undefined);
  // A build that fails: no PoC, so neither reproduces nor integrity is decided.
  const b = await runClaim(claimSandbox({ scripts: { 'vcr-build': () => ({ exitCode: 1 }) } }));
  assert.equal(b.gates.build.status, 'fail');
  for (const g of ['reproduces', 'integrity', 'claimedObservable']) assert.equal(b.gates[g], undefined, g);
  assert.equal(b.facts.poc, undefined);
});

// ------------------------------------------- the facts always make a valid report

/** The real report (src/report.js): no outcome of the gates and the fix check breaks its one form (R6-F1: a fix that applied is never `builds: not-run`). */
function toReport(r, request) {
  return assembleReport(r, { ...request, attestation: {} }, { gvisor: 'runc' });
}

test('the facts and gates make a valid verdikta.claim-report/1 on every outcome (common\'s validator), and tier-B trust follows integrity', async () => {
  const { validateClaimReport, isTrustedPassingEvidence } = require('@verdikta/common/src/codeReview/report');
  const { FIX_PATCH, suitePasses } = require('../helpers/fakeClaim');
  const fix = Buffer.from(FIX_PATCH);
  const passing = junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()' }] }]);
  const forged = () => ({ exitCode: 0, stdout: junit([{ suite: 'test/Exploit.t.sol:ExploitTest', cases: [{ name: 'test_drain()', failure: 'vault drained' }] }], { summary: false }) });
  const cases = [
    ['clean', {}, {}, true],
    ['clean, with a fix that verifies', {}, { fixPatch: fix }, true],
    ['a fix whose PoC still fails, and a regression', { fix: { suite: suitePasses({ poc: { failure: 'x' }, deposit: { failure: 'y' } }) } }, { fixPatch: fix }, true],
    ['a fix that does not build', { fix: { build: () => ({ exitCode: 1 }) } }, { fixPatch: fix }, true],
    ['a fix touching tests', { fix: { nameStatus: 'M\0test/Vault.t.sol\0' } }, { fixPatch: fix }, true],
    ['a binary fix', { fix: { patch: Buffer.from('diff --git a/x.png b/x.png\nGIT binary patch\nliteral 1\n') } }, { fixPatch: Buffer.from('diff --git a/x.png b/x.png\nGIT binary patch\nliteral 1\n') }, true],
    ['integrity fails', { poc: [forged, forged, forged] }, {}, false],
    ['observable mismatch', {}, { finding: finding({ observable: 'test_drain fails with "elsewhere"' }) }, true],
    ['a pass on run 2', { poc: [drainFails(), passing, drainFails()] }, {}, true],
    ['the build fails', { scripts: { 'vcr-build': () => ({ exitCode: 1 }) } }, { fixPatch: fix }, null],
    ['the patch does not apply', { git: { 'apply --index': () => ({ exitCode: 1, stderr: 'error: patch failed\n' }) } }, { fixPatch: fix }, null]
  ];
  for (const [what, sbOver, reqOver, trusted] of cases) {
    const request = claimRequest(reqOver);
    const r = await runClaim(claimSandbox(sbOver), request);
    assert.equal(r.outcome, 'definitive', `${what}: ${show(r)}`);
    const report = toReport(r, request);
    const v = validateClaimReport(report);
    assert.equal(v.ok, true, `${what}: ${JSON.stringify(v.issues)}`);
    if (trusted !== null) assert.equal(isTrustedPassingEvidence(report), trusted, what);
    else assert.equal(report.poc, null, what);
    if (report.fix.applies === 'pass') assert.notEqual(report.fix.builds, 'not-run', `${what}: R6-F1`);
  }
});

// ------------------------------------------------------------------- round 1

test('A3a R1-F3: a forge in the work tree is measured before it runs; one a run replaced is never run for its configuration', async () => {
  const { forgeConfig } = require('../helpers/fakeClaim');
  const framework = (d, box) => ({ stdout: `vcr-forge /work/bin/forge\nvcr-path /work/bin:/usr/bin:/bin\nvcr-real /work/bin/forge\n${forgeConfig(box.tree)}` });
  const replace = (d, k, box) => { if (k === 1) set(box, '/work/bin/forge', '#!/bin/sh\n# restores itself, then execs the real forge\n'); return { exitCode: 1, stdout: drainFails() }; };
  const sb = claimSandbox({ onBox: (box) => set(box, '/work/bin/forge', 'ELF'), poc: [replace, drainFails(), drainFails()], scripts: { 'vcr-framework': framework } });
  const r = await runClaim(sb);
  assertIntegrityFails(r, ['frameworkUnchanged'], /run 1: bin\/forge changed/);
  assert.match(r.gates.integrity.detail, /forge's executable \/work\/bin\/forge changed; it was not run/);
  // Measured first: the manifest after each run comes before that run's probe.
  const order = sb.execs().map(label);
  assert.ok(order.indexOf('vcr-manifest', order.indexOf('vcr-poc')) < order.indexOf('vcr-framework', order.indexOf('vcr-poc')));
  // The reference runs forge config (forge-config follows its discovery); after run 1, the replaced forge is not executed for it.
  const afterFirstPoc = order.slice(order.indexOf('vcr-poc'));
  assert.ok(order.slice(0, order.indexOf('vcr-poc')).includes('forge-config'), 'the reference runs forge config');
  assert.ok(!afterFirstPoc.slice(0, afterFirstPoc.indexOf('git reset')).includes('forge-config'), 'after run 1, the replaced forge is not executed');
});

test('A3a R1-F6: claimedObservable reads forge\'s whole message as well as the report\'s form (past 2,000 characters, absolute paths)', async () => {
  const long = drainFails(`${'x'.repeat(2100)} vault drained at /work/src/Vault.sol`);
  for (const observable of [
    'test_drain fails with "vault drained at /work/src/Vault.sol"',
    'test_drain fails with "xxxx"'
  ]) {
    const r = await runClaim(claimSandbox({ poc: [long, long, long] }), claimRequest({ finding: finding({ observable }) }));
    assert.equal(r.gates.claimedObservable.status, 'pass', `${observable}: ${show(r)}`);
  }
  const short = drainFails('balance wrong in /work/src/Vault.sol');
  for (const observable of ['test_drain fails with "in src/Vault.sol"', 'test_drain fails with "in /work/src/Vault.sol"']) {
    const r = await runClaim(claimSandbox({ poc: [short, short, short] }), claimRequest({ finding: finding({ observable }) }));
    assert.equal(r.gates.claimedObservable.status, 'pass', `${observable}: ${show(r)}`);
  }
});

test('A3a R1-F3 (round 2): the executable is checked by its own entry, wherever it is (forge\'s cache directory too); one the reference cannot hash is the requester\'s', async () => {
  const { forgeConfig } = require('../helpers/fakeClaim');
  const at = (where) => (d, box) => ({ stdout: `vcr-forge /work/bin/forge\nvcr-path /work/bin:/usr/bin\nvcr-real ${where}\n${forgeConfig(box.tree)}` });
  const FORGE = '/work/cache/tools/forge';
  const replace = (d, k, box) => { if (k === 2) set(box, FORGE, '#!/bin/sh\n'); return { exitCode: 1, stdout: drainFails() }; };
  const sb = claimSandbox({ onBox: (box) => { set(box, FORGE, 'ELF'); box.tree.set('/work/bin/forge', { type: 'l', target: '../cache/tools/forge' }); }, poc: [drainFails(), replace, drainFails()], scripts: { 'vcr-framework': at(FORGE) } });
  const r = await runClaim(sb);
  assertIntegrityFails(r, ['frameworkUnchanged'], /run 2: cache\/tools\/forge changed/);
  assert.match(r.gates.integrity.detail, /forge's executable \/work\/cache\/tools\/forge changed; it was not run/);
  const probes = sb.execs().filter((d) => d.kind === 'vcr-framework');
  assert.deepEqual(probes.slice(2).map((d) => d.argv[4]), [FORGE, FORGE, FORGE], 'later probes name the reference\'s real path, never the link a run could retarget');
  const configs = sb.execs().filter((d) => d.kind === 'forge-config');
  assert.deepEqual(configs.map((d) => d.argv[0]), [FORGE, FORGE, FORGE], 'forge config before any patch, at the reference and after run 1; not at all once it changed');
  // A forge in the work tree the reference cannot hash (a listing it is pruned from, or unreadable) is refused before any claim code.
  for (const [where, seed] of [['/work/cache/solidity-files-cache.json.abi/forge', 'f'], ['/work/bin/forge', 'unreadable']]) {
    const sb2 = claimSandbox({
      onBox: (box) => box.tree.set(where, { type: 'f', mode: '755', content: 'ELF', unreadable: seed === 'unreadable' }),
      scripts: { 'vcr-framework': at(where) }
    });
    const r2 = await runClaim(sb2);
    assert.equal(r2.outcome, 'requester_error', `${where}: ${show(r2)}`);
    assert.deepEqual(r2.issues.map((i) => i.code), ['IMAGE_FORGE_UNWATCHED']);
  }
});

test('A3a R6-F1: what a watched link points to is watched as the link is (a dependency link, a symlinked lib/ root with a link inside); a link outside every watched set is not followed', async () => {
  const link = (box, p, target) => box.tree.set(p, { type: 'l', target });
  const cases = [
    // lib/pkg -> ../vendor/pkg, the fixture under vendor/ untracked.
    [(box) => { link(box, '/work/lib/pkg', '../vendor/pkg'); set(box, '/work/vendor/pkg/fixture.json', '{}'); }, '/work/vendor/pkg/fixture.json', /dependenciesUnchanged \(run 2: vendor\/pkg\/fixture\.json changed/],
    // lib itself a link (the dependency root), with a link inside what it leads to. (Attempt 1 wrote `lib -> ../third_party`,
    // which the kernel resolves from /work to /third_party, outside the work tree: the case's intent is a sibling.)
    [(box) => { box.tree.delete('/work/lib/forge-std/src/Test.sol'); link(box, '/work/lib', 'third_party'); link(box, '/work/third_party/oz', '/work/vendor2/oz'); set(box, '/work/vendor2/oz/ERC20.sol', 'contract ERC20 {}'); }, '/work/vendor2/oz/ERC20.sol', /dependenciesUnchanged \(run 2: vendor2\/oz\/ERC20\.sol changed/]
  ];
  for (const [seed, target, re] of cases) {
    const edit = (d, k, box) => { if (k === 2) set(box, target, '// changed behind the link'); return { exitCode: 1, stdout: drainFails() }; };
    const r = await runClaim(claimSandbox({ onBox: seed, poc: [edit, edit, edit] }));
    assertIntegrityFails(r, ['dependenciesUnchanged'], re);
  }
  // A link outside every watched set (a source file the maker links to an untracked one) is not followed (attempt 2, item
  // 2): what it reaches is an untracked file outside the sets, which the check never watched. A maker who wants it
  // watched lists the link under paths.protected, and then a change behind it fails protectedPathsUnchanged.
  const gen = (box) => { link(box, '/work/src/Gen.sol', '../gen/Gen.sol'); set(box, '/work/gen/Gen.sol', 'contract Gen {}'); };
  const editGen = (d, k, box) => { if (k === 2) set(box, '/work/gen/Gen.sol', '// changed behind the link'); return { exitCode: 1, stdout: drainFails() }; };
  const unwatched = await runClaim(claimSandbox({ onBox: gen, poc: [editGen, editGen, editGen] }));
  assert.equal(unwatched.gates.integrity.status, 'pass', show(unwatched));
  const protectedSrc = claimRequest({ spec: forgeSpec({ paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', 'src/**'] } }) });
  const watchedGen = await runClaim(claimSandbox({ onBox: gen, poc: [editGen, editGen, editGen] }), protectedSrc);
  assertIntegrityFails(watchedGen, ['protectedPathsUnchanged'], /protectedPathsUnchanged \(run 2: gen\/Gen\.sol changed/);
  // A watched link into /tmp is refused before any claim code, the link and its target named; an unwatched one is not.
  const r = await runClaim(claimSandbox({ onBox: (box) => { link(box, '/work/lib/tmpdep', '/tmp/dep'); set(box, '/tmp/dep/Dep.sol', 'contract Dep {}'); } }));
  assert.equal(r.outcome, 'requester_error', show(r));
  assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_LINK_UNCOVERED']);
  assert.match(r.issues[0].detail, /lib\/tmpdep -> \/tmp\/dep \(\/tmp\)/);
  const ok = await runClaim(claimSandbox({ onBox: (box) => link(box, '/work/scratch', '/tmp/scratch') }));
  assert.equal(ok.gates.integrity.status, 'pass', show(ok));
  // /tmp is empty when the reference is taken, so such a link usually resolves to nothing then: the kernel's "nothing" is
  // recorded, and a run that creates its target changes the link's own entry.
  const create = (d, k, box) => { if (k === 1) set(box, '/tmp/dep/Dep.sol', 'contract Dep {}'); return { exitCode: 1, stdout: drainFails() }; };
  const later = await runClaim(claimSandbox({ onBox: (box) => link(box, '/work/lib/tmpdep', '/tmp/dep'), poc: [create, create, create] }));
  assertIntegrityFails(later, ['dependenciesUnchanged'], /dependenciesUnchanged \(run 1: lib\/tmpdep changed/);
  assert.match(later.gates.integrity.detail, /lib\/tmpdep -> \/tmp\/dep is a watched link into \/tmp/);
});

// ----------------------------------------------- attempt 2: the kernel resolves the links

test('A3a R6-F1 (round 7): `lib/pkg -> ../bridge/../payload` with `bridge -> vendor/nested`: the kernel\'s answer (vendor/payload) is watched, not the lexical one', async () => {
  const seed = (box) => {
    box.tree.set('/work/lib/pkg', { type: 'l', target: '../bridge/../payload' });
    box.tree.set('/work/bridge', { type: 'l', target: 'vendor/nested' });
    set(box, '/work/vendor/nested/.keep', '');
    set(box, '/work/vendor/payload/fixture.json', '{}');
    set(box, '/work/payload/fixture.json', '{}');
  };
  const edit = (p) => (d, k, box) => { if (k === 2) set(box, p, '{"drained":true}'); return { exitCode: 1, stdout: drainFails() }; };
  const sb = claimSandbox({ onBox: seed, poc: [edit('/work/vendor/payload/fixture.json'), edit('/work/vendor/payload/fixture.json'), edit('/work/vendor/payload/fixture.json')] });
  const r = await runClaim(sb);
  assertIntegrityFails(r, ['dependenciesUnchanged'], /dependenciesUnchanged \(run 2: vendor\/payload\/fixture\.json changed/);
  // The runner asked the sandbox about the watched link only (bridge is in no set), the path on stdin, hermetically.
  const links = sb.execs().filter((d) => d.kind === 'vcr-links');
  assert.equal(links.length, 5, 'the reference, after the build and after each run');
  for (const l of links) {
    assert.equal(l.stdin.toString('latin1'), '/work/lib/pkg\0');
    assert.deepEqual(l.launched.slice(0, 2), ['/usr/bin/env', '-i']);
  }
  // The lexical answer (payload/) is nobody's dependency: changing it is not a change of the watched sets.
  const decoy = edit('/work/payload/fixture.json');
  const ok = await runClaim(claimSandbox({ onBox: seed, poc: [decoy, decoy, decoy] }));
  assert.equal(ok.gates.integrity.status, 'pass', show(ok));
});

test('A3a R6-F1 (round 7): a watched link into forge\'s cache directory is IMAGE_WATCH_LINK_UNCOVERED, the link and its target named', async () => {
  const r = await runClaim(claimSandbox({ onBox: (box) => { box.tree.set('/work/lib/cpkg', { type: 'l', target: '../cache/pkg' }); set(box, '/work/cache/pkg/Dep.sol', 'contract Dep {}'); } }));
  assert.equal(r.outcome, 'requester_error', show(r));
  assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_LINK_UNCOVERED']);
  assert.match(r.issues[0].detail, /lib\/cpkg -> \/work\/cache\/pkg \(forge's cache directory \(cache\)\)/);
});

test('links whose targets change between runs: an unwatched link on the way retargeted during a run changes the watched link\'s own entry', async () => {
  const seed = (box) => {
    box.tree.set('/work/lib/pkg', { type: 'l', target: '../bridge/pkg' });
    box.tree.set('/work/bridge', { type: 'l', target: 'vendor' });
    set(box, '/work/vendor/pkg/X.sol', 'contract X {}');
    set(box, '/work/vendor2/pkg/X.sol', 'contract X {}');
  };
  // The same bytes behind the new target: only the kernel's answer for lib/pkg differs.
  const retarget = (to) => (d, k, box) => { if (k === 1) box.tree.set('/work/bridge', { type: 'l', target: to }); return { exitCode: 1, stdout: drainFails() }; };
  const r = await runClaim(claimSandbox({ onBox: seed, poc: [retarget('vendor2'), drainFails(), drainFails()] }));
  assertIntegrityFails(r, ['dependenciesUnchanged'], /dependenciesUnchanged \(run 1: lib\/pkg changed/);
  // Retargeted into /tmp: the after-run snapshot names where it now leads.
  const tmp = await runClaim(claimSandbox({ onBox: (box) => { seed(box); set(box, '/tmp/pkg/X.sol', 'contract X {}'); }, poc: [retarget('/tmp'), drainFails(), drainFails()] }));
  assertIntegrityFails(tmp, ['dependenciesUnchanged'], /lib\/pkg -> \/tmp\/pkg is a watched link into \/tmp/);
});

test('a dependency root behind a link (libs = ["deps/lib"], deps -> third_party): what forge reads there is watched, and a run that edits it fails dependenciesUnchanged', async () => {
  const seed = (box) => {
    box.configOver = { libs: ['lib', 'deps/lib'] };
    box.tree.set('/work/deps', { type: 'l', target: 'third_party' });
    set(box, '/work/third_party/lib/X.sol', 'contract X {}');
  };
  const edit = (d, k, box) => { if (k === 2) set(box, '/work/third_party/lib/X.sol', '// drained'); return { exitCode: 1, stdout: drainFails() }; };
  const sb = claimSandbox({ onBox: seed, poc: [edit, edit, edit] });
  const r = await runClaim(sb);
  assertIntegrityFails(r, ['dependenciesUnchanged'], /dependenciesUnchanged \(run 2: third_party\/lib\/X\.sol changed/);
  assert.equal(sb.execs().filter((d) => d.kind === 'vcr-links')[0].stdin.toString('latin1'), '/work/deps/lib\0', 'the root itself, through the link');
});

test('A3a R7-F1: 20,000 links to `.` in the test paths are never resolved, and 20,000 in lib/ are one resolution per snapshot, deduplicated to one tree; the claim still passes, in bounded time', async () => {
  const N = 20000;
  const many = (dir) => (box) => { for (let i = 0; i < N; i += 1) box.tree.set(`/work/${dir}/l${i}`, { type: 'l', target: '.' }); };
  const t0 = process.hrtime.bigint();
  const tests = claimSandbox({ onBox: many('test/links') });
  const r1 = await runClaim(tests);
  assert.equal(r1.gates.integrity.status, 'pass', show(r1));
  assert.equal(tests.execs().filter((d) => d.kind === 'vcr-links').length, 0, 'links in the test paths are never followed');
  const lib = claimSandbox({ onBox: many('lib') });
  const r2 = await runClaim(lib);
  assert.equal(r2.gates.integrity.status, 'pass', show(r2));
  const links = lib.execs().filter((d) => d.kind === 'vcr-links');
  assert.equal(links.length, 5);
  for (const l of links) assert.equal(l.stdin.toString('latin1').split('\0').filter(Boolean).length, N);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 60000, `${ms} ms for both claims (each builds its fake listings of ${N} links five times)`);
});

test('a link the patch adds inside a watched set (paths.tests overlapping lib/) fails the check it sits in; it is never followed, and never the image\'s error', async () => {
  const spec = forgeSpec({ paths: { tests: ['test/**', 'lib/**/*.t.sol'], protected: ['foundry.toml'] } });
  const git = {
    'diff --name-status': () => ({ stdout: 'A\0lib/x/E.t.sol\0A\0test/Exploit.t.sol\0' }),
    'diff --numstat': () => ({ stdout: '0\t0\tlib/x/E.t.sol\0' + '3\t0\ttest/Exploit.t.sol\0' })
  };
  const sb = claimSandbox({ git, onBox: (box) => box.tree.set('/work/lib/x/E.t.sol', { type: 'l', target: '/tmp/evil' }) });
  const r = await runClaim(sb, claimRequest({ spec }));
  assertIntegrityFails(r, ['dependenciesUnchanged'], /dependenciesUnchanged \(the reference: the patch adds a link inside the dependencies \(lib\/x\/E\.t\.sol\)/);
  assert.equal(sb.execs().filter((d) => d.kind === 'vcr-links').length, 0, 'never resolved');
});

test('resolving the links: an image without realpath is IMAGE_TOOL_MISSING; an unreadable answer is the runner\'s error; more watched links than the cap after a run is a definitive failure', async () => {
  const seed = (box) => { box.tree.set('/work/lib/pkg', { type: 'l', target: '../vendor/pkg' }); set(box, '/work/vendor/pkg/X.sol', 'contract X {}'); };
  const missing = await runClaim(claimSandbox({ onBox: seed, scripts: { 'vcr-links': () => ({ exitCode: 4 }) } }));
  assert.equal(missing.outcome, 'requester_error', show(missing));
  assert.deepEqual(missing.issues.map((i) => i.code), ['IMAGE_TOOL_MISSING']);
  assert.match(missing.issues[0].detail, /realpath/);
  const garbled = await runClaim(claimSandbox({ onBox: seed, scripts: { 'vcr-links': () => ({ stdout: 'd\0/work/lib/other\0/work\0' }) } }));
  assert.equal(garbled.outcome, 'abstain', show(garbled));
  assert.equal(garbled.abstain.cause, 'runner_error');
  // Past the cap on watched links (a run that adds them): every check the listing feeds fails, nothing is resolved past it.
  const { MAX_WATCHED_LINKS } = require('../../src/integrity');
  const flood = (d, k, box) => { if (k === 1) for (let i = 0; i <= MAX_WATCHED_LINKS; i += 1) box.tree.set(`/work/lib/f${i}`, { type: 'l', target: '.' }); return { exitCode: 1, stdout: drainFails() }; };
  const sb = claimSandbox({ poc: [flood, drainFails(), drainFails()] });
  const r = await runClaim(sb);
  assertIntegrityFails(r, ['protectedPathsUnchanged', 'frameworkUnchanged', 'dependenciesUnchanged'], new RegExp(`run 1: more than ${MAX_WATCHED_LINKS} watched links`));
  assert.ok(sb.execs().filter((d) => d.kind === 'vcr-links').every((d) => d.stdin.toString('latin1').split('\0').filter(Boolean).length <= MAX_WATCHED_LINKS));
});

test('with a watched link, its resolution is part of measuring the files: after the manifest, before forge runs for its configuration (R1-F3)', async () => {
  const sb = claimSandbox({ onBox: (box) => { box.tree.set('/work/lib/pkg', { type: 'l', target: '../vendor/pkg' }); set(box, '/work/vendor/pkg/X.sol', 'contract X {}'); } });
  const r = await runClaim(sb);
  assert.equal(r.gates.integrity.status, 'pass', show(r));
  const order = sb.execs().map(label);
  const from = order.indexOf('git rev-parse', order.indexOf('git commit'));
  assert.deepEqual(order.slice(from + 1), [
    'git diff', 'git cat-file', 'git cat-file', 'git ls-tree',
    'vcr-framework', 'forge-config', 'vcr-external-roots', 'vcr-manifest', 'vcr-links', 'vcr-build', 'vcr-cleanup', 'vcr-manifest', 'vcr-links',
    'vcr-poc', 'vcr-cleanup', 'vcr-manifest', 'vcr-links', 'vcr-framework', 'forge-config',
    'git reset', 'vcr-manifest', 'vcr-poc', 'vcr-cleanup', 'vcr-manifest', 'vcr-links', 'vcr-framework', 'forge-config',
    'git reset', 'vcr-manifest', 'vcr-poc', 'vcr-cleanup', 'vcr-manifest', 'vcr-links', 'vcr-framework', 'forge-config'
  ]);
});

test('A3a R8-F1: forge\'s out and compile cache configured in /tmp (and a PATH directory there) are IMAGE_WATCH_ROOT_UNCOVERED before any maker command, never left unwatched', async () => {
  const sb = claimSandbox({ onBox: (box) => { box.configOver = { out: '/tmp/forge-out', cache_path: '/tmp/forge-cache' }; } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'requester_error', show(r));
  assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
  assert.match(r.issues[0].detail, /out \(\/tmp\/forge-out\) is not a plain path in the work tree; cache_path \(\/tmp\/forge-cache\) is not a plain path in the work tree/);
  assert.ok(!sb.execs().some((d) => d.kind === 'vcr-build' || d.kind === 'vcr-poc'), 'no maker command and no claim code ran');
  const { forgeConfig } = require('../helpers/fakeClaim');
  const framework = (d, box) => ({ stdout: `vcr-forge /usr/local/bin/forge\nvcr-path /tmp/bin:/usr/local/bin:/usr/bin\n${forgeConfig(box.tree)}` });
  const p = await runClaim(claimSandbox({ scripts: { 'vcr-framework': framework } }));
  assert.equal(p.outcome, 'requester_error', show(p));
  assert.match(p.issues[0].detail, /PATH directory \/tmp\/bin is in \/tmp/);
});

test('A3a R8-F1 (round 9): out = "cache/artifacts", or libs with "cache/pkg", is IMAGE_WATCH_ROOT_UNCOVERED before any maker command', async () => {
  for (const [over, re] of [[{ out: 'cache/artifacts' }, /out \(cache\/artifacts\) is in forge's cache directory \(cache\)/], [{ libs: ['lib', 'cache/pkg'] }, /libs \(cache\/pkg\) is in forge's cache directory \(cache\)/]]) {
    const sb = claimSandbox({ onBox: (box) => { box.configOver = over; } });
    const r = await runClaim(sb);
    assert.equal(r.outcome, 'requester_error', show(r));
    assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
    assert.match(r.issues[0].detail, re);
    assert.ok(!sb.execs().some((d) => d.kind === 'vcr-build' || d.kind === 'vcr-poc'));
  }
});

test('A3a R11-F2: a helper reached through PATH `.bin`, or through an empty PATH entry (the commands\' directory), changed during a run fails frameworkUnchanged', async () => {
  const { forgeConfig } = require('../helpers/fakeClaim');
  for (const [path, helper, rel] of [['.bin:/usr/local/bin:/usr/bin', '/work/.bin/helper', '.bin/helper'], [':/usr/local/bin:/usr/bin', '/work/helper.sh', 'helper.sh']]) {
    const framework = (d, box) => ({ stdout: `vcr-forge /usr/local/bin/forge\nvcr-path ${path}\n${forgeConfig(box.tree)}` });
    const edit = (d, k, box) => { if (k === 2) set(box, helper, '#!/bin/sh\nexit 0\n'); return { exitCode: 1, stdout: drainFails() }; };
    const r = await runClaim(claimSandbox({ onBox: (box) => set(box, helper, '#!/bin/sh\nexec "$@"\n'), poc: [edit, edit, edit], scripts: { 'vcr-framework': framework } }));
    assertIntegrityFails(r, ['frameworkUnchanged'], new RegExp(`frameworkUnchanged \\(run 2: ${rel.replace(/\./g, '\\.')} changed`));
  }
});

// ------------------------------------------------- R13-F1: what a snapshot cannot read

test('A3a R13-F1: a file a run leaves unreadable in out/ fails frameworkUnchanged at once: same-length bytes changed behind mode 000 are never accepted as run 1\'s artifact', async () => {
  const hide = (d, k, box) => {
    box.tree.set('/work/out/payload.bin', { type: 'f', mode: '0', content: k === 1 ? 'aaa' : 'bbb', unreadable: true });
    return { exitCode: 1, stdout: drainFails() };
  };
  const r = await runClaim(claimSandbox({ poc: [hide, hide, hide] }));
  assertIntegrityFails(r, ['frameworkUnchanged'], /run 1: out\/payload\.bin cannot be read/);
  // In the one run of the fix check's suite too: there is no run 2 to compare it with.
  const { FIX_PATCH, suitePasses } = require('../helpers/fakeClaim');
  const suite = (d, k, box) => { box.tree.set('/work/out/payload.bin', { type: 'f', mode: '0', content: 'aaa', unreadable: true }); return { exitCode: 0, stdout: suitePasses() }; };
  const f = await runClaim(claimSandbox({ fix: { suite } }), claimRequest({ fixPatch: Buffer.from(FIX_PATCH) }));
  assert.equal(f.facts.fix.integrity.frameworkUnchanged, false, show(f));
  assert.match(JSON.stringify(f.facts.integrity.fix.failures), /the suite: out\/payload\.bin cannot be read/);
});

test('A3a R13-F1: a directory a run leaves unlistable hides what is under it, so it fails its set\'s check; in the sets held to the reference, as in the artifacts', async () => {
  for (const [dir, check, re] of [
    ['/work/out/hid', 'frameworkUnchanged', /run 1: out\/hid cannot be read/],
    ['/work/lib/hid', 'dependenciesUnchanged', /run 1: lib\/hid cannot be read/],
    ['/home/sandbox/.foundry/hid', 'frameworkUnchanged', /run 1: ~\/\.foundry\/hid cannot be read/],
    // Wherever it is: forge's cache directory hides the compile cache, and any other could hide a root.
    ['/work/cache', 'frameworkUnchanged', /run 1: cache cannot be read/],
    ['/work/state/hid', 'frameworkUnchanged', /run 1: state\/hid cannot be read/],
    ['/work', 'frameworkUnchanged', /run 1: \/work cannot be read/]
  ]) {
    const hide = (d, k, box) => { box.tree.set(dir, { type: 'd', mode: '0', content: '' }); return { exitCode: 1, stdout: drainFails() }; };
    const r = await runClaim(claimSandbox({ poc: [hide, hide, hide] }));
    assertIntegrityFails(r, [check], re);
  }
  // A file unreadable after a run in a set held to the reference: the same.
  const lock = (d, k, box) => { box.tree.set('/work/lib/forge-std/src/Test.sol', { type: 'f', mode: '0', content: '// forge-std\n', unreadable: true }); return { exitCode: 1, stdout: drainFails() }; };
  const r = await runClaim(claimSandbox({ poc: [lock, lock, lock] }));
  assertIntegrityFails(r, ['dependenciesUnchanged'], /run 1: lib\/forge-std\/src\/Test\.sol cannot be read/);
});

test('A3a R13-F1 (round 14): a directory on the way to a watched root, or a watched link\'s target, left unlistable: the artifact baseline would be empty, and run 1 fails instead', async () => {
  // out = "build/out": forge reaches it by its path through build/ at mode 0111; find lists nothing under build/.
  const artifact = '/work/build/out/Vault.sol/Vault.json';
  const hideAncestor = (d, k, box) => {
    box.tree.delete(artifact);
    box.tree.set('/work/build', { type: 'd', mode: '111', content: '' });
    return { exitCode: 1, stdout: drainFails() };
  };
  const nested = await runClaim(claimSandbox({
    onBox: (box) => { box.configOver = { out: 'build/out' }; set(box, artifact, '{"bytecode":"0x6080"}'); },
    poc: [hideAncestor, hideAncestor, hideAncestor]
  }));
  assertIntegrityFails(nested, ['frameworkUnchanged'], /run 1: build cannot be read/);
  // lib/pkg -> ../real-pkg: the link's target itself, its contents no longer listed.
  const hideTarget = (d, k, box) => {
    box.tree.delete('/work/real-pkg/P.sol');
    box.tree.set('/work/real-pkg', { type: 'd', mode: '111', content: '' });
    return { exitCode: 1, stdout: drainFails() };
  };
  const linked = await runClaim(claimSandbox({
    onBox: (box) => { box.tree.set('/work/lib/pkg', { type: 'l', target: '../real-pkg' }); set(box, '/work/real-pkg/P.sol', 'contract P {}'); },
    poc: [hideTarget, hideTarget, hideTarget]
  }));
  assertIntegrityFails(linked, ['frameworkUnchanged'], /run 1: real-pkg cannot be read/);
});

test('A3a R13-F1: what the reference cannot read in the watched sets is the image\'s error before any maker command (IMAGE_WATCH_UNREADABLE); outside them it is not watched and raises nothing', async () => {
  for (const [p, entry] of [
    ['/work/lib/secret.sol', { type: 'f', mode: '0', content: 'x', unreadable: true }],
    ['/work/lib/hidden', { type: 'd', mode: '0', content: '' }],
    ['/work/out/old.bin', { type: 'f', mode: '0', content: 'x', unreadable: true }],
    ['/work/anywhere', { type: 'd', mode: '111', content: '' }]
  ]) {
    const sb = claimSandbox({ onBox: (box) => box.tree.set(p, entry) });
    const r = await runClaim(sb);
    assert.equal(r.outcome, 'requester_error', `${p}: ${show(r)}`);
    assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_UNREADABLE']);
    assert.ok(r.issues[0].detail.includes(p.slice('/work/'.length)), r.issues[0].detail);
    assert.ok(!sb.execs().some((d) => d.kind === 'vcr-build' || d.kind === 'vcr-poc'), 'no maker command ran');
  }
  // A state file of the PoC's own, in no watched set: no check reads it, before or after.
  const own = (d, k, box) => { box.tree.set('/work/state/own', { type: 'f', mode: '0', content: `run ${k}`, unreadable: true }); return { exitCode: 1, stdout: drainFails() }; };
  const r = await runClaim(claimSandbox({ onBox: (box) => box.tree.set('/work/src/unread.txt', { type: 'f', mode: '0', content: 'x', unreadable: true }), poc: [own, own, own] }));
  assert.equal(r.gates.integrity.status, 'pass', show(r));
  assert.deepEqual(r.facts.poc.integrity, CLEAN);
});

// ------------------------------------------- R16-F1: "immutable" asked of the kernel, step by step

test('A3a R16-F1: a PATH directory or solc on the read-only root whose way leads through the work tree, $HOME or /tmp, or a symbolic link in such a PATH directory, is IMAGE_WATCH_ROOT_UNCOVERED before any maker command', async () => {
  const { forgeConfig } = require('../helpers/fakeClaim');
  const PATH = '/opt/helpers:/usr/local/bin:/usr/bin';
  const framework = (d, box) => ({ stdout: `vcr-forge /usr/local/bin/forge\nvcr-path ${PATH}\n${forgeConfig(box.tree)}` });
  for (const [seed, re] of [
    [(box) => box.tree.set('/opt/helpers', { type: 'l', target: '/work/helpers' }), /\/opt\/helpers \(in PATH, the runner's tools or solc\) resolves through a place the sandbox can write/],
    [(box) => { set(box, '/opt/helpers/keep', 'x'); box.tree.set('/opt/helpers/tool', { type: 'l', target: '/work/helpers/tool' }); }, /\/opt\/helpers\/tool \(in PATH/],
    [(box) => { set(box, '/opt/helpers/keep', 'x'); box.tree.set('/opt/helpers/tmp', { type: 'l', target: '/tmp/tool' }); }, /\/opt\/helpers\/tmp \(in PATH/],
    [(box) => { set(box, '/opt/helpers/keep', 'x'); box.tree.set('/opt/helpers/home', { type: 'l', target: '/home/sandbox/tool' }); }, /\/opt\/helpers\/home \(in PATH/],
    // Round 17: through a link in the work tree, the destination read-only: a run could retarget the link.
    [(box) => { box.tree.set('/opt/helpers', { type: 'l', target: '/work/helper-path' }); box.tree.set('/work/helper-path', { type: 'l', target: '/opt/helpers-v1' }); set(box, '/opt/helpers-v1/helper', 'x'); }, /\/opt\/helpers \(in PATH/]
  ]) {
    const sb = claimSandbox({ onBox: seed, scripts: { 'vcr-framework': framework } });
    const r = await runClaim(sb);
    assert.equal(r.outcome, 'requester_error', show(r));
    assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
    assert.match(r.issues[0].detail, re);
    assert.ok(!sb.execs().some((d) => d.kind === 'vcr-build' || d.kind === 'vcr-poc'), 'no maker command ran');
  }
  // solc, through a link on the read-only root.
  const sb = claimSandbox({ onBox: (box) => box.tree.set('/opt/solc/solc', { type: 'l', target: '/work/tools/solc' }) });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'requester_error', show(r));
  assert.match(r.issues[0].detail, /\/opt\/solc\/solc \(in PATH/);
  // Round 17: a PATH directory the sandbox can search but not list could hold a link nobody saw.
  const hid = await runClaim(claimSandbox({ onBox: (box) => box.tree.set('/opt/helpers', { type: 'd', mode: '111', content: '' }), scripts: { 'vcr-framework': framework } }));
  assert.equal(hid.outcome, 'requester_error', show(hid));
  assert.deepEqual(hid.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
  assert.match(hid.issues[0].detail, /\/opt\/helpers \(in PATH or the runner's tools\) cannot be listed/);
});

test('A3a R16-F1 (round 18): the runner\'s own tools are held to it too: a link in hermetic()\'s PATH through the work tree is refused, whatever the image\'s PATH says', async () => {
  // /usr/local/bin/find -> /work/find-link -> /usr/bin/find: a retarget would run a claim's program as the snapshot's find.
  const sb = claimSandbox({ onBox: (box) => {
    set(box, '/usr/local/bin/keep', 'x');
    box.tree.set('/usr/local/bin/find', { type: 'l', target: '/work/find-link' });
    box.tree.set('/work/find-link', { type: 'l', target: '/usr/bin/find' });
  } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'requester_error', show(r));
  assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
  assert.match(r.issues[0].detail, /\/usr\/local\/bin\/find \(in PATH, the runner's tools or solc\) resolves through/);
  assert.ok(!sb.execs().some((d) => d.kind === 'vcr-manifest' || d.kind === 'vcr-build' || d.kind === 'git'), 'before the checkout, the patch or a snapshot could run it');
});

test('A3a R16-F1 (round 19): a file a patch adds cannot be a tool or forge: a dangling link to it is refused before the patch; forge or a PATH directory under paths.tests before forge runs', async () => {
  const { forgeConfig } = require('../helpers/fakeClaim');
  // /usr/local/bin/find -> /work/test/find, dangling until a patch adds test/find.
  const sb = claimSandbox({ onBox: (box) => { set(box, '/usr/local/bin/keep', 'x'); box.tree.set('/usr/local/bin/find', { type: 'l', target: '/work/test/find' }); } });
  const r = await runClaim(sb);
  assert.equal(r.outcome, 'requester_error', show(r));
  assert.match(r.issues[0].detail, /\/usr\/local\/bin\/find \(in PATH/);
  assert.ok(!sb.execs().some((d) => d.kind === 'git'), 'the patch was never applied');
  // A link to forge in a PATH directory off the tools': walked before forge first runs.
  const viaPath = (d, box) => ({ stdout: `vcr-forge /opt/helpers/forge\nvcr-path /opt/helpers:/usr/bin\nvcr-real /work/test/forge\n${forgeConfig(box.tree)}` });
  const f = claimSandbox({ onBox: (box) => box.tree.set('/opt/helpers/forge', { type: 'l', target: '/work/test/forge' }), scripts: { 'vcr-framework': viaPath } });
  const fr = await runClaim(f);
  assert.equal(fr.outcome, 'requester_error', show(fr));
  assert.deepEqual(fr.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
  assert.match(fr.issues[0].detail, /forge \(\/work\/test\/forge\) is under paths\.tests/);
  assert.ok(!f.execs().some((d) => d.forge), 'a patch\'s file never ran as forge');
  // PATH=/work/test:…: refused before forge runs, whatever forge's configuration would have said.
  const inTests = (d, box) => ({ stdout: `vcr-forge /work/test/forge\nvcr-path /work/test:/usr/bin\nvcr-real /work/test/forge\n${forgeConfig(box.tree)}` });
  const t = claimSandbox({ scripts: { 'vcr-framework': inTests } });
  const tr = await runClaim(t);
  assert.equal(tr.outcome, 'requester_error', show(tr));
  assert.ok(!t.execs().some((d) => d.forge), 'a patch\'s file never ran as forge');
  // The listing check holds the same: its prepare is the claim's.
  const { validateListingRequest, listingSteps, imageUnpackedBytes } = require('../../src/listing');
  const body = { spec: { version: 1, kind: 'bug', repo: 'https://github.com/acme/vault', baseCommit: BASE, env: { from: 'foundry' }, commands: forgeSpec().commands, paths: forgeSpec().paths, stake: { scope: { include: ['src/**'] } } }, image: IMAGE, deadline: 900000 };
  const v = validateListingRequest(body);
  assert.ok(v.ok, JSON.stringify(v.issues));
  const l = claimSandbox({ handlers: { history: () => ({ stdout: '400000000\n' }) }, onBox: (box) => { set(box, '/usr/local/bin/keep', 'x'); box.tree.set('/usr/local/bin/find', { type: 'l', target: '/work/test/find' }); } });
  const receivedAt = Date.now();
  const lr = await executeRun({
    docker: l.docker, config: testConfig(), limits: v.limits, image: IMAGE, runId: '0123456789abcdef',
    steps: listingSteps(v.request, v.limits, { imageSize: () => imageUnpackedBytes(l.docker, IMAGE), platform: 'linux/amd64', solcList: fakeSolcList() }),
    receivedAt, deadlineAt: receivedAt + 900000, active: new Set(), log: silent, admit: async () => {}
  });
  assert.equal(lr.outcome, 'requester_error', JSON.stringify(lr.abstain || lr.facts.listing));
  assert.deepEqual(lr.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
});

test('A3a R16-F1: links on the read-only root that stay there are fine (merged /usr, alternatives); asked once, hermetic, before the listing; the walk is A1\'s launcher check; a broken answer is the runner\'s', async () => {
  const { forgeConfig } = require('../helpers/fakeClaim');
  const { IMMUTABLE_CHECK } = require('../../src/integrity');
  const { WALK_CHECK } = require('../../src/launcher');
  const framework = (d, box) => ({ stdout: `vcr-forge /usr/local/bin/forge\nvcr-path /work/.bin:/home/sandbox/bin:/opt/helpers:/bin:/usr/bin\n${forgeConfig(box.tree)}` });
  const ok = claimSandbox({
    onBox: (box) => { box.tree.set('/bin', { type: 'l', target: 'usr/bin' }); set(box, '/usr/bin/mawk', 'ELF'); box.tree.set('/usr/bin/awk', { type: 'l', target: '/etc/alternatives/awk' }); box.tree.set('/etc/alternatives/awk', { type: 'l', target: '/usr/bin/mawk' }); },
    scripts: { 'vcr-framework': framework }
  });
  const fine = await runClaim(ok);
  assert.equal(fine.outcome, 'definitive', show(fine));
  assert.equal(fine.gates.integrity.status, 'pass', show(fine));
  const asked = ok.execs().filter((d) => d.kind === 'vcr-external-roots');
  assert.equal(asked.length, 5, 'the way there is out of the sandbox user\'s reach: no need to ask again after a run');
  for (const a of asked) {
    assert.deepEqual(a.launched.slice(0, 2), ['/usr/bin/env', '-i']);
    assert.equal(a.argv[4], IMMUTABLE_CHECK);
  }
  // First the tools' directories, before the checkout; then the image's PATH outside them, the work tree and $HOME, before
  // forge first runs; then solc, which only forge's configuration names.
  const list = (a) => a.stdin.toString('latin1').split('\0').filter(Boolean);
  // A1's walk; owning something counts only on the mounts the sandbox can write (the builder chowns /repo, on the read-only root).
  assert.ok(IMMUTABLE_CHECK.endsWith(WALK_CHECK));
  assert.match(IMMUTABLE_CHECK.split('\n')[0], /case \$1 in \/proc\|\/proc\/\*\) exit 1 ;; \/work\|\/work\/\*\|\/tmp\|\/tmp\/\*\|\/home\/sandbox\|\/home\/sandbox\/\*\) ;; \*\) return 0/);
  assert.deepEqual(list(asked[0]), ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin']);
  assert.deepEqual(list(asked[1]), ['/opt/helpers']);
  assert.deepEqual(list(asked[2]), ['/opt/solc/solc']);
  const order = ok.execs().map(label);
  assert.equal(order.indexOf('vcr-external-roots'), 1, 'right after the processes are recorded');
  assert.ok(order.indexOf('vcr-external-roots') < order.indexOf('git init'));
  const config = order.indexOf('forge-config');
  assert.equal(order[config - 1], 'vcr-external-roots', 'PATH walked before forge first runs');
  assert.equal(order[config + 1], 'vcr-svm', 'the installed releases are listed next');
  assert.equal(order[config + 2], 'vcr-external-roots', 'solc right after its configuration names it');
  for (const bad of [() => ({ exitCode: 1 }), () => ({ stdout: Buffer.from('odd\0') }), () => ({ stdout: Buffer.from('p\0?\0') })]) {
    const r = await runClaim(claimSandbox({ scripts: { 'vcr-external-roots': bad } }));
    assert.equal(r.outcome, 'abstain', show(r));
    assert.equal(r.abstain.cause, 'runner_error');
  }
});

// ------------------------------------------------ Q32: what the claim did not do is not held against it

test('Q32: what changes a watched place during the build, before any claim code, is the image\'s doing: the requester\'s error, never a failed integrity check on an honest claim', async () => {
  for (const [what, write, re] of [
    ['a compiler that writes into lib/', (box) => set(box, '/work/lib/trap.sol', 'x'), /the build: lib\/trap\.sol added/],
    ['a program that rewrites foundry.toml', (box) => set(box, '/work/foundry.toml', '[profile.default]\nffi = true\n'), /the build: foundry\.toml changed/],
    ['a program that leaves a directory unlistable', (box) => box.tree.set('/work/anywhere', { type: 'd', mode: '111', content: '' }), /the build: anywhere cannot be read/]
  ]) {
    const sb = claimSandbox({ scripts: { 'vcr-build': (d, box) => { write(box); return { exitCode: 0 }; } } });
    const r = await runClaim(sb);
    assert.equal(r.outcome, 'requester_error', `${what}: ${show(r)}`);
    assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_CHANGED_BY_BUILD'], what);
    assert.match(r.issues[0].detail, re);
    assert.equal(r.gates.integrity, undefined, 'no integrity gate is decided');
    assert.ok(!sb.execs().some((d) => d.kind === 'vcr-poc'), 'no claim code ran');
  }
  // A build that failed and wrote is the image's too; a build that failed and wrote nothing stays the build gate's.
  const failed = await runClaim(claimSandbox({ scripts: { 'vcr-build': (d, box) => { set(box, '/work/lib/trap.sol', 'x'); return { exitCode: 1 }; } } }));
  assert.equal(failed.outcome, 'requester_error', show(failed));
  const plain = await runClaim(claimSandbox({ scripts: { 'vcr-build': () => ({ exitCode: 1 }) } }));
  assert.equal(plain.outcome, 'definitive', show(plain));
  assert.equal(plain.gates.build.status, 'fail');
  // A run's own change is still the claim's: the same write in run 1 fails integrity.
  const inRun = (d, k, box) => { set(box, '/work/lib/trap.sol', 'x'); return { exitCode: 1, stdout: drainFails() }; };
  assertIntegrityFails(await runClaim(claimSandbox({ poc: [inRun, inRun, inRun] })), ['dependenciesUnchanged'], /run 1: lib\/trap\.sol added/);
});

test('A3a R21-F1: where forge itself writes is never held to the reference, whatever else names it: a protected glob over out/ or cache/, a `libs` entry holding out, a test\'s artifact compiled in run 1', async () => {
  // `--skip test`: the build writes no test artifact; run 1 compiles the PoC. With a glob over that artifact the honest claim failed.
  const compile = (d, k, box) => { if (k === 1) set(box, '/work/out/Exploit.t.sol/ExploitTest.json', '{"bytecode":"0x6081"}'); return { exitCode: 1, stdout: drainFails() }; };
  for (const globs of [['out/Exploit.t.sol/**'], ['out/**'], ['**/*.json'], ['cache/**']]) {
    const spec = forgeSpec({ paths: { tests: ['test/**'], protected: ['foundry.toml', ...globs] }, commands: { build: 'forge build --skip test' } });
    const r = await runClaim(claimSandbox({ poc: [compile, drainFails(), drainFails()] }), claimRequest({ spec }));
    assert.equal(r.outcome, 'definitive', `${globs}: ${show(r)}`);
    assert.equal(r.gates.integrity.status, 'pass', `${globs}: ${show(r)}`);
    assert.equal(r.gates.reproduces.status, 'pass', `${globs}: ${show(r)}`);
  }
  // out = "lib/out": a dependency root holding forge's output.
  const inLib = claimSandbox({
    onBox: (box) => { box.configOver = { out: 'lib/out' }; },
    scripts: { 'vcr-build': (d, box) => { set(box, '/work/lib/out/Vault.sol/Vault.json', '{}'); return { exitCode: 0 }; } }
  });
  const lib = await runClaim(inLib);
  assert.equal(lib.gates.integrity.status, 'pass', show(lib));
  // Still held: from run 1 on, as artifacts; and a real dependency beside it.
  const later = (d, k, box) => { if (k === 2) set(box, '/work/out/Vault.sol/Vault.json', '{"bytecode":"0xfe"}'); return { exitCode: 1, stdout: drainFails() }; };
  const specOut = forgeSpec({ paths: { tests: ['test/**'], protected: ['foundry.toml', 'out/**'] } });
  const tampered = await runClaim(claimSandbox({ poc: [later, later, later] }), claimRequest({ spec: specOut }));
  assertIntegrityFails(tampered, ['frameworkUnchanged'], /run 2: out\/Vault\.sol\/Vault\.json changed/);
  const dep = (d, k, box) => { set(box, '/work/lib/forge-std/src/Test.sol', 'changed'); return { exitCode: 1, stdout: drainFails() }; };
  const depChanged = await runClaim(claimSandbox({ onBox: (box) => { box.configOver = { out: 'lib/out' }; }, poc: [dep, dep, dep] }));
  assertIntegrityFails(depChanged, ['dependenciesUnchanged'], /run 1: lib\/forge-std\/src\/Test\.sol changed/);
});

test('A3a R22-F1: a watched input the image already has inside forge\'s output is refused before any maker command or claim code, so a run could not rewrite it as an artifact', async () => {
  const refused = (r, re) => {
    assert.equal(r.outcome, 'requester_error', show(r));
    assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
    assert.match(r.issues[0].detail, re);
  };
  // out = "lib" beside what lib/ holds: everything there would have been exempt.
  const dep = claimSandbox({ onBox: (box) => { box.configOver = { out: 'lib' }; } });
  refused(await runClaim(dep), /lib\/forge-std\/src\/Test\.sol is watched and lies where forge writes/);
  assert.equal(dep.execs().filter((d) => d.kind === 'vcr-build' || d.kind === 'vcr-poc').length, 0);
  // A protected glob over what the setup built: `forge test` compiles again with other settings and rewrites it.
  const seed = (box) => { set(box, '/work/out/Base.t.sol/Base.json', '{}'); set(box, '/work/cache/solidity-files-cache.json', '{}'); };
  for (const [glob, re] of [['out/Base.t.sol/**', /out\/Base\.t\.sol\/Base\.json/], ['cache/**', /cache\/solidity-files-cache\.json/], ['**/*.json', /out\/Base\.t\.sol\/Base\.json/]]) {
    const spec = forgeSpec({ paths: { tests: ['test/**'], protected: ['foundry.toml', glob] } });
    refused(await runClaim(claimSandbox({ onBox: seed }), claimRequest({ spec })), re);
  }
  // The same image with nothing watched over it is no conflict: what a build leaves in out/ is an artifact.
  const plain = await runClaim(claimSandbox({ onBox: seed }));
  assert.equal(plain.gates.integrity.status, 'pass', show(plain));
  // Forge's output behind a link, or a link inside it: forge writes through it to where no rule here names.
  const behind = claimSandbox({ onBox: (box) => { box.tree.set('/work/out', { type: 'l', target: 'build/artifacts' }); set(box, '/work/build/artifacts/V.json', '{}'); } });
  refused(await runClaim(behind), /out is a link where forge writes/);
  const onTheWay = claimSandbox({ onBox: (box) => { box.configOver = { out: 'build/out' }; box.tree.set('/work/build', { type: 'l', target: 'elsewhere' }); } });
  refused(await runClaim(onTheWay), /build is a link on the way to build\/out, where forge writes/);
  const inside = claimSandbox({ onBox: (box) => { box.tree.set('/work/out/E.t.sol', { type: 'l', target: '../y' }); } });
  refused(await runClaim(inside), /out\/E\.t\.sol is a link where forge writes/);
});

test('A3a: what else forge writes in a plain run (an invariant\'s failure_persist_dir, a maker\'s foundry.toml) is forge\'s output: an honest PoC passes, a watched input already there is refused, and outside the work tree it is refused', async () => {
  const persist = { invariant: { failure_persist_dir: 'lib/persist' } };
  const writes = (d, k, box) => { set(box, '/work/lib/persist/failures/E/invariants/invariant_x', 'seq'); return { exitCode: 1, stdout: drainFails() }; };
  const honest = await runClaim(claimSandbox({ onBox: (box) => { box.configOver = persist; }, poc: [writes, writes, writes] }));
  assert.equal(honest.outcome, 'definitive', show(honest));
  assert.equal(honest.gates.integrity.status, 'pass', show(honest));
  // A real dependency beside it stays held.
  const dep = (d, k, box) => { set(box, '/work/lib/forge-std/src/Test.sol', 'changed'); return { exitCode: 1, stdout: drainFails() }; };
  assertIntegrityFails(await runClaim(claimSandbox({ onBox: (box) => { box.configOver = persist; }, poc: [dep, dep, dep] })), ['dependenciesUnchanged'], /lib\/forge-std\/src\/Test\.sol changed/);
  const over = await runClaim(claimSandbox({ onBox: (box) => { box.configOver = { fuzz: { failure_persist_dir: 'lib/forge-std' } }; } }));
  assert.equal(over.outcome, 'requester_error', show(over));
  assert.deepEqual(over.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
  assert.match(over.issues[0].detail, /lib\/forge-std\/src\/Test\.sol is watched and lies where forge writes/);
  for (const value of ['/home/sandbox/persist', '../persist', '.git/persist']) {
    const away = await runClaim(claimSandbox({ onBox: (box) => { box.configOver = { invariant: { failure_persist_dir: value } }; } }));
    assert.equal(away.outcome, 'requester_error', `${value}: ${show(away)}`);
    assert.deepEqual(away.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
    assert.match(away.issues[0].detail, /invariant\.failure_persist_dir/);
  }
});

test('A3a R21-F1 (round 22): a protected root behind a link into forge\'s output is refused at the reference, though it resolves to nothing until run 1 compiles', async () => {
  const seed = (box) => { box.tree.set('/work/artifact-alias', { type: 'l', target: 'out' }); };
  const links = (d) => ({ stdout: Buffer.from(d.stdin.toString('latin1').split('\0').filter(Boolean).map((p) => `?\0${p}\0/work/out/Exploit.t.sol\0`).join(''), 'latin1') });
  const spec = forgeSpec({ paths: { tests: ['test/**'], protected: ['foundry.toml', 'artifact-alias/Exploit.t.sol/**'] }, commands: { build: 'forge build --skip test' } });
  const sb = claimSandbox({ onBox: seed, scripts: { 'vcr-links': links } });
  const r = await runClaim(sb, claimRequest({ spec }));
  assert.equal(r.outcome, 'requester_error', show(r));
  assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_LINK_UNCOVERED']);
  assert.match(r.issues[0].detail, /artifact-alias\/Exploit\.t\.sol -> \/work\/out\/Exploit\.t\.sol \(forge's out directory \(out\)\)/);
  assert.equal(sb.execs().filter((d) => d.kind === 'vcr-build' || d.kind === 'vcr-poc').length, 0);
});

test('owner decision Q35: settlement can tell, from fields of verdikta.claim-report/1 alone, a tamper flag from any other failed check, and a reproduces failure only through integrity from one on its own', async () => {
  const SUITE = 'test/Exploit.t.sol:ExploitTest';
  const passes = junit([{ suite: SUITE, cases: [{ name: 'test_drain()' }] }]);
  const skipped = junit([{ suite: SUITE, cases: [{ name: 'test_drain()', skipped: true }] }]);
  const harness = junit([{ suite: SUITE, cases: [{ name: 'test_drain()', failure: 'vault drained' }] }, { suite: 'test/Exploit.t.sol:Helper', cases: [{ name: 'setUp()', failure: 'cannot deploy' }] }]);
  const touch = (out) => (d, k, box) => { set(box, '/work/lib/forge-std/src/Test.sol', `changed ${k}`); return { exitCode: hasFailureText(out) ? 1 : 0, stdout: out }; };
  const flagged = POC_DIFF.replace('+// end', '+// vm.writeFile("lib/forge-std/src/StdAssertions.sol", "")');
  // forge-std is the framework's, a dependency, and under the spec's protected `lib/**`.
  const held = ['protectedPathsUnchanged', 'frameworkUnchanged', 'dependenciesUnchanged'];
  const fails = drainFails();
  for (const [name, over, want] of [
    ['clean', {}, { integrity: 'pass', tampered: false, failedChecks: [], reproduces: 'pass', reproducesFailed: null }],
    ['another check alone', { poc: [fails, touch(fails), fails] }, { integrity: 'fail', tampered: false, failedChecks: held, reproduces: 'fail', reproducesFailed: 'only-through-integrity' }],
    ['a tamper flag alone', { diff: flagged }, { integrity: 'fail', tampered: true, failedChecks: [], reproduces: 'fail', reproducesFailed: 'only-through-integrity' }],
    ['a tamper flag and another check', { diff: flagged, poc: [touch(fails), fails, fails] }, { integrity: 'fail', tampered: true, failedChecks: held, reproduces: 'fail', reproducesFailed: 'only-through-integrity' }],
    ['the PoC passes on run 2', { poc: [fails, passes, fails] }, { integrity: 'pass', tampered: false, failedChecks: [], reproduces: 'fail', reproducesFailed: 'on-its-own' }],
    ['the PoC passes on run 2, and another check', { poc: [fails, touch(passes), fails] }, { integrity: 'fail', tampered: false, failedChecks: held, reproduces: 'fail', reproducesFailed: 'on-its-own' }],
    ['a harness record fails beside tests that all fail', { poc: [harness, harness, harness] }, { integrity: 'pass', tampered: false, failedChecks: [], reproduces: 'fail', reproducesFailed: 'on-its-own' }],
    ['a harness record on run 2 only, and another check', { poc: [fails, touch(harness), fails] }, { integrity: 'fail', tampered: false, failedChecks: held, reproduces: 'fail', reproducesFailed: 'on-its-own' }],
    ['a skip on run 2', { poc: [fails, skipped, fails] }, { integrity: 'fail', tampered: false, failedChecks: ['identityComplete'], reproduces: 'fail', reproducesFailed: 'on-its-own' }]
  ]) {
    const r = await runClaim(claimSandbox(over));
    assert.equal(r.outcome, 'definitive', `${name}: ${show(r)}`);
    const { valid, issues, ...got } = settlementFacts(r);
    assert.deepEqual(issues, [], `${name}: common's validator`);
    assert.equal(valid, true, name);
    assert.deepEqual(got, want, name);
    // The runner's own basis says the same, for a reader of its result.
    assert.equal(r.gates.reproduces.basis === 'integrity', want.reproducesFailed === 'only-through-integrity', `${name}: ${r.gates.reproduces.basis}`);
  }
  // No JUnit, and so no test the patch added, is a failure on its own, whatever else.
  const none = await runClaim(claimSandbox({ poc: [{ exitCode: 1, stdout: 'Compiler run failed' }, fails, fails] }));
  assert.equal(settlementFacts(none).reproducesFailed, 'on-its-own', show(none));
  assert.deepEqual(settlementFacts(none).issues, []);
  // The build's failure is no PoC at all: a gate, INVALID.
  const noBuild = await runClaim(claimSandbox({ scripts: { 'vcr-build': () => ({ exitCode: 1, stderr: 'Compiler run failed' }) } }));
  assert.equal(noBuild.gates.build.status, 'fail', show(noBuild));
  assert.deepEqual(settlementFacts(noBuild), { valid: true, issues: [], integrity: 'not-run', tampered: false, failedChecks: [], reproduces: 'not-run', reproducesFailed: null });
});

test('owner decision Q37: the read before any patch decides the pin, and every later forge run carries it: a release, a path outside the work tree, or empty; a compiler in the work tree is refused; forge answering otherwise under the pin is refused', async () => {
  const pinOf = (d) => { const e = d.launched.find((a) => a.startsWith('FOUNDRY_SOLC=')); return e === undefined ? undefined : e.slice('FOUNDRY_SOLC='.length); };
  for (const [solc, pin] of [['0.8.31', '0.8.31'], ['/opt/solc/solc', '/opt/solc/solc'], [null, '']]) {
    const sb = claimSandbox({ onBox: (box) => { box.configOver = { solc }; } });
    const r = await runClaim(sb);
    assert.equal(r.gates.integrity.status, 'pass', `${solc}: ${show(r)}`);
    const execs = sb.execs();
    const forge = execs.filter((d) => d.forge);
    assert.equal(pinOf(forge[0]), undefined, 'the read that decides it has no pin');
    assert.equal(forge[0].kind, 'forge-config');
    assert.ok(execs.indexOf(forge[0]) < execs.findIndex((d) => d.kind === 'git' && d.sub[0] === 'apply'), 'before any patch');
    assert.ok(execs.findIndex((d) => d.kind === 'git' && d.sub[0] === 'apply') < execs.indexOf(forge[1]), 'and only that one');
    for (const d of forge.slice(1)) assert.equal(pinOf(d), pin, `${solc}: ${d.kind}`);
    assert.ok(forge.length >= 6);
  }
  // forge answers with something else under the pin: nothing later could be read as the pinned compiler's.
  let n = 0;
  const { forgeConfig } = require('../helpers/fakeClaim');
  const moved = claimSandbox({ scripts: { 'vcr-framework': (d, box) => { n += 1; return { stdout: `vcr-forge /usr/local/bin/forge\nvcr-path /usr/bin\n${forgeConfig(box.tree, n === 1 ? {} : { solc: '/opt/other/solc' })}` }; } } });
  const r = await runClaim(moved);
  assert.equal(r.outcome, 'requester_error', show(r));
  assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
  assert.match(r.issues[0].detail, /forge reads solc as "\/opt\/other\/solc" with FOUNDRY_SOLC set to "\/opt\/solc\/solc"/);
  assert.equal(moved.execs().filter((d) => d.kind === 'vcr-build').length, 0);
  // The watch itself will not run forge without one.
  const { Watch } = require('../../src/integrity');
  assert.throws(() => new Watch({}), /compiler pinned/);
});

test('A3a R24-F1: a compiler a patch could replace is refused before any patch, since forge runs it from its first start: in the work tree by any form, or outside it through a place the sandbox can write', async () => {
  for (const solc of ['test/solc', 'bin/solc', './bin/solc', '/work/test/solc', 'solc', '0.8.31/solc', '00.8.31', '0.8.31-tools/solc', '/opt/../work/test/solc']) {
    const sb = claimSandbox({ onBox: (box) => { box.configOver = { solc }; } });
    const r = await runClaim(sb);
    assert.equal(r.outcome, 'requester_error', `${solc}: ${show(r)}`);
    assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
    assert.match(r.issues[0].detail, /is in the work tree, where a patch could replace it/);
    assert.equal(sb.execs().filter((d) => d.kind === 'git' && d.sub[0] === 'apply').length, 0, `${solc}: no patch applied`);
  }
  // A release forge looks up itself, and a compiler on the read-only root, are nothing.
  for (const solc of ['0.8.31', '/opt/solc/solc']) {
    const r = await runClaim(claimSandbox({ onBox: (box) => { box.configOver = { solc }; } }));
    assert.equal(r.gates.integrity.status, 'pass', `${solc}: ${show(r)}`);
  }
  // A dangling link there, to a file a patch would add, and any way through the work tree.
  const linked = claimSandbox({ onBox: (box) => box.tree.set('/opt/solc/solc', { type: 'l', target: '/work/test/solc' }) });
  const viaRoot = await runClaim(linked);
  assert.equal(viaRoot.outcome, 'requester_error', show(viaRoot));
  assert.deepEqual(viaRoot.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
  assert.equal(linked.execs().filter((d) => d.kind === 'git' && d.sub[0] === 'apply').length, 0, 'no patch applied');
  // R24-F1, round 26: a release named by version, installed as a link a patch could fill.
  const svm = claimSandbox({ onBox: (box) => { box.configOver = { solc: '0.8.31' }; box.tree.set('/opt/verdikta/tools/share/svm/0.8.31/solc-0.8.31', { type: 'l', target: '/work/test/solc' }); } });
  const viaSvm = await runClaim(svm);
  assert.equal(viaSvm.outcome, 'requester_error', show(viaSvm));
  assert.deepEqual(viaSvm.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
  assert.match(viaSvm.issues[0].detail, /svm\/0\.8\.31\/solc-0\.8\.31 \(in PATH, the runner's tools or solc\) resolves through a place the sandbox can write/);
  assert.equal(svm.execs().filter((d) => d.kind === 'git' && d.sub[0] === 'apply').length, 0, 'no patch applied');
  // A real file there is nothing.
  const installed = await runClaim(claimSandbox({ onBox: (box) => { box.configOver = { solc: '0.8.31' }; set(box, '/opt/verdikta/tools/share/svm/0.8.31/solc-0.8.31', 'ELF'); } }));
  assert.equal(installed.gates.integrity.status, 'pass', show(installed));
  // R24-F1, round 27: an adapter, anywhere; a solver named by a path in the work tree; bare solver names are PATH's, and fine.
  const adapter = claimSandbox({ onBox: (box) => { box.configOver = { external_compilers: [{ id: 'x', command: '/opt/adapter', roots: ['test'] }] }; } });
  const viaAdapter = await runClaim(adapter);
  assert.equal(viaAdapter.outcome, 'requester_error', show(viaAdapter));
  assert.deepEqual(viaAdapter.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
  assert.match(viaAdapter.issues[0].detail, /external_compilers names 1 adapter/);
  assert.equal(adapter.execs().filter((d) => d.kind === 'git' && d.sub[0] === 'apply').length, 0, 'no patch applied');
  for (const [symbolic, re] of [
    [{ solver: 'test/z3' }, /symbolic\.solver \(test\/z3\) is in the work tree/],
    [{ solver_command: 'test/z3 -smt2' }, /symbolic\.solver_command \(test\/z3\) is in the work tree/],
    [{ solver_portfolio: ['z3', '"/work/test/cvc5" --lang smt2'] }, /symbolic\.solver_portfolio \(\/work\/test\/cvc5\) is in the work tree/]
  ]) {
    const solver = await runClaim(claimSandbox({ onBox: (box) => { box.configOver = { symbolic }; } }));
    assert.equal(solver.outcome, 'requester_error', show(solver));
    assert.match(solver.issues[0].detail, re);
  }
  const fine = await runClaim(claimSandbox({ onBox: (box) => { box.configOver = { symbolic: { solver: 'z3', solver_command: '', solver_portfolio: ['cvc5', 'yices'] } }; } }));
  assert.equal(fine.gates.integrity.status, 'pass', show(fine));
  // Vyper's, which forge runs for a `.vy` file a patch adds.
  const vyper = await runClaim(claimSandbox({ onBox: (box) => { box.configOver = { vyper: { path: 'test/vyper' } }; } }));
  assert.equal(vyper.outcome, 'requester_error', show(vyper));
  assert.match(vyper.issues[0].detail, /vyper\.path \(test\/vyper\) is in the work tree/);
  // R25-F1: `extends` moves forge's configuration into a file a patch could change; a root file that is a link, the same.
  for (const [seed, re] of [
    [(box) => set(box, '/work/foundry.toml', '[profile.default]\nextends = "test/compiler.toml"\n'), /foundry\.toml uses `extends`/],
    [(box) => set(box, '/work/foundry.toml', '"ext\\u0065nds" = 1\n'), /foundry\.toml uses `extends`, or an escape/],
    [(box) => box.tree.set('/work/foundry.toml', { type: 'l', target: 'test/foundry.toml' }), /foundry\.toml is a link/],
    [(box) => box.tree.set('/work/.env', { type: 'l', target: 'test/.env' }), /\.env is a link/]
  ]) {
    const refused = claimSandbox({ onBox: seed });
    const out = await runClaim(refused);
    assert.equal(out.outcome, 'requester_error', show(out));
    assert.deepEqual(out.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
    assert.match(out.issues[0].detail, re);
    assert.equal(refused.execs().filter((d) => d.forge).length, 0, 'forge never started');
  }
  const comment = await runClaim(claimSandbox({ onBox: (box) => set(box, '/work/foundry.toml', '[profile.default]\n# extends is not used here\n') }));
  assert.notEqual(comment.outcome, 'requester_error', show(comment));
  // forge's configuration under paths.tests, which forge reads at its first start, and not protected: a patch's .env.
  const spec = forgeSpec({ paths: { tests: ['test/**', '.env'], protected: ['foundry.toml', 'lib/**'] } });
  const sb = claimSandbox();
  const env = await runClaim(sb, claimRequest({ spec }));
  assert.equal(env.outcome, 'requester_error', show(env));
  assert.deepEqual(env.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
  assert.match(env.issues[0].detail, /\.env is under paths\.tests and not protected/);
  const safe = forgeSpec({ paths: { tests: ['test/**', '.env'], protected: ['foundry.toml', 'lib/**', '.env'] } });
  assert.equal((await runClaim(claimSandbox(), claimRequest({ spec: safe }))).gates.integrity.status, 'pass', 'protected: a patch cannot touch it');
});

test('A3a R25-F2: a fix that changes forge\'s own configuration is not built: a fact, a failed fixed build, and the PoC\'s gates stand', async () => {
  const { FIX_PATCH } = require('../helpers/fakeClaim');
  const sb = claimSandbox({ fix: { nameStatus: 'M\0foundry.toml\0', numstat: '1\t1\tfoundry.toml\0' } });
  const spec = forgeSpec({ paths: { tests: ['test/**'], protected: ['lib/**'] } });
  const r = await runClaim(sb, claimRequest({ spec, fixPatch: Buffer.from(FIX_PATCH) }));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.reproduces.status, 'pass', show(r));
  assert.equal(r.facts.fix.applies, 'pass', JSON.stringify(r.facts.fix.detail));
  assert.equal(r.facts.fix.builds, 'fail');
  assert.equal(r.facts.fix.pocPasses, null);
  assert.match(r.facts.fix.detail.builds, /fix\.patch changes foundry\.toml, forge's own configuration/);
  assert.deepEqual(sb.execs().filter((d) => d.box === 2 && d.forge).map((d) => d.kind), ['forge-config'], 'only the read of the listing, before any patch: forge never ran on the fix');
});

test('A3a R23-F1: a listed Solidity file that sets a path by inline configuration is refused right after the checkout, before any patch; other inline settings are nothing', async () => {
  const annotate = (line) => (box) => set(box, '/work/test/Annotated.t.sol', `// SPDX-License-Identifier: MIT\n${line}\ncontract Annotated {}\n`);
  for (const line of [
    '/// forge-config: default.invariant.failure_persist_dir = "lib/persist"',
    '/// forge-config: default.fuzz.corpus_dir = "lib/corpus"',
    '/** forge-config: default.invariant = { frontier_dir = "lib/f" } */',
    '/// forge-config: default.invariant."failure\\u005fpersist\\u005fdir" = "lib/persist"',
    '/// forge-config: default.symbolic.solver_command = "test/z3"'
  ]) {
    const sb = claimSandbox({ onBox: annotate(line) });
    const r = await runClaim(sb);
    assert.equal(r.outcome, 'requester_error', `${line}: ${show(r)}`);
    assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
    assert.match(r.issues[0].detail, /test\/Annotated\.t\.sol sets a path by inline configuration/);
    assert.equal(sb.execs().filter((d) => /^git apply|^vcr-(?:build|poc|framework)/.test(d.kind)).length, 0, 'nothing after the checkout ran');
  }
  const fine = await runClaim(claimSandbox({ onBox: annotate('/// forge-config: default.fuzz.runs = 5') }));
  assert.equal(fine.gates.integrity.status, 'pass', show(fine));
  const noGrep = await runClaim(claimSandbox({ scripts: { 'vcr-inline-config': () => ({ exitCode: 4 }) } }));
  assert.equal(noGrep.outcome, 'requester_error', show(noGrep));
  assert.deepEqual(noGrep.issues.map((i) => i.code), ['IMAGE_TOOL_MISSING']);
  const broken = await runClaim(claimSandbox({ scripts: { 'vcr-inline-config': () => ({ exitCode: 2 }) } }));
  assert.equal(broken.outcome, 'abstain', show(broken));
  assert.equal(broken.abstain.cause, 'runner_error');
});

test('Q32: in the fix check\'s sandbox a build that changes a watched place is a failed fixed build, a fact; the PoC\'s gates stand', async () => {
  const { FIX_PATCH } = require('../helpers/fakeClaim');
  const build = (d, box) => { set(box, '/work/lib/trap.sol', 'x'); return { exitCode: 0 }; };
  const r = await runClaim(claimSandbox({ fix: { build } }), claimRequest({ fixPatch: Buffer.from(FIX_PATCH) }));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.reproduces.status, 'pass', show(r));
  assert.equal(r.facts.fix.builds, 'fail');
  assert.match(r.facts.fix.detail.builds, /^with the fix, IMAGE_WATCH_CHANGED_BY_BUILD: .*the build: lib\/trap\.sol added/);
});
