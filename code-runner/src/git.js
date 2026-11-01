'use strict';

/**
 * git inside the sandbox (design §9.1: git apply included runs inside the
 * container, never on the host). Every git the runner starts is a step argv
 * built here and run through ctx.exec; the host never runs git.
 *
 * The work tree is /work, a copy of the env image's checkout. Its own
 * configuration is the maker's, so each call fixes what would change an
 * outcome or run something: no system or global config, no hooks, no
 * fsmonitor, no line-ending conversion, whitespace errors never refuse a
 * patch, diffs without external drivers, prefixes or rename detection, the
 * index compared by content (no ignored stat data, no sparse checkout), and
 * C-locale messages (they reach gate details, so they must read the same on
 * every arbiter). `-c` settings reach the git processes git starts for
 * submodules too. Attribute drivers (filters, textconv) are switched off by
 * the attributes the claim pipeline writes to .git/info/attributes
 * (claim.js, NEUTRAL_ATTRIBUTES), the one attribute source above the
 * repository's own.
 */

const WORK_TREE = '/work';
const GIT_DIR = '/work/.git';

const GIT_ENV = Object.freeze({
  GIT_DIR,
  GIT_WORK_TREE: WORK_TREE,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  LC_ALL: 'C'
});

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
  // GIT_NO_REPLACE_OBJECTS is dropped for submodule processes; -c settings reach them.
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

/** The fixed author, committer and date of the commit that records poc.patch (§9.2 step 3). */
const COMMIT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: 'Verdikta code runner',
  GIT_AUTHOR_EMAIL: 'code-runner@verdikta.invalid',
  GIT_AUTHOR_DATE: '1767225600 +0000',
  GIT_COMMITTER_NAME: 'Verdikta code runner',
  GIT_COMMITTER_EMAIL: 'code-runner@verdikta.invalid',
  GIT_COMMITTER_DATE: '1767225600 +0000'
});
const COMMIT_MESSAGE = 'poc.patch';

/** `git <fixed -c flags> <args>`, an argv for ctx.exec. */
function git(args) {
  if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === 'string')) throw new TypeError('git args must be strings');
  return ['git', ...GIT_CONFIG.flatMap((c) => ['-c', c]), ...args];
}

module.exports = { git, GIT_ENV, GIT_CONFIG, COMMIT_ENV, COMMIT_MESSAGE, WORK_TREE, GIT_DIR };
