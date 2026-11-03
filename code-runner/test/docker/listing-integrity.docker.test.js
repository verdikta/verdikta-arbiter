'use strict';

// Node A2c against real forge (the base pinned in @verdikta/common, v1.8.5): the listing check takes a claim's integrity
// reference, holds its suite and its harness probes to a claim's post-run checksums, and refuses any solc in the image that
// is not an official release. One test per refusal code; each code a claim gives is run as a claim too, on the same image,
// and must be the same code. Ordinary projects must pass, and a claim on them must then pass. Under runc locally; CI runs
// this file under runc and under gVisor (runsc). Every container and image is removed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { executeRun } = require('../../src/pipeline');
const { validateListingRequest, listingSteps, imageUnpackedBytes } = require('../../src/listing');
const { officialList, makeList } = require('../../src/solcReleases');
const { checkSpec } = require('../../src/classLimits');
const { claimSteps } = require('../../src/steps');
const { checkClaim } = require('../../src/claim');
const { svmEntryProblem, discoverForge } = require('../../src/integrity');
const forgeLib = require('../../src/forge');
const { runText } = require('../../src/docker');
const { PLATFORM, silent, instanceId, dockerTestConfig, dockerFor, ensureImage, leftovers, removeAll, smallLimits } = require('./helpers');
const { VAULT_REPO, FOUNDRY_TOML, vaultBaseline, buildFixture, addFilesPatch, pocFile, foundryBase, forgeStdFiles } = require('./forgeFixture');

