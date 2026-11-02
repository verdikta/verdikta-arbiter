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
const { BASE, POC_PATCH, POC_DIFF, junit, drainFails, claimSandbox } = require('../helpers/fakeClaim');

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
    'vcr-framework', 'vcr-manifest', 'vcr-build', 'vcr-cleanup',
    // After a run: the files are measured first, then forge runs for its configuration (R1-F3).
    'vcr-poc', 'vcr-cleanup', 'vcr-manifest', 'vcr-framework',
    'git reset', 'vcr-manifest', 'vcr-poc', 'vcr-cleanup', 'vcr-manifest', 'vcr-framework',
    'git reset', 'vcr-manifest', 'vcr-poc', 'vcr-cleanup', 'vcr-manifest', 'vcr-framework'
  ]);
  const manifests = sb.execs().filter((d) => d.kind === 'vcr-manifest');
  // Every snapshot is hermetic (nothing of the image's environment reaches find or sha256sum).
  for (const m of manifests) assert.deepEqual(m.launched.slice(0, 2), ['/usr/bin/env', '-i']);
  assert.deepEqual(manifests[0].argv.slice(4, 6), ['/work', '/home/sandbox']);
  assert.deepEqual(manifests[2].argv.slice(4), ['/work/.git', '-xdev'], 'after a reset: the runner\'s repository only');
  // The framework probe runs as the maker's commands do (the image's PATH), forge from the reference's own path afterwards.
  const probes = sb.execs().filter((d) => d.kind === 'vcr-framework');
  assert.equal(probes[0].launched[0], '/bin/sh');
  assert.deepEqual(probes.slice(1).map((p) => p.argv[4]), ['/usr/local/bin/forge', '/usr/local/bin/forge', '/usr/local/bin/forge']);
});

test('every fact carries its tier: A for what the runner observed from outside, B for results from a process that ran claim code', async () => {
  const sb = claimSandbox();
  const r = await runClaim(sb, claimRequest({ fixPatch: Buffer.from(require('../helpers/fakeClaim').FIX_PATCH) }));
  assert.equal(r.outcome, 'definitive', show(r));
  const want = {
    checkout: 'A', patch: 'A', commit: 'A', diff: 'A', testPaths: 'A', flags: 'A', protectedReset: 'A', leftoverProcesses: 'A',
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
    [{ 'vcr-manifest': () => ({ stdout: Buffer.alloc(64 * 1024 * 1024 + 1, 0x61) }) }, 'IMAGE_WATCH_TOO_LARGE']
  ];
  for (const [scripts, code] of cases) {
    const r = await runClaim(claimSandbox({ scripts }));
    assert.equal(r.outcome, 'requester_error', `${code}: ${show(r)}`);
    assert.deepEqual(r.issues.map((i) => i.code), [code]);
  }
  // After a run: the listing overflows, or forge's configuration no longer loads.
  let n = 0;
  const flood = (d, box) => { n += 1; if (n === 2) return { stdout: Buffer.alloc(64 * 1024 * 1024 + 1, 0x61) }; return { stdout: require('../helpers/fakeClaim').manifestOf(box.tree, d.argv.slice(4)) }; };
  const r1 = await runClaim(claimSandbox({ scripts: { 'vcr-manifest': flood } }));
  assertIntegrityFails(r1, ['protectedPathsUnchanged', 'frameworkUnchanged', 'dependenciesUnchanged'], /run 1: the watched paths exceed/);
  let p = 0;
  const broken = (d, box) => { p += 1; return p === 1 ? { stdout: `vcr-forge /usr/local/bin/forge\nvcr-path /usr/bin\n${forgeConfig(initialTree())}` } : { exitCode: 1, stdout: 'vcr-forge /usr/local/bin/forge\nvcr-path /usr/bin\n' }; };
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

/**
 * The Verification Report the facts and gates make (A3b builds the real one): a test-only mapping, so
 * @verdikta/common's validator can check that no outcome of the gates and the fix check breaks the
 * report's one form (R6-F1: a fix that applied is never `builds: not-run`).
 */
function toReport(r, request) {
  const g = (name) => (r.gates[name] ? r.gates[name].status : 'not-run');
  const f = r.facts;
  const stat = (d) => (d ? { files: d.files, added: d.added, removed: d.removed } : { files: 0, added: 0, removed: 0 });
  return {
    schema: 'verdikta.claim-report/1',
    inputs: {
      listingCid: request.listingCid, bcid: request.bcid, envImage: `sha256:${'a'.repeat(64)}`, platform: 'linux/amd64',
      attestationSha256: 'b'.repeat(64), baseCommit: request.spec.baseCommit, pocPatchSha256: f.patch.sha256,
      fixPatchSha256: f.fix.present ? f.fix.patch.sha256 : null, runner: '0.1.0', gvisor: 'runc', semgrepRules: '2026.10',
      eaGates: { disclosure: 'pass', inScope: 'pass' }
    },
    gates: Object.fromEntries(['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable'].map((k) => [k, g(k)])),
    poc: f.poc ? {
      tier: 'B', testCount: f.poc.testCount, runCounts: f.poc.runCounts, tests: f.poc.tests, integrity: f.poc.integrity, honestyFlags: []
    } : null,
    fix: {
      present: f.fix.present, applies: f.fix.applies, builds: f.fix.builds, pocPasses: f.fix.pocPasses, regressions: f.fix.regressions,
      regressionCount: f.fix.regressionCount, tier: 'B', integrity: f.fix.integrity
    },
    build: { status: g('build'), tier: 'A' },
    findings: [],
    flags: f.flags ? { existingTestsModified: f.flags.existingTestsModified, skipMarkersAdded: f.flags.skipMarkersAdded, protectedPathsTouched: f.flags.protectedPathsTouched }
      : { existingTestsModified: [], skipMarkersAdded: [], protectedPathsTouched: [] },
    diff: { poc: stat(f.diff), fix: f.fix.present ? stat(f.fix.diff) : null }
  };
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
  const framework = (d, box) => ({ stdout: `vcr-forge /work/bin/forge\nvcr-path /work/bin:/usr/bin:/bin\nvcr-real /work/bin/forge\n${d.argv[5] === 'noconfig' ? '' : forgeConfig(box.tree)}` });
  const replace = (d, k, box) => { if (k === 1) set(box, '/work/bin/forge', '#!/bin/sh\n# restores itself, then execs the real forge\n'); return { exitCode: 1, stdout: drainFails() }; };
  const sb = claimSandbox({ onBox: (box) => set(box, '/work/bin/forge', 'ELF'), poc: [replace, drainFails(), drainFails()], scripts: { 'vcr-framework': framework } });
  const r = await runClaim(sb);
  assertIntegrityFails(r, ['frameworkUnchanged'], /run 1: bin\/forge changed/);
  assert.match(r.gates.integrity.detail, /forge's executable \/work\/bin\/forge changed; it was not run/);
  const probes = sb.execs().filter((d) => d.kind === 'vcr-framework');
  assert.equal(probes[0].argv[5], undefined, 'the reference runs forge config');
  assert.equal(probes[1].argv[5], 'noconfig', 'after run 1, the replaced forge is not executed');
  // Measured first: the manifest after each run comes before that run's probe.
  const order = sb.execs().map(label);
  assert.ok(order.indexOf('vcr-manifest', order.indexOf('vcr-poc')) < order.indexOf('vcr-framework', order.indexOf('vcr-poc')));
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
