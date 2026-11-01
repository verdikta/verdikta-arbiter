'use strict';

// The forced checkout (src/checkout.js), A2a attempt 2 (owner decision Q25):
// one test group per acceptance item, driven through the run engine against
// a fake env image whose git objects are a real object store
// (test/helpers/fakeClaim.js, gitStore.js). The same paths run against real
// git and forge in test/docker/claim.docker.test.js, with the attack table.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { executeRun } = require('../../src/pipeline');
const { checkSpec } = require('../../src/classLimits');
const { claimSteps } = require('../../src/steps');
const { GIT_DIR, STAGE_DIR, GIT_FIXED_ENV, BASE_ENV, EXTRA_ENV } = require('../../src/git');
const { STAGE_SCRIPT, DIRS_SCRIPT, CLEAR_SCRIPT, UNSTAGE_SCRIPT, NEUTRAL_ATTRIBUTES, LISTS_DIR } = require('../../src/checkout');
const { testConfig } = require('../helpers/http');
const { spec: baseSpec, IMAGE } = require('../helpers/requests');
const { claimSandbox, defaultImage } = require('../helpers/fakeClaim');
const { GitStore } = require('../helpers/gitStore');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function request(base) {
  return {
    listingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    bcid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    spec: baseSpec({
      baseCommit: base,
      commands: { framework: 'forge', build: 'forge build', test: 'forge test', testFiles: 'forge test --match-path $FILES', testIds: 'forge test --match-test $TEST_IDS' },
      paths: { tests: ['test/**'], protected: ['foundry.toml', 'lib/**'] },
      limits: { cpus: 1, memoryMb: 512, buildSeconds: 30, testSeconds: 60, runSeconds: 300, maxPatchBytes: 2000000 }
    }),
    attestation: {},
    pocPatch: Buffer.from('diff --git a/test/Exploit.t.sol b/test/Exploit.t.sol\nnew file mode 100644\n--- /dev/null\n+++ b/test/Exploit.t.sol\n@@ -0,0 +1 @@\n+contract ExploitTest {}\n'),
    fixPatch: null,
    baseline: { version: 1, baseCommit: base, framework: 'forge', runs: 3, tests: [{ id: 'test/Vault.t.sol > VaultTest > test_deposit()', results: ['pass', 'pass', 'pass'] }], stable: [], unstable: [] },
    finding: {},
    report: '',
    knownIssues: [],
    priorFindings: [],
    eaGates: { disclosure: 'pass', inScope: 'pass' },
    deadlineMs: 700000
  };
}

async function run(sb, base = sb.image.base) {
  const req = request(base);
  const lim = checkSpec(req.spec);
  assert.ok(lim.ok, JSON.stringify(lim.issues));
  const receivedAt = Date.now();
  return executeRun({
    docker: sb.docker, config: testConfig(), limits: lim.limits, image: IMAGE, runId: '0123456789abcdef', steps: claimSteps(req, lim.limits),
    receivedAt, deadlineAt: receivedAt + 700000, active: new Set(), log: silent, admit: async () => {}
  });
}

/** An image of `files` (gitStore.js's map), plus submodules made with `sub(files)`. */
function imageOf(build, algo = 'sha1') {
  const store = new GitStore(algo);
  const files = build((f) => ({ gitlink: store.repo(f, 'sub') }), store);
  return { store, base: store.repo(files, 'base') };
}