const TIMEOUT = 900000;
const builder = dockerFor(dockerTestConfig());
const fixtures = new Map();
const SVM = '/opt/verdikta/tools/share/svm';
const BASE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** A setup line writing `text` to `file` exactly, its bytes known to the test (its hash goes on a test's list). */
const writeFile = (file, text) => `printf '%s' '${Buffer.from(text).toString('base64')}' | base64 -d > ${file} && chmod 0755 ${file}`;
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
/** The official list for this platform, plus programs this test wants past the look so that it can see what comes after it. */
const listWith = (...texts) => {
  const official = officialList(PLATFORM);
  return makeList({ platform: PLATFORM, asOf: official.asOf, releases: { ...Object.fromEntries(official.releases), ...Object.fromEntries(texts.map((t, i) => [`0.0.${i + 1}`, sha256(t)])) } });
};

const NAMES_VERSION = FOUNDRY_TOML().replace('solc = "/opt/solc/solc"', 'solc_version = "0.8.31"');
const NAMES_NOTHING = (extra = '') => FOUNDRY_TOML(extra).replace('solc = "/opt/solc/solc"\n', '');
const STD = {
  // forge-std's Test, cut down to the assertion the probe uses, with a constructor that runs `script` in sh when given.
  stub: (script = null) => [
    '// SPDX-License-Identifier: MIT',
    'pragma solidity >=0.6.2;',
    'pragma experimental ABIEncoderV2;',
    'interface VmStd {',
    '    function assertEq(uint256 a, uint256 b, string calldata err) external pure;',
    '    function ffi(string[] calldata c) external returns (bytes memory);',
    '}',
    'abstract contract Test {',
    '    VmStd private constant VM = VmStd(address(uint160(uint256(keccak256("hevm cheat code")))));',
    ...(script === null ? [] : [
      `    constructor() { string[] memory c = new string[](3); c[0] = "sh"; c[1] = "-c"; c[2] = ${JSON.stringify(script)}; VM.ffi(c); }`
    ]),
    '    function assertEq(uint256 a, uint256 b, string memory err) internal { VM.assertEq(a, b, err); }',
    '}',
    ''
  ].join('\n')
};
const REMAP = 'remappings = ["forge-std/=lib/forge-std/src/"]';

/** A fake compiler: the real one, after `extra` (shell). */
const SOLC_TRAP = '#!/bin/sh\ncase " $* " in *" --standard-json "*) printf x > /work/lib/trap.sol ;; esac\nexec /opt/solc/solc.real "$@"\n';
const SOLC_WRAP = '#!/bin/sh\nexec /opt/solc/solc "$@"\n';
const replaceSolc = (text) => `mv /opt/solc/solc /opt/solc/solc.real && ${writeFile('/opt/solc/solc', text)}`;
const svmFile = (v, name = `solc-${v}`) => `${SVM}/${v}/${name}`;
const tools = (...lines) => [`mkdir -p ${SVM}`, ...lines, 'chmod -R a+rX /opt/verdikta'].join(' && ');

/** A contract under test/ whose test runs `script` in sh through ffi (fs_permissions stays forge's business). */
const FFI_TEST = (script) => [
  '// SPDX-License-Identifier: MIT',
  'pragma solidity ^0.8.0;',
  'import {Base} from "./Vm.sol";',
  'contract WriterTest is Base {',
  `    function test_writer() public { string[] memory c = new string[](3); c[0] = "sh"; c[1] = "-c"; c[2] = ${JSON.stringify(script)}; vm.ffi(c); }`,
  '}',
  ''
].join('\n');
const ONCE = (then) => `if [ -e state/once ]; then ${then}; fi; : > state/once`;

/** An ordinary Foundry project (forge init's shape): real forge-std, a unit, fuzz and invariant test, console logging. */
const COUNTER = Object.freeze({
  'src/Counter.sol': '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.13;\ncontract Counter {\n    uint256 public number;\n    function setNumber(uint256 n) public { number = n; }\n    function increment() public { number += 1; }\n}\n',
  'test/Counter.t.sol': [
    '// SPDX-License-Identifier: MIT',
    'pragma solidity ^0.8.13;',
    'import {Test, console} from "forge-std/Test.sol";',
    'import {Counter} from "../src/Counter.sol";',
    'contract CounterTest is Test {',
    '    Counter public counter;',
    '    function setUp() public { counter = new Counter(); counter.setNumber(0); targetContract(address(counter)); }',
    '    function test_Increment() public { counter.increment(); console.log("number", counter.number()); assertEq(counter.number(), 1); }',
    '    function testFuzz_SetNumber(uint256 x) public { counter.setNumber(x); assertEq(counter.number(), x); }',
    '    function invariant_ReadsBack() public view { assertEq(counter.number(), counter.number()); }',
    '}',
    ''
  ].join('\n'),
  'script/Counter.s.sol': '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.13;\nimport {Script} from "forge-std/Script.sol";\ncontract CounterScript is Script { function run() public {} }\n',
  'remappings.txt': 'forge-std/=lib/forge-std/src/\n',
  'foundry.lock': '{}\n',
  '.gitignore': 'out/\ncache/\nbroadcast/\n.env\n',
  '.gitmodules': '[submodule "lib/forge-std"]\n\tpath = lib/forge-std\n\turl = https://github.com/foundry-rs/forge-std\n',
  'foundry.toml': '[profile.default]\nsrc = "src"\nout = "out"\nlibs = ["lib"]\nsolc_version = "0.8.31"\noffline = true\n\n[invariant]\nruns = 4\ndepth = 4\n'
});
/** The image shape the attested builder makes (builder/src/dockerfile.js). */
const BUILDER_ENV = ['XDG_DATA_HOME=/opt/verdikta/tools/share', 'VERDIKTA_TOOLS=/opt/verdikta/tools', `PATH=${BASE_PATH}:/opt/verdikta/tools/bin`];
const AS_BUILDER = 'chown -R 10001:10001 /repo && git config --system --add safe.directory /repo';
/** What forge's own install leaves beside a release: these are no compilers (see the install test below). */
const INSTALL_MARKERS = (...versions) => [`: > ${SVM}/.global-version`, ...versions.map((v) => `: > ${SVM}/${v}/.lock`)].join(' && ');

/** Files in the near-cap fixture: each a find record and a hash line of about 3,900 bytes of path, about 7,900 bytes in all. */
const NEAR_CAP_FILES = 8300;

const VARIANTS = Object.freeze({
  // ------------------------------------------------- what a claim refuses, the same image as both
  forgeunwatched: {
    setup: 'mkdir -p bin cache/solidity-files-cache.json.abi && cp /usr/local/bin/forge cache/solidity-files-cache.json.abi/forge && ln -s ../cache/solidity-files-cache.json.abi/forge bin/forge',
    env: [`PATH=/work/bin:${BASE_PATH}`]
  },
  linkuncovered: { setup: 'mkdir -p cache/pkg lib && printf "contract Dep {}\\n" > cache/pkg/Dep.sol && ln -s ../cache/pkg lib/cpkg' },
  // 17 levels of linked trees, one past the cap.
  toolarge: { setup: 'mkdir -p lib trees && ln -s ../trees/a0 lib/start && i=0 && while [ $i -lt 18 ]; do mkdir -p trees/a$i; ln -s ../a$((i+1)) trees/a$i/next; i=$((i+1)); done' },
  rootuncovered: { files: { ...VAULT_REPO, 'foundry.toml': FOUNDRY_TOML().replace('out = "out"', 'out = "/tmp/forge-out"') } },
  outincache: { files: { ...VAULT_REPO, 'foundry.toml': FOUNDRY_TOML().replace('out = "out"', 'out = "cache/artifacts"') } },
  inlinepath: { files: { ...VAULT_REPO, 'test/Note.t.sol': '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\n/// forge-config: default.invariant.failure_persist_dir = "lib/persist"\ncontract Note { function test_n() public pure {} }\n' } },
  svmthroughtree: { files: { ...VAULT_REPO, 'foundry.toml': NAMES_VERSION }, setup: tools(`mkdir -p ${SVM}/0.8.31`, `ln -s /work/test/solc ${svmFile('0.8.31')}`) },
  // A compiler in the tree, by a path that does not start with /work/: forge's own directory through /proc, and a doubled slash.
  procself: { files: { ...VAULT_REPO, 'foundry.toml': FOUNDRY_TOML().replace('solc = "/opt/solc/solc"', 'solc = "/proc/self/cwd/tools/solc"') }, setup: 'mkdir -p tools && ln -s /opt/solc/solc tools/solc' },
  doubleslash: { files: { ...VAULT_REPO, 'foundry.toml': FOUNDRY_TOML().replace('solc = "/opt/solc/solc"', 'solc = "//work/tools/solc"') }, setup: 'mkdir -p tools && ln -s /opt/solc/solc tools/solc' },
  // The same through a link on the read-only root, named or as an installed release: official bytes today, a patch's tomorrow.
  proclinked: {
    files: { ...VAULT_REPO, 'foundry.toml': FOUNDRY_TOML().replace('solc = "/opt/solc/solc"', 'solc = "/opt/x/solc"') },
    setup: 'mkdir -p /opt/x && ln -s /proc/self/cwd/test/solc /opt/x/solc && ln -s /opt/solc/solc test/solc'
  },
  procsvm: {
    files: { ...VAULT_REPO, 'foundry.toml': NAMES_VERSION },
    setup: tools(`mkdir -p ${SVM}/0.8.31`, `ln -s /proc/self/cwd/test/solc ${svmFile('0.8.31')}`, 'ln -s /opt/solc/solc test/solc')
  },
  unreadable: {},
  nogrep: { setup: 'rm -f /usr/bin/grep' },
  norealpath: { setup: 'rm -f /usr/bin/realpath && mkdir -p lib/solady && ln -s solady lib/alias' },
  noforge: { env: ['PATH=/usr/sbin:/usr/bin:/sbin:/bin'] },
  badconfig: { files: { ...VAULT_REPO, 'foundry.toml': '[profile.default\nthis is not toml\n' } },
  solctrap: { files: { ...VAULT_REPO, 'lib/.keep': '' }, setup: replaceSolc(SOLC_TRAP) },
  // ------------------------------------------------- not an official release
  solcwrapper: { setup: replaceSolc(SOLC_WRAP.replace('/opt/solc/solc', '/opt/solc/solc.real')) },
  installedfake: { files: { ...VAULT_REPO, 'foundry.toml': NAMES_VERSION }, setup: tools(`mkdir -p ${SVM}/0.8.31`, writeFile(svmFile('0.8.31'), SOLC_WRAP)) },
  // The listing names an official release; a pragma could still pick the fake with the variable empty.
  otherfake: { files: { ...VAULT_REPO, 'foundry.toml': NAMES_VERSION }, installed: ['0.8.31'], setup: tools(`mkdir -p ${SVM}/0.8.32`, writeFile(svmFile('0.8.32'), SOLC_WRAP)) },
  wrongbytes: { files: { ...VAULT_REPO, 'foundry.toml': NAMES_VERSION }, installed: ['0.8.32'], setup: tools(`mkdir -p ${SVM}/0.8.31`, `cp ${svmFile('0.8.32')} ${svmFile('0.8.31')}`) },
  newerthanlist: { installed: [], setup: tools(`mkdir -p ${SVM}/0.9.99`, `cp /opt/solc/solc ${svmFile('0.9.99')}`) },
  svmextra: { installed: ['0.8.31'], setup: tools(writeFile(`${SVM}/0.8.31/helper`, SOLC_WRAP)) },
  svmlinked: { files: { ...VAULT_REPO, 'foundry.toml': NAMES_VERSION }, setup: tools(`mkdir -p ${SVM}/0.8.31`, `ln -s /opt/solc/solc ${svmFile('0.8.31')}`) },
  svmoddname: { installed: ['0.8.31'], setup: tools(`mkdir -p '${SVM}/0.8.35+fake'`, writeFile(`'${SVM}/0.8.35+fake/solc-0.8.35+fake'`, SOLC_WRAP)) },
  pathsolc: { setup: `mkdir -p /opt/pathsolc && ${writeFile('/opt/pathsolc/solc', SOLC_WRAP)}`, env: [`PATH=/opt/pathsolc:${BASE_PATH}`] },
  // What names the compiler, other than foundry.toml's default profile: the pin reads forge's answer, so the look reads that file.
  envnames: { files: { ...VAULT_REPO, 'foundry.toml': NAMES_NOTHING(), '.env': 'FOUNDRY_SOLC=/opt/fake/solc\n' }, setup: `mkdir -p /opt/fake && ${writeFile('/opt/fake/solc', SOLC_WRAP)}` },
  envprofile: { files: { ...VAULT_REPO, 'foundry.toml': `${FOUNDRY_TOML()}\n[profile.alt]\nsolc = "/opt/fake/solc"\n`, '.env': 'FOUNDRY_PROFILE=alt\n' }, setup: `mkdir -p /opt/fake && ${writeFile('/opt/fake/solc', SOLC_WRAP)}` },
  unreadablerelease: { files: { ...VAULT_REPO, 'foundry.toml': NAMES_VERSION }, installed: ['0.8.31'], setup: `chmod 0111 ${svmFile('0.8.31')}` },
  // ------------------------------------------------- a suite, or a probe, that writes what claims are held to
  suitelib: { toml: 'ffi = true', files: { ...VAULT_REPO, 'test/Writer.t.sol': FFI_TEST('printf x > lib/trap.sol; printf y > lib/trap2.sol'), 'lib/.keep': '' } },
  suitetoml: { toml: 'ffi = true', files: { ...VAULT_REPO, 'test/Writer.t.sol': FFI_TEST('printf "# touched\\n" >> foundry.toml') } },
  suitehome: { toml: 'ffi = true', files: { ...VAULT_REPO, 'test/Writer.t.sol': FFI_TEST('printf x > "$HOME/planted"') } },
  suitelater: { toml: 'ffi = true', files: { ...VAULT_REPO, 'test/Writer.t.sol': FFI_TEST(ONCE('printf x > lib/trap.sol')), 'lib/.keep': '' } },
  suiteartifact: { toml: 'ffi = true', files: { ...VAULT_REPO, 'test/Writer.t.sol': FFI_TEST(`${ONCE('printf 2 > out/stamp')}; [ -e out/stamp ] || printf 1 > out/stamp`) } },
  // A trap that spares the suite: only what imports forge-std runs it, as the harness probe does.
  stdtrap: { toml: `ffi = true\n${REMAP}`, files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': STD.stub('printf x > lib/trap.sol') } },
  // The same, only from the second run on: the first of the testIds runs.
  stdtraplater: { toml: `ffi = true\n${REMAP}`, files: { ...VAULT_REPO, 'lib/forge-std/src/Test.sol': STD.stub(ONCE('printf x > lib/trap.sol')) } },
  // ------------------------------------------------- what must pass
  ordinary: { files: null, installed: ['0.8.31'], setup: `${INSTALL_MARKERS('0.8.31')} && chmod -R a+rX /opt/verdikta && ${AS_BUILDER}`, env: BUILDER_ENV },
  prebuilt: { setup: 'forge build' },
  nodemodules: { setup: 'mkdir -p node_modules/.bin node_modules/pkg node_modules/.pnpm/a@1/node_modules/a && printf "module.exports=1\\n" > node_modules/pkg/index.js && printf "{}\\n" > node_modules/.pnpm/a@1/node_modules/a/package.json && ln -s ../pkg/index.js node_modules/.bin/pkg && ln -s .pnpm/a@1/node_modules/a node_modules/a' },
  mixed: {
    files: {
      ...VAULT_REPO,
      'foundry.toml': NAMES_NOTHING(),
      'src/Vault.sol': VAULT_REPO['src/Vault.sol'].replace('pragma solidity ^0.8.0;', 'pragma solidity =0.8.31;'),
      'src/Later.sol': '// SPDX-License-Identifier: MIT\npragma solidity =0.8.32;\ncontract Later { function value() public pure returns (uint256) { return 1; } }\n'
    },
    installed: ['0.8.31', '0.8.32'],
    setup: INSTALL_MARKERS('0.8.31', '0.8.32')
  },
  namedthroughlink: {
    files: { ...VAULT_REPO, 'foundry.toml': FOUNDRY_TOML().replace('solc = "/opt/solc/solc"', 'solc = "/opt/verdikta/tools/bin/solc"') },
    setup: 'mkdir -p /opt/verdikta/tools/bin && ln -s /opt/solc/solc /opt/verdikta/tools/bin/solc && chmod -R a+rX /opt/verdikta'
  },
  plainvault: {},
  // Just under what a listing may hold (LISTING_RESERVE): long paths, no bytes, so the listing is large and the work tree small.
  nearcap: {
    setup: [
      'p=pad; i=0; while [ $i -lt 15 ]; do p="$p/$(printf "%0250d" $i)"; i=$((i+1)); done',
      'mkdir -p "$p"',
      `i=0; while [ $i -lt ${NEAR_CAP_FILES} ]; do : > "$p/f$i"; i=$((i+1)); done`
    ].join('; ')
  },
  // A known limit: repository code only a proof would call, which nothing at listing runs.
  repoffi: { toml: 'ffi = true', files: { ...VAULT_REPO, 'lib/.keep': '', 'scripts/setup-fixture.sh': 'printf x > lib/trap.sol\n' } },
  // ------------------------------------------------- forge's lookup, with a compiler planted where it never looks
  planted: {
    files: { ...VAULT_REPO, 'foundry.toml': NAMES_NOTHING() },
    installed: ['0.8.31'],
    setup: tools(
      ...[`${SVM}/v0.8.33/solc-0.8.33`, `${SVM}/0.8.34-fake/solc-0.8.34-fake`, `'${SVM}/0.8.35+fake/solc-0.8.35+fake'`, `${SVM}/0.8.36/solc`, `${SVM}/0.8.31/solc`, '/opt/pathsolc/solc', '/opt/elsewhere/svm/0.8.31/solc-0.8.31'].flatMap((f) => [
        `mkdir -p "$(dirname ${f})"`,
        writeFile(f, '#!/bin/sh\nprintf x > /tmp/planted-ran\nexec /opt/solc/solc "$@"\n')
      ]),
      'chmod -R a+rX /opt/pathsolc /opt/elsewhere'
    ),
    env: [`PATH=/opt/pathsolc:${BASE_PATH}`]
  }
});

async function fixture(variant) {
  if (!fixtures.has(variant)) {
    const v = VARIANTS[variant];
    const files = v.files === null ? { ...COUNTER, ...await forgeStdFiles() } : v.files;
    fixtures.set(variant, buildFixture(builder, { ...v, ...(files ? { files } : {}), instance: `${instanceId()}${variant}` }));
  }
  return fixtures.get(variant);
}

test.after(async () => {
  for (const f of fixtures.values()) {
    try { await (await f).remove(); } catch (_) { /* the build failed: nothing to remove */ }
  }
});

const PATHS = { tests: ['test/**'], protected: ['foundry.toml', 'lib/**', '.gitignore'] };
const COMMANDS = { framework: 'forge', build: 'forge build', test: 'forge test', testFiles: 'forge test --match-path $FILES', testIds: 'forge test --match-test $TEST_IDS' };

function body(fx, over = {}) {
  return {
    spec: {
      version: 1, kind: 'bug', repo: 'https://github.com/acme/vault', baseCommit: fx.baseCommit,
      env: { from: 'foundry' }, commands: { ...COMMANDS, ...(over.commands || {}) },
      paths: over.paths || PATHS, stake: { scope: { include: ['src/**'] } }, limits: { cpus: 1, memoryMb: 1024 }
    },
    image: fx.image,
    deadline: 900000
  };
}

async function check(t, b, { before = [], solcList = undefined } = {}) {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance).catch(() => {}));
  const v = validateListingRequest(b);
  assert.ok(v.ok, JSON.stringify(v.issues));
  const steps = listingSteps(v.request, v.limits, { imageSize: () => imageUnpackedBytes(docker, v.request.image), platform: PLATFORM, ...(solcList ? { solcList } : {}) });
  const receivedAt = Date.now();
  const result = await executeRun({
    docker, config, limits: v.limits, image: v.request.image, runId: crypto.randomBytes(8).toString('hex'),
    steps: [...before, ...steps], receivedAt, deadlineAt: receivedAt + v.request.deadlineMs, active: new Set(), log: silent
  });
  assert.deepEqual(await leftovers(docker, config.instance), [], 'the check removed its sandbox');
  return result;
}

