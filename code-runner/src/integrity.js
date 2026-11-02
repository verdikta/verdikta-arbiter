'use strict';

/**
 * The integrity checks on tier-B evidence (design §9.5, §20 decision 6;
 * node A3a). gVisor separates the sandbox from the host, not the grader from
 * the program inside it: forge, which writes the JUnit, runs the claim's
 * code as the same user. So every result a PoC run reports is trusted only
 * when all five checks pass, each measured by the runner from outside the
 * tested process wherever it can be:
 *
 * 1. identity completeness: every test the patch added has exactly one
 *    record on every run, none skipped (for the fix check, every baseline
 *    `stable` identity too);
 * 2. framework-summary consistency: forge's own summary of each suite
 *    (`Suite result: ok|FAILED. P passed; F failed; S skipped`, which forge
 *    1.8.5 writes into the suite's <system-out>) and the counts on
 *    <testsuite> and <testsuites> agree with the records;
 * 3. exit-code consistency: the test command exits non-zero exactly when the
 *    JUnit records a failure; an exit 0 without forge's JUnit (or with an
 *    unreadable one) is an exit before forge's report;
 * 4. post-run checksums, read once every claim process is dead: the watched
 *    files hash the same after each run as in the image plus the accepted
 *    patch (`protectedPathsUnchanged`, `frameworkUnchanged`,
 *    `dependenciesUnchanged`; below);
 * 5. static tamper flags on the patch's added lines (tamperFlags()).
 *
 * What is watched (classify()), every file and link with its type, mode,
 * size and SHA-256 (or target):
 *
 * - protected: work-tree paths matching paths.protected, tracked or not,
 *   and the runner's own repository (/work/.git: its config, attributes,
 *   index and objects decide what the reset between runs writes);
 * - dependencies: everything under forge's `libs` (from `forge config`),
 *   `node_modules/` and `dependencies/` (Soldeer);
 * - framework: forge's executable (`command -v forge`, its path and, when it
 *   lives in the work tree, its bytes), forge's resolved configuration
 *   (`forge config --json`, run as every maker command runs forge: the same
 *   argv builder, environment and directory, forge.forgeArgv; it sees
 *   foundry.toml, remappings, .env and the global ~/.foundry/foundry.toml
 *   alike), the root
 *   config files themselves, $HOME but its caches (~/.foundry/cache,
 *   ~/.cache), the PATH directories inside the work tree, solc when it is in
 *   the work tree, forge-std under the dependencies (the assertion library,
 *   forge's "reporter module"), and the build's artifacts (`out`, and forge's
 *   compile cache, which names the artifact files a later run loads), which
 *   may change during the first test run (forge compiles what the build left
 *   out) and never after it.
 *
 * Symbolic links in those sets (watchLinks(); attempt 2 of R6-F1/R7-F1): the
 * listing is physical (find never follows a link), so a file listed in a set
 * is reached through real directories only, and a write to it changes its
 * hash. The ways to reach other bytes through a watched path are a link in
 * the set and a link on the way to a set's root (watchRoots). Each one is
 * resolved by the kernel inside the sandbox (LINKS_SCRIPT: `cd -P`,
 * `realpath -e`; the runner never computes a path from a link's text), its
 * answer is part of its own entry (so a link on the way retargeted is a
 * change), and what it leads to joins its set, transitively. A watched link
 * whose real target is in, or holds, a place builds and runs write to (/tmp,
 * $HOME, the work tree's root, the runner's repository, forge's out, cache,
 * broadcast and snapshots directories, paths.tests) is refused
 * (IMAGE_WATCH_LINK_UNCOVERED), as is one leading to a directory outside the
 * work tree (not listed, so its own links are unseen); a file on the
 * read-only root needs nothing watched. Links outside the sets are not
 * followed: what they reach is no more than an untracked file at their own
 * path would be. The work is linear in the listing and capped (MAX_ENTRIES,
 * MAX_WATCHED_LINKS, MAX_LINK_ROUNDS): beyond a cap the image is
 * IMAGE_WATCH_TOO_LARGE. And no configured root is dropped silently
 * (unwatchableRoots, R8-F1): forge's out, cache_path and libs outside the
 * work tree, or solc or a PATH directory where nothing is listed, is
 * IMAGE_WATCH_ROOT_UNCOVERED.
 *
 * Not watched: the rest of forge's cache directory (`cache_path`: the ABI
 * cache, test-failures, fuzz failures, which forge rewrites on every run),
 * the $HOME caches, /tmp, untracked files elsewhere (a state file a PoC
 * writes). Tracked files outside the sets go back to the PoC commit by the
 * runner's reset before each re-run.
 */

const crypto = require('node:crypto');
const { matchesAny, normalizePath } = require('./common');
const { hermetic } = require('./git');
const { Abstain, ABSTAIN, RequesterError } = require('./result');
const { Prefix } = require('./capture');
const forge = require('./forge');

const WORK = '/work';
const HOME = '/home/sandbox';
const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
/** Entries (files, links, anything but a directory) in one listing. */
const MAX_ENTRIES = 1000000;
/** Watched links the kernel is asked about, across a snapshot's rounds. */
const MAX_WATCHED_LINKS = 50000;
/** Levels of linked trees (a link in a tree a link leads to is the next level). */
const MAX_LINK_ROUNDS = 16;
const LINKS_MAX_BYTES = 64 * 1024 * 1024;
const CONFIG_MAX_BYTES = 1024 * 1024;
const SNAPSHOT_TIMEOUT_MS = 120000;
const MAX_CHANGED = 100;

/** The kinds of static tamper flag (the report's TamperFlag kinds, §9.5 check 5). */
const TAMPER_FLAG_KINDS = Object.freeze([
  'report-path-referenced', 'exit-during-import', 'exit-handler-registered', 'framework-patched', 'reporter-patched', 'write-outside-repository'
]);
const MAX_TAMPER_FLAGS = 100;

/** The checks of §9.5, in the order a report names them. */
const CHECKS = Object.freeze([
  'identityComplete', 'summaryConsistent', 'exitConsistent', 'protectedPathsUnchanged', 'frameworkUnchanged', 'dependenciesUnchanged', 'tamperFlags'
]);

/** Root files forge reads as configuration (foundry.toml, remappings, .env, its lock files). */
const FRAMEWORK_FILES = Object.freeze(['foundry.toml', 'remappings.txt', '.env', 'foundry.lock', 'soldeer.lock']);
/** $HOME directories that hold caches, not configuration: forge's own, and the XDG cache directory (ffi helpers' caches). */
const HOME_CACHES = Object.freeze(['~/.foundry/cache', '~/.cache']);
/** Dependency directories forge resolves imports from besides its `libs`. */
const DEPENDENCY_DIRS = Object.freeze(['node_modules', 'dependencies']);

/**
 * The framework probe's discovery (§9.5 check 4, `frameworkUnchanged`), in
 * the image's own environment (its PATH is what it reads): where `forge`
 * resolves, PATH, and the real path of the forge to run. Later probes give
 * the forge the reference found ($1), never one a run may have put on PATH.
 * forge's configuration is read next, by forge itself through forgeArgv
 * (probe()), never by this script.
 */
const FRAMEWORK_SCRIPT = [
  'f=$(command -v forge 2>/dev/null) || f=',
  'printf "vcr-forge %s\\n" "$f"',
  'printf "vcr-path %s\\n" "$PATH"',
  'x=${1:-$f}',
  '[ -n "$x" ] || exit 3',
  // Where the forge to run really is (a link into the work tree is the work tree's file): coreutils by absolute path.
  'r=$x; [ -x /usr/bin/readlink ] && r=$(/usr/bin/readlink -f -- "$x" 2>/dev/null) || r=$x',
  'printf "vcr-real %s\\n" "$r"'
].join('\n');

/**
 * The manifest of the watched trees, hermetic (nothing of the image's
 * environment): GNU find's records of every entry that is not a directory,
 * and of every directory it cannot list or enter (type, mode, size, path, link
 * target, NUL-separated), a marker, then sha256sum -z's line for every
 * regular file. "$@" is find's start: the roots, -xdev and the prune
 * expression the runner builds. Errors are never fatal. What the listing
 * cannot read (a file with no hash line, a directory that hides what is under
 * it) has nothing to compare, so in a watched set it never counts as
 * unchanged (changedPaths, R13-F1); at the reference it is the image's error.
 */
const MANIFEST_SCRIPT = [
  'find "$@" \\( ! -type d -o ! -readable -o ! -executable \\) -printf "%y\\0%m\\0%s\\0%p\\0%l\\0" 2>/dev/null',
  'printf "vcr-hashes\\0"',
  'find "$@" -type f -print0 2>/dev/null | xargs -0 -r sha256sum -z -- 2>/dev/null',
  'exit 0'
].join('\n');

/**
 * The kernel's answer for each watched link, hermetic: absolute paths on
 * stdin (NUL-separated), one `kind\0path\0real\0` record each, in order.
 * `d`: the link leads to a directory, `real` its physical path (the kernel
 * walks it in `cd -P`; `$PWD` is then getcwd's answer). `f`: to anything
 * else that exists, `real` from `realpath -e` (GNU coreutils, component by
 * component). `?`: the kernel resolves it to nothing (missing, a loop, a file
 * used as a directory, no search permission). `!`: the kernel found an entry
 * but its physical path could not be read (realpath failed, or getcwd did).
 * Every path is resolved from /work, forge's own directory (a
 * /proc/self/cwd on the way means the same as it does to forge). The script
 * reads no link's text itself. Exit 4: the image has no realpath.
 */