const label = (d) => (d.kind === 'git' ? `git ${d.sub[0]}` : d.kind);
const prepareExecs = (sb) => {
  const all = sb.execs();
  const end = all.findIndex((d) => d.kind === 'vcr-unstage');
  return all.slice(0, end + 1);
};
const gitIn = (sb, sub) => sb.execs().filter((d) => d.kind === 'git' && d.sub[0] === sub);
const scriptIn = (sb, name) => sb.execs().filter((d) => d.kind === name);
const zSplit = (buf) => buf.toString('latin1').split('\0').slice(0, -1);
const noClaimCode = (sb) => {
  assert.equal(sb.execs().filter((d) => d.kind === 'vcr-build' || d.kind === 'vcr-poc').length, 0, 'no build or PoC ran');
  assert.equal(gitIn(sb, 'apply').length, 0, 'the patch never reached git');
};
const blobId = (algo, content) => crypto.createHash(algo).update(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(content, 'latin1')}\0`), Buffer.from(content, 'latin1')])).digest('hex');

// ------------------------------------------------ item 1: no image git state

test('item 1: every git call starts with an empty environment, in one of the runner\'s two repositories, and nothing of /repo is read by git', async () => {
  const sb = claimSandbox();
  const r = await run(sb);
  assert.equal(r.outcome, 'definitive', JSON.stringify(r.abstain || r.issues));
  const allowed = new Set([...Object.keys(GIT_FIXED_ENV), 'GIT_DIR', 'GIT_WORK_TREE', ...EXTRA_ENV]);
  for (const d of sb.execs().filter((x) => x.kind === 'git')) {
    assert.deepEqual(d.launched.slice(0, 2), ['/usr/bin/env', '-i'], `${d.sub[0]}: an empty environment, then the runner's`);
    for (const k of Object.keys(d.fixedEnv)) assert.ok(allowed.has(k), `${d.sub[0]} gets no ${k}`);
    assert.ok([GIT_DIR, STAGE_DIR].includes(d.fixedEnv.GIT_DIR), `${d.sub[0]} runs in ${d.fixedEnv.GIT_DIR}`);
    for (const k of ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_ATTR_NOSYSTEM', 'GIT_NO_REPLACE_OBJECTS']) assert.equal(d.fixedEnv[k], GIT_FIXED_ENV[k]);
    assert.ok(d.argv.includes('core.hooksPath=/dev/null') && d.argv.includes('core.fsmonitor=false') && d.argv.includes('core.useReplaceRefs=false'));
    assert.ok(!d.launched.some((a) => a.includes('/repo')), `${d.sub[0]} never names the image's checkout`);
  }
  const prep = prepareExecs(sb);
  // Objects are read from the staging store only; everything else is the fresh repository.
  for (const d of prep.filter((x) => x.kind === 'git')) {
    const stage = d.sub[0] === 'cat-file' || (d.sub[0] === 'init' && d.sub.includes('--bare'));
    assert.equal(d.fixedEnv.GIT_DIR, stage ? STAGE_DIR : GIT_DIR, d.sub.join(' '));
    assert.equal(d.fixedEnv.GIT_WORK_TREE, stage ? undefined : '/work');
    assert.ok(!['submodule', 'status', 'ls-files', 'config', 'for-each-ref'].includes(d.sub[0]), `prepare runs no git ${d.sub[0]}`);
    assert.ok(!d.sub.includes('HEAD'), 'the image\'s HEAD is never read');
  }
  for (const init of gitIn(sb, 'init')) assert.ok(init.sub.includes('--template='), 'no template (no hook) is copied into a fresh repository');
  // The runner's own scripts get an empty environment too (no TAR_OPTIONS, CDPATH or PATH of the image's).
  for (const name of ['vcr-stage', 'vcr-dirs', 'vcr-clear', 'vcr-unstage']) {
    const [d] = scriptIn(sb, name);
    assert.deepEqual(d.launched.slice(0, 2), ['/usr/bin/env', '-i'], name);
    assert.deepEqual(d.fixedEnv, BASE_ENV, name);
  }
  // Only the copy step names /repo, and it runs no git.
  const named = prep.filter((d) => d.launched.some((a) => a === '/repo'));
  assert.deepEqual(named.map(label), ['vcr-stage']);
});

test('item 1: the runner re-hashes every object it uses; a forged commit, tree or blob, the superproject\'s or a submodule\'s, is refused before any build', async () => {
  const img = defaultImage();
  const ids = {};
  for (const [id, o] of img.store.objects) {
    const text = o.content.toString('latin1');
    if (o.type === 'blob' && text === 'contract Vault {}\n') ids.blob = id;
    if (o.type === 'blob' && text === '// forge-std\n') ids.subBlob = id;
  }
  ids.commit = img.base;
  ids.tree = /^tree ([0-9a-f]{40})/.exec(img.store.objects.get(img.base).content.toString())[1];
  ids.subCommit = img.dep;
  for (const [what, id] of Object.entries(ids)) {
    const forged = (m) => {
      const o = m.get(id);
      const content = Buffer.from(o.content);
      content[content.length - 2] ^= 1; // same size, other bytes: the store still files it under the old id
      m.set(id, { type: o.type, content });
      return m;
    };
    const sb = claimSandbox({ image: img, objects: forged });
    const r = await run(sb);
    assert.equal(r.outcome, 'requester_error', what);
    assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_OBJECT_INVALID'], what);
    assert.match(r.issues[0].detail, new RegExp(`the object ${id} in the env image does not hash to its id`), what);
    assert.equal(sb.repo.commit, null, `${what}: nothing was committed`);
    noClaimCode(sb);
  }
  // An object of another type filed under a tree's id: the bytes hash, as a tree, to nothing it claims.
  const retyped = claimSandbox({ image: img, objects: (m) => { const o = m.get(ids.tree); m.set(ids.tree, { type: 'blob', content: o.content }); return m; } });
  const r2 = await run(retyped);
  assert.deepEqual(r2.issues.map((i) => i.code), ['IMAGE_OBJECT_INVALID']);
});

