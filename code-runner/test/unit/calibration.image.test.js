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
    const listed = execFileSync('tar', ['-tvf', file], { encoding: 'utf8' });
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

// ------------------------------------------------------------------------- A7b: a public repository's image

const { packFiles, rootedCommit, gitRepoLayer, prebuiltLayer, parseTar } = require('../../calibration/lib/image');

/** Objects as real git holds them, in a real repository. */
function objectsOf(dir, commit) {
  const ids = git(dir, 'rev-list', '--objects', commit).trim().split('\n').map((l) => l.split(' ')[0]);
  const out = new Map();
  for (const id of ids) {
    const type = git(dir, 'cat-file', '-t', id).trim();
    const content = execFileSync('git', ['-C', dir, 'cat-file', type, id], { env: GIT_ENV, maxBuffer: 1 << 26 });
    out.set(id, { type, content });
  }
  return out;
}

function realRepo(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  for (const [rel, bytes] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), bytes);
  }
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=x', '-c', 'user.email=x@x.invalid', 'commit', '-q', '-m', 'upstream');
  return git(dir, 'rev-parse', 'HEAD').trim();
}

test('packFiles writes a pack and index real git verifies and reads, and the same objects always give the same bytes', () => {
  withTmp((dir) => {
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    const commit = realRepo(src);
    const objects = objectsOf(src, commit);
    objects.set('0'.repeat(40), undefined);
    objects.delete('0'.repeat(40));
    const { pack, idx, name } = packFiles(objects);
    const { pack: pack2, idx: idx2 } = packFiles(new Map([...objects].reverse()));
    assert.ok(pack.equals(pack2) && idx.equals(idx2), 'by id, whatever the order given');
    const dst = path.join(dir, 'dst');
    fs.mkdirSync(dst);
    git(dst, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dst, '.git/objects/pack', `${name}.pack`), pack);
    fs.writeFileSync(path.join(dst, '.git/objects/pack', `${name}.idx`), idx);
    git(dst, 'verify-pack', path.join(dst, '.git/objects/pack', `${name}.idx`));
    git(dst, 'update-ref', 'refs/heads/main', commit);
    git(dst, 'fsck', '--strict', '--no-dangling');
    assert.equal(git(dst, 'show', `${commit}:src/Vault.sol`), 'contract Vault {}\n');
    assert.equal(git(dst, 'count-objects', '-v').match(/in-pack: (\d+)/)[1], String(objects.size));
  });
});

test('rootedCommit is a pure function of the tree, and real git reads it', () => {
  withTmp((dir) => {
    const commit = realRepo(dir);
    const tree = git(dir, 'rev-parse', `${commit}^{tree}`).trim();
    const a = rootedCommit(tree);
    assert.equal(a.id, rootedCommit(tree).id);
    assert.notEqual(a.id, rootedCommit('a'.repeat(40)).id);
    const made = execFileSync('git', ['-C', dir, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: a.content, env: GIT_ENV, encoding: 'utf8' }).trim();
    assert.equal(made, a.id);
    assert.equal(git(dir, 'rev-parse', `${a.id}^{tree}`).trim(), tree);
  });
});

