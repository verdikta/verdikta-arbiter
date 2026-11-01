'use strict';

/**
 * The forced checkout (design §9.2 step 3; owner decision Q25, "force the
 * checkout"): before any claim code runs, /work becomes the listed commit,
 * whatever the env image's install commands left in its checkout.
 *
 * The env image keeps a checkout at /repo. Its git state (config, index,
 * hooks, attributes, refs, replace refs, alternates, commondir, worktree
 * redirects, submodule settings) is never used. Its git objects are data:
 *
 * 1. Two fresh repositories, made by the runner with its own settings
 *    (git.js): /work/.git, the one the claim pipeline uses, and a staging
 *    store. The image's files are copied into /work without any `.git`
 *    entry (at any depth), device, socket or named pipe; the loose objects and packs of
 *    every `objects` directory inside a `.git` directory of /repo are copied
 *    into the staging store, as files, in byte order, the first copy of a
 *    name kept. Nothing else of theirs (no info/alternates, no
 *    multi-pack-index, no commit-graph) is copied.
 * 2. The runner reads, from the staging store, the listed commit, then its
 *    trees level by level, then each submodule's commit (the one its gitlink
 *    records) and trees, then every blob, and re-hashes each object itself
 *    (objects.js). An object that does not hash to its id, has the wrong
 *    type or is malformed is the requester's error; so is a missing object
 *    of the listed commit's own tree. A submodule whose objects are not all
 *    there is left an empty directory, as git leaves an unpopulated one.
 * 3. The verified blobs, the runner's own trees of the whole tree
 *    (submodules' files as ordinary paths) and its root commit go into
 *    /work/.git as packs the runner writes (`git index-pack --stdin`: git
 *    stores the bytes and judges no path); git must then agree on the
 *    commit and tree ids, and read-tree builds the index from that commit
 *    (where git's own path rules apply: a path it refuses is the
 *    requester's error).
 * 4. Every tracked path is replaced, never written through: each directory
 *    on the way to a tracked path must be a real directory (a symbolic link,
 *    file or anything else there is removed and a directory made, from
 *    the top down), whatever sits at the tracked path itself is removed (a
 *    directory with all it holds included), and git checks the files out
 *    into the now empty places. Untracked and ignored files (installed
 *    dependencies, out/, cache/) stay as the image built them, unless one
 *    sits at a tracked path or on the way to one.
 * 5. How many tracked paths the image had differently, which submodules were
 *    left empty and how many `.git` entries were dropped are recorded
 *    (facts.checkout), never judged.
 */

const { ABSTAIN, Abstain, RequesterError } = require('./result');
const { git, GIT_DIR, STAGE_DIR, WORK_TREE, COMMIT_IDENT, COMMIT_DATE, hermetic } = require('./git');
const {
  algorithmOf, hashObject, parseCommitTree, parseTree, treeObjects, BatchReader, packObjects, commitObject, KIND
} = require('./objects');

/** Where the env image keeps the repository checkout (README, "What the env image must provide"). */
const IMAGE_CHECKOUT = '/repo';
const LISTS_DIR = `${GIT_DIR}/vcr-lists`;
const REF = 'refs/heads/main';

/** Bounds on what the checkout reads and writes (the work tree is a 1 GiB tmpfs). */
const LIMITS = Object.freeze({
  treeBytes: 64 * 1024 * 1024,
  checkoutBytes: 512 * 1024 * 1024,
  batchBytes: 32 * 1024 * 1024,
  entries: 200000,
  depth: 128,
  // Below PATH_MAX (4096) with room for the scripts' "./" and git's own prefixes.
  pathBytes: 4000,
  linkBytes: 4095
});
const TIMEOUT_MS = 120000;
const MAX_LISTED = 100;

/** The repository's highest-precedence attributes: no filter, conversion, ident or driver, ever. */
const NEUTRAL_ATTRIBUTES = '* !filter !diff !merge !text !crlf !eol !ident !working-tree-encoding';

const ENTRY_NAME = '.git';