const NAME = 'test_deposit_credits_exactly';
const DRAIN = pocFile('ExploitTest', [
  `    function ${NAME}() public { Vault v = new Vault(); v.deposit(1); vm.assertEq(v.balanceOf(address(this)), 1); }`
]);
const FINDING = (name = NAME) => ({
  version: 1, claimedClass: 'HIGH', rootCause: 'A deposit credits one wei more than it receives, so balances overstate deposits.',
  affectedPaths: ['src/Vault.sol'], poc: { command: `forge test --match-test ${name}`, observable: `${name} fails at the committed hash` }
});

function claimOf(fx, { pocPatch = addFilesPatch({ 'test/Exploit.t.sol': DRAIN }), baseline = vaultBaseline(fx.baseCommit), limits, commands = {}, finding = FINDING() } = {}) {
  return {
    listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    bcid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    spec: {
      version: 1, kind: 'bug', repo: 'https://github.com/acme/vault', baseCommit: fx.baseCommit,
      env: { image: fx.image, from: 'foundry', platform: 'linux/amd64', unpackedBytes: 2000000000 },
      attestation: 'attestation.json', commands: { ...COMMANDS, ...commands }, paths: PATHS,
      limits: limits || { cpus: 1, memoryMb: 1024, buildSeconds: 90, testSeconds: 120, runSeconds: 360, maxPatchBytes: 2000000 }
    },
    attestation: {}, pocPatch, fixPatch: null, baseline, finding, report: '', knownIssues: [], priorFindings: [],
    eaGates: { disclosure: 'pass', inScope: 'pass' }, deadlineMs: 800000
  };
}

