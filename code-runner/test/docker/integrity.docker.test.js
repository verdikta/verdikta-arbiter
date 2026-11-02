'use strict';

// Node A3a against real forge (the base pinned in @verdikta/common, v1.8.5):
// the §9.5 integrity checks, claimedObservable and the fix check, with every
// catalogue fixture of the node in its forge form — ffi and fs-cheatcode
// attempts, stdout mimicking forge's JUnit, lib/ edits — and ordinary PoCs
// that must raise nothing. Under runc locally; CI runs this file under runc
// and under gVisor (runsc). Every container and image is removed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { executeRun } = require('../../src/pipeline');
const { checkSpec } = require('../../src/classLimits');
const { claimSteps } = require('../../src/steps');
const { RUNTIME, silent, instanceId, dockerTestConfig, dockerFor, leftovers, removeAll } = require('./helpers');
const { settlementFacts } = require('../helpers/settlementFacts');
const { VAULT_REPO, FOUNDRY_TOML, vaultBaseline, buildFixture, addFilesPatch, addLinksPatch, modifyPatch, pocFile } = require('./forgeFixture');

const TIMEOUT = 900000;
const fixtures = new Map();
const builder = dockerFor(dockerTestConfig());

const FORGE_STD = '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract StdMarker {}\n';
const PLAIN_TOML = 'fs_permissions = [{ access = "read-write", path = "./state" }]';
const ANNOTATED = [
  '// SPDX-License-Identifier: MIT', 'pragma solidity ^0.8.0;', 'import {Base} from "./Vm.sol";',
  'contract H { uint256 public x; function bump() public { x += 1; } }',
  '/// forge-config: default.invariant.failure_persist_dir = "lib/persist"',
  'contract Annotated is Base {', '    function test_ok() public pure {}', '}', ''
].join('\n');

const VARIANTS = Object.freeze({
  // The vault with a maker-allowed state directory, a tracked forge-std file and an untracked dependency in lib/.
  plain: {
    toml: PLAIN_TOML,
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'mkdir -p lib/solady/src && printf "contract Solady {}\\n" > lib/solady/src/Solady.sol'
  },
  // The same, with ffi enabled by the maker (ffi cannot be enabled inline at forge 1.8.5).
  ffi: {
    toml: 'ffi = true',
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'mkdir -p lib/solady/src && printf "contract Solady {}\\n" > lib/solady/src/Solady.sol'
  },
  // Attempt 2 (ffi): lib/pkg -> ../bridge/../payload with bridge -> vendor/nested (R6-F1, round 7), a decoy at payload/
  // (where collapsing `..` before the link would lead), 20,000 links to `.` in node_modules (R7-F1: a dependency
  // directory the runner always watches; `libs` keeps forge itself out of it, since forge adds node_modules to its libs
  // by default and walks every link there), and a lib root behind a link (libs "deps/lib", deps -> third_party).
  links: {
    toml: 'ffi = true\nlibs = ["lib", "deps/lib"]',
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: [
      'mkdir -p lib/solady/src && printf "contract Solady {}\\n" > lib/solady/src/Solady.sol',
      'mkdir -p vendor/nested vendor/payload payload && touch vendor/nested/.keep',
      'printf "{}\\n" > vendor/payload/fixture.json && printf "{}\\n" > payload/fixture.json',
      'ln -s vendor/nested bridge && ln -s ../bridge/../payload lib/pkg',
      'mkdir -p node_modules && i=0 && while [ $i -lt 20000 ]; do ln -s . node_modules/l$i; i=$((i+1)); done',
      'mkdir -p third_party/lib && printf "contract TP {}\\n" > third_party/lib/TP.sol && ln -s third_party deps'
    ].join(' && ')
  },
  // An image as the builder makes it (stake-attestation/builder/src/dockerfile.js): the fixed ENV, the tools last on PATH,
  // the setup's solc release under XDG_DATA_HOME (foundry.toml names a version, not a path), /repo owned by the sandbox
  // user on the read-only root, and a tool that is a link into /repo.
  builder: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD, 'foundry.toml': FOUNDRY_TOML('ffi = true').replace('solc = "/opt/solc/solc"', 'solc_version = "0.8.31"') },
    setup: [
      'mkdir -p /opt/verdikta/tools/bin /opt/verdikta/tools/share/svm/0.8.31',
      'cp /opt/solc/solc /opt/verdikta/tools/share/svm/0.8.31/solc-0.8.31',
      'printf "#!/bin/sh\\nprintf helper-ran\\n" > tool.sh && chmod 0755 tool.sh && ln -s /repo/tool.sh /opt/verdikta/tools/bin/tool',
      'chmod -R a+rX /opt/verdikta && chown -R 10001:10001 /repo && git config --system --add safe.directory /repo'
    ].join(' && '),
    env: ['XDG_DATA_HOME=/opt/verdikta/tools/share', 'VERDIKTA_TOOLS=/opt/verdikta/tools', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/verdikta/tools/bin']
  },
  // R20-F1: the image's own ENV names shared objects at paths a run can write.
  loader: {
    toml: 'ffi = true',
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    env: ['LD_PRELOAD=/work/hook.so', 'LD_AUDIT=/work/hook.so', 'LD_LIBRARY_PATH=/work/libs', 'GCONV_PATH=/work/libs']
  },
  // Q32, an honest claim's defects: a compiler in the image that writes into lib/ whenever it compiles; forge's out inside
  // lib/; and (open, below) a compiler that waits for the compile `forge test` always does after `forge build`.
  solctrap: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'mv /opt/solc/solc /opt/solc/solc.real && printf \'#!/bin/sh\\ncase " $* " in *" --standard-json "*) printf x > /work/lib/trap.sol ;; esac\\nexec /opt/solc/solc.real "$@"\\n\' > /opt/solc/solc && chmod 0755 /opt/solc/solc'
  },
  outlib: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD, 'foundry.toml': FOUNDRY_TOML().replace('out = "out"', 'out = "lib/out"') }
  },
  // R21-F1, round 22: a link at forge's out before anything is compiled, and one a build left behind in out/.
  outalias: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'ln -s out artifact-alias && mkdir -p out/Prebuilt.sol && printf "{}\\n" > out/Prebuilt.sol/Prebuilt.json'
  },
  // The same dangling route, through a link on the read-only root that the listing never sees.
  outchain: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'ln -s /work/out/Exploit.t.sol/ExploitTest.json /opt/pending && ln -s /opt/pending lib/pending'
  },
  // R22-F1: out is the dependency directory, beside what it holds.
  libout: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD, 'foundry.toml': FOUNDRY_TOML().replace('out = "out"', 'out = "lib"') }
  },
  // What forge writes in a plain run besides out and its cache, and an out that is a link.
  runoutputs: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD, 'foundry.toml': FOUNDRY_TOML('test_failures_file = "lib/failures/tf"\n\n[invariant]\nfailure_persist_dir = "lib/persist"') }
  },
  outlinked: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'mkdir -p build/artifacts && ln -s build/artifacts out'
  },
  // R24-F1: the compiler a link under paths.tests, as the review proposed it.
  solcintests: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD, 'foundry.toml': FOUNDRY_TOML().replace('solc = "/opt/solc/solc"', 'solc = "test/solc"') },
    setup: 'ln -s /opt/solc/solc test/solc'
  },
  // R24-F1, round 25: a compiler path that starts like a release; R25-F1: the compiler in a file `extends` names.
  solcversiondir: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD, 'foundry.toml': FOUNDRY_TOML().replace('solc = "/opt/solc/solc"', 'solc = "0.8.31/solc"') },
    setup: 'mkdir -p 0.8.31 && ln -s /opt/solc/solc 0.8.31/solc'
  },
  // R25-F2: foundry.toml as a fix would change it, not protected.
  fixconfig: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD, 'foundry.toml': FOUNDRY_TOML() }
  },
  extendsconf: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD, 'test/compiler.toml': '[profile.default]\nsolc = "/opt/solc/solc"\n', 'foundry.toml': FOUNDRY_TOML().replace('solc = "/opt/solc/solc"', 'extends = "test/compiler.toml"') }
  },
  // R23-F1: a listed test contract that sets where forge writes by inline configuration, which `forge config` never shows.
  inlinepersist: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD, 'test/Annotated.t.sol': ANNOTATED }
  },
  // R21-F2: invariants, with reverting handlers allowed.
  invariants: { toml: '[profile.default.invariant]\nruns = 3\ndepth = 4\nfail_on_revert = false', files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD } },
  // Known limits (Q35): a fake solc that refuses any compile holding a test it has not seen; repository code that writes lib/.
  solcunseen: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'mv /opt/solc/solc /opt/solc/solc.real && printf \'#!/bin/sh\\ncase " $* " in *" --standard-json "*) in=$(cat); case "$in" in *Exploit*) echo "unsupported source" >&2; exit 1 ;; esac; printf "%%s" "$in" | exec /opt/solc/solc.real "$@" ;; esac\\nexec /opt/solc/solc.real "$@"\\n\' > /opt/solc/solc && chmod 0755 /opt/solc/solc'
  },
  solclater: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'mv /opt/solc/solc /opt/solc/solc.real && printf \'#!/bin/sh\\ncase " $* " in *" --standard-json "*) if [ -e /work/cache/solidity-files-cache.json ]; then echo "unsupported source" >&2; exit 1; fi ;; esac\\nexec /opt/solc/solc.real "$@"\\n\' > /opt/solc/solc && chmod 0755 /opt/solc/solc'
  },
  repoffi: {
    toml: 'ffi = true',
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD, 'scripts/setup-fixture.sh': 'printf x > lib/trap.sol\n' }
  },
  solcsecond: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'mv /opt/solc/solc /opt/solc/solc.real && printf \'#!/bin/sh\\ncase " $* " in *" --standard-json "*) [ ! -e /work/cache/solidity-files-cache.json ] || printf x > /work/lib/trap.sol ;; esac\\nexec /opt/solc/solc.real "$@"\\n\' > /opt/solc/solc && chmod 0755 /opt/solc/solc'
  },
  // R16-F1: a PATH directory on the read-only root that is a link into the work tree, and a link into it in a read-only one.
  pathalias: {
    toml: 'ffi = true',
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'ln -s /work/helpers /opt/helpers',
    env: ['PATH=/opt/helpers:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']
  },
  pathlink: {
    toml: 'ffi = true',
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'ln -s /work/helpers/helper /usr/local/bin/helper'
  },
  // Round 19: the snapshot's find a dangling link to a file a patch would add.
  toolpatch: {
    toml: 'ffi = true',
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'ln -s /work/test/find /usr/local/bin/find'
  },
  // Round 18: the runner's own tool behind a link in the work tree, ending back on the root.
  toolchain: {
    toml: 'ffi = true',
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'ln -s /work/sum-link /usr/local/bin/sha256sum && ln -s /usr/bin/sha256sum sum-link'
  },
  // Round 17: the alias through a link in the work tree, ending back on the root; a PATH directory that cannot be listed.
  pathchain: {
    toml: 'ffi = true',
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'mkdir /opt/helpers-v1 && ln -s /work/helper-path /opt/helpers && ln -s /opt/helpers-v1 helper-path',
    env: ['PATH=/opt/helpers:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']
  },
  pathhidden: {
    toml: 'ffi = true',
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'mkdir /opt/helpers && ln -s /work/helpers/helper /opt/helpers/helper && chmod 0111 /opt/helpers',
    env: ['PATH=/opt/helpers:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']
  },
  // R13-F1 (round 14): forge's out two levels down, so its parent can hide it.
  nestedout: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD, 'foundry.toml': FOUNDRY_TOML('ffi = true').replace('out = "out"', 'out = "build/out"') }
  },
  // Attempt 3 (R11-F1, owner decision Q31): the image's own environment names another profile, out directory and
  // configuration file. forge runs with the runner's environment, so none of them may reach it (FOUNDRY_CONFIG names
  // no file: forge would fail if it did).
  imageenv: {
    toml: 'ffi = true\n\n[profile.ci]\nout = "ci-out"\ncache_path = "ci-cache"',
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    env: ['FOUNDRY_PROFILE=ci', 'FOUNDRY_OUT=env-out', 'FOUNDRY_CONFIG=/nowhere/foundry.toml']
  },
  // R8-F1: forge's out and compile cache configured in /tmp, outside everything the snapshots list.
  tmpout: {
    files: {
      ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD,
      'foundry.toml': FOUNDRY_TOML(PLAIN_TOML).replace('out = "out"', 'out = "/tmp/forge-out"').replace('cache_path = "cache"', 'cache_path = "/tmp/forge-cache"')
    }
  },
  // R8-F1 (round 9): forge's out inside its cache directory, which the snapshots skip.
  cacheout: {
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD, 'foundry.toml': FOUNDRY_TOML(PLAIN_TOML).replace('out = "out"', 'out = "cache/artifacts"') }
  },
  // Attempt 2: a dependency link into forge's cache directory (R6-F1, round 7).
  cachelink: {
    toml: PLAIN_TOML,
    files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': FORGE_STD },
    setup: 'mkdir -p cache/pkg && printf "contract Dep {}\\n" > cache/pkg/Dep.sol && ln -s ../cache/pkg lib/cpkg'
  }
});

