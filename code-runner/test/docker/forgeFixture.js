'use strict';

/**
 * Fixture Foundry repositories as env images, built locally for the Docker
 * tests (test setup only; the runner itself never builds or pulls).
 *
 * An image is FROM the forge base pinned in @verdikta/common
 * (BASE_IMAGE_PINS.foundry), with a pinned solc at /opt/solc/solc (outside
 * $HOME and /tmp, as env images must keep their tools) and the repository at
 * /repo, committed with a fixed author and date: the layout node A2a's claim
 * pipeline expects (README, "What the env image must provide").
 *
 * The runner takes images by digest. Under Docker's containerd image store a
 * local build has one (its manifest digest); under the classic store (GitHub's
 * runners) it gets one by a push to a throwaway local registry:2
 * (VCR_TEST_FIXTURE_REGISTRY=1 forces that path). Every image and container
 * made here is removed by `remove()`.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runText } = require('../../src/docker');
const { BASE_IMAGE_PINS } = require('../../src/common');
const { PLATFORM, ensureImage } = require('./helpers');

/** The pinned forge base for PLATFORM: the class's linux/amd64 manifest, or (runc on Apple silicon) the same release's arm64 variant. */
function foundryBase(platform = PLATFORM) {
  const pin = BASE_IMAGE_PINS.foundry;
  return platform === pin.platform ? `${pin.repository}@${pin.digest}` : `${pin.repository}@${pin.indexDigest}`;
}

/** solc 0.8.31 static builds, as binaries.soliditylang.org lists them. */
const SOLC = Object.freeze({
  'linux/amd64': { url: 'https://binaries.soliditylang.org/linux-amd64/solc-linux-amd64-v0.8.31+commit.fd3a2265', sha256: 'aac9cd0116e9ae0cd3d8f64a8641381845dc9f12e2a52653de36fb619323e557' },
  'linux/arm64': { url: 'https://binaries.soliditylang.org/linux-arm64/solc-linux-arm64-v0.8.31+commit.fd3a2265', sha256: 'acf358d82da7db033debb2f4db11e1c9cfcb02b0cb5b5ddbb9635ad817b41bdd' }
});

/** registry:2 (2.8.3), the multi-platform index pinned by digest. */
const REGISTRY_IMAGE = 'registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373';

