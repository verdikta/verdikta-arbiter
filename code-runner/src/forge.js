'use strict';

/**
 * The forge adapter (design §8.1 commands, §9.2 steps 5-6, §20 decision 17:
 * the MVP is Foundry-only). What the runner adds to the maker's declared
 * commands, how it names a test, and how it reads a forge test result.
 *
 * Commands run only inside the sandbox, as written, in its /bin/sh with
 * pathname expansion off (`set -f`: $FILES is a forge glob, which the shell
 * must pass through untouched). The runner appends its reporter flags as
 * arguments: `--junit` (forge prints the JUnit on stdout, which the runner
 * reads as a capped stream) and the fixed `--fuzz-seed` from
 * @verdikta/common, so fuzz and invariant tests draw the same inputs on
 * every host and every run. Every forge invocation also gets the seed as
 * FOUNDRY_FUZZ_SEED.
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

function reporterFlags() {
  return ['--junit', '--fuzz-seed', FORGE_FUZZ_SEED];
}

function forgeEnv() {
  return { FOUNDRY_FUZZ_SEED: FORGE_FUZZ_SEED };
}

/**
 * The argv that runs a declared command in the sandbox: the maker's text as
 * the script of /bin/sh -c, `name` as $0, and `append` passed as arguments
 * after it ("$@"), never spliced into the text.
 */
function commandArgv(command, { name, append = [] }) {
  const script = append.length ? `set -f; ${command} "$@"` : `set -f; ${command}`;
  return ['/bin/sh', '-c', script, name, ...append];
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

/**
 * Classify one JUnit record of a test function.
 * @param {{name:string, outcome:'pass'|'failure'|'error'|'skipped', message:string|null, out?:string}} record
 *   `out`: the start of the record's <system-out>
 * @returns {{result:'pass'|'fail'|'error'|'skip', kind:'assertion'|'error'|null}}
 */
function classifyRecord(record) {
  switch (record.outcome) {
    case 'pass': return { result: 'pass', kind: null };
    case 'skipped': return { result: 'skip', kind: null };
    case 'failure': {
      const error = { result: 'error', kind: 'error' };
      const m = record.message;
      if (typeof m !== 'string' || m === '') return error;
      if (FORGE_ERRORS.some((re) => re.test(m))) return error;
      if (typeof record.out === 'string' && record.out.includes(`] ${record.name} (gas: 0)`)) return error;
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
  reporterFlags, forgeEnv, commandArgv, testIdentity, isTestFunction, isHarnessRecord, classifyRecord, filesGlob, testIdsRegex,
  scanAddedLines, FORGE_ERRORS, HARNESS_RECORDS, REFERENCES
};