function fixture(variant = 'plain') {
  if (!fixtures.has(variant)) fixtures.set(variant, buildFixture(builder, { ...VARIANTS[variant], instance: `${instanceId()}${variant}` }));
  return fixtures.get(variant);
}

test.after(async () => {
  for (const f of fixtures.values()) {
    try { await (await f).remove(); } catch (_) { /* the build failed: nothing to remove */ }
  }
});

function claimSpec(fx, over = {}) {
  return {
    version: 1,
    kind: 'bug',
    repo: 'https://github.com/acme/vault',
    baseCommit: fx.baseCommit,
    env: { image: fx.image, from: 'foundry', platform: 'linux/amd64', unpackedBytes: 2000000000 },
    attestation: 'attestation.json',
    commands: {
      framework: 'forge', build: 'forge build', test: 'forge test',
      testFiles: 'forge test --match-path $FILES', testIds: 'forge test --match-test $TEST_IDS', ...(over.commands || {})
    },
    paths: over.paths || { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.gitignore'] },
    limits: { cpus: 1, memoryMb: 1024, buildSeconds: 90, testSeconds: 120, runSeconds: 360, maxPatchBytes: 2000000 }
  };
}

const NAME = 'test_deposit_credits_exactly';
function finding(poc = {}) {
  return {
    version: 1, claimedClass: 'HIGH', rootCause: 'Vault.deposit credits one wei more than it receives, so balances overstate deposits.',
    affectedPaths: ['src/Vault.sol'],
    poc: { command: `forge test --match-test ${NAME}`, observable: `${NAME} fails at the committed hash with "2 != 1"`, ...poc }
  };
}

function claim(fx, pocPatch, over = {}) {
  return {
    listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    bcid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    spec: claimSpec(fx, over),
    attestation: {},
    pocPatch,
    fixPatch: over.fixPatch || null,
    baseline: vaultBaseline(fx.baseCommit),
    finding: over.finding || finding(),
    report: '',
    knownIssues: [],
    priorFindings: [],
    eaGates: { disclosure: 'pass', inScope: 'pass' },
    deadlineMs: 800000
  };
}

async function run(t, request) {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance).catch(() => {}));
  const lim = checkSpec(request.spec);
  assert.ok(lim.ok, JSON.stringify(lim.issues));
  const receivedAt = Date.now();
  const result = await executeRun({
    docker, config, limits: lim.limits, image: request.spec.env.image, runId: crypto.randomBytes(8).toString('hex'),
    steps: claimSteps(request, lim.limits), receivedAt, deadlineAt: receivedAt + request.deadlineMs,
    active: new Set(), log: silent, sandboxes: request.fixPatch ? 2 : 1
  });
  assert.deepEqual(await leftovers(docker, config.instance), [], 'the run removed its sandboxes');
  return result;
}

const show = (r) => JSON.stringify({
  outcome: r.outcome, abstain: r.abstain, issues: r.issues, gates: r.gates,
  integrity: r.facts && r.facts.poc ? r.facts.poc.integrity : undefined, failures: r.facts && r.facts.integrity ? r.facts.integrity.poc : undefined,
  runs: r.facts && r.facts.poc ? r.facts.poc.runs : undefined,
  step: r.abstain ? (r.steps || []).find((s) => s.name === r.abstain.step) : undefined
}, null, 1);

const CLEAN = Object.freeze({
  identityComplete: true, summaryConsistent: true, exitConsistent: true,
  protectedPathsUnchanged: true, frameworkUnchanged: true, dependenciesUnchanged: true, tamperFlags: []
});

