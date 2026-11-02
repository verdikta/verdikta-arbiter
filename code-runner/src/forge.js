'use strict';

/**
 * The forge adapter (design §8.1 commands, §9.2 steps 5-6, §20 decision 17:
 * the MVP is Foundry-only). What the runner adds to the maker's declared
 * commands, how it names a test, and how it reads a forge test result.
 *
 * Commands (node A3a attempt 3, owner decision Q31): the runner runs forge
 * itself. A listing's build and test commands are plain `forge build` /
 * `forge test` with allowlisted flags (src/commands.js parses them); no
 * shell ever reads them. forgeArgv() is forge's whole argv: `/usr/bin/env
 * -i`, forge's fixed environment (forgeEnvironment: the sandbox's fixed
 * variables, the image's PATH as the integrity reference probed it, the
 * builder's fixed values, the fuzz seed, nothing else), the forge the reference probed (its real path),
 * then the parsed arguments, each one argv element. The launcher (A1) prints
 * its nonce and execs that argv without interpreting it; the runner runs it
 * in /work. `forge config --json` (the configuration the checks watch) is
 * read through the same forgeArgv, so it is the configuration every maker
 * command runs with. The runner appends its reporter flags to a test run:
 * `--junit` (forge prints the JUnit on stdout, which the runner reads as a
 * capped stream) and the fixed `--fuzz-seed` from @verdikta/common, so fuzz
 * and invariant tests draw the same inputs on every host and every run; the
 * seed is also FOUNDRY_FUZZ_SEED in forge's environment.
 *
 * Assertion vs error (§10.1 `reproduces`). A forge test fails one way: the
 * test function ran and reverted (an assertion helper, a require, a revert
 * reached from the code under test). That is the assertion failure the
 * gate wants; it is what the §8.2 harness proof tells apart from a broken
 * test. Everything else is an error:
 *
 * - no JUnit at all (a compile error: an import that does not resolve);
 * - a failed setUp(), constructor() or afterInvariant() (the suite never
 *   reached its tests: forge's collection error), or a record forge marks as
 *   an error;
 * - a failure whose body never ran. forge reports a unit-test failure's gas
 *   as `(gas: N)`, and every path that fails a test without running it
 *   (a reverting beforeTestSetup, a table test without fixtures, an inline
 *   config error, an executor error) leaves the default `(gas: 0)`; a body
 *   that ran always used gas. This is read from the record's own
 *   <system-out>, as forge 1.8.5 writes it (`<status> <signature> (gas: N)`);
 * - a failure without a reason (the reverting beforeTestSetup, and legacy
 *   non-reverting assertions, which the listing check refuses);
 * - a failure forge raised itself, by its fixed wording at the pinned
 *   version (FORGE_ERRORS, taken from forge v1.8.5's runner): a refused or
 *   failed cheatcode (`vm.<name>: …`), `testFail*` (removed), the EVM failing
 *   (`EvmError:` other than `Revert`), fuzz or invariant set-up, a fuzz test
 *   whose inputs `vm.assume` all rejected, table-test fixtures, an invariant
 *   with parameters, incomplete symbolic execution.
 *
 * A bare `EvmError: Revert` stays the test's own revert: forge prints the
 * same for a call to an address with no code, so that case is the jury's to
 * read (claimedObservable, A3a), not the gate's. Misreading in the other
 * direction gains a hunter nothing: a test that reverts on purpose is an
 * assertion failure anyway. The rules move with the forge pin.
 */

const { FORGE_FUZZ_SEED } = require('./common');
const { SANDBOX_ENV } = require('./sandbox');

/**
 * The rest of the fixed ENV of the builder's final stage
 * (stake-attestation/builder/src/dockerfile.js in verdikta-applications):
 * forge finds the solc releases the maker's setup installed under
 * XDG_DATA_HOME (without it, "can't install missing solc in offline mode").
 * Fixed values, so an image's own ENV moves nothing.
 */
const BUILDER_ENV = Object.freeze({ XDG_DATA_HOME: '/opt/verdikta/tools/share', VERDIKTA_TOOLS: '/opt/verdikta/tools' });

/** The work tree, where forge runs (forge reads /work/foundry.toml, as the reference probed it). */
const FORGE_WORKDIR = '/work';

function reporterFlags() {
  return ['--junit', '--fuzz-seed', FORGE_FUZZ_SEED];
}

/**
 * forge's whole environment: the image's PATH as the integrity reference
 * probed it (what forge's own children, ffi included, look commands up on),
 * the sandbox's fixed variables (§9.3: HOME, TZ, LANG, CI, PYTHONHASHSEED),
 * the builder's fixed values (BUILDER_ENV) and the fuzz seed. No other variable
 * of the image's environment, and no FOUNDRY_* but the seed.
 * @param {string} path - the probed PATH
 */