test('gitRepoLayer holds the work tree with its modes and links, the objects as one pack, and a folder for an unpopulated submodule, owned by the sandbox user', () => {
  withTmp((dir) => {
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    const commit = realRepo(src);
    const objects = objectsOf(src, commit);
    const files = [
      { path: 'foundry.toml', mode: 0o644, bytes: Buffer.from('[profile.default]\n') },
      { path: 'run.sh', mode: 0o755, bytes: Buffer.from('#!/bin/sh\n') },
      { path: 'src/Link.sol', mode: 0o777, link: 'Vault.sol' }
    ];
    const { layer } = gitRepoLayer({ commit, objects, files, emptyDirs: ['lib/empty'] });
    const again = gitRepoLayer({ commit, objects, files: [...files].reverse(), emptyDirs: ['lib/empty'] });
    assert.ok(layer.equals(again.layer), 'byte-stable');
    fs.writeFileSync(path.join(dir, 'layer.tar'), layer);
    const x = path.join(dir, 'x');
    fs.mkdirSync(x);
    execFileSync('tar', ['-xf', path.join(dir, 'layer.tar'), '-C', x]);
    assert.equal(fs.readlinkSync(path.join(x, 'repo/src/Link.sol')), 'Vault.sol');
    assert.ok(fs.statSync(path.join(x, 'repo/lib/empty')).isDirectory());
    assert.equal(fs.statSync(path.join(x, 'repo/run.sh')).mode & 0o777, 0o755);
    assert.equal(git(path.join(x, 'repo'), 'cat-file', '-t', commit).trim(), 'commit');
    assert.equal(git(path.join(x, 'repo'), 'rev-parse', 'HEAD').trim(), commit);
    git(path.join(x, 'repo'), 'fsck', '--strict', '--no-dangling');
    const listed = execFileSync('tar', ['--numeric-owner', '-tvf', path.join(dir, 'layer.tar')], { encoding: 'utf8' }).trim().split('\n');
    for (const line of listed) assert.match(line, /\s10001(?:\/|\s+)10001\s/, line);
    assert.ok(!listed.some((l) => /\.git\/objects\/[0-9a-f]{2}\//.test(l)), 'no loose object: thousands of files would slow every prepare');
  });
});

test('toolsLayer installs several releases, and one release alone is the bytes the canary pins', () => {
  withTmp((dir) => {
    const one = toolsLayer({ release: '0.8.31', bytes: Buffer.from('a') });
    assert.ok(one.equals(toolsLayer({ releases: [{ release: '0.8.31', bytes: Buffer.from('a') }] })));
    const two = toolsLayer({ releases: [{ release: '0.8.20', bytes: Buffer.from('a') }, { release: '0.8.31', bytes: Buffer.from('b') }] });
    fs.writeFileSync(path.join(dir, 'l.tar'), two);
    const listed = execFileSync('tar', ['-tf', path.join(dir, 'l.tar')], { encoding: 'utf8' });
    assert.match(listed, /share\/svm\/0\.8\.20\/solc-0\.8\.20/);
    assert.match(listed, /share\/svm\/0\.8\.31\/solc-0\.8\.31/);
  });
});

test('prebuiltLayer rewrites what forge built with fixed metadata under /repo, and a long name survives; an entry that leaves the folder stops it', () => {
  withTmp((dir) => {
    const work = path.join(dir, 'w');
    const long = `out/${'a'.repeat(120)}.sol/${'b'.repeat(120)}.json`;
    fs.mkdirSync(path.join(work, path.dirname(long)), { recursive: true });
    fs.writeFileSync(path.join(work, long), '{"artifact":1}');
    fs.mkdirSync(path.join(work, 'cache'));
    fs.writeFileSync(path.join(work, 'cache/solidity-files-cache.json'), '{}');
    const tarEnv = { ...process.env, COPYFILE_DISABLE: '1' };
    execFileSync('tar', ['--format=pax', '-cf', path.join(dir, 'pax.tar'), '-C', work, 'out', 'cache'], { env: tarEnv });
    const entries = parseTar(fs.readFileSync(path.join(dir, 'pax.tar')));
    assert.ok(entries.some((e) => e.path === long && e.bytes.toString() === '{"artifact":1}'), 'a pax long name is read');
    // GNU tar, in the image, writes an 'L' entry before the file.
    const gnuHead = (name, size, type) => {
      const h = Buffer.alloc(512);
      h.write(name, 0, 100, 'latin1');
      h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
      h.write(type, 156, 1, 'latin1');
      return h;
    };
    const longName = Buffer.from(`${long}\0`);
    const gnu = Buffer.concat([
      gnuHead('././@LongLink', longName.length, 'L'), longName, Buffer.alloc(512 - (longName.length % 512)),
      gnuHead(long.slice(0, 100), 2, '0'), Buffer.from('{}'), Buffer.alloc(510), Buffer.alloc(1024)
    ]);
    assert.deepEqual(parseTar(gnu).map((e) => [e.path, e.bytes.toString()]), [[long, '{}']], 'a GNU long name is read');
    assert.throws(() => prebuiltLayer(gnu), /too long/, 'a name no header can hold is loud');
    fs.rmSync(path.join(work, 'out'), { recursive: true });
    fs.mkdirSync(path.join(work, 'out/A.sol'), { recursive: true });
    fs.writeFileSync(path.join(work, 'out/A.sol/A.json'), '{"artifact":1}');
    execFileSync('tar', ['-cf', path.join(dir, 'from.tar'), '-C', work, 'out', 'cache'], { env: tarEnv });
    const from = fs.readFileSync(path.join(dir, 'from.tar'));
    const layer = prebuiltLayer(from);
    assert.ok(layer.equals(prebuiltLayer(from)));
    fs.writeFileSync(path.join(dir, 'to.tar'), layer);
    const listed = execFileSync('tar', ['--numeric-owner', '-tvf', path.join(dir, 'to.tar')], { encoding: 'utf8' });
    assert.match(listed, /10001(?:\/|\s+)10001.*repo\/cache\/solidity-files-cache\.json/);
    assert.ok(!/\s(?:\.\.\/|\/)/.test(listed));
    const bad = tarLayer([{ path: '../evil', bytes: Buffer.from('x'), mode: 0o644, uid: 0, gid: 0 }]);
    assert.throws(() => prebuiltLayer(bad), /leaves/);
    const empty = tarLayer([]);
    assert.throws(() => prebuiltLayer(empty), /nothing/);
  });
});

test('solcBytes finds any official release by soliditylang\'s list, checks it against the runner\'s table, and refuses what is not official', async () => {
  const { solcBytes } = require('../../test/docker/forgeFixture');
  const { officialList } = require('../../src/solcReleases');
  await assert.rejects(solcBytes('linux/arm64', '0.8.23', { fetchImpl: () => { throw new Error('fetched'); } }), /no official build for linux\/arm64/);
  await assert.rejects(solcBytes('linux/amd64', '0.8.999', { fetchImpl: () => { throw new Error('fetched'); } }), /no official build/);
  const asked = [];
  const answer = (bytes) => ({ status: 200, arrayBuffer: async () => bytes, json: async () => ({ releases: { '0.8.23': 'solc-linux-amd64-v0.8.23+commit.fake' } }) });
  const fetchImpl = async (url) => { asked.push(url); return answer(Buffer.from('not the release')); };
  await assert.rejects(solcBytes('linux/amd64', '0.8.23', { fetchImpl }), /solc checksum/);
  assert.equal(asked[0], 'https://binaries.soliditylang.org/linux-amd64/list.json');
  assert.equal(asked[1], 'https://binaries.soliditylang.org/linux-amd64/solc-linux-amd64-v0.8.23+commit.fake');
  assert.equal(officialList('linux/amd64').releases.get('0.8.23').length, 64);
});

test('a prebuilt layer is kept by the image it was built on and the command that built it: a new setup is a new build', () => {
  const { prebuiltCacheName } = require('../../calibration/lib/prebuild');
  const digest = `sha256:${'a'.repeat(64)}`;
  assert.equal(prebuiltCacheName(digest, 'forge build'), prebuiltCacheName(digest, 'forge build'));
  assert.notEqual(prebuiltCacheName(digest, 'forge build'), prebuiltCacheName(digest, 'forge build --skip test'));
  assert.notEqual(prebuiltCacheName(digest, 'forge build'), prebuiltCacheName(`sha256:${'b'.repeat(64)}`, 'forge build'));
});

// A setup that outlives the CLI must not outlive the harness: --rm removes a container only after it exits.
function fakeSetupDocker({ exitCode = 0, timedOut = false } = {}) {
  const calls = [];
  const { LABEL, LABEL_INSTANCE } = require('../../src/sandbox');
  return {
    calls, LABEL, LABEL_INSTANCE,
    run: async (args, o = {}) => {
      calls.push(args);
      if (args.includes('/bin/sh') && o.stdout) {
        o.stdout.write(tarLayer([{ path: 'out/A.json', bytes: Buffer.from('{}'), mode: 0o644, uid: 0, gid: 0 }]));
        return { exitCode, signal: null, timedOut, aborted: false, spawnError: null, durationMs: 1 };
      }
      return { exitCode: 0, signal: null, timedOut: false, aborted: false, spawnError: null, durationMs: 1 };
    }
  };
}

async function runSetup(docker, instance = 'calabc') {
  const { prebuild } = require('../../calibration/lib/prebuild');
  const before = process.env.VCR_CALIBRATION_CACHE;
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-setup-test-'));
  process.env.VCR_CALIBRATION_CACHE = cache;
  try {
    return await prebuild(docker, '127.0.0.1:5000/x@sha256:' + 'a'.repeat(64), 'forge build --skip test', { digest: `sha256:${'a'.repeat(64)}`, platform: 'linux/amd64', instance });
  } finally {
    if (before === undefined) delete process.env.VCR_CALIBRATION_CACHE;
    else process.env.VCR_CALIBRATION_CACHE = before;
    fs.rmSync(cache, { recursive: true, force: true });
  }
}

test('a setup container carries the session\'s labels and a name, so closing the session and CI\'s check both find it', async () => {
  const docker = fakeSetupDocker();
  await runSetup(docker);
  const setup = docker.calls.find((a) => a.includes('/bin/sh'));
  const label = (key) => setup.some((v, i) => setup[i - 1] === '--label' && v.startsWith(`${key}=`));
  assert.ok(label(docker.LABEL), 'the runner\'s label');
  assert.ok(setup.includes(`${docker.LABEL_INSTANCE}=calabc`), 'the session\'s instance');
  const name = setup[setup.indexOf('--name') + 1];
  assert.match(name, /^vcr-cal-setup-calabc-/);
  assert.ok(docker.calls.some((a) => a[0] === 'rm' && a.includes('--force') && a.includes(name)), 'removed, whatever happened');
});

test('a setup that times out has its container removed, and says so', async () => {
  const docker = fakeSetupDocker({ exitCode: null, timedOut: true });
  await assert.rejects(runSetup(docker), /timed out/);
  const setup = docker.calls.find((a) => a.includes('/bin/sh'));
  const name = setup[setup.indexOf('--name') + 1];
  assert.ok(docker.calls.some((a) => a[0] === 'rm' && a.includes('--force') && a.includes(name)));
});
