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
 * test. Everything else is an error: no JUnit at all (a compile error: an
 * import that does not resolve), a failed setUp() or constructor() (the
 * suite never reached its tests: forge's collection error), a record forge
 * marks as an error, or a failure forge raised itself rather than the test:
 * a refused or failed cheatcode (`vm.<name>: …`), a removed test form
 * (`testFail*`), the EVM failing (`EvmError: OutOfGas` and the like), a fuzz
 * test whose every input `vm.assume` rejected, an invariant campaign that
 * could not start. A bare `EvmError: Revert` stays the test's own revert:
 * forge prints the same for a call to an address with no code, so that case
 * is the jury's to read, not the gate's. The list is forge's wording at the
 * pinned version (checked against v1.8.5), so it moves with the pin.
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

const TEST_FUNCTION = /^(?:test|invariant|statefulFuzz|table)[^()]*\(.*\)$/s;

/** Whether a JUnit record is a test function (else a harness record: setUp(), constructor(), afterInvariant(), …). */
function isTestFunction(name) {
  return typeof name === 'string' && TEST_FUNCTION.test(name);
}

/** Failures forge raises itself, at the pinned version: the test never got to assert. */
const HARNESS_ERRORS = Object.freeze([
  /^vm\.[A-Za-z0-9_]+: /, // a cheatcode refused or failed: FFI disabled, a path not allowed, no such artifact
  /^`testFail\*` has been removed/, // forge refuses the removed test form
  /^EvmError: (?!Revert$)/, // the EVM itself failed: out of gas, memory, stack, …
  /^`vm\.assume` rejected too many inputs/, // the fuzzer found no input: the test body never ran to an assertion
  /^failed to set up invariant testing environment/ // the invariant campaign never started
]);

/**
 * Classify one JUnit record of a test function.
 * @param {{outcome:'pass'|'failure'|'error'|'skipped', message:string|null}} record
 * @returns {{result:'pass'|'fail'|'error'|'skip', kind:'assertion'|'error'|null}}
 */
function classifyRecord(record) {
  switch (record.outcome) {
    case 'pass': return { result: 'pass', kind: null };
    case 'skipped': return { result: 'skip', kind: null };
    case 'failure': {
      const m = typeof record.message === 'string' ? record.message : '';
      if (HARNESS_ERRORS.some((re) => re.test(m))) return { result: 'error', kind: 'error' };
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
  reporterFlags, forgeEnv, commandArgv, testIdentity, isTestFunction, classifyRecord, filesGlob, testIdsRegex, scanAddedLines,
  HARNESS_ERRORS, REFERENCES
};