function forgeEnvironment(path) {
  if (typeof path !== 'string' || /[\0\n]/.test(path)) throw new TypeError('the probed PATH must be one line');
  return { PATH: path, ...SANDBOX_ENV, ...BUILDER_ENV, FOUNDRY_FUZZ_SEED: FORGE_FUZZ_SEED };
}

/**
 * Why the runner cannot run this forge as an argv (null when it can): env
 * reads an argument holding `=` before the program as an assignment, so the
 * program's path must be absolute and hold no `=` and no control character.
 * @param {{realPath:string, path:string}} tool
 */
function toolProblem(tool) {
  if (!tool || typeof tool.realPath !== 'string' || !tool.realPath.startsWith('/')) return 'forge has no absolute path';
  if (/[=\u0000-\u001f\u007f]/.test(tool.realPath)) return `forge's path ${JSON.stringify(tool.realPath)} holds "=" or a control character`;
  if (typeof tool.path !== 'string' || /[\0\n]/.test(tool.path)) return 'the image\'s PATH is not one line';
  return null;
}

/**
 * The argv that runs forge in the sandbox (through ctx.exec, so through the
 * launcher): `/usr/bin/env -i <forge's environment> <forge> <args…>`. `args`
 * are forge's arguments, each one element, as commands.forgeArgs() gives
 * them (plus the runner's reporter flags for a test run); no shell reads
 * any of them.
 * @param {{realPath:string, path:string}} tool - the forge the reference probed, and the image's PATH
 * @param {string[]} args
 */
function forgeArgv(tool, args) {
  const problem = toolProblem(tool);
  if (problem) throw new TypeError(problem);
  if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === 'string' && !a.includes('\0'))) {
    throw new TypeError('forge\'s arguments must be strings without NUL');
  }
  const env = forgeEnvironment(tool.path);
  return ['/usr/bin/env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), tool.realPath, ...args];
}

/** The runner's test identity (baseline.json): file > contract > test, the test as forge names it (its signature). */
function testIdentity(file, contract, name) {
  return `${file} > ${contract} > ${name}`;
}

/** forge's test kinds (TestFunctionKind::classify): test*, invariant* / statefulFuzz*, table*, and check* / prove* when symbolic entry points are on. */
const TEST_FUNCTION = /^(?:test|invariant|statefulFuzz|table|check|prove)[^()]*\(.*\)$/s;

/** Whether a JUnit record is a test function. */
function isTestFunction(name) {
  return typeof name === 'string' && TEST_FUNCTION.test(name);
}

/**
 * Whether a JUnit record is part of an invariant campaign: a predicate
 * (`invariant*`, `statefulFuzz*`), or a handler failure (`handler <name>`, a
 * record of its own). forge 1.8.5 expands a campaign into these
 * (add_junit_test_cases); its suite summary counts the campaign as one result.
 */
function isInvariantRecord(name) {
  return typeof name === 'string' && (/^(?:invariant|statefulFuzz)[^()]*\(.*\)$/s.test(name) || name.startsWith('handler '));
}

/** The records forge writes for a suite that failed before its tests ran (or after its invariants). */
const HARNESS_RECORDS = Object.freeze(['setUp()', 'constructor()', 'afterInvariant()']);

/** Whether a JUnit record is a harness record: a failure there means the suite's tests did not (all) run. */
function isHarnessRecord(name) {
  return HARNESS_RECORDS.includes(name);
}

