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
 *   (`forge config --json`, which sees foundry.toml, remappings, .env, the
 *   global ~/.foundry/foundry.toml and the environment alike), the root
 *   config files themselves, $HOME but its caches (~/.foundry/cache,
 *   ~/.cache), the PATH directories inside the work tree, solc when it is in
 *   the work tree, forge-std under the dependencies (the assertion library,
 *   forge's "reporter module"), and the build's artifacts (`out`, and forge's
 *   compile cache, which names the artifact files a later run loads), which
 *   may change during the first test run (forge compiles what the build left
 *   out) and never after it.
 *
 * Not watched: the rest of forge's cache directory (`cache_path`: the ABI
 * cache, test-failures, fuzz failures, which forge rewrites on every run),
 * the $HOME caches, /tmp, untracked files elsewhere (a state file a PoC
 * writes). Tracked files outside the sets go back to the PoC commit by the
 * runner's reset before each re-run.
 */

const crypto = require('node:crypto');
const { matchesAny } = require('./common');
const { hermetic } = require('./git');
const { Abstain, ABSTAIN, RequesterError } = require('./result');
const { Prefix } = require('./capture');
const forge = require('./forge');

const WORK = '/work';
const HOME = '/home/sandbox';
const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
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
 * The framework probe (§9.5 check 4, `frameworkUnchanged`), run like the
 * maker's commands (the image's PATH, forge's environment): where `forge`
 * resolves, PATH, and forge's resolved configuration. Later probes run the
 * forge the reference found ($1), never one a run may have put on PATH.
 */
const FRAMEWORK_SCRIPT = [
  'f=$(command -v forge 2>/dev/null) || f=',
  'printf "vcr-forge %s\\n" "$f"',
  'printf "vcr-path %s\\n" "$PATH"',
  'x=${1:-$f}',
  '[ -n "$x" ] || exit 3',
  // Where the forge to run really is (a link into the work tree is the work tree's file): coreutils by absolute path.
  'r=$x; [ -x /usr/bin/readlink ] && r=$(/usr/bin/readlink -f -- "$x" 2>/dev/null) || r=$x',
  'printf "vcr-real %s\\n" "$r"',
  '[ "$2" = noconfig ] && exit 0',
  'exec "$x" config --json'
].join('\n');

/**
 * The manifest of the watched trees, hermetic (nothing of the image's
 * environment): GNU find's records of every entry that is not a directory
 * (type, mode, size, path, link target, NUL-separated), a marker, then
 * sha256sum -z's line for every regular file. "$@" is find's start: the
 * roots, -xdev and the prune expression the runner builds. Errors (an
 * unreadable directory or file) are left out of the listing, never fatal:
 * a file the listing lacks or cannot hash differs from the reference.
 */
const MANIFEST_SCRIPT = [
  'find "$@" ! -type d -printf "%y\\0%m\\0%s\\0%p\\0%l\\0" 2>/dev/null',
  'printf "vcr-hashes\\0"',
  'find "$@" -type f -print0 2>/dev/null | xargs -0 -r sha256sum -z -- 2>/dev/null',
  'exit 0'
].join('\n');

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
  const pathDirs = m[2].split(':').filter((d) => d !== '').map((d) => (d.startsWith('/') ? d.replace(/\/+$/, '') : `${WORK}/${d.replace(/^\.\/?/, '').replace(/\/+$/, '')}`.replace(/\/$/, '')));
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
      solc: str(parsed.solc)
    }
  };
}

/**
 * Read the manifest: find's records, then sha256sum's lines.
 * @param {Buffer} buf
 * @returns {{ok:true, entries:Map<string, {type:string, mode:string, size:string, target:string, hash:string|null}>} | {ok:false, reason:string}}
 *   keys are absolute paths, as bytes read latin1
 */