async function claim(t, fx, { before = [], ...over } = {}) {
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance).catch(() => {}));
  const request = claimOf(fx, over);
  const lim = checkSpec(request.spec);
  assert.ok(lim.ok, JSON.stringify(lim.issues));
  const receivedAt = Date.now();
  const result = await executeRun({
    docker, config, limits: lim.limits, image: fx.image, runId: crypto.randomBytes(8).toString('hex'),
    steps: [...before, ...claimSteps(request, lim.limits)], receivedAt, deadlineAt: receivedAt + request.deadlineMs, active: new Set(), log: silent, sandboxes: 1
  });
  assert.deepEqual(await leftovers(docker, config.instance), [], 'the run removed its sandbox');
  return result;
}

const show = (r) => JSON.stringify({
  outcome: r.outcome, abstain: r.abstain, issues: r.issues, gates: r.gates,
  listing: r.facts && r.facts.listing ? { ...r.facts.listing, baseline: undefined } : undefined,
  step: r.abstain ? (r.steps || []).find((s) => s.name === r.abstain.step) : undefined
}, null, 1);
const stepNames = (r) => (r.steps || []).map((s) => s.name);

// ---------------------------------------------------------- one test per code a claim gives: the same image, both ways

/** A listing's directory no real image can leave (the forced checkout refuses what it cannot read), so a step stands in for one. */
const HIDDEN = async (ctx) => {
  const r = await ctx.exec(['/bin/sh', '-c', 'mkdir -p /work/lib/hidden && chmod 0311 /work/lib/hidden'], { name: 'plant', timeoutMs: 60000 });
  assert.equal(r.exitCode, 0);
};