const LINKS_SCRIPT = [
  'command -v realpath >/dev/null 2>&1 || exit 4',
  'exec xargs -0 -r sh -c \'',
  '  home() { cd /work 2>/dev/null || cd /; }',
  '  home',
  '  nl=$(printf "\\nx"); nl=${nl%x}',
  '  for l do',
  '    if [ -d "$l" ]; then',
  '      if cd -P -- "$l" 2>/dev/null; then',
  '        case $PWD in /*) printf "d\\0%s\\0%s\\0" "$l" "$PWD" ;; *) printf "!\\0%s\\0\\0" "$l" ;; esac',
  '        home',
  '      else',
  '        printf "?\\0%s\\0\\0" "$l"',
  '      fi',
  '    elif [ -e "$l" ]; then',
  '      if r=$(realpath -e -- "$l" 2>/dev/null && printf x); then r=${r%x}; r=${r%"$nl"}; printf "f\\0%s\\0%s\\0" "$l" "$r"; else printf "!\\0%s\\0\\0" "$l"; fi',
  '    else',
  '      printf "?\\0%s\\0\\0" "$l"',
  '    fi',
  '  done\' vcr-resolve'
].join('\n');

/** Thrown when what the check would watch is over one of its caps (IMAGE_WATCH_TOO_LARGE before claim code, a failure after). */
class WatchTooLarge extends Error {}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** A path argument for find's -path: its glob characters escaped. */
function globLiteral(p) {
  return p.replace(/[\\*?[\]]/g, '\\$&');
}