// ------------------------------------------ item 2: tracked paths forced to the commit

test('item 2: the fresh repository holds exactly the commit\'s files, bytes and modes, each submodule\'s at its recorded commit, as ordinary paths', async () => {
  const nl = 'odd\nname';
  const img = imageOf((sub) => {
    const inner = sub({ 'deep/x.sol': 'inner\n' });
    return {
      'src/Vault.sol': 'contract Vault {}\n',
      'src/run.sh': { exec: '#!/bin/sh\necho hi\n' },
      'src/link': { link: 'Vault.sol' },
      'src/abs': { link: '/etc/passwd' },
      [`test/${nl}`]: 'newline\n',
      'test/"q': 'quote\n',
      'test/-dash': 'dash\n',
      'test/..x': 'dots\n',
      'test/A.sol': 'upper\n',
      'test/a.sol': 'lower\n',
      'test/ÿþ': Buffer.from([0xff, 0x00, 0x0a]),
      'lib/dep': sub({ 'src/D.sol': 'dep\n', 'lib/inner': inner, 'bin/tool': { exec: 'tool\n' } })
    };
  });
  const sb = claimSandbox({ image: img });
  const r = await run(sb);
  assert.equal(r.outcome, 'definitive', JSON.stringify(r.abstain || r.issues));
  const expected = {
    'lib/dep/bin/tool': ['100755', 'tool\n'],
    'lib/dep/lib/inner/deep/x.sol': ['100644', 'inner\n'],
    'lib/dep/src/D.sol': ['100644', 'dep\n'],
    'src/Vault.sol': ['100644', 'contract Vault {}\n'],
    'src/abs': ['120000', '/etc/passwd'],
    'src/link': ['120000', 'Vault.sol'],
    'src/run.sh': ['100755', '#!/bin/sh\necho hi\n'],
    'test/"q': ['100644', 'quote\n'],
    'test/-dash': ['100644', 'dash\n'],
    'test/..x': ['100644', 'dots\n'],
    'test/A.sol': ['100644', 'upper\n'],
    'test/a.sol': ['100644', 'lower\n'],
    [`test/${nl}`]: ['100644', 'newline\n'],
    'test/ÿþ': ['100644', 'ÿ\u0000\n']
  };
  // The fresh repository's branch (read back from the runner's packs, hashed independently).
  assert.deepEqual(Object.fromEntries(sb.repo.files.map((f) => [f.path, [f.mode, f.id]])),
    Object.fromEntries(Object.entries(expected).map(([p, [mode, content]]) => [p, [mode, blobId('sha1', content)]])));
  // Every blob the fresh repository got is the commit's bytes.
  for (const [p, [, content]] of Object.entries(expected)) assert.equal(sb.repo.objects.get(blobId('sha1', content)).content.toString('latin1'), content, p);
  // Packs hold the runner's objects only: the verified blobs, its trees, its commit.
  const packed = sb.repo.packs.flat();
  assert.deepEqual(new Set(packed.map((o) => o.type)), new Set(['blob', 'tree', 'commit']));
  assert.equal(packed.filter((o) => o.type === 'commit').length, 1);
  const commit = { author: `author ${/\nauthor ([^\n]*)/.exec(sb.repo.objects.get(sb.repo.commit).content.toString())[1]}`,
    message: sb.repo.objects.get(sb.repo.commit).content.toString().split('\n\n')[1] };
  // The tree git built from them is the flattened commit, as an independent store computes it.
  const store = new GitStore('sha1');
  const flat = store.treeOfEntries(Object.entries(expected).map(([path, [mode, content]]) => ({ path, mode, id: blobId('sha1', content) })));
  assert.equal(r.facts.checkout.tree, flat);
  assert.equal(r.facts.checkout.commit, sb.repo.commit);
  assert.equal(r.facts.checkout.paths, Object.keys(expected).length);
  assert.equal(commit.author, 'author Verdikta code runner <code-runner@verdikta.invalid> 1767225600 +0000');
  assert.equal(commit.message, `listed commit ${img.base}\n`);

  // Every directory on the way to a tracked path, parents first; every tracked path cleared, then written by git.
  const [dirs] = scriptIn(sb, 'vcr-dirs');
  assert.deepEqual(zSplit(dirs.stdin), ['lib', 'lib/dep', 'lib/dep/bin', 'lib/dep/lib', 'lib/dep/lib/inner', 'lib/dep/lib/inner/deep', 'lib/dep/src', 'src', 'test']);
  const [clear] = scriptIn(sb, 'vcr-clear');
  assert.deepEqual(zSplit(clear.stdin).sort(), Object.keys(expected).sort());
  assert.deepEqual(clear.argv.slice(4), [`${LISTS_DIR}/clear`]);
  const order = prepareExecs(sb).map(label);
  const at = (k) => order.indexOf(k);
  assert.ok(at('git read-tree') < at('vcr-dirs') && at('vcr-dirs') < at('git diff-files') && at('git diff-files') < at('vcr-clear'));
  assert.ok(at('vcr-clear') < at('git checkout-index') && at('git checkout-index') < order.lastIndexOf('git diff-files'));
  assert.deepEqual(gitIn(sb, 'checkout-index')[0].sub, ['checkout-index', '--all', '--index']);
  assert.deepEqual(gitIn(sb, 'read-tree')[0].sub, ['read-tree', sb.repo.commit]);
  // What git compares before the clear only counts (item 5); every tracked path is cleared and written whatever it said.
  assert.deepEqual(gitIn(sb, 'diff-files').map((d) => d.sub), [['diff-files', '--name-only', '-z'], ['diff-files', '--quiet']]);
});

