'use strict';

/**
 * The claim pipeline for a forge listing (design §9.2 steps 3-6, §10.1:
 * `applies`, `testPathsOnly`, `build`, `reproduces`). Node A2a.
 *
 *   prepare   the processes present before any claim code runs recorded;
 *             then the forced checkout (checkout.js): /work becomes the
 *             listed commit, read from the env image's objects as data and
 *             re-hashed by the runner, every tracked path replaced, in a
 *             fresh repository with the runner's own settings; untracked
 *             files (installed dependencies) stay as the image built them
 *   applies   maxPatchBytes and the 50 MB expansion from the patch's bytes;
 *             then git, in the sandbox, reads and applies it to the listed
 *             commit (index and work tree)
 *   testPathsOnly  git, in the sandbox, lists the paths the applied patch
 *             touched: every one under paths.tests, none under
 *             paths.protected; the flags (existing tests modified, skip
 *             markers, framework or reporter references) from git's diff
 *   reset     protected paths back to the listed commit (the checkout's
 *             commit of it), then the result is committed with a fixed
 *             author and date
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
const { git, COMMIT_ENV, COMMIT_MESSAGE } = require('./git');
const { forceCheckout, IMAGE_CHECKOUT, NEUTRAL_ATTRIBUTES } = require('./checkout');
const forge = require('./forge');
const { readForgeJUnit, JUNIT_MAX_BYTES } = require('./junit');
const {
  scanPatch, parseRawZ, sumObjectSizes, parseNameStatusZ, parseNumstatZ, parseLsTreeZ, parseAddedLines, reportablePath
} = require('./patch');

/** git's answers (paths, stats, the diff) are read up to this. */
const GIT_OUTPUT_MAX = 16 * 1024 * 1024;
const PREP_TIMEOUT_MS = 120000;
const GIT_TIMEOUT_MS = 120000;
/** The patch's own apply budget: a timeout here is the patch's fault, not the run's (§9.2 step 3, owner decision Q26). */
const APPLY_TIMEOUT_MS = 90000;
const CLEANUP_TIMEOUT_MS = 60000;
/** The work tree (git.js WORK_TREE), and the headroom the apply needs beyond patchExpansionBytes, so ENOSPC is the patch's fault, not a full image's. */
const WORK_TREE = '/work';
const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
/**
 * Prints the work tree's free bytes as `vcr-free <bytes>`: GNU `stat -f` (free
 * blocks x block size), falling back to `df` (POSIX 1K blocks) where statfs is
 * not available. Both ship on the foundry base; one of them answers on every
 * runtime (runc and gVisor).
 */
const FREE_SPACE_SCRIPT = [
  `b=$(stat -f -c '%a %S' ${WORK_TREE} 2>/dev/null) && set -- $b && printf 'vcr-free %s\\n' "$(( $1 * $2 ))" && exit 0`,
  `k=$(df -P -k ${WORK_TREE} 2>/dev/null | awk 'NR==2{print $4}') && [ -n "$k" ] && printf 'vcr-free %s\\n' "$(( k * 1024 ))" && exit 0`,
  'exit 1'
].join('\n');
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
 * none is left alive: shell builtins and /proc only, so it still runs in a
 * sandbox whose processes hold most of the pid table, and a process cannot
 * fork once stopped.
 *
 * Every other process is signalled on every pass, whatever its state. A
 * process counts as gone only when every one of its tasks is a zombie (a
 * zombie leader can have live threads), and a task's state is read from its
 * whole stat file, after the last ") ": the process name before it is the
 * process's own to choose (`/proc/self/comm`) and can hold ") Z" and line
 * breaks. Zombies are left to the init. Prints `killed <n>`; exits 3 when a
 * process is still alive after 50 passes.
 */
const CLEANUP_SCRIPT = [
  'self=$$',
  'keep=" $* "',
  'seen=" "',
  'killed=0',
  'pass=0',
  'alive() {',
  '  for t in "$1"/task/[0-9]*; do',
  '    [ -e "$t/stat" ] || continue',
  '    s=',
  '    { while IFS= read -r l || [ -n "$l" ]; do s="$s $l"; done < "$t/stat"; } 2>/dev/null || continue',
  '    s=${s##*) }',
  '    case "$s" in Z*|X*) ;; *) return 0 ;; esac',
  '  done',
  '  return 1',
  '}',
  'while [ "$pass" -lt 50 ]; do',
  '  pass=$((pass+1))',
  '  found=',
  '  for d in /proc/[0-9]*; do',
  '    p=${d#/proc/}',
  '    case "$p" in ""|*[!0-9]*) continue ;; esac',
  '    [ "$p" = "$self" ] && continue',
  '    case "$keep" in *" $p "*) continue ;; esac',
  '    kill -STOP "$p" 2>/dev/null',
  '    alive "$d" && found="$found $p"',
  '    kill -KILL "$p" 2>/dev/null',
  '  done',
  '  if [ -z "$found" ]; then printf "killed %s\\n" "$killed"; exit 0; fi',
  '  for p in $found; do',
  '    case "$seen" in *" $p "*) ;; *) seen="$seen$p "; killed=$((killed+1)) ;; esac',
  '  done',
  'done',
  'printf "killed %s\\n" "$killed"',
  'exit 3'
].join('\n');

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
/**
 * Why a failed `git apply` blames the patch (`input`, PATCH_EXPANSION) rather
 * than the run, given the work tree's free space was confirmed first. An OOM
 * kill or the apply's own wall-clock budget is then the patch materialising
 * more than it may; the run's own deadline, budget or cancellation is not.
 * @param {Abstain} abstain - the abstain ctx.exec threw for the apply step
 * @param {number} applyTimeoutMs - the apply's own budget
 * @returns {string|null} the gate detail when it is the patch, else null (rethrow)
 */