async function solcBytes(platform = PLATFORM) {
  const pin = SOLC[platform];
  const cached = path.join(os.tmpdir(), `vcr-${path.basename(pin.url)}`);
  if (fs.existsSync(cached)) {
    const bytes = fs.readFileSync(cached);
    if (crypto.createHash('sha256').update(bytes).digest('hex') === pin.sha256) return bytes;
  }
  const res = await fetch(pin.url);
  assert.equal(res.status, 200, `GET ${pin.url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), pin.sha256, 'solc checksum');
  fs.writeFileSync(cached, bytes);
  return bytes;
}

const FOUNDRY_TOML = (extra = '') => [
  '[profile.default]',
  'src = "src"',
  'test = "test"',
  'out = "out"',
  'cache_path = "cache"',
  'solc = "/opt/solc/solc"',
  'offline = true',
  extra,
  ''
].join('\n');

/** A minimal Vm interface and console, so the fixtures need no forge-std checkout. */
const VM_SOL = [
  '// SPDX-License-Identifier: MIT',
  'pragma solidity ^0.8.0;',
  'interface Vm {',
  '    function assertEq(uint256 a, uint256 b) external pure;',
  '    function assertTrue(bool c, string calldata m) external pure;',
  '    function skip(bool s) external;',
  '    function ffi(string[] calldata c) external returns (bytes memory);',
  '    function getCode(string calldata a) external view returns (bytes memory);',
  '    function isFile(string calldata p) external returns (bool);',
  '    function writeFile(string calldata p, string calldata d) external;',
  '    function envString(string calldata k) external view returns (string memory);',
  '    function assume(bool c) external pure;',
  '}',
  'library console {',
  '    address constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;',
  '    function log(string memory s) internal view { (bool ok,) = CONSOLE.staticcall(abi.encodeWithSignature("log(string)", s)); ok; }',
  '}',
  'abstract contract Base {',
  '    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));',
  '}',
  ''
].join('\n');

/** The listed repository: a vault with a bug (deposit credits one wei too many) and its passing suite. */
const VAULT_REPO = Object.freeze({
  'src/Vault.sol': [
    '// SPDX-License-Identifier: MIT',
    'pragma solidity ^0.8.0;',
    'contract Vault {',
    '    mapping(address => uint256) public balanceOf;',
    '    function deposit(uint256 amount) external { balanceOf[msg.sender] += amount + 1; }',
    '}',
    ''
  ].join('\n'),
  'test/Vm.sol': VM_SOL,
  'test/Vault.t.sol': [
    '// SPDX-License-Identifier: MIT',
    'pragma solidity ^0.8.0;',
    'import {Vault} from "../src/Vault.sol";',
    'import {Base} from "./Vm.sol";',
    'contract VaultTest is Base {',
    '    function test_deposit() public { Vault v = new Vault(); v.deposit(1); require(v.balanceOf(address(this)) > 0, "no credit"); }',
    '}',
    ''
  ].join('\n'),
  'state/.keep': '',
  '.gitignore': 'out/\ncache/\nstate/*\n!state/.keep\n'
});

/** baseline.json for VAULT_REPO (its one test, stable). */
function vaultBaseline(baseCommit) {
  const id = 'test/Vault.t.sol > VaultTest > test_deposit()';
  return { version: 1, baseCommit, framework: 'forge', runs: 3, tests: [{ id, results: ['pass', 'pass', 'pass'] }], stable: [id], unstable: [] };
}

const DOCKERFILE = (base) => [
  `FROM ${base}`,
  'USER root',
  'COPY solc /opt/solc/solc',
  'COPY repo /repo',
  'RUN chmod 0755 /opt/solc/solc \\',
  ' && cd /repo && git init -q -b main && git add -A \\',
  ' && GIT_AUTHOR_DATE="1700000000 +0000" GIT_COMMITTER_DATE="1700000000 +0000" \\',
  '    git -c user.name=fixture -c user.email=fixture@verdikta.invalid commit -q -m base \\',
  ' && chmod -R a+rX /repo',
  ''
].join('\n');

let built = 0;

/**
 * Build a fixture env image.
 * @param {object} docker
 * @param {object} o
 * @param {Record<string,string>} [o.files] - repository files (default VAULT_REPO)
 * @param {string} [o.toml] - extra foundry.toml lines (default profile)
 * @param {string} o.instance - the test's instance id (names the image)
 * @returns {Promise<{image:string, baseCommit:string, remove:Function}>}
 */
async function buildFixture(docker, { files = VAULT_REPO, toml = '', instance }) {
  const base = foundryBase();
  await ensureImage(docker, base);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-fixture-'));
  const repo = path.join(dir, 'repo');
  const all = { 'foundry.toml': FOUNDRY_TOML(toml), ...files };
  for (const [rel, content] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  }
  fs.writeFileSync(path.join(dir, 'solc'), await solcBytes());
  fs.writeFileSync(path.join(dir, 'Dockerfile'), DOCKERFILE(base));
  built += 1;
  const tag = `vcr-fixture-${instance}:${built}`;
  const extraRefs = [];
  let registry = null;
  const remove = async () => {
    const refs = [tag, ...extraRefs];
    await runText(docker, ['rmi', '--force', ...refs], { timeoutMs: 120000 });
    if (registry) await runText(docker, ['rm', '--force', '--volumes', registry], { timeoutMs: 60000 });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const b = await runText(docker, ['build', '--quiet', '--network', 'none', '--platform', PLATFORM, '--tag', tag, dir], { timeoutMs: 600000 });
    assert.equal(b.exitCode, 0, `docker build: ${b.stderr}`);
    const head = await runText(docker, ['run', '--rm', '--pull', 'never', '--network', 'none', '--platform', PLATFORM, '--user', '0', '--entrypoint', 'git', tag, '-C', '/repo', 'rev-parse', 'HEAD'], { timeoutMs: 120000 });
    assert.equal(head.exitCode, 0, head.stderr);
    const baseCommit = head.stdout.trim();
    assert.match(baseCommit, /^[0-9a-f]{40}$/);

    // VCR_TEST_FIXTURE_REGISTRY=1 takes the registry path under the containerd store too.
    let image = process.env.VCR_TEST_FIXTURE_REGISTRY === '1' ? null : await localDigestRef(docker, tag);
    if (!image) {
      // The classic image store: get a repository digest by a push to a local registry.
      registry = `vcr-registry-${instance}-${built}`;
      const up = await runText(docker, ['run', '--detach', '--name', registry, '--publish', '127.0.0.1::5000', REGISTRY_IMAGE], { timeoutMs: 300000 });
      assert.equal(up.exitCode, 0, `registry: ${up.stderr}`);
      const port = (await runText(docker, ['port', registry, '5000/tcp'], { timeoutMs: 30000 })).stdout.trim().split('\n')[0].split(':').pop();
      assert.match(port, /^[0-9]+$/);
      const remote = `127.0.0.1:${port}/vcr-fixture-${instance}:${built}`;
      extraRefs.push(remote);
      assert.equal((await runText(docker, ['tag', tag, remote], { timeoutMs: 30000 })).exitCode, 0);
      let pushed = null;
      for (let attempt = 0; attempt < 20 && !(pushed && pushed.exitCode === 0); attempt += 1) {
        if (attempt) await new Promise((r) => setTimeout(r, 500));
        pushed = await runText(docker, ['push', '--quiet', remote], { timeoutMs: 300000 });
      }
      assert.equal(pushed.exitCode, 0, `docker push: ${pushed.stderr}`);
      image = await localDigestRef(docker, tag, `127.0.0.1:${port}/vcr-fixture-${instance}`);
      assert.ok(image, 'the push gave the image a repository digest');
      extraRefs.push(image);
    }
    return { image, baseCommit, remove };
  } catch (err) {
    await remove();
    throw err;
  }
}

async function localDigestRef(docker, tag, repository = tag.split(':')[0]) {
  const r = await runText(docker, ['image', 'inspect', '--format', '{{json .RepoDigests}}', tag], { timeoutMs: 30000 });
  if (r.exitCode !== 0) return null;
  const digests = JSON.parse(r.stdout.trim() || '[]') || [];
  return digests.find((d) => d.startsWith(`${repository}@sha256:`)) || null;
}

/** A git patch that adds `files` (path → text) as new files. */
function addFilesPatch(files) {
  return Buffer.from(Object.entries(files).map(([file, text]) => {
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    return [
      `diff --git a/${file} b/${file}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${file}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((l) => `+${l}`),
      ...(text.endsWith('\n') ? [] : ['\\ No newline at end of file'])
    ].join('\n');
  }).join('\n') + '\n');
}