/** The vault's bug: a deposit credits one wei too many. */
const DRAIN = pocFile('ExploitTest', [
  `    function ${NAME}() public { Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
]);

/** A Solidity string literal of `text` (quotes and backslashes escaped, line breaks as \n). */
const sol = (text) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

/** An ffi call running `script` in sh, as one line of a test body. */
const ffiSh = (script) => `string[] memory c = new string[](3); c[0] = "sh"; c[1] = "-c"; c[2] = ${sol(script)}; vm.ffi(c);`;

// ------------------------------------------------------------ no false positives

test('ordinary PoCs raise no integrity failure under real forge: the vault PoC, a build that skips tests, a PoC writing an allowed state file', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const r = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': DRAIN })));
  assert.equal(r.outcome, 'definitive', show(r));
  for (const g of ['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable']) assert.equal(r.gates[g].status, 'pass', `${g}: ${show(r)}`);
  assert.deepEqual(r.facts.poc.integrity, CLEAN);
  for (const [name, v] of Object.entries(r.facts)) assert.ok(v && (v.tier === 'A' || v.tier === 'B'), `${name} carries its tier`);

  // `forge build --skip test`: run 1 compiles the tests and rewrites out/ (a new build-info): not a change.
  const skip = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': DRAIN }), { commands: { build: 'forge build --skip test' } }));
  assert.equal(skip.gates.integrity.status, 'pass', show(skip));

  // A PoC that writes the state directory the maker allowed, every run, and fails each time.
  const state = pocFile('ExploitTest', [
    `    function ${NAME}() public { vm.writeFile("state/seen", "1"); Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
  ]);
  const s = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': state })));
  assert.equal(s.gates.integrity.status, 'pass', show(s));
  assert.equal(s.gates.reproduces.status, 'pass');
});

// ------------------------------------------------------- the catalogue fixtures

test('junit-forged-early-exit (forge form): an ffi child prints a JUnit to forge\'s stdout and kills forge: the kill is a signal death, the arbiter abstains; a maker\'s command that would mask it (`! forge test`) is refused', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('ffi');
  const forged = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="Test run" tests="1" skipped="0" failures="1" errors="0">',
    '<testsuite name="test/Exploit.t.sol:ExploitTest" tests="1" skipped="0" errors="0" failures="1">',
    '<testcase name="test_forged()"><failure message="vault drained"/><system-out>[FAIL: vault drained] test_forged() (gas: 3266)</system-out></testcase>',
    '</testsuite></testsuites>'
  ].join('');
  const poc = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      `    function test_forged() public { ${ffiSh(`printf '%s\\n' '${forged}' > /proc/$PPID/fd/1; kill -9 $PPID`)} }`
    ])
  });
  // Attempt 3 (owner decision Q31): the runner runs forge itself, so nothing can invert its exit. The form that once
  // reached the exit-code and summary checks (`!`) is the requester's error; those checks stay, with their unit tests.
  const masked = await run(t, claim(fx, poc, {
    commands: { testFiles: '! forge test --match-path $FILES', testIds: '! forge test --match-test $TEST_IDS' },
    finding: finding({ command: 'forge test --match-test test_forged', observable: 'test_forged fails with "vault drained"' })
  }));
  assert.equal(masked.outcome, 'requester_error', show(masked));
  assert.deepEqual(masked.issues.map((i) => i.code), ['COMMAND_NOT_ALLOWED', 'COMMAND_NOT_ALLOWED']);
  assert.match(masked.issues[0].detail, /^commands\.testFiles: "!" is not allowed/);

  // The kill is a signal death (exit 137): the arbiter abstains, no verdict.
  const plain = await run(t, claim(fx, poc));
  assert.equal(plain.outcome, 'abstain', show(plain));
  assert.equal(plain.abstain.step, 'poc:1');
});

test('protected-file-modified-at-runtime (forge form): an ffi child rewrites foundry.toml during run 1; forge itself refuses the file cheatcode form', { timeout: TIMEOUT }, async (t) => {
  // forge 1.8.5 refuses vm.writeFile on foundry.toml whatever fs_permissions say: the attempt errors, and is flagged.
  const plain = await fixture();
  const toml = `${FOUNDRY_TOML(PLAIN_TOML)}ffi = true\n`;
  const cheat = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      '    /// forge-config: default.fs_permissions = [{ access = "read-write", path = "./" }]',
      `    function ${NAME}() public { vm.writeFile("foundry.toml", ${sol(toml)}); Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
    ])
  });
  const c = await run(t, claim(plain, cheat));
  assert.equal(c.outcome, 'definitive', show(c));
  assert.equal(c.gates.reproduces.status, 'fail', show(c));
  assert.equal(c.facts.poc.tests[0].kind, 'error', 'the refused cheatcode is an error, not an assertion');
  assert.equal(c.gates.integrity.status, 'fail');
  assert.equal(c.facts.poc.integrity.protectedPathsUnchanged, true, 'forge left foundry.toml alone');
  assert.ok(c.facts.poc.integrity.tamperFlags.some((f) => f.kind === 'framework-patched'), JSON.stringify(c.facts.poc.integrity.tamperFlags));

  // ffi (enabled by the maker) has no such guard: the child appends to foundry.toml, which later runs would load.
  const fx = await fixture('ffi');
  const poc = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      `    function ${NAME}() public { ${ffiSh("printf 'optimizer = true\\n' >> foundry.toml")} Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
    ])
  });
  const r = await run(t, claim(fx, poc));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.integrity.status, 'fail', show(r));
  assert.equal(r.facts.poc.integrity.protectedPathsUnchanged, false);
  assert.equal(r.facts.poc.integrity.frameworkUnchanged, false, 'forge\'s resolved configuration changed with it');
  assert.match(r.gates.integrity.detail, /protectedPathsUnchanged \(run 1: foundry\.toml changed/);
  assert.match(r.gates.integrity.detail, /forge's resolved configuration changed/);
  assert.deepEqual(r.facts.poc.tests[0].runs, ['fail', 'fail', 'fail'], 'the JUnit alone would have reproduced');
  assert.equal(r.gates.reproduces.status, 'fail');
  assert.equal(r.gates.reproduces.basis, 'integrity');
});

test('reporter-monkeypatched (forge form): a PoC rewrites forge-std\'s source with a file cheatcode during run 1', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const poc = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      '    /// forge-config: default.fs_permissions = [{ access = "read-write", path = "./lib" }]',
      `    function ${NAME}() public { vm.writeFile("lib/forge-std/src/Test.sol", ${sol(`${FORGE_STD}// patched\n`)}); Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
    ])
  });
  const r = await run(t, claim(fx, poc));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.integrity.status, 'fail', show(r));
  assert.ok(r.facts.poc.integrity.tamperFlags.some((f) => f.kind === 'reporter-patched'), JSON.stringify(r.facts.poc.integrity.tamperFlags));
  assert.equal(r.facts.poc.integrity.frameworkUnchanged, false, 'the post-run checksum of the reporter module');
  assert.equal(r.facts.poc.integrity.dependenciesUnchanged, false);
  assert.match(r.gates.integrity.detail, /run 1: lib\/forge-std\/src\/Test\.sol changed/);
  // Q35: a tamper flag beside another failed check, as settlement reads them.
  const read = settlementFacts(r);
  assert.deepEqual(read.issues, [], 'common\'s validator');
  assert.equal(read.tampered, true);
  assert.deepEqual(read.failedChecks, ['protectedPathsUnchanged', 'frameworkUnchanged', 'dependenciesUnchanged']);
});

test('dependencies-edited-during-run (forge form): an ffi child edits an untracked lib/ dependency during run 2', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('ffi');
  const count = 'n=$(cat state/n 2>/dev/null || echo 0); n=$((n+1)); echo $n > state/n; if [ $n -eq 2 ]; then echo "// drained" >> lib/solady/src/Solady.sol; fi';
  const poc = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      `    function ${NAME}() public { ${ffiSh(count)} Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
    ])
  });
  const r = await run(t, claim(fx, poc));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.integrity.status, 'fail', show(r));
  assert.equal(r.facts.poc.integrity.dependenciesUnchanged, false);
  assert.match(r.gates.integrity.detail, /dependenciesUnchanged \(run 2: lib\/solady\/src\/Solady\.sol changed/);
  assert.deepEqual(r.facts.poc.tests[0].runs, ['fail', 'fail', 'fail'], 'the JUnit alone would have reproduced');
  assert.deepEqual(r.facts.poc.integrity.tamperFlags, [], 'measured, not predicted: no static flag caught this one');
});

test('test-report-missing-identity (forge form): the PoC skips itself on runs 2 and 3 (vm.skip after a state file)', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const poc = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      `    function ${NAME}() public { if (vm.isFile("state/ran")) vm.skip(true); vm.writeFile("state/ran", "1"); Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
    ])
  });
  const r = await run(t, claim(fx, poc));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.facts.poc.integrity.identityComplete, false, show(r));
  assert.match(r.gates.integrity.detail, /identityComplete \(run 2: test\/Exploit\.t\.sol > ExploitTest > test_deposit_credits_exactly\(\) is skipped/);
  assert.deepEqual(r.facts.poc.tests[0].runs, ['fail', 'skip', 'skip']);
  assert.equal(r.gates.reproduces.status, 'fail');
  // forge's own summary and exit code agree with the skip: only identity completeness fails.
  assert.equal(r.facts.poc.integrity.summaryConsistent, true);
  assert.equal(r.facts.poc.integrity.exitConsistent, true);
});