/**
 * Copies the image's files into /work and its object files into the staging
 * store; writes the fresh repository's attributes. $1 /repo, $2 the staging
 * objects directory, $3 the attributes, $4 the fresh repository's info
 * directory, $5 the lists directory. Not copied: `.git` entries (at any
 * depth), device nodes, sockets and named pipes (none holds a file's bytes,
 * and a pipe git or a build opened, such as a `.gitattributes`, would block
 * it). Object files are copied each with its own bytes (a hard link is read
 * as the file it is, never re-linked to another store's copy), in byte
 * order within each store and across stores, the first copy of a name kept.
 * Prints `vcr-git-entries <n>`, the number
 * of `.git` entries the image had (not copied). A pipeline's status is read
 * from every command in it (`5>&1 >&2`: each failure names itself on fd 5).
 * Exit 10: no checkout; 12: the files could not be copied (unreadable, or
 * larger than the work tree); 13: the object files could not be read; 14:
 * the runner's own directories could not be written.
 */
const STAGE_SCRIPT = [
  'set -u',
  'src=$1 objects=$2 attrs=$3 info=$4 lists=$5',
  'mkdir -p "$info" "$lists" "$objects/pack" && printf "%s\\n" "$attrs" > "$info/attributes" || exit 14',
  '[ -d "$src" ] || exit 10',
  'cd "$src" || exit 10',
  `bad=$( { { find . -mindepth 1 \\( -name ${ENTRY_NAME} -o -type b -o -type c -o -type s -o -type p \\) -prune -o -print0 || echo find >&5; } \\`,
  '  | { tar --null --verbatim-files-from --no-recursion -T - -cf - || echo tar >&5; } \\',
  '  | { tar -xpf - -C /work || echo untar >&5; }; } 5>&1 >&2 )',
  '[ -z "$bad" ] || exit 12',
  `n=$(find . -name ${ENTRY_NAME} -prune -printf x | wc -c) || exit 13`,
  'printf "vcr-git-entries %s\\n" "$n"',
  `bad=$( { { find . -type d -name objects -path '*/${ENTRY_NAME}/*' -prune -print0 || echo find >&5; } \\`,
  '  | { LC_ALL=C sort -z || echo sort >&5; } \\',
  '  | { xargs -0 -r sh -c \'',
  '      objects=$1; shift',
  '      for d; do',
  '        bad=$( { { cd "$d" && find . -mindepth 2 -maxdepth 2 -type f \\( -path "./[0-9a-f][0-9a-f]/*" -o -path "./pack/pack-*.pack" -o -path "./pack/pack-*.idx" \\) -print0 || echo find >&5; } \\',
  '          | { sort -z || echo sort >&5; } \\',
  '          | { cd "$d" && tar --null --verbatim-files-from --no-recursion --hard-dereference -T - -cf - || echo tar >&5; } \\',
  '          | { tar -xf - -C "$objects" --skip-old-files || echo untar >&5; }; } 5>&1 >&2 )',
  '        [ -z "$bad" ] || exit 1',
  '      done\' vcr-harvest "$objects" || echo harvest >&5; }; } 5>&1 >&2 )',
  '[ -z "$bad" ] || exit 13',
  'exit 0'
].join('\n');

/**
 * Makes each directory on stdin (NUL-separated, relative to /work, parents
 * first) a real directory the sandbox user can use: one there is kept (its
 * mode made u+rwx if it lacked that), anything else there (a symbolic link,
 * file, pipe, device node) is removed, never followed, and a directory made.
 * Builtins decide; rm and mkdir run only for a directory it has to make.
 * Prints each one it made, NUL-terminated. Exit 4: one could not be made.
 */