test('item 2: the scripts replace, never write through: real directories on the way, whatever sits at a tracked path removed, nothing followed', () => {
  // A directory on the way is kept only when it is one and not a symbolic link; anything else is removed (rm -f, which
  // never follows a link) and a directory made. Parents come first, so no later test looks through a link.
  assert.match(DIRS_SCRIPT, /if \[ -d "\$d" \] && \[ ! -L "\$d" \]; then/);
  assert.match(DIRS_SCRIPT, /if \[ -e "\$d" \] \|\| \[ -L "\$d" \]; then rm -f -- "\$d" \|\| exit 1; fi\n {4}mkdir -- "\$d" \|\| exit 1/);
  assert.match(DIRS_SCRIPT, /d=\.\/\$d/, 'a path is never read as an option');
  // At a tracked path: rm -rf (a link itself, a directory with all it holds), then a builtin check that nothing is left;
  // permissions are opened only on a real directory (chmod -R never through a link).
  assert.match(CLEAR_SCRIPT, /xargs -0 -r -a "\$list" rm -rf --/);
  assert.match(CLEAR_SCRIPT, /\{ \[ -L "\$p" \] \|\| chmod -R u\+rwx -- "\$p"; \} && rm -rf -- "\$p" \|\| exit 1/);
  assert.match(CLEAR_SCRIPT, /\{ \[ -e "\$p" \] \|\| \[ -L "\$p" \]; \} && exit 1/);
  // The copy: every .git entry (at any depth, any type), device node, socket and named pipe left out (R13-F1: a pipe
  // at .gitattributes would block git's attribute reader); everything else as the image has it.
  assert.match(STAGE_SCRIPT, /find \. -mindepth 1 \\\( -name \.git -o -type b -o -type c -o -type s -o -type p \\\) -prune -o -print0/);
  assert.match(STAGE_SCRIPT, /tar --null --verbatim-files-from --no-recursion -T - -cf -/);
  assert.match(STAGE_SCRIPT, /tar -xpf - -C \/work/);
  // The objects: regular files only, loose objects and packs, from objects directories inside .git directories, in byte
  // order, the first copy of a name kept; no alternates, multi-pack-index or commit-graph.
  assert.match(STAGE_SCRIPT, /find \. -type d -name objects -path '\*\/\.git\/\*' -prune -print0/);
  assert.match(STAGE_SCRIPT, /LC_ALL=C sort -z/);
  assert.match(STAGE_SCRIPT, /-type f \\\( -path "\.\/\[0-9a-f\]\[0-9a-f\]\/\*" -o -path "\.\/pack\/pack-\*\.pack" -o -path "\.\/pack\/pack-\*\.idx" \\\)/);
  assert.match(STAGE_SCRIPT, /--skip-old-files/);
  // R13-F2: each object file with its own bytes (a hard link is never re-linked to another store's copy), sorted in a store.
  assert.match(STAGE_SCRIPT, /\| \{ sort -z \|\| echo sort >&5; \} \\\n {10}\| \{ cd "\$d" && tar --null --verbatim-files-from --no-recursion --hard-dereference -T - -cf -/);
  for (const not of ['alternates', 'multi-pack-index', 'commit-graph', 'info/packs']) assert.ok(!STAGE_SCRIPT.includes(not), not);
  // The fresh repository's attributes: no filter, conversion, ident or driver for any path.
  assert.equal(NEUTRAL_ATTRIBUTES, '* !filter !diff !merge !text !crlf !eol !ident !working-tree-encoding');
  assert.match(STAGE_SCRIPT, /printf "%s\\n" "\$attrs" > "\$info\/attributes"/);
  // No script runs git: git runs only as git.js builds it.
  for (const s of [STAGE_SCRIPT, DIRS_SCRIPT, CLEAR_SCRIPT, UNSTAGE_SCRIPT]) assert.doesNotMatch(s, /(^|[\s;&|({])git(\s|$)/m);
});

// --------------------------------------------------------- item 3: missing objects

test('item 3: a submodule whose objects are not in the image is left an empty directory (its commit, a tree or a blob missing; nested too)', async () => {
  const build = (sub, store) => {
    const nested = sub({ 'n.sol': 'n\n' });
    return {
      'src/Vault.sol': 'v\n',
      'lib/nocommit': { gitlink: store.add('blob', 'placeholder') && 'f'.repeat(40) },
      'lib/notree': sub({ 'a/b.sol': 'b\n' }),
      'lib/noblob': sub({ 'c.sol': 'gone\n' }),
      'lib/outer': sub({ 'o.sol': 'o\n', 'lib/nested': nested })
    };
  };
  const img = imageOf(build);
  const drop = (m) => {
    for (const [id, o] of [...m]) {
      const text = o.content.toString('latin1');
      if (o.type === 'tree' && /^40000 b.sol|100644 b\.sol/.test(text)) m.delete(id); // lib/notree's a/
      if (o.type === 'blob' && text === 'gone\n') m.delete(id); // lib/noblob's c.sol
      if (o.type === 'blob' && text === 'n\n') m.delete(id); // lib/outer/lib/nested's n.sol
    }
    return m;
  };
  const sb = claimSandbox({ image: img, objects: drop });
  const r = await run(sb);
  assert.equal(r.outcome, 'definitive', JSON.stringify(r.abstain || r.issues));
  assert.deepEqual(r.facts.checkout.emptySubmodules, ['lib/noblob', 'lib/nocommit', 'lib/notree', 'lib/outer/lib/nested']);
  const paths = sb.repo.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['lib/outer/o.sol', 'src/Vault.sol'], 'nothing of an empty submodule is tracked');
  // Each is cleared like a tracked path, then made an empty directory (the second dirs pass).
  const [clear] = scriptIn(sb, 'vcr-clear');
  for (const p of r.facts.checkout.emptySubmodules) assert.ok(zSplit(clear.stdin).includes(p), p);
  const [, empty] = scriptIn(sb, 'vcr-dirs');
  assert.deepEqual(zSplit(empty.stdin), ['lib/noblob', 'lib/nocommit', 'lib/notree', 'lib/outer/lib/nested']);
  const [dirs] = scriptIn(sb, 'vcr-dirs');
  assert.deepEqual(zSplit(dirs.stdin), ['lib', 'lib/outer', 'lib/outer/lib', 'src'], 'the directories on the way to them are real');
});

test('item 3: a missing object of the listed commit\'s own tree is a requester error, refused before any build', async () => {
  const img = defaultImage();
  const rootTree = /^tree ([0-9a-f]{40})/.exec(img.store.objects.get(img.base).content.toString())[1];
  const find = (pred) => [...img.store.objects].find(([, o]) => pred(o))[0];
  const cases = [
    ['the listed commit', img.base, /holds no object for the listed commit/, '/spec/env/image'],
    ['the root tree', rootTree, /listed commit's tree [0-9a-f]{40} at the top/, '/spec/env/image'],
    ['a subtree', find((o) => o.type === 'tree' && o.content.toString('latin1').startsWith('100644 Vault.sol')), /tree [0-9a-f]{40} at "src"/, '/spec/env/image'],
    ['a blob', find((o) => o.type === 'blob' && o.content.toString() === 'contract Vault {}\n'), /no object for "src\/Vault\.sol" \(blob [0-9a-f]{40}\)/, '/spec/env/image']
  ];
  for (const [what, id, re] of cases) {
    const sb = claimSandbox({ image: img, objects: (m) => { m.delete(id); return m; } });
    const r = await run(sb);
    assert.equal(r.outcome, 'requester_error', what);
    assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_OBJECTS_MISSING'], what);
    assert.match(r.issues[0].detail, re, what);
    assert.match(r.issues[0].detail, /in a \.git directory under \/repo/);
    assert.equal(sb.repo.commit, null);
    noClaimCode(sb);
  }
});

// ------------------------------------------------------ item 4: one fresh repository

test('item 4: two repositories the runner makes, one left: the staging store is removed; the claim steps run in the fresh one', async () => {
  const sb = claimSandbox();
  const r = await run(sb);
  assert.equal(r.outcome, 'definitive');
  const [work, stage] = gitIn(sb, 'init');
  assert.deepEqual(work.sub, ['init', '--quiet', '--template=', '--object-format=sha1', '--initial-branch=main']);
  assert.equal(work.fixedEnv.GIT_DIR, GIT_DIR);
  assert.deepEqual(stage.sub, ['init', '--quiet', '--bare', '--template=', '--object-format=sha1', '--initial-branch=main']);
  assert.equal(stage.fixedEnv.GIT_DIR, STAGE_DIR);
  const all = sb.execs();
  const unstage = all.find((d) => d.kind === 'vcr-unstage');
  assert.deepEqual(unstage.argv.slice(4), [STAGE_DIR, LISTS_DIR]);
  const after = all.slice(all.indexOf(unstage) + 1).filter((d) => d.kind === 'git');
  assert.ok(after.length >= 8);
  for (const d of after) assert.equal(d.fixedEnv.GIT_DIR, GIT_DIR, d.sub[0]);
  for (const d of sb.execs().filter((x) => x.kind === 'git' && ['index-pack', 'update-ref'].includes(x.sub[0]))) assert.equal(d.fixedEnv.GIT_DIR, GIT_DIR);
  assert.deepEqual(gitIn(sb, 'index-pack').map((d) => d.sub), [['index-pack', '--stdin'], ['index-pack', '--stdin']]);
  assert.deepEqual(gitIn(sb, 'update-ref')[0].sub, ['update-ref', 'refs/heads/main', sb.repo.commit]);
  assert.deepEqual(r.facts.commit, { base: sb.image.base, poc: '9e1b2d0000000000000000000000000000000000' });
});

test('item 4: a fresh repository that is not what the runner built, or a work tree that does not match it, abstains; nothing runs on it', async () => {
  const cases = [
    [{ git: { 'rev-parse': (d, repo) => ({ stdout: d.sub.includes('refs/heads/main^{commit}') ? `${repo.commit}\n${'0'.repeat(40)}\n` : `${repo.commit}\n` }) } }, 'prepare:head'],
    [{ git: { 'rev-parse': (d, repo) => ({ stdout: d.sub.includes('refs/heads/main^{commit}') ? `${'0'.repeat(40)}\n${repo.tree}\n` : `${repo.commit}\n` }) } }, 'prepare:head'],
    [{ git: { 'diff-files --quiet': () => ({ exitCode: 1 }) } }, 'prepare:verify'],
    [{ git: { 'index-pack': () => ({ exitCode: 128, stderr: 'fatal: out of memory\n' }) } }, 'prepare:import:1'],
    [{ git: { 'update-ref': () => ({ exitCode: 128, stderr: 'fatal: cannot lock ref\n' }) } }, 'prepare:ref'],
    [{ git: { 'checkout-index': () => ({ exitCode: 1, stderr: 'error: x already exists\n' }) } }, 'prepare:write'],
    [{ scripts: { 'vcr-clear': () => ({ exitCode: 5 }) } }, 'prepare:clear'],
    [{ scripts: { 'vcr-dirs': () => ({ exitCode: 4 }) } }, 'prepare:dirs'],
    [{ scripts: { 'vcr-unstage': () => ({ exitCode: 1 }) } }, 'prepare:unstage']
  ];
  for (const [over, step] of cases) {
    const sb = claimSandbox(over);
    const r = await run(sb);
    assert.equal(r.outcome, 'abstain', step);
    assert.equal(r.abstain.cause, 'runner_error', step);
    assert.equal(r.abstain.step, step);
    noClaimCode(sb);
  }
});

// -------------------------------------------------- item 5: recorded, not judged

test('item 5: corrections are facts: tracked paths the image had differently, directories made, empty submodules, .git entries dropped', async () => {
  const sb = claimSandbox({
    corrected: ['lib/forge-std/src/Test.sol', 'src/Vault.sol'],
    scripts: { 'vcr-stage': () => ({ stdout: 'vcr-git-entries 3\n' }), 'vcr-dirs': () => ({ stdout: './src\0' }) }
  });
  const r = await run(sb);
  assert.equal(r.outcome, 'definitive', 'a corrected image is run, not refused');
  for (const g of ['applies', 'testPathsOnly', 'build', 'reproduces']) assert.ok(r.gates[g], g);
  const c = r.facts.checkout;
  assert.deepEqual({ ...c, commit: undefined, tree: undefined }, {
    commit: undefined,
    tree: undefined,
    paths: 5,
    corrected: 2,
    correctedPaths: ['lib/forge-std/src/Test.sol', 'src/Vault.sol'],
    directoriesMade: 1,
    emptySubmodules: [],
    gitRemoved: true,
    gitEntriesRemoved: 3
  });
  const clean = await run(claimSandbox({ scripts: { 'vcr-stage': () => ({ stdout: 'vcr-git-entries 0\n' }) } }));
  assert.equal(clean.facts.checkout.gitRemoved, false);
  assert.equal(clean.facts.checkout.corrected, 0);
  // Many corrections: all counted, the first 100 listed.
  const many = Array.from({ length: 150 }, (_, i) => `src/f${String(i).padStart(3, '0')}`);
  const big = await run(claimSandbox({ corrected: many }));
  assert.equal(big.facts.checkout.corrected, 150);
  assert.deepEqual(big.facts.checkout.correctedPaths, many.slice(0, 100));
});

test('item 5: the same image gives the same fresh repository, stream and facts on every run', async () => {
  const a = claimSandbox();
  const b = claimSandbox();
  const ra = await run(a);
  const rb = await run(b);
  assert.deepEqual(ra.facts.checkout, rb.facts.checkout);
  const streams = (sb) => sb.execs().filter((d) => d.kind === 'git' && d.sub[0] === 'index-pack').map((d) => d.stdin.toString('hex'));
  assert.deepEqual(streams(a), streams(b));
});

// ------------------------------------------------------ the requester's package

test('the requester\'s package: no checkout, unreadable files or objects, a malformed object, a path git will not check out, too large', async () => {
  const img = defaultImage();
  /** The default image plus a listed commit whose root tree `mutate` builds: objects that hash, but are malformed. */
  const withTree = (mutate) => {
    const store = new GitStore('sha1');
    for (const [id, o] of img.store.objects) store.objects.set(id, o);
    const rootTree = /^tree ([0-9a-f]{40})/.exec(store.objects.get(img.base).content.toString())[1];
    const tree = mutate(store, store.objects.get(rootTree).content);
    return { store, base: store.commit(tree, 'malformed') };
  };
  const cases = [
    [{ scripts: { 'vcr-stage': () => ({ exitCode: 10 }) } }, 'IMAGE_CHECKOUT_MISSING', /no repository checkout at \/repo/],
    [{ scripts: { 'vcr-stage': () => ({ exitCode: 12, stderr: 'tar: ./secret: Cannot open: Permission denied\n' }) } }, 'IMAGE_CHECKOUT_UNREADABLE', /could not be copied.*Permission denied/],
    [{ scripts: { 'vcr-stage': () => ({ exitCode: 13 }) } }, 'IMAGE_CHECKOUT_UNREADABLE', /git objects could not be copied for reading/],
    [{ git: { 'cat-file --batch': () => ({ exitCode: 128, stderr: 'fatal: loose object 12ab is corrupt\n' }) } }, 'IMAGE_OBJECT_INVALID', /could not read the env image's objects.*corrupt/],
    [{ git: { 'read-tree': () => ({ exitCode: 128, stderr: 'error: invalid path \'git~1\'\n' }) } }, 'IMAGE_OBJECT_INVALID', /a path git will not check out: error: invalid path 'git~1'/],
    [{ git: { 'cat-file --batch-check': (d) => ({ stdout: d.stdin.toString().split('\n').filter(Boolean).map((id) => `${id} blob 600000000\n`).join('') }) } },
      'IMAGE_CHECKOUT_TOO_LARGE', /bytes; the checkout holds at most 536870912/]
  ];
  for (const [over, code, re] of cases) {
    const sb = claimSandbox({ image: img, ...over });
    const r = await run(sb);
    assert.equal(r.outcome, 'requester_error', code);
    assert.deepEqual(r.issues.map((i) => i.code), [code]);
    assert.match(r.issues[0].detail, re);
    noClaimCode(sb);
  }
  // Objects that hash but that git (or Linux) would not check out: the commit is the image's, so it is the requester's error.
  const entry = (mode, name, id) => Buffer.concat([Buffer.from(`${mode} ${name}\0`, 'latin1'), Buffer.from(id, 'hex')]);
  const bad = [
    ['a .git entry', (s, root) => s.add('tree', Buffer.concat([entry('40000', '.git', s.tree([])), root])), /has an entry named "\.git"/],
    ['an empty symbolic link', (s, root) => s.add('tree', Buffer.concat([root, entry('120000', 'zlink', s.add('blob', ''))])), /symbolic link "zlink" has a target Linux cannot hold/],
    ['a NUL in a link target', (s, root) => s.add('tree', Buffer.concat([root, entry('120000', 'zlink', s.add('blob', 'a\0b'))])), /symbolic link "zlink"/],
    ['a gitlink to a blob', (s, root) => s.add('tree', Buffer.concat([root, entry('160000', 'zsub', s.add('blob', 'not a commit'))])), /submodule at "zsub" records [0-9a-f]{40}, a blob/],
    ['a blob entry naming a tree', (s, root) => s.add('tree', Buffer.concat([root, entry('100644', 'zfile', s.tree([]))])), /"zfile" records [0-9a-f]{40}, a tree/]
  ];
  for (const [what, mutate, re] of bad) {
    const sb = claimSandbox({ image: withTree(mutate) });
    const r = await run(sb);
    assert.equal(r.outcome, 'requester_error', what);
    assert.deepEqual(r.issues.map((i) => i.code), ['IMAGE_OBJECT_INVALID'], what);
    assert.match(r.issues[0].detail, re, what);
    noClaimCode(sb);
  }
  // The listed commit is a tree in the image.
  const asTree = claimSandbox({ image: img });
  const rootTree = /^tree ([0-9a-f]{40})/.exec(img.store.objects.get(img.base).content.toString())[1];
  const r3 = await run(asTree, rootTree);
  assert.deepEqual(r3.issues.map((i) => i.code), ['IMAGE_OBJECT_INVALID']);
  assert.match(r3.issues[0].detail, /is a tree in the env image/);
});

test('a SHA-256 repository: 64-hex ids, a SHA-256 fresh repository, every object hashed with SHA-256', async () => {
  const img = defaultImage('sha256');
  assert.match(img.base, /^[0-9a-f]{64}$/);
  const sb = claimSandbox({ image: img });
  const r = await run(sb);
  assert.equal(r.outcome, 'definitive', JSON.stringify(r.abstain || r.issues));
  for (const init of gitIn(sb, 'init')) assert.ok(init.sub.includes('--object-format=sha256'));
  assert.match(r.facts.checkout.tree, /^[0-9a-f]{64}$/);
  const forged = claimSandbox({ image: img, objects: (m) => { const o = m.get(img.base); const c = Buffer.from(o.content); c[c.length - 2] ^= 1; m.set(img.base, { type: 'commit', content: c }); return m; } });
  const r2 = await run(forged);
  assert.deepEqual(r2.issues.map((i) => i.code), ['IMAGE_OBJECT_INVALID']);
});

test('too large: the cap counts every path\'s bytes (one blob at many paths is written many times), entries and depth', async () => {
  // 600 paths share one blob the store says is 1 MiB: 600 MiB to write, though one object to read.
  const many = imageOf(() => Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`test/f${i}`, 'same'])));
  const size = (d) => ({ stdout: d.stdin.toString().split('\n').filter(Boolean).map((id) => `${id} blob ${1024 * 1024}\n`).join('') });
  const r1 = await run(claimSandbox({ image: many, git: { 'cat-file --batch-check': size } }));
  assert.deepEqual(r1.issues.map((i) => i.code), ['IMAGE_CHECKOUT_TOO_LARGE']);
  assert.match(r1.issues[0].detail, /629145600 bytes; the checkout holds at most 536870912/);
  // Directories nested past 128: refused before reading further.
  const deep = imageOf(() => ({ [`${Array.from({ length: 130 }, () => 'd').join('/')}/f`]: 'x' }));
  const r2 = await run(claimSandbox({ image: deep }));
  assert.deepEqual(r2.issues.map((i) => i.code), ['IMAGE_CHECKOUT_TOO_LARGE']);
  assert.match(r2.issues[0].detail, /more than 128 deep/);
  assert.ok(r2.steps.filter((s) => s.name.startsWith('prepare:objects:')).length <= 131, 'one read per level, bounded');
});

test('a path the scripts could not name (over 4000 bytes) is refused, and a commit id git does not print is the runner\'s error', async () => {
  const long = imageOf(() => ({ [`test/${'d'.repeat(250)}/${'e'.repeat(250)}/${Array.from({ length: 15 }, () => 'f'.repeat(250)).join('/')}/x`]: 'x' }));
  const r1 = await run(claimSandbox({ image: long }));
  assert.deepEqual(r1.issues.map((i) => i.code), ['IMAGE_OBJECT_INVALID']);
  assert.match(r1.issues[0].detail, /a path longer than 4000 bytes/);
  const r2 = await run(claimSandbox({ git: { 'rev-parse': (d, repo) => ({ stdout: d.sub.includes('refs/heads/main^{commit}') ? `\n${repo.tree}\n` : 'x\n' }) } }));
  assert.equal(r2.outcome, 'abstain');
  assert.equal(r2.abstain.step, 'prepare:head');
});