/** A repository-relative directory a config names (`out`, `cache_path`, a lib): a plain relative path, or null. */
function plainDir(value) {
  if (typeof value !== 'string') return null;
  let v = value;
  if (v.startsWith(`${WORK}/`)) v = v.slice(WORK.length + 1);
  v = v.replace(/^\.\//, '').replace(/\/+$/, '');
  if (v === '' || v.startsWith('/') || /[\u0000-\u001f]/.test(v)) return null;
  if (v.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
  return v;
}

function under(p, dir) {
  return p === dir || p.startsWith(`${dir}/`);
}

/** The display form of a watched path (its UTF-8 reading; paths are kept as bytes in latin1). */
function displayPath(key) {
  return Buffer.from(key, 'latin1').toString('utf8');
}

/**
 * Read the framework probe's output.
 * @param {Buffer} buf
 * @returns {{ok:true, forgePath:string, path:string, pathDirs:string[], configSha256:string, config:{out:string|null, cachePath:string|null, libs:string[], solc:string|null}} | {ok:false, reason:string, forgePath?:string}}
 */
function parseFramework(buf) {
  const text = buf.toString('utf8');
  const m = /^vcr-forge ([^\n]*)\nvcr-path ([^\n]*)\n(?:vcr-real ([^\n]*)\n)?/.exec(text);
  if (!m) return { ok: false, reason: 'the framework probe printed no forge path' };
  const forgePath = m[1];
  const realPath = m[3] !== undefined ? m[3] : forgePath;
  // PATH as the shell reads it, from the maker's commands' directory (/work): an empty entry or `.` is that directory,
  // a relative one lies under it, and only an actual `./` prefix is stripped (`.bin` stays `.bin`; R11-F2).
  const pathDirs = m[2].split(':').map((d) => {
    if (d.startsWith('/')) return d.replace(/\/+$/, '') || '/';
    let rel = d;
    while (rel.startsWith('./')) rel = rel.slice(2).replace(/^\/+/, '');
    rel = rel.replace(/\/+$/, '');
    return rel === '' || rel === '.' ? WORK : `${WORK}/${rel}`;
  });
  const configText = buf.subarray(Buffer.byteLength(m[0])).toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(configText);
  } catch (_) {
    return { ok: false, reason: '`forge config --json` printed no JSON', forgePath, realPath };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: '`forge config --json` printed no object', forgePath };
  const str = (v) => (typeof v === 'string' ? v : null);
  return {
    ok: true,
    forgePath,
    realPath,
    path: m[2],
    pathDirs,
    configSha256: sha256(buf.subarray(Buffer.byteLength(m[0]))),
    config: {
      out: str(parsed.out),
      cachePath: str(parsed.cache_path),
      libs: Array.isArray(parsed.libs) ? parsed.libs.filter((l) => typeof l === 'string') : [],
      solc: str(parsed.solc),
      broadcast: str(parsed.broadcast),
      snapshots: str(parsed.snapshots)
    }
  };
}

/**
 * Read the manifest: find's records, then sha256sum's lines.
 * @param {Buffer} buf
 * @param {{maxEntries?:number}} [o] - more records than this is `tooLarge` (default MAX_ENTRIES), read no further
 * @returns {{ok:true, entries:Map<string, {type:string, mode:string, size:string, target:string, hash:string|null}>} | {ok:false, reason:string, tooLarge?:true}}
 *   keys are absolute paths, as bytes read latin1
 */
function parseManifest(buf, { maxEntries = MAX_ENTRIES } = {}) {
  const marker = Buffer.from('vcr-hashes\0');
  const entries = new Map();
  let pos = 0;
  const field = () => {
    const end = buf.indexOf(0, pos);
    if (end < 0) return null;
    const s = buf.toString('latin1', pos, end);
    pos = end + 1;
    return s;
  };
  for (;;) {
    if (pos >= buf.length) return { ok: false, reason: 'the listing has no hash section' };
    if (buf.length - pos >= marker.length && buf.subarray(pos, pos + marker.length).equals(marker)) {
      pos += marker.length;
      break;
    }
    const type = field();
    const mode = field();
    const size = field();
    const p = field();
    const target = field();
    if (target === null) return { ok: false, reason: 'a listing record ends early' };
    if (!/^[a-zA-Z]$/.test(type) || !/^[0-7]{1,6}$/.test(mode) || !/^[0-9]+$/.test(size) || !p.startsWith('/')) {
      return { ok: false, reason: 'a listing record is not find\'s' };
    }
    entries.set(p, { type, mode, size, target: type === 'l' ? target : '', hash: null });
    if (entries.size > maxEntries) return { ok: false, tooLarge: true, reason: `the listing has more than ${maxEntries} entries` };
  }
  while (pos < buf.length) {
    const end = buf.indexOf(0, pos);
    if (end < 0) return { ok: false, reason: 'a hash line without its end' };
    const line = buf.toString('latin1', pos, end);
    pos = end + 1;
    const h = /^([0-9a-f]{64}) [ *]([\s\S]+)$/.exec(line);
    if (!h) return { ok: false, reason: 'a hash line that is not sha256sum\'s' };
    const e = entries.get(h[2]);
    if (e && e.type === 'f') e.hash = h[1];
  }
  return { ok: true, entries };
}

/**
 * One watched entry, as compared: type, mode, size, and the hash (a file;
 * `unreadable` when it could not be hashed) or the target. The only directories
 * a listing holds are the ones it could not read.
 */
function describe(e) {
  const what = e.type === 'f' ? (e.hash || 'unreadable') : e.type === 'd' ? 'unreadable' : e.type === 'l' ? `-> ${e.target}` : '';
  return `${e.type} ${e.mode} ${e.size} ${what}`;
}

/** Whether a description is of something the listing could not read (never a link, whatever its target says). */
function isUnreadable(description) {
  return /^[fd] \S+ \S+ unreadable$/.test(description);
}

/** What the listing could not read across a snapshot's sets, in the manifest's byte form, sorted. */
function unreadablePaths(sets) {
  const out = new Set();
  for (const set of Object.values(sets)) for (const [p, d] of set) if (isUnreadable(d)) out.add(p);
  return [...out].sort();
}

/**
 * The work-tree paths the sets are rooted at, from the reference's forge
 * config, forge's path and PATH, in the manifest's byte form (its keys are
 * the paths' bytes read latin1; forge's config and PATH are text, so every
 * configured path is turned into the same form before it is compared, R4-F1).
 */
function layout({ config, forgePath = '', realPath = '', pathDirs = [] }) {
  const bytes = (p) => (p === null ? null : Buffer.from(p, 'utf8').toString('latin1'));
  const deps = [...new Set([...config.libs.map(plainDir).filter(Boolean), ...DEPENDENCY_DIRS])].map(bytes);
  // forge's defaults when its config names none.
  const out = bytes(plainDir(typeof config.out === 'string' ? config.out : 'out'));
  const cache = bytes(plainDir(typeof config.cachePath === 'string' ? config.cachePath : 'cache'));
  // forge's compile cache names the artifact files a later run loads instead of compiling: it is held like them.
  const filesCache = cache ? `${cache}/solidity-files-cache.json` : null;
  const inWork = (p) => (typeof p === 'string' && p.startsWith(`${WORK}/`) ? p.slice(WORK.length + 1) : null);
  const tools = [inWork(forgePath), inWork(realPath), config.solc && !config.solc.startsWith('/') ? plainDir(config.solc) : inWork(config.solc)].filter(Boolean).map(bytes);
  const pathRoots = pathDirs.map((d) => (d === WORK ? '' : inWork(d))).filter((d) => d !== null).map(bytes);
  return { deps, out, cache, filesCache, tools, pathRoots };
}

/**
 * The configured places the snapshots could not cover (R8-F1), each as
 * `setting (value) why`; the reference refuses any (IMAGE_WATCH_ROOT_UNCOVERED)
 * rather than leave what lies there unwatched. The listing holds /work and
 * $HOME only, so forge's out, cache_path and libs must be plain paths in the
 * work tree (elsewhere they are unlisted: in /tmp writable too, on the
 * read-only root a directory whose links are unseen). solc and the PATH
 * directories may also be on the read-only root (immutable) or in $HOME
 * (watched), but not in /tmp or a $HOME cache (both unlisted) or through
 * `..`. out and the dependency directories may not lie in the runner's
 * repository or forge's cache directory, which classify() sorts out first
 * (round 9). A PATH directory in the work tree may not lie where builds and
 * runs write (the runner's repository, forge's out, cache, broadcast and
 * snapshots directories) or under paths.tests, where a patch's file would be
 * a command.
 * @param {object} config - parseFramework().config
 * @param {string[]} pathDirs - PATH, as absolute directories
 * @param {string[]} testGlobs - paths.tests
 * @returns {string[]}
 */
function unwatchableRoots(config, pathDirs = [], testGlobs = []) {
  const problems = [];
  const outside = (abs) => {
    if (abs.split('/').includes('..')) return 'is not a plain path (`..`)';
    if (within(abs, '/tmp')) return 'is in /tmp, which the runner does not list';
    if (HOME_CACHES.some((c) => within(abs, `${HOME}/${c.slice(2)}`))) return 'is in a $HOME cache, which the runner does not list';
    return null;
  };
  const named = (value, fallback) => plainDir(typeof value === 'string' ? value : fallback);
  const cache = named(config.cachePath, 'cache');
  // classify() sorts the runner's repository and forge's cache directory out first (the cache is skipped but for its
  // compile cache): an out or dependency directory inside either would be watched as neither (round 9).
  const inWork = (setting, value) => {
    const rel = plainDir(value);
    if (rel === null) problems.push(`${setting} (${value}) is not a plain path in the work tree`);
    else if (under(rel, '.git')) problems.push(`${setting} (${value}) is in the runner's repository`);
    else if (cache && under(rel, cache)) problems.push(`${setting} (${value}) is in forge's cache directory (${cache}), which the snapshots skip`);
  };
  inWork('out', typeof config.out === 'string' ? config.out : 'out');
  if (typeof config.cachePath === 'string' && plainDir(config.cachePath) === null) problems.push(`cache_path (${config.cachePath}) is not a plain path in the work tree`);
  for (const lib of config.libs) inWork('libs', lib);
  for (const dir of DEPENDENCY_DIRS) if (cache && under(dir, cache)) problems.push(`the dependency directory ${dir} is in forge's cache directory (${cache}), which the snapshots skip`);
  if (typeof config.solc === 'string' && config.solc !== '') {
    const s = config.solc;
    const why = s.startsWith('/') && !s.startsWith(`${WORK}/`) ? outside(s) : plainDir(s) === null ? 'is not a plain path in the work tree' : null;
    if (why) problems.push(`solc (${s}) ${why}`);
  }
  const areas = [['.git', 'the runner\'s repository'], [named(config.out, 'out'), 'forge\'s out directory'], [cache, 'forge\'s cache directory'],
    [named(config.broadcast, 'broadcast'), 'forge\'s broadcast directory'], [named(config.snapshots, 'snapshots'), 'forge\'s snapshots directory']].filter(([d]) => d);
  for (const d of pathDirs) {
    if (d === WORK) continue;
    if (!d.startsWith(`${WORK}/`)) {
      const why = outside(d);
      if (why) problems.push(`PATH directory ${d} ${why}`);
      continue;
    }
    const rel = plainDir(d);
    if (rel === null) {
      problems.push(`PATH directory ${d} is not a plain path in the work tree`);
      continue;
    }
    const area = areas.find(([dir]) => under(rel, dir));
    if (area) problems.push(`PATH directory ${d} is in ${area[1]}, which builds and runs write`);
    else if (testGlobs.length && matchesAny(rel, testGlobs)) problems.push(`PATH directory ${d} is under paths.tests, where a patch's file would be a command`);
  }
  return problems;
}

/**
 * The roots of the watched sets as paths (`rel`, latin1) with their set: the
 * dependency directories, PATH directories and tools in the work tree,
 * forge's out directory and compile cache, and each protected glob's path
 * (the glob itself when it has no wildcard, else its literal directories).
 * watchLinks asks the kernel about one only when a link sits at or above it.
 */
function watchRoots({ protectedGlobs = [], ...w }) {
  const { deps, out, filesCache, tools, pathRoots } = layout(w);
  const roots = [];
  const add = (rel, category) => { if (rel) roots.push({ rel, category }); };
  for (const d of deps) add(d, 'dependencies');
  for (const d of [...pathRoots, ...tools]) add(d, 'framework');
  add(out, 'artifacts');
  add(filesCache, 'artifacts');
  for (const g of protectedGlobs) {
    const segs = normalizePath(g).split('/');
    const wild = segs.findIndex((s) => /[*?]/.test(s));
    const literal = wild < 0 ? segs : segs.slice(0, wild);
    add(Buffer.from(literal.join('/'), 'utf8').toString('latin1'), 'protected');
  }
  return roots;
}

/**
 * Sort a manifest into the watched sets.
 * @param {Map} entries - parseManifest().entries
 * @param {object} w
 * @param {string[]} w.protectedGlobs - paths.protected
 * @param {{out:string|null, cachePath:string|null, libs:string[], solc:string|null}} w.config - the reference's forge config
 * @param {string} [w.forgePath] - where forge resolved (the reference)
 * @param {string[]} [w.pathDirs] - PATH, as directories
 * @returns {{protected:Map, dependencies:Map, framework:Map, artifacts:Map, repository:Map}} each relative path (latin1) → description;
 *   $HOME entries as `~/…`, the repository's as `.git/…`
 */
function classify(entries, { protectedGlobs = [], config, forgePath = '', realPath = '', pathDirs = [] }) {
  const sets = { protected: new Map(), dependencies: new Map(), framework: new Map(), artifacts: new Map(), repository: new Map() };
  const { deps, out, cache, filesCache, tools, pathRoots } = layout({ config, forgePath, realPath, pathDirs });
  const inWork = (p) => (typeof p === 'string' && p.startsWith(`${WORK}/`) ? p.slice(WORK.length + 1) : null);
  for (const p of [...entries.keys()].sort()) {
    const d = describe(entries.get(p));
    if (p === `${WORK}/.git` || p.startsWith(`${WORK}/.git/`)) {
      sets.repository.set(p.slice(WORK.length + 1), d);
      continue;
    }
    if (p.startsWith(`${HOME}/`)) {
      const rel = `~/${p.slice(HOME.length + 1)}`;
      if (!HOME_CACHES.some((c) => under(rel, c))) sets.framework.set(rel, d);
      continue;
    }
    const rel = inWork(p);
    if (rel === null) continue;
    const name = displayPath(rel);
    if (protectedGlobs.length && matchesAny(name, protectedGlobs)) sets.protected.set(rel, d);
    // forge's executable and solc are the framework wherever they are, forge's cache directory included (R1-F3).
    if (tools.includes(rel)) sets.framework.set(rel, d);
    if (cache && under(rel, cache)) {
      // The compile cache, and any directory on the way to it that a listing could not read (it hides the cache).
      if (rel === filesCache || (filesCache && entries.get(p).type === 'd' && under(filesCache, rel))) sets.artifacts.set(rel, d);
      continue;
    }
    const dep = deps.find((r) => under(rel, r));
    let framework = FRAMEWORK_FILES.includes(rel) || tools.includes(rel) || pathRoots.some((r) => r === '' ? !rel.includes('/') : under(rel, r));
    if (dep) {
      sets.dependencies.set(rel, d);
      if (rel.slice(dep.length + 1).split('/').some((s) => s.startsWith('forge-std'))) framework = true;
    }
    if (framework) sets.framework.set(rel, d);
    if (out && under(rel, out)) sets.artifacts.set(rel, d);
  }
  return sets;
}

// ------------------------------------------------------------------- links

/**
 * The sets whose links are followed: every set compared (the runner's repository holds no link of the image's). The
 * artifacts are first compared after run 1, but a link among them at the reference (out/ a link into /tmp) is refused
 * then, before any claim code, rather than failing every claim.
 */
const LINK_CATEGORIES = Object.freeze(['protected', 'dependencies', 'framework', 'artifacts']);
const CATEGORY_WORDS = Object.freeze({ protected: 'protected paths', dependencies: 'dependencies', framework: 'framework', artifacts: 'artifacts' });
/** A directory target that holds /tmp, $HOME or the work tree (`/`, `/home`): every place a run writes is under it. */
const HOLDS_WRITABLE = 'a directory that holds /tmp, $HOME or the work tree';
/** A directory target on the read-only root, which the listing does not cover. */
const OUTSIDE_DIRECTORY = 'a directory outside the work tree, whose links the runner does not list';

/** Whether `p` is `dir` or lies under it (`/` holds every absolute path). */
function within(p, dir) {
  return dir === '/' ? p.startsWith('/') : under(p, dir);
}

/** The first index of a sorted array whose element is not below `x`. */
function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Read the link script's records (LINKS_SCRIPT) for `batch`, in its order.
 * @param {Buffer} buf
 * @param {string[]} batch - the absolute paths asked about (latin1)
 * @returns {{ok:true, answers:Map<string, {kind:string, real:string}>} | {ok:false, reason:string}}
 */
function parseLinks(buf, batch) {
  const answers = new Map();
  let pos = 0;
  const field = () => {
    const end = buf.indexOf(0, pos);
    if (end < 0) return null;
    const s = buf.toString('latin1', pos, end);
    pos = end + 1;
    return s;
  };
  while (pos < buf.length) {
    const i = answers.size;
    const kind = field();
    const path = field();
    const real = field();
    if (real === null) return { ok: false, reason: 'a record ends early' };
    if (!['d', 'f', '?', '!'].includes(kind)) return { ok: false, reason: `a record of kind ${JSON.stringify(kind.slice(0, 8))}` };
    if (i >= batch.length || path !== batch[i]) return { ok: false, reason: 'a record for a path not asked about, or out of order' };
    if ((kind === 'd' || kind === 'f') ? !real.startsWith('/') : real !== '') return { ok: false, reason: 'a record whose answer is not an absolute path' };
    answers.set(path, { kind, real });
  }
  if (answers.size !== batch.length) return { ok: false, reason: `${batch.length - answers.size} of ${batch.length} links have no answer` };
  return { ok: true, answers };
}

/**
 * Follow the watched sets' symbolic links through the kernel's answers
 * (§9.5 check 4; attempt 2 of R6-F1/R7-F1). `sets` (classify()'s) is changed
 * in place: each watched link's entry gets the kernel's answer (` => d
 * /real`, ` => f /real`, ` => ?`), and what a link leads to in the work tree
 * joins the link's set (a directory with everything listed under it, a
 * file), its own links then followed for that set in the next round.
 *
 * Only links in a set are followed: a write through any link lands on its
 * real target, which the checksums see whenever that target is listed in a
 * set, so what needs adding is exactly what watched links lead to. The
 * closure is deduplicated by (set, link) and by (set, real tree) before it
 * is queued, and each tree is joined by one range of the sorted listing,
 * with a skip pointer per set, so every listed entry is visited at most once
 * per set: the host's work is linear in the listing and the links (one sort,
 * then at most four visits per entry), and the kernel is asked at most
 * MAX_LINK_ROUNDS times.
 *
 * Not followed but reported:
 * - `uncovered`: a link whose real target is in, or (a directory) holds, a
 *   place builds and runs write to (/tmp, $HOME, the work tree's root, the
 *   runner's repository, forge's out, cache, broadcast and snapshots
 *   directories, paths.tests), unless it is a file the set already watches
 *   (forge's executable in its cache directory, R1-F3); an artifact link's
 *   target in out/ is an artifact; and one leading to a directory outside
 *   the work tree (not listed, so the links inside it are not seen). A file
 *   on the read-only root needs nothing watched; a link the kernel resolves
 *   to nothing is recorded as such.
 * - `patchLinks`: a link at a path a patch touched (possible only where
 *   paths.tests overlaps a set): the claim's, never the image's.
 *
 * @param {Map} entries - parseManifest().entries
 * @param {object} sets - classify()'s sets
 * @param {object} o
 * @param {object} o.config - the reference's forge config (out, cachePath, broadcast, snapshots)
 * @param {string[]} [o.testGlobs] - paths.tests
 * @param {Set<string>} [o.patchPaths] - work-tree paths the patches touched (latin1)
 * @param {Array<{rel:string, category:string}>} [o.roots] - watchRoots(): resolved too when a link sits at or above one
 * @param {string[]} [o.categories] - the sets whose links are followed
 * @param {{links?:number, rounds?:number}} [o.limits] - the caps (MAX_WATCHED_LINKS, MAX_LINK_ROUNDS)
 * @param {(paths:string[], round:number) => Promise<Map<string, {kind:string, real:string}>>} resolve - the kernel's answers
 * @returns {Promise<{uncovered:Array<{link:string, target:string, where:string, category:string}>,
 *   patchLinks:Array<{link:string, category:string}>, links:number, rounds:number, visited:number}>}
 * @throws {WatchTooLarge} more watched links, or levels of linked trees, than the caps
 */
async function watchLinks(entries, sets, { config, testGlobs = [], patchPaths = new Set(), roots = [], categories = LINK_CATEGORIES, limits = {} }, resolve) {
  const maxLinks = limits.links || MAX_WATCHED_LINKS;
  const maxRounds = limits.rounds || MAX_LINK_ROUNDS;
  const bytes = (p) => (p === null ? null : Buffer.from(p, 'utf8').toString('latin1'));
  const dirOf = (value, fallback) => bytes(plainDir(typeof value === 'string' ? value : fallback));
  const out = dirOf(config.out, 'out');
  const cache = dirOf(config.cachePath, 'cache');
  const filesCache = cache ? `${cache}/solidity-files-cache.json` : null;
  // Where builds and runs write in the work tree: forge's directories (its defaults when the config names none).
  const areas = [['.git', 'the runner\'s repository']];
  for (const [d, what] of [[out, 'out'], [cache, 'cache'], [dirOf(config.broadcast, 'broadcast'), 'broadcast'], [dirOf(config.snapshots, 'snapshots'), 'snapshots']]) {
    if (d) areas.push([d, `forge's ${what} directory`]);
  }
  const relOf = (abs) => (abs.startsWith(`${WORK}/`) ? abs.slice(WORK.length + 1) : abs.startsWith(`${HOME}/`) ? `~/${abs.slice(HOME.length + 1)}` : null);

  /** Why a real target cannot be watched for set `c`, or null. */
  function refusal(real, kind, c) {
    const holds = kind === 'd';
    const hit = (dir) => within(real, dir) || (holds && within(dir, real));
    if (hit('/tmp')) return within(real, '/tmp') ? '/tmp' : HOLDS_WRITABLE;
    if (hit(HOME)) return within(real, HOME) ? '$HOME' : HOLDS_WRITABLE;
    if (real === WORK) return 'the work tree\'s root';
    if (holds && within(WORK, real)) return HOLDS_WRITABLE;
    // The read-only root: a file there never changes and its real path holds no link; a directory is not listed, so a
    // link inside it (one leading back into the work tree, say) could not be seen.
    if (!real.startsWith(`${WORK}/`)) return holds ? OUTSIDE_DIRECTORY : null;
    const rel = real.slice(WORK.length + 1);
    if (c === 'artifacts' && ((out && under(rel, out)) || rel === filesCache)) return null;
    for (const [dir, what] of areas) {
      if (under(rel, dir)) return `${what} (${displayPath(dir)})`;
      if (holds && under(dir, rel)) return `a directory holding ${what} (${displayPath(dir)})`;
    }
    if (testGlobs.length && matchesAny(displayPath(rel), testGlobs)) return 'paths.tests';
    return null;
  }

  const resolution = new Map();
  const seen = new Set();
  const uncovered = [];
  const patchLinks = [];
  const joined = Object.fromEntries(categories.map((c) => [c, new Set()]));
  let frontier = [];
  // The distinct links of the frontier the kernel has not answered yet: the cap holds as they are queued.
  let unresolved = new Set();
  let visited = 0;
  const addPair = (abs, c) => {
    const key = `${c}\u0000${abs}`;
    if (seen.has(key)) return;
    seen.add(key);
    const rel = relOf(abs);
    if (patchPaths.has(rel)) {
      patchLinks.push({ link: displayPath(rel), category: c });
      return;
    }
    if (!resolution.has(abs) && !unresolved.has(abs)) {
      unresolved.add(abs);
      if (resolution.size + unresolved.size > maxLinks) throw new WatchTooLarge(`more than ${maxLinks} watched links`);
    }
    frontier.push([abs, c]);
  };
  for (const [abs, e] of entries) {
    if (e.type !== 'l') continue;
    const rel = relOf(abs);
    if (rel === null || rel === '.git' || rel.startsWith('.git/')) continue;
    for (const c of categories) if (sets[c].has(rel)) addPair(abs, c);
  }
  // A link at or above a set's root (`libs = ["deps/lib"]` with deps a link; forge's cache directory a link): nothing
  // under the root is listed, so the kernel resolves the root itself, which then counts as a link of its set (its
  // answer is its entry). A tracked path never lies behind a link (the forced checkout makes the way to it real).
  for (const { rel, category: c } of roots) {
    if (!categories.includes(c)) continue;
    let via = null;
    for (let i = rel.indexOf('/'); via === null; i = rel.indexOf('/', i + 1)) {
      const prefix = i < 0 ? rel : rel.slice(0, i);
      const e = entries.get(`${WORK}/${prefix}`);
      if (e && e.type === 'l') via = prefix;
      if (i < 0) break;
    }
    if (via === null) continue;
    // The patch's own link on the way is the claim's (reported, never followed).
    if (patchPaths.has(via)) {
      addPair(`${WORK}/${via}`, c);
      continue;
    }
    const abs = `${WORK}/${rel}`;
    if (!sets[c].has(rel)) sets[c].set(rel, entries.has(abs) ? describe(entries.get(abs)) : 'root');
    addPair(abs, c);
  }

  let keys = null;
  const skips = new Map();
  // skip[i]: the first index from i on not yet joined to the set (path halving keeps every lookup near constant).
  const skipOf = (c) => {
    if (!skips.has(c)) {
      const skip = new Int32Array(keys.length + 1);
      for (let i = 0; i <= keys.length; i += 1) skip[i] = i;
      skips.set(c, skip);
    }
    return skips.get(c);
  };
  const nextOf = (skip, from) => {
    let i = from;
    while (skip[i] !== i) {
      skip[i] = skip[skip[i]];
      i = skip[i];
    }
    return i;
  };
  let rounds = 0;
  while (frontier.length) {
    rounds += 1;
    if (rounds > maxRounds) throw new WatchTooLarge(`the watched links lead through more than ${maxRounds} levels of linked trees`);
    const need = [...unresolved].sort();
    unresolved = new Set();
    if (need.length) {
      const answers = await resolve(need, rounds);
      for (const abs of need) {
        const a = answers.get(abs);
        if (!a) throw new TypeError(`the link resolver gave no answer for ${displayPath(abs)}`);
        resolution.set(abs, a);
      }
    }
    const pending = frontier;
    frontier = [];
    const joins = new Map(categories.map((c) => [c, new Set()]));
    for (const [abs, c] of pending) {
      visited += 1;
      const r = resolution.get(abs);
      if (r.kind === '?') continue;
      const link = displayPath(relOf(abs));
      if (r.kind === '!') {
        uncovered.push({ link, target: '?', where: 'a target realpath could not resolve', category: c });
        continue;
      }
      const trel = relOf(r.real);
      if (r.kind === 'f' && trel !== null && sets[c].has(trel)) continue;
      const where = refusal(r.real, r.kind, c);
      if (where) {
        uncovered.push({ link, target: displayPath(r.real), where, category: c });
        continue;
      }
      if (!r.real.startsWith(`${WORK}/`)) continue;
      if (r.kind === 'f') {
        const e = entries.get(r.real);
        if (e) sets[c].set(trel, describe(e));
      } else joins.get(c).add(r.real);
    }
    // Each new tree joins as one range of the sorted listing (the entries under a directory are the keys from "dir/" up
    // to "dir0"), each entry at most once per set across every round: a skip pointer per set jumps over what is joined.
    for (const [c, trees] of joins) {
      for (const root of [...trees].sort()) {
        if (joined[c].has(root)) continue;
        joined[c].add(root);
        if (keys === null) keys = [...entries.keys()].sort();
        const skip = skipOf(c);
        const end = lowerBound(keys, `${root}0`);
        for (let i = nextOf(skip, lowerBound(keys, `${root}/`)); i < end; i = nextOf(skip, i + 1)) {
          skip[i] = i + 1;
          visited += 1;
          const k = keys[i];
          const e = entries.get(k);
          const rel = k.slice(WORK.length + 1);
          if (!sets[c].has(rel)) sets[c].set(rel, describe(e));
          if (e.type === 'l') addPair(k, c);
        }
      }
    }
  }
  // The kernel's answer is part of each watched link's entry: a link on the way retargeted changes it.
  for (const [abs, r] of resolution) {
    const rel = relOf(abs);
    const d = `${entries.has(abs) ? describe(entries.get(abs)) : 'root'} => ${r.kind}${r.real ? ` ${r.real}` : ''}`;
    for (const c of categories) if (sets[c].has(rel)) sets[c].set(rel, d);
  }
  const order = (a, b) => (a.link !== b.link ? (a.link < b.link ? -1 : 1) : a.category < b.category ? -1 : a.category > b.category ? 1 : 0);
  return { uncovered: uncovered.sort(order), patchLinks: patchLinks.sort(order), links: resolution.size, rounds, visited };
}

/** The links detail: the first five links with their targets and why, and how many more there are. */
function listUncovered(uncovered) {
  const byLink = new Map();
  for (const u of uncovered) if (!byLink.has(u.link)) byLink.set(u.link, `${u.link} -> ${u.target} (${u.where})`);
  return shown([...byLink.values()], 5, ', ');
}

/**
 * Paths whose description differs between two sets (changed, added or
 * removed), in byte order.
 * @returns {string[]}
 */
function changedPaths(before, after) {
  const out = [];
  // Unreadable on either side: there is nothing to compare, so it is never unchanged (R13-F1).
  for (const [p, d] of before) if (after.get(p) !== d || isUnreadable(d)) out.push(p);
  for (const p of after.keys()) if (!before.has(p)) out.push(p);
  return [...new Set(out)].sort();
}

function changeWord(before, after, p) {
  if (after.has(p) && isUnreadable(after.get(p))) return 'cannot be read';
  if (!before.has(p)) return 'added';
  if (!after.has(p)) return 'removed';
  return 'changed';
}

// ------------------------------------------------------------ the snapshots

function frameworkArgv(forgePath = '') {
  return ['/bin/sh', '-c', FRAMEWORK_SCRIPT, 'vcr-framework', forgePath];
}

function manifestArgv(roots, prunes = []) {
  const prune = prunes.length ? ['(', ...prunes.flatMap((p, i) => [...(i ? ['-o'] : []), '-path', globLiteral(p)]), ')', '-prune', '-o'] : [];
  return hermetic(MANIFEST_SCRIPT, 'vcr-manifest', [...roots, '-xdev', ...prune]);
}

/** The link script's argv (its paths go on stdin). */
function linksArgv() {
  return hermetic(LINKS_SCRIPT, 'vcr-links');
}

function runnerError(step, detail) {
  return new Abstain(ABSTAIN.RUNNER_ERROR, detail, { step });
}

/** The discovery's lines: forge's path, PATH, the real path. */
const DISCOVERY = /^vcr-forge ([^\n]*)\nvcr-path ([^\n]*)\n(?:vcr-real ([^\n]*)\n)?$/;

/**
 * The framework probe: the discovery (FRAMEWORK_SCRIPT), then, with
 * `config`, `forge config --json` run by forge itself through forgeArgv,
 * exactly as the maker's commands run it: the same forge (`tool`'s real
 * path, the reference's; at the reference, the one just found), the same
 * fixed environment and PATH, /work. Its output follows the discovery's
 * lines in `bytes` (parseFramework); its exit code and stderr are the
 * configuration's. A forge the runner cannot run as an argv is `unrunnable`.
 * @param {object} ctx
 * @param {string} name
 * @param {string} forgePath - '' at the reference, else the reference's real path
 * @param {{config?:boolean, tool?:{realPath:string, path:string}}} [o]
 */
async function probe(ctx, name, forgePath, { config = true, tool = null } = {}) {
  const head = new Prefix(CONFIG_MAX_BYTES);
  const found = await ctx.exec(frameworkArgv(forgePath), { name, timeoutMs: SNAPSHOT_TIMEOUT_MS, tee: head });
  const headBytes = head.bytes();
  const done = (exitCode, bytes, stderr, extra = {}) => ({ exitCode, truncated: head.truncated, bytes, stderr, ...extra });
  if (found.exitCode !== 0 || !config) return done(found.exitCode, headBytes, found.stderr ? found.stderr.text : '');
  const m = head.truncated ? null : DISCOVERY.exec(headBytes.toString('utf8'));
  if (!m) return done(found.exitCode, headBytes, '');
  const use = tool || { realPath: m[3] !== undefined ? m[3] : m[1], path: m[2] };
  const problem = forge.toolProblem(use);
  if (problem) return done(found.exitCode, headBytes, '', { unrunnable: problem });
  const out = new Prefix(CONFIG_MAX_BYTES);
  const record = await ctx.exec(forge.forgeArgv(use, ['config', '--json']), {
    name: `${name}:config`, timeoutMs: SNAPSHOT_TIMEOUT_MS, workdir: forge.FORGE_WORKDIR, tee: out
  });
  return {
    exitCode: record.exitCode, truncated: out.truncated, bytes: Buffer.concat([headBytes, out.bytes()]), stderr: record.stderr ? record.stderr.text : ''
  };
}

/**
 * Where forge is, for a session the integrity reference does not cover (the
 * listing check's build and suite, its harness probes): the discovery only.
 * What it finds is the requester's when it cannot be run (no forge, or a
 * path the runner cannot pass as a program).
 * @returns {Promise<{forgePath:string, realPath:string, path:string}>}
 */
async function discoverForge(ctx, name) {
  const p = await probe(ctx, name, '', { config: false });
  const m = p.truncated ? null : DISCOVERY.exec(p.bytes.toString('utf8'));
  // As at the integrity reference: no forge, or an answer that holds none (an image PATH of several lines).
  if (!m || m[1] === '' || p.exitCode !== 0) throw new RequesterError([{ code: 'IMAGE_FORGE_MISSING', path: '/spec/env/image', detail: 'the env image has no forge on its PATH' }]);
  const tool = { forgePath: m[1], realPath: m[3] !== undefined ? m[3] : m[1], path: m[2] };
  const problem = forge.toolProblem(tool);
  if (problem) throw new RequesterError([{ code: 'IMAGE_FORGE_MISSING', path: '/spec/env/image', detail: `the env image has no forge the runner can run: ${problem}` }]);
  return tool;
}

/** The listing; `overflow` with its reason when it is over a cap (MANIFEST_MAX_BYTES, MAX_ENTRIES). */
async function manifest(ctx, name, roots, prunes) {
  const out = new Prefix(MANIFEST_MAX_BYTES);
  const record = await ctx.exec(manifestArgv(roots, prunes), { name, timeoutMs: SNAPSHOT_TIMEOUT_MS, tee: out });
  if (record.exitCode !== 0) throw runnerError(name, `the watched paths could not be listed (exit ${record.exitCode})`);
  if (out.truncated) return { overflow: true, reason: `the watched paths exceed ${MANIFEST_MAX_BYTES} bytes of listing` };
  const m = parseManifest(out.bytes());
  if (!m.ok && m.tooLarge) return { overflow: true, reason: `the watched paths' listing has more than ${MAX_ENTRIES} entries` };
  if (!m.ok) throw runnerError(name, `the watched paths' listing could not be read: ${m.reason}`);
  return { overflow: false, entries: m.entries };
}

function firstLine(text) {
  const line = String(text || '').split(/\r?\n/).find((l) => l.trim());
  return line ? line.trim().slice(0, 200) : '';
}

/**
 * The post-run checksums of one sandbox (§9.5 check 4): the reference before
 * any maker command runs, then a snapshot after every run that ran claim
 * code, taken once its processes are dead.
 */
class Watch {
  /**
   * @param {object} o
   * @param {string[]} o.protectedGlobs - paths.protected
   * @param {string[]} [o.testGlobs] - paths.tests (a watched link may not lead there)
   * @param {string[]} [o.patchPaths] - the work-tree paths the claim's patches add or change (git's names)
   * @param {string} [o.prefix] - exec names' prefix
   */
  constructor({ protectedGlobs = [], testGlobs = [], patchPaths = [], prefix = 'integrity' } = {}) {
    this.protectedGlobs = protectedGlobs;
    this.testGlobs = testGlobs;
    // In the manifest's byte form (its keys are the paths' bytes read latin1).
    this.patchPaths = new Set(patchPaths.map((p) => Buffer.from(p, 'utf8').toString('latin1')));
    this.prefix = prefix;
    this.ref = null;
    this.repository = null;
    this.artifacts = null;
    this.failures = { protected: [], framework: [], dependencies: [] };
    this.changed = { protected: new Set(), framework: new Set(), dependencies: new Set() };
  }

  watchArgs() {
    const { config, forgePath, realPath, pathDirs } = this.ref;
    return { protectedGlobs: this.protectedGlobs, config, forgePath, realPath, pathDirs };
  }

  /** Trees the listing skips: forge's ABI cache (rewritten on every run) and the $HOME caches. */
  prunes(config) {
    const cache = plainDir(config.cachePath);
    return [...(cache ? [`${WORK}/${cache}/solidity-files-cache.json.abi`] : []), ...HOME_CACHES.map((c) => `${HOME}/${c.slice(2)}`)];
  }

  /**
   * The reference: the image plus the accepted patch, before any maker
   * command. What cannot be read here is the requester's package (no claim
   * code has run yet).
   */
  async reference(ctx) {
    const name = `${this.prefix}:reference`;
    const p = await probe(ctx, `${name}:framework`, '');
    const parsed = p.truncated ? { ok: false, reason: 'more than 1 MiB' } : parseFramework(p.bytes);
    const forgePath = parsed.forgePath !== undefined ? parsed.forgePath : null;
    if (forgePath === '' || forgePath === null) {
      throw new RequesterError([{ code: 'IMAGE_FORGE_MISSING', path: '/spec/env/image', detail: 'the env image has no forge on its PATH' }]);
    }
    if (p.unrunnable) {
      throw new RequesterError([{ code: 'IMAGE_FORGE_MISSING', path: '/spec/env/image', detail: `the env image has no forge the runner can run: ${p.unrunnable}` }]);
    }
    if (p.exitCode !== 0 || !parsed.ok) {
      throw new RequesterError([{
        code: 'FORGE_CONFIG_INVALID', path: '/spec/env/image',
        detail: `\`forge config --json\` failed at the listed commit (exit ${p.exitCode}): ${firstLine(p.stderr) || parsed.reason || ''}`.trim()
      }]);
    }
    // Every place the sets are rooted at must be one the snapshots cover (R8-F1): none is dropped silently.
    const uncoveredRoots = unwatchableRoots(parsed.config, parsed.pathDirs, this.testGlobs);
    if (uncoveredRoots.length) {
      throw new RequesterError([{
        code: 'IMAGE_WATCH_ROOT_UNCOVERED', path: '/spec/env/image',
        detail: `forge's configuration puts what the runner watches where its snapshots cannot cover it: ${shown(uncoveredRoots, 5, '; ')}`
      }]);
    }
    const tooLarge = (why) => new RequesterError([{
      code: 'IMAGE_WATCH_TOO_LARGE', path: '/spec/env/image', detail: `${why}: the runner cannot watch the work tree for changes during a run`
    }]);
    const m = await manifest(ctx, `${name}:manifest`, [WORK, HOME], this.prunes(parsed.config));
    if (m.overflow) throw tooLarge(m.reason);
    // `path` and `realPath` are the forge every maker command runs, with the configuration hashed here (forgeArgv).
    this.ref = {
      forgePath: parsed.forgePath, realPath: parsed.realPath, path: parsed.path, pathDirs: parsed.pathDirs, configSha256: parsed.configSha256, config: parsed.config
    };
    // A forge that lives in the work tree runs after claim code only while its bytes are the reference's (R1-F3): the
    // reference must have hashed it, wherever it is.
    this.ref.forgeEntry = null;
    if (parsed.realPath.startsWith(`${WORK}/`)) {
      const e = m.entries.get(Buffer.from(parsed.realPath, 'utf8').toString('latin1'));
      if (!e || e.type !== 'f' || !e.hash) {
        throw new RequesterError([{
          code: 'IMAGE_FORGE_UNWATCHED', path: '/spec/env/image',
          detail: `forge resolves to ${parsed.realPath}, in the work tree, which the runner cannot hash: it could not verify forge before running it after claim code`
        }]);
      }
      this.ref.forgeEntry = describe(e);
    }
    const sets = classify(m.entries, this.watchArgs());
    let links;
    try {
      links = await this.links(ctx, name, m.entries, sets, { reference: true });
    } catch (err) {
      if (err instanceof WatchTooLarge) throw tooLarge(err.message);
      throw err;
    }
    if (links.uncovered.length) {
      throw new RequesterError([{
        code: 'IMAGE_WATCH_LINK_UNCOVERED', path: '/spec/env/image',
        detail: `a watched link leads where builds and runs write, so the runner could not tell a change behind it: ${listUncovered(links.uncovered)}`
      }]);
    }
    // What the reference cannot read could change unseen (R13-F1). No claim code has run, and a patch writes no such mode.
    const unreadable = unreadablePaths(sets);
    if (unreadable.length) {
      throw new RequesterError([{
        code: 'IMAGE_WATCH_UNREADABLE', path: '/spec/env/image',
        detail: `the env image holds files or directories the runner watches but cannot read, so it could not tell a change in them: ${shown(unreadable.map(displayPath), 5, ', ')}`
      }]);
    }
    // A link a patch added in a set (paths.tests overlapping it) is the claim's: its check fails, the image is not refused.
    for (const p of links.patchLinks) {
      const category = p.category === 'artifacts' ? 'framework' : p.category;
      this.fail(category, `the reference: the patch adds a link inside the ${CATEGORY_WORDS[p.category]} (${p.link}): the runner follows only the image's links`);
      this.changed[category].add(p.link);
    }
    this.ref.sets = sets;
    this.repository = sets.repository;
  }

  /**
   * The forge the maker's commands run (forge.forgeArgv): the reference's,
   * its real path and the image's PATH as probed, the configuration hashed
   * at the reference.
   * @returns {{forgePath:string, realPath:string, path:string}}
   */
  tool() {
    if (!this.ref) throw new TypeError('the reference has not been taken');
    return { forgePath: this.ref.forgePath, realPath: this.ref.realPath, path: this.ref.path };
  }

  /**
   * The watched sets' links, resolved by the kernel in this sandbox
   * (watchLinks, LINKS_SCRIPT): one exec per level of linked trees, none
   * when no watched set holds a link.
   */
  links(ctx, name, entries, sets, { reference }) {
    const resolve = async (paths, round) => {
      const step = round === 1 ? `${name}:links` : `${name}:links-${round}`;
      const out = new Prefix(LINKS_MAX_BYTES);
      const record = await ctx.exec(linksArgv(), {
        name: step, timeoutMs: SNAPSHOT_TIMEOUT_MS, stdin: Buffer.from(`${paths.join('\0')}\0`, 'latin1'), tee: out
      });
      if (record.exitCode === 4 && reference) {
        throw new RequesterError([{
          code: 'IMAGE_TOOL_MISSING', path: '/spec/env/image', detail: 'the env image has no realpath (GNU coreutils), which the runner needs to resolve the watched links'
        }]);
      }
      if (record.exitCode !== 0) throw runnerError(step, `the watched links could not be resolved (exit ${record.exitCode})`);
      if (out.truncated) throw new WatchTooLarge(`the watched links' resolution exceeds ${LINKS_MAX_BYTES} bytes`);
      const parsed = parseLinks(out.bytes(), paths);
      if (!parsed.ok) throw runnerError(step, `the watched links' resolution could not be read: ${parsed.reason}`);
      return parsed.answers;
    };
    const roots = watchRoots(this.watchArgs());
    return watchLinks(entries, sets, { config: this.ref.config, testGlobs: this.testGlobs, patchPaths: this.patchPaths, roots }, resolve);
  }

  fail(category, detail, paths = []) {
    this.failures[category].push(detail);
    for (const p of paths) this.changed[category].add(displayPath(p));
  }

  /**
   * A snapshot after run `label` (`run 1`, `the suite`…), compared with the
   * reference; `first` is the sandbox's first test run, whose compile may
   * write `out`, and whose artifacts the later runs are then held to.
   */
  async afterRun(ctx, label, { first }) {
    const name = `${this.prefix}:${label.replace(/\s+/g, '-')}`;
    // The files first: forge runs (for its configuration) only once they are measured, and never when it is a file in
    // the work tree whose bytes the run changed (R1-F3): a replaced forge could restore what the listing would see.
    const listed = await this.compareFiles(ctx, name, label, first);
    let runnable = true;
    if (this.ref.forgeEntry !== null) {
      // The executable's own entry, hashed in both listings and the same (never a set it might be skipped from).
      const e = listed ? listed.get(Buffer.from(this.ref.realPath, 'utf8').toString('latin1')) : null;
      runnable = Boolean(e && e.type === 'f' && e.hash && describe(e) === this.ref.forgeEntry);
    }
    // The reference's real path, never a link a run could retarget; its configuration read as the commands run forge.
    const p = await probe(ctx, `${name}:framework`, this.ref.realPath, { config: runnable, tool: this.tool() });
    const parsed = p.truncated ? { ok: false, reason: 'more than 1 MiB' } : parseFramework(p.bytes);
    if (parsed.forgePath !== undefined && parsed.forgePath !== this.ref.forgePath) {
      this.fail('framework', `${label}: forge resolves to ${parsed.forgePath || 'nothing'}, not ${this.ref.forgePath}`);
    }
    if (!runnable) this.fail('framework', `${label}: forge's executable ${this.ref.realPath} changed; it was not run`);
    else if (p.exitCode !== 0) this.fail('framework', `${label}: forge config exited ${p.exitCode}${firstLine(p.stderr) ? `: ${firstLine(p.stderr)}` : ''}`);
    else if (!parsed.ok) this.fail('framework', `${label}: forge's configuration could not be read: ${parsed.reason}`);
    else if (parsed.configSha256 !== this.ref.configSha256) this.fail('framework', `${label}: forge's resolved configuration changed (\`forge config --json\`)`);
  }

  async compareFiles(ctx, name, label, first) {
    const m = await manifest(ctx, `${name}:manifest`, [WORK, HOME], this.prunes(this.ref.config));
    const overflow = (reason) => {
      for (const c of ['protected', 'framework', 'dependencies']) this.fail(c, `${label}: ${reason}`);
      return null;
    };
    if (m.overflow) return overflow(m.reason);
    const sets = classify(m.entries, this.watchArgs());
    let links;
    try {
      links = await this.links(ctx, name, m.entries, sets, { reference: false });
    } catch (err) {
      if (err instanceof WatchTooLarge) return overflow(err.message);
      throw err;
    }
    const compare = (category, before, after) => {
      const changed = changedPaths(before, after);
      if (changed.length) {
        const more = changed.length > 1 ? `, and ${changed.length - 1} more` : '';
        this.fail(category, `${label}: ${displayPath(changed[0])} ${changeWord(before, after, changed[0])}${more}`, changed);
      }
    };
    compare('protected', this.ref.sets.protected, sets.protected);
    compare('protected', this.repository, sets.repository);
    compare('dependencies', this.ref.sets.dependencies, sets.dependencies);
    compare('framework', this.ref.sets.framework, sets.framework);
    // The first run's artifacts are what the later ones are held to (none when its listing overflowed: already a
    // failure), so an artifact it left unreadable fails here: nothing later could tell a change in it (R13-F1).
    if (first) {
      this.artifacts = sets.artifacts;
      compare('framework', new Map(), new Map([...sets.artifacts].filter(([, d]) => isUnreadable(d))));
    } else if (this.artifacts) compare('framework', this.artifacts, sets.artifacts);
    // A watched link a run left leading where builds and runs write: for a set held to the reference its entry changed
    // too; for the artifacts after run 1 (the later runs' reference) this is the failure.
    for (const u of links.uncovered) {
      const category = u.category === 'artifacts' ? 'framework' : u.category;
      this.fail(category, `${label}: ${u.link} -> ${u.target} is a watched link into ${u.where}`);
      this.changed[category].add(u.link);
    }
    return m.entries;
  }

  /** After the runner's own reset: its repository is read again, as the next run's reference for it. */
  async afterReset(ctx, label) {
    const m = await manifest(ctx, `${this.prefix}:repository:${label.replace(/\s+/g, '-')}`, [`${WORK}/.git`], []);
    if (m.overflow) throw runnerError(`${this.prefix}:repository`, 'the runner\'s repository could not be listed');
    this.repository = classify(m.entries, this.watchArgs()).repository;
  }

  /** The changed paths per check, for the facts: the first 100 of each, in code-unit order. */
  changedFacts() {
    const list = (s) => [...s].sort().slice(0, MAX_CHANGED);
    return { protected: list(this.changed.protected), framework: list(this.changed.framework), dependencies: list(this.changed.dependencies) };
  }
}

// ------------------------------------------- framework-summary and exit codes

const SUMMARY = /^Suite result: (ok|FAILED)\. ([0-9]+) passed; ([0-9]+) failed; ([0-9]+) skipped; finished in [^\n]+$/;

function countRecords(cases) {
  const c = { pass: 0, failure: 0, error: 0, skipped: 0 };
  for (const k of cases) c[k.outcome] += 1;
  return c;
}

/**
 * Framework-summary consistency (§9.5 check 2) of one readable JUnit:
 * forge's summary of each suite and the counts it writes on <testsuite> and
 * <testsuites> agree with the records. A JUnit that could not be read has
 * nothing to compare (that run is already an error for reproduces).
 * @param {object} doc - readForgeJUnit's result
 * @returns {{ok:boolean, detail:string|null}}
 */
function summaryConsistency(doc) {
  if (!doc || !doc.ok) return { ok: true, detail: null };
  const bad = (detail) => ({ ok: false, detail });
  const sum = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const s of doc.suites) {
    const name = `${s.file}:${s.contract}`;
    const c = countRecords(s.cases);
    const failed = c.failure + c.error;
    const lines = s.summaries.filter((t) => SUMMARY.test(t));
    if (lines.length === 0) return bad(`${name} has no forge suite summary`);
    if (lines.length > 1 || s.summaries.length > 1) return bad(`${name} has more than one forge suite summary`);
    const [, word, passed, nFailed, skipped] = SUMMARY.exec(lines[0]);
    if (Number(passed) !== c.pass || Number(nFailed) !== failed || Number(skipped) !== c.skipped) {
      return bad(`${name}: forge's summary says ${passed} passed, ${nFailed} failed, ${skipped} skipped; its records are ${c.pass} passed, ${failed} failed, ${c.skipped} skipped`);
    }
    if ((word === 'ok') !== (failed === 0)) return bad(`${name}: forge's summary says ${word} with ${failed} failed`);
    const want = { tests: s.cases.length, failures: c.failure, errors: c.error, skipped: c.skipped };
    for (const [k, v] of Object.entries(want)) {
      if (s.counts[k] === null) return bad(`${name} has no ${k} count`);
      if (s.counts[k] !== String(v)) return bad(`${name}: ${k}="${s.counts[k]}", but the suite has ${v}`);
      sum[k] += v;
    }
  }
  for (const [k, v] of Object.entries(sum)) {
    if (doc.totals[k] === null) return bad(`<testsuites> has no ${k} count`);
    if (doc.totals[k] !== String(v)) return bad(`<testsuites> ${k}="${doc.totals[k]}", but the suites hold ${v}`);
  }
  return { ok: true, detail: null };
}

