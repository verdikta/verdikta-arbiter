'use strict';

/**
 * The claim pipeline for a forge listing (design §9.2 steps 3-8, §9.5, §10.1:
 * `applies`, `testPathsOnly`, `build`, `reproduces`, `integrity`,
 * `claimedObservable`, and the fix check). Nodes A2a and A3a.
 *
 *   fix check  with fix.patch: a second sandbox, started first and run
 *             beside the PoC's (fix.js); its result is a fact, never a gate
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
 *   build     the reference snapshot of what the integrity checks watch
 *             (integrity.js, the image plus the accepted patch); then the
 *             declared build command, whose exit code is the gate (tier A)
 *   reproduces  the fixed schedule: testFiles on the PoC's files, then
 *             testIds twice on the tests run 1 found, each with --junit and
 *             the fixed --fuzz-seed, a snapshot after each. Every test the
 *             patch added must fail as an assertion on all three runs, and
 *             every integrity check must pass (§9.5: any failed check fails
 *             reproduces with it); then claimedObservable (observable.js)
 *
 * Every forge the pipeline starts is the runner's own argv (node A3a
 * attempt 3, owner decision Q31): the listing's commands are parsed by
 * src/commands.js (plain `forge build` / `forge test` with allowlisted
 * flags; anything else is the requester's error before any sandbox) and run
 * as `/usr/bin/env -i <forge's environment> <forge> <args>` (forge.js), in
 * /work, the forge being the one the integrity reference probed and whose
 * configuration it hashed. No shell reads the maker's text.
 *
 * Gates come only from definitive results: a step that hits a limit, dies or
 * does not start throws Abstain out of ctx.exec, and the run abstains
 * without the gate. A gate that fails stops the pipeline (the later gates
 * are not run). The schedule never looks at the time left: three runs,
 * always, once run 1 found the PoC's tests. Between steps that ran claim
 * code, every process the claim left behind is killed, and the work tree's
 * tracked files go back to the PoC commit before each re-run.
 *
 * Every fact carries its tier (§9.5): A for what the runner observed from
 * outside the tested process, B for results reported by a process that ran
 * claim code (the PoC's JUnit, the fix check's).
 */

const { ABSTAIN, Abstain, RequesterError } = require('./result');
const { Prefix } = require('./capture');
const { matchesAny, pocPatchPathsGate } = require('./common');
const { git, COMMIT_ENV, COMMIT_MESSAGE } = require('./git');
const { forceCheckout, IMAGE_CHECKOUT, NEUTRAL_ATTRIBUTES } = require('./checkout');
const forge = require('./forge');
const commands = require('./commands');
const { readForgeJUnit, JUNIT_MAX_BYTES } = require('./junit');
const {
  scanPatch, parseRawZ, sumObjectSizes, parseNameStatusZ, parseNumstatZ, parseLsTreeZ, parseAddedLines, reportablePath
} = require('./patch');
const integrity = require('./integrity');
const { claimedObservable, functionName } = require('./observable');
const { runFixCheck, notRunFix } = require('./fix');

/** git's answers (paths, stats, the diff) are read up to this. */
const GIT_OUTPUT_MAX = 16 * 1024 * 1024;
const PREP_TIMEOUT_MS = 120000;
const GIT_TIMEOUT_MS = 120000;
/** The patch's own apply budget: a timeout here is the patch's fault, not the run's (§9.2 step 3, owner decision Q26). */
const APPLY_TIMEOUT_MS = 90000;
const CLEANUP_TIMEOUT_MS = 60000;
/**
 * The work tree (git.js WORK_TREE), and the free disk the apply needs beyond
 * patchExpansionBytes before running out of it is charged to the patch. The
 * margin covers git's own working files (loose objects, the index) besides
 * the postimage bytes written.
 */
const WORK_TREE = '/work';
const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
/**
 * Prints the work tree's free bytes as `vcr-free <bytes>`: GNU `stat -f` (free
 * blocks x block size), falling back to `df` (POSIX 1K blocks) where statfs is
 * not available. Both ship on the foundry base; one answers on every runtime
 * (runc and gVisor). Memory is not read: running out of it while applying is
 * an ordinary resource abstain (owner decision Q28), not the patch's fault.
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

/**
 * What the forge adapter needs from the listing spec: the framework, the
 * base image, the commands it runs (build, testFiles, testIds: the grammar
 * of src/commands.js), the listed commit and the test paths. The listing
 * check (listing.js) asks the same of a spec before it runs one, plus
 * commands.test (its suite), which a claim needs only with fix.patch.
 */