const DIRS_SCRIPT = [
  'cd /work || exit 3',
  'xargs -0 -r sh -c \'',
  '  for d; do',
  '    d=./$d',
  '    if [ -d "$d" ] && [ ! -L "$d" ]; then',
  '      { [ -r "$d" ] && [ -w "$d" ] && [ -x "$d" ]; } || chmod u+rwx -- "$d" || exit 1',
  '      continue',
  '    fi',
  '    if [ -e "$d" ] || [ -L "$d" ]; then rm -f -- "$d" || exit 1; fi',
  '    mkdir -- "$d" || exit 1',
  '    printf "%s\\0" "$d"',
  '  done\' vcr-dirs || exit 4',
  'exit 0'
].join('\n');

/**
 * Removes whatever sits at each path on stdin (NUL-separated, relative to
 * /work, every directory on the way already real): a file, a symbolic link
 * (not what it points to), a pipe, a directory with all it holds. Then
 * checks, with builtins, that nothing is left, retrying one with its
 * permissions opened (never through a symbolic link). $1 the list file.
 * Exit 5: a path could not be cleared.
 */
const CLEAR_SCRIPT = [
  'list=$1',
  'cd /work && cat > "$list" || exit 3',
  'xargs -0 -r -a "$list" rm -rf -- 2>/dev/null',
  'xargs -0 -r -a "$list" sh -c \'',
  '  for p; do',
  '    p=./$p',
  '    { [ -e "$p" ] || [ -L "$p" ]; } || continue',
  '    { [ -L "$p" ] || chmod -R u+rwx -- "$p"; } && rm -rf -- "$p" || exit 1',
  '    { [ -e "$p" ] || [ -L "$p" ]; } && exit 1',
  '  done\' vcr-clear || exit 5',
  'exit 0'
].join('\n');

/** Removes the staging store and the lists: /work then holds one repository, the runner's. */
const UNSTAGE_SCRIPT = 'rm -rf -- "$1" "$2" || exit 1';

/** NUL-separated paths as they stream: counts them, keeps the first `max` (byte strings). */
class PathList {
  constructor(max) {
    this.max = max;
    this.paths = [];
    this.count = 0;
    this.partial = [];
  }

  write(chunk) {
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    for (let nul = buf.indexOf(0); nul >= 0; nul = buf.indexOf(0)) {
      if (this.paths.length < this.max) this.paths.push(Buffer.concat([...this.partial, buf.subarray(0, nul)]).toString('latin1'));
      this.partial = [];
      this.count += 1;
      buf = buf.subarray(nul + 1);
    }
    if (buf.length && this.paths.length < this.max && this.partial.reduce((n, b) => n + b.length, 0) < 8192) this.partial.push(Buffer.from(buf));
    return true;
  }
}

const zList = (paths) => Buffer.from(paths.map((p) => `${p}\0`).join(''), 'latin1');
/** A byte-string path as the report shows it. */
const shown = (p) => Buffer.from(p, 'latin1').toString('utf8');
const quoted = (p) => JSON.stringify(shown(p).slice(0, 300));
const firstLine = (text) => {
  const line = String(text || '').split(/\r?\n/).find((l) => l.trim());
  return line ? line.trim().slice(0, 300) : '';
};

function chainMissing(module) {
  for (let m = module; m; m = m.parent) if (m.missing) return true;
  return false;
}

/**
 * Force /work to the listed commit. Throws RequesterError (the image) or
 * Abstain; returns { commit, tree } of the fresh repository's commit, and
 * `objects` (every object it holds, id → size).
 * @param {object} ctx - the pipeline's step context
 * @param {{base:string}} o - the listed commit
 */
