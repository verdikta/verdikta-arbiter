'use strict';

/**
 * The `claimedObservable` gate (design §10.1; node A3a): "the tests
 * finding.json names are not the ones that failed, or the asserted
 * observable does not appear in the recorded failure". It is decided only on
 * a PoC that reproduced (every test the patch added failed as an assertion
 * on all three runs, its evidence trusted), from finding.json and the
 * recorded failures alone, so every arbiter reaches the same answer.
 *
 * - The tests finding.json names: the identifiers in `poc.command` and
 *   `poc.observable` that are the function name of a test the runner knows
 *   (a test the patch added, any test of the PoC's files, a baseline test).
 *   At least one must be named, and every one named must be a test the
 *   patch added (which, the PoC having reproduced, failed on every run).
 * - The words of the forge command name nothing else (node A3d; found on a
 *   real repository, whose fixture has `function test() external {}`, a
 *   coverage marker): `forge test`, the flags of the listing's grammar
 *   (src/commands.js), and what those flags hold that is no test's name, a
 *   path or a choice. So they count only as the name of a test the patch
 *   added, as before; anything else in the command is read: the values of
 *   --match-test, --no-match-test, --match-contract and --no-match-contract,
 *   and every word the grammar does not know (the command is the hunter's text,
 *   which the runner never runs, so it may well be outside the grammar). No
 *   filter is evaluated: a name counts when it is spelled, a `$` after it being
 *   the regex's end.
 * - The observable appears in the recorded failure: the observable's text
 *   in double quotes, each fragment of it, appears in the failure message of
 *   a named test on every run; or, when it quotes nothing, the failure
 *   message of a named test (the same on every run) appears in the
 *   observable as written. The message is forge's own, whole, or the form
 *   the report carries (repository-relative paths, at most 2,000
 *   characters): either matches. Whitespace runs compare as one space;
 *   nothing else is normalised.
 *
 * The rule is for the hunter tool to follow (P5): name the test, quote the
 * message forge prints.
 */

const commands = require('./commands');

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const QUOTED = /"([^"]*)"/g;
/** The grammar's flags whose value is matched against a test or its contract: a name written there is one. */
const NAME_FLAGS = Object.freeze(['--match-test', '--no-match-test', '--match-contract', '--no-match-contract']);
/** A word of a command, as a shell would split it: a quoted span stays whole, so what is inside one is never taken for a flag. */
const WORD = /(?:[^\s'"]+|'[^']*'|"[^"]*"|['"])+/g;
/** forge's subcommands in the grammar: `forge test` is a command, not a test. */
const SUBCOMMANDS = Object.freeze([...new Set(Object.values(commands.COMMANDS).map((c) => c.subcommand))]);

/** A test identity's function name: `<file> > <Contract> > name(args)` → name. */
function functionName(id) {
  const sig = String(id).split(' > ').pop();
  const open = sig.indexOf('(');
  return open < 0 ? sig : sig.slice(0, open);
}

/**
 * The identifiers in a text. `$` is a character of a Solidity identifier and the end of a
 * regex: `^test_x$`, the usual way to name one test to --match-test, names test_x, so an
 * identifier ending in it counts as itself and as what comes before it.
 */
function identifiers(text) {
  return [...String(text).matchAll(IDENTIFIER)].flatMap((m) => (m[0].endsWith('$') ? [m[0], m[0].replace(/\$+$/, '')] : [m[0]]));
}

/** Whether a flag's value is a word of the command rather than a name: a path pattern, or one of a flag's fixed choices. */
function ownValue(flag, value) {
  const spec = commands.FLAGS[flag];
  if (NAME_FLAGS.includes(flag)) return false;
  return spec.value === 'pattern' || (spec.value === 'choice' && spec.choices.includes(value));
}

/**
 * What of `poc.command` can name a test the patch did not add: the command less
 * its own words (the top of this file). Anything that is not exactly one of them
 * stays, so a name cannot be hidden by spelling a flag another way.
 * @param {string} command
 * @returns {string[]} the words kept
 */