/**
 * Exit-code consistency (§9.5 check 3): forge exits non-zero exactly when
 * a test failed. Without a readable JUnit, only a non-zero exit is
 * consistent (forge failed before its report, as on a compile error); an
 * exit 0 there is an exit before forge's report.
 * @param {{exitCode:number, junit:'ok'|'absent'|'invalid', doc:object|null}} run
 * @returns {{ok:boolean, detail:string|null}}
 */
function exitConsistency({ exitCode, junit, doc }) {
  if (junit !== 'ok') {
    if (exitCode !== 0) return { ok: true, detail: null };
    return { ok: false, detail: junit === 'absent' ? 'the test command exited 0 without forge\'s JUnit' : 'the test command exited 0 with an unreadable JUnit' };
  }
  let failures = 0;
  for (const s of doc.suites) for (const k of s.cases) if (k.outcome === 'failure' || k.outcome === 'error') failures += 1;
  if ((exitCode !== 0) === (failures > 0)) return { ok: true, detail: null };
  return {
    ok: false,
    detail: failures > 0
      ? `the test command exited ${exitCode}, but the JUnit records ${failures} failure${failures === 1 ? '' : 's'}`
      : `the test command exited ${exitCode}, but the JUnit records no failure`
  };
}

/** The identity-completeness detail of one run's entry for a test, or null when it is complete. */
function identityGap(id, entry) {
  if (entry.result === 'missing') return `${id} has no record`;
  if (entry.result === 'skip') return `${id} is skipped`;
  if (entry.result === 'duplicate') return `${id} has ${entry.records || 'several'} records`;
  return null;
}