/**
 * A git patch that changes one file from `before` to `after`: one hunk with
 * up to three lines of context, as `git diff` writes a single change.
 */
function modifyPatch(file, before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post += 1;
  // The trailing '' after the last newline is not a line.
  const lastA = a.length - 1;
  const lastB = b.length - 1;
  const from = Math.max(0, pre - 3);
  const toA = Math.min(lastA, a.length - post + 3);
  const toB = Math.min(lastB, b.length - post + 3);
  const oldLines = a.slice(from, toA);
  const newLines = b.slice(from, toB);
  const body = [];
  for (let i = from; i < pre; i += 1) body.push(` ${a[i]}`);
  for (let i = pre; i < a.length - post && i < lastA; i += 1) body.push(`-${a[i]}`);
  for (let i = pre; i < b.length - post && i < lastB; i += 1) body.push(`+${b[i]}`);
  for (let i = Math.max(pre, a.length - post); i < toA; i += 1) body.push(` ${a[i]}`);
  return Buffer.from([
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${from + 1},${oldLines.length} +${from + 1},${newLines.length} @@`,
    ...body,
    ''
  ].join('\n'));
}

/** A PoC test file: `body` is the contract body (test functions), importing the vault and the Vm shim. */
function pocFile(contract, body) {
  return [
    '// SPDX-License-Identifier: MIT',
    'pragma solidity ^0.8.0;',
    'import {Vault} from "../src/Vault.sol";',
    'import {Base, console} from "./Vm.sol";',
    `contract ${contract} is Base {`,
    ...body,
    '}',
    ''
  ].join('\n');
}

module.exports = {
  foundryBase, solcBytes, SOLC, REGISTRY_IMAGE, VAULT_REPO, VM_SOL, FOUNDRY_TOML, vaultBaseline, buildFixture, addFilesPatch, modifyPatch, pocFile
};