function namingWords(command) {
  const words = command.match(WORD) || [];
  const kept = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w === 'forge' && SUBCOMMANDS.includes(words[i + 1])) { i += 1; continue; }
    if (commands.VERBOSITY.test(w)) continue;
    const eq = w.indexOf('=');
    const flag = w.startsWith('--') && Object.hasOwn(commands.ALIASES, eq < 0 ? w : w.slice(0, eq)) ? commands.ALIASES[eq < 0 ? w : w.slice(0, eq)] : null;
    if (flag === null) { kept.push(w); continue; }
    if (eq >= 0) {
      const value = w.slice(eq + 1);
      if (!ownValue(flag, value)) kept.push(value);
    } else if (i + 1 < words.length && !words[i + 1].startsWith('-') && ownValue(flag, words[i + 1])) {
      i += 1; // as the grammar reads it: a value does not start with `-`
    }
    // The next word, when it is any other value, is read on its own turn.
  }
  return kept;
}

function squash(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function listNames(names) {
  const shown = names.slice(0, 5).join(', ');
  return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown;
}

/**
 * @param {object} o
 * @param {object} o.finding - finding.json
 * @param {Array<{id:string, messages:Array<string|null>, recorded?:Array<string|null>}>} o.tests - the tests the patch added, with
 *   each run's failure message as forge wrote it (`messages`) and as the report carries it (`recorded`)
 * @param {Iterable<string>} o.knownNames - function names of every test the runner knows of
 * @returns {{status:'pass'|'fail', detail:string, named:string[]}}
 */
function claimedObservable({ finding, tests, knownNames }) {
  const fail = (detail, named = []) => ({ status: 'fail', detail, named });
  const poc = finding && typeof finding === 'object' && finding.poc && typeof finding.poc === 'object' ? finding.poc : null;
  const observable = poc && typeof poc.observable === 'string' ? poc.observable : null;
  const command = poc && typeof poc.command === 'string' ? poc.command : '';
  if (observable === null) return fail('finding.json has no poc.observable');
  const added = new Map();
  for (const t of tests) {
    const name = functionName(t.id);
    if (!added.has(name)) added.set(name, []);
    added.get(name).push(t);
  }
  const known = new Set([...knownNames, ...added.keys()]);
  const inObservable = identifiers(observable);
  // A test the patch added is named wherever the text says it; any other only where a name can be written.
  const named = [...new Set([
    ...[...identifiers(command), ...inObservable].filter((t) => added.has(t)),
    ...[...identifiers(namingWords(command).join('\n')), ...inObservable].filter((t) => known.has(t))
  ])].sort();
  if (named.length === 0) {
    return fail(`finding.json names none of the tests the patch added (${listNames([...added.keys()].sort())}) in poc.command or poc.observable`);
  }
  const other = named.filter((n) => !added.has(n));
  if (other.length) return fail(`finding.json names ${other[0]}, which is not a test the patch added that failed`, named);
  const namedTests = named.flatMap((n) => added.get(n));
  // Each run's message in both forms: forge's whole message, and the report's.
  const forms = (t) => [t.messages, t.recorded || t.messages].map((list) => list.map((m) => (typeof m === 'string' ? squash(m) : null)));
  const fragments = [...observable.matchAll(QUOTED)].map((m) => squash(m[1])).filter((f) => f !== '');
  const who = named.join(', ');
  if (fragments.length) {
    for (const f of fragments) {
      const seen = namedTests.some((t) => forms(t).some((ms) => ms.every((m) => m !== null && m.includes(f))));
      if (!seen) return fail(`"${f.slice(0, 300)}" is not in the recorded failure of ${who} on every run`, named);
    }
    return { status: 'pass', detail: `finding.json names ${who}; each quoted observable is in its recorded failure on every run`, named };
  }
  const plain = squash(observable);
  for (const t of namedTests) {
    for (const ms of forms(t)) {
      if (ms[0] !== null && ms[0] !== '' && ms.every((m) => m === ms[0]) && plain.includes(ms[0])) {
        return { status: 'pass', detail: `finding.json names ${who}; its recorded failure is in the observable`, named };
      }
    }
  }
  const first = namedTests[0] ? forms(namedTests[0])[1][0] : null;
  return fail(`poc.observable quotes no failure text, and the recorded failure of ${who}${first ? ` ("${first.slice(0, 300)}")` : ''} is not in it`, named);
}

module.exports = { claimedObservable, functionName };
