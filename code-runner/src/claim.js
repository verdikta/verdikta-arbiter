'use strict';

/**
 * The claim pipeline for a forge listing (design §9.2 steps 3-6, §10.1:
 * `applies`, `testPathsOnly`, `build`, `reproduces`). Node A2a.
 *
 *   prepare   the env image's checkout (/repo) copied into the empty /work,
 *             its attributes neutralised (no filter or conversion runs), its
 *             index rebuilt from HEAD and checked to be the listed commit
 *             and clean, and the processes present before any claim code
 *             runs recorded
 *   applies   maxPatchBytes and the 50 MB expansion from the patch's bytes;
 *             then git, in the sandbox, reads and applies it to the listed
 *             commit (index and work tree)
 *   testPathsOnly  git, in the sandbox, lists the paths the applied patch
 *             touched: every one under paths.tests, none under
 *             paths.protected; the flags (existing tests modified, skip
 *             markers, framework or reporter references) from git's diff
 *   reset     protected paths back to the listed commit, then the result is
 *             committed with a fixed author and date
 *   build     the declared build command; its exit code is the gate (tier A)
 *   reproduces  the fixed schedule: testFiles on the PoC's files, then
 *             testIds twice on the tests run 1 found, each with --junit and
 *             the fixed --fuzz-seed. Every test the patch added must fail as
 *             an assertion on all three runs.
 *
 * Gates come only from definitive results: a step that hits a limit, dies or
 * does not start throws Abstain out of ctx.exec, and the run abstains
 * without the gate. A gate that fails stops the pipeline (the later gates
 * are not run). The schedule never looks at the time left: three runs,
 * always, once run 1 found the PoC's tests. Between steps that ran claim
 * code, every process the claim left behind is killed, and the work tree's
 * tracked files go back to the PoC commit before each re-run.
 */

const { ABSTAIN, Abstain, RequesterError } = require('./result');
const { Prefix } = require('./capture');
const { matchesAny, pocPatchPathsGate } = require('./common');
const { git, GIT_ENV, GIT_DIR, COMMIT_ENV, COMMIT_MESSAGE } = require('./git');
const forge = require('./forge');
const { readForgeJUnit, JUNIT_MAX_BYTES } = require('./junit');
const {
  scanPatch, parseNameStatusZ, parseNumstatZ, parseLsTreeZ, parseAddedLines, reportablePath
} = require('./patch');

/** Where the env image keeps the repository checkout at the listed commit (README, "What the env image must provide"). */
const IMAGE_CHECKOUT = '/repo';
/** git's answers (paths, stats, the diff) are read up to this. */
const GIT_OUTPUT_MAX = 16 * 1024 * 1024;
const PREP_TIMEOUT_MS = 120000;
const GIT_TIMEOUT_MS = 120000;
const CLEANUP_TIMEOUT_MS = 60000;
/** The fixed repeat schedule (§9.2 step 6): run 1 with testFiles, runs 2 and 3 with testIds. */
const RUNS = 3;
/** Lists in the facts keep the first entries in code-unit order (the report's bounds). */
const MAX_PATHS = 1000;
const MAX_TESTS = 200;
const MAX_REFERENCES = 200;
const MAX_MESSAGE = 2000;

/** Prints the PIDs in the sandbox other than its own: before any claim code runs, these are the init and the keepalive. */
const PROCS_SCRIPT = [
  'self=$$',
  'for d in /proc/[0-9]*; do',
  '  p=${d#/proc/}',
  '  [ "$p" = "$self" ] || printf "%s\\n" "$p"',
  'done'
].join('\n');

/**
 * Stops and kills every process but its own and the ones given ($@), until
 * none is left: shell builtins and /proc only, so it still runs in a sandbox
 * whose processes hold most of the pid table, and a process cannot fork once
 * stopped. Zombies are left to the init. Prints `killed <n>`; exits 3 when
 * processes are still there after 50 passes.
 */
const CLEANUP_SCRIPT = [
  'self=$$',
  'keep=" $* "',
  'seen=" "',
  'killed=0',
  'pass=0',
  'while [ "$pass" -lt 50 ]; do',
  '  pass=$((pass+1))',
  '  found=',
  '  for d in /proc/[0-9]*; do',
  '    p=${d#/proc/}',
  '    case "$p" in ""|*[!0-9]*) continue ;; esac',
  '    [ "$p" = "$self" ] && continue',
  '    case "$keep" in *" $p "*) continue ;; esac',
  '    s=',
  '    { read -r s < "$d/stat"; } 2>/dev/null || continue',
  '    s=${s##*) }',
  '    case "$s" in Z*|X*) continue ;; esac',
  '    kill -STOP "$p" 2>/dev/null',
  '    found="$found $p"',
  '  done',
  '  if [ -z "$found" ]; then printf "killed %s\\n" "$killed"; exit 0; fi',
  '  for p in $found; do',
  '    kill -KILL "$p" 2>/dev/null || continue',
  '    case "$seen" in *" $p "*) ;; *) seen="$seen$p "; killed=$((killed+1)) ;; esac',
  '  done',
  'done',
  'printf "killed %s\\n" "$killed"',
  'exit 3'
].join('\n');