function checkForgeSpec(spec) {
  const issues = [];
  const cmds = spec.commands && typeof spec.commands === 'object' ? spec.commands : {};
  if (cmds.framework !== 'forge') issues.push(issue('FRAMEWORK_UNSUPPORTED', '/spec/commands/framework', 'this runner runs forge listings only (the Foundry MVP)'));
  if (!spec.env || spec.env.from !== 'foundry') issues.push(issue('ENV_UNSUPPORTED', '/spec/env/from', 'this runner runs env images built FROM the pinned foundry base only'));
  issues.push(...commands.commandIssues(cmds, 'build'), ...commands.commandIssues(cmds, 'testFiles'), ...commands.commandIssues(cmds, 'testIds'));
  if (typeof spec.baseCommit !== 'string' || !COMMIT_HEX.test(spec.baseCommit)) issues.push(issue('SCHEMA', '/spec/baseCommit', 'must be a full commit hash'));
  const paths = spec.paths;
  const globs = (v) => Array.isArray(v) && v.every((g) => typeof g === 'string' && g !== '');
  if (!paths || !globs(paths.tests) || paths.tests.length === 0) issues.push(issue('SCHEMA', '/spec/paths/tests', 'must be a non-empty list of globs'));
  else if (paths.protected !== undefined && !globs(paths.protected)) issues.push(issue('SCHEMA', '/spec/paths/protected', 'must be a list of globs'));
  return issues;
}

/** What the forge adapter needs from the request, checked before any claim code runs. */
function checkClaim(request) {
  const spec = request.spec || {};
  const issues = checkForgeSpec(spec);
  // The fix check runs the maker's full suite (§9.2 step 8), so it needs commands.test; without a fix a claim never
  // runs it, but one that is there is still held to the grammar: the listing check would have refused it.
  const cmds = spec.commands && typeof spec.commands === 'object' ? spec.commands : {};
  if (request.fixPatch || cmds.test !== undefined) issues.push(...commands.commandIssues(cmds, 'test'));
  const baseline = request.baseline;
  if (!baseline || !Array.isArray(baseline.tests) || !baseline.tests.every((t) => t && typeof t.id === 'string')) {
    issues.push(issue('BASELINE_INVALID', '/baseline/tests', 'baseline.json must list the tests at the listed commit (tests[].id)'));
  } else if (request.fixPatch && (!Array.isArray(baseline.stable) || !baseline.stable.every((id) => typeof id === 'string'))) {
    issues.push(issue('BASELINE_INVALID', '/baseline/stable', 'baseline.json must list its stable tests (stable[]) for the fix check'));
  }
  return issues;
}

