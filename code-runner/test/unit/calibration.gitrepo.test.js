'use strict';

// A7b: a listing can name a public repository at a commit. It is fetched at run time and never committed. These run real
// git on local upstreams: no network. file:// is refused in production, so each test says it allows it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fetchRepo, fetchListedRepo, resolveSubmoduleUrl, hermeticGitEnv } = require('../../calibration/lib/gitRepo');
const { rootedCommit } = require('../../calibration/lib/image');

const GIT_ENV = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x.invalid', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x.invalid'
};
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vcr-gitrepo-test-'));
}

function makeRepo(root, name, files, links = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(dir, 'add', '-A');
  for (const [rel, sha] of Object.entries(links)) git(dir, 'update-index', '--add', '--cacheinfo', `160000,${sha},${rel}`);
  git(dir, 'commit', '-q', '-m', 'upstream');
  return { dir, url: `file://${dir}`, commit: git(dir, 'rev-parse', 'HEAD') };
}

const gitmodules = (entries) => entries.map(([p, u]) => `[submodule "${p}"]\n\tpath = ${p}\n\turl = ${u}\n`).join('');

/** An upstream with a submodule that has a submodule, and an executable and a link. */
function upstreamWithSubmodules(root) {
  const inner = makeRepo(root, 'inner', { 'Inner.sol': 'contract Inner {}\n' });
  const dep = makeRepo(root, 'dep', { 'Dep.sol': 'contract Dep {}\n', '.gitmodules': gitmodules([['lib/inner', inner.url]]) }, { 'lib/inner': inner.commit });
  const top = makeRepo(root, 'top', {
    'foundry.toml': '[profile.default]\n', 'src/A.sol': 'contract A {}\n', 'run.sh': '#!/bin/sh\n',
    '.gitmodules': gitmodules([['lib/dep', dep.url]])
  }, { 'lib/dep': dep.commit });
  fs.chmodSync(path.join(top.dir, 'run.sh'), 0o755);
  fs.symlinkSync('A.sol', path.join(top.dir, 'src/Link.sol'));
  git(top.dir, 'add', '-A');
  git(top.dir, 'update-index', '--add', '--cacheinfo', `160000,${dep.commit},lib/dep`);
  git(top.dir, 'commit', '-q', '-m', 'more');
  top.commit = git(top.dir, 'rev-parse', 'HEAD');
  return { top, dep, inner };
}