/**
 * Copies the checkout ($1) into the empty work tree, refuses a git directory
 * that points elsewhere, and writes the runner's attributes ($2) to
 * .git/info/attributes. A git directory must be self-contained: a symbolic
 * link in it, a `commondir` file (git then reads config, info/, refs and
 * objects from that other directory), object alternates or grafts could
 * leave the repository's metadata in the work tree, where a patched file
 * would stand in for its config or attributes. Exit 10: no checkout; 11: not
 * a git repository; 12: the copy failed; 13: the git directory points
 * elsewhere; 14: .git/info could not be written.
 */
const CHECKOUT_SCRIPT = [
  'set -u',
  'src=$1',
  '[ -d "$src" ] || exit 10',
  '[ -d "$src/.git" ] && [ ! -L "$src/.git" ] || exit 11',
  'cp -a -- "$src/." /work/ || exit 12',
  'link=$(find /work/.git -type l -print -quit) || exit 13',
  '[ -z "$link" ] || exit 13',
  'for f in commondir objects/info/alternates objects/info/http-alternates info/grafts; do',
  '  [ -e "/work/.git/$f" ] && exit 13',
  'done',
  'mkdir -p /work/.git/info && rm -f /work/.git/info/attributes && printf "%s\\n" "$2" > /work/.git/info/attributes || exit 14',
  'exit 0'
].join('\n');

/**
 * The repository's highest-precedence attributes (§9.1: claim content never
 * runs outside the declared commands). Every path gets no filter driver (a
 * clean or smudge command, which a patched file could be), no diff, merge or
 * textconv driver, no line-ending or working-tree-encoding conversion and no
 * ident expansion: the work tree holds the commit's bytes and the patch's,
 * exactly, and git runs nothing of the repository's.
 */
const NEUTRAL_ATTRIBUTES = '* !filter !diff !merge !text !eol !ident !working-tree-encoding';

/**
 * Run by `git submodule foreach --recursive` in every submodule, before the
 * clean check: the superproject's rules for the submodule's own repository.
 * Its git directory must be self-contained (no commondir, alternates,
 * grafts or symbolic link: its info/attributes must be the one git reads),
 * its attributes are neutralised (a submodule's clean filter could map
 * changed bytes back to the committed blob), and its index is rebuilt from
 * its HEAD (no assume-unchanged or skip-worktree bit) and refreshed.
 */
const SUBMODULE_INDEX_SCRIPT = [
  'gd=$(git rev-parse --path-format=absolute --git-dir) && cdir=$(git rev-parse --path-format=absolute --git-common-dir) || exit 1',
  '[ "$gd" = "$cdir" ] || exit 1',
  'for f in commondir objects/info/alternates objects/info/http-alternates info/grafts; do [ -e "$gd/$f" ] && exit 1; done',
  'link=$(find "$gd" -type l -print -quit) || exit 1',
  '[ -z "$link" ] || exit 1',
  `mkdir -p "$gd/info" && rm -f "$gd/info/attributes" && printf '%s\\n' '${NEUTRAL_ATTRIBUTES}' > "$gd/info/attributes" || exit 1`,
  'git read-tree HEAD || exit 1',
  'git update-index -q --refresh',
  'exit 0'
].join('; ');

const COMMIT_HEX = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function firstLine(text) {
  const line = String(text || '').split(/\r?\n/).find((l) => l.trim());
  return line ? line.trim().slice(0, 300) : '';
}

function issue(code, path, detail) {
  return { code, path, detail };
}

/** A command the forge adapter needs, with the placeholder the runner fills (if any). */
function commandIssues(commands, key, placeholder) {
  const value = commands ? commands[key] : undefined;
  const path = `/spec/commands/${key}`;
  if (typeof value !== 'string' || value.trim() === '') return [issue('COMMAND_MISSING', path, `the forge adapter needs commands.${key}`)];
  if (value.length > 2000 || /[\u0000\r\n]/.test(value)) return [issue('COMMAND_INVALID', path, `commands.${key} must be one line of at most 2000 characters`)];
  if (placeholder && !new RegExp(`\\$(?:${placeholder}|\\{${placeholder}\\})(?![A-Za-z0-9_])`).test(value)) {
    return [issue('COMMAND_PLACEHOLDER', path, `commands.${key} must use $${placeholder}, which the runner fills`)];
  }
  return [];
}