function applyFailureReason(abstain, applyTimeoutMs) {
  if (abstain.cause === ABSTAIN.OOM) return 'poc.patch exhausted the sandbox\'s memory as git applied it (a hunk that inflates past the limit)';
  // The step's own timer aborts with reason 'step'; the run's budget, deadline and cancel use other reasons. Both
  // the step and the run budget map to STEP_TIMEOUT, so the apply's own timeout is told apart by its detail (result.js).
  if (abstain.cause === ABSTAIN.STEP_TIMEOUT && /^the step reached its wall-clock limit/.test(abstain.detail || '')) {
    return `poc.patch did not finish applying within ${Math.round(applyTimeoutMs / 1000)}s`;
  }
  return null;
}

function claimSteps(request, limits) {
  const issues = checkClaim(request);
  if (issues.length) return [async () => { throw new RequesterError(issues); }];

  const spec = request.spec;
  const base = spec.baseCommit;
  const testGlobs = spec.paths.tests;
  const protectedGlobs = spec.paths.protected || [];
  const baselineIds = new Set(request.baseline.tests.map((t) => t.id));
  const state = { done: false, keep: [], touched: null, prepared: null, pocCommit: null, leftovers: [] };

  /** Run a git command and read its stdout (capped); definitive or it throws. */
  async function gitRead(ctx, name, args, { stdin, env } = {}) {
    const out = new Prefix(GIT_OUTPUT_MAX);
    const record = await ctx.exec(git(args, { env }), { name, timeoutMs: GIT_TIMEOUT_MS, stdin, tee: out });
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

    // Before any claim code runs: /work is the listed commit (checkout.js).
    const checkout = await forceCheckout(ctx, { base });
    state.prepared = checkout.commit;
    ctx.fact('commit', { base, poc: null });
  }

  /** The work tree's free bytes before the apply (its own value is definitive or it throws). */
  async function freeBytes(ctx) {
    const out = new Prefix(256);
    const record = await ctx.exec(['/bin/sh', '-c', FREE_SPACE_SCRIPT, 'vcr-freespace'], { name: 'patch:space', timeoutMs: GIT_TIMEOUT_MS, tee: out });
    const m = /vcr-free ([0-9]+)/.exec(out.bytes().toString('utf8'));
    if (record.exitCode !== 0 || !m) throw runnerError('patch:space', `the work tree's free space could not be read (exit ${record.exitCode})`);
    return Number(m[1]);
  }

  async function applies(ctx) {
    const scan = scanPatch(request.pocPatch, limits);
    const patchFact = { bytes: scan.bytes, sha256: scan.sha256, expansionBytes: null, binaryHunks: scan.binaryHunks };
    ctx.fact('patch', patchFact);
    if (!scan.ok) {
      ctx.gate('applies', 'fail', 'input', scan.reason);
      state.done = true;
      return;
    }
    const failExpansion = (reason) => { ctx.fact('patch', { ...patchFact }); ctx.gate('applies', 'fail', 'input', reason); state.done = true; };

    // The measurement needs room to write patchExpansionBytes; without it, the image's checkout and dependencies left
    // too little, which is the requester's package, not the hunter's patch (owner decision Q26).
    const need = limits.patchExpansionBytes + FREE_SPACE_MARGIN_BYTES;
    const free = await freeBytes(ctx);
    if (free < need) {
      throw new RequesterError([issue('IMAGE_WORKDIR_FULL', '/spec/env/image',
        `the env image's checkout and installed dependencies leave only ${free} bytes free in the work tree; a claim needs room to write up to ${limits.patchExpansionBytes} (patchExpansionBytes) plus a ${FREE_SPACE_MARGIN_BYTES}-byte margin`)]);
    }

    // git applies the patch in the sandbox, in the runner's own repository, under its memory, pids and space limits
    // and the apply's own time budget. Out of space or memory, or the budget, is then the patch's fault.
    let applied;
    try {
      applied = await ctx.exec(git(['apply', '--index', '--whitespace=nowarn', '-']), {
        name: 'patch:apply', timeoutMs: APPLY_TIMEOUT_MS, stdin: request.pocPatch
      });
    } catch (err) {
      const reason = err instanceof Abstain ? applyFailureReason(err, APPLY_TIMEOUT_MS) : null;
      if (!reason) throw err;
      failExpansion(`${reason}; the class allows ${limits.patchExpansionBytes} bytes written (patchExpansionBytes)`);
      return;
    }
    if (applied.exitCode !== 0) {
      // ENOSPC with the room confirmed above is the patch overrunning the work tree, not a full image.
      if (/No space left on device|Disk quota exceeded/.test(applied.stderr.text)) {
        failExpansion(`poc.patch filled the work tree as git applied it; the class allows ${limits.patchExpansionBytes} bytes written (patchExpansionBytes)`);
        return;
      }
      ctx.gate('applies', 'fail', 'exit_code', `poc.patch does not apply to the listed commit ${base} (exit ${applied.exitCode}): ${firstLine(applied.stderr.text)}`);
      state.done = true;
      return;
    }

    // Measure what git wrote: the postimage bytes of every path the patch created or modified, from the runner's index.
    const raw = await gitRead(ctx, 'patch:measure', ['diff', '--cached', '--raw', '-z', '--no-renames', '--abbrev=' + base.length, 'HEAD', '--']);
    const parsed = raw.record.exitCode === 0 && !raw.out.truncated ? parseRawZ(raw.out.bytes(), base.length) : null;
    if (!parsed || !parsed.ok) throw runnerError('patch:measure', `the paths poc.patch wrote could not be read: ${parsed ? parsed.reason : `git exited ${raw.record.exitCode}`}`);
    let written = 0;
    if (parsed.ids.length) {
      const sizes = await gitRead(ctx, 'patch:sizes', ['cat-file', '--batch-check=%(objectsize)'], { stdin: Buffer.from(parsed.ids.map((id) => `${id}\n`).join('')) });
      const total = sizes.record.exitCode === 0 && !sizes.out.truncated ? sumObjectSizes(sizes.out.bytes().toString('utf8'), parsed.ids.length) : null;
      if (total === null) throw runnerError('patch:sizes', `the sizes poc.patch wrote could not be read (git exited ${sizes.record.exitCode})`);
      written = total;
    }
    patchFact.expansionBytes = written;
    ctx.fact('patch', { ...patchFact });
    if (written > limits.patchExpansionBytes) {
      failExpansion(`poc.patch wrote ${written} bytes across ${parsed.paths} path${parsed.paths === 1 ? '' : 's'}; the class allows ${limits.patchExpansionBytes} (patchExpansionBytes)`);
      return;
    }
    ctx.gate('applies', 'pass', 'exit_code', `poc.patch applies to the listed commit ${base} and writes ${written} bytes`);
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
    // The listed commit's files as the checkout committed them (submodules' files as ordinary paths).
    const tree = await gitRead(ctx, 'reset:list', ['ls-tree', '-r', '-z', '--full-tree', '--name-only', '--end-of-options', state.prepared]);
    const all = tree.record.exitCode === 0 && !tree.out.truncated ? parseLsTreeZ(tree.out.bytes()) : null;
    if (!all) throw runnerError('reset:list', `the listed commit's files could not be listed (git exited ${tree.record.exitCode})`);
    const protectedFiles = protectedGlobs.length ? all.filter((p) => matchesAny(p, protectedGlobs)) : [];
    if (protectedFiles.length) {
      const reset = await ctx.exec(git(['checkout', state.prepared, '--pathspec-from-file=-', '--pathspec-file-nul'], { env: { GIT_LITERAL_PATHSPECS: '1' } }), {
        name: 'reset:protected', timeoutMs: GIT_TIMEOUT_MS, stdin: Buffer.from(protectedFiles.join('\0'))
      });
      if (reset.exitCode !== 0) throw runnerError('reset:protected', `the protected paths could not be reset: ${firstLine(reset.stderr.text)}`);
    }
    ctx.fact('protectedReset', protectedFiles.length);
    const commit = await ctx.exec(git(['commit', '--quiet', '--no-verify', '--no-gpg-sign', '--allow-empty', '--cleanup=whitespace', '--message', COMMIT_MESSAGE], { env: COMMIT_ENV }), {
      name: 'patch:commit', timeoutMs: GIT_TIMEOUT_MS
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
        const reset = await ctx.exec(git(['reset', '--quiet', '--hard', state.pocCommit]), { name: `poc:reset:${k}`, timeoutMs: GIT_TIMEOUT_MS });
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

module.exports = { claimSteps, checkClaim, applyFailureReason, IMAGE_CHECKOUT, NEUTRAL_ATTRIBUTES, PROCS_SCRIPT, CLEANUP_SCRIPT, APPLY_TIMEOUT_MS, FREE_SPACE_SCRIPT, RUNS };