function parseManifest(buf) {
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

/** One watched entry, as compared: type, mode, size, and the hash (a file; `unreadable` when it could not be hashed) or the target. */
function describe(e) {
  const what = e.type === 'f' ? (e.hash || 'unreadable') : e.type === 'l' ? `-> ${e.target}` : '';
  return `${e.type} ${e.mode} ${e.size} ${what}`;
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
  const deps = [...new Set([...config.libs.map(plainDir).filter(Boolean), ...DEPENDENCY_DIRS])];
  const out = plainDir(config.out);
  const cache = plainDir(config.cachePath);
  // forge's compile cache names the artifact files a later run loads instead of compiling: it is held like them.
  const filesCache = cache ? `${cache}/solidity-files-cache.json` : null;
  const inWork = (p) => (typeof p === 'string' && p.startsWith(`${WORK}/`) ? p.slice(WORK.length + 1) : null);
  const tools = [inWork(forgePath), inWork(realPath), config.solc && !config.solc.startsWith('/') ? plainDir(config.solc) : inWork(config.solc)].filter(Boolean);
  const pathRoots = pathDirs.map((d) => (d === WORK ? '' : inWork(d))).filter((d) => d !== null);
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
      if (rel === filesCache) sets.artifacts.set(rel, d);
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

/**
 * Paths whose description differs between two sets (changed, added or
 * removed), in byte order.
 * @returns {string[]}
 */
function changedPaths(before, after) {
  const out = [];
  for (const [p, d] of before) if (after.get(p) !== d) out.push(p);
  for (const p of after.keys()) if (!before.has(p)) out.push(p);
  return [...new Set(out)].sort();
}

function changeWord(before, after, p) {
  if (!before.has(p)) return 'added';
  if (!after.has(p)) return 'removed';
  return 'changed';
}

// ------------------------------------------------------------ the snapshots

function frameworkArgv(forgePath = '', { config = true } = {}) {
  return ['/bin/sh', '-c', FRAMEWORK_SCRIPT, 'vcr-framework', forgePath, ...(config ? [] : ['noconfig'])];
}

function manifestArgv(roots, prunes = []) {
  const prune = prunes.length ? ['(', ...prunes.flatMap((p, i) => [...(i ? ['-o'] : []), '-path', globLiteral(p)]), ')', '-prune', '-o'] : [];
  return hermetic(MANIFEST_SCRIPT, 'vcr-manifest', [...roots, '-xdev', ...prune]);
}

function runnerError(step, detail) {
  return new Abstain(ABSTAIN.RUNNER_ERROR, detail, { step });
}

async function probe(ctx, name, forgePath, { config = true } = {}) {
  const out = new Prefix(CONFIG_MAX_BYTES);
  const record = await ctx.exec(frameworkArgv(forgePath, { config }), { name, timeoutMs: SNAPSHOT_TIMEOUT_MS, env: forge.forgeEnv(), tee: out });
  return { exitCode: record.exitCode, truncated: out.truncated, bytes: out.bytes(), stderr: record.stderr ? record.stderr.text : '' };
}

async function manifest(ctx, name, roots, prunes) {
  const out = new Prefix(MANIFEST_MAX_BYTES);
  const record = await ctx.exec(manifestArgv(roots, prunes), { name, timeoutMs: SNAPSHOT_TIMEOUT_MS, tee: out });
  if (record.exitCode !== 0) throw runnerError(name, `the watched paths could not be listed (exit ${record.exitCode})`);
  if (out.truncated) return { overflow: true };
  const m = parseManifest(out.bytes());
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
   * @param {string} [o.prefix] - exec names' prefix
   */
  constructor({ protectedGlobs = [], prefix = 'integrity' } = {}) {
    this.protectedGlobs = protectedGlobs;
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
    if (p.exitCode !== 0 || !parsed.ok) {
      throw new RequesterError([{
        code: 'FORGE_CONFIG_INVALID', path: '/spec/env/image',
        detail: `\`forge config --json\` failed at the listed commit (exit ${p.exitCode}): ${firstLine(p.stderr) || parsed.reason || ''}`.trim()
      }]);
    }
    const m = await manifest(ctx, `${name}:manifest`, [WORK, HOME], this.prunes(parsed.config));
    if (m.overflow) {
      throw new RequesterError([{
        code: 'IMAGE_WATCH_TOO_LARGE', path: '/spec/env/image',
        detail: `the work tree's listing exceeds ${MANIFEST_MAX_BYTES} bytes: the runner cannot watch it for changes during a run`
      }]);
    }
    this.ref = { forgePath: parsed.forgePath, realPath: parsed.realPath, pathDirs: parsed.pathDirs, configSha256: parsed.configSha256, config: parsed.config };
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
    this.ref.sets = classify(m.entries, this.watchArgs());
    this.repository = this.ref.sets.repository;
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
    // The reference's real path, never a link a run could retarget.
    const p = await probe(ctx, `${name}:framework`, this.ref.realPath, { config: runnable });
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
    if (m.overflow) {
      const detail = `${label}: the watched paths exceed ${MANIFEST_MAX_BYTES} bytes of listing`;
      for (const c of ['protected', 'framework', 'dependencies']) this.fail(c, detail);
      return null;
    }
    const sets = classify(m.entries, this.watchArgs());
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
    // The first run's artifacts are what the later ones are held to (none when its listing overflowed: already a failure).
    if (first) this.artifacts = sets.artifacts;
    else if (this.artifacts) compare('framework', this.artifacts, sets.artifacts);
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

/** The repository paths a maker's command names (a script it runs), with any leading ./ removed. */
function commandPaths(commands) {
  const out = new Set();
  for (const v of Object.values(commands || {})) {
    if (typeof v !== 'string') continue;
    for (const tok of v.split(/[\s;|&()<>'"`]+/)) {
      const t = tok.replace(/^(?:\.\/)+/, '');
      if (t && !t.startsWith('-') && !t.startsWith('$') && t.includes('/') || /\.(?:sh|js|ts|py|mk)$/.test(t)) out.add(t);
    }
  }
  return out;
}

/**
 * Static tamper flags (§9.5 check 5) over the lines a patch added, in its
 * files under paths.tests (and, for the fix check, the fix's lines): test
 * code that names forge's report channel or writes JUnit markup, ends
 * forge's process or registers an exit handler, changes forge's file
 * permissions inline, writes forge's configuration, its dependencies, its
 * artifacts, the runner's repository or forge-std (the assertion library)
 * with a file cheatcode, or writes outside the repository; and a patch that
 * changes a script a maker's command runs. One flag per kind per line, at
 * most 100, in the report's order (kind, file, line).
 * @param {object} o
 * @param {Map<string, Array<{line:number, text:string}>>} o.added - the patch's added lines by file
 * @param {Array<{status:string, path:string}>} o.touched - the paths the patch touched
 * @param {object} o.commands - the spec's commands
 * @returns {Array<{kind:string, file:string, line:number|null}>}
 */
function tamperFlags({ added, touched = [], commands = {} }) {
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
  const named = commandPaths(commands);
  for (const t of touched) if (named.has(t.path)) flag('framework-patched', t.path, null);
  const order = (a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line === b.line) return 0;
    if (a.line === null) return -1;
    if (b.line === null) return 1;
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
  FRAMEWORK_SCRIPT, MANIFEST_SCRIPT, MANIFEST_MAX_BYTES, CONFIG_MAX_BYTES, TAMPER_FLAG_KINDS, CHECKS, FRAMEWORK_FILES, DEPENDENCY_DIRS,
  parseFramework, parseManifest, classify, changedPaths, displayPath, frameworkArgv, manifestArgv, Watch,
  summaryConsistency, exitConsistency, identityGap, tamperFlags, integrityOf, integrityDetail, plainDir
};
