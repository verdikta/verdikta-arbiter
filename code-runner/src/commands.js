'use strict';

/**
 * The listing's forge commands (node A3a attempt 3, R11-F1; owner decision
 * Q31): `commands.build` is `forge build` and `commands.test`, `testFiles`
 * and `testIds` are `forge test`, each followed only by flags from an
 * allowlist. The runner never hands a command to a shell: it parses the
 * string here, strictly, and runs the image's forge itself with the parsed
 * arguments as an argv (forge.forgeArgv), in /work, with the fixed
 * environment the integrity reference probed forge's configuration in. So
 * every forge the maker's commands start runs with the configuration the
 * checks watch, and nothing else runs.
 *
 * One grammar, shared: claims (claim.js checkForgeSpec, checkClaim) and the
 * listing check (listing.js validateListingRequest) refuse exactly the same
 * forms, with the same issue. `commands.setup` is not parsed here: it runs
 * only while the env image is built (P3a's builder), never on an arbiter.
 *
 * The grammar:
 *
 * - The string is tokens separated by spaces (U+0020). A token is either
 *   unquoted, made only of `A-Z a-z 0-9 _ . / : , + @ % = -`, or a whole
 *   single-quoted value (`'…'`: printable ASCII, no quote inside; a value
 *   with spaces or a glob or regex character). Nothing else: no other
 *   quoting or escape, no shell character (`; & | < > $ \` * ? [ ] ( ) { }
 *   " \ ~ # !`) outside a quoted value, no control character, line break or
 *   non-ASCII character anywhere. The runner's placeholders are whole
 *   unquoted tokens: `$FILES` (or `${FILES}`) and `$TEST_IDS` (or
 *   `${TEST_IDS}`).
 * - The first token is `forge`, the second the command's subcommand
 *   (`build`, or `test`). Then flags only: a long flag (`--name`, or
 *   `--name=value` for one that takes a value) or a verbosity flag (`-v` to
 *   `-vvvvv`, test commands only), each at most once (an alias counts as its
 *   flag). A flag's value is the next token (or follows `=`). No positional
 *   argument, no other short option, no short-option cluster, no flag
 *   outside the command's allowlist (aliases forge hides from --help
 *   included: an allowlist names what is accepted).
 * - Values: a pattern (regex or glob) is text, 1 to 512 characters; a count
 *   is a whole number from 1 to its maximum; a choice is one of its words.
 *   An unquoted value starting with `-` is read as a missing value (quote
 *   it). The runner passes every value as `--name=value`, one argv element,
 *   so forge never reads a value as a flag.
 * - The runner's own flags (`--junit`, `--fuzz-seed`) and environment are
 *   the runner's: a command cannot set them.
 * - testFiles is `forge test --match-path $FILES …`; testIds is `forge test
 *   --match-test $TEST_IDS …` and may add `--match-path $FILES`. There the
 *   runner chooses the tests, so the matching flags take only its
 *   placeholder and no other filter is allowed (one could only hide a PoC's
 *   tests).
 *
 * Every refusal is one requester error, COMMAND_NOT_ALLOWED, naming the
 * command and the offending token. Besides it: COMMAND_MISSING (no
 * command), COMMAND_INVALID (over 2,000 characters), COMMAND_PLACEHOLDER
 * (testFiles without `--match-path $FILES`, testIds without `--match-test
 * $TEST_IDS`).
 */

const MAX_LENGTH = 2000;
const MAX_PATTERN = 512;
const MAX_FUZZ_RUNS = 1000000;
const MAX_VERBOSITY = 5;

/** An unquoted token's characters. */
const UNQUOTED = /^[A-Za-z0-9_./:,+@%=-]+$/;
/** A quoted value's characters: printable ASCII but the quote. */
const QUOTED = /^[\u0020-\u0026\u0028-\u007e]*$/;
const PLACEHOLDER = /^\$(?:(FILES|TEST_IDS)|\{(FILES|TEST_IDS)\})$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const VERBOSITY = /^-v+$/;