const SAME_CODE = Object.freeze([
  ['IMAGE_FORGE_UNWATCHED', 'forgeunwatched', /forge resolves to \/work\/cache\/solidity-files-cache\.json\.abi\/forge/],
  ['IMAGE_WATCH_LINK_UNCOVERED', 'linkuncovered', /lib\/cpkg -> \/work\/cache\/pkg \(forge's cache directory \(cache\)\)/],
  ['IMAGE_WATCH_TOO_LARGE', 'toolarge', /more than 16 levels of linked trees/],
  ['IMAGE_WATCH_ROOT_UNCOVERED', 'rootuncovered', /out \(\/tmp\/forge-out\) is not a plain path in the work tree/],
  ['IMAGE_WATCH_ROOT_UNCOVERED', 'outincache', /out \(cache\/artifacts\) is in forge's cache directory/],
  ['IMAGE_WATCH_ROOT_UNCOVERED', 'inlinepath', /test\/Note\.t\.sol sets a path by inline configuration/],
  ['IMAGE_WATCH_ROOT_UNCOVERED', 'svmthroughtree', /svm\/0\.8\.31\/solc-0\.8\.31/],
  ['IMAGE_WATCH_ROOT_UNCOVERED', 'procself', /\/proc\/self\/cwd\/tools\/solc/],
  ['IMAGE_WATCH_ROOT_UNCOVERED', 'doubleslash', /\/\/work\/tools\/solc/],
  ['IMAGE_WATCH_ROOT_UNCOVERED', 'proclinked', /\/opt\/x\/solc/],
  ['IMAGE_WATCH_ROOT_UNCOVERED', 'procsvm', /svm\/0\.8\.31\/solc-0\.8\.31/],
  ['IMAGE_WATCH_UNREADABLE', 'unreadable', /lib\/hidden/, { before: [HIDDEN] }],
  ['IMAGE_TOOL_MISSING', 'nogrep', /no grep/],
  ['IMAGE_TOOL_MISSING', 'norealpath', /no realpath/],
  ['IMAGE_FORGE_MISSING', 'noforge', /no forge on its PATH/],
  ['FORGE_CONFIG_INVALID', 'badconfig', /forge config --json. failed at the listed commit/],
  // A compiler that writes a watched place in a build. The look would stop it first, so this list lets it by.
  ['IMAGE_WATCH_CHANGED_BY_BUILD', 'solctrap', /the build: lib\/trap\.sol added/, { solcList: () => listWith(SOLC_TRAP) }]
]);

for (const [code, variant, detail, opts = {}] of SAME_CODE) {
  test(`A2c under real forge: ${code} (${variant}): refused at listing with the code a claim gives on the same image, before anything of the maker's runs where the claim's is`, { timeout: TIMEOUT }, async (t) => {
    const fx = await fixture(variant);
    const listing = await check(t, body(fx), { before: opts.before, solcList: opts.solcList ? opts.solcList() : undefined });
    assert.equal(listing.outcome, 'requester_error', show(listing));
    assert.deepEqual(listing.issues.map((i) => i.code), [code], show(listing));
    assert.match(listing.issues[0].detail, detail);
    assert.equal(listing.issues[0].path, '/spec/env/image');
    if (code !== 'IMAGE_WATCH_CHANGED_BY_BUILD') assert.ok(!stepNames(listing).includes('build'), 'no maker command ran');
    assert.ok(!stepNames(listing).some((n) => /^suite:/.test(n)), 'no suite ran');
    const asClaim = await claim(t, fx, { before: opts.before });
    assert.equal(asClaim.outcome, 'requester_error', show(asClaim));
    assert.deepEqual(asClaim.issues.map((i) => i.code), [code], show(asClaim));
    assert.equal(asClaim.issues[0].detail, listing.issues[0].detail, 'the same words');
  });
}

test('A2c under real forge: Q31 (a): a command a claim refuses is refused at listing with the same code, before any sandbox; forge runs from the runner\'s own argv', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('plainvault');
  const forms = [
    [{ build: 'forge build && touch /tmp/x' }, 'COMMAND_NOT_ALLOWED', '/spec/commands/build'],
    [{ build: 'FOUNDRY_PROFILE=ci forge build' }, 'COMMAND_NOT_ALLOWED', '/spec/commands/build'],
    [{ build: '/usr/local/bin/forge build' }, 'COMMAND_NOT_ALLOWED', '/spec/commands/build'],
    [{ build: 'make build' }, 'COMMAND_NOT_ALLOWED', '/spec/commands/build'],
    [{ test: 'sh -c "forge test"' }, 'COMMAND_NOT_ALLOWED', '/spec/commands/test'],
    [{ test: 'forge test --use /tmp/solc' }, 'COMMAND_NOT_ALLOWED', '/spec/commands/test'],
    [{ test: `forge test ${'-v '.repeat(700)}` }, 'COMMAND_INVALID', '/spec/commands/test'],
    [{ build: '' }, 'COMMAND_MISSING', '/spec/commands/build'],
    [{ testFiles: 'forge test' }, 'COMMAND_PLACEHOLDER', '/spec/commands/testFiles'],
    [{ testIds: 'forge test --match-path $FILES' }, 'COMMAND_PLACEHOLDER', '/spec/commands/testIds']
  ];
  for (const [commands, code, path] of forms) {
    const v = validateListingRequest(body(fx, { commands }));
    assert.equal(v.ok, false, JSON.stringify(commands));
    assert.deepEqual(v.issues.map((i) => [i.code, i.path]), [[code, path]], JSON.stringify(commands));
    const c = checkClaim(claimOf(fx, { commands }));
    assert.deepEqual(c.map((i) => [i.code, i.path, i.detail]), v.issues.map((i) => [i.code, i.path, i.detail]), `a claim gives the same issue for ${JSON.stringify(commands)}`);
  }
});

// ---------------------------------------------------------- SOLC_NOT_OFFICIAL

const NOT_OFFICIAL = Object.freeze([
  ['a compiler named by a file outside the work tree that is a wrapper (Q37 condition 2)', 'solcwrapper', /\/opt\/solc\/solc .*is not an official solc release/],
  ['the release the listing names, a wrapper under its name', 'installedfake', /svm\/0\.8\.31\/solc-0\.8\.31 .*is not official 0\.8\.31/],
  ['another installed release, which a pragma could pick with the variable empty', 'otherfake', /svm\/0\.8\.32\/solc-0\.8\.32 .*is not official 0\.8\.32/],
  ['an official release\'s bytes under another release\'s name', 'wrongbytes', /svm\/0\.8\.31\/solc-0\.8\.31 .*is not official 0\.8\.31/],
  ['a release the runner\'s list does not hold', 'newerthanlist', /svm\/0\.9\.99\/solc-0\.9\.99 .*0\.9\.99 is not on the list/],
  ['anything else under svm/', 'svmextra', /svm\/0\.8\.31\/helper .*not a file forge's install leaves/],
  ['a link under svm/, even to an official file', 'svmlinked', /svm\/0\.8\.31\/solc-0\.8\.31 .*is a link/],
  ['a directory forge reads a version from, with another name', 'svmoddname', /svm\/0\.8\.35\+fake\/solc-0\.8\.35\+fake .*not a file forge's install leaves/],
  ['a solc on PATH', 'pathsolc', /\/opt\/pathsolc\/solc .*is not an official solc release/],
  ['a compiler a .env names', 'envnames', /\/opt\/fake\/solc \(the compiler the listing names\) is not an official solc release/],
  ['a compiler in the profile a .env selects', 'envprofile', /\/opt\/fake\/solc \(the compiler the listing names\) is not an official solc release/],
  ['a release the sandbox user can run but not read', 'unreadablerelease', /svm\/0\.8\.31\/solc-0\.8\.31 .*cannot be read/]
]);

for (const [what, variant, detail] of NOT_OFFICIAL) {
  test(`A2c under real forge: SOLC_NOT_OFFICIAL: ${what}, before any build`, { timeout: TIMEOUT }, async (t) => {
    const r = await check(t, body(await fixture(variant)));
    assert.equal(r.outcome, 'definitive', show(r));
    assert.equal(r.facts.listing.status, 'refused', show(r));
    assert.deepEqual(r.facts.listing.refusals.map((x) => x.code), ['SOLC_NOT_OFFICIAL'], show(r));
    assert.match(r.facts.listing.refusals[0].detail, detail);
    assert.ok(!stepNames(r).includes('build'), 'the fake never compiled anything at listing');
    assert.equal(r.facts.listing.baseline, null);
  });
}

test('A2c under real forge: a fake compiler that stays behind when forge reads its configuration is killed before the look, so nothing of the maker\'s is alive while the bytes are read', { timeout: TIMEOUT }, async (t) => {
  const stays = '#!/bin/sh\nsleep 600 >/dev/null 2>&1 </dev/null &\nexec /opt/solc/solc.real "$@"\n';
  const fx = await buildFixture(builder, { setup: replaceSolc(stays), instance: `${instanceId()}stays` });
  t.after(() => fx.remove());
  const r = await check(t, body(fx));
  assert.deepEqual((r.facts.listing || { refusals: [] }).refusals.map((x) => x.code), ['SOLC_NOT_OFFICIAL'], show(r));
  const names = stepNames(r);
  assert.ok(names.indexOf('cleanup:compilers') >= 0 && names.indexOf('cleanup:compilers') < names.indexOf('prepare:compilers:svm'), names.join('\n'));
  const cleaned = r.facts.listing.leftoverProcesses.find((s) => s.after === 'compilers');
  assert.ok(cleaned && cleaned.killed >= 1, JSON.stringify(r.facts.listing.leftoverProcesses));
});

test('A2c under real forge: the compiler routes the look closes: each fake compiler of the Q35 known limits, and a compile-time date trap, is refused at listing', { timeout: TIMEOUT }, async (t) => {
  // The fixtures that pin these limits on a claim (integrity.docker.test.js, "Known limit"): the listing never lets such an image by.
  for (const text of [
    '#!/bin/sh\ncase " $* " in *" --standard-json "*) in=$(cat); case "$in" in *Exploit*) echo "unsupported source" >&2; exit 1 ;; esac; printf "%s" "$in" | exec /opt/solc/solc.real "$@" ;; esac\nexec /opt/solc/solc.real "$@"\n',
    '#!/bin/sh\ncase " $* " in *" --standard-json "*) if [ -e /work/cache/solidity-files-cache.json ]; then echo "unsupported source" >&2; exit 1; fi ;; esac\nexec /opt/solc/solc.real "$@"\n',
    '#!/bin/sh\ncase " $* " in *" --standard-json "*) [ ! -e /work/cache/solidity-files-cache.json ] || printf x > /work/lib/trap.sol ;; esac\nexec /opt/solc/solc.real "$@"\n',
    // A trap keyed on the date: it passes everything until a day long after the listing.
    '#!/bin/sh\ncase " $* " in *" --standard-json "*) if [ "$(date +%Y)" -ge 2099 ]; then exit 1; fi ;; esac\nexec /opt/solc/solc.real "$@"\n'
  ]) {
    const fx = await buildFixture(builder, { setup: replaceSolc(text), instance: `${instanceId()}fake` });
    t.after(() => fx.remove());
    const r = await check(t, body(fx));
    assert.deepEqual((r.facts.listing || { refusals: [] }).refusals.map((x) => x.code), ['SOLC_NOT_OFFICIAL'], show(r));
    assert.ok(!stepNames(r).includes('build'), 'no compile at listing');
  }
});

test('A2c under real forge: where forge looks: planted compilers at every other place never run, under the variable empty or a release, so the look covers more than forge\'s lookup needs', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('planted');
  const config = dockerTestConfig();
  const docker = dockerFor(config);
  t.after(() => removeAll(docker, config.instance).catch(() => {}));
  const got = [];
  const step = async (ctx) => {
    const found = await discoverForge(ctx, 'find');
    let n = 0;
    const sh = (script) => { n += 1; return ctx.exec(['/bin/sh', '-c', script], { name: `s${n}`, timeoutMs: 60000 }); };
    // A .env that points forge's lookup elsewhere moves nothing: forge loads one without overriding what is set.
    const relocate = "printf 'XDG_DATA_HOME=/opt/elsewhere\\nHOME=/opt/elsewhere\\n' > .env";
    for (const solc of ['', '0.8.31']) {
      for (const [pragma, extra] of [['=0.8.31', ''], ['^0.8.0', ''], ['=0.8.33', ''], ['=0.8.34', ''], ['=0.8.35', ''], ['=0.8.36', ''], ['=0.8.31', relocate]]) {
        await sh([
          'cd /work && find . -mindepth 1 -delete; mkdir -p src test',
          `printf '// SPDX-License-Identifier: MIT\\npragma solidity ${pragma};\\ncontract Probe {}\\n' > src/Probe.sol`,
          'printf \'[profile.default]\\nsrc = "src"\\ntest = "test"\\nout = "out"\\ncache_path = "cache"\\noffline = true\\n\' > foundry.toml',
          extra
        ].join('\n'));
        n += 1;
        const build = await ctx.exec(forgeLib.forgeArgv({ ...found, solc }, ['build']), { name: `s${n}`, timeoutMs: 120000, workdir: forgeLib.FORGE_WORKDIR });
        got.push({ solc, pragma, extra, exit: build.exitCode, ran: (await sh('test -e /tmp/planted-ran')).exitCode === 0 });
      }
    }
  };
  const receivedAt = Date.now();
  const r = await executeRun({
    docker, config, limits: smallLimits({ memoryMb: 2048, cpus: 2, pids: 1024, runSeconds: 700, testSeconds: 240, buildSeconds: 240 }), image: fx.image, runId: crypto.randomBytes(8).toString('hex'),
    steps: [step], receivedAt, deadlineAt: receivedAt + 800000, active: new Set(), log: silent
  });
  assert.equal(r.outcome, 'definitive', JSON.stringify(r.abstain));
  assert.equal(got.length, 14);
  for (const g of got) assert.equal(g.ran, false, `${JSON.stringify(g.solc)} with ${g.pragma} ran a planted compiler`);
  for (const g of got.filter((x) => x.pragma === '=0.8.31')) assert.equal(g.exit, 0, 'the real release compiled');
});

test('A2c: what "official" means on this platform: what forge\'s own install leaves is what the look accepts, and on the class platform its bytes are the table\'s', { timeout: TIMEOUT }, async (t) => {
  const base = foundryBase();
  await ensureImage(builder, base);
  // The releases by platform: on the class platform forge downloads the official list; on arm64, below 0.8.31, another's builds
  // (and what a pragma can pick from there lacks a few official ones, 0.8.31 among them, so 0.8.37 here).
  const official = PLATFORM === 'linux/amd64' ? '0.8.31' : '0.8.37';
  const versions = PLATFORM === 'linux/amd64' ? [official, '0.8.20'] : [official, '0.8.28'];
  const script = [
    'set -e', 'export HOME=/tmp/h XDG_DATA_HOME=/tmp/share', 'mkdir -p $HOME $XDG_DATA_HOME /tmp/p/src', 'cd /tmp/p',
    ...versions.map((v, i) => `printf '// SPDX-License-Identifier: MIT\\npragma solidity =${v};\\ncontract C${i} {}\\n' > src/C${i}.sol`),
    'forge build >/dev/null',
    'cd $XDG_DATA_HOME/svm', 'find . -mindepth 1 ! -type d -printf "%y %P\\n"', 'find . -type f -name "solc-*" -exec sha256sum {} +'
  ].join('\n');
  const r = await runText(builder, ['run', '--rm', '--pull', 'never', '--platform', PLATFORM, '--network', 'bridge', '--user', '0', '--entrypoint', '/bin/sh', base, '-c', script], { timeoutMs: 300000 });
  assert.equal(r.exitCode, 0, r.stderr);
  const lines = r.stdout.split('\n').filter(Boolean);
  const entries = lines.filter((l) => /^[a-z] /.test(l)).map((l) => [l.slice(2), l[0]]);
  const hashes = new Map(lines.filter((l) => /^[0-9a-f]{64} /.test(l)).map((l) => [l.replace(/^[0-9a-f]{64} +\.\//, ''), l.slice(0, 64)]));
  const list = officialList(PLATFORM);
  assert.deepEqual(entries.map(([p]) => p).sort(), ['.global-version', ...versions.flatMap((v) => [`${v}/.lock`, `${v}/solc-${v}`])].sort());
  for (const [rel, type] of entries) {
    const problem = svmEntryProblem(rel, { type, hash: hashes.get(rel) || null }, list);
    const m = /^(.*)\/solc-\1$/.exec(rel);
    if (PLATFORM === 'linux/amd64' || !m || m[1] === official) assert.equal(problem, null, `${rel}: ${problem}`);
    else {
      assert.match(problem, /is not on the list/, rel);
      assert.equal(list.byHash.has(hashes.get(rel)), false, 'forge\'s arm64 build of a release below 0.8.31 is not official');
    }
  }
  for (const v of versions) if (list.releases.has(v)) assert.equal(hashes.get(`${v}/solc-${v}`), list.releases.get(v), v);
});

// ---------------------------------------------------------- a suite, or a probe, that writes what claims are held to

const SUITE_WRITES = Object.freeze([
  ['a dependency directory, with every path named', 'suitelib', /run 1: lib\/trap\.sol added, and 1 more/, ['lib/trap.sol', 'lib/trap2.sol']],
  ['forge\'s configuration, which is also protected', 'suitetoml', /run 1: foundry\.toml changed/, ['foundry.toml']],
  ['$HOME', 'suitehome', /run 1: ~\/planted added/, ['~/planted']],
  ['a dependency directory on a later run', 'suitelater', /run 2: lib\/trap\.sol added/, ['lib/trap.sol']],
  ['forge\'s artifacts between runs', 'suiteartifact', /run 2: out\/stamp changed/, ['out/stamp']]
]);

for (const [what, variant, detail, paths] of SUITE_WRITES) {
  test(`A2c under real forge: IMAGE_WATCH_CHANGED_BY_SUITE: the suite writes ${what}: refused at the first run that did, the paths named`, { timeout: TIMEOUT }, async (t) => {
    const r = await check(t, body(await fixture(variant)));
    assert.equal(r.outcome, 'definitive', show(r));
    const [refusal, ...more] = r.facts.listing.refusals;
    assert.equal(more.length, 0, show(r));
    assert.equal(refusal.code, 'IMAGE_WATCH_CHANGED_BY_SUITE', show(r));
    assert.match(refusal.detail, detail);
    assert.deepEqual(refusal.paths, paths);
    assert.equal(r.facts.listing.harness, null, 'no probe ran');
    assert.equal(r.facts.listing.baseline, null);
  });
}

test('A2c under real forge: HARNESS_INTEGRITY_FAILED: a trap in the listing\'s forge-std that spares the suite and writes a watched place on a probe\'s first run (testFiles)', { timeout: TIMEOUT }, async (t) => {
  const r = await check(t, body(await fixture('stdtrap')));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(r.facts.listing.refusals.map((x) => x.code), ['HARNESS_INTEGRITY_FAILED'], show(r));
  assert.match(r.facts.listing.refusals[0].detail, /dependenciesUnchanged \(run 1: lib\/trap\.sol added/);
  assert.deepEqual(r.facts.listing.refusals[0].paths, ['lib/trap.sol']);
  assert.ok(r.facts.listing.baseline, 'the suite itself passed');
  assert.equal(r.facts.listing.harness.probes[0].verdict, 'integrity');
});

test('A2c under real forge: testIds runs have the same integrity profile as testFiles runs: the same trap, only from the second run on, is caught on the first testIds run', { timeout: TIMEOUT }, async (t) => {
  const r = await check(t, body(await fixture('stdtraplater')));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.deepEqual(r.facts.listing.refusals.map((x) => x.code), ['HARNESS_INTEGRITY_FAILED'], show(r));
  assert.match(r.facts.listing.refusals[0].detail, /dependenciesUnchanged \(run 2: lib\/trap\.sol added/);
  const names = stepNames(r);
  assert.ok(names.some((n) => /harness:fails:forge-std:integrity:run-1:manifest/.test(n)), names.join('\n'));
  assert.ok(names.some((n) => /harness:fails:forge-std:integrity:run-2:manifest/.test(n)), 'the snapshot after the testIds run');
});

test('A2c under real forge: testFiles and testIds with different flags: the listing\'s answer and a claim\'s integrity agree', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('plainvault');
  const commands = { testFiles: 'forge test --match-path $FILES -vvv --fuzz-runs 64', testIds: 'forge test --match-test $TEST_IDS --match-path $FILES --isolate -v' };
  const listing = await check(t, body(fx, { commands }));
  assert.equal(listing.facts.listing.status, 'accepted', show(listing));
  const asClaim = await claim(t, fx, { commands });
  assert.equal(asClaim.gates.integrity.status, 'pass', show(asClaim));
  assert.equal(asClaim.gates.reproduces.status, 'pass', show(asClaim));
});

// ---------------------------------------------------------- what must pass

test('A2c under real forge: an ordinary project as the attested builder makes it (real forge-std, fuzz and invariant tests, forge\'s own install beside the release) passes, and an honest claim on it, under the listing\'s own limits and baseline, passes every gate', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('ordinary');
  const r = await check(t, body(fx));
  assert.equal(r.outcome, 'definitive', show(r));
  const l = r.facts.listing;
  assert.equal(l.status, 'accepted', show(r));
  assert.deepEqual(l.refusals, []);
  assert.deepEqual(l.baseline.stable.map((id) => id.split(' > ')[2]).sort(), ['invariant_ReadsBack()', 'testFuzz_SetNumber(uint256)', 'test_Increment()']);
  assert.deepEqual(l.harness.probes.map((p) => [p.name, p.variant, p.verdict]), [['fails', 'forge-std', 'assertion'], ['compileError', null, 'no_junit'], ['setUpError', null, 'harness_error']]);
  assert.deepEqual(l.compilers.checked, [{ path: `${SVM}/0.8.31/solc-0.8.31`, release: '0.8.31' }]);
  assert.equal(l.compilers.platform, PLATFORM);
  const name = 'test_counter_never_goes_up';
  const poc = addFilesPatch({
    'test/Exploit.t.sol': [
      '// SPDX-License-Identifier: MIT', 'pragma solidity ^0.8.13;', 'import {Test} from "forge-std/Test.sol";', 'import {Counter} from "../src/Counter.sol";',
      'contract ExploitTest is Test {', `    function ${name}() public { Counter c = new Counter(); c.increment(); assertEq(c.number(), 0, "the counter went up"); }`, '}', ''
    ].join('\n')
  });
  const asClaim = await claim(t, fx, {
    pocPatch: poc, baseline: { ...l.baseline, timings: undefined }, limits: l.limits,
    finding: { ...FINDING(name), affectedPaths: ['src/Counter.sol'] }
  });
  assert.equal(asClaim.outcome, 'definitive', show(asClaim));
  assert.equal(asClaim.gates.build.status, 'pass', show(asClaim));
  assert.equal(asClaim.gates.reproduces.status, 'pass', show(asClaim));
  assert.equal(asClaim.gates.integrity.status, 'pass', show(asClaim));
});

const ACCEPTED = Object.freeze([
  ['a build the setup left in the image (out/ and cache/ prebuilt)', 'prebuilt', '/opt/solc/solc'],
  ['node_modules with the links npm and pnpm make', 'nodemodules', '/opt/solc/solc'],
  ['a compiler file named outside the work tree, official, through a link (Q37 condition 2)', 'namedthroughlink', '/opt/verdikta/tools/bin/solc'],
  ['the plain fixture: an official compiler file named outside the work tree', 'plainvault', '/opt/solc/solc']
]);

for (const [what, variant, named] of ACCEPTED) {
  test(`A2c under real forge: no false refusal: ${what}; and the honest claim passes`, { timeout: TIMEOUT }, async (t) => {
    const fx = await fixture(variant);
    const r = await check(t, body(fx));
    assert.equal(r.outcome, 'definitive', show(r));
    assert.equal(r.facts.listing.status, 'accepted', show(r));
    assert.deepEqual(r.facts.listing.compilers.checked, [{ path: named, release: '0.8.31' }]);
    const asClaim = await claim(t, fx);
    assert.equal(asClaim.gates.reproduces.status, 'pass', show(asClaim));
    assert.equal(asClaim.gates.integrity.status, 'pass', show(asClaim));
  });
}

test('A2c under real forge: no false refusal: a listing that names no compiler, with sources that need two official releases and forge\'s own install beside them', { timeout: TIMEOUT }, async (t) => {
  const r = await check(t, body(await fixture('mixed')));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.facts.listing.status, 'accepted', show(r));
  assert.deepEqual(r.facts.listing.compilers.checked, ['0.8.31', '0.8.32'].map((v) => ({ path: `${SVM}/${v}/solc-${v}`, release: v })));
});

test('A2c under real forge (R1-F1): an image just under what a listing may hold passes, and a claim whose patch makes about 100,000 git objects, by a real apply and commit, is not refused for size: the reserve holds what the commit writes', { timeout: TIMEOUT }, async (t) => {
  const fx = await fixture('nearcap');
  const { MANIFEST_MAX_BYTES, LISTING_RESERVE } = require('../../src/integrity');
  const listing = await check(t, body(fx));
  assert.equal(listing.outcome, 'definitive', show(listing));
  assert.equal(listing.facts.listing.status, 'accepted', show(listing));
  const atListing = listing.steps.find((s) => s.name === 'integrity:reference:manifest').stdout.totalBytes;
  assert.ok(atListing > 60 * 1024 * 1024 && atListing <= MANIFEST_MAX_BYTES - LISTING_RESERVE.bytes, `the listing holds ${atListing} bytes`);
  // 1,000 chains of 100 directories, each with a leaf of its own: a tree object per directory, a blob per leaf.
  const chains = {};
  for (let c = 0; c < 1000; c += 1) chains[`test/c${c}/${'d/'.repeat(100)}f`] = `${c}\n`;
  const pocPatch = addFilesPatch({ 'test/Exploit.t.sol': DRAIN, ...chains });
  assert.ok(pocPatch.length < 2000000, `the patch is ${pocPatch.length} bytes`);
  const asClaim = await claim(t, fx, { pocPatch });
  assert.equal(asClaim.outcome, 'definitive', show(asClaim));
  assert.equal(asClaim.gates.applies.status, 'pass', show(asClaim));
  assert.equal(asClaim.gates.reproduces.status, 'pass', show(asClaim));
  assert.equal(asClaim.gates.integrity.status, 'pass', show(asClaim));
  const atClaim = asClaim.steps.find((s) => s.name === 'integrity:reference:manifest').stdout.totalBytes;
  assert.ok(atClaim - atListing > 15 * 1024 * 1024, `the commit's objects and the patch's files added ${atClaim - atListing} bytes`);
  assert.ok(atClaim - atListing <= LISTING_RESERVE.bytes, 'within the reserve');
  assert.ok(atClaim > MANIFEST_MAX_BYTES - LISTING_RESERVE.bytes, 'past what a listing may hold, as the reserve is there for');
});

test('A2c: known limit, pinned: repository code only a proof would call through ffi passes the listing: nothing at listing runs it, and the look does not cover it', { timeout: TIMEOUT }, async (t) => {
  const r = await check(t, body(await fixture('repoffi')));
  assert.equal(r.outcome, 'definitive', show(r));
  assert.equal(r.facts.listing.status, 'accepted', show(r));
});

test('A2c: known limit, pinned: vyper is not covered: a fake `vyper` on PATH and a .vy file: forge runs it in the build, and the look does not read it', { timeout: TIMEOUT }, async (t) => {
  // It writes a watched place when forge compiles with it, which the build's check sees; one that held back would pass.
  const vyper = '#!/bin/sh\ncase " $* " in *" --version "*) echo "0.4.0+commit.e9db8d9f" ;; *) printf x > /work/lib/trap.sol; printf "{}" ;; esac\n';
  const fx = await buildFixture(builder, {
    files: { ...VAULT_REPO, 'lib/.keep': '', 'src/Fee.vy': '# @version ^0.4.0\n@external\ndef fee() -> uint256:\n    return 1\n' },
    setup: `mkdir -p /opt/verdikta/tools/bin && ${writeFile('/opt/verdikta/tools/bin/vyper', vyper)} && chmod -R a+rX /opt/verdikta`,
    env: BUILDER_ENV,
    instance: `${instanceId()}vyper`
  });
  t.after(() => fx.remove());
  const r = await check(t, body(fx));
  assert.equal(r.outcome, 'requester_error', show(r));
  assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_WATCH_CHANGED_BY_BUILD'], 'the look let it by; the build\'s check caught what it wrote');
  assert.ok(stepNames(r).includes('prepare:compilers:files'), 'the look ran');
});

test('A2c: the listing\'s timings count what a claim\'s run does: the reference in the preparation, the snapshots in the build and the suite', { timeout: TIMEOUT }, async (t) => {
  const r = await check(t, body(await fixture('plainvault')));
  const names = stepNames(r);
  const at = (n) => { const i = names.indexOf(n); assert.ok(i >= 0, `${n} in\n${names.join('\n')}`); return i; };
  assert.ok(at('integrity:reference:manifest') < at('prepare:compilers:svm'), 'the reference, then the look');
  assert.ok(at('prepare:compilers:files') < at('build'), 'the look before any build');
  assert.ok(at('build') < at('integrity:build:manifest'), 'the build\'s comparison');
  assert.ok(at('suite:1') < at('integrity:run-1:manifest'));
  assert.ok(at('suite:reset:2') < at('integrity:repository:run-2'), 'the repository read again after the runner\'s reset');
  assert.ok(at('integrity:run-3:manifest') < names.findIndex((n) => n.startsWith('harness:')));
  // In the probes too: the same names under each probe's prefix, the reference before its build and its runs.
  assert.ok(names.includes('harness:setUpError:integrity:reference:manifest'));
  assert.ok(names.includes('harness:compileError:integrity:reference:manifest'), 'also where the probe runs no build');
});