test('test-report-duplicate-identity (forge form): an ffi child forges a summary-consistent JUnit carrying the PoC twice: with forge\'s death unmasked the arbiter abstains; the wrapper that would mask it is refused', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('ffi');
  const forged = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="Test run" tests="2" skipped="0" failures="1" errors="0">',
    '<testsuite name="test/Exploit.t.sol:ExploitTest" tests="2" skipped="0" errors="0" failures="1">',
    '<testcase name="test_dup()"><failure message="vault drained"/><system-out>[FAIL: vault drained] test_dup() (gas: 3266)</system-out></testcase>',
    '<testcase name="test_dup()"><system-out>[PASS] test_dup() (gas: 143)</system-out></testcase>',
    '<system-out>Suite result: FAILED. 1 passed; 1 failed; 0 skipped; finished in 1.00ms (1.00ms CPU time)</system-out>',
    '</testsuite></testsuites>'
  ].join('');
  const poc = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [`    function test_dup() public { ${ffiSh(`printf '%s\\n' '${forged}' > /proc/$PPID/fd/1; kill -9 $PPID`)} }`])
  });
  // A wrapper that keeps forge's 0 and 1 and turns a signal death into 1: attempt 3 refuses it (the identity check that
  // once caught this form stays, with its unit test `test-report-duplicate-identity`).
  const wrapped = await run(t, claim(fx, poc, {
    commands: {
      testFiles: 'sh -c \'forge test --match-path "$0" "$@" || exit 1\' $FILES',
      testIds: 'sh -c \'forge test --match-test "$0" "$@" || exit 1\' $TEST_IDS'
    }
  }));
  assert.equal(wrapped.outcome, 'requester_error', show(wrapped));
  assert.deepEqual(wrapped.issues.map((i) => i.code), ['COMMAND_NOT_ALLOWED', 'COMMAND_NOT_ALLOWED']);
  assert.match(wrapped.issues[0].detail, /^commands\.testFiles: "sh" is not allowed/);
  // The runner's own forge: the kill is forge's death, whatever the child printed.
  const r = await run(t, claim(fx, poc));
  assert.equal(r.outcome, 'abstain', show(r));
  assert.equal(r.abstain.step, 'poc:1');
});

test('claimed-observable-mismatch (forge form): finding.json names another test, or quotes an observable forge did not record', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const poc = addFilesPatch({ 'test/Exploit.t.sol': DRAIN });
  for (const [poc2, status, re] of [
    [{ command: 'forge test --match-test test_deposit', observable: 'test_deposit fails with "2 != 1"' }, 'fail', /names test_deposit, which is not a test the patch added that failed/],
    [{ observable: `${NAME} fails with "vault emptied"` }, 'fail', /"vault emptied" is not in the recorded failure/],
    [{}, 'pass', new RegExp(NAME)]
  ]) {
    const r = await run(t, claim(fx, poc, { finding: finding(poc2) }));
    assert.equal(r.gates.reproduces.status, 'pass', show(r));
    assert.equal(r.gates.claimedObservable.status, status, show(r));
    assert.match(r.gates.claimedObservable.detail, re);
  }
});

// ------------------------------------------------- attempt 2: the kernel resolves the links

/** Each named step's duration, in ms, from the run's step records. */
const stepMs = (r, re) => (r.steps || []).filter((s) => re.test(s.name)).map((s) => s.durationMs);

test('A3a R6-F1 (round 7) under real forge: the kernel resolves `lib/pkg -> ../bridge/../payload` (bridge -> vendor/nested) to vendor/payload, which is watched; payload/ is not', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('links');
  // An ordinary PoC on this image raises nothing: the chain, and 20,000 node_modules links resolved once per snapshot.
  const plain = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': DRAIN })));
  assert.equal(plain.outcome, 'definitive', show(plain));
  for (const g of ['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable']) assert.equal(plain.gates[g].status, 'pass', `${g}: ${show(plain)}`);
  assert.deepEqual(plain.facts.poc.integrity, CLEAN);
  const linkSteps = stepMs(plain, /^integrity:.*:links$/);
  assert.equal(linkSteps.length, 5, 'the reference, after the build and one after each run');
  for (const ms of linkSteps) assert.ok(ms < 60000, `${ms} ms in the sandbox`);

  // An ffi child edits vendor/payload/fixture.json on run 2: the kernel's answer for lib/pkg, watched.
  const edit = (p) => addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      `    function ${NAME}() public { ${ffiSh(`n=$(cat state/n 2>/dev/null || echo 0); n=$((n+1)); echo $n > state/n; if [ $n -eq 2 ]; then echo '"x"' >> ${p}; fi`)} Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
    ])
  });
  const r = await run(t, claim(fx, edit('vendor/payload/fixture.json')));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.integrity.status, 'fail', show(r));
  assert.equal(r.facts.poc.integrity.dependenciesUnchanged, false);
  assert.match(r.gates.integrity.detail, /dependenciesUnchanged \(run 2: vendor\/payload\/fixture\.json changed/);
  assert.deepEqual(r.facts.poc.tests[0].runs, ['fail', 'fail', 'fail'], 'the JUnit alone would have reproduced');

  // The lexical answer (payload/) is nobody's dependency: an edit there is not a change of the watched sets.
  const decoy = await run(t, claim(fx, edit('payload/fixture.json')));
  assert.equal(decoy.gates.integrity.status, 'pass', show(decoy));

  // A lib root behind a link (libs "deps/lib", deps -> third_party): the kernel resolves the root, so an edit of what
  // forge reads there is a dependency change.
  const behind = await run(t, claim(fx, edit('third_party/lib/TP.sol')));
  assert.equal(behind.outcome, 'definitive', show(behind));
  assert.match(behind.gates.integrity.detail, /dependenciesUnchanged \(run 2: third_party\/lib\/TP\.sol changed/);

  // The unwatched link on the way retargeted during run 1: lib/pkg's own entry (the kernel's answer) changed.
  const retarget = addFilesPatch({
    'test/Exploit.t.sol': pocFile('ExploitTest', [
      `    function ${NAME}() public { ${ffiSh('[ -e state/r ] || { rm bridge && ln -s . bridge && touch state/r; }')} Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
    ])
  });
  const moved = await run(t, claim(fx, retarget));
  assert.equal(moved.outcome, 'definitive', show(moved));
  assert.equal(moved.facts.poc.integrity.dependenciesUnchanged, false, show(moved));
  assert.match(moved.gates.integrity.detail, /dependenciesUnchanged \(run 1: lib\/pkg changed/);
});

test('A3a R6-F1 (round 7) under real forge: a dependency link into forge\'s cache directory is refused before any claim code (IMAGE_WATCH_LINK_UNCOVERED)', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('cachelink');
  const r = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': DRAIN })));
  assert.equal(r.outcome, 'requester_error', show(r));
  assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_LINK_UNCOVERED']);
  assert.match(r.issues[0].detail, /lib\/cpkg -> \/work\/cache\/pkg \(forge's cache directory \(cache\)\)/);
  assert.ok(!(r.steps || []).some((s) => /^(?:build|poc:)/.test(s.name)), 'no maker command and no claim code ran');
});

test('A3a R8-F1 under real forge: out and cache_path configured in /tmp, or out inside the cache directory, are refused before any maker command (IMAGE_WATCH_ROOT_UNCOVERED)', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('tmpout');
  const r = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': DRAIN })));
  assert.equal(r.outcome, 'requester_error', show(r));
  assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
  assert.match(r.issues[0].detail, /out \(\/tmp\/forge-out\) is not a plain path in the work tree; cache_path \(\/tmp\/forge-cache\)/);
  assert.ok(!(r.steps || []).some((s) => /^(?:build|poc:)/.test(s.name)), 'no maker command and no claim code ran');
  // Round 9: out inside forge's cache directory.
  const inCache = await run(t, claim(await fixture('cacheout'), addFilesPatch({ 'test/Exploit.t.sol': DRAIN })));
  assert.equal(inCache.outcome, 'requester_error', show(inCache));
  assert.match(inCache.issues[0].detail, /out \(cache\/artifacts\) is in forge's cache directory \(cache\)/);
  assert.ok(!(inCache.steps || []).some((s) => /^(?:build|poc:)/.test(s.name)));
});

test('A3a R11-F1 (attempt 3) under real forge: the runner runs forge as an argv, with its own environment in /work (the image\'s FOUNDRY_PROFILE, FOUNDRY_OUT and FOUNDRY_CONFIG never reach it), and every allowlisted flag works', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('imageenv');
  // An ffi child reports the environment forge gave it: the image's variables, and forge's working directory.
  const report = 'printf "%s|%s|%s|%s" "${FOUNDRY_PROFILE-unset}" "${FOUNDRY_OUT-unset}" "${FOUNDRY_CONFIG-unset}" "$(pwd)"';
  const env = pocFile('EnvTest', [
    `    function test_env() public { ${ffiSh(report).replace('vm.ffi(c);', 'bytes memory got = vm.ffi(c); vm.assertTrue(false, string(got));')} }`
  ]);
  // Two PoC files: $FILES is a brace glob, which forge gets as one --match-path=… argument.
  const patch = addFilesPatch({ 'test/Env.t.sol': env, 'test/Exploit.t.sol': DRAIN });
  const r = await run(t, claim(fx, patch, {
    commands: {
      build: 'forge build --skip test',
      testFiles: 'forge test -vvv --match-path $FILES --fuzz-runs 64 --isolate',
      testIds: 'forge test --mt $TEST_IDS --mp $FILES -vv'
    },
    finding: finding({ command: 'forge test --match-test test_env', observable: 'test_env fails with "unset|unset|unset|/work"' })
  }));
  assert.equal(r.outcome, 'definitive', show(r));
  for (const g of ['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable']) assert.equal(r.gates[g].status, 'pass', `${g}: ${show(r)}`);
  assert.deepEqual(r.facts.poc.integrity, CLEAN);
  const byId = Object.fromEntries(r.facts.poc.tests.map((x) => [x.id, x]));
  assert.equal(byId['test/Env.t.sol > EnvTest > test_env()'].message, 'unset|unset|unset|/work', show(r));
  assert.deepEqual(byId['test/Env.t.sol > EnvTest > test_env()'].runs, ['fail', 'fail', 'fail']);
  assert.deepEqual(byId[`test/Exploit.t.sol > ExploitTest > ${NAME}()`].runs, ['fail', 'fail', 'fail']);
});