/** How many sandboxes a claim's run opens at once (admission holds memory for each): the fix check's beside the PoC's. */
function sandboxesFor(request) {
  return request && request.fixPatch ? 2 : 1;
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
 * Why a failed `git apply` blames the patch (`input`, PATCH_EXPANSION) rather
 * than the run, given the work tree's free space was confirmed first. Only the
 * apply's own wall-clock budget is the patch here; running out of memory is an
 * ordinary resource abstain (owner decision Q28, R20-F1), and the run's own
 * deadline, budget or cancellation is not the patch either.
 * @param {Abstain} abstain - the abstain ctx.exec threw for the apply step
 * @param {number} applyTimeoutMs - the apply's own budget
 * @param {string} [label] - the patch's name
 * @returns {string|null} the gate detail when it is the patch, else null (rethrow to abstain)
 */
function applyFailureReason(abstain, applyTimeoutMs, label = 'poc.patch') {
  // The step's own timer aborts with reason 'step'; the run's budget, deadline and cancel use other reasons. Both
  // the step and the run budget map to STEP_TIMEOUT, so the apply's own timeout is told apart by its detail (result.js).
  if (abstain.cause === ABSTAIN.STEP_TIMEOUT && /^the step reached its wall-clock limit/.test(abstain.detail || '')) {
    return `${label} did not finish applying within ${Math.round(applyTimeoutMs / 1000)}s`;
  }
  return null;
}

// ------------------------------------------------------------------------
// The kit: steps both sandboxes run (the PoC's, and the fix check's in
// fix.js). Each takes the sandbox's context and its `box` (the processes
// recorded before any claim code ran, the leftovers killed since).

function runnerError(step, detail) {
  return new Abstain(ABSTAIN.RUNNER_ERROR, detail, { step });
}

/** Run a git command and read its stdout (capped); definitive or it throws. */
async function gitRead(ctx, name, args, { stdin, env } = {}) {
  const out = new Prefix(GIT_OUTPUT_MAX);
  const record = await ctx.exec(git(args, { env }), { name, timeoutMs: GIT_TIMEOUT_MS, stdin, tee: out });
  return { record, out };
}

function newBox() {
  return { keep: [], leftovers: [] };
}

async function recordProcesses(ctx, box) {
  const procs = new Prefix(64 * 1024);
  await ctx.exec(['/bin/sh', '-c', PROCS_SCRIPT, 'vcr-procs'], { name: 'prepare:procs', timeoutMs: PREP_TIMEOUT_MS, tee: procs });
  box.keep = procs.bytes().toString('utf8').split('\n').filter((l) => /^[0-9]+$/.test(l));
  if (box.keep.length === 0) throw new Abstain(ABSTAIN.DOCKER_ERROR, 'the sandbox\'s processes could not be listed', { step: 'prepare:procs' });
}

/** Kill whatever the last step left behind (§9.5: claim processes that outlive a step). */
async function cleanup(ctx, box, after) {
  const name = `cleanup:${after}`;
  const out = new Prefix(4096);
  const record = await ctx.exec(['/bin/sh', '-c', CLEANUP_SCRIPT, 'vcr-cleanup', ...box.keep], { name, timeoutMs: CLEANUP_TIMEOUT_MS, tee: out });
  const m = /^killed ([0-9]+)$/m.exec(out.bytes().toString('utf8'));
  if (record.exitCode !== 0 || !m) {
    throw new Abstain(ABSTAIN.DOCKER_ERROR, `processes the step left in the sandbox could not be stopped (exit ${record.exitCode})`, { step: name });
  }
  box.leftovers.push({ after, killed: Number(m[1]) });
  ctx.fact('leftoverProcesses', { tier: 'A', steps: [...box.leftovers] });
}

/** The work tree's free bytes before an apply (its own value is definitive or it throws). */
async function freeBytes(ctx, name) {
  const out = new Prefix(256);
  const record = await ctx.exec(['/bin/sh', '-c', FREE_SPACE_SCRIPT, 'vcr-freespace'], { name, timeoutMs: GIT_TIMEOUT_MS, tee: out });
  const m = /vcr-free ([0-9]+)/.exec(out.bytes().toString('utf8'));
  if (record.exitCode !== 0 || !m) throw runnerError(name, `the work tree's free space could not be read (exit ${record.exitCode})`);
  return Number(m[1]);
}

/**
 * The `applies` checks of one patch (§9.2 step 3): the host-side scan, the
 * free disk, git apply in the sandbox, the measurement of what it wrote.
 * @param {object} ctx
 * @param {object} o
 * @param {Buffer} o.bytes - the patch
 * @param {string} o.label - 'poc.patch' or 'fix.patch'
 * @param {object} o.limits
 * @param {string} o.base - the listed commit (for the detail and the id length)
 * @param {string} o.step - exec name prefix ('patch', 'fixpatch')
 * @param {'requester'|'fail'} [o.noRoom] - too little free disk: the requester's package (before any patch), or a failure of this patch
 * @returns {Promise<{status:'pass'|'fail', basis:string, detail:string, fact:object, applied:boolean}>}
 *   `applied`: git applied it (an over-large result is applied and must be undone by the caller)
 */
async function applyPatch(ctx, { bytes, label, limits, base, step, noRoom = 'requester' }) {
  const scan = scanPatch(bytes, limits, label);
  const fact = { tier: 'A', bytes: scan.bytes, sha256: scan.sha256, expansionBytes: null };
  const fail = (basis, detail, applied = false) => ({ status: 'fail', basis, detail, fact: { ...fact }, applied });
  if (!scan.ok) return fail('input', scan.reason);

  // The measurement needs disk room to write patchExpansionBytes; without it, the image's checkout and dependencies
  // left too little, which is the requester's package, not the hunter's patch (owner decision Q26).
  const need = limits.patchExpansionBytes + FREE_SPACE_MARGIN_BYTES;
  const free = await freeBytes(ctx, `${step}:space`);
  if (free < need) {
    if (noRoom === 'fail') {
      return fail('input', `the work tree has ${free} bytes free after poc.patch; ${label} needs room for up to ${limits.patchExpansionBytes} (patchExpansionBytes) plus a ${FREE_SPACE_MARGIN_BYTES}-byte margin`);
    }
    throw new RequesterError([issue('IMAGE_WORKDIR_FULL', '/spec/env/image',
      `the env image's checkout and installed dependencies leave only ${free} bytes free in the work tree; a claim needs room to write up to ${limits.patchExpansionBytes} (patchExpansionBytes) plus a ${FREE_SPACE_MARGIN_BYTES}-byte margin`)]);
  }

  // git applies the patch in the sandbox, in the runner's own repository, under its memory, pids and space limits
  // and the apply's own time budget. Running out of the confirmed disk room, or the budget, is the patch's fault;
  // running out of memory is an ordinary resource abstain (owner decision Q28), not an input refusal.
  let applied;
  try {
    applied = await ctx.exec(git(['apply', '--index', '--whitespace=nowarn', '-']), { name: `${step}:apply`, timeoutMs: APPLY_TIMEOUT_MS, stdin: bytes });
  } catch (err) {
    const reason = err instanceof Abstain ? applyFailureReason(err, APPLY_TIMEOUT_MS, label) : null;
    if (!reason) throw err; // an OOM, or the run's own abort: a genuine abstain.
    return { ...fail('input', `${reason}; the class allows ${limits.patchExpansionBytes} bytes written (patchExpansionBytes)`), sandboxKilled: true };
  }
  if (applied.exitCode !== 0) {
    // ENOSPC with the room confirmed above is the patch overrunning the work tree, not a full image.
    if (/No space left on device|Disk quota exceeded/.test(applied.stderr.text)) {
      return fail('input', `${label} filled the work tree as git applied it; the class allows ${limits.patchExpansionBytes} bytes written (patchExpansionBytes)`, true);
    }
    return fail('exit_code', `${label} does not apply to ${label === 'poc.patch' ? 'the listed commit' : 'the listed commit with poc.patch'} ${base} (exit ${applied.exitCode}): ${firstLine(applied.stderr.text)}`);
  }

  // Measure what git wrote: the postimage bytes of every path the patch created or modified, from the runner's index.
  const raw = await gitRead(ctx, `${step}:measure`, ['diff', '--cached', '--raw', '-z', '--no-renames', '--abbrev=' + base.length, 'HEAD', '--']);
  const parsed = raw.record.exitCode === 0 && !raw.out.truncated ? parseRawZ(raw.out.bytes(), base.length) : null;
  if (!parsed || !parsed.ok) throw runnerError(`${step}:measure`, `the paths ${label} wrote could not be read: ${parsed ? parsed.reason : `git exited ${raw.record.exitCode}`}`);
  let written = 0;
  if (parsed.ids.length) {
    const sizes = await gitRead(ctx, `${step}:sizes`, ['cat-file', '--batch-check=%(objectsize)'], { stdin: Buffer.from(parsed.ids.map((id) => `${id}\n`).join('')) });
    const total = sizes.record.exitCode === 0 && !sizes.out.truncated ? sumObjectSizes(sizes.out.bytes().toString('utf8'), parsed.ids.length) : null;
    if (total === null) throw runnerError(`${step}:sizes`, `the sizes ${label} wrote could not be read (git exited ${sizes.record.exitCode})`);
    written = total;
  }
  fact.expansionBytes = written;
  if (written > limits.patchExpansionBytes) {
    return fail('input', `${label} wrote ${written} bytes across ${parsed.paths} path${parsed.paths === 1 ? '' : 's'}; the class allows ${limits.patchExpansionBytes} (patchExpansionBytes)`, true);
  }
  return { status: 'pass', basis: 'exit_code', detail: `${label} applies to the listed commit ${base} and writes ${written} bytes`, fact: { ...fact }, applied: true };
}

/** What the applied patch touched, as git says (staged against HEAD): paths, stats and added lines. */
async function readTouched(ctx, step, label) {
  const ns = await gitRead(ctx, `${step}:paths`, ['diff', '--cached', '--name-status', '-z', '--no-renames', 'HEAD', '--']);
  const touched = ns.record.exitCode === 0 && !ns.out.truncated ? parseNameStatusZ(ns.out.bytes()) : null;
  if (!touched) throw runnerError(`${step}:paths`, `the paths ${label} touched could not be read (git exited ${ns.record.exitCode})`);
  const num = await gitRead(ctx, `${step}:stats`, ['diff', '--cached', '--numstat', '-z', '--no-renames', 'HEAD', '--']);
  const stats = num.record.exitCode === 0 && !num.out.truncated ? parseNumstatZ(num.out.bytes()) : null;
  if (!stats) throw runnerError(`${step}:stats`, `the diff stats of ${label} could not be read (git exited ${num.record.exitCode})`);
  const diff = await gitRead(ctx, `${step}:diff`, ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
    '--diff-algorithm=myers', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD', '--']);
  const added = diff.record.exitCode === 0 ? parseAddedLines(diff.out.bytes()) : null;
  if (!added || !added.ok) throw runnerError(`${step}:diff`, `the diff of ${label} could not be read: ${added ? added.reason : `git exited ${diff.record.exitCode}`}`);
  return {
    touched,
    added: added.files,
    diff: {
      tier: 'A',
      files: stats.length,
      added: stats.reduce((n, s) => n + s.added, 0),
      removed: stats.reduce((n, s) => n + s.removed, 0),
      binaryFiles: stats.filter((s) => s.binary).length
    }
  };
}

/** Protected files back to the listed commit (the checkout's commit of it): how many were reset. */
async function resetProtected(ctx, prepared, protectedGlobs) {
  // The listed commit's files as the checkout committed them (submodules' files as ordinary paths).
  const tree = await gitRead(ctx, 'reset:list', ['ls-tree', '-r', '-z', '--full-tree', '--name-only', '--end-of-options', prepared]);
  const all = tree.record.exitCode === 0 && !tree.out.truncated ? parseLsTreeZ(tree.out.bytes()) : null;
  if (!all) throw runnerError('reset:list', `the listed commit's files could not be listed (git exited ${tree.record.exitCode})`);
  // Each path is latin1 (one char per byte). The glob is matched on the path's UTF-8 decoding, so a UTF-8 filename
  // matches the same way the path gate (testPathsOnly) matches it (R23-F1); the literal pathspec is written back as
  // the original bytes (R22-F1). A non-UTF-8 byte decodes to U+FFFD in both, so they still agree.
  const protectedFiles = protectedGlobs.length ? all.filter((p) => matchesAny(Buffer.from(p, 'latin1').toString('utf8'), protectedGlobs)) : [];
  if (protectedFiles.length) {
    const reset = await ctx.exec(git(['checkout', prepared, '--pathspec-from-file=-', '--pathspec-file-nul'], { env: { GIT_LITERAL_PATHSPECS: '1' } }), {
      name: 'reset:protected', timeoutMs: GIT_TIMEOUT_MS, stdin: Buffer.from(protectedFiles.join('\0'), 'latin1')
    });
    if (reset.exitCode !== 0) throw runnerError('reset:protected', `the protected paths could not be reset: ${firstLine(reset.stderr.text)}`);
  }
  return protectedFiles.length;
}

/** Commit the index with the runner's fixed identity and date; the commit's id. */
async function commitTree(ctx, message, step) {
  const commit = await ctx.exec(git(['commit', '--quiet', '--no-verify', '--no-gpg-sign', '--allow-empty', '--cleanup=whitespace', '--message', message], { env: COMMIT_ENV }), {
    name: `${step}:commit`, timeoutMs: GIT_TIMEOUT_MS
  });
  if (commit.exitCode !== 0) throw runnerError(`${step}:commit`, `the patched tree could not be committed: ${firstLine(commit.stderr.text)}`);
  const head = await gitRead(ctx, `${step}:head`, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
  const id = head.out.bytes().toString('utf8').trim();
  if (head.record.exitCode !== 0 || !COMMIT_HEX.test(id)) throw runnerError(`${step}:head`, `the ${message} commit could not be read`);
  return id;
}

/** The tracked files back to `commit` (git reset --hard), between runs. */
async function resetHard(ctx, commit, name) {
  const reset = await ctx.exec(git(['reset', '--quiet', '--hard', commit]), { name, timeoutMs: GIT_TIMEOUT_MS });
  if (reset.exitCode !== 0) throw runnerError(name, `the work tree could not be reset to ${commit}: ${firstLine(reset.stderr.text)}`);
}

/**
 * The declared build command, run by the runner as forge's argv (`tool`:
 * the probed forge; `command`: commands.build, parsed); its exit code (tier A).
 */
async function runBuild(ctx, box, tool, command, limits) {
  const record = await ctx.exec(forge.forgeArgv(tool, commands.forgeArgs(command)), {
    name: 'build', timeoutMs: limits.buildSeconds * 1000, workdir: forge.FORGE_WORKDIR
  });
  await cleanup(ctx, box, 'build');
  return record.exitCode;
}

/**
 * One forge test run with the runner's reporter flags: the JUnit read
 * strictly, the run's exit code. `doc` is the reader's whole answer (the
 * suites, their counts and forge's summaries), for the integrity checks.
 * `command` is a parsed test command; `values` fill its placeholders
 * ($FILES, $TEST_IDS); forge is `tool`, run as an argv (forge.forgeArgv).
 */
async function forgeRun(ctx, box, { name, tool, command, values = {}, timeoutMs }) {
  const out = new Prefix(JUNIT_MAX_BYTES);
  const record = await ctx.exec(forge.forgeArgv(tool, [...commands.forgeArgs(command, values), ...forge.reporterFlags()]), {
    name, timeoutMs, workdir: forge.FORGE_WORKDIR, tee: out
  });
  await cleanup(ctx, box, name);
  const bytes = out.bytes();
  const blank = out.totalBytes === 0 || !/[^\s]/.test(bytes.toString('latin1'));
  const read = blank ? null : readForgeJUnit(bytes, { truncated: out.truncated });
  return {
    exitCode: record.exitCode,
    junit: blank ? 'absent' : read.ok ? 'ok' : 'invalid',
    reason: blank ? `forge printed no JUnit (exit ${record.exitCode})` : read.ok ? null : read.reason,
    suites: read && read.ok ? read.suites : null,
    doc: read && read.ok ? read : null
  };
}

/** The identity of every test-function record of a run, with its records: id → [record]. */
function recordsById(suites, keep = () => true) {
  const out = new Map();
  for (const s of suites || []) {
    for (const c of s.cases) {
      if (!forge.isTestFunction(c.name)) continue;
      const id = forge.testIdentity(s.file, s.contract, c.name);
      if (!keep(id, s)) continue;
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(c);
    }
  }
  return out;
}

/** One identity's result on a run: `missing`, `duplicate` (with the count), or forge's record classified. */
function entryOf(got) {
  if (!got || got.length === 0) return { result: 'missing', kind: null, message: null };
  if (got.length > 1) return { result: 'duplicate', kind: null, message: null, records: got.length };
  const reason = forge.recordReason(got[0]);
  return { ...forge.classifyRecord(got[0]), message: normaliseMessage(reason), rawMessage: typeof reason === 'string' ? reason : null };
}

/** The consistency checks of one run (§9.5 checks 2 and 3), as `label: detail` failures. */
function runConsistency(run, label, summary, exit) {
  const s = integrity.summaryConsistency(run.doc);
  if (!s.ok) summary.push(`${label}: ${s.detail}`);
  const e = integrity.exitConsistency(run);
  if (!e.ok) exit.push(`${label}: ${e.detail}`);
}

const KIT = Object.freeze({
  parsedCommand: (spec, key) => commands.parsedCommand(spec.commands, key, RequesterError),
  gitRead, newBox, recordProcesses, cleanup, applyPatch, readTouched, resetProtected, commitTree, resetHard, runBuild, forgeRun,
  recordsById, entryOf, runConsistency, normaliseMessage, sortedUnique, capped, listPaths, firstLine, runnerError
});

// ------------------------------------------------------------------------
// The PoC's sandbox.

/**
 * The claim steps for a forge listing: the fix check's start, the claim
 * session's steps in order (each skipped once a gate failed), the fix check's
 * result.
 * @param {object} request - the validated POST /v1/runs request
 * @param {object} limits - the effective limits
 * @returns {Function[]}
 */
function claimSteps(request, limits) {
  const issues = checkClaim(request);
  if (issues.length) return [async () => { throw new RequesterError(issues); }];
  const session = claimSession(request, limits);
  const steps = [session.prepare, session.applies, session.testPathsOnly, session.resetAndCommit, session.watch, session.build, session.reproduces].map((step) => {
    const wrapped = async (ctx) => {
      if (session.state.done) return;
      try {
        await step(ctx);
      } catch (err) {
        session.state.halted = true;
        throw err;
      }
    };
    Object.defineProperty(wrapped, 'name', { value: step.name });
    return wrapped;
  });
  return [session.startFixCheck, ...steps, session.fixCheck];
}

/**
 * The claim pipeline's steps as functions of a context, over one state
 * (claimSteps runs them in order). The listing check (listing.js) runs the
 * same functions on its harness probes: `adopt` takes the processes and the
 * forced checkout of a session that already prepared this sandbox, so a
 * probe is applied, gated, built and run exactly as a claim's PoC is. A
 * session that never ran `watch` (a probe) gets every integrity check but
 * the post-run checksums; it finds forge itself (integrity.discoverForge)
 * before the first forge it runs, and runs that forge the same way.
 * @param {object} request - spec, pocPatch, baseline (as checkClaim accepts them), fixPatch and finding for a claim
 * @param {object} limits - the effective limits
 * @param {{adopt?: {keep:string[], prepared:string, solcPin:string, tool?:object}}} [o]
 */
function claimSession(request, limits, { adopt = null } = {}) {
  const spec = request.spec;
  const base = spec.baseCommit;
  const testGlobs = spec.paths.tests;
  const protectedGlobs = spec.paths.protected || [];
  const baselineIds = new Set(request.baseline.tests.map((t) => t.id));
  // The state is the sandbox's box too (kit: the processes kept, the leftovers killed).
  const state = {
    done: false, halted: false, keep: [], leftovers: [], touched: null, added: null, addedIds: null, prepared: null, pocCommit: null, watch: null,
    tool: null, solcPin: null, fix: null, integrity: { tier: 'A', poc: null, fix: null }
  };
  if (adopt) {
    state.keep = [...adopt.keep];
    state.prepared = adopt.prepared;
    state.solcPin = adopt.solcPin;
    if (adopt.tool) state.tool = adopt.tool;
  }
  const box = state;

  /** A command of the spec, parsed (checkClaim and the listing check refused any other form before this). */
  const command = (key) => commands.parsedCommand(spec.commands, key, RequesterError);

  /**
   * The forge every maker command runs: the integrity reference's (its
   * configuration is what the checks watch), or, in a session without one
   * (the listing check's), the one found in this sandbox before the first
   * forge runs.
   */
  async function tool(ctx) {
    if (state.watch) return state.watch.tool();
    if (!state.tool) state.tool = { ...await integrity.discoverForge(ctx, 'forge:find'), solc: state.solcPin };
    return state.tool;
  }

  /** The fix check (§9.2 step 8), started before the PoC's own steps and run beside them. */
  async function startFixCheck(ctx) {
    if (!request.fixPatch) return;
    const running = runFixCheck(ctx, { request, limits, kit: KIT, halted: () => state.halted });
    state.fix = running.then((value) => ({ value }), (error) => ({ error }));
  }

  async function prepare(ctx) {
    await recordProcesses(ctx, box);
    // First thing, while the work tree is empty: the tools everything below runs are out of the claim's reach (R16-F1).
    await integrity.requireImmutableTools(ctx);
    // Before any claim code runs: /work is the listed commit (checkout.js).
    const checkout = await forceCheckout(ctx, { base });
    // The maker's own inline configuration, before a patch can touch it (R23-F1).
    await integrity.requirePlainInlineConfig(ctx);
    // Where the compiler is, which forge runs from its first start on (R24-F1), read from the listing's own files: every
    // later forge run is pinned to it (owner decision Q37).
    state.solcPin = await integrity.pinCompiler(ctx, { testGlobs, protectedGlobs });
    state.prepared = checkout.commit;
    ctx.fact('commit', { tier: 'A', base, poc: null });
  }

  async function applies(ctx) {
    const r = await applyPatch(ctx, { bytes: request.pocPatch, label: 'poc.patch', limits, base, step: 'patch' });
    ctx.fact('patch', r.fact);
    ctx.gate('applies', r.status, r.basis, r.detail);
    if (r.status !== 'pass') state.done = true;
  }

  async function testPathsOnly(ctx) {
    const { touched, added, diff } = await readTouched(ctx, 'patch', 'poc.patch');
    ctx.fact('diff', diff);

    const paths = touched.map((t) => t.path);
    const gate = pocPatchPathsGate(paths, spec);
    const unreportable = sortedUnique(paths.filter((p) => !reportablePath(p) && !gate.outside.includes(p)));
    const outside = sortedUnique(gate.outside);
    const prot = sortedUnique(gate.protected);
    ctx.fact('testPaths', { tier: 'A', outside: capped(outside, MAX_PATHS), protected: capped(prot, MAX_PATHS), unreportable: capped(unreportable, MAX_PATHS) });

    // Tier-A flags (§9.2 step 3), as plain repository paths under paths.tests.
    const inTests = (p) => reportablePath(p) && matchesAny(p, testGlobs);
    const skipFiles = [];
    const references = [];
    for (const [file, lines] of added) {
      if (!inTests(file)) continue;
      const scan = forge.scanAddedLines(lines);
      if (scan.skipMarkers.length) skipFiles.push(file);
      for (const r of scan.references) references.push({ file, line: r.line, rule: r.rule });
    }
    references.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    ctx.fact('flags', {
      tier: 'A',
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
    state.added = new Map([...added].filter(([file]) => inTests(file)));
    ctx.gate('testPathsOnly', 'pass', 'exit_code', `poc.patch touches ${touched.length} path${touched.length === 1 ? '' : 's'}, all under paths.tests`);
  }

  async function resetAndCommit(ctx) {
    const files = await resetProtected(ctx, state.prepared, protectedGlobs);
    ctx.fact('protectedReset', { tier: 'A', files });
    state.pocCommit = await commitTree(ctx, COMMIT_MESSAGE, 'patch');
    ctx.fact('commit', { tier: 'A', base, poc: state.pocCommit });
  }

  /** The reference the post-run checksums compare with: the image plus the accepted patch, before any maker command. */
  async function watch(ctx) {
    const patchPaths = state.touched.filter((t) => t.status !== 'D').map((t) => t.path);
    state.watch = new integrity.Watch({ protectedGlobs, testGlobs, patchPaths, solc: state.solcPin });
    await state.watch.reference(ctx);
  }

  async function build(ctx) {
    const exitCode = await runBuild(ctx, box, await tool(ctx), command('build'), limits);
    // Nothing of the claim has run yet: what changed here is the image's doing, not the claim's (Q32).
    if (state.watch) await state.watch.afterBuild(ctx);
    const ok = exitCode === 0;
    ctx.gate('build', ok ? 'pass' : 'fail', 'exit_code', `the build command exited ${exitCode}`);
    if (!ok) state.done = true;
  }

  /**
   * One PoC run of the test command `key` (testFiles, testIds; the listing
   * check's suite: test), its placeholders filled from `values`, then the
   * snapshot the integrity checks compare (its processes are dead by then).
   * `step` names it; the listing check's suite runs pass their own.
   */
  async function pocRun(ctx, index, key, values, { step = `poc:${index}` } = {}) {
    const run = await forgeRun(ctx, box, { name: step, tool: await tool(ctx), command: command(key), values, timeoutMs: limits.testSeconds * 1000 });
    if (state.watch) await state.watch.afterRun(ctx, `run ${index}`, { first: index === 1 });
    return run;
  }

  async function reproduces(ctx) {
    const files = sortedUnique(state.touched.filter((t) => t.status !== 'D' && t.path.endsWith('.sol')).map((t) => t.path));
    const runs = [];
    const fileSet = new Set(files);
    if (files.length) {
      const FILES = forge.filesGlob(files);
      runs.push({ command: 'testFiles', ...(await pocRun(ctx, 1, 'testFiles', { FILES })) });
    }

    // The tests the patch added: test functions in the PoC's files, as run 1
    // reported them, that are not in the listed commit's baseline.
    const signatures = new Map();
    const pocNames = new Set();
    if (runs.length && runs[0].suites) {
      for (const s of runs[0].suites) {
        if (!fileSet.has(s.file)) continue;
        for (const c of s.cases) {
          if (!forge.isTestFunction(c.name)) continue;
          pocNames.add(functionName(c.name));
          const id = forge.testIdentity(s.file, s.contract, c.name);
          if (!baselineIds.has(id)) signatures.set(id, c.name);
        }
      }
    }
    const ids = [...signatures.keys()].sort();
    state.addedIds = ids;
    if (ids.length > 0) {
      const FILES = forge.filesGlob(files);
      const TEST_IDS = forge.testIdsRegex([...signatures.values()]);
      for (let k = 2; k <= RUNS; k += 1) {
        await resetHard(ctx, state.pocCommit, `poc:reset:${k}`);
        if (state.watch) await state.watch.afterReset(ctx, `run ${k}`);
        runs.push({ command: 'testIds', ...(await pocRun(ctx, k, 'testIds', { FILES, TEST_IDS })) });
      }
    }

    // Each added test on each run, and the harness records that failed in the PoC's suites.
    const results = new Map(ids.map((id) => [id, []]));
    const harness = [];
    const identity = [];
    const summary = [];
    const exit = [];
    runs.forEach((run, r) => {
      const errors = [];
      if (run.suites) {
        for (const s of run.suites) {
          if (!fileSet.has(s.file)) continue;
          for (const c of s.cases) {
            if (forge.isHarnessRecord(c.name) && (c.outcome === 'failure' || c.outcome === 'error')) {
              errors.push({ suite: `${s.file}:${s.contract}`, name: c.name, message: normaliseMessage(c.message) });
            }
          }
        }
      }
      // Other records (an invariant campaign's `handler …` cases) are not tests of their own.
      const records = recordsById(run.suites, (id, s) => fileSet.has(s.file));
      errors.sort((a, b) => (a.suite + a.name < b.suite + b.name ? -1 : 1));
      harness.push(errors);
      for (const id of ids) {
        let entry = run.suites ? entryOf(records.get(id)) : { result: 'error', kind: null, message: null };
        // A run with a failed harness record in the PoC's files reproduces nothing, as the gate says below. The report has
        // no field for that record, so its run counts must say it: settlement tells a failure of reproduces on its own
        // from one only through integrity by them alone (owner decision Q35), and common's rule derives the gate from them.
        if (errors.length && entry.result === 'fail') entry = { ...entry, result: 'error', kind: 'error', message: errors[0].message };
        results.get(id).push(entry);
        // §9.5 check 1: exactly one record of every test the patch added, none skipped, on every run read.
        const gap = run.suites ? integrity.identityGap(id, entry) : null;
        if (gap) identity.push(`run ${r + 1}: ${gap}`);
      }
      run.harnessErrors = capped(errors, MAX_TESTS);
      runConsistency(run, `run ${r + 1}`, summary, exit);
    });
    for (let r = runs.length; r < RUNS; r += 1) for (const id of ids) results.get(id).push({ result: 'not-run', kind: null, message: null });

    const flags = integrity.tamperFlags({ added: state.added });
    const checks = integrity.integrityOf({
      identity, summary, exit, ...(state.watch ? state.watch.failures : {}), tamperFlags: flags
    });
    ctx.fact('poc', { ...pocFacts(ids.map((id) => [id, results.get(id)]), runs), integrity: checks.integrity });
    state.integrity.poc = { failures: checks.failures, changed: state.watch ? state.watch.changedFacts() : null };
    ctx.fact('integrity', { ...state.integrity });

    let verdict;
    if (files.length === 0) verdict = ['fail', 'exit_code', 'poc.patch adds or changes no Solidity file under paths.tests: there is no PoC to run'];
    else verdict = reproducesVerdict(runs, harness, ids, results);
    if (verdict[0] === 'pass' && !checks.clean) {
      verdict = ['fail', 'integrity', `the PoC's results are not trusted: ${checks.failures.map((f) => f.check).join(', ')} failed (§9.5)`];
    }
    ctx.gate('reproduces', ...verdict);
    ctx.gate('integrity', checks.clean ? 'pass' : 'fail', 'integrity', checks.clean
      ? `every integrity check passed on ${runs.length} run${runs.length === 1 ? '' : 's'}`
      : integrity.integrityDetail(checks.failures));
    if (verdict[0] === 'pass') {
      const known = new Set([...pocNames, ...request.baseline.tests.map((t) => functionName(t.id))]);
      // forge's own messages and the report's (repository-relative, bounded) forms of them (R1-F6).
      const tests = ids.map((id) => ({ id, messages: results.get(id).map((e) => e.rawMessage), recorded: results.get(id).map((e) => e.message) }));
      const o = claimedObservable({ finding: request.finding, tests, knownNames: known });
      ctx.gate('claimedObservable', o.status, 'junit', o.detail);
    }
    state.done = true;
  }

  /** The fix check's result, whatever the PoC's gates were (it is never a gate). */
  async function fixCheck(ctx) {
    let fix = notRunFix();
    if (state.fix) {
      const r = await state.fix;
      if (r.error) throw r.error;
      // Held to the tests the patch added as the PoC's run 1 reported them (R1-F1).
      const settled = r.value.settle(state.addedIds);
      fix = settled.fact;
      state.integrity.fix = settled.integrity;
    }
    ctx.fact('fix', fix);
    ctx.fact('integrity', { ...state.integrity });
  }

  return {
    state, startFixCheck, prepare, applies, testPathsOnly, resetAndCommit, watch, build, reproduces, fixCheck, pocRun,
    cleanup: (ctx, after) => cleanup(ctx, box, after)
  };
}

const WORD = Object.freeze({ pass: 'passed', error: 'errored', skip: 'skipped', missing: 'missing', duplicate: 'duplicated' });

/**
 * The reproduces gate from the three runs' JUnit, in a fixed order (run by
 * run; within a run: the JUnit, the harness, then the tests in code-unit
 * order), so the detail names the same first failure on every arbiter. The
 * integrity checks are applied on top (claimSteps).
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

/** The PoC facts (§9.4 `poc`, tier B): counts over every test and run, the first 200 tests in code-unit order. */
function pocFacts(entries, runs) {
  const runCounts = { fail: 0, pass: 0, error: 0, skip: 0, missing: 0, duplicate: 0, notRun: 0 };
  const tests = [];
  for (const [id, list] of entries) {
    for (const e of list) runCounts[e.result === 'not-run' ? 'notRun' : e.result] += 1;
    // common's rule: any error on any run makes the test's kind `error`, else any failure `assertion`; the message that kind's first.
    const worst = list.some((e) => e.result === 'error') ? 'error' : list.some((e) => e.result === 'fail') ? 'fail' : null;
    const recorded = worst && list.find((e) => e.result === worst);
    if (tests.length < MAX_TESTS) {
      tests.push({ id, runs: list.map((e) => e.result), kind: worst === null ? null : worst === 'error' ? 'error' : 'assertion', message: recorded ? recorded.message : null });
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
  claimSteps, claimSession, checkClaim, checkForgeSpec, sandboxesFor, applyFailureReason, IMAGE_CHECKOUT, NEUTRAL_ATTRIBUTES,
  PROCS_SCRIPT, CLEANUP_SCRIPT, APPLY_TIMEOUT_MS, FREE_SPACE_SCRIPT, FREE_SPACE_MARGIN_BYTES, RUNS, KIT
};