// ------------------------------------------------------------- tamper flags

/** File cheatcodes that write, and which of their arguments are paths. */
const WRITE_CHEATCODES = Object.freeze({
  writeFile: [0], writeFileBinary: [0], writeLine: [0], writeJson: [1], writeToml: [1],
  removeFile: [0], removeDir: [0], createDir: [0], copyFile: [1]
});
const WRITE_CALL = new RegExp(`\\.\\s*(${Object.keys(WRITE_CHEATCODES).join('|')})\\s*\\(`, 'g');
/** forge's report is its stdout: a path that reaches it, or another process's descriptors. */
const REPORT_PATH = /\/proc\/|\/dev\/(?:stdout|stderr|tty|fd\/)/;
/** JUnit element markup: writing the report itself. */
const JUNIT_MARKUP = /<\s*\/?\s*(?:testsuites|testsuite|testcase)\b/;
/** Ending forge's process from test code (an ffi kill), or registering an exit handler (a shell trap). */
const KILL = /\b(?:pkill|killall)\b|\bkill\s+-(?:[0-9]+|[A-Z]+|s\s)/;
const TRAP = /\btrap\s+(?:"[^"]*"|'[^']*'|\S+)\s+(?:EXIT|INT|TERM|HUP|QUIT|0)\b/;
/** Inline config that changes forge's file permissions for a test. */
const INLINE_FS = /forge-config:\s*[A-Za-z0-9_.-]*fs_permissions/;