/** Why a character is refused outside a quoted value, by class (for the detail). */
const CHARACTER_CLASSES = Object.freeze([
  [/[\n\r]/, 'a line break'],
  [/[\u0000-\u001f\u007f]/, 'a control character'],
  [/[^\u0000-\u007f]/, 'a character outside ASCII'],
  [/[;&|]/, 'a command separator, `&` or a pipe'],
  [/[<>]/, 'a redirect'],
  [/[$`]/, 'an expansion (`$` or a backquote)'],
  [/[*?[\]]/, 'a glob character outside a quoted value'],
  [/[(){}]/, 'a subshell, group or brace'],
  [/["\\]/, 'a double quote or a backslash (only a whole value may be quoted, in single quotes)'],
  [/[~#!]/, 'a shell character (`~`, `#` or `!`)'],
  [/ /, 'a space'],
  [/[^A-Za-z0-9_./:,+@%=-]/, 'a character allowed only inside a single-quoted value']
]);

/**
 * The flags a command may use, by forge 1.8.5's names. `value`: null (a
 * switch), 'pattern' (text), 'count' (1 to `max`) or 'choice' (one of
 * `choices`). `aliases`: the visible aliases forge's --help lists.
 */
const FLAGS = Object.freeze({
  '--skip': { value: 'choice', choices: ['test', 'script'], aliases: [] },
  '--match-test': { value: 'pattern', aliases: ['--mt'] },
  '--no-match-test': { value: 'pattern', aliases: ['--nmt'] },
  '--match-contract': { value: 'pattern', aliases: ['--mc'] },
  '--no-match-contract': { value: 'pattern', aliases: ['--nmc'] },
  '--match-path': { value: 'pattern', aliases: ['--mp'] },
  '--no-match-path': { value: 'pattern', aliases: ['--nmp'] },
  '--fuzz-runs': { value: 'count', max: MAX_FUZZ_RUNS, aliases: [] },
  '--isolate': { value: null, aliases: [] }
});

const ALIASES = Object.freeze(Object.fromEntries(Object.entries(FLAGS).flatMap(([name, f]) => [[name, name], ...f.aliases.map((a) => [a, name])])));

const MATCHING = Object.freeze(['--match-test', '--no-match-test', '--match-contract', '--no-match-contract', '--match-path', '--no-match-path']);

/**
 * What each command may hold. `placeholders`: the flags whose value is the
 * runner's placeholder, and only that; `required`: the placeholders the
 * command must use.
 */
const COMMANDS = Object.freeze({
  build: Object.freeze({ subcommand: 'build', flags: ['--skip'], verbosity: false, placeholders: {}, required: [] }),
  test: Object.freeze({ subcommand: 'test', flags: [...MATCHING, '--fuzz-runs', '--isolate'], verbosity: true, placeholders: {}, required: [] }),
  testFiles: Object.freeze({ subcommand: 'test', flags: ['--match-path', '--fuzz-runs', '--isolate'], verbosity: true, placeholders: { '--match-path': 'FILES' }, required: ['FILES'] }),
  testIds: Object.freeze({
    subcommand: 'test', flags: ['--match-test', '--match-path', '--fuzz-runs', '--isolate'], verbosity: true,
    placeholders: { '--match-test': 'TEST_IDS', '--match-path': 'FILES' }, required: ['TEST_IDS']
  })
});

/** Flags whose refusal the detail explains beyond "not allowed" (forge 1.8.5's names and aliases). */
const KNOWN = Object.freeze({
  configuration: ['--profile', '--config-path', '--root', '--use', '--compiler-version', '--offline', '--force', '--no-cache', '--ffi',
    '--evm-version', '--optimize', '--optimizer-runs', '--via-ir', '--libraries', '--deny', '--ignored-error-codes', '--no-auto-detect'],
  paths: ['--out', '--contracts', '--remappings', '--remappings-env', '--cache-path', '--lib-paths', '--hardhat', '--hh', '--build-info-path',
    '--build-info', '--extra-output-files', '--json-file', '--dump', '--gas-snapshot-emit', '--fuzz-corpus-dir', '--invariant-corpus-dir',
    '--regression-out', '--showmap-out', '--watch'],
  runner: ['--junit', '--fuzz-seed', '--json', '--md', '--quiet', '--allow-failure', '--fail-fast', '--rerun', '--list']
});

const SHORT_REASONS = Object.freeze({
  '-o': 'it sets forge\'s output directory (--out)',
  '-C': 'it sets the contracts directory (--contracts)',
  '-R': 'it sets the remappings (--remappings)',
  '-j': 'it sets forge\'s thread count (--threads)',
  '-q': 'it silences forge, and the runner reads forge\'s report',
  '-w': 'it starts forge\'s watch mode',
  '-r': 'it names an RPC endpoint (the sandbox has no network)',
  '-s': 'it is not on the allowlist',
  '-l': 'it lists tests instead of running them'
});

function shown(token) {
  return JSON.stringify(token);
}

function allowedText(key) {
  const c = COMMANDS[key];
  const parts = c.flags.map((f) => {
    const spec = FLAGS[f];
    const names = [f, ...spec.aliases].join('/');
    if (c.placeholders[f]) return `${names} $${c.placeholders[f]}`;
    if (spec.value === 'choice') return `${names} ${spec.choices.join('|')}`;
    if (spec.value === 'count') return `${names} <1-${spec.max}>`;
    if (spec.value === 'pattern') return `${names} <pattern>`;
    return names;
  });
  if (c.verbosity) parts.push(`-v to -${'v'.repeat(MAX_VERBOSITY)}`);
  return parts.length ? `\`forge ${c.subcommand}\` followed only by ${parts.join(', ')}` : `\`forge ${c.subcommand}\``;
}

function issue(code, key, detail) {
  return { code, path: `/spec/commands/${key}`, detail };
}

function refusal(key, token, reason) {
  return {
    ok: false,
    token,
    issue: issue('COMMAND_NOT_ALLOWED', key,
      `commands.${key}: ${shown(token)} is not allowed: ${reason}. commands.${key} must be ${allowedText(key)}; anything else belongs in commands.setup, which runs when the image is built`)
  };
}

/** Why one character outside a quoted value is refused. */
function characterReason(token) {
  for (const [re, why] of CHARACTER_CLASSES) if (re.test(token)) return why;
  return 'a character allowed only inside a single-quoted value';
}

/**
 * Split a command into tokens. A token the grammar refuses by its
 * characters or quoting carries `bad` (why); parseCommand names the first
 * offending token from the left, whichever way it offends.
 * @returns {Array<{text:string, raw:string, quoted:boolean, placeholder:string|null, bad:string|null}>}
 */
function tokenize(text) {
  const tokens = [];
  let i = 0;
  const toSpace = (from) => {
    let k = from;
    while (k < text.length && text[k] !== ' ') k += 1;
    return k;
  };
  while (i < text.length) {
    if (text[i] === ' ') { i += 1; continue; }
    if (text[i] === '\'') {
      const end = text.indexOf('\'', i + 1);
      if (end < 0) {
        tokens.push({ text: text.slice(i), raw: text.slice(i), quoted: true, placeholder: null, bad: 'a single quote that is never closed' });
        break;
      }
      if (end + 1 < text.length && text[end + 1] !== ' ') {
        const k = toSpace(end + 1);
        tokens.push({ text: text.slice(i, k), raw: text.slice(i, k), quoted: false, placeholder: null, bad: 'a quote inside a token (only a whole value may be quoted)' });
        i = k;
        continue;
      }
      const value = text.slice(i + 1, end);
      const raw = text.slice(i, end + 1);
      const bad = QUOTED.test(value) ? null : `${characterReason(value.replace(/[\u0020-\u007e]/g, ''))} inside the quotes`;
      tokens.push({ text: value, raw, quoted: true, placeholder: null, bad });
      i = end + 1;
      continue;
    }
    const k = toSpace(i);
    const raw = text.slice(i, k);
    const p = PLACEHOLDER.exec(raw);
    let bad = null;
    if (!p) {
      if (raw.includes('\'')) bad = 'a quote inside a token (only a whole value may be quoted)';
      else if (!UNQUOTED.test(raw)) bad = characterReason(raw.replace(/[A-Za-z0-9_./:,+@%=-]/g, ''));
    }
    tokens.push({ text: raw, raw, quoted: false, placeholder: p ? p[1] || p[2] : null, bad });
    i = k;
  }
  return tokens;
}

/** Why a flag outside the command's allowlist is refused. */
function flagReason(key, name) {
  if (KNOWN.runner.includes(name)) {
    return name === '--junit' || name === '--fuzz-seed'
      ? 'the runner adds it itself'
      : 'it changes forge\'s report or which tests run, which the runner reads';
  }
  if (KNOWN.paths.includes(name)) return 'it sets a path forge reads or writes';
  if (KNOWN.configuration.includes(name)) return 'it changes forge\'s configuration (the runner runs forge with the configuration it probed)';
  if (MATCHING.includes(ALIASES[name] || name) && (key === 'testFiles' || key === 'testIds')) {
    return `the runner chooses the tests commands.${key} runs; another filter could only hide them`;
  }
  if (ALIASES[name]) return `it is not one of the flags commands.${key} allows`;
  return 'it is not on the allowlist';
}

/**
 * Parse one command of the listing.
 * @param {'build'|'test'|'testFiles'|'testIds'} key
 * @param {unknown} text - the spec's commands[key]
 * @returns {{ok:true, key:string, subcommand:string, args:object[]} | {ok:false, issue:object, token?:string}}
 *   `args` in the command's order: {flag, value} (value: null for a switch, text, or {placeholder}) or {verbosity}
 */
function parseCommand(key, text) {
  const c = COMMANDS[key];
  if (!c) throw new TypeError(`no forge command ${JSON.stringify(key)}`);
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, issue: issue('COMMAND_MISSING', key, `the forge adapter needs commands.${key}`) };
  if (text.length > MAX_LENGTH) return { ok: false, issue: issue('COMMAND_INVALID', key, `commands.${key} must be at most ${MAX_LENGTH} characters`) };
  const tokens = tokenize(text);

  const head = tokens[0];
  if (head.bad) return refusal(key, head.raw, head.bad);
  if (head.quoted || head.text !== 'forge') {
    if (head.quoted) return refusal(key, head.raw, 'only a flag\'s value may be quoted');
    if (head.placeholder) return refusal(key, head.raw, 'the command starts with forge');
    if (ASSIGNMENT.test(head.text)) return refusal(key, head.raw, 'an environment assignment (forge\'s environment is the runner\'s)');
    if (head.text === 'env') return refusal(key, head.raw, 'a program other than forge (forge\'s environment is the runner\'s)');
    if (head.text.includes('/')) return refusal(key, head.raw, 'a path to a program (the runner runs the image\'s forge itself)');
    return refusal(key, head.raw, 'a program other than forge');
  }
  const sub = tokens[1];
  if (!sub) return refusal(key, head.raw, `forge without its subcommand (\`${c.subcommand}\`)`);
  if (sub.bad) return refusal(key, sub.raw, sub.bad);
  if (sub.quoted || sub.placeholder || sub.text !== c.subcommand) {
    return refusal(key, sub.raw, sub.quoted ? 'only a flag\'s value may be quoted' : `another forge subcommand than \`${c.subcommand}\``);
  }

  const args = [];
  const seen = new Set();
  const used = new Set();
  for (let k = 2; k < tokens.length; k += 1) {
    const tok = tokens[k];
    if (tok.bad) return refusal(key, tok.raw, tok.bad);
    if (tok.quoted) return refusal(key, tok.raw, 'only a flag\'s value may be quoted (a quoted token here is an argument)');
    if (tok.placeholder) return refusal(key, tok.raw, `the runner fills $${tok.placeholder} only as the value of ${placeholderFlags(tok.placeholder)}`);
    const t = tok.text;
    if (VERBOSITY.test(t)) {
      if (!c.verbosity) return refusal(key, t, `commands.${key} takes no verbosity flag`);
      if (t.length - 1 > MAX_VERBOSITY) return refusal(key, t, `more than -${'v'.repeat(MAX_VERBOSITY)}`);
      if (seen.has('verbosity')) return refusal(key, t, 'a second verbosity flag (write it once, as -vvv)');
      seen.add('verbosity');
      args.push({ verbosity: t.length - 1 });
      continue;
    }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq >= 0 ? t.slice(0, eq) : t;
      const flag = ALIASES[name];
      if (!flag || !c.flags.includes(flag)) return refusal(key, t, flagReason(key, name));
      if (seen.has(flag)) return refusal(key, t, `${flag} a second time`);
      seen.add(flag);
      const spec = FLAGS[flag];
      if (spec.value === null) {
        if (eq >= 0) return refusal(key, t, `${flag} takes no value`);
        args.push({ flag, value: null });
        continue;
      }
      let valueTok;
      if (eq >= 0) {
        valueTok = { text: t.slice(eq + 1), quoted: false, placeholder: null, raw: t, bad: null };
        if (valueTok.text === '') return refusal(key, t, `${flag} with an empty value`);
      } else {
        valueTok = tokens[k + 1];
        if (valueTok && valueTok.bad) return refusal(key, valueTok.raw, valueTok.bad);
        if (!valueTok || (!valueTok.quoted && !valueTok.placeholder && valueTok.text.startsWith('-'))) {
          return refusal(key, t, `${flag} without its value (quote a value that starts with -)`);
        }
        k += 1;
      }
      const v = checkValue(key, flag, spec, valueTok);
      if (!v.ok) return refusal(key, v.token, v.reason);
      if (v.value.placeholder) used.add(v.value.placeholder);
      args.push({ flag, value: v.value.placeholder ? { placeholder: v.value.placeholder } : v.value.text });
      continue;
    }
    if (t.startsWith('-')) {
      if (t === '-') return refusal(key, t, 'an argument (forge takes no paths or other arguments here, only flags)');
      if (t.length === 2) return refusal(key, t, `the short option ${t}${SHORT_REASONS[t] ? `: ${SHORT_REASONS[t]}` : ' is not on the allowlist'}`);
      return refusal(key, t, 'a short-option cluster (write each allowed flag in its long form)');
    }
    if (ASSIGNMENT.test(t)) return refusal(key, t, 'an environment assignment (forge\'s environment is the runner\'s)');
    return refusal(key, t, 'an argument (forge takes no paths or other arguments here, only flags)');
  }
  for (const p of c.required) {
    if (!used.has(p)) {
      const flag = Object.keys(c.placeholders).find((f) => c.placeholders[f] === p);
      return { ok: false, issue: issue('COMMAND_PLACEHOLDER', key, `commands.${key} must use ${flag} $${p}, which the runner fills`) };
    }
  }
  return { ok: true, key, subcommand: c.subcommand, args };
}