/** What the forge adapter needs from the request, checked before any claim code runs. */
function checkClaim(request) {
  const spec = request.spec || {};
  const issues = [];
  const commands = spec.commands && typeof spec.commands === 'object' ? spec.commands : {};
  if (commands.framework !== 'forge') issues.push(issue('FRAMEWORK_UNSUPPORTED', '/spec/commands/framework', 'this runner runs forge listings only (the Foundry MVP)'));
  if (!spec.env || spec.env.from !== 'foundry') issues.push(issue('ENV_UNSUPPORTED', '/spec/env/from', 'this runner runs env images built FROM the pinned foundry base only'));
  issues.push(...commandIssues(commands, 'build', null), ...commandIssues(commands, 'testFiles', 'FILES'), ...commandIssues(commands, 'testIds', 'TEST_IDS'));
  if (typeof spec.baseCommit !== 'string' || !COMMIT_HEX.test(spec.baseCommit)) issues.push(issue('SCHEMA', '/spec/baseCommit', 'must be a full commit hash'));
  const paths = spec.paths;
  const globs = (v) => Array.isArray(v) && v.every((g) => typeof g === 'string' && g !== '');
  if (!paths || !globs(paths.tests) || paths.tests.length === 0) issues.push(issue('SCHEMA', '/spec/paths/tests', 'must be a non-empty list of globs'));
  else if (paths.protected !== undefined && !globs(paths.protected)) issues.push(issue('SCHEMA', '/spec/paths/protected', 'must be a list of globs'));
  const baseline = request.baseline;
  if (!baseline || !Array.isArray(baseline.tests) || !baseline.tests.every((t) => t && typeof t.id === 'string')) {
    issues.push(issue('BASELINE_INVALID', '/baseline/tests', 'baseline.json must list the tests at the listed commit (tests[].id)'));
  }
  return issues;
}

function sortedUnique(list) {
  return [...new Set(list)].sort();
}

function capped(list, max) {
  return list.length > max ? list.slice(0, max) : list;
}

function listPaths(paths) {
  const shown = paths.slice(0, 5).join(', ');
  return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown;
}

/** A failure message as the report carries it: repository-relative, bounded. */
function normaliseMessage(message) {
  if (typeof message !== 'string') return null;
  return message.split('/work/').join('').slice(0, MAX_MESSAGE);
}

/**
 * The claim steps for a forge listing.
 * @param {object} request - the validated POST /v1/runs request
 * @param {object} limits - the effective limits
 * @returns {Function[]}
 */
