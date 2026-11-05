'use strict';

/**
 * git inside the sandbox (design §9.1: git apply included runs inside the
 * container, never on the host). Every git the runner starts is a step argv
 * built here and run through ctx.exec; the host never runs git.
 *
 * Every git call starts with an empty environment (`/usr/bin/env -i`): the
 * env image's own environment (`ENV` lines in its Dockerfile, such as
 * GIT_CONFIG_COUNT, GIT_EXEC_PATH or GIT_ALTERNATE_OBJECT_DIRECTORIES) never
 * reaches git. It then gets a fixed one: the git directory (one of the
 * runner's own two, never the image's), no system or global config, no
 * system attributes, no replace objects, C-locale messages (they reach gate
 * details, so they must read the same on every arbiter).
 *
 * The repositories are the runner's (checkout.js makes them with
 * `--template=`, so no hook is copied in), and each call also fixes what
 * would change an outcome or run something: no hooks, no fsmonitor, no
 * line-ending conversion, whitespace errors never refuse a patch, diffs
 * without external drivers, prefixes or rename detection, the index
 * compared by content (no ignored stat data, no sparse checkout). Attribute
 * drivers (filters, textconv) and conversions are switched off by the
 * attributes checkout.js writes to .git/info/attributes (NEUTRAL_ATTRIBUTES),
 * the one attribute source above the repository's own.
 */

const WORK_TREE = '/work';
/** The runner's repository: the forced checkout, the patch, the PoC commit. */
const GIT_DIR = '/work/.git';
/** The runner's staging store: the env image's object files, read as data, removed once the checkout is written. */
const STAGE_DIR = '/work/.git/vcr-image';
const GIT_DIRS = Object.freeze([GIT_DIR, STAGE_DIR]);

/** The whole environment of every git call and checkout script (nothing of the image's). */
const BASE_ENV = Object.freeze({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/dev/null',
  LC_ALL: 'C'
});

const GIT_FIXED_ENV = Object.freeze({
  ...BASE_ENV,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_PAGER: 'cat',
  PAGER: 'cat'
});

/** The runner's repository's environment (as git() builds it by default). */
const GIT_ENV = Object.freeze({ ...GIT_FIXED_ENV, GIT_DIR, GIT_WORK_TREE: WORK_TREE });

const GIT_CONFIG = Object.freeze([
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.autocrlf=false',
  'core.safecrlf=false',
  'core.eol=lf',
  'core.quotePath=false',
  'core.symlinks=true',
  'core.ignoreCase=false',
  'core.precomposeUnicode=false',
  'core.attributesFile=/dev/null',
  'core.untrackedCache=false',
  'core.splitIndex=false',
  'core.ignoreStat=false',
  'core.checkStat=default',
  'core.trustctime=true',
  'core.fileMode=true',
  'core.sparseCheckout=false',
  'core.sparseCheckoutCone=false',
  'index.sparse=false',
  'core.protectNTFS=true',
  'core.protectHFS=false',
  'core.bigFileThreshold=512m',
  'core.useReplaceRefs=false',
  'apply.whitespace=nowarn',
  'apply.ignoreWhitespace=no',
  'diff.noprefix=false',
  'diff.mnemonicPrefix=false',
  'diff.relative=false',
  'diff.renames=false',
  'diff.algorithm=myers',
  'diff.indentHeuristic=true',
  'diff.interHunkContext=0',
  'diff.submodule=short',
  'color.ui=never',
  'commit.gpgSign=false',
  'submodule.recurse=false',
  'gc.auto=0',
  'maintenance.auto=false',
  'i18n.commitEncoding=UTF-8'
]);

/** The fixed author, committer and date of the runner's commits (the checkout's, and the one that records poc.patch, §9.2 step 3). */
const COMMIT_NAME = 'Verdikta code runner';
const COMMIT_EMAIL = 'code-runner@verdikta.invalid';
const COMMIT_IDENT = `${COMMIT_NAME} <${COMMIT_EMAIL}>`;
const COMMIT_DATE = '1767225600 +0000';
const COMMIT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: COMMIT_NAME,
  GIT_AUTHOR_EMAIL: COMMIT_EMAIL,
  GIT_AUTHOR_DATE: COMMIT_DATE,
  GIT_COMMITTER_NAME: COMMIT_NAME,
  GIT_COMMITTER_EMAIL: COMMIT_EMAIL,
  GIT_COMMITTER_DATE: COMMIT_DATE
});
const COMMIT_MESSAGE = 'poc.patch';

/** The only variables a caller may add to a git call's fixed environment. */
const EXTRA_ENV = Object.freeze(['GIT_LITERAL_PATHSPECS', ...Object.keys(COMMIT_ENV)]);

function envArgs(env) {
  return Object.entries(env).map(([k, v]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || typeof v !== 'string' || v.includes('\0')) throw new TypeError(`invalid env entry ${JSON.stringify(k)}`);
    return `${k}=${v}`;
  });
}

/**
 * `/usr/bin/env -i <fixed env> git <fixed -c flags> <args>`, an argv for ctx.exec.
 * @param {string[]} args
 * @param {object} [o]
 * @param {string} [o.gitDir] - GIT_DIR (with the work tree) or STAGE_DIR (bare); nothing else
 * @param {object} [o.env] - extra variables, from EXTRA_ENV only
 */
function git(args, { gitDir = GIT_DIR, env = {} } = {}) {
  if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === 'string')) throw new TypeError('git args must be strings');
  if (!GIT_DIRS.includes(gitDir)) throw new TypeError(`git runs only in the runner's repositories, not ${JSON.stringify(gitDir)}`);
  for (const k of Object.keys(env)) if (!EXTRA_ENV.includes(k)) throw new TypeError(`git takes no ${k} from a caller`);
  const fixed = { ...GIT_FIXED_ENV, GIT_DIR: gitDir, ...(gitDir === GIT_DIR ? { GIT_WORK_TREE: WORK_TREE } : {}), ...env };
  return ['/usr/bin/env', '-i', ...envArgs(fixed), 'git', ...GIT_CONFIG.flatMap((c) => ['-c', c]), ...args];
}

/** `/usr/bin/env -i <fixed env> /bin/sh -c <script> <name> <args>`: a runner script with nothing of the image's environment. */
function hermetic(script, name, args = []) {
  if (typeof script !== 'string' || typeof name !== 'string' || !args.every((a) => typeof a === 'string')) throw new TypeError('script, name and args must be strings');
  return ['/usr/bin/env', '-i', ...envArgs(BASE_ENV), '/bin/sh', '-c', script, name, ...args];
}

module.exports = {
  git, hermetic, GIT_ENV, GIT_FIXED_ENV, BASE_ENV, GIT_CONFIG, GIT_DIRS, EXTRA_ENV, COMMIT_ENV, COMMIT_MESSAGE, COMMIT_IDENT, COMMIT_DATE, WORK_TREE, GIT_DIR, STAGE_DIR
};