function placeholderFlags(p) {
  const where = Object.entries(COMMANDS).flatMap(([k, c]) => Object.entries(c.placeholders).filter(([, v]) => v === p).map(([f]) => `${f} in commands.${k}`));
  return where.join(' or ');
}

/** One flag's value: text within its kind, or the runner's placeholder where the command takes it. */
function checkValue(key, flag, spec, tok) {
  const c = COMMANDS[key];
  const want = c.placeholders[flag] || null;
  const shownTok = tok.quoted ? tok.raw : tok.text;
  if (tok.placeholder) {
    if (tok.placeholder !== want) return { ok: false, token: tok.raw, reason: `the runner fills $${tok.placeholder} only as the value of ${placeholderFlags(tok.placeholder)}` };
    return { ok: true, value: { placeholder: tok.placeholder } };
  }
  if (want) return { ok: false, token: shownTok, reason: `in commands.${key}, ${flag} takes only $${want}, which the runner fills` };
  const v = tok.text;
  if (spec.value === 'pattern') {
    if (v === '') return { ok: false, token: shownTok, reason: `${flag} with an empty value` };
    if (v.length > MAX_PATTERN) return { ok: false, token: shownTok, reason: `a ${flag} pattern of more than ${MAX_PATTERN} characters` };
    return { ok: true, value: { text: v } };
  }
  if (spec.value === 'count') {
    if (!/^[1-9][0-9]*$/.test(v) || v.length > String(spec.max).length || Number(v) > spec.max) {
      return { ok: false, token: shownTok, reason: `${flag} takes a whole number from 1 to ${spec.max}` };
    }
    return { ok: true, value: { text: v } };
  }
  if (spec.value === 'choice') {
    if (!spec.choices.includes(v)) return { ok: false, token: shownTok, reason: `${flag} takes ${spec.choices.join(' or ')}` };
    return { ok: true, value: { text: v } };
  }
  throw new TypeError(`unknown value kind for ${flag}`);
}