test('A3a R11-F1 (attempt 3) under real forge: the routes rounds 11 and 12 found are refused before any maker command, at claim time and at listing time, with the token named', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('imageenv');
  const { validateListingRequest } = require('../../src/listing');
  for (const [key, text, token] of [
    ['testFiles', 'FOUNDRY_PROFILE=ci forge test --match-path $FILES', 'FOUNDRY_PROFILE=ci'],
    ['testIds', 'env -u FOUNDRY_CONFIG FOUNDRY_PROFILE=ci /usr/local/bin/forge test --match-test $TEST_IDS', 'env'],
    ['testFiles', 'forge test --match-path $FILES --compiler-version /work/toolchain/solc', '--compiler-version'],
    ['build', 'forge build --config-path foundry.toml', '--config-path'],
    ['build', '/usr/local/bin/forge build', '/usr/local/bin/forge'],
    ['testFiles', '! forge test --match-path $FILES', '!']
  ]) {
    const r = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': DRAIN }), { commands: { [key]: text } }));
    assert.equal(r.outcome, 'requester_error', `${text}: ${show(r)}`);
    assert.deepEqual(r.issues.map((i) => [i.code, i.path]), [['COMMAND_NOT_ALLOWED', `/spec/commands/${key}`]]);
    assert.ok(r.issues[0].detail.includes(JSON.stringify(token)), r.issues[0].detail);
    assert.ok(!(r.steps || []).some((s) => /^(?:build|poc:|integrity)/.test(s.name)), 'nothing ran');
    const spec = claimSpec(fx, { commands: { [key]: text } });
    const listing = validateListingRequest({ spec: { ...spec, env: { from: 'foundry' }, limits: undefined, stake: { scope: { include: ['src/**'] } } }, image: fx.image, deadline: 900000 });
    assert.equal(listing.ok, false, text);
    assert.deepEqual(listing.issues, r.issues, `${text}: the listing check refuses it the same way`);
  }
});

test('A3a R13-F1 under real forge: a file or a directory a run leaves unreadable under out/ fails frameworkUnchanged, its bytes changed behind mode 000 or not', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('ffi');
  for (const [script, re] of [
    ['if [ -e out/payload.bin ]; then chmod 600 out/payload.bin; printf bbb > out/payload.bin; else printf aaa > out/payload.bin; fi; chmod 000 out/payload.bin', /run 1: out\/payload\.bin cannot be read/],
    ['if [ -e out/hid ]; then chmod 700 out/hid; printf bbb > out/hid/f; else mkdir out/hid; printf aaa > out/hid/f; fi; chmod 000 out/hid', /run 1: out\/hid cannot be read/]
  ]) {
    const poc = pocFile('ExploitTest', [
      `    function ${NAME}() public { ${ffiSh(script)} Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
    ]);
    const r = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': poc })));
    assert.equal(r.outcome, 'definitive', show(r));
    assert.equal(r.gates.integrity.status, 'fail', show(r));
    assert.equal(r.facts.poc.integrity.frameworkUnchanged, false, show(r));
    assert.match(r.gates.integrity.detail, re);
    assert.equal(r.gates.reproduces.status, 'fail');
  }
  // Round 14: out = "build/out", build/ at mode 0111. forge still reaches its artifacts by their path; find lists nothing.
  const hidden = pocFile('ExploitTest', [
    `    function ${NAME}() public { ${ffiSh('chmod 0111 build')} Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
  ]);
  const r = await run(t, claim(await fixture('nestedout'), addFilesPatch({ 'test/Exploit.t.sol': hidden })));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.integrity.status, 'fail', show(r));
  assert.equal(r.facts.poc.integrity.frameworkUnchanged, false, show(r));
  assert.match(r.gates.integrity.detail, /run 1: build cannot be read/);
});