function claimSteps(request, limits) {
  const issues = checkClaim(request);
  if (issues.length) return [async () => { throw new RequesterError(issues); }];

  const spec = request.spec;
  const base = spec.baseCommit;
  const testGlobs = spec.paths.tests;
  const protectedGlobs = spec.paths.protected || [];
  const baselineIds = new Set(request.baseline.tests.map((t) => t.id));
  const state = { done: false, keep: [], touched: null, pocCommit: null, leftovers: [] };

  /** Run a git command and read its stdout (capped); definitive or it throws. */
  async function gitRead(ctx, name, args, { stdin, env } = {}) {
    const out = new Prefix(GIT_OUTPUT_MAX);
    const record = await ctx.exec(git(args), { name, timeoutMs: GIT_TIMEOUT_MS, stdin, env: { ...GIT_ENV, ...(env || {}) }, tee: out });
    return { record, out };
  }

  function runnerError(step, detail) {
    return new Abstain(ABSTAIN.RUNNER_ERROR, detail, { step });
  }

  /** Kill whatever the last step left behind (§9.5: claim processes that outlive a step). */
  async function cleanup(ctx, after) {
    const name = `cleanup:${after}`;
    const out = new Prefix(4096);
    const record = await ctx.exec(['/bin/sh', '-c', CLEANUP_SCRIPT, 'vcr-cleanup', ...state.keep], { name, timeoutMs: CLEANUP_TIMEOUT_MS, tee: out });
    const m = /^killed ([0-9]+)$/m.exec(out.bytes().toString('utf8'));
    if (record.exitCode !== 0 || !m) {
      throw new Abstain(ABSTAIN.DOCKER_ERROR, `processes the step left in the sandbox could not be stopped (exit ${record.exitCode})`, { step: name });
    }
    state.leftovers.push({ after, killed: Number(m[1]) });
    ctx.fact('leftoverProcesses', state.leftovers);
  }

  async function prepare(ctx) {
    const procs = new Prefix(64 * 1024);
    await ctx.exec(['/bin/sh', '-c', PROCS_SCRIPT, 'vcr-procs'], { name: 'prepare:procs', timeoutMs: PREP_TIMEOUT_MS, tee: procs });
    state.keep = procs.bytes().toString('utf8').split('\n').filter((l) => /^[0-9]+$/.test(l));
    if (state.keep.length === 0) throw new Abstain(ABSTAIN.DOCKER_ERROR, 'the sandbox\'s processes could not be listed', { step: 'prepare:procs' });

    const copy = await ctx.exec(['/bin/sh', '-c', CHECKOUT_SCRIPT, 'vcr-checkout', IMAGE_CHECKOUT, NEUTRAL_ATTRIBUTES], { name: 'prepare:checkout', timeoutMs: PREP_TIMEOUT_MS });
    const image = '/spec/env/image';
    switch (copy.exitCode) {
      case 0: break;
      case 10: throw new RequesterError([issue('IMAGE_CHECKOUT_MISSING', image, `the env image has no repository checkout at ${IMAGE_CHECKOUT}`)]);
      case 11: throw new RequesterError([issue('IMAGE_CHECKOUT_NOT_GIT', image, `${IMAGE_CHECKOUT} in the env image is not a git repository`)]);
      case 12: throw new RequesterError([issue('IMAGE_CHECKOUT_UNREADABLE', image,
        `the checkout could not be copied into the work tree as uid 10001 (unreadable, or larger than the work tree): ${firstLine(copy.stderr.text)}`)]);
      case 13: throw new RequesterError([issue('IMAGE_CHECKOUT_GIT_REDIRECT', image,
        `${IMAGE_CHECKOUT}/.git points elsewhere (a symbolic link, commondir, object alternates or grafts); the git directory must be self-contained`)]);
      case 14: throw new RequesterError([issue('IMAGE_CHECKOUT_NOT_GIT', image, `.git/info in the copied checkout could not be written: ${firstLine(copy.stderr.text)}`)]);
      default: throw new Abstain(ABSTAIN.DOCKER_ERROR, `the checkout copy exited ${copy.exitCode}`, { step: 'prepare:checkout' });
    }

    // And git agrees: its git directory and common directory are /work/.git.
    const dirs = await gitRead(ctx, 'prepare:gitdir', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
    if (dirs.record.exitCode !== 0 || dirs.out.bytes().toString('utf8') !== `${GIT_DIR}\n${GIT_DIR}\n`) {
      throw new RequesterError([issue('IMAGE_CHECKOUT_GIT_REDIRECT', image,
        `git does not keep the checkout's repository in its own .git: ${firstLine(dirs.out.bytes().toString('utf8') + dirs.record.stderr.text).slice(0, 200)}`)]);
    }
    const head = await gitRead(ctx, 'prepare:head', ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
    if (head.record.exitCode !== 0) {
      throw new RequesterError([issue('IMAGE_CHECKOUT_NOT_GIT', image, `HEAD of the env image's checkout is not a commit: ${firstLine(head.record.stderr.text)}`)]);
    }
    const headCommit = head.out.bytes().toString('utf8').trim();
    if (headCommit !== base) {
      throw new RequesterError([issue('IMAGE_CHECKOUT_MISMATCH', '/spec/baseCommit', `the env image's checkout is at ${headCommit.slice(0, 64)}, not the listed commit ${base}`)]);
    }
    // The copied index is the image's: it could mark a changed file
    // assume-unchanged or skip-worktree, and git status would then call it
    // clean. Rebuild it from HEAD, in the repository and in every submodule,
    // and refresh it, so git compares every tracked file's bytes with the
    // commit's (refresh's exit code says only that some file needed it).
    const index = await ctx.exec(git(['read-tree', 'HEAD']), { name: 'prepare:index', timeoutMs: GIT_TIMEOUT_MS, env: GIT_ENV });
    if (index.exitCode !== 0) {
      throw new RequesterError([issue('IMAGE_CHECKOUT_NOT_GIT', image, `the checkout's index could not be rebuilt from HEAD: ${firstLine(index.stderr.text)}`)]);
    }
    const subs = await ctx.exec(git(['submodule', 'foreach', '--quiet', '--recursive', SUBMODULE_INDEX_SCRIPT]), {
      name: 'prepare:submodules', timeoutMs: GIT_TIMEOUT_MS, env: GIT_ENV
    });
    if (subs.exitCode !== 0) {
      throw new RequesterError([issue('IMAGE_CHECKOUT_GIT_REDIRECT', image,
        `a submodule's repository is not self-contained or its index could not be rebuilt from its HEAD: ${firstLine(subs.stderr.text)}`)]);
    }
    await ctx.exec(git(['update-index', '-q', '--refresh']), { name: 'prepare:refresh', timeoutMs: GIT_TIMEOUT_MS, env: GIT_ENV });
    // Untracked and ignored files may be there (installed dependencies, also
    // inside submodules); tracked files, and submodules' commits and tracked
    // files, must be the listed commit's.
    const status = await gitRead(ctx, 'prepare:status', ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=untracked']);
    if (status.record.exitCode !== 0) {
      throw new RequesterError([issue('IMAGE_CHECKOUT_NOT_GIT', image, `git status failed on the env image's checkout: ${firstLine(status.record.stderr.text)}`)]);
    }
    const dirty = status.out.bytes().toString('utf8').split('\0').filter(Boolean).map((e) => e.slice(3));
    if (dirty.length || status.out.truncated) {
      throw new RequesterError([issue('IMAGE_CHECKOUT_DIRTY', image,
        `the env image's checkout differs from the listed commit in ${listPaths(dirty)}; tracked files must be the commit's`)]);
    }
    ctx.fact('commit', { base, poc: null });
  }

  async function applies(ctx) {
    const scan = scanPatch(request.pocPatch, limits);
    ctx.fact('patch', { bytes: scan.bytes, sha256: scan.sha256, expansionBytes: scan.expansionBytes, binaryHunks: scan.binaryHunks });
    if (!scan.ok) {
      ctx.gate('applies', 'fail', 'input', scan.reason);
      state.done = true;
      return;
    }
    const parsed = await gitRead(ctx, 'patch:read', ['apply', '--numstat', '-z', '--whitespace=nowarn', '-'], { stdin: request.pocPatch });
    if (parsed.record.exitCode !== 0) {
      ctx.gate('applies', 'fail', 'exit_code', `git could not read poc.patch (exit ${parsed.record.exitCode}): ${firstLine(parsed.record.stderr.text)}`);
      state.done = true;
      return;
    }
    const entries = parsed.out.truncated ? null : parseNumstatZ(parsed.out.bytes());
    if (!entries) throw runnerError('patch:read', 'git\'s reading of poc.patch could not be parsed');
    // git holds the result of every entry in memory before it writes; one
    // file patched many times over would multiply a large file. git diff
    // never writes a patch like that.
    const seen = new Set();
    for (const e of entries) {
      if (seen.has(e.path)) {
        ctx.gate('applies', 'fail', 'exit_code', `poc.patch changes ${e.path.slice(0, 300)} more than once`);
        state.done = true;
        return;
      }
      seen.add(e.path);
    }
    const applied = await ctx.exec(git(['apply', '--index', '--whitespace=nowarn', '-']), {
      name: 'patch:apply', timeoutMs: GIT_TIMEOUT_MS, stdin: request.pocPatch, env: GIT_ENV
    });
    if (applied.exitCode !== 0) {
      ctx.gate('applies', 'fail', 'exit_code', `poc.patch does not apply to the listed commit ${base} (exit ${applied.exitCode}): ${firstLine(applied.stderr.text)}`);
      state.done = true;
      return;
    }
    ctx.gate('applies', 'pass', 'exit_code', `poc.patch applies to the listed commit ${base}`);
  }

  async function testPathsOnly(ctx) {
    const ns = await gitRead(ctx, 'patch:paths', ['diff', '--cached', '--name-status', '-z', '--no-renames', 'HEAD', '--']);
    const touched = ns.record.exitCode === 0 && !ns.out.truncated ? parseNameStatusZ(ns.out.bytes()) : null;
    if (!touched) throw runnerError('patch:paths', `the paths poc.patch touched could not be read (git exited ${ns.record.exitCode})`);
    const num = await gitRead(ctx, 'patch:stats', ['diff', '--cached', '--numstat', '-z', '--no-renames', 'HEAD', '--']);
    const stats = num.record.exitCode === 0 && !num.out.truncated ? parseNumstatZ(num.out.bytes()) : null;
    if (!stats) throw runnerError('patch:stats', `the diff stats of poc.patch could not be read (git exited ${num.record.exitCode})`);
    const diff = await gitRead(ctx, 'patch:diff', ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
      '--diff-algorithm=myers', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD', '--']);
    const added = diff.record.exitCode === 0 ? parseAddedLines(diff.out.bytes()) : null;
    if (!added || !added.ok) throw runnerError('patch:diff', `the diff of poc.patch could not be read: ${added ? added.reason : `git exited ${diff.record.exitCode}`}`);

    ctx.fact('diff', {
      files: stats.length,
      added: stats.reduce((n, s) => n + s.added, 0),
      removed: stats.reduce((n, s) => n + s.removed, 0),
      binaryFiles: stats.filter((s) => s.binary).length
    });

    const paths = touched.map((t) => t.path);
    const gate = pocPatchPathsGate(paths, spec);
    const unreportable = sortedUnique(paths.filter((p) => !reportablePath(p) && !gate.outside.includes(p)));
    const outside = sortedUnique(gate.outside);
    const prot = sortedUnique(gate.protected);
    ctx.fact('testPaths', { outside: capped(outside, MAX_PATHS), protected: capped(prot, MAX_PATHS), unreportable: capped(unreportable, MAX_PATHS) });

    // Tier-A flags (§9.2 step 3), as plain repository paths under paths.tests.
    const inTests = (p) => reportablePath(p) && matchesAny(p, testGlobs);
    const skipFiles = [];
    const references = [];
    for (const [file, lines] of added.files) {
      if (!inTests(file)) continue;
      const scan = forge.scanAddedLines(lines);
      if (scan.skipMarkers.length) skipFiles.push(file);
      for (const r of scan.references) references.push({ file, line: r.line, rule: r.rule });
    }
    references.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    ctx.fact('flags', {
      existingTestsModified: capped(sortedUnique(touched.filter((t) => t.status !== 'A' && inTests(t.path)).map((t) => t.path)), MAX_PATHS),
      skipMarkersAdded: capped(sortedUnique(skipFiles), MAX_PATHS),
      protectedPathsTouched: capped(prot.filter(reportablePath), MAX_PATHS),
      frameworkReferences: capped(references, MAX_REFERENCES)
    });

    if (!gate.pass || unreportable.length) {
      const parts = [];
      if (outside.length) parts.push(`${listPaths(outside)} outside paths.tests`);
      if (prot.length) parts.push(`${listPaths(prot)} under paths.protected`);
      if (unreportable.length) parts.push(`${listPaths(unreportable)}, which cannot be named in a report (whitespace, a control character or a backslash)`);
      if (!parts.length) parts.push('nothing');
      ctx.gate('testPathsOnly', 'fail', 'exit_code', `poc.patch touches ${parts.join('; ')}`);
      state.done = true;
      return;
    }
    state.touched = touched;
    ctx.gate('testPathsOnly', 'pass', 'exit_code', `poc.patch touches ${touched.length} path${touched.length === 1 ? '' : 's'}, all under paths.tests`);
  }

  async function resetAndCommit(ctx) {
    const tree = await gitRead(ctx, 'reset:list', ['ls-tree', '-r', '-z', '--full-tree', '--name-only', '--end-of-options', base]);
    const all = tree.record.exitCode === 0 && !tree.out.truncated ? parseLsTreeZ(tree.out.bytes()) : null;
    if (!all) throw runnerError('reset:list', `the listed commit's files could not be listed (git exited ${tree.record.exitCode})`);
    const protectedFiles = protectedGlobs.length ? all.filter((p) => matchesAny(p, protectedGlobs)) : [];
    if (protectedFiles.length) {
      const reset = await ctx.exec(git(['checkout', base, '--pathspec-from-file=-', '--pathspec-file-nul']), {
        name: 'reset:protected', timeoutMs: GIT_TIMEOUT_MS, stdin: Buffer.from(protectedFiles.join('\0')), env: { ...GIT_ENV, GIT_LITERAL_PATHSPECS: '1' }
      });
      if (reset.exitCode !== 0) throw runnerError('reset:protected', `the protected paths could not be reset: ${firstLine(reset.stderr.text)}`);
    }
    ctx.fact('protectedReset', protectedFiles.length);
    const commit = await ctx.exec(git(['commit', '--quiet', '--no-verify', '--no-gpg-sign', '--allow-empty', '--cleanup=whitespace', '--message', COMMIT_MESSAGE]), {
      name: 'patch:commit', timeoutMs: GIT_TIMEOUT_MS, env: { ...GIT_ENV, ...COMMIT_ENV }
    });
    if (commit.exitCode !== 0) throw runnerError('patch:commit', `the patched tree could not be committed: ${firstLine(commit.stderr.text)}`);
    const head = await gitRead(ctx, 'patch:head', ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
    const poc = head.out.bytes().toString('utf8').trim();
    if (head.record.exitCode !== 0 || !COMMIT_HEX.test(poc)) throw runnerError('patch:head', 'the PoC commit could not be read');
    state.pocCommit = poc;
    ctx.fact('commit', { base, poc });
  }

  async function build(ctx) {
    const record = await ctx.exec(forge.commandArgv(spec.commands.build, { name: 'vcr-build' }), {
      name: 'build', timeoutMs: limits.buildSeconds * 1000, env: forge.forgeEnv()
    });
    await cleanup(ctx, 'build');
    const ok = record.exitCode === 0;
    ctx.gate('build', ok ? 'pass' : 'fail', 'exit_code', `the build command exited ${record.exitCode}`);
    if (!ok) state.done = true;
  }

  /** One PoC run: the JUnit read, the harness records failing in the PoC's suites. */
  async function pocRun(ctx, index, command, env) {
    const out = new Prefix(JUNIT_MAX_BYTES);
    const name = `poc:${index}`;
    const record = await ctx.exec(forge.commandArgv(command, { name: 'vcr-poc', append: forge.reporterFlags() }), {
      name, timeoutMs: limits.testSeconds * 1000, env: { ...forge.forgeEnv(), ...env }, tee: out
    });
    await cleanup(ctx, name);
    const bytes = out.bytes();
    const blank = out.totalBytes === 0 || !/[^\s]/.test(bytes.toString('latin1'));
    const read = blank ? null : readForgeJUnit(bytes, { truncated: out.truncated });
    return {
      exitCode: record.exitCode,
      junit: blank ? 'absent' : read.ok ? 'ok' : 'invalid',
      reason: blank ? `forge printed no JUnit (exit ${record.exitCode})` : read.ok ? null : read.reason,
      suites: read && read.ok ? read.suites : null
    };
  }

  async function reproduces(ctx) {
    const files = sortedUnique(state.touched.filter((t) => t.status !== 'D' && t.path.endsWith('.sol')).map((t) => t.path));
    const done = (status, basis, detail) => { ctx.gate('reproduces', status, basis, detail); state.done = true; };
    if (files.length === 0) {
      ctx.fact('poc', pocFacts([], []));
      done('fail', 'exit_code', 'poc.patch adds or changes no Solidity file under paths.tests: there is no PoC to run');
      return;
    }
    const fileSet = new Set(files);
    const FILES = forge.filesGlob(files);
    const runs = [];
    runs.push({ command: 'testFiles', ...(await pocRun(ctx, 1, spec.commands.testFiles, { FILES })) });

    // The tests the patch added: test functions in the PoC's files, as run 1
    // reported them, that are not in the listed commit's baseline.
    const signatures = new Map();
    if (runs[0].suites) {
      for (const s of runs[0].suites) {
        if (!fileSet.has(s.file)) continue;
        for (const c of s.cases) {
          if (!forge.isTestFunction(c.name)) continue;
          const id = forge.testIdentity(s.file, s.contract, c.name);
          if (!baselineIds.has(id)) signatures.set(id, c.name);
        }
      }
    }
    const ids = [...signatures.keys()].sort();
    if (ids.length > 0) {
      const TEST_IDS = forge.testIdsRegex([...signatures.values()]);
      for (let k = 2; k <= RUNS; k += 1) {
        const reset = await ctx.exec(git(['reset', '--quiet', '--hard', state.pocCommit]), { name: `poc:reset:${k}`, timeoutMs: GIT_TIMEOUT_MS, env: GIT_ENV });
        if (reset.exitCode !== 0) throw runnerError(`poc:reset:${k}`, `the work tree could not be reset to the PoC commit: ${firstLine(reset.stderr.text)}`);
        runs.push({ command: 'testIds', ...(await pocRun(ctx, k, spec.commands.testIds, { FILES, TEST_IDS })) });
      }
    }

    // Each added test on each run, and the harness records that failed in the PoC's suites.
    const results = new Map(ids.map((id) => [id, []]));
    const harness = [];
    runs.forEach((run, r) => {
      const errors = [];
      const records = new Map(ids.map((id) => [id, []]));
      if (run.suites) {
        for (const s of run.suites) {
          if (!fileSet.has(s.file)) continue;
          for (const c of s.cases) {
            if (forge.isHarnessRecord(c.name)) {
              if (c.outcome === 'failure' || c.outcome === 'error') errors.push({ suite: `${s.file}:${s.contract}`, name: c.name, message: normaliseMessage(c.message) });
              continue;
            }
            // Other records (an invariant campaign's `handler …` cases) are not tests of their own.
            if (!forge.isTestFunction(c.name)) continue;
            const id = forge.testIdentity(s.file, s.contract, c.name);
            if (records.has(id)) records.get(id).push(c);
          }
        }
      }
      errors.sort((a, b) => (a.suite + a.name < b.suite + b.name ? -1 : 1));
      harness.push(errors);
      for (const id of ids) {
        const got = records.get(id);
        let entry;
        if (!run.suites) entry = { result: 'error', kind: null, message: null };
        else if (got.length === 0) entry = { result: 'missing', kind: null, message: null };
        else if (got.length > 1) entry = { result: 'duplicate', kind: null, message: null };
        else entry = { ...forge.classifyRecord(got[0]), message: normaliseMessage(got[0].message) };
        results.get(id).push(entry);
      }
      run.harnessErrors = capped(errors, MAX_TESTS);
    });
    for (let r = runs.length; r < RUNS; r += 1) for (const id of ids) results.get(id).push({ result: 'not-run', kind: null, message: null });

    ctx.fact('poc', pocFacts(ids.map((id) => [id, results.get(id)]), runs));
    done(...reproducesVerdict(runs, harness, ids, results));
  }

  return [prepare, applies, testPathsOnly, resetAndCommit, build, reproduces].map((step) => {
    const wrapped = async (ctx) => { if (!state.done) await step(ctx); };
    Object.defineProperty(wrapped, 'name', { value: step.name });
    return wrapped;
  });
}

const WORD = Object.freeze({ pass: 'passed', error: 'errored', skip: 'skipped', missing: 'missing', duplicate: 'duplicated' });

/**
 * The reproduces gate from the three runs, in a fixed order (run by run;
 * within a run: the JUnit, the harness, then the tests in code-unit order),
 * so the detail names the same first failure on every arbiter.
 * @returns {[status:string, basis:string, detail:string]}
 */
function reproducesVerdict(runs, harness, ids, results) {
  const unreadable = (run, k) => (run.junit === 'absent'
    ? `no JUnit on run ${k}: ${run.reason}; a compile, collection or setUp error`
    : `unreadable JUnit on run ${k}: ${run.reason}`);
  if (!runs[0].suites) return ['fail', 'junit', unreadable(runs[0], 1)];
  if (harness[0].length) {
    const h = harness[0][0];
    return ['fail', 'junit', `${h.name} failed in ${h.suite} on run 1${h.message ? `: ${h.message.slice(0, 300)}` : ''}`];
  }
  if (ids.length === 0) return ['fail', 'junit', 'no test the patch added ran on run 1'];
  for (let r = 0; r < runs.length; r += 1) {
    const k = r + 1;
    if (r > 0 && !runs[r].suites) return ['fail', 'junit', unreadable(runs[r], k)];
    if (r > 0 && harness[r].length) {
      const h = harness[r][0];
      return ['fail', 'junit', `${h.name} failed in ${h.suite} on run ${k}${h.message ? `: ${h.message.slice(0, 300)}` : ''}`];
    }
    for (const id of ids) {
      const e = results.get(id)[r];
      if (e.result === 'fail') continue;
      const why = e.result === 'error' && e.message ? ` (${e.message.slice(0, 300)})` : '';
      return ['fail', 'junit', `${id} ${WORD[e.result] || e.result} on run ${k}${why}`];
    }
  }
  return ['pass', 'junit', `${ids.length} test${ids.length === 1 ? '' : 's'} the patch added failed as an assertion on all ${RUNS} runs`];
}

/** The PoC facts (§9.4 `poc`): counts over every test and run, the first 200 tests in code-unit order. */
function pocFacts(entries, runs) {
  const runCounts = { fail: 0, pass: 0, error: 0, skip: 0, missing: 0, duplicate: 0, notRun: 0 };
  const tests = [];
  for (const [id, list] of entries) {
    for (const e of list) runCounts[e.result === 'not-run' ? 'notRun' : e.result] += 1;
    const recorded = list.find((e) => (e.result === 'fail' || e.result === 'error') && e.kind);
    if (tests.length < MAX_TESTS) {
      tests.push({ id, runs: list.map((e) => e.result), kind: recorded ? recorded.kind : null, message: recorded ? recorded.message : null });
    }
  }
  return {
    tier: 'B',
    testCount: entries.length,
    runCounts,
    tests,
    runs: runs.map((run) => ({
      command: run.command, junit: run.junit, reason: run.reason, exitCode: run.exitCode, harnessErrors: run.harnessErrors || []
    }))
  };
}

module.exports = {
  claimSteps, checkClaim, IMAGE_CHECKOUT, PROCS_SCRIPT, CLEANUP_SCRIPT, CHECKOUT_SCRIPT, NEUTRAL_ATTRIBUTES, SUBMODULE_INDEX_SCRIPT, RUNS
};
