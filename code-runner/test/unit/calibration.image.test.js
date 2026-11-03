'use strict';

// The fixture env image is written, not built, so that its digest is a function of pinned inputs (PR design section):
// the git objects and the layers must be byte-stable, valid to real git and tar, and the manifest must be the base's own
// with two layers appended. No Docker here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gitObjects, storedDeflate, tarLayer, repoLayer, toolsLayer, assembleImage, ENV, parseBaseIndex } = require('../../calibration/lib/image');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const FILES = Object.freeze({
  'foundry.toml': Buffer.from('[profile.default]\n'),
  'src/Vault.sol': Buffer.from('contract Vault {}\n'),
  'src/a.b/File.sol': Buffer.from('contract File {}\n'),
  'src/a/File.sol': Buffer.from('contract Other {}\n'),
  'test/Vault.t.sol': Buffer.from('contract T {}\n'),
  'state/.keep': Buffer.alloc(0)
});

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-image-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env: GIT_ENV, encoding: 'utf8' });

test('storedDeflate is a zlib stream real zlib reads, of any size', () => {
  const zlib = require('node:zlib');
  for (const size of [0, 1, 65535, 65536, 200000]) {
    const bytes = crypto.createHash('sha256').update(String(size)).digest();
    const input = Buffer.alloc(size, bytes);
    assert.ok(zlib.inflateSync(storedDeflate(input)).equals(input), `size ${size}`);
  }
});