/** The string-literal arguments of the call opening at `from` (the index after its "("), as far as this line goes. */
function callArguments(text, from) {
  const args = [];
  let cur = '';
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === '\'') {
      let j = i + 1;
      let lit = '';
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\' && j + 1 < text.length) { lit += text[j + 1]; j += 2; continue; }
        lit += text[j];
        j += 1;
      }
      cur += `\u0000${lit}`;
      i = j;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if ((ch === ')' || ch === ']' || ch === '}') && depth > 0) { depth -= 1; cur += ch; continue; }
    if (ch === ')' && depth === 0) { args.push(cur); return args; }
    if (ch === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    cur += ch;
  }
  args.push(cur);
  return args;
}

/** A path argument that is one string literal, or null. */
function literalArg(arg) {
  if (typeof arg !== 'string') return null;
  const m = /^\s*\u0000([\s\S]*)$/.exec(arg);
  return m && !m[1].includes('\u0000') ? m[1] : null;
}

const FRAMEWORK_TARGET = /^(?:\.\/)*(?:foundry\.toml|remappings\.txt|\.env|foundry\.lock|soldeer\.lock)$|^(?:\.\/)*(?:lib|node_modules|dependencies|out|cache|\.git|\.foundry)(?:\/|$)|(?:^|\/)\.foundry(?:\/|$)|(?:^|\/)\.git(?:\/|$)/;