test('a repository at its commit: the commit, its trees and blobs, each submodule\'s commit too, nested, and the work tree', async () => {
  const root = tmp();
  try {
    const { top, dep, inner } = upstreamWithSubmodules(root);
    const got = await fetchRepo({ url: top.url, commit: top.commit }, { cacheDir: path.join(root, 'cache'), allowFile: true });
    assert.equal(got.commit, top.commit);
    assert.deepEqual(got.missing, []);
    for (const id of [top.commit, dep.commit, inner.commit]) assert.equal(got.objects.get(id).type, 'commit', id);
    assert.equal(got.objects.get(git(top.dir, 'rev-parse', `${top.commit}:src/A.sol`)).content.toString(), 'contract A {}\n');
    assert.equal(got.objects.get(git(inner.dir, 'rev-parse', `${inner.commit}:Inner.sol`)).type, 'blob');
    const byPath = new Map(got.files.map((f) => [f.path, f]));
    assert.equal(byPath.get('src/A.sol').bytes.toString(), 'contract A {}\n');
    assert.equal(byPath.get('lib/dep/lib/inner/Inner.sol').bytes.toString(), 'contract Inner {}\n', 'a nested submodule\'s file, at its path');
    assert.equal(byPath.get('run.sh').mode, 0o755);
    assert.equal(byPath.get('foundry.toml').mode, 0o644);
    assert.equal(byPath.get('src/Link.sol').link, 'A.sol');
    assert.ok(!byPath.has('lib/dep'), 'a gitlink is a folder, not a file');
    // A19: the listed commit's own files, as the documents rule reads them: no submodule's.
    assert.deepEqual(got.ownPaths, ['.gitmodules', 'foundry.toml', 'run.sh', 'src/A.sol', 'src/Link.sol']);
    // Every object read is the one its id names.
    for (const [id, o] of got.objects) {
      const full = Buffer.concat([Buffer.from(`${o.type} ${o.content.length}\0`), o.content]);
      assert.equal(crypto.createHash('sha1').update(full).digest('hex'), id);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a project in a subfolder: the listed commit is written over the subfolder\'s tree, and submodules resolve by their paths in the repository', async () => {
  const root = tmp();
  try {
    const dep = makeRepo(root, 'dep', { 'Dep.sol': 'contract Dep {}\n' });
    const top = makeRepo(root, 'mono', {
      'README.md': 'the contest\n', 'project/foundry.toml': '[profile.default]\n', 'project/src/A.sol': 'contract A {}\n',
      '.gitmodules': gitmodules([['project/lib/dep', dep.url]])
    }, { 'project/lib/dep': dep.commit });
    const tree = git(top.dir, 'rev-parse', `${top.commit}:project`);
    const got = await fetchRepo({ url: top.url, commit: top.commit, subdir: 'project', tree }, { cacheDir: path.join(root, 'cache'), allowFile: true });
    assert.equal(got.commit, rootedCommit(tree).id);
    assert.equal(got.tree, tree, 'the tree is the upstream\'s own, byte for byte');
    assert.notEqual(got.commit, top.commit);
    const paths = got.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['foundry.toml', 'lib/dep/Dep.sol', 'src/A.sol']);
    assert.deepEqual(got.ownPaths, ['foundry.toml', 'src/A.sol'], 'the subfolder\'s own: the repository\'s README.md is not the listed commit\'s');
    assert.ok(!got.objects.has(top.commit), 'the upstream\'s own commit object names another tree: it stays out');
    assert.deepEqual(got.missing, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('two subfolders of one commit keep their own stores: each fetches its own submodules', async () => {
  const root = tmp();
  try {
    const depA = makeRepo(root, 'depA', { 'A.sol': 'contract A {}\n' });
    const depB = makeRepo(root, 'depB', { 'B.sol': 'contract B {}\n' });
    const top = makeRepo(root, 'mono', {
      'a/foundry.toml': 'x\n', 'b/foundry.toml': 'y\n',
      '.gitmodules': gitmodules([['a/lib/dep', depA.url], ['b/lib/dep', depB.url]])
    }, { 'a/lib/dep': depA.commit, 'b/lib/dep': depB.commit });
    const cacheDir = path.join(root, 'cache');
    const one = await fetchRepo({ url: top.url, commit: top.commit, subdir: 'a', tree: git(top.dir, 'rev-parse', `${top.commit}:a`) }, { cacheDir, allowFile: true });
    const two = await fetchRepo({ url: top.url, commit: top.commit, subdir: 'b', tree: git(top.dir, 'rev-parse', `${top.commit}:b`) }, { cacheDir, allowFile: true });
    assert.deepEqual(one.missing, []);
    assert.deepEqual(two.missing, []);
    assert.ok(two.files.some((f) => f.path === 'lib/dep/B.sol'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a subfolder whose tree is not the one pinned stops the fetch', async () => {
  const root = tmp();
  try {
    const top = makeRepo(root, 'mono', { 'project/foundry.toml': 'x\n' });
    await assert.rejects(
      fetchRepo({ url: top.url, commit: top.commit, subdir: 'project', tree: 'a'.repeat(40) }, { cacheDir: path.join(root, 'cache'), allowFile: true }),
      /tree .* not the .* listing/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a commit the remote does not have stops the fetch, and a submodule\'s is recorded and left out, as git leaves it', async () => {
  const root = tmp();
  try {
    const gone = 'b'.repeat(40);
    const top = makeRepo(root, 'top', {
      'foundry.toml': 'x\n', '.gitmodules': gitmodules([['lib/gone', `file://${path.join(root, 'nowhere')}`]])
    }, { 'lib/gone': gone });
    const got = await fetchRepo({ url: top.url, commit: top.commit }, { cacheDir: path.join(root, 'cache'), allowFile: true });
    assert.deepEqual(got.missing.map((m) => [m.path, m.commit]), [['lib/gone', gone]]);
    assert.deepEqual(got.emptyDirs, ['lib/gone']);
    await assert.rejects(
      fetchRepo({ url: top.url, commit: 'c'.repeat(40) }, { cacheDir: path.join(root, 'cache2'), allowFile: true }),
      /could not be fetched/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a store with a submodule left out is not kept: a fetch that failed once is tried again', async () => {
  const root = tmp();
  try {
    const dep = makeRepo(root, 'dep', { 'Dep.sol': 'contract Dep {}\n' });
    const url = `file://${path.join(root, 'dep-later')}`;
    const top = makeRepo(root, 'top', { 'foundry.toml': 'x\n', '.gitmodules': gitmodules([['lib/dep', url]]) }, { 'lib/dep': dep.commit });
    const cacheDir = path.join(root, 'cache');
    assert.equal((await fetchRepo({ url: top.url, commit: top.commit }, { cacheDir, allowFile: true })).missing.length, 1);
    fs.renameSync(dep.dir, path.join(root, 'dep-later'));
    const second = await fetchRepo({ url: top.url, commit: top.commit }, { cacheDir, allowFile: true });
    assert.deepEqual(second.missing, []);
    assert.ok(second.objects.has(dep.commit));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a listing\'s repository comes whole, and is the commit it names: otherwise nothing is built from it', async () => {
  const root = tmp();
  try {
    const top = makeRepo(root, 'top', { 'foundry.toml': 'x\n', '.gitmodules': gitmodules([['lib/gone', `file://${path.join(root, 'nowhere')}`]]) }, { 'lib/gone': 'b'.repeat(40) });
    const o = { cacheDir: path.join(root, 'cache'), allowFile: true };
    await assert.rejects(fetchListedRepo({ id: 'x', commit: top.commit, repo: { url: top.url, commit: top.commit } }, o), /lib\/gone .* could not be fetched/);
    const whole = makeRepo(root, 'whole', { 'foundry.toml': 'x\n' });
    assert.equal((await fetchListedRepo({ id: 'x', commit: whole.commit, repo: { url: whole.url, commit: whole.commit } }, o)).commit, whole.commit);
    await assert.rejects(fetchListedRepo({ id: 'x', commit: 'c'.repeat(40), repo: { url: whole.url, commit: whole.commit } }, o), /makes commit/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a tree whose paths leave the repository, or hold .git, stops the fetch', async () => {
  const root = tmp();
  try {
    const top = makeRepo(root, 'top', { 'foundry.toml': 'x\n' });
    // A tree real git would not check out: only hash-object --literally writes it.
    const blob = git(top.dir, 'rev-parse', `${top.commit}:foundry.toml`);
    const entry = (name) => Buffer.concat([Buffer.from(`100644 ${name}\0`), Buffer.from(blob, 'hex')]);
    for (const name of ['..', '.git']) {
      const tree = execFileSync('git', ['-C', top.dir, 'hash-object', '-t', 'tree', '-w', '--stdin', '--literally'], { input: entry(name), env: GIT_ENV, encoding: 'utf8' }).trim();
      const commit = execFileSync('git', ['-C', top.dir, 'commit-tree', tree, '-m', 'x'], { env: GIT_ENV, encoding: 'utf8' }).trim();
      await assert.rejects(fetchRepo({ url: top.url, commit }, { cacheDir: path.join(root, `cache-${name}`), allowFile: true }), /path/, name);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a gitlink no .gitmodules names is left out and recorded', async () => {
  const root = tmp();
  try {
    const top = makeRepo(root, 'top', { 'foundry.toml': 'x\n' }, { 'lib/nameless': 'd'.repeat(40) });
    const got = await fetchRepo({ url: top.url, commit: top.commit }, { cacheDir: path.join(root, 'cache'), allowFile: true });
    assert.equal(got.missing[0].path, 'lib/nameless');
    assert.match(got.missing[0].reason, /\.gitmodules/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the second fetch reads the cache: the same bytes with the upstream gone', async () => {
  const root = tmp();
  try {
    const { top, dep, inner } = upstreamWithSubmodules(root);
    const cacheDir = path.join(root, 'cache');
    const first = await fetchRepo({ url: top.url, commit: top.commit }, { cacheDir, allowFile: true });
    for (const r of [top, dep, inner]) fs.rmSync(r.dir, { recursive: true, force: true });
    const second = await fetchRepo({ url: top.url, commit: top.commit }, { cacheDir, allowFile: true });
    assert.deepEqual([...second.objects.keys()].sort(), [...first.objects.keys()].sort());
    assert.deepEqual(second.files.map((f) => f.path), first.files.map((f) => f.path));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only https reaches a real fetch, and a submodule cannot walk to another protocol', async () => {
  const root = tmp();
  try {
    await assert.rejects(fetchRepo({ url: 'http://example.org/x', commit: 'a'.repeat(40) }, { cacheDir: path.join(root, 'cache') }), /https/);
    await assert.rejects(fetchRepo({ url: 'file:///tmp/x', commit: 'a'.repeat(40) }, { cacheDir: path.join(root, 'cache') }), /https/);
    assert.equal(resolveSubmoduleUrl('https://github.com/a/b', '../c.git'), 'https://github.com/a/c.git');
    assert.equal(resolveSubmoduleUrl('https://github.com/a/b.git', './d'), 'https://github.com/a/b.git/d');
    assert.equal(resolveSubmoduleUrl('https://github.com/a/b', 'https://github.com/x/y'), 'https://github.com/x/y');
    assert.equal(resolveSubmoduleUrl('https://github.com/a/b', 'git@github.com:x/y.git'), 'https://github.com/x/y.git', 'ssh form of a public repository');
    assert.equal(resolveSubmoduleUrl('https://github.com/a/b', 'file:///etc'), null);
    assert.equal(resolveSubmoduleUrl('https://github.com/a/b', 'ext::sh -c x'), null);
    const top = makeRepo(root, 'top', { 'foundry.toml': 'x\n', '.gitmodules': gitmodules([['lib/x', 'ext::sh -c touch']]) }, { 'lib/x': 'e'.repeat(40) });
    const got = await fetchRepo({ url: top.url, commit: top.commit }, { cacheDir: path.join(root, 'cache'), allowFile: true });
    assert.match(got.missing[0].reason, /URL/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('git runs with no user or system configuration, and without a prompt', () => {
  const env = hermeticGitEnv({ PATH: '/usr/bin', HOME: '/home/x', GIT_DIR: '/evil', GIT_CONFIG_PARAMETERS: 'x' });
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
  assert.equal(env.HOME, undefined);
});