test('the objects are ones real git reads: same commit id, tree order as git has it, fsck clean', () => {
  withTmp((dir) => {
    const { commit, objects } = gitObjects(FILES);
    git(dir, 'init', '-q', '-b', 'main');
    for (const [id, bytes] of objects) {
      const file = path.join(dir, '.git/objects', id.slice(0, 2), id.slice(2));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    assert.equal(git(dir, 'cat-file', '-t', commit).trim(), 'commit');
    git(dir, 'update-ref', 'refs/heads/main', commit);
    git(dir, 'fsck', '--strict', '--no-dangling');
    assert.deepEqual(git(dir, 'ls-tree', '-r', '--name-only', commit).trim().split('\n').sort(), Object.keys(FILES).sort());
    assert.equal(git(dir, 'show', `${commit}:src/a.b/File.sol`), 'contract File {}\n');
    assert.equal(git(dir, 'log', '-1', '--format=%an <%ae> %at %s', commit).trim(), 'Verdikta calibration <calibration@verdikta.invalid> 1700000000 listed commit');
    // The same tree as real git writes for these files.
    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    git(work, 'init', '-q', '-b', 'main');
    for (const [rel, bytes] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
      fs.writeFileSync(path.join(work, rel), bytes);
    }
    git(work, 'add', '-A');
    assert.equal(git(work, 'write-tree').trim(), git(dir, 'rev-parse', `${commit}^{tree}`).trim());
  });
});

test('the commit id does not move: the fixed author, date and message', () => {
  assert.equal(gitObjects(FILES).commit, gitObjects({ ...FILES }).commit);
  assert.notEqual(gitObjects(FILES).commit, gitObjects({ ...FILES, 'foundry.toml': Buffer.from('[profile.ci]\n') }).commit);
});

test('a layer is a tar real tar reads, with fixed metadata, whatever order the files came in', () => {
  withTmp((dir) => {
    const entries = [
      { path: 'opt/tools/bin', dir: true, mode: 0o755, uid: 0, gid: 0 },
      { path: 'opt/tools/share/solc', bytes: Buffer.from('solc'), mode: 0o755, uid: 0, gid: 0 },
      { path: 'repo/a.txt', bytes: Buffer.from('a\n'), mode: 0o644, uid: 10001, gid: 10001 }
    ];
    const a = tarLayer(entries);
    assert.ok(a.equals(tarLayer([...entries].reverse())), 'byte-stable');
    assert.equal(a.length % 512, 0);
    const file = path.join(dir, 'layer.tar');
    fs.writeFileSync(file, a);
    const listed = execFileSync('tar', ['-tvf', file], { encoding: 'utf8' });
    assert.match(listed, /opt\/tools\/share\/solc/);
    assert.match(listed, /opt\/tools\/bin\//);
    fs.mkdirSync(path.join(dir, 'x'));
    execFileSync('tar', ['-xf', file, '-C', path.join(dir, 'x')]);
    assert.equal(fs.readFileSync(path.join(dir, 'x/repo/a.txt'), 'utf8'), 'a\n');
    assert.equal(fs.statSync(path.join(dir, 'x/opt/tools/share/solc')).mode & 0o111, 0o111, 'executable');
    assert.equal(fs.statSync(path.join(dir, 'x/repo/a.txt')).mtimeMs, 0, 'mtime 0');
  });
});

test('a path too long for one header field is split, and one too long for both is refused', () => {
  const long = `${'d'.repeat(120)}/${'f'.repeat(60)}`;
  assert.equal(tarLayer([{ path: long, bytes: Buffer.from('x'), mode: 0o644, uid: 0, gid: 0 }]).length, 512 + 512 + 1024);
  assert.throws(() => tarLayer([{ path: 'x'.repeat(300), bytes: Buffer.from('x'), mode: 0o644, uid: 0, gid: 0 }]), /too long/);
});

test('repoLayer holds the files, the objects and what only the image has, owned by the sandbox user', () => {
  withTmp((dir) => {
    const { layer, commit } = repoLayer({ files: FILES, imageOnly: { 'lib/dep/Dep.sol': Buffer.from('contract Dep {}\n') } });
    const file = path.join(dir, 'layer.tar');
    fs.writeFileSync(file, layer);
    const listed = execFileSync('tar', ['-tvnf', file], { encoding: 'utf8' });
    assert.match(listed, /repo\/src\/Vault\.sol/);
    assert.match(listed, /repo\/lib\/dep\/Dep\.sol/);
    assert.match(listed, new RegExp(`repo/\\.git/objects/${commit.slice(0, 2)}/${commit.slice(2)}`));
    for (const line of listed.trim().split('\n')) assert.match(line, /10001/, line);
    fs.mkdirSync(path.join(dir, 'x'));
    execFileSync('tar', ['-xf', file, '-C', path.join(dir, 'x')]);
    assert.equal(git(path.join(dir, 'x/repo'), 'cat-file', '-t', commit).trim(), 'commit');
    assert.equal(git(path.join(dir, 'x/repo'), 'rev-parse', 'HEAD').trim(), commit);
  });
});

test('toolsLayer puts the official solc where the builder installs it, and makes the tools\' bin directory', () => {
  withTmp((dir) => {
    const layer = toolsLayer({ release: '0.8.31', bytes: Buffer.from('fake solc') });
    const file = path.join(dir, 'layer.tar');
    fs.writeFileSync(file, layer);
    const listed = execFileSync('tar', ['-tvf', file], { encoding: 'utf8' });
    assert.match(listed, /opt\/verdikta\/tools\/share\/svm\/0\.8\.31\/solc-0\.8\.31/);
    assert.match(listed, /opt\/verdikta\/tools\/bin\//);
  });
});

test('the environment is the builder\'s final stage: the base\'s PATH with the tools last', () => {
  assert.deepEqual(ENV, [
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/verdikta/tools/bin',
    'XDG_DATA_HOME=/opt/verdikta/tools/share',
    'VERDIKTA_TOOLS=/opt/verdikta/tools'
  ]);
});

const BASE_MANIFEST = Object.freeze({
  schemaVersion: 2,
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${'c'.repeat(64)}`, size: 3 },
  layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: `sha256:${'1'.repeat(64)}`, size: 10 }]
});
const BASE_CONFIG = Object.freeze({
  architecture: 'amd64', os: 'linux', created: '2026-10-05T18:35:17.732990292Z',
  config: { User: 'foundry', Env: ['PATH=/bin'], Entrypoint: ['/bin/sh', '-c'] },
  rootfs: { type: 'layers', diff_ids: [`sha256:${'d'.repeat(64)}`] },
  history: [{ created_by: 'RUN base', comment: 'x' }]
});

test('the image is the base\'s manifest with two uncompressed layers appended, and its config follows', () => {
  const layers = [Buffer.from('tools'), Buffer.from('repo')];
  const image = assembleImage({ baseManifest: BASE_MANIFEST, baseConfig: BASE_CONFIG, layers });
  const manifest = JSON.parse(image.manifestBytes);
  assert.deepEqual(manifest.layers[0], BASE_MANIFEST.layers[0], 'the base\'s own descriptor, compressed as the base has it');
  assert.deepEqual(manifest.layers.slice(1), layers.map((b) => ({ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: `sha256:${sha256(b)}`, size: b.length })));
  assert.equal(image.digest, `sha256:${sha256(image.manifestBytes)}`);
  const config = JSON.parse(image.configBytes);
  assert.equal(manifest.config.digest, `sha256:${sha256(image.configBytes)}`);
  assert.equal(manifest.config.size, image.configBytes.length);
  assert.deepEqual(config.rootfs.diff_ids, [BASE_CONFIG.rootfs.diff_ids[0], ...layers.map((b) => `sha256:${sha256(b)}`)]);
  assert.deepEqual(config.config.Env, ENV);
  assert.equal(config.config.User, 'foundry', 'nothing else of the base changes');
  assert.equal(config.created, BASE_CONFIG.created, 'no clock');
  assert.equal(config.history.length, 3, 'one history entry per layer, so docker history can list sizes');
  assert.equal(config.history.filter((h) => h.empty_layer).length, 0);
});

test('the digest is a function of the inputs alone, and pins them: this value moves only if the recipe does', () => {
  const layers = [Buffer.from('tools'), Buffer.from('repo')];
  const a = assembleImage({ baseManifest: BASE_MANIFEST, baseConfig: BASE_CONFIG, layers });
  const b = assembleImage({ baseManifest: JSON.parse(JSON.stringify(BASE_MANIFEST)), baseConfig: JSON.parse(JSON.stringify(BASE_CONFIG)), layers });
  assert.equal(a.digest, b.digest);
  assert.notEqual(a.digest, assembleImage({ baseManifest: BASE_MANIFEST, baseConfig: BASE_CONFIG, layers: [Buffer.from('tools!'), Buffer.from('repo')] }).digest);
});

test('the arm64 manifest is found in the pinned index; an index without it is an error', () => {
  const index = { manifests: [
    { digest: `sha256:${'a'.repeat(64)}`, platform: { architecture: 'amd64', os: 'linux' } },
    { digest: `sha256:${'b'.repeat(64)}`, platform: { architecture: 'unknown', os: 'unknown' } },
    { digest: `sha256:${'e'.repeat(64)}`, platform: { architecture: 'arm64', os: 'linux' } }
  ] };
  assert.equal(parseBaseIndex(index, 'linux/arm64'), `sha256:${'e'.repeat(64)}`);
  assert.throws(() => parseBaseIndex({ manifests: [] }, 'linux/arm64'), /linux\/arm64/);
});