function pathKinds(p) {
  const kinds = [];
  if (p.startsWith('/') || p.startsWith('~') || /(?:^|\/)\.\.(?:\/|$)/.test(p)) kinds.push('write-outside-repository');
  if (/(?:^|\/)forge-std(?:[^/]*)(?:\/|$)/.test(p)) kinds.push('reporter-patched');
  else if (FRAMEWORK_TARGET.test(p)) kinds.push('framework-patched');
  if (REPORT_PATH.test(p)) kinds.push('report-path-referenced');
  return kinds;
}

/**
 * Static tamper flags (§9.5 check 5) over the lines a patch added, in its
 * files under paths.tests (and, for the fix check, the fix's lines): test
 * code that names forge's report channel or writes JUnit markup, ends
 * forge's process or registers an exit handler, changes forge's file
 * permissions inline, writes forge's configuration, its dependencies, its
 * artifacts, the runner's repository or forge-std (the assertion library)
 * with a file cheatcode, or writes outside the repository. (A maker's
 * command names no script any more: the grammar refuses one, src/commands.js.)
 * One flag per kind per line, at most 100, in the report's order (kind,
 * file, line).
 * @param {object} o
 * @param {Map<string, Array<{line:number, text:string}>>} o.added - the patch's added lines by file
 * @returns {Array<{kind:string, file:string, line:number|null}>}
 */
