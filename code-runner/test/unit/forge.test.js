'use strict';

// Acceptance: the PoC runs with testFiles plus the runner's --junit flags and
// a fixed --fuzz-seed on every forge invocation; each added test is
// classified pass / assertion failure / error (compile, collection, setUp).
// Review focus: assertion vs error classification. These are the forge
// adapter's pure parts; claim.test.js drives them through the pipeline.

const test = require('node:test');
const assert = require('node:assert/strict');
const forge = require('../../src/forge');
const { FORGE_FUZZ_SEED } = require('../../src/common');

test('the reporter flags: JUnit on stdout and the fixed fuzz seed from @verdikta/common', () => {
  assert.equal(FORGE_FUZZ_SEED, '0x76657264696b7461');
  assert.deepEqual(forge.reporterFlags(), ['--junit', '--fuzz-seed', FORGE_FUZZ_SEED]);
  assert.deepEqual(forge.forgeEnv(), { FOUNDRY_FUZZ_SEED: FORGE_FUZZ_SEED });
});

test('a declared command runs as written in the sandbox\'s /bin/sh, with the reporter flags appended as arguments', () => {
  const argv = forge.commandArgv('forge test --match-path $FILES', { name: 'vcr-poc', append: forge.reporterFlags() });
  assert.deepEqual(argv, ['/bin/sh', '-c', 'set -f; forge test --match-path $FILES "$@"', 'vcr-poc', '--junit', '--fuzz-seed', FORGE_FUZZ_SEED]);
  assert.deepEqual(forge.commandArgv('forge build', { name: 'vcr-build' }), ['/bin/sh', '-c', 'set -f; forge build', 'vcr-build']);
});

test('test identity: file > contract > test, as baseline.json has it', () => {
  assert.equal(forge.testIdentity('test/Exploit.t.sol', 'ExploitTest', 'test_drain()'), 'test/Exploit.t.sol > ExploitTest > test_drain()');
});

test('which records are tests: test*, invariant*, statefulFuzz*, table*; setUp() and constructor() are the harness\'s', () => {
  for (const n of ['test_a()', 'testFuzz_x(uint256)', 'invariant_total()', 'statefulFuzz_x()', 'table_x(uint256)', 'test()']) {
    assert.equal(forge.isTestFunction(n), true, n);
  }
  for (const n of ['setUp()', 'constructor()', 'afterInvariant()', 'helper()', 'Test_a()', '']) {
    assert.equal(forge.isTestFunction(n), false, n);
  }
});

test('assertion vs error: a test that ran and reverted is an assertion failure; forge\'s own errors are errors', () => {
  const fail = (message) => forge.classifyRecord({ name: 'test_x()', outcome: 'failure', message });
  // Every way a forge test fails by its own revert: forge's model has no
  // other kind of test failure, and the §8.2 harness proof checks exactly
  // this distinction (a trivially failing test vs a trivially broken one).
  for (const m of [
    'assertion failed: 1 != 2', 'vault drained: 1 != 2', 'vault drained', 'assertion failed', 'panic: assertion failed (0x01)',
    'panic: arithmetic underflow or overflow (0x11)', 'EvmError: Revert', 'next call did not revert as expected',
    'bug is 1', 'fuzz', null
  ]) {
    assert.deepEqual(fail(m), { result: 'fail', kind: 'assertion' }, String(m));
  }
  // The harness refused or the EVM itself failed: the test never got to assert.
  for (const m of [
    'vm.ffi: FFI is disabled; add the `--ffi` flag to allow tests to call external commands',
    'vm.readFile: the path /etc/passwd is not allowed to be accessed for read operations',
    'vm.getCode: no matching artifact found',
    '`testFail*` has been removed. Consider changing to test_Revert[If|When]_Condition and expecting a revert',
    'EvmError: OutOfGas', 'EvmError: MemoryOOG', 'EvmError: StackOverflow'
  ]) {
    assert.deepEqual(fail(m), { result: 'error', kind: 'error' }, m);
  }
  assert.deepEqual(forge.classifyRecord({ name: 'test_x()', outcome: 'pass', message: null }), { result: 'pass', kind: null });
  assert.deepEqual(forge.classifyRecord({ name: 'test_x()', outcome: 'skipped', message: null }), { result: 'skip', kind: null });
  assert.deepEqual(forge.classifyRecord({ name: 'test_x()', outcome: 'error', message: 'x' }), { result: 'error', kind: 'error' });
});

test('$FILES: one forge glob over the PoC files, glob characters escaped', () => {
  assert.equal(forge.filesGlob(['test/B.t.sol']), 'test/B.t.sol');
  assert.equal(forge.filesGlob(['test/B.t.sol', 'test/we,ird/A[1]{x}.t.sol']), '{test/B.t.sol,test/we\\,ird/A\\[1\\]\\{x\\}.t.sol}');
  assert.equal(forge.filesGlob(['test/a*?.sol']), 'test/a\\*\\?.sol');
  assert.throws(() => forge.filesGlob([]), /at least one/);
});

test('$TEST_IDS: an anchored regex over the exact signatures forge matches --match-test against', () => {
  assert.equal(forge.testIdsRegex(['test_b()', 'test_w()']), '^(?:test_b\\(\\)|test_w\\(\\))$');
  assert.equal(forge.testIdsRegex(['testFuzz_x(uint256[],address)', 'test_$a()']), '^(?:testFuzz_x\\(uint256\\[\\],address\\)|test_\\$a\\(\\))$');
  assert.equal(forge.testIdsRegex(['test_b()', 'test_b()']), '^(?:test_b\\(\\))$', 'each signature once');
  assert.throws(() => forge.testIdsRegex([]), /at least one/);
});

test('added-line flags: skip markers and framework or reporter references', () => {
  const r = forge.scanAddedLines([
    { line: 3, text: '        vm.skip(true);' },
    { line: 4, text: '        skip(1 days); // forge-std time warp, not a skip marker' },
    { line: 5, text: '    /// forge-config: default.fuzz.runs = 1' },
    { line: 6, text: '        console.log("<testcase name=\\"x\\">");' },
    { line: 7, text: '        vm.writeFile("foundry.toml", "");' },
    { line: 8, text: '        string[] memory c = new string[](1); vm.ffi(c);' },
    { line: 9, text: '        assertEq(vault.balance(), 0);' }
  ]);
  assert.deepEqual(r.skipMarkers, [3]);
  assert.deepEqual(r.references.map((x) => [x.line, x.rule]), [
    [5, 'forge-inline-config'],
    [6, 'junit-markup'],
    [7, 'filesystem-cheatcode'],
    [7, 'framework-config'],
    [8, 'ffi']
  ]);
});