/** Failure reasons forge writes itself, at the pinned version (forge v1.8.5, crates/forge/src/runner.rs and result.rs). */
const FORGE_ERRORS = Object.freeze([
  /^vm\.[A-Za-z0-9_]+: /, // a cheatcode refused or failed: FFI disabled, a path not allowed, no such artifact
  /^`testFail\*` has been removed/, // forge refuses the removed test form
  /^EvmError: (?!Revert$)/, // the EVM itself failed: out of gas, memory, stack, …
  /^`vm\.assume` rejected too many inputs/, // the fuzzer found no input the test accepts
  /^failed to set up (?:fuzz|invariant) testing environment/, // the campaign never started
  /^Table test should have /, // a table test without parameters or fixtures
  /^No fixture defined for param /,
  /^[0-9]+ fixtures defined for .* \(expected [0-9]+\)$/s,
  /^invariant `[^`]*` must take no parameters$/,
  /^multiple (?:setUp|afterInvariant) functions$/,
  /^incomplete symbolic execution /,
  /^minimize (?:edge index|observations) lock poisoned$/
]);

/** XML attribute-value normalisation (§3.3.3), applied to the system-out text so it compares with the message attribute. */
function normaliseWhitespace(text) {
  return text.replace(/[\t\n\r]/g, ' ');
}

/**
 * forge's own line for the record, at the offset its format puts it
 * (`[FAIL: <reason>] <signature> <kind report>`, junit_xml_report in forge
 * 1.8.5): `(gas: 0)` there is TestKind's default, which only a path that
 * failed the test without running its body leaves. Read at that offset, a
 * long reason cannot push it out of reach, and text elsewhere (logs, the
 * reason itself) is never taken for it.
 */
function bodyNeverRan(record, message) {
  if (typeof record.out !== 'string') return false;
  const head = `[FAIL: ${message}] ${record.name} (gas: 0)`;
  return normaliseWhitespace(record.out.slice(0, head.length)) === head;
}

/**
 * A failure's reason. forge writes it as the record's message, but for a
 * campaign of one invariant predicate only in the record's own <system-out>,
 * on the first line (TestResult keeps invariant reasons in invariant_failures,
 * and only the expanded form sets the message). Read there for invariants
 * alone: another test's failure without a message stays one.
 */
function recordReason(record) {
  if (typeof record.message === 'string' && record.message !== '') return record.message;
  if (!isInvariantRecord(record.name) || typeof record.out !== 'string') return record.message;
  const line = record.out.split('\n', 1)[0];
  if (!line.startsWith('[FAIL: ')) return record.message;
  // `[FAIL: <reason>]` alone with a counterexample's sequence below it, else `[FAIL: <reason>] <name> (runs: …)`.
  const tail = `] ${record.name} `;
  const end = line.endsWith(']') ? line.length - 1 : line.lastIndexOf(tail);
  return end > 7 ? line.slice(7, end) : record.message;
}

/**
 * Classify one JUnit record of a test function.
 * @param {{name:string, outcome:'pass'|'failure'|'error'|'skipped', message:string|null, out?:string}} record
 *   `out`: the record's <system-out>
 * @returns {{result:'pass'|'fail'|'error'|'skip', kind:'assertion'|'error'|null}}
 */
function classifyRecord(record) {
  switch (record.outcome) {
    case 'pass': return { result: 'pass', kind: null };
    case 'skipped': return { result: 'skip', kind: null };
    case 'failure': {
      const error = { result: 'error', kind: 'error' };
      const m = recordReason(record);
      if (typeof m !== 'string' || m === '') return error;
      if (FORGE_ERRORS.some((re) => re.test(m))) return error;
      if (bodyNeverRan(record, m)) return error;
      return { result: 'fail', kind: 'assertion' };
    }
    default: return { result: 'error', kind: 'error' };
  }
}

/** $FILES: one forge (globset) glob over the PoC's files, with glob characters escaped. */
function filesGlob(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new TypeError('filesGlob needs at least one path');
  const escaped = paths.map((p) => p.replace(/[\\*?[\]{},]/g, '\\$&'));
  return escaped.length === 1 ? escaped[0] : `{${escaped.join(',')}}`;
}

/** Rust regex::escape's set: the characters --match-test's regex syntax gives a meaning. */
const REGEX_META = /[\\.+*?()|[\]{}^$#&\-~]/g;

/** $TEST_IDS: an anchored regex matching exactly these signatures (forge matches --match-test against the signature). */
function testIdsRegex(signatures) {
  if (!Array.isArray(signatures) || signatures.length === 0) throw new TypeError('testIdsRegex needs at least one signature');
  const unique = [...new Set(signatures)].sort();
  return `^(?:${unique.map((s) => s.replace(REGEX_META, '\\$&')).join('|')})$`;
}

/** A forge skip marker: vm.skip(…) (any cheatcode handle). forge-std's free skip(seconds) warps time and is not one. */
const SKIP_MARKER = /\.\s*skip\s*\(/;

/** References to the framework or its reporter, as tier-A flags (§9.2 step 3). They fail no gate. */
const REFERENCES = Object.freeze([
  ['forge-inline-config', /forge-config\s*:/],
  ['junit-markup', /<\s*\/?\s*(?:testsuites?|testcase|failure|skipped|system-out|system-err)\b|\bjunit\b/i],
  ['filesystem-cheatcode', /\.\s*(?:writeFile|writeFileBinary|writeLine|writeJson|writeToml|removeFile|removeDir|createDir|copyFile|closeFile)\s*\(/],
  ['framework-config', /foundry\.toml|remappings\.txt/],
  ['ffi', /\.\s*(?:ffi|tryFfi)\s*\(/],
  ['environment-cheatcode', /\.\s*setEnv\s*\(/]
]);

/**
 * Scan a file's added lines.
 * @param {Array<{line:number, text:string}>} lines
 * @returns {{skipMarkers:number[], references:Array<{line:number, rule:string}>}}
 */
function scanAddedLines(lines) {
  const skipMarkers = [];
  const references = [];
  for (const { line, text } of lines) {
    if (SKIP_MARKER.test(text)) skipMarkers.push(line);
    for (const [rule, re] of REFERENCES) if (re.test(text)) references.push({ line, rule });
  }
  return { skipMarkers, references };
}

module.exports = {
  reporterFlags, forgeEnvironment, forgeArgv, toolProblem, FORGE_WORKDIR, BUILDER_ENV, testIdentity, isTestFunction, isInvariantRecord, recordReason, isHarnessRecord, classifyRecord, filesGlob, testIdsRegex,
  scanAddedLines, FORGE_ERRORS, HARNESS_RECORDS, REFERENCES
};