function tamperFlags({ added }) {
  const flags = new Map();
  const flag = (kind, file, line) => flags.set(`${kind}\u0000${file}\u0000${line}`, { kind, file, line });
  for (const [file, lines] of added) {
    for (const { line, text } of lines) {
      if (REPORT_PATH.test(text) || JUNIT_MARKUP.test(text)) flag('report-path-referenced', file, line);
      if (KILL.test(text)) flag('exit-during-import', file, line);
      if (TRAP.test(text)) flag('exit-handler-registered', file, line);
      if (INLINE_FS.test(text)) {
        // A grant of write access, inline, to the repository's root, to what the framework reads, or outside the
        // repository. A narrow grant (a scratch directory of the PoC's own) is not a flag: what is written is measured.
        for (const m of text.matchAll(/\{([^}]*)\}/g)) {
          const access = /access\s*=\s*"([^"]*)"/.exec(m[1]);
          const where = /path\s*=\s*"([^"]*)"/.exec(m[1]);
          if (!access || !where || !/write/.test(access[1])) continue;
          const kinds = pathKinds(where[1]);
          if (plainDir(where[1]) === null && !where[1].startsWith('/') && !where[1].startsWith('~')) kinds.push('framework-patched');
          if (kinds.includes('write-outside-repository')) kinds.push('framework-patched');
          for (const k of kinds) flag(k, file, line);
        }
      }
      for (const m of text.matchAll(WRITE_CALL)) {
        const args = callArguments(text, m.index + m[0].length);
        for (const i of WRITE_CHEATCODES[m[1]]) {
          const p = literalArg(args[i]);
          if (p !== null) for (const k of pathKinds(p)) flag(k, file, line);
        }
      }
    }
  }
  const order = (a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  };
  return [...flags.values()].sort(order).slice(0, MAX_TAMPER_FLAGS);
}

// ------------------------------------------------------- the Integrity object

/**
 * The report's Integrity object from each check's failures (details, in
 * run order) and the tamper flags; `failures` names each failed check with
 * its first detail, in CHECKS order.
 */
function integrityOf({ identity = [], summary = [], exit = [], protected: prot = [], framework = [], dependencies = [], tamperFlags: flags = [] }) {
  const lists = {
    identityComplete: identity, summaryConsistent: summary, exitConsistent: exit,
    protectedPathsUnchanged: prot, frameworkUnchanged: framework, dependenciesUnchanged: dependencies
  };
  const result = {};
  const failures = [];
  for (const check of CHECKS) {
    if (check === 'tamperFlags') continue;
    result[check] = lists[check].length === 0;
    if (!result[check]) failures.push({ check, detail: shown(lists[check], 3) });
  }
  result.tamperFlags = flags;
  if (flags.length) {
    failures.push({ check: 'tamperFlags', detail: shown(flags.map((f) => `${f.kind} at ${f.file}${f.line === null ? '' : `:${f.line}`}`), 5, ', ') });
  }
  return { integrity: result, clean: failures.length === 0, failures };
}

/** The first `n` of a check's details, and how many more there are. */
function shown(list, n, sep = '; ') {
  const head = list.slice(0, n).join(sep);
  return list.length > n ? `${head}${sep}and ${list.length - n} more` : head;
}

/** The integrity gate's detail: every failed check with its evidence. */
function integrityDetail(failures) {
  return failures.map((f) => `${f.check} (${f.detail})`).join('; ').slice(0, 2000);
}

module.exports = {
  FRAMEWORK_SCRIPT, MANIFEST_SCRIPT, LINKS_SCRIPT, MANIFEST_MAX_BYTES, MAX_ENTRIES, MAX_WATCHED_LINKS, MAX_LINK_ROUNDS, CONFIG_MAX_BYTES,
  TAMPER_FLAG_KINDS, CHECKS, FRAMEWORK_FILES, DEPENDENCY_DIRS,
  parseFramework, parseManifest, parseLinks, classify, watchRoots, unwatchableRoots, watchLinks, WatchTooLarge, changedPaths, unreadablePaths, displayPath, frameworkArgv, manifestArgv, linksArgv, Watch,
  discoverForge, probe,
  summaryConsistency, exitConsistency, identityGap, tamperFlags, integrityOf, integrityDetail, plainDir
};