/**
 * The issues of one command (none when it parses).
 * @param {object} commands - the spec's commands
 * @param {string} key
 * @returns {object[]}
 */
function commandIssues(commands, key) {
  const value = commands && typeof commands === 'object' ? commands[key] : undefined;
  const p = parseCommand(key, value);
  return p.ok ? [] : [p.issue];
}

/**
 * forge's arguments for a parsed command (after the binary): the
 * subcommand, then each flag as one element (`--name=value`), the runner's
 * placeholders filled from `values`.
 * @param {object} parsed - parseCommand()'s answer (ok)
 * @param {{FILES?:string, TEST_IDS?:string}} [values]
 * @returns {string[]}
 */
function forgeArgs(parsed, values = {}) {
  if (!parsed || parsed.ok !== true) throw new TypeError('forgeArgs needs a parsed command');
  const out = [parsed.subcommand];
  for (const a of parsed.args) {
    if (a.verbosity) { out.push(`-${'v'.repeat(a.verbosity)}`); continue; }
    if (a.value === null) { out.push(a.flag); continue; }
    const v = typeof a.value === 'string' ? a.value : values[a.value.placeholder];
    if (typeof v !== 'string' || v === '' || v.includes('\0')) throw new TypeError(`no value for $${a.value.placeholder}`);
    out.push(`${a.flag}=${v}`);
  }
  return out;
}

/**
 * A command the spec was already checked for (checkForgeSpec): parsed, or
 * the requester's error should it not parse.
 */
function parsedCommand(commands, key, RequesterError) {
  const p = parseCommand(key, commands ? commands[key] : undefined);
  if (!p.ok) throw new RequesterError([p.issue]);
  return p;
}

module.exports = {
  parseCommand, commandIssues, forgeArgs, parsedCommand, tokenize, allowedText,
  COMMANDS, FLAGS, ALIASES, KNOWN, VERBOSITY, MAX_LENGTH, MAX_PATTERN, MAX_FUZZ_RUNS, MAX_VERBOSITY
};