async function forceCheckout(ctx, { base }) {
  const algo = algorithmOf(base);
  const image = '/spec/env/image';
  const requester = (code, path, detail) => new RequesterError([{ code, path, detail }]);
  const missing = (detail) => requester('IMAGE_OBJECTS_MISSING', image, `${detail}; the env image must hold the listed commit's objects in a .git directory under ${IMAGE_CHECKOUT}`);
  const invalid = (detail) => requester('IMAGE_OBJECT_INVALID', image, detail);
  const tooLarge = (detail) => requester('IMAGE_CHECKOUT_TOO_LARGE', image, detail);
  const runnerError = (step, detail) => new Abstain(ABSTAIN.RUNNER_ERROR, detail, { step });

  async function exec(name, argv, o = {}) {
    return ctx.exec(argv, { name, timeoutMs: TIMEOUT_MS, ...o });
  }

  // 1. The two fresh repositories, then the image's files and object files.
  for (const [name, gitDir, bare] of [['prepare:init', GIT_DIR, false], ['prepare:init:stage', STAGE_DIR, true]]) {
    const r = await exec(name, git(['init', '--quiet', ...(bare ? ['--bare'] : []), '--template=', `--object-format=${algo}`, '--initial-branch=main'], { gitDir }));
    // 126/127: the launcher ran, and found no /usr/bin/env or git to run (README: the env image provides them).
    if (r.exitCode === 126 || r.exitCode === 127) throw requester('IMAGE_TOOL_MISSING', image, `the env image cannot run /usr/bin/env and git (exit ${r.exitCode}): ${firstLine(r.stderr.text)}`);
    if (r.exitCode !== 0) throw runnerError(name, `git could not make a repository: ${firstLine(r.stderr.text)}`);
  }
  const stage = await exec('prepare:copy', hermetic(STAGE_SCRIPT, 'vcr-stage', [IMAGE_CHECKOUT, `${STAGE_DIR}/objects`, NEUTRAL_ATTRIBUTES, `${GIT_DIR}/info`, LISTS_DIR]));
  switch (stage.exitCode) {
    case 0: break;
    case 10: throw requester('IMAGE_CHECKOUT_MISSING', image, `the env image has no repository checkout at ${IMAGE_CHECKOUT}`);
    case 12: throw requester('IMAGE_CHECKOUT_UNREADABLE', image,
      `the checkout could not be copied into the work tree as uid 10001 (unreadable, or larger than the work tree): ${firstLine(stage.stderr.text)}`);
    case 13: throw requester('IMAGE_CHECKOUT_UNREADABLE', image,
      `the checkout's git objects could not be copied for reading as uid 10001 (unreadable, or larger than the work tree): ${firstLine(stage.stderr.text)}`);
    default: throw runnerError('prepare:copy', `the checkout copy exited ${stage.exitCode}: ${firstLine(stage.stderr.text)}`);
  }
  const counted = /^vcr-git-entries ([0-9]+)$/m.exec(stage.stdout.text);
  if (!counted) throw runnerError('prepare:copy', 'the checkout copy did not count the image\'s .git entries');
  const gitEntries = Number(counted[1]);

  // 2. The objects, re-hashed here.
  let treeBudget = LIMITS.treeBytes;
  async function read(name, ids, { check = false, maxObjectBytes, maxTotalBytes }) {
    const reader = new BatchReader({ algo, check, maxObjectBytes, maxTotalBytes });
    const r = await exec(name, git(['cat-file', check ? '--batch-check' : '--batch'], { gitDir: STAGE_DIR }), {
      stdin: Buffer.from(ids.map((id) => `${id}\n`).join('')), tee: reader
    });
    if (r.exitCode !== 0) throw invalid(`git could not read the env image's objects (a corrupt object or pack): ${firstLine(r.stderr.text)}`);
    const out = reader.finish();
    if (!out.ok) throw runnerError(name, `git's object output could not be read: ${out.reason}`);
    if (out.records.length !== ids.length || out.records.some((rec, i) => rec.id !== ids[i])) throw runnerError(name, 'git did not answer for every object asked');
    const got = new Map();
    for (const rec of out.records) {
      if (!check && !rec.missing) {
        if (rec.content === null) throw tooLarge(`the object ${rec.id} is ${rec.size} bytes, more than the checkout can hold`);
        // The runner's own check: an object is what hashes to its id, whatever the store says.
        if (hashObject(algo, rec.type, rec.content) !== rec.id) {
          throw invalid(`the object ${rec.id} in the env image does not hash to its id (a corrupt or forged object)`);
        }
      }
      got.set(rec.id, rec);
    }
    return got;
  }
  async function readTrees(name, ids) {
    const got = await read(name, ids, { maxObjectBytes: treeBudget, maxTotalBytes: treeBudget });
    for (const rec of got.values()) if (!rec.missing) treeBudget -= rec.size;
    return got;
  }

  /** Store verified objects in the fresh repository: git computes their ids itself and judges no path. */
  async function importPack(name, objects) {
    const r = await exec(name, git(['index-pack', '--stdin']), { stdin: packObjects(algo, objects) });
    if (r.exitCode !== 0) throw runnerError(name, `git could not store the runner's pack: ${firstLine(r.stderr.text)}`);
  }

  const commit = (await readTrees('prepare:objects:1', [base])).get(base);
  if (commit.missing) throw missing(`the env image holds no object for the listed commit ${base}`);
  if (commit.type !== 'commit') throw invalid(`the listed commit ${base} is a ${commit.type} in the env image`);
  const rootTree = parseCommitTree(commit.content, algo);
  if (!rootTree) throw invalid(`the listed commit ${base} has no tree line`);

  const root = { path: null, parent: null, missing: false };
  const modules = [];
  const files = [];
  const parsed = new Map();
  let trees = [{ id: rootTree, prefix: '', module: root, depth: 0 }];
  let links = [];
  let entries = 0;
  for (let round = 2; trees.length || links.length; round += 1) {
    trees = trees.filter((t) => !chainMissing(t.module));
    links = links.filter((l) => !chainMissing(l.module));
    const want = [...new Set([...trees.map((t) => t.id).filter((id) => !parsed.has(id)), ...links.map((l) => l.id)])].sort();
    const got = want.length ? await readTrees(`prepare:objects:${round}`, want) : new Map();
    const nextTrees = [];
    const nextLinks = [];
    for (const l of links) {
      const rec = got.get(l.id);
      const m = { path: l.path, parent: l.module, missing: false };
      modules.push(m);
      if (rec.missing) { m.missing = true; continue; }
      if (rec.type !== 'commit') throw invalid(`the submodule at ${quoted(l.path)} records ${l.id}, a ${rec.type} in the env image, not a commit`);
      const t = parseCommitTree(rec.content, algo);
      if (!t) throw invalid(`the commit ${l.id} (the submodule at ${quoted(l.path)}) has no tree line`);
      nextTrees.push({ id: t, prefix: `${l.path}/`, module: m, depth: l.depth });
    }
    for (const t of trees) {
      let list = parsed.get(t.id);
      const where = t.prefix ? `at ${quoted(t.prefix.slice(0, -1))}` : 'at the top';
      if (!list) {
        const rec = got.get(t.id);
        if (rec.missing) {
          if (t.module === root) throw missing(`the env image holds no object for the listed commit's tree ${t.id} ${where}`);
          t.module.missing = true;
          continue;
        }
        if (rec.type !== 'tree') throw invalid(`the object ${t.id} ${where} is a ${rec.type} in the env image, not a tree`);
        const p = parseTree(rec.content, algo);
        if (!p.ok) throw invalid(`the tree ${t.id} ${where} has ${p.reason}`);
        list = p.entries;
        parsed.set(t.id, list);
      }
      if (chainMissing(t.module)) continue;
      for (const e of list) {
        entries += 1;
        if (entries > LIMITS.entries) throw tooLarge(`the listed commit has more than ${LIMITS.entries} entries (submodules included)`);
        const path = t.prefix + e.name;
        if (path.length > LIMITS.pathBytes) throw invalid(`a path longer than ${LIMITS.pathBytes} bytes: ${quoted(path)}`);
        if (e.kind === KIND.tree || e.kind === KIND.gitlink) {
          if (t.depth + 1 > LIMITS.depth) throw tooLarge(`the listed commit nests directories more than ${LIMITS.depth} deep: ${quoted(path)}`);
          (e.kind === KIND.tree ? nextTrees : nextLinks).push({ id: e.id, prefix: `${path}/`, path, module: t.module, depth: t.depth + 1 });
        } else {
          files.push({ path, kind: e.kind, id: e.id, module: t.module });
        }
      }
    }
    trees = nextTrees;
    links = nextLinks;
  }

  // Every blob's type and size first (a missing one empties its submodule), then the content.
  let live = files.filter((f) => !chainMissing(f.module));
  const blobIds = [...new Set(live.map((f) => f.id))].sort();
  const info = blobIds.length ? await read('prepare:objects:sizes', blobIds, { check: true }) : new Map();
  for (const f of live) {
    const rec = info.get(f.id);
    if (rec.missing) {
      if (f.module === root) throw missing(`the env image holds no object for ${quoted(f.path)} (blob ${f.id}) of the listed commit`);
      f.module.missing = true;
    } else if (rec.type !== 'blob') {
      throw invalid(`${quoted(f.path)} records ${f.id}, a ${rec.type} in the env image, not a blob`);
    }
  }
  live = files.filter((f) => !chainMissing(f.module));
  const needed = [...new Set(live.map((f) => f.id))].sort();
  // What the work tree will hold: every path's bytes (one blob at many paths is written many times).
  const total = live.reduce((n, f) => n + info.get(f.id).size, 0);
  if (total > LIMITS.checkoutBytes) throw tooLarge(`the listed commit's files are ${total} bytes; the checkout holds at most ${LIMITS.checkoutBytes}`);
  const links120 = new Map(live.filter((f) => f.kind === KIND.link).map((f) => [f.id, f.path]));

  // 3. The verified blobs into the fresh repository, a batch at a time.
  for (let i = 0, batch = 1; i < needed.length; batch += 1) {
    const ids = [];
    let bytes = 0;
    while (i < needed.length && (ids.length === 0 || bytes + info.get(needed[i]).size <= LIMITS.batchBytes)) {
      bytes += info.get(needed[i]).size;
      ids.push(needed[i]);
      i += 1;
    }
    const got = await read(`prepare:blobs:${batch}`, ids, { maxObjectBytes: LIMITS.checkoutBytes, maxTotalBytes: bytes });
    const contents = ids.map((id) => {
      const rec = got.get(id);
      if (rec.missing || rec.type !== 'blob') throw invalid(`the object ${id} changed between two reads of the env image's store`);
      const link = links120.get(id);
      if (link !== undefined && (rec.content.length === 0 || rec.content.length > LIMITS.linkBytes || rec.content.includes(0))) {
        throw invalid(`the symbolic link ${quoted(link)} has a target Linux cannot hold (empty, a NUL byte, or more than ${LIMITS.linkBytes} bytes)`);
      }
      return rec.content;
    });
    await importPack(`prepare:import:${batch}`, contents.map((content) => ({ type: 'blob', content })));
  }
  // The runner's own trees and root commit (the submodules' files as ordinary paths), then the branch.
  live.sort((a, b) => (a.path < b.path ? -1 : 1));
  const built = treeObjects(live, algo);
  const commitContent = commitObject({ tree: built.id, ident: COMMIT_IDENT, date: COMMIT_DATE, message: `listed commit ${base}\n` });
  const prepared = hashObject(algo, 'commit', commitContent);
  await importPack('prepare:commit', [...[...built.objects.values()].map((content) => ({ type: 'tree', content })), { type: 'commit', content: commitContent }]);
  const ref = await exec('prepare:ref', git(['update-ref', REF, prepared]));
  if (ref.exitCode !== 0) throw runnerError('prepare:ref', `the fresh repository's branch could not be set: ${firstLine(ref.stderr.text)}`);
  // And git agrees: the branch holds the runner's commit, of the runner's tree.
  const head = await exec('prepare:head', git(['rev-parse', `${REF}^{commit}`, `${REF}^{tree}`]));
  const [got, tree] = head.stdout.text.split('\n');
  if (head.exitCode !== 0 || got !== prepared || tree !== built.id) {
    throw runnerError('prepare:head', `the fresh repository holds ${String(got).slice(0, 64)} of ${String(tree).slice(0, 64)}, not the runner's ${prepared} of ${built.id}`);
  }
  const index = await exec('prepare:index', git(['read-tree', prepared]));
  if (index.exitCode !== 0) throw invalid(`the listed commit has a path git will not check out: ${firstLine(index.stderr.text)}`);

  // 4. The work tree: real directories on the way, what the image had there counted, every tracked path replaced.
  const empty = modules.filter((m) => m.missing && !chainMissing(m.parent)).map((m) => m.path).sort();
  const dirs = new Set();
  for (const p of [...live.map((f) => f.path), ...empty]) {
    for (let k = p.indexOf('/'); k >= 0; k = p.indexOf('/', k + 1)) dirs.add(p.slice(0, k));
  }
  const parents = [...dirs].sort();
  const made = new PathList(0);
  const d1 = await exec('prepare:dirs', hermetic(DIRS_SCRIPT, 'vcr-dirs'), { stdin: zList(parents), tee: made });
  if (d1.exitCode !== 0) throw runnerError('prepare:dirs', `a directory on the way to a tracked path could not be made: ${firstLine(d1.stderr.text)}`);
  await exec('prepare:refresh', git(['update-index', '-q', '--refresh']));
  const differ = new PathList(MAX_LISTED);
  const diff = await exec('prepare:compare', git(['diff-files', '--name-only', '-z']), { tee: differ });
  if (diff.exitCode !== 0) throw runnerError('prepare:compare', `the image's tracked files could not be compared: ${firstLine(diff.stderr.text)}`);
  const cleared = await exec('prepare:clear', hermetic(CLEAR_SCRIPT, 'vcr-clear', [`${LISTS_DIR}/clear`]), { stdin: zList([...live.map((f) => f.path), ...empty]) });
  if (cleared.exitCode !== 0) throw runnerError('prepare:clear', `a tracked path could not be cleared: ${firstLine(cleared.stderr.text)}`);
  if (empty.length) {
    const d2 = await exec('prepare:empty', hermetic(DIRS_SCRIPT, 'vcr-dirs'), { stdin: zList(empty) });
    if (d2.exitCode !== 0) throw runnerError('prepare:empty', `an empty submodule directory could not be made: ${firstLine(d2.stderr.text)}`);
  }
  const written = await exec('prepare:write', git(['checkout-index', '--all', '--index']));
  if (written.exitCode !== 0) throw runnerError('prepare:write', `git could not write the listed commit's files: ${firstLine(written.stderr.text)}`);
  const check = await exec('prepare:verify', git(['diff-files', '--quiet']));
  if (check.exitCode !== 0) throw runnerError('prepare:verify', 'the work tree does not hold the listed commit\'s files after the checkout');
  const unstaged = await exec('prepare:unstage', hermetic(UNSTAGE_SCRIPT, 'vcr-unstage', [STAGE_DIR, LISTS_DIR]));
  if (unstaged.exitCode !== 0) throw runnerError('prepare:unstage', `the staging store could not be removed: ${firstLine(unstaged.stderr.text)}`);

  // 5. Facts, not gates.
  ctx.fact('checkout', {
    commit: prepared,
    tree,
    paths: live.length,
    corrected: differ.count,
    correctedPaths: differ.paths.map(shown),
    directoriesMade: made.count,
    emptySubmodules: empty.slice(0, MAX_LISTED).map(shown),
    gitRemoved: gitEntries > 0,
    gitEntriesRemoved: gitEntries
  });
  // Every object the fresh repository holds, id → size: what a binary patch could name as its postimage (patch.js).
  const objects = new Map(needed.map((id) => [id, info.get(id).size]));
  for (const [id, content] of built.objects) objects.set(id, content.length);
  objects.set(prepared, commitContent.length);
  return { commit: prepared, tree, objects };
}

module.exports = {
  forceCheckout, IMAGE_CHECKOUT, NEUTRAL_ATTRIBUTES, STAGE_SCRIPT, DIRS_SCRIPT, CLEAR_SCRIPT, UNSTAGE_SCRIPT, LIMITS, LISTS_DIR, PathList, WORK_TREE
};