test('A3a R16-F1 under real forge: what the checks take for immutable, with real symbolic links in the image: a PATH directory through the work tree, directly or by a chain back to the root; a link into it in a read-only PATH directory; the runner\'s own tool behind one; a directory it cannot list', { timeout: TIMEOUT }, async (t) => {
  for (const [variant, re] of [
    ['pathalias', /\/opt\/helpers \(in PATH, the runner's tools or solc\) resolves through a place the sandbox can write/],
    ['pathchain', /\/opt\/helpers \(in PATH, the runner's tools or solc\) resolves through/],
    ['pathlink', /\/usr\/local\/bin\/helper \(in PATH, the runner's tools or solc\) resolves through/],
    ['toolchain', /\/usr\/local\/bin\/sha256sum \(in PATH, the runner's tools or solc\) resolves through/],
    ['pathhidden', /\/opt\/helpers \(in PATH or the runner's tools\) cannot be listed/]
  ]) {
    const r = await run(t, claim(await fixture(variant), addFilesPatch({ 'test/Exploit.t.sol': DRAIN })));
    assert.equal(r.outcome, 'requester_error', `${variant}: ${show(r)}`);
    assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED'], variant);
    assert.match(r.issues[0].detail, re);
    assert.ok(!(r.steps || []).some((s) => /^(?:build|poc:)/.test(s.name)), 'no maker command and no claim code ran');
  }
  // Round 19: a patch adding test/find, which would suppress its own enumeration and restore what it changed: refused before the patch.
  const finder = Buffer.concat([addFilesPatch({ 'test/Exploit.t.sol': DRAIN }), Buffer.from(['diff --git a/test/find b/test/find', 'new file mode 100755', '--- /dev/null', '+++ b/test/find', '@@ -0,0 +1,2 @@', '+#!/bin/sh', '+exec /usr/bin/find "$@"', ''].join('\n'))]);
  const r = await run(t, claim(await fixture('toolpatch'), finder));
  assert.equal(r.outcome, 'requester_error', show(r));
  assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
  assert.match(r.issues[0].detail, /\/usr\/local\/bin\/find \(in PATH, the runner's tools or solc\) resolves through/);
  assert.ok(!(r.steps || []).some((s) => /^patch:/.test(s.name)), 'refused before the patch was applied');
});

test('A3a R20-F1 under real forge: the image\'s LD_PRELOAD and the like never reach a step: a library a run plants at the named path is not loaded, by the launcher or by anything after it', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('loader');
  const { Prefix } = require('../../src/capture');
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance).catch(() => {}));
  const said = {};
  const steps = [async (ctx) => {
    // As a run could: a real shared object appears at the paths the image's ENV names.
    const plant = await ctx.exec(['/bin/sh', '-c', 'mkdir -p /work/libs && l=$(ls /lib/*/libdl.so.2 | head -n 1) && cp "$l" /work/hook.so && cp "$l" /work/libs/ && printf done'], { name: 'plant', timeoutMs: 60000 });
    assert.equal(plant.exitCode, 0, plant.stderr.text);
    // A later step: what the launcher's /bin/sh sees, and what is mapped into it and into a program it starts.
    const out = new Prefix(64 * 1024);
    const look = await ctx.exec(['/bin/sh', '-c', 'printf "[%s|%s|%s|%s]" "$LD_PRELOAD" "$LD_AUDIT" "$LD_LIBRARY_PATH" "$GCONV_PATH"; cat /proc/$$/maps /proc/self/maps'], { name: 'look', timeoutMs: 60000, tee: out });
    said.text = out.bytes().toString('utf8');
    said.stderr = look.stderr.text;
  }];
  const lim = checkSpec(claimSpec(fx));
  const receivedAt = Date.now();
  const result = await executeRun({ docker, config, limits: lim.limits, image: fx.image, runId: crypto.randomBytes(8).toString('hex'), steps, receivedAt, deadlineAt: receivedAt + 800000, active: new Set(), log: silent });
  assert.equal(result.outcome, 'definitive', JSON.stringify({ abstain: result.abstain, issues: result.issues }));
  assert.ok(said.text.startsWith('[|||]'), said.text.slice(0, 200));
  assert.doesNotMatch(said.text, /\/work\/(?:hook\.so|libs)/, 'nothing from the work tree is mapped');
  assert.doesNotMatch(said.stderr, /ld\.so/, said.stderr);
  // The whole pipeline on that image, a PoC planting the library on run 1: an ordinary claim.
  const plantPoc = pocFile('ExploitTest', [
    `    function ${NAME}() public { ${ffiSh('cp "$(ls /lib/*/libdl.so.2 | head -n 1)" /work/hook.so')} Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
  ]);
  const r = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': plantPoc })));
  assert.equal(r.outcome, 'definitive', show(r));
  for (const g of ['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable']) assert.equal(r.gates[g].status, 'pass', `${g}: ${show(r)}`);
});

test('an image as the attested builder makes it: forge finds the setup\'s solc under XDG_DATA_HOME, a tool that is a link into /repo (owned by the sandbox user, on the read-only root) passes the walk and runs last on PATH', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('builder');
  const poc = pocFile('ExploitTest', [
    `    function ${NAME}() public { ${ffiSh('tool').replace('vm.ffi(c);', 'bytes memory got = vm.ffi(c); vm.assertTrue(false, string(got));')} }`
  ]);
  const r = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': poc }), { finding: finding({ observable: `${NAME} fails with "helper-ran"` }) }));
  assert.equal(r.outcome, 'definitive', show(r));
  for (const g of ['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable']) assert.equal(r.gates[g].status, 'pass', `${g}: ${show(r)}`);
  assert.deepEqual(r.facts.poc.integrity, CLEAN);
  assert.equal(r.facts.poc.tests[0].message, 'helper-ran');
});

test('Q32 under real forge: a compiler that writes into lib/ during the build is the requester\'s error, not an INVALID', { timeout: TIMEOUT }, async (t) => {
  const r = await run(t, claim(await fixture('solctrap'), addFilesPatch({ 'test/Exploit.t.sol': DRAIN })));
  assert.equal(r.outcome, 'requester_error', show(r));
  assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_CHANGED_BY_BUILD']);
  assert.match(r.issues[0].detail, /the build: lib\/trap\.sol added/);
  assert.ok(!(r.steps || []).some((s) => /^poc:/.test(s.name)), 'no claim code ran');
});

test('A3a R21-F1 under real forge: where forge writes is not held to the reference, whatever else names it: a protected glob over a test\'s artifact with `--skip test`, and out inside lib/; honest claims pass', { timeout: TIMEOUT }, async (t) => {
  const poc = addFilesPatch({ 'test/Exploit.t.sol': DRAIN });
  const glob = await run(t, claim(await fixture(), poc, {
    commands: { build: 'forge build --skip test' },
    paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.gitignore', 'out/Exploit.t.sol/**', 'cache/**'] }
  }));
  assert.equal(glob.outcome, 'definitive', show(glob));
  for (const g of ['build', 'reproduces', 'integrity', 'claimedObservable']) assert.equal(glob.gates[g].status, 'pass', `${g}: ${show(glob)}`);
  assert.deepEqual(glob.facts.poc.integrity, CLEAN);
  const lib = await run(t, claim(await fixture('outlib'), poc));
  assert.equal(lib.outcome, 'definitive', show(lib));
  for (const g of ['build', 'reproduces', 'integrity', 'claimedObservable']) assert.equal(lib.gates[g].status, 'pass', `${g}: ${show(lib)}`);
  assert.deepEqual(lib.facts.poc.integrity, CLEAN);
});

test('A3a R21-F2 under real forge: invariant PoCs and suites: one predicate failing, two in one campaign failing, and a suite with a passing multi-predicate campaign in the fix check, whose summary counts the campaign as one', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('invariants');
  // The vault credits one wei too many: 2 != 1, from the first check on; with the fix these predicates hold.
  const setUp = 'function setUp() public { v = new Vault(); v.deposit(1); }';
  const one = pocFile('InvOne', ['    Vault v;', `    ${setUp}`, '    function invariant_only() public { vm.assertEq(v.balanceOf(address(this)), 1); }']);
  const r1 = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': one }), { finding: finding({ command: 'forge test --match-test invariant_only', observable: 'invariant_only fails' }) }));
  assert.equal(r1.outcome, 'definitive', show(r1));
  assert.equal(r1.facts.poc.integrity.summaryConsistent, true, show(r1));
  assert.deepEqual(r1.facts.poc.tests[0].runs, ['fail', 'fail', 'fail'], show(r1));
  assert.equal(r1.facts.poc.tests[0].kind, 'assertion', 'the reason from forge\'s line: an honest invariant PoC is no error');
  assert.ok(r1.facts.poc.tests[0].message, show(r1));
  const two = pocFile('InvTwo', ['    Vault v;', `    ${setUp}`,
    '    function invariant_a() public { vm.assertEq(v.balanceOf(address(this)), 1); }', '    function invariant_b() public { vm.assertEq(v.balanceOf(address(this)), 1); }']);
  const r2 = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': two }), { finding: finding({ command: 'forge test --match-test invariant_a', observable: 'invariant_a fails' }) }));
  assert.equal(r2.outcome, 'definitive', show(r2));
  assert.equal(r2.facts.poc.integrity.summaryConsistent, true, `one failed result, two failing records: ${show(r2)}`);
  assert.equal(r2.facts.poc.testCount, 2);
  // A fix under which a two-predicate PoC passes: the suite's summary counts the campaign once.
  const vault = VAULT_REPO['src/Vault.sol'];
  const fixPatch = modifyPatch('src/Vault.sol', vault, vault.replace('amount + 1', 'amount'));
  const r3 = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': two }), { fixPatch, finding: finding({ command: 'forge test --match-test invariant_a', observable: 'invariant_a fails' }) }));
  assert.equal(r3.outcome, 'definitive', show(r3));
  assert.equal(r3.facts.fix.applies, 'pass', JSON.stringify(r3.facts.fix.detail));
  assert.equal(r3.facts.fix.integrity.summaryConsistent, true, JSON.stringify(r3.facts.integrity.fix));
  assert.equal(r3.facts.fix.pocPasses, true, JSON.stringify(r3.facts.fix.suite));
  // A handler's failed assertion is a record of its own, beside a predicate that passes; forge's summary says one failed.
  const handler = [
    '// SPDX-License-Identifier: MIT',
    'pragma solidity ^0.8.0;',
    'import {Base} from "./Vm.sol";',
    'contract H is Base { uint256 public x; function boom() public { x += 1; vm.assertEq(uint256(1), uint256(2)); } }',
    'contract InvHandler is Base {',
    '    H h;',
    '    function setUp() public { h = new H(); }',
    '    function invariant_holds() public pure {}',
    '}',
    ''
  ].join('\n');
  const r4 = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': handler }), { finding: finding({ command: 'forge test --match-test invariant_holds', observable: 'invariant_holds fails' }) }));
  assert.equal(r4.outcome, 'definitive', show(r4));
  assert.equal(r4.facts.poc.integrity.summaryConsistent, true, show(r4));
  assert.equal(r4.facts.poc.integrity.exitConsistent, true, show(r4));
  const report = r4.steps.find((s) => s.name === 'poc:1').stdout.text;
  assert.match(report, /<testcase name="handler [^"]*"/, 'forge wrote the handler\'s record');
  assert.match(report, /Suite result: FAILED\. 0 passed; 1 failed; 0 skipped/);
});

test('A3a R21-F1 (round 22) and R22-F1 under real forge: the same conflict by a link, by a chain through the read-only root, by a prebuilt artifact and by `out = "lib"`: each a requester error before any maker command or claim code', { timeout: TIMEOUT }, async (t) => {
  const poc = addFilesPatch({ 'test/Exploit.t.sol': DRAIN });
  const paths = (...protect) => ({ tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.gitignore', ...protect] });
  const refused = (r, code, re) => {
    assert.equal(r.outcome, 'requester_error', show(r));
    assert.deepEqual(r.issues.map((i) => i.code), [code], show(r));
    assert.match(r.issues[0].detail, re);
    assert.ok(!(r.steps || []).some((s) => /^(?:build|poc:)/.test(s.name)), 'no maker command and no claim code ran');
  };
  const fx = await fixture('outalias');
  refused(await run(t, claim(fx, poc, { commands: { build: 'forge build --skip test' }, paths: paths('artifact-alias/Exploit.t.sol/**') })),
    'IMAGE_WATCH_LINK_UNCOVERED', /artifact-alias\/Exploit\.t\.sol -> \/work\/out\/Exploit\.t\.sol \(forge's out directory \(out\)\)/);
  refused(await run(t, claim(fx, poc, { paths: paths('out/Prebuilt.sol/**') })), 'IMAGE_WATCH_ROOT_UNCOVERED', /out\/Prebuilt\.sol\/Prebuilt\.json is watched/);
  // The link alone, with nothing watched through it, is nothing: the honest claim passes.
  const plain = await run(t, claim(fx, poc));
  assert.equal(plain.outcome, 'definitive', show(plain));
  for (const g of ['build', 'reproduces', 'integrity', 'claimedObservable']) assert.equal(plain.gates[g].status, 'pass', `${g}: ${show(plain)}`);
  refused(await run(t, claim(await fixture('outchain'), poc, { commands: { build: 'forge build --skip test' } })),
    'IMAGE_WATCH_LINK_UNCOVERED', /lib\/pending -> \/work\/out\/Exploit\.t\.sol\/ExploitTest\.json \(forge's out directory \(out\)\)/);
  refused(await run(t, claim(await fixture('libout'), poc)), 'IMAGE_WATCH_ROOT_UNCOVERED', /lib\/forge-std\/src\/Test\.sol is watched/);
});

test('A3a under real forge: forge\'s other outputs (test_failures_file, failure_persist_dir) inside a dependency directory are its output: an honest failing PoC and an honest invariant PoC with a counterexample pass; out behind a link is refused', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('runoutputs');
  const plain = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': DRAIN })));
  assert.equal(plain.outcome, 'definitive', show(plain));
  for (const g of ['build', 'reproduces', 'integrity', 'claimedObservable']) assert.equal(plain.gates[g].status, 'pass', `${g}: ${show(plain)}`);
  assert.deepEqual(plain.facts.poc.integrity, CLEAN);
  // A counterexample's sequence: forge persists it in failure_persist_dir, in the run's own compile.
  const inv = ['// SPDX-License-Identifier: MIT', 'pragma solidity ^0.8.0;', 'import {Base} from "./Vm.sol";', 'contract H { uint256 public x; function bump() public { x += 1; } }',
    'contract InvPersist is Base {', '    H h;', '    function setUp() public { h = new H(); }', '    function invariant_only() public view { require(h.x() == 0, "moved"); }', '}', ''].join('\n');
  const r = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': inv }), { finding: finding({ command: 'forge test --match-test invariant_only', observable: 'invariant_only fails' }) }));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.integrity.status, 'pass', show(r));
  assert.deepEqual(r.facts.poc.integrity, CLEAN);
  const linked = await run(t, claim(await fixture('outlinked'), addFilesPatch({ 'test/Exploit.t.sol': DRAIN })));
  assert.equal(linked.outcome, 'requester_error', show(linked));
  assert.deepEqual(linked.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
  assert.match(linked.issues[0].detail, /out is a link/);
});

test('A3a R24-F1 under real forge: a compiler under paths.tests is refused before the patch that would replace it, so a wrapper never runs', { timeout: TIMEOUT }, async (t) => {
  const wrapper = '#!/bin/sh\nprintf x > /work/state-wrapper-ran\nexec /opt/solc/solc "$@"\n';
  const r = await run(t, claim(await fixture('solcintests'), addFilesPatch({ 'test/Exploit.t.sol': DRAIN, 'test/solc.wrapper': wrapper })));
  assert.equal(r.outcome, 'requester_error', show(r));
  assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
  assert.match(r.issues[0].detail, /solc \(test\/solc\) is in the work tree, where a patch could replace it/);
  assert.ok(!(r.steps || []).some((s) => /^(?:patch|build|poc:)/.test(s.name)), 'no patch, maker command or claim code ran');
  // A path that starts like a release is a file to forge; `extends` is refused before forge starts.
  for (const [variant, re] of [['solcversiondir', /solc \(0\.8\.31\/solc\) is in the work tree/], ['extendsconf', /foundry\.toml uses `extends`/]]) {
    const refused = await run(t, claim(await fixture(variant), addFilesPatch({ 'test/Exploit.t.sol': DRAIN })));
    assert.equal(refused.outcome, 'requester_error', `${variant}: ${show(refused)}`);
    assert.deepEqual(refused.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
    assert.match(refused.issues[0].detail, re);
    assert.ok(!(refused.steps || []).some((s) => /^(?:patch|build|poc:)/.test(s.name)), 'no patch, maker command or claim code ran');
  }
  // R25-F2: a fix that selects another compiler is a failed fixed build, a fact; the PoC's gates stand.
  const fx = await fixture('fixconfig');
  const toml = FOUNDRY_TOML();
  const fixPatch = modifyPatch('foundry.toml', toml, toml.replace('solc = "/opt/solc/solc"', 'solc = "src/compiler"'));
  const paths = { tests: ['test/**'], protected: ['lib/**', '.gitignore'] };
  const fixed = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': DRAIN }), { fixPatch, paths }));
  assert.equal(fixed.outcome, 'definitive', show(fixed));
  assert.equal(fixed.gates.reproduces.status, 'pass', show(fixed));
  assert.equal(fixed.facts.fix.builds, 'fail', JSON.stringify(fixed.facts.fix));
  assert.match(fixed.facts.fix.detail.builds, /fix\.patch changes foundry\.toml/);
});

test('A3a R23-F1 under real forge: a listed contract whose inline configuration sets where forge writes is refused before any patch or claim code, so an honest invariant PoC added to it cannot be failed by its counterexample', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('inlinepersist');
  const after = ANNOTATED.replace('function test_ok() public pure {}', 'H h;\n    function setUp() public { h = new H(); }\n    function invariant_only() public view { require(h.x() == 0, "moved"); }');
  const r = await run(t, claim(fx, modifyPatch('test/Annotated.t.sol', ANNOTATED, after), { finding: finding({ command: 'forge test --match-test invariant_only', observable: 'invariant_only fails' }) }));
  assert.equal(r.outcome, 'requester_error', show(r));
  assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_ROOT_UNCOVERED']);
  assert.match(r.issues[0].detail, /test\/Annotated\.t\.sol sets a path by inline configuration/);
  assert.ok(!(r.steps || []).some((s) => /^(?:patch|build|poc:)/.test(s.name)), 'no patch, maker command or claim code ran');
  // A claim's own annotation is the claim's: the scan is of what the maker listed, and its write fails its own check.
  const own = ANNOTATED.replace('function test_ok() public pure {}', 'H h;\n    function setUp() public { h = new H(); }\n    function invariant_only() public view { require(h.x() == 0, "moved"); }');
  const mine = await run(t, claim(await fixture('invariants'), addFilesPatch({ 'test/Exploit.t.sol': own }), { finding: finding({ command: 'forge test --match-test invariant_only', observable: 'invariant_only fails' }) }));
  assert.equal(mine.outcome, 'definitive', show(mine));
  assert.equal(mine.gates.integrity.status, 'fail', show(mine));
  assert.equal(mine.facts.poc.integrity.dependenciesUnchanged, false, show(mine));
});

test('A3a R22-F2 under real forge: a one-predicate invariant whose reason spans lines is an assertion failure, with or without a counterexample\'s sequence, and a quoted observable on its later line is found', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('invariants');
  const flat = pocFile('InvLines', [
    '    Vault v;', '    function setUp() public { v = new Vault(); v.deposit(1); }',
    '    function invariant_only() public view { require(v.balanceOf(address(this)) == 1, "expected balance\\nactual balance"); }'
  ]);
  const seq = [
    '// SPDX-License-Identifier: MIT', 'pragma solidity ^0.8.0;', 'import {Base} from "./Vm.sol";',
    'contract H { uint256 public x; function bump() public { x += 1; } }',
    'contract InvSeq is Base {', '    H h;', '    function setUp() public { h = new H(); }',
    '    function invariant_only() public view { require(h.x() == 0, "expected zero\\nactual more"); }', '}', ''
  ].join('\n');
  for (const [source, fragment] of [[flat, 'actual balance'], [seq, 'actual more']]) {
    const r = await run(t, claim(fx, addFilesPatch({ 'test/Exploit.t.sol': source }), { finding: finding({ command: 'forge test --match-test invariant_only', observable: `invariant_only fails with "${fragment}"` }) }));
    assert.equal(r.outcome, 'definitive', show(r));
    assert.deepEqual(r.facts.poc.tests[0].runs, ['fail', 'fail', 'fail'], show(r));
    assert.equal(r.facts.poc.tests[0].kind, 'assertion', show(r));
    assert.equal(r.gates.reproduces.status, 'pass', show(r));
    assert.equal(r.gates.claimedObservable.status, 'pass', show(r));
    assert.equal(r.facts.poc.tests[0].message.split('\n').length, 2, show(r));
  }
});

test('Known limit (Q35; pins today\'s behaviour, not a wanted one): a compiler in the image that waits for run 1 fails an honest claim\'s integrity; the runner cannot tell it from claim code', { timeout: TIMEOUT }, async (t) => {
  // `forge test` always compiles again after `forge build` (other settings), and forge runs `solc --version` on every start,
  // so a program the image ships as solc runs inside each PoC run. This one writes only once a compile cache exists.
  const r = await run(t, claim(await fixture('solcsecond'), addFilesPatch({ 'test/Exploit.t.sol': DRAIN })));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.build.status, 'pass', show(r));
  assert.equal(r.gates.integrity.status, 'fail', show(r));
  assert.equal(r.facts.poc.integrity.dependenciesUnchanged, false, show(r));
  assert.match(r.gates.integrity.detail, /run 1: lib\/trap\.sol added/);
  // Settlement reads no tamper flag and no failure of reproduces on its own: bond back, no award, the check named.
  const read = settlementFacts(r);
  assert.deepEqual(read.issues, [], 'common\'s validator');
  assert.equal(read.tampered, false);
  assert.deepEqual(read.failedChecks, ['protectedPathsUnchanged', 'dependenciesUnchanged']);
  assert.equal(read.reproducesFailed, 'only-through-integrity');
});

test('Known limit (Q35; pins today\'s behaviour, not a wanted one): repository code an honest proof calls through ffi and that writes a watched place: the same, no tamper flag', { timeout: TIMEOUT }, async (t) => {
  const poc = pocFile('ExploitTest', [
    `    function ${NAME}() public { ${ffiSh('sh scripts/setup-fixture.sh')} Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
  ]);
  const r = await run(t, claim(await fixture('repoffi'), addFilesPatch({ 'test/Exploit.t.sol': poc })));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.integrity.status, 'fail', show(r));
  const read = settlementFacts(r);
  assert.deepEqual(read.issues, [], 'common\'s validator');
  assert.equal(read.tampered, false, JSON.stringify(r.facts.poc.integrity.tamperFlags));
  assert.ok(read.failedChecks.includes('dependenciesUnchanged'), show(r));
  assert.equal(read.reproducesFailed, 'only-through-integrity');
});

test('Known limit (Q35; pins today\'s behaviour, not a wanted one): a fake solc that exits with an error on a test it has not seen fails an honest claim at the build gate, or, waiting for the compile `forge test` does, at reproduces on its own: both stay INVALID', { timeout: TIMEOUT }, async (t) => {
  const poc = addFilesPatch({ 'test/Exploit.t.sol': DRAIN });
  const atBuild = await run(t, claim(await fixture('solcunseen'), poc));
  assert.equal(atBuild.outcome, 'definitive', show(atBuild));
  assert.equal(atBuild.gates.build.status, 'fail', show(atBuild));
  assert.equal(atBuild.gates.reproduces, undefined, 'the PoC never ran');
  const read = settlementFacts(atBuild);
  assert.deepEqual(read.issues, [], 'common\'s validator');
  assert.equal(read.integrity, 'not-run', 'no integrity failure for settlement to read: the build gate, INVALID');
  const atRun = await run(t, claim(await fixture('solclater'), poc));
  assert.equal(atRun.outcome, 'definitive', show(atRun));
  assert.equal(atRun.gates.build.status, 'pass', show(atRun));
  assert.equal(atRun.gates.reproduces.status, 'fail', show(atRun));
  assert.match(atRun.gates.reproduces.detail, /no JUnit on run 1/);
  const readRun = settlementFacts(atRun);
  assert.deepEqual(readRun.issues, [], 'common\'s validator');
  assert.equal(readRun.reproducesFailed, 'on-its-own', 'a false rejection at reproduces: INVALID');
  // The honest PoC itself is good: the same claim on an image without the fake passes every gate (the ordinary-PoCs test).
});

test('A3a R7-F1 under real forge: a PoC patch adding 5,000 links to `.` under test/ is never followed, and the claim passes', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const links = {};
  for (let i = 0; i < 5000; i += 1) links[`test/links/l${i}`] = '.';
  const patch = Buffer.concat([addFilesPatch({ 'test/Exploit.t.sol': DRAIN }), addLinksPatch(links)]);
  const r = await run(t, claim(fx, patch));
  assert.equal(r.outcome, 'definitive', show(r));
  for (const g of ['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity']) assert.equal(r.gates[g].status, 'pass', `${g}: ${show(r)}`);
  assert.deepEqual(stepMs(r, /:links$/), [], 'links outside every watched set are never resolved');
});

test('a link the patch adds inside a watched set (paths.tests overlapping lib/) under real forge: the dependencies check fails, the link is never followed, the image is not refused', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const patch = Buffer.concat([addFilesPatch({ 'test/Exploit.t.sol': DRAIN }), addLinksPatch({ 'lib/x/E.t.sol': '/tmp/evil' })]);
  const r = await run(t, claim(fx, patch, { paths: { tests: ['test/**', 'lib/**/*.t.sol'], protected: ['foundry.toml', '.gitignore'] } }));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.gates.testPathsOnly.status, 'pass', show(r));
  assert.equal(r.gates.integrity.status, 'fail', show(r));
  assert.equal(r.facts.poc.integrity.dependenciesUnchanged, false);
  assert.match(r.gates.integrity.detail, /dependenciesUnchanged \(the reference: the patch adds a link inside the dependencies \(lib\/x\/E\.t\.sol\)/);
  assert.deepEqual(stepMs(r, /:links/), [], 'never resolved');
});

// ------------------------------------------------------------------ the fix check

test('fix check under real forge: a fix that verifies, one whose PoC still fails, and one that breaks a stable test (regression); the claim\'s gates never move', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture();
  const vault = VAULT_REPO['src/Vault.sol'];
  const poc = addFilesPatch({ 'test/Exploit.t.sol': DRAIN });
  const cases = [
    [modifyPatch('src/Vault.sol', vault, vault.replace('amount + 1', 'amount')), { pocPasses: true, regressions: [] }],
    [modifyPatch('src/Vault.sol', vault, vault.replace('contract Vault {', '// a comment, not a fix\ncontract Vault {')), { pocPasses: false, regressions: [] }],
    [modifyPatch('src/Vault.sol', vault, vault.replace('amount + 1', '0')), { pocPasses: false, regressions: ['test/Vault.t.sol > VaultTest > test_deposit()'] }]
  ];
  for (const [fixPatch, want] of cases) {
    const r = await run(t, claim(fx, poc, { fixPatch }));
    assert.equal(r.outcome, 'definitive', show(r));
    for (const g of ['applies', 'testPathsOnly', 'build', 'reproduces', 'integrity', 'claimedObservable']) assert.equal(r.gates[g].status, 'pass', `${g}: ${show(r)}`);
    const f = r.facts.fix;
    assert.equal(f.present, true);
    assert.equal(f.applies, 'pass', JSON.stringify(f.detail));
    assert.equal(f.builds, 'pass', JSON.stringify(f.detail));
    assert.equal(f.pocPasses, want.pocPasses, JSON.stringify(f.suite));
    assert.deepEqual(f.regressions, want.regressions);
    assert.equal(f.regressionCount, want.regressions.length);
    assert.deepEqual(f.integrity, CLEAN, JSON.stringify(r.facts.integrity.fix));
    assert.ok(r.steps.some((s) => s.name === 'fix:suite'));
  }
  // A fix that edits a test does not apply; the fixed tree is never built.
  const touchesTest = modifyPatch('test/Vault.t.sol', VAULT_REPO['test/Vault.t.sol'], VAULT_REPO['test/Vault.t.sol'].replace('"no credit"', '"none"'));
  const r = await run(t, claim(fx, poc, { fixPatch: touchesTest }));
  assert.equal(r.facts.fix.applies, 'fail', show(r));
  assert.equal(r.facts.fix.builds, 'not-run');
  assert.match(r.facts.fix.detail.applies, /test\/Vault\.t\.sol under paths\.tests/);
});
